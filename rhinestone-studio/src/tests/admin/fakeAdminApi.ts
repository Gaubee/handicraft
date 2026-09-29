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
  AdminSessionUser,
  AdminSettings,
  TokenOutput,
} from '../../lib/adminApi'

export interface FakeAdminState {
  users: AdminUserView[]
  settings: AdminSettings
  /** me() 返回（null=抛 401 语义错）。 */
  meUser: AdminSessionUser | null
  loginShouldFail: boolean
  refreshShouldFail: boolean
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
  }

  return { state, api }
}

export type FakeAdminApi = ReturnType<typeof makeFakeAdminApi>
