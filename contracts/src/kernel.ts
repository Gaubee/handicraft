/**
 * 主体分割与多元贴钻内核工件契约（add-subject-sam-pipeline design §1/§2/§3/§4.4/§5
 * ——P0.1 冻结，零模型依赖）。决策源：owner-directive-20260924.md（原话冻结）。
 * 与 design 字面的四处偏差（P0 定稿增量，报告已列）：
 *   [1] 钻引用统一用既有 StonePick（stoneRef→stone 库 resourceId），不再发明
 *       specKey×colorId 双键（定稿增量①——StonePickSchema 已含尺寸/颜色/溯源三元组）。
 *   [2] mask 用「blob 引用 | 紧凑内联编码」二态（design §3 字面 `mask: Mask2D`——
 *       Uint8Array 非 JSON 线格式安全；两态均保持 w*h 字节 0/1 逐位同构语义，
 *       与 spike 实证 objecttree-*.json bitsB64 同形）。
 *   [3] ObjectNode 增 bbox（任务定稿字段；引擎 Mask2D 是 bbox 局部坐标，节点必须
 *       自带画布坐标锚点）。
 *   [4] StrategyAssignment.engineStrategy 为可选映射（排除/自由代码无引擎五策略
 *       映射；几何族不足降级 hex 时显式落引擎面——design §9 回流 4）。
 * 正交意图：
 *   [1] ObjectTree/ObjectNode（§3 树状工件+父子一致性校验+blockId id 桥）。
 *   [2] SceneAnalysis（§1 S2 VLM 识图产物）+ StrategyAssignment/StrategyPlan（§5
 *       LLM 策略指派 proposal）+ 代码策略工件（§4.4 自由代码沙箱执行面工件形状）。
 *   [3] 具名常量冻结（定稿增量②③）：默认密度 2.3/cm² + ΔE 三档 3/10/25。
 *   [4] canvasCm→pixelsPerMm 推导纯函数（§1 S1：纵横比不符显式拒）。
 */
import { z } from 'zod';
import { BlobRefSchema, IsoDateTimeSchema } from './common.js';
import { BlockIdSchema, StrategyIdSchema } from './paving.js';
import { base64Encode } from './stone-adapter.js';
import { StonePickSchema } from './stones.js';

// ---------------------------------------------------------------- 定稿增量②③ 具名常量

/**
 * 策略默认密度（颗/cm²）。Owner 2026-09-24 晚定调原话：「我们先默认一平方厘米
 * 2.3（自然数）颗吧」——自编常数待标定；客户成品实测 6.1/cm² 见
 * experiments/sam3-spike-20260924（multistrat REPORT §8 密度对照另记 721-1128 颗/图
 * 为实验稀疏设计选择）。
 */
export const DEFAULT_DENSITY_PER_CM2 = 2.3;

/**
 * ΔE76 三档阈值（替代决策序用）。出处：experiments/rhinestone-catalog-20260924/
 * SUBSTITUTION.md（「ΔE<3 auto / 3-10 auto+note / 10-25 confirm / >25 reject」）。
 * NEAR=感知无差（自动替代）；FAMILY=同色族（自动+备注）；COARSE=粗粒度兜底上限
 * （>25 拒绝）。CIE76 与引擎/内核 Lab 管线同源（color.ts 镜像纪律）。
 */
export const DELTA_E_NEAR = 3;
export const DELTA_E_FAMILY = 10;
export const DELTA_E_COARSE = 25;

// ---------------------------------------------------------------- §1 S1 canvasCm→pixelsPerMm

/** 画布物理尺寸声明（cm；Owner 原始流程第一步「首先要输入一个厘米尺寸」）。 */
export const CanvasCmSchema = z
  .object({
    w: z.number().positive(),
    h: z.number().positive(),
  })
  .strict();
export type CanvasCm = z.infer<typeof CanvasCmSchema>;

/** 归一底图像素尺寸（S0 产物；int 正数）。 */
export const ImagePxSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();
export type ImagePx = z.infer<typeof ImagePxSchema>;

/** 尺寸声明工件：canvasCm{w,h} + imagePx{width,height}（§1 S1 一等输入）。 */
export const CanvasDeclarationSchema = z
  .object({
    canvasCm: CanvasCmSchema,
    imagePx: ImagePxSchema,
  })
  .strict();
export type CanvasDeclaration = z.infer<typeof CanvasDeclarationSchema>;

/**
 * 纵横比容差（相对偏差；整数像素栅格对 cm 声明必有舍入——1px/100px=1% 量级，
 * 2% 缺省安全；调用方可显式收紧/放宽）。
 */
export const CANVAS_ASPECT_TOLERANCE = 0.02;

export type DerivePixelsPerMmResult =
  | { ok: true; pixelsPerMm: number }
  | { ok: false; reason: 'aspect-mismatch'; aspectCm: number; aspectPx: number };

/**
 * canvasCm+imagePx → pixelsPerMm（纯函数；§1 S1「纵横比不符显式拒」）。
 * px/mm 取 x/y 两轴均值（纵横比一致前提下二者相等；均值=确定性无主轴偏好）。
 * 显式拒：|aspectPx-aspectCm|/aspectCm > tolerance（默认 0.02）。
 */
export function derivePixelsPerMm(
  decl: CanvasDeclaration,
  tolerance: number = CANVAS_ASPECT_TOLERANCE,
): DerivePixelsPerMmResult {
  const aspectCm = decl.canvasCm.w / decl.canvasCm.h;
  const aspectPx = decl.imagePx.width / decl.imagePx.height;
  if (Math.abs(aspectPx - aspectCm) / aspectCm > tolerance) {
    return { ok: false, reason: 'aspect-mismatch', aspectCm, aspectPx };
  }
  const ppmX = decl.imagePx.width / (decl.canvasCm.w * 10);
  const ppmY = decl.imagePx.height / (decl.canvasCm.h * 10);
  return { ok: true, pixelsPerMm: (ppmX + ppmY) / 2 };
}

// ---------------------------------------------------------------- §3 mask 引用（blob | 紧凑内联）

/**
 * 引擎 Mask2D 同构语义：w*h 字节、逐字节 ∈ {0,1}、行主序（局部坐标
 * (x,y) → bits[y*w+x]——engine types.ts Mask2D）。内联态 base64 编码（JSON 安全，
 * spike bitsB64 同形）；blob 态为同布局原始字节入 BlobStore（内容寻址引用）。
 */
export const InlineMaskSchema = z
  .object({
    kind: z.literal('inline'),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    encoding: z.literal('base64-01'),
    data: z.string().min(4),
  })
  .strict()
  .superRefine((m, ctx) => {
    const bytes = decodeMaskData(m.data);
    if (bytes === null) {
      ctx.addIssue({ code: 'custom', message: 'mask.data 非法 base64' });
      return;
    }
    if (bytes.length !== m.w * m.h) {
      ctx.addIssue({ code: 'custom', message: `mask.data 解码 ${bytes.length} 字节 ≠ w*h=${m.w * m.h}` });
      return;
    }
    for (const b of bytes) {
      if (b !== 0 && b !== 1) {
        ctx.addIssue({ code: 'custom', message: 'mask 字节必须 ∈ {0,1}（引擎 Mask2D 同构）' });
        return;
      }
    }
  });
export type InlineMask = z.infer<typeof InlineMaskSchema>;

/** blob 态：w/h 随行（blob 内容=w*h 0/1 字节，解码方据此重建 Mask2D）。 */
export const BlobMaskSchema = z
  .object({
    kind: z.literal('blob'),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    blobRef: BlobRefSchema,
  })
  .strict();
export type BlobMask = z.infer<typeof BlobMaskSchema>;

export const Mask2DRefSchema = z.discriminatedUnion('kind', [InlineMaskSchema, BlobMaskSchema]);
export type Mask2DRef = z.infer<typeof Mask2DRefSchema>;

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 反查表（-1=非法；模块级构建一次——2d 性能门：逐组 Map/数组分配的旧解码 4K² 面位 ~366ms）。 */
const B64_REVERSE = new Int8Array(256).fill(-1);
for (let i = 0; i < B64_ALPHABET.length; i += 1) B64_REVERSE[B64_ALPHABET.charCodeAt(i)] = i;

/** 严格 base64 解码（字母表+4 字符对齐+尾垫仅限末组 c2/c3 且 c2='='⇒c3='='；非法返回 null）。 */
function decodeMaskData(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 !== 0) return null;
  let padding = 0;
  if (s.endsWith('==')) padding = 2;
  else if (s.endsWith('=')) padding = 1;
  const out = new Uint8Array((s.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const isLast = i + 4 === s.length;
    const c0 = s.charCodeAt(i);
    const c1 = s.charCodeAt(i + 1);
    const c2 = s.charCodeAt(i + 2);
    const c3 = s.charCodeAt(i + 3);
    // 垫符（61='='）仅允许末组第 2/3 位，且 c2 垫 ⇒ c3 垫（c3 单垫=len%3==2 标准形态
    // ——旧条件 `quad[2] !== '='` 会拒收自产编码，P2.2 实证修复；校验语义逐条保持，
    // 2d 性能门仅去逐组 Map/数组分配）。
    if (c0 === 61 || c1 === 61) return null;
    const v0 = c0 < 256 ? B64_REVERSE[c0]! : -1;
    const v1 = c1 < 256 ? B64_REVERSE[c1]! : -1;
    if (v0 < 0 || v1 < 0) return null;
    if (c2 === 61) {
      if (!isLast || c3 !== 61) return null;
      out[o++] = (v0 << 2) | (v1 >> 4);
      continue;
    }
    const v2 = c2 < 256 ? B64_REVERSE[c2]! : -1;
    if (v2 < 0) return null;
    if (c3 === 61) {
      if (!isLast) return null;
      out[o++] = (v0 << 2) | (v1 >> 4);
      out[o++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
      continue;
    }
    const v3 = c3 < 256 ? B64_REVERSE[c3]! : -1;
    if (v3 < 0) return null;
    out[o++] = (v0 << 2) | (v1 >> 4);
    out[o++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
    out[o++] = ((v2 & 0x03) << 6) | v3;
  }
  return o === out.length ? out : null;
}

/** w*h 0/1 字节 → 内联 mask 工件（长度/取值校验前置，不猜测）。 */
export function encodeInlineMask(w: number, h: number, bits: Uint8Array): InlineMask {
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) {
    throw new RangeError('mask 尺寸必须为正整数');
  }
  if (bits.length !== w * h) throw new RangeError(`bits 长度 ${bits.length} ≠ w*h=${w * h}`);
  for (const b of bits) {
    if (b !== 0 && b !== 1) throw new RangeError('mask 字节必须 ∈ {0,1}');
  }
  return InlineMaskSchema.parse({ kind: 'inline', w, h, encoding: 'base64-01', data: base64Encode(bits) });
}

/** 内联 mask → w*h 0/1 字节（schema 已保证合法，此处直接解码）。 */
export function decodeInlineMask(mask: InlineMask): { w: number; h: number; bits: Uint8Array } {
  const bits = decodeMaskData(mask.data);
  if (bits === null) throw new Error('mask.data 非法 base64（schema 外构造）');
  return { w: mask.w, h: mask.h, bits };
}

// ---------------------------------------------------------------- §3 ObjectNode/ObjectTree

/**
 * 节点 id = 引擎 blockId（同寻址空间——design §3 原注；paving Region/patch op
 * 的 BlockId 直接接受本 id，见 blockIdOfNode/blockIdsOfTree）。
 */
export const NodeIdSchema = BlockIdSchema;
export type NodeId = z.infer<typeof NodeIdSchema>;

/** 画布像素坐标 bbox（int；mask 为 bbox 局部坐标，全局定位取此）。 */
export const NodeBBoxSchema = z
  .object({
    x: z.number().int().nonnegative(),
    y: z.number().int().nonnegative(),
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  })
  .strict();
export type NodeBBox = z.infer<typeof NodeBBoxSchema>;

/** 节点来源（§3 origin；一键模式降级路径=auto-color）。 */
export const ObjectOriginSchema = z.enum(['vlm+sam3', 'manual-lasso', 'auto-color', 'refinement']);
export type ObjectOrigin = z.infer<typeof ObjectOriginSchema>;

/**
 * 节点挂靠关系类型（realize-scene-understanding Codex B1/B2 裁定 2026-09-28）：
 * semantic=语义解剖部位（左手/脸/上衣——VLM Scene Graph 归属或 Agent 重分类后挂入）；
 * refinement=细分区域（SAM 拆分产物、无独立解剖语义——「小丑·部分N」类，防止被
 * v5 叶子恒产规则误当普通解剖叶子）。缺省（旧树工件）=未标注（语义同 semantic 读法，
 * 不按名称猜）。仅结构（parent/children）是寻址面；relation 是语义标注。
 */
export const ObjectRelationSchema = z.enum(['semantic', 'refinement']);
export type ObjectRelation = z.infer<typeof ObjectRelationSchema>;

export const ObjectNodeSchema = z
  .object({
    id: NodeIdSchema,
    /** 中文语义名（路灯·杆 / 路灯·灯头 / 柳树·枝条） */
    objectName: z.string().min(1),
    /** VLM/SAM3 类别（structure/foliage/face/light/…） */
    category: z.string().min(1),
    mask: Mask2DRefSchema,
    bbox: NodeBBoxSchema,
    parent: NodeIdSchema.nullable(),
    children: z.array(NodeIdSchema),
    /** 停止判据数据：有效物理尺寸 mm（mask 面积开方） */
    effectiveMm: z.number().nonnegative(),
    /** 停止判据数据：节点内 Lab 色方差（ΔE76 量纲——color.ts 管线） */
    labVariance: z.number().nonnegative(),
    /** 排除开关（灯光/脸蛋=false；LLM 建议用户可改——补充定调：先别做排除硬策略） */
    drillWorthy: z.boolean(),
    origin: ObjectOriginSchema,
    /** 挂靠关系类型（v2 树写面起标注；旧树缺省=未标注——见 ObjectRelationSchema 注）。 */
    relation: ObjectRelationSchema.optional(),
    /**
     * 抠图指令原文（add-vision-pipeline-v2 D4）：该图层基于什么指令被抠出——
     * **Agent 原始指令**（provenance；翻译/英文化只发生在 SAM 请求侧，译文不落此
     * 字段）。可选=旧树无字段（兼容反序列化）；写侧纪律：新抠图必写、没有就不写
     * （undefined——不伪造、不填空串，min(1) 由 schema 把守）；历史树补字段=重跑
     * 抠图流程（Out of Scope 本 change）。
     */
    segmentPrompt: z.string().min(1).optional(),
  })
  .strict();
export type ObjectNode = z.infer<typeof ObjectNodeSchema>;

/**
 * object-tree 工件（§3 核心新工件）：扁平节点表+parent/children 指针（spike 实证
 * 同形）；单根树（owner：树状结构+归属关系）。结构一致性 superRefine：id 唯一/
 * parent 必存在/children 双向闭合/无自指/children 无重复/恰一根。
 */
export const ObjectTreeSchema = z
  .object({
    kind: z.literal('object-tree'),
    formatVersion: z.literal(1),
    canvasCm: CanvasCmSchema,
    imagePx: ImagePxSchema,
    nodes: z.array(ObjectNodeSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((tree, ctx) => {
    const byId = new Map<string, (typeof tree.nodes)[number]>();
    for (const n of tree.nodes) {
      if (byId.has(n.id)) ctx.addIssue({ code: 'custom', message: `节点 id 重复：${n.id}` });
      byId.set(n.id, n);
    }
    let roots = 0;
    for (const n of tree.nodes) {
      if (n.id === n.parent) ctx.addIssue({ code: 'custom', message: `节点自指：${n.id}` });
      if (n.parent === null) {
        roots++;
        continue;
      }
      const p = byId.get(n.parent);
      if (p === undefined) {
        ctx.addIssue({ code: 'custom', message: `parent 不存在：${n.id}→${n.parent}` });
        continue;
      }
      if (!p.children.includes(n.id)) {
        ctx.addIssue({ code: 'custom', message: `父子非双向：${p.id}.children 缺 ${n.id}` });
      }
    }
    for (const n of tree.nodes) {
      if (new Set(n.children).size !== n.children.length) {
        ctx.addIssue({ code: 'custom', message: `children 重复：${n.id}` });
      }
      for (const c of n.children) {
        const child = byId.get(c);
        if (child === undefined) {
          ctx.addIssue({ code: 'custom', message: `child 不存在：${n.id}→${c}` });
        } else if (child.parent !== n.id) {
          ctx.addIssue({ code: 'custom', message: `父子非双向：${c}.parent ≠ ${n.id}` });
        }
      }
    }
    if (roots !== 1) ctx.addIssue({ code: 'custom', message: `必须恰一根节点（实为 ${roots}）` });
  });
export type ObjectTree = z.infer<typeof ObjectTreeSchema>;

// ---------------------------------------------------------------- blockId id 桥（适配层约定）

/** 节点 id 即引擎 blockId（同寻址空间约定——paving Region/patch 直接可寻址）。 */
export function blockIdOfNode(node: ObjectNode): NodeId {
  return node.id;
}

/**
 * 产块节点谓词（v5 Owner 裁定 2026-09-28，**单源**——rework-layer-ps-panel 修复轮
 * R1e 收敛）：图层=PS 图层、钻=图层特效 fx，图层拆成子图层后**只有子图层（叶子）
 * 能套钻**——恒=children.length===0；中间节点（组）不论 drillWorthy 恒不产钻不产块
 * （drillWorthy 降为建议面标注，不参与产块裁定）。v4「叶子 || drillWorthy」允许
 * 中间节点产钻是排钻嵌套根因（父层 159 颗与子层 150 颗坐标重叠叠排），已废止。
 * 消费方（三处同源，禁止再各自维护内联判定）：
 *   [1] daemon 内核生产路径（strategies/design.ts producesBlockOf 与
 *       vision/tree-to-blocks.ts producesBlock——两者委托本函数）；
 *   [2] daemon 内核 workbench/导出面（workbench.ts typed 门、rpc.ts
 *       effectiveGems 过滤）；
 *   [3] 前端（store.svelte.ts isStaleGroupAssignment/渲染叶子过滤——经
 *       '@handicraft/contracts' 导入）。
 */
export function nodeProducesBlock(node: Readonly<Pick<ObjectNode, 'children'>>): boolean {
  return node.children.length === 0;
}

/** 全树节点 id → BlockId[]（S7 拼接/S8 全局 enforceMinDistance 按此寻址）。 */
export function blockIdsOfTree(tree: ObjectTree): NodeId[] {
  return tree.nodes.map((n) => n.id);
}

// ---------------------------------------------------------------- §1 S2 SceneAnalysis（VLM 识图产物）

/**
 * S2 元素（首轮=SAM3 提示来源；box=画布像素坐标）。
 * v2 关系格式（realize-scene-understanding Codex B1 裁定）：parent 必须是显式、
 * 稳定的语义引用（elementId/parentElementId），不从名称或 bbox 包含关系事后猜测。
 * v1 平铺旧工件=显式兼容：三字段全部缺席（validateSceneRelations 判 legacy-flat，
 * 全部挂画布直接子节点——不按名称猜 anatomy）。
 */
export const SceneElementSchema = z
  .object({
    /** 中文名（路灯/草地/人物/房子/马车…） */
    name: z.string().min(1),
    /** VLM 类别（与 ObjectNode.category 同词表——P4.1 词表版本化） */
    category: z.string().min(1).optional(),
    boxPx: NodeBBoxSchema,
    /** SAM3 提示词（英文语义提示优先——spike 实证 person/hat 类） */
    hint: z.string().min(1),
    /** 值得贴建议（主体=值得强调/值得贴——黑背景/灯光类=false；用户可改） */
    suggestDrillWorthy: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
    /** v2：稳定元素 id（同工件内唯一——parentElementId 的寻址键；v2 必给）。 */
    elementId: z.string().min(1).max(64).optional(),
    /** v2：语义父元素 id（顶层=null/缺席；v1 平铺缺席）。 */
    parentElementId: z.string().min(1).max(64).nullable().optional(),
    /** v2：挂靠关系（semantic=语义部位 / refinement=细分区域；挂父时必给）。 */
    relation: ObjectRelationSchema.optional(),
  })
  .strict();
export type SceneElement = z.infer<typeof SceneElementSchema>;

/**
 * S2→树构建的关系校验计划（validateSceneRelations 产物——纯数据，无 IO）。
 */
export interface SceneRelationPlan {
  /** legacy-flat=v1 平铺（全部画布直接子节点）/ structured=v2 显式关系。 */
  mode: 'legacy-flat' | 'structured';
  /** 元素数组下标的父下标（-1=顶层）——按下标寻址避免 id 缺失歧义。 */
  parentIndex: number[];
  /** 元素数组下标的关系类型（顶层=null；legacy-flat 全 null）。 */
  relationOfIndex: Array<ObjectRelation | null>;
  /** 处理序（父先子后——拓扑序；legacy-flat=原数组序）。 */
  orderedIndices: number[];
}

/**
 * S2 元素关系校验（S2→ObjectTree 构建器前置——Codex B1 四校验）：
 * parent 存在 / 无自指 / 无环 / 每元素至多一个语义父（单 parentElementId 字段天然
 * 保证）/ 根归属唯一（多个顶层=画布多主体——合法，画布唯一根收口）。坏关系抛
 * Error（调用方收敛为 typed reject——不静默按数组序挂载）。
 * 纯函数：同输入同输出。全部元素无 elementId=legacy-flat（v1 兼容面——不按名称猜）。
 */
export function validateSceneRelations(elements: readonly SceneElement[]): SceneRelationPlan {
  const hasIds = elements.some((element) => element.elementId !== undefined);
  const mixed = elements.some((element) => element.elementId !== undefined)
    && elements.some((element) => element.elementId === undefined);
  if (mixed) {
    throw new Error('scene-analysis 关系格式混用：部分元素带 elementId 部分不带（v2 结构化清单必须全员携带；v1 平铺必须全员缺席）');
  }
  if (!hasIds) {
    return {
      mode: 'legacy-flat',
      parentIndex: elements.map(() => -1),
      relationOfIndex: elements.map(() => null),
      orderedIndices: elements.map((_, i) => i),
    };
  }
  const idToIndex = new Map<string, number>();
  for (let i = 0; i < elements.length; i++) {
    const id = elements[i]!.elementId!;
    if (idToIndex.has(id)) throw new Error(`elementId 重复：${id}`);
    idToIndex.set(id, i);
  }
  const parentIndex = elements.map(() => -1);
  elements.forEach((element, i) => {
    const parent = element.parentElementId;
    if (parent === undefined || parent === null) return;
    if (parent === element.elementId) {
      throw new Error(`元素自指：${element.elementId}（parentElementId=自身）`);
    }
    const parentIdx = idToIndex.get(parent);
    if (parentIdx === undefined) {
      throw new Error(`parentElementId 不存在：${element.elementId}→${parent}`);
    }
    parentIndex[i] = parentIdx;
    if (element.relation === undefined) {
      throw new Error(`挂父元素缺 relation：${element.elementId}→${parent}（semantic|refinement 必给）`);
    }
  });
  // 无环（沿父链上溯必达顶层；重访即环——元素数上限内必终止）
  const depth = elements.map(() => -1);
  const resolveDepth = (i: number, trail: Set<number>): number => {
    if (depth[i] >= 0) return depth[i]!;
    if (trail.has(i)) {
      throw new Error(`元素关系成环：${elements[i]!.elementId}（链 ${[...trail].map((t) => elements[t]!.elementId).join('→')}）`);
    }
    trail.add(i);
    const d = parentIndex[i] === -1 ? 0 : resolveDepth(parentIndex[i]!, trail) + 1;
    depth[i] = d;
    return d;
  };
  elements.forEach((_, i) => resolveDepth(i, new Set()));
  const orderedIndices = elements.map((_, i) => i).sort(
    (a, b) => depth[a]! - depth[b]! || a - b, // 同深度保持数组序（确定性）
  );
  return {
    mode: 'structured',
    parentIndex,
    relationOfIndex: elements.map((element, i) =>
      parentIndex[i] === -1 ? null : (element.relation ?? 'semantic'),
    ),
    orderedIndices,
  };
}

export const SceneAnalysisSchema = z
  .object({
    kind: z.literal('scene-analysis'),
    /** v1=平铺（legacy-flat 兼容读）；v2=显式关系（elementId/parentElementId/relation）。 */
    formatVersion: z.union([z.literal(1), z.literal(2)]),
    imageBlobRef: BlobRefSchema,
    /** 尺寸锚点（一等输入——S1 声明随工件留存，S5 ObjectTree 同字段回填） */
    canvasCm: CanvasCmSchema,
    imagePx: ImagePxSchema,
    elements: z.array(SceneElementSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((analysis, ctx) => {
    if (analysis.formatVersion === 1) return; // v1 平铺旧工件=显式兼容（不按名称猜 anatomy）
    try {
      const plan = validateSceneRelations(analysis.elements);
      if (plan.mode !== 'structured') {
        ctx.addIssue({
          code: 'custom',
          message: 'scene-analysis v2 关系校验失败：结构化清单必须全员携带 elementId（无关系字段的平铺形态应落 v1 工件或经桥通道 daemon 派 id）',
        });
      }
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: `scene-analysis v2 关系校验失败：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>;

// ---------------------------------------------------------------- §4.4 代码策略工件

/**
 * 自由代码策略 JS 源码工件（沙箱执行面——schema 只管工件形状：source/entryPoint/
 * 声明式元数据；沙箱注入 API/无网无 fs/CPU 时有界=daemon P1.4 职责）。
 */
export const CodeStrategyArtifactSchema = z
  .object({
    kind: z.literal('free-code-artifact'),
    formatVersion: z.literal(1),
    /** 首版 JS（§4.4；Python 调研项——枚举留位，不加值不扩语义） */
    language: z.enum(['javascript']),
    /** JS 源码片段（LLM 生成；无 import——依赖经注入面） */
    source: z.string().min(1),
    /** 沙箱调用入口函数名（如 'layout'——(ctx) => Gem[] 形状由沙箱校验） */
    entryPoint: z.string().min(1),
    /** 同代码+同 seed 可回放（§4.4 确定性——审计/重跑） */
    seed: z.number().int().nonnegative(),
    /** 声明式元数据：拟用的注入 API 名单（沙箱审计面——越界调用即策略失败） */
    declaredApiCalls: z.array(z.string().min(1)),
    /** 声明式元数据：策略意图自述（人审/LLM 重写上下文） */
    description: z.string().optional(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type CodeStrategyArtifact = z.infer<typeof CodeStrategyArtifactSchema>;

// ---------------------------------------------------------------- §5 策略指派

/**
 * 内核策略八类（Owner 定调四族展开——owner-directive 主文+补充定调；close-paving-backlog
 * T3 增第八值 along-path——Owner 2026-09-21「路径功能意味着要能编辑路径」预留兑现）：
 * 纹理贴图法/柔和曲线/花形/直线（刚硬物）/几何（星射线·心·方·圆·矩·椭圆·螺旋）/
 * 排除/自由代码/**沿路径**（outline 掩码边界等距线=边框花环承接 / custom 显式折线）。
 * 补充定调：排除族先搁置（drillWorthy 开关仍在，不作硬策略）。
 */
export const KernelStrategyKindSchema = z.enum([
  'texture-fill',
  'soft-curve',
  'flower',
  'straight-line',
  'geometry',
  'exclusion',
  'free-code',
  'along-path',
]);
export type KernelStrategyKind = z.infer<typeof KernelStrategyKindSchema>;

/**
 * 单节点策略指派（§5 LLM proposal 单元）。钻引用统一 StonePick（定稿增量①：
 * resourceId 即 stoneRef——不再发明 specKey×colorId 双键）；密度默认 2.3/cm²
 * （定稿增量②）。**绝对颗数密度语义**（realize-scene-understanding T3 / Codex
 * C2 冻结）：颗/cm²——非满铺比例、非引擎乘数；引擎乘数由 adapter 按实际晶格
 * （pitchMm=钻径+gap）换算 densityRatio（design.ts engineDensityConversion 单源）。
 * engineStrategy=落引擎五策略面的映射（几何族降级 hex/引擎既有路径复用；排除/
 * 自由代码/内核执行器自产 Gem 时缺省）。
 */
export const StrategyAssignmentSchema = z
  .object({
    nodeId: NodeIdSchema,
    strategyKind: KernelStrategyKindSchema,
    /** 策略族参数（P1.1/P1.2 逐族冻结参数 schema；P0 先占自由 record） */
    params: z.record(z.string(), z.unknown()),
    /** 该节点可用钻（StonePick 列表——空数组=仅排除/待定） */
    stones: z.array(StonePickSchema),
    /** 密度（颗/cm²；Owner 默认 2.3） */
    densityPerCm2: z.number().positive().default(DEFAULT_DENSITY_PER_CM2),
    /** 引擎 STRATEGY_IDS 映射（paving.StrategyId 五值；见头注偏差[4]） */
    engineStrategy: StrategyIdSchema.optional(),
    /** free-code 时的工件 blob 引用（CodeStrategyArtifact 内容寻址；余缺省） */
    codeArtifactRef: BlobRefSchema.optional(),
    /**
     * 多尺寸混排（close-paving-backlog T2——「打底+补隙」执行层正交模式，可叠加到
     * 任意产钻策略）：base 趟（strategyKind 本体）产钻后，以 stoneRef 指向的小径钻
     * 在掩膜内空隙补钻（客户 3mm+10mm 混排刚需）。stoneRef 必须同时列入本节点
     * stones 候选（superRefine 把守）；exclusion（不产钻）/free-code（沙箱自管钻）
     * 组合必拒。缺省缺席=单径现状（strict 可选键——旧数据 parse 恒过）。
     */
    gapFill: z
      .object({
        /** 补隙钻引用（=本节点 stones[].resourceId 之一——补隙钻须同时列入候选） */
        stoneRef: z.string().min(1),
        /** 补隙最小中心距收紧因子 [1.0,3.0]（缺省 1.0=与导出门 gateRequiredPairPx 逐位同式） */
        minGapRatio: z.number().gte(1.0).lte(3.0).default(1.0),
      })
      .strict()
      .optional(),
    /** LLM 指派理由（proposal 可审性） */
    rationale: z.string().min(1),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.strategyKind === 'free-code' && a.codeArtifactRef === undefined) {
      ctx.addIssue({ code: 'custom', message: 'free-code 指派必须携带 codeArtifactRef' });
    }
    if (a.strategyKind !== 'free-code' && a.codeArtifactRef !== undefined) {
      ctx.addIssue({ code: 'custom', message: '非 free-code 指派不得携带 codeArtifactRef' });
    }
    if (a.gapFill !== undefined) {
      if (a.strategyKind === 'exclusion' || a.strategyKind === 'free-code') {
        ctx.addIssue({
          code: 'custom',
          message: `gapFill 混排不可与 ${a.strategyKind} 组合（${a.strategyKind === 'exclusion' ? '排除不产钻' : '自由代码沙箱自管钻'}）——去掉 gapFill 或换产钻策略`,
        });
      }
      if (!a.stones.some((pick) => pick.resourceId === a.gapFill!.stoneRef)) {
        ctx.addIssue({
          code: 'custom',
          message: `gapFill.stoneRef=${a.gapFill.stoneRef} 不在本节点 stones 候选内（补隙钻须同时列入候选—— stones[].resourceId 之一）`,
        });
      }
    }
  });
export type StrategyAssignment = z.infer<typeof StrategyAssignmentSchema>;

/** 策略指派集（S6 proposal 工件；styleId=艺术家风格接口预留——§5 后话）。 */
export const StrategyPlanSchema = z
  .object({
    kind: z.literal('strategy-plan'),
    formatVersion: z.literal(1),
    /** 树根 ObjectTree blob（proposal 可溯源） */
    objectTreeRef: BlobRefSchema,
    styleId: z.string().min(1).optional(),
    assignments: z.array(StrategyAssignmentSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();
    for (const a of plan.assignments) {
      if (seen.has(a.nodeId)) ctx.addIssue({ code: 'custom', message: `nodeId 重复指派：${a.nodeId}` });
      seen.add(a.nodeId);
    }
  });
export type StrategyPlan = z.infer<typeof StrategyPlanSchema>;
