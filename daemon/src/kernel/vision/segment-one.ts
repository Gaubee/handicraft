/**
 * segmentOne 单步细分原子（add-task-detail-layer-workbench tasks 1.2 / design
 * §segmentOne——「功能原子化的双消费面」：Agent 工具面与人类 RPC 共用同一后端原子）。
 *
 * 与 runSegmentLoop（P2.4 整循环）的关系=**组合其内部件的单步化**（design：「对指定
 * nodeId 单次细分；提示 hint 透传 SAM text 提示；沿共享 SamBridge；产子节点+mask+
 * 树更新+预览」）：
 *   - 树基态=工件读回（loadObjectTreeArtifact——不是循环的内存态；blob 态 mask 先
 *     归一 inline 再入掩码运算）；
 *   - 单次 SAM segment（后续轮循环体的桥投影同款：bridge.run + resolveMaskBits +
 *     ensureCanvasMask 全图锚点校验）；
 *   - 子节点构造=循环后续轮同款管线：父∩子位与（防掩码外溢）→ filterSmallComponents
 *     碎片清理（P2.4-hardening [3]）→ tightBBox → effectiveMm 外接矩形换算 →
 *     encodeInlineMask；category=categoryForHint 固定映射（[4]）；
 *   - 兄弟互斥=resolveSiblingOverlaps（P2.4-hardening [1]——新子与既有兄弟重叠时
 *     drillWorthy 优先/小 mask 胜出，败者削交集重算，完全吞没移出树+warning）；
 *   - 落档=persistTreeWithPreview 双轨（object-tree.json + object-tree-preview.png）
 *     + artifact 帧登记（subject.segment 同款）。
 * 不改变 subject.segment 工具面既有行为（它继续整循环——本模块零触碰其注册面）。
 * 纯度：桥/时钟经注入；无后台任务；桥失败 typed 上抛（不静默降级——降级面
 * fallbackSegment 是整循环的一键模式语义，与人类「拆这一层」的意图不符）。
 */
import { z } from 'zod';
import {
  ObjectTreeSchema,
  decodeInlineMask,
  derivePixelsPerMm,
  encodeInlineMask,
  SegmentOneInputSchema,
  type NodeBBox,
  type ObjectNode,
  type ObjectTree,
  type SegmentOneInput,
} from '@handicraft/contracts';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import type { JobService } from '../../jobs/service.js';
import { decodePng } from '../../png/codec.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import { SamBridge, SamBridgeError, makeSegmentRequest } from './sam-bridge.js';
import {
  categoryForHint,
  cropBits,
  effectiveMmOf,
  ensureCanvasMask,
  filterSmallComponents,
  maskFragmentThresholdPx,
  resolveSiblingOverlaps,
  SEGMENT_LOOP_ID_PREFIX,
  SEGMENT_LOOP_MAX_NODES_DEFAULT,
  tightBBox,
  type SegmentLoopParams,
  type SegmentLoopWarning,
} from './segment-loop.js';
import { labVarianceMeasurer, SEGMENT_TOOL_DEFAULT_MAX_GEM_MM } from './segment-tool.js';
import {
  loadObjectTreeArtifact,
  persistTreeWithPreview,
  resolveMaskBits,
  type TreeArtifactBundle,
} from './tree-persist.js';

// ---------------------------------------------------------------- 冻结常量

/** 树工件帧名（与 subject.segment emitArtifacts 同名同约定——latest-by-name 即当前树）。 */
export const OBJECT_TREE_ARTIFACT_NAME = 'object-tree.json';
export const OBJECT_TREE_PREVIEW_ARTIFACT_NAME = 'object-tree-preview.png';

/** 人类提示语义名长度上界（与 layer.rename objectName 同档——人读命名面统一界）。 */
const CHILD_NAME_MAX = 64;

// ---------------------------------------------------------------- typed error

export type SegmentOneErrorKind =
  | 'invalid-input'
  | 'image-missing'
  | 'image-decode-failed'
  | 'tree-missing'
  | 'tree-invalid'
  | 'anchor-mismatch'
  | 'node-not-found'
  | 'bridge-failure'
  | 'no-instance'
  | 'fence'
  | 'internal';

/** segmentOne 统一 typed error（沿 SubjectSegmentError kind 先例——kind 判别失败面）。 */
export class SegmentOneError extends Error {
  readonly kind: SegmentOneErrorKind;

  constructor(message: string, kind: SegmentOneErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SegmentOneError';
    this.kind = kind;
  }
}

export interface SegmentOneWarning {
  reason: string;
  detail: string;
}

export interface SegmentOneOutcome {
  children: ObjectNode[];
  treeBlobRef: string;
  previewBlobRef: string;
  warnings: SegmentOneWarning[];
  /** 树更新后的持久化形态（DFS 规范序——preview 角标与 JSON 数组序对齐）。 */
  persisted: ObjectTree;
}

export interface SegmentOneDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（artifact 帧登记；缺席=不登记帧，仅落工件）。 */
  jobs?: Pick<JobService, 'emitFor'>;
  /** SAM 桥（kernel 共享实例注入——队列/超时/留存全量生效；单步细分必经桥，无降级面）。 */
  bridge: Pick<SamBridge, 'run'>;
}

// ---------------------------------------------------------------- 内部工具

/** 树工件读回（损坏/缺 blob typed 拒——不静默）。 */
function loadTree(deps: SegmentOneDeps, treeBlobRef: string): ObjectTree {
  let tree: ObjectTree;
  try {
    tree = loadObjectTreeArtifact(deps.blobs, treeBlobRef);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new SegmentOneError(
        `object-tree 工件不符契约：${error.issues.slice(0, 3).map((i) => i.message).join('; ')}`,
        'tree-invalid',
        { cause: error },
      );
    }
    throw new SegmentOneError(
      `object-tree 工件读回失败：${error instanceof Error ? error.message : String(error)}`,
      'tree-missing',
      { cause: error },
    );
  }
  return tree;
}

/** 节点 mask 归一 inline（持久化树可能 blob 态——掩码运算/兄弟互斥先展开；写时复制）。 */
function inlineCopyOf(deps: SegmentOneDeps, node: ObjectNode): ObjectNode {
  if (node.mask.kind === 'inline') return { ...node, children: [...node.children] };
  const { w, h, bits } = resolveMaskBits(deps.blobs, node.mask);
  return { ...node, children: [...node.children], mask: encodeInlineMask(w, h, bits) };
}

/** inline 态节点 → 全图 bits（父∩子的父侧展开——循环 canvasMaskOf 的读回态变体）。 */
function canvasBitsOf(node: ObjectNode, imagePx: { width: number; height: number }): Uint8Array {
  const canvas = new Uint8Array(imagePx.width * imagePx.height);
  if (node.mask.kind !== 'inline') {
    throw new SegmentOneError(
      `掩码运算态节点 mask 必须为 inline（${node.id} 实为 ${node.mask.kind}）——内部不变式`,
      'internal',
    );
  }
  const { w, h, bits } = decodeInlineMask(node.mask);
  if (w !== node.bbox.w || h !== node.bbox.h) {
    throw new SegmentOneError(
      `节点 mask 维度 ${w}×${h} ≠ bbox ${node.bbox.w}×${node.bbox.h}（${node.id}）——工件不变式`,
      'tree-invalid',
    );
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x] === 1) canvas[(node.bbox.y + y) * imagePx.width + (node.bbox.x + x)] = 1;
    }
  }
  return canvas;
}

/** 下一个确定性节点序号（sam-node-NNNN 空间——与既有 id 不撞，max+1）。 */
function nextSeqOf(nodes: ObjectNode[]): number {
  let max = 0;
  for (const node of nodes) {
    const match = /^sam-node-(\d+)$/.exec(node.id);
    if (match !== null) max = Math.max(max, Number.parseInt(match[1]!, 10));
  }
  return max + 1;
}

function nodeIdOf(seq: number): string {
  return `${SEGMENT_LOOP_ID_PREFIX}-${String(seq).padStart(4, '0')}`;
}

// ---------------------------------------------------------------- 原子本体

/**
 * 单步细分（typed reject 或 resolve）：树工件读回 → 单次 SAM text 提示 → 父∩子 →
 * 子节点入树 → 兄弟互斥 → 双轨落档+帧登记。children 为持久化形态（mask 可能转
 * blob——inline|blob 二态契约）；零检出/完全吞没=children: [] + resolve（warnings
 * 留痕，人读面呈现），桥失败/树损坏=fence 外 typed 拒。
 */
export async function segmentOne(
  deps: SegmentOneDeps,
  rawInput: unknown,
): Promise<SegmentOneOutcome> {
  const parsed = SegmentOneInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new SegmentOneError(
      `segmentOne 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
      'invalid-input',
      { cause: parsed.error },
    );
  }
  const input: SegmentOneInput = parsed.data;
  const hint = input.hint.trim();
  if (hint.length === 0) {
    throw new SegmentOneError('hint 不能为空白（文本提示是单步细分的唯一提示源）', 'invalid-input');
  }

  const tree = loadTree(deps, input.treeBlobRef);

  // —— 原图解码+锚点（掩码交集/预览渲染的坐标系）
  const imageBytes = deps.blobs.read(input.imageBlobRef);
  if (imageBytes === null) {
    throw new SegmentOneError(
      `原图 blob 不存在（blobRef=${input.imageBlobRef.slice(0, 12)}…）`,
      'image-missing',
    );
  }
  let decoded: { width: number; height: number; rgba: Uint8Array };
  try {
    decoded = decodePng(imageBytes);
  } catch (error) {
    throw new SegmentOneError(
      `原图解码失败（仅支持 PNG——S0 归一面）：${error instanceof Error ? error.message : String(error)}`,
      'image-decode-failed',
      { cause: error },
    );
  }
  if (decoded.width !== tree.imagePx.width || decoded.height !== tree.imagePx.height) {
    throw new SegmentOneError(
      `tree.imagePx 与原图尺寸不符（${tree.imagePx.width}×${tree.imagePx.height} ≠ 实际 ${decoded.width}×${decoded.height}）——bbox 锚点错位，拒绝细分`,
      'anchor-mismatch',
    );
  }
  const ppm = derivePixelsPerMm({ canvasCm: tree.canvasCm, imagePx: tree.imagePx });
  if (!ppm.ok) {
    throw new SegmentOneError(
      `canvasCm/imagePx 纵横比不符（cm ${ppm.aspectCm} vs px ${ppm.aspectPx}，容差 2%）——尺寸声明漂移必拒`,
      'anchor-mismatch',
    );
  }

  // —— 目标节点定位+掩码归一（写时复制：输入工件字节不改）
  const nodes = tree.nodes.map((n) => inlineCopyOf(deps, n));
  const target = nodes.find((n) => n.id === input.nodeId);
  if (target === undefined) {
    throw new SegmentOneError(
      `目标节点 ${input.nodeId} 不在当前树（${nodes.length} 节点——tree 工件与 UI 视图漂移，刷新后重试）`,
      'node-not-found',
    );
  }

  const warnings: SegmentOneWarning[] = [];
  const measure = labVarianceMeasurer(decoded); // Lab 键缓存单一实例（子节点+互斥重测量共用）

  // —— 单次 SAM segment（text 提示透传；后续轮循环体的桥投影同款）
  const request = makeSegmentRequest({
    taskId: input.taskId,
    imageBlobRef: input.imageBlobRef,
    imagePx: tree.imagePx,
    canvasCm: tree.canvasCm,
    prompt: { kind: 'text', text: hint },
    iteration: 0,
  });
  let run: Awaited<ReturnType<SamBridge['run']>>;
  try {
    run = await deps.bridge.run(request);
  } catch (error) {
    if (error instanceof SamBridgeError) {
      // 桥留存写入被 fence 拒=任务不可写面（非桥故障）——kind 归 fence，调用方按任务态处置
      const kind = error.kind === 'fence' ? 'fence' : 'bridge-failure';
      throw new SegmentOneError(`SAM 桥失败（${error.kind}）：${error.message}`, kind, {
        cause: error,
      });
    }
    throw new SegmentOneError(
      `SAM 桥失败：${error instanceof Error ? error.message : String(error)}`,
      'bridge-failure',
      { cause: error },
    );
  }
  if (run.kind !== 'segment') {
    throw new SegmentOneError(
      `桥响应 kind 不匹配（期望 segment，实为 ${run.kind}）——单步细分不消费 analyze 投影`,
      'bridge-failure',
    );
  }
  if (typeof run.score !== 'number') {
    warnings.push({
      reason: 'score-missing',
      detail: `「${hint}」检出实例但桥 segment 未回 score（run1 bug-score-null 防回归——按默认置信入树）`,
    });
  }
  const maskBits = resolveMaskBits(deps.blobs, run.mask);
  ensureCanvasMask(maskBits, tree.imagePx);

  // —— 父∩子（位与防外溢）+ 碎片清理 + 紧外接（循环后续轮同款管线）
  const parentCanvas = canvasBitsOf(target, tree.imagePx);
  const inter = new Uint8Array(tree.imagePx.width * tree.imagePx.height);
  for (let i = 0; i < inter.length; i++) {
    inter[i] = maskBits.bits[i]! & parentCanvas[i]!;
  }
  const cleaned = filterSmallComponents(
    inter,
    tree.imagePx.width,
    tree.imagePx.height,
    maskFragmentThresholdPx(tree.imagePx),
  );
  const childBbox = tightBBox(cleaned, tree.imagePx.width, tree.imagePx.height);
  const seq = nextSeqOf(nodes);
  const childId = nodeIdOf(seq);
  let child: ObjectNode | undefined;
  if (childBbox !== null) {
    const localBits = cropBits(cleaned, childBbox, tree.imagePx.width);
    child = {
      id: childId,
      objectName: hint.slice(0, CHILD_NAME_MAX),
      category: categoryForHint(hint),
      mask: encodeInlineMask(childBbox.w, childBbox.h, localBits),
      bbox: childBbox,
      parent: target.id,
      children: [],
      effectiveMm: effectiveMmOf(childBbox, ppm.pixelsPerMm),
      labVariance: measure({ bbox: childBbox, bits: localBits }),
      drillWorthy: target.drillWorthy, // 排除开关继承（策略层/用户可改——循环同款）
      origin: 'vlm+sam3',
    };
    target.children.push(childId);
    nodes.push(child);
  } else {
    warnings.push({
      reason: 'no-instance',
      detail: `提示「${hint}」在「${target.objectName}」掩码内零可用实例（空掩码/全碎片）——未产生子层`,
    });
  }

  // —— 兄弟互斥消解（P2.4-hardening [1]——新子与既有兄弟重叠时胜者保留）
  const loopParams: SegmentLoopParams = {
    anchors: {
      taskId: input.taskId,
      imageBlobRef: input.imageBlobRef,
      imagePx: tree.imagePx,
      canvasCm: tree.canvasCm,
    },
    elements: [],
    pixelsPerMm: ppm.pixelsPerMm,
    maxGemDiameterMm: SEGMENT_TOOL_DEFAULT_MAX_GEM_MM,
    maxIterations: 1,
    maxNodes: SEGMENT_LOOP_MAX_NODES_DEFAULT,
    vlmReentry: false,
    elementPromptMode: 'hint',
    singleSubject: false,
  };
  const overlap = resolveSiblingOverlaps(
    nodes,
    loopParams,
    (region: { bbox: NodeBBox; bits: Uint8Array }) => measure(region),
    0,
  );
  for (const w of overlap.warnings as SegmentLoopWarning[]) {
    warnings.push({ reason: w.reason, detail: w.detail });
  }
  if (child !== undefined && overlap.consumed.has(child.id)) {
    warnings.push({
      reason: 'child-consumed',
      detail: `新子层「${child.objectName}」掩码被兄弟完全吞没——本次细分未入树（换更具体的提示重试）`,
    });
    child = undefined;
  }

  // —— 树终验+落档+帧登记（结构不变式由 schema 把守——互斥消解后必复核）
  let updated: ObjectTree;
  try {
    updated = ObjectTreeSchema.parse({ ...tree, nodes });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new SegmentOneError(
        `细分后树不符契约：${error.issues.slice(0, 3).map((i) => i.message).join('; ')}`,
        'internal',
        { cause: error },
      );
    }
    throw error;
  }
  let bundle: TreeArtifactBundle;
  try {
    bundle = persistTreeWithPreview({ db: deps.db, blobs: deps.blobs }, input.taskId, input.imageBlobRef, updated);
  } catch (error) {
    if (error instanceof ArtifactFenceError) {
      throw new SegmentOneError(
        `object-tree 工件写入被 fence 拒绝（任务 ${input.taskId} 已不可写）：${error.message}`,
        'fence',
        { cause: error },
      );
    }
    throw new SegmentOneError(
      `object-tree 工件落档失败：${error instanceof Error ? error.message : String(error)}`,
      'internal',
      { cause: error },
    );
  }
  deps.jobs?.emitFor(input.taskId, 'artifact', { blobRef: bundle.treeBlobRef, name: OBJECT_TREE_ARTIFACT_NAME });
  deps.jobs?.emitFor(input.taskId, 'artifact', { blobRef: bundle.previewBlobRef, name: OBJECT_TREE_PREVIEW_ARTIFACT_NAME });

  const children = child !== undefined
    ? bundle.persisted.nodes.filter((n) => n.id === child.id)
    : [];
  return {
    children,
    treeBlobRef: bundle.treeBlobRef,
    previewBlobRef: bundle.previewBlobRef,
    warnings,
    persisted: bundle.persisted,
  };
}
