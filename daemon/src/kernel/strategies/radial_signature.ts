/**
 * 径向边界签名 r(θ) 共享件（close-paving-backlog T1.1——Owner 2026-10-02「排钻算法
 * 清账」裁决：star 射线策略补全，径向签名自 flower.ts 提为模块级共享导出）。
 *
 * 原实现位于 flower.ts（add-subject-sam-pipeline P1.2——极坐标分解的花瓣检测面），
 * star 原位升级（r(θ) 逐角边界调制）需同一真源——**行为零变更提取**：函数体逐字迁出，
 * flower 改引本件并 re-export（既有 import 面不变），返回形状不变。
 *
 * 纪律（design §1）：**不进 GeometryHelpers 注入面**——沙箱 geo.* API 不扩容；
 * 本件仅 kernel strategies 子树内共享（flower/geometry star 两消费面）。
 */
import type { TreeMask2D } from '../vision/tree-to-blocks.js';

/** 循环盒式平滑（1D 环信号）。 */
export function circularSmooth(sig: Float64Array, r: number): Float64Array {
  const n = sig.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let d = -r; d <= r; d++) acc += sig[(i + d + n * 4) % n]!;
    out[i] = acc / (2 * r + 1);
  }
  return out;
}

/**
 * 径向边界签名 r(θ)（K 个角 bin 的掩膜成员最大半径）+ 花瓣/星角自动检测（去均值峰计数，
 * 显著性 ≥ max(12% 峰谷差, 4.5% rMax)——绝对 px 下限抗栅格化涟漪；循环平滑 K/24≈15°）。
 * 返回签名与检测峰数（未检测出=0）。导出面：花瓣检测数断言复用同一真源。
 *
 * 坐标约定：mask 局部坐标（cx/cy 与 mask 像素同系——geometry star 消费时全局锚点
 * 需先减 bbox 偏移）。
 */
export function radialSignatureAndPetals(mask: TreeMask2D, cx: number, cy: number): {
  sig: Float64Array;
  detected: number;
} {
  const K = 256;
  const maxR = new Float64Array(K);
  const { w, h } = mask;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask.bits[y * w + x] !== 1) continue;
      const dx = x - cx;
      const dy = y - cy;
      const r = Math.hypot(dx, dy);
      const bin = Math.floor((((Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2)) * K);
      if (r > maxR[bin]!) maxR[bin] = r;
    }
  }
  const sig = circularSmooth(maxR, Math.max(2, Math.round(K / 24)));
  // 去均值（花心圆对称基线）→ 峰计数（显著性含绝对 px 下限——像素盘边界涟漪不计数）
  let mean = 0;
  for (let i = 0; i < K; i++) mean += sig[i]!;
  mean /= K;
  const detrended = new Float64Array(K);
  for (let i = 0; i < K; i++) detrended[i] = sig[i]! - mean;
  let lo = Infinity;
  let hi = -Infinity;
  let sigMax = 0;
  for (let i = 0; i < K; i++) {
    if (detrended[i]! < lo) lo = detrended[i]!;
    if (detrended[i]! > hi) hi = detrended[i]!;
    if (sig[i]! > sigMax) sigMax = sig[i]!;
  }
  const prom = Math.max((hi - lo) * 0.12, sigMax * 0.045);
  let peaks = 0;
  for (let i = 0; i < K; i++) {
    const v = detrended[i]!;
    if (v < prom) continue;
    const prev = detrended[(i - 1 + K) % K]!;
    const next = detrended[(i + 1) % K]!;
    if (v >= prev && v > next) peaks++;
  }
  return { sig, detected: peaks };
}

/**
 * 角度 → 签名 bin 值查询（star 射线步进上界消费——r(θ_ray) 调制面）。
 * θ 任意实弧度（归一 [0,2π) 后取 bin；签名已循环平滑，bin 边界无跳变）。
 */
export function signatureAt(sig: Float64Array, theta: number): number {
  const K = sig.length;
  const t = ((theta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const bin = Math.min(K - 1, Math.floor((t / (2 * Math.PI)) * K));
  return sig[bin]!;
}
