/**
 * stone→引擎 adapter 纯函数契约（add-stone-library design §10——S0.3 冻结）。
 * 原始需求 2026-09-24（引擎零改动红线：stone 一切引擎消费经本 adapter，引擎不
 * import stone 契约；**接口交付，内核消费归 add-subject-sam-pipeline P 任务**）。
 * 与 design §10 字面的两处偏差（§8.1 规则 7 落地，报告已列）：
 *   [1] specOfStone 返回值包 result union——sizeMm 可 null（无物理尺寸声明），
 *       排钻无尺寸依据={ok:false, reason:'size-unspecified'} 显式态，不猜测。
 *   [2] paletteColorOfStone 的 id=stone.id 原值（§1.3 规定 stone.id 已是 'stn-'+uuid；
 *       照 §10 字面 `stn-${stone.id}` 会产生 'stn-stn-' 双前缀，取其命名空间意图）。
 * 正交意图：[1] BaseSpec 投影；[2] 调色板色投影；[3] 贴图渲染源（PNG 头解析+dataUrl）。
 */
import type { StoneFile } from './stones.js';

/** stone→BaseSpec（排布间距）：sizeMm 是唯一物理依据（diameterMm→gridFromSpec pitch）。 */
export interface StoneSpec {
  /** 'custom' 当且仅当 gemshapeRef 存在；否则 'round'+sizeMm 圆包络 */
  shapeId: 'round' | 'custom';
  diameterMm: number;
  /** shapeId='custom' 时的资产弱引用（=gemshapeRef） */
  assetId?: string;
}

export type SpecOfStoneResult =
  | { ok: true; spec: StoneSpec }
  | { ok: false; reason: 'size-unspecified' };

/**
 * 排布间距投影（design §10 签名一）。custom 分支的直径仍取 sizeMm——pitch=
 * diameterMm+gap 的圆包络语义对 custom 形同样成立（requiredCenterDistancePx）。
 */
export function specOfStone(stone: StoneFile): SpecOfStoneResult {
  if (stone.sizeMm === null) return { ok: false, reason: 'size-unspecified' };
  const diameterMm = stone.sizeMm;
  if (stone.gemshapeRef === undefined) return { ok: true, spec: { shapeId: 'round', diameterMm } };
  return { ok: true, spec: { shapeId: 'custom', diameterMm, assetId: stone.gemshapeRef } };
}

/** 调色板色（design §10 签名二：mapColors 最近邻换算直接可用）。 */
export interface StonePaletteColor {
  /** 'stn-'+uuid（stone.id 原值——palette id 命名空间与其它色板源不冲突） */
  id: string;
  name: string;
  /** '#RRGGBB' 大写 */
  hex: string;
}

/** rgb→'#RRGGBB'（大写；stone_index.color_hex / 引擎 palette hex 同形）。 */
export function rgbToHex(rgb: readonly [number, number, number]): string {
  const channel = (c: number) => c.toString(16).padStart(2, '0').toUpperCase();
  return `#${channel(rgb[0])}${channel(rgb[1])}${channel(rgb[2])}`;
}

/** 调色板投影：颜色身份=stone.color（name 取色名——palette 按色分组的心智）。 */
export function paletteColorOfStone(stone: StoneFile): StonePaletteColor {
  return { id: stone.id, name: stone.color.name, hex: rgbToHex(stone.color.rgb) };
}

// ---------------------------------------------------------------- 贴图渲染源

/** 渲染源（形态与 daemon shape-assets assetResolverOf 产物同构——ShapeAssetSource.image）。 */
export interface StoneTextureSource {
  mime: 'image/png';
  dataUrl: string;
  width: number;
  height: number;
}

export type ResolveStoneTextureResult =
  | { ok: true; texture: StoneTextureSource }
  | { ok: false; reason: 'not-png' | 'truncated' | 'bad-dimensions' };

/** PNG 签名（8 字节）。 */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

const B64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 纯 base64 编码（双端可用——不依赖 Buffer/btoa，独立可发布纪律）。 */
export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : null;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : null;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 !== null ? B64_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] : '=';
    out += b2 !== null ? B64_ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

/**
 * 贴图→渲染源（design §10 签名三：buildSvg <image> / renderGemsPng resolveAsset 消费）。
 * 纯函数：仅做 PNG 头（IHDR）级解析取宽高+dataUrl 组装；像素级六条 gate（实测
 * 宽高对账/上限/alpha bounds/fit/分辨率/missing——§1.4）是 daemon 入库职责，不在此重复。
 * typed error：签名不符/首块非 IHDR→not-png；不足 24 字节读不出 IHDR→truncated；
 * 宽高为 0（PNG 规格非法）→bad-dimensions。
 */
export function resolveStoneTexture(textureBytes: Uint8Array): ResolveStoneTextureResult {
  if (textureBytes.length < 24) return { ok: false, reason: 'truncated' };
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (textureBytes[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: 'not-png' };
  }
  // 首 chunk 必须是 IHDR（PNG 规格固定布局：8 签名 + 4 长度 + 4 类型）
  const ihdr =
    textureBytes[12] === 0x49 &&
    textureBytes[13] === 0x48 &&
    textureBytes[14] === 0x44 &&
    textureBytes[15] === 0x52;
  if (!ihdr) return { ok: false, reason: 'not-png' };
  const width = (textureBytes[16] << 24) | (textureBytes[17] << 16) | (textureBytes[18] << 8) | textureBytes[19];
  const height = (textureBytes[20] << 24) | (textureBytes[21] << 16) | (textureBytes[22] << 8) | textureBytes[23];
  if (width <= 0 || height <= 0) return { ok: false, reason: 'bad-dimensions' };
  return {
    ok: true,
    texture: {
      mime: 'image/png',
      dataUrl: `data:image/png;base64,${base64Encode(textureBytes)}`,
      width,
      height,
    },
  };
}
