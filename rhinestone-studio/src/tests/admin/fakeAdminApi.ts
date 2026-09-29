/*
 * [split-admin-portal 1.5/1.6 测试基建] fake admin/auth client 工厂。
 * 契约签名冻结（auth.login/refresh/me + admin.userList/userCreate/userUpdate/
 * userDelete/settingsGet/settingsUpdate）——本地声明输出形状，daemon 子代理
 * 合流后 UI 零变化（fake 与真实现同签名）。
 * 用法：vi.mock('$lib/adminApi', () => ({ adminApi: () => holder.api }))——
 * holder 为 vi.hoisted 容器，beforeEach 重建实例。
 */
import type {
  AdminUserView,
  AdminSettings,
  TokenOutput,
  UserInfo,
  KbAdminListOutput,
  KbRevision,
  KbRevisionGetOutput,
  AssetsLibMigrateItem,
  AssetsLibMigrateVerifyInput,
  AssetsLibNode,
} from '@handicraft/contracts'
import { assetsLibManifestPayload } from '@handicraft/contracts'

/** adminApi 同名别名（lib/adminApi：AdminSessionUser = UserInfo）。 */
type AdminSessionUser = UserInfo

export interface FakeAdminState {
  users: AdminUserView[]
  settings: AdminSettings
  /** me() 返回（null=抛 401 语义错）。 */
  meUser: AdminSessionUser | null
  loginShouldFail: boolean
  refreshShouldFail: boolean
  /** 知识库面（split-admin-portal 3.4）：可变库 + 历史降级开关 + 调用记录。 */
  kbGroups: KbAdminListOutput['groups']
  kbHistoryAvailable: boolean
  kbRevisions: KbRevision[]
  /** 素材库面（split-admin-portal 4.4）：可变节点树 + 迁移面 + 调用记录。 */
  assetsNodes: AssetsLibNode[]
  calls: {
    login: Array<{ username: string; password: string }>
    refresh: string[]
    me: number
    userList: number
    userCreate: Array<{ username: string; password: string; role: 'admin' | 'user' }>
    userUpdate: Array<Record<string, unknown>>
    userDelete: string[]
    settingsGet: number
    settingsUpdate: Array<{ allowAnonymous?: boolean; siteName?: string }>
    kbList: number
    kbSaveGroup: Array<{ name: string; note?: string; newName?: string }>
    kbDeleteGroup: string[]
    kbSaveEntry: Array<{ group: string; key: string; value: string; newKey?: string }>
    kbDeleteEntry: Array<{ group: string; key: string }>
    kbRevisions: number
    kbRevisionGet: string[]
    kbRestore: string[]
    assetsLibTree: number
    assetsLibRename: Array<{ id: string; name: string }>
    assetsLibMove: Array<{ id: string; newParentId: string | null }>
    assetsLibSoftDelete: string[]
    assetsLibRestore: string[]
    assetsLibPurge: number
    assetsLibMigrateBatch: number
    assetsLibMigrateVerify: AssetsLibMigrateVerifyInput[]
  }
}

export function makeFakeAdminApi() {
  const state: FakeAdminState = {
    users: [
      { username: 'boss', role: 'admin', disabled: false, createdAt: '2026-01-01T00:00:00Z' },
      { username: 'user1', role: 'user', disabled: false, createdAt: '2026-01-02T00:00:00Z' },
      { username: '__anonymous__', role: 'user', disabled: false, createdAt: '2026-01-01T00:00:00Z' },
    ],
    settings: { allowAnonymous: true, siteName: '贴钻工作台' },
    meUser: { username: 'boss', role: 'admin' },
    loginShouldFail: false,
    refreshShouldFail: false,
    kbGroups: [
      {
        name: '钻径与规格',
        note: 'SS 尺码与选用要点（来源：整理初版，待领域负责人校订）',
        entries: [
          { key: 'SS 尺码表（SS6–SS34）', value: 'SS6=2.0、SS8=2.4 … SS34=7.1（非线性，永远查表）' },
          { key: '密度与钻径+gap 的关系', value: 'pitchMm = 钻径 + gapMm；gap 0=相切，缺省 0.4mm。' },
        ],
      },
      {
        name: '色系与编码',
        note: '色系命名、SKU 编码解析与 ΔE 色容差三档',
        entries: [{ key: 'ΔE76 色容差三档（3、10、25）', value: 'ΔE<3 自动替代；3–10 自动+备注；10–25 人工确认；>25 拒绝。' }],
      },
    ],
    kbHistoryAvailable: true,
    kbRevisions: [
      { id: 'a1b2c3d', at: '2026-09-29T10:00:00+08:00', actor: 'admin:boss', summary: '新增条目「色系与编码/ΔE76 色容差三档（3、10、25）」' },
      { id: '0f1e2d3', at: '2026-09-29T09:00:00+08:00', actor: 'system', summary: '初始化知识库种子（5 组）' },
    ],
    assetsNodes: [
      {
        id: 'al-dir-uploads',
        owner: 'boss',
        parentId: null,
        name: '上传',
        isDir: true,
        mime: null,
        width: null,
        height: null,
        blobHash: null,
        bytes: 0,
        softDeleted: false,
        createdAt: '2026-09-29T00:00:00Z',
        updatedAt: '2026-09-29T00:00:00Z',
      },
      {
        id: 'al-img-1',
        owner: 'boss',
        parentId: 'al-dir-uploads',
        name: '样图.png',
        isDir: false,
        mime: 'image/png',
        width: 120,
        height: 80,
        blobHash: 'a'.repeat(64),
        bytes: 2048,
        softDeleted: false,
        createdAt: '2026-09-29T00:00:00Z',
        updatedAt: '2026-09-29T00:00:00Z',
      },
    ],
    calls: {
      login: [],
      refresh: [],
      me: 0,
      userList: 0,
      userCreate: [],
      userUpdate: [],
      userDelete: [],
      settingsGet: 0,
      settingsUpdate: [],
      kbList: 0,
      kbSaveGroup: [],
      kbDeleteGroup: [],
      kbSaveEntry: [],
      kbDeleteEntry: [],
      kbRevisions: 0,
      kbRevisionGet: [],
      kbRestore: [],
      assetsLibTree: 0,
      assetsLibRename: [],
      assetsLibMove: [],
      assetsLibSoftDelete: [],
      assetsLibRestore: [],
      assetsLibPurge: 0,
      assetsLibMigrateBatch: 0,
      assetsLibMigrateVerify: [],
    },
  }

  const token = (username: string, role: AdminSessionUser['role']): TokenOutput => ({
    token: `tok-${username}-${state.calls.login.length}`,
    expiresAt: 4102444800000,
    user: { username, role },
  })

  const api = {
    async login(username: string, password: string): Promise<TokenOutput> {
      const seq = state.calls.login.length
      state.calls.login.push({ username, password })
      if (state.loginShouldFail) throw new Error('用户名或密码错误')
      const out = token(username, username === 'boss' ? 'admin' : 'user')
      return { ...out, token: `tok-${username}-${seq}` }
    },
    async refresh(oldToken: string): Promise<TokenOutput> {
      state.calls.refresh.push(oldToken)
      if (state.refreshShouldFail) throw new Error('token 已失效')
      const username = oldToken.replace(/^tok-/, '').split('-')[0] || 'boss'
      return token(username, username === 'boss' ? 'admin' : 'user')
    },
    async me(): Promise<AdminSessionUser> {
      state.calls.me += 1
      if (state.meUser === null) throw new Error('Unauthorized')
      return state.meUser
    },
    async userList(): Promise<{ users: AdminUserView[] }> {
      state.calls.userList += 1
      return { users: state.users }
    },
    async userCreate(input: { username: string; password: string; role: 'admin' | 'user' }): Promise<AdminUserView> {
      state.calls.userCreate.push({ ...input })
      const created: AdminUserView = { username: input.username, role: input.role, disabled: false, createdAt: '2026-09-28T00:00:00Z' }
      state.users = [...state.users, created]
      return created
    },
    async userUpdate(input: Record<string, unknown>): Promise<AdminUserView> {
      state.calls.userUpdate.push({ ...input })
      const username = input.username as string
      const row = state.users.find((u) => u.username === username)
      if (row === undefined) throw new Error('用户不存在')
      if (typeof input.password === 'string') return row
      if (typeof input.disabled === 'boolean') row.disabled = input.disabled
      if (input.role === 'admin' || input.role === 'user') row.role = input.role
      return row
    },
    async userDelete(username: string): Promise<void> {
      state.calls.userDelete.push(username)
      state.users = state.users.filter((u) => u.username !== username)
    },
    async settingsGet(): Promise<AdminSettings> {
      state.calls.settingsGet += 1
      return { ...state.settings }
    },
    async settingsUpdate(input: { allowAnonymous?: boolean; siteName?: string }): Promise<AdminSettings> {
      state.calls.settingsUpdate.push({ ...input })
      state.settings = { ...state.settings, ...input }
      return { ...state.settings }
    },
    // ---- kb 面（真实 adminApi 同签名：写面返回全量 groups 即时回填） ----
    async kbList(): Promise<KbAdminListOutput> {
      state.calls.kbList += 1
      return { groups: state.kbGroups.map((g) => ({ ...g, entries: g.entries.map((e) => ({ ...e })) })) }
    },
    async kbSaveGroup(input: { name: string; note?: string; newName?: string }): Promise<KbAdminListOutput> {
      state.calls.kbSaveGroup.push({ ...input })
      const existing = state.kbGroups.find((g) => g.name === input.name)
      if (existing === undefined) {
        state.kbGroups = [...state.kbGroups, { name: input.newName ?? input.name, note: input.note ?? '', entries: [] }]
      } else {
        existing.note = input.note ?? existing.note
        if (input.newName !== undefined) existing.name = input.newName
      }
      return this.kbList()
    },
    async kbDeleteGroup(name: string): Promise<KbAdminListOutput> {
      state.calls.kbDeleteGroup.push(name)
      state.kbGroups = state.kbGroups.filter((g) => g.name !== name)
      return this.kbList()
    },
    async kbSaveEntry(input: { group: string; key: string; value: string; newKey?: string }): Promise<KbAdminListOutput> {
      state.calls.kbSaveEntry.push({ ...input })
      const group = state.kbGroups.find((g) => g.name === input.group)
      if (group === undefined) throw new Error('分组不存在')
      const existing = group.entries.find((e) => e.key === input.key)
      if (existing === undefined) {
        group.entries = [...group.entries, { key: input.newKey ?? input.key, value: input.value }]
      } else {
        existing.value = input.value
        if (input.newKey !== undefined) existing.key = input.newKey
      }
      return this.kbList()
    },
    async kbDeleteEntry(group: string, key: string): Promise<KbAdminListOutput> {
      state.calls.kbDeleteEntry.push({ group, key })
      const target = state.kbGroups.find((g) => g.name === group)
      if (target === undefined) throw new Error('分组不存在')
      target.entries = target.entries.filter((e) => e.key !== key)
      return this.kbList()
    },
    async kbRevisions(): Promise<{ available: boolean; revisions: KbRevision[] }> {
      state.calls.kbRevisions += 1
      return { available: state.kbHistoryAvailable, revisions: [...state.kbRevisions] }
    },
    async kbRevisionGet(id: string): Promise<KbRevisionGetOutput> {
      state.calls.kbRevisionGet.push(id)
      const revision = state.kbRevisions.find((r) => r.id === id)
      if (revision === undefined) throw new Error('修订不存在')
      return {
        revision,
        changes: [{ path: '钻径与规格/SS 尺码表（SS6–SS34）.md', status: 'added' }],
        snapshot: state.kbGroups.map((g) => ({ ...g, entries: g.entries.map((e) => ({ ...e })) })),
      }
    },
    async kbRestore(id: string): Promise<{ ok: boolean }> {
      state.calls.kbRestore.push(id)
      return { ok: true }
    },
    // ---- assetsLib 面（真实 adminApi 同签名；服务端语义的内存面仿真） ----
    async assetsLibTree(input: { owner?: string; includeTrashed?: boolean } = {}): Promise<{ nodes: AssetsLibNode[] }> {
      state.calls.assetsLibTree += 1
      void input.owner
      const nodes = input.includeTrashed ? state.assetsNodes : state.assetsNodes.filter((node) => !node.softDeleted)
      return { nodes: nodes.map((node) => ({ ...node })) }
    },
    async assetsLibUploadImage(input: {
      parentId: string | null
      name: string
      dataBase64: string
      width?: number
      height?: number
    }): Promise<AssetsLibNode> {
      const node: AssetsLibNode = {
        id: `al-img-${state.assetsNodes.length + 1}`,
        owner: 'boss',
        parentId: input.parentId,
        name: input.name,
        isDir: false,
        mime: 'image/png',
        width: input.width ?? null,
        height: input.height ?? null,
        blobHash: 'b'.repeat(64),
        bytes: Math.ceil((input.dataBase64.length * 3) / 4),
        softDeleted: false,
        createdAt: '2026-09-29T00:00:00Z',
        updatedAt: '2026-09-29T00:00:00Z',
      }
      state.assetsNodes = [...state.assetsNodes, node]
      return { ...node }
    },
    async assetsLibMove(id: string, newParentId: string | null): Promise<AssetsLibNode> {
      state.calls.assetsLibMove.push({ id, newParentId })
      const node = state.assetsNodes.find((n) => n.id === id)
      if (node === undefined) throw new Error('素材不存在')
      node.parentId = newParentId
      return { ...node }
    },
    async assetsLibRename(id: string, name: string): Promise<AssetsLibNode> {
      state.calls.assetsLibRename.push({ id, name })
      const node = state.assetsNodes.find((n) => n.id === id)
      if (node === undefined) throw new Error('素材不存在')
      node.name = name
      return { ...node }
    },
    async assetsLibSoftDelete(id: string): Promise<{ id: string; softDeletedRows: number }> {
      state.calls.assetsLibSoftDelete.push(id)
      const subtree = collectSubtree(state.assetsNodes, id)
      for (const node of subtree) node.softDeleted = true
      return { id, softDeletedRows: subtree.length }
    },
    async assetsLibRestore(id: string): Promise<{ id: string; restoredRows: number }> {
      state.calls.assetsLibRestore.push(id)
      const subtree = collectSubtree(state.assetsNodes, id)
      for (const node of subtree) node.softDeleted = false
      return { id, restoredRows: subtree.length }
    },
    async assetsLibPurgeEmptyTrash(): Promise<{ purgedNodeIds: string[]; releasedBlobHashes: string[] }> {
      state.calls.assetsLibPurge += 1
      const purged = state.assetsNodes.filter((node) => node.softDeleted)
      state.assetsNodes = state.assetsNodes.filter((node) => !node.softDeleted)
      return {
        purgedNodeIds: purged.map((node) => node.id),
        releasedBlobHashes: purged.filter((node) => node.blobHash !== null).map((node) => node.blobHash!),
      }
    },
    async assetsLibMigrateBatch(
      items: AssetsLibMigrateItem[],
    ): Promise<{ results: Array<{ clientId: string; status: 'created' | 'existing'; id: string }> }> {
      state.calls.assetsLibMigrateBatch += 1
      const results: Array<{ clientId: string; status: 'created' | 'existing'; id: string }> = []
      for (const item of items) {
        const id = `al-fake:${item.clientId}`
        if (state.assetsNodes.some((node) => node.id === id)) {
          results.push({ clientId: item.clientId, status: 'existing', id })
          continue
        }
        state.assetsNodes = [
          ...state.assetsNodes,
          {
            id,
            owner: 'boss',
            parentId: item.parentClientId !== null ? `al-fake:${item.parentClientId}` : null,
            name: item.name,
            isDir: item.isDir,
            mime: item.isDir ? null : 'image/png',
            width: item.isDir ? null : (item.width ?? null),
            height: item.isDir ? null : (item.height ?? null),
            blobHash: item.isDir ? null : await sha256OfBase64(item.dataBase64),
            bytes: item.isDir ? 0 : atob(item.dataBase64).length,
            softDeleted: false,
            createdAt: '2026-09-29T00:00:00Z',
            updatedAt: '2026-09-29T00:00:00Z',
          },
        ]
        results.push({ clientId: item.clientId, status: 'created', id })
      }
      return { results }
    },
    async assetsLibMigrateVerify(
      input: AssetsLibMigrateVerifyInput,
    ): Promise<{
      match: boolean
      serverCount: number
      serverBytes: number
      serverDigest: string
      serverNodes: Array<{ id: string; name: string; blobHash: string; bytes: number }>
    }> {
      state.calls.assetsLibMigrateVerify.push(input)
      const serverNodes = state.assetsNodes
        .filter((node) => !node.isDir && !node.softDeleted && node.blobHash !== null)
        .map((node) => ({ id: node.id, name: node.name, blobHash: node.blobHash!, bytes: node.bytes }))
      const digest = await sha256Hex(assetsLibManifestPayload(serverNodes))
      const serverBytes = serverNodes.reduce((sum, node) => sum + node.bytes, 0)
      return {
        match:
          serverNodes.length === input.declaredCount && serverBytes === input.declaredBytes && digest === input.declaredDigest,
        serverCount: serverNodes.length,
        serverBytes,
        serverDigest: digest,
        serverNodes,
      }
    },
  }

  return { state, api }
}

/** 子树收集（软删/恢复仿真共用——BFS 沿 parentId）。 */
function collectSubtree(nodes: AssetsLibNode[], rootId: string): AssetsLibNode[] {
  const collected: AssetsLibNode[] = []
  const queue = [rootId]
  while (queue.length > 0) {
    const current = queue.shift()!
    const node = nodes.find((n) => n.id === current)
    if (node !== undefined) collected.push(node)
    for (const child of nodes.filter((n) => n.parentId === current)) queue.push(child.id)
  }
  return collected
}

/** base64 内容→真实 sha256 hex（与迁移工具/daemon 两端同算法——核验一致性前提）。 */
async function sha256OfBase64(dataBase64: string): Promise<string> {
  const binary = atob(dataBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** 真实 sha256 hex（verify 仿真——与 daemon/工具两端同算法）。 */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const bytes = new Uint8Array(digest)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

export type FakeAdminApi = ReturnType<typeof makeFakeAdminApi>
