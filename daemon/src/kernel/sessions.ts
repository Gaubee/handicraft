/**
 * 内核任务会话服务（照 shufa-server kernel/sessions.ts 移植——其上游=
 * skill-creator-v2 kernel/agent-sessions.ts；W4.1 按贴钻冻结契约适配）。
 * 原始需求 2026-09-23（W4.1）：createTaskSession（一次 followup=一个 type=agent
 * 的 task——§3.5 契约；taskId 即 dsh 会话身份）/ firehose→Frame 投影（Zod
 * safeParse，畸形丢弃+有界诊断）/ 帧提交走 JobService.emitFor 单点（seq 分配/
 * jsonl 落盘/订阅广播/writer CAS fence——W3 §6.5 语义原样复用）/ cancel/dispose。
 * add-agent-three-channel 1.2（2026-09-26，对齐 shufa b6cec8a W10a）：steer（live
 * 投递 entry.agent.steer——消息构造与首 prompt 同构）/ stopByTask（打断当前轮：
 * cancel{kind:'user'}+keepInbox → 立即 done 收口）/ inbox 可见面（nextTurn/nextStep
 * 读 + remove/replace/splice——队列编辑「暂离内核」语义的地基）。
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
import type { AttachmentMeta, FrameKind } from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { AttachmentMaterial } from './attachments.js';
import { getTaskById, updateTask } from '../db/jobs.js';
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
  /** 首条用户消息全文（taskId 绑定标注由调用方拼好）。 */
  prompt: string;
  /**
   * 附件图像（split-admin-portal 2.3 物料桥）：字节已经 BlobStore 读回+魔数嗅探
   * （kernel/attachments 治理面产出）。本层经 ctx.attachments.saveImages（dsh-base
   * 的 attachment-local 服务——sharp 全解码验证+规范化+内容寻址落存）取得
   * ImageAttachmentRef，按序映射为 dsh 用户消息原生 image 内容块。伪图在
   * saveImages 的解码校验处显式抛错（不静默降级为文本）。
   */
  images?: AttachmentMaterial[];
  /**
   * [product-polish-w2 补抄 zhumo 强度 chip] 任务级模型/强度覆盖（zhumo 语义：
   * 缺席=跟随后台默认——deps.modelSelection()；provider/model 必填成对，effort
   * 可空）。合法性校验（已配置路由/efforts 目录）由调用方 kernel/index followup
   * 前置完成，本层直接进 agentOptions（dsh agents.create——0.1.6-alpha.1 同版
   * zhumo 实证 reasoningEffort 面）。
   */
  model?: { provider: string; model: string; effort?: string | null };
}

/**
 * dsh 原生图像内容块类型推导（不经 daemon 直接依赖 @deepseek-ai/dsh-attachment
 * ——该包是 dsh-llm 的传递依赖，从 createUserMessage 签名推导保持类型同源）。
 */
type DshContentBlock = NonNullable<Parameters<typeof createUserMessage>[0]>['content'][number];
type DshImageAttachmentRef = Extract<DshContentBlock, { type: 'image' }>['attachment'];

/**
 * ctx.attachments 服务收窄（宿主 AttachmentStore 的消费面——结构化 unknown 收窄
 * 妥协声明的延续，见文件头）。saveImages：批量验证（媒体类型+全解码）+规范化+
 * 内容寻址落存，返回与输入同序的持久引用。
 */
interface AttachmentsServiceLike {
  saveImages(
    inputs: ReadonlyArray<{
      data: Uint8Array;
      mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
      name?: string;
    }>,
  ): Promise<readonly DshImageAttachmentRef[]>;
}

function attachmentsService(ctx: Context): AttachmentsServiceLike {
  const service = (ctx as Context & { attachments?: unknown }).attachments;
  if (!service || typeof (service as AttachmentsServiceLike).saveImages !== 'function') {
    throw new Error('kernel ctx.attachments 服务不可用（dsh-base attachment-local 未激活）——图片消息无法入线');
  }
  return service as AttachmentsServiceLike;
}

/** 内核 Agent 最小结构面（unknown 收窄）。 */
interface AgentLike {
  id: string;
  status: string;
  session: { id: string };
  followup(message: unknown): void;
  /**
   * 引导当前轮（add-agent-three-channel 1.2，dsh-agent Agent.steer——node_modules
   * 类型实证 0.1.6-alpha.1）：运行中的 driver 在下一 step 边界消费（影响当前轮）；
   * idle 时等价开新轮。注入面（inject）一并收窄——队列面板后续波次的第三模式。
   */
  steer(message: unknown): void;
  inject(message: unknown): void;
  cancel(cause: unknown, options?: unknown): void;
  whenIdle(): Promise<void>;
  /**
   * 排队工作读写面（dsh-agent Inbox）：nextTurn=逐轮 prompts；nextStep=step 边界
   * 挂起项（steer/inject）。消息以内核 UserMessage 形状流转（unknown 收窄；text
   * 提取/重建由本模块负责——remove/replace/splice 即队列编辑的「暂离内核」语义）。
   */
  inbox: {
    readonly nextTurn: readonly unknown[];
    readonly nextStep: readonly unknown[];
    remove(messageId: string): boolean;
    replace(messageId: string, newMessage: unknown): boolean;
    splice(target: 'next-turn' | 'next-step', start: number, deleteCount: number, inserted: unknown[]): unknown[];
  };
}

/** 内核 UserMessage 的产品侧收窄（content.text 块拼接为面板文本——照 shufa b6cec8a 同法）。 */
function inboxMessageText(message: unknown): string {
  const blocks = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return blocks
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

function inboxMessageId(message: unknown): string {
  return String((message as { id?: unknown }).id ?? '');
}

/** inbox 条目视图（队列面板波次的产品投影地基：id 稳定，replace 后为新身份）。 */
export interface InboxEntryView {
  messageId: string;
  text: string;
}

interface AgentsServiceLike {
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; agentPreset?: string };
    /** [product-polish-w2] reasoningEffort=任务级强度档（zhumo 同版实证面）。 */
    agentOptions?: { provider?: string; model?: string; reasoningEffort?: string };
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
  /**
   * 首条用户消息的附件元数据（split-admin-portal 2.1/2.3 物料桥投影）：createTaskSession
   * 在推送消息前落位，首条 user/message 事件投影进 transcript 帧（attachments 元数据
   * ——回放渲染缩略）；消费即清（后续 steer 等用户消息不带附件，不得复挂）。
   */
  attachmentMeta: AttachmentMeta[] | undefined;
  /**
   * 首条用户消息的失败兜底帧料（波 5 P2-4）：dsh agent-loop 的 user/message append
   * 发生在 prepareRequest **之后**——prepare 期失败（no provider/model / prepareCall
   * 异常）时 echo 永不达，用户消息泡/附件缩略永不回放。echo 达（user/message 投影）
   * 即清；settle 时未清=echo 未达，先补落 user 帧再落终态帧。
   */
  pendingUserFrame: { text: string; attachments?: AttachmentMeta[] } | undefined;
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
    // 失败兜底（波 5 P2-4）：首条用户消息的 echo 未达（prepare 期失败——user/message
    // 从未 append）时补落 user 帧（含附件元数据），回放不缺用户泡；echo 已达则此处
    // 已被清空，no-op。帧序=user 帧先于终态帧。
    const pending = entry.pendingUserFrame;
    entry.pendingUserFrame = undefined;
    if (pending !== undefined && (pending.text.length > 0 || pending.attachments !== undefined)) {
      emit(entry, 'transcript', {
        role: 'user',
        text: pending.text,
        ...(pending.attachments !== undefined ? { attachments: pending.attachments } : {}),
      });
    }
    if (outcome === 'done') {
      emit(entry, 'done', {});
      settleTaskRow(entry.taskId, 'done');
    } else {
      emit(entry, 'error', { message: message ?? 'turn 失败' });
      settleTaskRow(entry.taskId, 'failed');
    }
    live.delete(entry.agent.session.id);
    void entry.dispose().catch(() => undefined);
  }

  /**
   * 终态行写入（三通道 1.2 收口语义，对齐 shufa W10f「终态不覆盖幂等」）：仅
   * running/queued 收敛——行已被终态取消（tasks.cancel → cancelled）或以其它路径
   * 离开活跃态时，迟到 settle 只丢帧（emit 的 fence 已拒）不改写状态。否则终态
   * cancel 会被内核自然落下的 turn/end 复活成 done（打断≠取消的两态固化前提）。
   */
  function settleTaskRow(taskId: string, status: 'done' | 'failed'): void {
    const row = getTaskById(deps.db, taskId);
    if (!row || (row.status !== 'running' && row.status !== 'queued')) return;
    updateTask(deps.db, taskId, { status });
  }

  /** live 会话断言（inbox 面共用——不在册=重启后未开对话，队列本就空）。 */
  function requireLive(sessionId: string): LiveTaskSession {
    const entry = live.get(sessionId);
    if (!entry) throw new Error(`agent session not found: ${sessionId}`);
    return entry;
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
        const text = textOf(checked.data) ?? '';
        // 附件元数据（split-admin-portal 2.3）：首条用户消息（物料桥创建的带图消息）
        // 携带 attachments 进帧——消费即清（steer 等后续用户消息不得复挂）。纯图消息
        // text 为空串也产帧（旧面「空文本丢弃」只适用无附件消息）。
        const meta = entry.attachmentMeta;
        entry.attachmentMeta = undefined;
        // 首条 echo 已达——失败兜底帧料退役（P2-4：echo 投影成功，settle 不再补落）。
        entry.pendingUserFrame = undefined;
        if (text.length === 0 && meta === undefined) return;
        emit(entry, 'transcript', {
          role: 'user',
          text,
          ...(meta !== undefined ? { attachments: meta } : {}),
        });
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
        } else if (reason?.kind === 'error' || reason?.kind === 'failed' || reason?.kind === 'rejected') {
          // 真实 dsh 词汇=error（agent-loop catch 分支：no provider/model / Connection
          // error 等——波 5 P1-2 实证落 dsh 会话档而前端只等 300s 看门狗误报「超时」）；
          // failed/rejected 为投影层历史别名（保留容忍——schema 对 kind 透传不枚举）。
          const detail =
            reason.error?.message !== undefined
              ? reason.error.code !== undefined
                ? `${reason.error.message}（${reason.error.code}）`
                : reason.error.message
              : reason.kind === 'failed'
                ? 'turn 失败'
                : 'turn 被拒绝';
          settle(entry, 'error', detail);
        } else if (reason?.kind === 'blocked') {
          // dsh 词汇：pre-step 决策拒绝（如审批门阻断）——终态错误面。
          settle(entry, 'error', 'turn 被拒绝（blocked）');
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
     * followup=单 task）；deny-list setup + 首 prompt 启动。带图消息（split-admin-
     * portal 2.3 物料桥）：附件字节经 ctx.attachments.saveImages（验证+规范化+落存）
     * → 持久 ImageAttachmentRef → dsh 原生 image 内容块按序追加在文本块之后。
     */
    async createTaskSession(taskId: string, input: TaskSessionStartInput): Promise<{ sessionId: string }> {
      const kernel = requireKernel();
      bindFirehose(kernel);
      const agents = agentsService(kernel.ctx);
      // [product-polish-w2] 任务级覆盖优先（followup 携带=开任务那一刻锁定），
      // 缺席=后台默认路由（deps.modelSelection 原语义）。
      const model = input.model ?? deps.modelSelection();
      const handle = await agents.create({
        sessionId: taskId,
        meta: { cwd: input.cwd, agentPreset: 'handicraft' },
        ...(model
          ? {
              agentOptions: {
                provider: model.provider,
                model: model.model,
                ...(input.model?.effort ? { reasoningEffort: input.model.effort } : {}),
              },
            }
          : {}),
        setup: setupToolSurface,
      });
      const content: DshContentBlock[] = [{ type: 'text', text: input.prompt }];
      let attachmentMeta: AttachmentMeta[] | undefined;
      if (input.images !== undefined && input.images.length > 0) {
        const refs = await attachmentsService(kernel.ctx).saveImages(
          input.images.map((image) => ({
            data: image.data,
            mediaType: image.mediaType,
            ...(image.name !== undefined ? { name: image.name } : {}),
          })),
        );
        // 引用与输入同序（saveImages 契约）——blobRef↔dsh ref 映射在装配点对齐，
        // 帧元数据（name/mime/width/height）取 dsh 解码真相+我方 blobRef。
        attachmentMeta = input.images.map((image, index) => ({
          name: image.name,
          mime: image.mediaType,
          width: refs[index]!.width,
          height: refs[index]!.height,
          blobRef: image.blobRef,
        }));
        for (const ref of refs) content.push({ type: 'image', attachment: ref });
      }
      live.set(handle.agent.session.id, {
        agent: handle.agent,
        dispose: handle.dispose,
        taskId,
        toolNames: new Map(),
        settled: false,
        attachmentMeta,
        // 失败兜底帧料（P2-4）：echo 达即清（user/message 投影处）；settle 时未清
        // 则先补落 user 帧——回放不缺用户泡/附件缩略。
        pendingUserFrame: {
          text: input.prompt,
          ...(attachmentMeta !== undefined ? { attachments: attachmentMeta } : {}),
        },
      });
      handle.agent.followup(
        createUserMessage({ source: { kind: 'user' }, content }) as never,
      );
      return { sessionId: handle.agent.session.id };
    },

    /** 取消当前活动（幂等；排队消息存活）。 */
    cancel(sessionId: string): void {
      const entry = live.get(sessionId);
      if (!entry) return;
      entry.agent.cancel('user', { keepInbox: true });
    },

    /**
     * 引导当前轮（三通道 1.2，对齐 shufa b6cec8a sessions.steer）：live 投递
     * entry.agent.steer——运行中的 driver 在下一 step 边界消费；idle 时等价开新轮。
     * 消息构造与 createTaskSession 首 prompt 同构（createUserMessage + source user）；
     * 贴钻无 / 与 $ 面板分流（shufa 注：面板语义属于整轮对话，引导是中途改口的裸
     * 文本——本仓本就无该分流面）。不在册时抛错（调用方走新任务路径，与 shufa
     * 「复活后重试」约定同构——贴钻的复活=followup 新 task）。
     */
    steer(sessionId: string, text: string): void {
      const entry = live.get(sessionId);
      if (!entry) throw new Error(`agent session not found: ${sessionId}`);
      entry.agent.steer(
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }) as never,
      );
    },

    /**
     * 打断当前轮（三通道 1.2，对齐 shufa tasks.stop 内核面——DSH cancel{kind:'user'}）：
     * 中止生成→立即以 done 收口（终态帧+行 done+回收 live）——打断后会话可续聊（贴钻
     * 语义=同 session 再 followup 开新任务）；被打断轮的迟到事件因 live 已摘除而丢弃。
     * [Codex W10 P0-2 裁定=前端外环] cancel 携带 {keepInbox:true} 仅为对齐 dsh cancel
     * 惯例——inbox 消费不承诺：settle 随即 dispose（live 即 inbox 载体），排队消息的
     * 延续由前端队列外环负责（后端 inbox 持久化=后续波）。不在册（已收敛/重启窗口）
     * 返回 false，由调用方决定行级收口。
     */
    stopByTask(taskId: string): boolean {
      const entry = [...live.values()].find((candidate) => candidate.taskId === taskId);
      if (!entry) return false;
      entry.agent.cancel({ kind: 'user' }, { keepInbox: true });
      settle(entry, 'done');
      return true;
    },

    // ------------------------------------------------ inbox 可见面（三通道 1.2——队列编辑「暂离内核」语义的地基）

    /** 队列视图：两桶条目（nextTurn=排队逐轮；nextStep=steer/inject 挂起项）。 */
    inboxView(sessionId: string): { nextTurn: InboxEntryView[]; nextStep: InboxEntryView[] } {
      const entry = requireLive(sessionId);
      const viewOf = (messages: readonly unknown[]): InboxEntryView[] =>
        messages.map((message) => ({ messageId: inboxMessageId(message), text: inboxMessageText(message) }));
      return { nextTurn: viewOf(entry.agent.inbox.nextTurn), nextStep: viewOf(entry.agent.inbox.nextStep) };
    },

    /** 删除一条排队/挂起消息（不在队列幂等返回 false）。 */
    inboxRemove(sessionId: string, messageId: string): boolean {
      return requireLive(sessionId).agent.inbox.remove(messageId);
    },

    /** 原位改写一条（文本重建=新消息身份——dsh replace 语义；不在队列返回 false）。 */
    inboxReplace(sessionId: string, messageId: string, text: string): boolean {
      return requireLive(sessionId).agent.inbox.replace(
        messageId,
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
      );
    },

    /**
     * 标准 splice（队列编辑的暂离/放回原语）：removed 条目以视图返回（暂离侧自持
     * 文本，放回按 texts 重建——同 shufa queueUnfreeze 的 append 语义）；插入消息
     * 按 texts 重建（与 followup/steer 消息构造同构）。
     */
    inboxSplice(
      sessionId: string,
      target: 'next-turn' | 'next-step',
      start: number,
      deleteCount: number,
      texts: string[],
    ): InboxEntryView[] {
      const entry = requireLive(sessionId);
      const inserted = texts.map((text) =>
        createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
      );
      return entry.agent.inbox
        .splice(target, start, deleteCount, inserted)
        .map((message) => ({ messageId: inboxMessageId(message), text: inboxMessageText(message) }));
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
