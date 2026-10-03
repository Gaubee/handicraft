/**
 * 掩膜质量门（add-vision-pipeline-v2 D5——几何先验，纯函数零 IO）。
 * 生产实证（三天使图 round2，2026-10-03）：右发掩膜泄漏成 95×288 全身条带 / 中发
 * 1% 空膜 / 左翅收缩——agent 对病态掩膜零感知。本模块按 design D5 三先验给出
 * **typed warning 级**判定（拒收≠丢弃：不丢结果、不阻断循环，warning 回流 agent
 * 决策重试——换英文措辞/调精度/拆分提示）：
 *   [1] mask-suspicious-fill 填充率下限：fill=置位数/bbox 面积 < minFill（缺省 5%
 *       ——中发 1% 空膜命中）；
 *   [2] mask-suspicious-aspect 细长宽容带：bbox 宽高比 ∉ [aspectMin, aspectMax]
 *       （缺省 [0.5, 2]）**且** 高度 > parentHeightShare×高度基准（缺省 90%——高度
 *       基准=父节点 bbox 高，无父回画布高）。设计原文「细长结构（hair/lineage 类）
 *       宽高比 ∈[0.5,2] 宽容带或高度 ≤父节点 90%」=细长本身合法（缎带/发丝天然
 *       细长），细长**且**贯穿父层高度才可疑（右发 95×288 全身条带命中）；
 *   [3] mask-parent-iou 父掩膜 IoU 上限：IoU(子, 父) > parentIouCeiling（缺省
 *       0.95——循环的子掩膜恒=父∩子，SAM 若回「整片父」泄漏则 IoU=1；右发整身
 *       泄漏型命中）。仅父节点在场时评估（顶层节点无父）。
 * 纯度纪律：无 IO/无随机/无时钟；三条先验独立评估（各自独立 reason，可同拍多命中）；
 * 阈值经入参注入（SegmentLoopOptions.maskQuality/segment-tool deps——「config 注入
 * +缺省」），缺省=下方冻结常量。结构面（画布根等）不进门（调用方裁定）。
 */
import type { NodeBBox } from '@handicraft/contracts';

/** 质量门阈值（全字段可注入；缺省 MASK_QUALITY_DEFAULTS）。 */
export interface MaskQualityThresholds {
  /** 填充率下限（0..1——置位数/bbox 面积；design D5：≥5%）。 */
  minFill: number;
  /** 宽高比宽容带下限（bbox.w/bbox.h；design D5：0.5）。 */
  aspectMin: number;
  /** 宽高比宽容带上限（design D5：2）。 */
  aspectMax: number;
  /** 高度占基准份额上限（0..1——细长先验的第二条件；design D5：父节点 90%）。 */
  parentHeightShare: number;
  /** 父掩膜 IoU 上限（0..1——「整片父」泄漏先验；design D5 未给数，取 0.95：
   *  循环子掩膜=父∩子 ⇒ 泄漏型恒 IoU=1，正常细分子掩膜远小于父）。 */
  parentIouCeiling: number;
}

/** 缺省阈值（design D5 显式值；parentIouCeiling 为实现裁定缺省——见上）。 */
export const MASK_QUALITY_DEFAULTS: Readonly<MaskQualityThresholds> = Object.freeze({
  minFill: 0.05,
  aspectMin: 0.5,
  aspectMax: 2,
  parentHeightShare: 0.9,
  parentIouCeiling: 0.95,
});

/** 质量门命中（typed reason——进 SegmentLoopWarning/SegmentOneWarning 联合）。 */
export type MaskQualityReason =
  | 'mask-suspicious-fill'
  | 'mask-suspicious-aspect'
  | 'mask-parent-iou';

export interface MaskQualityFlag {
  reason: MaskQualityReason;
  /** 确定性人读细节（含测量值——同输入同输出） */
  detail: string;
}

/** 质量门输入（全图级 bits——与 imagePx 同维；bbox/parentBbox 由调用方先算好免重扫）。 */
export interface MaskQualityInput {
  /** 被检掩码（画布级 0/1 bits） */
  bits: Uint8Array;
  /** 被检掩码紧外接矩形（调用方已算） */
  bbox: NodeBBox;
  imagePx: { width: number; height: number };
  /** 父节点（v2 挂靠/细分目标在场时提供——父 IoU 先验+高度基准；缺省=无父） */
  parent?: { bbox: NodeBBox; bits: Uint8Array };
}

/** 百分比格式（detail 面统一两位小数）。 */
function pct(v: number): string {
  return `${(v * 100).toFixed(2)}%`;
}

/**
 * 三先验评估（纯函数）：返回命中 flags（空数组=通过）。父 IoU 需 parentBits 在场；
 * 细长先验的高度基准=父 bbox 高，无父回画布高（顶层元素对画布贯穿同样可疑——
 * 右发型泄漏在 legacy-flat 首轮即无父节点）。
 */
export function evaluateMaskQuality(
  input: MaskQualityInput,
  thresholds: MaskQualityThresholds = MASK_QUALITY_DEFAULTS,
): MaskQualityFlag[] {
  const flags: MaskQualityFlag[] = [];
  const { bits, bbox, imagePx, parent } = input;
  const area = bbox.w * bbox.h;
  if (area <= 0) return flags; // 空 bbox 不进门（调用方零实例路径已分流）

  // [1] 填充率
  let pop = 0;
  for (let y = 0; y < bbox.h; y++) {
    const row = (bbox.y + y) * imagePx.width + bbox.x;
    for (let x = 0; x < bbox.w; x++) {
      pop += bits[row + x]!;
    }
  }
  const fill = pop / area;
  if (fill < thresholds.minFill) {
    flags.push({
      reason: 'mask-suspicious-fill',
      detail: `填充率 ${pct(fill)} < 下限 ${pct(thresholds.minFill)}（置位 ${pop}/${area} px）——疑似空膜/碎屑膜，请查看预览图并考虑换更具体的英文措辞重试`,
    });
  }

  // [2] 细长宽容带（aspect 越带 且 高度贯穿基准）
  const aspect = bbox.w / bbox.h;
  const heightRef = parent !== undefined ? parent.bbox.h : imagePx.height;
  const heightRefLabel = parent !== undefined ? `父节点 ${parent.bbox.h}px` : `画布 ${imagePx.height}px`;
  if (
    (aspect < thresholds.aspectMin || aspect > thresholds.aspectMax)
    && bbox.h > thresholds.parentHeightShare * heightRef
  ) {
    flags.push({
      reason: 'mask-suspicious-aspect',
      detail: `细长泄漏嫌疑：宽高比 ${aspect.toFixed(2)} ∉ [${thresholds.aspectMin}, ${thresholds.aspectMax}] 且高度 ${bbox.h}px > ${thresholds.parentHeightShare * 100}%×${heightRefLabel}——疑似掩膜沿全身/整域泄漏成条带，请查看预览图并考虑换更具体的英文措辞重试`,
    });
  }

  // [3] 父 IoU 上限（无父跳过）
  if (parent !== undefined) {
    let inter = 0;
    let union = 0;
    for (let i = 0; i < bits.length; i++) {
      const a = bits[i]!;
      const b = parent.bits[i]!;
      if (a === 1 && b === 1) inter++;
      if (a === 1 || b === 1) union++;
    }
    if (union > 0) {
      const iou = inter / union;
      if (iou > thresholds.parentIouCeiling) {
        flags.push({
          reason: 'mask-parent-iou',
          detail: `与父掩膜 IoU ${iou.toFixed(3)} > 上限 ${thresholds.parentIouCeiling}（${inter}/${union} px）——疑似 SAM 把整个父区域当目标返回（泄漏型），请查看预览图并考虑拆分提示或调高精度重试`,
        });
      }
    }
  }
  return flags;
}
