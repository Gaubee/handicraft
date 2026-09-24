/*
 * 仓储管理工作台测试夹具（add-stone-library S7.4）。
 * 双标准夹具（yuhang + factoryB——**同编号 J51**，限定名区分的验收面）+
 * 内存 sets 面（真 CAS：baseRevision 漂移拒+typed code；调用全记录——保存链
 * 调用形态断言用）。stones 面实现 WarehouseClient 的 tree/list 子集（翻页真切）。
 * 复用 stonesAdmin fixtures 的 makeCell（cell 构造单一来源）。
 */

import type { StoneGridCell } from '@handicraft/contracts'
import { makeCell } from '../stonesAdmin/fixtures'
import type { StonesListInput, StonesListOutput, StonesTreeOutput } from '$lib/stonesAdmin/schemas'
import type {
  SetsCreateInput,
  SetsDeleteOutput,
  SetsGetOutput,
  SetsListInput,
  SetsListOutput,
  SetsUpdateInput,
  SetsUpdateOutput,
  SetSummary,
} from '$lib/warehouse/schemas'
import type { WarehouseClient } from '$lib/warehouse/store.svelte'

/** yuhang J51/A51/J52 + factoryB J51/B52（跨标准同编号——§7.6 冲突场景）。 */
export function makeWarehouseCells(): StoneGridCell[] {
  return [
    makeCell({ resourceId: 'res-yh-j51', sku: 'J51', supplier: 'yuhang', textureUrl: '/api/stones/res-yh-j51/texture.png' }),
    makeCell({ resourceId: 'res-yh-a51', sku: 'A51', supplier: 'yuhang', sizeMm: 3, name: '象牙白 · 3mm', textureUrl: '/api/stones/res-yh-a51/texture.png' }),
    makeCell({ resourceId: 'res-yh-j52', sku: 'J52', supplier: 'yuhang', styleName: '米白', name: '米白 · 2mm', textureUrl: '/api/stones/res-yh-j52/texture.png' }),
    makeCell({ resourceId: 'res-fb-j51', sku: 'J51', supplier: 'factoryB', name: '亮白 · 2mm', styleName: '亮白', textureUrl: '/api/stones/res-fb-j51/texture.png' }),
    makeCell({ resourceId: 'res-fb-b52', sku: 'B52', supplier: 'factoryB', family: '金色系', styleName: '香槟金', name: '香槟金 · 2mm', colorHex: '#D4AF37', textureUrl: '/api/stones/res-fb-b52/texture.png' }),
  ]
}

export interface SetsFixtureCalls {
  list: SetsListInput[]
  get: string[]
  create: SetsCreateInput[]
  update: SetsUpdateInput[]
  delete: string[]
}

interface FixtureSetState {
  summary: SetSummary
  members: Array<{ stoneRef: string; quantity?: number; note?: string }>
}

export interface WarehouseFixtureOptions {
  cells?: StoneGridCell[]
  /** 预置组合（[label, members]——resourceId=set-<label>）。 */
  sets?: Array<{ label: string; name: string; members: Array<{ stoneRef: string; quantity?: number; note?: string }> }>
  /** 成员解析态覆盖（stoneRef → state——缺失态呈现用；缺省 resolved）。 */
  memberStates?: Record<string, 'resolved' | 'soft-deleted' | 'blob-missing' | 'wrong-kind' | 'not-found'>
}

export function makeWarehouseClient(options: WarehouseFixtureOptions = {}): { client: WarehouseClient; calls: SetsFixtureCalls; sets: Map<string, FixtureSetState> } {
  const cells = options.cells ?? makeWarehouseCells()
  const byResource = new Map(cells.map((cell) => [cell.resourceId, cell]))
  const calls: SetsFixtureCalls = { list: [], get: [], create: [], update: [], delete: [] }
  const sets = new Map<string, FixtureSetState>()

  function treeOutput(): StonesTreeOutput {
    const suppliers = [...new Set(cells.map((cell) => cell.supplier))]
    return {
      rootId: 'dir-standards',
      readScope: 'shared-library',
      node: {
        kind: 'dir',
        id: 'dir-standards',
        name: 'standards',
        role: 'standards-root',
        childCount: suppliers.length,
        children: suppliers.map((supplier) => ({
          kind: 'dir' as const,
          id: `dir-${supplier}`,
          name: supplier,
          role: 'supplier' as const,
          childCount: cells.filter((cell) => cell.supplier === supplier).length,
          children: [],
        })),
      },
    }
  }

  const stones = {
    async tree(input: { rootId?: string; includeTrashed?: boolean } = {}): Promise<StonesTreeOutput> {
      return treeOutput()
    },
    async list(input: StonesListInput): Promise<StonesListOutput> {
      let rows = cells
      if (input.supplier !== undefined) rows = rows.filter((cell) => cell.supplier === input.supplier)
      if (input.family !== undefined) rows = rows.filter((cell) => cell.family === input.family)
      if (input.q !== undefined) {
        const needle = input.q.toLowerCase()
        rows = rows.filter((cell) => `${cell.sku} ${cell.supplier} ${cell.family} ${cell.styleName} ${cell.name}`.toLowerCase().includes(needle))
      }
      const total = rows.length
      const page = rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize)
      return { cells: page, total, page: input.page, pageSize: input.pageSize, readScope: 'shared-library' }
    },
  }

  let revisionSeed = 3
  for (const preset of options.sets ?? []) {
    const resourceId = `set-${preset.label}`
    sets.set(resourceId, {
      summary: {
        resourceId,
        setId: `setid-${preset.label}`,
        name: preset.name,
        origin: { kind: 'manual-pick' },
        memberCount: preset.members.length,
        revision: 3,
        path: `/stones/production-sets/${resourceId}`,
        trashed: false,
        updatedAt: '2026-09-24T00:00:00.000Z',
      },
      members: preset.members.map((m) => ({ ...m })),
    })
  }

  class FixtureSetsError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message)
    }
  }

  function resolveMembers(members: Array<{ stoneRef: string; quantity?: number; note?: string }>): SetsGetOutput['members'] {
    return members.map((member) => {
      const state = options.memberStates?.[member.stoneRef] ?? 'resolved'
      const cell = byResource.get(member.stoneRef)
      const resolved = state === 'resolved' && cell !== undefined
      const indexKnown = state === 'resolved' || state === 'soft-deleted' || state === 'blob-missing'
      return {
        stoneRef: member.stoneRef,
        state,
        ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
        ...(member.note !== undefined ? { note: member.note } : {}),
        ...(resolved
          ? {
              standardId: cell!.supplier,
              qualifiedSku: `${cell!.supplier}/${cell!.sku}`,
              textureUrl: cell!.textureUrl,
            }
          : indexKnown && cell !== undefined
            ? { standardId: cell.supplier, qualifiedSku: `${cell.supplier}/${cell.sku}` }
            : {}),
      }
    })
  }

  const setsFace = {
    async list(input: SetsListInput = {}): Promise<SetsListOutput> {
      calls.list.push(input)
      let rows = [...sets.values()].map((s) => s.summary)
      if (input.includeTrashed !== true) rows = rows.filter((s) => !s.trashed)
      return { sets: rows, total: rows.length, page: input.page ?? 1, pageSize: input.pageSize ?? 50 }
    },
    async get(resourceId: string): Promise<SetsGetOutput> {
      calls.get.push(resourceId)
      const state = sets.get(resourceId)
      if (state === undefined) throw new FixtureSetsError(`组合不存在：${resourceId}`, 'not-found')
      const now = new Date().toISOString()
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
          stones: state.members.map((m) => ({
            stoneRef: m.stoneRef,
            ...(m.quantity !== undefined ? { quantity: m.quantity } : {}),
            ...(m.note !== undefined ? { note: m.note } : {}),
          })),
          origin: state.summary.origin,
          metadata: {},
          createdAt: now,
          updatedAt: now,
        },
        members: resolveMembers(state.members),
      }
    },
    async create(input: SetsCreateInput): Promise<{ resourceId: string; setId: string; revision: number; path: string; memberCount: number; setJsonBlobRef: string }> {
      calls.create.push(input)
      if (input.origin.kind !== 'manual-pick') throw new FixtureSetsError('bom-derived 接口位冻结', 'invalid-origin')
      if (input.members === undefined || input.members.length === 0) throw new FixtureSetsError('空成员拒', 'empty-members')
      const resourceId = `set-created-${calls.create.length}`
      revisionSeed += 1
      sets.set(resourceId, {
        summary: {
          resourceId,
          setId: `setid-created-${calls.create.length}`,
          name: input.name,
          ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
          origin: input.origin,
          memberCount: input.members.length,
          revision: revisionSeed,
          path: `/stones/production-sets/${resourceId}`,
          trashed: false,
          updatedAt: '2026-09-24T00:00:00.000Z',
        },
        members: input.members.map((m) => ({ ...m })),
      })
      return { resourceId, setId: `setid-created-${calls.create.length}`, revision: revisionSeed, path: `/stones/production-sets/${resourceId}`, memberCount: input.members.length, setJsonBlobRef: 'a'.repeat(64) }
    },
    async update(input: SetsUpdateInput): Promise<SetsUpdateOutput> {
      calls.update.push(input)
      const state = sets.get(input.resourceId)
      if (state === undefined) throw new FixtureSetsError(`组合不存在：${input.resourceId}`, 'not-found')
      if (input.baseRevision !== state.summary.revision) {
        throw new FixtureSetsError(`revision 漂移：base=${input.baseRevision} current=${state.summary.revision}`, 'revision-conflict')
      }
      const patch = input.patch
      if (patch.name !== undefined) state.summary.name = patch.name
      if (patch.purpose !== undefined) {
        if (patch.purpose === null) delete state.summary.purpose
        else state.summary.purpose = patch.purpose
      }
      let members = [...state.members]
      if (patch.addMembers !== undefined) {
        for (const add of patch.addMembers) {
          if (members.some((m) => m.stoneRef === add.stoneRef)) throw new FixtureSetsError(`重复成员拒：${add.stoneRef}`, 'duplicate-member')
          members.push({ ...add })
        }
      }
      if (patch.removeMembers !== undefined) {
        members = members.filter((m) => !patch.removeMembers!.includes(m.stoneRef))
      }
      if (patch.updateMembers !== undefined) {
        for (const upd of patch.updateMembers) {
          const member = members.find((m) => m.stoneRef === upd.stoneRef)
          if (member === undefined) throw new FixtureSetsError(`指向非成员拒：${upd.stoneRef}`, 'not-found')
          if (upd.quantity !== undefined) {
            if (upd.quantity === null) delete member.quantity
            else member.quantity = upd.quantity
          }
          if (upd.note !== undefined) {
            if (upd.note === null) delete member.note
            else member.note = upd.note
          }
        }
      }
      if (members.length === 0) throw new FixtureSetsError('清空必拒', 'empty-members')
      state.members = members
      state.summary.memberCount = members.length
      state.summary.revision += 1
      return { resourceId: input.resourceId, revision: state.summary.revision, path: state.summary.path, memberCount: members.length }
    },
    async delete(resourceId: string): Promise<SetsDeleteOutput> {
      calls.delete.push(resourceId)
      const state = sets.get(resourceId)
      if (state === undefined) throw new FixtureSetsError(`组合不存在：${resourceId}`, 'not-found')
      state.summary.trashed = true
      return { resourceId, trashedRows: 2, note: '软删=回收站语义' }
    },
  }

  return { client: { stones, sets: setsFace }, calls, sets }
}
