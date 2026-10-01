<!--
  MySetsSection.svelte——「我的材料 → 我的贴砖组合」子区（restructure-materials-story
  W2b，2026-09-30 Owner 故事·组套/归档环：自建组合跟着账号走）。
  组合卡片网格：名称/成员数/更新时间/开工/删除（确认 Dialog——软删回收站语义）。
  创建入口：CreateSetDialog（components/stones-admin——W2a 产出，接口契约冻结
  <CreateSetDialog open onclose ownerScope="personal" oncreated />；owner=当前
  认证账户由服务端注入——Daemon 侧创建恒绑当前用户）。
  数据面：lib/myMaterials/sets.svelte.ts（sets.list owner 收窄——admin 显式本人/
  其余身份服务端恒收窄）。
  状态机：加载/错误/删除 busy 锁（全生命周期——杜绝幽灵操作）。
  详情面（Owner 验收 2026-09-30：点卡片要有反应）：卡片=button 语义可点开
  SetDetailSheet（右滑出组合详情——成员快照渐进渲染+T4 编辑态）；删除/开工按钮
  stopPropagation 不触发详情；键盘可达（Enter/Space）。
  [product-polish-w1 T2] 开工 CTA：createSession（标题=组合名）+queueComposerSetPreset
  预选该组合（新会话 Composer 选择器）+切前台 Agent 视图——N1 动线「挑组合→开工」
  一步进首条消息。
  [product-polish-w1 T4] 材料市场组合分组：scope=market 只读组（默认折叠；与我的组
  resourceId 去重）——卡片开 SetDetailSheet 市场模式（只读快照+「复制到我的材料」）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import CreateSetDialog from '../stones-admin/CreateSetDialog.svelte'
  import SetDetailSheet from './SetDetailSheet.svelte'
  import Layers from '@lucide/svelte/icons/layers'
  import Plus from '@lucide/svelte/icons/plus'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Rocket from '@lucide/svelte/icons/rocket'
  import Store from '@lucide/svelte/icons/store'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import {
    deleteMySet,
    getMarketSets,
    getMarketSetsState,
    getMySets,
    getMySetsError,
    getMySetsState,
    initMarketSets,
    initMySets,
    isMySetsDeleting,
    refreshMarketSets,
    refreshMySets,
  } from '$lib/myMaterials/sets.svelte'
  import { createSession, getAgentError, initAgentStore } from '$lib/agentApi/store.svelte'
  import { queueComposerSetPreset } from '$lib/agentApi/composerOutbox.svelte'
  import { setView } from '$lib/stores/view.svelte'
  import { navigate } from '$lib/router.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { SetsCreateResult } from '$lib/warehouse/client'
  import type { SetSummary } from '$lib/warehouse/schemas'

  /** CreateSetDialog 开合（ownerScope=personal——我的材料创建入口）。 */
  let createOpen = $state(false)

  /** 待删除组合（确认 Dialog 目标）。 */
  let deleteTarget = $state<{ resourceId: string; name: string } | null>(null)

  /** 详情面板目标（null=卸载——SetDetailSheet 经 sets.get 拉成员快照；market=只读市场模式）。 */
  let detailTarget = $state<{ summary: SetSummary; market: boolean } | null>(null)

  /** 详情面板受控开合：关闭先收动画（open=false），250ms 后再卸载目标——bits-ui
   *  关闭过渡帧不能读已销毁引用（存量 unhandled rejection 修复）。 */
  let detailOpen = $state(true)

  function openDetail(summary: SetSummary, market: boolean): void {
    detailTarget = { summary, market }
    detailOpen = true
  }

  function closeDetail(): void {
    detailOpen = false
    const closing = detailTarget
    setTimeout(() => {
      if (detailTarget === closing) detailTarget = null
    }, 250)
  }

  /** 开工 busy 锁（一次一个——createSession 串行化）。 */
  let startingId = $state<string | null>(null)

  /** 材料市场分组折叠态（默认折叠——宁可藏，不可摊）。 */
  let marketOpen = $state(false)

  // store 读面（getter 派生——Svelte 5 模块 $state 经访问器保持响应式）。
  const sets = $derived(getMySets())
  const loading = $derived(getMySetsState() === 'loading')
  const error = $derived(getMySetsError())
  const deleting = $derived(isMySetsDeleting())
  const marketLoading = $derived(getMarketSetsState() === 'loading')
  /** 市场组（与我的组 resourceId 去重——admin 自有组合进我的组，不重复陈列）。 */
  const marketSets = $derived.by(() => {
    const mineIds = new Set(sets.map((set) => set.resourceId))
    return getMarketSets().filter((set) => !mineIds.has(set.resourceId))
  })

  /** 更新时间呈现（本地化短格式——卡片行内弱化）。 */
  function formatUpdatedAt(iso: string): string {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
  }

  async function commitDelete(): Promise<void> {
    if (deleteTarget === null) return
    const target = deleteTarget
    deleteTarget = null
    await deleteMySet(target.resourceId)
  }

  /**
   * 开工（product-polish-w1 T2——N1 动线「挑组合→开工」）：createSession（标题=
   * 组合名）→预选注入（composerOutbox 单槽——新会话 Composer 集合选择器预选该
   * 组合，发送首条消息即带 sourceSetId）→切前台 Agent 视图。
   */
  async function startFromSet(set: SetSummary): Promise<void> {
    if (startingId !== null) return
    startingId = set.resourceId
    try {
      await initAgentStore() // 幂等（前台已挂载则零调用——后台直达也保证 api 绑定）
      await createSession(set.name)
      // store 的 createSession 经 guard 吞错（storeError 面）——此处显式复核：失败
      // 即抛（不注入预选/不跳转，开工链原子）。
      const failure = getAgentError()
      if (failure !== null) throw new Error(failure)
      // 预选注入在会话创建成功之后（失败不残留半链——前台挂载 SessionStream 才消费）。
      queueComposerSetPreset({
        resourceId: set.resourceId,
        setId: set.setId,
        name: set.name,
        memberCount: set.memberCount,
        updatedAt: set.updatedAt,
        scope: 'mine',
      })
      setView('agent')
      navigate('#/')
      showToast(`已开新会话「${set.name}」——发送首条消息即开工`)
    } catch (error) {
      showToast(`开工失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      startingId = null
    }
  }

  /** 市场复制成功（T1/T4）：副本已进我的组——详情切到副本（可编辑）。 */
  function onMarketCopied(created: SetsCreateResult): void {
    const copy = getMySets().find((set) => set.resourceId === created.resourceId)
    detailTarget = copy !== undefined ? { summary: copy, market: false } : null
  }

  onMount(() => {
    void initMySets()
    void initMarketSets()
  })
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="my-sets-section">
  <!-- 工具行 -->
  <div class="bg-background/80 flex flex-wrap items-center gap-2 border-b px-3 py-2 backdrop-blur" data-testid="my-sets-toolbar">
    <Button size="sm" class="h-8" disabled={loading || deleting} onclick={() => void refreshMySets()} data-testid="my-sets-refresh" title="重载本人组合清单">
      <RefreshCw class="size-3.5" aria-hidden="true" />
      刷新
    </Button>
    <!-- 创建组合：CreateSetDialog（ownerScope=personal——创建后刷新本人清单）。 -->
    <Button
      size="sm"
      class="h-8"
      onclick={() => (createOpen = true)}
      title="新建本人贴砖组合"
      data-testid="my-sets-create"
    >
      <Plus class="size-3.5" aria-hidden="true" />
      创建组合
    </Button>
    <span class="text-muted-foreground ml-auto text-xs" data-testid="my-sets-count">{sets.length} 个组合</span>
  </div>

  {#if error !== null}
    <div class="flex items-center gap-2 border-b px-3 py-1.5">
      <p class="border-destructive/30 bg-destructive/10 text-destructive flex-1 px-2 py-1 text-xs" data-testid="my-sets-error" role="alert">{error}</p>
      <Button size="sm" variant="outline" class="h-8" disabled={loading} onclick={() => void refreshMySets()}>重试</Button>
    </div>
  {/if}

  <main class="bg-muted/30 min-h-0 flex-1 overflow-y-auto p-3" data-testid="my-sets-grid">
    {#if loading}
      <p class="text-muted-foreground py-16 text-center text-sm" role="status">本人组合加载中…</p>
    {:else if sets.length === 0}
      <div class="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center" data-testid="my-sets-empty">
        <Layers class="size-8 opacity-40" aria-hidden="true" />
        <p class="text-sm">还没有自己的贴砖组合</p>
        <p class="text-xs opacity-80">接单后从材料市场挑钻组套，常用系列存在这里随取随用</p>
      </div>
    {:else}
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {#each sets as set (set.resourceId)}
          <!-- 卡片=button 语义可点开详情 Sheet（div+role——内含操作 Button，不可嵌
               button 于 button；键盘 Enter/Space，目标守卫防内层按钮冒泡误开）。 -->
          <div
            role="button"
            tabindex="0"
            aria-label="查看组合 {set.name} 详情"
            class="bg-card hover:border-primary/50 focus-visible:ring-ring outline-none focus-visible:ring-2 flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors"
            data-testid="my-sets-card-{set.resourceId}"
            onclick={() => openDetail(set, false)}
            onkeydown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                openDetail(set, false)
              }
            }}
          >
            <div class="flex min-w-0 items-start gap-1.5">
              <Layers class="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span class="min-w-0 flex-1 truncate text-sm font-medium" title={set.name}>{set.name}</span>
            </div>
            <div class="flex items-center gap-1.5">
              <Badge variant="secondary" class="text-[10px]">{set.memberCount} 款钻</Badge>
              {#if set.purpose}
                <span class="text-muted-foreground min-w-0 flex-1 truncate text-[10px]" title={set.purpose}>{set.purpose}</span>
              {/if}
            </div>
            <div class="text-muted-foreground text-[10px]" title={set.updatedAt}>更新于 {formatUpdatedAt(set.updatedAt)}</div>
            <div class="mt-auto flex items-center justify-end gap-1">
              <!-- 开工（T2）：createSession+预选该组合——N1「挑组合→开工」一步进首条消息。 -->
              <Button
                size="xs"
                disabled={startingId !== null}
                onclick={(event) => {
                  event.stopPropagation()
                  void startFromSet(set)
                }}
                data-testid="my-sets-start-{set.resourceId}"
                title="开新会话并预选该组合（发送首条消息即带集合清单）"
              >
                <Rocket class="size-3" aria-hidden="true" />
                {startingId === set.resourceId ? '开工中…' : '开工'}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                class="text-destructive"
                disabled={deleting}
                onclick={(event) => {
                  event.stopPropagation()
                  deleteTarget = { resourceId: set.resourceId, name: set.name }
                }}
                data-testid="my-sets-delete-{set.resourceId}"
              >
                <Trash2 class="size-3" aria-hidden="true" />
                删除
              </Button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    <!-- 材料市场组合分组（product-polish-w1 T4——A1「组合=材料的另一种打开方式」：
         市场是「行业有什么」，我的组是「我选了什么」。默认折叠；卡片开只读详情+
         复制 CTA（复制后进我的组、可编辑、可开工）。 -->
    {#if marketSets.length > 0}
      <section class="mt-4" data-testid="my-sets-market-section">
        <button
          type="button"
          class="hover:bg-muted/60 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-medium transition-colors"
          aria-expanded={marketOpen}
          data-testid="my-sets-market-toggle"
          onclick={() => (marketOpen = !marketOpen)}
        >
          <ChevronDown class="text-muted-foreground size-3.5 shrink-0 transition-transform {marketOpen ? '' : '-rotate-90'}" aria-hidden="true" />
          <Store class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
          <span>材料市场组合</span>
          <span class="text-muted-foreground font-normal">（{marketSets.length}）</span>
          {#if marketLoading}
            <span class="text-muted-foreground ml-auto font-normal text-[10px]">刷新中…</span>
          {:else}
            <span class="text-muted-foreground ml-auto font-normal text-[10px]">管理员共享 · 复制到我的材料后可编辑</span>
          {/if}
        </button>
        {#if marketOpen}
          <div class="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {#each marketSets as set (set.resourceId)}
              <div
                role="button"
                tabindex="0"
                aria-label="查看市场组合 {set.name}（只读快照）"
                class="bg-card/60 hover:border-primary/50 focus-visible:ring-ring outline-none focus-visible:ring-2 flex cursor-pointer flex-col gap-1.5 rounded-lg border border-dashed p-3 transition-colors"
                data-testid="my-sets-market-card-{set.resourceId}"
                onclick={() => openDetail(set, true)}
                onkeydown={(event) => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    openDetail(set, true)
                  }
                }}
              >
                <div class="flex min-w-0 items-start gap-1.5">
                  <Store class="text-primary/70 mt-0.5 size-4 shrink-0" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate text-sm font-medium" title={set.name}>{set.name}</span>
                </div>
                <div class="flex items-center gap-1.5">
                  <Badge class="bg-primary/10 text-primary text-[10px]" data-testid="my-sets-market-badge-{set.resourceId}">市场</Badge>
                  <Badge variant="secondary" class="text-[10px]">{set.memberCount} 款钻</Badge>
                </div>
                <div class="text-muted-foreground text-[10px]" title={set.updatedAt}>更新于 {formatUpdatedAt(set.updatedAt)}</div>
                <div class="text-muted-foreground mt-auto text-[10px]">只读快照 · 点开复制到我的材料</div>
              </div>
            {/each}
          </div>
        {/if}
      </section>
    {/if}
  </main>
</div>

<!-- 创建组合 Dialog（W2a 冻结契约组件——owner=当前认证账户；成功后刷新本人清单） -->
<CreateSetDialog
  open={createOpen}
  onclose={() => (createOpen = false)}
  ownerScope="personal"
  oncreated={() => void refreshMySets()}
/>

<!-- 组合详情 Sheet（Owner 验收 2026-09-30 + T4 编辑态/市场模式——成员快照渐进渲染）。
     关闭时序（存量 unhandled 修复）：bits-ui Sheet 关闭动画期间组件仍渲染一帧——
     立即置 null 会让该帧读到空 summary 抛 unhandled rejection；关闭先走动画，
     250ms 后再卸载数据（引用比较防误清新目标）。 -->
{#if detailTarget !== null}
  <SetDetailSheet
    summary={detailTarget.summary}
    market={detailTarget.market}
    open={detailOpen}
    oncopied={onMarketCopied}
    onsaved={() => void refreshMySets()}
    onclose={closeDetail}
  />
{/if}

<!-- 删除确认 Dialog（软删=回收站语义——成员引用的标准钻不受影响） -->
<Dialog.Root
  open={deleteTarget !== null}
  onOpenChange={(open) => {
    if (!open) deleteTarget = null
  }}
>
  <Dialog.Content class="max-w-sm p-5" data-testid="my-sets-delete-dialog">
    <Dialog.Title class="text-sm font-medium">删除组合 · {deleteTarget?.name ?? ''}</Dialog.Title>
    <Dialog.Description class="text-muted-foreground mt-2 text-xs leading-relaxed">
      删除后组合进入回收站（软删），其中的标准钻不受影响。会话里引用该组合的历史不受影响，但新建项目将无法再选它。
    </Dialog.Description>
    {#if error}
      <p class="text-destructive mt-2 text-xs" role="alert">{error}</p>
    {/if}
    <Dialog.Footer class="mt-4">
      <Button variant="ghost" size="sm" onclick={() => (deleteTarget = null)}>取消</Button>
      <Button variant="destructive" size="sm" disabled={deleting} onclick={() => void commitDelete()} data-testid="my-sets-delete-confirm">确认删除</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
