<!--
Orthogonal intents (max 3):
1. [2026-09-18 R2] 实验室布局：桌面 400px 配置列 + 画廊主区（minmax(0,1fr)，各自独立滚动）；
   移动端单列自然流（配置 → 画廊 → 吸底 CTA）。
2. [2026-09-18 R2 PM-B1] 生成 CTA sticky：桌面钉在配置列底、移动端钉在视口底（底部 Tab 之上）；
   未配置 BYOK 时该按钮变「配置连接」（RunBar 内部实现）。
3. [2026-09-18 Handoff] 送转化：LabView 只负责预览 Dialog 开合与 sendToStudio 调用；
   视图切换由 App 层 handoff $effect 接管，确认反馈由全局 toast 承担（不再留孤儿 notice）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import Dropzone from '../../../components/Lab/Dropzone.svelte'
  import VariantEditor from '../../../components/Lab/VariantEditor.svelte'
  import RunBar from '../../../components/Lab/RunBar.svelte'
  import TaskQueue from '../../../components/Lab/TaskQueue.svelte'
  import PreviewDialog from '../../../components/Lab/PreviewDialog.svelte'
  import { hydrate, sendToStudio } from '$lib/stores/lab.svelte'

  let previewOpen = $state(false)
  let previewTaskId = $state<string | null>(null)

  onMount(() => {
    void hydrate()
  })

  function openPreview(taskId: string): void {
    previewTaskId = taskId
    previewOpen = true
  }

  async function handleSend(taskId: string): Promise<void> {
    const ok = await sendToStudio(taskId)
    if (!ok) return
    previewOpen = false
    // 视图切换：App.svelte 的 handoff $effect；确认反馈：全局 toast「已送入转化工作台」
  }
</script>

<div
  class="flex h-full min-h-0 flex-col overflow-y-auto pb-24 lg:grid lg:grid-cols-[400px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)_auto] lg:overflow-hidden lg:pb-0"
>
  <!-- 配置列（桌面左 400px，独立滚动；移动端自然流） -->
  <div class="flex flex-col gap-4 p-4 pb-3 lg:col-start-1 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto lg:border-r">
    <Dropzone />
    <VariantEditor />
  </div>

  <!-- 画廊主区（桌面右列整高滚动；移动端跟随主滚动） -->
  <div class="p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:min-h-0 lg:overflow-y-auto">
    <TaskQueue onopenpreview={openPreview} onsend={(id) => void handleSend(id)} />
  </div>

  <!-- 吸底生成 CTA：移动端 sticky 视口底；桌面钉在配置列底部 -->
  <div
    class="bg-background/95 sticky bottom-0 z-20 border-t p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur lg:col-start-1 lg:row-start-2"
    data-testid="run-bar-slot"
  >
    <RunBar />
  </div>
</div>

<PreviewDialog bind:open={previewOpen} bind:taskId={previewTaskId} onsend={(id) => void handleSend(id)} />
