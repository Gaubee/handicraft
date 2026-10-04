<!--
WorkbenchReferenceLayer.svelte — 图层面板顶部「参考图层」条目（add-flat-aux-segmentation
T6 / design D6，2026-10-04）。三态呈现（task.detail referenceImage 投影）：
  - 未生成（generated=false/absent）：占位缩略+「分件用原图」——唯一操作=重新生成；
  - 在场（generated=true 生效中）：真实缩略（referenceBlobRef 附件通道）+一致性数字
    （IoU/模型/时刻——report 工件投影）+操作 查看大图/重新生成（approved-mutation
    授权流+loading）/禁用（确认面→重跑分件提示）；
  - 禁用（disabled=true）：工件在档只是不用（缩略仍在）+操作 查看大图/重新生成/启用。
结构保护（非可排钻层——同画布根）：不进树序/不可选中/不可拖拽/不可删——仅呈现+操作。
版本史/活动时间线留痕消费既有帧（生成/一致性门/禁用/启用帧流在案）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import {
    cancelDisableReferenceLayer,
    confirmDisableReferenceLayer,
    enableReferenceLayer,
    ensureReferenceThumb,
    getPendingReferenceDisable,
    getReferenceLayerAction,
    getReferenceThumbUrl,
    getWorkbenchReferenceLayer,
    regenerateReferenceLayer,
    requestDisableReferenceLayer,
  } from './store.svelte'
  import ImageUp from '@lucide/svelte/icons/image-up'
  import Layers from '@lucide/svelte/icons/layers'
  import Lock from '@lucide/svelte/icons/lock'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'

  const reference = $derived(getWorkbenchReferenceLayer())
  const action = $derived(getReferenceLayerAction())
  const pendingDisable = $derived(getPendingReferenceDisable())
  const thumbUrl = $derived(getReferenceThumbUrl())

  /** 生成工件在场（active/disabled 两态共用——缩略/大图锚）。 */
  const generatedRef = $derived(reference?.generated === true ? reference.referenceBlobRef ?? null : null)

  // 缩略拉取（ref 变化重拉——内容寻址缓存单源）
  $effect(() => {
    void ensureReferenceThumb(generatedRef)
  })

  // 查看大图（内联展开——data URL 顶层导航被浏览器拦，条目下方直接展开更近）
  let expanded = $state(false)
  $effect(() => {
    // 换态/换工件收起大图（避免展示旧层）
    if (generatedRef === null) expanded = false
  })

  const busy = $derived(action.phase === 'proposing' || action.phase === 'executing')

  /** 一致性数字行（title 悬浮全量——行内只放关键数字）。 */
  const consistencyLine = $derived.by(() => {
    const c = reference?.consistency
    if (c === undefined || c === null) return null
    const time = c.generatedAt.slice(5, 16).replace('T', ' ')
    return `IoU ${c.iou.toFixed(3)} · ${c.model} · ${time}`
  })
</script>

<div
  class="border-b px-2.5 py-2"
  data-testid="workbench-reference-layer"
  data-state={reference === null || reference.generated === false ? 'absent' : reference.disabled === true ? 'disabled' : 'active'}
  aria-label="参考图层（分件真源——非可排钻层）"
>
  <div class="flex items-center gap-2">
    <!-- 缩略（未生成=虚线占位；生成=真实工件缩略） -->
    {#if generatedRef !== null && thumbUrl !== null}
      <img
        src={thumbUrl}
        alt="参考图层缩略"
        class="border-border/60 size-8 shrink-0 rounded-sm border object-cover"
        data-testid="workbench-reference-thumb"
      />
    {:else}
      <span
        class="border-border/60 text-muted-foreground/60 flex size-8 shrink-0 items-center justify-center rounded-sm border border-dashed"
        data-testid="workbench-reference-thumb-placeholder"
        title={generatedRef !== null ? '缩略加载中…' : '未生成——分件用原图'}
      >
        <Layers class="size-3.5" aria-hidden="true" />
      </span>
    {/if}
    <!-- 名称+状态徽标 -->
    <div class="min-w-0 flex-1" title="参考图层（photographic 图经 image-edit 扁平化的分件真源）——非可排钻层，不参与图层排序/选择">
      <div class="flex items-center gap-1.5">
        <span class="truncate text-xs font-medium">参考图层</span>
        {#if reference === null || reference.generated === false}
          <span class="text-muted-foreground/80 rounded border border-dashed px-1 py-px text-[9px] leading-none" data-testid="workbench-reference-badge">未生成 · 分件用原图</span>
        {:else if reference.disabled === true}
          <span class="text-amber-700 dark:text-amber-400 rounded border border-amber-500/40 px-1 py-px text-[9px] leading-none" data-testid="workbench-reference-badge">已禁用 · 分件用原图</span>
        {:else}
          <span class="text-primary rounded border border-primary/30 bg-primary/5 px-1 py-px text-[9px] leading-none" data-testid="workbench-reference-badge">生效中 · 分件真源</span>
        {/if}
        <!-- 结构保护（同画布根——不可排钻不可删） -->
        <span class="text-muted-foreground/60 shrink-0" title="非可排钻层（结构保护——不参与排序/选中/删除）" aria-label="非可排钻层（结构保护）">
          <Lock class="size-3" aria-hidden="true" />
        </span>
      </div>
      {#if consistencyLine !== null}
        <p
          class="text-muted-foreground/80 mt-0.5 truncate font-mono text-[9px] leading-tight"
          title={`几何一致性门：IoU ${reference!.consistency!.iou.toFixed(3)}（阈值 ${reference!.consistency!.threshold}，${reference!.consistency!.pass ? '通过' : '未过'}）· 前景覆盖 ${(reference!.consistency!.sourceCoverage * 100).toFixed(0)}%/${(reference!.consistency!.referenceCoverage * 100).toFixed(0)}% · ${reference!.consistency!.model} · ${reference!.consistency!.generatedAt}`}
          data-testid="workbench-reference-consistency"
        >
          {consistencyLine}
        </p>
      {/if}
    </div>
    <!-- 操作簇 -->
    <div class="flex shrink-0 items-center gap-0.5">
      {#if generatedRef !== null}
        <button
          type="button"
          class="text-muted-foreground hover:text-foreground rounded p-1"
          onclick={() => (expanded = !expanded)}
          aria-pressed={expanded}
          aria-label={expanded ? '收起参考图层大图' : '查看参考图层大图'}
          title={expanded ? '收起大图' : '查看大图'}
          data-testid="workbench-reference-view"
        >
          {#if expanded}
            <EyeOff class="size-3.5" aria-hidden="true" />
          {:else}
            <Eye class="size-3.5" aria-hidden="true" />
          {/if}
        </button>
      {/if}
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded p-1 disabled:opacity-50"
        onclick={() => void regenerateReferenceLayer()}
        disabled={busy || action.phase === 'pending'}
        title="重新生成（外部计费调用——审批流：自动批准会话立即执行，否则在会话审批卡批准）"
        aria-label="重新生成参考图层"
        data-testid="workbench-reference-regenerate"
      >
        {#if busy}
          <RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />
        {:else}
          <ImageUp class="size-3.5" aria-hidden="true" />
        {/if}
        <span class="text-[10px]">{busy ? '生成中…' : '重新生成'}</span>
      </button>
      {#if reference !== null && reference.generated === true}
        {#if reference.disabled === true}
          <button
            type="button"
            class="text-muted-foreground hover:text-foreground rounded p-1"
            onclick={() => void enableReferenceLayer()}
            title="启用（重申既有工件——后续分件恢复用参考图层）"
            aria-label="启用参考图层"
            data-testid="workbench-reference-enable"
          >
            <Layers class="size-3.5" aria-hidden="true" />
          </button>
        {:else}
          <button
            type="button"
            class="text-muted-foreground hover:text-destructive rounded p-1"
            onclick={() => requestDisableReferenceLayer()}
            title="禁用（分件输入回退原图——对既有图层重跑抠图后生效）"
            aria-label="禁用参考图层"
            data-testid="workbench-reference-disable"
          >
            <EyeOff class="size-3.5" aria-hidden="true" />
          </button>
        {/if}
      {/if}
    </div>
  </div>

  <!-- 动作态行（pending 指引/错误/完成消息——error 红显） -->
  {#if action.message !== null}
    <p
      class="{action.error ? 'text-destructive' : 'text-muted-foreground'} mt-1.5 text-[10px] leading-relaxed"
      role={action.error ? 'alert' : undefined}
      data-testid="workbench-reference-action-message"
    >
      {action.message}
    </p>
  {/if}

  <!-- 禁用确认面（破坏性=确认——重跑分件提示就近呈现） -->
  {#if pendingDisable}
    <div class="bg-background mt-1.5 rounded-md border p-2" data-testid="workbench-reference-disable-confirm" role="alertdialog" aria-label="确认禁用参考图层">
      <p class="text-xs leading-relaxed">
        禁用参考图层？
        <span class="text-muted-foreground block text-[10px]">后续抠图（分件）输入回退原图；已拆图层的掩膜不变——需要更准的重跑请对目标层重新抠图。</span>
      </p>
      <div class="mt-1.5 flex gap-1.5">
        <Button size="sm" variant="destructive" class="h-6 px-2 text-[11px]" onclick={() => void confirmDisableReferenceLayer()} data-testid="workbench-reference-disable-confirm-ok">
          确认禁用
        </Button>
        <Button size="sm" variant="outline" class="h-6 px-2 text-[11px]" onclick={() => cancelDisableReferenceLayer()} data-testid="workbench-reference-disable-confirm-cancel">
          取消
        </Button>
      </div>
    </div>
  {/if}

  <!-- 大图（内联展开——真实尺寸受面板宽度约束） -->
  {#if expanded && generatedRef !== null && thumbUrl !== null}
    <div class="bg-background/60 mt-1.5 rounded-md border p-1.5" data-testid="workbench-reference-large">
      <img src={thumbUrl} alt="参考图层大图" class="max-h-72 w-full rounded object-contain" />
    </div>
  {/if}
</div>
