/**
 * 内核任务会话服务（照 shufa-server kernel/sessions.ts 移植——其上游=
 * skill-creator-v2 kernel/agent-sessions.ts；W4.1 按贴钻冻结契约适配）。
 * 原始需求 2026-09-23（W4.1）：createTaskSession（一次 followup=一个 type=agent
 * 的 task——§3.5 契约；taskId 即 dsh 会话身份）/ firehose→Frame 投影（Zod
 * safeParse，畸形丢弃+有界诊断）/ 帧提交走 JobService.emitFor 单点（seq 分配/
 * jsonl 落盘/订阅广播/writer CAS fence——W3 §6.5 语义原样复用）/ cancel/dispose。
 * 冻结契约适配（相对 shufa 参考的差异，逐处对应 design）：
 *   [A1] 帧词汇=@handicraft/contracts agent 帧族（transcript/approval-request/
 *        approval-resolved/done/error）——无 assistant-delta/tool-call 独立帧，
 *        工具事件投影为 transcript{role:'tool'}。
 *   [A2] 帧不经本模块的 FrameStore 环——走 jobs.emitFor（tasks/<id>/frames.jsonl
 *        由既有 JobService/FrameStore 承载；回放=replay 契约端点）。
 *   [A3] task 终态：turn/end completed → done 帧+task done；failed/rejected/
 *        aborted → error 帧+task failed（§3.5 followup=单 task 语义；W4.2/W4.3
 *        产品 export 工具接管终态后此处退化为兜底）。
 *   [A4] 审批（user-questions/request → approval-request 帧 + answer 回填）归
 *        W4.2 授权桥/W4.3 旅程——本波不挂 answerer（preset 的 ask-user 行保留）。
 *   [A5] resume/多轮 followup/disposeLive 归 W4.3（编辑旅程）。
 * 妥协声明：跨 cordis 服务访问按结构化 unknown 收窄（宿主服务形状无公开 TS 面）。
 */
import type { Context } from '@deepseek-ai/cordis';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { FrameKind } from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import { updateTask } from '../db/jobs.js';
import type { JobService } from '../jobs/service.js';
import type { HandicraftKernelHandle } from './boot.js';
import { productToolDenyList } from './tool-surface.js';
import {
  MessageEventSchema,
  ObjectPayloadEventSchema,
  ToolCallEventSchema,
  ToolResultEventSchema,
  TurnEndEventSchema,
  logDroppedEvent,
} from './firehose-events.js';

export interface TaskSessionDeps {
  kernel: () => HandicraftKernelHandle | null;
  /** 帧提交单点（JobService.emitFor——writer CAS fence/seq/jsonl/广播）。 */
  jobs: JobService;
  /** task 行终态收口（updateTask）。 */
  db: SqliteDb;
  /** 模型选择（null = 未配置，内核用缺省路由）。 */
  modelSelection: () => { provider: string; model: string } | null;
}

export interface TaskSessionStartInput {
  /** agent 会话工作目录（内核相对路径解析基准；无 shell 工具面——DATA_ROOT）。 */
  cwd: string;
  /** 首条用户消息全文（附件标注由调用方拼好——W4.1 文本面投影）。 */
  prompt: string;
}

/** 内核 Agent 最小结构面（unknown 收窄）。 */
interface AgentLike {
  id: string;
  status: string;
  session: { id: string };
  followup(message: unknown): void;
  cancel(cause: unknown, options?: unknown): void;
  whenIdle(): Promise<void>;
}

interface AgentsServiceLike {
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; agentPreset?: string };
    agentOptions?: { provider?: string; model?: string };
    setup?: (agentCtx: Context) => void;
  }): Promise<{ agent: AgentLike; dispose(): Promise<void> }>;
}

interface SessionEventLike {
  seq: number;
  type: string;
  data: unknown;
}

/** 会话 live 记录（live agent 引用 + 投影工作集）。 */
interface LiveTaskSession {
  agent: AgentLike;
  dispose(): Promise<void>;
  taskId: string;
  toolNames: Map<string, string>;
  settled: boolean;
}

export function createTaskSessions(deps: TaskSessionDeps) {
  const live = new Map<string, LiveTaskSession>();
  let firehoseBound = false;

  function requireKernel(): HandicraftKernelHandle {
    const kernel = deps.kernel();
    if (!kernel) throw new Error('agent kernel is not mounted');
    return kernel;
  }

  function agentsService(ctx: Context): AgentsServiceLike {
    const service = (ctx as Context & { agents?: unknown }).agents;
    if (!service) throw new Error('kernel ctx.agents service missing');
    return service as AgentsServiceLike;
  }

  /** 订阅 session/event firehose → 帧投影（内核生命周期内绑定一次）。 */
  function bindFirehose(kernel: HandicraftKernelHandle): void {
    if (firehoseBound) return;
    firehoseBound = true;
    type FirehoseContext = Context & {
      on: (event: 'session/event', listener: (session: { id: string }, event: SessionEventLike) => void) => () => void;
    };
    (kernel.ctx as FirehoseContext).on('session/event', (session, event) => {
      const entry = live.get(session.id);
      if (!entry) return;
      projectEvent(entry, event);
    });
  }

  /** 帧提交单点（JobService.emitFor——fence 语义见 W3）。 */
  function emit(entry: LiveTaskSession, kind: FrameKind, payload: unknown): void {
    deps.jobs.emitFor(entry.taskId, kind, payload);
  }

  /** task 终态收口（A3）。 */
  function settle(entry: LiveTaskSession, outcome: 'done' | 'error', message?: string): void {
    if (entry.settled) return;
    entry.settled = true;
    if (outcome === 'done') {
      emit(entry, 'done', {});
      updateTask(deps.db, entry.taskId, { status: 'done' });
    } else {
      emit(entry, 'error', { message: message ?? 'turn 失败' });
      updateTask(deps.db, entry.taskId, { status: 'failed' });
    }
    live.delete(entry.agent.session.id);
    void entry.dispose().catch(() => undefined);
  }

  /** 单事件 → 帧投影（畸形丢弃；词汇=A1）。 */
  function projectEvent(entry: LiveTaskSession, event: SessionEventLike): void {
    const sessionId = entry.agent.session.id;
    const data: unknown = event.data;
    switch (event.type) {
      case 'user/message': {
        const checked = MessageEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return;
        }
        if (checked.data.source?.kind !== 'user') return;
        const text = textOf(checked.data);
        if (text === undefined || text.length === 0) return;
        emit(entry, 'transcript', { role: 'user', text });
        return;
      }
      case 'assistant/message': {
        const checked = MessageEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return;
        }
        const text = textOf(checked.data);
        if (text === undefined || text.length === 0) return;
        emit(entry, 'transcript', { role: 'assistant', text });
        return;
      }
      case 'tool/call': {
        const checked = ToolCallEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return;
        }
        entry.toolNames.set(checked.data.callId, checked.data.name);
        emit(entry, 'transcript', { role: 'tool', text: `调用工具 ${checked.data.name}（参数 ${checked.data.arguments}）` });
        return;
      }
      case 'tool/result': {
        const checked = ToolResultEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return;
        }
        const block = checked.data.message.content[0];
        const parts: string[] = [];
        for (const part of block.content) {
          if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) parts.push(part.text);
        }
        const text = parts.join('\n');
        const suffix = block.isError ? '（工具执行错误）' : '';
        emit(entry, 'transcript', {
          role: 'tool',
          text: `工具结果${entry.toolNames.get(checked.data.message.source.callId) ? `（${entry.toolNames.get(checked.data.message.source.callId)}）` : ''}：${text === '' ? '(空)' : text}${suffix}`,
        });
        return;
      }
      case 'turn/start': {
        if (!ObjectPayloadEventSchema.safeParse(data).success) {
          logDroppedEvent(sessionId, event.type, data);
        }
        return;
      }
      case 'turn/end': {
        const checked = TurnEndEventSchema.safeParse(data);
        if (!checked.success) {
          logDroppedEvent(sessionId, event.type, data);
          return;
        }
        const reason = checked.data.reason;
        if (reason?.kind === 'completed') {
          settle(entry, 'done');
        } else if (reason?.kind === 'failed' || reason?.kind === 'rejected') {
          const detail =
            reason.error?.message !== undefined
              ? reason.error.code !== undefined
                ? `${reason.error.message}（${reason.error.code}）`
                : reason.error.message
              : reason.kind === 'failed'
                ? 'turn 失败'
                : 'turn 被拒绝';
          settle(entry, 'error', detail);
        } else if (reason?.kind === 'aborted') {
          settle(entry, 'error', 'turn 被取消');
        }
        return;
      }
      default:
        return;
    }
  }

  /** 消息 content 块拼接（type 判别 + text）。 */
  function textOf(message: { content: Array<{ type: string; text?: string }> }): string | undefined {
    const parts = message.content
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text as string);
    return parts.length > 0 ? parts.join('\n') : undefined;
  }

  /** 工具面收窄 setup：全局继承工具按 deny-list restrict（MCP scoped 注册不受影响）。 */
  function setupToolSurface(agentCtx: Context): void {
    const tools = (
      agentCtx as Context & {
        tools?: { schemas?: () => Array<{ name?: string }>; restrict?: (filter: { deny: string[] }) => () => void };
      }
    ).tools;
    if (!tools?.restrict) return;
    const globalNames = (tools.schemas?.() ?? [])
      .map((schema) => schema?.name)
      .filter((name): name is string => typeof name === 'string');
    const deny = productToolDenyList(globalNames);
    if (deny.length > 0) tools.restrict({ deny });
  }

  return {
    /** 内核挂载后首个会话操作前调用（幂等）。 */
    attach(kernel: HandicraftKernelHandle): void {
      bindFirehose(kernel);
    },

    /**
     * 创建任务会话（一次 followup 的内核面）：dsh 会话身份=taskId（§3.5
     * followup=单 task）；deny-list setup + 首 prompt 启动。
     */
    async createTaskSession(taskId: string, input: TaskSessionStartInput): Promise<{ sessionId: string }> {
      const kernel = requireKernel();
      bindFirehose(kernel);
      const agents = agentsService(kernel.ctx);
      const model = deps.modelSelection();
      const handle = await agents.create({
        sessionId: taskId,
        meta: { cwd: input.cwd, agentPreset: 'handicraft' },
        ...(model ? { agentOptions: { provider: model.provider, model: model.model } } : {}),
        setup: setupToolSurface,
      });
      live.set(handle.agent.session.id, {
        agent: handle.agent,
        dispose: handle.dispose,
        taskId,
        toolNames: new Map(),
        settled: false,
      });
      handle.agent.followup(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: input.prompt }] }) as never,
      );
      return { sessionId: handle.agent.session.id };
    },

    /** 取消当前活动（幂等；排队消息存活）。 */
    cancel(sessionId: string): void {
      const entry = live.get(sessionId);
      if (!entry) return;
      entry.agent.cancel('user', { keepInbox: true });
    },

    /** 兜底收口：daemon 停机或超时时对仍在册会话的失败结算（A3 兜底语义）。 */
    failOutstanding(detail: string): void {
      for (const entry of [...live.values()]) {
        settle(entry, 'error', detail);
      }
    },

    /** 指定 task 的失败收口（看门狗/熔断回调定向面）。 */
    failByTask(taskId: string, detail: string): boolean {
      for (const entry of [...live.values()]) {
        if (entry.taskId === taskId) {
          settle(entry, 'error', detail);
          return true;
        }
      }
      return false;
    },

    /** live 状态（诊断面）。 */
    isLive(sessionId: string): boolean {
      return live.has(sessionId);
    },

    /** 有界销毁（daemon stop）：agent 逐个回收。 */
    async dispose(): Promise<void> {
      await Promise.allSettled([...live.values()].map((entry) => entry.dispose()));
      live.clear();
    },
  };
}

export type StudioTaskSessions = ReturnType<typeof createTaskSessions>;
