/**
 * 排除族（add-subject-sam-pipeline design §4.3——P1.3 贯穿）。
 * 语义：`drillWorthy=false` 节点跳过产钻（零 Gem）+ BOM 明示「未贴区域」。
 *
 * 前置（P0.2 语义）：drillWorthy=false 的叶子**仍产 Block**（几何基座必须存在——
 * tree-to-blocks 裁定 [1]），排除策略吃它——即本策略的输入 block 恒存在，排除是
 * 策略层关注而非建树层。
 *
 * Owner 补充定调（2026-09-24 晚）：「先别做排除，不是说脸蛋就一定要不贴……不是
 * 绝对的」——排除不落硬规则：kind=exclusion 是 LLM/用户**显式指派**才生效的策略，
 * reason 一等参数（BOM 注记人读溯源：破坏质感/灯光不贴/顾客要求…）。
 */
import { z } from 'zod';
import type { KernelStrategy } from './registry.js';

export const ExclusionParamsSchema = z
  .object({
    /** BOM 未贴区注记原因（LLM/用户给出——「脸蛋破坏质感」「灯光不贴」…；缺省=开关语义） */
    reason: z.string().min(1).default('drillWorthy=false（S5 建树判定——不值得贴）'),
  })
  .strict();
export type ExclusionParams = z.output<typeof ExclusionParamsSchema>;

export const exclusionStrategy: KernelStrategy = {
  kind: 'exclusion',
  status: 'implemented',
  paramsSchema: ExclusionParamsSchema,
  apply(input) {
    if (input.node.id !== input.block.id) {
      throw new Error(`node/block id 不一致（${input.node.id} ≠ ${input.block.id}——P0.2 同寻址空间契约破裂）`);
    }
    const p = ExclusionParamsSchema.parse(input.params ?? {});
    // BOM 未贴区注记结构（excludedRegions 输出位——registry.ts StrategyResult 契约）：
    // 面积按 block.areaPx（P0.2 距离变换同口径统计）换算 cm²
    const areaCm2 = input.block.areaPx / (input.canvas.pixelsPerMm ** 2 * 100);
    return {
      gems: [],
      warnings: [
        {
          kind: 'excluded' as const,
          detail: `未贴区明示：${input.block.label} 不产钻（${p.reason}）——BOM 未贴区注记`,
        },
      ],
      excludedRegions: [
        {
          nodeId: input.node.id,
          label: input.block.label,
          reason: p.reason,
          areaCm2: Math.round(areaCm2 * 1e6) / 1e6,
        },
      ],
    };
  },
};
