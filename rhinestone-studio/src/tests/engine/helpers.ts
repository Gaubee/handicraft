/*
Orthogonal intents (max 3):
1. [2026-09-18 Fixture] 程序化合成 ImageData fixture：硬边多色几何（矩形/圆环/细线/孤点），无 AA、确定性。
2. [2026-09-18 Invariant] 五策略共用的几何不变量断言（间距 ≥ pitch×0.999 / 钻心在掩码内）。
*/

import { expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gridFromSs, labFromRgb } from "$lib/engine";
import type { Block, EngineImage, Gem, GridSpec } from "$lib/engine";

export function makeImage(w: number, h: number, paint: (x: number, y: number) => [number, number, number]): EngineImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const IVORY: [number, number, number] = [255, 252, 240];
const RED: [number, number, number] = [200, 16, 46];
const BLACK: [number, number, number] = [26, 26, 26];
const GREEN: [number, number, number] = [85, 107, 47];
const BLUE: [number, number, number] = [62, 111, 176];

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** 120×120 五色：象牙底 + 40×40 红方 + 黑圆环(外30内18) + 3px 绿斜线 + 4×4 蓝孤点 */
export function fixtureShapes(): EngineImage {
  return makeImage(120, 120, (x, y) => {
    if (x >= 10 && x <= 49 && y >= 10 && y <= 49) return RED;
    const dr = Math.hypot(x - 85, y - 44);
    if (dr <= 30 && dr > 18) return BLACK;
    if (distToSeg(x + 0.5, y + 0.5, 15, 85, 105, 105) <= 1.5) return GREEN;
    if (x >= 54 && x <= 57 && y >= 5 && y <= 8) return BLUE;
    return IVORY;
  });
}

/** 48×48 纯红：单块单调性 fixture（无邻块 → 精确无跨块干扰） */
export function fixtureSolid(): EngineImage {
  return makeImage(48, 48, () => RED);
}

/** 96×64 双矩形相邻：cvt 密度连续性 fixture */
export function fixtureTwoRects(): EngineImage {
  return makeImage(96, 64, (x) => (x <= 47 ? RED : BLACK));
}

// ---------- 照片派生 fixture（boston.rgb → 硬边少色数字油画；smoke 与 hybrid 回归共用同一管线） ----------

/** 6 锚色（照片 → 数字油画调色板；含暖色系，覆盖样本的砖红/夜色基调） */
const PHOTO_ANCHORS: Array<[number, number, number]> = [
  [26, 26, 26], // 黑
  [200, 16, 46], // 红
  [212, 175, 55], // 金
  [240, 235, 220], // 米白
  [85, 107, 47], // 橄榄绿
  [62, 111, 176], // 蓝
];

/** boston.rgb 照片 → 6 锚色 Lab 吸附 + 3×3 众数滤波 ×2（确定性：并列取最小标签）→ 硬边少色图 */
export function loadBostonPhotoPainting(): EngineImage {
  const buf = readFileSync(join(__dirname, "fixtures", "boston.rgb"));
  const w = buf.readUInt32LE(0);
  const h = buf.readUInt32LE(4);
  const rgb = buf.subarray(8);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    data[p * 4] = rgb[p * 3];
    data[p * 4 + 1] = rgb[p * 3 + 1];
    data[p * 4 + 2] = rgb[p * 3 + 2];
    data[p * 4 + 3] = 255;
  }
  const anchorLabs = PHOTO_ANCHORS.map(([r, g, b]) => labFromRgb(r, g, b));
  const labels = new Uint8Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const lab = labFromRgb(data[p * 4], data[p * 4 + 1], data[p * 4 + 2]);
    let best = 0;
    let bestD = Infinity;
    for (let a = 0; a < anchorLabs.length; a++) {
      const dl = lab.L - anchorLabs[a].L;
      const da = lab.a - anchorLabs[a].a;
      const db = lab.b - anchorLabs[a].b;
      const d = dl * dl + da * da + db * db;
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    labels[p] = best;
  }
  let cur = labels;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const counts = new Uint8Array(PHOTO_ANCHORS.length);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            counts[cur[ny * w + nx]]++;
          }
        }
        let best = 0;
        for (let a = 1; a < counts.length; a++) if (counts[a] > counts[best]) best = a;
        next[y * w + x] = best;
      }
    }
    cur = next;
  }
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const [r, g, b] = PHOTO_ANCHORS[cur[p]];
    out[p * 4] = r;
    out[p * 4 + 1] = g;
    out[p * 4 + 2] = b;
    out[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

/** 标准测试网格：SS10 + 2.5px/mm → pitch 8px、钻径 7px */
export function standardGrid(): GridSpec {
  return gridFromSs("SS10", 2.5);
}

export const SEG_OPTS = { k: 6, seed: 3, gemDiameterPx: 7 } as const;

/** 断言全部硬不变量：任意两钻 ≥ pitch×0.999；钻心在所属块掩码内（中心点规则 → 无半钻） */
export function expectInvariants(gems: Gem[], blocks: Block[], pitch: number, label: string): void {
  const byId = new Map(blocks.map((b) => [b.id, b] as const));
  for (const gem of gems) {
    const block = byId.get(gem.blockId);
    expect(block, `${label}: 钻 ${gem.id} 引用块 ${gem.blockId} 应存在`).toBeDefined();
    if (!block) continue;
    const ix = Math.round(gem.x) - block.bbox.x;
    const iy = Math.round(gem.y) - block.bbox.y;
    const inside =
      ix >= 0 &&
      iy >= 0 &&
      ix < block.bbox.w &&
      iy < block.bbox.h &&
      block.mask.bits[iy * block.bbox.w + ix] === 1;
    expect(inside, `${label}: 钻 ${gem.id} (${gem.x.toFixed(2)},${gem.y.toFixed(2)}) 应在块 ${block.id} 掩码内`).toBe(true);
  }
  const threshold = pitch * 0.999;
  for (let i = 0; i < gems.length; i++) {
    for (let j = i + 1; j < gems.length; j++) {
      const dx = gems[j].x - gems[i].x;
      const dy = gems[j].y - gems[i].y;
      expect(
        dx * dx + dy * dy,
        `${label}: 钻 ${gems[i].id}(${gems[i].x.toFixed(2)},${gems[i].y.toFixed(2)}) 与 ${gems[j].id}(${gems[j].x.toFixed(2)},${gems[j].y.toFixed(2)}) 距离应 ≥ ${threshold.toFixed(3)}`,
      ).toBeGreaterThanOrEqual(threshold * threshold);
    }
  }
}
