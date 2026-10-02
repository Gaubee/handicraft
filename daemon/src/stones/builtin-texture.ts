/**
 * 内置标准钻贴图生成器（add-builtin-standard-stones proposal §What-1）。
 * 原始需求 2026-10-02（E2E 走查实证）：空钻库实例的自动路径在 stone.create 结构性
 * 必死——propose 模式贴图必填但 agent 无上传面。修法=服务端按 SS 云数据 rgb
 * **确定性生成**标准圆钻贴图（同 rgb 同字节——幂等复用的基石），经
 * stone.create.builtin 审批物化入库。
 * 纯函数纪律：零 IO（不出 blob/不入库——落 blob 归调用方）、零随机源、零时钟；
 * 渲染三要素=抗锯齿圆盘（盒式滤波超采样）+左上高光点（高斯衰减提亮）+边缘
 * 暗部（径向二次衰减）。生成器与 gates 同仓同源（png/codec.ts encode→decode
 * 必对账——declared 128×128 即解码实测）。
 */
import type { RgbTuple } from '@handicraft/contracts';
import { encodePng } from '../png/codec.js';

/** 画布边长 px（正方形；gate 2 边长远低于 4096 上限）。 */
export const BUILTIN_TEXTURE_SIZE = 128;

/** 圆盘半径 px（alpha bounds 主径 ≈96px ≥ gate 5 下限 64px；纵横比 1:1 过 gate 4）。 */
const DISC_RADIUS_PX = 48;

/** 抗锯齿超采样边（每像素 n×n 子样的盒式滤波覆盖——确定性，无随机抖动）。 */
const SUPERSAMPLE = 3;

/** 边缘暗部强度（径向归一距离 1 处亮度乘 1-该值——圆钻折射的边缘暗环观感）。 */
const EDGE_DARKEN = 0.45;

/** 高光点：中心向左上偏移（半径比例）/ 高斯 σ（半径比例）/ 向白提亮峰值混入比。 */
const HIGHLIGHT_OFFSET = 0.42;
const HIGHLIGHT_SIGMA_RATIO = 0.2;
const HIGHLIGHT_STRENGTH = 0.55;

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * rgb → 内置标准钻贴图 PNG 字节（128×128 RGBA，圆外 alpha=0）。
 * 确定性：同 rgb 同字节（纯整数循环+确定性数学函数；encodePng 的 deflateSync
 * 对同输入同输出）——propose 期落 blob 与执行期幂等复用/再生成得以对 hash。
 */
export function generateBuiltinTexturePng(rgb: RgbTuple): Uint8Array {
  const size = BUILTIN_TEXTURE_SIZE;
  const center = size / 2; // 64（子样坐标空间 [0,128) 的圆心）
  const radius = DISC_RADIUS_PX;
  const sigma = radius * HIGHLIGHT_SIGMA_RATIO;
  const twoSigmaSq = 2 * sigma * sigma;
  const hx = center - HIGHLIGHT_OFFSET * radius;
  const hy = center - HIGHLIGHT_OFFSET * radius;
  const subs = SUPERSAMPLE * SUPERSAMPLE;
  const rgba = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 覆盖率：n×n 子样圆内测试（确定性抗锯齿——alpha=coverage×255）。
      let inside = 0;
      for (let sy = 0; sy < SUPERSAMPLE; sy++) {
        const py = y + (sy + 0.5) / SUPERSAMPLE;
        for (let sx = 0; sx < SUPERSAMPLE; sx++) {
          const px = x + (sx + 0.5) / SUPERSAMPLE;
          const dx = px - center;
          const dy = py - center;
          if (dx * dx + dy * dy <= radius * radius) inside += 1;
        }
      }
      const p = (y * size + x) * 4;
      if (inside === 0) {
        rgba[p + 3] = 0; // 圆外全透明（RGB 留零——gate 3 alpha bounds 只看 alpha）
        continue;
      }
      const coverage = inside / subs;
      // 着色三要素（像素中心单点采样——与覆盖率同源确定性）。
      const cx = x + 0.5 - center;
      const cy = y + 0.5 - center;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const t = clamp01(dist / radius);
      const shade = 1 - EDGE_DARKEN * t * t; // 边缘暗部（二次衰减——中心亮缘暗）
      const hdx = x + 0.5 - hx;
      const hdy = y + 0.5 - hy;
      const glow = HIGHLIGHT_STRENGTH * Math.exp(-(hdx * hdx + hdy * hdy) / twoSigmaSq); // 左上高光
      for (let ch = 0; ch < 3; ch++) {
        const base = rgb[ch] * shade;
        rgba[p + ch] = Math.round(base + (255 - base) * glow); // 基色暗部 + 向白高光
      }
      rgba[p + 3] = Math.round(coverage * 255);
    }
  }
  return new Uint8Array(encodePng(size, size, rgba));
}
