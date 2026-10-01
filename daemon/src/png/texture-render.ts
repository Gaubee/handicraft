/**
 * 任务导出效果图贴图合成渲染器（2026-10-02——Owner 拷问「最终渲染是拿了钻去渲染
 * 还是只是挖了孔」的升级答案）。导出三件套分工（产品口径）：
 *   render.png=**效果图**（客户确认/报价——本模块：用钻的真实贴图按位渲染成品效果）；
 *   SVG=生产定位（矢量圆点+stoneRef 元数据——engine buildSvg 现状不动）；BOM 不变。
 *
 * 管线（2× 超采样抗锯齿——任务简报冻结口径）：
 *   [1] 逐钻解析贴图源：builtin 形按 stoneRef 取钻库贴图 blob（StoneService 投影，
 *       调用方注入 resolver）；custom 形按 .gemshape 资产 image dataUrl（现状 asset
 *       解析面）。贴图解码按 **blobRef 内容寻址缓存**（同贴图多钻复用解码结果）。
 *   [2] 2× 超采样平面：降级色点底层=renderGemsRgba 复用（几何×2 重投影——圆 analytic
 *       AA/多边形 4×4 覆盖，降级渲染与圆点版完全同源）；贴图钻=双线性（预乘插值，
 *       软边无光晕）逆旋转映射 source-over 合成。
 *   [3] 2×2 预乘 box 降采样回目标分辨率（ppm×画布）→ encodePng（纯 TS 非隔行）。
 *
 * 贴图几何口径（对齐前端精修视图 gemSprites contentBoxOf——画布 drawImage 按位先例）：
 *   - 钻库贴图：alpha 内容 bounds（stone.json texture.alphaBounds——导入时解码实测）
 *     的主径 → 钻盒 s=diameterMm×ppm，纵横比保持（异形窄边 < 直径），主体居中。
 *   - custom 资产贴图：全画布 → s×s 方盒（render.ts drawTexture 现状口径）。
 *   - 旋转：rotationDeg 逆旋转映射（render.ts drawTexture 同式）。
 *
 * 降级与错误面（不静默）：
 *   - 贴图缺失（pending 款/软删/引用不可达——resolver 返 null）＝降级 colorHex 色点
 *     +missingStoneRefs 明示（调用方转「N 颗用色点占位（贴图缺失款）」warnings）。
 *   - 贴图解码失败（含隔行 Adam7——导入管线 gateStoneTexture 已保证入库贴图非隔行，
 *     命中即数据腐蚀）＝同为降级色点+undecodableStoneRefs 明示。
 *   - custom 缺 assetId=CustomAssetIdMissingError；资产未解析/非 PNG=PngAssetUnresolvedError
 *     （render.ts 既有 typed 纪律——exportGate missing-asset 门在前，理论不可达）。
 */
import {
  CustomAssetIdMissingError,
  type Gem,
  type GridSpec,
  type Palette,
} from 'rhinestone-studio/engine';
import { decodePng, encodePng, type DecodedPng } from './codec.js';
import { renderGemsRgba, PngAssetUnresolvedError, type PngShapeAsset, type ResolveShapeAsset } from './render.js';

// ---------------------------------------------------------------- 输入/输出面

/** 钻库贴图字节源（resolver 产物——blobRef 为解码缓存键）。 */
export interface StoneTextureBytes {
  /** 内容寻址引用（同贴图多钻只解码一次）。 */
  blobRef: string;
  bytes: Uint8Array;
  /** alpha 内容 bounds（stone.json texture.alphaBounds——主径/纵横比换算源；缺省全画布）。 */
  alphaBounds?: { x: number; y: number; w: number; h: number };
}

export type ResolveStoneTexture = (stoneRef: string) => StoneTextureBytes | null;

export interface RenderGemsTextureInput {
  gems: Gem[];
  palette: Palette;
  grid: GridSpec;
  width: number;
  height: number;
  /** builtin 形钻库贴图解析（null=贴图缺失——降级色点）。 */
  resolveStoneTexture: ResolveStoneTexture;
  /** custom 形 .gemshape 资产解析（缺省时任何 custom 钻=PngAssetUnresolvedError）。 */
  resolveAsset?: ResolveShapeAsset;
  /** 解码 miss 观测面（测试/诊断——每次真实解码（缓存未命中）回调一次）。 */
  onTextureDecode?: (cacheKey: string) => void;
}

export interface RenderGemsTextureResult {
  png: Uint8Array;
  /** 贴图渲染颗数（钻库贴图+custom 资产贴图）。 */
  texturedCount: number;
  /** 降级色点颗数（贴图缺失+解码失败——custom vectorPath 几何渲染不计）。 */
  fallbackCount: number;
  /** 贴图缺失降级颗数（missingStoneRefs 口径的 gem 计数）。 */
  fallbackMissingCount: number;
  /** 贴图解码失败降级颗数（undecodableStoneRefs 口径的 gem 计数）。 */
  fallbackUndecodableCount: number;
  /** 贴图缺失款 stoneRef（字典序——warnings 面）。 */
  missingStoneRefs: string[];
  /** 贴图解码失败款 stoneRef（字典序——warnings 面）。 */
  undecodableStoneRefs: string[];
}

// ---------------------------------------------------------------- 常量

/** 超采样倍率（2×——任务简报冻结：2x 超采样后缩回目标分辨率）。 */
const SS = 2;
/** 纵横比护栏（前端 gemSprites contentBoxOf 同值——异常贴图不放大畸变）。 */
const ASPECT_MIN = 0.1;
const ASPECT_MAX = 10;

// ---------------------------------------------------------------- 主函数

interface TexturedPlacement {
  gem: Gem;
  decoded: DecodedPng;
  /** 采样源矩形（alpha bounds 或全画布——纹理空间）。 */
  src: { x: number; y: number; w: number; h: number };
  /** 内容盒（SS 平面 px——纵横比保持，主径=s×SS）。 */
  boxW: number;
  boxH: number;
}

export function renderGemsTexturePng(input: RenderGemsTextureInput): RenderGemsTextureResult {
  const { gems, palette, grid, width: W, height: H } = input;
  const W2 = W * SS;
  const H2 = H * SS;
  const decodeCache = new Map<string, DecodedPng>();
  const missingRefs = new Set<string>();
  const undecodableRefs = new Set<string>();
  let missingCount = 0;
  let undecodableCount = 0;
  const placements: TexturedPlacement[] = [];
  const fallbackGems: Gem[] = [];

  const decodeCached = (cacheKey: string, bytes: Uint8Array): DecodedPng | null => {
    const hit = decodeCache.get(cacheKey);
    if (hit !== undefined) return hit;
    let decoded: DecodedPng;
    try {
      decoded = decodePng(bytes);
    } catch {
      return null; // 调用方按 undecodable 降级（含隔行/截断/色型不支持）
    }
    decodeCache.set(cacheKey, decoded);
    input.onTextureDecode?.(cacheKey);
    return decoded;
  };

  for (const gem of gems) {
    // —— custom 形：.gemshape 资产（image 贴图 / vectorPath 几何——现状分派）。
    if (gem.shapeId === 'custom') {
      const asset = requireAsset(gem, input.resolveAsset);
      if (asset.image !== undefined) {
        if (asset.image.mime !== 'image/png') {
          throw new PngAssetUnresolvedError(gem.assetId!, `贴图 MIME ${asset.image.mime} 无纯 TS 解码器（仅 image/png）`);
        }
        const base64 = /^data:image\/png;base64,(.+)$/.exec(asset.image.dataUrl)?.[1];
        if (base64 === undefined) {
          throw new PngAssetUnresolvedError(gem.assetId!, '贴图 dataUrl 形态不合法（非 base64 PNG）');
        }
        // 缓存键=assetId（shapeAssets 内 assetId→blobRef 单射——blobRef 语义等价）。
        const decoded = decodeCached(`asset:${gem.assetId!}`, Buffer.from(base64, 'base64'));
        if (decoded === null) {
          throw new PngAssetUnresolvedError(gem.assetId!, '贴图解码失败（dataUrl 字节非合法非隔行 PNG）');
        }
        const s = gem.diameterMm * grid.pixelsPerMm * SS;
        placements.push({ gem, decoded, src: { x: 0, y: 0, w: decoded.width, h: decoded.height }, boxW: s, boxH: s });
        continue;
      }
      fallbackGems.push(gem); // vectorPath 几何渲染（renderGemsRgba 现状色面——非缺图降级）
      continue;
    }
    // —— builtin 形：钻库贴图（缺图/解码失败=色点降级+明示）。
    const source = input.resolveStoneTexture(gem.colorId);
    if (source === null) {
      missingRefs.add(gem.colorId);
      missingCount += 1;
      fallbackGems.push(gem);
      continue;
    }
    const decoded = decodeCached(`blob:${source.blobRef}`, source.bytes);
    if (decoded === null) {
      undecodableRefs.add(gem.colorId);
      undecodableCount += 1;
      fallbackGems.push(gem);
      continue;
    }
    const bounds = source.alphaBounds ?? { x: 0, y: 0, w: decoded.width, h: decoded.height };
    const s = gem.diameterMm * grid.pixelsPerMm * SS; // 主径（SS 平面 px）
    const aspect = bounds.w / bounds.h;
    const safeAspect = Number.isFinite(aspect) && aspect > ASPECT_MIN && aspect < ASPECT_MAX ? aspect : 1;
    placements.push({
      gem,
      decoded,
      src: bounds,
      boxW: safeAspect >= 1 ? s : s * safeAspect,
      boxH: safeAspect >= 1 ? s / safeAspect : s,
    });
  }

  // —— 2× 平面：降级色点底层（renderGemsRgba 同源几何——坐标/栅格 ×2 重投影）。
  const plane = renderGemsRgba({
    gems: fallbackGems.map((gem) => ({ ...gem, x: gem.x * SS + 0.5, y: gem.y * SS + 0.5 })),
    palette,
    grid: { ...grid, pixelsPerMm: grid.pixelsPerMm * SS },
    width: W2,
    height: H2,
    ...(input.resolveAsset !== undefined ? { resolveAsset: input.resolveAsset } : {}),
  });

  // —— 贴图合成（降级层之上；spacing 门保证钻位不重叠，绘制序不影响结果）。
  for (const placement of placements) {
    drawRotatedTexture(plane, placement, W2, H2);
  }

  const rgba = downsample2x(plane, W, H);
  return {
    png: encodePng(W, H, rgba),
    texturedCount: placements.length,
    fallbackCount: missingCount + undecodableCount,
    fallbackMissingCount: missingCount,
    fallbackUndecodableCount: undecodableCount,
    missingStoneRefs: [...missingRefs].sort(),
    undecodableStoneRefs: [...undecodableRefs].sort(),
  };
}

// ---------------------------------------------------------------- 内部：资产取用

/** custom 资产取用（render.ts requireAsset 同纪律——typed 拒，禁静默）。 */
function requireAsset(gem: Gem, resolveAsset: ResolveShapeAsset | undefined): PngShapeAsset {
  if (gem.assetId === undefined || gem.assetId === '') {
    throw new CustomAssetIdMissingError('daemon texture render');
  }
  const asset = resolveAsset?.(gem.assetId);
  if (asset === null || asset === undefined) {
    throw new PngAssetUnresolvedError(gem.assetId, '资产不可达（未注册解析器或 blob 缺失）');
  }
  if (asset.vectorPath === undefined && asset.image === undefined) {
    throw new PngAssetUnresolvedError(gem.assetId, '资产无可渲染载荷（vectorPath/image 均缺席）');
  }
  return asset;
}

// ---------------------------------------------------------------- 内部：贴图光栅

/** 逆旋转双线性贴图绘制（SS 平面 source-over——render.ts drawTexture 同映射式）。 */
function drawRotatedTexture(
  plane: Uint8Array,
  placement: TexturedPlacement,
  W2: number,
  H2: number,
): void {
  const { gem, decoded, src, boxW, boxH } = placement;
  const cx = (gem.x + 0.5) * SS;
  const cy = (gem.y + 0.5) * SS;
  const rotation = ((gem.rotationDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const halfDiag = Math.sqrt(boxW * boxW + boxH * boxH) / 2 + 1;
  const x0 = Math.max(0, Math.floor(cx - halfDiag));
  const x1 = Math.min(W2 - 1, Math.ceil(cx + halfDiag));
  const y0 = Math.max(0, Math.floor(cy - halfDiag));
  const y1 = Math.min(H2 - 1, Math.ceil(cy + halfDiag));
  const { width: tw, height: th, rgba: trgba } = decoded;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      if (Math.abs(lx) > boxW / 2 || Math.abs(ly) > boxH / 2) continue;
      const u = src.x + (lx / boxW + 0.5) * src.w;
      const v = src.y + (ly / boxH + 0.5) * src.h;
      const [r, g, b, a255] = sampleBilinearPremultiplied(trgba, tw, th, u, v);
      if (a255 <= 0) continue;
      const sa = a255 / 255;
      const d = (y * W2 + x) * 4;
      const da = plane[d + 3]! / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      plane[d] = Math.round((r * sa + plane[d]! * da * (1 - sa)) / outA);
      plane[d + 1] = Math.round((g * sa + plane[d + 1]! * da * (1 - sa)) / outA);
      plane[d + 2] = Math.round((b * sa + plane[d + 2]! * da * (1 - sa)) / outA);
      plane[d + 3] = Math.round(outA * 255);
    }
  }
}

/** 双线性采样（预乘插值——软 alpha 边无深色光晕；返回直色 [r,g,b,a]）。 */
function sampleBilinearPremultiplied(
  rgba: Uint8Array,
  tw: number,
  th: number,
  u: number,
  v: number,
): [number, number, number, number] {
  const uc = Math.min(Math.max(u, 0), tw - 1);
  const vc = Math.min(Math.max(v, 0), th - 1);
  const x0 = Math.floor(uc);
  const y0 = Math.floor(vc);
  const x1 = Math.min(x0 + 1, tw - 1);
  const y1 = Math.min(y0 + 1, th - 1);
  const fu = uc - x0;
  const fv = vc - y0;
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pa = 0;
  for (let cy = 0; cy <= 1; cy++) {
    for (let cx = 0; cx <= 1; cx++) {
      const wx = cx === 0 ? 1 - fu : fu;
      const wy = cy === 0 ? 1 - fv : fv;
      const w = wx * wy;
      const p = ((cy === 0 ? y0 : y1) * tw + (cx === 0 ? x0 : x1)) * 4;
      const a = rgba[p + 3]! / 255;
      pr += rgba[p]! * a * w;
      pg += rgba[p + 1]! * a * w;
      pb += rgba[p + 2]! * a * w;
      pa += a * w;
    }
  }
  if (pa <= 0) return [0, 0, 0, 0];
  return [pr / pa, pg / pa, pb / pa, pa * 255];
}

/** 2×2 预乘 box 降采样（SS 平面 → 目标分辨率）。 */
function downsample2x(plane: Uint8Array, W: number, H: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  const W2 = W * SS;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let ra = 0;
      let ga = 0;
      let ba = 0;
      let aSum = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const p = ((y * SS + dy) * W2 + x * SS + dx) * 4;
          const a = plane[p + 3]!;
          if (a === 0) continue;
          ra += plane[p]! * a;
          ga += plane[p + 1]! * a;
          ba += plane[p + 2]! * a;
          aSum += a;
        }
      }
      const d = (y * W + x) * 4;
      if (aSum <= 0) continue; // 全透明（背景）
      out[d] = Math.round(ra / aSum);
      out[d + 1] = Math.round(ga / aSum);
      out[d + 2] = Math.round(ba / aSum);
      out[d + 3] = Math.round(aSum / (SS * SS));
    }
  }
  return out;
}
