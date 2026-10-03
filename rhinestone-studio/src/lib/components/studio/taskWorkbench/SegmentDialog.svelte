<!--
SegmentDialog.svelte — 工作台抠图 Dialog（add-vision-pipeline-v2 T5/D6——任务详情形态）。
Owner 定调（2026-10-03 逐句）：「点击出现一个弹窗，这个弹窗中可以看到要扣的图层，然后
可以输入指令，可以调整参数，可以预览结果。等满意了再确定要使用这个 mask 落地层图层，
并可以在落地图层之前自定义图层名称。」
结构（单一任务=任务详情；store=队列预埋——segmentTasks.svelte）：
  [目标层预览]（LayerCutoutThumb 现有渲染面+层名+既有 segmentPrompt 追溯）
  [指令输入]（自由文本——服务端记 segmentPrompt 原文）
  [参数区]（precision：maskMaxSide/confThreshold——空=「跟随配置」语义，不发明新 UI 依赖）
  [试跑]（dryRun=true：真跑分段 1-2 分钟不落树——loading 态+结果预览+质量门警告+回放标记）
  [图层命名]（空=服务端提示语命名链——placeholder 展示回退名）
  [确认落地 / 取消]（确认=同参 dryRun=false——服务端账本命中掩膜回放，零二次桥调）
Codex R1 修复批（2026-10-04）：
  P1 预览绑定确认：试跑成功记基态快照（instruction/precision/targetNodeId/treeBlobRef）；
    参数漂移=回 draft+预览作废+「参数已变更，请重新试跑」；树基态漂移=确认禁用+提示
    （确认请求携 trialTreeBlobRef——服务端 trial-stale-tree typed 拒双保险）。
  P2-1 吞没文案：零检出且 warnings 含 child-consumed=「无落地结果（被兄弟 X 吞没）」。
  P2-3 忙碌态关窗闸：trialing/landing 中 Escape/外点/关闭钮一律不关。
  P2-5 参数草稿：两输入框独立文本草稿（taskId 键控），失焦/试跑时校验——非法/越界=
    错误提示且不参与试跑（逐字输入中间态不清空）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import type { SegmentPrecision } from '@handicraft/contracts'
  import {
    getBaseImageUrl,
    getNodeOf,
    getWorkbenchDetail,
    getWorkbenchLayerRender,
  } from './store.svelte'
  import {
    closeSegmentTask,
    confirmSegmentLanding,
    getActiveSegmentTask,
    runSegmentTrial,
    updateSegmentTask,
  } from './segmentTasks.svelte.js'
  import LayerCutoutThumb from './LayerCutoutThumb.svelte'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import RotateCw from '@lucide/svelte/icons/rotate-cw'
  import Scissors from '@lucide/svelte/icons/scissors'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'

  const task = $derived(getActiveSegmentTask())
  const target = $derived(task === null ? null : getNodeOf(task.targetNodeId))
  const baseImageUrl = $derived(getBaseImageUrl())
  const imagePx = $derived(getWorkbenchLayerRender()?.imagePx)

  // 目标节点消失（工作台切任务/树重装载）→ 关任务详情（stale 目标不可试跑/落地）
  $effect(() => {
    if (getActiveSegmentTask() !== null && getNodeOf(getActiveSegmentTask()!.targetNodeId) === null) {
      closeSegmentTask()
    }
  })

  const busy = $derived(task !== null && (task.status === 'trialing' || task.status === 'landing'))
  const hasInstance = $derived((task?.trialResult?.children.length ?? 0) > 0)

  // —— 参数区（Codex R1 P2-5）：独立文本草稿（taskId 键控——任务切换/新任务自动弃用
  //    旧草稿回退任务 precision 衍生值）；失焦/试跑时校验：空=跟随配置；非法/越界=
  //    错误提示且不参与试跑（不回写解析值——逐字输入中间态不清空）。
  interface PrecisionDraft {
    taskId: string
    maskMaxSide: string
    confThreshold: string
    maskMaxSideError: string | null
    confThresholdError: string | null
  }
  let precisionDraft = $state<PrecisionDraft | null>(null)
  const draftActive = $derived(precisionDraft !== null && precisionDraft.taskId === task?.id)
  const maskMaxSideText = $derived(
    draftActive ? precisionDraft!.maskMaxSide
      : task?.precision?.maskMaxSide !== undefined ? String(task.precision.maskMaxSide) : '',
  )
  const confThresholdText = $derived(
    draftActive ? precisionDraft!.confThreshold
      : task?.precision?.confThreshold !== undefined ? String(task.precision.confThreshold) : '',
  )
  const maskMaxSideError = $derived(draftActive ? precisionDraft!.maskMaxSideError : null)
  const confThresholdError = $derived(draftActive ? precisionDraft!.confThresholdError : null)
  const precisionInvalid = $derived(maskMaxSideError !== null || confThresholdError !== null)

  const canTrial = $derived(
    task !== null && !busy && task.status !== 'done' && task.instruction.trim() !== '' && !precisionInvalid,
  )

  // —— 树基态漂移守卫（Codex R1 P1）：试跑后树被别处改过（当前树引用≠快照）=确认禁用+提示
  const currentTreeRef = $derived(getWorkbenchDetail()?.tree?.blobRef ?? null)
  const treeDrifted = $derived(
    task !== null &&
    task.status === 'preview-ready' &&
    task.trialSnapshot !== null &&
    currentTreeRef !== null &&
    currentTreeRef !== task.trialSnapshot.treeBlobRef,
  )
  const canLand = $derived(task !== null && task.status === 'preview-ready' && hasInstance && !treeDrifted)

  /** 目标层是画布根（parent=null——缩略走原图直出面）。 */
  const isRoot = $derived(target?.parent == null)

  /** 解析草稿（空=跟随配置；非法/越界=错误文案，值不参与试跑）。 */
  function parsePrecisionDrafts(nextMaskMaxSide: string, nextConfThreshold: string): {
    ok: boolean
    value: SegmentPrecision | null
    maskMaxSideError: string | null
    confThresholdError: string | null
  } {
    let ok = true
    let maskMaxSideError: string | null = null
    let confThresholdError: string | null = null
    const maskText = nextMaskMaxSide.trim()
    const confText = nextConfThreshold.trim()
    let maskMaxSide: number | undefined
    let confThreshold: number | undefined
    if (maskText !== '') {
      const n = Number(maskText)
      if (!Number.isInteger(n) || n < 32) {
        ok = false
        maskMaxSideError = '掩膜长边上限须为 ≥32 的整数（该值不参与试跑）'
      } else {
        maskMaxSide = n
      }
    }
    if (confText !== '') {
      const n = Number(confText)
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        ok = false
        confThresholdError = '置信度阈值须在 0..1 区间（该值不参与试跑）'
      } else {
        confThreshold = n
      }
    }
    const value = !ok
      ? null
      : maskMaxSide === undefined && confThreshold === undefined
        ? null
        : {
            ...(maskMaxSide !== undefined ? { maskMaxSide } : {}),
            ...(confThreshold !== undefined ? { confThreshold } : {}),
          }
    return { ok, value, maskMaxSideError, confThresholdError }
  }

  /** 校验并提交草稿到任务 precision（失焦/试跑前调用——返回 false=存在非法值不试跑）。 */
  function commitPrecisionDrafts(): boolean {
    if (task === null) return false
    const parsed = parsePrecisionDrafts(maskMaxSideText, confThresholdText)
    precisionDraft = {
      taskId: task.id,
      maskMaxSide: maskMaxSideText,
      confThreshold: confThresholdText,
      maskMaxSideError: parsed.maskMaxSideError,
      confThresholdError: parsed.confThresholdError,
    }
    if (!parsed.ok) return false
    updateSegmentTask(task.id, { precision: parsed.value })
    return true
  }

  function onMaskMaxSideInput(event: Event): void {
    if (task === null) return
    const value = (event.currentTarget as HTMLInputElement).value
    precisionDraft = {
      taskId: task.id,
      maskMaxSide: value,
      confThreshold: confThresholdText,
      maskMaxSideError: null, // 新输入即清本字段错误（复校验在失焦/试跑）
      confThresholdError,
    }
  }

  function onConfThresholdInput(event: Event): void {
    if (task === null) return
    const value = (event.currentTarget as HTMLInputElement).value
    precisionDraft = {
      taskId: task.id,
      maskMaxSide: maskMaxSideText,
      confThreshold: value,
      maskMaxSideError,
      confThresholdError: null,
    }
  }

  function onInstructionInput(event: Event): void {
    if (task === null) return
    updateSegmentTask(task.id, { instruction: (event.currentTarget as HTMLInputElement).value })
  }

  function onLayerNameInput(event: Event): void {
    if (task === null) return
    updateSegmentTask(task.id, { layerName: (event.currentTarget as HTMLInputElement).value })
  }

  /** 试跑入口：先提交参数草稿（非法=呈现错误不试跑），再跑。 */
  function onTrialClick(): void {
    if (task === null) return
    if (!commitPrecisionDrafts()) return
    void runSegmentTrial(task.id)
  }

  /** 命名回退链（placeholder——服务端「把X拆出来」→X 提取；无试跑结果时按指令预估）。 */
  const fallbackName = $derived.by(() => {
    if (task === null) return ''
    const named = task.trialResult?.children[0]?.objectName
    if (named !== undefined && named !== '') return named
    const parsed = /把(.{1,12}?)(拆|分)/.exec(task.instruction.trim())
    return parsed?.[1] ?? task.instruction.trim().slice(0, 12)
  })

  /** 试跑预览 dataUrl（dataBase64→img src——mock/jsdom 与真链路同形）。 */
  const previewDataUrl = $derived.by(() => {
    const preview = task?.trialResult?.preview
    if (preview === undefined || preview.dataBase64 === '') return null
    return `data:${preview.mime};base64,${preview.dataBase64}`
  })

  /** 完全吞没文案（Codex R1 P2-1 前端面）：child-consumed/兄弟消解 warning 的「无落地结果」。 */
  const consumedDetail = $derived.by(() => {
    const warnings = task?.trialResult?.warnings ?? []
    return (
      warnings.find((warning) => warning.reason === 'child-consumed')?.detail
      ?? warnings.find((warning) => warning.reason === 'sibling-overlap-consumed')?.detail
      ?? null
    )
  })

  // —— 关窗闸（Codex R1 P2-3）：trialing/landing 中 Escape/外点/关闭钮一律不关——
  //    本地 open 镜像 + Content 行为闸（escape/outside=ignore）双保险；关窗仅清 draft 态任务。
  const wantOpen = $derived(task !== null && target !== null)
  let dialogOpen = $state(false)
  $effect(() => {
    dialogOpen = wantOpen
  })
</script>

<Dialog.Root
  open={dialogOpen}
  onOpenChange={(open) => {
    if (!open && busy) {
      dialogOpen = true // 忙碌态拒绝关窗（重申受控 open——在途 RPC 不被打断）
      return
    }
    if (!open) closeSegmentTask()
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="bg-black/40" />
    <Dialog.Content
      class="bg-background fixed top-1/2 left-1/2 z-50 max-h-[85vh] w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-4 shadow-lg"
      escapeKeydownBehavior={busy ? 'ignore' : 'close'}
      interactOutsideBehavior={busy ? 'ignore' : 'close'}
      showCloseButton={!busy}
      data-testid="workbench-segment-dialog"
    >
      <Dialog.Header class="mb-3">
        <Dialog.Title class="flex items-center gap-1.5 text-sm font-semibold">
          <Scissors class="size-3.5" aria-hidden="true" />
          抠图（任务详情）
        </Dialog.Title>
        <Dialog.Description class="text-muted-foreground text-[11px] leading-relaxed">
          输入指令试跑（真跑 SAM 约 1-2 分钟，不落树）→ 预览掩膜 → 满意后命名落地
        </Dialog.Description>
      </Dialog.Header>

      {#if task !== null && target !== null}
        <!-- 目标层预览（现有缩略渲染面+层名+指令追溯） -->
        <div class="flex items-center gap-2.5 rounded-md border p-2.5" data-testid="workbench-segment-target">
          <LayerCutoutThumb
            nodeId={target.id}
            nodeBbox={isRoot ? undefined : target.bbox}
            baseImageUrl={isRoot ? baseImageUrl : undefined}
            imagePx={imagePx}
          />
          <div class="min-w-0 flex-1">
            <p class="truncate text-xs font-medium" data-testid="workbench-segment-target-name">{target.objectName}</p>
            <p class="text-muted-foreground font-mono text-[10px]">
              {target.bbox.w}×{target.bbox.h} px{isRoot ? ' · 画布根（子层落在画布内）' : ''}
            </p>
            {#if target.segmentPrompt !== undefined}
              <p class="text-muted-foreground/70 mt-0.5 truncate text-[10px]" title={target.segmentPrompt}>
                既有指令：{target.segmentPrompt}
              </p>
            {/if}
          </div>
        </div>

        <!-- 指令输入 -->
        <div class="mt-3 space-y-1">
          <label class="text-xs font-medium" for="workbench-segment-instruction">抠图指令</label>
          <input
            id="workbench-segment-instruction"
            type="text"
            value={task.instruction}
            disabled={busy}
            oninput={onInstructionInput}
            placeholder="如：把帽子拆出来 / the right wing"
            class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
            data-testid="workbench-segment-instruction"
          />
          <p class="text-muted-foreground/70 text-[10px]">中文自动英译只在 SAM 请求侧；图层 segmentPrompt 记指令原文</p>
        </div>

        <!-- 参数区（precision——空=跟随配置；独立文本草稿，失焦/试跑时校验） -->
        <div class="mt-3 grid grid-cols-2 gap-2">
          <div class="space-y-1">
            <label class="text-muted-foreground text-[10px] font-medium" for="workbench-segment-mask-max-side">
              掩膜长边上限（maskMaxSide）
            </label>
            <input
              id="workbench-segment-mask-max-side"
              type="text"
              inputmode="numeric"
              value={maskMaxSideText}
              disabled={busy}
              oninput={onMaskMaxSideInput}
              onblur={commitPrecisionDrafts}
              placeholder="跟随配置"
              title="SAM 请求侧掩码长边降采上限（px，≥32 整数；更高=更精细更慢；空=图像处理配置缺省）"
              class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
              data-testid="workbench-segment-mask-max-side"
            />
            {#if maskMaxSideError !== null}
              <p class="text-destructive text-[10px] leading-snug" data-testid="workbench-segment-mask-max-side-error" role="alert">
                {maskMaxSideError}
              </p>
            {/if}
          </div>
          <div class="space-y-1">
            <label class="text-muted-foreground text-[10px] font-medium" for="workbench-segment-conf-threshold">
              置信度阈值（confThreshold）
            </label>
            <input
              id="workbench-segment-conf-threshold"
              type="text"
              inputmode="decimal"
              value={confThresholdText}
              disabled={busy}
              oninput={onConfThresholdInput}
              onblur={commitPrecisionDrafts}
              placeholder="跟随配置"
              title="SAM 检出置信度阈值（0..1；更低=更宽容；空=图像处理配置缺省）"
              class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
              data-testid="workbench-segment-conf-threshold"
            />
            {#if confThresholdError !== null}
              <p class="text-destructive text-[10px] leading-snug" data-testid="workbench-segment-conf-threshold-error" role="alert">
                {confThresholdError}
              </p>
            {/if}
          </div>
        </div>

        <!-- 试跑参数作废提示（Codex R1 P1：参数变更后旧预览作废——回 draft 待重试跑） -->
        {#if task.staleNote !== null && task.status === 'draft'}
          <p class="text-amber-600 mt-2 flex items-start gap-1 text-[10px] leading-relaxed" data-testid="workbench-segment-stale-note" role="status">
            <TriangleAlert class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            {task.staleNote}
          </p>
        {/if}

        <!-- 试跑按钮（dryRun——真跑分段不落树） -->
        <div class="mt-3">
          <Button
            size="sm"
            variant="outline"
            class="w-full"
            disabled={!canTrial}
            onclick={onTrialClick}
            data-testid="workbench-segment-trial"
          >
            {#if task.status === 'trialing'}
              <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
              试跑中…（真跑约 1-2 分钟，不落树）
            {:else}
              {#if task.status === 'preview-ready' || task.status === 'failed'}
                <RotateCw class="size-3.5" aria-hidden="true" />
                重跑试跑（改指令/参数后）
              {:else}
                <Scissors class="size-3.5" aria-hidden="true" />
                试跑（预览掩膜，不落树）
              {/if}
            {/if}
          </Button>
        </div>

        <!-- 失败态（可重试——重试=再点试跑/落地按钮） -->
        {#if task.status === 'failed' && task.error !== null}
          <div
            class="text-destructive mt-3 flex items-start gap-1.5 rounded-md border border-destructive/40 px-2 py-1.5 text-[11px] leading-relaxed"
            data-testid="workbench-segment-error"
            role="alert"
          >
            <TriangleAlert class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            <span>{task.error}</span>
          </div>
        {/if}

        <!-- 试跑结果预览（掩膜叠加图+警告+回放标记） -->
        {#if task.trialResult !== null}
          <div class="mt-3 space-y-2 rounded-md border p-2.5" data-testid="workbench-segment-trial-result">
            <div class="flex items-center justify-between">
              <span class="text-xs font-medium">试跑结果</span>
              <span
                class="text-muted-foreground font-mono text-[9px]"
                title={task.trialResult.replayed ? '掩膜来自断点账本回放（零桥调用）' : '本次为 SAM 实跑（已入账本——确认落地直接回放）'}
                data-testid="workbench-segment-trial-replayed"
              >
                {task.trialResult.replayed ? '账本回放' : 'SAM 实跑'}
              </span>
            </div>
            {#if previewDataUrl !== null}
              <img
                src={previewDataUrl}
                alt="目标层掩膜叠加预览"
                draggable="false"
                class="bg-muted/40 mx-auto block max-h-56 w-auto rounded border"
                data-testid="workbench-segment-trial-preview"
              />
            {/if}
            {#if hasInstance}
              <p class="text-muted-foreground text-[10px]">
                将新增子层：{task.trialResult.children.map((child) => child.objectName).join('、')}
                （挂在「{target.objectName}」内——原层不动）
              </p>
            {:else if consumedDetail !== null}
              <!-- 完全吞没（Codex R1 P2-1）：互斥后无落地结果——点名胜者兄弟的明确文案 -->
              <p class="text-[10px] leading-relaxed" data-testid="workbench-segment-trial-empty">
                无落地结果：{consumedDetail}
              </p>
            {:else}
              <p class="text-[10px] leading-relaxed" data-testid="workbench-segment-trial-empty">
                零检出：该指令在目标层内没有可拆出的区域——换更具体的指令或调高精度（掩膜长边上限）后重跑
              </p>
            {/if}
            {#if task.trialResult.warnings.length > 0}
              <div class="space-y-1" data-testid="workbench-segment-trial-warnings">
                {#each task.trialResult.warnings.slice(0, 4) as warning}
                  <p class="text-muted-foreground flex items-start gap-1 text-[10px] leading-relaxed">
                    <TriangleAlert class="text-amber-600 mt-0.5 size-2.5 shrink-0" aria-hidden="true" />
                    {warning.detail}
                  </p>
                {/each}
              </div>
            {/if}
          </div>
        {/if}

        <!-- 图层命名（空=回退提示语命名链——placeholder 展示回退名） -->
        {#if task.status === 'preview-ready' || task.status === 'landing' || task.status === 'failed'}
          <div class="mt-3 space-y-1">
            <label class="text-xs font-medium" for="workbench-segment-layer-name">图层名（落地前自定义）</label>
            <input
              id="workbench-segment-layer-name"
              type="text"
              value={task.layerName}
              disabled={busy}
              oninput={onLayerNameInput}
              placeholder={fallbackName === '' ? '跟随指令命名' : `${fallbackName}（跟随指令命名）`}
              maxlength="64"
              class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
              data-testid="workbench-segment-layer-name"
            />
          </div>
        {/if}

        <Dialog.Footer class="mt-4 gap-1.5">
          <Button size="sm" variant="outline" disabled={busy} onclick={closeSegmentTask} data-testid="workbench-segment-cancel">
            取消
          </Button>
          <Button
            size="sm"
            disabled={!canLand}
            onclick={() => void confirmSegmentLanding(task.id)}
            data-testid="workbench-segment-apply"
            title={treeDrifted ? '试跑后图层树已被修改——重新试跑后再确认' : undefined}
          >
            {#if task.status === 'landing'}
              <LoaderCircle class="size-3.5 animate-spin" aria-hidden="true" />
              落地中…
            {:else}
              确认落地
            {/if}
          </Button>
        </Dialog.Footer>

        <!-- 树基态漂移提示（Codex R1 P1：试跑后树被别处改过——确认禁用+指引重跑） -->
        {#if treeDrifted}
          <p class="text-amber-600 mt-2 flex items-start gap-1 text-[10px] leading-relaxed" data-testid="workbench-segment-tree-drifted" role="alert">
            <TriangleAlert class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
            图层树在试跑后被修改（试跑结果已过期）——请重新试跑后再确认落地
          </p>
        {/if}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
