/**
 * sets 契约单测（add-stone-library design §7.1/§7.6——S7.1 冻结面验证）。
 * 覆盖面：
 *   [1] ProductionSetFileSchema：合法最小文件/严格键拒绝（含成员内嵌 stone 字段
 *       副本=引用集不变量的 schema 级证明）/ stones min(1)/kind/formatVersion 字面量
 *       /quantity 正整数/origin 三来源字段形状。
 *   [2] qualifiedSku 纯函数：两标准同 SKU 并存可区分（`yuhang/J51` vs
 *       `factoryB/J51`——Owner 定调五「编号冲突自动加标准 ID」）；空串/'/' 歧义
 *       显式拒绝。
 */
import { describe, expect, it } from 'vitest';
import {
  ProductionSetFileSchema,
  qualifiedSku,
  type ProductionSetFile,
} from './sets.js';

function sampleSet(overrides: Partial<ProductionSetFile> = {}): ProductionSetFile {
  return {
    kind: 'stone-set',
    formatVersion: 1,
    id: 'set-00000000-0000-4000-8000-000000000001',
    name: '卡通人物套餐-A',
    stones: [
      { stoneRef: 'stn-a', quantity: 2 },
      { stoneRef: 'stn-b', note: '点缀用' },
      { stoneRef: 'stn-c' }, // 无数量=「按设计用量另计」显式缺省
    ],
    origin: { kind: 'manual-pick' },
    metadata: {},
    createdAt: '2026-09-24T10:00:00.000Z',
    updatedAt: '2026-09-24T10:00:00.000Z',
    ...overrides,
  };
}

describe('S7.1 ProductionSetFileSchema（§7.1 冻结）', () => {
  it('合法最小文件通过（成员三形态：quantity/note/裸引用）', () => {
    expect(ProductionSetFileSchema.parse(sampleSet())).toEqual(sampleSet());
  });

  it('purpose/origin 溯源字段形状（§7.4 三来源）', () => {
    expect(
      ProductionSetFileSchema.parse(sampleSet({ purpose: '小件卡通订单' })).purpose,
    ).toBe('小件卡通订单');
    expect(
      ProductionSetFileSchema.parse(
        sampleSet({ origin: { kind: 'bom-derived', sourceTaskId: 'task-1' } }),
      ).origin,
    ).toEqual({ kind: 'bom-derived', sourceTaskId: 'task-1' });
    expect(
      ProductionSetFileSchema.parse(sampleSet({ origin: { kind: 'clone', fromSetId: 'set-x' } })).origin,
    ).toEqual({ kind: 'clone', fromSetId: 'set-x' });
  });

  it('引用集不变量（schema 级）：成员只存弱引用——内嵌 stone 字段副本必拒', () => {
    const embedded = sampleSet({
      stones: [
        {
          stoneRef: 'stn-a',
          // @ts-expect-error 引用集永不内嵌 stone 数据副本——strict 拒绝即不变量证明
          color: { name: '象牙白', rgb: [240, 240, 232], family: '白色系', finish: 'glossy' },
        },
      ],
    });
    expect(ProductionSetFileSchema.safeParse(embedded).success).toBe(false);
    const embeddedTexture = sampleSet({
      stones: [
        {
          stoneRef: 'stn-a',
          // @ts-expect-error 贴图副本同样必拒（物化只在消费时刻）
          textureUrl: '/api/stones/stn-a/texture.png',
        },
      ],
    });
    expect(ProductionSetFileSchema.safeParse(embeddedTexture).success).toBe(false);
  });

  it('stones min(1)：空成员清单必拒（空组合无生产语义）', () => {
    expect(ProductionSetFileSchema.safeParse(sampleSet({ stones: [] })).success).toBe(false);
  });

  it('kind/formatVersion 字面量与未知键 strict 拒绝', () => {
    expect(ProductionSetFileSchema.safeParse(sampleSet({ kind: 'stone' as never })).success).toBe(false);
    expect(ProductionSetFileSchema.safeParse(sampleSet({ formatVersion: 2 as never })).success).toBe(false);
    expect(
      ProductionSetFileSchema.safeParse({ ...sampleSet(), extra: 1 }).success,
    ).toBe(false);
  });

  it('quantity=正整数（0/负数/浮点必拒）；stoneRef 空串必拒', () => {
    for (const quantity of [0, -1, 1.5]) {
      expect(
        ProductionSetFileSchema.safeParse(sampleSet({ stones: [{ stoneRef: 'a', quantity }] })).success,
      ).toBe(false);
    }
    expect(
      ProductionSetFileSchema.safeParse(sampleSet({ stones: [{ stoneRef: '' }] })).success,
    ).toBe(false);
  });
});

describe('S7.1 qualifiedSku 限定名（§7.6 编号冲突区分）', () => {
  it('两标准同 SKU 并存可区分（展示投影）', () => {
    expect(qualifiedSku('yuhang', 'J51')).toBe('yuhang/J51');
    expect(qualifiedSku('factoryB', 'J51')).toBe('factoryB/J51');
    expect(qualifiedSku('yuhang', 'J51')).not.toBe(qualifiedSku('factoryB', 'J51'));
  });

  it('空段或含 "/" 的段=歧义，显式拒绝（不猜测转义）', () => {
    expect(() => qualifiedSku('', 'J51')).toThrow();
    expect(() => qualifiedSku('yuhang', '')).toThrow();
    expect(() => qualifiedSku('yu/hang', 'J51')).toThrow();
    expect(() => qualifiedSku('yuhang', 'J/51')).toThrow();
  });
});
