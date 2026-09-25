/**
 * 自由代码族策略（add-subject-sam-pipeline P1.4——design §4.4「Owner 倾向的模式，
 * 重要度最高」+ owner-directive-20260924：LLM 在画布上自写排钻算法）。
 *
 * 形态：LLM 生成 JS 片段（CodeStrategyArtifact.source+entryPoint+seed）→ 沙箱有界执行
 * （run.ts 三线：CPU 计数/墙钟 terminate/内存界）→ 输出校验链（Zod→强制引擎校验门）。
 *
 * 通道（本波）：inline source 测试通道（params.source/entryPoint/seed——tasks P1.4
 * 「本波 apply 支持 inline code 通道供测试」）；codeArtifactRef 工件读取（BlobStore
 * 内容寻址 → CodeStrategyArtifact）归 P3 接线——显式 fail-fast 不静默降级。
 *
 * 同步性：KernelStrategy.apply 为冻结同步接口——经 runSandboxArtifactSync（Atomics 桥，
 * 阻塞 ≤ wallMs 缺省 5s）；异步消费面（P3 LLM 循环）直接用 runSandboxArtifact。
 * 失败=抛 SandboxFailureError（typed failure 载荷+userMessage——P3 捕获回 LLM 有界重试）。
 */
import { z } from 'zod';
import { BlobRefSchema } from '@handicraft/contracts';
import type { KernelStrategy } from '../registry.js';
import { runSandboxArtifactSync, type SandboxFailure } from './run.js';

/**
 * 源码体积上限（=run.ts SANDBOX_MAX_CODE_BYTES）。字面量而非 import：registry→free-code→
 * run→registry 模块环的求值序安全性要求 free-code 模块体零跨模块值引用（TDZ 实证
 * 2026-09-25：tsx ESM 下 run 先载 → registry → free-code 顶层取 SANDBOX_MAX_CODE_BYTES
 * 抛 ReferenceError）——等值由 tests 断言把守。
 */
const MAX_CODE_BYTES = 256 * 1024;

/** free-code 参数（inline 测试通道——P3 工件引用通道二选一）。 */
export const FreeCodeParamsSchema = z
  .object({
    /** JS 源码（inline 测试通道——LLM 片段；无 import，依赖经 sandbox 注入面）。 */
    source: z.string().min(1).max(MAX_CODE_BYTES).optional(),
    /** 入口函数名（CodeStrategyArtifact.entryPoint 同义——(sandbox) => Gem[]）。 */
    entryPoint: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, 'entryPoint 必须为 JS 标识符').default('layout'),
    /** 确定性种子（CodeStrategyArtifact.seed 同义——同 code+同 seed 可回放）。 */
    seed: z.number().int().nonnegative().default(0),
    /** 墙钟界 ms（测试/运维界——缺省 run.ts SANDBOX_DEFAULT_WALL_MS=5s；apply 同步桥阻塞上限同此）。 */
    wallMs: z.number().int().positive().max(60_000).optional(),
    /** 工件 blob 引用（P3 接线——内容寻址读 CodeStrategyArtifact）。 */
    codeArtifactRef: BlobRefSchema.optional(),
  })
  .strict()
  .superRefine((p, ctx) => {
    const hasSource = p.source !== undefined;
    const hasRef = p.codeArtifactRef !== undefined;
    if (hasSource === hasRef) {
      ctx.addIssue({
        code: 'custom',
        message: 'free-code 参数必须二选一：inline source（测试通道）或 codeArtifactRef（P3 工件读取）',
      });
    }
  });
export type FreeCodeParams = z.output<typeof FreeCodeParamsSchema>;

/** 沙箱失败 typed error（P3 捕获面——failure 载荷+userMessage 回 LLM 有界重试）。 */
export class SandboxFailureError extends Error {
  constructor(
    readonly failure: SandboxFailure,
    readonly userMessage: string,
  ) {
    super(`free-code 沙箱失败（${failure.stage}）：${userMessage}`);
    this.name = 'SandboxFailureError';
  }
}

export const freeCodeStrategy: KernelStrategy = {
  kind: 'free-code',
  status: 'implemented',
  paramsSchema: FreeCodeParamsSchema,
  apply(input, ctx) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = FreeCodeParamsSchema.parse(input.params ?? {});
    if (p.codeArtifactRef !== undefined) {
      throw new Error(
        `free-code 工件引用通道（codeArtifactRef=${p.codeArtifactRef.slice(0, 12)}…）P3 接线——本波 inline source 测试通道`,
      );
    }
    const r = runSandboxArtifactSync(p.source!, input, ctx, {
      entryPoint: p.entryPoint,
      seed: p.seed,
      ...(p.wallMs !== undefined ? { wallMs: p.wallMs } : {}),
    });
    if (!r.ok) throw new SandboxFailureError(r.error, r.userMessage);
    return { gems: r.gems, warnings: r.warnings };
  },
};
