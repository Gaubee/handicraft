/**
 * ObjectTree→Block[] 适配等价测试（add-subject-sam-pipeline design §3/§8——P0.2）。
 * 覆盖：drillWorthy 组合×3 场景（仅叶/父可钻灯头排除/全可钻）的树展开计数 +
 * blockId=nodeId 同寻址 + mask 逐位等价（编码→解码 round-trip+blob/inline 同树同果）+
 * origin 链（originBlockId=父 Block id/parentNodeId 树链/depth）+ 字段回填
 * （label 祖先链/areaPx/widthPx 距离变换/suggested 推断/colorRgb 注入与回退）+
 * ppm 数值与纵横比显式拒透传 + typed error 全谱 + 确定性（同输入同输出）。
 * 树形=P0.1 kernel.test 同款三层路灯（owner 原话：一根路灯=杆+灯；灯头嵌灯罩）。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectNodeSchema,
  ObjectTreeSchema,
  decodeInlineMask,
  encodeInlineMask,
  type BlobRef,
  type ObjectNode,
  type ObjectTree,
} from '@handicraft/contracts';
import { treeToBlocks, type ReadBlobFn, type TreeBlock } from '../src/kernel/vision/tree-to-blocks.js';

const iso = '2026-09-24T00:00:00.000Z';
/** 3000×4000 px / 30×40 cm → 10 px/mm（两轴一致）。 */
const canvasCm = { w: 30, h: 40 };
const imagePx = { width: 3000, height: 4000 };

/** 实心 w×h mask 字节。 */
function solid(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h).fill(1);
}

/** 三层路灯树（P0.1 同款）：路灯→(杆, 灯头→灯罩)；四节点四种几何（fill/linear/element/linear）。 */
interface NodeSpec {
  id: string;
  objectName: string;
  category: string;
  parent: string | null;
  children: string[];
  bbox: { x: number; y: number; w: number; h: number };
  bits: Uint8Array;
  drillWorthy: boolean;
}

function streetlightSpecs(drill: Record<string, boolean>): NodeSpec[] {
  return [
    {
      id: 'n-lamp',
      objectName: '路灯',
      category: 'structure',
      parent: null,
      children: ['n-lamp-pole', 'n-lamp-head'],
      bbox: { x: 100, y: 50, w: 12, h: 8 },
      bits: solid(12, 8),
      drillWorthy: drill['n-lamp'] ?? true,
    },
    {
      id: 'n-lamp-pole',
      objectName: '路灯·杆',
      category: 'structure',
      parent: 'n-lamp',
      children: [],
      bbox: { x: 104, y: 58, w: 20, h: 2 },
      bits: solid(20, 2),
      drillWorthy: drill['n-lamp-pole'] ?? true,
    },
    {
      id: 'n-lamp-head',
      objectName: '路灯·灯头',
      category: 'light',
      parent: 'n-lamp',
      children: ['n-lamp-shade'],
      bbox: { x: 112, y: 44, w: 2, h: 2 },
      bits: new Uint8Array([1, 1, 1, 0]),
      drillWorthy: drill['n-lamp-head'] ?? true,
    },
    {
      id: 'n-lamp-shade',
      objectName: '路灯·灯头·灯罩',
      category: 'structure',
      parent: 'n-lamp-head',
      children: [],
      bbox: { x: 111, y: 40, w: 4, h: 4 },
      bits: solid(4, 4),
      drillWorthy: drill['n-lamp-shade'] ?? true,
    },
  ];
}

/** inline 态树。 */
function inlineTree(drill: Record<string, boolean>): ObjectTree {
  return ObjectTreeSchema.parse({
    kind: 'object-tree' as const,
    formatVersion: 1 as const,
    canvasCm,
    imagePx,
    nodes: streetlightSpecs(drill).map((s) =>
      ObjectNodeSchema.parse({
        id: s.id,
        objectName: s.objectName,
        category: s.category,
        mask: encodeInlineMask(s.bbox.w, s.bbox.h, s.bits),
        bbox: s.bbox,
        parent: s.parent,
        children: s.children,
        effectiveMm: 6.4,
        labVariance: 4.2,
        drillWorthy: s.drillWorthy,
        origin: 'vlm+sam3' as const,
      }),
    ),
    createdAt: iso,
  });
}

/** blob 态树（同几何同 drill；ref=节点序号派生伪 sha256——十六进制 64 位，节点间互异）。 */
function blobRefOf(index: number): BlobRef {
  return ('a'.repeat(63) + String(index)) as BlobRef;
}

function blobTree(drill: Record<string, boolean>): { tree: ObjectTree; store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  const nodes = streetlightSpecs(drill).map((s, i) => {
    const ref = blobRefOf(i);
    store.set(ref, s.bits);
    return ObjectNodeSchema.parse({
      id: s.id,
      objectName: s.objectName,
      category: s.category,
      mask: { kind: 'blob' as const, w: s.bbox.w, h: s.bbox.h, blobRef: ref },
      bbox: s.bbox,
      parent: s.parent,
      children: s.children,
      effectiveMm: 6.4,
      labVariance: 4.2,
      drillWorthy: s.drillWorthy,
      origin: 'vlm+sam3' as const,
    });
  });
  return {
    tree: ObjectTreeSchema.parse({
      kind: 'object-tree' as const,
      formatVersion: 1 as const,
      canvasCm,
      imagePx,
      nodes,
      createdAt: iso,
    }),
    store,
  };
}

const readFrom = (store: Map<string, Uint8Array>): ReadBlobFn => (ref) => store.get(ref) ?? null;
const noBlob: ReadBlobFn = () => null;
/** gemDiameterPx=2 → elementAreaPx=max(13, ceil(π·1²))=13；linearWidthPx=6。 */
const opts = { gemDiameterPx: 2 };

/** 深比较友好投影（Uint8Array → number[]）。 */
function project(b: TreeBlock): unknown {
  return { ...b, mask: { w: b.mask.w, h: b.mask.h, bits: Array.from(b.mask.bits) } };
}

describe('树展开：drillWorthy 组合×3 场景（叶子必产/中间按 drillWorthy）', () => {
  it('场景 1 仅叶：全 drillWorthy=false → 杆+灯罩两块（灯头=light 排除不产；叶仍产——排除是策略层 Gem 关注）', () => {
    const res = treeToBlocks(inlineTree({ 'n-lamp': false, 'n-lamp-pole': false, 'n-lamp-head': false, 'n-lamp-shade': false }), { readBlob: noBlob }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.blocks.map((b) => b.id)).toEqual(['n-lamp-pole', 'n-lamp-shade']);
    // 父均未产块 → originBlockId=null，但树链 parentNodeId 完整保留。
    expect(res.blocks.map((b) => b.origin.originBlockId)).toEqual([null, null]);
    expect(res.blocks.map((b) => b.origin.parentNodeId)).toEqual(['n-lamp', 'n-lamp-head']);
    expect(res.blocks.every((b) => b.origin.isLeaf)).toBe(true);
  });

  it('场景 2 父可钻（灯头排除）：路灯/杆/灯罩三块——灯头中间且 false 不产', () => {
    const res = treeToBlocks(inlineTree({ 'n-lamp': true, 'n-lamp-head': false }), { readBlob: noBlob }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.blocks.map((b) => b.id)).toEqual(['n-lamp', 'n-lamp-pole', 'n-lamp-shade']);
    const byId = new Map(res.blocks.map((b) => [b.id, b]));
    // 杆的父块=路灯（产了）；灯罩的父节点=灯头（未产）→ originBlockId=null 但 parentNodeId 在。
    expect(byId.get('n-lamp-pole')!.origin.originBlockId).toBe('n-lamp');
    expect(byId.get('n-lamp-shade')!.origin).toMatchObject({ originBlockId: null, parentNodeId: 'n-lamp-head' });
    expect(byId.get('n-lamp')!.origin).toMatchObject({ originBlockId: null, parentNodeId: null, depth: 0 });
  });

  it('场景 3 全可钻：四块全产（父子都产+origin 父子关系——策略层选粒度）', () => {
    const res = treeToBlocks(inlineTree({}), { readBlob: noBlob }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.blocks.map((b) => b.id)).toEqual(['n-lamp', 'n-lamp-pole', 'n-lamp-head', 'n-lamp-shade']);
    const byId = new Map(res.blocks.map((b) => [b.id, b]));
    expect(byId.get('n-lamp-pole')!.origin.originBlockId).toBe('n-lamp');
    expect(byId.get('n-lamp-head')!.origin.originBlockId).toBe('n-lamp');
    expect(byId.get('n-lamp-shade')!.origin.originBlockId).toBe('n-lamp-head');
    expect(res.blocks.map((b) => b.origin.depth)).toEqual([0, 1, 1, 2]);
  });

  it('blockId=blockIdOfNode（同寻址空间）：输出 id 逐一等于节点 id', () => {
    const tree = inlineTree({});
    const res = treeToBlocks(tree, { readBlob: noBlob }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    for (const b of res.blocks) {
      expect(tree.nodes.some((n) => n.id === b.id)).toBe(true);
    }
  });
});

describe('mask 同构：逐位等价（inline round-trip + blob/inline 同树同果）', () => {
  it('inline 态：block.mask 逐位=decodeInlineMask(node.mask)，且编码→解码 round-trip 自洽', () => {
    const tree = inlineTree({});
    const res = treeToBlocks(tree, { readBlob: noBlob }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const nodes = new Map(tree.nodes.map((n) => [n.id, n]));
    for (const b of res.blocks) {
      const node = nodes.get(b.id)!;
      if (node.mask.kind !== 'inline') throw new Error('fixture 应为 inline 态');
      const decoded = decodeInlineMask(node.mask);
      expect(b.mask.w).toBe(decoded.w);
      expect(b.mask.h).toBe(decoded.h);
      expect(Array.from(b.mask.bits)).toEqual(Array.from(decoded.bits));
      // round-trip：block 位图自身重编码再解码逐位等价。
      const rt = decodeInlineMask(encodeInlineMask(b.mask.w, b.mask.h, b.mask.bits));
      expect(Array.from(rt.bits)).toEqual(Array.from(b.mask.bits));
    }
  });

  it('blob 态与 inline 态同树同果（读 blob 字节→同 blocks 逐字段等价）', () => {
    const { tree, store } = blobTree({});
    const resBlob = treeToBlocks(tree, { readBlob: readFrom(store) }, opts);
    const resInline = treeToBlocks(inlineTree({}), { readBlob: noBlob }, opts);
    expect(resBlob.ok).toBe(true);
    expect(resInline.ok).toBe(true);
    if (!resBlob.ok || !resInline.ok) return;
    expect(resBlob.blocks.map(project)).toEqual(resInline.blocks.map(project));
    expect(resBlob.pixelsPerMm).toBe(resInline.pixelsPerMm);
  });
});

describe('字段回填（label 链/几何统计/suggested 推断/colorRgb）', () => {
  /** 全可钻树的块表（fixture 必须适配成功——否则测试自身失效）。 */
  function full(): Map<string, TreeBlock> {
    const res = treeToBlocks(inlineTree({}), { readBlob: noBlob }, opts);
    if (!res.ok) throw new Error(`fixture 树必须适配成功：${JSON.stringify(res)}`);
    return new Map(res.blocks.map((b) => [b.id, b]));
  }

  it('label=objectName 祖先链（「路灯/杆」「路灯/灯头/灯罩」）', () => {
    const byId = full();
    expect(byId.get('n-lamp')!.label).toBe('路灯');
    expect(byId.get('n-lamp-pole')!.label).toBe('路灯/杆');
    expect(byId.get('n-lamp-head')!.label).toBe('路灯/灯头');
    expect(byId.get('n-lamp-shade')!.label).toBe('路灯/灯头/灯罩');
  });

  it('areaPx=mask 计数；bbox=node.bbox 画布锚点直拷', () => {
    const byId = full();
    expect(byId.get('n-lamp')!.areaPx).toBe(96);
    expect(byId.get('n-lamp-pole')!.areaPx).toBe(40);
    expect(byId.get('n-lamp-head')!.areaPx).toBe(3);
    expect(byId.get('n-lamp-shade')!.areaPx).toBe(16);
    expect(byId.get('n-lamp-pole')!.bbox).toEqual({ x: 104, y: 58, w: 20, h: 2 });
  });

  it('widthPx=距离变换宽度（2×到背景距离；虚拟背景边框——贴边不虚高）', () => {
    const byId = full();
    // 12×8 实心：中心到最近背景 4px → max=8。
    expect(byId.get('n-lamp')!.widthPx.max).toBe(8);
    // 20×2 实心：处处距虚拟背景 1px → max=mean=2。
    expect(byId.get('n-lamp-pole')!.widthPx).toEqual({ max: 2, mean: 2 });
    // 4×4 实心：中心距 2px → max=4（mean=2.5：角 1/边 1/心 2 均值 1.25×2）。
    expect(byId.get('n-lamp-shade')!.widthPx).toEqual({ max: 4, mean: 2.5 });
  });

  it('suggested=引擎文档化推断（面积<单钻足迹→element；宽度<3 钻径→linear；否则 fill）', () => {
    const byId = full();
    expect(byId.get('n-lamp')!.suggested).toBe('fill'); // 96≥13 且 max8≥6
    expect(byId.get('n-lamp-pole')!.suggested).toBe('linear'); // 40≥13 且 max2<6
    expect(byId.get('n-lamp-head')!.suggested).toBe('element'); // 3<13
    expect(byId.get('n-lamp-shade')!.suggested).toBe('linear'); // 16≥13 且 max4<6
  });

  it('colorRgb：注入节点色生效；缺省确定性灰+colorSource 标注', () => {
    const colored = treeToBlocks(inlineTree({}), { readBlob: noBlob }, {
      gemDiameterPx: 2,
      nodeColors: { 'n-lamp-pole': [200, 30, 30], 'n-lamp': [10, 20, 30] },
    });
    expect(colored.ok).toBe(true);
    if (!colored.ok) return;
    const cById = new Map(colored.blocks.map((b) => [b.id, b]));
    expect(cById.get('n-lamp-pole')!.colorRgb).toEqual([200, 30, 30]);
    expect(cById.get('n-lamp-pole')!.origin.colorSource).toBe('node-color');
    expect(cById.get('n-lamp')!.colorRgb).toEqual([10, 20, 30]);
    expect(cById.get('n-lamp-head')!.colorRgb).toEqual([128, 128, 128]);
    expect(cById.get('n-lamp-head')!.origin.colorSource).toBe('fallback');
  });

  it('origin 标注透传停止判据数据与排除开关（effectiveMm/labVariance/category/drillWorthy）', () => {
    const byId = full();
    expect(byId.get('n-lamp-head')!.origin).toMatchObject({
      nodeCategory: 'light',
      drillWorthy: true,
      nodeOrigin: 'vlm+sam3',
      effectiveMm: 6.4,
      labVariance: 4.2,
    });
  });
});

describe('pixelsPerMm（§1 S1——derivePixelsPerMm 消费）', () => {
  it('3000×4000 px / 30×40 cm → 10 px/mm（两轴均值）', () => {
    const res = treeToBlocks(inlineTree({}), { readBlob: noBlob }, opts);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pixelsPerMm).toBe(10);
  });

  it('纵横比>2% 显式拒（typed error 透传：aspectCm/aspectPx 数值随行）', () => {
    const tree = inlineTree({});
    const skewed = { ...tree, imagePx: { width: 4000, height: 3000 } } as ObjectTree;
    const res = treeToBlocks(skewed, { readBlob: noBlob }, opts);
    expect(res).toEqual({
      ok: false,
      reason: 'aspect-mismatch',
      aspectCm: 0.75,
      aspectPx: 4000 / 3000,
    });
  });
});

describe('typed error 全谱（不抛不猜——畸形输入显式拒）', () => {
  it('mask 尺寸 ≠ bbox 尺寸 → mask-dims-mismatch（锚点语义未定义）', () => {
    const tree = inlineTree({});
    const nodes = tree.nodes.map((n) =>
      n.id === 'n-lamp-shade' ? { ...n, bbox: { ...n.bbox, w: 3 } } : n,
    ) as ObjectNode[];
    const bad = { ...tree, nodes } as ObjectTree;
    const res = treeToBlocks(bad, { readBlob: noBlob }, opts);
    expect(res).toEqual({
      ok: false,
      reason: 'mask-dims-mismatch',
      nodeId: 'n-lamp-shade',
      maskW: 4,
      maskH: 4,
      bboxW: 3,
      bboxH: 4,
    });
  });

  it('blob 无 active 行 → blob-missing', () => {
    const { tree } = blobTree({});
    const res = treeToBlocks(tree, { readBlob: noBlob }, opts);
    expect(res).toMatchObject({ ok: false, reason: 'blob-missing', nodeId: 'n-lamp' });
  });

  it('blob 字节长度 ≠ w*h → mask-bytes-invalid', () => {
    const { tree, store } = blobTree({});
    const ref = (tree.nodes[0]!.mask as { blobRef: BlobRef }).blobRef;
    store.set(ref, new Uint8Array(5)); // 12×8 应 96
    const res = treeToBlocks(tree, { readBlob: readFrom(store) }, opts);
    expect(res).toMatchObject({ ok: false, reason: 'mask-bytes-invalid', nodeId: 'n-lamp' });
  });

  it('blob 字节 ∉ {0,1} → mask-bytes-invalid', () => {
    const { tree, store } = blobTree({});
    const ref = (tree.nodes[0]!.mask as { blobRef: BlobRef }).blobRef;
    store.set(ref, new Uint8Array(96).fill(2));
    const res = treeToBlocks(tree, { readBlob: readFrom(store) }, opts);
    expect(res).toMatchObject({ ok: false, reason: 'mask-bytes-invalid', nodeId: 'n-lamp' });
  });

  it('全零 mask（零成员像素节点）→ empty-mask', () => {
    const tree = inlineTree({});
    const nodes = tree.nodes.map((n) =>
      n.id === 'n-lamp-pole'
        ? { ...n, mask: encodeInlineMask(20, 2, new Uint8Array(40)), bbox: { ...n.bbox } }
        : n,
    ) as ObjectNode[];
    const res = treeToBlocks({ ...tree, nodes } as ObjectTree, { readBlob: noBlob }, opts);
    expect(res).toEqual({ ok: false, reason: 'empty-mask', nodeId: 'n-lamp-pole' });
  });

  it('nodeColors 条目非法（越界/非整数/长度错）→ color-invalid', () => {
    for (const bad of [[256, 0, 0], [1.5, 0, 0], [1, 2]] as [number, number, number][]) {
      const res = treeToBlocks(inlineTree({}), { readBlob: noBlob }, { gemDiameterPx: 2, nodeColors: { 'n-lamp': bad } });
      expect(res).toMatchObject({ ok: false, reason: 'color-invalid', nodeId: 'n-lamp' });
    }
  });

  it('gemDiameterPx 非正 → RangeError（编程错误面，非 typed error）', () => {
    expect(() => treeToBlocks(inlineTree({}), { readBlob: noBlob }, { gemDiameterPx: 0 })).toThrow(RangeError);
  });
});

describe('确定性（同输入同输出）', () => {
  it('两次调用逐字段等价（含 blob 态）', () => {
    const { tree, store } = blobTree({});
    const a = treeToBlocks(tree, { readBlob: readFrom(store) }, opts);
    const b = treeToBlocks(tree, { readBlob: readFrom(store) }, opts);
    expect(a).toEqual(b);
  });
});
