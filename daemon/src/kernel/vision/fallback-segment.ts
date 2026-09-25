/**
 * 桥不可达降级=一键模式（颜色结构分块）（add-subject-sam-pipeline tasks P2.5 /
 * design §7「降级=一键模式（颜色结构分块），对齐 §6.4 哲学」——add-backend-platform
 * design §6.4：agent 面故障不殃及基础工作流）。
 * 原始需求 2026-09-25（Owner 决策源 owner-directive-20260924 + P2.5 任务简报）。
 *
 * 引擎红线纪律：**不 import 不改动** rhinestone-studio/engine——算法按 engine
 * segment.ts 的已文档范式（Lab 空间 kmeans 量化→逐色掩码→4-连通域→块属性）自实现；
 * Lab 转换用 contracts color.ts 镜像（labFromRgb——双端一致纪律）。
 *
 * 与 engine segment.ts 范式的刻意差异（保真度声明）：
 *   [1] kmeans 初始化=固定网格采样+raster 首样本起确定性 farthest-first 选心
 *       （kmeans++ 的无随机同构——色多样性与 engine 范式对齐；**不用** mulberry32
 *       随机——P2.5 简报：同图同参同树）；Lloyd 迭代固定 12 次（简报字面；engine
 *       为 30 次+收敛早停）。
 *   [2] 统计口径：effectiveMm/labVariance 在**下采样工作网格**（≤1024 边）上计算
 *       （engine 在原分辨率）——物理换算经 workingPpm 保持一致；mask/bbox 升回
 *       原始网格（tree.imagePx=原图——persistTreeWithPreview 锚点不变式）。
 *   [3] 产物=ObjectTree（根=画布 drillWorthy=false，子=色区域节点 origin=
 *       'auto-color'），非引擎 Block[]（P0.2 treeToBlocks 负责适配；等价性由测试
 *       「产物树喂 treeToBlocks」把守）。
 *
 * 正交意图：
 *   [1] fallbackSegment：PNG 解码→下采样→Lab kmeans→逐色连通域→ObjectTree（纯函数）。
 *   [2] segmentWithFallback：桥先行（注入 transport 单发 segment）→连续失败阈值 2
 *       →降级+warning{reason:'bridge-unavailable'}；取消传播；恢复探测不归本波。
 */
import {
  decodeInlineMask,
  derivePixelsPerMm,
  encodeInlineMask,
  labFromRgb,
  type CanvasCm,
  type ImagePx,
  type Lab,
  type Mask2DRef,
  type ObjectNode,
  type ObjectOrigin,
  type ObjectTree,
} from '@handicraft/contracts';
import { decodePng, PngCodecError } from '../../png/codec.js';
import {
  SamBridgeError,
  SamBridgeResponseSchema,
  type SamResponseMeta,
  type SamTextPrompt,
  type SamTransport,
} from './sam-bridge.js';
import type { ReadBlobFn } from './tree-to-blocks.js';

// ---------------------------------------------------------------- 常量冻结

/** 下采样界：工作网格最长边（px）——>1024 边缩（kmeans/连通域成本有界）。 */
export const FALLBACK_MAX_EDGE_PX = 1024;

/** kmeans 色数缺省（调用方可 k 覆写）。 */
export const FALLBACK_K_DEFAULT = 8;

/** Lloyd 迭代固定次数（确定性——不用收敛早停；P2.5 简报字面）。 */
export const FALLBACK_LLOYD_ITERATIONS = 12;

/** kmeans 网格采样上限（engine segment.ts 范式同值——≤16384 样本足够收敛）。 */
export const FALLBACK_SAMPLE_CAP = 16384;

/** 微小聚类死亡线（占比如 engine 0.2%，下限 3——噪点抑制）。 */
export const FALLBACK_MICRO_CLUSTER_RATIO = 0.002;

/** 小连通域面积下限（cm²——面积<此值弃；tasks P2.5 字面）。 */
export const FALLBACK_MIN_REGION_CM2 = 0.5;

/** 降级节点类别词（design §3 category 词表的一键模式缺省值）。 */
export const FALLBACK_CATEGORY = 'color-region';

/** 根（画布）类别词。 */
export const FALLBACK_ROOT_CATEGORY = 'canvas';

/** 桥路径单发提示缺省（design §1 S3「后续轮=宽泛语义提示」）。 */
export const DEFAULT_BRIDGE_PROMPT_TEXT = 'subject';

/** 桥连续失败降级阈值（P2.5 简报：阈值 2——单次调用内两次尝试皆败即降级）。 */
export const BRIDGE_FAILURE_THRESHOLD_DEFAULT = 2;

/** 根节点 id（BlockId 同寻址空间——ASCII 稳定，engine b{c}-{i} 风格）。 */
export const FALLBACK_ROOT_ID = 'auto-root';

// ---------------------------------------------------------------- [1] 类型面

/** 降级分割选项（canvasCm 一等输入——§1 S1）。 */
export interface FallbackSegmentOptions {
  canvasCm: CanvasCm;
  /** kmeans 色数（缺省 FALLBACK_K_DEFAULT=8；正整数）。 */
  k?: number;
  /** 小连通域面积下限 cm²（缺省 FALLBACK_MIN_REGION_CM2=0.5——画布标度测试可覆写）。 */
  minRegionCm2?: number;
  /** 时钟注入（createdAt 用；缺省 Date.now——确定性测试注入固定值）。 */
  now?: () => number;
}

export type FallbackSegmentError =
  | { reason: 'aspect-mismatch'; aspectCm: number; aspectPx: number }
  | { reason: 'decode-failed'; message: string }
  | { reason: 'no-surviving-regions'; k: number; minAreaPx: number };

export type FallbackSegmentResult =
  | { ok: true; tree: ObjectTree }
  | ({ ok: false } & FallbackSegmentError);

// ---------------------------------------------------------------- 内部：下采样+Lab

/** 工作网格（≤1024 边的盒滤波下采样；≤界时=原图直通，rgb 三通道平面）。 */
interface WorkGrid {
  w: number;
  h: number;
  rgb: Uint8Array;
  /** 工作网格 ppm（px/mm）=原 ppm×缩放（面积/尺寸换算一致性的锚）。 */
  ppm: number;
  origW: number;
  origH: number;
}

/** 盒滤波下采样（确定性整数累进+round；alpha 忽略——engine segment 同口径只取 RGB）。 */
function buildWorkGrid(rgba: Uint8Array, W: number, H: number, ppm: number): WorkGrid {
  const scale = Math.min(1, FALLBACK_MAX_EDGE_PX / Math.max(W, H));
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const sums = new Float64Array(w * h * 3);
  const counts = new Uint32Array(w * h);
  for (let y = 0; y < H; y++) {
    const wy = Math.min(h - 1, Math.floor((y * h) / H));
    const rowBase = y * W;
    for (let x = 0; x < W; x++) {
      const wx = Math.min(w - 1, Math.floor((x * w) / W));
      const wi = wy * w + wx;
      const p = (rowBase + x) * 4;
      sums[wi * 3] += rgba[p]!;
      sums[wi * 3 + 1] += rgba[p + 1]!;
      sums[wi * 3 + 2] += rgba[p + 2]!;
      counts[wi]++;
    }
  }
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const n = counts[i]! || 1;
    rgb[i * 3] = Math.round(sums[i * 3]! / n);
    rgb[i * 3 + 1] = Math.round(sums[i * 3 + 1]! / n);
    rgb[i * 3 + 2] = Math.round(sums[i * 3 + 2]! / n);
  }
  // 工作 ppm：两轴缩放均值（纵横比一致前提下相等；确定性无主轴偏好——derivePixelsPerMm 同哲）
  const ppmWork = (ppm * (w / W) + ppm * (h / H)) / 2;
  return { w, h, rgb, ppm: ppmWork, origW: W, origH: H };
}

/** 逐像素 Lab（24bit RGB 键缓存——engine LabCache 同构；工作网格 ≤1024² 有界）。 */
function labsOf(work: WorkGrid): Lab[] {
  const cache = new Map<number, Lab>();
  const total = work.w * work.h;
  const labs: Lab[] = new Array(total);
  for (let p = 0; p < total; p++) {
    const r = work.rgb[p * 3]!;
    const g = work.rgb[p * 3 + 1]!;
    const b = work.rgb[p * 3 + 2]!;
    const key = (r << 16) | (g << 8) | b;
    let lab = cache.get(key);
    if (lab === undefined) {
      lab = labFromRgb(r, g, b);
      cache.set(key, lab);
    }
    labs[p] = lab;
  }
  return labs;
}

// ---------------------------------------------------------------- 内部：kmeans（Lab）

function sqLabDist(a: Lab, b: Lab): number {
  const dl = a.L - b.L;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return dl * dl + da * da + db * db;
}

/** 全样本分配到最近心（平局取低索引——确定性）。 */
function assignAll(labs: Lab[], centroids: Lab[], assign: Int32Array): void {
  for (let p = 0; p < labs.length; p++) {
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const d = sqLabDist(labs[p]!, centroids[c]!);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    assign[p] = best;
  }
}

/**
 * Lab kmeans：raster 步进网格采样（≤cap）→**确定性 farthest-first 选心**（kmeans++
 * 的无随机同构：首心=首样本，此后每心=距已选心最远者，平局取低索引——基色占主导
 * 的图也能播下稀有色种子）→Lloyd 固定 FALLBACK_LLOYD_ITERATIONS 次（空簇自然
 * 消亡）→微簇死亡（<max(3, 0.2%) 滤除重分配，engine 范式同构）→最终标签。
 * **全程零随机——同图同参同标签**。返回 null=有效色全灭（微簇全死/样本为空）。
 */
function kmeansLabels(labs: Lab[], k: number): Int32Array | null {
  const total = labs.length;
  const stride = Math.max(1, Math.floor(total / FALLBACK_SAMPLE_CAP));
  const samples: Lab[] = [];
  for (let p = 0; p < total; p += stride) samples.push(labs[p]!);
  const kk = Math.min(k, samples.length);
  if (kk < 1) return null;
  let centroids: Lab[] = [samples[0]!];
  const minD = new Float64Array(samples.length);
  for (let q = 0; q < samples.length; q++) minD[q] = sqLabDist(samples[q]!, centroids[0]!);
  while (centroids.length < kk) {
    let best = 0;
    let bestD = -1;
    for (let q = 0; q < samples.length; q++) {
      if (minD[q]! > bestD) {
        bestD = minD[q]!;
        best = q;
      }
    }
    centroids.push(samples[best]!);
    for (let q = 0; q < samples.length; q++) {
      const d = sqLabDist(samples[q]!, samples[best]!);
      if (d < minD[q]!) minD[q] = d;
    }
  }

  const assign = new Int32Array(total);
  for (let iter = 0; iter < FALLBACK_LLOYD_ITERATIONS; iter++) {
    assignAll(labs, centroids, assign);
    const sums = centroids.map(() => ({ L: 0, a: 0, b: 0, n: 0 }));
    for (let p = 0; p < total; p++) {
      const s = sums[assign[p]!]!;
      const lab = labs[p]!;
      s.L += lab.L;
      s.a += lab.a;
      s.b += lab.b;
      s.n++;
    }
    centroids = sums.filter((s) => s.n > 0).map((s) => ({ L: s.L / s.n, a: s.a / s.n, b: s.b / s.n }));
    if (centroids.length === 0) return null;
  }
  assignAll(labs, centroids, assign);

  const minCluster = Math.max(3, Math.floor(total * FALLBACK_MICRO_CLUSTER_RATIO));
  for (let guard = 0; guard < k; guard++) {
    const counts = new Int32Array(centroids.length);
    for (let p = 0; p < total; p++) counts[assign[p]!]!++;
    const keep: boolean[] = [];
    for (let i = 0; i < centroids.length; i++) keep.push(counts[i]! >= minCluster);
    if (keep.every(Boolean)) break;
    centroids = centroids.filter((_, i) => keep[i]);
    if (centroids.length === 0) return null;
    assignAll(labs, centroids, assign);
  }
  return assign;
}

// ---------------------------------------------------------------- 内部：连通域+节点统计

/** 连通域（4-连通；raster 发现序——确定性；成员=工作网格平面索引）。 */
interface WorkComponent {
  /** 色索引（kmeans 标签）。 */
  color: number;
  indices: number[];
}

/** 全标签一次扫描 4-连通域（显式栈遍历；每域首个像素=raster 首见——域序确定）。 */
function connectedComponentsByLabel(w: number, h: number, labels: Int32Array): WorkComponent[] {
  const total = w * h;
  const visited = new Uint8Array(total);
  const stack = new Int32Array(total);
  const comps: WorkComponent[] = [];
  for (let p = 0; p < total; p++) {
    if (visited[p] === 1) continue;
    const color = labels[p]!;
    visited[p] = 1;
    let sp = 0;
    stack[sp++] = p;
    const indices: number[] = [p];
    while (sp > 0) {
      const cur = stack[--sp]!;
      const x = cur % w;
      const y = (cur / w) | 0;
      // 4-邻接（engine connectedComponents 同构语义；入栈即标记防重复）
      if (y > 0 && visited[cur - w] === 0 && labels[cur - w] === color) {
        visited[cur - w] = 1;
        stack[sp++] = cur - w;
        indices.push(cur - w);
      }
      if (y < h - 1 && visited[cur + w] === 0 && labels[cur + w] === color) {
        visited[cur + w] = 1;
        stack[sp++] = cur + w;
        indices.push(cur + w);
      }
      if (x > 0 && visited[cur - 1] === 0 && labels[cur - 1] === color) {
        visited[cur - 1] = 1;
        stack[sp++] = cur - 1;
        indices.push(cur - 1);
      }
      if (x < w - 1 && visited[cur + 1] === 0 && labels[cur + 1] === color) {
        visited[cur + 1] = 1;
        stack[sp++] = cur + 1;
        indices.push(cur + 1);
      }
    }
    comps.push({ color, indices });
  }
  return comps;
}

/** 域统计（工作网格）：面积/bbox/均值 Lab/RMS ΔE76 色方差（ΔE 量纲——kernel.ts 语义）。 */
interface CompStats {
  areaPx: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  labVariance: number;
}

function statsOf(indices: number[], labs: Lab[], w: number): CompStats {
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  let minX = w;
  let minY = Number.MAX_SAFE_INTEGER;
  let maxX = -1;
  let maxY = -1;
  for (const idx of indices) {
    const lab = labs[idx]!;
    sumL += lab.L;
    sumA += lab.a;
    sumB += lab.b;
    const x = idx % w;
    const y = (idx / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const n = indices.length;
  const mean = { L: sumL / n, a: sumA / n, b: sumB / n };
  let sqSum = 0;
  for (const idx of indices) {
    const d = sqLabDist(labs[idx]!, mean);
    sqSum += d;
  }
  return {
    areaPx: n,
    minX,
    minY,
    maxX,
    maxY,
    labVariance: Math.sqrt(sqSum / n),
  };
}

/** 全网格统计（根=画布全域——免成员索引数组物化）。 */
function statsOfAllGrid(labs: Lab[]): { areaPx: number; labVariance: number } {
  let sumL = 0;
  let sumA = 0;
  let sumB = 0;
  for (const lab of labs) {
    sumL += lab.L;
    sumA += lab.a;
    sumB += lab.b;
  }
  const n = labs.length;
  const mean = { L: sumL / n, a: sumA / n, b: sumB / n };
  let sqSum = 0;
  for (const lab of labs) {
    sqSum += sqLabDist(lab, mean);
  }
  return { areaPx: n, labVariance: Math.sqrt(sqSum / n) };
}

/** 两位小数舍入（tree-to-blocks widthPx 同口径——工件数值稳定）。 */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * 工作网格域 mask → 原始网格 bbox+mask（最近邻上采样：原像素 (x,y) ← 工作格
 * min(w-1, floor(x*w/W))——tree.imagePx=原图，persistTreeWithPreview 锚点不变式）。
 */
function upscaleMask(
  work: WorkGrid,
  comp: WorkComponent,
  st: CompStats,
): { bbox: { x: number; y: number; w: number; h: number }; bits: Uint8Array } {
  const { w, h, origW: W, origH: H } = work;
  const member = new Uint8Array(w * h);
  for (const idx of comp.indices) member[idx] = 1;
  const X0 = Math.floor((st.minX * W) / w);
  const Y0 = Math.floor((st.minY * H) / h);
  const X1 = Math.min(W - 1, Math.ceil(((st.maxX + 1) * W) / w) - 1);
  const Y1 = Math.min(H - 1, Math.ceil(((st.maxY + 1) * H) / h) - 1);
  const bw = X1 - X0 + 1;
  const bh = Y1 - Y0 + 1;
  const bits = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    const wy = Math.min(h - 1, Math.floor(((Y0 + y) * h) / H));
    for (let x = 0; x < bw; x++) {
      const wx = Math.min(w - 1, Math.floor(((X0 + x) * w) / W));
      bits[y * bw + x] = member[wy * w + wx]!; // member=全网格平面（行主序）
    }
  }
  return { bbox: { x: X0, y: Y0, w: bw, h: bh }, bits };
}

// ---------------------------------------------------------------- [1] fallbackSegment 主入口

/** 画布根节点（两路径共用：drillWorthy=false——画布非贴钻主体，§4.3 排除语义）。 */
function canvasRootNode(
  imagePx: ImagePx,
  stats: { areaPx: number; labVariance: number },
  ppm: number,
  origin: ObjectOrigin,
): ObjectNode {
  const bits = new Uint8Array(imagePx.width * imagePx.height).fill(1);
  return {
    id: FALLBACK_ROOT_ID,
    objectName: '画布',
    category: FALLBACK_ROOT_CATEGORY,
    mask: encodeInlineMask(imagePx.width, imagePx.height, bits),
    bbox: { x: 0, y: 0, w: imagePx.width, h: imagePx.height },
    parent: null,
    children: [],
    effectiveMm: round2(Math.sqrt(stats.areaPx) / ppm),
    labVariance: round2(stats.labVariance),
    drillWorthy: false,
    origin,
  };
}

/**
 * 一键模式降级分割：Lab kmeans 颜色结构分块 → ObjectTree（design §7 降级路径）。
 * 纯函数纪律：无 IO/无随机/时钟经 options.now 注入——同图同参同树（含 createdAt）。
 * 节点：根=画布（origin 同树）；子=`色<N>-<区域序>`（1 基人读名；id=auto-<c>-<i>
 * 0 基 ASCII——BlockId 寻址稳定）；mask inline；effectiveMm=√面积/ppm（工作网格
 * 口径）；labVariance=域内 RMS ΔE76；depth=1；origin='auto-color'。
 */
export function fallbackSegment(imageBytes: Uint8Array, options: FallbackSegmentOptions): FallbackSegmentResult {
  const k = options.k ?? FALLBACK_K_DEFAULT;
  if (!Number.isInteger(k) || k < 1) {
    throw new RangeError(`k 必须为正整数（实为 ${k}）`);
  }
  const minRegionCm2 = options.minRegionCm2 ?? FALLBACK_MIN_REGION_CM2;
  if (!(minRegionCm2 > 0)) {
    throw new RangeError(`minRegionCm2 必须为正数（实为 ${minRegionCm2}）`);
  }

  let decoded;
  try {
    decoded = decodePng(imageBytes);
  } catch (error) {
    if (error instanceof PngCodecError) {
      return { ok: false, reason: 'decode-failed', message: error.message };
    }
    throw error;
  }
  const imagePx: ImagePx = { width: decoded.width, height: decoded.height };

  // §1 S1：canvasCm×imagePx → px/mm（纵横比>2% 显式拒——typed error 透传）
  const ppmResult = derivePixelsPerMm({ canvasCm: options.canvasCm, imagePx });
  if (!ppmResult.ok) {
    return { ok: false, reason: 'aspect-mismatch', aspectCm: ppmResult.aspectCm, aspectPx: ppmResult.aspectPx };
  }
  const ppm = ppmResult.pixelsPerMm;

  const work = buildWorkGrid(decoded.rgba, decoded.width, decoded.height, ppm);
  const labs = labsOf(work);
  const labels = kmeansLabels(labs, k);
  if (labels === null) {
    return { ok: false, reason: 'no-surviving-regions', k, minAreaPx: 0 };
  }

  // 小连通域面积下限：cm²→工作网格 px（1cm²=100mm²；px=mm²×ppm²——换算一致性的锚）
  const minAreaPx = minRegionCm2 * 100 * work.ppm * work.ppm;
  const comps = connectedComponentsByLabel(work.w, work.h, labels)
    .filter((c) => c.indices.length >= minAreaPx)
    .sort((a, b) => a.color - b.color); // 色升序；同色保持 raster 发现序（sort 稳定）
  if (comps.length === 0) {
    return { ok: false, reason: 'no-surviving-regions', k, minAreaPx };
  }

  // 子节点（色 N=过滤后标签序 1 基；区域序=同色 raster 发现序 1 基）
  const regionIds: string[] = [];
  const regionNodes: ObjectNode[] = [];
  const perColorOrdinal = new Map<number, number>();
  for (const comp of comps) {
    const ordinal = (perColorOrdinal.get(comp.color) ?? 0) + 1;
    perColorOrdinal.set(comp.color, ordinal);
    const st = statsOf(comp.indices, labs, work.w);
    const { bbox, bits } = upscaleMask(work, comp, st);
    const id = `auto-${comp.color}-${ordinal - 1}`;
    regionIds.push(id);
    regionNodes.push({
      id,
      objectName: `色${comp.color + 1}-${ordinal}`,
      category: FALLBACK_CATEGORY,
      mask: encodeInlineMask(bbox.w, bbox.h, bits),
      bbox,
      parent: FALLBACK_ROOT_ID,
      children: [],
      effectiveMm: round2(Math.sqrt(st.areaPx) / work.ppm),
      labVariance: round2(st.labVariance),
      drillWorthy: true,
      origin: 'auto-color',
    });
  }

  // 根=画布（全域统计）
  const root = canvasRootNode(imagePx, statsOfAllGrid(labs), work.ppm, 'auto-color');
  root.children = regionIds;

  const tree: ObjectTree = {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: options.canvasCm,
    imagePx,
    nodes: [root, ...regionNodes],
    createdAt: new Date((options.now ?? Date.now)()).toISOString(),
  };
  return { ok: true, tree };
}

// ---------------------------------------------------------------- [2] segmentWithFallback

/** 降级 warning（§6.4 哲学：基础工作流不因桥故障中断——warning 透出降级事实）。 */
export interface SegmentFallbackWarning {
  reason: 'bridge-unavailable';
  /** 连续失败次数（=阈值时降级） */
  failures: number;
  /** 降级分割耗时 ms（deps.now 注入下确定） */
  fallbackDurationMs: number;
  /** 最后一次桥失败摘要（人读） */
  bridgeError: string;
}

export interface SegmentWithFallbackDeps {
  /** 桥传输（注入——P2.4 循环/SshSamTransport/MockSamTransport 均可）。 */
  transport: SamTransport;
  /** mask blob 态解析面（inline 不经此；blob 态读取——tree-to-blocks ReadBlobFn 同构）。 */
  readBlob: ReadBlobFn;
  /** 时钟注入（warning 耗时+createdAt；缺省 Date.now）。 */
  now?: () => number;
  /** 桥连续失败阈值（缺省 BRIDGE_FAILURE_THRESHOLD_DEFAULT=2）。 */
  bridgeFailureThreshold?: number;
}

export interface SegmentWithFallbackInput {
  taskId: string;
  imageBlobRef: string;
  imageBytes: Uint8Array;
  /** 声明像素尺寸（桥请求锚点；与解码尺寸不符=typed error——锚点错位不猜）。 */
  imagePx: ImagePx;
  canvasCm: CanvasCm;
  /** 降级 kmeans 色数（缺省 8）。 */
  k?: number;
  /** 降级小连通域下限 cm²（缺省 0.5）。 */
  minRegionCm2?: number;
  /** 桥单发提示（缺省宽泛语义 'subject'——design §1 S3）。 */
  prompt?: SamTextPrompt;
  /** 取消信号（排队/执行中取消=传播，不降级——取消是调用方意图）。 */
  signal?: AbortSignal;
}

export type SegmentWithFallbackError =
  | FallbackSegmentError
  | { reason: 'cancelled' }
  | { reason: 'decode-failed'; message: string }
  | { reason: 'image-dims-mismatch'; declared: ImagePx; decoded: ImagePx };

export type SegmentWithFallbackResult =
  | { ok: true; tree: ObjectTree; fallback: false; warning?: undefined; bridgeMeta?: SamResponseMeta }
  | { ok: true; tree: ObjectTree; fallback: true; warning: SegmentFallbackWarning }
  | ({ ok: false } & SegmentWithFallbackError);

/** 取消判定（signal 已中止 / SamBridgeError cancelled / DOMException AbortError）。 */
function isCancellation(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (error instanceof Error && error.name === 'AbortError') return true;
  return error instanceof SamBridgeError && error.kind === 'cancelled';
}

function errMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** 两态 mask → bits+w/h（blob 态经 readBlob——tree-to-blocks maskBitsOf 同构子集）。 */
function resolveBridgeMask(
  readBlob: ReadBlobFn,
  mask: Mask2DRef,
): { ok: true; w: number; h: number; bits: Uint8Array } | { ok: false; detail: string } {
  if (mask.kind === 'inline') return { ok: true, ...decodeInlineMask(mask) };
  const raw = readBlob(mask.blobRef);
  if (raw === null) return { ok: false, detail: `mask blob 不存在（${mask.blobRef.slice(0, 12)}…）` };
  if (raw.length !== mask.w * mask.h) {
    return { ok: false, detail: `mask blob 长度 ${raw.length} ≠ w*h=${mask.w * mask.h}` };
  }
  for (const b of raw) {
    if (b !== 0 && b !== 1) return { ok: false, detail: 'mask blob 字节 ∉ {0,1}' };
  }
  return { ok: true, w: mask.w, h: mask.h, bits: raw };
}

/**
 * 桥先行分割+降级包装（P2.5 降级触发面）：
 * 先桥（注入 transport 单发 segment——迭代多轮树归 P2.4 segment-loop，本函数是
 * 单发宽泛提示的最小桥路径）；连续失败达阈值（缺省 2）→fallbackSegment 降级
 * +warning{reason:'bridge-unavailable'}。取消传播（不降级）；桥恢复探测不归本波
 * （每次调用重新试桥——无闭锁电路）。失败面：传输失败/超时/坏响应/mask 不可解
 * 均计失败（§6.4 哲学：桥侧任何故障都不阻断基础工作流）；typed error=降级自身
 * 失败（decode/aspect/no-surviving-regions）与取消。
 */
export async function segmentWithFallback(
  deps: SegmentWithFallbackDeps,
  input: SegmentWithFallbackInput,
): Promise<SegmentWithFallbackResult> {
  const threshold = deps.bridgeFailureThreshold ?? BRIDGE_FAILURE_THRESHOLD_DEFAULT;
  if (!Number.isInteger(threshold) || threshold < 1) {
    throw new RangeError(`bridgeFailureThreshold 必须为正整数（实为 ${threshold}）`);
  }
  const now = deps.now ?? Date.now;
  if (input.signal?.aborted) return { ok: false, reason: 'cancelled' };

  let decoded;
  try {
    decoded = decodePng(input.imageBytes);
  } catch (error) {
    if (error instanceof PngCodecError) {
      return { ok: false, reason: 'decode-failed', message: error.message };
    }
    throw error;
  }
  if (decoded.width !== input.imagePx.width || decoded.height !== input.imagePx.height) {
    return {
      ok: false,
      reason: 'image-dims-mismatch',
      declared: input.imagePx,
      decoded: { width: decoded.width, height: decoded.height },
    };
  }

  const prompt: SamTextPrompt = input.prompt ?? { kind: 'text', text: DEFAULT_BRIDGE_PROMPT_TEXT };
  const request = {
    kind: 'segment' as const,
    taskId: input.taskId,
    imageBlobRef: input.imageBlobRef,
    imagePx: input.imagePx,
    canvasCm: input.canvasCm,
    prompt,
    iteration: 0,
  };

  let failures = 0;
  let lastError: unknown;
  while (failures < threshold) {
    let response;
    try {
      response = await deps.transport.send({
        request,
        imageBytes: new Uint8Array(input.imageBytes),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      });
    } catch (error) {
      if (isCancellation(error, input.signal)) return { ok: false, reason: 'cancelled' };
      failures++;
      lastError = error;
      continue;
    }

    // 响应校验（schema+kind——SamBridge 同口径；坏响应计失败走降级）
    const check = SamBridgeResponseSchema.safeParse(response);
    if (!check.success || check.data.kind !== 'segment') {
      failures++;
      lastError = new Error(
        check.success
          ? `SAM 响应 kind 不匹配（期望 segment，实为 ${String((check.data as { kind?: unknown }).kind)}）`
          : `SAM 响应校验失败：${check.error.issues.map((i) => i.message).join('; ')}`,
      );
      continue;
    }
    const seg = check.data;

    // mask 解析（两态→bits；尺寸≠imagePx/空 mask=锚点错位，计失败走降级）
    const mask = resolveBridgeMask(deps.readBlob, seg.mask);
    if (!mask.ok || mask.w !== input.imagePx.width || mask.h !== input.imagePx.height) {
      failures++;
      lastError = new Error(
        !mask.ok
          ? `桥 mask 不可解：${mask.detail}`
          : `桥 mask 尺寸 ${mask.w}×${mask.h} ≠ imagePx ${input.imagePx.width}×${input.imagePx.height}`,
      );
      continue;
    }
    let popcount = 0;
    let minX = mask.w;
    let minY = mask.h;
    let maxX = -1;
    let maxY = -1;
    for (let i = 0; i < mask.bits.length; i++) {
      if (mask.bits[i] !== 1) continue;
      popcount++;
      const x = i % mask.w;
      const y = (i / mask.w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (popcount === 0) {
      failures++;
      lastError = new Error('桥 mask 全零（无主体像素）');
      continue;
    }

    // 桥路径树：根=画布 + 主体单节点（bbox=mask 紧致框；mask 裁剪到 bbox）
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const cropBits = new Uint8Array(bw * bh);
    for (let i = 0; i < mask.bits.length; i++) {
      if (mask.bits[i] !== 1) continue;
      const x = i % mask.w;
      const y = (i / mask.w) | 0;
      cropBits[(y - minY) * bw + (x - minX)] = 1;
    }
    const ppmResult = derivePixelsPerMm({ canvasCm: input.canvasCm, imagePx: input.imagePx });
    if (!ppmResult.ok) {
      return { ok: false, reason: 'aspect-mismatch', aspectCm: ppmResult.aspectCm, aspectPx: ppmResult.aspectPx };
    }
    // 主体统计口径与降级路径一致：工作网格 RMS ΔE76（最近邻下采样掩码）
    const work = buildWorkGrid(decoded.rgba, decoded.width, decoded.height, ppmResult.pixelsPerMm);
    const workMask = new Uint8Array(work.w * work.h);
    for (let y = 0; y < work.h; y++) {
      const oy = Math.min(decoded.height - 1, Math.floor((y * decoded.height) / work.h));
      for (let x = 0; x < work.w; x++) {
        const ox = Math.min(decoded.width - 1, Math.floor((x * decoded.width) / work.w));
        workMask[y * work.w + x] = mask.bits[oy * mask.w + ox]!;
      }
    }
    const labs = labsOf(work);
    const memberIdx: number[] = [];
    for (let i = 0; i < workMask.length; i++) {
      if (workMask[i] === 1) memberIdx.push(i);
    }
    const st = statsOf(memberIdx, labs, work.w);

    const root = canvasRootNode(input.imagePx, statsOfAllGrid(labs), work.ppm, 'vlm+sam3');
    const subjectId = 'sam-0';
    root.children = [subjectId];
    const tree: ObjectTree = {
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: input.canvasCm,
      imagePx: input.imagePx,
      nodes: [
        root,
        {
          id: subjectId,
          objectName: '主体',
          category: 'subject',
          mask: encodeInlineMask(bw, bh, cropBits),
          bbox: { x: minX, y: minY, w: bw, h: bh },
          parent: FALLBACK_ROOT_ID,
          children: [],
          effectiveMm: round2(Math.sqrt(popcount) / ppmResult.pixelsPerMm),
          labVariance: round2(st.labVariance),
          drillWorthy: true,
          origin: 'vlm+sam3',
        },
      ],
      createdAt: new Date(now()).toISOString(),
    };
    return { ok: true, tree, fallback: false, bridgeMeta: seg.meta };
  }

  // 降级（连续失败达阈值——§6.4 哲学：桥故障不阻断基础工作流）
  const t0 = now();
  const fb = fallbackSegment(input.imageBytes, {
    canvasCm: input.canvasCm,
    ...(input.k !== undefined ? { k: input.k } : {}),
    ...(input.minRegionCm2 !== undefined ? { minRegionCm2: input.minRegionCm2 } : {}),
    now,
  });
  const fallbackDurationMs = now() - t0;
  if (!fb.ok) return fb;
  return {
    ok: true,
    tree: fb.tree,
    fallback: true,
    warning: {
      reason: 'bridge-unavailable',
      failures,
      fallbackDurationMs,
      bridgeError: errMessage(lastError),
    },
  };
}
