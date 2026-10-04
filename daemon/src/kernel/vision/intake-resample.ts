/**
 * 管线入线重采样（realize-scene-understanding W1——Owner 性能指令 2026-09-28；
 * 2026-10-04 工作画布确定性裁定升级）。
 * 原始需求（Owner 原话）：「处理图片的时候，基于图片尺寸（cm）做低像素处理（比如
 * 1cm 换算成 10px-50px，你自己评估一个合适的比例），目的都是为了更快的性能更好
 * 的效果」。
 *
 * 语义冻结（MainAgent 裁定 25px/cm 缺省——1px=0.4mm，小于最小钻径 2mm 的 1/5）：
 *   [1] **工作画布恒等推导（2026-10-04 Owner 报障「辅助图 512×512mm 未铺满画布」
 *       根因修复）**：canvasCm 在场时目标尺寸恒 = round(canvasCm×ppcmTarget)——
 *       与上传字节/格式无关（JPEG 转码路、原生 PNG 直传路同出同一工作画布；旧
 *       「只降不升」语义废止——密度低于目标同样升采到规范网格，排钻几何的
 *       pitch=diameter×ppm 才恒 ≥1px 可解）。纵横比漂移超
 *       CANVAS_ASPECT_TOLERANCE（2%）→ 透传不拉伸（保留 S1 derivePixelsPerMm
 *       显式拒的既有迟到面——不在入线静默畸变）。
 *   [2] 物理尺寸缺失兜底：无 canvasCm 声明时长边 PPCM_FALLBACK_MAX_EDGE_PX=2048
 *       封顶（仍只降不升——无物理锚可言，无规范网格可推）。
 *   [3] env 面：PPCM_RESAMPLE=0 整体关闭（透传旧行为；缺省开）；PPCM_TARGET 数值
 *       越界 clamp 到界内（10..50——Owner 给定的可配区间）。
 *   [4] 重采样为入线单点：锚点图换新 blob+imagePx 同源更新后，全链（S2 工件/SAM 桥/
 *       掩码/树/预览）天然在新坐标系——不在中途二次缩放。确定性（同图同配置同产物）
 *       使 scene.analyze 与 subject.segment 两入线口各自推导亦得同一 blobRef——
 *       双口锚点天然互洽。
 *
 * 重采样质量：面积加权平均（OpenCV INTER_AREA 同语义的确定性实现——逐目标像素按
 * 源覆盖分数加权累加，整数输入浮点累进 round 出；无随机、同图同产物）。升采同一
 * 公式天然成立（目标窗 <1 源像素=1..4 邻域加权——box 上采样）。刻意不用最近邻
 * （锯齿）。
 * 正交意图：
 *   [1] resolveIntakeResampleConfig：env → 配置（开关+clamped 目标密度）。
 *   [2] planIntakeResample：纯规划（尺寸/物理声明 → 是否重采样+目标尺寸+原因）。
 *   [3] resampleRgbaArea：纯执行（RGBA 平面面积加权重采样——降采/升采同式）。
 *   [4] applyIntakeResample：入线编排单源（规划→执行→intake-image.png 工件+帧；
 *       scene.analyze 与 subject.segment 共用——工作画布推导只有这一个实现）。
 */
import { CANVAS_ASPECT_TOLERANCE, type CanvasCm, type ImagePx } from '@handicraft/contracts';
import type { SqliteDb } from '../../db/database.js';
import type { BlobStore } from '../../db/blobs.js';
import type { JobService } from '../../jobs/service.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { encodePng } from '../../png/codec.js';

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

/** 入线重采样图工件名（latest-by-name 帧定位——task.detail baseImage 等消费面）。 */
export const INTAKE_IMAGE_ARTIFACT_NAME = 'intake-image.png';

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

export type IntakeResampleReason = 'density-cap' | 'density-lift' | 'edge-fallback' | 'none';

/** 入线重采样规划（纯函数——确定性；resampled=false 时 width/height=原尺寸）。 */
export interface IntakeResamplePlan {
  resampled: boolean;
  /** 目标尺寸（resampled=false 时=入参原尺寸）。 */
  width: number;
  height: number;
  /** 应用缩放（x/y 轴均值；1=不变——<1 主体降采、>1 升采到规范网格）。 */
  scale: number;
  reason: IntakeResampleReason;
  /** 入线密度 px/cm（canvasCm 缺席=null——兜底分支无物理密度可言）。 */
  ppcmBefore: number | null;
  /** 重采样后密度 px/cm（resampled=false 时=ppcmBefore；null 同前）。 */
  ppcmAfter: number | null;
  /** 规划所用目标密度（config.ppcmTarget——审计面；兜底分支为 null）。 */
  ppcmTarget: number | null;
}

/**
 * 入线重采样规划（工作画布确定性推导——2026-10-04 Owner 裁定）：
 * - 关闭 → 直通（reason='none'）。
 * - canvasCm 在场 → 目标尺寸恒 = round(canvasCm×ppcmTarget)（**与上传尺寸/格式无关**
 *   ——同名义画布的 JPEG 转码路与 PNG 直传路必得同一工作画布）。目标≠原图即重采样：
 *   主体降采 reason='density-cap'，升采/混合 reason='density-lift'；目标=原图直通。
 *   纵横比漂移超 CANVAS_ASPECT_TOLERANCE（2%）→ 直通不拉伸（S1 derivePixelsPerMm
 *   显式拒的迟到面保留——声明的物理尺寸与图不符是调用方错误，不静默畸变）。
 * - canvasCm 缺席 → 长边 2048 兜底封顶（只降不升——无物理锚无规范网格）。
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
  const aspectCm = input.canvasCm.w / input.canvasCm.h;
  const aspectPx = input.width / input.height;
  if (Math.abs(aspectPx - aspectCm) / aspectCm > CANVAS_ASPECT_TOLERANCE) {
    // 声明漂移透传（不拉伸）——迟到面：S1 derivePixelsPerMm / 树锚点校验显式拒。
    return { ...none, ppcmBefore: ppcm, ppcmAfter: ppcm, ppcmTarget: config.ppcmTarget };
  }
  // 规范网格：恒 = round(canvasCm×ppcmTarget)——上传无关（确定性推导核心）。
  const width = Math.max(1, Math.round(input.canvasCm.w * config.ppcmTarget));
  const height = Math.max(1, Math.round(input.canvasCm.h * config.ppcmTarget));
  if (width === input.width && height === input.height) {
    return { ...none, ppcmBefore: ppcm, ppcmAfter: ppcm, ppcmTarget: config.ppcmTarget };
  }
  const reason: 'density-cap' | 'density-lift' =
    width <= input.width && height <= input.height ? 'density-cap' : 'density-lift';
  return {
    resampled: true,
    width,
    height,
    scale: (width / input.width + height / input.height) / 2,
    reason,
    ppcmBefore: ppcm,
    ppcmAfter: Math.max(width / input.canvasCm.w, height / input.canvasCm.h),
    ppcmTarget: config.ppcmTarget,
  };
}

// ---------------------------------------------------------------- [3] 执行面

/**
 * RGBA 平面面积加权重采样（确定性；降采/升采同式）。目标像素 (tx,ty) 的值=源窗口
 * [tx·W/w,(tx+1)·W/w)×[ty·H/h,(ty+1)·H/h) 内像素按覆盖面积加权的均值（逐通道，
 * alpha 同通道平均——S0 归一面恒不透明，平均保 255）。升采（w>W 或 h>H）时目标窗
 * <1 源像素=1..4 邻域加权（box 上采样）——工作画布规范网格升采（2026-10-04）。
 */
export function resampleRgbaArea(
  rgba: Uint8Array,
  W: number,
  H: number,
  w: number,
  h: number,
): Uint8Array {
  if (w === W && h === H) return rgba;
  if (w < 1 || h < 1) {
    throw new Error(`resampleRgbaArea 目标尺寸非法（${W}×${H} → ${w}×${h}——空图由规划面排除）`);
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

// ---------------------------------------------------------------- [4] 入线编排单源

/**
 * 入线重采样事实面（工具结果携带——调用方/Agent 必须以本面的 imageBlobRef/imagePx
 * 为后续锚点；applied=false 时=入参原值透传）。scene.analyze 与 subject.segment 共用。
 */
export interface IntakeResampleFact {
  applied: boolean;
  /** 重采样后实际锚点图（applied=false 时=入参原值）。 */
  imageBlobRef: string;
  imagePx: ImagePx;
  /** applied 时的入参原锚点（审计：from→to 可追溯）。 */
  fromImageBlobRef?: string;
  fromImagePx?: ImagePx;
  /** applied 时=触发原因（density-cap=密度超目标降采；density-lift=升采到规范网格；
   * edge-fallback=无物理尺寸兜底）。 */
  reason?: 'density-cap' | 'density-lift' | 'edge-fallback';
  /** 入线密度 px/cm（canvasCm 在场时；透传时前后相等）。 */
  ppcmBefore?: number;
  ppcmAfter?: number;
}

/** 入线编排依赖（putTaskArtifact 工件面 + 可选帧登记）。 */
export interface IntakeResampleDeps {
  db: SqliteDb;
  blobs: BlobStore;
  jobs?: Pick<JobService, 'emitFor'>;
}

/** applyIntakeResample 输入下界（taskId/imageBlobRef/imagePx/canvasCm 四锚恒在）。 */
export type IntakeResampleSubject = {
  taskId: string;
  imageBlobRef: string;
  imagePx: ImagePx;
  canvasCm: CanvasCm;
};

export interface IntakeResampleApplied<T extends IntakeResampleSubject> {
  /** 重采样后有效输入（applied=false 时=入参原对象——恒等透传）。 */
  effective: T;
  /** 有效锚点图字节（applied=false 时=入参字节）。 */
  imageBytes: Uint8Array;
  /** 有效锚点图解码面（重采样后的 rgba——下游 measure/预览直接消费，免二次解码）。 */
  decoded: { width: number; height: number; rgba: Uint8Array };
  intake: IntakeResampleFact;
}

/**
 * 入线重采样编排单源（2026-10-04 工作画布确定性——Bug A 修复核心）：plan → 面积
 * 重采样 → PNG 落任务工件域（putTaskArtifact fence 同事务）+ intake-image.png 帧登记。
 * 透传时零写入零帧。确定性（同图同配置同产物）保证 scene.analyze 与 subject.segment
 * 两入线口各自调用亦得同一 blobRef——双口锚点互洽（agent 传原始 ref 或 intake ref
 * 均收敛到同一规范网格锚点）。
 * ArtifactFenceError 原样上抛（调用方收敛为各自 typed error）。
 */
export function applyIntakeResample<T extends IntakeResampleSubject>(
  deps: IntakeResampleDeps,
  input: T,
  decoded: { width: number; height: number; rgba: Uint8Array },
  imageBytes: Uint8Array,
  config: IntakeResampleConfig,
): IntakeResampleApplied<T> {
  const plan = planIntakeResample(
    { width: decoded.width, height: decoded.height, canvasCm: input.canvasCm },
    config,
  );
  const { ppcmBefore, ppcmAfter } = plan;
  const densityFields =
    ppcmBefore !== null && ppcmAfter !== null ? { ppcmBefore, ppcmAfter } : {};
  if (!plan.resampled) {
    return {
      effective: input,
      imageBytes,
      decoded,
      intake: {
        applied: false,
        imageBlobRef: input.imageBlobRef,
        imagePx: input.imagePx,
        ...densityFields,
      },
    };
  }
  const rgba = resampleRgbaArea(decoded.rgba, decoded.width, decoded.height, plan.width, plan.height);
  const png = encodePng(plan.width, plan.height, rgba);
  const put = putTaskArtifact(deps, input.taskId, png);
  deps.jobs?.emitFor(input.taskId, 'artifact', {
    blobRef: put.hash,
    name: INTAKE_IMAGE_ARTIFACT_NAME,
  });
  const imagePx = { width: plan.width, height: plan.height };
  const reason: 'density-cap' | 'density-lift' | 'edge-fallback' =
    plan.reason === 'edge-fallback'
      ? 'edge-fallback'
      : plan.reason === 'density-lift'
        ? 'density-lift'
        : 'density-cap';
  return {
    effective: { ...input, imageBlobRef: put.hash, imagePx },
    imageBytes: png,
    decoded: { width: plan.width, height: plan.height, rgba },
    intake: {
      applied: true,
      imageBlobRef: put.hash,
      imagePx,
      fromImageBlobRef: input.imageBlobRef,
      fromImagePx: input.imagePx,
      reason,
      ...densityFields,
    },
  };
}
