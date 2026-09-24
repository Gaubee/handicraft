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
import { createStudioCapabilities } from '../capability/studio.js';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
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
  followup(user: UserRow, sessionId: string, input: FollowupInput): Promise<{ taskId: string }>;
}

export interface HandicraftKernelDeps {
  config: AppConfig;
  db: SqliteDb;
  /** 帧提交单点（emitFor——writer CAS fence 语义见 JobService）。 */
  jobs: JobService;
  /** 附件引用账本登记（会话 CAS 同事务——W3 P1-3 裁决）。 */
  sessions: SessionService;
}

/** followup 运行兜底超时（骨架语义——完整预算归 W4.2）。 */
const FOLLOWUP_TIMEOUT_MS = 300_000;

export class HandicraftKernel implements DshKernelFacade {
  state: DshKernelState = 'unbooted';
  reason = '';
  readonly capabilities: CapabilityRegistry;
  private handle: HandicraftKernelHandle | null = null;
  private readonly taskSessions: StudioTaskSessions;
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: HandicraftKernelDeps) {
    this.capabilities = createStudioCapabilities({
      db: deps.db,
      // 熔断回调（RUNAWAY_LIMIT=5 同错连击）：取消并失败当前在册会话（W4.1 单
      // live 会话常态；bucket 归 W4.2 任务化）。
      onRunaway: (bucket, detail) => {
        console.warn(`[kernel] 工具熔断（bucket=${bucket}）：${detail}`);
        this.cancelLive(`工具熔断：${detail}`);
      },
    });
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
      attachments.length > 0
        ? `${input.text}\n\n[附件 ${attachments.length} 个：${attachments.join(', ')}（W4.1 文本面投影；物料桥归 W4.2）]`
        : input.text;
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

  /** 附件登记：会话可写 CAS + blob acquireRef + 账本行，同一事务。 */
  private registerAttachments(sessionId: string, blobRefs: string[]): string[] {
    const { db, sessions } = this.deps;
    const blobs = sessionBlobsOf(sessions);
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

/** 会话服务的 BlobStore 旁路（附件 acquireRef 依赖面——结构投影）。 */
function sessionBlobsOf(sessions: SessionService): { acquireRef(hash: string): void } {
  const blobs = (sessions as unknown as { deps?: { blobs?: unknown } }).deps?.blobs;
  if (!blobs || typeof (blobs as { acquireRef?: unknown }).acquireRef !== 'function') {
    throw new Error('SessionService 未装配 BlobStore（附件面不可用）');
  }
  return blobs as { acquireRef(hash: string): void };
}
