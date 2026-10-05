<!--
WorkbenchReferenceLayer.svelte — 图层面板顶部「参考图层」条目（add-flat-aux-segmentation
T6 / design D6，2026-10-04；T6.3 导入面 2026-10-05）。三态呈现（task.detail referenceImage 投影）：
  - 未生成（generated=false/absent）：占位缩略+「分件用原图」——操作=导入（BYOK 主入口）
    /重新生成；
  - 在场（generated=true 生效中）：真实缩略（referenceBlobRef 附件通道）+一致性数字
    （IoU/模型/时刻——report 工件投影）+操作 查看大图/导入（替换）/重新生成
    （approved-mutation 授权流+loading）/禁用（确认面→重跑分件提示）；
  - 禁用（disabled=true）：工件在档只是不用（缩略仍在）+操作 查看大图/导入（再激活）
    /重新生成/启用。
导入（T6.3 BYOK 路线）：hidden file input → uploadAssetImage（rpc 附件面——非 PNG 自动
转 PNG）→ task.reference.import（过与生成同一道几何一致性门；typed 拒就地呈现）。
结构保护（非可排钻层——同画布根）：不进树序/不可选中/不可拖拽/不可删——仅呈现+操作。
版本史/活动时间线留痕消费既有帧（生成/一致性门/禁用/启用/导入帧流在案）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { getBoundAgentApi } from '$lib/agentApi/store.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import {
    cancelDisableReferenceLayer,
    confirmDisableReferenceLayer,
    enableReferenceLayer,
    ensureReferenceThumb,
    getPendingReferenceDisable,
    getReferenceLayerAction,
    getReferenceThumbUrl,
    getWorkbenchReferenceLayer,
    getWorkbenchTaskId,
    loadWorkbench,
    regenerateReferenceLayer,
    requestDisableReferenceLayer,
  } from './store.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import FileUp from '@lucide/svelte/icons/file-up'
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

  // ---------------------------------------------------------------- 手动导入（T6.3 BYOK）

  let importFileInput = $state<HTMLInputElement | null>(null)
  let importing = $state(false)
  /** 导入流就地状态（typed 拒错误文案——与 regenerate 动作态行同形态）。 */
  let importMessage = $state<{ text: string; error: boolean } | null>(null)

  /** 导入口在场=api 面在否决定（taskReferenceImport 可选——旧 daemon 缺路由即收起，
   * attachable 同款语义；mock/rpc 真身均有）。 */
  const importSupported = $derived.by(() => {
    const api = getBoundAgentApi()
    return api !== null && api.taskReferenceImport !== undefined
  })

  const busy = $derived(action.phase === 'proposing' || action.phase === 'executing' || importing)

  /**
   * 文件选中 → 上传 → 导入：rpc 走 uploadAssetImage（附件面归一——非 PNG 自动转
   * PNG，4MiB/4096px 前置门+中文错误）；mock 演示模式无上传面=演示元数据
   * （NewTaskComposer 同款——blobRef demo- 前缀，mock import 不消费字节）。
   * 成功=定向刷新 task detail（regenerate 成功同一路径）+toast 携 IoU；
   * 失败=typed 错误就地呈现（code 在 message——reference-import-* 前缀可判别，
   * 门不过时携带 IoU 数字）。
   */
  async function onImportFilePicked(event: Event): Promise<void> {
    const input = event.currentTarget instanceof HTMLInputElement ? event.currentTarget : null
    const file = input?.files?.[0] ?? null
    if (input !== null) input.value = '' // 重置——同名文件可重复选择重试
    if (file === null) return
    const requestTaskId = getWorkbenchTaskId()
    if (requestTaskId === null) return
    const api = getBoundAgentApi()
    if (api === null || api.taskReferenceImport === undefined) {
      importMessage = { text: '导入失败：当前模式不支持导入（旧 daemon 无 task.reference.import 路由）', error: true }
      return
    }
    importing = true
    importMessage = null
    try {
      const blobRef =
        api.uploadAssetImage !== undefined
          ? (await api.uploadAssetImage(file)).blobRef
          : `demo-${file.name}`
      const output = await api.taskReferenceImport({ taskId: requestTaskId, imageBlobRef: blobRef })
      if (requestTaskId !== getWorkbenchTaskId()) return
      await loadWorkbench(requestTaskId, { refresh: true })
      showToast(`参考图层已导入（IoU ${output.consistency.iou.toFixed(3)}）`)
    } catch (error) {
      if (requestTaskId !== getWorkbenchTaskId()) return
      importMessage = { text: `导入失败：${error instanceof Error ? error.message : String(error)}`, error: true }
    } finally {
      importing = false
    }
  }

  /** 一致性数字行（title 悬浮全量——行内只放关键数字）。 */
  const consistencyLine = $derived.by(() => {
    const c = reference?.consistency
    if (c === undefined || c === null) return null
    const time = c.generatedAt.slice(5, 16).replace('T', ' ')
    return `IoU ${c.iou.toFixed(3)} · ${c.model} · ${time}`
  })

  /** 元数据展开（2026-10-05 Owner 需求：提示词/模型/生成参数入图层元数据）。 */
  let metadataOpen = $state(false)
  const metadata = $derived.by(() => reference?.consistency ?? null)
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
      {#if metadata !== null && consistencyLine !== null}
        <button
          type="button"
          class="text-muted-foreground/70 hover:text-foreground mt-0.5 inline-flex items-center gap-0.5 text-[9px] leading-tight"
          onclick={() => (metadataOpen = !metadataOpen)}
          aria-expanded={metadataOpen}
          data-testid="workbench-reference-metadata-toggle"
        >
          <ChevronDown class="size-2.5 transition-transform {metadataOpen ? 'rotate-180' : ''}" aria-hidden="true" />
          生成元数据（提示词/模型/参数）
        </button>
        {#if metadataOpen}
          <dl
            class="border-border/60 text-muted-foreground mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 rounded border border-dashed px-1.5 py-1 font-mono text-[9px] leading-tight"
            data-testid="workbench-reference-metadata"
          >
            <dt>模型</dt><dd class="truncate">{metadata.model}</dd>
            {#if metadata.provider !== undefined}<dt>提供商</dt><dd class="truncate">{metadata.provider}</dd>{/if}
            {#if metadata.size !== undefined}<dt>size</dt><dd>{metadata.size}</dd>{/if}
            {#if metadata.durationMs !== undefined}<dt>耗时</dt><dd>{(metadata.durationMs / 1000).toFixed(1)}s</dd>{/if}
            {#if metadata.promptSha256 !== undefined}
              <dt>提示词</dt>
              <dd class="truncate" title={`sha256=${metadata.promptSha256}${metadata.promptChars !== undefined ? `（${metadata.promptChars} 字符，冻结版——全文与逐轮报告见 reference-image-report.json 工件）` : ''}`}>
                sha256 {metadata.promptSha256.slice(0, 16)}…{metadata.promptChars !== undefined ? `（${metadata.promptChars} 字符·冻结版）` : ''}
              </dd>
            {/if}
          </dl>
        {/if}
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
      {#if importSupported}
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground flex items-center gap-1 rounded p-1 disabled:opacity-50"
        onclick={() => importFileInput?.click()}
        disabled={busy || action.phase === 'pending'}
        title="导入参考图层（自备扁平图——上传后过与生成同一道几何一致性门 IoU≥0.85；无 image-edit 路由时的 BYOK 路线。在场=替换当前层；禁用=再激活）"
        aria-label="导入参考图层"
        data-testid="workbench-reference-import"
      >
        {#if importing}
          <RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />
        {:else}
          <FileUp class="size-3.5" aria-hidden="true" />
        {/if}
        <span class="text-[10px]">{importing ? '导入中…' : '导入'}</span>
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
        {#if action.phase === 'proposing' || action.phase === 'executing'}
          <RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />
        {:else}
          <ImageUp class="size-3.5" aria-hidden="true" />
        {/if}
        <span class="text-[10px]">{action.phase === 'proposing' || action.phase === 'executing' ? '生成中…' : '重新生成'}</span>
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

  <!-- 导入态行（T6.3 BYOK——typed 拒就地呈现，error 红显同动作态形态） -->
  {#if importMessage !== null}
    <p
      class="{importMessage.error ? 'text-destructive' : 'text-muted-foreground'} mt-1.5 text-[10px] leading-relaxed"
      role={importMessage.error ? 'alert' : undefined}
      data-testid="workbench-reference-import-message"
    >
      {importMessage.text}
    </p>
  {/if}

  <!-- 导入文件入口（隐藏——按钮 click 触发；accept 收图片，非 PNG 由附件面归一转 PNG） -->
  <input
    type="file"
    accept="image/*"
    hidden
    bind:this={importFileInput}
    onchange={onImportFilePicked}
    data-testid="workbench-reference-import-file"
    aria-hidden="true"
    tabindex={-1}
  />

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
