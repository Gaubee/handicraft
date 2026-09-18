/*
Orthogonal intents (max 3):
1. [2026-09-18 RPC] module worker 壳：纯 RPC 转发到 computeAll，无业务逻辑；协议 {type:'compute',id,input} → progress* → result | error。
2. [2026-09-18 Protocol] 单 worker 实例上多任务复用（id 匹配）；cancel 消息置位协作中止标记——注意内核微任务让出不排空消息队列，worker 内取消尽力而为，真正的取消语义由客户端丢弃迟到结果兜底（见 computeClient）。
3. [2026-09-18 Isomorphic] 协议处理抽为工厂 createComputeWorkerHandler（假 Worker 测试复用真实处理逻辑）；自装配仅在真实 worker 全局（WorkerGlobalScope 存在）下执行，jsdom/SSR/主线程导入安全跳过。
*/

import {
  computeAll,
  type ComputeInput,
  type ComputeOutput,
  type ComputeProgress,
} from "./computeCore";

// ---------- 协议类型（壳与客户端共用；仅类型导入，不把 worker 模块拉进主包） ----------

export interface ComputeRequestCompute {
  type: "compute";
  /** 客户端单调自增的任务号（同一长活 worker 上多任务区分） */
  id: number;
  input: ComputeInput;
}

export interface ComputeRequestCancel {
  type: "cancel";
  id: number;
}

export type ComputeRequest = ComputeRequestCompute | ComputeRequestCancel;

export type ComputeResponse =
  | { type: "progress"; id: number; progress: ComputeProgress }
  | { type: "result"; id: number; output: ComputeOutput }
  | { type: "error"; id: number; error: { name: string; message: string } };

export type ComputePost = (message: ComputeResponse) => void;

/** Error 不可靠结构化克隆，平面化为 {name, message}（客户端按 name 还原 ComputeAbortedError 身份） */
function serializeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

// ---------- RPC 处理工厂（每 worker 实例一份，持有该实例的取消标记集） ----------

export function createComputeWorkerHandler(): (message: unknown, post: ComputePost) => void {
  const cancelled = new Set<number>();
  return (message, post) => {
    if (!message || typeof message !== "object") return;
    const msg = message as ComputeRequest;
    if (msg.type === "cancel") {
      cancelled.add(msg.id);
      return;
    }
    if (msg.type === "compute") {
      const { id, input } = msg;
      cancelled.delete(id);
      void computeAll(
        input,
        (progress) => post({ type: "progress", id, progress }),
        () => cancelled.has(id),
      )
        .then((output) => post({ type: "result", id, output }))
        .catch((error: unknown) => post({ type: "error", id, error: serializeError(error) }));
      return;
    }
  };
}

// ---------- 自装配（真实 module worker；jsdom/SSR 主线程无 WorkerGlobalScope，安全跳过） ----------

const globalScope = globalThis as { WorkerGlobalScope?: unknown };
if (typeof globalScope.WorkerGlobalScope !== "undefined" && typeof self !== "undefined") {
  // lib.dom 不声明 DedicatedWorkerGlobalScope（在 lib.webworker 中），用结构化类型桥接
  const ctx = self as unknown as {
    onmessage: ((event: MessageEvent) => unknown) | null;
    postMessage(message: unknown): void;
  };
  const handler = createComputeWorkerHandler();
  ctx.onmessage = (event: MessageEvent) => handler(event.data, (m) => ctx.postMessage(m));
}
