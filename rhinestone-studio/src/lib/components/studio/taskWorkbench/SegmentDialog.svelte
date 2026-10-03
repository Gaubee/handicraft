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
走查修复（2026-10-04 Owner 反馈「两个都 input-text？填写什么都不知道，默认值多少也没显示」）：
  参数区升级 number 输入（整数 px/0.01 步进+min/max 范围面）+空态 placeholder 展示
  服务端当前生效值（task.detail segmentDefaults 投影——「跟随配置（当前 1024）」，
  maskMaxSide null=原尺寸；前端不硬编码）+逐字段一句人话说明（maskMaxSide 语义=
  返回掩膜长边像素上限——原图始终全分辨率送 SAM）。草稿态语义不回退（P2-5 保持）。
add-sam-playbook T2 三模式（2026-10-04，D1/D2/D3）：
  [排除区拖画] 目标层区域视图/试跑预览上拖画矩形（红色虚线叠加）→ excludeBox 参与试跑/
    落地（服务端确定性像素减法——「框住的区域将从结果掩膜中扣除」）；矩形经 bbox 同源
    换算映射回 imagePx 画布坐标（预览是缩略图必反解）；可清除；P1 快照含 excludeBox
    （改排除区=改请求面→旧预览作废重试跑）。
  [纯框模式] 指令留空+画正框（蓝色实线）→ 纯框选抠图（「无指令=纯框选抠图」提示）；
    指令与正框二者都空=不可试跑；层名缺省「框选区域」。
  [实例枚举] instances 开关（缺省 best）；all=试跑回逐实例缩略列表（instancePreviews+
    序号+掩膜像素数——inline 掩膜 popcount）；落地=全量落地（子集勾选=挂账 follow-up）。
  试跑预览图上移进拖画区（preview-ready 时表面内容=掩膜叠加图，同几何可继续拖画）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import type { NodeBBox, SegmentPrecision } from '@handicraft/contracts'
  import { decodeInlineMask } from '@handicraft/contracts'
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

  // —— add-sam-playbook T2 三模式（D1/D2/D3）：
  //    排除区拖画（excludeBox 红色虚线——掩膜泄漏时框住泄漏区，服务端像素减法扣除）
  //    正框拖画（纯框模式：指令留空+画正框=纯框选抠图，不赌语义命中）
  //    实例枚举（instances 开关——all=同款多实例逐个成层，试跑后逐实例缩略列表）
  type DrawMode = 'exclude' | 'box'
  let drawMode = $state<DrawMode>('exclude')
  let drawSurfaceEl = $state<HTMLDivElement | null>(null)
  /** 拖画进行态（surface 局部 px——offsetX/Y 源）。 */
  let drawStart = $state<{ x: number; y: number } | null>(null)
  let drawCurrent = $state<{ x: number; y: number } | null>(null)
  const drawingRect = $derived(
    drawStart !== null && drawCurrent !== null
      ? { x0: Math.min(drawStart.x, drawCurrent.x), y0: Math.min(drawStart.y, drawCurrent.y), x1: Math.max(drawStart.x, drawCurrent.x), y1: Math.max(drawStart.y, drawCurrent.y) }
      : null,
  )
  /** 指令与正框至少一项（纯框模式=指令留空+正框；二者都空=不可试跑）。 */
  const hasInstruction = $derived(task !== null && task.instruction.trim() !== '')
  const hasBox = $derived(task !== null && task.box !== null)

  /** 排除区/正框 → surface 内百分比定位（预览图=目标层 bbox 区域缩略，bbox 同源换算）。 */
  const excludeRectPct = $derived.by(() => {
    if (task === null || target === null || task.excludeBox === null) return null
    const { bbox } = target
    return {
      left: ((task.excludeBox.x - bbox.x) / bbox.w) * 100,
      top: ((task.excludeBox.y - bbox.y) / bbox.h) * 100,
      width: (task.excludeBox.w / bbox.w) * 100,
      height: (task.excludeBox.h / bbox.h) * 100,
    }
  })
  const boxRectPct = $derived.by(() => {
    if (task === null || target === null || task.box === null) return null
    const { bbox } = target
    return {
      left: ((task.box.x - bbox.x) / bbox.w) * 100,
      top: ((task.box.y - bbox.y) / bbox.h) * 100,
      width: (task.box.w / bbox.w) * 100,
      height: (task.box.h / bbox.h) * 100,
    }
  })
  /** 拖画进行态 → 百分比（surface 尺寸经 offsetWidth/Height——jsdom 由测试桩注入）。 */
  const drawingRectPct = $derived.by(() => {
    const rect = drawingRect
    const el = drawSurfaceEl
    if (rect === null || el === null || el.offsetWidth <= 0 || el.offsetHeight <= 0) return null
    return {
      left: (rect.x0 / el.offsetWidth) * 100,
      top: (rect.y0 / el.offsetHeight) * 100,
      width: ((rect.x1 - rect.x0) / el.offsetWidth) * 100,
      height: ((rect.y1 - rect.y0) / el.offsetHeight) * 100,
    }
  })
  /** 草稿态底图裁剪定位（目标层 bbox 区域直出——CSS background 裁剪公式）。 */
  const cropStyle = $derived.by(() => {
    if (target === null || imagePx === undefined || baseImageUrl === null) return null
    const { bbox } = target
    const denomX = imagePx.width - bbox.w
    const denomY = imagePx.height - bbox.h
    return {
      backgroundImage: `url(${baseImageUrl})`,
      backgroundSize: `${(imagePx.width / bbox.w) * 100}% ${(imagePx.height / bbox.h) * 100}%`,
      backgroundPosition: `${denomX > 0 ? (bbox.x / denomX) * 100 : 0}% ${denomY > 0 ? (bbox.y / denomY) * 100 : 0}%`,
    }
  })

  function onDrawPointerDown(event: PointerEvent): void {
    if (task === null || busy) return
    drawStart = { x: event.offsetX, y: event.offsetY }
    drawCurrent = { ...drawStart }
  }

  function onDrawPointerMove(event: PointerEvent): void {
    if (drawStart === null) return
    drawCurrent = { x: event.offsetX, y: event.offsetY }
  }

  /** 松手提交：surface px → imagePx 画布坐标（bbox 同源换算——预览是缩略图必反解）。 */
  function onDrawPointerUp(): void {
    const rect = drawingRect
    const el = drawSurfaceEl
    if (task === null || target === null || rect === null || el === null || el.offsetWidth <= 0 || el.offsetHeight <= 0) {
      drawStart = null
      drawCurrent = null
      return
    }
    const toCanvasX = (sx: number): number => target.bbox.x + (sx / el.offsetWidth) * target.bbox.w
    const toCanvasY = (sy: number): number => target.bbox.y + (sy / el.offsetHeight) * target.bbox.h
    const canvasRect: NodeBBox = {
      x: Math.max(target.bbox.x, Math.round(Math.min(toCanvasX(rect.x0), toCanvasX(rect.x1)))),
      y: Math.max(target.bbox.y, Math.round(Math.min(toCanvasY(rect.y0), toCanvasY(rect.y1)))),
      w: Math.max(1, Math.round(Math.abs(toCanvasX(rect.x1) - toCanvasX(rect.x0)))),
      h: Math.max(1, Math.round(Math.abs(toCanvasY(rect.y1) - toCanvasY(rect.y0)))),
    }
    drawStart = null
    drawCurrent = null
    if (canvasRect.w < 2 || canvasRect.h < 2) return // 微点=误触忽略
    updateSegmentTask(task.id, drawMode === 'exclude' ? { excludeBox: canvasRect } : { box: canvasRect })
  }

  function clearExclude(): void {
    if (task === null) return
    updateSegmentTask(task.id, { excludeBox: null })
  }

  function clearBox(): void {
    if (task === null) return
    updateSegmentTask(task.id, { box: null })
  }

  function onInstancesToggle(event: Event): void {
    if (task === null) return
    const checked = (event.currentTarget as HTMLInputElement).checked
    updateSegmentTask(task.id, { instances: checked ? 'all' : 'best' })
  }

  /** 逐实例试跑缩略行（序号+名称+掩膜像素数——掩膜 inline 态 popcount，blob 态不可解）。 */
  const instanceRows = $derived.by(() => {
    const previews = task?.trialResult?.instancePreviews
    if (previews === undefined || task === null) return []
    return previews.map((preview, index) => {
      const child = task.trialResult?.children.find((candidate) => candidate.id === preview.nodeId)
      let maskPx: number | null = null
      if (child !== undefined && child.mask.kind === 'inline') {
        const bits = decodeInlineMask(child.mask).bits
        let count = 0
        for (const bit of bits) count += bit
        maskPx = count
      }
      return { preview, index: index + 1, objectName: preview.objectName ?? child?.objectName ?? `实例 ${index + 1}`, maskPx }
    })
  })

  // —— 参数缺省（Owner 走查 2026-10-04：「填写什么都不知道，默认值是多少你也没显示」）：
  //    服务端当前生效值=task.detail 的 segmentDefaults 投影（daemon
  //    imageProcessingEffective——settings→env→default 单源解析，改配置对下次
  //    task.detail 生效；前端不硬编码）。空态 placeholder 形如「跟随配置（当前 1024）」
  //    /「跟随配置（当前 0.4）」；maskMaxSide null=原尺寸。读面失败/字段缺席=回退纯
  //    「跟随配置」（缺省可见性降级，不阻塞参数面本身）。
  const segmentDefaults = $derived(getWorkbenchDetail()?.segmentDefaults ?? null)
  const maskMaxSidePlaceholder = $derived(
    segmentDefaults === null
      ? '跟随配置'
      : `跟随配置（当前 ${segmentDefaults.maskMaxSide === null ? '原尺寸' : segmentDefaults.maskMaxSide}）`,
  )
  const confThresholdPlaceholder = $derived(
    segmentDefaults === null
      ? '跟随配置'
      : `跟随配置（当前 ${segmentDefaults.confThreshold}）`,
  )

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
    task !== null &&
      !busy &&
      task.status !== 'done' &&
      !precisionInvalid &&
      (hasInstruction || hasBox), // 指令与正框至少一项（纯框模式=指令留空+正框）
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

  /** 命名回退链（placeholder——服务端「把X拆出来」→X 提取；纯框模式=「框选区域」）。 */
  const fallbackName = $derived.by(() => {
    if (task === null) return ''
    const named = task.trialResult?.children[0]?.objectName
    if (named !== undefined && named !== '') return named
    if (!hasInstruction) return '框选区域'
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

        <!-- 指令输入（add-sam-playbook T2：可选——纯框模式留空+画正框） -->
        <div class="mt-3 space-y-1">
          <label class="text-xs font-medium" for="workbench-segment-instruction">抠图指令</label>
          <input
            id="workbench-segment-instruction"
            type="text"
            value={task.instruction}
            disabled={busy}
            oninput={onInstructionInput}
            placeholder="如：把帽子拆出来 / the right wing（留空+画正框=纯框选）"
            class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1.5 text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
            data-testid="workbench-segment-instruction"
          />
          <p class="text-muted-foreground/70 text-[10px]">中文自动英译只在 SAM 请求侧；图层 segmentPrompt 记指令原文；短名词短语最稳（禁数词/否定词）</p>
        </div>

        <!-- 拖画区（add-sam-playbook T2：排除区/正框——目标层区域视图，矩形映射回 imagePx 画布坐标） -->
        <div class="mt-3 space-y-1.5" data-testid="workbench-segment-draw">
          <div class="flex items-center justify-between gap-2">
            <div class="border-input inline-flex overflow-hidden rounded-md border text-[10px]" role="group" aria-label="拖画模式">
              <button
                type="button"
                class={drawMode === 'exclude'
                  ? 'bg-primary text-primary-foreground px-2 py-0.5 font-medium'
                  : 'hover:bg-accent text-muted-foreground px-2 py-0.5'}
                onclick={() => (drawMode = 'exclude')}
                data-testid="workbench-segment-draw-mode-exclude"
              >
                画排除区
              </button>
              <button
                type="button"
                class={drawMode === 'box'
                  ? 'bg-primary text-primary-foreground px-2 py-0.5 font-medium'
                  : 'hover:bg-accent text-muted-foreground px-2 py-0.5'}
                onclick={() => (drawMode = 'box')}
                data-testid="workbench-segment-draw-mode-box"
              >
                画正框
              </button>
            </div>
            <div class="flex items-center gap-1.5">
              {#if task.excludeBox !== null}
                <button
                  type="button"
                  class="text-muted-foreground hover:text-destructive text-[10px] underline-offset-2 hover:underline"
                  onclick={clearExclude}
                  data-testid="workbench-segment-exclude-clear"
                >
                  清除排除区
                </button>
              {/if}
              {#if task.box !== null}
                <button
                  type="button"
                  class="text-muted-foreground hover:text-destructive text-[10px] underline-offset-2 hover:underline"
                  onclick={clearBox}
                  data-testid="workbench-segment-box-clear"
                >
                  清除正框
                </button>
              {/if}
            </div>
          </div>
          <p class="text-muted-foreground/70 text-[10px] leading-snug">
            {drawMode === 'exclude'
              ? '排除区（红色虚线）：框住的区域将从结果掩膜中扣除——掩膜泄漏到无关区域时框住泄漏区重试'
              : '正框（蓝色实线）：指令留空时=纯框选抠图（无指令，不赌语义命中）；有指令时=框内聚焦'}
          </p>
          <div
            bind:this={drawSurfaceEl}
            class="bg-muted/40 relative mx-auto block w-full max-h-56 cursor-crosshair touch-none select-none overflow-hidden rounded border"
            style={`aspect-ratio: ${target.bbox.w} / ${target.bbox.h}`}
            onpointerdown={onDrawPointerDown}
            onpointermove={onDrawPointerMove}
            onpointerup={onDrawPointerUp}
            onpointercancel={() => { drawStart = null; drawCurrent = null }}
            data-testid="workbench-segment-draw-surface"
            role="application"
            aria-label="目标层区域拖画面（画排除区/正框）"
          >
            {#if previewDataUrl !== null && task.trialResult !== null}
              <img
                src={previewDataUrl}
                alt="目标层掩膜叠加预览（可拖画）"
                draggable="false"
                class="pointer-events-none absolute inset-0 h-full w-full"
                style="object-fit: fill"
                data-testid="workbench-segment-trial-preview"
              />
            {:else if cropStyle !== null}
              <div class="pointer-events-none absolute inset-0" style={`background-repeat: no-repeat; background-image: ${cropStyle.backgroundImage}; background-size: ${cropStyle.backgroundSize}; background-position: ${cropStyle.backgroundPosition};`}></div>
            {/if}
            {#if excludeRectPct !== null}
              <div
                class="pointer-events-none absolute border-2 border-dashed border-red-500 bg-red-500/10"
                style={`left: ${excludeRectPct.left}%; top: ${excludeRectPct.top}%; width: ${excludeRectPct.width}%; height: ${excludeRectPct.height}%;`}
                data-testid="workbench-segment-exclude-rect"
                title="排除区（将从掩膜中扣除）"
              ></div>
            {/if}
            {#if boxRectPct !== null}
              <div
                class="pointer-events-none absolute border-2 border-blue-500 bg-blue-500/10"
                style={`left: ${boxRectPct.left}%; top: ${boxRectPct.top}%; width: ${boxRectPct.width}%; height: ${boxRectPct.height}%;`}
                data-testid="workbench-segment-box-rect"
                title="正框（框内聚焦/纯框选）"
              ></div>
            {/if}
            {#if drawingRectPct !== null}
              <div
                class={`pointer-events-none absolute border-2 ${drawMode === 'exclude' ? 'border-dashed border-red-500 bg-red-500/10' : 'border-blue-500 bg-blue-500/10'}`}
                style={`left: ${drawingRectPct.left}%; top: ${drawingRectPct.top}%; width: ${drawingRectPct.width}%; height: ${drawingRectPct.height}%;`}
                data-testid="workbench-segment-drawing-rect"
              ></div>
            {/if}
          </div>
          {#if !hasInstruction && hasBox}
            <p class="text-[10px] leading-relaxed" data-testid="workbench-segment-purebox-note">
              无指令=纯框选抠图（层名缺省「框选区域」——落地前可自定义）
            </p>
          {/if}
          {#if !hasInstruction && !hasBox}
            <p class="text-muted-foreground/70 text-[10px]" data-testid="workbench-segment-empty-note">
              指令与正框至少一项：输入指令，或在上方画正框（纯框选）
            </p>
          {/if}
        </div>

        <!-- 参数区（precision——空=跟随配置（placeholder 展示服务端当前生效值）；独立文本
             草稿，失焦/试跑时校验。走查 2026-10-04：number 输入（整数 px / 0.01 步进）
             +逐字段一句人话说明——maskMaxSide 语义=返回掩膜长边上限（原图始终全分辨率
             送 SAM），非入线降采） -->
        <div class="mt-3 grid grid-cols-2 gap-2">
          <div class="space-y-1">
            <label class="text-muted-foreground text-[10px] font-medium" for="workbench-segment-mask-max-side">
              掩膜长边上限（maskMaxSide）
            </label>
            <input
              id="workbench-segment-mask-max-side"
              type="number"
              inputmode="numeric"
              step="1"
              min="32"
              value={maskMaxSideText}
              disabled={busy}
              oninput={onMaskMaxSideInput}
              onblur={commitPrecisionDrafts}
              placeholder={maskMaxSidePlaceholder}
              title="返回掩膜的最长边像素上限（≥32 整数；越大边缘细节越细，耗时略增；空=跟随配置）"
              class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
              data-testid="workbench-segment-mask-max-side"
            />
            <p class="text-muted-foreground/70 text-[10px] leading-snug" data-testid="workbench-segment-mask-max-side-hint">
              返回掩膜的最长边像素上限。越大边缘细节越细，耗时略增；默认跟随配置。
            </p>
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
              type="number"
              inputmode="decimal"
              step="0.01"
              min="0"
              max="1"
              value={confThresholdText}
              disabled={busy}
              oninput={onConfThresholdInput}
              onblur={commitPrecisionDrafts}
              placeholder={confThresholdPlaceholder}
              title="检出区域的置信度门槛（0~1；越高越严格（不易泄漏），过低易误检；空=跟随配置）"
              class="border-input bg-background focus-visible:ring-ring w-full rounded-md border px-2 py-1 font-mono text-xs outline-none focus-visible:ring-2 disabled:opacity-60"
              data-testid="workbench-segment-conf-threshold"
            />
            <p class="text-muted-foreground/70 text-[10px] leading-snug" data-testid="workbench-segment-conf-threshold-hint">
              0~1，检出区域的置信度门槛。越高越严格（不易泄漏），过低易误检；默认跟随配置。
            </p>
            {#if confThresholdError !== null}
              <p class="text-destructive text-[10px] leading-snug" data-testid="workbench-segment-conf-threshold-error" role="alert">
                {confThresholdError}
              </p>
            {/if}
          </div>
        </div>

        <!-- 实例枚举开关（add-sam-playbook D1：all=同款多实例逐个成层——「六颗星星逐颗成层」） -->
        <div class="mt-3 flex items-center gap-2">
          <input
            id="workbench-segment-instances"
            type="checkbox"
            checked={task.instances === 'all'}
            disabled={busy}
            onchange={onInstancesToggle}
            class="size-3.5 accent-primary"
            data-testid="workbench-segment-instances"
          />
          <label for="workbench-segment-instances" class="text-[11px] font-medium">
            逐实例成层（instances=all）
          </label>
          <span class="text-muted-foreground/70 text-[10px]">同款多实例逐个拆（≤24，超限截断）——计数在掩膜层做，指令里别写数词</span>
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
                重跑试跑（改指令/参数/框选后）
              {:else if !hasInstruction && hasBox}
                <Scissors class="size-3.5" aria-hidden="true" />
                试跑（纯框选抠图，不落树）
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

        <!-- 试跑结果（掩膜叠加图已上移拖画区+警告+回放标记；D1 all=逐实例缩略列表） -->
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
            {#if instanceRows.length > 0}
              <!-- D1 逐实例试跑缩略：序号+名称+掩膜像素数；落地=全量落地（子集勾选挂 follow-up） -->
              <div class="space-y-1" data-testid="workbench-segment-instance-list">
                <p class="text-muted-foreground text-[10px]">
                  逐实例 {instanceRows.length} 个（落地=全部成层）：
                </p>
                <div class="grid grid-cols-3 gap-1.5">
                  {#each instanceRows as row (row.preview.nodeId ?? row.index)}
                    <div class="space-y-0.5 rounded border p-1" data-testid="workbench-segment-instance-item">
                      <img
                        src={`data:${row.preview.mime};base64,${row.preview.dataBase64}`}
                        alt={`实例 ${row.index} ${row.objectName} 掩膜特写`}
                        draggable="false"
                        class="bg-muted/40 block aspect-square w-full rounded object-contain"
                        data-testid="workbench-segment-instance-thumb"
                      />
                      <p class="truncate text-[10px] font-medium" title={row.objectName}>{row.index}. {row.objectName}</p>
                      <p class="text-muted-foreground font-mono text-[9px]">
                        {row.maskPx !== null ? `${row.maskPx.toLocaleString()} px` : '—'}
                      </p>
                    </div>
                  {/each}
                </div>
              </div>
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
                零检出：该指令在目标层内没有可拆出的区域——换更具体的指令、画正框聚焦，或调高精度（掩膜长边上限）后重跑
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
