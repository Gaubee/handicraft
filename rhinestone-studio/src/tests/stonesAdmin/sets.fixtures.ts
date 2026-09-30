/*
 * 材料市场组合分区测试夹具（restructure-materials-story W2a）。
 * 内存 WarehouseSetsClient（list/get/create——视图所需子集）：sets.get 成员解析
 * 对齐 daemon resolveMember 真实读面（resolved 附带 stone+textureUrl 富化；非
 * resolved 退限定名/裸态），调用全记录。复用本目录 makeCell/makeStoneFile
 * （cell/全文构造单一来源）。不 ship 到 lib（生产走 RpcWarehouseSetsClient）。
 */

import type { StoneFile, StoneGridCell } from '@handicraft/contracts'
import type { SetsCreateResult, WarehouseSetsClient } from '$lib/warehouse/client'
import type { SetMemberResolution, SetSummary, SetsCreateInput, SetsGetOutput, SetsListInput, SetsListOutput } from '$lib/warehouse/schemas'
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
}

export interface MarketSetsFixtureCalls {
  list: SetsListInput[]
  get: string[]
  create: SetsCreateInput[]
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
  const calls: MarketSetsFixtureCalls = { list: [], get: [], create: [] }
  const byResource = new Map<string, { summary: SetSummary; members: MemberRow[]; memberStates: Map<string, SetMemberResolution['state']>; cells: Map<string, StoneGridCell | undefined> }>()
  let revisionSeed = 7
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
    async update(): Promise<never> {
      throw new Error('market fixture: update 未接线（W2a 视图无 update 面）')
    },
    async delete(): Promise<never> {
      throw new Error('market fixture: delete 未接线（W2a 视图无 delete 面）')
    },
  }
  return { client, calls }
}
