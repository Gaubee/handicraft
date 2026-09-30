/*
 * 材料市场组合分区测试夹具（restructure-materials-story W2a）。
 * 内存 WarehouseSetsClient（list/get/create——视图所需子集）：sets.get 成员解析
 * 对齐 daemon resolveMember 真实读面（resolved 附带 stone+textureUrl 富化；非
 * resolved 退限定名/裸态），调用全记录。复用本目录 makeCell/makeStoneFile
 * （cell/全文构造单一来源）。不 ship 到 lib（生产走 RpcWarehouseSetsClient）。
 */

import type { StoneFile, StoneGridCell } from '@handicraft/contracts'
import type { SetsCreateResult, WarehouseSetsClient } from '$lib/warehouse/client'
import type { SetMemberResolution, SetSummary, SetsCreateInput, SetsGetOutput, SetsListInput, SetsListOutput, SetsUpdateInput, SetsUpdateOutput } from '$lib/warehouse/schemas'
import { makeCell, makeStoneFile } from './fixtures'

/** cell → StoneFile（resolved 富化的 stone 载体——sku/色/尺寸随 cell）。 */
function stoneFileFromCell(cell: StoneGridCell): StoneFile {
  return makeStoneFile({
    id: `stn-${cell.resourceId}`,
    name: cell.name,
    supplier: cell.supplier,
    sku: cell.sku,
    sizeMm: cell.sizeMm,
    color: { name: cell.styleName, rgb: [255, 255, 240], family: cell.family, finish: cell.finish },
  })
}

export interface MarketFixtureMember {
  stoneRef: string
  state?: SetMemberResolution['state']
  quantity?: number
  note?: string
  /** resolved 富化数据源（缺省 makeCell({ resourceId: stoneRef })）。 */
  cell?: StoneGridCell
}

export interface MarketFixtureSet {
  resourceId: string
  name: string
  purpose?: string
  members: MarketFixtureMember[]
  trashed?: boolean
  /** [product-polish-w1 T1] 市场组合标记（scope=market 过滤+复制白名单锚）。 */
  market?: boolean
  /**
   * [product-polish-w1 T1] 归属当前测试视角（缺省 true=「我的」——daemon 普通用户
   * no-scope 恒收窄本人的 fixture 投影；market 且 mine 双 true=admin 自有组合进
   * 两组）。
   */
  mine?: boolean
}

export interface MarketSetsFixtureCalls {
  list: SetsListInput[]
  get: string[]
  create: SetsCreateInput[]
  /** [product-polish-w1 T4] update 调用全记录（SetDetailSheet 编辑面保存链——SetPatch diff 断言锚）。 */
  update: SetsUpdateInput[]
  /** [product-polish-w1 T1] copyFromMarket 调用全记录。 */
  copyFromMarket: Array<{ resourceId: string; name?: string }>
}

export interface MarketSetsFixtureOptions {
  sets?: MarketFixtureSet[]
  /** create 强制失败（错误条呈现测试——抛 typed code 形错误）。 */
  failCreateWith?: { message: string; code: string }
  /** list 强制失败（分区错误条测试——钻库网格不受影响的验收面）。 */
  failListWith?: string
}

/** 内存态成员行（快照——quantity/note 存储形态）。 */
interface MemberRow {
  stoneRef: string
  quantity?: number
  note?: string
}

export function makeMarketSetsClient(
  options: MarketSetsFixtureOptions = {},
): { client: WarehouseSetsClient; calls: MarketSetsFixtureCalls } {
  const calls: MarketSetsFixtureCalls = { list: [], get: [], create: [], update: [], copyFromMarket: [] }
  /** 市场组合标记（scope=market 过滤+复制白名单锚——SetSummary 无 owner 字段）。 */
  const marketFlagged = new Set<string>()
  /** 「我的」归属标记（no-scope/scope=owner 过滤锚——普通用户服务端恒收窄本人）。 */
  const mineFlagged = new Set<string>()
  const byResource = new Map<string, { summary: SetSummary; members: MemberRow[]; memberStates: Map<string, SetMemberResolution['state']>; cells: Map<string, StoneGridCell | undefined> }>()
  let revisionSeed = 7
  let copySeq = 0
  for (const preset of options.sets ?? []) {
    byResource.set(preset.resourceId, {
      summary: {
        resourceId: preset.resourceId,
        setId: `setid-${preset.resourceId}`,
        name: preset.name,
        ...(preset.purpose !== undefined ? { purpose: preset.purpose } : {}),
        origin: { kind: 'manual-pick' },
        memberCount: preset.members.length,
        revision: 3,
        path: `/stones/production-sets/${preset.resourceId}`,
        trashed: preset.trashed ?? false,
        updatedAt: '2026-09-28T00:00:00.000Z',
      },
      members: preset.members.map((member) => ({
        stoneRef: member.stoneRef,
        ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
        ...(member.note !== undefined ? { note: member.note } : {}),
      })),
      memberStates: new Map(preset.members.map((member) => [member.stoneRef, member.state ?? 'resolved'])),
      cells: new Map(preset.members.map((member) => [member.stoneRef, member.cell ?? makeCell({ resourceId: member.stoneRef })])),
    })
    if (preset.market === true) marketFlagged.add(preset.resourceId)
    if (preset.mine !== false) mineFlagged.add(preset.resourceId)
  }

  /** 成员解析（对齐 daemon resolveMember：resolved 才附 stone+textureUrl）。 */
  function resolveMembers(state: { members: MemberRow[]; memberStates: Map<string, SetMemberResolution['state']>; cells: Map<string, StoneGridCell | undefined> }): SetMemberResolution[] {
    return state.members.map((member) => {
      const memberState = state.memberStates.get(member.stoneRef) ?? 'resolved'
      const cell = state.cells.get(member.stoneRef)
      const resolved = memberState === 'resolved' && cell !== undefined
      const indexKnown = (memberState === 'soft-deleted' || memberState === 'blob-missing') && cell !== undefined
      return {
        stoneRef: member.stoneRef,
        state: memberState,
        ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
        ...(member.note !== undefined ? { note: member.note } : {}),
        ...(resolved
          ? {
              standardId: cell!.supplier,
              qualifiedSku: `${cell!.supplier}/${cell!.sku}`,
              textureUrl: `/api/stones/${member.stoneRef}/texture.png`,
              stone: stoneFileFromCell(cell!),
              revision: 1,
            }
          : indexKnown
            ? { standardId: cell!.supplier, qualifiedSku: `${cell!.supplier}/${cell!.sku}` }
            : {}),
      }
    })
  }

  const client: WarehouseSetsClient = {
    async list(input: SetsListInput = {}): Promise<SetsListOutput> {
      calls.list.push(input)
      if (options.failListWith !== undefined) throw new Error(options.failListWith)
      let rows = [...byResource.values()].map((state) => state.summary)
      // [product-polish-w1 T1] scope 归属域（daemon 同语义）：owner/缺省=本人（mine
      // 缺省 true——普通用户 no-scope 恒收窄；admin 视角 fixture 由用例自行标注）；
      // market=市场组合（admin 所建）。
      if (input.scope !== 'market') rows = rows.filter((summary) => mineFlagged.has(summary.resourceId))
      if (input.scope === 'market') rows = rows.filter((summary) => marketFlagged.has(summary.resourceId))
      if (input.includeTrashed !== true) rows = rows.filter((summary) => !summary.trashed)
      return { sets: rows, total: rows.length, page: input.page ?? 1, pageSize: input.pageSize ?? 50 }
    },
    async get(resourceId: string): Promise<SetsGetOutput> {
      calls.get.push(resourceId)
      const state = byResource.get(resourceId)
      if (state === undefined) {
        throw Object.assign(new Error(`组合不存在：${resourceId}`), { code: 'not-found' })
      }
      return {
        resourceId,
        setId: state.summary.setId,
        revision: state.summary.revision,
        path: state.summary.path,
        trashed: state.summary.trashed,
        set: {
          kind: 'stone-set',
          formatVersion: 1,
          id: state.summary.setId,
          name: state.summary.name,
          ...(state.summary.purpose !== undefined ? { purpose: state.summary.purpose } : {}),
          stones: state.members.map((member) => ({
            stoneRef: member.stoneRef,
            ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
            ...(member.note !== undefined ? { note: member.note } : {}),
          })),
          origin: state.summary.origin,
          metadata: {},
          createdAt: '2026-09-28T00:00:00.000Z',
          updatedAt: state.summary.updatedAt,
        },
        members: resolveMembers(state),
      }
    },
    async create(input: SetsCreateInput): Promise<SetsCreateResult> {
      calls.create.push(input)
      if (options.failCreateWith !== undefined) {
        throw Object.assign(new Error(options.failCreateWith.message), { code: options.failCreateWith.code })
      }
      const resourceId = `set-created-${calls.create.length}`
      revisionSeed += 1
      mineFlagged.add(resourceId) // 创建者归属（no-scope 恒收窄本人）
      const members = input.members ?? []
      byResource.set(resourceId, {
        summary: {
          resourceId,
          setId: `setid-${resourceId}`,
          name: input.name,
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          origin: input.origin,
          memberCount: members.length,
          revision: revisionSeed,
          path: `/stones/production-sets/${resourceId}`,
          trashed: false,
          updatedAt: '2026-09-28T00:00:00.000Z',
        },
        members: members.map((member) => ({
          stoneRef: member.stoneRef,
          ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
          ...(member.note !== undefined ? { note: member.note } : {}),
        })),
        memberStates: new Map(members.map((member) => [member.stoneRef, 'resolved' as const])),
        cells: new Map(members.map((member) => [member.stoneRef, makeCell({ resourceId: member.stoneRef })])),
      })
      return { resourceId, setId: `setid-${resourceId}`, revision: revisionSeed, path: `/stones/production-sets/${resourceId}`, memberCount: members.length, setJsonBlobRef: 'c'.repeat(64) }
    },
    /** [product-polish-w1 T4] update 真形（成员 ops+CAS——SetDetailSheet 编辑面保存链）。 */
    async update(input: SetsUpdateInput): Promise<SetsUpdateOutput> {
      calls.update.push(structuredClone(input))
      const state = byResource.get(input.resourceId)
      if (state === undefined) throw Object.assign(new Error(`组合不存在：${input.resourceId}`), { code: 'not-found' })
      if (input.baseRevision !== state.summary.revision) {
        throw Object.assign(new Error(`revision 漂移：base=${input.baseRevision} 当前=${state.summary.revision}（CAS 必拒）`), {
          code: 'revision-conflict',
        })
      }
      const patch = input.patch
      let members = [...state.members]
      if (patch.removeMembers !== undefined) {
        members = members.filter((member) => !patch.removeMembers!.includes(member.stoneRef))
      }
      if (patch.addMembers !== undefined) {
        for (const add of patch.addMembers) {
          if (members.some((member) => member.stoneRef === add.stoneRef)) {
            throw Object.assign(new Error(`成员 stoneRef 重复：${add.stoneRef}`), { code: 'duplicate-member' })
          }
          members.push({ ...add })
        }
      }
      if (patch.updateMembers !== undefined) {
        for (const upd of patch.updateMembers) {
          const member = members.find((candidate) => candidate.stoneRef === upd.stoneRef)
          if (member === undefined) {
            throw Object.assign(new Error(`updateMembers 指向非成员：${upd.stoneRef}`), { code: 'not-found' })
          }
          if (upd.quantity !== undefined) {
            if (upd.quantity === null) delete member.quantity
            else member.quantity = upd.quantity
          }
        }
      }
      if (members.length === 0) throw Object.assign(new Error('成员清单不可清空'), { code: 'empty-members' })
      state.members = members
      state.summary.memberCount = members.length
      state.summary.revision += 1
      return { resourceId: input.resourceId, revision: state.summary.revision, path: state.summary.path, memberCount: members.length }
    },
    async delete(): Promise<never> {
      throw new Error('market fixture: delete 未接线（W2a 视图无 delete 面）')
    },
    /** [product-polish-w1 T1] 市场组合→我的材料：副本 origin={clone, fromSetId} 溯源+成员快照。 */
    async copyFromMarket(input: { resourceId: string; name?: string }): Promise<{ resourceId: string; setId: string; revision: number; path: string; memberCount: number; setJsonBlobRef: string }> {
      calls.copyFromMarket.push(input)
      const source = byResource.get(input.resourceId)
      if (source === undefined) throw Object.assign(new Error(`组合不存在：${input.resourceId}`), { code: 'not-found' })
      if (!marketFlagged.has(input.resourceId)) {
        throw Object.assign(new Error('源组合不属于管理员（市场组合复制白名单外——跨用户 clone 必拒）'), {
          code: 'owner-mismatch',
        })
      }
      copySeq += 1
      revisionSeed += 1
      const resourceId = `set-copy-${copySeq}`
      mineFlagged.add(resourceId) // 副本归属复制者（进「我的组合」组）
      byResource.set(resourceId, {
        summary: {
          resourceId,
          setId: `setid-copy-${copySeq}`,
          name: input.name ?? source.summary.name,
          ...(source.summary.purpose !== undefined ? { purpose: source.summary.purpose } : {}),
          origin: { kind: 'clone', fromSetId: input.resourceId },
          memberCount: source.members.length,
          revision: revisionSeed,
          path: `/stones/production-sets/${resourceId}`,
          trashed: false,
          updatedAt: '2026-09-28T00:00:00.000Z',
        },
        members: source.members.map((member) => ({ ...member })),
        memberStates: new Map(source.memberStates),
        cells: new Map(source.cells),
      })
      return {
        resourceId,
        setId: `setid-copy-${copySeq}`,
        revision: revisionSeed,
        path: `/stones/production-sets/${resourceId}`,
        memberCount: source.members.length,
        setJsonBlobRef: 'b'.repeat(64),
      }
    },
  }
  return { client, calls }
}
