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

/** 严格 base64 解码（字母表+4 字符对齐+尾垫仅限末组 c2/c3 且 c2='='⇒c3='='；非法返回 null）。 */
function decodeMaskData(s: string): Uint8Array | null {
  if (s.length === 0 || s.length % 4 !== 0) return null;
  const rev = new Map<string, number>();
  for (let i = 0; i < B64_ALPHABET.length; i++) rev.set(B64_ALPHABET[i]!, i);
  let padding = 0;
  if (s.endsWith('==')) padding = 2;
  else if (s.endsWith('=')) padding = 1;
  const out = new Uint8Array((s.length / 4) * 3 - padding);
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const isLast = i + 4 === s.length;
    const quad = [s[i], s[i + 1], s[i + 2], s[i + 3]];
    if (quad.some((c) => c === undefined)) return null;
    const val: number[] = [];
    for (let j = 0; j < 4; j++) {
      const ch = quad[j]!;
      if (ch === '=') {
        // 垫符仅允许出现在末组第 2/3 位，且 c2 垫 ⇒ c3 垫（c3 单垫=len%3==2 标准形态——
        // 旧条件 `quad[2] !== '='` 会拒收自产编码，P2.2 实证修复）
        if (!isLast || j < 2) return null;
        if (j === 2 && quad[3] !== '=') return null;
        val.push(0);
        continue;
      }
      const d = rev.get(ch);
      if (d === undefined) return null;
      val.push(d);
    }
    out[o++] = (val[0]! << 2) | (val[1]! >> 4);
    if (quad[2] !== '=') out[o++] = ((val[1]! & 0x0f) << 4) | (val[2]! >> 2);
    if (quad[3] !== '=') out[o++] = ((val[2]! & 0x03) << 6) | val[3]!;
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
export const ObjectOriginSchema = z.enum(['vlm+sam3', 'manual-lasso', 'auto-color']);
export type ObjectOrigin = z.infer<typeof ObjectOriginSchema>;

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

/** 全树节点 id → BlockId[]（S7 拼接/S8 全局 enforceMinDistance 按此寻址）。 */
export function blockIdsOfTree(tree: ObjectTree): NodeId[] {
  return tree.nodes.map((n) => n.id);
}

// ---------------------------------------------------------------- §1 S2 SceneAnalysis（VLM 识图产物）

/** S2 元素（首轮=SAM3 提示来源；box=画布像素坐标）。 */
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
  })
  .strict();
export type SceneElement = z.infer<typeof SceneElementSchema>;

export const SceneAnalysisSchema = z
  .object({
    kind: z.literal('scene-analysis'),
    formatVersion: z.literal(1),
    imageBlobRef: BlobRefSchema,
    /** 尺寸锚点（一等输入——S1 声明随工件留存，S5 ObjectTree 同字段回填） */
    canvasCm: CanvasCmSchema,
    imagePx: ImagePxSchema,
    elements: z.array(SceneElementSchema).min(1),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
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
 * 内核策略七类（Owner 定调四族展开——owner-directive 主文+补充定调）：
 * 纹理贴图法/柔和曲线/花形/直线（刚硬物）/几何（星射线·心·方·圆·矩·椭圆·螺旋）/
 * 排除/自由代码。补充定调：排除族先搁置（drillWorthy 开关仍在，不作硬策略）。
 */
export const KernelStrategyKindSchema = z.enum([
  'texture-fill',
  'soft-curve',
  'flower',
  'straight-line',
  'geometry',
  'exclusion',
  'free-code',
]);
export type KernelStrategyKind = z.infer<typeof KernelStrategyKindSchema>;

/**
 * 单节点策略指派（§5 LLM proposal 单元）。钻引用统一 StonePick（定稿增量①：
 * resourceId 即 stoneRef——不再发明 specKey×colorId 双键）；密度默认 2.3/cm²
 * （定稿增量②）。engineStrategy=落引擎五策略面的映射（几何族降级 hex/引擎既有
 * 路径复用；排除/自由代码/内核执行器自产 Gem 时缺省）。
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
