/**
 * 迭代抠图循环 subject.segment（add-subject-sam-pipeline P2.4 / design §1 S3+S4、§2）。
 * 决策源：owner-directive 主文（VLM 先行→SAM3 迭代语义抠图；首轮=VLM 提及的关键元素，
 * 后续轮=宽泛语义；停止两面：~5mm×5mm 不再细分 / 色容差不高的范围内容停；SAM3
 * 自认「没必要拆」更佳）+ design §9 回流 5（实测主停止器=判据 3「模型不再返回新实例」）。
 *
 * 状态机形态：显式 state{nodes, frontier, sealed, iter} + 纯转移 step(state)→state'——
 * 依赖全注入（桥 segment/analyze 投影、Lab 色方差测量、时钟），单测全 mock、可回放
 * （同 deps 脚本 ⇒ 同请求序同产物，确定性测试覆盖）。runSegmentLoop=init→step*→
 * finalize 编排；onStep 回调=循环层留存注入面（ObjectTree 演化 meta——mask/叠加留存
 * 归桥层 P2.2，本层不重复留）。
 * 正交意图：
 *   [1] 首轮（iter=0）：SceneAnalysis.elements 逐元素桥 segment——几何提示=box 中心
 *       include 点+box（P2.2 协议 points≥1，中心点=box 语义锚）；能力降级=文本提示
 *       （elementPromptMode='hint'，用 element.hint——桥几何面不可用时）。
 *   [2] 后续轮（iter≥1）：frontier 未停节点宽泛语义提示 broadSemanticPrompt（父名+
 *       「整体」类泛化，深度分层措辞）→子节点挂树；子 mask=父 mask∩子 mask（位与
 *       运算——防 design §9 回流 3 掩码外溢）；vlmReentry 接口位（默认 false：不回
 *       VLM 重述；true 时走桥 analyze 重新描述精化提示——仅接口接线，VLM 真连/调参
 *       归 P2.6/P4.1，本层不直连任何模型）。
 *   [3] 停止判据内嵌：每节点每轮后 evaluateStopCriteria（P0.3）→stop 即封叶出
 *       frontier；轮开始硬顶前置检查（iteration≥max 或节点数≥maxNodes ⇒ 全封停，
 *       不把注定封停的请求送上线）；maxIterations 缺省=画布面积标定公式（下）。
 *   [4] 产 ObjectTree（P0.1 schema 终验）：多主体→根=画布（结构性容器：全画布 mask、
 *       drillWorthy=false——tree-to-blocks producesBlock 语义=不产块）；单主体→根=
 *       该主体（design「单主体树」）。mask 均为 bbox 局部且维度=bbox 维度（P0.2
 *       tree-to-blocks 可直喂——mask-dims-mismatch 由构造排除）。
 * 语义裁定（偏差已列任务报告）：
 *   [a] effectiveMm=√(bbox.w×bbox.h)/pixelsPerMm（外接矩形换算，全树一致——任务定调
 *       「首轮=box 换算」；contracts 注释字面为「mask 面积开方」）。理由：细长结构
 *       （柳枝/缎带）按 popcount 开方会低估物理延展导致早停；外接矩形=保守上界
 *       （≥面积开方——宁迟停不早停，细分过头可后收，漏拆不可逆）。
 *   [b] 首轮节点 bbox=响应掩码的紧外接矩形（SAM 产物为真源；VLM boxPx 只作几何提示，
 *       二者外溢时以模型掩码为准——不反向裁模型）。
 *   [c] low-score（score<SEGMENT_LOOP_LOW_SCORE）=弱实例**不入树**（防 §9 回流 3
 *       语义过宽类垃圾节点）+父节点按判据 3 判停。
 *   [d] 桥 segment 掩码必须与 imagePx 同维（全图坐标锚点——请求携全图，掩码按全图
 *       坐标；不猜裁剪/缩放，维度不符 typed 拒）。
 * 纯度纪律：无 IO/无随机/无时钟（now 注入）；onStep 仅观察不影响转移；桥失败不静默
 * 吞（typed 桥错误上抛——降级归 P2.5 工具层裁量）。
 *
 * P2.4-hardening（vision 真连审查回流 2026-09-25——experiments/sam3-live-20260925：
 * person∩hat=16,334px 占 hat 掩膜 36.3% 兄弟重叠无消解 / person 35% 画幅非
 * drillWorthy 且无子节点=无钻贴路径 / person 掩膜约 90 碎片 ≤200px）：
 *   [1] 兄弟掩膜互斥：同层兄弟两两相交时 drillWorthy 优先保留、次以小 maskPx 胜出
 *       ——交集从败者位与清零+重算 bbox/effectiveMm/labVariance；败者归零=完全吞没
 *       →移出树+warning{sibling-overlap-consumed}（其子节点移交祖辈保树闭合）。
 *   [2] frontier 强制细分：非 drillWorthy 且 effectiveMm>最大钻径×3 的大块不得
 *       sealed（审查口径：大块非钻层不细分=其内部钻贴路径全断）——硬顶内持续细分，
 *       硬顶截断时 warning{depth-cap-unresolved} 显式留痕未解决大块。
 *   [3] 掩膜碎片清理：入树前连通域面积过滤（≤max(200px, 0.05%×画幅) 连通片剔除；
 *       审查口径 3px 闭运算按「简化实现即可」豁免——仅面积过滤）。
 *   [4] hint→category 固定映射：常见英文 hint→规范 category 常量表+未知透传 hint
 *       本身（消除 face/subject 随机兜底；VLM 显式 category 仍优先）。
 *   [5] score 非空门禁：检出节点 score 缺失（含运行时 null）→warning{score-missing}
 *       （run1 bug-score-null 防回归）；零检出照旧 no-instance 不入树。
 *   警告落点：SegmentLoopResult.warnings+逐步 meta（ObjectNode schema 为 strict 且
 *   contracts 非本层写权——警告面在循环层，不入侵树 schema）。
 */
import {
  ObjectTreeSchema,
  decodeInlineMask,
  derivePixelsPerMm,
  encodeInlineMask,
  type CanvasCm,
  type ImagePx,
  type NodeBBox,
  type NodeId,
  type ObjectNode,
  type ObjectTree,
  type SceneElement,
} from '@handicraft/contracts';
import {
  makeAnalyzeRequest,
  makeSegmentRequest,
  type SamAnalyzeRequest,
  type SamPrompt,
  type SamSegmentRequest,
} from './sam-bridge.js';
import {
  evaluateStopCriteria,
  type ModelSignal,
  type StopReason,
  type StopVerdict,
} from './stop-criteria.js';

// ---------------------------------------------------------------- 具名常量与硬顶公式

/**
 * 弱实例分数界（§2 判据 3 low-score 输入）：SAM3 返回 score<0.5 的实例视为半信半疑
 * ——不入树且父分支判停（实测校准前的中位界，P4.1 部件级分解实测后调整）。
 */
export const SEGMENT_LOOP_LOW_SCORE = 0.5;

/** 全局节点数硬顶缺省（design §2 判据 4「全局节点数上限」；实验实测 19 节点/图——256=一个量级余量）。 */
export const SEGMENT_LOOP_MAX_NODES_DEFAULT = 256;

/** 节点 id 前缀（顺序分配——确定性；id=引擎 blockId 同寻址空间，contracts NodeId）。 */
export const SEGMENT_LOOP_ID_PREFIX = 'sam-node';

/**
 * 强制细分系数（P2.4-hardening [2]）：非 drillWorthy 节点 effectiveMm > 最大钻径×
 * 本系数 ⇒ 不得 sealed（审查回流：person 35% 画幅非钻层且无子节点——大块非钻层
 * 不细分=其内部（帽/脸等可钻件）钻贴路径全断；×3 与判据 1 的 K=2.5 之间留出
 * （2.5×, 3×] 缓冲带——刚过判据 1 阈的小块允许正常判停）。
 */
export const SEGMENT_LOOP_FRONTIER_FORCE_FACTOR = 3;

/** 碎片连通片剔除下限（px）——P2.4-hardening [3] 审查口径（person 掩膜 90 碎片 ≤200px）。 */
export const MASK_FRAGMENT_MIN_PX_FLOOR = 200;

/** 碎片连通片剔除的画幅比例（0.05%×画幅——与下限取大者）。 */
export const MASK_FRAGMENT_CANVAS_RATIO = 0.0005;

/**
 * 常见英文 hint → 规范 category 固定映射（P2.4-hardening [4]——消除 face/subject
 * 随机兜底；键=hint trim+lowercase 全串精确匹配，未知透传 hint 本身。规范值与
 * SceneElement.category 同词表（structure/foliage/face/light/…——P4.1 版本化前对齐）。
 */
export const HINT_CATEGORY_MAP: Readonly<Record<string, string>> = {
  person: 'person', man: 'person', woman: 'person', boy: 'person', girl: 'person',
  people: 'person', human: 'person',
  face: 'face', eye: 'face', mouth: 'face', nose: 'face',
  hat: 'hat', cap: 'hat',
  hair: 'hair',
  tree: 'tree', 'christmas tree': 'tree', willow: 'tree', pine: 'tree', branch: 'branch',
  flower: 'flower', rose: 'flower',
  leaf: 'foliage', leaves: 'foliage', foliage: 'foliage',
  grass: 'grass', grassland: 'grass',
  sky: 'sky', cloud: 'cloud',
  sun: 'light', moon: 'light', streetlight: 'light', lamp: 'light',
  house: 'structure', building: 'structure', bridge: 'structure', fence: 'structure',
  road: 'ground', street: 'ground', path: 'ground',
};

/**
 * hint → category 解析（确定性纯函数）：映射表精确匹配（trim+lowercase）→命中返规范
 * category；未知透传 hint 本身（trim 原样——保留可读语义，不发明随机兜底）；空 hint
 * 返 'subject'（词表 P4.1 版本化前的中性兜底——与旧行为一致）。
 */
export function categoryForHint(hint: string): string {
  const key = hint.trim().toLowerCase();
  if (key.length === 0) return 'subject';
  return HINT_CATEGORY_MAP[key] ?? hint.trim();
}

/**
 * 碎片清理阈值=⌈max(200px, 0.05%×画幅)⌉（P2.4-hardening [3]；736×736 实拍→271px、
 * 800×800→320px、1024×1024→524px——实测 90 碎片 ≤200px 全落在阈值下）。
 */
export function maskFragmentThresholdPx(imagePx: ImagePx): number {
  return Math.max(
    MASK_FRAGMENT_MIN_PX_FLOOR,
    Math.ceil(imagePx.width * imagePx.height * MASK_FRAGMENT_CANVAS_RATIO),
  );
}

/** 面积标定分母（cm²/轮）：100cm²≈10cm×10cm——典型小件画幅一档。 */
const MAX_ITER_AREA_CM2 = 100;

/** 面积标定基线轮数：首轮元素轮+至少一次细分+收尾判停轮。 */
const MAX_ITER_BASE = 2;

/**
 * 迭代硬顶=画布面积标定（owner 原话「硬性地控制最大迭代数，比如说根据尺寸」+
 * design §2 判据 4「默认按画布面积标定」）：
 *   maxIterations = ⌈面积cm² / 100⌉ + 2
 * 理由：细分预算应正比于**内容量**而非边长（面积对双轴同权——20×30 与 30×20 同预算）；
 * 每 100cm²（≈10cm×10cm 档小件画幅）配一轮细分；+2 保底=首轮（S2 元素）+至少一轮
 * 宽泛语义细分+收尾判停，极小画布也有完整三轮结构。例：8×8cm→3、20×30cm→8、
 * 40×50cm→22。可与 maxGemDiameterMm 同源随钻规格表收紧（显式传参覆盖）。
 */
export function maxIterationsForCanvas(canvasCm: CanvasCm): number {
  return Math.ceil((canvasCm.w * canvasCm.h) / MAX_ITER_AREA_CM2) + MAX_ITER_BASE;
}

// ---------------------------------------------------------------- 提示模板

/**
 * 宽泛语义提示模板（owner：第二轮起「给他一个宽泛的语义，他就能抠出来一些零碎的
 * 内容」；任务定调：父名+「整体」类泛化，入参节点名/层级）。
 * - 英文 hint 优先（spike 实证 person/hat 类英文语义词最稳——SceneElement.hint 语义
 *   同源；vlmReentry 精化后的 hint 同样走此分支）；
 * - 无 hint 用中文 objectName 兜底（后续轮子节点无英文hint 时的常态）；
 * - 深度分层措辞：浅层问组成部分、中层问更细部件、深层问纹理结构（owner 贴钻语境：
 *   越深越接近「纹理贴图法」的对象粒度）。
 * 纯函数：确定性（同输入同输出）。
 */
export function broadSemanticPrompt(input: {
  objectName: string;
  depth: number;
  hint?: string;
}): string {
  const hint = input.hint?.trim();
  const subject = hint && hint.length > 0 ? hint : input.objectName.trim();
  if (hint && hint.length > 0) {
    const qualifier =
      input.depth <= 1
        ? 'all its component parts'
        : input.depth === 2
          ? 'finer sub-parts and details'
          : 'fine texture and structure';
    return `${subject} as a whole, including ${qualifier}`;
  }
  const qualifier =
    input.depth <= 1 ? '全部组成部分' : input.depth === 2 ? '更细的部件与细节' : '纹理与细微结构';
  return `${subject}整体，包括${qualifier}`;
}

/**
 * vlmReentry 重新描述提示（桥 analyze 文本指令——接口位模板；VLM 真实输出质量归
 * P2.3/P2.6，本层只消费 elements[].hint 精化 broadSemanticPrompt）。
 */
export function redescribePrompt(objectName: string): string {
  return `重新描述画面中「${objectName}」所在区域：列出其可见组成部分，每项给出中文名、英文语义提示（hint）与位置框`;
}

// ---------------------------------------------------------------- 注入依赖面

/** 桥 segment 投影结果（P2.2 SamSegmentRunResult 的窄面——mask 已解析为 bits；循环不关心队列/留存/meta）。 */
export interface SegmentBridgeOutcome {
  /** 全图坐标掩码（w*h= imagePx 同维——裁定 [d]） */
  mask: { w: number; h: number; bits: Uint8Array };
  score?: number;
}

/** 桥 analyze 投影结果（SamAnalyzeRunResult 的窄面——elements 同构）。 */
export interface AnalyzeBridgeOutcome {
  elements: SceneElement[];
}

/**
 * 循环依赖注入面（纯状态机的全部外界触点）：
 * - segment：单次抠图（真实装配=SamBridge.run + resolveMaskBits——工具层职责，测试全 mock）；
 * - analyze：vlmReentry=true 时必需（接口位——默认不调用）；
 * - measureLabVariance：节点内 Lab 色方差（ΔE76 量纲——判据 2 输入；原图 Lab 管线
 *   投影注入，循环保持零图像依赖）；
 * - now：终态 createdAt 时钟（确定性测试注入固定值）。
 */
export interface SegmentLoopDeps {
  segment: (request: SamSegmentRequest) => Promise<SegmentBridgeOutcome>;
  analyze?: (request: SamAnalyzeRequest) => Promise<AnalyzeBridgeOutcome>;
  measureLabVariance: (region: { bbox: NodeBBox; bits: Uint8Array }) => number;
  now?: () => string;
}

// ---------------------------------------------------------------- 输入面

export interface SegmentLoopOptions {
  taskId: string;
  imageBlobRef: string;
  imagePx: ImagePx;
  canvasCm: CanvasCm;
  /** S2 元素清单（P2.3 scene.analyze 产物或调用方注入） */
  elements: readonly SceneElement[];
  /** 钻规格表最大钻径 mm（判据 1 阈值=K×此值——随规格表取值） */
  maxGemDiameterMm: number;
  sizeFactorK?: number;
  deltaEThreshold?: number;
  /** 迭代硬顶——缺省 maxIterationsForCanvas(canvasCm)（面积标定公式） */
  maxIterations?: number;
  /** 全局节点数硬顶——缺省 SEGMENT_LOOP_MAX_NODES_DEFAULT */
  maxNodes?: number;
  /** VLM 复入（design §2「后续轮 VLM 复入位」——Owner 中立待实测，默认 false） */
  vlmReentry?: boolean;
  /** 首轮元素提示面：'box'=几何提示（缺省）/'hint'=文本降级（桥几何面不可用） */
  elementPromptMode?: 'box' | 'hint';
  /** 每步演化 meta 留存回调（注入面——仅观察，不影响转移） */
  onStep?: (meta: SegmentLoopStepMeta) => void;
}

/** 解析后参数（init 一次、step/finalize 复用——转移函数不再触 options）。 */
export interface SegmentLoopParams {
  anchors: { taskId: string; imageBlobRef: string; imagePx: ImagePx; canvasCm: CanvasCm };
  elements: readonly SceneElement[];
  pixelsPerMm: number;
  maxGemDiameterMm: number;
  sizeFactorK?: number;
  deltaEThreshold?: number;
  maxIterations: number;
  maxNodes: number;
  vlmReentry: boolean;
  elementPromptMode: 'box' | 'hint';
  /** 单主体树标记（finalize 根裁定+深度偏移共用） */
  singleSubject: boolean;
  onStep?: (meta: SegmentLoopStepMeta) => void;
}

export interface SegmentLoopContext {
  deps: SegmentLoopDeps;
  params: SegmentLoopParams;
}

// ---------------------------------------------------------------- 演化 meta（留存回调面）

/**
 * 加固警告（P2.4-hardening——审查回流显式留痕面；ObjectNode schema 为 strict 且
 * contracts 非循环层写权，警告挂循环结果/逐步 meta，不入侵树 schema）。
 */
export type SegmentLoopWarningReason =
  /** 兄弟掩膜互斥中败者被完全吞没（移出树——[1]） */
  | 'sibling-overlap-consumed'
  /** 硬顶截断时非钻层大块（>最大钻径×3）仍未细分解决（[2]） */
  | 'depth-cap-unresolved'
  /** 检出节点 score 缺失（run1 bug-score-null 防回归——[5]） */
  | 'score-missing';

export interface SegmentLoopWarning {
  nodeId: NodeId;
  reason: SegmentLoopWarningReason;
  /** 事件轮次（0 基） */
  iter: number;
  /** 确定性人读细节（胜者/重叠 px/尺寸等——同输入同输出） */
  detail: string;
}

/** 单请求逐节点记录（首轮 target=元素名标记；后续轮=节点 id）。 */
export interface SegmentLoopRoundEntry {
  target: string;
  promptKind: 'box' | 'text';
  outcome: 'node-created' | 'child-created' | 'no-instance' | 'no-new-instance' | 'low-score';
  /** 产出节点（首轮）/子节点（后续轮）；无产出缺省 */
  nodeId?: NodeId;
  /** 判据 3 输入信号（meta 审查面——§9 判据 3 为主停止器的观测位） */
  modelSignal: ModelSignal;
}

/** 每步（=每轮）演化 meta——onStep 留存回调载荷（「输出留存可审查」循环层轨道）。 */
export interface SegmentLoopStepMeta {
  /** 本轮轮次（0 基） */
  iter: number;
  entries: SegmentLoopRoundEntry[];
  /** 本轮封停节点（nodeId→触发原因全列——判定报告数据面） */
  sealed: Array<{ nodeId: NodeId; reasons: StopReason[] }>;
  /** 步后树形态摘要 */
  nodesAfter: number;
  frontierAfter: number;
  nodeIdsAfter: NodeId[];
  /** 本步发出的加固警告（P2.4-hardening——审计面；终态汇入 result.warnings） */
  warnings: SegmentLoopWarning[];
}

// ---------------------------------------------------------------- 状态机

/** 循环显式状态（可序列化回放——mask 为 inline 态 JSON 安全；nodes 多根=finalize 前常态）。 */
export interface SegmentLoopState {
  /** 轮次（0 基；0=首轮元素轮） */
  iter: number;
  nodes: ObjectNode[];
  /** 未停节点（细分候选；序=创建序——确定性） */
  frontier: NodeId[];
  /** 已封停节点 verdict（封叶面；出 frontier 即不可逆） */
  sealed: Record<NodeId, StopVerdict>;
  /** 节点英文语义提示（元素 hint 入态；vlmReentry 精化覆写——ObjectNode 无此字段，态内随行） */
  hints: Record<NodeId, string>;
  /** 下一节点序号（确定性 id 源） */
  nextSeq: number;
  /** 演化 meta 序列（终态随结果返回） */
  history: SegmentLoopStepMeta[];
  /** 加固警告累积（P2.4-hardening——终态随结果返回） */
  warnings: SegmentLoopWarning[];
}

export interface SegmentLoopResult {
  tree: ObjectTree;
  /** 执行轮数（=history.length，首轮含内） */
  iterations: number;
  totalNodes: number;
  /** 封停原因表（nodeId→reasons；结构性画布根不在封停面） */
  sealedByNode: Record<NodeId, StopReason[]>;
  /** 演化 meta（onStep 同构——审计/回放面） */
  history: SegmentLoopStepMeta[];
  /** 加固警告全列（P2.4-hardening：兄弟吞没/硬顶未解大块/score 缺失） */
  warnings: SegmentLoopWarning[];
}

// ---------------------------------------------------------------- typed error

export type SegmentLoopErrorKind =
  | 'aspect-mismatch'
  | 'bad-option'
  | 'vlm-reentry-unavailable'
  | 'bridge-failure'
  | 'bad-mask'
  | 'no-instances'
  | 'internal';

/** 循环面统一 typed error（沿 SamBridgeError kind 先例——kind 判别失败面）。 */
export class SegmentLoopError extends Error {
  readonly kind: SegmentLoopErrorKind;

  constructor(message: string, kind: SegmentLoopErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SegmentLoopError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- 内部工具

function nodeIdOf(seq: number): NodeId {
  return `${SEGMENT_LOOP_ID_PREFIX}-${String(seq).padStart(4, '0')}`;
}

function ensurePositiveOption(name: string, v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) {
    throw new SegmentLoopError(`${name} 必须为正有限数（实为 ${v}）——驱动循环的参数不允许猜测兜底`, 'bad-option');
  }
  return v;
}

/** 桥掩码全图锚点校验（裁定 [d]）+字节合法性（长度=w*h、值∈{0,1}——不信任注入面）。 */
function ensureCanvasMask(mask: { w: number; h: number; bits: Uint8Array }, imagePx: ImagePx): void {
  if (mask.w !== imagePx.width || mask.h !== imagePx.height) {
    throw new SegmentLoopError(
      `桥 segment 掩码维度 ${mask.w}×${mask.h} ≠ 画布 ${imagePx.width}×${imagePx.height}（全图坐标锚点——不猜裁剪/缩放）`,
      'bad-mask',
    );
  }
  if (mask.bits.length !== mask.w * mask.h) {
    throw new SegmentLoopError(`掩码 bits 长度 ${mask.bits.length} ≠ w*h=${mask.w * mask.h}`, 'bad-mask');
  }
  for (const b of mask.bits) {
    if (b !== 0 && b !== 1) {
      throw new SegmentLoopError('掩码字节必须 ∈ {0,1}（引擎 Mask2D 同构）', 'bad-mask');
    }
  }
}

/** 全图 bits 的紧外接矩形（空掩码=null）。 */
function tightBBox(bits: Uint8Array, w: number, h: number): NodeBBox | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x] !== 1) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 全图 bits → bbox 局部 bits（构造保证 bbox 在界内）。 */
function cropBits(canvasBits: Uint8Array, bbox: NodeBBox, canvasW: number): Uint8Array {
  const out = new Uint8Array(bbox.w * bbox.h);
  for (let y = 0; y < bbox.h; y++) {
    for (let x = 0; x < bbox.w; x++) {
      out[y * bbox.w + x] = canvasBits[(bbox.y + y) * canvasW + (bbox.x + x)];
    }
  }
  return out;
}

/** 节点 bbox 局部 mask → 全图 bits（父∩子位与的父侧展开；维度≠bbox=内部不变式破坏）。 */
function canvasMaskOf(node: ObjectNode, imagePx: ImagePx): Uint8Array {
  if (node.mask.kind !== 'inline') {
    throw new SegmentLoopError(
      `循环态节点 mask 必须为 inline 态（${node.id} 实为 ${node.mask.kind}）——态构造不变式`,
      'internal',
    );
  }
  const { w, h, bits } = decodeInlineMask(node.mask);
  if (w !== node.bbox.w || h !== node.bbox.h) {
    throw new SegmentLoopError(
      `节点 mask 维度 ${w}×${h} ≠ bbox ${node.bbox.w}×${node.bbox.h}（${node.id}）——态构造不变式`,
      'internal',
    );
  }
  const canvas = new Uint8Array(imagePx.width * imagePx.height);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x] === 1) canvas[(node.bbox.y + y) * imagePx.width + (node.bbox.x + x)] = 1;
    }
  }
  return canvas;
}

/** effectiveMm=√(bbox.w×bbox.h)/pixelsPerMm（裁定 [a]——外接矩形换算，保守上界）。 */
function effectiveMmOf(bbox: NodeBBox, pixelsPerMm: number): number {
  return Math.sqrt(bbox.w * bbox.h) / pixelsPerMm;
}

/** bits 置位数（maskPx——兄弟消解胜者裁定/断言面）。 */
function popcountOf(bits: Uint8Array): number {
  let n = 0;
  for (let k = 0; k < bits.length; k++) n += bits[k]!;
  return n;
}

/** 两 bbox 是否相交（兄弟消解快筛——O(1) 前置于像素级判定）。 */
function bboxIntersects(a: NodeBBox, b: NodeBBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * 连通域面积过滤（P2.4-hardening [3] 简化实现：4-连通 BFS，<minPx 连通片剔除；
 * 审查口径的 3px 闭运算按「简化实现即可」豁免——针孔不跨连通片拆分主体，面积过滤
 * 已覆盖实测 90 碎片场景）。纯函数：返回清理后新 bits（输入不改）。
 */
function filterSmallComponents(bits: Uint8Array, w: number, h: number, minPx: number): Uint8Array {
  const total = bits.length;
  const out = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const component: number[] = [];
  for (let start = 0; start < total; start++) {
    if (bits[start] !== 1 || visited[start] === 1) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;
    component.length = 0;
    component.push(start);
    while (head < tail) {
      const idx = queue[head++]!;
      const x = idx % w;
      const y = (idx - x) / w;
      if (x > 0 && bits[idx - 1] === 1 && visited[idx - 1] === 0) {
        visited[idx - 1] = 1;
        queue[tail++] = idx - 1;
        component.push(idx - 1);
      }
      if (x < w - 1 && bits[idx + 1] === 1 && visited[idx + 1] === 0) {
        visited[idx + 1] = 1;
        queue[tail++] = idx + 1;
        component.push(idx + 1);
      }
      if (y > 0 && bits[idx - w] === 1 && visited[idx - w] === 0) {
        visited[idx - w] = 1;
        queue[tail++] = idx - w;
        component.push(idx - w);
      }
      if (y < h - 1 && bits[idx + w] === 1 && visited[idx + w] === 0) {
        visited[idx + w] = 1;
        queue[tail++] = idx + w;
        component.push(idx + w);
      }
    }
    if (component.length >= minPx) {
      for (const idx of component) out[idx] = 1;
    }
  }
  return out;
}

/** 强制细分裁定（P2.4-hardening [2]）：非钻层大块（>最大钻径×系数）不得 sealed。 */
function isForcedFrontier(node: ObjectNode, params: SegmentLoopParams): boolean {
  return (
    !node.drillWorthy &&
    node.effectiveMm > params.maxGemDiameterMm * SEGMENT_LOOP_FRONTIER_FORCE_FACTOR
  );
}

/**
 * 兄弟掩膜互斥消解（P2.4-hardening [1]——每步末对全树同层兄弟组两两消解）：
 * - 胜者裁定：drillWorthy 优先保留；同为 worthy/非 worthy ⇒ 小 maskPx 胜出；全同 ⇒
 *   创建序早者（确定性）；
 * - 败者处置：交集位与清零→重算紧 bbox/mask/effectiveMm/labVariance（重测量走注入
 *   面——仅实际被削的节点）；归零=完全吞没→移出父 children+frontier/sealed 面+子节点
 *   移交祖辈（保树闭合），warning{sibling-overlap-consumed} 留痕；
 * - 多遍收敛：吞没移交的子节点入新兄弟组，重复直至稳定（总置位像素单调递减 ⇒ 必终止；
 *   遍数上限=节点数+1 兜底）。nodes 为步内写时复制件（就地改不污输入态）。
 */
function resolveSiblingOverlaps(
  nodes: ObjectNode[],
  params: SegmentLoopParams,
  measure: SegmentLoopDeps['measureLabVariance'],
  iter: number,
): { warnings: SegmentLoopWarning[]; consumed: Set<NodeId> } {
  const warnings: SegmentLoopWarning[] = [];
  const consumed = new Set<NodeId>();
  const { width, height } = params.anchors.imagePx;
  const canvasCache = new Map<NodeId, Uint8Array>();
  const canvasOf = (node: ObjectNode): Uint8Array => {
    const hit = canvasCache.get(node.id);
    if (hit !== undefined) return hit;
    const canvas = canvasMaskOf(node, params.anchors.imagePx);
    canvasCache.set(node.id, canvas);
    return canvas;
  };
  const byId = () => new Map<NodeId, ObjectNode>(nodes.map((n) => [n.id, n] as const));

  let changed = true;
  for (let pass = 0; changed && pass <= nodes.length + 1; pass++) {
    changed = false;
    // 兄弟分组快照（键=parent id；consumed 者出局；组内序=创建序）
    const groups = new Map<string, ObjectNode[]>();
    for (const n of nodes) {
      if (consumed.has(n.id)) continue;
      const key = n.parent ?? '\u0000root';
      const group = groups.get(key);
      if (group === undefined) groups.set(key, [n]);
      else group.push(n);
    }
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i++) {
        for (let j = i + 1; j < group.length; j++) {
          const a = group[i]!;
          const b = group[j]!;
          if (consumed.has(a.id) || consumed.has(b.id)) continue;
          if (!bboxIntersects(a.bbox, b.bbox)) continue;
          const canvasA = canvasOf(a);
          const canvasB = canvasOf(b);
          let overlapPx = 0;
          for (let k = 0; k < canvasA.length; k++) {
            if (canvasA[k] === 1 && canvasB[k] === 1) overlapPx++;
          }
          if (overlapPx === 0) continue;
          const aWins =
            a.drillWorthy !== b.drillWorthy
              ? a.drillWorthy
              : popcountOf(canvasA) !== popcountOf(canvasB)
                ? popcountOf(canvasA) < popcountOf(canvasB)
                : true;
          const winner = aWins ? a : b;
          const loser = aWins ? b : a;
          const loserCanvas = aWins ? canvasB : canvasA;
          const winnerCanvas = aWins ? canvasA : canvasB;
          for (let k = 0; k < loserCanvas.length; k++) {
            if (loserCanvas[k] === 1 && winnerCanvas[k] === 1) loserCanvas[k] = 0;
          }
          if (popcountOf(loserCanvas) === 0) {
            consumed.add(loser.id);
            canvasCache.delete(loser.id);
            const lookup = byId();
            const grand = loser.parent === null ? undefined : lookup.get(loser.parent);
            if (grand !== undefined) {
              grand.children = grand.children.filter((id) => id !== loser.id);
            }
            for (const childId of loser.children) {
              const child = lookup.get(childId);
              if (child === undefined) {
                throw new SegmentLoopError(
                  `兄弟消解子节点缺失（${childId}）——态构造不变式`,
                  'internal',
                );
              }
              child.parent = loser.parent; // 移交祖辈（null=顶层根——finalize 画布根收口）
              if (grand !== undefined) grand.children.push(childId);
            }
            loser.children = [];
            warnings.push({
              nodeId: loser.id,
              reason: 'sibling-overlap-consumed',
              iter,
              detail: `「${loser.objectName}」掩膜被兄弟「${winner.objectName}」(${winner.id}) 完全吞没（重叠 ${overlapPx}px）——移出树`,
            });
          } else {
            const bbox = tightBBox(loserCanvas, width, height);
            if (bbox === null) {
              throw new SegmentLoopError(
                `兄弟消解后败者掩膜非零但紧外接为空（${loser.id}）——内部不变式`,
                'internal',
              );
            }
            const localBits = cropBits(loserCanvas, bbox, width);
            loser.mask = encodeInlineMask(bbox.w, bbox.h, localBits);
            loser.bbox = bbox;
            loser.effectiveMm = effectiveMmOf(bbox, params.pixelsPerMm);
            loser.labVariance = measure({ bbox, bits: localBits });
            canvasCache.set(loser.id, loserCanvas);
          }
          changed = true;
        }
      }
    }
  }
  // 完全吞没者出 nodes 数组（树闭合：ObjectTreeSchema parent/children 双向校验不容孤儿）
  if (consumed.size > 0) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (consumed.has(nodes[i]!.id)) nodes.splice(i, 1);
    }
  }
  return { warnings, consumed };
}

/** 节点判据评估（参数装包+evaluateStopCriteria（P0.3）委托）。 */
function verdictFor(
  node: ObjectNode,
  modelSignal: ModelSignal,
  iteration: number,
  totalNodes: number,
  params: SegmentLoopParams,
): StopVerdict {
  return evaluateStopCriteria(
    { effectiveMm: node.effectiveMm, labVariance: node.labVariance },
    {
      maxGemDiameterMm: params.maxGemDiameterMm,
      ...(params.sizeFactorK !== undefined ? { sizeFactorK: params.sizeFactorK } : {}),
      ...(params.deltaEThreshold !== undefined ? { deltaEThreshold: params.deltaEThreshold } : {}),
      modelSignal,
      iteration,
      maxIterations: params.maxIterations,
      totalNodes,
      maxNodes: params.maxNodes,
    },
  );
}

/**
 * 循环内深度（提示模板分层用）：多主体时虚拟画布根占深度 0（首轮元素=1——任务定调
 * 「depth=1」）；单主体树根=主体自身（depth 0）。
 */
function loopDepthOf(node: ObjectNode, byId: Map<NodeId, ObjectNode>, singleSubject: boolean): number {
  let depth = 0;
  let cur: ObjectNode = node;
  while (cur.parent !== null) {
    depth++;
    const parent = byId.get(cur.parent);
    if (parent === undefined) {
      throw new SegmentLoopError(`frontier 节点父缺失（${cur.id}→${cur.parent}）——态构造不变式`, 'internal');
    }
    cur = parent;
  }
  return depth + (singleSubject ? 0 : 1);
}

/** 桥调用包装（typed 收敛；SegmentLoopError 透传不二次包裹）。 */
async function callBridge<T>(run: () => Promise<T>, what: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SegmentLoopError) throw error;
    throw new SegmentLoopError(
      `${what} 失败：${error instanceof Error ? error.message : String(error)}`,
      'bridge-failure',
      { cause: error },
    );
  }
}

/** 首轮几何提示：box 中心 include 点+box（P2.2 协议 points≥1——中心=box 语义锚）。 */
function boxPrompt(box: NodeBBox): SamPrompt {
  return {
    kind: 'geometric',
    points: [{ x: box.x + Math.floor(box.w / 2), y: box.y + Math.floor(box.h / 2), label: 'include' }],
    box: { ...box },
  };
}

// ---------------------------------------------------------------- init / step / finalize

/** 校验+解析参数+初始态（零节点；首轮=元素轮由 step 按 iter===0 分派）。 */
export function initSegmentLoop(
  options: SegmentLoopOptions,
  deps: SegmentLoopDeps,
): { state: SegmentLoopState; ctx: SegmentLoopContext } {
  if (options.elements.length === 0) {
    throw new SegmentLoopError('S2 元素清单为空——首轮无提示源（SceneAnalysis.elements ≥1 契约前置）', 'bad-option');
  }
  ensurePositiveOption('maxGemDiameterMm', options.maxGemDiameterMm);
  if (options.sizeFactorK !== undefined) ensurePositiveOption('sizeFactorK', options.sizeFactorK);
  if (options.deltaEThreshold !== undefined) ensurePositiveOption('deltaEThreshold', options.deltaEThreshold);
  const maxIterations = ensurePositiveOption(
    'maxIterations',
    options.maxIterations ?? maxIterationsForCanvas(options.canvasCm),
  );
  const maxNodes = ensurePositiveOption('maxNodes', options.maxNodes ?? SEGMENT_LOOP_MAX_NODES_DEFAULT);
  const vlmReentry = options.vlmReentry ?? false;
  if (vlmReentry && deps.analyze === undefined) {
    throw new SegmentLoopError(
      'vlmReentry=true 需要注入 deps.analyze（桥 analyze 投影——接口位；false 时永不调用）',
      'vlm-reentry-unavailable',
    );
  }
  const ppm = derivePixelsPerMm({ canvasCm: options.canvasCm, imagePx: options.imagePx });
  if (!ppm.ok) {
    throw new SegmentLoopError(
      `canvasCm/imagePx 纵横比不符（cm ${ppm.aspectCm} vs px ${ppm.aspectPx}，容差 2%）——S1 尺寸声明显式拒`,
      'aspect-mismatch',
    );
  }
  const params: SegmentLoopParams = {
    anchors: {
      taskId: options.taskId,
      imageBlobRef: options.imageBlobRef,
      imagePx: options.imagePx,
      canvasCm: options.canvasCm,
    },
    elements: options.elements,
    pixelsPerMm: ppm.pixelsPerMm,
    maxGemDiameterMm: options.maxGemDiameterMm,
    ...(options.sizeFactorK !== undefined ? { sizeFactorK: options.sizeFactorK } : {}),
    ...(options.deltaEThreshold !== undefined ? { deltaEThreshold: options.deltaEThreshold } : {}),
    maxIterations,
    maxNodes,
    vlmReentry,
    elementPromptMode: options.elementPromptMode ?? 'box',
    singleSubject: options.elements.length === 1,
    ...(options.onStep !== undefined ? { onStep: options.onStep } : {}),
  };
  return {
    state: { iter: 0, nodes: [], frontier: [], sealed: {}, hints: {}, nextSeq: 1, history: [], warnings: [] },
    ctx: { deps, params },
  };
}

/**
 * 终态判定：frontier 空=全部停（硬顶封停也汇入此处——每节点判停必出 frontier）。
 * 初始态（iter=0 空树空 frontier）恒非终态——首轮元素轮必须执行（否则空树误判终态）。
 */
export function isTerminalSegmentLoop(state: SegmentLoopState): boolean {
  return state.iter > 0 && state.frontier.length === 0;
}

/**
 * 纯转移：一轮=一步（state → state'）。
 * iter=0 首轮：元素轮（几何/降级文本提示）→节点+判据评估；
 * iter≥1：硬顶前置检查（达顶全封停、零请求）→frontier 逐节点宽泛语义细分（vlmReentry
 * 接口位在此接线）→子节点挂树（父∩子位与）+父子判据评估。
 * 写时复制：输入 state 不被修改（可回放对拍）；onStep 仅观察。
 */
export async function stepSegmentLoop(
  state: SegmentLoopState,
  ctx: SegmentLoopContext,
): Promise<SegmentLoopState> {
  if (isTerminalSegmentLoop(state)) return state;
  const { deps, params } = ctx;
  const { imagePx } = params.anchors;
  const nodes: ObjectNode[] = state.nodes.map((n) => ({ ...n, children: [...n.children] }));
  const sealed: Record<NodeId, StopVerdict> = { ...state.sealed };
  const hints: Record<NodeId, string> = { ...state.hints };
  const entries: SegmentLoopRoundEntry[] = [];
  const sealedNow: Array<{ nodeId: NodeId; reasons: StopReason[] }> = [];
  const emittedWarnings: SegmentLoopWarning[] = [];
  const nextFrontier: NodeId[] = [];
  let nextSeq = state.nextSeq;
  const fragmentMinPx = maskFragmentThresholdPx(imagePx);

  const seal = (id: NodeId, verdict: StopVerdict): void => {
    sealed[id] = verdict;
    sealedNow.push({ nodeId: id, reasons: verdict.reasons });
  };

  if (state.iter === 0) {
    // —— 首轮：S2 元素逐个桥 segment（几何=box；降级=hint 文本）
    for (const element of params.elements) {
      const prompt: SamPrompt =
        params.elementPromptMode === 'hint'
          ? { kind: 'text', text: element.hint }
          : boxPrompt(element.boxPx);
      const request = makeSegmentRequest({ ...params.anchors, prompt, iteration: 0 });
      const outcome = await callBridge(() => deps.segment(request), '桥 segment（首轮元素）');
      ensureCanvasMask(outcome.mask, imagePx);
      const promptKind: 'box' | 'text' = prompt.kind === 'text' ? 'text' : 'box';
      const cleanedBits = filterSmallComponents(
        outcome.mask.bits,
        imagePx.width,
        imagePx.height,
        fragmentMinPx,
      );
      const bbox = tightBBox(cleanedBits, imagePx.width, imagePx.height);
      if (bbox === null) {
        // 空掩码/全碎片=该元素零可用实例：不入树（finalize 全空→typed no-instances）
        entries.push({ target: `element:${element.name}`, promptKind, outcome: 'no-instance', modelSignal: 'no-new-instance' });
        continue;
      }
      const id = nodeIdOf(nextSeq++);
      const localBits = cropBits(cleanedBits, bbox, imagePx.width);
      const node: ObjectNode = {
        id,
        objectName: element.name,
        category: element.category ?? categoryForHint(element.hint), // [4] 固定映射/透传——消除随机兜底
        mask: encodeInlineMask(bbox.w, bbox.h, localBits),
        bbox,
        parent: null, // 多根=finalize 前常态（画布根/单主体根在 finalize 收口）
        children: [],
        effectiveMm: effectiveMmOf(bbox, params.pixelsPerMm),
        labVariance: deps.measureLabVariance({ bbox, bits: localBits }),
        drillWorthy: element.suggestDrillWorthy ?? true, // 缺省 true（排除是策略层开关）
        origin: 'vlm+sam3',
      };
      nodes.push(node);
      hints[id] = element.hint;
      if (typeof outcome.score !== 'number') {
        emittedWarnings.push({
          nodeId: id,
          reason: 'score-missing',
          iter: state.iter,
          detail: `元素「${element.name}」检出实例但桥 segment 未回 score（run1 bug-score-null 防回归——按默认置信入树）`,
        });
      }
      const verdict = verdictFor(node, 'new-instances', 0, nodes.length, params);
      entries.push({
        target: `element:${element.name}`,
        promptKind,
        outcome: 'node-created',
        nodeId: id,
        modelSignal: 'new-instances',
      });
      if (verdict.stop && !isForcedFrontier(node, params)) seal(id, verdict); // [2] 非钻层大块强制细分
      else nextFrontier.push(id);
    }
  } else if (
    state.iter >= params.maxIterations ||
    nodes.length >= params.maxNodes
  ) {
    // —— 硬顶前置：达顶全封停（零请求——不把注定封停的请求送上线）。
    // modelSignal='new-instances'=不发明未发出的模型主张；hard-cap 由条件必触发。
    for (const id of state.frontier) {
      const node = nodes.find((n) => n.id === id);
      if (node === undefined) {
        throw new SegmentLoopError(`frontier 节点缺失（${id}）——态构造不变式`, 'internal');
      }
      seal(id, verdictFor(node, 'new-instances', state.iter, nodes.length, params));
      if (isForcedFrontier(node, params)) {
        emittedWarnings.push({
          nodeId: id,
          reason: 'depth-cap-unresolved',
          iter: state.iter,
          detail: `非钻层大块「${node.objectName}」${node.effectiveMm.toFixed(1)}mm > ${SEGMENT_LOOP_FRONTIER_FORCE_FACTOR}×最大钻径 ${(params.maxGemDiameterMm * SEGMENT_LOOP_FRONTIER_FORCE_FACTOR).toFixed(1)}mm，硬顶截断未细分解决`,
        });
      }
    }
  } else {
    // —— 后续轮：frontier 逐节点宽泛语义细分
    const byId = new Map<NodeId, ObjectNode>(nodes.map((n) => [n.id, n] as const));
    for (const id of state.frontier) {
      const node = byId.get(id);
      if (node === undefined) {
        throw new SegmentLoopError(`frontier 节点缺失（${id}）——态构造不变式`, 'internal');
      }
      // vlmReentry 接口位（默认 false 不进此分支）：桥 analyze 重新描述→hint 精化
      let hint: string | undefined = hints[id];
      if (params.vlmReentry) {
        const analyzeDeps = deps.analyze;
        if (analyzeDeps !== undefined) {
          const analysis = await callBridge(
            () =>
              analyzeDeps(
                makeAnalyzeRequest({
                  ...params.anchors,
                  prompt: { kind: 'text', text: redescribePrompt(node.objectName) },
                  iteration: state.iter,
                }),
              ),
            `桥 analyze（vlmReentry，${node.objectName}）`,
          );
          const refined = analysis.elements.find((e) => e.hint.trim().length > 0);
          if (refined !== undefined) {
            hints[id] = refined.hint;
            hint = refined.hint;
          }
          // 空清单=不精化——宽泛模板兜底（接口位行为：不阻塞循环）
        }
      }
      const text = broadSemanticPrompt({
        objectName: node.objectName,
        depth: loopDepthOf(node, byId, params.singleSubject),
        hint,
      });
      const request = makeSegmentRequest({
        ...params.anchors,
        prompt: { kind: 'text', text },
        iteration: state.iter,
      });
      const outcome = await callBridge(() => deps.segment(request), `桥 segment（细分 ${node.objectName}）`);
      ensureCanvasMask(outcome.mask, imagePx);

      // 判据 3 信号裁定（裁定 [c]：low-score=弱实例不入树；[5] typeof 门=运行时
      // null/缺失不落 low-score 误杀——score 缺失走 warning 留痕）
      let signal: ModelSignal;
      let child: ObjectNode | undefined;
      if (typeof outcome.score === 'number' && outcome.score < SEGMENT_LOOP_LOW_SCORE) {
        signal = 'low-score';
      } else {
        const parentCanvas = canvasMaskOf(node, imagePx);
        const inter = new Uint8Array(imagePx.width * imagePx.height);
        for (let i = 0; i < inter.length; i++) {
          inter[i] = outcome.mask.bits[i]! & parentCanvas[i]!; // 父∩子（位与——防外溢）
        }
        const cleanedInter = filterSmallComponents(
          inter,
          imagePx.width,
          imagePx.height,
          fragmentMinPx,
        );
        const childBbox = tightBBox(cleanedInter, imagePx.width, imagePx.height);
        if (childBbox === null) {
          signal = 'no-new-instance';
        } else {
          signal = 'new-instances';
          const localBits = cropBits(cleanedInter, childBbox, imagePx.width);
          child = {
            id: nodeIdOf(nextSeq++),
            objectName: `${node.objectName}·部分${node.children.length + 1}`, // 无 vlmReentry 时的确定性命名
            category: node.category,
            mask: encodeInlineMask(childBbox.w, childBbox.h, localBits),
            bbox: childBbox,
            parent: node.id,
            children: [],
            effectiveMm: effectiveMmOf(childBbox, params.pixelsPerMm),
            labVariance: deps.measureLabVariance({ bbox: childBbox, bits: localBits }),
            drillWorthy: node.drillWorthy, // 排除开关继承（S6 策略层/用户可改）
            origin: 'vlm+sam3',
          };
        }
      }

      if (child !== undefined) {
        node.children.push(child.id); // node=写时复制件（state 不被修改）
        nodes.push(child);
        if (typeof outcome.score !== 'number') {
          emittedWarnings.push({
            nodeId: child.id,
            reason: 'score-missing',
            iter: state.iter,
            detail: `「${node.objectName}」细分检出子实例但桥 segment 未回 score（run1 bug-score-null 防回归——按默认置信入树）`,
          });
        }
        const childVerdict = verdictFor(child, 'new-instances', state.iter, nodes.length, params);
        if (childVerdict.stop && !isForcedFrontier(child, params)) seal(child.id, childVerdict); // [2]
        else nextFrontier.push(child.id);
      }
      const parentVerdict = verdictFor(node, signal, state.iter, nodes.length, params);
      entries.push({
        target: id,
        promptKind: 'text',
        outcome: child !== undefined ? 'child-created' : signal === 'low-score' ? 'low-score' : 'no-new-instance',
        ...(child !== undefined ? { nodeId: child.id } : {}),
        modelSignal: signal,
      });
      if (parentVerdict.stop && !isForcedFrontier(node, params)) seal(id, parentVerdict); // [2]
      else nextFrontier.push(id);
    }
  }

  // —— 兄弟掩膜互斥消解（[1]；硬顶步无新掩膜不重跑）。consumed 者出树/出 frontier/
  //    出封停面（warning 留痕替代），entries 保留为请求审计。
  if (!(state.iter > 0 && (state.iter >= params.maxIterations || nodes.length >= params.maxNodes))) {
    const overlap = resolveSiblingOverlaps(nodes, params, deps.measureLabVariance, state.iter);
    emittedWarnings.push(...overlap.warnings);
    if (overlap.consumed.size > 0) {
      for (const id of overlap.consumed) delete sealed[id];
      for (let i = sealedNow.length - 1; i >= 0; i--) {
        if (overlap.consumed.has(sealedNow[i]!.nodeId)) sealedNow.splice(i, 1);
      }
      for (let i = nextFrontier.length - 1; i >= 0; i--) {
        if (overlap.consumed.has(nextFrontier[i]!)) nextFrontier.splice(i, 1);
      }
    }
  }

  const meta: SegmentLoopStepMeta = {
    iter: state.iter,
    entries,
    sealed: sealedNow,
    nodesAfter: nodes.length,
    frontierAfter: nextFrontier.length,
    nodeIdsAfter: nodes.map((n) => n.id),
    warnings: emittedWarnings,
  };
  params.onStep?.(meta);
  return {
    iter: state.iter + 1,
    nodes,
    frontier: nextFrontier,
    sealed,
    hints,
    nextSeq,
    history: [...state.history, meta],
    warnings: [...state.warnings, ...emittedWarnings],
  };
}

/**
 * 终态收口：根裁定（多主体→插入画布结构性根；单主体→该主体即根）+DFS 先序规范序
 * （tree-persist 同规范序——预览角标与 JSON 数组序对齐）+ObjectTreeSchema 终验。
 */
export function finalizeSegmentLoop(state: SegmentLoopState, ctx: SegmentLoopContext): SegmentLoopResult {
  const { deps, params } = ctx;
  if (state.nodes.length === 0) {
    throw new SegmentLoopError(
      '全部元素零实例——无树可产（S2 清单与图像不符或桥面失效；降级路径归 P2.5）',
      'no-instances',
    );
  }
  let nodes: ObjectNode[] = state.nodes.map((n) => ({ ...n, children: [...n.children] }));
  let nextSeq = state.nextSeq;
  const roots = nodes.filter((n) => n.parent === null);
  let rootId: NodeId;
  if (params.singleSubject) {
    // 单主体树：根=该主体（design §1 S5「按 SceneAnalysis 单主体则根=该主体」——按
    // S2 清单裁定，非按存活节点数：多主体清单即使仅一元素成树也保画布根语义）
    if (roots.length !== 1) {
      throw new SegmentLoopError(
        `单主体树根数 ${roots.length} ≠ 1——态构造不变式`,
        'internal',
      );
    }
    rootId = roots[0]!.id;
  } else {
    // 多主体：插入画布结构性根（drillWorthy=false→tree-to-blocks 不产块——容器非钻层）
    const { width, height } = params.anchors.imagePx;
    const full: NodeBBox = { x: 0, y: 0, w: width, h: height };
    const fullBits = new Uint8Array(width * height).fill(1);
    const canvasId = nodeIdOf(nextSeq++);
    nodes = nodes.map((n) => (n.parent === null ? { ...n, parent: canvasId } : n));
    nodes.push({
      id: canvasId,
      objectName: '画布',
      category: 'canvas',
      mask: encodeInlineMask(width, height, fullBits),
      bbox: full,
      parent: null,
      children: roots.map((r) => r.id),
      effectiveMm: effectiveMmOf(full, params.pixelsPerMm),
      labVariance: deps.measureLabVariance({ bbox: full, bits: fullBits }),
      drillWorthy: false,
      origin: 'vlm+sam3',
    });
    rootId = canvasId;
  }
  const byId = new Map<NodeId, ObjectNode>(nodes.map((n) => [n.id, n] as const));
  const ordered: ObjectNode[] = [];
  const visit = (id: NodeId): void => {
    const node = byId.get(id);
    if (node === undefined) {
      throw new SegmentLoopError(`DFS 节点缺失（${id}）——态构造不变式`, 'internal');
    }
    ordered.push(node);
    for (const childId of node.children) visit(childId);
  };
  visit(rootId);
  const createdAt = deps.now?.() ?? new Date().toISOString();
  const tree = ObjectTreeSchema.parse({
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: params.anchors.canvasCm,
    imagePx: params.anchors.imagePx,
    nodes: ordered,
    createdAt,
  });
  const sealedByNode: Record<NodeId, StopReason[]> = {};
  for (const [id, verdict] of Object.entries(state.sealed)) {
    sealedByNode[id] = verdict.reasons;
  }
  return {
    tree,
    iterations: state.iter,
    totalNodes: ordered.length,
    sealedByNode,
    history: state.history,
    warnings: state.warnings,
  };
}

/**
 * 迭代抠图循环编排（init → step* → finalize）。
 * 终止性：迭代硬顶保证步数 ≤ maxIterations+1（达顶步全封停→frontier 空）；守卫计数
 * 为不变式兜底（触发=内部错误，typed 上抛）。
 */
export async function runSegmentLoop(
  options: SegmentLoopOptions,
  deps: SegmentLoopDeps,
): Promise<SegmentLoopResult> {
  const { state, ctx } = initSegmentLoop(options, deps);
  let current = state;
  const guardLimit = ctx.params.maxIterations + 2;
  let steps = 0;
  while (!isTerminalSegmentLoop(current)) {
    current = await stepSegmentLoop(current, ctx);
    steps++;
    if (steps > guardLimit) {
      throw new SegmentLoopError(
        `迭代守卫越界（${steps} 步 > 硬顶 ${ctx.params.maxIterations}+2）——状态机不终止，内部错误`,
        'internal',
      );
    }
  }
  return finalizeSegmentLoop(current, ctx);
}
