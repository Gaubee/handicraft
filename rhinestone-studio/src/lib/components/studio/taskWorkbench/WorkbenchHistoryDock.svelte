<!--
WorkbenchHistoryDock.svelte — 工作台历史事务面板（add-workbench-pro v3 Owner 整改：
2c 的事务历史区埋在左栏底部=不可见/不工作体感三连——迁底部全宽 dock+可见性提升；
rework-workbench-rail-drawers 2.2 迁右侧 Drawer 槽位）。
可折叠面板：收起=细条（版本计数徽标常显）；展开=版本链时间线（tree.history——
每条=版本号/动作 cause/描述/时间/回退按钮；journey 基线行=Agent 会话产树入链，
v3 播种语义见 daemon treeHistory）。回退确认面（D-3 透明化）就近内嵌；确认后全刷
（store.confirmTreeRevert → loadWorkbench refresh）。
[w19-critic P2] Drawer 槽位外控开合：抽屉 open 由 rail 状态机喂入（open/ontoggle
注入时本面板开合权威外移——抽屉开=时间线体直接在场；此前内部 open 缺省 false，
Drawer 打开只见「N 版」计数行、时间线体要二次点击才出现=「列表渲染空」体感）。
旧宿主（自管开合）不传 props 时行为不变（toggleTreeHistoryPanel 自管+开面拉取）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import {
    cancelPendingTreeRevert,
    confirmTreeRevert,
    getPendingTreeRevert,
    getTreeHistoryState,
    requestTreeRevert,
    toggleTreeHistoryPanel,
  } from './store.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import History from '@lucide/svelte/icons/history'
  import Undo2 from '@lucide/svelte/icons/undo-2'

  let {
    /** 外控开合（Drawer 槽位注入——开合权威=抽屉；缺省=自管（旧宿主兼容）。 */
    open = undefined,
    /** 外控开合回调（注入时标题行点击走外层——如 rail.toggle('history') 收抽屉）。 */
    ontoggle = undefined,
  }: { open?: boolean; ontoggle?: (() => void) | null } = $props()

  const treeHistory = $derived(getTreeHistoryState())
  const pendingTreeRevert = $derived(getPendingTreeRevert())
  /** 生效开合=并集：外控（Drawer open）∪ 自管（treeHistory.open——测试/旧宿主直驱
   *  toggleTreeHistoryPanel 不被外控压制；Drawer 关+自管开的体藏在隐形抽屉内无害）。 */
  const panelOpen = $derived(treeHistory.open || open === true)
  const latestVersion = $derived(treeHistory.versions.length > 0 ? treeHistory.versions[treeHistory.versions.length - 1]!.version : null)

  /** 标题行开合动作：外控走回调（收抽屉）；自管走 store 开面+拉取。 */
  function onToggle(): void {
    if (ontoggle !== undefined && ontoggle !== null) ontoggle()
    else toggleTreeHistoryPanel()
  }

  /** cause 徽标样式（journey=Agent 会话产树——outline 区分工作台写）。 */
  function causeVariant(cause: string): 'default' | 'secondary' | 'outline' | 'destructive' {
    if (cause === 'journey') return 'outline'
    if (cause === 'mask-patch') return 'secondary'
    if (cause === 'delete') return 'destructive'
    return 'secondary'
  }

  const CAUSE_LABELS: Record<string, string> = {
    'segment-one': '拆层',
    rename: '重命名',
    reorder: '重排',
    delete: '删除',
    'mask-patch': '笔刷编辑',
    revert: '回退',
    journey: '会话产树',
  }

  /** 时间线呈现（HH:MM:SS——同日省日期；跨日补日期）。 */
  function timeLabel(iso: string): string {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return '—'
    const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
    return hm
  }
</script>

<div class="bg-background flex shrink-0 flex-col border-t" data-testid="workbench-tree-history">
  <button
    type="button"
    class="hover:bg-accent/50 flex h-8 shrink-0 items-center gap-2 px-3 text-[11px] transition-colors"
    onclick={onToggle}
    aria-expanded={panelOpen}
    data-testid="workbench-tree-history-toggle"
  >
    {#if panelOpen}
      <ChevronDown class="text-muted-foreground size-3.5" aria-hidden="true" />
    {:else}
      <ChevronRight class="text-muted-foreground size-3.5" aria-hidden="true" />
    {/if}
    <History class="text-muted-foreground size-3.5" aria-hidden="true" />
    <span class="font-medium">历史事务</span>
    {#if treeHistory.loading}
      <span class="text-muted-foreground/70 animate-pulse text-[10px]" data-testid="workbench-tree-history-loading">版本链读取中…</span>
    {:else if treeHistory.error !== null}
      <span class="text-destructive truncate text-[10px]" role="alert" data-testid="workbench-tree-history-error">{treeHistory.error}</span>
    {:else}
      <Badge variant="outline" class="px-1.5 text-[10px]" data-testid="workbench-tree-history-count">
        {treeHistory.versions.length > 0 ? `${treeHistory.versions.length} 版${latestVersion !== null ? ` · 当前 v${latestVersion}` : ''}` : '暂无版本'}
      </Badge>
    {/if}
    <span class="text-muted-foreground/70 ml-auto hidden text-[10px] sm:inline">版本链时间线——任意版本可整树回退（回退自身入史）</span>
  </button>

  {#if panelOpen}
    <div class="scrollbar-thin max-h-52 overflow-y-auto border-t px-3 py-2" data-testid="workbench-tree-history-body">
      {#if !treeHistory.loading && treeHistory.error === null && treeHistory.versions.length === 0}
        <p class="text-muted-foreground px-1 py-3 text-center text-[11px]" data-testid="workbench-tree-history-empty">
          尚无版本——拆层/重命名/重排/删除/笔刷编辑后入史；Agent 会话产树自动入链
        </p>
      {:else}
        <ol class="relative ml-1 border-l pl-3" data-testid="workbench-tree-history-timeline">
          {#each [...treeHistory.versions].reverse() as version (version.version)}
            {@const isLatest = version.version === latestVersion}
            <li
              class="relative flex items-center gap-2 py-1 text-[11px]"
              data-testid="workbench-tree-history-row"
              data-version={version.version}
            >
              <span class="absolute top-1/2 -left-[17px] size-1.5 -translate-y-1/2 rounded-full {isLatest ? 'bg-primary' : 'bg-muted-foreground/50'}" aria-hidden="true"></span>
              <span class="text-muted-foreground w-8 shrink-0 font-mono" title={version.createdAt}>v{version.version}</span>
              <Badge variant={causeVariant(version.cause)} class="shrink-0 px-1 text-[9px]">
                {CAUSE_LABELS[version.cause] ?? version.cause}
              </Badge>
              <span class="text-muted-foreground min-w-0 flex-1 truncate" title={version.detail ?? ''}>{version.detail ?? '—'}</span>
              <span class="text-muted-foreground/70 shrink-0 font-mono text-[10px]">{timeLabel(version.createdAt)}</span>
              {#if !isLatest}
                <button
                  type="button"
                  class="text-muted-foreground hover:text-foreground flex shrink-0 items-center gap-0.5 rounded border px-1.5 py-0.5 text-[10px] transition-colors"
                  onclick={() => void requestTreeRevert(version.version)}
                  data-testid="workbench-tree-revert-{version.version}"
                  aria-label="回退到 v{version.version}"
                  title="整树回退到该版本（tree.revert——后续版本一并回退，确认后执行）"
                >
                  <Undo2 class="size-2.5" aria-hidden="true" />
                  回退
                </button>
              {:else}
                <span class="text-primary/80 shrink-0 text-[10px]" title="当前版本">当前</span>
              {/if}
            </li>
          {/each}
        </ol>
      {/if}

      <!-- 整树回退确认面（D-3 透明化——结构域回退将一并回退 target 之后的全部中间操作） -->
      {#if pendingTreeRevert !== null}
        <div class="bg-background mt-2 rounded-md border p-2.5" data-testid="workbench-revert-confirm" role="alertdialog" aria-label="确认整树回退">
          <p class="text-xs leading-relaxed">
            回退到 v{pendingTreeRevert.targetVersion}？
            {#if pendingTreeRevert.entries.length > 0}
              <span class="text-destructive block text-[10px]">
                将一并回退 {pendingTreeRevert.entries.length} 个后续版本（含遮罩/重排交错——
                {pendingTreeRevert.entries.map((entry) => `v${entry.version} ${CAUSE_LABELS[entry.cause] ?? entry.cause}`).join('、')}）
              </span>
            {:else}
              <span class="text-muted-foreground block text-[10px]">该版本之后无其他操作。</span>
            {/if}
          </p>
          <div class="mt-2 flex gap-1.5">
            <Button size="sm" class="h-6 px-2 text-[11px]" onclick={() => void confirmTreeRevert()} data-testid="workbench-revert-confirm-ok">
              <Undo2 class="size-3" aria-hidden="true" />
              确认回退
            </Button>
            <Button size="sm" variant="outline" class="h-6 px-2 text-[11px]" onclick={cancelPendingTreeRevert} data-testid="workbench-revert-confirm-cancel">
              取消
            </Button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
