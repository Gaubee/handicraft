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
  KernelStrategyKindSchema,
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
  nodeProducesBlock,
  validateSceneRelations,
} from './kernel.js';
import { RegionSchema } from './paving.js';
import type { ObjectNode, SceneElement } from './kernel.js';

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
  it('单尾垫形态（len%3==2，如 5/8/560 字节）round-trip——P2.2 实证回归', () => {
    // 旧 decodeMaskData 拒收 c3 单垫 ⇒ encodeInlineMask 对 len%3==2 自抛
    // 「mask.data 非法 base64」（560=14×40 实尺寸掩码踩中）
    for (const n of [5, 8, 14 * 40]) {
      const bits = new Uint8Array(n).map((_, i) => (i % 2 === 0 ? 1 : 0));
      const inline = encodeInlineMask(n, 1, bits);
      expect(inline.data.endsWith('=')).toBe(true);
      expect(inline.data.endsWith('==')).toBe(false); // 单垫形态
      const back = decodeInlineMask(inline);
      expect(Array.from(back.bits)).toEqual(Array.from(bits));
    }
    // 垫符纪律不放宽：c2 垫而 c3 非 垫仍拒（'AA=!' 非法字符面已另有测试）
    expect(InlineMaskSchema.safeParse({ kind: 'inline', w: 1, h: 1, encoding: 'base64-01', data: 'AA=A' }).success).toBe(false);
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
  it('D3 树掩膜源锚：imageBlobRef 可选（新树恒带/旧树缺席兼容读/形状非法拒）', () => {
    const tree = streetlightTree();
    // 旧树缺席=undefined（兼容读——读侧回退 scene-analysis 锚）
    expect(ObjectTreeSchema.parse(tree).imageBlobRef).toBeUndefined();
    // 新树显式锚 round-trip（persistTreeWithPreview 单源写入面）
    const anchored = ObjectTreeSchema.parse({ ...tree, imageBlobRef: blobRef });
    expect(anchored.imageBlobRef).toBe(blobRef);
    // 形状非法拒（blobRef 值域——防模型/磁盘注入面乱值）
    expect(ObjectTreeSchema.safeParse({ ...tree, imageBlobRef: 'not-a-blobref' }).success).toBe(false);
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
  it('D1 风格检测：style 三值合法/缺席兼容/值域外拒（判定缺席≠非法值入库）', () => {
    // 三值合法（photographic=参考图层触发依据——D2 波消费）
    for (const style of ['flat', 'semi-flat', 'photographic'] as const) {
      expect(SceneAnalysisSchema.parse({ ...analysis, style }).style).toBe(style);
    }
    // 缺席兼容（旧工件/判定失败缺省——不阻塞原图流程）
    expect(SceneAnalysisSchema.parse(analysis).style).toBeUndefined();
    // 值域外拒（模型乱值在 daemon 解析侧归 undefined，不入库）
    expect(SceneAnalysisSchema.safeParse({ ...analysis, style: 'photo' }).success).toBe(false);
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

  // —— close-paving-backlog T2.1：gapFill 多尺寸混排（「打底+补隙」执行层正交模式）——
  it('gapFill：合法混排（stoneRef∈stones）round-trip——minGapRatio 缺省 1.0', () => {
    const parsed = StrategyAssignmentSchema.parse({
      ...base,
      stones: [stonePick, { ...stonePick, resourceId: 'stn-f3', sizeMm: 3 }],
      gapFill: { stoneRef: 'stn-f3' },
    });
    expect(parsed.gapFill).toEqual({ stoneRef: 'stn-f3', minGapRatio: 1.0 });
    // minGapRatio 显式 [1.0,3.0]
    expect(StrategyAssignmentSchema.parse({
      ...base,
      stones: [stonePick, { ...stonePick, resourceId: 'stn-f3', sizeMm: 3 }],
      gapFill: { stoneRef: 'stn-f3', minGapRatio: 2.5 },
    }).gapFill?.minGapRatio).toBe(2.5);
    expect(
      StrategyAssignmentSchema.safeParse({
        ...base,
        stones: [stonePick, { ...stonePick, resourceId: 'stn-f3', sizeMm: 3 }],
        gapFill: { stoneRef: 'stn-f3', minGapRatio: 3.1 },
      }).success,
    ).toBe(false);
    expect(
      StrategyAssignmentSchema.safeParse({
        ...base,
        stones: [stonePick, { ...stonePick, resourceId: 'stn-f3', sizeMm: 3 }],
        gapFill: { stoneRef: 'stn-f3', minGapRatio: 0.9 },
      }).success,
    ).toBe(false);
  });

  it('gapFill superRefine 拒：stoneRef 不在 stones / exclusion 组合 / free-code 组合 / strict 未知键', () => {
    // stoneRef ∉ stones
    expect(
      StrategyAssignmentSchema.safeParse({ ...base, gapFill: { stoneRef: 'stn-unknown' } }).success,
    ).toBe(false);
    // exclusion（不产钻）组合拒
    expect(
      StrategyAssignmentSchema.safeParse({
        ...base,
        strategyKind: 'exclusion',
        stones: [stonePick],
        gapFill: { stoneRef: 'stn-0a1b2c3d' },
      }).success,
    ).toBe(false);
    // free-code（沙箱自管钻）组合拒（free-code 另需 codeArtifactRef——双拒同报）
    expect(
      StrategyAssignmentSchema.safeParse({
        ...base,
        strategyKind: 'free-code',
        codeArtifactRef: blobRef,
        stones: [stonePick],
        gapFill: { stoneRef: 'stn-0a1b2c3d' },
      }).success,
    ).toBe(false);
    // strict：gapFill 未知键拒
    expect(
      StrategyAssignmentSchema.safeParse({
        ...base,
        stones: [stonePick, { ...stonePick, resourceId: 'stn-f3', sizeMm: 3 }],
        gapFill: { stoneRef: 'stn-f3', extra: 1 },
      }).success,
    ).toBe(false);
  });

  it('gapFill 缺席=现状逐位兼容（旧数据 parse 恒过——strict 可选键）', () => {
    const parsed = StrategyAssignmentSchema.parse(base);
    expect('gapFill' in parsed).toBe(false);
    expect(parsed.gapFill).toBeUndefined();
  });

  it('KernelStrategyKind 八值（close-paving-backlog T3：along-path 入枚举）', () => {
    expect(KernelStrategyKindSchema.options).toContain('along-path');
    expect(KernelStrategyKindSchema.options).toHaveLength(8);
    expect(StrategyAssignmentSchema.safeParse({ ...base, strategyKind: 'along-path' }).success).toBe(true);
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

// ---------------------------------------------------------------- v5 产块节点谓词（单源）

describe('nodeProducesBlock（v5 叶子谓词单源——修复轮 R1e）', () => {
  const leaf: Pick<ObjectNode, 'children'> = { children: [] };
  const group: Pick<ObjectNode, 'children'> = { children: ['a', 'b'] };
  it('恒=叶子：children 空=true；组（有 children）不论 drillWorthy 恒 false', () => {
    expect(nodeProducesBlock(leaf)).toBe(true);
    expect(nodeProducesBlock(group)).toBe(false);
  });
  it('接受 ObjectNode 结构子集（daemon 内核/前端视图节点/导出过滤三面同源消费）', () => {
    const node = { children: ['c'] } as Pick<ObjectNode, 'children'>;
    expect(nodeProducesBlock(node)).toBe(false);
  });
});

// ---------------------------------------------------------------- S2 v2 关系格式（realize-scene-understanding T1 / Codex B1）

describe('validateSceneRelations（S2→树构建的关系校验计划）', () => {
  const el = (elementId: string | undefined, parent: string | null | undefined, extra?: Partial<SceneElement>): SceneElement => ({
    name: `元素${elementId ?? '?'}`,
    boxPx: { x: 0, y: 0, w: 10, h: 10 },
    hint: 'subject',
    suggestDrillWorthy: true,
    ...(elementId !== undefined ? { elementId } : {}),
    ...(parent !== undefined ? { parentElementId: parent } : {}),
    ...(parent ? { relation: 'semantic' } : {}),
    ...(extra ?? {}),
  }) as SceneElement;

  it('structured：挂父/relation/拓扑序（父先子后——同深度保持数组序）', () => {
    const plan = validateSceneRelations([
      el('el-clown', null),
      el('el-hand', 'el-clown'),
      el('el-nose', 'el-face'),
      el('el-face', 'el-clown', { relation: 'semantic' }),
    ]);
    expect(plan.mode).toBe('structured');
    expect(plan.parentIndex).toEqual([-1, 0, 3, 0]);
    expect(plan.relationOfIndex).toEqual([null, 'semantic', 'semantic', 'semantic']);
    // 拓扑序：clown(0) 先于 face(3) 先于 nose(2)——hand(1) 与 nose 同深度 2，按数组序
    expect(plan.orderedIndices).toEqual([0, 1, 3, 2]);
  });

  it('legacy-flat：全员无 elementId=全部顶层+原数组序（v1 显式兼容）', () => {
    const plan = validateSceneRelations([el(undefined, undefined), el(undefined, undefined)]);
    expect(plan.mode).toBe('legacy-flat');
    expect(plan.parentIndex).toEqual([-1, -1]);
    expect(plan.orderedIndices).toEqual([0, 1]);
  });

  it('坏关系 typed 拒：格式混用/重复 id/parent 缺失/自指/成环/挂父缺 relation', () => {
    expect(() => validateSceneRelations([el('el-1', null), el(undefined, undefined)])).toThrow('混用');
    expect(() => validateSceneRelations([el('el-1', null), el('el-1', null)])).toThrow('重复');
    expect(() => validateSceneRelations([el('el-1', null), el('el-2', 'el-9')])).toThrow('不存在');
    expect(() => validateSceneRelations([el('el-1', 'el-1')])).toThrow('自指');
    expect(() => validateSceneRelations([el('el-1', 'el-2'), el('el-2', 'el-1')])).toThrow('成环');
    const noRelation = { name: 'x', boxPx: { x: 0, y: 0, w: 5, h: 5 }, hint: 'h', suggestDrillWorthy: true, elementId: 'el-2', parentElementId: 'el-1' };
    expect(() => validateSceneRelations([el('el-1', null), noRelation])).toThrow('relation');
  });
});

describe('SceneAnalysis v2 关系格式（schema 面）', () => {
  const base = {
    kind: 'scene-analysis' as const,
    imageBlobRef: blobRef,
    canvasCm: { w: 20, h: 20 },
    imagePx: { width: 736, height: 736 },
    createdAt: iso,
  };
  const structuredElements = [
    { elementId: 'el-clown', parentElementId: null, name: '小丑', boxPx: { x: 150, y: 100, w: 440, h: 540 }, hint: 'clown', suggestDrillWorthy: true },
    { elementId: 'el-hand', parentElementId: 'el-clown', relation: 'semantic', name: '左手', boxPx: { x: 170, y: 380, w: 90, h: 110 }, hint: 'hand', suggestDrillWorthy: true },
  ];

  it('v2 结构化清单 round-trip（elementId/parentElementId/relation 保留）', () => {
    const parsed = SceneAnalysisSchema.parse({ ...base, formatVersion: 2, elements: structuredElements });
    expect(parsed.formatVersion).toBe(2);
    expect(parsed.elements[1]!.parentElementId).toBe('el-clown');
    expect(parsed.elements[1]!.relation).toBe('semantic');
  });

  it('v2 平铺拒绝（无关系字段不得落 v2——legacy 形态应落 v1）', () => {
    const flat = structuredElements.map(({ elementId: _i, parentElementId: _p, relation: _r, ...rest }) => rest);
    expect(SceneAnalysisSchema.safeParse({ ...base, formatVersion: 2, elements: flat }).success).toBe(false);
  });

  it('v1 平铺旧工件显式兼容（缺关系字段——不按名称猜 anatomy）', () => {
    const flat = structuredElements.map(({ elementId: _i, parentElementId: _p, relation: _r, ...rest }) => rest);
    expect(SceneAnalysisSchema.safeParse({ ...base, formatVersion: 1, elements: flat }).success).toBe(true);
  });

  it('v2 坏关系 parse 拒（parent 缺失——不静默按数组序挂）', () => {
    const bad = [
      structuredElements[0]!,
      { ...structuredElements[1]!, parentElementId: 'el-none' },
    ];
    const check = SceneAnalysisSchema.safeParse({ ...base, formatVersion: 2, elements: bad });
    expect(check.success).toBe(false);
  });
});

describe('ObjectNode relation/origin 扩展（T1+T2——B2 细分节点标注）', () => {
  it("origin='refinement'+relation='refinement' 解析（SAM 拆分产物——B2 临时细分节点）", () => {
    const node = ObjectNodeSchema.parse({
      id: 'sam-node-0002',
      objectName: '小丑·部分1',
      category: 'figure',
      mask: encodeInlineMask(4, 4, new Uint8Array(16).fill(1)),
      bbox: { x: 0, y: 0, w: 4, h: 4 },
      parent: 'sam-node-0001',
      children: [],
      effectiveMm: 5,
      labVariance: 3,
      drillWorthy: true,
      origin: 'refinement',
      relation: 'refinement',
    });
    expect(node.origin).toBe('refinement');
    expect(node.relation).toBe('refinement');
  });

  it('旧树工件（无 relation 字段）仍解析——additive 兼容', () => {
    const node = ObjectNodeSchema.parse({
      id: 'n1',
      objectName: '路灯',
      category: 'structure',
      mask: encodeInlineMask(4, 4, new Uint8Array(16).fill(1)),
      bbox: { x: 0, y: 0, w: 4, h: 4 },
      parent: null,
      children: [],
      effectiveMm: 5,
      labVariance: 3,
      drillWorthy: true,
      origin: 'vlm+sam3',
    });
    expect(node.relation).toBeUndefined();
  });
});

describe('ObjectNode segmentPrompt 字段（add-vision-pipeline-v2 D4——指令原文可观测）', () => {
  it('携带 segmentPrompt 的节点解析（round-trip）；旧树无字段仍解析——additive 兼容', () => {
    const base = {
      id: 'sam-node-0003',
      objectName: '右发',
      category: 'hair',
      mask: encodeInlineMask(4, 4, new Uint8Array(16).fill(1)),
      bbox: { x: 0, y: 0, w: 4, h: 4 },
      parent: null,
      children: [],
      effectiveMm: 5,
      labVariance: 3,
      drillWorthy: true,
      origin: 'vlm+sam3',
    };
    const withPrompt = ObjectNodeSchema.parse({ ...base, segmentPrompt: '右发 as a whole, including all its component parts' });
    expect(withPrompt.segmentPrompt).toBe('右发 as a whole, including all its component parts');
    // 旧树（无字段）——反序列化兼容，缺省=undefined（不伪造）
    expect(ObjectNodeSchema.parse(base).segmentPrompt).toBeUndefined();
    // 全树面：混布（有/无字段节点同树）照常解析
    const tree = ObjectTreeSchema.parse({
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: { w: 30, h: 40 },
      imagePx: { width: 3000, height: 4000 },
      nodes: [
        { ...base, id: 'n-root', objectName: '画布', category: 'canvas', drillWorthy: false, children: ['sam-node-0003'] },
        { ...base, parent: 'n-root', segmentPrompt: 'hat' },
      ],
      createdAt: iso,
    });
    expect(tree.nodes[0]!.segmentPrompt).toBeUndefined();
    expect(tree.nodes[1]!.segmentPrompt).toBe('hat');
  });

  it('空串必拒（min(1)——写侧纪律「没有就 undefined，不填空串」的 schema 把守）', () => {
    expect(ObjectNodeSchema.safeParse({
      id: 'n1',
      objectName: '路灯',
      category: 'structure',
      mask: encodeInlineMask(4, 4, new Uint8Array(16).fill(1)),
      bbox: { x: 0, y: 0, w: 4, h: 4 },
      parent: null,
      children: [],
      effectiveMm: 5,
      labVariance: 3,
      drillWorthy: true,
      origin: 'vlm+sam3',
      segmentPrompt: '',
    }).success).toBe(false);
  });
});
