/*
[2026-09-18 Test] 客户端双路径：
- fallback（jsdom 无真 Worker，vitest 主测路径）：端到端 promise + 进度序列 + cancel 语义 + 错误透传 + 结算后 cancel no-op；
- worker RPC：vi.stubGlobal 假 Worker 桥接「真实」createComputeWorkerHandler（协议处理零 mock），
  覆盖单例复用、id 匹配/并发不串扰、进度转发顺序、错误还原、取消后迟到结果丢弃且单例存活。
*/

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layout, segment } from "$lib/engine";
import { ComputeAbortedError } from "$lib/workers/computeCore";
import type { ComputeInput, ComputeProgress } from "$lib/workers/computeCore";
import {
  __resetComputeClientForTests,
  isWorkerAvailable,
  runCompute,
} from "$lib/workers/computeClient";
import { createComputeWorkerHandler } from "$lib/workers/computeWorker";
import { fixtureShapes, SEG_OPTS, standardGrid } from "../engine/helpers";

const IMAGE = fixtureShapes();
const SEG_OPTS_MIN = { ...SEG_OPTS, minAreaPx: 12 };
const LAYOUT_OPTS = { density: 1, seed: 1, relax: { boundary: false, repulsion: false } };
const GRID = standardGrid();

/** 数据长度与 width*height*4 不符 → 引擎 segment 抛错（错误透传路径的触发器） */
const BAD_IMAGE = { width: 4, height: 4, data: new Uint8ClampedArray(4) };

function makeInput(overrides: Partial<ComputeInput> = {}): ComputeInput {
  return {
    image: IMAGE,
    segmentOpts: SEG_OPTS_MIN,
    strategies: ["hex-thin", "hybrid"],
    layoutOpts: LAYOUT_OPTS,
    grid: GRID,
    ...overrides,
  };
}

/** 直调引擎的期望输出（确定性对照基准） */
function expectedLayout(sid: "hex-thin" | "hybrid") {
  return layout(segment(IMAGE, SEG_OPTS_MIN), sid, LAYOUT_OPTS, GRID);
}

// ---------- 假 Worker：主线程桥接真实协议处理（每个实例一份 handler，持有各自取消标记集） ----------

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => unknown) | null = null;
  private readonly handler = createComputeWorkerHandler();

  constructor(_url?: unknown, _opts?: unknown) {
    FakeWorker.instances.push(this);
  }

  postMessage(message: unknown): void {
    // 模拟 worker 线程边界：请求先过真实结构化克隆（Proxy 输入在此抛 DataCloneError，
    // 与浏览器 postMessage 同语义——2026-09-19 真机走查抓到的 $state 代理问题的回归防线），
    // 请求处理与响应投递均隔一个 macrotask
    structuredClone(message);
    setTimeout(() => {
      this.handler(message, (m) => setTimeout(() => this.onmessage?.({ data: m } as unknown as MessageEvent), 0));
    }, 0);
  }

  terminate(): void {
    /* 测试桩：无需清理 */
  }
}

async function flushMacrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  FakeWorker.instances = [];
  __resetComputeClientForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __resetComputeClientForTests();
});

// ---------- fallback 路径（jsdom 无 Worker，vitest 主测） ----------

describe("computeClient fallback（无 Worker 环境）", () => {
  it("isWorkerAvailable() 为 false（jsdom）", () => {
    expect(isWorkerAvailable()).toBe(false);
  });

  it("端到端：promise 输出 + 进度序列 + 与直调引擎逐位一致", async () => {
    const events: ComputeProgress[] = [];
    const out = await runCompute(makeInput(), (p) => events.push(p)).promise;
    expect(events.map((e) => e.stage)).toEqual([
      "segment",
      "layout:hex-thin",
      "layout:hybrid",
      "done",
    ]);
    expect(events.map((e) => e.done)).toEqual([0, 1, 2, 3]);
    expect(out.blocks).toEqual(segment(IMAGE, SEG_OPTS_MIN));
    expect(out.results["hex-thin"]).toEqual(expectedLayout("hex-thin"));
    expect(out.results["hybrid"]).toEqual(expectedLayout("hybrid"));
  });

  it("同步 cancel → 下一个检查点抛 ComputeAbortedError，零进度", async () => {
    const events: ComputeProgress[] = [];
    const handle = runCompute(makeInput(), (p) => events.push(p));
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(ComputeAbortedError);
    expect(events).toEqual([]);
  });

  it("onProgress 内 cancel → segment 后中止（句柄先于首个进度落地）", async () => {
    const events: ComputeProgress[] = [];
    const handle = runCompute(makeInput(), (p) => {
      events.push(p);
      if (p.stage === "segment") handle.cancel();
    });
    await expect(handle.promise).rejects.toBeInstanceOf(ComputeAbortedError);
    expect(events.map((e) => e.stage)).toEqual(["segment"]);
  });

  it("结算后 cancel 为 no-op（不翻转已完成的 promise）", async () => {
    const handle = runCompute(makeInput({ strategies: [] }));
    const out = await handle.promise;
    handle.cancel();
    handle.cancel();
    await expect(handle.promise).resolves.toBe(out);
    expect(Object.keys(out.results)).toEqual([]);
  });

  it("错误透传：引擎异常沿 promise 拒绝（消息保留）", async () => {
    const handle = runCompute(makeInput({ image: BAD_IMAGE }));
    await expect(handle.promise).rejects.toThrow(/data 长度/);
  });
});

// ---------- worker RPC 路径（假 Worker + 真实协议处理） ----------

describe("computeClient worker RPC（stub Worker + 真实 handler）", () => {
  beforeEach(() => {
    vi.stubGlobal("Worker", FakeWorker);
  });

  it("isWorkerAvailable() 为 true（stub 后）且端到端 RPC 与直调引擎逐位一致", async () => {
    expect(isWorkerAvailable()).toBe(true);
    const events: ComputeProgress[] = [];
    const out = await runCompute(makeInput(), (p) => events.push(p)).promise;
    expect(events.map((e) => e.stage)).toEqual([
      "segment",
      "layout:hex-thin",
      "layout:hybrid",
      "done",
    ]);
    expect(out.blocks).toEqual(segment(IMAGE, SEG_OPTS_MIN));
    expect(out.results["hex-thin"]).toEqual(expectedLayout("hex-thin"));
    expect(out.results["hybrid"]).toEqual(expectedLayout("hybrid"));
    expect(FakeWorker.instances).toHaveLength(1); // 长活单例
  });

  it("并发两次 runCompute：同一单例复用，id 匹配互不串扰", async () => {
    const [outA, outB] = await Promise.all([
      runCompute(makeInput({ strategies: ["hex-thin"] })).promise,
      runCompute(makeInput({ strategies: ["hybrid"] })).promise,
    ]);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(outA.results["hex-thin"]).toEqual(expectedLayout("hex-thin"));
    expect(outB.results["hybrid"]).toEqual(expectedLayout("hybrid"));
    // results 只含各自请求的策略键
    expect(outA.results["hybrid"]).toBeUndefined();
    expect(outB.results["hex-thin"]).toBeUndefined();
  });

  it("错误还原：引擎异常经 worker 协议平面化后按 message 拒绝", async () => {
    const handle = runCompute(makeInput({ image: BAD_IMAGE }));
    await expect(handle.promise).rejects.toThrow(/data 长度/);
  });

  it("cancel：立即 reject(ComputeAbortedError)，迟到结果被丢弃且单例存活可继续服务", async () => {
    const handle = runCompute(makeInput());
    handle.cancel();
    await expect(handle.promise).rejects.toBeInstanceOf(ComputeAbortedError);
    await flushMacrotasks(); // 迟到的 progress/result 全部到达并被未知 id 丢弃
    expect(FakeWorker.instances).toHaveLength(1); // cancel 不 terminate
    const again = runCompute(makeInput({ strategies: ["hex-thin"] }));
    const out = await again.promise;
    expect(out.results["hex-thin"].gems.length).toBeGreaterThan(0);
  });

  it("$state 深代理输入（Proxy 包裹 image/blocks）经边界剥离后可克隆且结果逐位一致", async () => {
    // 用原生 Proxy 复刻 Svelte $state 深代理语义（无需 runes 环境）
    const deepProxy = <T>(v: T): T => {
      if (typeof v !== "object" || v === null) return v;
      return new Proxy(v as object, {
        get(t, k) {
          // 不传 receiver：typedArray 的 length getter 要求接收者有内部槽，
          // 代理只负责把读出的对象值再深包一层（复刻 $state 的读取语义）
          const val = Reflect.get(t, k);
          return typeof val === "object" && val !== null ? deepProxy(val) : val;
        },
      }) as T;
    };
    const proxied = deepProxy(makeInput({ blocks: segment(IMAGE, SEG_OPTS_MIN) }));
    // 前置证明：未剥离的代理输入过不了结构化克隆（真实 postMessage 的失败形态）
    expect(() => structuredClone(proxied)).toThrow();
    const out = await runCompute(proxied).promise;
    expect(out.blocks).toEqual(segment(IMAGE, SEG_OPTS_MIN));
    expect(out.results["hex-thin"]).toEqual(expectedLayout("hex-thin"));
    expect(out.results["hybrid"]).toEqual(expectedLayout("hybrid"));
  });
});
