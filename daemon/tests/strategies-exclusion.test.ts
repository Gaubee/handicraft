/**
 * 排除族贯穿测试（add-subject-sam-pipeline design §4.3——P1.3）。
 * 覆盖：drillWorthy=false 节点经 P0.2 适配器仍产 Block（几何基座语义）→ 排除策略
 * 吃它：零 Gem + excluded 警告 + excludedRegions BOM 未贴区注记结构（nodeId/label/
 * reason/areaCm2）+ reason 缺省与自定义 round-trip + strict 拒 + 确定性 +
 * 注册表/分发入口双路等价。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectNodeSchema,
  ObjectTreeSchema,
  encodeInlineMask,
  type ObjectTree,
} from '@handicraft/contracts';
import { treeToBlocks, type TreeBlock } from '../src/kernel/vision/tree-to-blocks.js';
import { ExclusionParamsSchema, exclusionStrategy } from '../src/kernel/strategies/exclusion.js';
import { applyStrategy, createStrategyContext, type StrategyContext } from '../src/kernel/strategies/registry.js';

const iso = '2026-09-24T00:00:00.000Z';
/** 3000×4000 px / 30×40 cm → 10 px/mm。 */
const canvasCm = { w: 30, h: 40 };
const imagePx = { width: 3000, height: 4000 };
const PPM = 10;

const ctx: StrategyContext = createStrategyContext({ gemDiameterPx: 30 });
const canvas = { px: imagePx, cm: canvasCm, pixelsPerMm: PPM };

/** 两节点树：可钻主体 + drillWorthy=false 灯光叶（排除对象）。 */
function exclusionTree(): ObjectTree {
  const solid = (w: number, h: number) => new Uint8Array(w * h).fill(1);
  return ObjectTreeSchema.parse({
    kind: 'object-tree' as const,
    formatVersion: 1 as const,
    canvasCm,
    imagePx,
    nodes: [
      ObjectNodeSchema.parse({
        id: 'n-canvas-art',
        objectName: '卡通人物',
        category: 'character',
        mask: encodeInlineMask(12, 8, solid(12, 8)),
        bbox: { x: 100, y: 50, w: 12, h: 8 },
        parent: null,
        children: ['n-face-light'],
        effectiveMm: 9.8,
        labVariance: 12.5,
        drillWorthy: true,
        origin: 'vlm+sam3' as const,
      }),
      ObjectNodeSchema.parse({
        id: 'n-face-light',
        objectName: '卡通人物·脸蛋高光',
        category: 'light',
        mask: encodeInlineMask(20, 10, solid(20, 10)),
        bbox: { x: 104, y: 58, w: 20, h: 10 },
        parent: 'n-canvas-art',
        children: [],
        effectiveMm: 14.1,
        labVariance: 2.0,
        drillWorthy: false, // ← 排除对象（P0.2：叶子仍产 Block）
        origin: 'vlm+sam3' as const,
      }),
    ],
    createdAt: iso,
  });
}

function setup(): { node: ObjectTree['nodes'][number]; block: TreeBlock } {
  const tree = exclusionTree();
  const result = treeToBlocks(tree, { readBlob: () => null }, { gemDiameterPx: 30 });
  if (!result.ok) throw new Error(`treeToBlocks 失败：${JSON.stringify(result)}`);
  const block = result.blocks.find((b) => b.id === 'n-face-light');
  if (!block) throw new Error('drillWorthy=false 叶子未产块（P0.2 语义破裂）');
  const node = tree.nodes.find((n) => n.id === 'n-face-light')!;
  return { node, block };
}

describe('P1.3 排除族（P0.2 适配器贯穿）', () => {
  it('drillWorthy=false 叶子仍产 Block（P0.2 裁定[1]）——排除策略吃它', () => {
    const { block } = setup();
    expect(block.origin.drillWorthy).toBe(false);
    expect(block.areaPx).toBe(200); // 20×10 实心
  });

  it('apply：零 Gem + excluded 警告 + excludedRegions BOM 注记结构', () => {
    const { node, block } = setup();
    const r = exclusionStrategy.apply({ node, block, params: {}, canvas }, ctx);
    expect(r.gems).toEqual([]); // §4.3 跳过产钻
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.kind).toBe('excluded');
    expect(r.warnings[0]!.detail).toContain('未贴区明示');
    expect(r.warnings[0]!.detail).toContain(block.label);
    expect(r.engineStrategy).toBeUndefined(); // 排除无引擎映射（contracts 偏差[4]）
    // BOM 未贴区注记：nodeId 同寻址 + label 祖先链 + reason + 面积（200px/100px²·cm⁻²=0.02cm²）
    expect(r.excludedRegions).toHaveLength(1);
    const region = r.excludedRegions![0]!;
    expect(region.nodeId).toBe('n-face-light');
    expect(region.label).toBe(block.label);
    expect(region.reason).toContain('drillWorthy=false');
    expect(region.areaCm2).toBeCloseTo(200 / (PPM * PPM * 100), 6);
  });

  it('reason 一等参数：自定义原因透传（LLM/用户显式指派语义）', () => {
    const { node, block } = setup();
    const r = exclusionStrategy.apply(
      { node, block, params: { reason: '顾客要求脸蛋无凸起钻' }, canvas },
      ctx,
    );
    expect(r.excludedRegions![0]!.reason).toBe('顾客要求脸蛋无凸起钻');
    expect(r.warnings[0]!.detail).toContain('顾客要求脸蛋无凸起钻');
  });

  it('参数 schema：缺省补全+round-trip 幂等+strict 拒未知键+空 reason 拒', () => {
    const parsed = ExclusionParamsSchema.parse({});
    expect(parsed.reason.length).toBeGreaterThan(0);
    expect(ExclusionParamsSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(() => ExclusionParamsSchema.parse({ extra: 1 })).toThrow();
    expect(() => ExclusionParamsSchema.parse({ reason: '' })).toThrow();
  });

  it('确定性：同输入同输出（逐位）', () => {
    const { node, block } = setup();
    const a = exclusionStrategy.apply({ node, block, params: {}, canvas }, ctx);
    const b = exclusionStrategy.apply({ node, block, params: {}, canvas }, ctx);
    expect(a).toEqual(b);
  });

  it('node/block id 不一致 → 显式抛', () => {
    const { node, block } = setup();
    expect(() =>
      exclusionStrategy.apply({ node: { ...node, id: 'n-other' }, block, params: {}, canvas }, ctx),
    ).toThrow(/不一致/);
  });

  it('注册表分发等价：applyStrategy(kind=exclusion) = exclusionStrategy.apply', () => {
    const { node, block } = setup();
    const input = { node, block, params: {}, canvas };
    expect(applyStrategy('exclusion', input, ctx)).toEqual(exclusionStrategy.apply(input, ctx));
  });
});
