/**
 * mask-resample 纯函数单测（add-vision-pipeline-v2 T1.1/D2——结果侧升采样共享原语；
 * 实现自 sam-bridge.ts 抽出（commit 80f973e 行为逐位不变），桥面端到端归一化测试见
 * sam-bridge.test.ts「P1 掩码归一化」——本文件锁纯函数语义：恒等零拷贝/整倍块映射/
 * 非整倍中心对齐最近邻（与 PIL NEAREST 同族口径）/下采样/边界钳制）。
 */
import { describe, expect, it } from 'vitest';
import { nearestResampleMaskBits } from '../src/kernel/vision/mask-resample.js';

/** 期望源下标独立复算（中心对齐口径——dst 取 src[floor((d+0.5)×src/dst)] 钳 src-1）。 */
function expectedSrcIndex(d: number, src: number, dst: number): number {
  return Math.min(src - 1, Math.floor(((d + 0.5) * src) / dst));
}

describe('nearestResampleMaskBits（0/1 最近邻重采样）', () => {
  it('维度一致=零拷贝原样返回（同引用——常规原尺寸掩码路径无额外成本）', () => {
    const bits = new Uint8Array(12).fill(1);
    const out = nearestResampleMaskBits({ w: 4, h: 3, bits }, { width: 4, height: 3 });
    expect(out).toBe(bits); // 引用相等=未分配未复制
  });

  it('非整倍上采样（3×2 → 7×5）：全像素=中心对齐最近邻（手算期望逐位对照）', () => {
    // src 3×2：y0=[0,1,0] y1=[1,1,0]（非对称——行列映射皆可错即错）
    const src = new Uint8Array([0, 1, 0, 1, 1, 0]);
    const out = nearestResampleMaskBits({ w: 3, h: 2, bits: src }, { width: 7, height: 5 });
    expect(out.length).toBe(7 * 5);
    // 手算期望（中心对齐）：colSrc=[0,0,1,1,1,2,2] rowSrc=[0,0,1,1,1]
    //   y∈{0,1}（src 行0=[0,1,0]）→ [0,0,1,1,1,0,0]
    //   y∈{2,3,4}（src 行1=[1,1,0]）→ [1,1,1,1,1,0,0]
    const expected = new Uint8Array([
      0, 0, 1, 1, 1, 0, 0,
      0, 0, 1, 1, 1, 0, 0,
      1, 1, 1, 1, 1, 0, 0,
      1, 1, 1, 1, 1, 0, 0,
      1, 1, 1, 1, 1, 0, 0,
    ]);
    expect(out).toEqual(expected);
    // 口径公式全像素对拍（与手算互证——非整倍因子 7/3、5/2）
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++) {
        expect(out[y * 7 + x]).toBe(src[expectedSrcIndex(y, 2, 5) * 3 + expectedSrcIndex(x, 3, 7)]);
      }
    }
  });

  it('整倍块放大（2×2 → 4×4）：等值区整块映射（块常量，无插值灰度）', () => {
    const src = new Uint8Array([1, 0, 0, 1]);
    const out = nearestResampleMaskBits({ w: 2, h: 2, bits: src }, { width: 4, height: 4 });
    expect(Array.from(out)).toEqual([
      1, 1, 0, 0,
      1, 1, 0, 0,
      0, 0, 1, 1,
      0, 0, 1, 1,
    ]);
  });

  it('下采样（5×4 → 2×2）：中心采样且源下标钳制不越界', () => {
    const srcW = 5;
    const srcH = 4;
    const src = new Uint8Array(srcW * srcH);
    for (let y = 0; y < srcH; y++) {
      for (let x = 0; x < srcW; x++) src[y * srcW + x] = (x + y) % 2;
    }
    const out = nearestResampleMaskBits({ w: srcW, h: srcH, bits: src }, { width: 2, height: 2 });
    expect(out.length).toBe(4);
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 2; x++) {
        expect(out[y * 2 + x]).toBe(
          src[expectedSrcIndex(y, srcH, 2) * srcW + expectedSrcIndex(x, srcW, 2)],
        );
      }
    }
  });

  it('1×1 源放大到任意尺寸=源值广播；全 0/全 1 保恒等值域（0/1 位平面不引入灰度）', () => {
    const one = nearestResampleMaskBits(
      { w: 1, h: 1, bits: new Uint8Array([1]) },
      { width: 6, height: 4 },
    );
    expect(one.length).toBe(24);
    expect(one.every((b) => b === 1)).toBe(true);
    const zero = nearestResampleMaskBits(
      { w: 1, h: 1, bits: new Uint8Array([0]) },
      { width: 6, height: 4 },
    );
    expect(zero.every((b) => b === 0)).toBe(true);
  });

  it('输入 bits 不被修改（纯函数——写时复制纪律）', () => {
    const src = new Uint8Array([0, 1, 0, 1, 1, 0]);
    const before = Uint8Array.from(src);
    nearestResampleMaskBits({ w: 3, h: 2, bits: src }, { width: 7, height: 5 });
    expect(Array.from(src)).toEqual(Array.from(before));
  });
});
