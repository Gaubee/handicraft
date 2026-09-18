/*
[2026-09-18 Test] tasks 2.5 引擎冒烟：03-src.jpg（Boston 样本）派生合成数字油画 fixture 跑全管线，
五策略全量校验 + SVG/BOM 落盘 /tmp/engine-smoke/ 供人工目检。
fixture 生成链（一次性，不依赖网络）：03-src.jpg --sips--> 400px BMP --node--> boston.rgb（本目录提交，RGB 裸格式 + 8 字节宽高头）。
派生规则：Lab 最近邻吸附 6 锚色 → 3×3 众数滤波 ×2（去照片噪点）→ 数字油画风格的少色硬边图。
*/

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBom,
  buildSvg,
  gridFromSs,
  isExportable,
  labFromRgb,
  layout,
  mapColors,
  segment,
  STARTER_PALETTE,
  STRATEGY_IDS,
  type EngineImage,
  type StrategyId,
} from "$lib/engine";

const OUT_DIR = "/tmp/engine-smoke";

/** 6 锚色（照片 → 数字油画调色板；含暖色系，覆盖样本的砖红/夜色基调） */
const ANCHORS: Array<[number, number, number]> = [
  [26, 26, 26], // 黑
  [200, 16, 46], // 红
  [212, 175, 55], // 金
  [240, 235, 220], // 米白
  [85, 107, 47], // 橄榄绿
  [62, 111, 176], // 蓝
];

function loadFixture(): EngineImage {
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
  return { width: w, height: h, data };
}

function derivePainting(image: EngineImage): EngineImage {
  const { width: w, height: h, data } = image;
  const anchorLabs = ANCHORS.map(([r, g, b]) => labFromRgb(r, g, b));
  // 1) Lab 最近邻吸附
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
  // 2) 3×3 众数滤波 ×2（确定性：并列取最小标签）
  let cur = labels;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const counts = new Uint8Array(ANCHORS.length);
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
  // 3) 渲染为硬边少色图
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    const [r, g, b] = ANCHORS[cur[p]];
    out[p * 4] = r;
    out[p * 4 + 1] = g;
    out[p * 4 + 2] = b;
    out[p * 4 + 3] = 255;
  }
  return { width: w, height: h, data: out };
}

describe("引擎冒烟（03-src.jpg 派生数字油画全管线）", () => {
  const painting = derivePainting(loadFixture());
  const grid = gridFromSs("SS10", 2.5); // pitch 8px / 钻径 7px
  // minAreaPx 350：小于 ~2.5 钻足迹的碎块不进入排布（生产约束 §3.4 最小特征）
  const blocks = segment(painting, { k: 6, seed: 11, gemDiameterPx: 7, minAreaPx: 350 });

  it("分块合理（块数落在数字油画量级）", () => {
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    expect(blocks.length).toBeLessThanOrEqual(120);
  });

  it.each(STRATEGY_IDS)("%s：全管线零 spacing/mask 违规", (strategy: StrategyId) => {
    const { gems, warnings } = layout(blocks, strategy, { density: 1, seed: 11 }, grid);
    expect(gems.length).toBeGreaterThan(150); // 400×400 样本量级
    expect(warnings.filter((w) => w.kind === "spacing" || w.kind === "mask")).toEqual([]);
    expect(isExportable(warnings)).toBe(true);
  }, 90_000);

  it("产物落盘 /tmp/engine-smoke/（hex-pitch / hybrid / cvt 的 SVG + BOM CSV）", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const outputs: Array<[StrategyId, string]> = [
      ["hex-pitch", "rhinestone-hex-pitch.svg"],
      ["hybrid", "rhinestone-hybrid.svg"],
      ["cvt", "rhinestone-cvt.svg"],
    ];
    let bomTotal = -1;
    for (const [strategy, file] of outputs) {
      const { gems, warnings } = layout(blocks, strategy, { density: 1, seed: 11 }, grid);
      expect(isExportable(warnings)).toBe(true);
      mapColors(gems, blocks, STARTER_PALETTE);
      const svg = buildSvg(gems, grid, {
        width: painting.width,
        height: painting.height,
        palette: STARTER_PALETTE,
        showBoundaries: false,
      });
      writeFileSync(join(OUT_DIR, file), svg);
      expect((svg.match(/<circle /g) ?? []).length).toBe(gems.length);
      if (strategy === "hex-pitch") {
        const csv = buildBom(gems, STARTER_PALETTE, grid);
        writeFileSync(join(OUT_DIR, "rhinestone-bom.csv"), csv);
        const lines = csv.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
        bomTotal = Number(lines[lines.length - 1].split(",")[3]);
        expect(bomTotal).toBe(gems.length);
      }
    }
    expect(bomTotal).toBeGreaterThan(150);
  }, 180_000);
});
