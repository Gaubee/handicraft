/**
 * 策略注册表测试（add-subject-sam-pipeline design §4/§5——P1.5 冻结接口）。
 * 覆盖：七值全量注册（KernelStrategyKind ↔ 实现位一一对应）+ implemented/reserved
 * 状态矩阵（本波 geometry/exclusion 落地，P1.2/P1.4 五槽预留）+ reserved apply
 * fail-fast（StrategyNotImplementedError 携波次信息）+ 分发入口（未知 kind 拒/
 * raw 字符串先过 KernelStrategyKindSchema——LLM 边界）+ 缺省上下文工厂（密度缺省
 * DEFAULT_DENSITY_PER_CM2=2.3 + mulberry32 确定性）+ 引擎五策略=基础族成员声明
 * （ENGINE_BASE_FAMILY 五键与 contracts StrategyIdSchema 逐字面同源）+
 * engineStrategy 声明式通道输出位（降级路径见 strategies-geometry.test.ts）。
 */
import { describe, expect, it } from 'vitest';
import { KernelStrategyKindSchema, StrategyIdSchema, DEFAULT_DENSITY_PER_CM2 } from '@handicraft/contracts';
import {
  ENGINE_BASE_FAMILY,
  STRATEGY_KINDS,
  STRATEGY_REGISTRY,
  StrategyNotImplementedError,
  applyStrategy,
  createStrategyContext,
} from '../src/kernel/strategies/registry.js';
import type { KernelStrategyKind } from '@handicraft/contracts';
import { mulberry32, stringToSeed } from '../src/kernel/strategies/rng.js';

describe('P1.5 注册表（七值→实现位）', () => {
  it('KernelStrategyKind 七值全量注册，无多无漏', () => {
    expect([...STRATEGY_REGISTRY.keys()].sort()).toEqual([...KernelStrategyKindSchema.options].sort());
    expect(STRATEGY_KINDS).toEqual(KernelStrategyKindSchema.options);
    for (const [kind, entry] of STRATEGY_REGISTRY) {
      expect(entry.kind).toBe(kind);
      expect(typeof entry.apply).toBe('function');
      expect(entry.paramsSchema).toBeDefined();
    }
  });

  it('状态矩阵：本波 implemented={geometry,exclusion}，余五值 reserved', () => {
    const implemented = [...STRATEGY_REGISTRY.values()]
      .filter((s) => s.status === 'implemented')
      .map((s) => s.kind)
      .sort();
    expect(implemented).toEqual(['exclusion', 'geometry']);
    const reserved = [...STRATEGY_REGISTRY.values()].filter((s) => s.status === 'reserved');
    expect(reserved.map((s) => s.kind).sort()).toEqual(
      ['flower', 'free-code', 'soft-curve', 'straight-line', 'texture-fill'].sort(),
    );
  });

  it('reserved apply fail-fast：StrategyNotImplementedError 携波次（不静默空产出）', () => {
    const input = { node: null, block: null, params: {}, canvas: null } as never;
    const ctx = createStrategyContext({ gemDiameterPx: 30 });
    for (const kind of ['texture-fill', 'soft-curve', 'flower', 'straight-line', 'free-code'] as const) {
      try {
        STRATEGY_REGISTRY.get(kind)!.apply(input, ctx);
        expect.unreachable(`reserved ${kind} 不应产出`);
      } catch (e) {
        expect(e).toBeInstanceOf(StrategyNotImplementedError);
        const err = e as StrategyNotImplementedError;
        expect(err.kind).toBe(kind);
        expect(err.wave).toMatch(/P1\.[24]/);
        expect(err.message).toContain(kind);
      }
    }
  });

  it('分发入口：raw kind 先过 KernelStrategyKindSchema（LLM 输出边界）', () => {
    expect(() => KernelStrategyKindSchema.parse('geometry')).not.toThrow();
    expect(() => KernelStrategyKindSchema.parse('hex-pitch')).toThrow(); // 引擎 id ≠ 内核 kind
    expect(() => KernelStrategyKindSchema.parse('nope')).toThrow();
    const kind: KernelStrategyKind = KernelStrategyKindSchema.parse('exclusion');
    expect(kind).toBe('exclusion');
  });

  it('分发入口：七值内 kind 全部可路由（implemented 走 apply/reserved 抛）', () => {
    const ctx = createStrategyContext({ gemDiameterPx: 30 });
    const input = { node: null, block: null, params: {}, canvas: null } as never;
    for (const kind of KernelStrategyKindSchema.options) {
      const entry = STRATEGY_REGISTRY.get(kind)!;
      if (entry.status === 'implemented') {
        expect(() => applyStrategy(kind, input, ctx)).toThrow(/不一致|null/); // 走进实现（null 输入防御性抛）
      } else {
        expect(() => applyStrategy(kind, input, ctx)).toThrow(StrategyNotImplementedError);
      }
    }
  });
});

describe('P1.5 缺省上下文工厂 + 确定性随机源', () => {
  it('密度缺省=DEFAULT_DENSITY_PER_CM2（Owner 定调 2.3）；gemDiameterPx 正数防御', () => {
    const ctx = createStrategyContext({ gemDiameterPx: 30 });
    expect(ctx.densityPerCm2).toBe(DEFAULT_DENSITY_PER_CM2);
    expect(DEFAULT_DENSITY_PER_CM2).toBe(2.3);
    expect(ctx.gemDiameterPx).toBe(30);
    expect(ctx.geometry).toBeDefined();
    expect(() => createStrategyContext({ gemDiameterPx: 0 })).toThrow(RangeError);
    expect(createStrategyContext({ gemDiameterPx: 30, densityPerCm2: 5 }).densityPerCm2).toBe(5);
  });

  it('rng：mulberry32 同 seed 同序列/异 seed 异序列（§4.4 可回放前提）', () => {
    const ctx = createStrategyContext({ gemDiameterPx: 30 });
    const a1 = [...Array(5)].map(() => ctx.rng(42)());
    const a2 = [...Array(5)].map(() => mulberry32(42)());
    const b = [...Array(5)].map(() => ctx.rng(43)());
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    a1.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    });
  });

  it('stringToSeed：确定性+节点域分布（内核 nodeId→seed 锚）', () => {
    expect(stringToSeed('n-lamp')).toBe(stringToSeed('n-lamp'));
    expect(stringToSeed('n-lamp')).not.toBe(stringToSeed('n-lamp-pole'));
    expect(stringToSeed('n-lamp')).toBeLessThan(2 ** 32);
  });
});

describe('P1.5 引擎五策略=基础族成员（声明式 adapter 通道）', () => {
  it('ENGINE_BASE_FAMILY 五键与 contracts StrategyIdSchema 逐字面同源', () => {
    expect(Object.keys(ENGINE_BASE_FAMILY).sort()).toEqual([...StrategyIdSchema.options].sort());
    for (const note of Object.values(ENGINE_BASE_FAMILY)) {
      expect(note.family).toBe('geometry'); // design §0：统一硬算法=基础几何族成员
      expect(note.note.length).toBeGreaterThan(0);
    }
  });

  it('引擎 id ≠ 内核 kind（两命名空间不混——分发面先校验）', () => {
    for (const id of StrategyIdSchema.options) {
      expect(() => KernelStrategyKindSchema.parse(id)).toThrow();
    }
  });
});
