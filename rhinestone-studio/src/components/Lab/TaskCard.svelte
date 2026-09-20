<!--
Orthogonal intents (max 3):
1. [2026-09-19 4.5 两态] 卡片收起（默认）/展开：收起 = 单行（缩略方图 + 模板名 + 候选号 +
     状态/耗时 + 角标 + chevron），点击行任意处 toggle；展开 = 大图横幅 + 动作行 + error/debug 折叠。
     [2026-09-20 C3.3] 展开位扩蓝图最小子态（design §5.3——非画廊重构，收起卡零改动）：
     蓝图缩略位 + 「人审参照 · 非 BOM 数据源」角标 + 失败/重试中/中断徽标 + 单独重试/取消动作行；
     数据源 = task.stages 经 deriveBlueprintBadge 派生（生产归 4.3/4.4，C 轨承展示骨架 +
     动作回调缝 onBlueprintAction）。
2. [2026-09-19 4.5 并集] GalleryEntry 双源：活卡（会话任务：取消/重试/复用参数）与只读卡
     （库来源：角标「库」，无重试/取消/复用参数；imageUrl 经 gallery store 异步解析缓存）。
3. [2026-09-19 4.5 角标] 状态角标：案例绑定 / 库来源 / 档案缺失（活任务指向缺失节点）/
     模板已删除（展开态，templateAssetId 不在模板列表的孤儿）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { applyTaskParams, cancelTask, copyTaskPrompt, retryTask, type TaskStatus, type VariantEffectRef } from '$lib/stores/lab.svelte'
  import {
    downloadGalleryEntry,
    ensureEntryImageUrl,
    getReadonlyImageUrl,
    isEntryExpanded,
    sendGalleryEntry,
    toggleEntryExpanded,
    type GalleryEntry,
  } from '$lib/stores/gallery.svelte'
  import { deriveBlueprintBadge, type BlueprintTaskBadge } from '$lib/lab/stages'
  import { getTemplateAssetIds, isTemplatesReady } from '$lib/stores/templates.svelte'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import ClipboardCopy from '@lucide/svelte/icons/clipboard-copy'
  import Send from '@lucide/svelte/icons/send'
  import Download from '@lucide/svelte/icons/download'
  import Ban from '@lucide/svelte/icons/ban'
  import CircleAlert from '@lucide/svelte/icons/circle-alert'
  import PackageOpen from '@lucide/svelte/icons/package-open'
  import Settings2 from '@lucide/svelte/icons/settings-2'
  import ZoomIn from '@lucide/svelte/icons/zoom-in'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import DraftingCompass from '@lucide/svelte/icons/drafting-compass'

  let {
    entry,
    onopenpreview,
    onBlueprintAction,
  }: {
    entry: GalleryEntry
    onopenpreview: (entryKey: string) => void
    /** [C3.3] 蓝图 stage 单独动作缝（retry/cancel——成品图不动）；4.4 接线 lab store 级联 API。 */
    onBlueprintAction?: (kind: 'retry' | 'cancel', taskId: string) => void
  } = $props()

  const statusLabel: Record<TaskStatus, string> = {
    pending: '排队中',
    running: '生成中',
    success: '完成',
    error: '失败',
    cancelled: '已取消',
  }

  const statusBadgeVariant: Record<TaskStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    pending: 'outline',
    running: 'default',
    success: 'secondary',
    error: 'destructive',
    cancelled: 'outline',
  }

  const expanded = $derived(isEntryExpanded(entry.key))
  const task = $derived(entry.live ? entry.task : undefined)

  // 只读卡 imageUrl：挂载即解析（收起缩略与展开横幅共用；会话缓存 + 序号守卫在 store）
  $effect(() => {
    if (!entry.live) ensureEntryImageUrl(entry)
  })
  const readonlyUrl = $derived(
    !entry.live && entry.assetId !== undefined ? getReadonlyImageUrl(entry.assetId) : undefined,
  )
  const imageUrl = $derived(entry.live ? task?.imageUrl : (readonlyUrl ?? undefined))
  const hasImage = $derived(imageUrl !== undefined && imageUrl !== null)

  /** 展开态孤儿角标：templateAssetId 已不在模板列表（模板已删/移出，B.3）。模板 store 未就绪不判（启动期空列表 ≠ 全删）。 */
  const templateDeleted = $derived(
    isTemplatesReady() &&
    entry.templateAssetId !== undefined &&
    !getTemplateAssetIds().includes(entry.templateAssetId),
  )

  const durationMs = $derived(task?.durationMs)
  const durationText = $derived(durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : '')

  // [C3.3] 蓝图子态派生（design §5.3/§3.3 徽标列）：badge 只依赖 blueprint stage 自身状态
  // ——无 blueprint stage（未启用/旧档）不渲染蓝图区（收起卡与画廊机制零改动）
  const blueprintStage = $derived(task?.stages?.find((s) => s.kind === 'blueprint'))
  const blueprintBadge = $derived(blueprintStage !== undefined ? deriveBlueprintBadge(task?.stages ?? []) : null)
  /** 静态徽标文案（in-progress 的「重试中」细分在模板按 retryCount 三元覆盖）。 */
  const blueprintBadgeLabel: Record<BlueprintTaskBadge, string> = {
    'in-progress': '蓝图进行中',
    success: '蓝图完成',
    failed: '蓝图失败',
    cancelled: '蓝图已取消',
    skipped: '蓝图未随行',
    interrupted: '蓝图已中断，可重试',
  }
  const blueprintBadgeVariant: Record<BlueprintTaskBadge, 'default' | 'secondary' | 'destructive' | 'outline'> = {
    'in-progress': 'default',
    success: 'secondary',
    failed: 'destructive',
    cancelled: 'outline',
    skipped: 'outline',
    interrupted: 'destructive',
  }
  const blueprintRetryable = $derived(
    blueprintBadge === 'failed' || blueprintBadge === 'cancelled' || blueprintBadge === 'interrupted',
  )
  const blueprintCancelable = $derived(blueprintBadge === 'in-progress')

  function effectRefKindLabel(ref: VariantEffectRef | null | undefined): string {
    if (ref === null || ref === undefined) return ''
    return ref.kind === 'preset' ? '案例·内置' : '案例·合成图'
  }
</script>

<div
  class="border-input bg-card overflow-hidden rounded-xl border"
  data-testid="gallery-entry"
  data-entry-key={entry.key}
  data-live={entry.live}
>
  <!-- 收起行（默认态）：单行横排，点击任意处 toggle（移动端全宽单列同构） -->
  <button
    type="button"
    class="hover:bg-muted/40 flex w-full min-w-0 cursor-pointer items-center gap-2.5 p-2 text-left transition-colors"
    data-testid="entry-toggle"
    aria-expanded={expanded}
    title={expanded ? '收起' : '展开'}
    onclick={() => toggleEntryExpanded(entry.key)}
  >
    <!-- [UX-A] 缩略位状态图标（loading/警告/档案缺失）居中：容器 flex 全心居中，
         禁 m-auto（inline SVG 的 auto 边距计算为 0，图标会钉在盒顶）与固定像素偏移。 -->
    <span class="bg-muted/40 ring-ring/30 relative flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md ring-1">
      {#if hasImage}
        <img
          src={imageUrl as string}
          alt={`${entry.templateName} 候选 ${entry.candidateIndex + 1}`}
          class="size-full object-contain"
          draggable="false"
        />
      {:else if task?.status === 'running'}
        <LoaderCircle class="text-muted-foreground size-5 animate-spin" />
      {:else if task?.status === 'pending'}
        <LoaderCircle class="text-muted-foreground/60 size-5 animate-spin" />
      {:else if task?.status === 'error'}
        <CircleAlert class="text-destructive size-5" />
      {:else if entry.parseError !== undefined}
        <PackageOpen class="text-muted-foreground size-5" />
      {:else}
        <PackageOpen class="text-muted-foreground/60 size-5" />
      {/if}
    </span>

    <span class="flex min-w-0 flex-1 flex-col gap-1">
      <span class="flex min-w-0 items-baseline gap-1.5">
        <span class="truncate text-xs font-medium" title={entry.templateName}>{entry.templateName}</span>
        <span class="text-muted-foreground shrink-0 font-mono text-[10px] tabular-nums">
          候选 {entry.candidateIndex + 1}
        </span>
      </span>
      <span class="flex min-w-0 items-center gap-1.5">
        <Badge variant={statusBadgeVariant[entry.status]} class="text-[10px]">
          {entry.parseError !== undefined ? '无法读取' : statusLabel[entry.status]}
        </Badge>
        {#if durationText}
          <span class="text-muted-foreground font-mono text-[10px] tabular-nums">{durationText}</span>
        {/if}
        {#if task?.effectRef}
          <Badge variant="outline" class="text-[10px]" title="该任务发起时携带了案例参照图（原图+效果图合成的一张参照图）">
            {effectRefKindLabel(task.effectRef)}
          </Badge>
        {/if}
        {#if !entry.live}
          <Badge variant="outline" class="text-[10px]" title="该结果来自素材库生成档案（本会话之外生成或导入），只读展示">
            库
          </Badge>
        {/if}
        {#if entry.assetMissing}
          <Badge variant="outline" class="text-destructive text-[10px]" title="任务指向的生成档案在素材库中缺失（可能已被清理），图片以会话缓存展示">
            档案缺失
          </Badge>
        {/if}
        <span class="text-muted-foreground ml-auto hidden shrink-0 font-mono text-[10px] sm:inline">
          {task ? (task.mode === 'edit' ? 'edits' : 'gen') : '档案'}
        </span>
      </span>
    </span>

    <ChevronDown
      class={`text-muted-foreground size-4 shrink-0 transition-transform ${expanded ? '' : '-rotate-90'}`}
    />
  </button>

  {#if expanded}
    <div class="grid gap-2 border-t p-2.5" data-testid="entry-expanded">
      {#if templateDeleted}
        <Badge variant="outline" class="text-destructive w-fit text-[10px]" title="该结果引用的模板已删除或移出模板目录，可在回收站还原后自动回链">
          模板已删除 · {entry.templateName}
        </Badge>
      {/if}

      <!-- 大图横幅位：点击打开对比器 Dialog -->
      {#if hasImage}
        <button
          type="button"
          class="bg-muted/40 ring-ring/30 block w-full cursor-zoom-in overflow-hidden rounded-lg ring-1"
          style="background-image: repeating-conic-gradient(var(--color-muted) 0% 25%, transparent 0% 50%); background-size: 16px 16px;"
          title="放大对比"
          onclick={() => onopenpreview(entry.key)}
        >
          <img
            src={imageUrl as string}
            alt={`${entry.templateName} 候选 ${entry.candidateIndex + 1}`}
            class="mx-auto max-h-72 w-auto object-contain"
            draggable="false"
          />
        </button>
      {:else}
        <div class="text-muted-foreground flex min-h-32 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-4 text-center text-xs">
          {#if entry.parseError !== undefined}
            <PackageOpen class="size-6" />
            <span>档案无法读取（来自更新版本或已损坏）</span>
          {:else if task?.imageMissing}
            <PackageOpen class="size-6" />
            <span>图片缓存已失效（刷新后档案字节不可得）</span>
          {:else if task?.status === 'error'}
            <CircleAlert class="text-destructive size-6" />
            <span>生成失败</span>
          {:else}
            <LoaderCircle class="size-6 animate-spin" />
            <span>{entry.parseError !== undefined ? '档案解析中' : statusLabel[entry.status]}</span>
          {/if}
        </div>
      {/if}

      {#if blueprintBadge !== null && blueprintStage}
        <!-- [C3.3] 蓝图最小子态（design §5.3）：缩略位 + 人审参照角标 + 徽标 + 单独动作行 -->
        <div class="grid gap-1" data-testid="task-blueprint">
          <div class="flex flex-wrap items-center gap-1.5">
            <Badge variant={blueprintBadgeVariant[blueprintBadge]} class="text-[10px]" data-testid="task-blueprint-badge">
              {blueprintBadge === 'in-progress' && (blueprintStage.retryCount ?? 0) > 0
            ? '蓝图重试中'
            : blueprintBadgeLabel[blueprintBadge]}
            </Badge>
            <Badge
              variant="outline"
              class="text-[10px]"
              title="蓝图是给人审看的排布参照，不能作为 BOM / 逐钻数据来源（BOM 一律由排钻工作台重算）"
              data-testid="task-blueprint-role"
            >
              人审参照 · 非 BOM 数据源
            </Badge>
          </div>
          {#if blueprintStage.imageUrl}
            <div
              class="ring-ring/30 overflow-hidden rounded-lg ring-1"
              style="background-image: repeating-conic-gradient(var(--color-muted) 0% 25%, transparent 0% 50%); background-size: 16px 16px;"
            >
              <img
                src={blueprintStage.imageUrl}
                alt={`${entry.templateName} 施工蓝图（人审参照）`}
                class="mx-auto max-h-72 w-auto object-contain"
                draggable="false"
                data-testid="task-blueprint-image"
              />
            </div>
          {:else}
            <div class="text-muted-foreground flex min-h-20 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed p-3 text-center text-xs" data-testid="task-blueprint-placeholder">
              {#if blueprintBadge === 'in-progress'}
                <LoaderCircle class="size-5 animate-spin" />
                <span>{(blueprintStage.retryCount ?? 0) > 0 ? '蓝图重试中' : '蓝图生成中'}</span>
              {:else if blueprintBadge === 'failed' || blueprintBadge === 'interrupted'}
                <DraftingCompass class="size-5" />
                <span>{blueprintBadge === 'interrupted' ? '蓝图已中断（页面刷新），可重试' : '蓝图生成失败'}</span>
              {:else}
                <DraftingCompass class="size-5" />
                <span>无蓝图图（{blueprintBadgeLabel[blueprintBadge]}）</span>
              {/if}
            </div>
          {/if}
          {#if blueprintStage.error !== undefined && blueprintBadge !== 'interrupted'}
            <p class="text-destructive line-clamp-2 text-[11px] leading-snug break-all" title={blueprintStage.error}>
              {blueprintStage.error}
            </p>
          {/if}
          {#if blueprintRetryable || blueprintCancelable}
            <div class="flex flex-wrap items-center gap-1" data-testid="task-blueprint-actions">
              {#if blueprintRetryable}
                <Button
                  variant="outline"
                  size="xs"
                  title="单独重试蓝图（成品图不动；中断重试从已归档成品图取输入，零重新生成）"
                  onclick={() => task && onBlueprintAction?.('retry', task.id)}
                  data-testid="task-blueprint-retry"
                >
                  <RefreshCw />
                  重试蓝图
                </Button>
              {/if}
              {#if blueprintCancelable}
                <Button
                  variant="ghost"
                  size="xs"
                  class="text-muted-foreground hover:text-destructive"
                  title="单独取消蓝图（成品图不动）"
                  onclick={() => task && onBlueprintAction?.('cancel', task.id)}
                  data-testid="task-blueprint-cancel"
                >
                  <Ban />
                  取消蓝图
                </Button>
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      {#if task?.error}
        <p class="text-destructive line-clamp-3 text-[11px] leading-snug break-all" title={task.error}>
          {task.error}
        </p>
      {/if}

      <!-- 动作行：活卡 = 放大对比/送排钻/下载/复用参数/取消·重试；只读卡 = 放大对比/送排钻/下载 -->
      <div class="flex flex-wrap items-center gap-1">
        {#if task?.status === 'running' || task?.status === 'pending'}
          <Button variant="ghost" size="xs" class="text-muted-foreground hover:text-destructive" onclick={() => task && cancelTask(task.id)}>
            <Ban />
            取消
          </Button>
        {/if}
        {#if task?.status === 'error' || task?.status === 'cancelled'}
          <Button variant="outline" size="xs" onclick={() => task && retryTask(task.id)}>
            <RefreshCw />
            重试
          </Button>
          {#if task?.status === 'error'}
            <!-- 失败归因直达：401/CORS 等连接类问题的解释性文案在设置里 -->
            <Button variant="ghost" size="xs" onclick={openSettings} title="连接/鉴权类失败请到设置中检查">
              <Settings2 />
              去设置
            </Button>
          {/if}
        {/if}
        {#if hasImage}
          <Button variant="outline" size="xs" onclick={() => onopenpreview(entry.key)}>
            <ZoomIn />
            放大对比
          </Button>
        {/if}
        {#if task ? task.status === 'success' && hasImage : entry.assetId !== undefined && entry.parseError === undefined}
          <Button size="xs" onclick={() => void sendGalleryEntry(entry.key)}>
            <Send />
            送排钻
          </Button>
          <Button variant="outline" size="xs" onclick={() => void downloadGalleryEntry(entry.key)}>
            <Download />
            下载
          </Button>
        {/if}
        {#if task}
          <Button
            variant="outline"
            size="xs"
            class="ml-auto"
            title="把该任务的模型/尺寸/Advanced JSON 写回表单（提示词体不再写回模板）"
            onclick={() => task && applyTaskParams(task.id)}
          >
            <RotateCcw />
            复用参数
          </Button>
          <Button
            variant="outline"
            size="xs"
            title="复制该任务的提示词体快照到剪贴板（可粘贴进任意模板）"
            onclick={() => task && void copyTaskPrompt(task.id)}
            data-testid="task-copy-prompt"
          >
            <ClipboardCopy />
            复制提示词
          </Button>
        {/if}
      </div>

      {#if task?.debug}
        <details class="group">
          <summary class="text-muted-foreground cursor-pointer text-[11px] select-none">debug（截断脱敏）</summary>
          <pre class="bg-muted/60 mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap break-all">{JSON.stringify(task.debug, null, 2)}</pre>
        </details>
      {/if}
      {#if !entry.live && entry.composedPrompt}
        <details class="group">
          <summary class="text-muted-foreground cursor-pointer text-[11px] select-none">提示词全文（档案快照）</summary>
          <pre class="bg-muted/60 mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-[10px] leading-snug whitespace-pre-wrap break-all">{entry.composedPrompt}</pre>
        </details>
      {/if}
    </div>
  {/if}
</div>
