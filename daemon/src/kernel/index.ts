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
import { createSetCapabilities } from '../capability/sets.js';
import { createStudioCapabilities } from '../capability/studio.js';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { createAgentTask } from '../db/jobs.js';
import type { UserRow } from '../db/store.js';
import type { JobService } from '../jobs/service.js';
import type { SessionService } from '../sessions/service.js';
import { gridFromSpec, layout, type Block } from 'rhinestone-studio/engine';
import {
  mountHandicraftKernel,
  type HandicraftKernelHandle,
  type HandicraftKernelState,
} from './boot.js';
import { resolveSingleRoute, singleRouteBundle } from './model-route.js';
import { createTaskSessions, type StudioTaskSessions } from './sessions.js';
import { createStrategyDesignCapabilities, type EngineLayoutDelegate } from './strategies/design.js';
import { createVisionCapabilities } from './vision/scene-analyze.js';
import {
  createSubjectSegmentCapabilities,
  finishSamTransport,
  resolveKernelSamTransport,
} from './vision/segment-tool.js';
import { SamBridge, type SamTransport } from './vision/sam-bridge.js';
import { TaskWorkbench } from './workbench.js';

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
  /**
   * 排钻工作台（add-task-detail-layer-workbench 1.3：task 详情/图层操作的人类直调
   * 面）。不依赖 dsh 运行时——内核降级态（off/missing/error）下仍可用（仅依赖
   * db/blobs/jobs/SAM 桥/引擎委派，构造期装配）；rpc 层无需查 state。
   */
  readonly workbench: TaskWorkbench;
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
  /**
   * SAM 桥传输注入缝（add-subject-sam-pipeline P3.3）：缺省由 env 装配
   * （resolveKernelSamTransport——SAM_SSH_HOST 真连/SAM_BRIDGE_MOCK 合成 mock）；
   * kernel-live 冒烟/测试注入 mock 传输走此缝（生产装配零改动）。
   */
  samTransport?: SamTransport;
}

/** followup 运行兜底超时（骨架语义——完整预算归 W4.2）。env 可覆盖：
 * 真 SAM 桥多轮识图单调用 25-70s，全链 5-10 分钟超缺省 300s（P2.6/demo 实测），
 * 装配侧可按拓扑放大（FOLLOWUP_TIMEOUT_MS 毫秒——非数字/缺省回 300s）。
 * 惰性读 env：模块加载期脚本（demo/冒烟）在 import 后才置 env，const 固化会丢覆盖。 */
const followupTimeoutMs = (): number => Number(process.env.FOLLOWUP_TIMEOUT_MS) || 300_000;

/**
 * engineStrategy 委派真身（registry.ts adapter 契约的接线层消费——strategies 子树
 * 不 import 引擎红线，故真身在 kernel facade；导出面=strategy.design 执行链测试
 * 的真引擎集成位）：TreeBlock（P0.2 引擎 Block 九字段同构+origin 第十字段）直通
 * 引擎 layout 公共出口（jobs/engine.ts 先例）；grid=gridFromSpec(round, gap 0.4mm
 * 缺省——冻结语义 pitchMm=diameterMm+gapMm)；density 乘数与 seed 由 design 层换算
 * 注入（指派密度/Owner 基线 2.3；nodeId FNV-1a）。
 */
export const strategyEngineDelegate: EngineLayoutDelegate = (request) => {
  const grid = gridFromSpec(
    { shapeId: 'round', sizeLabel: `${request.gemDiameterMm}mm`, diameterMm: request.gemDiameterMm },
    0.4,
    request.pixelsPerMm,
  );
  const result = layout(
    [request.block as unknown as Block],
    request.strategy,
    { density: request.density, seed: request.seed, relax: { boundary: false, repulsion: false } },
    grid,
  );
  return {
    gems: result.gems.map((gem) => ({
      x: gem.x,
      y: gem.y,
      diameterMm: gem.diameterMm,
      ...(gem.rotationDeg !== undefined ? { rotationDeg: gem.rotationDeg } : {}),
    })),
    ...(result.dropped !== undefined ? { dropped: result.dropped } : {}),
  };
};

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
  /** 排钻工作台（人类直调面——桥/引擎委派与 capability 面同源实例）。 */
  readonly workbench: TaskWorkbench;
  private handle: HandicraftKernelHandle | null = null;
  private readonly taskSessions: StudioTaskSessions;
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private mcpConfigured = false;
  /** SAM 桥传输（SshSamTransport 时 stop 面优雅收口——P3.3 注入缝/env 装配）。 */
  private readonly samTransport: SamTransport | undefined;

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
    // + set.*（add-stone-library S7.3 五工具——生产组合层）+ vision（add-subject-
    // sam-pipeline P2.3 scene.analyze 识图工具 + P3.3 subject.segment 迭代抠图工具）
    // + strategy（P3.1 strategy.design 策略设计器）组合为单一 MCP 投影源（重名
    // fail fast；共 26 工具）。SAM 桥共享实例（P2.2 队列/留存全量）：env 装配真
    // SshSamTransport（SAM_SSH_HOST 惰性会话）或合成 mock（SAM_BRIDGE_MOCK）/注入缝
    // deps.samTransport；未装配=subject.segment 降级面（P2.5 颜色分块）。scene.analyze
    // 桥在场时优先通道 A、unsupported 显式降通道 B（LLM 路由，SAM_ANALYZE_LIVE 门控）；
    // strategy 面真连同理 STRATEGY_DESIGN_LIVE 门控。engineStrategy 委派真身在下方
    // strategyEngineDelegate（strategies 子树不 import 引擎红线——registry adapter
    // 契约的接线层消费）。
    const samTransport = deps.samTransport ?? resolveKernelSamTransport();
    this.samTransport = samTransport;
    const samBridge =
      samTransport === undefined
        ? undefined
        : new SamBridge({ db: deps.db, blobs: deps.blobs, dataRoot: deps.config.dataRoot }, { transport: samTransport });
    // 排钻工作台（P4.2 1.3）：SAM 桥/引擎委派与 capability 面同源共享实例——人类
    // 直调 RPC 与 agent 工具面消费同一后端原子（design「功能原子化的双消费面」）。
    this.workbench = new TaskWorkbench({
      db: deps.db,
      blobs: deps.blobs,
      jobs: deps.jobs,
      ...(samBridge !== undefined ? { bridge: samBridge } : {}),
      engineLayout: strategyEngineDelegate,
    });
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
      createSetCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        jobs: deps.jobs,
        approvals: this.approvals,
        onRunaway,
      }),
      createVisionCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        dataRoot: deps.config.dataRoot,
        llm: deps.config.llm,
        ...(samBridge !== undefined ? { bridge: samBridge } : {}),
        jobs: deps.jobs,
        onRunaway,
      }),
      createSubjectSegmentCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        jobs: deps.jobs,
        ...(samBridge !== undefined ? { bridge: samBridge } : {}),
        onRunaway,
      }),
      createStrategyDesignCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        dataRoot: deps.config.dataRoot,
        llm: deps.config.llm,
        approvals: this.approvals,
        engineLayout: strategyEngineDelegate,
        jobs: deps.jobs,
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
    const budgetMs = followupTimeoutMs();
    const timer = setTimeout(() => {
      this.watchdogs.delete(task.id);
      this.taskSessions.failByTask(task.id, `followup 超时（${budgetMs / 1000}s 兜底）`);
    }, budgetMs);
    timer.unref?.();
    this.watchdogs.set(task.id, timer);
    void this.watchClear(task.id);
    return { taskId: task.id };
  }

  /** task 终态后清看门狗（轮询 task 行——settle 路径唯一写终态；停机/db 关闭即退）。 */
  private async watchClear(taskId: string): Promise<void> {
    const deadline = Date.now() + followupTimeoutMs() + 5_000;
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

  /** 停机面：看门狗回收 + agent 回收 + fiber dispose + env 还原 + SAM 会话收口。 */
  async stop(): Promise<void> {
    for (const timer of this.watchdogs.values()) clearTimeout(timer);
    this.watchdogs.clear();
    await this.taskSessions.dispose();
    const handle = this.handle;
    this.handle = null;
    if (handle) await handle.dispose().catch(() => undefined);
    await finishSamTransport(this.samTransport).catch(() => undefined);
    if (this.state === 'ready') this.state = 'unbooted';
  }
}
