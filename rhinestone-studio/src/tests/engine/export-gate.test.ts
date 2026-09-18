/*
[2026-09-18 Test] N1 回归：导出阻断门覆盖 mask 违规。
- spec「排布硬约束」把"钻心在掩码内"与最小间距并列为硬约束；isExportable 此前只查 spacing。
- applyBoundary 的凹轮廓插值点可能出掩码 → 掩码内钳制（出掩码点回退原钻位）。
白盒：applyBoundary 深路径 import（UI 仍只准走 $lib/engine）。
*/

import { describe, expect, it } from "vitest";
import { isExportable, layout, segment, validate, type Block, type Gem } from "$lib/engine";
import { buildLayoutCtx } from "$lib/engine/layout/common";
import { applyBoundary } from "$lib/engine/layout/relax";
import { fixtureShapes, makeImage, SEG_OPTS, standardGrid } from "./helpers";

const RED: [number, number, number] = [200, 16, 46];

function blockFromMask(bits: number[], w: number, h: number): Block {
  const mask = { w, h, bits: Uint8Array.from(bits) };
  let area = 0;
  for (const b of bits) if (b === 1) area += 1;
  return {
    id: "syn",
    label: "syn",
    mask,
    colorRgb: RED,
    areaPx: area,
    bbox: { x: 0, y: 0, w, h },
    widthPx: { max: w, mean: w / 2 },
    suggested: "fill",
  };
}

describe("isExportable 阻断门（N1）", () => {
  it("mask 违规阻断导出（此前仅 spacing 阻断）", () => {
    const spacingOnly = [{ kind: "spacing", detail: "x" }] as const;
    const maskOnly = [{ kind: "mask", detail: "x" }] as const;
    const islandOnly = [{ kind: "island", detail: "x" }] as const;
    expect(isExportable([...spacingOnly])).toBe(false);
    expect(isExportable([...maskOnly])).toBe(false);
    expect(isExportable([...islandOnly])).toBe(true); // 孤岛仅提示，不阻断
    expect(isExportable([])).toBe(true);
  });

  it("validate 对出掩码钻产出 mask warning 且 isExportable=false", () => {
    const block = blockFromMask(
      [
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
        1, 1, 1, 1, 1, 1, 1, 1,
      ],
      8,
      8,
    );
    const inside: Gem = { id: "g1", x: 2, y: 2, colorId: "", blockId: "syn" };
    const outside: Gem = { id: "g2", x: 30, y: 30, colorId: "", blockId: "syn" };
    const warnings = validate([inside, outside], standardGrid(), [block]);
    expect(warnings.some((w) => w.kind === "mask")).toBe(true);
    expect(isExportable(warnings)).toBe(false);
  });
});

describe("applyBoundary 掩码内钳制（凹轮廓插值不出掩码）", () => {
  /** 梳齿形：一排 1px 宽凹槽，轮廓插值极易横穿凹口 */
  function combFixture(): Block {
    const w = 40;
    const h = 20;
    const bits: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        // 每 4px 一根 2px 宽齿（y < 16），底板 y ≥ 16 连通
        bits.push(y >= 16 || (x % 4 < 2 && y >= 2) ? 1 : 0);
      }
    }
    return blockFromMask(bits, w, h);
  }

  it.each([
    ["comb 凹槽", combFixture],
    ["annulus 圆环", () => segment(fixtureShapes(), SEG_OPTS).find((b) => b.suggested === "fill" && b.bbox.w > 40)!],
  ])("%s：boundary 后全部钻仍在所属块掩码内", (_name: string, make: () => Block) => {
    const block = make();
    const ctx = buildLayoutCtx([block], { density: 1, seed: 7, relax: { boundary: true, repulsion: false } }, standardGrid());
    // 基底钻：冻结晶格落掩码
    const base: Gem[] = [];
    const pitch = ctx.pitchPx;
    for (let y = 0; y < block.bbox.h; y += pitch) {
      for (let x = 0; x < block.bbox.w; x += pitch) {
        const ix = Math.round(x);
        const iy = Math.round(y);
        if (ix < block.bbox.w && iy < block.bbox.h && block.mask.bits[iy * block.bbox.w + ix] === 1) {
          base.push({ id: `b${base.length}`, x: ix, y: iy, colorId: "", blockId: block.id });
        }
      }
    }
    expect(base.length).toBeGreaterThan(2);
    const moved = applyBoundary(base, ctx);
    expect(moved.length).toBe(base.length); // boundary 保数
    // 本测试只断言掩码归属（钳制的属性）；间距由 layout 终局消解兜底，boundary 单独
    // 均匀重排允许暂时压间距（relax.ts 文档语义），不在此断言
    for (const g of moved) {
      const ix = Math.round(g.x) - block.bbox.x;
      const iy = Math.round(g.y) - block.bbox.y;
      const inside =
        ix >= 0 &&
        iy >= 0 &&
        ix < block.bbox.w &&
        iy < block.bbox.h &&
        block.mask.bits[iy * block.bbox.w + ix] === 1;
      expect(inside, `钻 ${g.id} (${g.x.toFixed(2)},${g.y.toFixed(2)}) 应留在块掩码内`).toBe(true);
    }
    // 钳制只在必要时回退原位：至少一枚钻应发生位移（boundary 生效证据）
    const anyMoved = moved.some((g, i) => Math.hypot(g.x - base[i].x, g.y - base[i].y) > 0.5);
    expect(anyMoved).toBe(true);
  });

  it("layout 全管线：boundary+repulsion 开启时 fixtureShapes 零 mask 违规且可导出", () => {
    const blocks = segment(fixtureShapes(), SEG_OPTS);
    const { gems, warnings } = layout(
      blocks,
      "hex-pitch",
      { density: 1, seed: 7, relax: { boundary: true, repulsion: true } },
      standardGrid(),
    );
    expect(warnings.filter((w) => w.kind === "mask")).toEqual([]);
    expect(isExportable(warnings)).toBe(true);
    expect(gems.length).toBeGreaterThan(0);
  });
});

describe("makeImage 合成助手仍可用（本文件依赖）", () => {
  it("2×2 三色合成", () => {
    const img = makeImage(2, 2, (x, y) => (x + y === 1 ? RED : [0, 0, 0]));
    expect(img.width).toBe(2);
    expect(img.data.length).toBe(16);
  });
});
