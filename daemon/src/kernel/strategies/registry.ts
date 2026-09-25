/**
 * 内核策略注册表（add-subject-sam-pipeline design §4/§5——P1.5，后续波次的冻结接口）。
 * 决策源：owner-directive-20260924.md（四族展开=KernelStrategyKind 七值，contracts P0.1 冻结）。
 *
 * 引擎五策略 adapter 契约（本波声明式通道——P3 接线）：
 *   引擎 hex-thin/hex-pitch/poisson/hybrid/cvt 经 adapter **降级为基础族（geometry）成员**
 *   （design §0「统一硬算法仅为基础几何族之一」+ §4.1）。本 strategies 子树**不 import
 *   引擎函数**（包边界纪律——引擎消费一律经 rhinestone-studio/engine 公共出口由接线层
 *   （jobs/engine.ts 先例）执行，同 P0.2 自实现红线）。通道两入口：
 *   [1] StrategyAssignment.engineStrategy（contracts P0.1 偏差[4]——LLM 显式指派引擎路径/
 *       几何族不足降级 hex 时显式落引擎面）；
 *   [2] StrategyResult.engineStrategy（本注册表输出位——内核执行器自产 Gem 缺省，几何族
 *       可读下限守卫触发时声明式降级，见 geometry.ts §9 回流 4）。
 *   P3 接线消费规则：指派带 engineStrategy 或 apply 结果带 engineStrategy → 该节点
 *   block 路由引擎 layout(strategy) 公共出口产 Gem（密度/seed 经 StrategyAssignment 通道），
 *   不调 applyStrategy 的 gems；两者均缺 → 消费 applyStrategy 的 gems。
 *
 * 状态矩阵（P1.2+P1.4 落位后）：七值全部 implemented。free-code=P1.4 沙箱（sandbox/
 * 子树：worker 隔离+三线有界+输出校验链）——失败抛 SandboxFailureError（typed failure
 * 载荷+userMessage——P3 捕获回 LLM 有界重试）。
 */
import { z } from 'zod';
import {
  DEFAULT_DENSITY_PER_CM2,
  KernelStrategyKindSchema,
  StrategyIdSchema,
  type CanvasCm,
  type ImagePx,
  type KernelStrategyKind,
  type NodeId,
  type ObjectNode,
} from '@handicraft/contracts';
import type { TreeBlock } from '../vision/tree-to-blocks.js';
import { exclusionStrategy } from './exclusion.js';
import { flowerStrategy } from './flower.js';
import { geometryHelpers, geometryStrategy, type GeometryHelpers } from './geometry.js';
import { mulberry32, type RngFactory } from './rng.js';
import { freeCodeStrategy } from './sandbox/free-code.js';
import { softCurveStrategy } from './soft_curve.js';
import { straightLineStrategy } from './straight_line.js';
import { textureFillStrategy } from './texture_fill.js';

// ---------------------------------------------------------------- 冻结接口（后续波次依据）

/** 引擎钻形六值（engine spec.ts SHAPE_IDS 同构——红线：不 import，字面抄录）。 */
export const KERNEL_GEM_SHAPE_IDS = ['round', 'square', 'drop', 'heart', 'marquise', 'custom'] as const;
export type KernelGemShapeId = (typeof KERNEL_GEM_SHAPE_IDS)[number];

/**
 * 内核钻位（engine types.ts Gem 同构——红线：不 import，字段/序一致）。
 * 内核策略产钻约束：shapeId='round'（内核基座钻形——异形由钻规格/编辑层替换）、
 * colorId=''（未映射——mapColors 是引擎既有阶段）、diameterMm=ctx.gemDiameterPx/ppm。
 */
export interface KernelGem {
  id: string;
  x: number;
  y: number;
  colorId: string;
  blockId: NodeId;
  shapeId: KernelGemShapeId;
  /** 唯一物理依据（mm——逐钻判距/渲染；引擎 Gem.diameterMm 同构） */
  diameterMm: number;
  rotationDeg?: number;
  assetId?: string;
}

export type StrategyWarningKind = 'excluded' | 'degraded' | 'spacing' | 'mask' | 'geometry';

export interface StrategyWarning {
  kind: StrategyWarningKind;
  detail: string;
}

/** BOM 未贴区注记结构（§4.3——排除族输出位；BOM 导出按节点分组消费）。 */
export interface ExcludedRegion {
  nodeId: NodeId;
  label: string;
  reason: string;
  /** 未贴区面积（cm²——block.areaPx/ppm²/100） */
  areaCm2: number;
}

/** 引擎策略 id（contracts StrategyIdSchema 五值同源复用——不另立字面量）。 */
export type EngineStrategyId = z.infer<typeof StrategyIdSchema>;

/** engineStrategy 声明式降级通道（头注 adapter 契约[2]——P3 接线消费）。 */
export interface EngineStrategyDelegation {
  engineStrategy: EngineStrategyId;
  reason: 'geometry-min-size' | 'explicit';
  note: string;
}

/** 统一策略产出（gems+warnings 必备；excludedRegions/engineStrategy 为各族输出位）。 */
export interface StrategyResult {
  gems: KernelGem[];
  warnings: StrategyWarning[];
  excludedRegions?: ExcludedRegion[];
  engineStrategy?: EngineStrategyDelegation;
}

/** 画布标度三面（px/cm/ppm——§1 S1 一等输入随工件流转）。 */
export interface KernelCanvas {
  px: ImagePx;
  cm: CanvasCm;
  pixelsPerMm: number;
}

/** 统一 apply 输入（node+block 投影——block=P0.2 TreeBlock，id 同寻址空间）。 */
export interface StrategyApplyInput {
  node: ObjectNode;
  block: TreeBlock;
  /** 未知对象——逐族 paramsSchema.parse（Zod 冻结；缺省值族内消化） */
  params: unknown;
  canvas: KernelCanvas;
}

/**
 * 统一策略上下文（注入面）：rng=确定性 PRNG 工厂（mulberry32 同构——同 seed 同果）；
 * geometry=帮助库注入面（geometry.ts 单源，P1.4 沙箱同面复用）；gemDiameterPx=判距
 * 物理下限；densityPerCm2 缺省 DEFAULT_DENSITY_PER_CM2（Owner 定调 2.3/cm²）。
 */
export interface StrategyContext {
  rng: RngFactory;
  geometry: GeometryHelpers;
  gemDiameterPx: number;
  densityPerCm2: number;
}

/** 策略实现位（注册表成员契约）。 */
export interface KernelStrategy {
  readonly kind: KernelStrategyKind;
  readonly status: 'implemented' | 'reserved';
  readonly paramsSchema: z.ZodType;
  apply(input: StrategyApplyInput, ctx: StrategyContext): StrategyResult;
}

// ---------------------------------------------------------------- 引擎五策略=基础族成员（声明式）

/** 引擎五策略 → 基础族（geometry）成员映射（design §0/§4.1；消费规则见头注 adapter 契约）。 */
export const ENGINE_BASE_FAMILY: Readonly<Record<EngineStrategyId, { family: 'geometry'; note: string }>> = {
  'hex-thin': {
    family: 'geometry',
    note: '六方晶格 RIPD 抽稀（密铺变体）——经 engineStrategy 通道由接线层路由引擎公共出口',
  },
  'hex-pitch': {
    family: 'geometry',
    note: '六方晶格密铺（几何族可读下限不足的缺省降级目标——§9 回流 4）',
  },
  poisson: { family: 'geometry', note: '泊松盘采样（各向同性散布）——风格门控默认关（Owner 补充定调）' },
  hybrid: { family: 'geometry', note: '晶格+泊松混合' },
  cvt: { family: 'geometry', note: '重心 Voronoi 铺装（受限 Lloyd 松弛器底座——纹理 v2 回流 2）' },
};

// ---------------------------------------------------------------- 注册表本体

/** 七值（contracts KernelStrategyKindSchema 同源——注册表键完备性编译期由 Record 保证）。 */
export const STRATEGY_KINDS = KernelStrategyKindSchema.options;

/** 预留槽占位策略：apply 即抛（fail-fast——不静默空产出误导 BOM/预览）。 */
export class StrategyNotImplementedError extends Error {
  constructor(
    readonly kind: KernelStrategyKind,
    readonly wave: string,
  ) {
    super(`策略 ${kind} 未实现（${wave} 波次落位——本波仅注册接口槽）`);
    this.name = 'StrategyNotImplementedError';
  }
}

function reserved(kind: KernelStrategyKind, wave: string): KernelStrategy {
  return {
    kind,
    status: 'reserved',
    paramsSchema: z.unknown(),
    apply() {
      throw new StrategyNotImplementedError(kind, wave);
    },
  };
}

const REGISTRY: Record<KernelStrategyKind, KernelStrategy> = {
  geometry: geometryStrategy,
  exclusion: exclusionStrategy,
  'texture-fill': textureFillStrategy,
  'soft-curve': softCurveStrategy,
  flower: flowerStrategy,
  'straight-line': straightLineStrategy,
  'free-code': freeCodeStrategy,
};

/** 注册表（七值全量——KernelStrategyKind → 实现位；只读快照防篡改）。 */
export const STRATEGY_REGISTRY: ReadonlyMap<KernelStrategyKind, KernelStrategy> = new Map(
  Object.entries(REGISTRY) as [KernelStrategyKind, KernelStrategy][],
);

/**
 * 统一分发入口（§4 四类策略执行器——S7 strategy.apply 的内核侧单点）。
 * kind 经 KernelStrategyKindSchema 校验（raw 字符串先 parse——LLM 输出边界）；
 * reserved 槽抛 StrategyNotImplementedError；params 非法由族内 Zod fail-fast
 * （P3 捕获回 LLM 有界重试——§4.4 同哲学）。
 */
export function applyStrategy(
  kind: KernelStrategyKind,
  input: StrategyApplyInput,
  ctx: StrategyContext,
): StrategyResult {
  const entry = STRATEGY_REGISTRY.get(kind);
  if (entry === undefined) throw new Error(`策略 ${kind} 不在注册表（七值之外——KernelStrategyKindSchema 先行校验）`);
  return entry.apply(input, ctx);
}

/**
 * 缺省上下文工厂：rng=mulberry32（rng.ts 同构）；geometry=geometryHelpers 单源；
 * density 缺省 DEFAULT_DENSITY_PER_CM2（Owner 2026-09-24 晚定调）。
 */
export function createStrategyContext(init: {
  gemDiameterPx: number;
  densityPerCm2?: number;
  rng?: RngFactory;
}): StrategyContext {
  if (!(init.gemDiameterPx > 0)) throw new RangeError('gemDiameterPx 必须为正');
  return {
    rng: init.rng ?? mulberry32,
    geometry: geometryHelpers,
    gemDiameterPx: init.gemDiameterPx,
    densityPerCm2: init.densityPerCm2 ?? DEFAULT_DENSITY_PER_CM2,
  };
}
