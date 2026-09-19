<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { applyTaskParams, cancelTask, copyTaskPrompt, retryTask, type LabTask } from '$lib/stores/lab.svelte'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy'
  import Eye from '@lucide/svelte/icons/eye'
  import Send from '@lucide/svelte/icons/send'
  import Download from '@lucide/svelte/icons/download'
  import Ban from '@lucide/svelte/icons/ban'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import PackageOpen from '@lucide/svelte/icons/package-open'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import ZoomIn from '@lucide/svelte/icons/zoom-in'

  let {
    task,
    onopenpreview,
    onsend,
  }: {
    task: LabTask
    onopenpreview: (taskId: string) => void
    onsend: (taskId: string) => void
  } = $props()

  const statusLabel: Record<LabTask['status'], string> = {
    pending: '排队中',
    running: '生成中',
    success: '完成',
    error: '失败',
    cancelled: '已取消',
  }

  const statusBadgeVariant: Record<LabTask['status'], 'default' | 'secondary' | 'destructive' | 'outline'> = {
    pending: 'outline',
    running: 'default',
    success: 'secondary',
    error: 'destructive',
    cancelled: 'outline',
  }

  const fileName = $derived(`${task.variantName}-候选${task.candidateIndex + 1}.png`)

  function effectRefKindLabel(ref: NonNullable<LabTask['effectRef']>): string {
    if (ref.kind === 'preset') return '案例·内置'
    return '案例·合成图'
  }
</script>

<div class="border-input bg-card grid gap-2 rounded-xl border p-2.5">
  <div class="relative">
    <button
      type="button"
      class="bg-muted/40 ring-ring/40 hover:ring-primary/40 block aspect-square w-full overflow-hidden rounded-md ring-1 transition-shadow"
      title={task.imageUrl ? '点击放大预览' : statusLabel[task.status]}
      onclick={() => task.imageUrl && onopenpreview(task.id)}
      disabled={!task.imageUrl}
    >
      {#if task.imageUrl}
        <img src={task.imageUrl} alt={`${task.variantName} 候选 ${task.candidateIndex + 1}`} class="size-full object-contain" draggable="false" />
      {:else if task.status === 'running'}
        <span class="text-muted-foreground flex size-full flex-col items-center justify-center gap-2 text-xs">
          <LoaderCircle class="size-6 animate-spin" />
          生成中…
        </span>
      {:else if task.status === 'pending'}
        <span class="text-muted-foreground flex size-full items-center justify-center gap-1.5 text-xs">
          <LoaderCircle class="size-4 opacity-50" />
          排队中
        </span>
      {:else if task.status === 'error'}
        <span class="text-destructive flex size-full flex-col items-center justify-center gap-1 text-xs">
          <CircleAlert class="size-6" />
          生成失败
        </span>
      {:else}
        <span class="text-muted-foreground flex size-full flex-col items-center justify-center gap-1 text-xs">
          {#if task.imageMissing}
            <PackageOpen class="size-6" />
            图片缓存已失效
          {:else}
            <Ban class="size-6" />
            {statusLabel[task.status]}
          {/if}
        </span>
      {/if}
    </button>
    <span class="text-foreground absolute top-1.5 left-1.5 rounded bg-black/55 px-1.5 py-0.5 font-mono text-[10px] tabular-nums backdrop-blur-sm">
      候选 {task.candidateIndex + 1}
    </span>
    {#if task.imageUrl}
      <Button
        variant="secondary"
        size="icon-xs"
        class="absolute top-1.5 right-1.5 size-6 rounded-full shadow-sm"
        title="放大预览"
        onclick={() => onopenpreview(task.id)}
      >
        <ZoomIn />
      </Button>
    {/if}
  </div>

  <div class="flex min-h-6 items-center gap-1.5">
    <Badge variant={statusBadgeVariant[task.status]}>{statusLabel[task.status]}</Badge>
    <!-- 批次分组后组内混合变体：卡片保留模板名标签，归属信息不丢 -->
    <span class="text-muted-foreground min-w-0 truncate text-[11px]" title={task.variantName}>{task.variantName}</span>
    {#if task.durationMs !== undefined}
      <span class="text-muted-foreground font-mono text-[11px] tabular-nums">{(task.durationMs / 1000).toFixed(1)}s</span>
    {/if}
    <span class="text-muted-foreground ml-auto flex items-center gap-1 font-mono text-[10px]">
      {#if task.effectRef}
        <Badge variant="outline" class="text-[10px]" title="该任务发起时携带了案例参照图（原图+效果图合成的一张参照图）">
          {effectRefKindLabel(task.effectRef)}
        </Badge>
      {/if}
      {task.mode === 'edit' ? 'edits' : 'gen'} · n:1
    </span>
  </div>

  {#if task.error}
    <p class="text-destructive line-clamp-3 text-[11px] leading-snug break-all" title={task.error}>{task.error}</p>
  {/if}

  {#if task.debug}
    <details class="group">
      <summary class="text-muted-foreground cursor-pointer text-[11px] select-none">debug（截断脱敏）</summary>
      <pre class="bg-muted/60 mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap break-all">{JSON.stringify(task.debug, null, 2)}</pre>
    </details>
  {/if}

  <div class="flex flex-wrap items-center gap-1">
    {#if task.status === 'running' || task.status === 'pending'}
      <Button variant="ghost" size="xs" class="text-muted-foreground hover:text-destructive" onclick={() => cancelTask(task.id)}>
        <Ban />
        取消
      </Button>
    {/if}
    {#if task.status === 'error' || task.status === 'cancelled'}
      <Button variant="outline" size="xs" onclick={() => retryTask(task.id)}>
        <RefreshCw />
        重试
      </Button>
      {#if task.status === 'error'}
        <!-- 失败归因直达：401/CORS 等连接类问题的解释性文案在设置里 -->
        <Button variant="ghost" size="xs" onclick={openSettings} title="连接/鉴权类失败请到设置中检查">
          <Settings2 />
          去设置
        </Button>
      {/if}
    {/if}
    {#if task.status === 'success'}
      {#if task.imageUrl}
        <Button variant="outline" size="xs" onclick={() => onopenpreview(task.id)}>
          <Eye />
          预览
        </Button>
        <Button size="xs" onclick={() => onsend(task.id)}>
          <Send />
          送转化
        </Button>
        <a
          class="border-input bg-background hover:bg-muted hover:text-foreground inline-flex h-6 items-center gap-1 rounded-[min(var(--radius-md),8px)] border px-2 text-xs font-medium shadow-xs transition-colors"
          href={task.imageUrl}
          download={fileName}
          title="下载 PNG"
        >
          <Download class="size-3" />
          下载
        </a>
      {:else}
        <span class="text-muted-foreground text-[11px]">图片缓存已失效（可重试恢复）</span>
      {/if}
    {/if}
    <Button
      variant="outline"
      size="xs"
      class="ml-auto"
      title="把该任务的模型/尺寸/Advanced JSON 写回表单（提示词体不再写回模板）"
      onclick={() => applyTaskParams(task.id)}
    >
      <RotateCcw />
      复用参数
    </Button>
    <Button
      variant="outline"
      size="xs"
      title="复制该任务的提示词体快照到剪贴板（可粘贴进任意模板）"
      onclick={() => void copyTaskPrompt(task.id)}
      data-testid="task-copy-prompt"
    >
      <ClipboardCopy />
      复制提示词
    </Button>
  </div>
</div>
