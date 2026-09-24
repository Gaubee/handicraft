/**
 * dsh 内核装配 facade（design §1 kernel/ 行 + §6.4 四态——W4.1）。
 * 原始需求 2026-09-23：boot（mountHandicraftKernel 四态判定）→ sessions
 * attach（firehose 投影）→ followup 管线（一次 followup=一个 type=agent 的
 * task 行 + 一个 dsh 会话；帧流经 JobService.emitFor 单点）→ 停机（agent 回收
 * + fiber dispose + env 还原）。附件面按 W3 P1-3 裁决同事务登记会话引用账本。
 * rpc 消费 DshKernelFacade（state/reason/followup）——降级态 followup 501 由
 * rpc 层按 state 判定；本模块不 import dsh 运行时（boot.ts 动态面在其内部）。
 */
import type { CapabilityRegistry } from '../capability/core.js';
import { ApprovalService } from '../capability/authorization.js';
import { composeRegistries, createStoneCapabilities } from '../capability/stones.js';
import { createStudioCapabilities } from '../capability/studio.js';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { createAgentTask } from '../db/jobs.js';
import type { UserRow } from '../db/store.js';
import type { JobService } from '../jobs/service.js';
import type { SessionService } from '../sessions/service.js';
import {
  mountHandicraftKernel,
  type HandicraftKernelHandle,
  type HandicraftKernelState,
} from './boot.js';
import { resolveSingleRoute, singleRouteBundle } from './model-route.js';
import { createTaskSessions, type StudioTaskSessions } from './sessions.js';

export type DshKernelState = HandicraftKernelState | 'unbooted' | 'booting';

/** followup 输入面（契约 SessionFollowupInput 的服务端形状）。 */
export interface FollowupInput {
  text: string;
  attachments?: string[];
}

/** rpc 消费的最小面（HandicraftKernel 实现；rpc 经此判 501）。 */
export interface DshKernelFacade {
  readonly state: DshKernelState;
  readonly reason: string;
  /** 能力注册表（MCP listener 投影消费——capability 三件套的 daemon 侧）。 */
  readonly capabilities: CapabilityRegistry;
  /** §3.6 授权桥（session.answer/retry 与 capability 面共享同一实例）。 */
  readonly approvals: ApprovalService;
  followup(user: UserRow, sessionId: string, input: FollowupInput): Promise<{ taskId: string }>;
}

export interface HandicraftKernelDeps {
  config: AppConfig;
  db: SqliteDb;
  /** 帧提交单点（emitFor——writer CAS fence 语义见 JobService）。 */
  jobs: JobService;
  /** 附件引用账本登记（会话 CAS 同事务——W3 P1-3 裁决）。 */
  sessions: SessionService;
  /**
   * 内容寻址存储（W4.2 起显式依赖——W4.1 曾经 SessionService 内部 deps 结构投影
   * 读取，属诊断面脆弱性，评审登记 backlog 后本波收口：依赖显式注入）。
   */
  blobs: BlobStore;
}

/** followup 运行兜底超时（骨架语义——完整预算归 W4.2）。 */
const FOLLOWUP_TIMEOUT_MS = 300_000;

/**
 * MCP 工具面注册等待上限（W4.1 backlog「注册时序栅栏」）：followup 入口等待
 * mcp__studio__* 工具就绪——内核 boot 后 dsh-mcp-client 首连+注册存在亚秒级窗口，
 * 早到 followup 的工具面不完整。超时不阻塞（告警放行——注册完成前 MCP 调用会
 * 由客户端侧失败重试兜底）。
 */
const MCP_TOOL_SURFACE_WAIT_MS = 10_000;

export class HandicraftKernel implements DshKernelFacade {
  state: DshKernelState = 'unbooted';
  reason = '';
  readonly capabilities: CapabilityRegistry;
  readonly approvals: ApprovalService;
  private handle: HandicraftKernelHandle | null = null;
  private readonly taskSessions: StudioTaskSessions;
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private mcpConfigured = false;

  constructor(private readonly deps: HandicraftKernelDeps) {
    this.approvals = new ApprovalService({
      db: deps.db,
      jobs: deps.jobs,
    });
    // 熔断回调（RUNAWAY_LIMIT=5 同错连击）：按 bucket 收口——任务桶（taskId）
    // 定向失败该任务；global 桶取消全部在册会话（W4.2 任务分桶收口）。
    const onRunaway = (bucket: string, detail: string): void => {
      console.warn(`[kernel] 工具熔断（bucket=${bucket}）：${detail}`);
      if (bucket === 'global' || bucket === 'undo') {
        this.cancelLive(`工具熔断：${detail}`);
      } else {
        const hit = this.taskSessions.failByTask(bucket, `工具熔断：${detail}`);
        if (!hit) this.cancelLive(`工具熔断：${detail}`);
      }
    };
    // 能力面=studio.*（W4.2 十工具）+ stones/stone.*（add-stone-library S4 八工具）
    // 组合为单一 MCP 投影源（重名 fail fast）。
    this.capabilities = composeRegistries([
      createStudioCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        jobs: deps.jobs,
        approvals: this.approvals,
        config: deps.config,
        // export 族撤销补偿入口（SessionService.revokeResult 同一回收链路）。
        revokeResult: (resultId) => deps.sessions.revokeResult(resultId),
        onRunaway,
      }),
      createStoneCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        jobs: deps.jobs,
        approvals: this.approvals,
        onRunaway,
      }),
    ]);
    this.taskSessions = createTaskSessions({
      kernel: () => this.handle,
      jobs: deps.jobs,
      db: deps.db,
      modelSelection: () => {
        const route = this.route();
        return route ? { provider: route.provider, model: route.model } : null;
      },
    });
  }

  /** 诊断面：内核全局工具名（MCP 注册时序观察——测试/日志用）。 */
  debugToolNames(): string[] {
    return this.handle?.globalToolNames() ?? [];
  }

  /** 模型路由（boot 时解析缓存；null=未配置——内核缺省路由）。 */
  private routeCache: ReturnType<typeof resolveSingleRoute> = null;

  private route(): ReturnType<typeof resolveSingleRoute> {
    return this.routeCache;
  }

  /**
   * boot（四态判定入口——失败不抛，state/reason 呈现）。mcp=独立 loopback
   * listener 的 url/token（内核 dsh-mcp-client 行连接目标——须已监听）。
   */
  async boot(mcp?: { url: string; token: string }): Promise<void> {
    if (this.state !== 'unbooted') return;
    // booting 态：内核组装中——MCP listener 放行（dsh-mcp-client 首连发生在
    // boot 期间；降级门只对终态 off/missing/error 生效——§6.4 语义不破）。
    this.state = 'booting';
    this.mcpConfigured = mcp !== undefined;
    const { config } = this.deps;
    let modelRoutes: ReturnType<typeof singleRouteBundle> | null = null;
    try {
      const route = resolveSingleRoute(config.llm);
      this.routeCache = route;
      modelRoutes = route ? singleRouteBundle(route) : null;
    } catch (error) {
      this.state = 'error';
      this.reason = `boot 异常（模型路由配置）：${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const mounted = await mountHandicraftKernel({
      dataRoot: config.dataRoot,
      ...(mcp ? { mcp } : {}),
      modelRoutes,
      ...(config.dshModuleRoot ? { moduleRoot: config.dshModuleRoot } : {}),
      enabled: config.dshEnabled,
    });
    this.state = mounted.state;
    this.reason = mounted.reason ?? '';
    if (mounted.kernel) {
      this.handle = mounted.kernel;
      this.taskSessions.attach(mounted.kernel);
      this.reason =
        this.routeCache !== null
          ? `ready（LLM=${this.routeCache.provider}/${this.routeCache.model}，openai-completions）`
          : 'ready（LLM 未配置——内核缺省路由，agent 请求期报 MISSING_CREDENTIAL）';
    }
  }

  /** followup 真实管线（W4.1 最小面）。ready 外调用=编程错误（rpc 已拦 501）。 */
  async followup(user: UserRow, sessionId: string, input: FollowupInput): Promise<{ taskId: string }> {
    if (this.state !== 'ready' || this.handle === null) {
      throw new Error(`内核未就绪（${this.state}）：${this.reason}`);
    }
    await this.waitForStudioToolSurface();
    const { db } = this.deps;
    const task = createAgentTask(db, {
      ownerId: user.id,
      sessionId,
      paramsJson: JSON.stringify({ text: input.text }),
      status: 'running',
    });
    // 附件引用账本（W3 P1-3：会话 CAS 同事务——clearing/cleared 原子拒；blob
    // 缺失/deleting 显式拒——acquireRef 不静默复活）。
    const attachments = this.registerAttachments(sessionId, input.attachments ?? []);
    const annotated =
      `${input.text}\n\n[任务绑定 taskId=${task.id}——调用 studio.* 工具时 taskId 参数一律用这个值]` +
      (attachments.length > 0
        ? `\n[附件 ${attachments.length} 个：${attachments.join(', ')}（W4.1 文本面投影；物料桥归 W4.2）]`
        : '');
    await this.taskSessions.createTaskSession(task.id, { cwd: this.deps.config.dataRoot, prompt: annotated });
    // 看门狗（骨架兜底：agent 挂起不结算时按超时失败——完整预算归 W4.2）。
    const timer = setTimeout(() => {
      this.watchdogs.delete(task.id);
      this.taskSessions.failByTask(task.id, `followup 超时（${FOLLOWUP_TIMEOUT_MS / 1000}s 兜底）`);
    }, FOLLOWUP_TIMEOUT_MS);
    timer.unref?.();
    this.watchdogs.set(task.id, timer);
    void this.watchClear(task.id);
    return { taskId: task.id };
  }

  /** task 终态后清看门狗（轮询 task 行——settle 路径唯一写终态；停机/db 关闭即退）。 */
  private async watchClear(taskId: string): Promise<void> {
    const deadline = Date.now() + FOLLOWUP_TIMEOUT_MS + 5_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (this.state !== 'ready') return; // 停机后不再触碰 db。
      let row: { status: string } | undefined;
      try {
        row = this.deps.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as
          | { status: string }
          | undefined;
      } catch {
        return; // db 已关（测试收尾竞态）——看门狗静默退出。
      }
      if (!row || (row.status !== 'running' && row.status !== 'queued')) {
        const timer = this.watchdogs.get(taskId);
        if (timer) {
          clearTimeout(timer);
          this.watchdogs.delete(taskId);
        }
        return;
      }
    }
  }

  /** 取消并失败全部在册会话（熔断/停机面）。 */
  private cancelLive(detail: string): void {
    this.taskSessions.failOutstanding(detail);
  }

  /** 附件登记：会话可写 CAS + blob acquireRef + 账本行，同一事务（deps.blobs 显式依赖——W4.1 backlog 收口）。 */
  private registerAttachments(sessionId: string, blobRefs: string[]): string[] {
    const { db, blobs } = this.deps;
    const commit = db.transaction(() => {
      const session = db.prepare('SELECT status FROM sessions WHERE id = ?').get(sessionId) as
        | { status: string }
        | undefined;
      if (!session) throw new Error(`会话不存在：${sessionId}`);
      if (session.status !== 'active') throw new Error(`会话正在清理或已清理，拒绝新输入：${sessionId}`);
      for (const ref of blobRefs) blobs.acquireRef(ref);
      for (const ref of blobRefs) {
        db.prepare('INSERT INTO session_blob_refs (session_id, blob_hash, created_at) VALUES (?, ?, ?)').run(
          sessionId,
          ref,
          new Date().toISOString(),
        );
      }
    });
    commit();
    return [...blobRefs];
  }

  /**
   * MCP 工具面注册栅栏（W4.1 backlog 收口）：followup 入口等待 mcp__studio__*
   * 就绪（dsh-mcp-client 首连+工具注册存在亚秒级窗口）。有界等待——超时告警
   * 放行（注册完成前的工具调用由 MCP 客户端侧失败/重试兜底，不阻塞会话）。
   */
  private async waitForStudioToolSurface(): Promise<void> {
    if (!this.mcpConfigured || this.handle === null) return;
    const deadline = Date.now() + MCP_TOOL_SURFACE_WAIT_MS;
    while (Date.now() < deadline) {
      if (this.handle.globalToolNames().some((name) => name.startsWith('mcp__studio__'))) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    console.warn(`[kernel] MCP studio 工具面在 ${MCP_TOOL_SURFACE_WAIT_MS}ms 内未完成注册——followup 放行（工具调用将由 MCP 客户端重试兜底）`);
  }

  /** 停机面：看门狗回收 + agent 回收 + fiber dispose + env 还原。 */
  async stop(): Promise<void> {
    for (const timer of this.watchdogs.values()) clearTimeout(timer);
    this.watchdogs.clear();
    await this.taskSessions.dispose();
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.dispose().catch(() => undefined);
    if (this.state === 'ready') this.state = 'unbooted';
  }
}
