/*
[2026-09-18 Test] 计算内核 computeAll：合成图 fixture 全流程（segment+双策略）、
进度序列断言（segment → layout:a → layout:b → done，done 单调、total 恒定）、
shouldAbort 中止语义（阶段前检查点）、blocks 复用跳过 segment、
与直接调引擎输出的逐位一致性（内核只是编排）。
fixture 复用 engine 测试的合成图（120×120 硬边五色几何，确定性）。
*/

import { describe, expect, it } from "vitest";
import { layout, segment, type Block, type LayoutResult } from "$lib/engine";
import {
  ComputeAbortedError,
  computeAll,
  type ComputeInput,
  type ComputeProgress,
} from "$lib/workers/computeCore";
import { fixtureShapes, SEG_OPTS, standardGrid } from "../engine/helpers";

const IMAGE = fixtureShapes();
/** ComputeInput 契约要求 minAreaPx 显式（合成图 120×120，取 schema 缺省量级） */
const SEG_OPTS_MIN = { ...SEG_OPTS, minAreaPx: 12 };
const LAYOUT_OPTS = { density: 1, seed: 1, relax: { boundary: false, repulsion: false } };
const GRID = standardGrid(); // SS10@2.5px/mm → pitch 8px / 钻径 7px
const STRATEGIES = ["hex-thin", "hybrid"] as const;

function makeInput(overrides: Partial<ComputeInput> = {}): ComputeInput {
  return {
    image: IMAGE,
    segmentOpts: SEG_OPTS_MIN,
    strategies: [...STRATEGIES],
    layoutOpts: LAYOUT_OPTS,
    grid: GRID,
    ...overrides,
  };
}

describe("computeAll 内核", () => {
  it("全流程：合成图 fixture → 分块 ≥3 + 双策略均有结果", async () => {
    const out = await computeAll(makeInput());
    expect(out.blocks.length).toBeGreaterThanOrEqual(3);
    for (const sid of STRATEGIES) {
      expect(out.results[sid].gems.length).toBeGreaterThan(0);
      expect(Array.isArray(out.results[sid].warnings)).toBe(true);
      expect(typeof out.results[sid].dropped).toBe("number");
    }
  });

  it("进度序列：segment → layout:a → layout:b → done；done 单调（严格递增）、total 恒定", async () => {
    const events: ComputeProgress[] = [];
    await computeAll(makeInput(), (p) => events.push(p));
    expect(events.map((e) => e.stage)).toEqual([
      "segment",
      "layout:hex-thin",
      "layout:hybrid",
      "done",
    ]);
    const dones = events.map((e) => e.done);
    expect(dones).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < dones.length; i++) {
      expect(dones[i]).toBeGreaterThanOrEqual(dones[i - 1]);
    }
    expect(events.every((e) => e.total === 3)).toBe(true);
    expect(events[events.length - 1].done).toBe(events[events.length - 1].total);
    expect(events.every((e) => e.label.length > 0)).toBe(true);
  });

  it("确定性：与直接调引擎输出逐位一致（内核只是编排）", async () => {
    const out = await computeAll(makeInput());
    const blocksDirect = segment(IMAGE, SEG_OPTS_MIN);
    expect(out.blocks).toEqual(blocksDirect);
    for (const sid of STRATEGIES) {
      const direct: LayoutResult = layout(blocksDirect, sid, LAYOUT_OPTS, GRID);
      expect(out.results[sid]).toEqual(direct);
    }
  });

  it("shouldAbort：开跑前即中止 → 抛 ComputeAbortedError 且零进度", async () => {
    const events: ComputeProgress[] = [];
    const run = computeAll(makeInput(), (p) => events.push(p), () => true);
    await expect(run).rejects.toBeInstanceOf(ComputeAbortedError);
    await expect(run).rejects.toThrow("计算已取消");
    expect(events).toEqual([]);
  });

  it("shouldAbort：segment 阶段置位 → layout 前检查点中止，只收到 segment 进度", async () => {
    let abort = false;
    const events: ComputeProgress[] = [];
    const run = computeAll(
      makeInput(),
      (p) => {
        events.push(p);
        if (p.stage === "segment") abort = true;
      },
      () => abort,
    );
    await expect(run).rejects.toBeInstanceOf(ComputeAbortedError);
    expect(events.map((e) => e.stage)).toEqual(["segment"]);
  });

  it("blocks 复用：跳过 segment（无 segment 进度、done 从 1 起），结果与全流程逐位一致", async () => {
    const blocks: Block[] = segment(IMAGE, SEG_OPTS_MIN);
    const events: ComputeProgress[] = [];
    const out = await computeAll(makeInput({ blocks }), (p) => events.push(p));
    expect(events.map((e) => e.stage)).toEqual(["layout:hex-thin", "layout:hybrid", "done"]);
    expect(events.map((e) => e.done)).toEqual([1, 2, 3]);
    expect(events.every((e) => e.total === 3)).toBe(true);
    expect(out.blocks).toEqual(blocks);
    const full = await computeAll(makeInput());
    for (const sid of STRATEGIES) {
      expect(out.results[sid]).toEqual(full.results[sid]);
    }
  });

  it("空策略集：segment + done 即终态（total=1）", async () => {
    const events: ComputeProgress[] = [];
    const out = await computeAll(makeInput({ strategies: [] }), (p) => events.push(p));
    expect(events.map((e) => e.stage)).toEqual(["segment", "done"]);
    expect(events.map((e) => e.done)).toEqual([0, 1]);
    expect(Object.keys(out.results)).toEqual([]);
  });
});
