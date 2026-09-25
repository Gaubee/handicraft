/**
 * 停止判据确定性单测（add-subject-sam-pipeline design §2——P0.3）。
 * 构造已知节点（Lab 色差由 contracts color.ts 真算 / 尺寸 mm 已知 / 深度已知）
 * 逐判据验证 + 综合权重（§9 回流 5：判据 3 为主、1/2 为辅——reasons 权重序
 * hard-cap > model > size > color）+ 坏参数 typed error + 确定性（同输入同输出）。
 */
import { describe, expect, it } from 'vitest';
import {
  DELTA_E_STOP_DEFAULT,
  SIZE_FACTOR_K_DEFAULT,
  evaluateStopCriteria,
  type StopCriteriaParams,
} from '../src/kernel/vision/stop-criteria.js';
import { DELTA_E_FAMILY, DELTA_E_NEAR, DELTA_E_COARSE, deltaE76, labFromRgb } from '@handicraft/contracts';

/** 迭代继续中的基准参数（四判据全不触发——逐项测试从此出发单项构造）。 */
const baseParams: StopCriteriaParams = {
  maxGemDiameterMm: 2,
  modelSignal: 'new-instances',
  iteration: 3,
  maxIterations: 8,
  totalNodes: 40,
  maxNodes: 500,
};

/** 大尺寸+高色方差节点（软判据不触发——卡通稿典型，§9 实测 0/19 触发口径）。 */
const bigVariedNode = { effectiveMm: 30, labVariance: 22 };

describe('判据 1 物理尺寸（owner 原话：~5mm×5mm 不再细分）', () => {
  it('2mm 钻×K2.5=阈值 5mm：effectiveMm=5（5mm×5mm 量级=√25）判停', () => {
    const v = evaluateStopCriteria({ effectiveMm: 5, labVariance: 22 }, baseParams);
    expect(v.size).toEqual({ stop: true, effectiveMm: 5, thresholdMm: 5 });
    expect(v.stop).toBe(true);
    expect(v.reasons).toEqual(['size']);
    expect(v.primaryReason).toBe('size');
  });
  it('5.01mm 越阈值不停（≤ 闭合边界；颜色/模型/硬顶均不触发）', () => {
    const v = evaluateStopCriteria({ effectiveMm: 5.01, labVariance: 22 }, baseParams);
    expect(v.size.stop).toBe(false);
    expect(v.stop).toBe(false);
  });
  it('K 可随钻规格表取值：K=2×5mm 钻→阈值 10mm（design §2 判据 1「随钻规格表取值」）', () => {
    const v = evaluateStopCriteria({ effectiveMm: 8, labVariance: 22 }, { ...baseParams, maxGemDiameterMm: 5, sizeFactorK: 2 });
    expect(v.size.thresholdMm).toBe(10);
    expect(v.size.stop).toBe(true);
  });
});

describe('判据 2 颜色容差（ΔE 三档常量——contracts 冻结）', () => {
  // Lab 色差已知：contracts color.ts 真算（非拍数）
  const white = labFromRgb(255, 255, 255);
  const dE245 = deltaE76(white, labFromRgb(245, 245, 245)); // ≈3.46（NEAR~FAMILY 之间）
  const dE215 = deltaE76(white, labFromRgb(215, 215, 215)); // ≈14.02（FAMILY~COARSE 之间）
  const dE180 = deltaE76(white, labFromRgb(180, 180, 180)); // ≈26.69（>COARSE）

  it('缺省阈值=contracts DELTA_E_FAMILY（10）——同源不复制', () => {
    expect(DELTA_E_STOP_DEFAULT).toBe(DELTA_E_FAMILY);
    expect(SIZE_FACTOR_K_DEFAULT).toBe(2.5);
  });
  it('天空类平色（ΔE≈3.46 ≤ 10）判停；草地类渐变（ΔE≈14 > 10）缺省不停', () => {
    const sky = evaluateStopCriteria(bigVariedNode, { ...baseParams, modelSignal: 'no-new-instance' });
    expect(sky.color.threshold).toBe(10);
    const stop3 = evaluateStopCriteria({ effectiveMm: 30, labVariance: dE245 }, { ...baseParams, modelSignal: 'new-instances' });
    expect(stop3.color.stop).toBe(true);
    expect(stop3.reasons).toEqual(['color']);
    const mid = evaluateStopCriteria({ effectiveMm: 30, labVariance: dE215 }, baseParams);
    expect(mid.color.stop).toBe(false);
    expect(mid.stop).toBe(false);
  });
  it('三档可显式切换：dE215 在 COARSE(25) 档判停、FAMILY(10) 档不停', () => {
    expect(dE215).toBeGreaterThan(DELTA_E_FAMILY);
    expect(dE215).toBeLessThan(DELTA_E_COARSE);
    const coarse = evaluateStopCriteria({ effectiveMm: 30, labVariance: dE215 }, { ...baseParams, deltaEThreshold: DELTA_E_COARSE });
    expect(coarse.color.stop).toBe(true);
    const near = evaluateStopCriteria({ effectiveMm: 30, labVariance: dE245 }, { ...baseParams, deltaEThreshold: DELTA_E_NEAR });
    expect(near.color.stop).toBe(false); // 3.46 > NEAR(3)
  });
  it('dE180（≈26.7）三档全不停（>COARSE——显著花色继续拆）', () => {
    expect(dE180).toBeGreaterThan(DELTA_E_COARSE);
    for (const t of [DELTA_E_NEAR, DELTA_E_FAMILY, DELTA_E_COARSE]) {
      expect(evaluateStopCriteria({ effectiveMm: 30, labVariance: dE180 }, { ...baseParams, deltaEThreshold: t }).color.stop).toBe(false);
    }
  });
});

describe('判据 3 模型自认（入口参数——§9 实测主停止器）', () => {
  it('no-new-instance 判停（大尺寸+高方差仍停——「实际停止器」用例）', () => {
    const v = evaluateStopCriteria(bigVariedNode, { ...baseParams, modelSignal: 'no-new-instance' });
    expect(v.model).toEqual({ stop: true, signal: 'no-new-instance' });
    expect(v.reasons).toEqual(['model']);
    expect(v.primaryReason).toBe('model');
  });
  it('low-score 判停（弱信号同停）；new-instances 不停', () => {
    expect(evaluateStopCriteria(bigVariedNode, { ...baseParams, modelSignal: 'low-score' }).model.stop).toBe(true);
    expect(evaluateStopCriteria(bigVariedNode, baseParams).model.stop).toBe(false);
  });
});

describe('判据 4 迭代硬顶', () => {
  it('轮次达顶判停（iteration 8 ≥ max 8）', () => {
    const v = evaluateStopCriteria(bigVariedNode, { ...baseParams, iteration: 8 });
    expect(v.hardCap.stop).toBe(true);
    expect(v.reasons).toEqual(['hard-cap']);
  });
  it('全局节点数达顶判停（totalNodes 500 ≥ maxNodes 500）', () => {
    const v = evaluateStopCriteria(bigVariedNode, { ...baseParams, totalNodes: 500 });
    expect(v.hardCap.stop).toBe(true);
  });
  it('7/8 轮+499/500 节点=未顶（边界不含）', () => {
    expect(evaluateStopCriteria(bigVariedNode, { ...baseParams, iteration: 7, totalNodes: 499 }).hardCap.stop).toBe(false);
  });
});

describe('综合 verdict 与权重序（§9 回流 5）', () => {
  it('四判据全触发：reasons 权重序 hard-cap > model > size > color', () => {
    const v = evaluateStopCriteria(
      { effectiveMm: 4, labVariance: 2 },
      { ...baseParams, modelSignal: 'no-new-instance', iteration: 8 },
    );
    expect(v.stop).toBe(true);
    expect(v.reasons).toEqual(['hard-cap', 'model', 'size', 'color']);
    expect(v.primaryReason).toBe('hard-cap');
  });
  it("软判据不触发+模型自认触发=reasons=['model']（卡通稿实测主路径）", () => {
    const v = evaluateStopCriteria(bigVariedNode, { ...baseParams, modelSignal: 'no-new-instance' });
    expect(v.size.stop).toBe(false);
    expect(v.color.stop).toBe(false);
    expect(v.reasons).toEqual(['model']);
  });
  it('全不触发：stop=false / reasons=[] / primaryReason=null', () => {
    const v = evaluateStopCriteria(bigVariedNode, baseParams);
    expect(v.stop).toBe(false);
    expect(v.reasons).toEqual([]);
    expect(v.primaryReason).toBe(null);
  });
  it('确定性：同输入两次调用 verdict 深比较相等', () => {
    const a = evaluateStopCriteria({ effectiveMm: 4, labVariance: 2 }, { ...baseParams, modelSignal: 'low-score' });
    const b = evaluateStopCriteria({ effectiveMm: 4, labVariance: 2 }, { ...baseParams, modelSignal: 'low-score' });
    expect(a).toEqual(b);
  });
});

describe('坏参数 typed error（驱动循环的参数不允许猜测兜底）', () => {
  const cases: Array<[string, Partial<StopCriteriaParams>]> = [
    ['maxGemDiameterMm=0', { maxGemDiameterMm: 0 }],
    ['sizeFactorK=-1', { sizeFactorK: -1 }],
    ['deltaEThreshold=NaN', { deltaEThreshold: Number.NaN }],
    ['maxIterations=0', { maxIterations: 0 }],
    ['maxNodes=0', { maxNodes: 0 }],
  ];
  for (const [name, over] of cases) {
    it(`${name} → RangeError`, () => {
      expect(() => evaluateStopCriteria(bigVariedNode, { ...baseParams, ...over })).toThrow(RangeError);
    });
  }
});
