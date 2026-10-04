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
 *   [4] resolveTreeEditImageAnchor：树编辑取图锚单源（add-flat-aux-segmentation D3
 *       ——树锚 imageBlobRef 优先，旧树无字段回退 scene-analysis 锚；树编辑面
 *       reparent/refine/merge/rename 一律经此取图，不从 scene-analysis 直取）。
 */
import {
  ObjectTreeSchema,
  SceneAnalysisSchema,
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
 * 树锚落盘（add-flat-aux-segmentation D3，2026-10-04）：树工件恒带 imageBlobRef=
 * 本函数入参（树掩膜源显式锚——persist 层单源，产树/编辑/拆层全部落盘点共用，
 * 新树恒带；旧树无字段=读侧回退语义，见 resolveTreeEditImageAnchor）。锚与树坐标
 * 天然一致（上面的尺寸校验即锚校验）。
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
  // 树锚显式化：入参 imageBlobRef 即树掩膜源（覆盖树对象可能携带的旧值——调用方
  // 传入的锚与本次尺寸校验过的图恒一致；undefined 字段吸收语义同形）。
  const anchored: ObjectTree = { ...tree, imageBlobRef };
  const artifact = persistObjectTreeArtifact(deps, taskId, anchored, options);
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

// ---------------------------------------------------------------- 树编辑取图锚（D3 单源）

/** 帧流工件帧名（latest-by-name 解析键——调用方组装 Map 后传入）。 */
export const TREE_EDIT_OBJECT_TREE_ARTIFACT_NAME = 'object-tree.json';
export const TREE_EDIT_SCENE_ANALYSIS_ARTIFACT_NAME = 'scene-analysis.json';

/** 树编辑取图锚解析结果（anchor=命中面——审计/日志可判别树锚 vs 兼容回退）。 */
export interface TreeEditImageAnchor {
  imageBlobRef: string;
  anchor: 'tree' | 'scene-analysis';
}

/**
 * 树编辑取图锚单源（add-flat-aux-segmentation D3——「树编辑一律用树锚引用」）：
 *   [1] 树锚优先：帧流电流树（object-tree.json）自带 imageBlobRef（673a87d 后
 *       persistTreeWithPreview 恒写——新树恒带）→ 直接采用。树编辑与树坐标恒同图，
 *       分析锚分叉免疫（iter-5 实证：1280 树 vs 500 分析图，旧取法在 reparent/
 *       merge 的树重落处尺寸拒）。
 *   [2] 兼容回退：旧树无字段（673a87d 前落盘）→ scene-analysis.json 的
 *       imageBlobRef（修复前行为，零迁移）。回退锚与树坐标可能分叉——沿用旧语义
 *       （同坐标任务不受影响；病态分叉旧档属历史数据面，非本层修复职责）。
 * 坏树工件（JSON 损坏/schema 漂移/锚形状非法）跳过树锚按 [2] 回退——树编辑的
 * 结构性错误由 currentTreeRef/treeInspect 主路径抛，本函数只做锚解析不越权。
 * 纯读函数：latest refs 由调用方组装（capability/rpc 各自的帧流读回实现）。
 */
export function resolveTreeEditImageAnchor(
  blobs: BlobStore,
  latestRefs: ReadonlyMap<string, string>,
): TreeEditImageAnchor | null {
  const treeRef = latestRefs.get(TREE_EDIT_OBJECT_TREE_ARTIFACT_NAME);
  if (treeRef !== undefined) {
    const bytes = blobs.read(treeRef);
    if (bytes !== null) {
      try {
        const tree = ObjectTreeSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (tree.imageBlobRef !== undefined) {
          return { imageBlobRef: tree.imageBlobRef, anchor: 'tree' };
        }
      } catch {
        // 坏树工件——回退 scene-analysis 锚（结构错误归主路径，见 doc）
      }
    }
  }
  const sceneRef = latestRefs.get(TREE_EDIT_SCENE_ANALYSIS_ARTIFACT_NAME);
  if (sceneRef === undefined) return null;
  const sceneBytes = blobs.read(sceneRef);
  if (sceneBytes === null) return null;
  try {
    const analysis = SceneAnalysisSchema.parse(JSON.parse(sceneBytes.toString('utf8')));
    return { imageBlobRef: analysis.imageBlobRef, anchor: 'scene-analysis' };
  } catch {
    return null;
  }
}
