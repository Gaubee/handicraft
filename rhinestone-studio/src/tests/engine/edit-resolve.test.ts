/*
[2026-09-19 Test] add-manual-edit-mode task 2.1：resolveConflicts 引擎出口。
四级保留优先级（manual > moved layout > unmoved layout > 稳定输入序）；
纯 Gem[]（无 meta）输出与 layout 内部消解（enforceMinDistanceCounted）逐位一致——
这是「共用同一实现、layout 语义零漂移」的直接守护（全量管线级守护另由
layout-invariants / cross-block-stability 等既有套件承担）；
removed 报告与被删对象吻合；消解后 isExportableEditable 为真。
*/

import { describe, expect, it } from "vitest";
import {
  fromEditGem,
  gridFromSs,
  isExportableEditable,
  layout,
  resolveConflicts,
  segment,
  toEditGem,
  validateEditable,
  type EditGem,
  type Gem,
} from "$lib/engine";
import { enforceMinDistanceCounted } from "$lib/engine/layout/common";
import { fixtureShapes, SEG_OPTS } from "./helpers";

const grid = gridFromSs("SS10", 2.5); // pitch 8px（阈值 7.992）
const PITCH = 8;

function egem(id: string, x: number, y: number, over?: Partial<EditGem>): EditGem {
  return { id, x, y, colorId: "red", blockId: "blk-a", origin: "layout", moved: false, ...over };
}

function layoutGems(): Gem[] {
  const blocks = segment(fixtureShapes(), SEG_OPTS);
  return layout(blocks, "hex-pitch", { density: 1, seed: 7 }, grid).gems;
}

describe("resolveConflicts：四级保留优先级", () => {
  it("manual > unmoved layout（手工钻胜出，即使输入在后）", () => {
    const r = resolveConflicts(
      [egem("g-1", 0, 0), egem("m-1", 7, 0, { origin: "manual", blockId: null })],
      grid,
    );
    expect(r.gems.map((g) => g.id)).toEqual(["m-1"]);
    expect(r.removed.map((x) => x.gem.id)).toEqual(["g-1"]);
  });

  it("moved layout > unmoved layout", () => {
    const r = resolveConflicts([egem("g-1", 0, 0), egem("g-2", 7, 0, { moved: true })], grid);
    expect(r.gems.map((g) => g.id)).toEqual(["g-2"]);
    expect(r.removed.map((x) => x.gem.id)).toEqual(["g-1"]);
  });

  it("manual > moved layout", () => {
    const r = resolveConflicts(
      [egem("g-1", 0, 0, { moved: true }), egem("m-1", 7, 0, { origin: "manual", blockId: null })],
      grid,
    );
    expect(r.gems.map((g) => g.id)).toEqual(["m-1"]);
  });

  it("同优先级并列 → 稳定输入序，前者保留", () => {
    const r = resolveConflicts(
      [
        egem("m-1", 0, 0, { origin: "manual", blockId: null }),
        egem("m-2", 7, 0, { origin: "manual", blockId: null }),
      ],
      grid,
    );
    expect(r.gems.map((g) => g.id)).toEqual(["m-1"]);
    expect(r.removed.map((x) => x.gem.id)).toEqual(["m-2"]);
  });

  it("优先级只决定让位、不改变保留集的输入顺序", () => {
    // 输入序 [unmoved, far, manual]：manual 胜出后，保留子集仍按输入序 [far, manual]
    const r = resolveConflicts(
      [egem("g-1", 0, 0), egem("g-2", 50, 50), egem("m-1", 7, 0, { origin: "manual", blockId: null })],
      grid,
    );
    expect(r.gems.map((g) => g.id)).toEqual(["g-2", "m-1"]);
  });
});

describe("resolveConflicts：removed 报告与被删对象吻合", () => {
  it("reason 指明冲突对端（保留钻 id），且对端确实在保留集中", () => {
    const input = [
      egem("g-1", 0, 0),
      egem("g-2", 7, 0),
      egem("m-9", 56, 0, { origin: "manual", blockId: null }),
    ];
    const r = resolveConflicts(input, grid);
    expect(r.removed).toHaveLength(1);
    const { gem, reason } = r.removed[0];
    expect(gem.id).toBe("g-2");
    expect(input).toContain(gem); // 报告里是被删对象本身（对象同一性）
    expect(reason).toContain("g-1");
    expect(reason).toContain("间距不足");
    expect(r.gems.map((g) => g.id)).toContain("g-1");
  });

  it("kept ∪ removed = 输入集，且不相交（对象同一性）", () => {
    const input = [
      egem("g-1", 0, 0),
      egem("g-2", 7, 0),
      egem("g-3", 3.5, 6), // 与 g-1、g-2 均冲突
      egem("g-4", 40, 40),
      egem("m-1", 47, 40, { origin: "manual", blockId: null }),
    ];
    const r = resolveConflicts(input, grid);
    const keptSet = new Set(r.gems);
    for (const { gem } of r.removed) {
      expect(keptSet.has(gem)).toBe(false);
      expect(input).toContain(gem);
    }
    expect(r.gems.length + r.removed.length).toBe(input.length);
    for (const g of r.gems) expect(input).toContain(g);
  });

  it("无冲突 → 零删除、原样返回", () => {
    const input = [egem("g-1", 0, 0), egem("g-2", 8, 0), egem("g-3", 16, 0)];
    const r = resolveConflicts(input, grid);
    expect(r.gems).toEqual(input);
    expect(r.removed).toEqual([]);
  });
});

describe("resolveConflicts：纯 Gem[]（无 meta）退化为 layout 现行为", () => {
  it("黄金用例：keep-earlier 输入序消解（改造前 enforceMinDistance 语义）", () => {
    const gems: Gem[] = [
      { id: "a", x: 0, y: 0, colorId: "red", blockId: "b1" },
      { id: "b", x: 7, y: 0, colorId: "red", blockId: "b1" }, // 与 a 冲突
      { id: "c", x: 20, y: 0, colorId: "red", blockId: "b1" },
      { id: "d", x: 27, y: 0, colorId: "red", blockId: "b1" }, // 与 c 冲突
    ];
    const r = resolveConflicts(gems, grid);
    expect(r.gems.map((g) => g.id)).toEqual(["a", "c"]);
    expect(r.removed.map((x) => x.gem.id)).toEqual(["b", "d"]);
    expect(r.removed[0].reason).toContain("a");
    expect(r.removed[1].reason).toContain("c");
  });

  it("确定性随机压力：与 enforceMinDistanceCounted 逐位一致（含 dropped 计数）", () => {
    let s = 42;
    const rand = (): number => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    const gems: Gem[] = Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      x: rand() * 120,
      y: rand() * 90,
      colorId: "red",
      blockId: "b1",
    }));
    const r = resolveConflicts(gems, grid);
    const layoutNative = enforceMinDistanceCounted(gems, PITCH);
    expect(r.gems).toEqual(layoutNative.gems);
    expect(r.removed).toHaveLength(layoutNative.dropped);
    expect(r.gems.length + r.removed.length).toBe(gems.length);
  });

  it("真实 layout 产物注入近重副本（副本先于源出现）：仍与 layout 消解逐位一致", () => {
    const produced = layoutGems();
    const mixed: Gem[] = [];
    produced.forEach((g, i) => {
      if (i % 10 === 3) mixed.push({ ...g, id: `dup-${g.id}`, x: g.x + 1 }); // 副本先入
      mixed.push(g);
    });
    const r = resolveConflicts(mixed, grid);
    const native = enforceMinDistanceCounted(mixed, PITCH);
    expect(r.gems).toEqual(native.gems);
    expect(r.removed).toHaveLength(native.dropped);
  });
});

describe("resolveConflicts：一键修复闭环（消解后过导出门）", () => {
  it("间距违规 → resolveConflicts → validateEditable 无 spacing → isExportableEditable=true", () => {
    const blocks = segment(fixtureShapes(), SEG_OPTS);
    const editGems = layout(blocks, "hex-pitch", { density: 1, seed: 7 }, grid).gems.map(toEditGem);
    // 注入违规：两个手工钻叠在既有钻旁（1px / 2px）
    const victim = editGems[0];
    const other = editGems.length > 20 ? editGems[20] : editGems[editGems.length - 1];
    const injected: EditGem[] = [
      ...editGems,
      { ...victim, id: "m-1", x: victim.x + 1, origin: "manual", blockId: null, moved: false },
      { ...other, id: "m-2", x: other.x + 2, origin: "manual", blockId: null, moved: false },
    ];
    const before = validateEditable(injected, grid, blocks);
    expect(before.some((w) => w.kind === "spacing")).toBe(true);
    expect(isExportableEditable(before)).toBe(false);

    const r = resolveConflicts(injected, grid);
    const after = validateEditable(r.gems, grid, blocks);
    expect(after.filter((w) => w.kind === "spacing")).toEqual([]);
    expect(isExportableEditable(after)).toBe(true);
    expect(r.removed.length).toBeGreaterThan(0);
    // 消解结果可直接过导出边界（fromEditGem 占位语义稳定）
    for (const g of r.gems.slice(0, 5)) expect(typeof fromEditGem(g).blockId).toBe("string");
  });

  it("同输入两次调用逐位一致（确定性重放）", () => {
    const input = [
      egem("g-1", 0, 0),
      egem("g-2", 7, 0),
      egem("m-1", 3.5, 6.1, { origin: "manual", blockId: null }),
      egem("g-3", 3.5, 6.2, { moved: true }),
    ];
    const a = resolveConflicts(input, grid);
    const b = resolveConflicts(input, grid);
    expect(a).toEqual(b);
  });
});
