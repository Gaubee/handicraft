/**
 * 迭代抠图停止判据纯函数（add-subject-sam-pipeline design §2——P0.3，零模型依赖）。
 * 决策源：owner-directive 主文（停止两面：有效内容 ~5mm×5mm 不再细分 / 颜色容差
 * 不高的大范围内容停）+ §9 回流 5 权重修正（软判据卡通稿 0/19 触发，实际停止器=
 * 「模型不再返回新实例」——判据 3 为主、1/2 为辅记录用）。
 * 语义：四判据各自独立评估，任一触发即 stop=true；reasons 按 weight 排序
 * （hard-cap > model > size > color——硬顶绝对优先，模型自认次之，软判据记录）。
 * 常量同源：ΔE 阈值默认取 contracts DELTA_E_FAMILY（三档 3/10/25 冻结，
 * experiments/rhinestone-catalog-20260924/SUBSTITUTION.md 决策序）。
 * 纯函数纪律：无 IO/无随机/同输入同输出（确定性单测覆盖）；「最大迭代数默认按
 * 画布面积标定」是调用方（P2.4 循环状态机）策略，本层不发明公式。
 */
import { DELTA_E_FAMILY } from '@handicraft/contracts';

/** 尺寸判据系数 K 缺省（design §2 判据 1：阈值=K×maxGemDiameterMm；2.5×2mm 钻≈5mm×5mm 量级——owner 原话对齐）。 */
export const SIZE_FACTOR_K_DEFAULT = 2.5;

/** 色容差判据缺省（contracts 三档中档=同色族；天空/草地类大范围平色在此档判停）。 */
export const DELTA_E_STOP_DEFAULT = DELTA_E_FAMILY;

/**
 * 模型自认信号（design §2 判据 3——入口参数，SAM3 本轮返回的语义评估）：
 * - new-instances：本轮仍抠出新实例（继续迭代）
 * - no-new-instance：提示无新实例（§9 实测主停止器）
 * - low-score：新实例 score 低（弱信号，判停）
 */
export type ModelSignal = 'new-instances' | 'no-new-instance' | 'low-score';

/** 节点现状（S3 迭代循环逐节点维护——ObjectNode.effectiveMm/labVariance 同源回填）。 */
export interface StopNodeState {
  /** 有效物理尺寸 mm（mask 面积开方） */
  effectiveMm: number;
  /** 节点内 Lab 色方差（ΔE76 量纲——contracts color.ts 管线） */
  labVariance: number;
}

/** 判据参数（maxGemDiameterMm 随钻规格表取值；硬顶两值由循环状态机显式给入）。 */
export interface StopCriteriaParams {
  maxGemDiameterMm: number;
  /** K 缺省 SIZE_FACTOR_K_DEFAULT */
  sizeFactorK?: number;
  /** ΔE 阈值缺省 DELTA_E_STOP_DEFAULT（=contracts DELTA_E_FAMILY） */
  deltaEThreshold?: number;
  modelSignal: ModelSignal;
  /** 当前迭代轮次（0 基） */
  iteration: number;
  maxIterations: number;
  /** 全局节点数（含本节点） */
  totalNodes: number;
  maxNodes: number;
}

/** 触发原因（权重序=声明序：hard-cap > model > size > color——§9 权重修正）。 */
export type StopReason = 'hard-cap' | 'model' | 'size' | 'color';

export interface SizeCriterionResult {
  stop: boolean;
  effectiveMm: number;
  /** 阈值=K×maxGemDiameterMm（mm） */
  thresholdMm: number;
}

export interface ColorCriterionResult {
  stop: boolean;
  labVariance: number;
  threshold: number;
}

export interface ModelCriterionResult {
  stop: boolean;
  signal: ModelSignal;
}

export interface HardCapCriterionResult {
  stop: boolean;
  iteration: number;
  maxIterations: number;
  totalNodes: number;
  maxNodes: number;
}

/** 结构化判定（各判据独立结果+综合 stop+按权重排序的原因清单）。 */
export interface StopVerdict {
  size: SizeCriterionResult;
  color: ColorCriterionResult;
  model: ModelCriterionResult;
  hardCap: HardCapCriterionResult;
  /** 综合：任一判据触发即 true */
  stop: boolean;
  /** 触发原因按权重排序（hard-cap > model > size > color；空=继续迭代） */
  reasons: StopReason[];
  /** 主导原因（reasons[0]；null=不停）——§9「判据 3 为主」在原因序中体现 */
  primaryReason: StopReason | null;
}

function ensurePositive(name: string, v: number): void {
  if (!Number.isFinite(v) || v <= 0) throw new RangeError(`${name} 必须为正有限数（实为 ${v}）`);
}

/**
 * 评估单节点停止判据（确定性纯函数）。
 * 坏参数 typed error（RangeError）：maxGemDiameterMm/sizeFactorK/deltaEThreshold/
 * maxIterations/maxNodes 非正或非有限——驱动循环的参数不允许猜测兜底。
 */
export function evaluateStopCriteria(node: StopNodeState, params: StopCriteriaParams): StopVerdict {
  ensurePositive('maxGemDiameterMm', params.maxGemDiameterMm);
  const k = params.sizeFactorK ?? SIZE_FACTOR_K_DEFAULT;
  ensurePositive('sizeFactorK', k);
  const threshold = params.deltaEThreshold ?? DELTA_E_STOP_DEFAULT;
  ensurePositive('deltaEThreshold', threshold);
  ensurePositive('maxIterations', params.maxIterations);
  ensurePositive('maxNodes', params.maxNodes);

  const thresholdMm = k * params.maxGemDiameterMm;
  const size: SizeCriterionResult = {
    stop: node.effectiveMm <= thresholdMm,
    effectiveMm: node.effectiveMm,
    thresholdMm,
  };
  const color: ColorCriterionResult = {
    stop: node.labVariance <= threshold,
    labVariance: node.labVariance,
    threshold,
  };
  const model: ModelCriterionResult = {
    stop: params.modelSignal !== 'new-instances',
    signal: params.modelSignal,
  };
  const hardCap: HardCapCriterionResult = {
    stop: params.iteration >= params.maxIterations || params.totalNodes >= params.maxNodes,
    iteration: params.iteration,
    maxIterations: params.maxIterations,
    totalNodes: params.totalNodes,
    maxNodes: params.maxNodes,
  };

  const reasons: StopReason[] = [];
  if (hardCap.stop) reasons.push('hard-cap');
  if (model.stop) reasons.push('model');
  if (size.stop) reasons.push('size');
  if (color.stop) reasons.push('color');

  return {
    size,
    color,
    model,
    hardCap,
    stop: reasons.length > 0,
    reasons,
    primaryReason: reasons[0] ?? null,
  };
}
