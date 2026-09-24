/**
 * stone 贴图六条 gate（add-stone-library design §1.4——S1.3）。
 * 原始需求 2026-09-24：入库贴图必须「解码实测对账 + 输入上限 + alpha 内容非空 +
 * fit 比例 + 分辨率下限」，缺贴图=显式 missing 态，全部 typed error 拒收
 * （沿 .gemshape 六条 parser gate 纪律，gem-catalog design §1.4 同源）。
 * PNG 解码复用本仓纯 TS 编解码器（src/png/codec.ts——无原生依赖纪律，
 * 不新增 pngjs/sharp）。
 * 正交意图：
 *   [1] StoneTextureGateError：typed 拒收（code 十值，逐条 gate 一一对应）。
 *   [2] gateStoneTexture：纯校验函数（字节→实测宽高/alpha bounds/主径/建议 px/mm）。
 *   [3] STONE_TEXTURE_LIMITS：上限常量单源（可参覆写——测试面）。
 */
import { decodePng, PngCodecError } from '../png/codec.js';

/** gate 拒收码（每码对应 design §1.4 一条或其输入前置）。 */
export type StoneTextureGateCode =
  | 'not-png' // 签名不符（gate 2：仅 PNG）
  | 'decode-failed' // 截断/炸弹/不支持色型/位深/隔行（codec typed 拒绝的统一面）
  | 'input-bytes-over-limit' // gate 2：输入字节 > 2MB
  | 'edge-over-limit' // gate 2：边长 > 4096px
  | 'pixels-over-limit' // gate 2：像素总量上限（防炸弹贴图）
  | 'dimension-mismatch' // gate 1：声明宽高 ≠ 解码实测
  | 'fully-transparent' // gate 3：alpha 内容 bounds 为空（全透明）
  | 'aspect-drift' // gate 4：主径纵横比与 shapeClass 期望比超容差
  | 'resolution-too-low'; // gate 5：alpha bounds 主径 < 64px 绝对下限

export class StoneTextureGateError extends Error {
  readonly code: StoneTextureGateCode;
  /** 量化细节（声明 vs 实测/上限值——报告与测试断言面）。 */
  readonly detail: Record<string, number | string>;

  constructor(code: StoneTextureGateCode, message: string, detail: Record<string, number | string> = {}) {
    super(message);
    this.name = 'StoneTextureGateError';
    this.code = code;
    this.detail = detail;
  }
}

/** 上限/容差常量（design §1.4 gate 2/4/5——单源，测试可参覆写）。 */
export interface StoneTextureLimits {
  /** 输入字节上限：2MB */
  maxInputBytes: number;
  /** 单边上限：4096px */
  maxEdgePx: number;
  /** 像素总量上限（4096²——独立防线，边长组合绕不过时的显式拒绝） */
  maxPixels: number;
  /** alpha bounds 主径绝对下限：64px */
  minSubjectPx: number;
  /** 建议 px/mm（≥32 达标——advisory 非阻断） */
  recommendedPxPerMm: number;
  /** 主径纵横比容差（期望 1:1 类；ratio ≤ 1+tolerance 放行） */
  aspectTolerance: number;
}

export const STONE_TEXTURE_LIMITS: StoneTextureLimits = {
  maxInputBytes: 2 * 1024 * 1024,
  maxEdgePx: 4096,
  maxPixels: 4096 * 4096,
  minSubjectPx: 64,
  recommendedPxPerMm: 32,
  aspectTolerance: 0.25,
};

/** 纵横比期望 1:1 的几何归类（缺省 'round'；自由串归类不预设比例——跳过 gate 4）。 */
const ONE_TO_ONE_SHAPE_CLASSES = new Set(['round', 'cabochon', 'pearl', 'resin-dome']);

export interface TextureGateInput {
  bytes: Uint8Array;
  /** 声明宽高（gate 1 对账基准——不符必拒，服务端不代改） */
  declaredWidth: number;
  declaredHeight: number;
  /** 几何归类（缺省 'round'） */
  shapeClass?: string;
  /** 物理尺寸（建议 px/mm 的换算分母；null=无尺寸声明，advisory 置 null） */
  sizeMm?: number | null;
  limits?: Partial<StoneTextureLimits>;
}

/** gate 通过产物（实测真值——入库以此落 stone.json texture，不信任声明）。 */
export interface TextureGateResult {
  /** 解码实测宽高（画布外框） */
  width: number;
  height: number;
  /** alpha 内容 bounds（alpha>0 像素的最小包围盒——主径/物理换算取此） */
  alphaBounds: { x: number; y: number; w: number; h: number };
  /** 主径 px（bounds 宽高较大者） */
  subjectMajorPx: number;
  /** 主径纵横比（≥1，宽高较大/较小） */
  subjectAspect: number;
  /** 建议 px/mm 是否达标（sizeMm=null 时为 null——无基准不下结论） */
  meetsRecommendedPxPerMm: boolean | null;
}

/** 单像素 alpha 内容判定阈值（alpha>0 即内容——软边羽化像素计入主体）。 */
const ALPHA_CONTENT_THRESHOLD = 0;

/**
 * 六条 gate 主函数（纯函数——不动库）。顺序冻结：
 * 字节上限 → 解码（签名/边界/色型 typed 拒）→ 边长/像素上限 → 实测对账 →
 * alpha bounds 非空 → fit 比例 → 分辨率下限。gate 6（missing 显式态）在
 * service 层：create 无贴图字节=typed 拒、引用解析四态见 resolveStoneRef。
 */
export function gateStoneTexture(input: TextureGateInput): TextureGateResult {
  const limits: StoneTextureLimits = { ...STONE_TEXTURE_LIMITS, ...input.limits };
  if (input.bytes.byteLength > limits.maxInputBytes) {
    throw new StoneTextureGateError(
      'input-bytes-over-limit',
      `贴图输入超上限（${input.bytes.byteLength} > ${limits.maxInputBytes} 字节）`,
      { actual: input.bytes.byteLength, limit: limits.maxInputBytes },
    );
  }
  let decoded;
  try {
    decoded = decodePng(input.bytes);
  } catch (error) {
    if (error instanceof PngCodecError && error.message.includes('签名不符')) {
      throw new StoneTextureGateError('not-png', '贴图不是 PNG（签名不符——仅收 PNG）');
    }
    throw new StoneTextureGateError(
      'decode-failed',
      `贴图解码失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const { width, height, rgba } = decoded;
  if (width > limits.maxEdgePx || height > limits.maxEdgePx) {
    throw new StoneTextureGateError('edge-over-limit', `贴图边长超上限（${width}×${height} > ${limits.maxEdgePx}px）`, {
      width,
      height,
      limit: limits.maxEdgePx,
    });
  }
  if (width * height > limits.maxPixels) {
    throw new StoneTextureGateError('pixels-over-limit', `贴图像素总量超上限（${width * height} > ${limits.maxPixels}）`, {
      pixels: width * height,
      limit: limits.maxPixels,
    });
  }
  if (width !== input.declaredWidth || height !== input.declaredHeight) {
    throw new StoneTextureGateError(
      'dimension-mismatch',
      `声明宽高 ${input.declaredWidth}×${input.declaredHeight} 与解码实测 ${width}×${height} 不符`,
      { declaredWidth: input.declaredWidth, declaredHeight: input.declaredHeight, width, height },
    );
  }
  const bounds = alphaBoundsOf(width, height, rgba);
  if (bounds === null) {
    throw new StoneTextureGateError('fully-transparent', '贴图全透明（alpha 内容 bounds 为空）', {
      width,
      height,
    });
  }
  const shapeClass = input.shapeClass ?? 'round';
  const subjectMajorPx = Math.max(bounds.w, bounds.h);
  const subjectMinorPx = Math.min(bounds.w, bounds.h);
  const subjectAspect = subjectMajorPx / subjectMinorPx;
  if (ONE_TO_ONE_SHAPE_CLASSES.has(shapeClass) && subjectAspect > 1 + limits.aspectTolerance) {
    throw new StoneTextureGateError(
      'aspect-drift',
      `主径纵横比 ${subjectAspect.toFixed(3)} 超出 ${shapeClass} 期望 1:1 容差（≤${(1 + limits.aspectTolerance).toFixed(2)}）——比例漂移即物理尺寸谎言`,
      { aspect: Math.round(subjectAspect * 1000) / 1000, tolerance: limits.aspectTolerance, shapeClass },
    );
  }
  if (subjectMajorPx < limits.minSubjectPx) {
    throw new StoneTextureGateError(
      'resolution-too-low',
      `alpha bounds 主径 ${subjectMajorPx}px 低于绝对下限 ${limits.minSubjectPx}px`,
      { subjectMajorPx, limit: limits.minSubjectPx },
    );
  }
  const sizeMm = input.sizeMm ?? null;
  const meetsRecommendedPxPerMm =
    sizeMm === null ? null : subjectMajorPx / sizeMm >= limits.recommendedPxPerMm;
  return {
    width,
    height,
    alphaBounds: bounds,
    subjectMajorPx,
    subjectAspect,
    meetsRecommendedPxPerMm,
  };
}

/** alpha>0 像素最小包围盒（无内容像素=null）。 */
function alphaBoundsOf(
  width: number,
  height: number,
  rgba: Uint8Array,
): { x: number; y: number; w: number; h: number } | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3]!;
      if (alpha > ALPHA_CONTENT_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
