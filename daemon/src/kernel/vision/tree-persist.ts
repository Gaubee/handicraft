/**
 * object-tree 工件持久化（add-subject-sam-pipeline tasks P0.4 / design §3+§1 S5
 * ——「人看图+机用工件双轨」的机用轨）。
 * 原始需求 2026-09-24（Owner：树状工件+归属关系）：ObjectTree 序列化 JSON → 任务
 * 产物 blob；mask blob 态优先——inline 大掩码转 blob 落盘，工件里只留 blobRef
 * （两态语义=contracts kernel.ts Mask2DRef：blob 内容 w*h 0/1 字节，行主序）。
 * 产物纪律（沿 jobs/engine.ts 先例照写）：一切写入经 putTaskArtifact——fence 与
 * 写入同事务，cancelled/cleared/行删任务拒写（ArtifactFenceError 由调用方收敛）。
 * 登记面（仓内现状）：putTaskArtifact 只落 blob；工件登记=调用方 emit('artifact',
 * {blobRef, name}) 帧 + JSON 载荷内 kind 字面量（'object-tree'——schema 冻结）。
 * 本模块不发帧（runner/工具层职责——engine.ts 同分工）。
 * 正交意图：
 *   [1] persistObjectTreeArtifact：DFS 规范序+mask inline→blob 转换+tree JSON 落盘。
 *   [2] loadObjectTreeArtifact/resolveMaskBits：读回面（JSON→ObjectTree；两态 mask→bits）。
 *   [3] persistTreeWithPreview：双轨编排（tree 工件+树视图叠加预览图工件）。
 */
import {
  ObjectTreeSchema,
  decodeInlineMask,
  type BlobMask,
  type Mask2DRef,
  type ObjectNode,
  type ObjectTree,
} from '@handicraft/contracts';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { decodePng } from '../../png/codec.js';
import { renderTreeOverlayPreview, type TreePreviewLegendEntry } from './tree-preview.js';

/**
 * inline mask 持久化分界（字节=w*h）：≤ 此值保持内联（小掩码 JSON 直读方便），
 * 超出转 blob（大树掩码不臃肿 JSON——「blob 态优先」策略的大/小分界；0=全转 blob）。
 */
export const MASK_INLINE_PERSIST_MAX_BYTES = 4096;

/** 工件面（与 putTaskArtifact 同构——db+blobs 即可，runner/工具层均可用）。 */
export interface TreeArtifactDeps {
  db: SqliteDb;
  blobs: BlobStore;
}

export interface PersistObjectTreeOptions {
  /** inline mask 转 blob 阈值（字节=w*h）；0=全转 blob。缺省 MASK_INLINE_PERSIST_MAX_BYTES。 */
  inlineMaxBytes?: number;
}

export interface PersistedTreeArtifact {
  /** object-tree.json 工件 blobRef（内容寻址 sha256） */
  treeBlobRef: string;
  /** 落盘形态（DFS 规范序+mask 转换后——与 blob 内容逐字节同源） */
  persisted: ObjectTree;
  /** 发生 inline→blob 转换的节点（nodeId → mask blobRef；未转换的不在表内） */
  maskBlobRefs: Map<string, string>;
}

/** 全树节点 DFS 先序（根起、children 声明序——schema 已保证单根无环）。 */
function dfsOrderOf(tree: ObjectTree): ObjectNode[] {
  const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
  const order: ObjectNode[] = [];
  const visit = (node: ObjectNode): void => {
    order.push(node);
    for (const childId of node.children) {
      const child = byId.get(childId);
      if (child !== undefined) visit(child); // superRefine 已拒悬垂——防御跳过
    }
  };
  const root = tree.nodes.find((n) => n.parent === null);
  if (root !== undefined) visit(root);
  return order.length === tree.nodes.length ? order : tree.nodes.slice(); // 全连通则先序，否则保序
}

/**
 * ObjectTree → 任务产物（object-tree.json）。
 * 规范化两件事（确定性——同树同产物，内容寻址去重可回放）：
 *   [1] 节点序=DFS 先序（预览图角标序号与 JSON 数组序天然对齐——双轨桥）。
 *   [2] mask inline 且 w*h>阈值 → 转 blob（经 putTaskArtifact 落任务域 blob，
 *       工件里只留 blobRef）；已 blob 的原样保留。
 * 写入序：mask blob 先、tree JSON 最后（JSON 是提交点——中途 fence 拒绝时无「指向
 * 缺失 blob 的工件」；已写 mask blob 成为无引用残留，与 engine.ts 逐 put 独立 fence
 * 的暴露面一致，P0.4 不引入 stage/commit 事务）。
 */
export function persistObjectTreeArtifact(
  deps: TreeArtifactDeps,
  taskId: string,
  tree: ObjectTree,
  options: PersistObjectTreeOptions = {},
): PersistedTreeArtifact {
  const threshold = options.inlineMaxBytes ?? MASK_INLINE_PERSIST_MAX_BYTES;
  const maskBlobRefs = new Map<string, string>();
  const nodes = dfsOrderOf(tree).map((node) => {
    if (node.mask.kind !== 'inline' || node.mask.w * node.mask.h <= threshold) {
      return node; // blob 态保留；小 inline 保留
    }
    const { w, h, bits } = decodeInlineMask(node.mask);
    const put = putTaskArtifact(deps, taskId, bits);
    maskBlobRefs.set(node.id, put.hash);
    const converted: BlobMask = { kind: 'blob', w, h, blobRef: put.hash };
    return { ...node, mask: converted };
  });
  // 落盘前 schema 复核（转换只动 mask 态——结构不变式仍须成立，不静默）。
  const persisted = ObjectTreeSchema.parse({
    ...tree,
    nodes,
  });
  const json = Buffer.from(JSON.stringify(persisted), 'utf8');
  const put = putTaskArtifact(deps, taskId, json);
  return { treeBlobRef: put.hash, persisted, maskBlobRefs };
}

/** object-tree 工件读回（blobRef → ObjectTree；损坏/缺 blob/schema 漂移均显式抛）。 */
export function loadObjectTreeArtifact(blobs: BlobStore, blobRef: string): ObjectTree {
  const bytes = blobs.read(blobRef);
  if (bytes === null) {
    throw new Error(`object-tree 工件不存在（blobRef=${blobRef.slice(0, 12)}…）`);
  }
  return ObjectTreeSchema.parse(JSON.parse(bytes.toString('utf8')));
}

/** 两态 mask → w*h 0/1 字节（blob 态读 BlobStore；长度/取值校验不猜测）。 */
export function resolveMaskBits(blobs: BlobStore, mask: Mask2DRef): {
  w: number;
  h: number;
  bits: Uint8Array;
} {
  if (mask.kind === 'inline') return decodeInlineMask(mask);
  const bytes = blobs.read(mask.blobRef);
  if (bytes === null) {
    throw new Error(`mask blob 不存在（blobRef=${mask.blobRef.slice(0, 12)}…）`);
  }
  if (bytes.byteLength !== mask.w * mask.h) {
    throw new RangeError(`mask blob 长度 ${bytes.byteLength} ≠ w*h=${mask.w * mask.h}`);
  }
  for (const b of bytes) {
    if (b !== 0 && b !== 1) throw new RangeError('mask blob 字节必须 ∈ {0,1}（引擎 Mask2D 同构）');
  }
  return { w: mask.w, h: mask.h, bits: bytes };
}

/** 双轨工件集（tree JSON + 叠加预览 PNG——S5「树视图」人看轨）。 */
export interface TreeArtifactBundle {
  treeBlobRef: string;
  previewBlobRef: string;
  persisted: ObjectTree;
  /** 预览角标序号↔节点对照（与 persisted.nodes 数组序一致） */
  legend: TreePreviewLegendEntry[];
  /** inline→blob 转换记录（同 persistObjectTreeArtifact） */
  maskBlobRefs: Map<string, string>;
}

/**
 * 双轨编排：持久化 object-tree + 产出树视图叠加预览图（均经 putTaskArtifact）。
 * 原图自 blobRef 读字节、codec 解码（RGBA/RGB）；tree.imagePx 与解码尺寸不符=锚点
 * 错位，显式拒（bbox 是画布坐标——不猜缩放）。预览从落盘形态（persisted）渲染——
 * 图上序号与 JSON 节点序严格一致。工件名约定（调用方 emit 用）：
 * 'object-tree.json' / 'object-tree-preview.png'（kind 字面量在 JSON 载荷内）。
 */
export function persistTreeWithPreview(
  deps: TreeArtifactDeps,
  taskId: string,
  imageBlobRef: string,
  tree: ObjectTree,
  options: PersistObjectTreeOptions = {},
): TreeArtifactBundle {
  const imageBytes = deps.blobs.read(imageBlobRef);
  if (imageBytes === null) {
    throw new Error(`原图不存在（blobRef=${imageBlobRef.slice(0, 12)}…）`);
  }
  const decoded = decodePng(imageBytes);
  if (decoded.width !== tree.imagePx.width || decoded.height !== tree.imagePx.height) {
    throw new Error(
      `tree.imagePx 与原图尺寸不符（${tree.imagePx.width}×${tree.imagePx.height} ≠ 实际 ${decoded.width}×${decoded.height}）——bbox 锚点错位，拒绝产出`,
    );
  }
  const artifact = persistObjectTreeArtifact(deps, taskId, tree, options);
  const { png, legend } = renderTreeOverlayPreview(
    { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
    artifact.persisted,
  );
  const put = putTaskArtifact(deps, taskId, png);
  return {
    treeBlobRef: artifact.treeBlobRef,
    previewBlobRef: put.hash,
    persisted: artifact.persisted,
    legend,
    maskBlobRefs: artifact.maskBlobRefs,
  };
}
