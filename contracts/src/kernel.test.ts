/**
 * 主体分割内核契约单测（add-subject-sam-pipeline P0.1——design §1/§3/§4.4/§5）。
 * 覆盖：全 schema round-trip + 坏输入 typed error + object-tree 嵌套/路灯父子
 * （owner 原话：一根路灯=杆+灯）+ mask 内联/blob 二态与 0/1 同构校验 + ppm 推导
 * 数值（纵横比不符显式拒）+ 具名常量快照（定稿增量②③）+ blockId id 桥
 * （paving Region 直接接受 nodeId）。
 */
import { describe, expect, it } from 'vitest';
import {
  BlobMaskSchema,
  CANVAS_ASPECT_TOLERANCE,
  CanvasDeclarationSchema,
  CodeStrategyArtifactSchema,
  DEFAULT_DENSITY_PER_CM2,
  DELTA_E_COARSE,
  DELTA_E_FAMILY,
  DELTA_E_NEAR,
  InlineMaskSchema,
  ObjectNodeSchema,
  ObjectTreeSchema,
  SceneAnalysisSchema,
  StrategyAssignmentSchema,
  StrategyPlanSchema,
  blockIdOfNode,
  blockIdsOfTree,
  decodeInlineMask,
  derivePixelsPerMm,
  encodeInlineMask,
} from './kernel.js';
import { RegionSchema } from './paving.js';
import type { ObjectNode } from './kernel.js';

const iso = '2026-09-25T00:00:00.000Z';
const blobRef = 'a'.repeat(64);

// ---------------------------------------------------------------- 常量快照（定稿增量②③）

describe('具名常量冻结（Owner 定调+实验出处）', () => {
  it('默认密度 2.3/cm²（Owner 2026-09-24 晚自编常数待标定）', () => {
    expect(DEFAULT_DENSITY_PER_CM2).toBe(2.3);
  });
  it('ΔE76 三档 3/10/25（experiments/rhinestone-catalog-20260924/SUBSTITUTION.md 决策序）', () => {
    expect([DELTA_E_NEAR, DELTA_E_FAMILY, DELTA_E_COARSE]).toEqual([3, 10, 25]);
    expect(DELTA_E_NEAR).toBeLessThan(DELTA_E_FAMILY);
    expect(DELTA_E_FAMILY).toBeLessThan(DELTA_E_COARSE);
  });
  it('纵横比容差缺省 2%', () => {
    expect(CANVAS_ASPECT_TOLERANCE).toBe(0.02);
  });
});

// ---------------------------------------------------------------- ppm 推导（§1 S1）

describe('derivePixelsPerMm（canvasCm 一等输入）', () => {
  it('30×40cm + 3000×4000px → 恰 10 px/mm（两轴一致）', () => {
    const r = derivePixelsPerMm({ canvasCm: { w: 30, h: 40 }, imagePx: { width: 3000, height: 4000 } });
    expect(r).toEqual({ ok: true, pixelsPerMm: 10 });
  });
  it('A4 21×29.7cm + 1240×1754px → 两轴均值（舍入容差内）', () => {
    const r = derivePixelsPerMm({ canvasCm: { w: 21, h: 29.7 }, imagePx: { width: 1240, height: 1754 } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.pixelsPerMm).toBeCloseTo(5.90524, 4);
  });
  it('纵横比不符显式拒：30×40cm vs 3000×5000px（0.75 vs 0.6）', () => {
    const r = derivePixelsPerMm({ canvasCm: { w: 30, h: 40 }, imagePx: { width: 3000, height: 5000 } });
    expect(r).toEqual({ ok: false, reason: 'aspect-mismatch', aspectCm: 0.75, aspectPx: 0.6 });
  });
  it('容差可显式放宽：0.6 vs 0.75 相对偏差 0.2 ≤ tolerance 0.25 放行', () => {
    const r = derivePixelsPerMm(
      { canvasCm: { w: 30, h: 40 }, imagePx: { width: 3000, height: 5000 } },
      0.25,
    );
    expect(r.ok).toBe(true);
  });
  it('CanvasDeclaration schema 坏输入拒绝：非正 cm / 浮点像素 / 未知字段', () => {
    expect(
      CanvasDeclarationSchema.safeParse({ canvasCm: { w: 0, h: 40 }, imagePx: { width: 100, height: 100 } }).success,
    ).toBe(false);
    expect(
      CanvasDeclarationSchema.safeParse({ canvasCm: { w: 30, h: 40 }, imagePx: { width: 100.5, height: 100 } }).success,
    ).toBe(false);
    expect(
      CanvasDeclarationSchema.safeParse({
        canvasCm: { w: 30, h: 40 },
        imagePx: { width: 100, height: 100 },
        dpi: 150,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- mask 引用（§3 偏差[2]）

describe('mask 内联紧凑编码（引擎 Mask2D 同构：w*h 字节 0/1）', () => {
  it('encode→schema→decode round-trip（2×3 斑马行）', () => {
    const bits = new Uint8Array([1, 0, 1, 0, 1, 0]);
    const inline = encodeInlineMask(2, 3, bits);
    expect(InlineMaskSchema.parse(inline)).toEqual(inline);
    const back = decodeInlineMask(inline);
    expect(back.w).toBe(2);
    expect(back.h).toBe(3);
    expect(Array.from(back.bits)).toEqual([1, 0, 1, 0, 1, 0]);
  });
  it('单字节 mask（w=h=1，最短 base64 4 字符）round-trip', () => {
    const inline = encodeInlineMask(1, 1, new Uint8Array([1]));
    expect(decodeInlineMask(inline).bits[0]).toBe(1);
  });
  it('encodeInlineMask typed error：长度不符 / 非 0/1 字节 / 非正尺寸', () => {
    expect(() => encodeInlineMask(2, 2, new Uint8Array([1, 0, 0]))).toThrow(RangeError);
    expect(() => encodeInlineMask(1, 1, new Uint8Array([2]))).toThrow(/0,1/);
    expect(() => encodeInlineMask(0, 1, new Uint8Array())).toThrow(RangeError);
  });
  it('schema 坏输入拒绝：解码长度 ≠ w*h', () => {
    // 3 字节 'AAEC' 解码为 [0,1,2]——长度对 1×3 但字节 2 非法；对 2×2 长度即不符
    const three = encodeInlineMask(1, 3, new Uint8Array([0, 0, 0]));
    expect(InlineMaskSchema.safeParse({ ...three, w: 2, h: 2 }).success).toBe(false);
  });
  it('schema 坏输入拒绝：字节 ∉ {0,1}（0x02）', () => {
    const bad = {
      kind: 'inline' as const,
      w: 1,
      h: 3,
      encoding: 'base64-01' as const,
      data: 'AAEC', // 解码 [0,1,2]
    };
    expect(InlineMaskSchema.safeParse(bad).success).toBe(false);
  });
  it('schema 坏输入拒绝：非 base64 / 长度非 4 对齐 / 中置垫符', () => {
    expect(InlineMaskSchema.safeParse({ kind: 'inline', w: 1, h: 1, encoding: 'base64-01', data: 'A' }).success).toBe(false);
    expect(InlineMaskSchema.safeParse({ kind: 'inline', w: 1, h: 1, encoding: 'base64-01', data: 'A=BC' }).success).toBe(false);
    expect(InlineMaskSchema.safeParse({ kind: 'inline', w: 2, h: 2, encoding: 'base64-01', data: 'AAAAA' }).success).toBe(false);
  });
  it('blob 态：w/h 随行+blobRef 内容寻址（64 hex）', () => {
    const blob = BlobMaskSchema.parse({ kind: 'blob', w: 4, h: 4, blobRef });
    expect(blob.kind).toBe('blob');
    expect(BlobMaskSchema.safeParse({ kind: 'blob', w: 4, h: 4, blobRef: 'xyz' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- ObjectTree（§3 路灯父子）

/** 路灯树（owner 原话：一根路灯=杆的部分+灯的部分；灯头再嵌灯罩=三层验证）。 */
function streetlightNodes(): ObjectNode[] {
  const inline = encodeInlineMask(2, 2, new Uint8Array([1, 1, 1, 0]));
  const node = (
    id: string,
    objectName: string,
    category: string,
    parent: string | null,
    children: string[],
  ): ObjectNode =>
    ObjectNodeSchema.parse({
      id,
      objectName,
      category,
      mask: inline,
      bbox: { x: 10, y: 20, w: 2, h: 2 },
      parent,
      children,
      effectiveMm: 6.4,
      labVariance: 4.2,
      drillWorthy: true,
      origin: 'vlm+sam3',
    });
  return [
    node('n-lamp', '路灯', 'structure', null, ['n-lamp-pole', 'n-lamp-head']),
    node('n-lamp-pole', '路灯·杆', 'structure', 'n-lamp', []),
    node('n-lamp-head', '路灯·灯头', 'light', 'n-lamp', ['n-lamp-shade']),
    node('n-lamp-shade', '路灯·灯头·灯罩', 'structure', 'n-lamp-head', []),
  ];
}

function streetlightTree() {
  return ObjectTreeSchema.parse({
    kind: 'object-tree' as const,
    formatVersion: 1 as const,
    canvasCm: { w: 30, h: 40 },
    imagePx: { width: 3000, height: 4000 },
    nodes: streetlightNodes(),
    createdAt: iso,
  });
}

// ObjectNodeSchema 的 round-trip 已由 streetlightNodes 内部 parse 覆盖（下文另有坏输入用例）。

describe('ObjectTree：路灯嵌套/归属关系（owner 定调）', () => {
  it('三层树 round-trip：路灯→(杆, 灯头→灯罩)，canvasCm 尺寸锚点随树留存', () => {
    const tree = streetlightTree();
    expect(tree.nodes).toHaveLength(4);
    const head = tree.nodes.find((n) => n.id === 'n-lamp-head')!;
    expect(head.objectName).toBe('路灯·灯头');
    expect(head.parent).toBe('n-lamp');
    expect(head.children).toEqual(['n-lamp-shade']);
  });
  it('坏树拒绝：parent 指向不存在节点', () => {
    const tree = streetlightTree();
    tree.nodes[1]!.parent = 'n-ghost';
    expect(ObjectTreeSchema.safeParse(tree).success).toBe(false);
  });
  it('坏树拒绝：父子非双向（父 children 缺子）', () => {
    const tree = streetlightTree();
    tree.nodes[0]!.children = ['n-lamp-pole'];
    expect(ObjectTreeSchema.safeParse(tree).success).toBe(false);
  });
  it('坏树拒绝：child 不存在', () => {
    const tree = streetlightTree();
    tree.nodes[2]!.children = ['n-lamp-shade', 'n-ghost'];
    expect(ObjectTreeSchema.safeParse(tree).success).toBe(false);
  });
  it('坏树拒绝：id 重复', () => {
    const tree = streetlightTree();
    tree.nodes[3]!.id = 'n-lamp-pole';
    expect(ObjectTreeSchema.safeParse(tree).success).toBe(false);
  });
  it('坏树拒绝：双根/无根（必须恰一根）', () => {
    const two = streetlightTree();
    two.nodes[1]!.parent = null;
    expect(ObjectTreeSchema.safeParse(two).success).toBe(false);
    const none = streetlightTree();
    none.nodes[0]!.parent = 'n-lamp-pole';
    expect(ObjectTreeSchema.safeParse(none).success).toBe(false);
  });
  it('坏树拒绝：自指/children 重复', () => {
    const self = streetlightTree();
    self.nodes[1]!.parent = 'n-lamp-pole';
    self.nodes[0]!.children = ['n-lamp-head'];
    expect(ObjectTreeSchema.safeParse(self).success).toBe(false);
    const dupChild = streetlightTree();
    dupChild.nodes[0]!.children = ['n-lamp-pole', 'n-lamp-pole', 'n-lamp-head'];
    expect(ObjectTreeSchema.safeParse(dupChild).success).toBe(false);
  });
  it('坏节点拒绝：空 objectName / 非法 origin / 负 labVariance / 未知字段', () => {
    const [pole] = streetlightNodes();
    expect(ObjectNodeSchema.safeParse({ ...pole, objectName: '' }).success).toBe(false);
    expect(ObjectNodeSchema.safeParse({ ...pole, origin: 'sam' }).success).toBe(false);
    expect(ObjectNodeSchema.safeParse({ ...pole, labVariance: -1 }).success).toBe(false);
    expect(ObjectNodeSchema.safeParse({ ...pole, extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- blockId id 桥

describe('blockIds 接受 nodeId（同寻址空间——适配层约定字段）', () => {
  it('blockIdOfNode/blockIdsOfTree：节点 id 原样即 BlockId', () => {
    const tree = streetlightTree();
    expect(blockIdOfNode(tree.nodes[1]!)).toBe('n-lamp-pole');
    expect(blockIdsOfTree(tree)).toEqual(['n-lamp', 'n-lamp-pole', 'n-lamp-head', 'n-lamp-shade']);
  });
  it('paving Region（kind:blocks）直接接受 nodeId 寻址', () => {
    const ids = blockIdsOfTree(streetlightTree());
    expect(RegionSchema.parse({ kind: 'blocks', ids })).toEqual({ kind: 'blocks', ids });
  });
});

// ---------------------------------------------------------------- SceneAnalysis（§1 S2）

describe('SceneAnalysis（VLM 识图产物）', () => {
  const analysis = {
    kind: 'scene-analysis' as const,
    formatVersion: 1 as const,
    imageBlobRef: blobRef,
    canvasCm: { w: 30, h: 40 },
    imagePx: { width: 3000, height: 4000 },
    elements: [
      {
        name: '路灯',
        category: 'structure',
        boxPx: { x: 1200, y: 300, w: 180, h: 900 },
        hint: 'street lamp',
        suggestDrillWorthy: true,
        confidence: 0.91,
      },
      { name: '黑色背景', boxPx: { x: 0, y: 0, w: 3000, h: 4000 }, hint: 'background', suggestDrillWorthy: false },
    ],
    createdAt: iso,
  };

  it('round-trip（主体清单+值得贴判定+尺寸锚点 canvasCm 一等输入）', () => {
    const parsed = SceneAnalysisSchema.parse(analysis);
    expect(parsed.elements).toHaveLength(2);
    expect(parsed.elements[1]!.suggestDrillWorthy).toBe(false);
    expect(parsed.canvasCm).toEqual({ w: 30, h: 40 });
  });
  it('坏输入拒绝：空元素表 / confidence 越界 / 缺 canvasCm（一等输入必填）', () => {
    expect(SceneAnalysisSchema.safeParse({ ...analysis, elements: [] }).success).toBe(false);
    expect(SceneAnalysisSchema.safeParse({ ...analysis, elements: [{ ...analysis.elements[0]!, confidence: 1.5 }] }).success).toBe(false);
    const { canvasCm: _drop, ...noCanvas } = analysis;
    expect(SceneAnalysisSchema.safeParse(noCanvas).success).toBe(false);
  });
});

// ---------------------------------------------------------------- 代码策略工件（§4.4）

describe('CodeStrategyArtifact（自由代码工件形状：source/entryPoint/声明式元数据）', () => {
  const artifact = {
    kind: 'free-code-artifact' as const,
    formatVersion: 1 as const,
    language: 'javascript' as const,
    source: 'function layout(ctx) { return ctx.scatter(ctx.mask, ctx.stones[0], 2.3); }',
    entryPoint: 'layout',
    seed: 42,
    declaredApiCalls: ['mask', 'stones', 'scatter'],
    description: '叶序螺旋布钻',
    createdAt: iso,
  };

  it('round-trip（seed 确定性回放位）', () => {
    const parsed = CodeStrategyArtifactSchema.parse(artifact);
    expect(parsed.entryPoint).toBe('layout');
    expect(parsed.seed).toBe(42);
  });
  it('坏输入拒绝：Python（调研项未开）/ 空 source / 负 seed / 空 entryPoint', () => {
    expect(CodeStrategyArtifactSchema.safeParse({ ...artifact, language: 'python' }).success).toBe(false);
    expect(CodeStrategyArtifactSchema.safeParse({ ...artifact, source: '' }).success).toBe(false);
    expect(CodeStrategyArtifactSchema.safeParse({ ...artifact, seed: -1 }).success).toBe(false);
    expect(CodeStrategyArtifactSchema.safeParse({ ...artifact, entryPoint: '' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- 策略指派（§5+定稿增量①）

const stonePick = {
  resourceId: 'stn-0a1b2c3d',
  sku: 'J51',
  supplier: 'yuhang',
  sizeMm: 2,
  colorHex: '#FFFFF0',
};

describe('StrategyAssignment（钻引用统一 StonePick——定稿增量①）', () => {
  const base = {
    nodeId: 'n-lamp-pole',
    strategyKind: 'straight-line' as const,
    params: { along: 'vertical' },
    stones: [stonePick],
    rationale: '刚硬物直线贴法（owner：路灯=直线）',
  };

  it('round-trip：densityPerCm2 缺省=2.3（定稿增量②）+ StonePick 引用', () => {
    const parsed = StrategyAssignmentSchema.parse(base);
    expect(parsed.densityPerCm2).toBe(2.3);
    expect(parsed.stones[0]!.resourceId).toBe('stn-0a1b2c3d');
    expect(parsed.stones[0]!.sizeMm).toBe(2);
  });
  it('engineStrategy 仅接受引擎五值（映射关系字段）', () => {
    expect(StrategyAssignmentSchema.safeParse({ ...base, engineStrategy: 'hex-pitch' }).success).toBe(true);
    expect(StrategyAssignmentSchema.safeParse({ ...base, engineStrategy: 'hex' }).success).toBe(false);
  });
  it('free-code ⟺ codeArtifactRef 交叉闭合：缺/多均拒', () => {
    expect(StrategyAssignmentSchema.safeParse({ ...base, strategyKind: 'free-code' }).success).toBe(false);
    expect(
      StrategyAssignmentSchema.safeParse({ ...base, strategyKind: 'geometry', codeArtifactRef: blobRef }).success,
    ).toBe(false);
    expect(
      StrategyAssignmentSchema.safeParse({
        ...base,
        strategyKind: 'free-code',
        codeArtifactRef: blobRef,
        rationale: '柳树顺枝条自写算法',
      }).success,
    ).toBe(true);
  });
  it('坏输入拒绝：七类外策略 / sizeMm null 的钻不可排钻语义仍可入列（显式态由消费方处理）', () => {
    expect(StrategyAssignmentSchema.safeParse({ ...base, strategyKind: 'hex-fill' }).success).toBe(false);
    const nullable = StrategyAssignmentSchema.safeParse({
      ...base,
      stones: [{ ...stonePick, sizeMm: null }],
    });
    expect(nullable.success).toBe(true);
  });
});

describe('StrategyPlan（S6 proposal 工件）', () => {
  const plan = {
    kind: 'strategy-plan' as const,
    formatVersion: 1 as const,
    objectTreeRef: blobRef,
    assignments: [
      {
        nodeId: 'n-lamp-pole',
        strategyKind: 'straight-line' as const,
        params: {},
        stones: [stonePick],
        rationale: '路灯杆=直线',
      },
      {
        nodeId: 'n-lamp-head',
        strategyKind: 'exclusion' as const,
        params: {},
        stones: [],
        rationale: '灯光类不贴（用户可改）',
      },
    ],
    createdAt: iso,
  };

  it('round-trip + styleId 预留位可选', () => {
    expect(StrategyPlanSchema.parse(plan).assignments).toHaveLength(2);
    expect(StrategyPlanSchema.safeParse({ ...plan, styleId: 'impressionist' }).success).toBe(true);
  });
  it('坏输入拒绝：nodeId 重复指派 / 空指派表', () => {
    expect(
      StrategyPlanSchema.safeParse({
        ...plan,
        assignments: [plan.assignments[0]!, { ...plan.assignments[1]!, nodeId: 'n-lamp-pole' }],
      }).success,
    ).toBe(false);
    expect(StrategyPlanSchema.safeParse({ ...plan, assignments: [] }).success).toBe(false);
  });
});
