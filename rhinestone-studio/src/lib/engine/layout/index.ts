/*
Orthogonal intents (max 3):
1. [2026-09-18 Pipeline] layout 统一管线：策略生成（ts-pattern 穷尽分派）→ boundary 钩子 → repulsion 钩子（或确定性冲突消解）→ 重编号 → 全量 validate。
2. [2026-09-18 Contract] design.md §2 签名的落地出口（blocks × strategy × opts × grid → LayoutResult，纯函数）。
*/

import { match } from "ts-pattern";
import {
  GridSpecSchema,
  LayoutOptionsSchema,
  StrategyIdSchema,
  type Block,
  type Gem,
  type GridSpec,
  type LayoutOptions,
  type LayoutResult,
  type StrategyId,
} from "../types";
import { validate } from "../validate";
import { buildLayoutCtx, enforceMinDistanceCounted, typeRankCompare, type StrategyOutput } from "./common";
import { cvt } from "./cvt";
import { hexPitch } from "./hex-pitch";
import { hexThin } from "./hex-thin";
import { hybrid } from "./hybrid";
import { poisson } from "./poisson";
import { applyBoundary, applyRepulsion } from "./relax";

/**
 * 排布主入口（纯函数，同输入同输出）。
 * 不变量 1（任意两钻 ≥ pitch×0.999）在任何输出上恒真：
 * 构造策略自带间距保证；松弛钩子（boundary/repulsion）之后的残余冲突由终局确定性消解兜底
 * （repulsion 先修复大部分并保钻数，消解只丢真正卡死的少量钻）。validate 的 spacing/mask
 * warning 只对外部篡改过的钻集（用户手工改动）可达，此时 isExportable=false 阻断导出。
 * dropped 汇总策略内部 + 终局全部确定性消解丢弃（N4 可视化）。
 */
export function layout(
  blocks: Block[],
  strategy: StrategyId,
  opts: LayoutOptions,
  grid: GridSpec,
): LayoutResult {
  const sid: StrategyId = StrategyIdSchema.parse(strategy);
  const o = LayoutOptionsSchema.parse(opts ?? {});
  const g = GridSpecSchema.parse(grid);
  if (blocks.length === 0) return { gems: [], warnings: [], dropped: 0 };

  const ctx = buildLayoutCtx(blocks, o, g);
  const produced: StrategyOutput = match(sid)
    .with("hex-thin", () => hexThin(ctx))
    .with("hex-pitch", () => hexPitch(ctx))
    .with("poisson", () => poisson(ctx))
    .with("hybrid", () => hybrid(ctx))
    .with("cvt", () => cvt(ctx))
    .exhaustive();
  let gems: Gem[] = produced.gems;
  let dropped = produced.dropped;

  if (o.relax.boundary) {
    gems = applyBoundary(gems, ctx);
  }
  if (o.relax.repulsion) {
    gems = applyRepulsion(gems, ctx).gems;
  }
  // 终局确定性消解（不变量 1 violation 即 bug）：冻结晶格策略默认零丢弃；
  // poisson/hybrid 的跨块/交汇真实冲突与 boundary/repulsion 移动后的残余在此兜底
  // （计入 dropped 呈现，而非留给 warning）
  const final = enforceMinDistanceCounted(gems, ctx.grid, typeRankCompare(ctx));
  dropped += final.dropped;

  const renumbered = final.gems.map((gem, i) => ({ ...gem, id: `g${String(i + 1).padStart(5, "0")}` }));
  return { gems: renumbered, warnings: validate(renumbered, g, blocks), dropped };
}
