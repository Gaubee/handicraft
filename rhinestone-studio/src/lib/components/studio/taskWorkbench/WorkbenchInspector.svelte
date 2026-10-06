<!--
WorkbenchInspector.svelte — 工作台右栏·图层属性面板（add-workbench-pro v3 Owner 整改：
PS 式三栏布局——图层细节全收进右侧属性区，左栏图层行只留缩略图/名/眼睛/锁定）。
分区（选中层的全部属性）：
  基本信息——类别/尺寸 mm/掩码覆盖率/行程数/drillWorthy；
  策略区——策略族选择+schema 驱动参数表单+密度+钻选择入口（2026-10-05 Owner 整改：
  992 款平铺色块网格收进 WorkbenchStonePickerDialog——搜索/分组/真实贴图配图；
  本面留入口按钮+已选缩略横排，应用仍随 layer.strategy.set stoneIdx 提交）；
  掩码编辑状态——ready/stale/error/incomplete 留痕+重算/放弃（终评 P0-1 恢复链）。
未选层=引导态。策略直改语义沿 WorkbenchParamsPanel（D-1 直接生效——不注入对话）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { KernelStrategyKind, StoneCandidateRow } from '@handicraft/contracts'
  import {
    STRATEGY_FORM_SPECS,
    STRATEGY_KIND_ORDER,
    discriminantValueOf,
    fieldsFor,
    FREE_CODE_PROPOSAL_HINT,
    strategyDefaultsOf,
  } from '$lib/strategyDesigner/paramsSchema'
  import {
    applyLayerStrategy,
    getApplyError,
    getAssignmentOf,
    getLayerMaskCoverage,
    getMaskEditActionBusy,
    getMaskEditOf,
    getNodeOf,
    getSelectedNodeId,
    getStoneCandidates,
    getWorkbenchRenderMetrics,
    isApplying,
    discardMaskEditNode,
    retryMaskEditNode,
    stoneIdxOfAssignment,
  } from './store.svelte'
  import { setUndoFocusDomain } from './undoDomains.svelte.js'
  import { withAuthToken } from '$lib/stonesAdmin/authUrl'
  import WorkbenchStonePickerDialog from './WorkbenchStonePickerDialog.svelte'
  import Gem from '@lucide/svelte/icons/gem'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Zap from '@lucide/svelte/icons/zap'

  const selectedId = $derived(getSelectedNodeId())
  const node = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const assignment = $derived(selectedId === null ? null : getAssignmentOf(selectedId))
  const applying = $derived(isApplying())
  const applyError = $derived(getApplyError())
  const candidates = $derived(getStoneCandidates())
  const model = $derived(getWorkbenchRenderMetrics())
  const maskEdit = $derived(selectedId === null ? null : getMaskEditOf(selectedId))
  const maskCoverage = $derived(selectedId === null ? null : getLayerMaskCoverage(selectedId))
  /** v5：选中组（有 children）——组不产钻，策略区整体换门（无任何指派控件）。 */
  const isGroup = $derived(node !== null && node.children.length > 0)

  // ---- fx 徽标定位（v5：图层面板 fx 徽标点击→本面板策略区滚入视野+短暂高亮） ----
  let strategyAnchorEl = $state<HTMLElement | null>(null)
  let fxFocusSeq = $state(0)
  $effect(() => {
    const onFocus = (event: Event): void => {
      const detail = (event as CustomEvent<{ nodeId: string }>).detail
      if (detail?.nodeId === undefined) return
      const target = getNodeOf(detail.nodeId)
      if (target !== null && target.children.length > 0) return // 组无 fx——不定位
      fxFocusSeq += 1
    }
    window.addEventListener('workbench:fx-focus', onFocus)
    return () => window.removeEventListener('workbench:fx-focus', onFocus)
  })
  $effect(() => {
    if (fxFocusSeq === 0) return
    strategyAnchorEl?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })

  // ---------------------------------------------------------------- v4 纹理优先缺省：推荐决策树（design §5）

  /**
   * 策略推荐决策树（rework-layer-model §5）：通用 → texture-fill（绝大部分场景的
   * 通用解）；「画面硬朗且填充区接近纯色」提示下才展开规整族（straight-line/
   * geometry——低成本解）。选项序+推荐面均按此表达。
   */
  const RECOMMEND_PRIMARY: KernelStrategyKind = 'texture-fill'
  // close-paving-backlog 首版注记：along-path 已入下拉（STRATEGY_KIND_ORDER 单源），
  // 不进推荐组——待真链走查后再定推荐位。
  const REGULAR_FAMILY: KernelStrategyKind[] = ['straight-line', 'geometry']
  // 决策树序单源（v4 修复轮二 G1）：STRATEGY_KIND_ORDER——与紧凑态共用同一份数组
  const KIND_OPTIONS = STRATEGY_KIND_ORDER.map((kind) => ({
    value: kind,
    label: STRATEGY_FORM_SPECS[kind].label,
  }))

  /** 规整族提示展开态（「硬朗+纯色」分支——缺省收起：无信号不推荐规整族）。 */
  let regularOpen = $state(false)

  /** 指派钻反查 idx（选中态高亮锚——resourceId 匹配候选表）。 */
  const assignedIdx = $derived(selectedId === null ? [] : stoneIdxOfAssignment(selectedId))

  /** 当前编辑的策略族（选中层变化→回指派真值；手动切换→新族草稿从空起）。 */
  let kindDraft = $state<KernelStrategyKind | null>(null)

  $effect(() => {
    const current = assignment
    kindDraft = current === null ? null : current.strategyKind
  })

  const spec = $derived(kindDraft === null ? null : STRATEGY_FORM_SPECS[kindDraft])

  /** 表单草稿（输入框字符串态——应用时按字段控制类型回转）。 */
  let draft = $state<Record<string, string>>({})
  let densityText = $state('')
  /** 钻选择草稿（null=未改动——应用时继承既有指派钻；首指派必选）。 */
  let stoneDraft = $state<number[] | null>(null)

  $effect(() => {
    // 选中层/策略族变化 → 草稿重置为该族当前值（新族=空——缺省交服务端推导）。
    const current = assignment
    const next: Record<string, string> = {}
    if (current !== null && kindDraft === current.strategyKind) {
      for (const [key, value] of Object.entries(current.params)) {
        next[key] = value === undefined || value === null ? '' : String(value)
      }
    }
    draft = next
    densityText =
      current !== null && kindDraft === current.strategyKind ? String(current.densityPerCm2) : ''
    stoneDraft = null
  })

  /** 钻选择器选中集（未改动=指派反查；首指派=空——应用校验引导）。 */
  const selectedStoneIdx = $derived(stoneDraft ?? assignedIdx)

  /**
   * 空选语义（Codex v3 复核——真源一致性）：将显式发出选集（动过选择器或首指派）但
   * 为空 = 禁用应用——store 层空数组被当「继承旧钻」发送，UI 显示已选 0 而真源保留
   * 旧钻（所见≠真源）。清空指派请用 exclusion 策略（策略移除语义）。exclusion 无钻
   * 面不受此门。
   */
  const stoneIntentEmpty = $derived(
    kindDraft !== null &&
      kindDraft !== 'exclusion' &&
      (stoneDraft !== null || assignment === null) &&
      selectedStoneIdx.length === 0,
  )

  const fields = $derived(kindDraft === null ? [] : fieldsFor(kindDraft, draft))

  function setField(key: string, value: string): void {
    draft = { ...draft, [key]: value }
  }

  // ---- 选钻 Dialog（2026-10-05 Owner 整改：992 款平铺→Dialog 收纳；选集草稿=Dialog 内部
  //      working 态——应用经 onStonePickerApply 落 stoneDraft 再走现应用通道） ----
  let pickerOpen = $state(false)
  /** 钻选择面在场锚（static 族且非 exclusion——free-code 分支无钻面）。 */
  const stoneAreaVisible = $derived(
    kindDraft !== null && kindDraft !== 'exclusion' && kindDraft !== 'free-code' && spec !== null,
  )
  /** 策略族切走（钻面消失）→ 收口开窗锚（切回不意外复开 Dialog）。 */
  $effect(() => {
    if (!stoneAreaVisible) pickerOpen = false
  })
  /** 已选缩略横排行（idx→候选——不在候选表的 idx 不呈现，与反查同口径）。 */
  const selectedCandidates = $derived(
    selectedStoneIdx
      .map((idx) => candidates.find((candidate) => candidate.idx === idx))
      .filter((candidate): candidate is StoneCandidateRow => candidate !== undefined),
  )

  /** 选钻 Dialog 提交：先落 stoneDraft（入口横排即刻反映意图），再走现应用通道（成功由 Dialog 关窗）。 */
  async function onStonePickerApply(selection: number[]): Promise<boolean> {
    stoneDraft = [...selection]
    return onApply({ stoneSelection: selection })
  }

  /**
   * 应用载荷（G1 同源化 2026-09-28）：基座=strategyDefaultsOf(kind)（族最小合法参数
   * ——判别联合族必需判别值；与紧凑态应用同一序列化）；数字字段回转 number；空串
   * 省略（缺省语义交 daemon 推导）；判别键显式携带（草稿值覆盖基座缺省）。
   * H1（v4 修复轮三——Codex 三轮 P1-1）：requires-payload 族（free-code）不走本面
   * ——其应用经 onApplyFreeCode 以原指派载荷重发，此处仅服务 static 族。
   */  function paramsForApply(): Record<string, unknown> {
    if (kindDraft === null || spec === null) return {}
    const base = strategyDefaultsOf(kindDraft)
    const out = base.status === 'static' ? { ...base.params } : {}
    for (const field of fields) {
      const raw = draft[field.key] ?? ''
      if (raw === '') continue
      out[field.key] = field.control === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw
    }
    return out
  }

  /**
   * free-code 同族重应用（H1）：参数=原指派载荷整组（source/entryPoint/seed 保留——
   * JSON 深拷贝脱离 $state proxy）；密度可调（载荷不变仅密度重算）。别族切入的
   * 阻止面在模板（free-code 分支无重应用按钮+引导提示）。
   */
  async function onApplyFreeCode(): Promise<void> {
    if (selectedId === null || kindDraft !== 'free-code') return
    if (assignment === null || assignment.strategyKind !== 'free-code') return
    const params = JSON.parse(JSON.stringify(assignment.params)) as Record<string, unknown>
    const density = Number(densityText)
    await applyLayerStrategy(
      selectedId,
      'free-code',
      params,
      Number.isFinite(density) && density > 0 ? density : undefined,
    )
  }

  async function onApply(options: { stoneSelection?: number[] } = {}): Promise<boolean> {
    if (selectedId === null || kindDraft === null) return false
    let stoneIdx: number[] | undefined
    if (options.stoneSelection !== undefined) {
      // 选钻 Dialog 显式提交：空选=不发 stoneIdx（服务端沿用旧指派——Dialog 按钮文案
      // 已明示「空选=沿用当前指派」；首指派空选在 Dialog 侧禁用）。
      stoneIdx = options.stoneSelection.length > 0 ? options.stoneSelection : undefined
    } else {
      if (stoneIntentEmpty) return false // 空选门（上方 derived——按钮已禁用，键盘/竞态兜底）
      // 钻指派：草稿在=显式选集；未改动+既有指派=缺省（服务端继承旧钻）；首指派=以现选集发出
      //（空选已被 stoneIntentEmpty 门禁拦截——真源不落空集）。
      stoneIdx = stoneDraft !== null || assignment === null ? selectedStoneIdx : undefined
    }
    const density = Number(densityText)
    return applyLayerStrategy(
      selectedId,
      kindDraft,
      paramsForApply(),
      Number.isFinite(density) && density > 0 ? density : undefined,
      { stoneIdx },
    )
  }
</script>

<!-- 焦点域接线（属性面板=strategy-param——Ctrl+Z 路由面，D-3） -->
<div
  class="flex h-full min-h-0 flex-col"
  data-testid="workbench-inspector"
  onfocusin={() => setUndoFocusDomain('strategy-param')}
>
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">图层属性</span>
    {#if node !== null}
      <span class="text-muted-foreground min-w-0 flex-1 truncate text-[11px]" title={node.objectName}>{node.objectName}</span>
    {:else}
      <span class="text-muted-foreground ml-auto text-[10px]">策略直改（不注入对话）</span>
    {/if}
  </div>

  <div class="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
    {#if assignment === null && node === null}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs" data-testid="workbench-params-empty">
        在左侧图层树选择一个图层——属性/策略/用钻在此调整
      </p>
    {:else if node === null}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs" data-testid="workbench-params-empty">
        该图层已不在树中（可能已被拆分替换）——重新选择
      </p>
    {:else if isGroup}
      <!-- v5 组门（Owner 裁定：组恒不产钻）——策略区无任何指派控件；基本信息保留 -->
      <section class="space-y-1.5" data-testid="workbench-inspector-info">
        <div class="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">基本信息</div>
        <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">类别</dt>
            <dd class="truncate font-medium" title={node.category}>{node.category}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">子图层</dt>
            <dd class="font-mono">{node.children.length}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">尺寸</dt>
            <dd class="font-mono">
              {model?.ppm != null
                ? `${(node.bbox.w / model.ppm.ppm).toFixed(0)}×${(node.bbox.h / model.ppm.ppm).toFixed(0)} mm`
                : `${node.bbox.w}×${node.bbox.h} px`}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">有效粒径</dt>
            <dd class="font-mono">{node.effectiveMm.toFixed(1)} mm</dd>
          </div>
        </dl>
        <!-- 抠图指令（2026-10-05 Owner 需求「图层怎么抠出来的」）：树节点 segmentPrompt
             （SAM 文本/box 指令原文）+origin（产出方式）。逐层重抠（tree.refine）换新
             指令时随树推进更新。 -->
        {#if node.segmentPrompt !== undefined && node.segmentPrompt !== null && node.segmentPrompt !== ''}
          <div class="border-border/60 rounded border border-dashed px-2 py-1.5">
            <div class="text-muted-foreground flex items-baseline justify-between gap-2">
              <span class="text-[10px] font-semibold uppercase tracking-wide">抠图指令</span>
              <span class="rounded border px-1 font-mono text-[9px] leading-none" title="产出方式：vlm+sam3=识图引导抠图；refinement=树精修重抠" data-testid="workbench-inspector-seg-origin">{node.origin}</span>
            </div>
            <p class="mt-1 break-words font-mono text-[10px] leading-snug" title="SAM 指令原文（box[..]=框选指令）" data-testid="workbench-inspector-seg-prompt">{node.segmentPrompt}</p>
          </div>
        {/if}
      </section>
      <section class="space-y-1.5" data-testid="workbench-params-hierarchy">
        <div class="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">策略（组）</div>
        <p class="rounded-md border border-dashed px-2.5 py-3 text-center text-xs leading-relaxed">
          组不产钻——拆分后在子图层指派
          <span class="text-muted-foreground mt-1 block text-[10px]">图层=PS 图层、钻=图层特效（fx）：父级（组）恒不套钻；在左侧选中其子图层即可指派</span>
        </p>
        {#if assignment !== null}
          <p class="text-destructive rounded-md border border-destructive/30 px-2.5 py-2 text-[10px] leading-relaxed" role="alert" data-testid="workbench-params-hierarchy-stale">
            该组存在旧指派（{assignment.strategyKind}——v4 语义产物）——已失效：组不产钻，重算不再产块；下次任何策略重算后自动收敛移除
          </p>
        {/if}
      </section>
    {:else}
      <!-- 基本信息（类别/尺寸 mm/覆盖率/行程数） -->
      <section class="space-y-1.5" data-testid="workbench-inspector-info">
        <div class="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">基本信息</div>
        <dl class="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">类别</dt>
            <dd class="truncate font-medium" title={node.category}>{node.category}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">尺寸</dt>
            <dd class="font-mono">
              {model?.ppm != null
                ? `${(node.bbox.w / model.ppm.ppm).toFixed(0)}×${(node.bbox.h / model.ppm.ppm).toFixed(0)} mm`
                : `${node.bbox.w}×${node.bbox.h} px`}
            </dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground" title="掩码位面 1 位占比（位面就绪时）">掩码覆盖</dt>
            <dd class="font-mono">{maskCoverage !== null ? `${(maskCoverage * 100).toFixed(1)}%` : '—'}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground" title="mask 编辑留痕行程数（笔刷编辑后）">行程数</dt>
            <dd class="font-mono">{maskEdit !== null ? maskEdit.runCount : '—'}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">值得贴</dt>
            <dd>{node.drillWorthy ? '是' : '否（不产钻）'}</dd>
          </div>
          <div class="flex items-baseline justify-between gap-2">
            <dt class="text-muted-foreground">有效粒径</dt>
            <dd class="font-mono">{node.effectiveMm.toFixed(1)} mm</dd>
          </div>
        </dl>
        <!-- 抠图指令（2026-10-05 Owner 需求「图层怎么抠出来的」）：树节点 segmentPrompt
             （SAM 文本/box 指令原文）+origin（产出方式）。逐层重抠（tree.refine）换新
             指令时随树推进更新。 -->
        {#if node.segmentPrompt !== undefined && node.segmentPrompt !== null && node.segmentPrompt !== ''}
          <div class="border-border/60 rounded border border-dashed px-2 py-1.5">
            <div class="text-muted-foreground flex items-baseline justify-between gap-2">
              <span class="text-[10px] font-semibold uppercase tracking-wide">抠图指令</span>
              <span class="rounded border px-1 font-mono text-[9px] leading-none" title="产出方式：vlm+sam3=识图引导抠图；refinement=树精修重抠" data-testid="workbench-inspector-seg-origin">{node.origin}</span>
            </div>
            <p class="mt-1 break-words font-mono text-[10px] leading-snug" title="SAM 指令原文（box[..]=框选指令）" data-testid="workbench-inspector-seg-prompt">{node.segmentPrompt}</p>
          </div>
        {/if}
      </section>

      <!-- 掩码编辑状态（恢复链——stale/error 重算/放弃；incomplete 放弃；ready 只读呈现） -->
      {#if maskEdit !== null}
        <section class="space-y-1.5" data-testid="workbench-inspector-mask-edit">
          <div class="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">掩码编辑状态</div>
          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Badge
              variant={maskEdit.state === 'ready' && !maskEdit.incomplete ? 'secondary' : 'destructive'}
              data-testid="workbench-inspector-mask-edit-badge"
              title={maskEdit.incomplete
                ? `蒙版行程超限（${maskEdit.runCount}>4096——如实落盘但禁止导出，继续编辑收敛回限内或放弃告警）`
                : undefined}
            >
              {maskEdit.incomplete
                ? `行程超限（${maskEdit.runCount}>4096）`
                : maskEdit.state === 'stale'
                  ? '已漂移（stale）——编辑基线漂移，重算后再导出'
                  : maskEdit.state === 'error'
                    ? `重算失败（${maskEdit.state}）`
                    : `已编辑（行程 ${maskEdit.runCount} 段）`}
            </Badge>
            {#if maskEdit.state === 'stale' || maskEdit.state === 'error'}
              <Button
                size="sm"
                variant="outline"
                class="h-6 px-2 text-[10px]"
                disabled={getMaskEditActionBusy() !== null}
                onclick={() => void retryMaskEditNode(node.id)}
                data-testid="workbench-mask-retry-{node.id}"
                title="重放重算（maskEdit.retry——基于电流树重放，成功后导出门重估）"
              >
                <RefreshCw class="size-3" aria-hidden="true" />
                重算
              </Button>
            {/if}
            {#if maskEdit.state === 'stale' || maskEdit.state === 'error' || maskEdit.incomplete}
              <Button
                size="sm"
                variant="outline"
                class="text-destructive border-destructive/40 hover:bg-destructive/10 h-6 px-2 text-[10px]"
                disabled={getMaskEditActionBusy() !== null}
                onclick={() => void discardMaskEditNode(node.id)}
                data-testid="workbench-mask-discard-{node.id}"
                title="确认放弃（maskEdit.discard——mask 已落盘如实不回滚，仅清告警/门阻断面）"
              >
                <Trash2 class="size-3" aria-hidden="true" />
                放弃告警
              </Button>
            {/if}
          </div>
          {#if maskEdit.error !== null}
            <p class="text-destructive text-[10px] leading-relaxed">{maskEdit.error}</p>
          {/if}
        </section>
      {/if}

      <!-- fx 定位锚（v5：图层面板 fx 徽标点击→本锚滚入视野） -->
      <div bind:this={strategyAnchorEl} aria-hidden="true"></div>

      <!-- 策略区 -->
      {#if kindDraft === null}
        <!-- 未指派层：推荐决策树起排（v4 design §5——纹理优先缺省；strategy.set 支持新指派） -->
        <section class="space-y-2" data-testid="workbench-recommend">
          <div class="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">策略（未指派——推荐）</div>
          <!-- 通用推荐：texture-fill 首项（绝大部分场景的通用解） -->
          <button
            type="button"
            class="hover:border-primary/60 w-full rounded-md border px-2.5 py-2 text-left transition-colors"
            onclick={() => (kindDraft = RECOMMEND_PRIMARY)}
            data-testid="workbench-recommend-primary"
            title="纹理贴图（texture-fill）——散布/流向/混合按画面特征路由；绝大部分场景的通用解"
          >
            <span class="flex items-center gap-1.5 text-xs font-medium">
              <Zap class="text-primary size-3" aria-hidden="true" />
              {STRATEGY_FORM_SPECS[RECOMMEND_PRIMARY].label}（推荐）
            </span>
            <span class="text-muted-foreground mt-0.5 block text-[10px] leading-relaxed">
              纹理优先缺省——按画面特征散布/流向/混合；通用场景直接用这档
            </span>
          </button>
          <!-- 「硬朗+纯色」分支：规整族低成本解（提示下才展开） -->
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground flex w-full items-center gap-1 text-[10px] transition-colors"
            onclick={() => (regularOpen = !regularOpen)}
            aria-expanded={regularOpen}
            data-testid="workbench-recommend-regular-toggle"
            title="画面硬朗且填充区接近纯色（条纹/栏杆/规整几何面）时——规整族是低成本解"
          >
            画面硬朗且填充区接近纯色？展开规整族低成本解
          </button>
          {#if regularOpen}
            <div class="space-y-1 rounded-md border border-dashed p-1.5" data-testid="workbench-recommend-regular">
              {#each REGULAR_FAMILY as kind (kind)}
                <button
                  type="button"
                  class="hover:bg-accent flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors"
                  onclick={() => (kindDraft = kind)}
                  data-testid="workbench-recommend-regular-{kind}"
                  title="{STRATEGY_FORM_SPECS[kind].note}——低成本规整解（仅硬朗+纯色场景）"
                >
                  <span class="font-medium">{STRATEGY_FORM_SPECS[kind].label}</span>
                  <span class="text-muted-foreground text-[10px]">{kind}</span>
                </button>
              {/each}
              <p class="text-muted-foreground/70 px-1 text-[10px] leading-relaxed">
                规整族仅在画面硬朗、填充区接近纯色时作为低成本解——其余场景回到纹理贴图
              </p>
            </div>
          {/if}
          <!-- 其他族（完整清单——纹理优先序） -->
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs">其他策略族</span>
            <select
              class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
              value=""
              onchange={(event) => {
                const next = event.currentTarget.value as KernelStrategyKind
                if (next in STRATEGY_FORM_SPECS) kindDraft = next
              }}
              data-testid="workbench-kind-select"
            >
              <option value="" disabled>选择策略族…（纹理贴图为通用缺省）</option>
              {#each KIND_OPTIONS as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        </section>
      {:else if spec === null}
        <p class="text-muted-foreground px-1 py-6 text-center text-xs">未知策略族</p>
      {:else if kindDraft === 'free-code'}
        <!-- free-code：参数经代码工件/inline 源码承载（H1/Codex 三轮 P1-1）——
             ① 已有 free-code 指派=同族重应用（原载荷 source 保留，仅密度可调）；
             ② 从别族切入=阻止+引导提案流程（无载荷直改必被 daemon params-invalid 拒） -->
        <section class="space-y-2" data-testid="workbench-freecode-direct">
          <div class="flex items-center gap-2">
            <Badge variant="secondary">{spec.label}</Badge>
          </div>
          {#if assignment !== null && assignment.strategyKind === 'free-code'}
            <p class="text-muted-foreground text-[11px] leading-relaxed">
              该层已有自由代码指派——重应用保留原源码载荷（source 不变），可调密度触发重算；算法本身的调整请在 Agent 会话中重新提案。
            </p>
            <label class="block space-y-1">
              <span class="text-muted-foreground text-xs">密度（颗/cm²）</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                bind:value={densityText}
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                data-testid="workbench-params-field-density"
              />
            </label>
            <Button
              size="sm"
              class="w-full"
              disabled={applying}
              onclick={() => void onApplyFreeCode()}
              data-testid="workbench-freecode-reapply"
              title="按原源码载荷+新密度重算（D-1 直接生效——payload 保留 source/entryPoint/seed）"
            >
              <Zap class="size-3.5" aria-hidden="true" />
              {applying ? '重算中…' : '重应用（保留源码载荷）'}
            </Button>
            {#if applyError !== null}
              <p class="text-destructive text-[11px] leading-relaxed" data-testid="workbench-apply-error" role="alert">
                应用失败：{applyError}
              </p>
            {/if}
          {:else}
            <p class="text-destructive text-[11px] leading-relaxed" role="alert" data-testid="workbench-freecode-blocked">
              {FREE_CODE_PROPOSAL_HINT}
            </p>
          {/if}
        </section>
      {:else}
        <section class="space-y-2.5">
          <div class="text-muted-foreground text-[10px] font-semibold uppercase tracking-wide">策略</div>
          <div class="flex items-center gap-2">
            <Badge variant={kindDraft === 'exclusion' ? 'destructive' : 'secondary'} data-testid="workbench-params-kind">{spec.label}</Badge>
          </div>
          <p class="text-muted-foreground text-[11px] leading-relaxed">{spec.note}</p>

          <!-- 策略族切换（直改面主权：换族=整组参数按新族缺省重建；v4 决策树序——纹理优先） -->
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs">策略族</span>
            <select
              class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
              value={kindDraft}
              onchange={(event) => {
                const next = event.currentTarget.value as KernelStrategyKind
                if (next in STRATEGY_FORM_SPECS) kindDraft = next
              }}
              data-testid="workbench-kind-select"
              title="纹理贴图=通用缺省（绝大部分场景）；规整族（直线/几何）仅「画面硬朗且填充区接近纯色」时作为低成本解"
            >
              {#each KIND_OPTIONS as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>

          {#if spec.discriminant !== undefined}
            <label class="block space-y-1">
              <span class="text-muted-foreground text-xs">{spec.discriminant.label}</span>
              <select
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
                value={draft[spec.discriminant.key] ?? discriminantValueOf(spec, draft)}
                onchange={(event) => setField(spec.discriminant!.key, event.currentTarget.value)}
                data-testid="workbench-params-discriminant"
              >
                {#each spec.discriminant.options as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          {/if}

          {#each fields as field (field.key)}
            <label class="block space-y-1">
              <span class="text-muted-foreground flex items-center gap-1 text-xs">
                {field.label}
                {#if field.optional}<span class="opacity-60">（可空）</span>{/if}
                {#if field.derived}<span class="opacity-60">（服务端派生·只读）</span>{/if}
              </span>
              {#if field.control === 'number'}
                <input
                  type="number"
                  value={draft[field.key] ?? ''}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  disabled={field.derived}
                  oninput={(event) => setField(field.key, event.currentTarget.value)}
                  class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs disabled:opacity-60"
                  data-testid="workbench-params-field-{field.key}"
                />
              {:else if field.control === 'select'}
                <select
                  value={draft[field.key] ?? ''}
                  disabled={field.derived}
                  onchange={(event) => setField(field.key, event.currentTarget.value)}
                  class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
                  data-testid="workbench-params-field-{field.key}"
                >
                  {#each field.options ?? [] as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                  {/each}
                </select>
              {:else}
                <input
                  type="text"
                  value={draft[field.key] ?? ''}
                  disabled={field.derived}
                  oninput={(event) => setField(field.key, event.currentTarget.value)}
                  class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs disabled:opacity-60"
                  data-testid="workbench-params-field-{field.key}"
                />
              {/if}
              {#if field.help}
                <span class="text-muted-foreground/80 block text-[10px]">{field.help}</span>
              {/if}
            </label>
          {/each}

          {#if kindDraft !== 'exclusion'}
            <label class="block space-y-1">
              <span class="text-muted-foreground text-xs">密度（颗/cm²）</span>
              <input
                type="number"
                min="0.1"
                step="0.1"
                bind:value={densityText}
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs"
                data-testid="workbench-params-field-density"
              />
            </label>
          {/if}

          <!-- 钻选择入口（2026-10-05 Owner 整改：992 款平铺色块网格→选钻 Dialog 收纳——
               搜索/分组/真实贴图配图；本面=入口按钮+已选缩略横排（≤6 枚+溢出 +N）。
               free-code 分支已在上方整段排除） -->
          {#if kindDraft !== 'exclusion'}
            <div class="space-y-1.5">
              <div class="flex items-baseline gap-1.5">
                <span class="text-muted-foreground text-xs">用钻</span>
                <span class="text-muted-foreground/70 text-[10px]">候选 {candidates.length} 款 · 已选 {selectedStoneIdx.length}</span>
              </div>
              {#if candidates.length === 0}
                <p class="text-muted-foreground text-[10px] leading-relaxed" data-testid="workbench-stones-empty">
                  候选表为空——先在「钻库」入库钻规格（当前指派钻沿用不受影响）
                </p>
              {:else}
                <button
                  type="button"
                  class="border-input bg-background hover:border-primary/50 focus-visible:ring-ring flex w-full items-center gap-2 rounded-md border px-2.5 py-2 text-left outline-none focus-visible:ring-2"
                  onclick={() => (pickerOpen = true)}
                  data-testid="workbench-stone-picker"
                  title="打开选钻面板（搜索/按族分组/贴图浏览——多选=混钻排布）"
                >
                  <Gem class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                  <span class="min-w-0 flex-1 truncate text-xs" data-testid="workbench-stone-picker-label">
                    {selectedStoneIdx.length > 0 ? `选择用钻（当前 ${selectedStoneIdx.length} 款）` : '智能选钻（未指定）'}
                  </span>
                  {#if stoneDraft !== null}
                    <span class="text-primary shrink-0 text-[10px]">已改动</span>
                  {/if}
                </button>
                {#if selectedCandidates.length > 0}
                  <div class="flex flex-wrap items-center gap-1" data-testid="workbench-stone-selected-strip">
                    {#each selectedCandidates.slice(0, 6) as candidate (candidate.idx)}
                      <span
                        class="border-border relative size-6 overflow-hidden rounded border"
                        title="{candidate.sku} · {candidate.sizeMm !== null ? `${candidate.sizeMm}mm` : '未声明尺寸'} · {candidate.supplier}"
                      >
                        {#if candidate.textureUrl}
                          <img
                            src={withAuthToken(candidate.textureUrl)}
                            alt="{candidate.sku} 贴图"
                            loading="lazy"
                            class="h-full w-full object-contain"
                            data-testid="workbench-stone-strip-img-{candidate.idx}"
                          />
                        {:else}
                          <span class="absolute inset-0" style="background: {candidate.colorHex}" aria-hidden="true"></span>
                        {/if}
                      </span>
                    {/each}
                    {#if selectedCandidates.length > 6}
                      <span class="text-muted-foreground text-[10px]">+{selectedCandidates.length - 6}</span>
                    {/if}
                  </div>
                {/if}
                <p class="text-muted-foreground/70 text-[10px]">
                  {stoneDraft === null ? '不改动=沿用当前指派钻' : '选集已改动——随应用提交'}
                </p>
              {/if}
            </div>
          {/if}

          <Button
            size="sm"
            class="w-full"
            disabled={applying || stoneIntentEmpty}
            onclick={() => void onApply()}
            data-testid="workbench-apply-strategy"
            title={stoneIntentEmpty ? '至少选一款钻——空选不落真源（清空指派请用排除区策略移除）' : undefined}
          >
            <Zap class="size-3.5" aria-hidden="true" />
            {applying ? '重算中…' : '应用（直接生效）'}
          </Button>
          {#if stoneIntentEmpty}
            <p class="text-destructive text-[10px] leading-relaxed" data-testid="workbench-stone-empty-intent" role="alert">
              至少选一款（清空请用策略移除）——空选不会更新真源指派
            </p>
          {/if}
          {#if applyError !== null}
            <p class="text-destructive text-[11px] leading-relaxed" data-testid="workbench-apply-error" role="alert">
              应用失败：{applyError}
            </p>
          {/if}
          <p class="text-muted-foreground/80 text-center text-[10px]">
            应用后立即按新参数重算该层点阵并刷新全图预览（D-1 人类主权面直改——不经对话提案）
          </p>
        </section>
      {/if}
    {/if}
  </div>
</div>

<!-- 选钻 Dialog（根级挂载——策略族切走（exclusion/free-code）时 open 锚收口即关） -->
<WorkbenchStonePickerDialog
  open={pickerOpen && stoneAreaVisible}
  candidates={candidates}
  selectedIdx={selectedStoneIdx}
  applying={applying}
  applyError={applyError}
  hasExistingAssignment={assignment !== null}
  onOpenChange={(next) => (pickerOpen = next)}
  onApply={onStonePickerApply}
/>
