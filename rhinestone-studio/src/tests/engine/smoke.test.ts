/*
[2026-09-18 Test] tasks 2.5 引擎冒烟：03-src.jpg（Boston 样本）派生合成数字油画 fixture 跑全管线，
五策略全量校验 + SVG/BOM 落盘 /tmp/engine-smoke/ 供人工目检。
fixture 生成链（一次性，不依赖网络）：03-src.jpg --sips--> 400px BMP --node--> boston.rgb（本目录提交，RGB 裸格式 + 8 字节宽高头）。
派生规则：Lab 最近邻吸附 6 锚色 → 3×3 众数滤波 ×2（去照片噪点）→ 数字油画风格的少色硬边图。
*/

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBostonPhotoPainting } from "./helpers";
import {
  buildBom,
  buildSvg,
  gridFromSs,
  isExportable,
  layout,
  mapColors,
  segment,
  STARTER_PALETTE,
  STRATEGY_IDS,
  type EngineImage,
  type StrategyId,
} from "$lib/engine";

const OUT_DIR = "/tmp/engine-smoke";

describe("引擎冒烟（03-src.jpg 派生数字油画全管线）", () => {
  const painting = loadBostonPhotoPainting();
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
        bomTotal = Number(lines[lines.length - 1].split(",")[5]);
        expect(bomTotal).toBe(gems.length);
      }
    }
    expect(bomTotal).toBeGreaterThan(150);
  }, 180_000);
});
