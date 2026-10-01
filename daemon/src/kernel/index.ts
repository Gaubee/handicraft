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
import { createTaskStonesCapabilities } from '../capability/task-stones.js';
import { createTaskImagesCapabilities } from '../capability/task-images.js';
import { createTaskExportCapabilities } from '../capability/task-export.js';
import { createTreeCapabilities } from '../capability/tree.js';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { createAgentTask, getTaskById, updateTask } from '../db/jobs.js';
import type { UserRow } from '../db/store.js';
import type { JobService } from '../jobs/service.js';
import type { SessionService } from '../sessions/service.js';
import { gridFromSpec, layout, type Block } from 'rhinestone-studio/engine';
import {
  mountHandicraftKernel,
  type HandicraftKernelHandle,
  type HandicraftKernelState,
} from './boot.js';
import { resolveSingleRoute, singleRouteBundle, type StudioModelRoute } from './model-route.js';
import { buildRoutesBundle, loadModelsConfig, modelsSettingsInitialized, resolveRouteFor } from '../models-store.js';
import { imageProcessingEffective } from '../image-processing-store.js';
import { createTaskSessions, type StudioTaskSessions } from './sessions.js';
import { acquireSessionAttachments, type AttachmentMaterial } from './attachments.js';
import { createStrategyDesignCapabilities, type EngineLayoutDelegate } from './strategies/design.js';
import { ENGINE_DELEGATION_GAP_MM } from './strategies/design.js';
import { createVisionCapabilities } from './vision/scene-analyze.js';
import {
  createSubjectSegmentCapabilities,
  finishSamTransport,
  resolveKernelSamTransport,
} from './vision/segment-tool.js';
import { SamBridge, type SamTransport } from './vision/sam-bridge.js';
import { TaskWorkbench } from './workbench.js';
import { ProjectManifestService, type ManifestContent } from './project-manifest.js';
import { expandSourceSet, type SetExpansion } from './project-expand.js';
import { getSessionProject, setSessionAutoApprove } from '../db/sessions.js';
import { assignTaskImageIds } from '@handicraft/contracts';

export type DshKernelState = HandicraftKernelState | 'unbooted' | 'booting';

/** followup 输入面（契约 SessionFollowupInput 的服务端形状）。 */
export interface FollowupInput {
  /** 可空（split-admin-portal 2.1：纯图消息允许——text 或 attachments 至少其一由契约层保证）。 */
  text?: string;
  attachments?: string[];
  /**
   * 投递通道（三通道 1.3，对齐 shufa b6cec8a followup(mode) 分流）：followup=常规
   * 发送（缺省——新 task 新会话）；steer=引导——会话内有运行中 agent 任务时投递
   * 进其内核会话（下一 step 边界消费，不新开任务），无运行中任务时等价 followup
   * （贴钻的「复活逻辑共用」=两通道最终都落新 task 新会话路径）。
   */
  mode?: 'followup' | 'steer';
  /**
   * 项目集合选择（add-task-stones-manifest-export 0.3，arch-decisions A5 冻结）：
   * 仅会话**首个常规 followup**（创建项目）有效——W1 展开为 stones-manifest 快照；
   * steer 携带=拒（裸文本改口，与附件同款先例）；非首个携带=typed 拒（后续 task
   * 沿同一 session-project manifest，追加钻走 studio.task.stones.add）。本波只冻
   * 校验拒路径+params 审计入参；消费实装归 W1。
   */
  sourceSetId?: string;
  /**
   * 自动批准（product-polish-w1 T2——Owner「免值守」指令）：会话级开关透传，
   * **每条 followup（含 steer）均可携带**，最后写入者胜——落 sessions.auto_approve
   * 持久化（刷新/重开保持；summary/get 回读）。开启后该会话内**新发起**的
   * approved-mutation proposal 创建即自动签发 grant（authorization.propose 中央
   * 单点）；开启前悬挂的未决 proposal 不追补（只对开启后的新 proposal 生效）。
   * 与 sourceSetId 不同：非首条限定、steer 可携带（开关不属于任务面，属会话面）。
   */
  autoApprove?: boolean;
  /**
   * [product-polish-w2 补抄 zhumo 强度 chip] 任务级模型/强度覆盖（zhumo 语义：
   * null/缺席=跟随后台默认）：随 followup 携带=开任务那一刻锁定（一次 followup=
   * 一个 task——覆盖粒度天然任务级；无 zhumo 的 setTaskModel 热切面）。前置校验：
   * (provider,model) 指向已配置路由（resolveRouteFor）+ effort 在该模型 efforts
   * 目录内（loadModelsConfig——枚举外档 typed 拒，防内核 UNSUPPORTED_REASONING_
   * EFFORT 深层报错）。steer 携带=拒（模型/强度属新任务面——沿 steer+sourceSetId
   * 拒绝同款先例；引导命中运行中任务时模型已锁定不可改）。
   */
  model?: { provider: string; model: string; effort?: string | null };
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
  /**
   * 模型路由缓存失效+重解析（波 5 P1-3：modelsSave 保存成功后调用——新会话
   * agentOptions 跟随最新路由，无需重启 daemon）。
   */
  invalidateRouteCache(): void;
  followup(user: UserRow, sessionId: string, input: FollowupInput): Promise<{ taskId: string }>;
  /**
   * 打断当前轮（三通道 1.3，对齐 shufa b6cec8a tasks.stop——打断≠终态取消）：
   * live cancel{kind:'user'}+keepInbox + 任务置 done（error 清空）+终态帧；非
   * running/queued 幂等 no-op；已取消任务拒绝；job 族任务 no-op（无对话轮可打断）。
   * 任意内核态可调（live 已丢=重启窗口，行级 done 收口——不依赖 ready）。
   */
  stopTask(user: UserRow, taskId: string): void;
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
 * 缺省放宽至 30min（Owner 裁决 2026-09-29）：Agent 单轮对话常态串联 VLM（~115s）
 * +SAM（50-140s）+策略+导出多工具，M1 部署更慢——300s 兜底早判死仍在跑的轮次；
 * 此为最后兜底非目标时长，正常完成提前结束（FOLLOWUP_TIMEOUT_MS 毫秒可覆盖）。
 * 惰性读 env：模块加载期脚本（demo/冒烟）在 import 后才置 env，const 固化会丢覆盖。 */
const followupTimeoutMs = (): number => Number(process.env.FOLLOWUP_TIMEOUT_MS) || 1_800_000;

/**
 * engineStrategy 委派真身（registry.ts adapter 契约的接线层消费——strategies 子树
 * 不 import 引擎红线，故真身在 kernel facade；导出面=strategy.design 执行链测试
 * 的真引擎集成位）：TreeBlock（P0.2 引擎 Block 九字段同构+origin 第十字段）直通
 * 引擎 layout 公共出口（jobs/engine.ts 先例）；grid=gridFromSpec(round, gap=
 * ENGINE_DELEGATION_GAP_MM 缺省——冻结语义 pitchMm=diameterMm+gapMm)；density
 * 乘数与 seed 由 design 层换算注入（T3 绝对语义：densityRatio=densityPerCm2/
 * baseDensityPerCm2——engineDensityConversion 单源，gap 与基准容量同源防漂移；
 * nodeId FNV-1a）。
 */
export const strategyEngineDelegate: EngineLayoutDelegate = (request) => {
  const grid = gridFromSpec(
    { shapeId: 'round', sizeLabel: `${request.gemDiameterMm}mm`, diameterMm: request.gemDiameterMm },
    ENGINE_DELEGATION_GAP_MM,
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

/**
 * params JSON 剥离 error 键（三通道 1.3「error 清空」——贴钻的任务错误存于
 * params.error 而非独立列，见 JobService.setStatus）。非对象/解析失败原样返回。
 */
function paramsWithoutError(paramsJson: string | null): string | null {
  if (!paramsJson) return paramsJson;
  try {
    const parsed = JSON.parse(paramsJson) as Record<string, unknown>;
    if (!('error' in parsed)) return paramsJson;
    delete parsed['error'];
    return JSON.stringify(parsed);
  } catch {
    return paramsJson;
  }
}

export class HandicraftKernel implements DshKernelFacade {
  state: DshKernelState = 'unbooted';
  reason = '';
  readonly capabilities: CapabilityRegistry;
  readonly approvals: ApprovalService;
  /** 排钻工作台（人类直调面——桥/引擎委派与 capability 面同源实例）。 */
  readonly workbench: TaskWorkbench;
  /**
   * 项目钻清单 service（add-task-stones-manifest-export W1——A1 唯一写入面的内核
   * 持有实例：首条创建流经 writeManifestTx 与 task 行同事务提交初版 manifest）。
   */
  private readonly projectManifests: ProjectManifestService;
  private handle: HandicraftKernelHandle | null = null;
  private readonly taskSessions: StudioTaskSessions;
  private readonly watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private mcpConfigured = false;
  /** SAM 桥传输（SshSamTransport 时 stop 面优雅收口——P3.3 注入缝/env 装配）。 */
  private readonly samTransport: SamTransport | undefined;

  constructor(private readonly deps: HandicraftKernelDeps) {
    this.projectManifests = new ProjectManifestService({
      config: deps.config,
      db: deps.db,
      blobs: deps.blobs,
      jobs: deps.jobs,
    });
    this.approvals = new ApprovalService({
      db: deps.db,
      jobs: deps.jobs,
      // [W6 6.2] 项目域 grant 过期窗（env GRANT_PROJECT_TTL_MINUTES——缺省 30min）。
      grantProjectTtlMs: deps.config.grantProjectTtlMinutes * 60_000,
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
    // + strategy（P3.1 strategy.design 策略设计器）+ task 域（task-stones/export/
    // images/tree）+ tree 组装组合为单一 MCP 投影源（重名 fail fast）。SAM 桥共享
    // 实例（P2.2 队列/留存全量）：env 装配真
    // SshSamTransport（SAM_SSH_HOST 惰性会话）或合成 mock（SAM_BRIDGE_MOCK）/注入缝
    // deps.samTransport；未装配=subject.segment 降级面（P2.5 颜色分块）。scene.analyze
    // 桥在场时优先通道 A、unsupported 显式降通道 B（LLM 路由，SAM_ANALYZE_LIVE 门控）；
    // strategy 面真连同理 STRATEGY_DESIGN_LIVE 门控。engineStrategy 委派真身在下方
    // strategyEngineDelegate（strategies 子树不 import 引擎红线——registry adapter
    // 契约的接线层消费）。
    const samTransport = deps.samTransport ?? resolveKernelSamTransport();
    this.samTransport = samTransport;
    // 图像处理设置消费面（add-image-processing-settings §5.1/§5.2——调用时解析，改
    // 设置对 daemon 存续会话的下一次请求立即生效，不重启 kernel）：scene.analyze
    // 入线降采 provider + SAM 每请求调谐（segment wire params confThreshold/
    // maskMaxSide——null=原尺寸不发字段）。better-sqlite3 同步读，零 async 化。
    const intakeConfigProvider = () => {
      const v = imageProcessingEffective(deps.db, process.env);
      return { enabled: v.resampleEnabled, ppcmTarget: v.ppcmTarget };
    };
    const samRequestTuner = () => {
      const v = imageProcessingEffective(deps.db, process.env);
      return { confThreshold: v.samConfThreshold, maskMaxSide: v.samMaskMaxSide ?? undefined };
    };
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
      samRequestTuner,
      engineLayout: strategyEngineDelegate,
      // P2-4：task-layout 隐藏层过滤（workbench-view-state.json 帧定位）。
      dataRoot: deps.config.dataRoot,
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
      // 任务域项目钻工具（add-task-stones-manifest-export W2 2.1/2.2——arch-decisions
      // A4：list readonly + add approved-mutation 双模；manifest 唯一写面复用
      // ProjectManifestService CAS，lint 经 project-lint 单源）。
      createTaskStonesCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        config: deps.config,
        jobs: deps.jobs,
        approvals: this.approvals,
        onRunaway,
      }),
      // 任务域主图集观察工具（W5 走查 P0-1 双通道之二）：studio.task.images.list
      // readonly——{taskId}→主图集 imageId→blobRef 映射（通道一=首条 prompt 锚注；
      // 本工具为 agent 随时可查的持久保底：物料桥重编码后附件引用 ≠ daemon blobRef，
      // 工具入参的 imageBlobRef 一律取本映射的原始字节引用）。
      createTaskImagesCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        onRunaway,
      }),
      // 任务导出工具（add-task-stones-manifest-export W4 4.2/4.3——arch-decisions B1/B2/B3：
      // studio.task.export 双模（恒产每图 SVG+PNG+BOM 三件套——task-layout 快照单输入，
      // engine 公共出口只读复用+daemon buildTaskBom 按 stoneRef 聚合）+ exports.list
      // 多图历史读面（B3.5）；task-layout 生成器=executeStrategyPlan 同真源链末端）。
      createTaskExportCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        config: deps.config,
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
        // W1 入线降采调用时解析（add-image-processing-settings §5.1——analyze 每次
        // 经 provider 取 imageProcessingEffective 投影；analyzer 直注面保留优先）
        analyzerOptions: { intakeConfigProvider },
      }),
      createSubjectSegmentCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        jobs: deps.jobs,
        ...(samBridge !== undefined ? { bridge: samBridge } : {}),
        // SAM 每请求调谐（add-image-processing-settings §5.2——循环内逐请求解析）
        samRequestTuner,
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
      // Agent 树组装工具（realize-scene-understanding T2——Owner 2026-09-28 Agent
      // 循环架构：inspect/merge/refine/reparent/rename 五件；复用 workbench 内核
      // CAS 写路径+版本入史——与人类工作台同一后端原子）。
      createTreeCapabilities({
        db: deps.db,
        blobs: deps.blobs,
        jobs: deps.jobs,
        workbench: this.workbench,
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

  /** 诊断面：当前缓存路由（routeCache 观察口——P1-3 热生效回归测试用）。 */
  debugRoute(): StudioModelRoute | null {
    return this.routeCache;
  }

  /**
   * 模型路由（boot 解析缓存+modelsSave 后 invalidateRouteCache 重解析——P1-3
   * 热生效；null=未配置——内核缺省路由）。真源链（zhumo 方案移植块 A）：settings
   * 表 models_*（多路由 UI 配置面）优先 → .env LLM_* 单路由 fallback（迁移引导
   * ——loadRoutes 收编物化后同属 settings 真源）。
   */
  private routeCache: StudioModelRoute | null = null;

  private route(): StudioModelRoute | null {
    return this.routeCache;
  }

  /**
   * 模型路由缓存失效+重解析（波 5 P1-3：rpc modelsSave 保存成功后调用——
   * routeCache 此前仅 boot 解析，存续内核的新会话 agentOptions 被钉死旧路由，
   * 「保存后对新会话生效」失真（走查实证：改路由后新会话 turn 报 no provider/
   * model，重启后同配置正常外呼）。内核侧桥接面（settings.yaml/.credentials.yaml）
   * 由 dsh chokidar 热加载，daemon 侧只需本缓存跟随。重解析失败不抛（路由置空
   * +告警——内核缺省路由兜底，与 boot 降级语义一致）。
   */
  invalidateRouteCache(): void {
    try {
      this.resolveModelRoutes();
    } catch (error) {
      this.routeCache = null;
      console.warn(
        `[kernel] 模型路由缓存刷新失败（置空——新会话走内核缺省路由）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (this.state === 'ready') {
      this.reason =
        this.routeCache !== null
          ? `ready（LLM=${this.routeCache.provider}/${this.routeCache.model}，${this.routeCache.api}）`
          : 'ready（LLM 未配置——内核缺省路由，agent 请求期报 MISSING_CREDENTIAL）';
    }
  }

  /**
   * boot 真源解析：多路由真源（settings 表）优先；空且从未初始化才 .env 单路由
   * fallback（v6 复核 P1-3：settings 已初始化（含用户显式清空）时 fallback 终结
   * ——空路由=「未配置」，.env legacy 不得在内核面复活）。
   */
  private resolveModelRoutes(): ReturnType<typeof singleRouteBundle> | null {
    const { config, db } = this.deps;
    const stored = buildRoutesBundle(db, config.llm);
    if (stored.routes.length > 0) {
      // 默认模型路由投影（default 优先，缺省取首路由首模型——zhumo modelsRouteInfo 同式）。
      const host = stored.routes.find(
        (route) => route.provider === stored.default?.provider,
      ) ?? stored.routes[0]!;
      const modelId =
        host.models.find((entry) => entry.id === stored.default?.model)?.id ??
        host.models[0]?.id ??
        '';
      this.routeCache = {
        provider: host.provider,
        baseURL: host.baseURL,
        apiKey: host.apiKey,
        model: modelId,
        api: host.api,
        contextWindow: host.models.find((entry) => entry.id === modelId)?.contextWindow ?? 131072,
      };
      return stored;
    }
    if (modelsSettingsInitialized(db)) {
      // 已初始化（含显式清空）——.env 引导终结。缓存清空（P1-3：invalidateRouteCache
      // 重入此路径时不得残留旧路由——boot 首入无感，热失效后是正确性前提）。
      this.routeCache = null;
      return null;
    }
    const route = resolveSingleRoute(config.llm);
    this.routeCache = route;
    return route ? singleRouteBundle(route) : null;
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
      modelRoutes = this.resolveModelRoutes();
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
          ? `ready（LLM=${this.routeCache.provider}/${this.routeCache.model}，${this.routeCache.api}）`
          : 'ready（LLM 未配置——内核缺省路由，agent 请求期报 MISSING_CREDENTIAL）';
    }
  }

  /** followup 真实管线（W4.1 最小面）。ready 外调用=编程错误（rpc 已拦 501）。 */
  async followup(user: UserRow, sessionId: string, input: FollowupInput): Promise<{ taskId: string }> {
    if (this.state !== 'ready' || this.handle === null) {
      throw new Error(`内核未就绪（${this.state}）：${this.reason}`);
    }
    // 引导通道不带附件（附件登记/标注属新任务面——steer 改口是裸文本）；也不带
    // 集合配置（sourceSetId 属新任务面——0.3 沿 steer+附件拒绝同款先例形态）。
    if (input.mode === 'steer' && input.attachments !== undefined && input.attachments.length > 0) {
      throw new Error('引导通道（mode=steer）不支持附件——请用常规发送');
    }
    if (input.mode === 'steer' && input.sourceSetId !== undefined) {
      throw new Error('引导通道（mode=steer）不支持 sourceSetId——集合选择请用常规发送');
    }
    // [product-polish-w2] 模型/强度覆盖属新任务面：steer 携带=拒（模型已锁定的
    // 运行中任务不可改口；沿 steer+sourceSetId 同款先例）。
    if (input.mode === 'steer' && input.model !== undefined) {
      throw new Error('引导通道（mode=steer）不支持 model——模型/强度选择请用常规发送');
    }
    // 任务级覆盖前置校验（路由在场+effort 目录内——不静默回落，防深层内核报错
    // 或「chip 显示 high 实跑默认」的静默欺骗）。
    if (input.model !== undefined) {
      const { config, db } = this.deps;
      const route = resolveRouteFor(db, config.llm, input.model.provider, input.model.model);
      if (route === null) {
        throw new Error(`模型覆盖指向未配置路由：${input.model.provider}/${input.model.model}——请在后台模型配置中添加或改选`);
      }
      if (input.model.effort != null && input.model.effort !== '') {
        const efforts =
          loadModelsConfig(db, config.llm).routes
            .find((candidate) => candidate.provider === input.model!.provider)
            ?.models.find((entry) => entry.id === input.model!.model)?.efforts ?? [];
        if (!efforts.includes(input.model.effort)) {
          throw new Error(
            `强度档「${input.model.effort}」不在模型 ${input.model.model} 的 efforts 目录内（${efforts.join('、') || '无'}）`,
          );
        }
      }
    }
    // [product-polish-w1 T2] 会话级自动批准开关落库（最后写入者胜——先于 task 启动，
    // 本轮 task 内 capability 工具的 propose 即读到新值）。steer 同样生效（开关属会话面，
    // 非 sourceSetId 的任务面限定）；缺省不触碰（旧客户端/mock 不漂移存量真源）。
    if (input.autoApprove !== undefined) {
      setSessionAutoApprove(this.deps.db, sessionId, input.autoApprove);
    }
    await this.waitForStudioToolSurface();
    // 投递通道分流（三通道 1.3）：会话内有运行中的 live agent 任务 → steer 进其内核
    // 会话（影响当前轮、不新开任务，返回该任务 id）。无运行中任务（idle）时 steer
    // 等价开新轮——落入下方新任务路径（与 shufa「复活逻辑共用」同构）。
    if (input.mode === 'steer') {
      const liveTaskId = this.liveSteerableTask(sessionId);
      if (liveTaskId !== null) {
        // 引导是裸文本改口（契约层 text 或 attachments 至少其一——steer 通道恒有文本；
        // 此处显式复核防 daemon 侧直调绕过契约）。
        const steerText = input.text?.trim() ?? '';
        if (steerText === '') throw new Error('引导通道（mode=steer）需要非空文本');
        this.taskSessions.steer(liveTaskId, steerText);
        return { taskId: liveTaskId };
      }
    }
    const { db } = this.deps;
    // —— W1 1.1（arch-decisions A5「先校验后建行」顺序实改）——原实现先建 task 行
    // 后验证附件；现校验段全部前置（集合展开/附件治理），建行段单事务，启动段失败
    // 收口 failed——不留半成品 running task。
    // 集合选择仅首个常规 followup 有效（A5：后续常规 followup 沿同一 session-project
    // manifest，追加钻走 MCP stones.add——不能重选集合覆盖项目）。首个判定=会话内
    // 尚无 agent task 行（先于本条 task 的建行；校验拒路径零残留→重试仍是首个——
    // W0 裁量 3：失败首条重试放行 sourceSetId）。
    const isFirstRegularFollowup = !this.sessionHasAgentTask(sessionId);
    if (input.sourceSetId !== undefined && !isFirstRegularFollowup) {
      throw new Error('sourceSetId 仅在会话首个常规 followup 有效——后续轮次请用 studio.task.stones.add 追加钻');
    }
    // [校验段·纯读] 集合展开快照（A2 复制语义）：set owner（sets 现状=owner 隔离）/
    // 回收站/逐成员物化全链校验——无效成员 typed 拒（错误码+具体 stoneRef 清单），
    // 此时尚未建任何行=零残留（无 task 行/无 manifest 行）。
    let expansion: SetExpansion | null = null;
    if (input.sourceSetId !== undefined) {
      expansion = expandSourceSet({ db, blobs: this.deps.blobs }, user.id, input.sourceSetId);
    }
    // 首条主图集 imageId（A5 冻结：仅首条常规 followup 的附件按输入顺序分配
    // image-1..image-N 稳定图集——后续轮次附件=讨论插图不分配；assignTaskImageIds
    // =contracts 冻结的确定性单源）。
    const imageIds = isFirstRegularFollowup ? assignTaskImageIds(input.attachments?.length ?? 0) : [];
    // 初版 manifest 判定（幂等：session_projects 无行才写——W0 裁量 3；跳过集合=
    // sourceSet=null+entries=[] 的 rev1 空 manifest，A5）。携集合但项目已持清单
    // （防御态——正常不可达）=显式拒，不静默丢弃展开结果。
    const projectRow = getSessionProject(db, sessionId);
    if (projectRow !== null && expansion !== null) {
      throw new Error(`会话已持有项目清单（revision=${projectRow.revision}）——不能重选集合覆盖项目`);
    }
    const initManifestContent: ManifestContent | null =
      projectRow === null
        ? expansion !== null
          ? { sourceSet: expansion.sourceSet, entries: expansion.entries }
          : { sourceSet: null, entries: [] }
        : null;
    // 首条消息审计输入（A1：tasks.params 只留审计，不成为第二真源——展开快照落
    // session-project manifest）。imageIds=首条主图集分配审计（A5）。
    const auditParams = JSON.stringify({
      text: input.text ?? '',
      ...(input.attachments !== undefined && input.attachments.length > 0
        ? { attachments: input.attachments }
        : {}),
      ...(input.sourceSetId !== undefined ? { sourceSetId: input.sourceSetId } : {}),
      ...(input.autoApprove !== undefined ? { autoApprove: input.autoApprove } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(imageIds.length > 0 ? { imageIds } : {}),
    });
    // [建行段·单事务] 附件治理（split-admin-portal 2.2：会话 CAS 同事务 owner 校验+
    // acquireRef+账本行+字节读回+魔数嗅探）+ task 行 + 初版 manifest（writeManifestTx
    // 嵌套为 savepoint——task 行与 session_projects 状态行/CAS/blob 引用账本**同事务
    // 边界**原子提交；任一失败整体回滚=零残留）。manifest artifact 帧留事务外补发
    // （A1：JSONL 帧与 SQLite 无跨介质事务——帧失败≠写失败，repair 面收敛）。
    const committed = db.transaction((): {
      taskId: string;
      materials: AttachmentMaterial[];
      manifestBlobRef: string | null;
    } => {
      const materials = acquireSessionAttachments(
        { db, blobs: this.deps.blobs },
        user,
        sessionId,
        input.attachments ?? [],
      );
      const task = createAgentTask(db, {
        ownerId: user.id,
        sessionId,
        paramsJson: auditParams,
        status: 'running',
      });
      let manifestBlobRef: string | null = null;
      if (initManifestContent !== null) {
        manifestBlobRef = this.projectManifests.writeManifestTx(user, {
          sessionId,
          taskId: task.id,
          expectedRevision: 0,
          build: () => initManifestContent,
        }).blobRef;
      }
      return { taskId: task.id, materials, manifestBlobRef };
    })();
    const { taskId, materials, manifestBlobRef } = committed;
    if (manifestBlobRef !== null) {
      this.projectManifests.emitArtifactFrame(taskId, manifestBlobRef);
    }
    // 文本面：taskId 绑定标注保留；附件走原生图像内容块。首条带图=主图集 imageId
    // 锚定 + **imageId→blobRef 映射锚注**（W5 走查 P0-1 裁定：物料桥经 dsh
    // saveImages 重编码后，agent 可见附件引用 ≠ daemon blobRef（原始字节 sha），
    // 不投影映射则 scene.analyze/subject.segment 传错 ref 死锁——blobRef 是内容
    // 寻址引用非路径，不违 design §3「不拼路径进 prompt」；持久保底=studio.task.
    // images.list 工具）。后续轮次附件标注为讨论插图（不进图集）。
    const annotated =
      `${input.text ?? ''}\n\n[任务绑定 taskId=${taskId}——调用 studio.* 工具时 taskId 参数一律用这个值]` +
      (materials.length > 0
        ? imageIds.length > 0
          ? `\n[本消息附带 ${materials.length} 张图片（图像内容已随消息发送）；主图集 imageId→blobRef 映射按输入顺序：${imageIds
              .map((imageId, index) => `${imageId}=${materials[index]!.blobRef}`)
              .join('、')}——scene.analyze/subject.segment 等工具的 imageBlobRef 入参一律用这里的 blobRef（原始字节引用，与消息内附件引用不同源）；本会话各图的工件按 imageId 锚定，后续轮次附件为讨论插图不进图集；映射可随时经 studio.task.images.list 查询]`
          : `\n[本消息附带 ${materials.length} 张图片（图像内容已随消息发送；讨论插图——不进主图集）]`
        : '');
    // [启动段] agent 会话+看门狗——行已提交；此段失败按 A5 收口 failed（错误入
    // params.error，与 stopTask 收口同式），不留半成品 running task（原实现裸抛→
    // task 悬挂至看门狗超时兜底）。
    try {
      await this.taskSessions.createTaskSession(taskId, {
        cwd: this.deps.config.dataRoot,
        prompt: annotated,
        ...(materials.length > 0 ? { images: materials } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateTask(db, taskId, {
        status: 'failed',
        params: JSON.stringify({ ...(JSON.parse(auditParams) as Record<string, unknown>), error: message }),
      });
      throw error;
    }
    // 看门狗（骨架兜底：agent 挂起不结算时按超时失败——完整预算归 W4.2）。
    const budgetMs = followupTimeoutMs();
    const timer = setTimeout(() => {
      this.watchdogs.delete(taskId);
      this.taskSessions.failByTask(taskId, `followup 超时（${budgetMs / 1000}s 兜底）`);
    }, budgetMs);
    timer.unref?.();
    this.watchdogs.set(taskId, timer);
    void this.watchClear(taskId);
    return { taskId };
  }

  /**
   * 打断当前轮（三通道 1.3，对齐 shufa b6cec8a TaskService.stop——打断≠终态取消）：
   * 中止生成、任务回 done（可续聊——同会话再 followup 开新任务）。[Codex W10 P0-2
   * 裁定=前端外环] 排队消息的延续不依赖内核 inbox（cancel 的 keepInbox 仅对齐 dsh
   * 惯例、消费不承诺——live 随 settle dispose）；普通排队=前端队列唯一真源。
   * 与终态取消（tasks.cancel → cancelled 不可续聊、迟到帧被 fence 丢弃）语义不同。
   * 已取消任务拒绝；非 running/queued 幂等 no-op；job 族 no-op。live 已丢（daemon
   * 重启窗口/已收敛）时无活动可中止，行级 done 收口+终态帧补齐。
   */
  stopTask(user: UserRow, taskId: string): void {
    const task = this.deps.jobs.requireOwnedTask(user, taskId);
    if (task.status === 'cancelled') {
      // shufa 对齐：已取消的任务不可操作（CONFLICT 语义——本仓 ownedError 统一 BAD_REQUEST）。
      throw new Error('已取消的任务不可操作');
    }
    if (task.type !== 'agent') return; // job 族无对话轮可打断——no-op 返回现值。
    if (task.status !== 'running' && task.status !== 'queued') return; // 非 running 幂等。
    if (!this.taskSessions.stopByTask(taskId)) {
      // live 已丢：终态帧补齐（帧流收口）——emit 时行仍 running，fence 放行。
      this.deps.jobs.emitFor(taskId, 'done', {});
    }
    // 行收口：done + error 清空（params.error 剥离——shufa「error 清空」的贴钻形态，
    // error 存于 params JSON 而非独立列）。
    const fresh = getTaskById(this.deps.db, taskId) ?? task;
    updateTask(this.deps.db, taskId, { status: 'done', params: paramsWithoutError(fresh.params) });
  }

  /** 会话内最新运行中的 live agent 任务（steer 分流目标；dsh 会话身份=taskId）。 */
  private liveSteerableTask(sessionId: string): string | null {
    const rows = this.deps.db
      .prepare(
        "SELECT id FROM tasks WHERE session_id = ? AND type = 'agent' AND status = 'running' ORDER BY created_at DESC, id DESC",
      )
      .all(sessionId) as Array<{ id: string }>;
    for (const row of rows) {
      if (this.taskSessions.isLive(row.id)) return row.id;
    }
    return null;
  }

  /** 会话内是否已有 agent task（0.3：sourceSetId「仅首个常规 followup」判定锚）。 */
  private sessionHasAgentTask(sessionId: string): boolean {
    const row = this.deps.db
      .prepare("SELECT 1 FROM tasks WHERE session_id = ? AND type = 'agent' LIMIT 1")
      .get(sessionId);
    return row !== undefined;
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

  /**
   * 附件取得已外移（split-admin-portal 2.2）：治理面（CAS/owner/账本/嗅探）单源在
   * kernel/attachments.ts acquireSessionAttachments——followup 管线直接消费，本类
   * 不再持有私有实现（W4.1 的 registerAttachments 由此退役）。
   */

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
