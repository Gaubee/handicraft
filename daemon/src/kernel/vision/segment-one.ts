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
import {
  SamBridge,
  SamBridgeError,
  makeSegmentRequest,
  tuneSegmentRequest,
  type SamRequestTuner,
} from './sam-bridge.js';
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
import {
  evaluateMaskQuality,
  MASK_QUALITY_DEFAULTS,
  type MaskQualityReason,
  type MaskQualityThresholds,
} from './mask-quality.js';
import {
  materializeNodeMaskPreviews,
  segmentAgentPreviewEnabled,
  segmentAgentPreviewMaxSide,
} from './agent-preview.js';
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

/**
 * hint → 子层语义名（add-workbench-pro 2.6 走查遗留：拆层子名提取）：
 * 「把帽子拆出来」→「帽子」——/把(.+?)拆|分/ 优先提取核心名词（≤12 字符——mock
 * 通道同式正则）；无匹配回退原 hint 截断（「帽子」这类直接名词提示不受影响）。
 */
export function childNameForHint(hint: string): string {
  const parsed = /把(.{1,12}?)(拆|分)/.exec(hint);
  const name = parsed?.[1] ?? hint;
  return name.slice(0, CHILD_NAME_MAX).trim() || hint.slice(0, CHILD_NAME_MAX);
}

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
}

export interface SegmentOneDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（artifact 帧登记；缺席=不登记帧，仅落工件）。 */
  jobs?: Pick<JobService, 'emitFor'>;
  /** SAM 桥（kernel 共享实例注入——队列/超时/留存全量生效；单步细分必经桥，无降级面）。 */
  bridge: Pick<SamBridge, 'run'>;
  /**
   * SAM 每请求调谐（add-image-processing-settings §5.2——kernel 装配注入
   * imageProcessingEffective(db) 投影）：本原子单次桥请求前解析（改设置对下一次
   * 拆层立即生效）。
   */
  samRequestTuner?: SamRequestTuner;
  /**
   * SAM 英文优先提示（Owner 定调 2026-10-03——segment-loop 同款）：hint 无英文
   * （中文 hint/纯中文拆层指令）时先英译再送桥；失败降级原 hint+warning（不阻塞
   * 单步细分）。命名链（childNameForHint/objectName）仍取原 hint——图层名归调用
   * 方决定，译文只进 SAM text prompt。
   */
  translateSubject?: (subject: string) => Promise<string | null>;
  /**
   * 掩膜质量门阈值（add-vision-pipeline-v2 D5——config 注入+缺省
   * MASK_QUALITY_DEFAULTS）：typed warning 不丢结果不阻断拆层。
   */
  maskQuality?: MaskQualityThresholds;
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
  // [SAM 英文优先 2026-10-03] hint 无英文字母→先英译（确定性缓存面）；译得→桥
  // text 用译文，命名链仍用原 hint；译不得→原 hint 直送+warning（可观测不阻塞）。
  let samText = hint;
  let translateFailed = false;
  if (!/[a-z]/i.test(hint) && deps.translateSubject !== undefined) {
    let translated: string | null = null;
    try {
      translated = await deps.translateSubject(hint);
    } catch {
      translated = null;
    }
    if (translated !== null && translated.trim().length > 0) {
      samText = translated.trim();
    } else {
      translateFailed = true;
    }
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
  if (translateFailed) {
    warnings.push({
      reason: 'subject-translate-failed',
      detail: `hint「${hint}」无英文且英译失败——已降级原 hint 直送 SAM（英文为主的桥提示质量可能受损，可重试或换英文措辞）`,
    });
  }
  const measure = labVarianceMeasurer(decoded); // Lab 键缓存单一实例（子节点+互斥重测量共用）

  // —— 单次 SAM segment（text+box 组合提示——PROTOCOL §4：语义概念内限定区域；
  // 父节点外接框聚焦：真桥更快更准，合成桥落点锚定父层（demo 走查实证中央落点对
  // 顶/角节点零交集→零检出无反馈））
  const parentBbox = target.bbox;
  const request = tuneSegmentRequest(
    makeSegmentRequest({
      taskId: input.taskId,
      imageBlobRef: input.imageBlobRef,
      imagePx: tree.imagePx,
      canvasCm: tree.canvasCm,
      prompt: { kind: 'text', text: samText, box: parentBbox },
      iteration: 0,
    }),
    deps.samRequestTuner,
  );
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
  /** 质量门命中（预览回流物化面——D5；child 在场时才填充） */
  const qualityFlags: Array<{ reason: MaskQualityReason; bbox: NodeBBox }> = [];
  let child: ObjectNode | undefined;
  if (childBbox !== null) {
    const localBits = cropBits(cleaned, childBbox, tree.imagePx.width);
    child = {
      id: childId,
      objectName: childNameForHint(hint),
      category: categoryForHint(hint),
      mask: encodeInlineMask(childBbox.w, childBbox.h, localBits),
      bbox: childBbox,
      parent: target.id,
      children: [],
      effectiveMm: effectiveMmOf(childBbox, ppm.pixelsPerMm),
      labVariance: measure({ bbox: childBbox, bits: localBits }),
      drillWorthy: target.drillWorthy, // 排除开关继承（策略层/用户可改——循环同款）
      // B2 归宿（realize-scene-understanding）：SAM 拆分产物=refinement 临时节点
      // （origin=refinement 来源追溯——经 tree.rename/reparent 重分类后升 semantic）
      origin: 'refinement',
      relation: 'refinement',
      // D4 抠图指令原文：调用方 hint 原文（翻译前——samText 英译只发生在 SAM 请求侧）
      segmentPrompt: hint,
    };
    // —— 掩膜质量门（add-vision-pipeline-v2 D5——子掩膜对父节点三先验：父∩子后
    //    IoU=1 即「整片父」泄漏型（右发 95×288 条带）；typed warning 不丢结果不阻断）
    for (const flag of evaluateMaskQuality(
      { bits: cleaned, bbox: childBbox, imagePx: tree.imagePx, parent: { bbox: target.bbox, bits: parentCanvas } },
      deps.maskQuality ?? MASK_QUALITY_DEFAULTS,
    )) {
      warnings.push({
        reason: flag.reason,
        detail: `「${childNameForHint(hint)}」（提示「${hint.slice(0, 40)}」）${flag.detail}`,
      });
      qualityFlags.push({ reason: flag.reason, bbox: childBbox });
    }
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
    relations: { mode: 'legacy-flat', parentIndex: [], relationOfIndex: [], orderedIndices: [] },
    pixelsPerMm: ppm.pixelsPerMm,
    maxGemDiameterMm: SEGMENT_TOOL_DEFAULT_MAX_GEM_MM,
    maxIterations: 1,
    maxNodes: SEGMENT_LOOP_MAX_NODES_DEFAULT,
    vlmReentry: false,
    elementPromptMode: 'hint',
    maskQuality: deps.maskQuality ?? MASK_QUALITY_DEFAULTS,
    singleSubject: false,
  };  const overlap = resolveSiblingOverlaps(
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
  // —— 掩膜预览回流（add-vision-pipeline-v2 D5——病态掩膜 warning 携带特写图：
  //    成本开关 SEGMENT_AGENT_MASK_PREVIEW（缺省开）；无病态=缺席字段（零成本）。
  //    AgentImagePreview.dataBase64 由 MCP 投影提升为 image content（LLM 真看图）。
  const agentImagePreviews =
    qualityFlags.length > 0 && segmentAgentPreviewEnabled()
      ? materializeNodeMaskPreviews({
          db: deps.db,
          blobs: deps.blobs,
          taskId: input.taskId,
          image: { width: decoded.width, height: decoded.height, rgba: decoded.rgba },
          flagged: qualityFlags.map(({ reason, bbox }) => ({
            nodeId: childId,
            objectName: childNameForHint(hint),
            reason,
            bbox,
            bits: cleaned,
          })),
          maxSide: segmentAgentPreviewMaxSide(),
        })
      : [];
  // 返回=契约精确面（SegmentOneOutput 四字段）——多带 persisted（整树含 inline mask）
  // 会上 JSON 线，前端 strict zod 拒收 unrecognized key（真环境走查实证）。
  return {
    children,
    treeBlobRef: bundle.treeBlobRef,
    previewBlobRef: bundle.previewBlobRef,
    warnings,
    ...(agentImagePreviews.length > 0 ? { agentImagePreviews } : {}),
  };
}
