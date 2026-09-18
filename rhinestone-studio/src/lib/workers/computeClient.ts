/*
Orthogonal intents (max 4):
1. [2026-09-18 Offload] Worker 可用（浏览器）时计算全部走 module worker：单例长活实例复用、id 匹配多任务、进度转发、错误还原透传。
2. [2026-09-18 Fallback] Worker 不可用（jsdom/SSR）时主线程直接跑同一内核 computeAll——同构：进度序列、取消（ComputeAbortedError）、错误语义与 worker 路径一致；start 延后一个微任务，保证句柄先于任何进度回调落地。
3. [2026-09-18 Cancel] cancel = 标记 + 立即以 ComputeAbortedError reject（幂等、结算后 no-op）；不 terminate 长活 worker；迟到消息按未知 id 丢弃，cancel 消息仅作 worker 内协作中止的尽力而为信号。
4. [2026-09-18 Crash] worker onerror：全体 pending 以错误 reject、terminate 并置空单例（下次调用自动重建）。
*/

import {
  ComputeAbortedError,
  computeAll,
  type ComputeInput,
  type ComputeOutput,
  type ComputeProgress,
} from "./computeCore";
import type { ComputeRequest, ComputeResponse } from "./computeWorker";

export interface ComputeHandle {
  promise: Promise<ComputeOutput>;
  /** 幂等取消：立即 reject(ComputeAbortedError)；已结算（result/error/前次 cancel）后为 no-op */
  cancel(): void;
}

/** Worker 构造可用性（浏览器 true；jsdom/SSR false）——UI 据此决定 loading 文案（如「后台计算中」vs「计算中」） */
export function isWorkerAvailable(): boolean {
  return typeof Worker !== "undefined";
}

// ---------- Worker 单例与 pending 表 ----------

let worker: Worker | null = null;
let nextId = 1;

interface PendingJob {
  resolve: (output: ComputeOutput) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: ComputeProgress) => void;
}

const pending = new Map<number, PendingJob>();

function getWorker(): Worker {
  if (worker === null) {
    const w = new Worker(new URL("./computeWorker.ts", import.meta.url), { type: "module" });
    w.onmessage = (event: MessageEvent<ComputeResponse>) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      const job = pending.get(msg.id);
      if (!job) return; // 已取消/未知的迟到消息：丢弃
      switch (msg.type) {
        case "progress":
          job.onProgress?.(msg.progress);
          return;
        case "result":
          pending.delete(msg.id);
          job.resolve(msg.output);
          return;
        case "error":
          pending.delete(msg.id);
          job.reject(deserializeError(msg.error));
          return;
      }
    };
    w.onerror = (event: ErrorEvent) => {
      event.preventDefault();
      const crash = new Error(`compute worker 异常：${event.message || "未知错误"}`);
      failAllPending(crash);
      w.terminate();
      if (worker === w) worker = null; // 下次 runCompute 重建
    };
    worker = w;
  }
  return worker;
}

function failAllPending(error: Error): void {
  for (const [id, job] of pending) {
    pending.delete(id);
    job.reject(error);
  }
}

/** 还原错误身份：ComputeAbortedError 按类还原，其余保留 name/message 透传 */
function deserializeError(e: { name: string; message: string }): Error {
  if (e.name === "ComputeAbortedError") return new ComputeAbortedError(e.message);
  const error = new Error(e.message);
  error.name = e.name;
  return error;
}

/**
 * 剥离 Svelte $state 深代理的深拷贝（worker postMessage 边界，2026-09-19 真机走查实证）：
 * store 读出的 EngineImage.data / Block.mask.bits 是 Proxy，结构化克隆直接 DataCloneError。
 * 按值重建普通对象/数组/Uint8ClampedArray/Uint8Array，原语原样返回；
 * ComputeInput 是纯数据（无函数/循环引用/Map/Set/Date），此遍历安全且与引擎读取语义等价。
 * 注意：类型化数组必须按下标循环拷贝——构造器对 Proxy 走可迭代路径会在代理接收者上抛
 * "this is not a typed array"（vitest 假 Worker 回归实测）。
 */
function toCloneable<T>(value: T): T {
  if (value instanceof Uint8ClampedArray || value instanceof Uint8Array) {
    const src = value as Uint8ClampedArray | Uint8Array;
    const out =
      src instanceof Uint8ClampedArray
        ? new Uint8ClampedArray(src.length)
        : new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) out[i] = src[i];
    return out as unknown as T;
  }
  if (Array.isArray(value)) return value.map(toCloneable) as unknown as T;
  if (value instanceof Object) {
    const out: Record<string, unknown> = {};
    for (const key in value) out[key] = toCloneable((value as Record<string, unknown>)[key]);
    return out as T;
  }
  return value;
}

// ---------- 主入口 ----------

export function runCompute(
  input: ComputeInput,
  onProgress?: (progress: ComputeProgress) => void,
): ComputeHandle {
  // 同构 fallback：主线程直接跑内核（微任务延迟启动 → runCompute 返回句柄后才开始计算）
  if (!isWorkerAvailable()) {
    let cancelled = false;
    const promise = Promise.resolve().then(() => computeAll(input, onProgress, () => cancelled));
    return {
      promise,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  const id = nextId++;
  const w = getWorker();
  const promise = new Promise<ComputeOutput>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
  });
  const request: ComputeRequest = { type: "compute", id, input: toCloneable(input) };
  w.postMessage(request);
  return {
    promise,
    cancel: () => {
      const job = pending.get(id);
      if (!job) return; // 已结算或已取消：幂等 no-op
      pending.delete(id); // 迟到的 progress/result/error 按未知 id 丢弃
      w.postMessage({ type: "cancel", id } as ComputeRequest);
      job.reject(new ComputeAbortedError());
    },
  };
}

// ---------- 测试支持 ----------

/** 仅测试使用：terminate 单例 worker 并清空 pending（假 Worker 换装/测试隔离），下次 runCompute 重建。
 *  注意 nextId 不回卷：跨复位保持单调，杜绝上一测试在途消息的旧 id 与新任务碰撞。 */
export function __resetComputeClientForTests(): void {
  if (worker !== null) worker.terminate();
  worker = null;
  failAllPending(new ComputeAbortedError("compute client 已重置"));
}
