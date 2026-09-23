/**
 * Node 纯 TS 软光栅（design §6.3 R2/R3 冻结——W2.3）。
 * 原始需求 2026-09-23：服务端 PNG 无 document/Canvas/IndexedDB——builtin 五形参数化
 * 几何路径光栅（含 rotationDeg 与透明背景）+ custom 经 assetId 取 .gemshape 资产解析。
 * 几何语义对齐 engine/export.ts SVG 导出（圆走 analytic AA 快路径；异形 vectorPath
 * 按单位框 × s×s 方盒缩放——「产物与 SVG/BOM 形状预期一致」，禁静默画圆）。
 * 两类错误分别冻结（R3/R4）：custom 缺 assetId=CustomAssetIdMissingError（引擎类
 * 直用——身份缺失 typed invalid）；assetId 存在但资产未解析/不可用=PngAssetUnresolvedError
 * （独立错误码 PNG_ASSET_UNRESOLVED——语义对应 exportGate missing-asset 但不复用同一
 * 错误对象）。均显式抛出，禁静默降级画圆。
 * 正交意图：
 *   [1] 形状面：builtin 五形路径表（engine catalog SEED_VECTOR_PATHS 同源镜像——
 *       designer gemVisual 同款「域本地表不触 engine 冻结面」模式）+ SVG path 解析
 *       （M/L/H/V/C/S/Q/T/Z 绝对/相对）+ bezier 展平。
 *   [2] 光栅面：圆 analytic AA；多边形 4×4 超采样覆盖填充；custom 贴图最近邻采样
 *       （逆旋转映射）+ PNG dataUrl 解码。
 *   [3] 错误面：两类 typed error（见上）。
 */
import {
  CustomAssetIdMissingError,
  findPaletteColor,
  gemRadiusPx,
  type Gem,
  type GridSpec,
  type Palette,
} from 'rhinestone-studio/engine';
import { decodePng, encodePng } from './codec.js';

// ---------------------------------------------------------------- 两类 typed error

export const PNG_ASSET_UNRESOLVED = 'PNG_ASSET_UNRESOLVED';

/** assetId 存在但资产字节未解析/不可用（custom 形渲染的独立错误码——design §6.3 R3）。 */
export class PngAssetUnresolvedError extends Error {
  readonly code = PNG_ASSET_UNRESOLVED;
  constructor(
    public readonly assetId: string,
    public readonly reason: string,
  ) {
    super(`钻形资产 ${assetId} 未解析（PNG_ASSET_UNRESOLVED）：${reason}——不静默降级画圆。`);
    this.name = 'PngAssetUnresolvedError';
  }
}

// ---------------------------------------------------------------- 形状面

/**
 * builtin 五形归一化矢量轮廓（单位框 0..1）。镜像自 engine catalog SEED_VECTOR_PATHS
 * （私有常量不出 barrel；designer gemVisual FALLBACK_SHAPE_PATHS 同款镜像模式——
 * 控制点与 engine 同源，测试以字面量断言防漂移）。
 */
const BUILTIN_PATHS: Record<string, string> = {
  round:
    'M 0.5 0.02 C 0.7651 0.02 0.98 0.2349 0.98 0.5 C 0.98 0.7651 0.7651 0.98 0.5 0.98 C 0.2349 0.98 0.02 0.7651 0.02 0.5 C 0.02 0.2349 0.2349 0.02 0.5 0.02 Z',
  square: 'M 0.02 0.02 L 0.98 0.02 L 0.98 0.98 L 0.02 0.98 Z',
  drop:
    'M 0.5 0.02 C 0.74 0.26 0.98 0.46 0.98 0.68 C 0.98 0.85 0.76 0.98 0.5 0.98 C 0.24 0.98 0.02 0.85 0.02 0.68 C 0.02 0.46 0.26 0.26 0.5 0.02 Z',
  heart:
    'M 0.5 0.98 C 0.14 0.72 0.02 0.5 0.02 0.32 C 0.02 0.14 0.16 0.02 0.3 0.02 C 0.4 0.02 0.47 0.08 0.5 0.16 C 0.53 0.08 0.6 0.02 0.7 0.02 C 0.84 0.02 0.98 0.14 0.98 0.32 C 0.98 0.5 0.86 0.72 0.5 0.98 Z',
  marquise:
    'M 0.5 0.02 C 0.78 0.22 0.98 0.38 0.98 0.5 C 0.98 0.62 0.78 0.78 0.5 0.98 C 0.22 0.78 0.02 0.62 0.02 0.5 C 0.02 0.38 0.22 0.22 0.5 0.02 Z',
};

export type PathCommand =
  | { t: 'M'; x: number; y: number }
  | { t: 'L'; x: number; y: number }
  | { t: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { t: 'Q'; x1: number; y1: number; x: number; y: number }
  | { t: 'Z' };

/** SVG path 子集解析（M/L/H/V/C/S/Q/T/Z；绝对/相对——.gemshape vectorPath 校验同集）。 */
export function parseSvgPath(text: string): PathCommand[] {
  const tokens = text.match(/[MmLlHhVvCcSsQqTtZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g);
  if (tokens === null) throw new Error('SVG path 无有效记号');
  const commands: PathCommand[] = [];
  let index = 0;
  let cx = 0;
  let cy = 0;
  let lastCtrl: { x: number; y: number } | null = null;
  const num = (): number => Number(tokens[index++]);
  while (index < tokens.length) {
    const token = tokens[index++]!;
    const upper = token.toUpperCase();
    const absolute = token === upper;
    const rel = (x: number, y: number): [number, number] =>
      absolute ? [x, y] : [cx + x, cy + y];
    switch (upper) {
      case 'M': {
        const [x, y] = rel(num(), num());
        commands.push({ t: 'M', x, y });
        cx = x;
        cy = y;
        lastCtrl = null;
        break;
      }
      case 'L': {
        const [x, y] = rel(num(), num());
        commands.push({ t: 'L', x, y });
        cx = x;
        cy = y;
        lastCtrl = null;
        break;
      }
      case 'H': {
        const v = num();
        cx = absolute ? v : cx + v;
        commands.push({ t: 'L', x: cx, y: cy });
        lastCtrl = null;
        break;
      }
      case 'V': {
        const v = num();
        cy = absolute ? v : cy + v;
        commands.push({ t: 'L', x: cx, y: cy });
        lastCtrl = null;
        break;
      }
      case 'C': {
        const [x1, y1] = rel(num(), num());
        const [x2, y2] = rel(num(), num());
        const [x, y] = rel(num(), num());
        commands.push({ t: 'C', x1, y1, x2, y2, x, y });
        lastCtrl = { x: x2, y: y2 };
        cx = x;
        cy = y;
        break;
      }
      case 'S': {
        const [x2, y2] = rel(num(), num());
        const [x, y] = rel(num(), num());
        const prev: { x: number; y: number } | null = lastCtrl;
        const rx1: number = prev !== null ? 2 * cx - prev.x : cx;
        const ry1: number = prev !== null ? 2 * cy - prev.y : cy;
        commands.push({ t: 'C', x1: rx1, y1: ry1, x2, y2, x, y });
        lastCtrl = { x: x2, y: y2 };
        cx = x;
        cy = y;
        break;
      }
      case 'Q': {
        const [x1, y1] = rel(num(), num());
        const [x, y] = rel(num(), num());
        commands.push({ t: 'Q', x1, y1, x, y });
        lastCtrl = { x: x1, y: y1 };
        cx = x;
        cy = y;
        break;
      }
      case 'T': {
        const [x, y] = rel(num(), num());
        const prev: { x: number; y: number } | null = lastCtrl;
        const rx1: number = prev !== null ? 2 * cx - prev.x : cx;
        const ry1: number = prev !== null ? 2 * cy - prev.y : cy;
        commands.push({ t: 'Q', x1: rx1, y1: ry1, x, y });
        lastCtrl = { x: rx1, y: ry1 };
        cx = x;
        cy = y;
        break;
      }
      case 'Z': {
        commands.push({ t: 'Z' });
        lastCtrl = null;
        break;
      }
      default:
        throw new Error(`SVG path 不支持命令：${token}`);
    }
  }
  return commands;
}

/** 命令展平为多边形顶点（单位框坐标；bezier 定步长细分 24/16 段）。 */
export function flattenPath(commands: PathCommand[], steps = 24): [number, number][] {
  const points: [number, number][] = [];
  let start: [number, number] | null = null;
  let cur: [number, number] | null = null;
  const push = (p: [number, number]) => {
    points.push(p);
    cur = p;
  };
  for (const cmd of commands) {
    if (cmd.t === 'Z') {
      if (start && cur && (cur[0] !== start[0] || cur[1] !== start[1])) push([start[0], start[1]]);
      continue;
    }
    if (cmd.t === 'M') {
      if (start === null) start = [cmd.x, cmd.y];
      push([cmd.x, cmd.y]);
      continue;
    }
    if (cmd.t === 'L') {
      push([cmd.x, cmd.y]);
      continue;
    }
    const from = cur ?? [0, 0];
    if (cmd.t === 'C') {
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const mt = 1 - t;
        push([
          mt * mt * mt * from[0] + 3 * mt * mt * t * cmd.x1 + 3 * mt * t * t * cmd.x2 + t * t * t * cmd.x,
          mt * mt * mt * from[1] + 3 * mt * mt * t * cmd.y1 + 3 * mt * t * t * cmd.y2 + t * t * t * cmd.y,
        ]);
      }
      continue;
    }
    // Q
    for (let i = 1; i <= 16; i++) {
      const t = i / 16;
      const mt = 1 - t;
      push([
        mt * mt * from[0] + 2 * mt * t * cmd.x1 + t * t * cmd.x,
        mt * mt * from[1] + 2 * mt * t * cmd.y1 + t * t * cmd.y,
      ]);
    }
  }
  return points;
}

// ---------------------------------------------------------------- 资产解析面

/** custom 形资产（.gemshape 解析产物——调用方从 BlobStore 取字节解析后注入）。 */
export interface PngShapeAsset {
  /** 归一化 SVG path（单位框 0..1）——并存时矢量优先（与 export.ts 同序）。 */
  vectorPath?: string;
  /** 贴图 dataUrl（仅 image/png 可解码；jpeg/webp=PNG_ASSET_UNRESOLVED）。 */
  image?: { mime: string; dataUrl: string; width: number; height: number };
}

export type ResolveShapeAsset = (assetId: string) => PngShapeAsset | null;

// ---------------------------------------------------------------- 渲染

export interface RenderGemsInput {
  gems: Gem[];
  palette: Palette;
  grid: GridSpec;
  width: number;
  height: number;
  /** custom 资产解析（缺席时任何 custom 钻=PngAssetUnresolvedError——不静默）。 */
  resolveAsset?: ResolveShapeAsset;
}

const SS = 4; // 超采样倍率（4×4=16 子像素/像素）
const FALLBACK_RGB: [number, number, number] = [0x9c, 0xaf, 0xaf]; // #9CA3AF（export.ts 同款占位色）

function hexToRgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/** 钻集 → RGBA 平面（透明背景；逐钻按色填充）。 */
export function renderGemsRgba(input: RenderGemsInput): Uint8Array {
  const { gems, palette, grid, width: W, height: H } = input;
  const rgba = new Uint8Array(W * H * 4); // 全 0=全透明背景
  const coverage = new Float32Array(W * H);
  const colorPlane = new Uint8Array(W * H * 3); // 覆盖像素的填充色（最近写入）

  for (const gem of gems) {
    const entry = findPaletteColor(palette, gem.colorId);
    const rgb = entry ? hexToRgb(entry.hex) : FALLBACK_RGB;
    const cx = gem.x + 0.5; // SVG 栅格空间同口径（export.ts renderGem）
    const cy = gem.y + 0.5;
    const rotation = ((gem.rotationDeg ?? 0) * Math.PI) / 180;

    if (gem.shapeId === 'round') {
      // 圆快路径：analytic AA（export.ts circle 同径 gemRadiusPx）
      const r = gemRadiusPx(gem, grid);
      drawCircleAA(coverage, colorPlane, rgb, cx, cy, r, W, H);
      continue;
    }

    const s = gem.diameterMm * grid.pixelsPerMm; // 方盒边长（export.ts path scale 同口径）
    const polygon = shapePolygonOf(gem, input.resolveAsset);
    if (polygon === 'texture') {
      drawTexture(rgba, gem.assetId!, input.resolveAsset!(gem.assetId!)!, cx, cy, s, rotation, W, H);
      continue;
    }
    // 多边形：缩放到 s×s 方盒（单位框 -0.5..0.5 → ±s/2）+ 旋转
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const pts: [number, number][] = polygon.map(([u, v]) => {
      const lx = (u - 0.5) * s;
      const ly = (v - 0.5) * s;
      return [cx + lx * cos - ly * sin, cy + lx * sin + ly * cos];
    });
    drawPolygonSS(coverage, colorPlane, rgb, pts, W, H);
  }

  // 覆盖平面 → RGBA（source-over 合成；coverage 乘 alpha 通道）
  for (let p = 0; p < W * H; p++) {
    const cov = coverage[p];
    if (cov <= 0) continue;
    const alpha = Math.min(1, cov);
    const d = p * 4;
    rgba[d] = colorPlane[p * 3]!;
    rgba[d + 1] = colorPlane[p * 3 + 1]!;
    rgba[d + 2] = colorPlane[p * 3 + 2]!;
    rgba[d + 3] = Math.round(alpha * 255);
  }
  return rgba;
}

/** PNG 字节（renderGemsRgba + encodePng 组合面）。 */
export function renderGemsPng(input: RenderGemsInput): Uint8Array {
  const rgba = renderGemsRgba(input);
  return encodePng(input.width, input.height, rgba);
}

// ---------------------------------------------------------------- 内部：形状分派

/** 多边形顶点（单位框）；贴图形返回 'texture' 哨兵。 */
function shapePolygonOf(
  gem: Gem,
  resolveAsset: ResolveShapeAsset | undefined,
): [number, number][] | 'texture' {
  if (gem.shapeId === 'custom') {
    const asset = requireAsset(gem, resolveAsset);
    if (asset.vectorPath !== undefined) {
      return flattenPath(parseSvgPath(asset.vectorPath));
    }
    return 'texture';
  }
  const path = BUILTIN_PATHS[gem.shapeId];
  if (path === undefined) {
    // 未知形（非 SHAPE_IDS）——engine schema 已挡；防御性显式拒绝
    throw new Error(`未知形状：${gem.shapeId}`);
  }
  return flattenPath(parseSvgPath(path));
}

/** custom 资产取用：缺 assetId=CustomAssetIdMissingError；未解析=PngAssetUnresolvedError。 */
function requireAsset(
  gem: Gem,
  resolveAsset: ResolveShapeAsset | undefined,
): PngShapeAsset {
  if (gem.assetId === undefined || gem.assetId === '') {
    // 引擎 typed invalid 类直用（design §6.3：对齐 CustomAssetIdMissingError 语义）
    throw new CustomAssetIdMissingError('daemon png render');
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

// ---------------------------------------------------------------- 内部：光栅

/** 圆 analytic AA：alpha = clamp(r + 0.5 - dist, 0, 1)（像素中心采样）。 */
function drawCircleAA(
  coverage: Float32Array,
  colorPlane: Uint8Array,
  rgb: [number, number, number],
  cx: number,
  cy: number,
  r: number,
  W: number,
  H: number,
): void {
  if (!(r > 0)) return;
  const x0 = Math.max(0, Math.floor(cx - r - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + r + 1));
  const y0 = Math.max(0, Math.floor(cy - r - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + r + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const alpha = Math.max(0, Math.min(1, r + 0.5 - dist));
      if (alpha <= 0) continue;
      const p = y * W + x;
      coverage[p] = Math.max(coverage[p]!, alpha);
      colorPlane[p * 3] = rgb[0];
      colorPlane[p * 3 + 1] = rgb[1];
      colorPlane[p * 3 + 2] = rgb[2];
    }
  }
}

/** 多边形 4×4 超采样：子像素扫描线（even-odd 交叉计数），每命中 +1/16 覆盖。 */
function drawPolygonSS(
  coverage: Float32Array,
  colorPlane: Uint8Array,
  rgb: [number, number, number],
  pts: [number, number][],
  W: number,
  H: number,
): void {
  if (pts.length < 3) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const px0 = Math.max(0, Math.floor(minX - 1));
  const px1 = Math.min(W - 1, Math.ceil(maxX + 1));
  const py0 = Math.max(0, Math.floor(minY - 1));
  const py1 = Math.min(H - 1, Math.ceil(maxY + 1));
  if (px1 < px0 || py1 < py0) return;
  const bw = px1 - px0 + 1;
  const hits = new Uint8Array(bw * (py1 - py0 + 1)); // 0..16 子像素命中计数
  const step = 1 / SS;
  for (let sy = 0; sy < SS; sy++) {
    for (let sx = 0; sx < SS; sx++) {
      // 每子采样层一条扫描线族：逐边 even-odd 交叉 → 命中像素 +1
      for (let py = py0; py <= py1; py++) {
        const yLine = py + (sy + 0.5) * step;
        const xs: number[] = [];
        for (let i = 0; i < pts.length; i++) {
          const [ax, ay] = pts[i]!;
          const [bx, by] = pts[(i + 1) % pts.length]!;
          if (ay === by) continue;
          if (yLine >= Math.min(ay, by) && yLine < Math.max(ay, by)) {
            xs.push(ax + ((yLine - ay) / (by - ay)) * (bx - ax));
          }
        }
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const spanX0 = xs[k]!;
          const spanX1 = xs[k + 1]!;
          for (let px = px0; px <= px1; px++) {
            const xSub = px + (sx + 0.5) * step;
            if (xSub >= spanX0 && xSub < spanX1) {
              hits[(py - py0) * bw + (px - px0)]! += 1;
            }
          }
        }
      }
    }
  }
  for (let py = py0; py <= py1; py++) {
    for (let px = px0; px <= px1; px++) {
      const count = hits[(py - py0) * bw + (px - px0)]!;
      if (count === 0) continue;
      const p = py * W + px;
      coverage[p] = Math.max(coverage[p]!, count / (SS * SS));
      colorPlane[p * 3] = rgb[0];
      colorPlane[p * 3 + 1] = rgb[1];
      colorPlane[p * 3 + 2] = rgb[2];
    }
  }
}

/** custom 贴图：逆旋转最近邻采样，s×s 方盒（alpha=贴图 alpha；PNG dataUrl 解码）。 */
function drawTexture(
  rgba: Uint8Array,
  assetId: string,
  asset: PngShapeAsset,
  cx: number,
  cy: number,
  s: number,
  rotation: number,
  W: number,
  H: number,
): void {
  const image = asset.image!;
  if (image.mime !== 'image/png') {
    throw new PngAssetUnresolvedError(
      assetId,
      `贴图 MIME ${image.mime} 无纯 TS 解码器（仅 image/png）`,
    );
  }
  const base64 = /^data:image\/png;base64,(.+)$/.exec(image.dataUrl)?.[1];
  if (base64 === undefined) {
    throw new PngAssetUnresolvedError(assetId, '贴图 dataUrl 形态不合法（非 base64 PNG）');
  }
  let decoded;
  try {
    decoded = decodePng(Buffer.from(base64, 'base64'));
  } catch (error) {
    throw new PngAssetUnresolvedError(
      assetId,
      `贴图解码失败（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const { width: tw, height: th, rgba: trgba } = decoded;
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);
  const x0 = Math.max(0, Math.floor(cx - s / 2 - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + s / 2 + 1));
  const y0 = Math.max(0, Math.floor(cy - s / 2 - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + s / 2 + 1));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      // 逆旋转到方盒局部坐标
      const lx = dx * cos - dy * sin;
      const ly = dx * sin + dy * cos;
      const u = (lx / s + 0.5) * tw;
      const v = (ly / s + 0.5) * th;
      if (u < 0 || v < 0 || u >= tw || v >= th) continue;
      const sp = (Math.floor(v) * tw + Math.floor(u)) * 4;
      const sa = trgba[sp + 3]! / 255;
      if (sa <= 0) continue;
      const d = (y * W + x) * 4;
      // source-over 合成（贴图覆盖已有覆盖层——custom 形无色板填充）
      const da = rgba[d + 3]! / 255;
      const outA = sa + da * (1 - sa);
      if (outA <= 0) continue;
      rgba[d] = Math.round((trgba[sp]! * sa + rgba[d]! * da * (1 - sa)) / outA);
      rgba[d + 1] = Math.round((trgba[sp + 1]! * sa + rgba[d + 1]! * da * (1 - sa)) / outA);
      rgba[d + 2] = Math.round((trgba[sp + 2]! * sa + rgba[d + 2]! * da * (1 - sa)) / outA);
      rgba[d + 3] = Math.round(outA * 255);
    }
  }
}
