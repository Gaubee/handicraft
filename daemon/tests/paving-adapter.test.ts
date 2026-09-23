/**
 * W0.2 adapter 等价 fixture（P1-6①——codex-impl-review-w0w2：排布契约不再只是
 * 手工镜像）。contracts 不 import 引擎的前提保持不变；本测试在 **daemon 包**以
 * 真实 `rhinestone-studio/engine` 为裁判：
 *   [1] 五策略名与引擎 STRATEGY_IDS 运行时逐字相等（import 对比，不靠抄录）。
 *   [2] 契约 paving 输入 → paveArgsOf adapter → 真实 layout() 跑通（五策略全过）。
 *   [3] density 上升（0.5 → 1.0）⇒ 钻数单调不减（逐策略）。
 *   [4] 同参同出（确定性——两次调用深比较相等）。
 *   [5] 派生关系：grid.pitchMm = spec.diameterMm + gapMm（gridFromSpec 冻结语义）。
 *   [6] 边界对齐：负 gap / 越界 density 双侧（契约与引擎 schema）同拒。
 */
import { describe, expect, it } from 'vitest';
import { PaveJobParamsSchema, StrategyIdSchema } from '@handicraft/contracts';
import {
  GridSpecSchema,
  LayoutOptionsSchema,
  STRATEGY_IDS,
  layout,
  segment,
  type Block,
  type EngineImage,
} from 'rhinestone-studio/engine';
import { paveArgsOf } from '../src/jobs/engine.js';

/** 96×96 左红右蓝两块图（segment 产出 ≥2 块——同 engine.test.ts fixture 口径）。 */
function twoColorImage(): EngineImage {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      if (x < w / 2) {
        rgba[p] = 200;
        rgba[p + 1] = 16;
        rgba[p + 2] = 46;
      } else {
        rgba[p] = 16;
        rgba[p + 1] = 46;
        rgba[p + 2] = 200;
      }
      rgba[p + 3] = 255;
    }
  }
  return { width: w, height: h, data: rgba };
}

function blocksOfImage(image: EngineImage): Block[] {
  return segment(image, { k: 8, seed: 1, gemDiameterPx: 3 * 8 });
}

/** 契约输入（任务面形状——op 之外即 §3.4 排布参数一等输入）。 */
function contractParams(overrides: Record<string, unknown> = {}) {
  return PaveJobParamsSchema.parse({
    op: 'pave',
    imageRef: '0'.repeat(64),
    strategy: 'hex-pitch',
    gapMm: 0.4,
    spec: { shapeId: 'round', diameterMm: 3 },
    ...overrides,
  });
}

describe('P1-6① 契约真源对照（运行时 import 引擎——非抄录）', () => {
  it('五策略名与引擎 STRATEGY_IDS 逐字相等（值与序）', () => {
    expect([...StrategyIdSchema.options]).toEqual([...STRATEGY_IDS]);
  });

  it('边界对齐：负 gap/越界 density——契约与引擎 schema 同拒', () => {
    // gap：契约 GapMmSchema(≥0) ↔ 引擎 GridSpecSchema.gapMm(nonnegative)
    expect(() => contractParams({ gapMm: -0.1 })).toThrow();
    expect(() =>
      GridSpecSchema.parse({ pitchMm: 3.4, gapMm: -0.1, rowAngleDeg: 0, pixelsPerMm: 8 }),
    ).toThrow();
    // density：契约 (0,1] ↔ 引擎 LayoutOptionsSchema unit
    expect(() => contractParams({ density: 1.5 })).toThrow();
    expect(() => contractParams({ density: 0 })).toThrow();
    expect(() => LayoutOptionsSchema.parse({ density: 1.5 })).toThrow();
    expect(() => LayoutOptionsSchema.parse({ density: 0 })).toThrow();
    // 合法侧同时通过
    expect(() => LayoutOptionsSchema.parse({ density: 1 })).not.toThrow();
  });
});

describe('P1-6① adapter 等价 fixture（契约输入 → paveArgsOf → 真实 layout()）', () => {
  const blocks = blocksOfImage(twoColorImage());

  it('segment 前置：fixture 图产出 ≥2 块（region 语义可用）', () => {
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('五策略全过真实 layout()；同参同出（确定性深比较）', () => {
    for (const strategy of STRATEGY_IDS) {
      const params = contractParams({ strategy });
      const { strategy: sid, opts, grid } = paveArgsOf(params);
      expect(sid).toBe(strategy);
      const first = layout(blocks, sid, opts, grid);
      const second = layout(blocks, sid, opts, grid);
      expect(second).toEqual(first); // 同参同出（纯函数确定性）
      expect(first.gems.length).toBeGreaterThan(0);
      expect(first.warnings).toEqual([]);
    }
  });

  it('density 单调：0.5 → 1.0 钻数单调不减（逐策略）', () => {
    for (const strategy of STRATEGY_IDS) {
      const sparse = paveArgsOf(contractParams({ strategy, density: 0.5 }));
      const dense = paveArgsOf(contractParams({ strategy, density: 1.0 }));
      const nSparse = layout(blocks, sparse.strategy, sparse.opts, sparse.grid).gems.length;
      const nDense = layout(blocks, dense.strategy, dense.opts, dense.grid).gems.length;
      expect(nDense).toBeGreaterThanOrEqual(nSparse);
    }
  });

  it('派生关系：pitchMm = diameterMm + gapMm（gridFromSpec 冻结语义如实呈现）', () => {
    const { grid } = paveArgsOf(contractParams({ gapMm: 0.9 }));
    expect(grid.pitchMm).toBeCloseTo(3 + 0.9, 10);
    expect(grid.gapMm).toBe(0.9);
    expect(grid.rowAngleDeg).toBe(0);
    // 逐块 density 形态（Record 缺省块默认 1）也直通
    const byBlock = paveArgsOf(
      contractParams({ density: { [blocks[0]!.id]: 0.5 } }),
    );
    expect(byBlock.opts.density).toEqual({ [blocks[0]!.id]: 0.5 });
  });

  it('region 收敛语义：契约 region.ids → 引擎 blocks 子集（adapter 上层语义一致）', () => {
    const target = blocks[0]!;
    const params = contractParams({ region: { kind: 'blocks', ids: [target.id] } });
    const args = paveArgsOf(params);
    const result = layout([target], args.strategy, args.opts, args.grid);
    for (const gem of result.gems) {
      expect(gem.blockId).toBe(target.id); // 仅目标块出钻
    }
    // 空 region 由契约拒绝；未知 ID 契约层不查存在性（运行时 selectBlocks 拒绝——
    // engine.test.ts 的 ghost-block 用例覆盖该路径），此处只断言契约面不抛
    expect(() => contractParams({ region: { kind: 'blocks', ids: [] } })).toThrow();
    expect(() => contractParams({ region: { kind: 'blocks', ids: ['no-such-block'] } })).not.toThrow();
  });
});
