<!--
  MySetsSection.svelte——「我的材料 → 我的贴砖组合」子区（restructure-materials-story
  W2b，2026-09-30 Owner 故事·组套/归档环：自建组合跟着账号走）。
  组合卡片网格：名称/成员数/更新时间/删除（确认 Dialog——软删回收站语义）。
  创建入口：CreateSetDialog（components/stones-admin——W2a 产出，接口契约冻结
  <CreateSetDialog open onclose ownerScope="personal" oncreated />；owner=当前
  认证账户由服务端注入——Daemon 侧创建恒绑当前用户）。
  数据面：lib/myMaterials/sets.svelte.ts（sets.list owner 收窄——admin 显式本人/
  其余身份服务端恒收窄）。
  状态机：加载/错误/删除 busy 锁（全生命周期——杜绝幽灵操作）。
  详情面（Owner 验收 2026-09-30：点卡片要有反应）：卡片=button 语义可点开
  SetDetailSheet（右滑出组合详情——成员快照渐进渲染）；删除按钮 stopPropagation
  不触发详情；键盘可达（Enter/Space）。
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
  import {
    deleteMySet,
    getMySets,
    getMySetsError,
    getMySetsState,
    initMySets,
    isMySetsDeleting,
    refreshMySets,
  } from '$lib/myMaterials/sets.svelte'
  import type { SetSummary } from '$lib/warehouse/schemas'

  /** CreateSetDialog 开合（ownerScope=personal——我的材料创建入口）。 */
  let createOpen = $state(false)

  /** 待删除组合（确认 Dialog 目标）。 */
  let deleteTarget = $state<{ resourceId: string; name: string } | null>(null)

  /** 详情面板目标（null=关闭——SetDetailSheet 经 sets.get 拉成员快照）。 */
  let detailTarget = $state<SetSummary | null>(null)

  // store 读面（getter 派生——Svelte 5 模块 $state 经访问器保持响应式）。
  const sets = $derived(getMySets())
  const loading = $derived(getMySetsState() === 'loading')
  const error = $derived(getMySetsError())
  const deleting = $derived(isMySetsDeleting())

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

  onMount(() => {
    void initMySets()
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
          <!-- 卡片=button 语义可点开详情 Sheet（div+role——内含删除 Button，不可嵌
               button 于 button；键盘 Enter/Space，目标守卫防内层按钮冒泡误开）。 -->
          <div
            role="button"
            tabindex="0"
            aria-label="查看组合 {set.name} 详情"
            class="bg-card hover:border-primary/50 focus-visible:ring-ring outline-none focus-visible:ring-2 flex cursor-pointer flex-col gap-1.5 rounded-lg border p-3 transition-colors"
            data-testid="my-sets-card-{set.resourceId}"
            onclick={() => (detailTarget = set)}
            onkeydown={(event) => {
              if (event.target !== event.currentTarget) return
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                detailTarget = set
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
            <div class="mt-auto flex justify-end">
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
  </main>
</div>

<!-- 创建组合 Dialog（W2a 冻结契约组件——owner=当前认证账户；成功后刷新本人清单） -->
<CreateSetDialog
  open={createOpen}
  onclose={() => (createOpen = false)}
  ownerScope="personal"
  oncreated={() => void refreshMySets()}
/>

<!-- 组合详情 Sheet（Owner 验收 2026-09-30：点卡片开右滑出面板——成员快照渐进渲染） -->
<SetDetailSheet summary={detailTarget} onclose={() => (detailTarget = null)} />

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
