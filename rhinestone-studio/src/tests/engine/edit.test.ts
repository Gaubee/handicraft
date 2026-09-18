/*
Orthogonal intents (max 2):
1. [2026-09-19 Contract] Gem↔EditGem 边界转换契约（add-manual-edit-mode 契约冻结的代码落点）。
2. [2026-09-19 Boundary] 往返保真 + 占位语义（blockId null → '__manual' 不影响导出产物）。
*/

import { describe, expect, it } from "vitest";
import { fromEditGem, toEditGem, type EditGem, type Gem } from "$lib/engine";

const gem: Gem = { id: "g-1", x: 10.5, y: 20.25, colorId: "red", blockId: "blk-a" };

describe("Gem ↔ EditGem 边界转换", () => {
  it("toEditGem：origin=layout、moved=false、五字段直传", () => {
    const e = toEditGem(gem);
    expect(e).toEqual({ ...gem, origin: "layout", moved: false });
  });

  it("fromEditGem：blockId 非 null 时往返逐字段保真", () => {
    const round = fromEditGem(toEditGem(gem));
    expect(round).toEqual(gem);
  });

  it("fromEditGem：手工钻（blockId=null）以 '__manual' 占位，其余字段保真", () => {
    const manual: EditGem = {
      id: "m-42",
      x: 1,
      y: 2,
      colorId: "gold",
      blockId: null,
      origin: "manual",
      moved: false,
    };
    expect(fromEditGem(manual)).toEqual({
      id: "m-42",
      x: 1,
      y: 2,
      colorId: "gold",
      blockId: "__manual",
    });
  });

  it("结构化兼容：纯 Gem[] 与 EditGem[] 都满足 resolveConflicts 的最小约束（类型级断言）", () => {
    const asMeta = (g: Gem | EditGem): { id: string; x: number; y: number } => g;
    expect(asMeta(gem).id).toBe("g-1");
    expect(asMeta(toEditGem(gem)).id).toBe("g-1");
  });
});
