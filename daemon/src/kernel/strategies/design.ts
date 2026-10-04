/**
 * LLM 策略设计器 `strategy.design`（add-subject-sam-pipeline P3.1 / design §1 S6+§5）。
 * 原始需求 2026-09-24（Owner 定调：贴钻这步大模型非常重要，也许不需要视觉——基于
 * object-tree 按提示词泛化，给每个图层设计贴钻方式；skill 层艺术家风格=后话，接口
 * styleId 预留）。propose 产物=StrategyPlan proposal（授权桥审批——两层编辑铁律：
 * 策略层=图层级，单钻层归设计师工作台）。
 *
 * 双模（照 S4/S7 授权桥接法——capability/{stones,sets}.ts 先例）：
 *   propose（带 treeArtifactRef）：装配设计上下文（ObjectTree 工件读回 + S1 stones
 *     投影候选集[activeSetId 时 S7 组合投影过滤] + registry 八策略族清单——close-paving-backlog
 *     T3 增 along-path）→ LLM 生成
 *     逐节点指派（纯文本上下文——W5 P1-3 起走 kernel/llm-route：settings 真源优先
 *     +三协议适配+.env 迁移回退，与 scene.analyze 通道 B 同源）
 *     → JSON 抽取容错 + contracts StrategyPlan schema 校验 + **每节点 params 经 registry
 *     paramsSchema 逐项校验**（非法=typed error 携节点+字段）→ proposal（diff 预览=
 *     逐节点指派表+风格字段透出；approval 族 `strategy-design`）。
 *   execute（带 proposalId）：StrategyPlan → 逐节点 applyStrategy 真执行（registry）
 *     [+ engineStrategy 声明式/显式委派——registry adapter 契约消费规则] → gems 汇总 →
 *     引擎校验门（间距/掩膜内——P1.4 gate.ts 复用）→ 产物 {gems, excludedRegions, plan
 *     落档}（putTaskArtifact：strategy-plan.json + strategy-gems.json + 叠加预览 PNG）。
 *
 * 包边界纪律（registry.ts 头注红线）：本文件属 strategies 子树——**不 import 引擎函数**。
 * engineStrategy 委派经注入缝 `EngineLayoutDelegate`（真身=kernel/index.ts 接线层沿
 * jobs/engine.ts 先例调 rhinestone-studio/engine 公共出口；缺席=typed 拒不静默空产）。
 *
 * 正交意图：
 *   [1] 设计上下文装配：树读回+钻候选投影（StonePick 候选集——idx 锚定 LLM 引用，
 *       daemon 真源回填，同 scene.analyze 锚点纪律）+策略族指引表（快照可测）。
 *   [2] prompt 模板纯函数（buildStrategyDesignPrompt——无 IO 无时钟，快照测试）+
 *       LLM 线面（三协议文本调用+JSON 抽取+typed error 分类——llm-route 公共模块）。
 *   [3] plan 装配与校验：stoneIdx 回填/producing 集覆盖完整性/registry params 逐项/
 *       free-code 工件化（CodeStrategyArtifact 内容寻址落 blob）。
 *   [4] 执行链：逐节点 apply+engine 委派+P1.4 强制门+三工件落档+gems 叠加渲染（P0.4
 *       preview 同款纯像素纪律：非纯白底+节点框+钻点阵）。
 *   [5] 工具面注册（studio.strategy.design——MCP 投影 mcp__studio__strategy_design
 *       过 tool-surface deny 名单；RUNAWAY 熔断照 studio.ts 先例）。
 * LLM key 只走 env→config（model-route 纪律）；live 门沿 P2.3 形态（缺省 mock=
 * typed 拒 live-disabled——真连走 STRATEGY_DESIGN_LIVE=1）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CodeStrategyArtifactSchema,
  DEFAULT_DENSITY_PER_CM2,
  KernelStrategyKindSchema,
  PavingStyleSchema,
  StrategyIdSchema,
  StrategyPlanSchema,
  nodeProducesBlock,
  taskLayoutArtifactName,
  type AgentImagePreview,
  type KernelStrategyKind,
  type PavingStyle,
  type NodeBBox,
  type ObjectTree,
  type StonePick,
  type StrategyAssignment,
  type StrategyPlan,
  type TaskImageId,
} from '@handicraft/contracts';
import type { LlmConfig } from '../../config.js';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import type { JobService } from '../../jobs/service.js';
import type { ApprovalService, ConsumeDenyReason } from '../../capability/authorization.js';
import { approvalFaceOf, canonicalJson } from '../../capability/authorization.js';
import type { ApprovedOpRow } from '../../db/approvals.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from '../../capability/core.js';
import { RUNAWAY_LIMIT } from '../../capability/studio.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import { encodePng, decodePng } from '../../png/codec.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { StoneService } from '../../stones/service.js';
import { SetService } from '../../stones/sets-service.js';
import {
  lintAssignments,
  putStoneLintArtifact,
  stoneLintArtifactOf,
  stoneLintResultOf,
  type StoneLintComputation,
} from '../project-lint.js';
import { writeTaskLayoutForExecution } from '../task-layout.js';
import {
  buildTextLlmWireRequest,
  extractLlmContentText,
  resolveLlmRoute,
  type LlmWireRequest,
  type ResolvedLlmRoute,
} from '../llm-route.js';
import { envTimeoutMs } from '../timeout-env.js';
import { loadObjectTreeArtifact } from '../vision/tree-persist.js';
import { latestReferenceImageBlobRef } from '../vision/reference-image.js';
import { downscaleRgbaNearest, segmentAgentPreviewEnabled, segmentAgentPreviewMaxSide } from '../vision/agent-preview.js';
import { treeToBlocks, type TreeBlock } from '../vision/tree-to-blocks.js';
import { EXPORT_GATE_GRID_GAP_MM, gateRequiredPairPx, gemInMask, validateCrossNodeGemSpacing, validateGemPlacement } from './sandbox/gate.js';
import {
  applyStrategy,
  createStrategyContext,
  STRATEGY_KINDS,
  STRATEGY_REGISTRY,
  type EngineStrategyId,
  type ExcludedRegion,
  type KernelGem,
  type StrategyResult,
  type StrategyWarning,
} from './registry.js';
import { stringToSeed } from './rng.js';

// ---------------------------------------------------------------- 冻结常量

/** 真连开关 env 键（=1 才真实外呼；缺省 mock——typed 拒 live-disabled，P2.3 同形）。 */
export const STRATEGY_DESIGN_LIVE_ENV = 'STRATEGY_DESIGN_LIVE';

/**
 * LLM 调用超时界（W5 P1-4：env STRATEGY_DESIGN_LLM_TIMEOUT_MS 可调，缺省 300s
 * ——与 scene.analyze 通道 B 同界收口；plan 生成为长输出任务）。惰性读 env。
 */
export const strategyDesignLlmTimeoutMs = (): number =>
  envTimeoutMs('STRATEGY_DESIGN_LLM_TIMEOUT_MS', 300_000);

/** LLM max_tokens 有界（逐节点指派+自由代码片段；free-code source 上限 256KB 级，16k tokens 首版界）。 */
export const STRATEGY_DESIGN_LLM_MAX_TOKENS = 16_384;

/** 交换留存根目录名（DATA_ROOT 下——scene-analyze-logs 同纪律；不含 apiKey）。 */
export const STRATEGY_DESIGN_LOGS_DIRNAME = 'strategy-design-logs';

/** 工具面名（MCP 投影 mcp__studio__strategy_design——studio. 前缀过 deny 名单）。 */
export const STRATEGY_DESIGN_TOOL_NAME = 'studio.strategy.design';

/** execute 三工件的 artifact 帧名（tasks.artifact 合法集=帧∪附件——executeStrategyPlan value.note 同约定）。 */
export const STRATEGY_PLAN_ARTIFACT_NAME = 'strategy-plan.json';
export const STRATEGY_GEMS_ARTIFACT_NAME = 'strategy-gems.json';
export const STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME = 'strategy-gems-preview.png';

/** 钻候选上限（prompt 有界——超限=typed 拒，收窄 stoneFilter 后重发）。 */
export const MAX_STONE_CANDIDATES = 200;

/**
 * 全排除树/无可用尺寸时的类型推断基准径（mm——仅 treeToBlocks 的 suggested 推断
 * 阈值与 ctx 构造下限用，不产钻不进 BOM；排除族 apply 不消费该值）。
 */
export const FALLBACK_GEM_DIAMETER_MM = 3;

/**
 * 引擎委派晶格 gap（mm）——kernel/index.ts strategyEngineDelegate 构造 GridSpec 的
 * 单一真源（gridFromSpec 冻结语义 pitchMm=diameterMm+gapMm）。密度换算（下方
 * engineDensityConversion）必须按**同一 gap** 推基准容量——两处同源防漂移。
 */
export const ENGINE_DELEGATION_GAP_MM = 0.4;

/**
 * 密度绝对语义换算（realize-scene-understanding T3 / Codex C2 公式修正版）：
 * densityPerCm2 永远是**绝对颗数密度**（颗/cm²——用户/策略层口径）；引擎 density
 * 只是 adapter 内部乘数（densityRatio）。基准容量按引擎实际晶格推导（hex 胞元：
 * 密度=2/(√3·pitch²)，pitchMm=钻径+gap **含 gap**——2mm 钻+0.4mm gap 基准≈20.05
 * 颗/cm²；2.3 颗/cm² ≈11.5% 满铺，非旧注释的「2.3=满铺基线上限」）：
 *
 *   pitchCm = (gemDiameterMm + gapMm) / 10
 *   baseDensityPerCm2 = 2 / (√3 · pitchCm²)
 *   densityRatio = densityPerCm2 / baseDensityPerCm2
 *
 * 容量界：densityRatio > 1（超基准容量）= typed 拒 density-capacity-exceeded——
 * 禁止静默 clamp 到 1（Codex C2 裁定；降 gap/换规格是调用方的显式决策）。
 * texture-fill 直达/fallback hex/其他引擎路径消费**同一绝对口径**（fallback 只改
 * 排布形态不改目标密度）。
 */
export function engineDensityConversion(
  densityPerCm2: number,
  gemDiameterMm: number,
  gapMm: number = ENGINE_DELEGATION_GAP_MM,
): { densityRatio: number; baseDensityPerCm2: number } {
  if (!(densityPerCm2 > 0) || !Number.isFinite(densityPerCm2)) {
    throw new StrategyDesignError(`densityPerCm2 必须为正有限数（实为 ${densityPerCm2}）`, 'plan-params-invalid');
  }
  if (!(gemDiameterMm > 0) || !Number.isFinite(gemDiameterMm)) {
    throw new StrategyDesignError(`gemDiameterMm 必须为正有限数（实为 ${gemDiameterMm}）`, 'plan-params-invalid');
  }
  const pitchCm = (gemDiameterMm + gapMm) / 10;
  const baseDensityPerCm2 = 2 / (Math.sqrt(3) * pitchCm * pitchCm);
  const densityRatio = densityPerCm2 / baseDensityPerCm2;
  if (densityRatio > 1 + 1e-9) {
    throw new StrategyDesignError(
      `密度 ${densityPerCm2} 颗/cm² 超出 ${gemDiameterMm}mm 钻+${gapMm}mm gap 的基准容量 `
        + `${Math.round(baseDensityPerCm2 * 100) / 100} 颗/cm²（densityRatio=${Math.round(densityRatio * 1000) / 1000}>1）`
        + '——降低密度/换更小钻径/降 gap 后重试（禁止静默 clamp 到满铺）',
      'density-capacity-exceeded',
    );
  }
  return { densityRatio, baseDensityPerCm2 };
}

// ---------------------------------------------------------------- typed error

export type StrategyDesignErrorKind =
  | 'invalid-input'
  | 'tree-missing'
  | 'tree-invalid'
  | 'stone-filter-empty'
  | 'stone-filter-oversize'
  | 'set-unresolvable'
  | 'llm-route-unconfigured'
  | 'live-disabled'
  | 'llm-call-failed'
  | 'llm-bad-json'
  | 'llm-invalid-plan'
  | 'plan-node-unknown'
  | 'plan-coverage-incomplete'
  | 'plan-params-invalid'
  | 'plan-stone-invalid'
  | 'plan-stone-unsized'
  /** 多候选物料节点（P0-2 校验前置——propose 即拒，不留到执行末端生成器拒产）。 */
  | 'plan-stone-multi-candidate'
  /** 密度超基准容量（engineDensityConversion 容量门——T3 禁止静默 clamp）。 */
  | 'density-capacity-exceeded'
  | 'engine-delegation-unavailable'
  | 'execute-failed'
  | 'fence'
  | 'internal';

/** strategy.design 统一 typed error（沿 SceneAnalyzeError kind 先例）。 */
export class StrategyDesignError extends Error {
  readonly kind: StrategyDesignErrorKind;

  constructor(message: string, kind: StrategyDesignErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StrategyDesignError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- 输入 schema

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（followup 注入提示中的 taskId——proposal 归属与 fence 的上下文）');

const TreeArtifactRefField = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .describe('object-tree.json 工件 blobRef（S5 产物——策略设计的树上下文真源）');

const ProposalIdField = z.string().min(1).describe('已批准 proposal id（执行模式——grant 服务端内部关联）');

/** 钻候选过滤（S1 投影过滤 + S7 组合投影——三键可组）。 */
export const StoneFilterSchema = z
  .object({
    supplier: z.string().min(1).optional().describe('供应商过滤（stone_index.supplier）'),
    family: z.string().min(1).optional().describe('色系过滤（stone_index.family）'),
    activeSetId: z
      .string()
      .min(1)
      .optional()
      .describe('生产组合 resourceId（S7 组合投影——候选限定为该组成员；CAS 绑定该组合 revision）'),
  })
  .strict();
export type StoneFilter = z.infer<typeof StoneFilterSchema>;

/** propose 模式输入（execute 模式={taskId, proposalId}——互斥）。 */
export const StrategyDesignProposeSchema = z
  .object({
    taskId: TaskIdField,
    treeArtifactRef: TreeArtifactRefField,
    stoneFilter: StoneFilterSchema.optional(),
    /**
     * 铺法（T4.4——任务级排钻风格显式参数，contracts PavingStyleSchema 单源）：
     * full=满铺/accent=点缀；缺省不指定=交策略按画面自定（现行为）。来源=followup
     * 首消息「铺法：满铺/点缀」表单行（与画布尺寸行同模式，agent 读消息传参）。
     */
    pavingStyle: PavingStyleSchema.optional(),
    /** 艺术家风格词表键（接口位冻结——词表空缺省，仅透传进 prompt 与 plan.styleId）。 */
    styleId: z.string().min(1).max(64).optional(),
    /** 自由文本风格提示（styleHint 优先消费；与 styleId 不互斥）。 */
    styleHint: z.string().min(1).max(2000).optional(),
    /** 补充设计指令（如「把这棵柳树按枝条贴」）。 */
    instruction: z.string().min(1).max(4000).optional(),
  })
  .strict();
export type StrategyDesignProposeInput = z.infer<typeof StrategyDesignProposeSchema>;

/** 双模外层 schema（照 S4/S7：外层全可选，propose 齐备性 handler 内二次校验）。 */
const StrategyDesignInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  treeArtifactRef: TreeArtifactRefField.optional(),
  stoneFilter: StoneFilterSchema.optional(),
  pavingStyle: StrategyDesignProposeSchema.shape.pavingStyle.optional(),
  styleId: StrategyDesignProposeSchema.shape.styleId.optional(),
  styleHint: StrategyDesignProposeSchema.shape.styleHint.optional(),
  instruction: StrategyDesignProposeSchema.shape.instruction.optional(),
});

// ---------------------------------------------------------------- 策略族指引表（prompt 单源）

/**
 * 八策略族 prompt 指引（快照冻结面——params 字段约束与各族 paramsSchema 人工对齐；
 * 完备性由测试断言键集===STRATEGY_KINDS。**校验真源是 registry paramsSchema**——
 * 本表只是 LLM 引导文本，漂移不改执行语义。close-paving-backlog：star 四参数面/
 * straight-line 取向场/along-path 新族同步（T1.3/T4/T3.1）。
 */
export const STRATEGY_FAMILY_GUIDES: Readonly<Record<KernelStrategyKind, { summary: string; params: string }>> = {
  'texture-fill': {
    summary:
      '纹理贴图法（面状/渐变节点首选——Owner 定调主力）：B 打底（加权 Voronoi 满铺）+ A 特征描线（ETF 流线）按 mode 路由',
    params:
      '{"mode":"scatter|flow|hybrid","polarity":"dark-dense|bright-dense|flat","lloydIters":8,"lineShare":0.4（仅 hybrid）}'
        + '——flow=沿亮度梯度流线（**Owner 2026-10-03 定调：有机曲线形状首选**——发丝/翅膀羽枝/花簇花篮/藤蔓/织物褶皱/流水云纹等一切「有纹理方向感」的区域，'
        + '线条感优先于均布感，顺着结构走向排）；scatter=满铺散布（仅大面积近似纯色平涂区）；hybrid=描线+满铺混合（主体结构描线+底面补铺）',
  },
  'soft-curve': {
    summary: '柔和曲线（布艺/缎带/绳索类）：骨架线（Zhang-Suen 细化）沿线贝塞尔布钻',
    params: '{"minBranchLengthMm":可选,"pointSpacingMm":可选}——缺省均由密度推导',
  },
  flower: {
    summary: '花形（花朵类节点）：极坐标分解——花心圆布+花瓣扇区（花瓣数可自动检测）',
    params: '{"petals":可选(3-64,缺省自动检测),"coreRadiusRatio":0.3,"petalDensity":1}',
  },
  'straight-line': {
    summary: '直线族（刚硬物：栏杆/杆件/机械——Owner：机械感慎用）：PCA 主轴平行线族；gradient-field=方向场弯曲折线族（曲面贴合）',
    params:
      '{"orientation":"global-pca(缺省)|gradient-field","lineSpacingMm":可选(平行线距/弯曲族法向分离),"angleOffsetDeg":0(仅 global-pca),"lumaB64":系统注入}'
        + '——gradient-field 需亮度场（缺席退化掩膜形状流+warning）',
  },
  geometry: {
    summary: '参数化几何（星/心/圆/矩/椭圆/螺旋——科技感/装饰图形；小节点不足可读下限自动降级引擎 hex）',
    params:
      '{"shape":"star","rays":可选(3-64,缺省=径向签名峰数自动检测),"innerRadiusRatio":0.4,"rotationDeg":270,'
        + '"centerOffsetPx":可选{"x":0,"y":0}(圆心偏移——缺省质心自动锚),"sparseness":1(沿射线步长倍数 0.2-5)}'
        + ' / {"shape":"heart","aspectRatio":1,"dentDepth":1}'
        + ' / {"shape":"circle"|"rect"|"ellipse"} / {"shape":"spiral","turns":6,"pitchMm":可选,"decay":1}',
  },
  exclusion: {
    summary: '排除（不产钻+BOM 未贴区注记——值得贴与否是主观决策，显式指派才生效，Owner 补充定调）',
    params: '{"reason":"中文原因（如「灯光不贴」「顾客要求留白」）}',
  },
  'free-code': {
    summary:
      '自由代码（复杂排布自写算法——沙箱执行无网无 fs，注入面 sandbox.{mask,scale,gem,geo,rand}；输出 {x,y} 钻数组，强制过引擎校验门）',
    params:
      '{"source":"function layout(sandbox){ const gems=[]; …return gems; }","entryPoint":"layout","seed":0}'
        + '——钻心须落在掩膜内且中心距≥sandbox.gem.diameterPx',
  },
  'along-path': {
    summary: '沿路径（路径形节点：边框/花环/描边/用户编辑折线——2026-09-21 Owner 预留兑现；outline=掩码边界等距线承接边框花环）',
    params:
      '{"pathSource":"outline(缺省,掩码边界+内缩)|custom(显式折线)","outlineInsetPx":可选(缺省 0.5×钻径),'
        + '"pathPts":[{"x":..,"y":..}](custom 必填,画布坐标),"spacing":可选(px 步长,缺省密度推导),"closed":false(仅 custom)}',
  },
};

// ---------------------------------------------------------------- [1] 设计上下文装配

/** 钻候选（idx=prompt 引用锚——LLM 输出 stoneIdx，daemon 回填 StonePick 真源）。 */
export interface StoneCandidate {
  /** 1 基索引（prompt 候选表行号——LLM 引用键） */
  idx: number;
  pick: StonePick;
  family: string;
}

/** 候选投影结果（含组合投影的 CAS 绑定面与不可用成员明示）。 */
export interface StoneCandidateProjection {
  candidates: StoneCandidate[];
  /** activeSetId 在场时的 CAS 绑定（批准期间组合被改=执行期 stale-revision 必拒）。 */
  casBinding: { resourceId: string; baseRevision: number } | undefined;
  /** 组合成员中不可用（不在投影内——软删/不在库）的 stoneRef（预览明示，不静默）。 */
  unavailableSetMembers: string[];
}

/**
 * S1 stones.list 投影 → 钻候选集（共享库读——评审 D-1 同 stones readonly 面；过滤
 * 在 stone_index 投影行上做，S4 工具面同层）。activeSetId=S7 组合投影（getSet 成员
 * 弱引用集过滤+owner 交叉校验+revision CAS 绑定——set.create clone 同款接法）。
 */
export function projectStoneCandidates(
  deps: { db: SqliteDb; blobs: BlobStore },
  input: { ownerId: string; filter?: StoneFilter },
): StoneCandidateProjection {
  const stones = new StoneService({ db: deps.db, blobs: deps.blobs });
  let rows = stones.listIndexRows().filter((row) => row.trashed === 0);
  const filter = input.filter;
  if (filter?.supplier !== undefined) rows = rows.filter((row) => row.supplier === filter.supplier);
  if (filter?.family !== undefined) rows = rows.filter((row) => row.family === filter.family);

  let casBinding: StoneCandidateProjection['casBinding'] = undefined;
  let unavailableSetMembers: string[] = [];
  if (filter?.activeSetId !== undefined) {
    // owner 交叉校验（组合读写均按 owner 隔离——评审 D-1）。
    const row = deps.db
      .prepare('SELECT owner_id FROM resources WHERE id = ?')
      .get(filter.activeSetId) as { owner_id: string } | undefined;
    if (row === undefined) {
      throw new StrategyDesignError(`生产组合不存在：${filter.activeSetId}`, 'set-unresolvable');
    }
    if (row.owner_id !== input.ownerId) {
      throw new StrategyDesignError('生产组合不属于当前任务归属用户（跨用户组合访问必拒）', 'set-unresolvable');
    }
    const sets = new SetService({ db: deps.db, blobs: deps.blobs, stones });
    let detail: ReturnType<SetService['getSet']>;
    try {
      detail = sets.getSet(filter.activeSetId);
    } catch (error) {
      throw new StrategyDesignError(
        `生产组合不可解析（${filter.activeSetId}）：${error instanceof Error ? error.message : String(error)}`,
        'set-unresolvable',
        { cause: error },
      );
    }
    if (detail.trashed) {
      throw new StrategyDesignError('目标组合在回收站内（先恢复再用于策略设计）', 'set-unresolvable');
    }
    const memberRefs = new Set(detail.set.stones.map((member) => member.stoneRef));
    rows = rows.filter((row) => memberRefs.has(row.resource_id));
    unavailableSetMembers = [...memberRefs].filter((ref) => !rows.some((row) => row.resource_id === ref)).sort();
    // CAS 绑定：批准期间组合被改（成员增删/revision 前进）=执行期 grant 漂移必拒。
    casBinding = { resourceId: detail.resourceId, baseRevision: detail.revision };
  }

  if (rows.length === 0) {
    throw new StrategyDesignError(
      `钻候选集为空（filter=${JSON.stringify(filter ?? {})}——LLM 无 palette 可指派；放宽过滤或先入库钻规格）`,
      'stone-filter-empty',
    );
  }
  if (rows.length > MAX_STONE_CANDIDATES) {
    throw new StrategyDesignError(
      `钻候选 ${rows.length} 款超上限 ${MAX_STONE_CANDIDATES}（prompt 有界——用 stoneFilter.supplier/family/activeSetId 收窄后重发）`,
      'stone-filter-oversize',
    );
  }
  const candidates: StoneCandidate[] = rows.map((row, i) => ({
    idx: i + 1,
    pick: {
      resourceId: row.resource_id,
      sku: row.sku,
      supplier: row.supplier,
      sizeMm: row.size_mm,
      colorHex: row.color_hex,
    },
    family: row.family,
  }));
  return { candidates, casBinding, unavailableSetMembers };
}

/**
 * 工作台色板投影（2026-10-04 Owner 报障「属性面板无法选择钻」根因修复）：
 * `projectStoneCandidates` 的 200 款上限是 **LLM prompt 有界面**（策略设计候选表）；
 * task.detail 色板与 resolveStones 回填此前误用该投影——钻库超 200（生产实例 990
 * 款）时 stone-filter-oversize 抛错→task.detail catch 置空（色板恒「候选表为空」）、
 * resolveStones 直拒（应用必败）。UI 面无 prompt 界，单开本投影：
 * - 同 listIndexRows 稳定序同形状（idx=全库 1 基位——与 resolveStones 回填共用同一
 *   编号空间；agent 策略设计的 filter 后 idx 是另一空间，两不串）；
 * - 无 200 上限、无 activeSetId 面、空库=空数组（UI 语义：引导入库，不抛）。
 */
export function projectStonePalette(deps: { db: SqliteDb; blobs: BlobStore }): StoneCandidate[] {
  const stones = new StoneService({ db: deps.db, blobs: deps.blobs });
  const rows = stones.listIndexRows().filter((row) => row.trashed === 0);
  return rows.map((row, i) => ({
    idx: i + 1,
    pick: {
      resourceId: row.resource_id,
      sku: row.sku,
      supplier: row.supplier,
      sizeMm: row.size_mm,
      colorHex: row.color_hex,
    },
    family: row.family,
  }));
}

/**
 * 产块节点判定（v5 Owner 裁定 2026-09-28：图层=PS 图层，钻=图层特效 fx——图层拆成
 * 子图层后只有子图层能套钻）：**恒=叶子**（children.length===0）。中间节点（组）
 * 不论 drillWorthy 不产钻不产块（drillWorthy 降为建议面标注，不参与产块裁定）——
 * v4「叶子 || drillWorthy」允许中间节点产钻是排钻嵌套根因（父层 159 颗与子层 150
 * 颗坐标重叠叠排），已废止。判定单源=contracts nodeProducesBlock（修复轮 R1e——
 * 本函数与 tree-to-blocks producesBlock/前端/导出面四处同源，不再内联维护）。
 */
function producesBlockOf(node: ObjectTree['nodes'][number]): boolean {
  return nodeProducesBlock(node);
}

/** 树节点深度（根=0——prompt 缩进与摘要用）。 */
function depthMapOfTree(tree: ObjectTree): Map<string, number> {
  const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
  const depths = new Map<string, number>();
  for (const node of tree.nodes) {
    let depth = 0;
    let cur = node;
    while (cur.parent !== null) {
      depth++;
      const parent = byId.get(cur.parent);
      if (parent === undefined) break;
      cur = parent;
    }
    depths.set(node.id, depth);
  }
  return depths;
}

// ---------------------------------------------------------------- [2] prompt 模板（纯函数）

/** prompt 装配上下文（buildStrategyDesignPrompt 输入——快照测试面）。 */
export interface StrategyDesignPromptContext {
  tree: ObjectTree;
  candidates: StoneCandidate[];
  styleId?: string;
  styleHint?: string;
  instruction?: string;
  /** 铺法（T4.4——缺省不指定=无该行，prompt 字节零变化）。 */
  pavingStyle?: PavingStyle;
}

/** 节点摘要行（物理量四元组：有效尺寸/色方差/bbox/面积——design §2 判据数据随树流转）。 */
function nodeSummaryLines(tree: ObjectTree, predicate: (node: ObjectTree['nodes'][number]) => boolean): string[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
  const depths = depthMapOfTree(tree);
  const ppm = tree.imagePx.width / (tree.canvasCm.w * 10); // px/mm（x 轴——schema 已保证纵横比一致）
  const lines: string[] = [];
  for (const node of tree.nodes) {
    if (!predicate(node)) continue;
    const parentName = node.parent === null ? null : byId.get(node.parent)?.objectName ?? null;
    const areaCm2 = (node.bbox.w * node.bbox.h) / (ppm * ppm * 100);
    lines.push(
      `${'  '.repeat(depths.get(node.id) ?? 0)}- ${node.id} ${node.objectName}${parentName !== null ? `（父：${parentName}）` : ''}`
        + ` [${node.category}] 有效尺寸 ${Math.round(node.effectiveMm * 10) / 10}mm 色方差 ${Math.round(node.labVariance * 10) / 10}`
        + ` bbox ${node.bbox.w}×${node.bbox.h}px ≈${Math.round(areaCm2 * 10) / 10}cm² drillWorthy=${node.drillWorthy}`,
    );
  }
  return lines;
}

/**
 * S6 策略设计 prompt（纯函数——同上下文同文本，快照可测）。
 * 约束来源：owner-directive（四族展开+每图层该有的贴法）+design §9 回流 2（未分配
 * 区域不允许悬空→可贴节点全覆盖）+§10 回流 1（hex 族风格门控默认关）+定稿增量①②
 * （StonePick 引用/密度 2.3）。stoneIdx=候选表 idx 锚定（daemon 真源回填）。
 */
export function buildStrategyDesignPrompt(ctx: StrategyDesignPromptContext): string {
  const assignable = nodeSummaryLines(ctx.tree, producesBlockOf);
  const nonAssignable = nodeSummaryLines(ctx.tree, (node) => !producesBlockOf(node));
  const candidateLines = ctx.candidates.map(
    (candidate) =>
      `- ${candidate.idx} ${candidate.pick.supplier}/${candidate.pick.sku} `
      + `${candidate.pick.sizeMm !== null ? `${candidate.pick.sizeMm}mm` : '无尺寸'} ${candidate.pick.colorHex} ${candidate.family}`,
  );
  const familyBlocks = STRATEGY_KINDS.map((kind) => `- ${kind}：${STRATEGY_FAMILY_GUIDES[kind].summary}\n  params：${STRATEGY_FAMILY_GUIDES[kind].params}`);
  return [
    '你是贴钻产线的策略设计师（管线 S6）。基于 object-tree（主体分割产物）为每个图层设计贴钻策略，只输出一个 JSON 对象（禁止 JSON 以外的文字）：',
    '{"assignments":[{"nodeId":"n1","strategyKind":"texture-fill","params":{"mode":"flow","polarity":"dark-dense"},"stoneIdx":[1],"densityPerCm2":2.3,"rationale":"中文一句话理由"}]}',
    '指派规则：',
    '- 纹理优先：texture-fill 是绝大部分场景的通用缺省；规整族（straight-line/geometry 等）仅在「画面硬朗且填充区接近纯色」时作为低成本解选用。',
    '- 线条感优先（Owner 2026-10-03 定调）：有纹理方向感的有机形状（发丝/翅膀羽枝/花簇花篮/藤蔓/褶皱/云流水纹）一律 texture-fill mode=flow——'
    + '沿结构走向流线排布，显著优先于 scatter 均布；scatter 仅限大面积近纯色平涂。花朵整朵可另选 flower 族（花形径向）。',
    '- 同角色一致性（Owner 2026-10-03 定调）：画面内同类同角色的对称/并列部位（如多个人物的同类部位、左右翅膀）'
    + '应使用相同的 strategyKind/mode/钻色系/密度——除非用户显式要求差异化；禁止因节点拆分先后不同而风格漂移。',
    '- assignments 必须逐节点覆盖「可贴节点清单」的全部节点，一条不缺（未分配区域不允许悬空——设计回流 2）；不值得贴钻的节点用 exclusion 显式指派并给 reason。',
    '- 「层级节点清单」内的节点不产钻，禁止出现在 assignments。',
    '- stoneIdx 引用「钻候选表」的 idx（1 基）；**每节点恰指派一款钻（stoneIdx 单值，如 [1]）**'
    + '——多款候选会被 typed 拒（plan-stone-multi-candidate：执行链无法在多款候选中确定物料）；'
    + '所选钻须有尺寸（sizeMm 非空；exclusion 除外——其 stoneIdx 可省略）。'
    + '**例外：携带 gapFill 混排的节点恰指派两款（stoneIdx=[打底钻,补隙钻]，如 [1,2]）**。',
    '- 密度 densityPerCm2 必须为正数（颗/cm²，绝对颗数密度语义——非满铺比例）；缺省 2.3 颗/cm²（Owner 定调常数），可逐节点覆盖；'
    + '引擎乘数按实际晶格换算（如 2mm 钻+0.4mm gap 基准容量≈20 颗/cm²，2.3≈11.5% 满铺）。'
    + '建议范围 0.5-8 颗/cm²；超出所选钻径的基准容量会被 typed 拒（density-capacity-exceeded——降密度/换小钻径）。',
    '- engineStrategy 可选（hex-thin|hex-pitch|poisson|hybrid|cvt——显式路由引擎五策略；机械感强，仅科技感/高达类风格用，默认不用）。',
    '- **gapFill 多尺寸混排（可选——客户 3mm+10mm 场景：大钻打底后小钻补隙）**：'
    + '{"gapFill":{"stoneIdx":补隙钻 idx（1 基，即 stoneIdx 第二款）,"minGapRatio":1.0}}；'
    + '补隙钻须同时列入该节点 stones 候选（stoneIdx 两款）；exclusion/free-code 不可携带 gapFill（typed 拒）；'
    + '补隙量由几何空隙自然决定（不吃 densityPerCm2）。',
    '- params 必须符合「策略族」各 kind 的字段约束（多余/越界字段会被逐项校验拒绝）。',
    '- rationale 必给（中文一句话——proposal 人工可审性；缺席/空串=typed 拒）。',
    '- 每条指派只允许这些键：nodeId/strategyKind/params/stoneIdx/densityPerCm2/engineStrategy/gapFill/rationale——发明其余键（如 stoneId/gemSize/color）一律 typed 拒。',
    '可贴节点清单（nodeId 名称（父名） [类别] 有效尺寸 色方差 bbox 面积——必须逐节点指派）：',
    ...(assignable.length > 0 ? assignable : ['-（空——树无可贴节点，不应到达本工具）']),
    '层级节点清单（中间节点不产钻——禁止指派）：',
    ...(nonAssignable.length > 0 ? nonAssignable : ['-（无）']),
    `钻候选表（idx 供应商/SKU 尺寸 颜色 色系——共 ${ctx.candidates.length} 款；stoneIdx 只能引用这些 idx）：`,
    ...candidateLines,
    '钻形×铺法参考标准（Owner 2026-09-24 指引——选择倾向，非硬规则；候选集含对应形状时优先）：',
    '- 花瓣区→drop 泪滴形钻（径向对齐——花角度函数已备）；花心→round 圆钻、径大于花瓣钻。',
    '- 其余铺法无硬规则——候选集按形状语义就近选择。',
    '策略族（strategyKind 八值）：',
    ...familyBlocks,
    ...(ctx.styleId !== undefined ? [`风格词表键 styleId=${ctx.styleId}（词表暂空——仅透传，不作语义依据）`] : ['风格词表键 styleId 未给（词表暂空——接口位预留）']),
    ...(ctx.styleHint !== undefined ? [`风格提示：${ctx.styleHint}`] : ['风格提示：未给（按各节点物性默认审美路由——面状走纹理、线状走柔和曲线/流线、花朵走花形）']),
    ...(ctx.instruction !== undefined ? [`补充指令：${ctx.instruction}`] : ['补充指令：未给']),
    ...(ctx.pavingStyle !== undefined
      ? [
          ctx.pavingStyle === 'full'
            ? '铺法：满铺（full）——整体铺满导向：可贴节点一律铺钻，密度取所选钻径基准容量带（接近满铺、不超容量门），exclusion 仅限用户显式要求留白或不可贴区域'
            : '铺法：点缀（accent）——关键部位点缀导向：主体结构/轮廓/特征部位贴钻，大面积底面用低密度（0.5-2 颗/cm² 带）或 exclusion 显式留白（给 reason）',
        ]
      : []),
  ].join('\n');
}

// ---------------------------------------------------------------- JSON 抽取（scene-analyze 同构容错）

/** LLM 输出 → JSON 文本（fenced / ```json 剥壳；前后缀噪声取首 { 到尾 }）。 */
export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenceMatch !== null) return fenceMatch[1]!.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/** 原文摘要（typed error 携带——截断防日志爆炸）。 */
function excerpt(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字符）`;
}

// ---------------------------------------------------------------- [3] LLM 响应 → StrategyPlan

/**
 * LLM 指派松 schema（stoneIdx 锚定引用；params 自由记录——registry 逐项校验是真源）。
 * strict（P0-4 提示词加固）：发明键（stoneId/gemSize 等）typed 拒不静默剥落——
 * LLM 键名幻觉会以「静默忽略→语义漂移」形态进 plan，宁可拒之自纠。
 */
const LlmAssignmentSchema = z
  .object({
    nodeId: z.string().min(1),
    strategyKind: z.string().min(1),
    params: z.record(z.string(), z.unknown()).default({}),
    stoneIdx: z.array(z.number().int().min(1).max(MAX_STONE_CANDIDATES)).max(64).optional(),
    /**
     * 多尺寸混排（T2——LLM 线面以候选 idx 锚定，daemon 回填 stoneRef 真源——同
     * stoneIdx 纪律；策略 kind 面 exclusion/free-code 组合由 contracts superRefine 拒）。
     */
    gapFill: z
      .object({
        stoneIdx: z.number().int().min(1).max(MAX_STONE_CANDIDATES),
        minGapRatio: z.number().gte(1).lte(3).optional(),
      })
      .strict()
      .optional(),
    /** 正数硬约束（颗/cm²——绝对密度语义）；缺省=终验 parse 回填 2.3（Owner 基线）。 */
    densityPerCm2: z.number().positive().optional(),
    engineStrategy: z.string().min(1).optional(),
    rationale: z.string().min(1),
  })
  .strict();

/** sandbox 注入面 API 名单提取（声明式审计元数据——运行时真源是沙箱白名单注入）。 */
function declaredApiCallsOf(source: string): string[] {
  const hits = new Set<string>();
  for (const match of source.matchAll(/\bsandbox\s*\.\s*(mask|scale|gem|geo|rand)(?:\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*)?/g)) {
    hits.add(`sandbox.${match[1]}`);
  }
  return [...hits].sort();
}

/**
 * free-code 指派工件化（contracts StrategyAssignment 契约：free-code 必携带
 * codeArtifactRef）：params.source/entryPoint/seed → CodeStrategyArtifact →
 * 内容寻址 blob（propose 期 blobs.put——未批准时为无引用残留，preview blob 同暴露面）。
 * 执行期从 params inline 通道消费（registry free-code 本波形态）+工件引用可审计。
 * （P4.2-workbench 起 export——工作台策略直改面复用同一工件化真身。）
 */
export function persistFreeCodeArtifact(blobs: BlobStore, assignment: { params: Record<string, unknown> }): string {
  const source = assignment.params['source'];
  const entryPoint = assignment.params['entryPoint'];
  const seed = assignment.params['seed'];
  if (typeof source !== 'string' || source.length === 0) {
    throw new StrategyDesignError('free-code 指派 params.source 缺失（inline 通道——P3.1 LLM 流形态）', 'plan-params-invalid');
  }
  const artifact = CodeStrategyArtifactSchema.parse({
    kind: 'free-code-artifact',
    formatVersion: 1,
    language: 'javascript',
    source,
    entryPoint: typeof entryPoint === 'string' && entryPoint.length > 0 ? entryPoint : 'layout',
    seed: typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 ? seed : 0,
    declaredApiCalls: declaredApiCallsOf(source),
    createdAt: new Date().toISOString(),
  });
  return blobs.put(new Uint8Array(Buffer.from(JSON.stringify(artifact, null, 1), 'utf8'))).hash;
}

/** plan 装配+校验结果（propose 面与单测共用）。 */
export interface AssembledPlan {
  plan: StrategyPlan;
  /** LLM 原始指派数（=plan.assignments.length——一致性由校验保证）。 */
  assignmentCount: number;
}

/**
 * LLM 载荷 → StrategyPlan（daemon 真源回填纪律：stoneIdx→StonePick、objectTreeRef、
 * createdAt；free-code→工件化）。校验链（每步 typed error 携节点+字段）：
 * 松 schema → 候选回填 → kind/params（registry paramsSchema 逐项）→ producing 集
 * 成员/覆盖完整性 → 尺寸依据 → contracts StrategyPlanSchema 终验。
 */
export function assembleStrategyPlan(input: {
  tree: ObjectTree;
  treeArtifactRef: string;
  llmPayload: unknown;
  candidates: StoneCandidate[];
  styleId?: string;
  blobs: BlobStore;
}): AssembledPlan {
  const assignmentsRaw = z.array(LlmAssignmentSchema).min(1).safeParse(
    typeof input.llmPayload === 'object' && input.llmPayload !== null && 'assignments' in input.llmPayload
      ? (input.llmPayload as { assignments?: unknown }).assignments
      : undefined,
  );
  if (!assignmentsRaw.success) {
    throw new StrategyDesignError(
      `LLM 输出 assignments 校验失败（自纠：每条指派恰含 nodeId/strategyKind/params/stoneIdx/densityPerCm2?/engineStrategy?/rationale——`
        + `rationale 必填非空、densityPerCm2 须为正数、stoneIdx 单值、禁发明其余键）：`
        + assignmentsRaw.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      'llm-invalid-plan',
      { cause: assignmentsRaw.error },
    );
  }

  const candidateByIdx = new Map(input.candidates.map((candidate) => [candidate.idx, candidate] as const));
  const nodeById = new Map(input.tree.nodes.map((node) => [node.id, node] as const));
  const producingIds = new Set(input.tree.nodes.filter(producesBlockOf).map((node) => node.id));

  // 中间形态=StrategyAssignment 的 z.input 面（densityPerCm2 缺省由终验 parse 回填——
  // Owner 基线 2.3）；输出以 planCheck.data 为准（类型即校验证明）。
  const assignments = assignmentsRaw.data.map((raw) => {
    // —— 候选回填（stoneIdx → StonePick 真源；幻觉 idx typed 拒）
    let stones: StonePick[] = [];
    for (const idx of raw.stoneIdx ?? []) {
      const candidate = candidateByIdx.get(idx);
      if (candidate === undefined) {
        throw new StrategyDesignError(
          `节点 ${raw.nodeId} 的 stoneIdx=${idx} 不在钻候选表（1..${input.candidates.length}）——幻觉引用必拒`,
          'plan-stone-invalid',
        );
      }
      stones.push(candidate.pick);
    }
    // —— kind 校验（KernelStrategyKind 八值之外 typed 拒）
    const kindCheck = KernelStrategyKindSchema.safeParse(raw.strategyKind);
    if (!kindCheck.success) {
      throw new StrategyDesignError(
        `节点 ${raw.nodeId} 的 strategyKind=${raw.strategyKind} 不在八值枚举（texture-fill/soft-curve/flower/straight-line/geometry/exclusion/free-code/along-path）`,
        'llm-invalid-plan',
      );
    }
    const kind = kindCheck.data;
    // —— params 逐项校验（registry paramsSchema——合法性校验真源）
    const entry = STRATEGY_REGISTRY.get(kind);
    if (entry === undefined) {
      throw new StrategyDesignError(`策略 ${kind} 不在注册表（八值之外——KernelStrategyKindSchema 先行校验）`, 'llm-invalid-plan');
    }
    const paramsCheck = entry.paramsSchema.safeParse(raw.params);
    if (!paramsCheck.success) {
      throw new StrategyDesignError(
        `节点 ${raw.nodeId} 的 ${kind} params 非法：${paramsCheck.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
        'plan-params-invalid',
        { cause: paramsCheck.error },
      );
    }
    // —— engineStrategy 五值校验（contracts StrategyIdSchema）
    if (raw.engineStrategy !== undefined && !StrategyIdSchema.safeParse(raw.engineStrategy).success) {
      throw new StrategyDesignError(
        `节点 ${raw.nodeId} 的 engineStrategy=${raw.engineStrategy} 不在引擎五策略（hex-thin|hex-pitch|poisson|hybrid|cvt）`,
        'llm-invalid-plan',
      );
    }
    // —— producing 集成员（未知节点/层级节点均 typed 拒——携可判别信息）
    if (!nodeById.has(raw.nodeId)) {
      throw new StrategyDesignError(`节点 ${raw.nodeId} 不在 object-tree（幻觉 nodeId 必拒）`, 'plan-node-unknown');
    }
    if (!producingIds.has(raw.nodeId)) {
      throw new StrategyDesignError(
        `节点 ${raw.nodeId} 是层级节点（中间不产钻——禁止指派；可贴节点清单见 prompt）`,
        'plan-node-unknown',
      );
    }
    // —— 尺寸依据（未声明尺寸的钻不可排钻——非 exclusion 至少 1 款非空 sizeMm）
    if (kind !== 'exclusion' && !stones.some((stone) => stone.sizeMm !== null)) {
      throw new StrategyDesignError(
        `节点 ${raw.nodeId} 的 ${kind} 指派缺少尺寸依据（至少 1 款 sizeMm 非空候选钻——未声明尺寸的钻不可排钻）`,
        'plan-stone-unsized',
      );
    }
    // —— 多候选前置校验（P0-2 真链走查：多候选物料节点此前在**执行末端**被 task-layout
    //    生成器拒产（策略产物 colorId 恒 ''，无法在多款候选中唯一匹配物料——B2 不能猜），
    //    生成器一拒整链无 task-layout 工件、导出面才 typed 拒——代价是批准后才发现。
    //    前置到 propose：LLM 计划校验即拒，错误消息即自纠指引（每节点恰一款钻）。
    //    T2 例外：携带 gapFill 的混排指派恰两款（打底+补隙）——物料身份走混径匹配
    //    （task-layout materialIdentityOf 按 gem.diameterMm↔sizeMm 唯一匹配）。
    if (kind !== 'exclusion' && raw.gapFill === undefined && stones.length > 1) {
      throw new StrategyDesignError(
        `节点 ${raw.nodeId} 的 ${kind} 指派携带 ${stones.length} 款候选钻（stoneIdx=${(raw.stoneIdx ?? []).join(',')}）`
        + '——当前执行链不支持多候选物料：策略产物 colorId 恒为空串，无法在多款候选中唯一确定物料'
        + '（task-layout 生成器必拒、导出必阻断）。每节点恰指派一款钻（stoneIdx 单值；'
        + '多尺寸混排用 gapFill 通道——stoneIdx 两款+gapFill.stoneIdx 指补隙款）后重发',
        'plan-stone-multi-candidate',
      );
    }
    // —— gapFill 回填（T2）：LLM idx 锚定 → stoneRef 真源；补隙钻强制列入 stones
    //    （contracts superRefine 要求 stoneRef∈stones——LLM 只给 gapFill.stoneIdx 不列
    //    stoneIdx 时防御性补入）；exclusion/free-code 组合由终验 superRefine typed 拒。
    //    （minGapRatio 缺省由终验 parse 回填 1.0——中间形态=input 面）
    let gapFill: { stoneRef: string; minGapRatio?: number } | undefined;
    if (raw.gapFill !== undefined) {
      const fillCandidate = candidateByIdx.get(raw.gapFill.stoneIdx);
      if (fillCandidate === undefined) {
        throw new StrategyDesignError(
          `节点 ${raw.nodeId} 的 gapFill.stoneIdx=${raw.gapFill.stoneIdx} 不在钻候选表（1..${input.candidates.length}）——幻觉引用必拒`,
          'plan-stone-invalid',
        );
      }
      if (!stones.some((pick) => pick.resourceId === fillCandidate.pick.resourceId)) {
        stones = [...stones, fillCandidate.pick];
      }
      gapFill = {
        stoneRef: fillCandidate.pick.resourceId,
        ...(raw.gapFill.minGapRatio !== undefined ? { minGapRatio: raw.gapFill.minGapRatio } : {}),
      };
    }
    // —— 密度容量前置（P0-4 提示词加固配套：density-capacity-exceeded 原在执行链
    //    （executeStrategyPlan→engineDensityConversion）才拒——批准后才发现。propose
    //    即拒，消息即自纠指引（降密度/换小钻径）。缺省密度与执行链同源 2.3。
    if (kind !== 'exclusion') {
      const sized = stones.map((stone) => stone.sizeMm).filter((size): size is number => size !== null);
      engineDensityConversion(raw.densityPerCm2 ?? DEFAULT_DENSITY_PER_CM2, Math.max(...sized));
    }
    // —— free-code 工件化（contracts 契约：codeArtifactRef 必携带）
    const codeArtifactRef = kind === 'free-code' ? persistFreeCodeArtifact(input.blobs, { params: raw.params }) : undefined;
    return {
      nodeId: raw.nodeId,
      strategyKind: kind,
      params: raw.params,
      stones,
      ...(raw.densityPerCm2 !== undefined ? { densityPerCm2: raw.densityPerCm2 } : {}),
      ...(raw.engineStrategy !== undefined ? { engineStrategy: raw.engineStrategy } : {}),
      ...(gapFill !== undefined ? { gapFill } : {}),
      ...(codeArtifactRef !== undefined ? { codeArtifactRef } : {}),
      rationale: raw.rationale,
    };
  });

  // —— 覆盖完整性（可贴节点全覆盖——design §9 回流 2「不允许默认悬空」）
  const assigned = new Set(assignments.map((a) => a.nodeId));
  const missing = [...producingIds].filter((id) => !assigned.has(id)).sort();
  if (missing.length > 0) {
    throw new StrategyDesignError(
      `assignments 覆盖不完整——缺 ${missing.length} 个可贴节点：${missing.join(', ')}（每节点一条指派，不值得贴用 exclusion 显式指派）`,
      'plan-coverage-incomplete',
    );
  }

  // —— contracts 终验（nodeId 重复等结构不变式由 schema superRefine 把守）
  const planCheck = StrategyPlanSchema.safeParse({
    kind: 'strategy-plan',
    formatVersion: 1,
    objectTreeRef: input.treeArtifactRef,
    ...(input.styleId !== undefined ? { styleId: input.styleId } : {}),
    assignments,
    createdAt: new Date().toISOString(),
  });
  if (!planCheck.success) {
    throw new StrategyDesignError(
      `StrategyPlan 终验失败：${planCheck.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
      'llm-invalid-plan',
      { cause: planCheck.error },
    );
  }
  return { plan: planCheck.data, assignmentCount: assignments.length };
}

// ---------------------------------------------------------------- 设计器本体（propose 链）

export interface StrategyDesignerDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** DATA_ROOT（strategy-design-logs 留存根）。 */
  dataRoot: string;
  /** 既有 LLM 配置（settings 真源优先+env 迁移回退——key 绝不入库不入留存）。 */
  llm: LlmConfig;
}

export interface StrategyDesignerOptions {
  /** 真连开关（缺省 env STRATEGY_DESIGN_LIVE==='1'；测试注入 true+本地 mock 网关）。 */
  live?: boolean;
  /** fetch 替身（测试注入本地 mock 网关；缺省 globalThis.fetch——live 才会触达）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 文本模型名（缺省路由 model）。 */
  model?: string;
  /** LLM 调用超时界（ms）——测试短界注入。 */
  timeoutMs?: number;
}

/** 设计草案（未经授权桥——capability 层组装 proposal）。 */
export interface StrategyDesignDraft {
  plan: StrategyPlan;
  tree: ObjectTree;
  candidates: StoneCandidate[];
  casBinding: { resourceId: string; baseRevision: number } | undefined;
  unavailableSetMembers: string[];
  prompt: string;
  meta: { model: string; durationMs: number };
}

/** 交换留存落点。 */
export interface StrategyDesignRetention {
  dir: string;
  exchangeJson: string;
}

export interface StrategyDesignOutcome {
  draft: StrategyDesignDraft;
  retention: StrategyDesignRetention;
}

/**
 * strategy.design 设计器（propose 链：上下文装配→LLM→plan 校验；无后台任务——每请求
 * fetch 有超时界，零常驻定时器/连接）。授权桥（proposal 落库）归 capability 层——
 * 本类不触 approvals（纯设计面，测试可不装配桥直达 plan）。
 */
export class StrategyDesigner {
  private readonly live: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly model: string | undefined;
  private readonly timeoutMs: number;
  private seq = 0;

  constructor(
    private readonly deps: StrategyDesignerDeps,
    options: StrategyDesignerOptions = {},
  ) {
    this.live = options.live ?? process.env[STRATEGY_DESIGN_LIVE_ENV] === '1';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? strategyDesignLlmTimeoutMs();
  }

  /** propose 全链（typed reject 或 resolve——失败也留存）。 */
  async design(rawInput: unknown): Promise<StrategyDesignOutcome> {
    const parsed = StrategyDesignProposeSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new StrategyDesignError(
        `strategy.design 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const input = parsed.data;
    const startedAt = Date.now();
    // —— 任务行（owner 绑定面——候选投影 owner 隔离与审计链）
    const task = this.deps.db
      .prepare('SELECT id, owner_id, type FROM tasks WHERE id = ?')
      .get(input.taskId) as { id: string; owner_id: string; type: string } | undefined;
    if (!task) throw new StrategyDesignError(`任务不存在：${input.taskId}`, 'invalid-input');
    if (task.type !== 'agent') throw new StrategyDesignError(`任务不是 agent 会话任务：${input.taskId}`, 'invalid-input');

    try {
      // —— 树工件读回（P0.4 机用轨）
      let tree: ObjectTree;
      try {
        tree = loadObjectTreeArtifact(this.deps.blobs, input.treeArtifactRef);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new StrategyDesignError(`object-tree 工件不符契约：${error.issues.slice(0, 3).map((i) => i.message).join('; ')}`, 'tree-invalid', { cause: error });
        }
        throw new StrategyDesignError(
          `object-tree 工件读回失败：${error instanceof Error ? error.message : String(error)}`,
          'tree-missing',
          { cause: error },
        );
      }
      // —— 候选投影（S1+S7）
      const projection = projectStoneCandidates({ db: this.deps.db, blobs: this.deps.blobs }, {
        ownerId: task.owner_id,
        ...(input.stoneFilter !== undefined ? { filter: input.stoneFilter } : {}),
      });
      // —— LLM 生成（纯文本上下文——无视觉）
      const prompt = buildStrategyDesignPrompt({
        tree,
        candidates: projection.candidates,
        ...(input.styleId !== undefined ? { styleId: input.styleId } : {}),
        ...(input.styleHint !== undefined ? { styleHint: input.styleHint } : {}),
        ...(input.instruction !== undefined ? { instruction: input.instruction } : {}),
        ...(input.pavingStyle !== undefined ? { pavingStyle: input.pavingStyle } : {}),
      });
      const { contentText, model } = await this.callLlm(prompt);
      // —— plan 装配+校验（含 free-code 工件化——blobs.put）
      const { plan } = assembleStrategyPlan({
        tree,
        treeArtifactRef: input.treeArtifactRef,
        llmPayload: this.parsePayload(contentText),
        candidates: projection.candidates,
        ...(input.styleId !== undefined ? { styleId: input.styleId } : {}),
        blobs: this.deps.blobs,
      });
      const draft: StrategyDesignDraft = {
        plan,
        tree,
        candidates: projection.candidates,
        casBinding: projection.casBinding,
        unavailableSetMembers: projection.unavailableSetMembers,
        prompt,
        meta: { model, durationMs: Date.now() - startedAt },
      };
      const retention = this.writeRetention({
        startedAt,
        outcome: 'ok',
        request: input,
        model,
        promptChars: prompt.length,
        responseText: contentText,
      });
      return { draft, retention };
    } catch (error) {
      const typed =
        error instanceof StrategyDesignError
          ? error
          : new StrategyDesignError(`strategy.design 内部错误：${error instanceof Error ? error.message : String(error)}`, 'internal', { cause: error });
      try {
        this.writeRetention({
          startedAt,
          outcome: `error:${typed.kind}`,
          request: input,
          error: `${typed.name}[${typed.kind}]: ${typed.message}`,
        });
      } catch (retentionError) {
        console.warn('[strategy.design] 失败留存写入异常（不掩盖原错误）', retentionError);
      }
      throw typed;
    }
  }

  /** 响应文本 → JSON 载荷（fenced/裸 JSON 容错）。 */
  private parsePayload(contentText: string): unknown {
    try {
      return JSON.parse(extractJsonText(contentText));
    } catch (error) {
      throw new StrategyDesignError(
        `LLM 输出无法解析为 JSON（原文摘要：${excerpt(contentText)}）`,
        'llm-bad-json',
        { cause: error },
      );
    }
  }

  /**
   * LLM 线面（三协议纯文本调用——W5 P1-3：settings 真源优先+协议适配，与
   * scene.analyze 通道 B 共用 kernel/llm-route 单源；无视觉：纯文本 prompt）。
   */
  private async callLlm(prompt: string): Promise<{ contentText: string; model: string }> {
    let route: ResolvedLlmRoute | null;
    try {
      route = resolveLlmRoute(this.deps.db, this.deps.llm, 'strategy.design');
    } catch (error) {
      throw new StrategyDesignError(
        `LLM 路由配置错误：${error instanceof Error ? error.message : String(error)}`,
        'llm-route-unconfigured',
        { cause: error },
      );
    }
    if (route === null) {
      throw new StrategyDesignError(
        'LLM 路由未配置（LLM_API_KEY 缺失且后台模型路由无可用项）——文本模型不可用（S6 策略设计需要已配置的模型路由）',
        'llm-route-unconfigured',
      );
    }
    const model = this.model?.trim() || route.model;
    if (!this.live) {
      throw new StrategyDesignError(
        `strategy.design 真连未开启（env ${STRATEGY_DESIGN_LIVE_ENV}=1 才真实外呼；缺省 mock 语义）`,
        'live-disabled',
      );
    }
    let wire: LlmWireRequest;
    try {
      wire = buildTextLlmWireRequest(route, model, prompt, STRATEGY_DESIGN_LLM_MAX_TOKENS);
    } catch (error) {
      throw new StrategyDesignError(
        `路由协议构造失败：${error instanceof Error ? error.message : String(error)}`,
        'llm-route-unconfigured',
        { cause: error },
      );
    }
    let contentText: string | null = null;
    try {
      const response = await this.fetchImpl(wire.url, {
        method: 'POST',
        headers: wire.headers,
        body: wire.body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error', // 网关直连 https；跨域重定向=配置漂移面（imgapi 同款纪律）
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new StrategyDesignError(`文本模型 HTTP ${response.status}：${excerpt(bodyText, 200)}`, 'llm-call-failed');
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new StrategyDesignError('文本模型响应不是 JSON 体', 'llm-call-failed');
      }
      contentText = extractLlmContentText(route.api, body);
      if (contentText === null) {
        throw new StrategyDesignError(
          `文本模型响应无文本 content（原文摘要：${excerpt(JSON.stringify(body), 200)}）`,
          'llm-bad-json',
        );
      }
    } catch (error) {
      if (error instanceof StrategyDesignError) throw error;
      throw new StrategyDesignError(
        `文本模型调用失败：${error instanceof Error ? error.message : String(error)}`,
        'llm-call-failed',
        { cause: error },
      );
    }
    return { contentText, model };
  }

  /** 交换留存：strategy-design-logs/{date}/{taskId}/{seq}-{startedAtMs}.json。 */
  private writeRetention(input: {
    startedAt: number;
    outcome: string;
    request: StrategyDesignProposeInput;
    model?: string;
    promptChars?: number;
    responseText?: string;
    error?: string;
  }): StrategyDesignRetention {
    const seq = ++this.seq;
    const date = new Date(input.startedAt).toISOString().slice(0, 10);
    const dir = path.join(this.deps.dataRoot, STRATEGY_DESIGN_LOGS_DIRNAME, date, input.request.taskId);
    mkdirSync(dir, { recursive: true });
    const exchangeJson = path.join(dir, `${String(seq).padStart(4, '0')}-${input.startedAt}.json`);
    writeFileSync(
      exchangeJson,
      JSON.stringify(
        {
          seq,
          outcome: input.outcome,
          startedAt: new Date(input.startedAt).toISOString(),
          durationMs: Date.now() - input.startedAt,
          // 留存纪律：不含 apiKey、不含完整 prompt（候选/树可由工件+filter 复原；字符数作预算审计）。
          request: {
            taskId: input.request.taskId,
            treeArtifactRef: input.request.treeArtifactRef,
            ...(input.request.stoneFilter !== undefined ? { stoneFilter: input.request.stoneFilter } : {}),
            ...(input.request.styleId !== undefined ? { styleId: input.request.styleId } : {}),
            ...(input.request.styleHint !== undefined ? { styleHint: input.request.styleHint } : {}),
            ...(input.request.instruction !== undefined ? { instruction: input.request.instruction } : {}),
            ...(input.request.pavingStyle !== undefined ? { pavingStyle: input.request.pavingStyle } : {}),
          },
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.promptChars !== undefined ? { promptChars: input.promptChars } : {}),
          ...(input.responseText !== undefined ? { responseText: input.responseText } : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        },
        null,
        1,
      ),
    );
    return { dir, exchangeJson };
  }
}

// ---------------------------------------------------------------- [4] 执行链（授权后）

/** 引擎委派请求（kernel/index.ts 接线层真身——strategies 子树不 import 引擎红线）。 */
export interface EngineDelegationRequest {
  block: TreeBlock;
  strategy: EngineStrategyId;
  /**
   * 引擎密度乘数（T3 绝对语义：engineDensityConversion 产出的 densityRatio=
   * densityPerCm2/baseDensityPerCm2——按引擎实际晶格（含 gap）换算，非除以 2.3）。
   */
  density: number;
  /** 确定性种子（nodeId FNV-1a——同 plan 同 gems 回放）。 */
  seed: number;
  gemDiameterMm: number;
  pixelsPerMm: number;
}

/** 引擎 layout 委派缝（真身=kernel/index.ts——rhinestone-studio/engine 公共出口）。 */
export type EngineLayoutDelegate = (request: EngineDelegationRequest) => {
  gems: Array<{ x: number; y: number; diameterMm: number; rotationDeg?: number }>;
  dropped?: number;
};

/** 逐节点执行结果（preview 表与 gems 文档的共用投影）。 */
export interface NodeExecutionSummary {
  nodeId: string;
  strategyKind: KernelStrategyKind;
  gemCount: number;
  culled: number;
  /** engineStrategy 委派（显式/声明式降级——预览可见）。 */
  engineDelegation?: { strategy: EngineStrategyId; reason: 'explicit' | 'degraded' };
  /**
   * 密度诊断三元组（T3 绝对语义——产物保留用户口径 densityPerCm2 + adapter 诊断
   * 字段 densityRatio/baseDensityPerCm2，便于解释而不把内部值冒充用户值）。
   * exclusion 无钻径基准=缺席。
   */
  density?: { densityPerCm2: number; densityRatio: number; baseDensityPerCm2: number };
}

/** strategy-gems.json 工件（P3.1 输出面——contracts 冻结归后续波，本地 schema 把守）。 */
export const StrategyGemsDocSchema = z
  .object({
    kind: z.literal('strategy-gems'),
    formatVersion: z.literal(1),
    planRef: z.string().regex(/^[0-9a-f]{64}$/),
    canvasCm: z.object({ w: z.number().positive(), h: z.number().positive() }),
    imagePx: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
    gems: z.array(
      z.object({
        id: z.string().min(1),
        x: z.number(),
        y: z.number(),
        colorId: z.string(),
        blockId: z.string().min(1),
        shapeId: z.enum(['round', 'square', 'drop', 'heart', 'marquise', 'custom']),
        diameterMm: z.number().positive(),
        rotationDeg: z.number().min(0).max(360).optional(),
        assetId: z.string().min(1).optional(),
      }),
    ),
    excludedRegions: z.array(
      z.object({
        nodeId: z.string().min(1),
        label: z.string().min(1),
        reason: z.string().min(1),
        areaCm2: z.number().nonnegative(),
      }),
    ),
    warnings: z.array(z.object({ kind: z.enum(['excluded', 'degraded', 'spacing', 'mask', 'geometry']), detail: z.string().min(1) })),
    /**
     * 密度诊断（T3 绝对语义——Codex C2：产物保留用户口径 densityPerCm2+adapter
     * 诊断字段 densityRatio/baseDensityPerCm2，便于解释而不把内部值冒充用户值；
     * exclusion 节点缺席）。
     */
    nodeDensities: z
      .array(
        z
          .object({
            nodeId: z.string().min(1),
            densityPerCm2: z.number().positive(),
            densityRatio: z.number().positive(),
            baseDensityPerCm2: z.number().positive(),
          })
          .strict(),
      )
      .optional(),
    createdAt: z.string().min(1),
  })
  .strict();
export type StrategyGemsDoc = z.infer<typeof StrategyGemsDocSchema>;

/** 节点钻径（mm）：stones 最大非空 sizeMm（排除/无 stones→undefined）。
 * T2 注记：gapFill 混排下=打底径（fill 小钻入 stones 不影响 base 径——design §2.2）。 */
function nodeDiameterMmOf(assignment: StrategyAssignment): number | undefined {
  const sizes = assignment.stones.map((stone) => stone.sizeMm).filter((size): size is number => size !== null);
  return sizes.length > 0 ? Math.max(...sizes) : undefined;
}

// ---------------------------------------------------------------- gapFill 补隙趟（T2.2）

/** 补隙趟结果（执行段 gem 汇总面前置——base 趟产钻之后）。 */
export interface GapFillOutcome {
  gems: KernelGem[];
  warnings: StrategyWarning[];
}

/** 已放钻+候选判距的空间分桶（cell=最大触达半径——3×3 邻域查距 O(n+m)，design §2.2/§6）。 */
class GemBucket {
  private m = new Map<number, { x: number; y: number; d: number }[]>();
  constructor(private cellPx: number) {}
  private key(cx: number, cy: number): number {
    return cy * 1_000_000 + cx;
  }
  add(x: number, y: number, d: number): void {
    const k = this.key(Math.floor(x / this.cellPx), Math.floor(y / this.cellPx));
    let arr = this.m.get(k);
    if (!arr) {
      arr = [];
      this.m.set(k, arr);
    }
    arr.push({ x, y, d });
  }
  /** (x,y) 处 d_f 径候选 vs 已放钻逐对判距（ratio 收紧因子）——返回遮挡者 null=通过。 */
  blockerOf(x: number, y: number, fillDmm: number, ppm: number, ratio: number): { x: number; y: number; d: number } | null {
    const cx = Math.floor(x / this.cellPx);
    const cy = Math.floor(y / this.cellPx);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = this.m.get(this.key(cx + dx, cy + dy));
        if (!arr) continue;
        for (const q of arr) {
          const required = gateRequiredPairPx(q.d, fillDmm, ppm) * ratio;
          if ((q.x - x) ** 2 + (q.y - y) ** 2 < required * required) return q;
        }
      }
    }
    return null;
  }
}

/**
 * 多尺寸混排补隙趟（design §2.2——「打底+补隙」执行层正交模式，客户 3mm+10mm 刚需）：
 * base 趟产钻后对块掩膜内网格候选逐对判距补小径钻。
 *   [1] fill 径 d_f=assignment.stones 内查 gapFill.stoneRef（查无/无尺寸=typed 拒——
 *       contracts superRefine 已把守 stoneRef∈stones，执行段防御再拒）；
 *   [2] 候选=掩膜内网格（步长 d_f_px×1.2）；逐候选对**本节点全部已有钻**（base+已放
 *       fill）判中心距 ≥ gateRequiredPairPx(dᵢ, d_f, ppm)×minGapRatio——**单源引
 *       sandbox/gate.ts 门公式**（minGapRatio=1 缺省与导出门逐位同式；>1 线性收紧）；
 *       网格分桶 O(n+m)（数百钻级工程必要）；
 *   [3] fill 钻 diameterMm=d_f 落 KernelGem（逐钻直径字段本有）；角度=最近 base 钻
 *       角度（无 base=缺省不填）。
 * 密度语义：gapFill 不吃 densityPerCm2（base 已消费）——补隙量由几何空隙自然决定
 * （「能塞多少塞多少」=Owner「补隙」原语义）。
 * 已知取舍（注记）：补隙趟判距只对本节点——跨节点重叠由 validateCrossNodeGemSpacing
 * 兜底剔除+warning（gate.ts 已逐对混径）。
 * 确定性：网格扫描序（y 升 x 升）+keep-earlier——同输入同输出。
 */
export function applyGapFillPass(
  baseGems: readonly KernelGem[],
  block: TreeBlock,
  assignment: StrategyAssignment,
  ppm: number,
  gapFill: { stoneRef: string; minGapRatio?: number },
): GapFillOutcome {
  const warnings: StrategyWarning[] = [];
  const fillStone = assignment.stones.find((stone) => stone.resourceId === gapFill.stoneRef);
  if (fillStone === undefined) {
    throw new StrategyDesignError(
      `节点 ${assignment.nodeId} 的 gapFill.stoneRef=${gapFill.stoneRef} 不在该节点 stones 候选（superRefine 已拒——执行期防御再拒）`,
      'execute-failed',
    );
  }
  if (fillStone.sizeMm === null) {
    throw new StrategyDesignError(
      `节点 ${assignment.nodeId} 的 gapFill 补隙钻 ${fillStone.supplier}/${fillStone.sku} 无尺寸（sizeMm 空——补隙径不可推导）`,
      'plan-stone-unsized',
    );
  }
  const dF = fillStone.sizeMm;
  const ratio = gapFill.minGapRatio ?? 1.0;
  const { mask, bbox } = block;

  // 分桶：cell=最大触达半径（涉及 d_f 的最大判距——3×3 邻域全覆盖保证）
  const maxBaseD = baseGems.reduce((m, g) => Math.max(m, g.diameterMm), dF);
  const cell = Math.max(1, gateRequiredPairPx(maxBaseD, dF, ppm) * ratio);
  const bucket = new GemBucket(cell);
  for (const g of baseGems) bucket.add(g.x, g.y, g.diameterMm);

  // 网格候选（步长 1.2×d_f_px——补隙密度上界；y 升 x 升确定序）
  const stepPx = 1.2 * dF * ppm;
  const placed: KernelGem[] = [];
  for (let y = bbox.y + stepPx / 2, gy = 0; y < bbox.y + mask.h; y += stepPx, gy++) {
    for (let x = bbox.x + stepPx / 2, gx = 0; x < bbox.x + mask.w; x += stepPx, gx++) {
      if (!gemInMask(mask, bbox, x, y)) continue;
      if (bucket.blockerOf(x, y, dF, ppm, ratio) !== null) continue;
      // 就近 base 角度继承（判距扫描中最近者——无 base 缺省不填角度）
      let nearest: { d2: number; rot: number | undefined } | null = null;
      for (const g of baseGems) {
        const d2 = (g.x - x) ** 2 + (g.y - y) ** 2;
        if (nearest === null || d2 < nearest.d2) nearest = { d2, rot: g.rotationDeg };
      }
      const gem: KernelGem = {
        id: `${assignment.nodeId}#g${String(placed.length + 1).padStart(4, '0')}`,
        x: round6Local(x),
        y: round6Local(y),
        colorId: '',
        blockId: assignment.nodeId,
        shapeId: 'round',
        diameterMm: round6Local(dF),
        ...(nearest?.rot !== undefined ? { rotationDeg: nearest.rot } : {}),
      };
      placed.push(gem);
      bucket.add(gem.x, gem.y, gem.diameterMm);
    }
  }
  if (placed.length === 0 && baseGems.length > 0) {
    warnings.push({
      kind: 'spacing',
      detail: `节点 ${assignment.nodeId} gapFill 补隙 0 颗（${dF}mm 补隙钻无可用空隙——base 排布已密或 minGapRatio=${ratio} 过紧）`,
    });
  }
  return { gems: placed, warnings };
}

/** 六位小数取整（fill 钻坐标/径——JSON 工件面稳定）。 */
function round6Local(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

// ---------------------------------------------------------------- T4.2b 亮度场真源=原图

/** lumaB64 消费策略族（registry paramsSchema 携 lumaB64 可选位的族——注入白名单）。 */
export const LUMA_CONSUMING_STRATEGY_KINDS: ReadonlySet<string> = new Set(['texture-fill', 'straight-line']);

/**
 * bbox 局部原图灰度（Rec.601 luma——w*h 字节 base64，与 block mask 同 bbox 维度：
 * orientation_field.lumaFieldOf 的长度契约）。越界像素（病态 bbox）=128 平坦值
 * （不炸——渲染/采样面防御同 setPixel 纪律）。纯函数。
 */
export function bboxLumaB64(image: { width: number; height: number; rgba: Uint8Array }, bbox: NodeBBox): string {
  const out = Buffer.alloc(bbox.w * bbox.h);
  let k = 0;
  for (let y = 0; y < bbox.h; y++) {
    for (let x = 0; x < bbox.w; x++) {
      const px = bbox.x + x;
      const py = bbox.y + y;
      if (px < 0 || py < 0 || px >= image.width || py >= image.height) {
        out[k++] = 128;
        continue;
      }
      const p = (py * image.width + px) * 4;
      out[k++] = Math.round(
        0.299 * image.rgba[p]! + 0.587 * image.rgba[p + 1]! + 0.114 * image.rgba[p + 2]!,
      );
    }
  }
  return out.toString('base64');
}

/**
 * 策略亮度场真源解析（T4.2b——「色彩细节=原图」的取图面单源）：
 * - 无参考图层（帧缺席/帧流面缺席）→ 树锚 imageBlobRef（无参考任务树锚=原图；
 *   旧树无锚=null 不注入）；
 * - 参考图层在场 → scene-analysis.json 的 imageBlobRef（D3 sourceImage=归一后原图，
 *   与参考图层同网格）；scene-analysis 缺席=null **宁缺毋假**——绝不把参考图层
 * （扁平化产物，灰度非真实色彩）当色彩源。
 * 返回 null=调用方不注入（执行链零变化）。
 */
export function resolveStrategyLumaSourceRef(deps: {
  blobs: BlobStore;
  jobs?: Pick<JobService, 'emitFor' | 'framesAfter'>;
}, taskId: string, tree: ObjectTree): string | null {
  let referenceRef: string | null = null;
  if (deps.jobs !== undefined) referenceRef = latestReferenceImageBlobRef(deps.jobs, taskId);
  if (referenceRef === null) {
    return tree.imageBlobRef ?? null; // 无参考图层：树锚=原图语义（T4.1 保证同源）
  }
  if (deps.jobs === undefined) return null;
  const frames = deps.jobs.framesAfter(taskId, 0);
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'artifact') continue;
    const payload = frame.payload as { name?: unknown; blobRef?: unknown };
    if (payload.name === SCENE_ANALYSIS_ARTIFACT_NAME_LOCAL && typeof payload.blobRef === 'string') {
      const bytes = deps.blobs.read(payload.blobRef);
      if (bytes === null) return null;
      try {
        const analysis = JSON.parse(bytes.toString('utf8')) as { imageBlobRef?: unknown };
        return typeof analysis.imageBlobRef === 'string' ? analysis.imageBlobRef : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 授权后执行链（同步——executeApprovedLocal 事务内）：plan → 逐节点 applyStrategy
 * 真执行（registry）→ [engineStrategy 显式/声明式委派经注入缝路由引擎公共出口] →
 * gems 汇总 → P1.4 强制引擎校验门（间距/掩膜内——违例颗剔除+warnings）→ 三工件
 * putTaskArtifact（strategy-plan.json / strategy-gems.json / strategy-gems-preview.png）。
 * 确定性：engine 委派 seed=nodeId FNV-1a；registry 各族 seed 经 params/ctx 同源。
 */
export function executeStrategyPlan(deps: { db: SqliteDb; blobs: BlobStore; dataRoot?: string }, input: {
  taskId: string;
  plan: StrategyPlan;
  engineLayout?: EngineLayoutDelegate;
  /**
   * 亮度场真源=原图（T4.2b——add-flat-aux-segmentation D4「结构掩膜来自参考图层、
   * 纹理细节来自原图」）：在场且可解码且与树锚同网格时，texture-fill/straight-line
   * 指派缺省注入 params.lumaB64=bbox 局部原图灰度（**不落 plan 工件**——执行期派生
   * 量，同图同树确定）。缺席/不可用=不注入（执行行为零变化）。
   */
  sourceImage?: { blobRef: string };
}): { value: Record<string, unknown>; resultRef: string } {
  // —— plan/树真源读回（payload JSON round-trip 后防御性终验）
  const plan = input.plan;
  const tree = loadObjectTreeArtifact(deps.blobs, plan.objectTreeRef);
  const referenceDiameterMm = Math.max(
    FALLBACK_GEM_DIAMETER_MM,
    ...plan.assignments.map((assignment) => nodeDiameterMmOf(assignment) ?? 0),
  );
  const canvas = { px: tree.imagePx, cm: tree.canvasCm, pixelsPerMm: tree.imagePx.width / (tree.canvasCm.w * 10) };
  const blocksResult = treeToBlocks(tree, { readBlob: (ref) => deps.blobs.read(ref) }, { gemDiameterPx: referenceDiameterMm * canvas.pixelsPerMm });
  if (!blocksResult.ok) {
    throw new StrategyDesignError(
      `object-tree → blocks 失败（${blocksResult.reason}——树工件掩膜/锚点不一致）`,
      'tree-invalid',
    );
  }
  const blockById = new Map(blocksResult.blocks.map((block) => [block.id, block] as const));
  const nodeById = new Map(tree.nodes.map((node) => [node.id, node] as const));

  // —— T4.2b 亮度场真源解码（原图——「色彩细节来自原图」）：不可读/坏图/与树锚
  //    网格不符=不注入（执行行为零变化；宁缺毋假——不回退参考图层冒充色彩源）。
  let lumaSource: { width: number; height: number; rgba: Uint8Array } | undefined;
  if (input.sourceImage !== undefined) {
    const sourceBytes = deps.blobs.read(input.sourceImage.blobRef);
    if (sourceBytes !== null) {
      try {
        const decodedSource = decodePng(sourceBytes);
        if (decodedSource.width === tree.imagePx.width && decodedSource.height === tree.imagePx.height) {
          lumaSource = decodedSource;
        }
      } catch {
        // 坏图=不注入（下方 undefined 分支）
      }
    }
  }

  const allGems: KernelGem[] = [];
  const excludedRegions: ExcludedRegion[] = [];
  const warnings: StrategyWarning[] = [];
  const nodeSummaries: NodeExecutionSummary[] = [];
  const byKind = new Map<KernelStrategyKind, number>();

  for (const assignment of plan.assignments) {
    const node = nodeById.get(assignment.nodeId);
    const block = blockById.get(assignment.nodeId);
    if (node === undefined) {
      throw new StrategyDesignError(
        `指派节点 ${assignment.nodeId} 不在 object-tree（plan 校验后树漂移？）`,
        'execute-failed',
      );
    }
    // —— 旧数据兼容（v5 语义）：v4 产块判定允许 drillWorthy 中间节点产钻——存量 plan
    //    可能携带父层指派。重算时**跳过**（组不产块=不产钻）并 warnings 明示（不炸
    //    不静默——读面 task.detail assignments 同步降级标注「组不产钻——已失效」）。
    if (block === undefined) {
      if (node.children.length > 0) {
        warnings.push({
          kind: 'degraded',
          detail: `节点 ${assignment.nodeId}「${node.objectName}」是层级节点（组不产钻——v5 语义），旧指派已失效跳过（不产块）`,
        });
        continue;
      }
      throw new StrategyDesignError(
        `指派节点 ${assignment.nodeId} 无对应 block（非产块节点——plan 校验后树漂移？）`,
        'execute-failed',
      );
    }
    const diameterMm = nodeDiameterMmOf(assignment) ?? referenceDiameterMm;
    // —— 密度绝对语义（T3）：全路径（texture-fill 直达/fallback hex/显式引擎）同一
    //    绝对口径换算+容量门（超基准容量=typed 拒不静默 clamp；exclusion 无钻不消费）。
    const density =
      assignment.strategyKind === 'exclusion'
        ? undefined
        : (() => {
            const conversion = engineDensityConversion(assignment.densityPerCm2, diameterMm);
            return {
              densityPerCm2: assignment.densityPerCm2,
              densityRatio: conversion.densityRatio,
              baseDensityPerCm2: conversion.baseDensityPerCm2,
            };
          })();
    const ctx = createStrategyContext({
      gemDiameterPx: diameterMm * canvas.pixelsPerMm,
      densityPerCm2: assignment.densityPerCm2,
    });
    byKind.set(assignment.strategyKind, (byKind.get(assignment.strategyKind) ?? 0) + 1);

    // —— engineStrategy 消费规则（registry adapter 契约）：指派显式带 or apply 声明式降级
    // → 该节点路由引擎 layout 公共出口（接线层注入缝）；两者均缺 → applyStrategy gems。
    const explicitStrategy = assignment.engineStrategy;
    let result: StrategyResult | undefined;
    let delegation: { strategy: EngineStrategyId; reason: 'explicit' | 'degraded' } | undefined;
    if (explicitStrategy === undefined) {
      // —— T4.2b lumaB64 缺省注入（luma 消费族+LLM 未显式携带时）：bbox 局部**原图**
      //    灰度（结构掩膜可来自参考图层——色彩细节恒回原图，同色粘连的执行侧缓解）。
      //    注入进执行副本——plan 工件/JSON 字节零变化（派生量不进溯源锚）。
      const rawParams = assignment.params as Record<string, unknown>;
      const params =
        lumaSource !== undefined
        && LUMA_CONSUMING_STRATEGY_KINDS.has(assignment.strategyKind)
        && rawParams.lumaB64 === undefined
          ? { ...assignment.params, lumaB64: bboxLumaB64(lumaSource, node.bbox) }
          : assignment.params;
      result = applyStrategy(assignment.strategyKind, { node, block, params, canvas }, ctx);
      warnings.push(...result.warnings);
      if (result.excludedRegions !== undefined) excludedRegions.push(...result.excludedRegions);
      if (result.engineStrategy !== undefined) {
        // 声明式降级（geometry-min-size 等）→ 'degraded' 呈现；explicit 保义。
        delegation = {
          strategy: result.engineStrategy.engineStrategy,
          reason: result.engineStrategy.reason === 'explicit' ? 'explicit' : 'degraded',
        };
      }
    } else {
      delegation = { strategy: explicitStrategy, reason: 'explicit' };
    }

    let gems: KernelGem[];
    if (delegation !== undefined) {
      if (input.engineLayout === undefined) {
        throw new StrategyDesignError(
          `节点 ${assignment.nodeId} 需引擎策略 ${delegation.strategy} 委派（${delegation.reason}），但引擎接线缺席（kernel 装配面——不静默空产）`,
          'engine-delegation-unavailable',
        );
      }
      const engineResult = input.engineLayout({
        block,
        strategy: delegation.strategy,
        // T3 绝对语义：乘数=densityRatio（按引擎实际晶格换算）。exclusion 无钻径
        // 基准时（exotic：排除指派显式带 engineStrategy）按 referenceDiameterMm
        // 换算——同绝对口径，不走「除以 2.3」旧口径。
        density:
          density !== undefined
            ? density.densityRatio
            : engineDensityConversion(assignment.densityPerCm2, referenceDiameterMm).densityRatio,
        seed: stringToSeed(assignment.nodeId),
        gemDiameterMm: diameterMm,
        pixelsPerMm: canvas.pixelsPerMm,
      });
      gems = engineResult.gems.map((gem, i) => ({
        id: `${assignment.nodeId}#E${String(i + 1).padStart(4, '0')}`,
        x: gem.x,
        y: gem.y,
        colorId: '',
        blockId: assignment.nodeId,
        shapeId: 'round',
        diameterMm: gem.diameterMm,
        ...(gem.rotationDeg !== undefined ? { rotationDeg: gem.rotationDeg } : {}),
      }));
      warnings.push({
        kind: 'degraded',
        detail: `节点 ${assignment.nodeId} 路由引擎 ${delegation.strategy}（${delegation.reason}）${engineResult.dropped !== undefined ? `，dropped=${engineResult.dropped}` : ''}`,
      });
    } else {
      if (result === undefined) {
        // 逻辑不可达（delegation 缺席 ⇔ explicitStrategy 缺席 ⇒ result 已赋值）——防御。
        throw new StrategyDesignError(`节点 ${assignment.nodeId} 执行分支不一致（internal）`, 'internal');
      }
      gems = result.gems;
    }

    // —— T2.2 多尺寸混排补隙趟（gapFill 在场：base 趟产钻后小径补隙——「打底+补隙」
    //    正交叠加；exclusion/free-code 组合已被 contracts superRefine 拒；补隙钻与
    //    base 同过下方节点内门——per-pair 混径门不误剔小径 fill）。
    if (assignment.gapFill !== undefined) {
      const fill = applyGapFillPass(gems, block, assignment, canvas.pixelsPerMm, assignment.gapFill);
      gems = [...gems, ...fill.gems];
      warnings.push(...fill.warnings);
    }

    // —— P1.4 强制引擎校验门（间距/掩膜内——违例颗剔除+warnings；全灭=typed 拒）。
    //    判距单源（P0-1 闸门口径统一）：gateRequiredPairPx——与导出门（task-layout.grid
    //    → engine exportGate）同一换算（gap=EXPORT_GATE_GRID_GAP_MM 的 ×0.999 判据）。
    //    T2.3 混径化：逐对阈值=gateRequiredPairPx(q.d, g.d, ppm)（等径节点与旧单径
    //    标量门逐位同式；混排下单径门会系统性误剔 fill 钻——(d_b+d_f)/2<d_b）。
    const verdict = validateGemPlacement(gems, {
      mask: block.mask,
      bbox: block.bbox,
      pairPixelsPerMm: canvas.pixelsPerMm,
    });
    const maskCulled = verdict.culled.filter((c) => c.kind === 'mask');
    const spacingCulled = verdict.culled.filter((c) => c.kind === 'spacing');
    if (maskCulled.length > 0) {
      warnings.push({
        kind: 'mask',
        detail: `节点 ${assignment.nodeId} ${maskCulled.length} 颗越出掩膜被引擎校验门剔除（如 ${maskCulled[0]!.detail}）`,
      });
    }
    if (spacingCulled.length > 0) {
      warnings.push({
        kind: 'spacing',
        detail: `节点 ${assignment.nodeId} ${spacingCulled.length} 颗间距不足被引擎校验门剔除（如 ${spacingCulled[0]!.detail}）`,
      });
    }
    if (gems.length > 0 && verdict.kept.length === 0 && assignment.strategyKind !== 'exclusion') {
      throw new StrategyDesignError(
        `节点 ${assignment.nodeId} 的 ${assignment.strategyKind} 产出 ${gems.length} 颗全部被引擎校验门剔除（间距/掩膜——策略失败不静默空产）`,
        'execute-failed',
      );
    }
    allGems.push(...verdict.kept);
    nodeSummaries.push({
      nodeId: assignment.nodeId,
      strategyKind: assignment.strategyKind,
      gemCount: verdict.kept.length,
      culled: verdict.culled.length,
      ...(delegation !== undefined ? { engineDelegation: delegation } : {}),
      ...(density !== undefined ? { density } : {}),
    });
  }

  // —— 跨节点间距剔除（P0-1 真链走查：逐节点 P1.4 门只对本节点判距，节点间重叠
  //    （相邻块边界两颗互嵌）无人负责——导出门按全量 concat 判距必阻。此处对汇总
  //    gems 做 keep-earlier 跨节点剔除（确定性：同 plan 同节点序同输出；阈值与
  //    导出门同源 gateRequiredPairPx——混径节点对按 (a+b)/2 判），warnings 呈现
  //    剔除对。目标不变量：执行链写盘的 gems 过导出门 spacing 零违规
  //    （tests/gate-engine-alignment.test.ts 断言把守）。
  const crossNode = validateCrossNodeGemSpacing(allGems, canvas.pixelsPerMm);
  if (crossNode.culled.length > 0) {
    warnings.push({
      kind: 'spacing',
      detail: `跨节点重叠剔除 ${crossNode.culled.length} 颗（如 ${crossNode.culled[0]!.detail}）`,
    });
  }
  const finalGems = crossNode.kept;

  // —— T4.4b 部件级钻数终局实算（add-flat-aux-segmentation D4——iter-5/6 连续两轮
  //    「终报数字与终局不符」根治）：nodeSummaries.gemCount 以 **finalGems** 按
  //    blockId 实算（跨节点剔除后的终局口径=task-layout/导出终报同源），不再沿用
  //    节点段执行时的中间计数；culled 吸收终局差值（执行段剔除+跨节点剔除合计）。
  const finalCountByNode = new Map<string, number>();
  for (const gem of finalGems) {
    finalCountByNode.set(gem.blockId, (finalCountByNode.get(gem.blockId) ?? 0) + 1);
  }
  const finalNodeSummaries: NodeExecutionSummary[] = nodeSummaries.map((summary) => {
    const finalCount = finalCountByNode.get(summary.nodeId) ?? 0;
    if (finalCount === summary.gemCount) return summary;
    return { ...summary, gemCount: finalCount, culled: summary.culled + (summary.gemCount - finalCount) };
  });

  // —— 三工件落档（putTaskArtifact——fence 同事务；写入序=plan JSON → gems JSON → 预览 PNG，
  //     planRef 是 gems 文档的溯源锚，gems 落档前回填）
  const planPut = putArtifactChecked(deps, input.taskId, Buffer.from(JSON.stringify(plan, null, 1), 'utf8'));
  const gemsDoc: StrategyGemsDoc = StrategyGemsDocSchema.parse({
    kind: 'strategy-gems',
    formatVersion: 1,
    planRef: planPut,
    canvasCm: tree.canvasCm,
    imagePx: tree.imagePx,
    gems: finalGems,
    excludedRegions,
    warnings,
    ...(nodeSummaries.some((s) => s.density !== undefined)
      ? {
          nodeDensities: nodeSummaries
            .filter((s) => s.density !== undefined)
            .map((s) => ({ nodeId: s.nodeId, ...s.density! })),
        }
      : {}),
    createdAt: new Date().toISOString(),
  });
  const gemsPut = putArtifactChecked(deps, input.taskId, Buffer.from(JSON.stringify(gemsDoc, null, 1), 'utf8'));
  // —— task-layout.<imageId>.json（add-task-stones-manifest-export 4.1——B2 渲染快照）：
  //    策略执行同真源链末端装配（plan+gems+tree+blocks+manifestRevision 四锚绑定）；
  //    无 session-project 行=skip、生成拒/写失败=诊断呈现不放大（派生面纪律——与
  //    lint 同族；导出面以「无 task-layout 工件」typed 拒并复述成因）。单图现状
  //    imageId='image-1'（多图=每图一次策略执行链，调用方经 imageId 传入——本函数
  //    输入尚未按图分链，W3 单图冻结裁量延续）。
  const taskLayout = writeTaskLayoutForExecution(
    deps,
    {
      taskId: input.taskId,
      plan,
      planRef: planPut,
      tree,
      gems: finalGems,
      blocks: blocksResult.blocks,
      referenceDiameterMm,
      // 判距 gap 单源（P0-1）：task-layout.grid.gapMm 喂导出门（engine exportGate
      // requiredCenterDistancePx）——必须与 P1.4 门/跨节点剔除同一换算
      // （EXPORT_GATE_GRID_GAP_MM），排布拾取间隙（ENGINE_DELEGATION_GAP_MM）
      // 不进判距（详见 sandbox/gate.ts 头注）。
      gapMm: EXPORT_GATE_GRID_GAP_MM,
    },
  );
  // —— gems 叠加预览（P0.4 preview 同款纯像素纪律：非纯白底+节点框+钻点阵留存）
  const previewPut = putArtifactChecked(
    deps,
    input.taskId,
    renderGemsOverlay({
      imagePx: tree.imagePx,
      nodes: tree.nodes.map((node) => ({ bbox: node.bbox, drillWorthy: node.drillWorthy })),
      gems: finalGems.map((gem) => ({
        x: gem.x,
        y: gem.y,
        diameterPx: gem.diameterMm * canvas.pixelsPerMm,
        colorRgb: colorOfGem(plan, gem),
      })),
    }),
  );
  return {
    value: {
      planBlobRef: planPut,
      gemsBlobRef: gemsPut,
      previewBlobRef: previewPut,
      taskLayoutBlobRef: taskLayout.blobRef,
      taskLayoutImageId: taskLayout.imageId,
      taskLayoutDiagnostics: taskLayout.diagnostics,
      gemCount: finalGems.length,
      excludedRegions,
      warnings,
      nodeSummaries: finalNodeSummaries,
      byKind: Object.fromEntries(byKind),
      note: '工件名约定（emit 层消费）：strategy-plan.json / strategy-gems.json / strategy-gems-preview.png'
        + ' / task-layout.<imageId>.json（4.1——taskLayoutBlobRef 非空时按 taskLayoutImageId 组名）',
    },
    resultRef: gemsPut,
  };
}

/** putTaskArtifact 的 fence 收敛壳（cancelled/cleared 任务产物写入=typed fence 拒）。 */
function putArtifactChecked(deps: { db: SqliteDb; blobs: BlobStore }, taskId: string, data: Uint8Array): string {
  try {
    return putTaskArtifact(deps, taskId, data).hash;
  } catch (error) {
    if (error instanceof ArtifactFenceError) {
      throw new StrategyDesignError(
        `strategy 产物写入被 fence 拒绝（任务 ${taskId} 已不可写）：${error.message}`,
        'fence',
        { cause: error },
      );
    }
    throw error;
  }
}

/** gem 渲染色（节点首石 colorHex→RGB；缺省确定性灰——渲染语义，不进 BOM 真源）。 */
function colorOfGem(plan: StrategyPlan, gem: KernelGem): [number, number, number] {
  const assignment = plan.assignments.find((a) => a.nodeId === gem.blockId);
  const hex = assignment?.stones[0]?.colorHex ?? '#808080';
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return [Number.isFinite(r) ? r : 128, Number.isFinite(g) ? g : 128, Number.isFinite(b) ? b : 128];
}

// ---------------------------------------------------------------- gems 叠加渲染（P0.4 preview 同款纪律）

/** 叠加节点面（框+排除语义色——P0.4 tree-preview 同色系）。 */
export interface GemsOverlayNode {
  bbox: NodeBBox;
  drillWorthy: boolean;
}

/** 叠加钻点（画布像素坐标+物理径+渲染色）。 */
export interface GemsOverlayGem {
  x: number;
  y: number;
  diameterPx: number;
  colorRgb: readonly [number, number, number];
}

/** 预览框线粗/底色（§10 回流 5：产品渲染底色非纯白——浅灰）。 */
export const GEMS_PREVIEW_BG: readonly [number, number, number] = [235, 235, 235];
export const GEMS_PREVIEW_STROKE_PX = 2;

/**
 * 钻盘对比度环色（深灰——走查实证修复 2026-09-26，add-workbench-pro 2.3）：真共享库
 * 白钻 #F0F0E8 与浅灰底 [235,235,235] ΔRGB≤5，1888 颗全数已画但肉眼不可辨
 * （strategy-gems-preview.png 唯一色 4 被误判「渲染产物空」）。每颗钻盘先铺深灰盘
 * 再内缩 1px 铺石色芯——环带恒 ≥1px，任何石色（近白/近黑）对底色均可见；渲染色
 * 语义保留（芯=渲染色——环是描边不是替换）。
 */
export const GEMS_PREVIEW_RING_RGB: readonly [number, number, number] = [64, 64, 64];

/**
 * gems 点阵叠加预览（纯函数——同输入同 PNG，审计可回放；零字体依赖同 P0.4）：
 * 浅灰底 + 节点 bbox 框（drillWorthy 绿/排除红，2px）+ 钻圆盘（深灰对比度环+
 * 首石色内芯）。裁剪语义同 setPixel（贴边/越界像素丢弃；非有限坐标防御丢弃）。
 */
export function renderGemsOverlay(input: {
  imagePx: { width: number; height: number };
  nodes: GemsOverlayNode[];
  gems: GemsOverlayGem[];
}): Uint8Array {
  const { width, height } = input.imagePx;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    out[p] = GEMS_PREVIEW_BG[0];
    out[p + 1] = GEMS_PREVIEW_BG[1];
    out[p + 2] = GEMS_PREVIEW_BG[2];
    out[p + 3] = 255;
  }
  const setPixel = (x: number, y: number, color: readonly [number, number, number]): void => {
    // 非有限坐标防御：NaN 的比较全 false 会穿透边界检查、TypedArray NaN 索引静默
    // 丢弃——显式拒绝（上游策略产 NaN 坐标时渲染不炸、像素面不污染）。
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (y * width + x) * 4;
    out[p] = color[0];
    out[p + 1] = color[1];
    out[p + 2] = color[2];
    out[p + 3] = 255;
  };
  for (const node of input.nodes) {
    const color: readonly [number, number, number] = node.drillWorthy ? [0, 180, 0] : [255, 0, 0];
    const x0 = node.bbox.x;
    const y0 = node.bbox.y;
    const x1 = node.bbox.x + node.bbox.w - 1;
    const y1 = node.bbox.y + node.bbox.h - 1;
    for (let i = 0; i < GEMS_PREVIEW_STROKE_PX; i++) {
      for (let x = x0; x <= x1; x++) {
        setPixel(x, y0 + i, color);
        setPixel(x, y1 - i, color);
      }
      for (let y = y0; y <= y1; y++) {
        setPixel(x0 + i, y, color);
        setPixel(x1 - i, y, color);
      }
    }
  }
  for (const gem of input.gems) {
    const radius = Math.max(0.75, gem.diameterPx / 2);
    const r = Math.ceil(radius);
    const cx = Math.round(gem.x);
    const cy = Math.round(gem.y);
    // 外盘=对比度环（深灰——石色近底色时环带仍可见；见 GEMS_PREVIEW_RING_RGB 注记）
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= radius * radius) setPixel(cx + dx, cy + dy, GEMS_PREVIEW_RING_RGB);
      }
    }
    // 内芯=石色（radius-1 内缩——环带 ≥1px 恒在；极小钻整盘呈环色仍可见）
    const inner = radius - 1;
    if (inner > 0) {
      const ri = Math.ceil(inner);
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          if (dx * dx + dy * dy <= inner * inner) setPixel(cx + dx, cy + dy, gem.colorRgb);
        }
      }
    }
  }
  return encodePng(width, height, out);
}

// ---------------------------------------------------------------- [5] 工具面注册

// —— T4.2a 双图预览（add-flat-aux-segmentation D4：策略设计时两图都可看——结构参考=
//    参考图层（掩膜/树锚真源），色彩细节=原图（排钻色彩语义源）。无参考图层=零变化。

/** 双图合成间隔带（px——深色分隔；零字体依赖同 P0.4 preview 纪律）。 */
export const REFERENCE_SOURCE_PAIR_DIVIDER_PX = 4;
export const REFERENCE_SOURCE_PAIR_DIVIDER_RGB: readonly [number, number, number] = [24, 24, 24];
/** 短半幅纵向补齐底色（近白灰——与 GEMS_PREVIEW_BG 同族）。 */
export const REFERENCE_SOURCE_PAIR_PAD_RGB: readonly [number, number, number] = [245, 245, 245];

/**
 * 参考图层×原图双图合成（纯函数——左=参考图层（结构参考）、右=原图（色彩细节）、
 * 中缝深色分隔带；各半幅独立 downscaleRgbaNearest 到 maxSide 内、短者纵向补齐）。
 * agentImagePreviews 通道 kind='reference-source-pair' 的载荷真源（通道形态最小
 * 扩展——AgentImagePreviewSchema.kind 为开放 string，零 contracts 变更）。
 */
export function renderReferenceSourcePair(
  reference: { width: number; height: number; rgba: Uint8Array },
  source: { width: number; height: number; rgba: Uint8Array },
  maxSide: number,
): Uint8Array {
  const left = downscaleRgbaNearest(reference, maxSide);
  const right = downscaleRgbaNearest(source, maxSide);
  const height = Math.max(left.height, right.height);
  const width = left.width + REFERENCE_SOURCE_PAIR_DIVIDER_PX + right.width;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    out[p] = REFERENCE_SOURCE_PAIR_PAD_RGB[0];
    out[p + 1] = REFERENCE_SOURCE_PAIR_PAD_RGB[1];
    out[p + 2] = REFERENCE_SOURCE_PAIR_PAD_RGB[2];
    out[p + 3] = 255;
  }
  const blit = (img: { width: number; height: number; rgba: Uint8Array }, offsetX: number): void => {
    const padY = Math.floor((height - img.height) / 2);
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const src = (y * img.width + x) * 4;
        const dst = ((y + padY) * width + offsetX + x) * 4;
        out[dst] = img.rgba[src]!;
        out[dst + 1] = img.rgba[src + 1]!;
        out[dst + 2] = img.rgba[src + 2]!;
        out[dst + 3] = 255;
      }
    }
  };
  blit(left, 0);
  for (let y = 0; y < height; y++) {
    for (let dx = 0; dx < REFERENCE_SOURCE_PAIR_DIVIDER_PX; dx++) {
      const p = (y * width + left.width + dx) * 4;
      out[p] = REFERENCE_SOURCE_PAIR_DIVIDER_RGB[0];
      out[p + 1] = REFERENCE_SOURCE_PAIR_DIVIDER_RGB[1];
      out[p + 2] = REFERENCE_SOURCE_PAIR_DIVIDER_RGB[2];
      out[p + 3] = 255;
    }
  }
  blit(right, left.width + REFERENCE_SOURCE_PAIR_DIVIDER_PX);
  return encodePng(width, height, out);
}

/** 帧流工件帧名（scene-analysis 锚——本模块 latest-by-name 直读面）。 */
const SCENE_ANALYSIS_ARTIFACT_NAME_LOCAL = 'scene-analysis.json';

/**
 * 策略设计双图预览装配（T4.2a——propose 结果回流 agent 多模态）：任务级参考图层帧
 * 在场（latestReferenceImageBlobRef）+scene-analysis 锚可读 → 双图合成缩略图物化
 * 任务域 blob → AgentImagePreview（kind='reference-source-pair'）。缺席/失败=空数组
 * （**预览失败绝不阻塞设计主链**——segment-tool buildAgentPreviews 同款纪律）；
 * 无参考图层时零变化（不出预览）。
 */
export function buildReferenceSourcePairPreviews(
  deps: { db: SqliteDb; blobs: BlobStore; jobs?: Pick<JobService, 'emitFor' | 'framesAfter'> },
  taskId: string,
): AgentImagePreview[] {
  if (!segmentAgentPreviewEnabled() || deps.jobs === undefined) return [];
  try {
    const referenceRef = latestReferenceImageBlobRef(deps.jobs, taskId);
    if (referenceRef === null) return [];
    // 原图锚=scene-analysis.json 的 imageBlobRef（D3 sourceImage 语义=归一后原图；
    // 与参考图层同网格）。缺席（无 S2 工件的病态任务）=不出双图（零伪造）。
    const frames = deps.jobs.framesAfter(taskId, 0);
    let sceneRef: string | null = null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i]!;
      if (frame.kind !== 'artifact') continue;
      const payload = frame.payload as { name?: unknown; blobRef?: unknown };
      if (payload.name === SCENE_ANALYSIS_ARTIFACT_NAME_LOCAL && typeof payload.blobRef === 'string') {
        sceneRef = payload.blobRef;
        break;
      }
    }
    if (sceneRef === null) return [];
    const analysisBytes = deps.blobs.read(sceneRef);
    const referenceBytes = deps.blobs.read(referenceRef);
    if (analysisBytes === null || referenceBytes === null) return [];
    const analysis = JSON.parse(analysisBytes.toString('utf8')) as { imageBlobRef?: unknown };
    if (typeof analysis.imageBlobRef !== 'string') return [];
    const sourceBytes = deps.blobs.read(analysis.imageBlobRef);
    if (sourceBytes === null) return [];
    const reference = decodePng(referenceBytes);
    const source = decodePng(sourceBytes);
    const maxSide = segmentAgentPreviewMaxSide();
    const png = renderReferenceSourcePair(reference, source, maxSide);
    const blobRef = putTaskArtifact(deps, taskId, png).hash;
    return [
      {
        kind: 'reference-source-pair',
        blobRef,
        mime: 'image/png',
        maxSide,
        dataBase64: Buffer.from(png).toString('base64'),
      },
    ];
  } catch {
    return []; // 双图预览=增强面——任何解析/渲染失败缺席不阻塞（主链结果仍在）
  }
}

export interface StrategyDesignCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** DATA_ROOT（strategy-design-logs 留存根）。 */
  dataRoot: string;
  /** 既有 LLM 配置（settings 真源优先+env 迁移回退——key 绝不入库不入留存）。 */
  llm: LlmConfig;
  /** §3.6 授权桥（approved-mutation 面；缺省时按 core.ts 一律 principal-forbidden）。 */
  approvals?: ApprovalService;
  /** 引擎 layout 委派真身（kernel/index.ts 接线——registry adapter 契约消费规则）。 */
  engineLayout?: EngineLayoutDelegate;
  /** 帧提交单点（execute 三工件 artifact 帧登记+propose 双图预览帧流读回——kernel
   * 接线注入；缺席=不登记帧，仅落工件）。 */
  jobs?: Pick<JobService, 'emitFor' | 'framesAfter'>;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
  /** 设计器选项注入面（测试：live/fetchImpl/model/timeoutMs）。 */
  designerOptions?: StrategyDesignerOptions;
}

/**
 * strategy.design 能力集（kernel 工具面注册——approved-mutation 双模，照 S4/S7 接法：
 * 带参=发起 proposal；带 proposalId=执行）。授权语义零新：proposal+preview diff 预览→
 * 人工批准→grant→consumeForExecution→（activeSetId 在场时 revision CAS）→settleExternal
 * 同一 SQLite 事务。MCP 投影 mcp__studio__strategy_design 过 tool-surface deny 名单。
 */
export function createStrategyDesignCapabilities(deps: StrategyDesignCapabilitiesDeps): CapabilityRegistry {
  const designer = new StrategyDesigner(
    { db: deps.db, blobs: deps.blobs, dataRoot: deps.dataRoot, llm: deps.llm },
    deps.designerOptions,
  );
  const streaks = new Map<string, { key: string; count: number }>();

  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return { kind: 'failed', code: 'INVALID_OPERATION', message: `熔断：${reason}。请停止重试，向用户报告失败原因。` };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  function requireApprovals(): ApprovalService {
    if (!deps.approvals) throw new Error('授权桥未装配（approved-mutation 面不可用）');
    return deps.approvals;
  }

  /** 任务行校验（owner 绑定面——sets.ts agentTaskOf 同语义本地面）。 */
  function agentTaskOf(taskId: string): { ownerId: string; sessionId: string | null } {
    const task = deps.db
      .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
    return { ownerId: task.owner_id, sessionId: task.session_id };
  }

  function bucketOf(input: unknown): string {
    const taskId = (input as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : 'global';
  }

  /**
   * lint 计算核（A3 接线共用——add-task-stones-manifest-export W3 3.1）：无会话/
   * 无指派/无 session-project 行=null；计算异常（manifest 腐蚀等病态）=null 不放大
   * ——主流程（proposal 发起/策略执行）已成功，lint 是派生面不使其失败
   * （warning 不把 proposal 变 error 的对偶面）。
   */
  function computeLint(sessionId: string | null, assignments: StrategyAssignment[]): StoneLintComputation | null {
    if (sessionId === null || assignments.length === 0) return null;
    try {
      return lintAssignments({ db: deps.db, blobs: deps.blobs }, { sessionId, assignments });
    } catch {
      return null;
    }
  }

  /**
   * lint 分级规则文案（iter-1 Codex 审查修复①b——Agent 行为规则落在返回文案/工具
   * 描述）：unintroduced=warning 非阻断继续流程（导出只进 warnings——task-export.ts
   * 同口径）；unresolvable 与导出侧 mask/spacing 违规=硬阻断停止待修正。iter-1 实证
   * （codex-review.md 问题 1）：agent 把 unintroduced 当阻断停在提案阶段=次级行为问题，
   * 根因是授权反馈契约——文案必须显式分级。
   */
  const LINT_RULE_NOTE =
    'lint 分级：unintroduced=warning 非阻断——继续流程（执行/导出照常，导出只进 warnings；'
    + '如需纳入先与用户确认再经 studio.task.stones.add）；unresolvable（库外/软删）=硬阻断'
    + '——停止并修正（换钻或先入库）；导出侧 mask/spacing 违规同为硬阻断（导出工具 typed 拒）';

  /** lint 摘要注入 proposal summary（审批面可见——A3：unintroduced 提示先确认再纳入）。 */
  function lintNoteOf(computation: StoneLintComputation | null): string {
    if (computation === null) return '';
    const { unintroduced, unresolvable, unused } = computation.counts;
    const parts: string[] = [];
    if (unintroduced > 0) parts.push(`lint 警告：${unintroduced} 款钻未引入项目（非阻断——继续流程，导出只进 warnings；如需纳入先与用户确认再经 studio.task.stones.add）`);
    if (unresolvable > 0) parts.push(`lint 硬错：${unresolvable} 款钻不可解析（库外/软删——不能靠添加清单消除；硬阻断，停止并修正）`);
    if (unused > 0) parts.push(`已引入未使用 ${unused} 款`);
    return parts.length > 0 ? `·${parts.join('；')}` : '';
  }

  function failedOf(reason: ConsumeDenyReason | string, message: string): CapabilityCallResult {
    const code =
      reason === 'stale-revision' ? ('STALE' as const) : reason === 'concurrent' ? ('CONFLICT' as const) : ('INVALID_OPERATION' as const);
    return { kind: 'failed', code, message };
  }

  /** 双模判定（type guard）：proposalId 在场=执行模式。 */
  function isExecuteMode<T extends { proposalId?: string }>(parsed: T): parsed is T & { proposalId: string } {
    return parsed.proposalId !== undefined;
  }

  function previewBlob(doc: unknown): string {
    return deps.blobs.put(new Uint8Array(Buffer.from(canonicalJson(doc), 'utf8'))).hash;
  }

  function payloadOf(op: ApprovedOpRow): Record<string, unknown> {
    try {
      return JSON.parse(op.payload_json as string) as Record<string, unknown>;
    } catch {
      throw new Error(`proposal 载荷不可解析：${op.proposal_id}`);
    }
  }

  /** 本地恰好一次执行壳（照 S4/S7 executeApprovedLocal）：consume→执行→settle 同一事务。 */
  function executeApprovedLocal(
    tool: string,
    input: { taskId: string; proposalId: string },
    fn: (ctx: { op: ApprovedOpRow; payload: Record<string, unknown> }) => { value: Record<string, unknown>; resultRef?: string },
  ): CapabilityCallResult {
    const approvals = requireApprovals();
    const task = agentTaskOf(input.taskId);
    const tx = deps.db.transaction((): CapabilityCallResult => {
      const consume = approvals.consumeForExecution({
        proposalId: input.proposalId,
        taskId: input.taskId,
        userId: task.ownerId,
        tool,
      });
      if (!consume.ok) return failedOf(consume.reason, consume.message);
      const ctx = { op: consume.op, payload: payloadOf(consume.op) };
      const { value, resultRef } = fn(ctx);
      approvals.settleExternal(consume.op.proposal_id, resultRef !== undefined ? { kind: 'succeeded', resultRef } : { kind: 'succeeded' });
      return { kind: 'ok', value };
    });
    return tx();
  }

  const definitions: CapabilityDefinition[] = [
    {
      name: STRATEGY_DESIGN_TOOL_NAME,
      description:
        'LLM 策略设计（管线 S6，approved-mutation 双模）：带 treeArtifactRef = 发起 proposal'
        + '（object-tree+钻候选（stoneFilter.supplier/family/activeSetId 组合投影）+风格提示'
        + '（styleId 接口位预留/styleHint 自由文本）+铺法 pavingStyle（full=满铺/accent=点缀'
        + '——followup 首消息「铺法：满铺/点缀」表单行的传参面；缺省不指定=按画面自定）'
        + '→ LLM 逐节点指派 StrategyPlan（每节点'
        + ' strategyKind+params+钻引用+密度+理由——params 经 registry 逐项校验）→ 逐节点指派表'
        + ' diff 预览）；带 proposalId = 执行（逐节点 applyStrategy 真执行+引擎校验门+三工件'
        + ' 落档：strategy-plan/strategy-gems/叠加预览 PNG）。两层编辑铁律：本工具=图层级'
        + ' 策略面；单钻微调归设计师工作台。'
        + '计划硬约束（propose 即校验拒，错误消息即自纠指引）：每节点恰一款钻（stoneIdx 单值'
        + '——多候选=plan-stone-multi-candidate 拒，执行链无法在多款候选中确定物料）；'
        + 'rationale 必填非空；densityPerCm2 须为正数且不超所选钻径基准容量'
        + '（density-capacity-exceeded）；指派键仅 nodeId/strategyKind/params/stoneIdx/'
        + 'densityPerCm2/engineStrategy/rationale——发明键必拒。'
        + 'photographic 参考图层任务：发起结果附 agentImagePreviews 双图预览'
        + '（kind=reference-source-pair——左=参考图层（结构参考/掩膜真源）、右=原图（色彩细节））；'
        + '执行链亮度场（texture-fill/straight-line 的 lumaB64）自动以**原图** bbox 灰度注入'
        + '（结构掩膜来自参考图层、色彩细节来自原图——同色粘连的执行侧缓解）。'
        + 'lint 分级（iter-1 免值守修复）：unintroduced=warning 非阻断继续流程（导出只进'
        + ' warnings）；unresolvable（库外/软删）与导出侧 mask/spacing 违规=硬阻断停止待修正。'
        + 'autoApprove 会话：发起返回 autoApproved=true+「立即执行」指令时立即以'
        + ' {taskId, proposalId} 调用执行（勿等待用户）。',
      authority: 'approved-mutation' as const,
      input: StrategyDesignInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = StrategyDesignInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            STRATEGY_DESIGN_TOOL_NAME,
            `参数不合法（双模：发起={taskId,treeArtifactRef[,stoneFilter][,styleId][,styleHint][,instruction]} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (
              p.treeArtifactRef !== undefined || p.stoneFilter !== undefined || p.styleId !== undefined
              || p.styleHint !== undefined || p.instruction !== undefined || p.pavingStyle !== undefined
            ) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            let executedPlan: StrategyPlan | null = null;
            const outcome = executeApprovedLocal(STRATEGY_DESIGN_TOOL_NAME, p, ({ payload }) => {
              // payload plan 防御性终验（canonicalJson round-trip 后 schema 复核——不静默吃漂移）
              const planCheck = StrategyPlanSchema.safeParse(payload['plan']);
              if (!planCheck.success) {
                throw new StrategyDesignError(
                  `proposal 载荷 plan 不符 StrategyPlan 契约：${planCheck.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; ')}`,
                  'llm-invalid-plan',
                );
              }
              executedPlan = planCheck.data;
              // —— T4.2b 亮度场真源=原图（resolveStrategyLumaSourceRef 单源：无参考
              //    图层=树锚（=原图）；参考图层在场=scene-analysis 锚——宁缺毋假）。
              let lumaSourceRef: string | null = null;
              try {
                lumaSourceRef = resolveStrategyLumaSourceRef(
                  { blobs: deps.blobs, ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}) },
                  p.taskId,
                  loadObjectTreeArtifact(deps.blobs, planCheck.data.objectTreeRef),
                );
              } catch {
                lumaSourceRef = null; // 树读回失败归执行链主路径 typed 拒——此处不放大
              }
              return executeStrategyPlan(
                // dataRoot：task-layout 读 workbench-view-state.json（P2-4 隐藏层过滤）。
                { db: deps.db, blobs: deps.blobs, dataRoot: deps.dataRoot },
                {
                  taskId: p.taskId,
                  plan: planCheck.data,
                  ...(deps.engineLayout !== undefined ? { engineLayout: deps.engineLayout } : {}),
                  ...(lumaSourceRef !== null ? { sourceImage: { blobRef: lumaSourceRef } } : {}),
                },
              );
            });
            if (outcome.kind === 'ok') {
              noteSuccess(bucket);
              // execute 三工件 artifact 帧登记（P3.3-fix：tasks.artifact 合法集=帧∪附件，
              // UI provider 经帧流取工件）。事务提交成功后 emit——回滚路径不产生孤儿帧
              // （subject.segment emitArtifacts 先例；帧名=executeStrategyPlan value.note 约定）。
              const refs = outcome.value as {
                planBlobRef?: unknown;
                gemsBlobRef?: unknown;
                previewBlobRef?: unknown;
                taskLayoutBlobRef?: unknown;
                taskLayoutImageId?: unknown;
              };
              for (const [name, ref] of [
                [STRATEGY_PLAN_ARTIFACT_NAME, refs.planBlobRef],
                [STRATEGY_GEMS_ARTIFACT_NAME, refs.gemsBlobRef],
                [STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME, refs.previewBlobRef],
              ] as const) {
                if (typeof ref === 'string') deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: ref, name });
              }
              // —— task-layout 帧（4.1：装配成功时按 imageId 组名——task-layout.<imageId>.json；
              //    拒/skip=无帧，诊断随 value.taskLayoutDiagnostics 呈现，导出面 typed 拒）。
              if (typeof refs.taskLayoutBlobRef === 'string' && typeof refs.taskLayoutImageId === 'string') {
                deps.jobs?.emitFor(p.taskId, 'artifact', {
                  blobRef: refs.taskLayoutBlobRef,
                  name: taskLayoutArtifactName(refs.taskLayoutImageId as TaskImageId),
                });
              }
              // —— lint 执行落档后重算（A3 接线②：对当前 plan 重算+stones-lint.json
              //    工件 latest-by-name+结果内嵌；warning/unresolvable 分类呈现，不把
              //    执行结果变 error）。executedPlan 经显式收窄读回（回调内赋值——
              //    CFA 不跨闭包追踪，防窄化成 null/never）。
              const lintSession = agentTaskOf(p.taskId).sessionId;
              const executedAssignments = (executedPlan as StrategyPlan | null)?.assignments ?? [];
              const computation = computeLint(lintSession, executedAssignments);
              const executedValue = outcome.value as Record<string, unknown>;
              if (computation !== null && typeof refs.planBlobRef === 'string') {
                putStoneLintArtifact(
                  { db: deps.db, blobs: deps.blobs, ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}) },
                  {
                    taskId: p.taskId,
                    lint: stoneLintArtifactOf(computation, { sourceTaskId: p.taskId, planRef: refs.planBlobRef }),
                  },
                );
                outcome.value = { ...executedValue, lint: stoneLintResultOf(computation), lintRule: LINT_RULE_NOTE };
              } else {
                outcome.value = { ...executedValue, lint: null };
              }
            }
            return outcome;
          }
          // ---- propose 模式：设计→指派表 diff 预览→proposal（批准前库内零变更）。
          const proposeParsed = StrategyDesignProposeSchema.safeParse(p);
          if (!proposeParsed.success) {
            throw new Error(
              `发起模式需 {taskId, treeArtifactRef}（缺一不可——不猜测）：${proposeParsed.error.issues.map((i) => i.message).join('; ')}`,
            );
          }
          const propose = proposeParsed.data;
          const task = agentTaskOf(propose.taskId);
          const outcome = await designer.design(propose);
          const { draft } = outcome;
          // —— lint 草案 plan（A3 接线①：模型批准前可见 warning——unintroduced 提示
          //    「先与用户确认是否纳入项目」；不落工件（批准前库内零变更），不把
          //    proposal 变 error——分类呈现归讨论面）。
          const lintComputation = computeLint(task.sessionId, draft.plan.assignments);
          const nodeNames = new Map(draft.tree.nodes.map((node) => [node.id, node.objectName] as const));
          const byKind = new Map<KernelStrategyKind, number>();
          for (const assignment of draft.plan.assignments) {
            byKind.set(assignment.strategyKind, (byKind.get(assignment.strategyKind) ?? 0) + 1);
          }
          const kindSummary = [...byKind.entries()].map(([kind, n]) => `${kind}×${n}`).join('、');
          const assignmentTable = draft.plan.assignments.map((assignment) => ({
            nodeId: assignment.nodeId,
            objectName: nodeNames.get(assignment.nodeId) ?? '',
            strategyKind: assignment.strategyKind,
            params: assignment.params,
            stones: assignment.stones,
            densityPerCm2: assignment.densityPerCm2,
            ...(assignment.engineStrategy !== undefined ? { engineStrategy: assignment.engineStrategy } : {}),
            ...(assignment.codeArtifactRef !== undefined ? { codeArtifactRef: assignment.codeArtifactRef } : {}),
            rationale: assignment.rationale,
          }));
          const before = previewBlob({
            note: 'strategy-design',
            exists: false,
            owner: task.ownerId,
            treeArtifactRef: propose.treeArtifactRef,
            nodeCount: draft.tree.nodes.length,
          });
          const after = previewBlob({
            note: 'strategy-design',
            treeArtifactRef: propose.treeArtifactRef,
            ...(draft.plan.styleId !== undefined ? { styleId: draft.plan.styleId } : {}),
            assignments: assignmentTable,
            candidateCount: draft.candidates.length,
            ...(draft.unavailableSetMembers.length > 0 ? { unavailableSetMembers: draft.unavailableSetMembers } : {}),
          });
          const issued = requireApprovals().propose({
            taskId: propose.taskId,
            userId: task.ownerId,
            tool: STRATEGY_DESIGN_TOOL_NAME,
            ...(draft.casBinding !== undefined
              ? { resourceId: draft.casBinding.resourceId, baseRevision: draft.casBinding.baseRevision }
              : {}),
            payload: {
              kind: 'strategy-design',
              treeArtifactRef: propose.treeArtifactRef,
              plan: draft.plan,
              ...(propose.styleId !== undefined ? { styleId: propose.styleId } : {}),
              ...(propose.styleHint !== undefined ? { styleHint: propose.styleHint } : {}),
              ...(propose.instruction !== undefined ? { instruction: propose.instruction } : {}),
              ...(propose.stoneFilter !== undefined ? { stoneFilter: propose.stoneFilter } : {}),
              ...(propose.pavingStyle !== undefined ? { pavingStyle: propose.pavingStyle } : {}),
            },
            preview: { before, after },
            summary:
              `策略设计：${draft.plan.assignments.length} 节点指派（${kindSummary}）·候选钻 ${draft.candidates.length} 款`
              + `${draft.plan.styleId !== undefined ? `·风格 ${draft.plan.styleId}` : ''}`
              + `${propose.pavingStyle !== undefined ? `·铺法 ${propose.pavingStyle === 'full' ? '满铺' : '点缀'}` : ''}`
              + `${draft.casBinding !== undefined ? `·组合投影绑定（v${draft.casBinding.baseRevision}——批准期间组合被改必拒）` : ''}`
              + `${lintNoteOf(lintComputation)}`,
          });
          noteSuccess(bucket);
          // —— T4.2a 双图预览（参考图层帧在场时回流 agent：结构参考=参考图层/
          //    色彩细节=原图；无参考图层=缺席零变化；失败=缺席不阻塞）。
          const pairPreviews = buildReferenceSourcePairPreviews(
            { db: deps.db, blobs: deps.blobs, ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}) },
            propose.taskId,
          );
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              lint: lintComputation === null ? null : stoneLintResultOf(lintComputation),
              ...(lintComputation !== null ? { lintRule: LINT_RULE_NOTE } : {}),
              ...(pairPreviews.length > 0 ? { agentImagePreviews: pairPreviews } : {}),
              preview: {
                treeArtifactRef: propose.treeArtifactRef,
                ...(draft.plan.styleId !== undefined ? { styleId: draft.plan.styleId } : {}),
                assignments: assignmentTable,
                candidateCount: draft.candidates.length,
                ...(draft.unavailableSetMembers.length > 0 ? { unavailableSetMembers: draft.unavailableSetMembers } : {}),
                note: '指派表=批准即执行真身（逐节点 applyStrategy+引擎校验门）；free-code 指派携带 codeArtifactRef 工件引用',
                previewBlobs: { before, after },
              },
              meta: draft.meta,
              // iter-1 Codex 审查修复①a（design.ts 原 2114 面）：走 approvalFaceOf——
              // autoApprove 会话透传 autoApproved=true+「立即执行」指令（grant 已在，
              // 等的人不存在）；手动路径 pending 文案原样（studio/stones/sets 同款）。
              ...approvalFaceOf(issued, '等待用户批准（approval-request 已入任务帧流；批准前库内零变化）'),
            },
          };
        } catch (error) {
          const detail =
            error instanceof StrategyDesignError
              ? `${error.kind}：${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          return noteFailure(bucket, STRATEGY_DESIGN_TOOL_NAME, detail);
        }
      },
    },
  ];

  // 授权桥（§3.6）：双模例外照 S4/S7——无 proposalId=propose 面；带 proposalId 走
  // precheckMutation。未装配=一律 principal-forbidden。
  return createCapabilityRegistry(definitions, {
    ...(deps.approvals
      ? {
          mutationAuth: {
            precheck: (name: string, input: unknown) => {
              const proposalId = (input as { proposalId?: unknown } | null | undefined)?.proposalId;
              if (proposalId === undefined) return { ok: true };
              return deps.approvals!.precheckMutation(name, input);
            },
          },
        }
      : {}),
  });
}
