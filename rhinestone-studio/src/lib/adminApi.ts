/*
 * 认证与后台管理 RPC 面（split-admin-portal 1.5/1.6，2026-09-28）。
 * auth.login/refresh/me + admin.userList/userCreate/userUpdate/userDelete/
 * settingsGet/settingsUpdate（冻结契约签名——见 openspec split-admin-portal 简报）。
 * 4.3/4.4 追加 assetsLib 九端点（素材库服务化——树/写面/IDB 迁移与核验）。
 * 传输形态：modelsApi 同构（@orpc/client RPCLink over 同源 /ws/rpc?token= +
 * 单连接复用断线重建）；连接 token 取 daemonToken 存储层（登录 token 优先），
 * 登录成功换 token 后按代际漂移弃连重连（见 tokenEpoch）。
 *
 * 【待合流点】contracts/src/admin.ts 由 daemon 子代理并行落地——本文件本地
 * 声明契约类型与 zod 读面守门（签名按冻结契约）；合流后删除本地声明换
 * `import { ... } from '@handicraft/contracts'`（行为零变化）。
 */
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import {
  AdminSettingsOutputSchema,
  AdminUserCreateInputSchema,
  AdminUserListOutputSchema,
  AdminUserUpdateInputSchema,
  AdminUserViewSchema,
  AssetsLibMigrateBatchOutputSchema,
  AssetsLibMigrateVerifyOutputSchema,
  AssetsLibNodeSchema,
  AssetsLibPurgeEmptyTrashOutputSchema,
  AssetsLibTreeOutputSchema,
  KbAdminListOutputSchema,
  KbEntrySaveInputSchema,
  KbGroupSaveInputSchema,
  KbRestoreOutputSchema,
  KbRevisionGetOutputSchema,
  KbRevisionsOutputSchema,
  MeOutputSchema,
  RoleSchema,
  TokenOutputSchema,
  UserInfoSchema,
  type AdminRole,
  type AdminSettingsOutput,
  type AdminUserUpdateInput,
  type AdminUserView,
  type AssetsLibMigrateItem,
  type AssetsLibMigrateVerifyInput,
  type AssetsLibNode,
  type AssetsLibTreeOutput,
  type KbAdminListOutput,
  type KbEntrySaveInput,
  type KbGroupSaveInput,
  type KbRevisionGetOutput,
  type KbRevisionsOutput,
  type TokenOutput,
  type UserInfo,
} from '@handicraft/contracts'
import { getStoredToken } from './daemonToken.js'

// ---------------------------------------------------------------- 契约再导出（合流换接 2026-09-29）

/** 会话角色三值（contracts RoleSchema——含 anonymous；AdminRole 两值为管理行视图专用）。 */
export const AdminRoleSchema = RoleSchema
export type { AdminRole, AdminUserUpdateInput, AdminUserView, TokenOutput, UserInfo }
/**
 * 设置面类型=契约 **get 出面**（allowAnonymous 必填；siteName 可选——未设置时
 * daemon 省略字段。波 5 P1-1：此前误绑 update 入面 AdminSettingsSchema 做读面
 * 守门，空串 siteName 撞 min(1) 拒整包，新实例后台整体卡死）。
 */
export type AdminSettings = AdminSettingsOutput
export type AdminSessionUser = UserInfo
/** 服务端素材节点视图（contracts AssetsLibNode——AssetsLibAdmin 数据面）。 */
export type AssetsLibNodeView = AssetsLibNode

// ---------------------------------------------------------------- 读面守门（contracts schema 直用）

const UserListOutputGuard = AdminUserListOutputSchema
/** 设置读面守门=契约 get 出面（siteName 可选——波 5 P1-1 修正）。 */
const SettingsViewSchema = AdminSettingsOutputSchema

// ---------------------------------------------------------------- WS 客户端

/** orpc 客户端的窄结构类型（真实类型经输出 schema parse 收敛）。 */
interface AdminRpcClient {
  auth: {
    login(input: { username: string; password: string }): Promise<unknown>
    refresh(input: { token: string }): Promise<unknown>
    me(): Promise<unknown>
  }
  admin: {
    userList(): Promise<unknown>
    userCreate(input: { username: string; password: string; role: 'admin' | 'user' }): Promise<unknown>
    userUpdate(input: AdminUserUpdateInput): Promise<unknown>
    userDelete(input: { username: string }): Promise<unknown>
    settingsGet(): Promise<unknown>
    settingsUpdate(input: { allowAnonymous?: boolean; siteName?: string }): Promise<unknown>
    kb: {
      list(): Promise<unknown>
      saveGroup(input: KbGroupSaveInput): Promise<unknown>
      deleteGroup(input: { name: string }): Promise<unknown>
      saveEntry(input: KbEntrySaveInput): Promise<unknown>
      deleteEntry(input: { group: string; key: string }): Promise<unknown>
      revisions(): Promise<unknown>
      revisionGet(input: { id: string }): Promise<unknown>
      restore(input: { id: string }): Promise<unknown>
    }
  }
  assetsLib: {
    tree(input: { owner?: string; includeTrashed: boolean }): Promise<unknown>
    uploadImage(input: {
      parentId: string | null
      name: string
      dataBase64: string
      width?: number
      height?: number
    }): Promise<unknown>
    move(input: { id: string; newParentId: string | null }): Promise<unknown>
    rename(input: { id: string; name: string }): Promise<unknown>
    softDelete(input: { id: string }): Promise<unknown>
    restore(input: { id: string }): Promise<unknown>
    purgeEmptyTrash(input: Record<string, never>): Promise<unknown>
    migrateBatch(input: { items: AssetsLibMigrateItem[] }): Promise<unknown>
    migrateVerify(input: AssetsLibMigrateVerifyInput): Promise<unknown>
  }
}

function parseOrThrow<T>(schema: { parse(input: unknown): T }, value: unknown, what: string): T {
  try {
    return schema.parse(value)
  } catch (error) {
    throw new Error(`${what} 响应不符合契约：${String(error)}`)
  }
}

class AdminApiClient {
  private client: AdminRpcClient | null = null
  private connecting: Promise<AdminRpcClient> | null = null
  private readonly baseUrl: string
  /** 当前连接所用 token（代际漂移检测；null=匿名/无 token 连接）。 */
  private connectedToken: string | null = null

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? globalThis.location?.origin ?? 'http://127.0.0.1:8317').replace(/\/$/, '')
  }

  /**
   * token 代际自检：登录/登出/匿名兜底改写存储 token 后，旧连接仍以旧身份运行
   * （admin.* 直接收 403）——调用前检测漂移，弃连走重连（新连接取新 token）。
   */
  private syncTokenEpoch(): void {
    const stored = getStoredToken()
    if ((this.client !== null || this.connecting !== null) && this.connectedToken !== stored) {
      this.client = null
      this.connectedToken = null
      this.connecting = null // 进行中的连接按旧 token 建立——一并作废
    }
  }

  private rpc(): Promise<AdminRpcClient> {
    this.syncTokenEpoch()
    if (this.client) return Promise.resolve(this.client)
    if (!this.connecting) {
      this.connecting = this.connect().finally(() => {
        this.connecting = null
      })
    }
    return this.connecting
  }

  private async connect(): Promise<AdminRpcClient> {
    const token = getStoredToken()
    this.connectedToken = token
    const url = `${this.baseUrl.replace(/^http/, 'ws')}/ws/rpc${token ? `?token=${encodeURIComponent(token)}` : ''}`
    const websocket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      websocket.addEventListener('open', () => resolve(), { once: true })
      websocket.addEventListener('error', () => reject(new Error('WS 连接失败——daemon 不可达或未启动')), { once: true })
    })
    // 连接期间 token 被改写（登录完成/登出）——本连接按旧身份建立，作废重连
    //（竞态守卫：syncTokenEpoch 作废 connecting 后，迟到 resolve 不得复活旧连接）。
    if (getStoredToken() !== token) {
      websocket.close()
      throw new Error('token 已变更——按新会话重连')
    }
    websocket.addEventListener('close', () => {
      if (this.client !== null) {
        this.client = null
        this.connectedToken = null
      }
    })
    const link = new RPCLink({ websocket: websocket as unknown as WebSocket })
    this.client = createORPCClient(link) as unknown as AdminRpcClient
    return this.client
  }

  private async call<T>(
    what: string,
    invoke: (client: AdminRpcClient) => Promise<unknown>,
    schema: { parse(input: unknown): T },
  ): Promise<T> {
    const client = await this.rpc()
    return parseOrThrow(schema, await invoke(client), what)
  }

  // ---------------------------------------------------------------- auth 面

  /** 登录（成功 token 由调用方/session store 写入存储层；本客户端随代际漂移换连）。 */
  async login(username: string, password: string): Promise<TokenOutput> {
    return this.call('auth.login', (client) => client.auth.login({ username, password }), TokenOutputSchema)
  }

  /** 刷新（旧 token 换新——会话恢复路径）。 */
  async refresh(token: string): Promise<TokenOutput> {
    return this.call('auth.refresh', (client) => client.auth.refresh({ token }), TokenOutputSchema)
  }

  /** 当前会话投影（连接 token 对应的用户）。 */
  async me(): Promise<AdminSessionUser> {
    return this.call('auth.me', (client) => client.auth.me(), MeOutputSchema)
  }

  // ---------------------------------------------------------------- admin 面

  async userList(): Promise<{ users: AdminUserView[] }> {
    return this.call('admin.userList', (client) => client.admin.userList(), UserListOutputGuard)
  }

  async userCreate(input: { username: string; password: string; role: 'admin' | 'user' }): Promise<AdminUserView> {
    // 写面输出不守门（列表刷新面已守门）——daemon 侧实现并行落地，输出形状以读面为准。
    const client = await this.rpc()
    return (await client.admin.userCreate(input)) as AdminUserView
  }

  async userUpdate(input: AdminUserUpdateInput): Promise<AdminUserView> {
    const client = await this.rpc()
    return (await client.admin.userUpdate(input)) as AdminUserView
  }

  async userDelete(username: string): Promise<void> {
    const client = await this.rpc()
    await client.admin.userDelete({ username })
  }

  async settingsGet(): Promise<AdminSettings> {
    return this.call('admin.settingsGet', (client) => client.admin.settingsGet(), SettingsViewSchema)
  }

  async settingsUpdate(input: { allowAnonymous?: boolean; siteName?: string }): Promise<AdminSettings> {
    const client = await this.rpc()
    return SettingsViewSchema.parse(await client.admin.settingsUpdate(input))
  }

  // ---------------------------------------------------------------- admin.kb 面（split-admin-portal 3.4）

  /** 全量知识库（含 value——后台编辑器数据源；每次写回全量即时回填）。 */
  async kbList(): Promise<KbAdminListOutput> {
    return this.call('admin.kb.list', (client) => client.admin.kb.list(), KbAdminListOutputSchema)
  }

  async kbSaveGroup(input: KbGroupSaveInput): Promise<KbAdminListOutput> {
    return this.call('admin.kb.saveGroup', (client) => client.admin.kb.saveGroup(input), KbAdminListOutputSchema)
  }

  async kbDeleteGroup(name: string): Promise<KbAdminListOutput> {
    return this.call('admin.kb.deleteGroup', (client) => client.admin.kb.deleteGroup({ name }), KbAdminListOutputSchema)
  }

  async kbSaveEntry(input: KbEntrySaveInput): Promise<KbAdminListOutput> {
    return this.call('admin.kb.saveEntry', (client) => client.admin.kb.saveEntry(input), KbAdminListOutputSchema)
  }

  async kbDeleteEntry(group: string, key: string): Promise<KbAdminListOutput> {
    return this.call(
      'admin.kb.deleteEntry',
      (client) => client.admin.kb.deleteEntry({ group, key }),
      KbAdminListOutputSchema,
    )
  }

  async kbRevisions(): Promise<KbRevisionsOutput> {
    return this.call('admin.kb.revisions', (client) => client.admin.kb.revisions(), KbRevisionsOutputSchema)
  }

  async kbRevisionGet(id: string): Promise<KbRevisionGetOutput> {
    return this.call('admin.kb.revisionGet', (client) => client.admin.kb.revisionGet({ id }), KbRevisionGetOutputSchema)
  }

  async kbRestore(id: string): Promise<{ ok: boolean }> {
    return this.call('admin.kb.restore', (client) => client.admin.kb.restore({ id }), KbRestoreOutputSchema)
  }

  // ---------------------------------------------------------------- assetsLib 面（split-admin-portal 4.3/4.4——素材库服务化）

  /** 服务端素材树（owner 缺省=普通用户自己/admin 全量；admin 显式 owner 查指定用户）。 */
  async assetsLibTree(input: { owner?: string; includeTrashed?: boolean } = {}): Promise<AssetsLibTreeOutput> {
    return this.call('assetsLib.tree', (client) => client.assetsLib.tree({ includeTrashed: false, ...input }), AssetsLibTreeOutputSchema)
  }

  async assetsLibUploadImage(input: {
    parentId: string | null
    name: string
    dataBase64: string
    width?: number
    height?: number
  }): Promise<AssetsLibNode> {
    return this.call('assetsLib.uploadImage', (client) => client.assetsLib.uploadImage(input), AssetsLibNodeSchema)
  }

  async assetsLibMove(id: string, newParentId: string | null): Promise<AssetsLibNode> {
    return this.call('assetsLib.move', (client) => client.assetsLib.move({ id, newParentId }), AssetsLibNodeSchema)
  }

  async assetsLibRename(id: string, name: string): Promise<AssetsLibNode> {
    return this.call('assetsLib.rename', (client) => client.assetsLib.rename({ id, name }), AssetsLibNodeSchema)
  }

  async assetsLibSoftDelete(id: string): Promise<{ id: string; softDeletedRows: number }> {
    const client = await this.rpc()
    return (await client.assetsLib.softDelete({ id })) as { id: string; softDeletedRows: number }
  }

  async assetsLibRestore(id: string): Promise<{ id: string; restoredRows: number }> {
    const client = await this.rpc()
    return (await client.assetsLib.restore({ id })) as { id: string; restoredRows: number }
  }

  async assetsLibPurgeEmptyTrash(): Promise<{ purgedNodeIds: string[]; releasedBlobHashes: string[] }> {
    return this.call('assetsLib.purgeEmptyTrash', (client) => client.assetsLib.purgeEmptyTrash({}), AssetsLibPurgeEmptyTrashOutputSchema)
  }

  async assetsLibMigrateBatch(items: AssetsLibMigrateItem[]): Promise<{ results: Array<{ clientId: string; status: 'created' | 'existing'; id: string }> }> {
    return this.call('assetsLib.migrateBatch', (client) => client.assetsLib.migrateBatch({ items }), AssetsLibMigrateBatchOutputSchema)
  }

  async assetsLibMigrateVerify(input: AssetsLibMigrateVerifyInput): Promise<{
    match: boolean
    serverCount: number
    serverBytes: number
    serverDigest: string
    serverNodes: Array<{ id: string; name: string; blobHash: string; bytes: number }>
  }> {
    return this.call('assetsLib.migrateVerify', (client) => client.assetsLib.migrateVerify(input), AssetsLibMigrateVerifyOutputSchema)
  }
}

/** 单例（会话 store 与 AdminPage 共享一条连接；测试经 vi.mock('$lib/adminApi') 注入 fake）。 */
let instance: AdminApiClient | null = null

export function adminApi(baseUrl?: string): AdminApiClient {
  if (!instance) instance = new AdminApiClient(baseUrl)
  return instance
}
