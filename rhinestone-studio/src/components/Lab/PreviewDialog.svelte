<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Tabs from '$lib/components/ui/tabs'
  import { Button } from '$lib/components/ui/button'
  import { Slider } from '$lib/components/ui/slider'
  import { getReference, getTask, sendToStudio } from '$lib/stores/lab.svelte'
  import Send from '@lucide/svelte/icons/send'
  import Download from '@lucide/svelte/icons/download'
  import Images from '@lucide/svelte/icons/images'
  import Blend from '@lucide/svelte/icons/blend'

  let {
    open = $bindable(false),
    taskId = $bindable<string | null>(null),
    onsend,
  }: {
    open?: boolean
    taskId?: string | null
    onsend: (taskId: string) => void
  } = $props()

  let opacityValue = $state([1])
  let previewMode = $state<'overlay' | 'side'>('overlay')

  const task = $derived(taskId ? getTask(taskId) : undefined)
  const reference = $derived(getReference())
  const opacity = $derived(opacityValue[0] ?? 1)

  // 打开时重置；无参考图（如刷新后恢复的会话）自动切到并排模式。
  $effect(() => {
    if (open) {
      opacityValue = [1]
      previewMode = reference ? 'overlay' : 'side'
    }
  })

  const checkerboard =
    'background-image: repeating-conic-gradient(var(--color-muted) 0% 25%, transparent 0% 50%); background-size: 16px 16px;'
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-4xl">
    <Dialog.Header>
      <Dialog.Title class="text-sm">
        {#if task}
          {task.variantName} · 候选 {task.candidateIndex + 1}
          {#if task.durationMs !== undefined}
            <span class="text-muted-foreground font-normal">（{(task.durationMs / 1000).toFixed(1)}s）</span>
          {/if}
        {/if}
      </Dialog.Title>
      <Dialog.Description>叠加模式拖动透明度滑杆实时混合，用于判断风格化偏差；并排模式直接对比。</Dialog.Description>
    </Dialog.Header>

    {#if task}
      <div class="grid gap-3">
        <Tabs.Root bind:value={previewMode} >
          <Tabs.List class="w-full">
            <Tabs.Trigger value="overlay" class="flex-1 gap-1.5" disabled={!reference}>
              <Blend class="size-3.5" />
              叠加{reference ? '' : '（无参考图）'}
            </Tabs.Trigger>
            <Tabs.Trigger value="side" class="flex-1 gap-1.5">
              <Images class="size-3.5" />
              并排
            </Tabs.Trigger>
          </Tabs.List>
          <Tabs.Content value="overlay" class="mt-3">
            {#if reference && task.imageUrl}
              <div class="grid gap-3">
                <div class="relative mx-auto aspect-square w-full max-w-2xl overflow-hidden rounded-lg border" style={checkerboard}>
                  <img
                    src={reference.previewUrl}
                    alt="参考原图"
                    class="absolute inset-0 size-full object-contain"
                    draggable="false"
                  />
                  <img
                    src={task.imageUrl}
                    alt="生成候选"
                    class="absolute inset-0 size-full object-contain transition-opacity"
                    style="opacity: {opacity}"
                    draggable="false"
                  />
                </div>
                <label class="mx-auto flex w-full max-w-2xl items-center gap-3 text-xs">
                  <span class="text-muted-foreground w-20 shrink-0">候选不透明度</span>
                  <Slider type="multiple" bind:value={opacityValue} min={0} max={1} step={0.01} class="flex-1" />
                  <span class="text-muted-foreground w-10 shrink-0 text-right">{Math.round(opacity * 100)}%</span>
                </label>
              </div>
            {/if}
          </Tabs.Content>
          <Tabs.Content value="side" class="mt-3">
            <div class="grid gap-3 sm:grid-cols-2">
              <figure class="grid gap-1">
                {#if reference}
                  <div class="relative aspect-square overflow-hidden rounded-lg border" style={checkerboard}>
                    <img src={reference.previewUrl} alt="参考原图" class="absolute inset-0 size-full object-contain" draggable="false" />
                  </div>
                  <figcaption class="text-muted-foreground text-center text-xs">参考原图</figcaption>
                {:else}
                  <div class="text-muted-foreground flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs">
                    本会话未上传参考原图
                  </div>
                {/if}
              </figure>
              <figure class="grid gap-1">
                {#if task.imageUrl}
                  <div class="relative aspect-square overflow-hidden rounded-lg border" style={checkerboard}>
                    <img src={task.imageUrl} alt="生成候选" class="absolute inset-0 size-full object-contain" draggable="false" />
                  </div>
                  <figcaption class="text-muted-foreground text-center text-xs">生成候选</figcaption>
                {:else}
                  <div class="text-muted-foreground flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs">
                    该任务无图片（{task.status}）
                  </div>
                {/if}
              </figure>
            </div>
          </Tabs.Content>
        </Tabs.Root>
      </div>

      <Dialog.Footer class="sm:justify-start">
        {#if task.status === 'success' && task.imageUrl}
          <Button size="sm" onclick={() => onsend(task.id)}>
            <Send />
            送转化
          </Button>
          <a
            class="border-input bg-background hover:bg-muted hover:text-foreground inline-flex h-8 items-center gap-1.5 rounded-[min(var(--radius-md),10px)] border px-2.5 text-sm font-medium shadow-xs transition-colors"
            href={task.imageUrl}
            download={`${task.variantName}-候选${task.candidateIndex + 1}.png`}
          >
            <Download class="size-4" />
            下载
          </a>
        {/if}
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
