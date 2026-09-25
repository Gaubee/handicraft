/**
 * ObjectTree → Block[] 适配器（add-subject-sam-pipeline design §3/§1 S1——P0.2）。
 * 决策源：owner-directive 主文（主体=值得贴的内容）+ P0.2 任务定调。
 *
 * 引擎红线纪律：**不 import 不改动** rhinestone-studio/engine——本文件按引擎
 * types.ts/segment.ts/ops.ts 的**已文档语义**自实现同构件（逐字段结构同构 +
 * 同算法距离变换），等价性由 tests/tree-to-blocks.test.ts 语义级断言把守。
 *
 * 语义裁定（按 kernel.ts 字段实际语义，冲突项见任务报告）：
 *   [1] 树展开：叶子必产 Block；中间节点按 drillWorthy 产（Owner 定调：主体=
 *       值得贴的内容——父可钻时子为其细节层，父子都产+origin 标注，策略层选粒度）。
 *       drillWorthy=false 的**叶子仍产 Block**（design §4.3 排除族语义=跳过产 Gem
 *       +BOM 明示未贴区域——几何基座必须存在；排除是 P1.3 策略层关注）。
 *   [2] mask 同构：ObjectNode.mask 与引擎 Mask2D **同为 bbox 局部坐标**（kernel.ts
 *       NodeBBox 注：「mask 为 bbox 局部坐标，全局定位取此」；引擎 types.ts Mask2D
 *       注同）——位图直拷**无需平移**，画布全域定位由 Block.bbox=node.bbox 锚点承载。
 *       mask 尺寸 ≠ bbox 尺寸=锚点语义未定义 → typed error 显式拒（不猜）。
 *   [3] colorRgb：ObjectNode **无颜色字段**（树是无色几何工件——labVariance 是
 *       ΔE76 量纲标量，无法反算代表色）；调用方经 nodeColors 注入（S5 建树方有
 *       原图可算中位色），缺省确定性灰 [128,128,128] + colorSource='fallback' 标注
 *       （不静默发明数据）。
 *   [4] suggested：design 无 category→BlockType 映射表（§3 仅列类别词表）——按
 *       引擎 segment.ts 文档化推断同构实现（面积<单钻足迹→element；宽度<3 钻径→
 *       linear；否则 fill）；category 随 origin 标注透出，S6 策略层/用户可覆写
 *       （引擎 types.ts：suggested=建议值可覆写后送 layout）。
 *   [5] widthPx：距离变换宽度统计同构（引擎 ops.ts 精确 EDT——Felzenszwalb 1D×2，
 *       含图像外侧虚拟背景；宽度≈2×dist 文档化近似）——本文件自实现同算法。
 *
 * 纯函数纪律：无 IO/无随机/无时钟；blob 读取经注入面 readBlob（BlobStore.read
 * 的 (hash)→Buffer|null 投影）；同输入同输出（确定性单测覆盖）。
 */
import {
  blockIdOfNode,
  decodeInlineMask,
  derivePixelsPerMm,
  type BlobRef,
  type NodeId,
  type ObjectNode,
  type ObjectOrigin,
  type ObjectTree,
} from '@handicraft/contracts';

// ---------------------------------------------------------------- 引擎同构类型（不 import 引擎——红线）

/** 引擎 Mask2D 同构：w*h 字节、逐字节 ∈ {0,1}、行主序 bbox 局部坐标。 */
export interface TreeMask2D {
  w: number;
  h: number;
  bits: Uint8Array;
}

/** 引擎 BBox 同构：画布像素坐标锚点（mask 全局定位取此）。 */
export interface TreeBBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 引擎 BlockType 同构：'fill' | 'linear' | 'element'。 */
export type TreeBlockType = 'fill' | 'linear' | 'element';

/**
 * origin 标注（策略层粒度选择面——design §3/S6）：引擎 Block 九字段之外的本管线
 * 增量面。originBlockId=**父 Block** id（树父未产块→null——该节点即其钻层级顶）；
 * parentNodeId=树父节点 id（树链完整可溯，与父是否产块无关）。
 */
export interface TreeBlockOrigin {
  originBlockId: string | null;
  parentNodeId: string | null;
  /** VLM/SAM3 类别（structure/foliage/face/light/…——S6 策略指派输入） */
  nodeCategory: string;
  /** 排除开关（false→P1.3 排除族跳过产 Gem+BOM 未贴区明示） */
  drillWorthy: boolean;
  /** 节点来源（vlm+sam3 | manual-lasso | auto-color） */
  nodeOrigin: ObjectOrigin;
  /** 停止判据数据回填（design §2——策略层按需消费） */
  effectiveMm: number;
  labVariance: number;
  /** 树深度（根=0） */
  depth: number;
  isLeaf: boolean;
  /** colorRgb 来源：调用方注入（建树方中位色） | 缺省灰回退（树无色字段） */
  colorSource: 'node-color' | 'fallback';
}

/** 引擎 Block 同构（types.ts 九字段，序一致）+ origin 标注（第十字段）。 */
export interface TreeBlock {
  id: string;
  label: string;
  mask: TreeMask2D;
  colorRgb: [number, number, number];
  areaPx: number;
  bbox: TreeBBox;
  widthPx: { max: number; mean: number };
  suggested: TreeBlockType;
  origin: TreeBlockOrigin;
}

// ---------------------------------------------------------------- 输入面

/** blob 注入面：BlobStore.read 的投影（null=无 active 行/未装配）。 */
export type ReadBlobFn = (ref: BlobRef) => Uint8Array | null;

export interface TreeToBlocksDeps {
  readBlob: ReadBlobFn;
}

/** 建议类型推断参数（引擎 SegmentOptions 同构子集——gemDiameterPx 必填同引擎）。 */
export interface TreeToBlocksOptions {
  /** 钻直径 px（类型推断阈值：<3 钻径宽→linear；面积<单钻足迹→element） */
  gemDiameterPx: number;
  /** 单钻足迹下限（引擎缺省 12——仅参与 elementAreaPx 公式，不丢块） */
  minAreaPx?: number;
  /** 节点代表色注入（建树方按原图算的 Lab 中位→sRGB；缺省节点→灰回退） */
  nodeColors?: Readonly<Record<NodeId, [number, number, number]>>;
}

// ---------------------------------------------------------------- typed error（结果联合——不抛不猜）

export type TreeToBlocksError =
  /** derivePixelsPerMm 显式拒透传（§1 S1 纵横比>2%） */
  | { reason: 'aspect-mismatch'; aspectCm: number; aspectPx: number }
  /** mask 尺寸 ≠ bbox 尺寸（锚点语义未定义——kernel.ts [2] 裁定显式拒） */
  | { reason: 'mask-dims-mismatch'; nodeId: NodeId; maskW: number; maskH: number; bboxW: number; bboxH: number }
  /** blob 无 active 行/未装配 */
  | { reason: 'blob-missing'; nodeId: NodeId; blobRef: BlobRef }
  /** blob 字节非法（长度≠w*h 或字节∉{0,1}——blob 内容不经 schema 校验，运行时验） */
  | { reason: 'mask-bytes-invalid'; nodeId: NodeId; detail: string }
  /** 全零 mask（零成员像素节点=畸形分割产物——widthPx.mean 会 0/0，显式拒） */
  | { reason: 'empty-mask'; nodeId: NodeId }
  /** nodeColors 条目非法（非 3×int[0,255]） */
  | { reason: 'color-invalid'; nodeId: NodeId; detail: string };

export type TreeToBlocksResult =
  | { ok: true; blocks: TreeBlock[]; pixelsPerMm: number }
  | ({ ok: false } & TreeToBlocksError);

// ---------------------------------------------------------------- 精确 EDT（引擎 ops.ts 同构自实现——红线[5]）

/** Felzenszwalb 1D EDT（下包络两指针）——引擎 ops.ts edt1d 同算法。 */
function edt1d(
  f: Float64Array,
  fOff: number,
  fStride: number,
  n: number,
  d: Float64Array,
  dOff: number,
  dStride: number,
): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const INF = 1e20;
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[fOff + q * fStride] + q * q) - (f[fOff + v[k]! * fStride] + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) {
      k--;
      s = ((f[fOff + q * fStride] + q * q) - (f[fOff + v[k]! * fStride] + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1]! < q) k++;
    d[dOff + q * dStride] = (q - v[k]!) * (q - v[k]!) + f[fOff + v[k]! * fStride];
  }
}

/**
 * 掩码内每像素到最近背景（含图像外侧虚拟背景）的欧氏距离，px——引擎 ops.ts
 * distanceTransform 同构（贴边形状宽度不虚高）。
 */
function distanceTransform(mask: TreeMask2D): Float32Array {
  const { w, h } = mask;
  const W = w + 2;
  const H = h + 2;
  const INF = 1e20;
  const f = new Float64Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inner = x >= 1 && y >= 1 && x <= w && y <= h && mask.bits[(y - 1) * w + (x - 1)] === 1;
      f[y * W + x] = inner ? INF : 0;
    }
  }
  // 行方向 1D EDT → 列方向 1D EDT = 精确 2D 平方距离
  const g = new Float64Array(W * H);
  for (let y = 0; y < H; y++) edt1d(f, y * W, 1, W, g, y * W, 1);
  const out2 = new Float64Array(W * H);
  for (let x = 0; x < W; x++) edt1d(g, x, W, H, out2, x, W);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out[y * w + x] = Math.sqrt(out2[(y + 1) * W + (x + 1)]!);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 内部工具

/** 两位小数舍入（引擎 segment.ts widthPx 统计口径）。 */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** mask 二态 → w*h 0/1 字节（inline=schema 已验直接解码；blob=运行时验）。 */
function maskBitsOf(
  node: ObjectNode,
  readBlob: ReadBlobFn,
): { ok: true; w: number; h: number; bits: Uint8Array } | ({ ok: false } & TreeToBlocksError) {
  if (node.mask.kind === 'inline') return { ok: true, ...decodeInlineMask(node.mask) };
  const raw = readBlob(node.mask.blobRef);
  if (raw === null) return { ok: false, reason: 'blob-missing', nodeId: node.id, blobRef: node.mask.blobRef };
  const expect = node.mask.w * node.mask.h;
  if (raw.length !== expect) {
    return {
      ok: false,
      reason: 'mask-bytes-invalid',
      nodeId: node.id,
      detail: `blob ${node.mask.blobRef} 长度 ${raw.length} ≠ w*h=${expect}`,
    };
  }
  for (const b of raw) {
    if (b !== 0 && b !== 1) {
      return {
        ok: false,
        reason: 'mask-bytes-invalid',
        nodeId: node.id,
        detail: `blob ${node.mask.blobRef} 字节 ${b} ∉ {0,1}（引擎 Mask2D 同构）`,
      };
    }
  }
  // 防御拷贝（纯函数纪律：输出不与注入面缓冲共享可变引用——inline 路径本就新分配）
  return { ok: true, w: node.mask.w, h: node.mask.h, bits: new Uint8Array(raw) };
}

/** 树展开策略（裁定 [1]）：叶子必产；中间节点按 drillWorthy。 */
function producesBlock(node: ObjectNode): boolean {
  return node.children.length === 0 || node.drillWorthy;
}

/**
 * 祖先 objectName 链（根→本节点，'/' 连接——「路灯/杆」）：根贡献全名；各后代
 * 贡献**局部段**（最后一个「·」之后——§3 语义名约定「路灯·杆」自带父上下文，
 * 链式重组去重；无名内「·」时局部段=全名，如「柳树/枝条」）。树链 id 精确溯源
 * 见 origin.parentNodeId——label 仅人读展示面。
 */
function labelChainOf(node: ObjectNode, byId: Map<NodeId, ObjectNode>): string {
  const chain: ObjectNode[] = [];
  let cur: ObjectNode | undefined = node;
  while (cur) {
    chain.push(cur);
    cur = cur.parent === null ? undefined : byId.get(cur.parent);
  }
  chain.reverse();
  const parts = chain.map((n, i) => {
    if (i === 0) return n.objectName;
    const cut = n.objectName.lastIndexOf('·');
    const local = cut === -1 ? n.objectName : n.objectName.slice(cut + 1);
    return local.length > 0 ? local : n.objectName;
  });
  return parts.join('/');
}

/** 树深度（根=0）。 */
function depthOf(node: ObjectNode, byId: Map<NodeId, ObjectNode>): number {
  let depth = 0;
  let cur: ObjectNode | undefined = node;
  while (cur.parent !== null) {
    depth++;
    cur = byId.get(cur.parent)!;
  }
  return depth;
}

function colorOf(
  node: ObjectNode,
  nodeColors: Readonly<Record<NodeId, [number, number, number]>> | undefined,
): { ok: true; colorRgb: [number, number, number]; colorSource: 'node-color' | 'fallback' } | ({ ok: false } & TreeToBlocksError) {
  const given = nodeColors?.[node.id];
  if (given === undefined) return { ok: true, colorRgb: [128, 128, 128], colorSource: 'fallback' };
  if (given.length !== 3 || given.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) {
    return { ok: false, reason: 'color-invalid', nodeId: node.id, detail: `nodeColors[${node.id}] 须为 3×int[0,255]` };
  }
  return { ok: true, colorRgb: [given[0]!, given[1]!, given[2]!], colorSource: 'node-color' };
}

// ---------------------------------------------------------------- 主入口

/**
 * ObjectTree → TreeBlock[] + pixelsPerMm（§1 S1+§3——纯函数）。
 * 输出序=tree.nodes 序（确定性；blockId=blockIdOfNode 同寻址空间，S7/S8 直接寻址）。
 * suggested/category/drillWorthy 均为策略层可覆写建议面（S6 LLM 指派为真决策源）。
 */
export function treeToBlocks(
  tree: ObjectTree,
  deps: TreeToBlocksDeps,
  options: TreeToBlocksOptions,
): TreeToBlocksResult {
  if (!(options.gemDiameterPx > 0)) {
    throw new RangeError('gemDiameterPx 必须为正数（引擎类型推断阈值——同 SegmentOptions）');
  }
  const minAreaPx = options.minAreaPx ?? 12;
  if (!(Number.isInteger(minAreaPx) && minAreaPx > 0)) {
    throw new RangeError('minAreaPx 必须为正整数');
  }

  // §1 S1：canvasCm×imagePx → px/mm（纵横比>2% 显式拒——typed error 透传）
  const ppm = derivePixelsPerMm({ canvasCm: tree.canvasCm, imagePx: tree.imagePx });
  if (!ppm.ok) return { ok: false, reason: 'aspect-mismatch', aspectCm: ppm.aspectCm, aspectPx: ppm.aspectPx };

  const byId = new Map<NodeId, ObjectNode>(tree.nodes.map((n) => [n.id, n]));
  // 建议类型阈值（引擎 segment.ts 同构公式）
  const elementAreaPx = Math.max(minAreaPx + 1, Math.ceil(Math.PI * (options.gemDiameterPx / 2) ** 2));
  const linearWidthPx = 3 * options.gemDiameterPx;

  const blocks: TreeBlock[] = [];
  for (const node of tree.nodes) {
    if (!producesBlock(node)) continue;

    // mask 同构（裁定 [2]：同 bbox 局部坐标直拷；尺寸偏差显式拒）
    const mask = maskBitsOf(node, deps.readBlob);
    if (!mask.ok) return mask;
    if (mask.w !== node.bbox.w || mask.h !== node.bbox.h) {
      return {
        ok: false,
        reason: 'mask-dims-mismatch',
        nodeId: node.id,
        maskW: mask.w,
        maskH: mask.h,
        bboxW: node.bbox.w,
        bboxH: node.bbox.h,
      };
    }

    // 面积/宽度统计（引擎 segment.ts 口径：成员像素距离变换，宽度≈2×dist）
    const dt = distanceTransform(mask);
    let areaPx = 0;
    let dtMax = 0;
    let dtSum = 0;
    for (let i = 0; i < mask.bits.length; i++) {
      if (mask.bits[i] !== 1) continue;
      areaPx++;
      const d = dt[i]!;
      if (d > dtMax) dtMax = d;
      dtSum += d;
    }
    if (areaPx === 0) return { ok: false, reason: 'empty-mask', nodeId: node.id };
    const widthMax = round2(2 * dtMax);
    const widthMean = round2((2 * dtSum) / areaPx);

    // 建议类型（裁定 [4]：引擎文档化推断同构——面积<单钻足迹→element；
    // 宽度<3 钻径→linear；否则 fill）
    const suggested: TreeBlockType = areaPx < elementAreaPx ? 'element' : widthMax < linearWidthPx ? 'linear' : 'fill';

    // 代表色（裁定 [3]：树无色字段——注入或确定性灰回退+标注）
    const color = colorOf(node, options.nodeColors);
    if (!color.ok) return color;

    const parent = node.parent === null ? undefined : byId.get(node.parent);
    blocks.push({
      id: blockIdOfNode(node),
      label: labelChainOf(node, byId),
      mask: { w: mask.w, h: mask.h, bits: mask.bits },
      colorRgb: color.colorRgb,
      areaPx,
      bbox: { x: node.bbox.x, y: node.bbox.y, w: node.bbox.w, h: node.bbox.h },
      widthPx: { max: widthMax, mean: widthMean },
      suggested,
      origin: {
        originBlockId: parent !== undefined && producesBlock(parent) ? blockIdOfNode(parent) : null,
        parentNodeId: node.parent,
        nodeCategory: node.category,
        drillWorthy: node.drillWorthy,
        nodeOrigin: node.origin,
        effectiveMm: node.effectiveMm,
        labVariance: node.labVariance,
        depth: depthOf(node, byId),
        isLeaf: node.children.length === 0,
        colorSource: color.colorSource,
      },
    });
  }
  return { ok: true, blocks, pixelsPerMm: ppm.pixelsPerMm };
}
