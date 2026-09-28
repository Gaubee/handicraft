/**
 * 导出面叶子口径（rework-layer-ps-panel v5 修复轮 R1——Codex P1 闭合）：
 * task.detail 的 gems 摘要与 task.export 的导出字节共同消费的**单一**过滤纯函数。
 *
 * 背景：v4 产块判定允许 drillWorthy 中间节点产钻——存量 strategy-gems 工件可能携带
 * 父层（组）旧钻（真机实证 858 颗含父层 159 颗）。v5 语义下画布/徽标/顶栏均按当前树
 * 叶子集合过滤（「界面 699」），而导出若原样回放工件字节即出现「界面 699、下载 858」
 * 的跨面不一致——本模块把「叶子集合=children.length===0（nodeProducesBlock 单源）」
 * 的过滤收敛到一处，读面（detail 计数）与导出面（export 字节）同口径。
 */
import { nodeProducesBlock, type ObjectTree } from '@handicraft/contracts';
import type { StrategyGemsDoc } from './strategies/design.js';

/**
 * 有效钻集合（纯函数）：gems 中 blockId 命中当前树叶子集合的子序列（保序）。
 * 父层（组）旧钻不进任何导出/读数面——与前端 getWorkbenchLayerRender/
 * getEffectiveGemTotal 的客户端过滤、kernel execute 的跳过降级三面同语义。
 * 参数取结构子集（nodes 即可——task.detail 的 tree 面可直接透传）。
 */
export function effectiveGems(
  tree: Readonly<Pick<ObjectTree, 'nodes'>>,
  gems: StrategyGemsDoc['gems'],
): StrategyGemsDoc['gems'] {
  const leafIds = new Set(tree.nodes.filter(nodeProducesBlock).map((node) => node.id));
  return gems.filter((gem) => leafIds.has(gem.blockId));
}
