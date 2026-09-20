/*
Orthogonal intents (max 5):
1. [2026-09-18 Offload] 排钻工作台重计算的纯函数内核：segment → 逐策略 layout 的阶段化编排（worker 壳与主线程 fallback 共用同一实现，同输入同输出）。
2. [2026-09-18 Progress] 阶段事件模型：每阶段开始时上报 {stage, done(已完成单元数), total(策略数+1), label}；done 单调不减，终态 done === total。
3. [2026-09-18 Cancel] shouldAbort 检查点在每阶段开始前（segment 前 + 每策略 layout 前），命中抛 ComputeAbortedError（上层接线 run 号取消时按此错误类型识别）。
4. [2026-09-18 Reuse] input.blocks 存在时整体跳过 segment（复用既有分块的重排路径），segment 单元计为预完成（done 从 1 起，不发 segment 进度）。
5. [2026-09-18 Purity] 内核只是编排：直接调用引擎公共 API（$lib/engine），零引擎改动、零防御拷贝——输出与直接调引擎逐位一致。
*/

import {
  layout,
  segment,
  type Block,
  type EngineImage,
  type GridSpec,
  type LayoutOptions,
  type LayoutResult,
  type SegmentOptions,
  type StrategyId,
} from "$lib/engine";

/** 计算取消（shouldAbort 命中）；worker RPC 与主线程 fallback 两侧共用同一错误身份 */
export class ComputeAbortedError extends Error {
  constructor(message = "计算已取消") {
    super(message);
    this.name = "ComputeAbortedError";
  }
}

/** 进度阶段标签（与 studio.svelte.ts 的 STRATEGY_LABELS 同值本地副本——worker 不得 import runes store，合流时可统一） */
export const STRATEGY_LABELS: Record<StrategyId, string> = {
  "hex-thin": "六方抽稀",
  "hex-pitch": "六方变距",
  poisson: "泊松盘",
  hybrid: "语义混合",
  cvt: "CVT 点画",
};

export interface ComputeInput {
  image: EngineImage;
  /** minAreaPx 显式必填（store 侧 minAreaFor(image) 随图尺寸缩放） */
  segmentOpts: SegmentOptions & { minAreaPx: number };
  /** 参与本轮排布的策略（顺序即进度顺序）；单策略引擎异常不隔离，直接 reject 整轮（错误透传给调用方） */
  strategies: StrategyId[];
  layoutOpts: LayoutOptions;
  grid: GridSpec;
  /** 既有分块（重排路径）：存在时跳过 segment，image 不参与计算 */
  blocks?: Block[];
}

export interface ComputeProgress {
  stage: "segment" | `layout:${StrategyId}` | "done";
  /** 已完成计算单元数（segment 计 1 单元；blocks 复用路径预完成） */
  done: number;
  /** 总单元数 = 策略数 + 1（segment 单元） */
  total: number;
  /** 人类可读阶段名（UI 进度文案直出） */
  label: string;
}

export interface ComputeOutput {
  blocks: Block[];
  results: Record<StrategyId, LayoutResult>;
}

/** 微任务让出：进度回调在阶段间可被观察（微任务粒度，不让出渲染帧——渲染级让出由 worker 路径天然获得） */
function yieldMicrotask(): Promise<void> {
  return Promise.resolve();
}

/**
 * 全流程计算：segment（或复用 blocks）→ 逐策略 layout。
 * 进度序列（无 blocks、策略 [a,b]）：segment(0/3) → layout:a(1/3) → layout:b(2/3) → done(3/3)。
 * 每个事件描述"即将进入的阶段 + 已完成单元数"；shouldAbort 在每阶段开始前检查。
 */
export async function computeAll(
  input: ComputeInput,
  onProgress?: (progress: ComputeProgress) => void,
  shouldAbort?: () => boolean,
): Promise<ComputeOutput> {
  const total = input.strategies.length + 1;
  const report = (stage: ComputeProgress["stage"], done: number, label: string): void => {
    onProgress?.({ stage, done, total, label });
  };
  const checkAbort = (): void => {
    if (shouldAbort?.()) throw new ComputeAbortedError();
  };

  // 阶段 1：segment（blocks 复用路径整体跳过，不发 segment 进度）
  let blocks: Block[];
  let done: number;
  if (input.blocks !== undefined) {
    blocks = input.blocks;
    done = 1;
  } else {
    checkAbort();
    report("segment", 0, "正在分块…");
    await yieldMicrotask();
    blocks = segment(input.image, input.segmentOpts);
    done = 1;
  }

  // 阶段 2..N：逐策略 layout（结果只含本轮请求的策略键）
  const results = {} as Record<StrategyId, LayoutResult>;
  for (const sid of input.strategies) {
    checkAbort();
    report(`layout:${sid}`, done, `${STRATEGY_LABELS[sid]} 排布中…`);
    await yieldMicrotask();
    results[sid] = layout(blocks, sid, input.layoutOpts, input.grid);
    done++;
  }

  report("done", done, "计算完成");
  return { blocks, results };
}
