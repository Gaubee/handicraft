<!--
  /admin 后台壳（split-admin-portal 1.6，2026-09-28；zhumo webui AdminPage.svelte
  773 行形态 1:0.99 复刻适配——贴钻契约/组件库/文案基线）。四入口：账号管理 /
  资源管理（波 4 实装=三子分区：装饰钻库 StonesAdminView / 组合套装库
  WarehouseView / 素材库 AssetsLibAdmin——4.1/4.2/4.4）/ 知识库（波 3 实装=
  KnowledgeManager）/ 设置（大模型服务=ModelsConfig / 图像处理=
  ImageProcessingConfig 零改动挂载 / 站点与安全）。
  结构要点（zhumo 同款）：
  1. tab 路由（#/admin/accounts|resources|kb|settings）+ 侧栏导航（激活高亮；
     ≥md 常驻 aside，移动收进左侧 Sheet 抽屉——顶栏汉堡唤起，选中即收）。
  2. admin 角色守卫（非 admin 渲染「需要管理员权限」守卫卡，可去登录/回前台；
     服务端 requireAdmin 才是真门——客户端守卫只做提示与跳转）。
  3. 账号管理：用户表（桌面表格/移动卡片）+ 创建 Dialog（不开放注册文案）+
     改密 Dialog + 删除确认 Dialog + 禁用/启用行内操作 + 匿名开关 Switch；
     __anonymous__ 系统账户行只标注不给任何操作入口。
  4. 设置：二级 list-detail 三分区（桌面左分区导航右内容；移动顶部横滑 pill 条）。
     资源管理同款二级 list-detail 三子分区（波 4——StonesAdminView/WarehouseView
     组件内部零改动挂载，dev 旗标旧入口保留双入口过渡）。
-->
<script lang="ts">
  import IconFolder from '@lucide/svelte/icons/folder'
  import IconBookOpen from '@lucide/svelte/icons/book-open'
  import IconLogIn from '@lucide/svelte/icons/log-in'
  import IconSettings from '@lucide/svelte/icons/settings'
  import IconUsers from '@lucide/svelte/icons/users'
  import IconBrain from '@lucide/svelte/icons/brain'
  import IconShield from '@lucide/svelte/icons/shield'
  import IconImage from '@lucide/svelte/icons/image'
  import IconMenu from '@lucide/svelte/icons/menu'
  import IconX from '@lucide/svelte/icons/x'
  import IconBot from '@lucide/svelte/icons/bot'
  import IconLayers from '@lucide/svelte/icons/layers'
  import IconBoxes from '@lucide/svelte/icons/boxes'
  import IconFolderOpen from '@lucide/svelte/icons/folder-open'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Sheet from '$lib/components/ui/sheet'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import ModelsConfig from '$lib/components/models/ModelsConfig.svelte'
  import ImageProcessingConfig from '$lib/components/settings/ImageProcessingConfig.svelte'
  import KnowledgeManager from '$lib/components/kb/KnowledgeManager.svelte'
  import StonesAdminView from '../../../components/stones-admin/StonesAdminView.svelte'
  import WarehouseView from '../../../components/warehouse/WarehouseView.svelte'
  import AssetsLibAdmin from '$lib/components/assets-lib/AssetsLibAdmin.svelte'
  import { adminApi, type AdminUserView, type AdminSettings } from '$lib/adminApi'
  import { navigate, stashReturnTo, type Route } from '$lib/router.svelte'
  import { isAdmin, isSessionInitialized } from '$lib/stores/session.svelte'

  let { tab }: { tab: Route & { name: 'admin' } } = $props()

  // ---- 账号管理 ----
  let users = $state<AdminUserView[]>([])
  let createOpen = $state(false)
  let newUsername = $state('')
  let newPassword = $state('')
  let createError = $state<string | null>(null)
  let passwordTarget = $state<AdminUserView | null>(null)
  let nextPassword = $state('')
  let passwordError = $state<string | null>(null)
  /** 待删除账号（确认 Dialog 目标——删除=数据级联清理，不可恢复）。 */
  let deleteTarget = $state<AdminUserView | null>(null)
  /** 账号行操作（禁用/删除）的行内错误反馈。 */
  let accountMessage = $state<string | null>(null)
  let busy = $state(false)

  // ---- 设置 ----
  let settings = $state<AdminSettings | null>(null)
  let loadError = $state<string | null>(null)
  /** siteName 编辑草稿（null=未编辑，展示远端值）。 */
  let siteNameDraft = $state<string | null>(null)
  let siteMessage = $state<string | null>(null)

  const navItems = [
    { id: 'accounts', label: '账号管理', icon: IconUsers },
    { id: 'resources', label: '资源管理', icon: IconFolder },
    { id: 'kb', label: '知识库', icon: IconBookOpen },
    { id: 'settings', label: '设置', icon: IconSettings },
  ] as const

  // ---- 设置页二级导航（zhumo list-detail 同款：桌面左侧分区导航+右侧内容；
  // 移动顶部横滑 pill 条。默认落 models——高频的模型配置语义由导航默认项承接。
  // 纯视图状态不进路由（与 zhumo 一致）。 ----
  const settingSections = [
    { id: 'models', label: '大模型服务', icon: IconBrain },
    { id: 'image-processing', label: '图像处理', icon: IconImage },
    { id: 'site', label: '站点与安全', icon: IconShield },
  ] as const
  let section = $state<(typeof settingSections)[number]['id']>('models')

  // ---- 资源管理页二级导航（split-admin-portal 4.1/4.2/4.4——三子分区：装饰钻库
  // =StonesAdminView 零改动挂载（dev 旗标旧入口保留——双入口过渡）；组合/套装库
  // =WarehouseView 零改动挂载；素材库=AssetsLibAdmin（服务端数据源新组件——本地
  // AssetsView 保留为迁移源）。形态照设置分区 list-detail（桌面左导航/移动横滑 pill）。
  // 纯视图状态不进路由（与设置分区一致）。 ----
  const resourceSections = [
    { id: 'stones', label: '装饰钻库', icon: IconLayers },
    { id: 'sets', label: '组合/套装库', icon: IconBoxes },
    { id: 'assets', label: '素材库', icon: IconFolderOpen },
  ] as const
  let resourceSection = $state<(typeof resourceSections)[number]['id']>('stones')

  // ---- 一级导航移动适配（zhumo 同款：桌面常驻侧栏，移动收进左侧 Sheet 抽屉）。 ----
  let desktop = $state(true)
  $effect(() => {
    // jsdom 无 matchMedia——守卫回落桌面分支（AgentView 同式）。
    if (typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(min-width: 768px)')
    const sync = () => (desktop = mq.matches)
    sync()
    mq.addEventListener('change', sync)
    return () => mq.removeEventListener('change', sync)
  })
  let navOpen = $state(false)

  /** 一级导航项点击：路由跳转 + 移动抽屉收起。 */
  function goto(item: (typeof navItems)[number]): void {
    navigate(`#/admin/${item.id}`)
    if (!desktop) navOpen = false
  }

  const admin = $derived(isAdmin())
  const initialized = $derived(isSessionInitialized())

  $effect(() => {
    if (admin) void refreshData()
  })

  async function refreshData(): Promise<void> {
    loadError = null
    siteMessage = null
    try {
      const api = adminApi()
      const [userList, settingsView] = await Promise.all([api.userList(), api.settingsGet()])
      users = userList.users
      settings = settingsView
      siteNameDraft = null
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error)
    }
  }

  function isSystemAccount(user: AdminUserView): boolean {
    return user.username === '__anonymous__'
  }

  async function createUser(): Promise<void> {
    createError = null
    if (newUsername.trim().length < 2) {
      createError = '用户名至少 2 个字符'
      return
    }
    if (newPassword.length < 8) {
      createError = '密码至少 8 位'
      return
    }
    busy = true
    try {
      await adminApi().userCreate({ username: newUsername.trim(), password: newPassword, role: 'user' })
      await refreshData()
      createOpen = false
      newUsername = ''
      newPassword = ''
    } catch (e) {
      createError = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  async function changePassword(): Promise<void> {
    passwordError = null
    if (passwordTarget === null) return
    if (nextPassword.length < 8) {
      passwordError = '新密码至少 8 位'
      return
    }
    busy = true
    try {
      await adminApi().userUpdate({ username: passwordTarget.username, password: nextPassword })
      passwordTarget = null
      nextPassword = ''
    } catch (e) {
      passwordError = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  /** 禁用/启用（禁用=阻断后续读写与新登录；数据保留——daemon 侧同样拦截）。 */
  async function toggleDisabled(user: AdminUserView): Promise<void> {
    busy = true
    accountMessage = null
    try {
      await adminApi().userUpdate({ username: user.username, disabled: !user.disabled })
      await refreshData()
    } catch (e) {
      accountMessage = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  /** 删除账号（数据级联清理：会话、任务与素材一并移除，不可恢复）。 */
  async function deleteAccount(): Promise<void> {
    if (deleteTarget === null) return
    busy = true
    accountMessage = null
    try {
      await adminApi().userDelete(deleteTarget.username)
      deleteTarget = null
      await refreshData()
    } catch (e) {
      accountMessage = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  async function toggleAnonymous(allow: boolean): Promise<void> {
    if (settings === null) return
    settings.allowAnonymous = allow
    try {
      settings = await adminApi().settingsUpdate({ allowAnonymous: allow })
    } catch (e) {
      accountMessage = e instanceof Error ? e.message : String(e)
      await refreshData()
    }
  }

  async function saveSiteName(): Promise<void> {
    if (settings === null) return
    const next = (siteNameDraft ?? settings.siteName ?? '').trim()
    if (next.length === 0) {
      siteMessage = '站点名称不能为空'
      return
    }
    busy = true
    siteMessage = null
    try {
      settings = await adminApi().settingsUpdate({ siteName: next })
      siteNameDraft = null
      siteMessage = '已保存'
    } catch (e) {
      siteMessage = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }
</script>

<div class="bg-background flex h-screen flex-col">
  {#snippet primaryNavButtons()}
    {#each navItems as item (item.id)}
      {@const Icon = item.icon}
      {@const active = tab.tab === item.id}
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        data-testid="admin-nav-{item.id}"
        class="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors {active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
        onclick={() => goto(item)}
      >
        <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
        {item.label}
      </button>
    {/each}
  {/snippet}

  <header class="bg-background flex h-12 shrink-0 items-center gap-2 border-b px-3 md:gap-3 md:px-4">
    {#if !desktop}
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="打开后台导航"
        onclick={() => (navOpen = true)}
      >
        <IconMenu class="size-4" aria-hidden="true" />
      </Button>
    {/if}
    <IconBot class="text-primary size-5 shrink-0" aria-hidden="true" />
    <span class="text-sm font-semibold">后台管理</span>
    <span class="flex-1"></span>
    <Button size="sm" variant="outline" onclick={() => navigate('#/')} data-testid="admin-back-front">
      返回前台
    </Button>
  </header>

  {#if !initialized}
    <!-- 会话恢复中（initSession 异步——守卫判定前不闪守卫卡）。 -->
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      <p class="text-muted-foreground text-xs" role="status">正在恢复会话…</p>
    </div>
  {:else if !admin}
    <!-- 非 admin 守卫卡（服务端 requireAdmin 才是真门——此处只做提示与跳转）。 -->
    <div class="flex min-h-0 flex-1 items-center justify-center p-6">
      <div
        class="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-amber-500/50 bg-card p-6 text-center"
        data-testid="admin-guard-card"
      >
        <p class="text-sm font-medium">需要管理员权限</p>
        <p class="text-muted-foreground text-xs leading-snug">
          当前会话无权访问后台管理。请使用管理员账号登录后再试。
        </p>
        <div class="mt-1 flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onclick={() => {
              stashReturnTo()
              navigate('#/login')
            }}
          >
            <IconLogIn aria-hidden="true" />
            去登录
          </Button>
          <Button size="sm" variant="ghost" onclick={() => navigate('#/')}>返回前台</Button>
        </div>
      </div>
    </div>
  {:else}
    <div class="flex min-h-0 flex-1">
      <!-- 侧栏导航（≥md 常驻 aside；激活态 primary 高亮）。 -->
      <aside class="bg-card hidden w-44 shrink-0 flex-col gap-1 border-r p-2 md:flex">
        <nav class="flex flex-col gap-1" aria-label="后台导航">
          {@render primaryNavButtons()}
        </nav>
      </aside>

      <!-- min-w-0：flex item 默认 min-width:auto 会放行内容固有宽（nowrap 表格行）。 -->
      <main class="min-h-0 min-w-0 flex-1">
        {#if loadError !== null}
          <div class="p-4">
            <div
              class="text-destructive mx-auto max-w-2xl rounded-md border border-destructive/40 bg-destructive/5 p-4 text-xs"
              role="alert"
            >
              后台数据加载失败：{loadError}
            </div>
          </div>
        {:else if tab.tab === 'accounts'}
          <!-- 账号管理 -->
          <div class="h-full overflow-y-auto p-4">
            <div class="mx-auto max-w-2xl space-y-3">
              <div class="flex items-center justify-between">
                <h2 class="text-sm font-medium">账号管理</h2>
                <Button size="sm" onclick={() => (createOpen = true)} data-testid="admin-create-open">+ 创建用户</Button>
              </div>
              <div class="bg-card overflow-hidden rounded-lg border">
                <!-- 桌面表格 / 移动卡片（zhumo 同款：<md 换卡片列表，字段语义不变）。 -->
                <table class="hidden w-full text-xs md:table" data-testid="admin-users-table">
                  <thead class="bg-muted/40 text-muted-foreground border-b text-left">
                    <tr>
                      <th class="px-3 py-2 font-medium">用户名</th>
                      <th class="px-3 py-2 font-medium">角色</th>
                      <th class="px-3 py-2 font-medium">状态</th>
                      <th class="px-3 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each users as user (user.username)}
                      {@const isSystem = isSystemAccount(user)}
                      <tr class="border-b last:border-b-0">
                        <td class="px-3 py-2">
                          <span class="flex items-center gap-1.5">
                            <span class="font-mono">{user.username}</span>
                            {#if isSystem}
                              <Badge variant="outline" class="shrink-0 text-[10px]">系统账户</Badge>
                            {/if}
                          </span>
                        </td>
                        <td class="px-3 py-2">
                          <Badge variant="secondary" class="text-[10px]">{user.role}</Badge>
                        </td>
                        <td class="px-3 py-2">
                          {#if user.disabled}
                            <Badge variant="destructive" class="text-[10px]">已禁用</Badge>
                          {:else}
                            正常
                          {/if}
                        </td>
                        <td class="px-3 py-2 text-right">
                          {#if isSystem}
                            <span class="text-muted-foreground text-[11px]">—</span>
                          {:else}
                            <span class="inline-flex justify-end gap-1">
                              <Button
                                size="xs"
                                variant="ghost"
                                onclick={() => {
                                  passwordTarget = user
                                  nextPassword = ''
                                  passwordError = null
                                }}
                              >
                                改密
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                disabled={busy}
                                onclick={() => void toggleDisabled(user)}
                              >
                                {user.disabled ? '启用' : '禁用'}
                              </Button>
                              <Button
                                size="xs"
                                variant="ghost"
                                class="text-destructive"
                                disabled={busy}
                                onclick={() => (deleteTarget = user)}
                              >
                                删除
                              </Button>
                            </span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
                <div class="flex flex-col divide-y md:hidden">
                  {#each users as user (user.username)}
                    {@const isSystem = isSystemAccount(user)}
                    <div class="flex flex-col gap-2 p-3">
                      <div class="flex items-center gap-1.5">
                        <span class="min-w-0 flex-1 truncate font-mono text-xs">{user.username}</span>
                        {#if isSystem}
                          <Badge variant="outline" class="shrink-0 text-[10px]">系统账户</Badge>
                        {/if}
                        <Badge variant="secondary" class="shrink-0 text-[10px]">{user.role}</Badge>
                        {#if user.disabled}
                          <Badge variant="destructive" class="shrink-0 text-[10px]">已禁用</Badge>
                        {/if}
                      </div>
                      {#if isSystem}
                        <span class="text-muted-foreground text-[11px]">—</span>
                      {:else}
                        <div class="flex flex-wrap justify-end gap-1">
                          <Button
                            size="xs"
                            variant="ghost"
                            onclick={() => {
                              passwordTarget = user
                              nextPassword = ''
                              passwordError = null
                            }}
                          >
                            改密
                          </Button>
                          <Button size="xs" variant="ghost" disabled={busy} onclick={() => void toggleDisabled(user)}>
                            {user.disabled ? '启用' : '禁用'}
                          </Button>
                          <Button
                            size="xs"
                            variant="ghost"
                            class="text-destructive"
                            disabled={busy}
                            onclick={() => (deleteTarget = user)}
                          >
                            删除
                          </Button>
                        </div>
                      {/if}
                    </div>
                  {/each}
                </div>
              </div>
              {#if accountMessage}
                <p class="text-destructive text-xs" role="alert">{accountMessage}</p>
              {/if}
              <div class="bg-card flex items-center justify-between rounded-lg border p-3">
                <div>
                  <p class="text-xs font-medium">允许匿名访问</p>
                  <p class="text-muted-foreground text-[11px]">
                    开启后前台自动以内置匿名账号访问，关闭则须登录。
                  </p>
                </div>
                <Switch
                  checked={settings?.allowAnonymous ?? false}
                  onCheckedChange={(value) => void toggleAnonymous(value)}
                  aria-label="匿名访问开关"
                  data-testid="admin-anonymous-switch"
                />
              </div>
            </div>
          </div>
        {:else if tab.tab === 'resources'}
          <!-- 资源管理（4.1/4.2/4.4 实装）：三子分区 list-detail——装饰钻库（StonesAdminView
               零改动挂载）/组合套装库（WarehouseView 零改动挂载）/素材库（AssetsLibAdmin
               服务端数据源版）。三视图均满高链组件内滚（照 kb 分区挂载形态）。 -->
          <div class="flex h-full min-h-0 flex-col p-4">
            <div class="mx-auto flex min-h-0 w-full max-w-6xl flex-1 gap-4">
              <!-- 桌面：左侧分区导航（与设置分区同款视觉） -->
              <nav
                class="bg-card/60 hidden w-40 shrink-0 flex-col gap-1 self-start rounded-lg border p-1.5 md:flex"
                aria-label="资源分区"
                data-testid="admin-resources-nav"
              >
                {#each resourceSections as item (item.id)}
                  {@const Icon = item.icon}
                  {@const active = resourceSection === item.id}
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    data-testid="admin-resources-nav-{item.id}"
                    class="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors {active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
                    onclick={() => (resourceSection = item.id)}
                  >
                    <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
                    {item.label}
                  </button>
                {/each}
              </nav>
              <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <!-- 移动：顶部横滑分区条（与设置分区同款 pill 形态） -->
                <div class="mb-3 flex gap-1 overflow-x-auto pb-0.5 md:hidden">
                  {#each resourceSections as item (item.id)}
                    {@const active = resourceSection === item.id}
                    {@const Icon = item.icon}
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      data-testid="admin-resources-nav-{item.id}"
                      class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors {active
                        ? 'border-transparent bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
                      onclick={() => (resourceSection = item.id)}
                    >
                      <Icon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {item.label}
                    </button>
                  {/each}
                </div>
                {#if resourceSection === 'stones'}
                  <!-- 装饰钻库：满高链交 StonesAdminView 内滚（零改动挂载——App dev 旗标
                       下同一挂载形态：无 props、自初始化；双入口过渡期旧入口不删）。 -->
                  <section class="bg-card min-h-0 flex-1 overflow-hidden rounded-lg border" data-testid="admin-resources-stones">
                    <StonesAdminView />
                  </section>
                {:else if resourceSection === 'sets'}
                  <!-- 组合/套装库：满高链交 WarehouseView 内滚（零改动挂载+文案改组合库）。 -->
                  <section class="bg-card min-h-0 flex-1 overflow-hidden rounded-lg border" data-testid="admin-resources-sets">
                    <WarehouseView />
                  </section>
                {:else}
                  <!-- 素材库：服务端数据源管理面（AssetsLibAdmin 新组件——本地版保留为迁移源）。 -->
                  <section class="bg-card min-h-0 flex-1 overflow-hidden rounded-lg border" data-testid="admin-resources-assets">
                    <AssetsLibAdmin />
                  </section>
                {/if}
              </div>
            </div>
          </div>
        {:else if tab.tab === 'kb'}
          <!-- 知识库（波 3 实装——zhumo KnowledgeManager 复刻：满高链组件内滚）。 -->
          <KnowledgeManager />
        {:else}
          <!-- 设置：二级 list-detail 三分区（大模型服务 / 图像处理 / 站点与安全）。
               滚动所有权按分区分型：models/image-processing 满高链组件内滚
               （零改动挂载语义不变），site 页面级滚动。 -->
          <div class="flex h-full min-h-0 flex-col p-4">
            <div class="mx-auto flex min-h-0 w-full max-w-4xl flex-1 gap-4">
              <!-- 桌面：左侧分区导航（与一级 aside nav 同款视觉） -->
              <nav
                class="bg-card/60 hidden w-40 shrink-0 flex-col gap-1 self-start rounded-lg border p-1.5 md:flex"
                aria-label="设置分区"
                data-testid="admin-settings-nav"
              >
                {#each settingSections as item (item.id)}
                  {@const Icon = item.icon}
                  {@const active = section === item.id}
                  <button
                    type="button"
                    aria-current={active ? 'true' : undefined}
                    data-testid="admin-settings-nav-{item.id}"
                    class="flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium transition-colors {active
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
                    onclick={() => (section = item.id)}
                  >
                    <Icon class="h-4 w-4 shrink-0" aria-hidden="true" />
                    {item.label}
                  </button>
                {/each}
              </nav>
              <div class="flex min-h-0 min-w-0 flex-1 flex-col">
                <!-- 移动：顶部横滑分区条 -->
                <div class="mb-3 flex gap-1 overflow-x-auto pb-0.5 md:hidden">
                  {#each settingSections as item (item.id)}
                    {@const active = section === item.id}
                    {@const Icon = item.icon}
                    <button
                      type="button"
                      aria-current={active ? 'true' : undefined}
                      data-testid="admin-settings-nav-{item.id}"
                      class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors {active
                        ? 'border-transparent bg-primary/10 text-primary'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
                      onclick={() => (section = item.id)}
                    >
                      <Icon class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {item.label}
                    </button>
                  {/each}
                </div>
                {#if section === 'models'}
                  <!-- models：满高链交 ModelsConfig 内滚（零改动挂载）。 -->
                  <section class="bg-card min-h-0 flex-1 rounded-lg border p-4">
                    <ModelsConfig />
                  </section>
                {:else if section === 'image-processing'}
                  <!-- image-processing：满高链交 ImageProcessingConfig 内滚（零改动挂载）。 -->
                  <section class="bg-card min-h-0 flex-1 rounded-lg border p-4">
                    <ImageProcessingConfig />
                  </section>
                {:else}
                  <!-- site：页面级滚动 -->
                  <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
                    <section class="bg-card rounded-lg border p-4">
                      <h2 class="mb-3 text-sm font-medium">站点与安全</h2>
                      <div class="space-y-3">
                        <label class="flex flex-col gap-1 text-xs">
                          <span class="text-muted-foreground">站点名称（顶栏与登录页展示）</span>
                          <Input
                            class="h-8 max-w-sm text-xs"
                            value={siteNameDraft ?? settings?.siteName ?? ''}
                            onchange={(event) => (siteNameDraft = event.currentTarget.value)}
                            data-testid="admin-site-sitename-input"
                          />
                        </label>
                        <div class="flex items-center gap-3">
                          <Button size="sm" disabled={busy} onclick={() => void saveSiteName()} data-testid="admin-site-save">
                            保存
                          </Button>
                          {#if siteMessage}
                            <span class="text-muted-foreground text-[11px]" data-testid="admin-site-message">{siteMessage}</span>
                          {/if}
                        </div>
                      </div>
                    </section>
                  </div>
                {/if}
              </div>
            </div>
          </div>
        {/if}
      </main>
    </div>

    <!-- 移动一级导航抽屉（zhumo 同款：左抽屉 + 标题行内关闭）。 -->
    <Sheet.Root bind:open={navOpen}>
      <Sheet.Content side="left" class="w-60 gap-0 p-0" showCloseButton={false}>
        <Sheet.Header class="flex-row items-center justify-between border-b px-3 py-2">
          <Sheet.Title class="text-muted-foreground text-xs font-medium">后台导航</Sheet.Title>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="关闭导航"
            onclick={() => (navOpen = false)}
          >
            <IconX class="size-4" aria-hidden="true" />
          </Button>
        </Sheet.Header>
        <nav class="flex flex-col gap-1 p-2" aria-label="后台导航（移动）">
          {@render primaryNavButtons()}
        </nav>
      </Sheet.Content>
    </Sheet.Root>
  {/if}
</div>

<!-- 创建用户 Dialog（不开放注册，仅管理员创建）。 -->
<Dialog.Root bind:open={createOpen}>
  <Dialog.Content class="max-w-sm p-5" data-testid="admin-create-dialog">
    <Dialog.Title class="text-sm font-medium">创建用户</Dialog.Title>
    <Dialog.Description class="text-muted-foreground mt-1 text-[11px]">
      本站不开放注册，仅管理员创建。
    </Dialog.Description>
    <div class="mt-3 flex flex-col gap-2">
      <Input bind:value={newUsername} placeholder="用户名" class="h-8 text-xs" data-testid="admin-create-username" />
      <Input bind:value={newPassword} type="password" placeholder="密码（≥8 位）" class="h-8 text-xs" data-testid="admin-create-password" />
      {#if createError}
        <p class="text-destructive text-xs" role="alert">{createError}</p>
      {/if}
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (createOpen = false)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void createUser()} data-testid="admin-create-submit">创建</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 改密 Dialog -->
<Dialog.Root
  open={passwordTarget !== null}
  onOpenChange={(open) => {
    if (!open) passwordTarget = null
  }}
>
  <Dialog.Content class="max-w-sm p-5" data-testid="admin-password-dialog">
    <Dialog.Title class="text-sm font-medium">修改密码 · {passwordTarget?.username ?? ''}</Dialog.Title>
    <div class="mt-3 flex flex-col gap-2">
      <Input bind:value={nextPassword} type="password" placeholder="新密码（≥8 位）" class="h-8 text-xs" data-testid="admin-password-next" />
      {#if passwordError}
        <p class="text-destructive text-xs" role="alert">{passwordError}</p>
      {/if}
    </div>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (passwordTarget = null)}>取消</Button>
      <Button size="sm" disabled={busy} onclick={() => void changePassword()} data-testid="admin-password-submit">确认</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 删除账号确认（数据级联清理警示，不可恢复）。 -->
<Dialog.Root
  open={deleteTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteTarget = null
  }}
>
  <Dialog.Content class="max-w-sm p-5" data-testid="admin-delete-dialog">
    <Dialog.Title class="text-sm font-medium">删除账号 · {deleteTarget?.username ?? ''}</Dialog.Title>
    <Dialog.Description class="text-destructive mt-1 text-[11px] leading-snug">
      删除将清理该账号的全部数据（会话、任务与素材）且不可恢复。
    </Dialog.Description>
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (deleteTarget = null)}>取消</Button>
      <Button variant="destructive" size="sm" disabled={busy} onclick={() => void deleteAccount()} data-testid="admin-delete-submit">
        确认删除
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
