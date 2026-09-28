/**
 * 管线入线降采样（realize-scene-understanding W1——Owner 性能指令 2026-09-28）。
 * 原始需求（Owner 原话）：「处理图片的时候，基于图片尺寸（cm）做低像素处理（比如
 * 1cm 换算成 10px-50px，你自己评估一个合适的比例），目的都是为了更快的性能更好
 * 的效果」。
 *
 * 语义冻结（MainAgent 裁定 25px/cm 缺省——1px=0.4mm，小于最小钻径 2mm 的 1/5）：
 *   [1] 物理密度门：imagePx/canvasCm 主轴密度超过目标密度（PPCM_TARGET 缺省 25，
 *       clamp 10..50）→ 面积降采样到目标密度；**只降不升**（密度≤目标=原图直通）。
 *   [2] 物理尺寸缺失兜底：无 canvasCm 声明时长边 PPCM_FALLBACK_MAX_EDGE_PX=2048
 *       封顶（同样只降不升）。
 *   [3] env 面：PPCM_RESAMPLE=0 整体关闭（透传旧行为；缺省开）；PPCM_TARGET 数值
 *       越界 clamp 到界内（10..50——Owner 给定的可配区间）。
 *   [4] 降采为入线单点：锚点图换新 blob+imagePx 同源更新后，全链（S2 工件/SAM 桥/
 *       掩码/树/预览）天然在新坐标系——不在中途二次缩放。
 *
 * 降采质量：面积加权平均（OpenCV INTER_AREA 同语义的确定性实现——逐目标像素按
 * 源覆盖分数加权累加，整数输入浮点累进 round 出；无随机、同图同产物）。刻意不用
 * 最近邻（锯齿）与朴素盒滤波（整数倍丢弃亚像素权重——buildWorkGrid 那类工作网格
 * 降采是 kmeans 统计面，此处是锚点图重建面，保真度要求更高）。
 * 正交意图：
 *   [1] resolveIntakeResampleConfig：env → 配置（开关+clamped 目标密度）。
 *   [2] planIntakeResample：纯规划（尺寸/物理声明 → 是否降采+目标尺寸+原因）。
 *   [3] resampleRgbaArea：纯执行（RGBA 平面面积加权降采）。
 */
import type { CanvasCm } from '@handicraft/contracts';

// ---------------------------------------------------------------- 冻结常量

/** 目标密度 env 键（px/cm——1cm 换算像素数）。 */
export const PPCM_TARGET_ENV = 'PPCM_TARGET';

/** 入线降采总开关 env 键（=0 关闭透传；缺省=开）。 */
export const PPCM_RESAMPLE_ENV = 'PPCM_RESAMPLE';

/** 缺省目标密度（px/cm）：25=1px 0.4mm——最小钻径 2mm 的 1/5（精度裁定）。 */
export const PPCM_TARGET_DEFAULT = 25;

/** 目标密度下界（px/cm——Owner 区间下限）。 */
export const PPCM_TARGET_MIN = 10;

/** 目标密度上界（px/cm——Owner 区间上限）。 */
export const PPCM_TARGET_MAX = 50;

/** 物理尺寸缺失兜底：长边封顶（px）。 */
export const PPCM_FALLBACK_MAX_EDGE_PX = 2048;

// ---------------------------------------------------------------- [1] 配置面

export interface IntakeResampleConfig {
  /** 总开关（PPCM_RESAMPLE=0 → false=透传旧行为）。 */
  enabled: boolean;
  /** 目标密度（px/cm，已 clamp 10..50）。 */
  ppcmTarget: number;
}

/** env → 入线降采配置（坏值落缺省/clamp——env 面宽容，语义面严格）。 */
export function resolveIntakeResampleConfig(
  env: NodeJS.ProcessEnv = process.env,
): IntakeResampleConfig {
  const enabled = env[PPCM_RESAMPLE_ENV]?.trim() !== '0';
  const raw = Number(env[PPCM_TARGET_ENV]?.trim() ?? '');
  const ppcmTarget = Number.isFinite(raw) && raw > 0
    ? Math.min(PPCM_TARGET_MAX, Math.max(PPCM_TARGET_MIN, Math.floor(raw)))
    : PPCM_TARGET_DEFAULT;
  return { enabled, ppcmTarget };
}

// ---------------------------------------------------------------- [2] 规划面

export type IntakeResampleReason = 'density-cap' | 'edge-fallback' | 'none';

/** 入线降采规划（纯函数——确定性；resampled=false 时 width/height=原尺寸）。 */
export interface IntakeResamplePlan {
  resampled: boolean;
  /** 目标尺寸（resampled=false 时=入参原尺寸）。 */
  width: number;
  height: number;
  /** 应用缩放（≤1；1=不变——只降不升由构造排除）。 */
  scale: number;
  reason: IntakeResampleReason;
  /** 入线密度 px/cm（canvasCm 缺席=null——兜底分支无物理密度可言）。 */
  ppcmBefore: number | null;
  /** 降采后密度 px/cm（resampled=false 时=ppcmBefore；null 同前）。 */
  ppcmAfter: number | null;
  /** 规划所用目标密度（config.ppcmTarget——审计面；兜底分支为 null）。 */
  ppcmTarget: number | null;
}

/**
 * 入线降采规划：
 * - 关闭 → 直通（reason='none'）。
 * - canvasCm 在场 → 主轴密度 max(w/cw, h/ch)（纵横比一致时两轴相等；以更密轴为
 *   准=保守）超目标 → scale=target/密度（等比）；≤目标直通（只降不升）。
 * - canvasCm 缺席 → 长边 2048 兜底封顶。
 * 尺寸换算：round（半像素级取舍；w/h 至少 1px——空图由上游解码边界排除）。
 */
export function planIntakeResample(
  input: { width: number; height: number; canvasCm: CanvasCm | null },
  config: IntakeResampleConfig,
): IntakeResamplePlan {
  const none: IntakeResamplePlan = {
    resampled: false,
    width: input.width,
    height: input.height,
    scale: 1,
    reason: 'none',
    ppcmBefore: null,
    ppcmAfter: null,
    ppcmTarget: null,
  };
  if (!config.enabled || input.width < 1 || input.height < 1) return none;

  if (input.canvasCm === null) {
    const maxEdge = Math.max(input.width, input.height);
    if (maxEdge <= PPCM_FALLBACK_MAX_EDGE_PX) return none;
    const scale = PPCM_FALLBACK_MAX_EDGE_PX / maxEdge;
    return {
      resampled: true,
      width: Math.max(1, Math.round(input.width * scale)),
      height: Math.max(1, Math.round(input.height * scale)),
      scale,
      reason: 'edge-fallback',
      ppcmBefore: null,
      ppcmAfter: null,
      ppcmTarget: null,
    };
  }

  const ppcm = Math.max(input.width / input.canvasCm.w, input.height / input.canvasCm.h);
  if (ppcm <= config.ppcmTarget) {
    return { ...none, ppcmBefore: ppcm, ppcmAfter: ppcm, ppcmTarget: config.ppcmTarget };
  }
  const scale = config.ppcmTarget / ppcm;
  const width = Math.max(1, Math.round(input.width * scale));
  const height = Math.max(1, Math.round(input.height * scale));
  return {
    resampled: true,
    width,
    height,
    scale,
    reason: 'density-cap',
    ppcmBefore: ppcm,
    ppcmAfter: Math.max(width / input.canvasCm.w, height / input.canvasCm.h),
    ppcmTarget: config.ppcmTarget,
  };
}

// ---------------------------------------------------------------- [3] 执行面

/**
 * RGBA 平面面积加权降采（确定性）。目标像素 (tx,ty) 的值=源窗口
 * [tx·W/w,(tx+1)·W/w)×[ty·H/h,(ty+1)·H/h) 内像素按覆盖面积加权的均值（逐通道，
 * alpha 同通道平均——S0 归一面恒不透明，平均保 255）。放大（w>W 或 h>H）非本面
 * 语义：由 planIntakeResample 构造排除（只降不升），此处不实现插值。
 */
export function resampleRgbaArea(
  rgba: Uint8Array,
  W: number,
  H: number,
  w: number,
  h: number,
): Uint8Array {
  if (w === W && h === H) return rgba;
  if (w < 1 || h < 1 || w > W || h > H) {
    throw new Error(`resampleRgbaArea 仅支持降采（${W}×${H} → ${w}×${h} 非法——规划面已排除放大/空图）`);
  }
  const out = new Uint8Array(w * h * 4);
  const sx = W / w;
  const sy = H / h;
  for (let ty = 0; ty < h; ty++) {
    const y0 = ty * sy;
    const y1 = y0 + sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(H, Math.ceil(y1));
    for (let tx = 0; tx < w; tx++) {
      const x0 = tx * sx;
      const x1 = x0 + sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(W, Math.ceil(x1));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let weight = 0;
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y1, y + 1) - Math.max(y0, y);
        if (wy <= 0) continue;
        const rowBase = y * W;
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x1, x + 1) - Math.max(x0, x);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const p = (rowBase + x) * 4;
          r += rgba[p]! * wgt;
          g += rgba[p + 1]! * wgt;
          b += rgba[p + 2]! * wgt;
          a += rgba[p + 3]! * wgt;
          weight += wgt;
        }
      }
      const o = (ty * w + tx) * 4;
      // weight≥sx·sy>0 由构造保证（窗口非空）；除法后 round 出（确定性）。
      out[o] = Math.round(r / weight);
      out[o + 1] = Math.round(g / weight);
      out[o + 2] = Math.round(b / weight);
      out[o + 3] = Math.round(a / weight);
    }
  }
  return out;
}
