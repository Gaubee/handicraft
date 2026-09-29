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
} from '@handicraft/contracts'

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
  }

  return { state, api }
}

export type FakeAdminApi = ReturnType<typeof makeFakeAdminApi>
