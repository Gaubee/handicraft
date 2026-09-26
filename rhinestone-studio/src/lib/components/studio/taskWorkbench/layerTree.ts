/*
 * layerTree.ts——图层树结构操作纯函数（add-workbench-pro 2c 图层管理 P0）。
 *
 * Orthogonal intents (max 3):
 * 1. [重排意图→载荷] 拖拽（before/after/inside 三落区）与键盘（Alt+↑↓ 同父序移）
 *    的统一载荷构造：{newParentId, index}——index 语义=契约冻结的「newParent.children
 *    **移出 nodeId 后**的目标下标（0 基；越界由服务端夹取，客户端构造精确值）。
 * 2. [结构守卫] subtreeIdsOf/isDescendantOf（环路预判——newParent ∈ 目标子树）+
 *    根保护（parent===null）判定（root 不可删不可移；服务端同拒兜底——UI 预判先行）。
 * 3. [Pure] 纯 TS——jsdom 直测；组件拖拽/键盘与 store 写路径共用（禁第二实现）。
 */

import type { ObjectNode } from '@handicraft/contracts'

/** 拖拽落区：目标行前/后（同级序位）与内部（成为目标子层——尾部追加）。 */
export type DropZone = 'before' | 'after' | 'inside'

export interface ReorderPayload {
  newParentId: string
  index: number
}

function nodeOf(nodes: ObjectNode[], id: string): ObjectNode | null {
  return nodes.find((node) => node.id === id) ?? null
}

/** 节点子树全集（含自身，DFS 先序——删除确认计数/锁定预判共用）。 */
export function subtreeIdsOf(nodes: ObjectNode[], rootId: string): string[] {
  const byId = new Map(nodes.map((node) => [node.id, node] as const))
  const out: string[] = []
  const walk = (id: string): void => {
    const node = byId.get(id)
    if (node === undefined) return
    out.push(id)
    for (const child of node.children) walk(child)
  }
  walk(rootId)
  return out
}

/** candidate 是否在 ancestor 的子树内（含相等——环路判定 candidate===ancestor 亦真）。 */
export function isInSubtreeOf(nodes: ObjectNode[], candidateId: string, ancestorId: string): boolean {
  return subtreeIdsOf(nodes, ancestorId).includes(candidateId)
}

/** 根/画布节点判定（parent===null——单根树结构锚：不可删不可移）。 */
export function isRootNode(nodes: ObjectNode[], nodeId: string): boolean {
  return nodeOf(nodes, nodeId)?.parent === null
}

/**
 * 拖拽意图 → 重排载荷（纯）。不可落（目标=自身/自身子树、根的 before/after、
 * 目标不在树）返回 null——调用方就近提示，不发 RPC。
 */
export function buildReorderPayload(
  nodes: ObjectNode[],
  intent: { nodeId: string; targetId: string; zone: DropZone },
): ReorderPayload | null {
  const node = nodeOf(nodes, intent.nodeId)
  const target = nodeOf(nodes, intent.targetId)
  if (node === null || target === null) return null
  if (node.parent === null) return null // 根不可移（root-protected——UI 预判）
  if (isInSubtreeOf(nodes, intent.targetId, intent.nodeId)) return null // 环路预判（含自身）
  if (intent.zone === 'inside') {
    // 成为目标子层：目标 children 尾部追加（排除自引用防御——环路已拒）
    const siblings = target.children.filter((id) => id !== intent.nodeId)
    return { newParentId: target.id, index: siblings.length }
  }
  if (target.parent === null) return null // 根无同级序位（before/after 落根=非法）
  const parent = nodeOf(nodes, target.parent)
  if (parent === null) return null
  const base = parent.children.filter((id) => id !== intent.nodeId)
  const targetIndex = base.indexOf(target.id)
  if (targetIndex < 0) return null
  return { newParentId: parent.id, index: intent.zone === 'before' ? targetIndex : targetIndex + 1 }
}

/**
 * 同父序移载荷（Alt+↑↓ 键盘等价——a11y）：i±1 越界返回 null（已在顶/底）。
 * index 语义同契约（移出后下标）：children=[a,b,c] 移 b 上=0、下=2。
 */
export function siblingMovePayload(
  nodes: ObjectNode[],
  nodeId: string,
  direction: -1 | 1,
): ReorderPayload | null {
  const node = nodeOf(nodes, nodeId)
  if (node === null || node.parent === null) return null
  const parent = nodeOf(nodes, node.parent)
  if (parent === null) return null
  const i = parent.children.indexOf(nodeId)
  if (i < 0) return null
  const j = i + direction
  if (j < 0 || j >= parent.children.length) return null
  return { newParentId: parent.id, index: j }
}
