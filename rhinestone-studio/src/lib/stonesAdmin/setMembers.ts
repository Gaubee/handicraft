/*
 * 组合成员投影纯函数（restructure-materials-story W2a——design §2.2 材料市场
 * 左栏组合分区：点组合行 → 右侧网格呈现成员钻卡）。
 * sets.get 成员=SetMemberResolution（读时解析快照——daemon resolveMember：
 * resolved 附带 stone+textureUrl 富化；其余四态退 stone_index 限定名投影或裸态）。
 * 本文件把解析投影转成网格渲染面：
 *   - memberCellOf：resolved 且 stone 在场 → StoneGridCell（复用 StoneCard 全卡）。
 *   - memberPlaceholder：非 resolved（或 stone 缺席）→ 缺图占位卡数据（如实呈现
 *     五态与限定名/短 ref——不伪造钻卡，§7.1 引用集不变量「不自动剔除」）。
 * 纯函数、零依赖 Svelte——jsdom 直测。
 */

import type { StoneGridCell } from '@handicraft/contracts'
import type { SetMemberResolution } from '$lib/warehouse/schemas.js'

/** StoneFile.color.rgb → '#RRGGBB'（大写——StoneGridCell.colorHex 契约口径）。 */
export function rgbToHex(rgb: readonly [number, number, number] | number[]): string {
  const [r, g, b] = rgb
  const byte = (value: number): string => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0').toUpperCase()
  return `#${byte(r ?? 0)}${byte(g ?? 0)}${byte(b ?? 0)}`
}

/** 成员态中文标签（缺图/缺行如实呈现——不裸露英文态名）。 */
export const SET_MEMBER_STATE_LABEL: Record<SetMemberResolution['state'], string> = {
  resolved: '已解析',
  'soft-deleted': '成员已软删',
  'blob-missing': '贴图缺失',
  'wrong-kind': '引用类型不符',
  'not-found': '成员不存在',
}

/**
 * 成员解析投影 → StoneGridCell（仅 resolved 且 stone 富化在场——daemon 真实
 * 读面恒满足；其余态返回 null 由调用方走占位卡）。贴图 URL 优先服务端回填的
 * resolution.textureUrl（软删/重建后跟随），缺席退同源约定路径。
 */
export function memberCellOf(resolution: SetMemberResolution): StoneGridCell | null {
  if (resolution.state !== 'resolved' || resolution.stone === undefined) return null
  const stone = resolution.stone
  return {
    resourceId: resolution.stoneRef,
    sku: stone.sku,
    supplier: stone.supplier,
    name: stone.name,
    styleName: stone.color.name,
    family: stone.color.family,
    sizeMm: stone.sizeMm,
    colorHex: rgbToHex(stone.color.rgb),
    finish: stone.color.finish,
    textureUrl: resolution.textureUrl ?? `/api/stones/${resolution.stoneRef}/texture.png`,
    trashed: false,
    updatedAt: stone.updatedAt,
  }
}

/** 缺图成员占位卡数据（限定名优先；双缺退短 ref——缺失态本就要人眼处理）。 */
export interface MemberPlaceholder {
  stoneRef: string
  label: string
  state: SetMemberResolution['state']
  /** 解析投影贴图（在场则呈现——占位卡不浪费真数据）。 */
  textureUrl: string | undefined
  /** 已声明数量（缺省=按设计用量另计——§7.1）。 */
  quantity: number | undefined
}

export function memberPlaceholderOf(resolution: SetMemberResolution): MemberPlaceholder {
  const label =
    resolution.qualifiedSku !== undefined && resolution.qualifiedSku !== ''
      ? resolution.qualifiedSku
      : `未解析/${resolution.stoneRef.slice(0, 8)}`
  return {
    stoneRef: resolution.stoneRef,
    label,
    state: resolution.state,
    textureUrl: resolution.textureUrl,
    quantity: resolution.quantity,
  }
}
