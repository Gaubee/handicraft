<!--
TaskWorkbenchView.svelte — 任务详情工作台主视图（add-task-detail-layer-workbench 2.2-2.5；
add-workbench-pro 2.1-2.3+2c；v3=PS 式三栏；rework-layer-model v4=容器查询工作台，
2026-09-27 初始 + 2026-09-28 修复轮 F1-F8 与修复轮二 G1/G2——本文件当轮原始需求：
Codex 二轮复评 /tmp/codex-layer-model-v4-review.md「二轮复评」章 P1-1/P1-2）。
单一组件多形态（design §4——container-type:inline-size+Tailwind v4 @container 断点
@lg=32rem——断点只依赖宽度，inline-size 是合理选择；rework-workbench-rail-drawers
2026-09-29 中段 PS 式轨道化）：
  两形态共用骨架=左 rail（画布工具+图层开合）｜画布区（relative——图层/属性/历史
    三 Drawer overlay）｜右 rail（属性/历史/快捷键）；rail 常驻不收起。
  < 32rem（agent 详情右栏/移动 sheet）=紧凑形态：迷你画布+选中层摘要+关键操作
    （策略直改/掩码重算——v4 修复轮 F1）纵排；面板全经 Drawer（全宽 max-w-80）；
  ≥ 32rem=完整形态：顶部任务条+轨道骨架（@2xl=42rem 档双 Drawer 缺省展开——
    railState.svelte.ts 状态机，ResizeObserver 喂宽）。
embedded=true（TaskDetailPanel 挂载）：无自带顶栏（面板提供「打开完整工作台/继续对话」
——同 store 会话纯放大，无状态迁移）。
四态：装载/错误/无图层树引导/内容态。数据：task.detail RPC（store.svelte.ts）；
mask 位面+抠图层渐进请求（两个 $effect）。导出门：allowed=false 禁用+blockers 列表。
快捷键（2c 命令总线——commands.ts 单源：V/H/Z/B/Delete/F2/Esc/⌘Z 域路由/[ ]/?；
v4 修复轮 F3：实例不可见不截获——presence.svelte.ts）。
装载门（v4 修复轮 F2/Codex P1-2）：Tabs 常驻下双实例共享 store 单例——仅本实例
所属视图（embedded→agent / 完整→studio）激活时装载；store.taskId 不符即重载
（激活视图显示的永远是自己的任务；后台实例不覆盖前台）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import WorkbenchLayerPanel from './WorkbenchLayerPanel.svelte'
  import WorkbenchInspector from './WorkbenchInspector.svelte'
  import WorkbenchCanvasStage from './WorkbenchCanvasStage.svelte'
  import WorkbenchHistoryDock from './WorkbenchHistoryDock.svelte'
  import WorkbenchShortcutsHelp from './WorkbenchShortcutsHelp.svelte'
  import { openSession, getAgentMode } from '$lib/agentApi/store.svelte'
  import { closeStudioTask, getView, setView, type ViewId } from '$lib/stores/view.svelte'
  import { handleWorkbenchKeydown } from './commands.js'
  import { isWorkbenchVisible } from './presence.svelte.js'
  import { createRailState } from './railState.svelte.js'
  import WorkbenchRail from './WorkbenchRail.svelte'
  import WorkbenchRailDrawer from './WorkbenchRailDrawer.svelte'
  import {
    applyLayerStrategy,
    discardMaskEditNode,
    getApplyError,
    getAssignmentOf,
    getExportError,
    getExportGate,
    getLayerMaskCoverage,
    getMaskEditActionBusy,
    getMaskEditOf,
    getNodeOf,
    getRenameError,
    getSelectedNodeId,
    getWorkbenchDetail,
    getWorkbenchLayerRender,
    getWorkbenchLoadError,
    getWorkbenchPhase,
    getWorkbenchTaskId,
    getWorkbenchNodes,
    getEffectiveGemTotal,
    exportTask,
    isApplying,
    isExporting,
    loadWorkbench,
    requestCutoutsForTree,
    requestNodeMasksForTree,
    retryMaskEditNode,
  } from './store.svelte'
  import { STRATEGY_FORM_SPECS, STRATEGY_KIND_ORDER, FREE_CODE_PROPOSAL_HINT, strategyDefaultsOf } from '$lib/strategyDesigner/paramsSchema'
  import type { KernelStrategyKind } from '@handicraft/contracts'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import Download from '@lucide/svelte/icons/download'
  import Ellipsis from '@lucide/svelte/icons/ellipsis'
  import History from '@lucide/svelte/icons/history'
  import Keyboard from '@lucide/svelte/icons/keyboard'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import Zap from '@lucide/svelte/icons/zap'

  let { taskId, embedded = false }: { taskId: string; embedded?: boolean } = $props()

  /** 工作台容器根（装载门/快捷键门的可见性锚——bind:this）。 */
  let rootEl = $state<HTMLElement | null>(null)

  /**
   * 装载门（F2/Codex P1-2；修复轮二 G2 收紧）：本实例所属视图（embedded→agent /
   * 完整→studio）激活时装载/校验重载——**始终要求归属视图匹配**（修复轮一的无主
   * idle 旁路会让非归属实例在默认 agent+idle 态后台装载，Codex 二轮 P2：真实动线
   * StudioView 挂载恒伴随 view=studio，宽松分支只服务测试宿主——测试宿主显式
   * setView 即可，归属门不得因此放宽）。有主后严格归属：后台实例（视图非激活）
   * 绝不装载——Tabs 常驻下 Agent 换任务不覆盖 Studio 前台画布；视图切回时
   * store.taskId 不符即重载（激活视图显示的永远是自己的任务）。同任务且非 idle
   * 不重入（「纯放大」同会话——选中/笔刷保留；error 由用户重试——effect 不自动
   * 重试防死循环）。
   */
  const ownerView: ViewId = $derived(embedded ? 'agent' : 'studio')
  $effect(() => {
    void getView()
    if (getView() !== ownerView) return
    const idle = getWorkbenchPhase() === 'idle'
    if (getWorkbenchTaskId() === taskId && !idle) return
    void loadWorkbench(taskId)
  })

  // mask 位面渐进请求（nodes/tree 变化→inline 同步/blob 异步——maskBits 缓存面）
  $effect(() => {
    void getWorkbenchNodes()
    void getWorkbenchDetail()
    requestNodeMasksForTree()
  })

  // 抠图层渐进请求（v4 渲染语义层——位面就绪+原图在场→内容寻址合成）
  $effect(() => {
    void getWorkbenchNodes()
    void getWorkbenchDetail()
    requestCutoutsForTree()
  })

  const phase = $derived(getWorkbenchPhase())
  const detail = $derived(getWorkbenchDetail())
  const exportGate = $derived(getExportGate())
  const exporting = $derived(isExporting())
  const exportError = $derived(getExportError())
  const selectedId = $derived(getSelectedNodeId())
  const selectedNode = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const selectedAssignment = $derived(selectedId === null ? null : getAssignmentOf(selectedId))
  const selectedCoverage = $derived(selectedId === null ? null : getLayerMaskCoverage(selectedId))
  const renderModel = $derived(getWorkbenchLayerRender())

  /** ⋯ 菜单（紧凑形态承载：历史事务/快捷键/导出——完整形态也有）。 */
  let moreOpen = $state(false)

  // ---------------------------------------------------------------- 轨道 Drawer 状态机（rail-drawers 1.1/2.1）

  /**
   * PS 式轨道开合单源（railState.svelte.ts——auto 缺省随断点/手动记忆/右侧互斥）。
   * 断点输入：ResizeObserver 观察容器根宽（@2xl=42rem 阈值——与 CSS 容器查询同一档）；
   * jsdom 无布局（全局桩 observe 空操作）→ 恒 wide=false（Drawer 全收起缺省——
   * 内容常驻 DOM 仅切类，测试断言不依赖观察回调）。
   */
  const rail = createRailState()
  const layersOpen = $derived(rail.isOpen('layers'))
  const inspectorOpen = $derived(rail.isOpen('inspector'))
  const historyOpen = $derived(rail.isOpen('history'))

  /** 42rem（@2xl）=轨道断点阈值（design §2/§4——Tailwind v4 容器查询同源档位）。 */
  const RAIL_WIDE_MIN_PX = 42 * 16

  $effect(() => {
    const el = rootEl
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth
      rail.setWide(width >= RAIL_WIDE_MIN_PX)
    })
    observer.observe(el)
    return () => observer.disconnect()
  })

  /** 导出按钮：门阻禁用（blockers 列表就近呈现——门只增不减，无客户端豁免口）。 */
  async function onExport(): Promise<void> {
    moreOpen = false
    await exportTask()
  }

  /**
   * 快捷键（2c 命令总线单源——IME/输入框焦点保护在分派入口统一判定）。
   * F3/Codex P1-3：实例不可见（Tabs hidden/抽屉退场）直接放行——不截获
   * ⌘Z/Delete/F2/Alt+方向等键、不 preventDefault（presence.svelte.ts 判定）。
   */
  function onKeydown(event: KeyboardEvent): void {
    if (!isWorkbenchVisible(rootEl)) return
    handleWorkbenchKeydown(event)
  }

  /** 返回 Agent 会话：清任务上下文（studio 回模式选择）+打开该任务的会话。 */
  function onBack(): void {
    const session = detail?.session ?? null
    closeStudioTask()
    if (session !== null) void openSession(session.id)
    setView('agent')
  }

  // ---------------------------------------------------------------- F1：紧凑态关键操作（策略直改+掩码重算）

  /**
   * 紧凑态策略直改（design §4：<32rem 保留「策略/重算」关键操作）：策略族选择
   * （STRATEGY_KIND_ORDER 单源——v4 决策树序纹理优先，与 Inspector 同一份数组）
   * +密度——应用走同一 applyLayerStrategy（D-1 直接生效——与完整态同一 task 状态
   * 面，无第二写路径）。params=strategyDefaultsOf(kind)（族最小合法参数——判别联合
   * 族必需判别值；v4 修复轮二 G1/Codex 二轮 P1-1：此前传 {} 被 daemon 族 schema
   * params-invalid 拒，mock 不校验造成测试假绿）。参数细面/钻选择/笔刷编辑仍引导
   * 完整工作台（紧凑空间只承载关键操作）。
   */
  let compactKind = $state<KernelStrategyKind | null>(null)
  let compactDensityText = $state('')

  // 选中层变化 → 草稿回指派真值（未指派=null——应用时以现选族发出）
  $effect(() => {
    const assignment = selectedAssignment
    compactKind = assignment === null ? null : assignment.strategyKind
    compactDensityText = assignment === null ? '' : String(assignment.densityPerCm2)
  })

  const selectedMaskEdit = $derived(selectedId === null ? null : getMaskEditOf(selectedId))
  const maskActionBusy = $derived(getMaskEditActionBusy())

  /**
   * free-code 直改门（v4 修复轮三 H1/Codex 三轮 P1-1）：需载荷族不可静态默认——
   * 已有 free-code 指派同族重应用=保留原 params（不丢 source，仅密度可调）；从别族
   * 切入=阻止+引导提案流程（与 Inspector 同语义）。
   */
  const freeCodeBlocked = $derived(
    compactKind === 'free-code' && selectedAssignment?.strategyKind !== 'free-code',
  )

  /** 紧凑态应用（密度空串=缺省交服务端推导——同 Inspector 语义）。 */
  async function onCompactApply(): Promise<void> {
    if (selectedId === null || compactKind === null || freeCodeBlocked) return
    const density = Number(compactDensityText)
    const base = strategyDefaultsOf(compactKind)
    const params =
      base.status === 'static'
        ? base.params
        : // free-code 同族重应用：原指派载荷整组重发（source/entryPoint/seed 保留——
          // JSON 深拷贝脱离 $state proxy，RPC 载荷可 structuredClone）
          (JSON.parse(JSON.stringify(selectedAssignment?.params ?? {})) as Record<string, unknown>)
    await applyLayerStrategy(selectedId, compactKind, params, Number.isFinite(density) && density > 0 ? density : undefined)
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- 容器根（@container——子树 @lg:=≥32rem 完整形态/缺省紧凑形态） -->
<div bind:this={rootEl} class="@container flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-testid="task-workbench" data-embedded={embedded ? 'true' : undefined}>
  {#if phase === 'ready' && detail !== null && detail.tree !== null}
    {#if !embedded}
      <!-- 完整形态顶部：任务标题+状态+返回+导出门（紧凑容器时收窄） -->
      <header
        class="bg-background/80 flex h-12 shrink-0 items-center gap-3 border-b px-3 backdrop-blur @lg:gap-3 @max-lg:gap-1.5"
        data-testid="workbench-topbar"
      >
        <Button variant="ghost" size="sm" onclick={onBack} class="@max-lg:px-1.5" data-testid="workbench-back">
          <ArrowLeft class="size-3.5" aria-hidden="true" />
          <span class="@max-lg:sr-only">返回 Agent 会话</span>
        </Button>
        <h2 class="truncate text-sm font-semibold @lg:text-sm @max-lg:text-xs" data-testid="workbench-title" title={detail.task.title ?? detail.task.id}>
          {detail.task.title ?? detail.task.id}
        </h2>
        <Badge variant={detail.task.status === 'done' ? 'secondary' : 'outline'} class="shrink-0" data-testid="workbench-task-status">
          {detail.task.status}
        </Badge>
        <span class="text-muted-foreground shrink-0 font-mono text-xs @lg:inline @max-lg:hidden" data-testid="workbench-gem-count" title="去重口径总颗数（v5：父层旧指派的钻不计数）">
          {detail.gems !== null ? `${getEffectiveGemTotal()} 颗 · ${detail.gems.excludedRegions} 处留白` : '尚无排钻产物'}
        </span>
        <!-- 导出门+⋯ 菜单（ml-auto 收右） -->
        <div class="ml-auto flex shrink-0 items-center gap-1.5" data-testid="workbench-export-gate">
          {#if !exportGate.allowed}
            <span
              class="text-destructive hidden items-center gap-1 text-[11px] @lg:flex"
              data-testid="workbench-export-blockers"
              title={exportGate.blockers.join('、')}
              role="alert"
            >
              <TriangleAlert class="size-3" aria-hidden="true" />
              <span class="@max-lg:sr-only">导出阻断：{exportGate.blockers.join('、')}</span>
            </span>
          {/if}
          <Button
            size="sm"
            variant="outline"
            class="h-7 px-2 text-[11px] @lg:inline-flex @max-lg:hidden"
            disabled={!exportGate.allowed || exporting}
            onclick={() => void onExport()}
            data-testid="workbench-export-button"
            title={exportGate.allowed ? '导出排钻设计（strategy-gems.json）' : `导出被门阻：${exportGate.blockers.join('、')}`}
          >
            <Download class="size-3" aria-hidden="true" />
            {exporting ? '导出中…' : '导出'}
          </Button>
          <!-- ⋯ 菜单（历史/快捷键/导出——紧凑形态承载非关键操作） -->
          <div class="relative">
            <Button variant="ghost" size="icon" class="size-7" onclick={() => (moreOpen = !moreOpen)} aria-pressed={moreOpen} data-testid="workbench-more-menu" title="更多（历史事务/快捷键/导出）">
              <Ellipsis class="size-4" aria-hidden="true" />
            </Button>
            {#if moreOpen}
              <div class="bg-background absolute right-0 top-8 z-30 w-44 rounded-md border p-1 shadow-md" role="menu" data-testid="workbench-more-dropdown">
                <button
                  type="button"
                  class="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs"
                  role="menuitem"
                  onclick={() => {
                    moreOpen = false
                    rail.toggle('history')
                  }}
                  data-testid="workbench-more-history"
                >
                  <History class="size-3.5" aria-hidden="true" />
                  {historyOpen ? '收起历史事务' : '历史事务（版本链/回退）'}
                </button>
                <button
                  type="button"
                  class="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs"
                  role="menuitem"
                  onclick={() => {
                    moreOpen = false
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }))
                  }}
                  data-testid="workbench-more-help"
                >
                  <Keyboard class="size-3.5" aria-hidden="true" />
                  快捷键速查（?）
                </button>
                <button
                  type="button"
                  class="hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs {!exportGate.allowed || exporting ? 'text-muted-foreground' : ''}"
                  role="menuitem"
                  disabled={!exportGate.allowed || exporting}
                  onclick={() => void onExport()}
                  data-testid="workbench-more-export"
                >
                  <Download class="size-3.5" aria-hidden="true" />
                  {exporting ? '导出中…' : exportGate.allowed ? '导出排钻设计' : `导出被门阻（${exportGate.blockers.join('、')}）`}
                </button>
              </div>
            {/if}
          </div>
        </div>
      </header>

      {#if exportError !== null}
        <div class="text-destructive bg-destructive/5 border-b px-3 py-1 text-[11px]" data-testid="workbench-export-error" role="alert">
          {exportError}
        </div>
      {/if}
    {/if}

    <!-- 中段（rail-drawers 2.1——两形态共用骨架）：左 rail｜画布区（relative——双 Drawer
         overlay）｜右 rail；紧凑形态（@max-lg）=画布+摘要条纵排，图层/属性/历史全经 Drawer -->
    <div class="bg-background/40 flex min-h-0 min-w-0 flex-1 flex-row" data-testid="workbench-mid">
      <WorkbenchRail side="left" layersOpen={layersOpen} onToggleLayers={() => rail.toggle('layers')} />

      <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <!-- 画布舞台（v4 图层化渲染；紧凑=迷你画布——工具条已外提左 rail）。
             [w17-critic T3] 观察（预览模式/背景簇）工具条避让在场 Drawer：嵌入态窄容器
             里居中工具条曾被图层 Drawer（z-20）拦腰盖住——left/right 内缩到剩余区居中。 -->
        <div class="flex min-h-0 min-w-0 flex-1 flex-col @max-lg:min-h-[220px]">
          <WorkbenchCanvasStage avoidLeft={layersOpen} avoidRight={inspectorOpen || historyOpen} />
        </div>

        <!-- 紧凑形态：选中层摘要+关键操作（F1——策略直改+掩码重算/放弃就地可完成；
             完整形态经右 Drawer 属性面板，@lg 隐藏） -->
        {#if selectedNode !== null}
          <div class="scrollbar-thin hidden @max-lg:block @max-lg:max-h-[42%] @max-lg:shrink-0 @max-lg:overflow-y-auto border-t p-2.5" data-testid="workbench-compact-summary">
            <div class="flex items-center gap-1.5 text-xs font-medium">
              <span class="truncate">{selectedNode.objectName}</span>
              <Badge variant="outline" class="shrink-0 text-[10px]">{selectedNode.category}</Badge>
            </div>
            <dl class="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-0.5 text-[10px]">
              <div class="flex justify-between gap-1">
                <dt class="text-muted-foreground">尺寸</dt>
                <dd class="font-mono">{renderModel !== null ? `${(selectedNode.bbox.w / renderModel.ppm.ppm).toFixed(0)}×${(selectedNode.bbox.h / renderModel.ppm.ppm).toFixed(0)} mm` : `${selectedNode.bbox.w}×${selectedNode.bbox.h} px`}</dd>
              </div>
              <div class="flex justify-between gap-1">
                <dt class="text-muted-foreground">掩码覆盖</dt>
                <dd class="font-mono">{selectedCoverage !== null ? `${(selectedCoverage * 100).toFixed(0)}%` : '—'}</dd>
              </div>
            </dl>
            {#if selectedAssignment !== null}
              <p class="text-muted-foreground mt-1.5 truncate text-[10px]" title={selectedAssignment.strategyKind}>
                策略：{selectedAssignment.strategyKind}{selectedNode.children.length > 0 ? '（组不产钻——已失效）' : ''} · 密度 {selectedAssignment.densityPerCm2}/cm²
              </p>
              <p class="text-muted-foreground truncate text-[10px]">
                用钻：{selectedAssignment.stones.map((stone) => `${stone.sku}${stone.sizeMm !== null ? ` ${stone.sizeMm}mm` : ''}`).join('、') || '—'}
              </p>
            {:else}
              <p class="text-muted-foreground mt-1.5 text-[10px]">策略：未指派</p>
            {/if}

            <!-- 关键操作：策略直改（族+密度——applyLayerStrategy 同一写路径/同一 task 状态）。
                 v5 组门：选中组（有 children）无指派控件——组不产钻，同 Inspector 语义。 -->
            {#if selectedNode.children.length > 0}
              <div class="mt-2 space-y-1.5 rounded-md border border-dashed p-1.5" data-testid="workbench-compact-strategy">
                <div class="text-muted-foreground text-[10px] font-semibold">策略（组）</div>
                <p class="text-[11px] leading-relaxed">组不产钻——拆分后在子图层指派</p>
                <p class="text-muted-foreground text-[10px] leading-relaxed">父级（组）恒不套钻；选中其子图层后此处即可直改策略</p>
              </div>
            {:else}
            <div class="mt-2 space-y-1.5 rounded-md border p-1.5" data-testid="workbench-compact-strategy">
              <div class="text-muted-foreground text-[10px] font-semibold">策略直改（直接生效）</div>
              <div class="flex items-center gap-1.5">
                <select
                  class="border-input bg-background min-w-0 flex-1 rounded-md border px-1.5 py-1 text-[11px]"
                  value={compactKind ?? ''}
                  onchange={(event) => {
                    const next = event.currentTarget.value as KernelStrategyKind
                    if (next in STRATEGY_FORM_SPECS) compactKind = next
                  }}
                  data-testid="workbench-compact-strategy-select"
                  title="策略族（纹理贴图=通用缺省——与完整工作台同源决策树序）"
                  aria-label="策略族"
                >
                  {#if compactKind === null}
                    <option value="" disabled>选择策略族…（推荐纹理贴图）</option>
                  {/if}
                  {#each STRATEGY_KIND_ORDER as kind (kind)}
                    <option value={kind}>{STRATEGY_FORM_SPECS[kind].label}</option>
                  {/each}
                </select>
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  bind:value={compactDensityText}
                  placeholder="密度"
                  class="border-input bg-background w-16 shrink-0 rounded-md border px-1.5 py-1 font-mono text-[11px]"
                  data-testid="workbench-compact-strategy-density"
                  aria-label="密度（颗/cm²）"
                />
              </div>
              <Button
                size="sm"
                class="h-6 w-full px-2 text-[10px]"
                disabled={compactKind === null || isApplying() || freeCodeBlocked}
                onclick={() => void onCompactApply()}
                data-testid="workbench-compact-strategy-apply"
                title={freeCodeBlocked ? FREE_CODE_PROPOSAL_HINT : '按新策略族/密度重算该层点阵（D-1 直接生效——与完整工作台同一 task 状态）'}
              >
                <Zap class="size-3" aria-hidden="true" />
                {isApplying() ? '重算中…' : '应用策略'}
              </Button>
              {#if freeCodeBlocked}
                <!-- H1（Codex 三轮 P1-1）：free-code 需载荷族——无源码载荷的直改必被 daemon
                     params-invalid 拒；UI 就近阻止并引导提案流程（同族重应用=保留原载荷） -->
                <p class="text-destructive text-[10px] leading-relaxed" role="alert" data-testid="workbench-compact-freecode-blocked">
                  {FREE_CODE_PROPOSAL_HINT}
                </p>
              {/if}
              {#if getApplyError() !== null}
                <p class="text-destructive text-[10px]" role="alert" data-testid="workbench-compact-apply-error">应用失败：{getApplyError()}</p>
              {/if}
              <p class="text-muted-foreground/70 text-[10px] leading-relaxed">
                参数细面/钻选择/笔刷编辑在完整工作台（放大后同会话继续）
              </p>
            </div>
            {/if}

            <!-- 关键操作：掩码重算/放弃（stale/error/incomplete 留痕的就近恢复链——同 Inspector 命令） -->
            {#if selectedMaskEdit !== null && (selectedMaskEdit.state === 'stale' || selectedMaskEdit.state === 'error' || selectedMaskEdit.incomplete)}
              <div class="mt-1.5 space-y-1 rounded-md border border-destructive/30 p-1.5" data-testid="workbench-compact-mask-edit">
                <div class="text-destructive flex items-center gap-1 text-[10px] font-semibold">
                  <TriangleAlert class="size-3" aria-hidden="true" />
                  {selectedMaskEdit.incomplete ? `行程超限（${selectedMaskEdit.runCount}>4096）` : selectedMaskEdit.state === 'stale' ? '编辑基线漂移（stale）' : '重算失败'}
                </div>
                <div class="flex gap-1.5">
                  {#if selectedMaskEdit.state === 'stale' || selectedMaskEdit.state === 'error'}
                    <Button
                      size="sm"
                      variant="outline"
                      class="h-6 flex-1 px-2 text-[10px]"
                      disabled={maskActionBusy !== null}
                      onclick={() => selectedId !== null && void retryMaskEditNode(selectedId)}
                      data-testid="workbench-compact-mask-retry"
                      title="重放重算（maskEdit.retry——与完整工作台同一命令）"
                    >
                      <RefreshCw class="size-3" aria-hidden="true" />
                      重算
                    </Button>
                  {/if}
                  <Button
                    size="sm"
                    variant="outline"
                    class="text-destructive border-destructive/40 hover:bg-destructive/10 h-6 flex-1 px-2 text-[10px]"
                    disabled={maskActionBusy !== null}
                    onclick={() => selectedId !== null && void discardMaskEditNode(selectedId)}
                    data-testid="workbench-compact-mask-discard"
                    title="确认放弃（maskEdit.discard——清告警/门阻断面）"
                  >
                    <Trash2 class="size-3" aria-hidden="true" />
                    放弃告警
                  </Button>
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <!-- 紧凑形态未选层引导（@lg 隐藏） -->
          <div class="text-muted-foreground hidden items-center justify-center border-t px-3 py-2 text-[10px] @max-lg:flex" data-testid="workbench-compact-summary-empty">
            在图层列表选择一层——摘要与关键操作在此呈现
          </div>
        {/if}

        <!-- 左 Drawer：图层（WorkbenchLayerPanel——组件内部零改动；旧内联栏拆除） -->
        <WorkbenchRailDrawer side="left" open={layersOpen} testid="workbench-layer-slot" label="图层管理">
          <div class="flex min-h-0 flex-1 flex-col">
            <WorkbenchLayerPanel />
          </div>
        </WorkbenchRailDrawer>

        <!-- 右 Drawer：属性（WorkbenchInspector——组件内部零改动；旧内联栏拆除） -->
        <WorkbenchRailDrawer side="right" open={inspectorOpen} testid="workbench-inspector-slot" label="图层属性">
          <div class="flex min-h-0 flex-1 flex-col">
            <WorkbenchInspector />
          </div>
        </WorkbenchRailDrawer>

        <!-- 右 Drawer：历史（底部 dock 挂载退役——外壳满高滚动适配，WorkbenchHistoryDock 组件内部零改动） -->
        <WorkbenchRailDrawer side="right" open={historyOpen} testid="workbench-history-slot" label="历史事务">
          <div class="h-full overflow-auto">
            <WorkbenchHistoryDock />
          </div>
        </WorkbenchRailDrawer>
      </div>

      <WorkbenchRail
        side="right"
        inspectorOpen={inspectorOpen}
        historyOpen={historyOpen}
        onToggleInspector={() => rail.toggle('inspector')}
        onToggleHistory={() => rail.toggle('history')}
      />
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
      {#if !embedded}
        <Button variant="outline" size="sm" onclick={onBack} data-testid="workbench-no-tree-back">
          <ArrowLeft class="size-3.5" aria-hidden="true" />
          返回 Agent 会话
        </Button>
      {/if}
    </div>
  {:else if phase === 'error'}
    <!-- [w17-critic T1] mock 演示模式缺 fixture 的报错（「任务详情装载失败 fixt-…」）
         对演示用户是噪音：mock 通道改友好空态；真实通道保留可重试错误卡。 -->
    {#if getAgentMode() === 'mock'}
      <div class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center" data-testid="workbench-demo-empty">
        <p class="text-foreground text-sm font-medium">演示任务无工作台数据</p>
        <p class="text-muted-foreground max-w-sm text-xs leading-relaxed">
          本地演示（MOCK）没有为该任务准备画布与图层——连接真实服务后，任务详情会在此显示可编辑的工作台。
        </p>
      </div>
    {:else}
      <div class="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="workbench-error" role="alert">
        <p class="text-destructive text-sm font-medium">任务详情装载失败</p>
        <p class="text-muted-foreground max-w-md text-xs leading-relaxed">{getWorkbenchLoadError()}</p>
        <Button variant="outline" size="sm" onclick={() => void loadWorkbench(taskId)} data-testid="workbench-retry">
          <RefreshCw class="size-3.5" aria-hidden="true" />
          重试
        </Button>
      </div>
    {/if}
  {:else}
    <!-- 装载态（idle/loading 同呈现——task.detail+两工件字节在途） -->
    <div class="flex h-full flex-col items-center justify-center gap-2 p-6" data-testid="workbench-loading">
      <RefreshCw class="text-muted-foreground size-5 animate-spin" aria-hidden="true" />
      <p class="text-muted-foreground animate-pulse text-sm">任务详情装载中…</p>
    </div>
  {/if}
</div>
