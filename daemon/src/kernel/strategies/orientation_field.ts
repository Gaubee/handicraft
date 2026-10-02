/**
 * 结构张量方向场共享件（close-paving-backlog T4.1——Owner 2026-10-02「排钻算法清账」
 * 裁决：直线族取向场升级，张量计算与 texture-fill 共享单源）。
 *
 * 原实现位于 texture_fill.ts（add-subject-sam-pipeline P1.2——spike lib.mts orientField
 * 语义工程化移植）；straight_line 的 gradient-field 布点核需要同一张量计算——
 * **行为零变更提取**：算法体逐字迁出，签名自 TextureFillParams 窄化为显式入参
 * lumaB64（原签名仅消费 p.lumaB64——design §4「params 窄化为显式入参」）。
 * texture_fill 保留 params 形兼容导出（既有测试/调用面零改动）。
 */
import type { TreeMask2D } from '../vision/tree-to-blocks.js';

/** 可分离盒式模糊（running sum，边界 clamp，passes 次≈高斯——spike lib.mts boxBlur 语义）。 */
export function boxBlur(src: Float32Array, w: number, h: number, r: number, passes: number): Float32Array {
  if (r <= 0 || passes <= 0) return src;
  let cur = src;
  for (let p = 0; p < passes; p++) {
    const hz = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += cur[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        hz[y * w + x] = sum / (2 * r + 1);
        sum -= cur[y * w + Math.min(w - 1, Math.max(0, x - r))];
        sum += cur[y * w + Math.min(w - 1, Math.max(0, x + r + 1))];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += hz[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / (2 * r + 1);
        sum -= hz[Math.min(h - 1, Math.max(0, y - r)) * w + x];
        sum += hz[Math.min(h - 1, Math.max(0, y + r + 1)) * w + x];
      }
    }
    cur = out;
  }
  return cur;
}

/**
 * 亮度场（0-255 浮点）：lumaB64 解码+平滑（blurPx=max(1,min(8,min(w,h)/24)) 双 pass
 * ——texture_fill lumaField 的有亮度分支核心，提出共享单源）。长度失配显式拒。
 */
export function lumaFieldOf(lumaB64: string, mask: TreeMask2D): Float32Array {
  const n = mask.w * mask.h;
  const raw = Buffer.from(lumaB64, 'base64');
  if (raw.length !== n) {
    throw new RangeError(`lumaB64 解码长度 ${raw.length} ≠ 掩膜 w*h=${n}（亮度场与掩膜同 bbox 语义）`);
  }
  const f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = raw[i];
  const blurPx = Math.max(1, Math.min(8, Math.round(Math.min(mask.w, mask.h) / 24)));
  return boxBlur(f, mask.w, mask.h, blurPx, 2);
}

/** 方向场（spike lib.mts orientField 语义）：切向单位场+场源标记。 */
export interface OrientField {
  tx: Float32Array;
  ty: Float32Array;
  /** 场源是否为真实亮度（false=掩膜形状流退化——warning 依据） */
  fromLuma: boolean;
}

/**
 * 方向场（结构张量+ETF 投票精炼；无 luma 用模糊掩膜代=掩膜形状流退化）。
 * 签名窄化：仅消费 lumaB64（texture_fill 兼容壳/straight_line gradient-field 同一真源）。
 * 导出面：flow 方向一致性测试（gem→最近邻向量 vs 局部切向夹角中位）复用同一真源。
 */
export function orientationField(lumaB64: string | undefined, mask: TreeMask2D): OrientField {
  const { w, h } = mask;
  let L: Float32Array;
  let fromLuma = true;
  if (lumaB64 !== undefined) {
    L = lumaFieldOf(lumaB64, mask);
    L = boxBlur(L, w, h, 2, 1); // preBlur
  } else {
    // 退化：模糊掩膜（值 0/1）的等值线切向=顺掩膜形状流
    fromLuma = false;
    const mf = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) mf[i] = mask.bits[i];
    L = boxBlur(mf, w, h, Math.max(2, Math.min(8, Math.round(Math.min(w, h) / 16))), 2);
  }
  // Sobel 梯度
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const gm = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = L[i - w - 1];
      const b = L[i - w];
      const c = L[i - w + 1];
      const d = L[i - 1];
      const f = L[i + 1];
      const g = L[i + w - 1];
      const hh = L[i + w];
      const k = L[i + w + 1];
      const sx = c + 2 * f + k - (a + 2 * d + g);
      const sy = g + 2 * hh + k - (a + 2 * b + c);
      gx[i] = sx;
      gy[i] = sy;
      gm[i] = Math.hypot(sx, sy);
    }
  }
  const tb = Math.max(2, Math.min(7, Math.round(Math.min(w, h) / 20))); // tensorBlur（spike 7）
  const mul = (a: Float32Array, b: Float32Array): Float32Array => {
    const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = a[i] * b[i];
    return o;
  };
  const Jxx = boxBlur(mul(gx, gx), w, h, tb, 2);
  const Jxy = boxBlur(mul(gx, gy), w, h, tb, 2);
  const Jyy = boxBlur(mul(gy, gy), w, h, tb, 2);
  const tx = new Float32Array(w * h);
  const ty = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const major = 0.5 * Math.atan2(2 * Jxy[i], Jxx[i] - Jyy[i]); // 主轴（梯度向）
    tx[i] = -Math.sin(major);
    ty[i] = Math.cos(major); // 切向 = 主轴 + 90°
  }
  // ETF 投票精炼（Kang 2007 简化）：t'(x) ∝ Σ φ(y)·sgn·t(y)，φ=|∇I|/max，w_d=|dot|³
  const r = Math.max(3, Math.min(5, Math.floor(Math.min(w, h) / 20))); // etfRadius（spike 5）
  const etfIters = 2;
  let gmax = 0;
  for (let i = 0; i < w * h; i++) if (gm[i] > gmax) gmax = gm[i];
  if (gmax <= 0) gmax = 1;
  let cx = tx;
  let cy = ty;
  for (let it = 0; it < etfIters; it++) {
    const nx = new Float32Array(w * h);
    const ny = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let sx = 0;
        let sy = 0;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const yy = Math.min(h - 1, Math.max(0, y + dy));
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const j = yy * w + xx;
            const phi = gm[j] / gmax;
            if (phi < 1e-4) continue;
            const dot = cx[i] * cx[j] + cy[i] * cy[j];
            const sgn = dot >= 0 ? 1 : -1; // 对齐符号（切向 ± 等价）
            const wgt = phi * Math.abs(dot) * Math.abs(dot) * Math.abs(dot);
            sx += wgt * sgn * cx[j];
            sy += wgt * sgn * cy[j];
          }
        }
        const nn = Math.hypot(sx, sy);
        if (nn > 1e-9) {
          nx[i] = sx / nn;
          ny[i] = sy / nn;
        } else {
          nx[i] = cx[i];
          ny[i] = cy[i];
        }
      }
    }
    cx = nx;
    cy = ny;
  }
  return { tx: cx, ty: cy, fromLuma };
}
