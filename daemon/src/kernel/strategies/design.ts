/**
 * LLM 策略设计器 `strategy.design`（add-subject-sam-pipeline P3.1 / design §1 S6+§5）。
 * 原始需求 2026-09-24（Owner 定调：贴钻这步大模型非常重要，也许不需要视觉——基于
 * object-tree 按提示词泛化，给每个图层设计贴钻方式；skill 层艺术家风格=后话，接口
 * styleId 预留）。propose 产物=StrategyPlan proposal（授权桥审批——两层编辑铁律：
 * 策略层=图层级，单钻层归设计师工作台）。
 *
 * 双模（照 S4/S7 授权桥接法——capability/{stones,sets}.ts 先例）：
 *   propose（带 treeArtifactRef）：装配设计上下文（ObjectTree 工件读回 + S1 stones
 *     投影候选集[activeSetId 时 S7 组合投影过滤] + registry 七策略族清单）→ LLM 生成
 *     逐节点指派（纯文本上下文——W4.1 model-route 单路由，openai-completions 冻结协议）
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
 *       LLM 线面（openai-completions 文本调用+JSON 抽取+typed error 分类）。
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
  StrategyIdSchema,
  StrategyPlanSchema,
  type KernelStrategyKind,
  type NodeBBox,
  type ObjectTree,
  type StonePick,
  type StrategyAssignment,
  type StrategyPlan,
} from '@handicraft/contracts';
import type { LlmConfig } from '../../config.js';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import type { ApprovalService, ConsumeDenyReason } from '../../capability/authorization.js';
import { canonicalJson } from '../../capability/authorization.js';
import type { ApprovedOpRow } from '../../db/approvals.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from '../../capability/core.js';
import { RUNAWAY_LIMIT } from '../../capability/studio.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import { encodePng } from '../../png/codec.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { StoneService } from '../../stones/service.js';
import { SetService } from '../../stones/sets-service.js';
import { resolveSingleRoute, type StudioModelRoute } from '../model-route.js';
import { loadObjectTreeArtifact } from '../vision/tree-persist.js';
import { treeToBlocks, type TreeBlock } from '../vision/tree-to-blocks.js';
import { validateGemPlacement } from './sandbox/gate.js';
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

/** LLM 调用超时界（plan 生成量级与 S2 分析同界——120s）。 */
export const STRATEGY_DESIGN_LLM_TIMEOUT_MS = 120_000;

/** LLM max_tokens 有界（逐节点指派+自由代码片段；free-code source 上限 256KB 级，16k tokens 首版界）。 */
export const STRATEGY_DESIGN_LLM_MAX_TOKENS = 16_384;

/** 交换留存根目录名（DATA_ROOT 下——scene-analyze-logs 同纪律；不含 apiKey）。 */
export const STRATEGY_DESIGN_LOGS_DIRNAME = 'strategy-design-logs';

/** 工具面名（MCP 投影 mcp__studio__strategy_design——studio. 前缀过 deny 名单）。 */
export const STRATEGY_DESIGN_TOOL_NAME = 'studio.strategy.design';

/** 钻候选上限（prompt 有界——超限=typed 拒，收窄 stoneFilter 后重发）。 */
export const MAX_STONE_CANDIDATES = 200;

/**
 * 全排除树/无可用尺寸时的类型推断基准径（mm——仅 treeToBlocks 的 suggested 推断
 * 阈值与 ctx 构造下限用，不产钻不进 BOM；排除族 apply 不消费该值）。
 */
export const FALLBACK_GEM_DIAMETER_MM = 3;

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
  styleId: StrategyDesignProposeSchema.shape.styleId.optional(),
  styleHint: StrategyDesignProposeSchema.shape.styleHint.optional(),
  instruction: StrategyDesignProposeSchema.shape.instruction.optional(),
});

// ---------------------------------------------------------------- 策略族指引表（prompt 单源）

/**
 * 七策略族 prompt 指引（快照冻结面——params 字段约束与各族 paramsSchema 人工对齐；
 * 完备性由测试断言键集===STRATEGY_KINDS。**校验真源是 registry paramsSchema**——
 * 本表只是 LLM 引导文本，漂移不改执行语义）。
 */
export const STRATEGY_FAMILY_GUIDES: Readonly<Record<KernelStrategyKind, { summary: string; params: string }>> = {
  'texture-fill': {
    summary:
      '纹理贴图法（面状/渐变节点首选——Owner 定调主力）：B 打底（加权 Voronoi 满铺）+ A 特征描线（ETF 流线）按 mode 路由',
    params:
      '{"mode":"scatter|flow|hybrid","polarity":"dark-dense|bright-dense|flat","lloydIters":8,"lineShare":0.4（仅 hybrid）}'
        + '——scatter=满铺散布（lloydIters 0-16）；flow=沿亮度梯度流线（线主导节点：发须/卷纹/枝条/缎带）；hybrid=描线+满铺混合',
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
    summary: '直线族（刚硬物：栏杆/杆件/机械——Owner：机械感慎用）：PCA 主轴平行线族',
    params: '{"lineSpacingMm":可选,"angleOffsetDeg":0（±90 内偏移）}',
  },
  geometry: {
    summary: '参数化几何（星/心/圆/矩/椭圆/螺旋——科技感/装饰图形；小节点不足可读下限自动降级引擎 hex）',
    params:
      '{"shape":"star","rays":5,"innerRadiusRatio":0.4,"rotationDeg":270} / {"shape":"heart","aspectRatio":1,"dentDepth":1}'
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

/** 产块节点判定（tree-to-blocks producesBlock 同构裁定 [1]：叶子必产；中间按 drillWorthy）。 */
function producesBlockOf(node: ObjectTree['nodes'][number]): boolean {
  return node.children.length === 0 || node.drillWorthy;
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
    '{"assignments":[{"nodeId":"n1","strategyKind":"texture-fill","params":{"mode":"flow","polarity":"dark-dense"},"stoneIdx":[1,3],"densityPerCm2":2.3,"rationale":"中文一句话理由"}]}',
    '指派规则：',
    '- assignments 必须逐节点覆盖「可贴节点清单」的全部节点，一条不缺（未分配区域不允许悬空——设计回流 2）；不值得贴钻的节点用 exclusion 显式指派并给 reason。',
    '- 「层级节点清单」内的节点不产钻，禁止出现在 assignments。',
    '- stoneIdx 引用「钻候选表」的 idx（1 基）；每节点至少 1 款有尺寸（sizeMm 非空）的钻（exclusion 除外——其 stoneIdx 可省略）。',
    '- densityPerCm2 缺省 2.3 颗/cm²（Owner 定调常数），可逐节点覆盖。',
    '- engineStrategy 可选（hex-thin|hex-pitch|poisson|hybrid|cvt——显式路由引擎五策略；机械感强，仅科技感/高达类风格用，默认不用）。',
    '- params 必须符合「策略族」各 kind 的字段约束（多余/越界字段会被逐项校验拒绝）。',
    '- rationale 必给（中文一句话——proposal 人工可审性）。',
    '可贴节点清单（nodeId 名称（父名） [类别] 有效尺寸 色方差 bbox 面积——必须逐节点指派）：',
    ...(assignable.length > 0 ? assignable : ['-（空——树无可贴节点，不应到达本工具）']),
    '层级节点清单（中间节点不产钻——禁止指派）：',
    ...(nonAssignable.length > 0 ? nonAssignable : ['-（无）']),
    `钻候选表（idx 供应商/SKU 尺寸 颜色 色系——共 ${ctx.candidates.length} 款；stoneIdx 只能引用这些 idx）：`,
    ...candidateLines,
    '策略族（strategyKind 七值）：',
    ...familyBlocks,
    ...(ctx.styleId !== undefined ? [`风格词表键 styleId=${ctx.styleId}（词表暂空——仅透传，不作语义依据）`] : ['风格词表键 styleId 未给（词表暂空——接口位预留）']),
    ...(ctx.styleHint !== undefined ? [`风格提示：${ctx.styleHint}`] : ['风格提示：未给（按各节点物性默认审美路由——面状走纹理、线状走柔和曲线/流线、花朵走花形）']),
    ...(ctx.instruction !== undefined ? [`补充指令：${ctx.instruction}`] : ['补充指令：未给']),
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

/** openai-completions 响应体 → 文本 content（string 直取；parts 数组拼 text 段）。 */
function extractContentText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
          ? (part as { text?: unknown }).text
          : undefined,
      )
      .filter((piece): piece is string => typeof piece === 'string');
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

/** 原文摘要（typed error 携带——截断防日志爆炸）。 */
function excerpt(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字符）`;
}

// ---------------------------------------------------------------- [3] LLM 响应 → StrategyPlan

/** LLM 指派松 schema（stoneIdx 锚定引用；params 自由记录——registry 逐项校验是真源）。 */
const LlmAssignmentSchema = z.object({
  nodeId: z.string().min(1),
  strategyKind: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  stoneIdx: z.array(z.number().int().min(1).max(MAX_STONE_CANDIDATES)).max(64).optional(),
  densityPerCm2: z.number().positive().optional(),
  engineStrategy: z.string().min(1).optional(),
  rationale: z.string().min(1),
});

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
 */
function persistFreeCodeArtifact(blobs: BlobStore, assignment: { params: Record<string, unknown> }): string {
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
      `LLM 输出 assignments 校验失败：${assignmentsRaw.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
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
    const stones: StonePick[] = [];
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
    // —— kind 校验（KernelStrategyKind 七值之外 typed 拒）
    const kindCheck = KernelStrategyKindSchema.safeParse(raw.strategyKind);
    if (!kindCheck.success) {
      throw new StrategyDesignError(
        `节点 ${raw.nodeId} 的 strategyKind=${raw.strategyKind} 不在七值枚举（texture-fill/soft-curve/flower/straight-line/geometry/exclusion/free-code）`,
        'llm-invalid-plan',
      );
    }
    const kind = kindCheck.data;
    // —— params 逐项校验（registry paramsSchema——合法性校验真源）
    const entry = STRATEGY_REGISTRY.get(kind);
    if (entry === undefined) {
      throw new StrategyDesignError(`策略 ${kind} 不在注册表（七值之外——KernelStrategyKindSchema 先行校验）`, 'llm-invalid-plan');
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
    // —— free-code 工件化（contracts 契约：codeArtifactRef 必携带）
    const codeArtifactRef = kind === 'free-code' ? persistFreeCodeArtifact(input.blobs, { params: raw.params }) : undefined;
    return {
      nodeId: raw.nodeId,
      strategyKind: kind,
      params: raw.params,
      stones,
      ...(raw.densityPerCm2 !== undefined ? { densityPerCm2: raw.densityPerCm2 } : {}),
      ...(raw.engineStrategy !== undefined ? { engineStrategy: raw.engineStrategy } : {}),
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
  /** 既有 LLM 配置（env 真源——key 绝不入库）。 */
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
    this.timeoutMs = options.timeoutMs ?? STRATEGY_DESIGN_LLM_TIMEOUT_MS;
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

  /** LLM 线面（openai-completions 文本调用——无视觉：纯文本 prompt）。 */
  private async callLlm(prompt: string): Promise<{ contentText: string; model: string }> {
    let route: StudioModelRoute | null;
    try {
      route = resolveSingleRoute(this.deps.llm);
    } catch (error) {
      throw new StrategyDesignError(
        `LLM 路由配置错误：${error instanceof Error ? error.message : String(error)}`,
        'llm-route-unconfigured',
        { cause: error },
      );
    }
    if (route === null) {
      throw new StrategyDesignError(
        'LLM 路由未配置（LLM_API_KEY 缺失）——文本模型不可用（S6 策略设计需要既有 LLM 路由）',
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
    let contentText: string | null = null;
    try {
      const response = await this.fetchImpl(`${route.baseURL.trim().replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${route.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0,
          max_tokens: STRATEGY_DESIGN_LLM_MAX_TOKENS,
          stream: false,
        }),
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
      contentText = extractContentText(body);
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
  /** 引擎密度乘数（assignment.densityPerCm2 / Owner 基线 2.3——引擎 density 单位=乘数）。 */
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
    createdAt: z.string().min(1),
  })
  .strict();
export type StrategyGemsDoc = z.infer<typeof StrategyGemsDocSchema>;

/** 节点钻径（mm）：stones 最大非空 sizeMm（排除/无 stones→undefined）。 */
function nodeDiameterMmOf(assignment: StrategyAssignment): number | undefined {
  const sizes = assignment.stones.map((stone) => stone.sizeMm).filter((size): size is number => size !== null);
  return sizes.length > 0 ? Math.max(...sizes) : undefined;
}

/**
 * 授权后执行链（同步——executeApprovedLocal 事务内）：plan → 逐节点 applyStrategy
 * 真执行（registry）→ [engineStrategy 显式/声明式委派经注入缝路由引擎公共出口] →
 * gems 汇总 → P1.4 强制引擎校验门（间距/掩膜内——违例颗剔除+warnings）→ 三工件
 * putTaskArtifact（strategy-plan.json / strategy-gems.json / strategy-gems-preview.png）。
 * 确定性：engine 委派 seed=nodeId FNV-1a；registry 各族 seed 经 params/ctx 同源。
 */
export function executeStrategyPlan(deps: { db: SqliteDb; blobs: BlobStore }, input: {
  taskId: string;
  plan: StrategyPlan;
  engineLayout?: EngineLayoutDelegate;
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

  const allGems: KernelGem[] = [];
  const excludedRegions: ExcludedRegion[] = [];
  const warnings: StrategyWarning[] = [];
  const nodeSummaries: NodeExecutionSummary[] = [];
  const byKind = new Map<KernelStrategyKind, number>();

  for (const assignment of plan.assignments) {
    const node = nodeById.get(assignment.nodeId);
    const block = blockById.get(assignment.nodeId);
    if (node === undefined || block === undefined) {
      throw new StrategyDesignError(
        `指派节点 ${assignment.nodeId} 无对应 block（非产块节点——plan 校验后树漂移？）`,
        'execute-failed',
      );
    }
    const diameterMm = nodeDiameterMmOf(assignment) ?? referenceDiameterMm;
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
      result = applyStrategy(assignment.strategyKind, { node, block, params: assignment.params, canvas }, ctx);
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
        density: assignment.densityPerCm2 / DEFAULT_DENSITY_PER_CM2,
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

    // —— P1.4 强制引擎校验门（间距/掩膜内——违例颗剔除+warnings；全灭=typed 拒）
    const verdict = validateGemPlacement(gems, {
      mask: block.mask,
      bbox: block.bbox,
      minPx: ctx.gemDiameterPx * 0.999,
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
    });
  }

  // —— 三工件落档（putTaskArtifact——fence 同事务；写入序=plan JSON → gems JSON → 预览 PNG，
  //     planRef 是 gems 文档的溯源锚，gems 落档前回填）
  const planPut = putArtifactChecked(deps, input.taskId, Buffer.from(JSON.stringify(plan, null, 1), 'utf8'));
  const gemsDoc: StrategyGemsDoc = StrategyGemsDocSchema.parse({
    kind: 'strategy-gems',
    formatVersion: 1,
    planRef: planPut,
    canvasCm: tree.canvasCm,
    imagePx: tree.imagePx,
    gems: allGems,
    excludedRegions,
    warnings,
    createdAt: new Date().toISOString(),
  });
  const gemsPut = putArtifactChecked(deps, input.taskId, Buffer.from(JSON.stringify(gemsDoc, null, 1), 'utf8'));
  // —— gems 叠加预览（P0.4 preview 同款纯像素纪律：非纯白底+节点框+钻点阵留存）
  const previewPut = putArtifactChecked(
    deps,
    input.taskId,
    renderGemsOverlay({
      imagePx: tree.imagePx,
      nodes: tree.nodes.map((node) => ({ bbox: node.bbox, drillWorthy: node.drillWorthy })),
      gems: allGems.map((gem) => ({
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
      gemCount: allGems.length,
      excludedRegions,
      warnings,
      nodeSummaries,
      byKind: Object.fromEntries(byKind),
      note: '工件名约定（emit 层消费）：strategy-plan.json / strategy-gems.json / strategy-gems-preview.png',
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
 * gems 点阵叠加预览（纯函数——同输入同 PNG，审计可回放；零字体依赖同 P0.4）：
 * 浅灰底 + 节点 bbox 框（drillWorthy 绿/排除红，2px）+ 钻圆盘（首石色）。
 * 裁剪语义同 setPixel（贴边/越界像素丢弃）。
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
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= radius * radius) setPixel(cx + dx, cy + dy, gem.colorRgb);
      }
    }
  }
  return encodePng(width, height, out);
}

// ---------------------------------------------------------------- [5] 工具面注册

export interface StrategyDesignCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** DATA_ROOT（strategy-design-logs 留存根）。 */
  dataRoot: string;
  /** 既有 LLM 配置（env 真源——key 绝不入库）。 */
  llm: LlmConfig;
  /** §3.6 授权桥（approved-mutation 面；缺省时按 core.ts 一律 principal-forbidden）。 */
  approvals?: ApprovalService;
  /** 引擎 layout 委派真身（kernel/index.ts 接线——registry adapter 契约消费规则）。 */
  engineLayout?: EngineLayoutDelegate;
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
      approvals.settleExternal(input.proposalId, resultRef !== undefined ? { kind: 'succeeded', resultRef } : { kind: 'succeeded' });
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
        + '（styleId 接口位预留/styleHint 自由文本）→ LLM 逐节点指派 StrategyPlan（每节点'
        + ' strategyKind+params+钻引用+密度+理由——params 经 registry 逐项校验）→ 逐节点指派表'
        + ' diff 预览）；带 proposalId = 执行（逐节点 applyStrategy 真执行+引擎校验门+三工件'
        + ' 落档：strategy-plan/strategy-gems/叠加预览 PNG）。两层编辑铁律：本工具=图层级'
        + ' 策略面；单钻微调归设计师工作台。',
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
              || p.styleHint !== undefined || p.instruction !== undefined
            ) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            const outcome = executeApprovedLocal(STRATEGY_DESIGN_TOOL_NAME, p, ({ payload }) => {
              // payload plan 防御性终验（canonicalJson round-trip 后 schema 复核——不静默吃漂移）
              const planCheck = StrategyPlanSchema.safeParse(payload['plan']);
              if (!planCheck.success) {
                throw new StrategyDesignError(
                  `proposal 载荷 plan 不符 StrategyPlan 契约：${planCheck.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
                  'llm-invalid-plan',
                );
              }
              return executeStrategyPlan(
                { db: deps.db, blobs: deps.blobs },
                { taskId: p.taskId, plan: planCheck.data, ...(deps.engineLayout !== undefined ? { engineLayout: deps.engineLayout } : {}) },
              );
            });
            if (outcome.kind === 'ok') noteSuccess(bucket);
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
            },
            preview: { before, after },
            summary:
              `策略设计：${draft.plan.assignments.length} 节点指派（${kindSummary}）·候选钻 ${draft.candidates.length} 款`
              + `${draft.plan.styleId !== undefined ? `·风格 ${draft.plan.styleId}` : ''}`
              + `${draft.casBinding !== undefined ? `·组合投影绑定（v${draft.casBinding.baseRevision}——批准期间组合被改必拒）` : ''}`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
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
              pending: '等待用户批准（approval-request 已入任务帧流；批准前库内零变化）',
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
