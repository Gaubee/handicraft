<!--
TaskWorkbenchView.svelte — 任务详情工作台主视图（add-task-detail-layer-workbench 2.2-2.5；
add-workbench-pro 2.1-2.3+2c 增量）。
四态：装载（loading/idle）/错误（可重试）/无图层树引导（管线未跑到）/内容态。
布局：顶部任务条（标题+状态+返回+导出门）｜左=图层管理（LayerPanel 可编辑版——
2c 拖拽重排/删除/事务历史）｜右上=画布舞台（WorkbenchCanvasStage：StrategyCanvas
视口取景+滚轮锚定缩放/平移/层命中+笔刷层+工具条+状态栏）｜右下=策略卡（D-1 直接生效）。
数据：task.detail RPC 装载（store.svelte.ts）——baseImage/gems 字节经附件通道拉取；
波 2a 三新面（viewState/maskEdits/exportGate）+笔刷闭环（layer.mask.patch）。
导出门（2.1）：exportGate.allowed=false → 导出按钮禁用+blockers 列表（门只增不减）。
快捷键（2c 命令总线——commands.ts 单源：V/H/Z/B/Delete/F2/Esc/⌘Z 域路由/[ ]/?；
IME/输入框焦点保护=canvaskit isEditableTarget+isComposing——§0 复用红线）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import WorkbenchLayerPanel from './WorkbenchLayerPanel.svelte'
  import WorkbenchParamsPanel from './WorkbenchParamsPanel.svelte'
  import WorkbenchCanvasStage from './WorkbenchCanvasStage.svelte'
  import WorkbenchShortcutsHelp from './WorkbenchShortcutsHelp.svelte'
  import { openSession } from '$lib/agentApi/store.svelte'
  import { closeStudioTask, setView } from '$lib/stores/view.svelte'
  import { handleWorkbenchKeydown } from './commands.js'
  import {
    getExportError,
    getExportGate,
    getRenameError,
    getWorkbenchDetail,
    getWorkbenchLoadError,
    getWorkbenchPhase,
    getWorkbenchNodes,
    exportTask,
    isExporting,
    loadWorkbench,
    requestNodeMasksForTree,
  } from './store.svelte'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import Download from '@lucide/svelte/icons/download'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  let { taskId }: { taskId: string } = $props()

  // 装载：taskId 变化即重装载（StudioView 路由保证非空任务上下文）。
  $effect(() => {
    void loadWorkbench(taskId)
  })

  // mask 位面渐进请求（nodes/tree 变化→inline 同步/blob 异步——maskBits 缓存面）
  $effect(() => {
    void getWorkbenchNodes()
    void getWorkbenchDetail()
    requestNodeMasksForTree()
  })

  const phase = $derived(getWorkbenchPhase())
  const detail = $derived(getWorkbenchDetail())
  const exportGate = $derived(getExportGate())
  const exporting = $derived(isExporting())
  const exportError = $derived(getExportError())

  /** 导出按钮：门阻禁用（blockers 列表就近呈现——门只增不减，无客户端豁免口）。 */
  async function onExport(): Promise<void> {
    await exportTask()
  }

  /** 快捷键（2c 命令总线单源——IME/输入框焦点保护在分派入口统一判定）。 */
  function onKeydown(event: KeyboardEvent): void {
    handleWorkbenchKeydown(event)
  }

  /** 返回 Agent 会话：清任务上下文（studio 回模式选择）+打开该任务的会话。 */
  function onBack(): void {
    const session = detail?.session ?? null
    closeStudioTask()
    if (session !== null) void openSession(session.id)
    setView('agent')
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-testid="task-workbench">
  {#if phase === 'ready' && detail !== null && detail.tree !== null}
    <!-- 顶部：任务标题+状态+返回 Agent 会话+导出门（工作台显眼位） -->
    <header
      class="bg-background/80 flex h-12 shrink-0 items-center gap-3 border-b px-3 backdrop-blur"
      data-testid="workbench-topbar"
    >
      <Button variant="ghost" size="sm" onclick={onBack} data-testid="workbench-back">
        <ArrowLeft class="size-3.5" aria-hidden="true" />
        返回 Agent 会话
      </Button>
      <h2 class="truncate text-sm font-semibold" data-testid="workbench-title" title={detail.task.title ?? detail.task.id}>
        {detail.task.title ?? detail.task.id}
      </h2>
      <Badge variant={detail.task.status === 'done' ? 'secondary' : 'outline'} data-testid="workbench-task-status">
        {detail.task.status}
      </Badge>
      {#if detail.session !== null}
        <span class="text-muted-foreground hidden truncate text-xs sm:inline" title={detail.session.title}>
          {detail.session.title}
        </span>
      {/if}
      <span class="text-muted-foreground shrink-0 font-mono text-xs" data-testid="workbench-gem-count">
        {detail.gems !== null ? `${detail.gems.count} 颗 · ${detail.gems.excludedRegions} 处留白` : '尚无排钻产物'}
      </span>
      <!-- 导出门（2.1）：allowed=false 禁用+blockers 列表；放行=task.export 下载产物 -->
      <div class="ml-auto flex shrink-0 items-center gap-1.5" data-testid="workbench-export-gate">
        {#if !exportGate.allowed}
          <span
            class="text-destructive flex items-center gap-1 text-[11px]"
            data-testid="workbench-export-blockers"
            title={exportGate.blockers.join('、')}
            role="alert"
          >
            <TriangleAlert class="size-3" aria-hidden="true" />
            导出阻断：{exportGate.blockers.join('、')}
          </span>
        {/if}
        <Button
          size="sm"
          variant="outline"
          class="h-7 px-2 text-[11px]"
          disabled={!exportGate.allowed || exporting}
          onclick={() => void onExport()}
          data-testid="workbench-export-button"
          title={exportGate.allowed ? '导出排钻设计（strategy-gems.json）' : `导出被门阻：${exportGate.blockers.join('、')}`}
        >
          <Download class="size-3" aria-hidden="true" />
          {exporting ? '导出中…' : '导出'}
        </Button>
      </div>
    </header>

    {#if exportError !== null}
      <div class="text-destructive bg-destructive/5 border-b px-3 py-1 text-[11px]" data-testid="workbench-export-error" role="alert">
        {exportError}
      </div>
    {/if}

    <!-- 中段：左=图层管理 ｜ 右=画布（上）+策略卡（下） -->
    <div class="bg-background/40 flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row" data-testid="workbench-mid">
      <aside
        class="bg-background w-full shrink-0 border-b lg:w-72 lg:min-h-0 lg:border-r lg:border-b-0 max-lg:max-h-[40%]"
        data-testid="workbench-layer-slot"
        aria-label="图层管理"
      >
        <WorkbenchLayerPanel />
      </aside>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- 画布舞台（2c：视口取景+滚轮锚定缩放/空格·中键平移/层命中+笔刷层+工具条+状态栏） -->
        <WorkbenchCanvasStage />
        <div class="bg-background h-72 shrink-0 border-t max-lg:h-80" data-testid="workbench-params-slot" aria-label="图层策略">
          <WorkbenchParamsPanel />
        </div>
      </div>
    </div>

    <!-- ? 命令速查（命令总线驱动——Esc 关闭） -->
    <WorkbenchShortcutsHelp />


    {#if getRenameError() !== null}
      <!-- 兜底横幅（面板内已有就近错误位——此处仅防溢出场景） -->
      <div class="text-destructive border-t px-3 py-1 text-[11px]" role="alert">{getRenameError()}</div>
    {/if}
  {:else if phase === 'ready' && detail !== null && detail.tree === null}
    <!-- 内容子态：管线未产出图层树——引导回 Agent 会话（识图/抠图在会话旅程） -->
    <div class="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-testid="workbench-no-tree">
      <p class="text-foreground text-sm font-medium">该任务尚无图层树</p>
      <p class="max-w-sm text-xs leading-relaxed">
        任务详情的图层管理/策略直改依赖识图抠图产物（object-tree 工件）。回 Agent 会话上传图并声明厘米尺寸，完成识图后即可在此继续。
      </p>
      <Button variant="outline" size="sm" onclick={onBack} data-testid="workbench-no-tree-back">
        <ArrowLeft class="size-3.5" aria-hidden="true" />
        返回 Agent 会话
      </Button>
    </div>
  {:else if phase === 'error'}
    <!-- 错误态：可重试（loadSeq 作废迟到结果） -->
    <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="workbench-error" role="alert">
      <p class="text-destructive text-sm font-medium">任务详情装载失败</p>
      <p class="text-muted-foreground max-w-md text-xs leading-relaxed">{getWorkbenchLoadError()}</p>
      <Button variant="outline" size="sm" onclick={() => void loadWorkbench(taskId)} data-testid="workbench-retry">
        <RefreshCw class="size-3.5" aria-hidden="true" />
        重试
      </Button>
    </div>
  {:else}
    <!-- 装载态（idle/loading 同呈现——task.detail+两工件字节在途） -->
    <div class="flex h-full flex-col items-center justify-center gap-2 p-6" data-testid="workbench-loading">
      <RefreshCw class="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
      <p class="text-muted-foreground animate-pulse text-sm">任务详情装载中…</p>
    </div>
  {/if}
</div>
