<!--
Orthogonal intents (max 4):
1. [2026-09-19 Layout 1.1 / 2026-09-20 studio-layers 2.7 四区] 上下文条 h-10 / [左列 260px（图层|历史双 tab）|
     画布 flex | 检查器 320px] / 状态条 h-12（StrategyFilmStrip h-14 整区废除——策略/物理归检查器层配置卡）。
     min-h-0/min-w-0 链逐区落实（App.svelte 全出血壳纪律）：主区零纵向滚动，滚动只发生在画布取景/
     左列列表/检查器列表内。「画布常驻/答案常驻」不变量沿用。
2. [2026-09-20 studio-layers 2.7 左列] 双 tab（图层 LayerPanel / 历史 HistoryPanel）+ ⌘Z/⇧⌘Z 键盘同源
     （与历史面板按钮同一 reducer）；tabs 常驻撤销/重做入口。
3. [2026-09-19 Mobile 4.1 / 2.7 同构] 移动端：上下文条折两行（图层/历史抽屉入口）→ 画布 flex-1 →
     状态条；左列/检查器 = bottom sheet（沿现参数抽屉先例；层多选 = 长按进入多选模式归 P1 走查）。
4. [2026-09-19 Handoff/取景转发 / 2026-09-20 studio-layers 2.8 打开意图] handoff 置位即取图载入；
     素材库/导入的 .gemproj 经 openIntent 由本页 claim → openStudioProject（失败驻留错误卡——
     来源缺失带重绑换源重放）；BlockCanvas 取景控制经 bind:this 转发（BlockCanvas 零渲染改动）。
5. [2026-09-20 add-project-files 2.6 守卫三分法] dirty 会话三分支：切 Tab 不弹（store 单例跨视图
     存活——本页不参与路由守卫）；beforeunload（svelte:window）；页内破坏性动作（openIntent 打开
     其它项目 / handoff 送排钻新建 / 缺源重绑）经 guard 域 runStudioGuarded 三按钮 Dialog
     （「保存并继续 / 不保存 / 取消」——保存复用 ④段 saveGemproj；取消 = 意图 ackFailure /
     handoff 丢弃，会话原地保持）。换来源图/空态新建的守卫接线在 StudioContextBar/BlockCanvas。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import BlockCanvas from '../../../components/Studio/BlockCanvas.svelte'
  import StudioContextBar from '../../../components/Studio/StudioContextBar.svelte'
  import Inspector from '../../../components/Studio/Inspector.svelte'
  import StudioStatusBar from '../../../components/Studio/StudioStatusBar.svelte'
  import LayerPanel from '../../../components/Studio/LayerPanel.svelte'
  import HistoryPanel from '../../../components/Studio/HistoryPanel.svelte'
  import { clearHandoff, getHandoff } from '$lib/stores/handoff.svelte'
  import {
    ackOpenIntentFailure,
    ackOpenIntentSuccess,
    claimOpenIntent,
    peekOpenIntent,
  } from '$lib/stores/openIntent.svelte'
  import { getView } from '$lib/stores/view.svelte'
  import { isStudioDirty, openStudioProject, OpenGemprojError } from '$lib/studio/projectPersistence.svelte'
  import {
    getStudioGuardError,
    isStudioGuardBusy,
    isStudioGuardOpen,
    runStudioGuarded,
    studioGuardCancel,
    studioGuardDiscard,
    studioGuardSaveAndContinue,
  } from '$lib/studio/guard.svelte'
  import {
    canRedo,
    canUndo,
    fileToDataUrl,
    getSelectedBlockId,
    loadFromHandoff,
    redoStudioOp,
    undoStudioOp,
  } from '$lib/stores/studio.svelte'
  import History from '@lucide/svelte/icons/history'
  import Layers from '@lucide/svelte/icons/layers'
  import Redo from '@lucide/svelte/icons/redo'
  import Undo from '@lucide/svelte/icons/undo'
  import Upload from '@lucide/svelte/icons/upload'

  // 送排钻交接：handoff 置位（含视图切换后首次挂载）即取图载入（参考原图自动填充见 store）。
  // [2.6] 新建会话 = 破坏性动作：dirty 先过三按钮守卫；取消 = 丢弃本次交接（会话原地保持）。
  // armed 位防重入：守卫挂起期间 dirty 翻转（如 ⌘S 保存成功）会重跑本 effect——armed 保持到
  // 动作真正执行/取消，杜绝双载。
  let handoffGuardArmed = false
  $effect(() => {
    if (!getHandoff()) {
      handoffGuardArmed = false
      return
    }
    if (handoffGuardArmed) return
    if (isStudioDirty()) {
      handoffGuardArmed = true
      runStudioGuarded(
        async () => {
          handoffGuardArmed = false
          await loadFromHandoff()
        },
        { onCancel: clearHandoff },
      )
    } else {
      void loadFromHandoff()
    }
  })

  // ---- [2.8 打开意图] 素材库/导入的 .gemproj → 本页消费（App 只 peek 切视图——4.6 协议） ----
  // 失败驻留错误卡（来源缺失带重绑入口——参数完好，换源重放即恢复）；成功 ack 清意图。
  let openFailure = $state<{ assetId: string; message: string; sourceMissing: boolean } | null>(null)
  let rebindBusy = $state(false)

  $effect(() => {
    // 可见性门（EditView 4.6 同式：Tabs 恒挂载——只在排钻工作台为当前视图且 gemproj 意图时 claim，
    // 不偷 gemgen/gemtpl/gemdoc 的 LabView/EditView 消费）
    if (getView() !== 'studio') return
    const snapshot = peekOpenIntent()
    if (snapshot === null || snapshot.phase !== 'pending' || snapshot.kind !== 'gemproj') return
    const claim = claimOpenIntent()
    if (claim === null) return
    // [2.6] 打开其它项目 = 破坏性动作：dirty 先过三按钮守卫（EditView 意图门同式——取消 =
    // ackFailure，动作内自行 ack 终态）；claim 已把意图置 claimed，本 effect 不会重入双开
    const action = async (): Promise<void> => {
      try {
        await openStudioProject(claim.assetId)
        ackOpenIntentSuccess(claim.token)
      } catch (error) {
        openFailure = {
          assetId: claim.assetId,
          message: error instanceof Error ? error.message : String(error),
          sourceMissing: error instanceof OpenGemprojError && error.failure.kind === 'source-missing',
        }
        ackOpenIntentFailure(claim.token, `gemproj-open-failed:${claim.assetId}`)
      }
    }
    if (isStudioDirty()) runStudioGuarded(action, { claim })
    else void action()
  })

  /** 来源缺失重绑：重选来源图 → sourceOverride 换源重放（成功置 dirty，下次保存写入新来源）。
   *  [2.6] 重绑 = 打开其它项目（替换当前会话）：dirty 先过三按钮守卫。 */
  async function onRebindSource(e: Event): Promise<void> {
    const input = e.currentTarget
    const failure = openFailure
    if (!(input instanceof HTMLInputElement) || failure === null) return
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const dataUrl = await fileToDataUrl(file)
    const proceed = async (): Promise<void> => {
      rebindBusy = true
      try {
        await openStudioProject(failure.assetId, { sourceOverride: { dataUrl, name: file.name } })
        openFailure = null
      } catch (error) {
        openFailure = {
          assetId: failure.assetId,
          message: error instanceof Error ? error.message : String(error),
          sourceMissing: error instanceof OpenGemprojError && error.failure.kind === 'source-missing',
        }
      } finally {
        rebindBusy = false
      }
    }
    if (isStudioDirty()) runStudioGuarded(proceed)
    else await proceed()
  }

  // ---- 取景转发（上下文条 ↔ 画布实例）：结构性接口，不耦合组件实例类型 ----
  interface CanvasFramingApi {
    fitView: () => void
    zoomBy: (factor: number) => void
    getZoomPercent: () => number
  }
  let canvasApi = $state<CanvasFramingApi | null>(null)

  // ---- 左列双 tab（图层|历史）----
  let leftTab = $state<'layers' | 'history'>('layers')

  // ⌘Z/⇧⌘Z 与历史面板按钮同源（同一 reducer 入口）
  function onKeydown(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
    const target = e.target
    if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    e.preventDefault()
    if (e.shiftKey) redoStudioOp()
    else undoStudioOp()
  }

  // ---- 移动端抽屉（lg 以下：图层/历史抽屉入口在上下文条，本体在此） ----
  type DrawerKind = 'layers' | 'history' | 'inspector'
  let drawer = $state<DrawerKind | null>(null)
  const DRAWER_TITLES: Record<DrawerKind, string> = { layers: '图层', history: '历史', inspector: '检查器' }

  // ---- 选中块半屏抽屉（移动端）：选中即露出详情，画布保持可见 ----
  let blockSheetOpen = $state(false)

  function prefersMobileViewport(): boolean {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 1023px)').matches
      : false
  }

  let isMobileViewport = $state(prefersMobileViewport())
  $effect(() => {
    const onResize = (): void => {
      isMobileViewport = prefersMobileViewport()
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  })

  $effect(() => {
    if (getSelectedBlockId() && isMobileViewport) blockSheetOpen = true
  })

  // 跨 tab（图层⇄历史）focus 不丢层选择：左列容器承接键盘（LayerPanel 内部 ↑↓/Space）
</script>

<svelte:window
  onkeydown={onKeydown}
  onbeforeunload={(event) => {
    // [2.6] 守卫三分法之二：刷新/关窗拦截（dirty 时——store 单例跨视图存活，任意 Tab 下均成立）
    if (isStudioDirty()) {
      event.preventDefault()
      event.returnValue = ''
    }
  }}
/>

<div
  class="flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
  data-testid="studio-root"
>
  <!-- ① 上下文条：来源/更换 + 取景控制（预览三模式+透明度已收编背景层废除）；移动端=来源行+抽屉入口行 -->
  <StudioContextBar
    onOpenDrawer={(kind) => (drawer = kind)}
    onFit={() => canvasApi?.fitView()}
    onZoomIn={() => canvasApi?.zoomBy(1.25)}
    onZoomOut={() => canvasApi?.zoomBy(0.8)}
    zoomPercent={canvasApi?.getZoomPercent() ?? null}
  />

  <!-- ② 中段：[左列 260px | 画布 flex | 检查器 320px] -->
  <div class="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row" data-testid="studio-mid">
    <!-- 左列：双 tab（图层|历史）+ 撤销/重做；移动端由抽屉承载，此列隐藏 -->
    <aside
      class="hidden w-65 shrink-0 flex-col gap-2 border-r p-2 lg:min-h-0 lg:flex"
      data-testid="studio-left-column"
    >
      <div class="flex shrink-0 items-center gap-1">
        <!-- 左列面板切换（非导航 tab——aria-pressed chips，避免与 App 全局 [role="tab"] 查询串台） -->
        <div class="bg-muted grid grid-cols-2 gap-0.5 rounded-lg p-0.5" aria-label="左列面板">
          <button
            type="button"
            aria-pressed={leftTab === 'layers'}
            class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors {leftTab === 'layers'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'}"
            onclick={() => (leftTab = 'layers')}
            data-testid="left-tab-layers"
          >
            <Layers class="size-3.5" />
            图层
          </button>
          <button
            type="button"
            aria-pressed={leftTab === 'history'}
            class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors {leftTab === 'history'
              ? 'bg-background text-foreground shadow-sm'
              : 'text-muted-foreground hover:text-foreground'}"
            onclick={() => (leftTab = 'history')}
            data-testid="left-tab-history"
          >
            <History class="size-3.5" />
            历史
          </button>
        </div>
        <div class="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!canUndo()}
            title="撤销（⌘Z）"
            onclick={() => undoStudioOp()}
            data-testid="left-undo"
          >
            <Undo />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={!canRedo()}
            title="重做（⇧⌘Z）"
            onclick={() => redoStudioOp()}
            data-testid="left-redo"
          >
            <Redo />
          </Button>
        </div>
      </div>
      {#if leftTab === 'layers'}
        <LayerPanel />
      {:else}
        <HistoryPanel />
      {/if}
    </aside>

    <!-- 画布舞台：min-h-0/min-w-0 链关键一环；移动端 flex-1 填充，桌面同为 flex-1 -->
    <div
      class="relative flex min-h-0 min-w-0 flex-1 flex-col p-3 lg:p-4"
      data-testid="studio-stage"
    >
      <BlockCanvas bind:this={canvasApi} />

      <!-- [2.8 打开失败错误卡] 来源缺失带重绑（换源重放——参数完好）；其余失败可关闭驻留诊断 -->
      {#if openFailure}
        <div
          class="bg-background/85 absolute inset-0 z-20 flex items-center justify-center p-4 backdrop-blur-sm"
          data-testid="open-failure-card"
          role="alert"
        >
          <div class="border-destructive/40 bg-card w-full max-w-sm rounded-lg border p-4 shadow-lg">
            <p class="text-sm font-semibold">打开排钻项目失败</p>
            <p class="text-muted-foreground mt-1 text-xs">{openFailure.message}</p>
            {#if openFailure.sourceMissing}
              <p class="text-muted-foreground mt-2 text-xs">参数完好——重新绑定一张来源图即可重放。</p>
              <label class="mt-3 block">
                <span
                  class="border-input bg-background hover:bg-muted inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border px-3 text-xs font-medium shadow-xs transition-colors"
                >
                  <Upload class="size-3.5" />
                  {rebindBusy ? '重放中…' : '重新绑定来源图'}
                </span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  class="hidden"
                  onchange={onRebindSource}
                  data-testid="rebind-source-input"
                />
              </label>
            {/if}
            <div class="mt-3 flex justify-end">
              <Button size="sm" variant="ghost" onclick={() => (openFailure = null)}>关闭</Button>
            </div>
          </div>
        </div>
      {/if}
    </div>

    <!-- 检查器右列：桌面 320px（Inspector 内部滚动）；移动端由检查器抽屉承载，此列隐藏 -->
    <aside
      class="hidden w-80 shrink-0 lg:min-h-0 lg:flex lg:flex-col lg:border-l"
      data-testid="studio-inspector-slot"
    >
      <Inspector />
    </aside>
  </div>

  <!-- ③ 状态条：左统计（Σ 层含隐藏层口径）+ 右导出（exportGate 前置）+ worker 进度/取消 -->
  <StudioStatusBar />
</div>

<!-- 移动端图层/历史/检查器抽屉（bottom sheet——沿现参数抽屉先例） -->
<Sheet.Root
  open={drawer !== null}
  onOpenChange={(open) => {
    if (!open) drawer = null
  }}
>
  <Sheet.Content side="bottom" class="flex max-h-[80vh] flex-col overflow-hidden pb-[env(safe-area-inset-bottom)]" data-testid="left-drawer">
    <Sheet.Header class="pb-2">
      <Sheet.Title class="text-sm">{drawer ? DRAWER_TITLES[drawer] : ''}</Sheet.Title>
    </Sheet.Header>
    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      {#if drawer === 'layers'}
        <LayerPanel />
      {:else if drawer === 'history'}
        <HistoryPanel />
      {:else if drawer === 'inspector'}
        <Inspector />
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- 移动端选中块半屏抽屉：选中即在手边，画布保持可见（关抽屉不取消选中） -->
<Sheet.Root bind:open={blockSheetOpen} onOpenChange={(open) => !open && (blockSheetOpen = open)}>
  <Sheet.Content side="bottom" class="max-h-[70vh] overflow-y-auto pb-[env(safe-area-inset-bottom)]" data-testid="block-sheet">
    <Sheet.Header class="pb-2">
      <Sheet.Title class="text-sm">选中块</Sheet.Title>
      <Sheet.Description class="text-xs">拖动可收起；关闭抽屉不会取消画布上的选中。</Sheet.Description>
    </Sheet.Header>
    <div class="px-4 pb-4">
      <Inspector />
    </div>
  </Sheet.Content>
</Sheet.Root>

<!-- [2.6] dirty 守卫（三按钮：保存并继续 / 不保存 / 取消——打开其它项目/换来源图/新建共用单实例；
     overlay/Escape 关闭按取消处理——会话原地保持） -->
<Dialog.Root open={isStudioGuardOpen()} onOpenChange={(open) => !open && studioGuardCancel()}>
  <Dialog.Content class="max-w-sm" data-testid="studio-guard-dialog">
    <Dialog.Header>
      <Dialog.Title>当前排钻会话未保存</Dialog.Title>
      <Dialog.Description>
        继续将替换当前排钻会话。未保存的修改（含撤销历史）会随下一步动作丢弃，先保存为排钻工程更稳妥。
      </Dialog.Description>
    </Dialog.Header>
    {#if getStudioGuardError()}
      <p class="text-destructive text-xs" role="alert" data-testid="studio-guard-error">
        {getStudioGuardError()}
      </p>
    {/if}
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={studioGuardCancel} data-testid="studio-guard-cancel">
        取消
      </Button>
      <Button variant="outline" size="sm" onclick={studioGuardDiscard} data-testid="studio-guard-discard">
        不保存
      </Button>
      <Button
        size="sm"
        disabled={isStudioGuardBusy()}
        onclick={() => void studioGuardSaveAndContinue()}
        data-testid="studio-guard-save"
      >
        {isStudioGuardBusy() ? '保存中…' : '保存并继续'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
