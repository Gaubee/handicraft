/**
 * 项目文件契约层（openspec add-project-files design §2/§9.1，[0.5 契约唯一化定义]）。
 *
 * 本文件是 AssetProject / PROJECT_MIME / lease / CAS 的**唯一定义点**：
 * 实现切片（1.1 assetStore / labFile.ts / studio / edit）只消费此处类型与签名，
 * 不得在别处重定义（tasks 1.1 明文约束）。零运行时依赖（错误类为契约性异常形态），
 * 禁止 import Svelte / assetStore / 任何 store。
 */

import type { SSKey, StrategyId } from '$lib/engine/types'
import type { CaseRefLayout } from '$lib/lab/caseComposite'

/**
 * 格式族（五值，design §2 唯一真源 + gem-catalog W0 0.4 第五值）。
 * 'gemshape'：钻形资产（内容不可变——不参与 blobKey 换绑，任何内容变更另存新资产；
 * parser gate 六条见 persistence/gemshapeFile.ts）。
 */
export type ProjectKind = 'gemproj' | 'gemdoc' | 'gemtpl' | 'gemgen' | 'gemshape'

/** vendor MIME 五值（kind/MIME/文件内 kind 三者导入时交叉校验；扩展名不覆盖文件内 kind）。 */
export const PROJECT_MIME = {
  gemproj: 'application/vnd.rhinestone-studio.gemproj+json',
  gemdoc: 'application/vnd.rhinestone-studio.gemdoc+json',
  gemtpl: 'application/vnd.rhinestone-studio.gemtpl+json',
  gemgen: 'application/vnd.rhinestone-studio.gemgen+json',
  gemshape: 'application/vnd.rhinestone-studio.gemshape+json',
} as const

/** MIME → projectKind 反查（导入校验用）。 */
export function projectKindOfMime(mime: string): ProjectKind | null {
  for (const [kind, m] of Object.entries(PROJECT_MIME)) {
    if (m === mime) return kind as ProjectKind
  }
  return null
}

// ---------------------------------------------------------------------------
// AssetProject 节点（design §2；AssetNode union 的第三分化——1.1 实现接线）
// ---------------------------------------------------------------------------

/** 卡片展示性摘要缓存（非真源；每次保存/归档重写；实际打开必 parse blob）。 */
export interface ProjectSummary {
  gemCount?: number
  strategy?: StrategyId
  ss?: SSKey
  sourceName?: string
  updatedHint?: string
  /** gemgen 专属溯源摘要 */
  templateName?: string
  candidateIndex?: number
  size?: string
  mode?: 'generate' | 'edit'
}

/** gemgen 缩略物理记录元组（256px PNG；物理字节存 images store，key=thumbKey）。 */
export interface ProjectThumbMeta {
  key: string
  mime: 'image/png'
  width: number
  height: number
  bytes: number
}

/**
 * AssetProject 节点形状（1.1 并入 AssetNode union；不改 DB schema——
 * assetNodes store 对节点形状无约束）。
 * 可变性豁免：仅 gemproj/gemdoc/gemtpl 的 blobKey 随保存换绑（PRODUCT_MODEL v3）；
 * gemgen 不可变（生成即定稿，无换绑路径）。
 */
export interface AssetProject {
  id: string
  type: 'project'
  projectKind: ProjectKind
  refKind: 'blob'
  blobKey: string
  /** gemgen 缩略物理记录键 + 元组；其余 kind 无缩略。 */
  thumbKey?: string
  thumb?: ProjectThumbMeta
  name: string
  parentId: string | null
  createdAt: number
  updatedAt: number
  /** summary 重写时间戳（缓存过期诊断）。 */
  summaryUpdatedAt: number
  mime: string
  summary: ProjectSummary
  trashedAt?: number
}

// ---------------------------------------------------------------------------
// 项目生命周期 lease（design §9.1 B5，R3 补 ownerId 规则）
// ---------------------------------------------------------------------------

/**
 * openProject 返回的租约：
 * - ownerId 由宿主调用方提供且在宿主生命周期内稳定（如 'studio-page'/'edit-page'）；
 * - 每次 open 生成唯一 lease/token，同一 owner 重复 open = 多个独立引用各自计数；
 * - closeProject(lease) 幂等：重复 close 与已过期 token close = no-op 返回 'stale'，
 *   不抛错；仅同一 token 的最后一个有效 owner 关闭才解除 pin。
 */
export interface ProjectLease {
  projectId: string
  ownerId: string
  token: string
  /** 本次租约 pin 的资产集合（gemproj: source+reference；gemdoc: 仅 reference）。 */
  pinnedAssetIds: readonly string[]
  closed: boolean
}

export type CloseProjectResult = 'released' | 'stale'

export interface UpdateProjectAssetOptions {
  /** 乐观锁：调用方读到的当前 blobKey；不符 = 冲突（typed error，不写任何一项）。 */
  expectedBlobKey: string
  bytes: Blob
  summary: ProjectSummary
  /** gemgen 缩略（换绑时随旧 thumb 引用计数清理）。 */
  thumb?: { bytes: Blob; meta: Omit<ProjectThumbMeta, 'key' | 'bytes'> }
}

// ---------------------------------------------------------------------------
// 契约性异常形态（实现层继承/实例化；签名语义见各方法 JSDoc）
// ---------------------------------------------------------------------------

/** CAS 冲突：expectedBlobKey 与当前不符；不写入任何内容，孤儿 blob 由后续 GC 回收。 */
export class ProjectConflictError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly expectedBlobKey: string,
    public readonly actualBlobKey: string,
  ) {
    super('项目已被其他入口修改，请刷新后重试。')
    this.name = 'ProjectConflictError'
  }
}

// ---------------------------------------------------------------------------
// 生命周期 API 签名（1.1 在 assetStore 实现；此处冻结签名与语义）
// ---------------------------------------------------------------------------

/**
 * 打开项目：按 kind 差分 pin 引用集合（gemproj pin source+reference；gemdoc 仅
 * reference；gemtpl/gemgen 不 pin）。pin 为引用计数，多个宿主/项目共享同一资产时
 * 仅最后一个有效 owner 关闭才解除。
 */
export type OpenProject = (
  id: string,
  projectKind: ProjectKind,
  ownerId: string,
  pinnedAssetIds: readonly string[],
) => Promise<ProjectLease>

/** 关闭项目（幂等）：重复/过期 = 'stale' no-op；最后有效 owner 关闭 = 'released' 并解除 pin。 */
export type CloseProject = (lease: ProjectLease) => Promise<CloseProjectResult>

/**
 * CAS 换绑保存（gemproj/gemdoc/gemtpl；gemgen 无此路径）。单确认事务，顺序冻结：
 * 读节点及 expected key → 写新 blob/summary → 更新 node → 扫描旧 blob（含 thumb）
 * 引用 → 删除无引用物理记录。冲突 = typed error 且不写任何一项。
 */
export type UpdateProjectAsset = (
  projectId: string,
  options: UpdateProjectAssetOptions,
) => Promise<AssetProject>
