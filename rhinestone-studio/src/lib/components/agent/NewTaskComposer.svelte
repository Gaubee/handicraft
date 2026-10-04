<!--
  NewTaskComposer.svelte — 开始新任务面板（new-task-panel 2026-10-02，Owner 需求
  「参考朱墨：明确让用户填图片（可多）+尺寸+装饰钻集合；多图=并发创建多个会话，
  不是提示词实现」）。
  [中栏迁移 2026-10-02（Owner 反馈「新会话做在右侧——zhumo 不是这样的」——zhumo
  ListDetailPage chatColumn 现行形态）]：挂载**中栏**（对话栏——TranscriptView
  同位；AgentView chatColumn snippet：桌面第二栏 / 移动对话全宽位，单实例不双挂）。
  满高布局：头部（标题+取消）+ 表单区滚动 + 创建钮/输入面固定底栏。「新会话」
  点击=写 `#/new` 只切换中栏渲染本页（不创建会话）；取消=回 `#/`（零会话创建）；
  创建成功=submitNewTask pushState 新会话锚并打开（中栏切回对话流）。表单态不
  持久（卸载即清——Owner「简单为上」）。
  表单域（zhumo TaskComposer 同款骨架）：图片多选/画布尺寸/钻集合选择/预设
  chips + 指令输入面整体复用 ComposerCard（Owner 2026-09-28 复用裁决先例——
  模型/强度选择、发送语义同源，面板不自建 textarea）。
  正交意图：
  [1] 图片多选（文件选择+拖拽；chip 预览行可删；≥1 张才可创建——rpc 走
      uploadAssetImage 上传链，mock 演示模式本地元数据+横幅提示）。
  [2] 画布尺寸（宽×高 cm，界 5-100，缺省 20×20——纯函数层 newTaskComposer.ts）。
  [3] 装饰钻集合选择（listSets 读面：智能选钻（自动）缺省+我的组合/材料市场组；
      市场组合开工先复制副本——ComposerCard 发送链同款语义）。
  [4] 预设开场 chips（点选填充 ComposerCard 可编辑）。
  [5] 提交编排入口（sendFollowup 语义之上的 submitNewTask：N 图=N 会话并发，
      标题带序号；成功 oncreated 通知父层收起——失败保持在场，toast 已报告明细）。
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import ComposerCard from './ComposerCard.svelte'
  import {
    getAgentMode,
    getBoundAgentApi,
    isAgentSending,
    submitNewTask,
  } from '$lib/agentApi/store.svelte'
  import {
    CANVAS_CM_DEFAULT,
    CANVAS_CM_MAX,
    CANVAS_CM_MIN,
    NEW_TASK_PRESETS,
    buildNewTaskFirstMessage,
    isCanvasCmValid,
  } from '$lib/agentApi/newTaskComposer'
  import { MAX_ATTACHMENT_BYTES, type AttachmentMeta } from '$lib/agentApi/attachments'
  import { agentAssetUrl } from '$lib/agentApi/assetBoundary'
  import type { AgentSetSummary } from '$lib/agentApi/types'
  import { modelsApi } from '$lib/modelsApi'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { AvailableModel } from '@handicraft/contracts'
  import IconImagePlus from '@lucide/svelte/icons/image-plus'
  import IconX from '@lucide/svelte/icons/x'
  import IconLoader from '@lucide/svelte/icons/loader-circle'
  import IconTriangleAlert from '@lucide/svelte/icons/triangle-alert'

  let {
    /** 打开时预填图片（chat 空态拖入→AgentView 投递 seedFiles）。 */
    seedFiles = null,
    onseedconsumed = null,
    /** 取消/关闭：回列表态（不创建任何会话）——AgentView 收起 composer。 */
    oncancel = null,
    /** 创建成功（submitNewTask 已打开新会话）——AgentView 收起 composer。 */
    oncreated = null,
  }: {
    seedFiles?: File[] | null
    onseedconsumed?: (() => void) | null
    oncancel?: (() => void) | null
    oncreated?: (() => void) | null
  } = $props()

  // ------------------------------------------------------------ 图片选择（多选）

  /** 面板图片（上传元数据+去重键；mock 演示模式附本地预览 URL）。 */
  interface PanelImage {
    key: string
    meta: AttachmentMeta
    size: number
    demoUrl?: string
  }

  let images = $state<PanelImage[]>([])
  let uploading = $state(false)
  let fileInput = $state<HTMLInputElement | null>(null)
  let dragActive = $state(false)

  const isMock = $derived(getAgentMode() !== 'rpc')

  function isImageFile(file: File): boolean {
    return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name)
  }

  /** mock 演示模式本地预览（jsdom/隐私模式 createObjectURL 缺失或抛错——空串占位）。 */
  function objectUrlOf(file: File): string {
    try {
      if (typeof URL.createObjectURL !== 'function') return ''
      return URL.createObjectURL(file)
    } catch {
      return ''
    }
  }

  /** 单张入列：rpc 走上传链（同 ComposerCard 注入面）；mock=演示元数据
   *  （blobRef 演示标记——mock followup 接收不消费，面板链路完整可体验）。 */
  async function addImage(file: File): Promise<PanelImage> {
    const api = getBoundAgentApi()
    if (api?.uploadAssetImage !== undefined) {
      const uploaded = await api.uploadAssetImage(file)
      if (uploaded.convertedToPng) showToast(`「${file.name}」已转换为 PNG 上传`)
      return { key: `${file.name}:${file.size}`, meta: uploaded, size: file.size }
    }
    return {
      key: `${file.name}:${file.size}`,
      meta: {
        blobRef: `demo-${file.name}`,
        name: file.name,
        mime: file.type || 'image/png',
        width: 0,
        height: 0,
      },
      size: file.size,
      demoUrl: objectUrlOf(file),
    }
  }

  /** 收图入口（文件选择+拖拽同门）：图片过滤→尺寸门→去重→上传/入列（首败即停）。 */
  async function onFilesPicked(files: File[] | FileList | null): Promise<void> {
    if (files === null || files.length === 0) return
    const picked = Array.from(files).filter(isImageFile)
    if (picked.length === 0) {
      showToast('未识别到图片文件——请选择图片')
      return
    }
    uploading = true
    try {
      for (const file of picked) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          showToast(`「${file.name}」超过 4MiB 上限，未添加`)
          continue
        }
        if (images.some((image) => image.key === `${file.name}:${file.size}`)) continue
        try {
          images = [...images, await addImage(file)]
        } catch (error) {
          showToast(`图片添加失败：${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
    } finally {
      uploading = false
      if (fileInput !== null) fileInput.value = ''
    }
  }

  function removeImage(key: string): void {
    images = images.filter((image) => image.key !== key)
  }

  function ondragover(event: DragEvent): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    dragActive = true
  }

  function ondragleave(event: DragEvent): void {
    const zone = event.currentTarget
    const next = event.relatedTarget
    if (zone instanceof Node && next instanceof Node && zone.contains(next)) return
    dragActive = false
  }

  function ondrop(event: DragEvent): void {
    dragActive = false
    const files = event.dataTransfer?.files
    if (files === undefined || files.length === 0) return
    event.preventDefault()
    void onFilesPicked(files)
  }

  /** 挂载时预填（chat 空态拖入图→AgentView 投递 seedFiles——消费即清；面板
   *  随 `#/new` 中栏条件挂载，卸载即整体复位（表单态不持久）。 */
  $effect(() => {
    if (seedFiles === null || seedFiles.length === 0) return
    const files = seedFiles
    onseedconsumed?.()
    void onFilesPicked(files)
  })

  // ------------------------------------------------------------ 画布尺寸（cm）

  let widthCm = $state(CANVAS_CM_DEFAULT)
  let heightCm = $state(CANVAS_CM_DEFAULT)

  const sizeError = $derived.by(() => {
    if (isCanvasCmValid(widthCm) && isCanvasCmValid(heightCm)) return null
    return `宽/高需在 ${CANVAS_CM_MIN}–${CANVAS_CM_MAX} cm 之间`
  })

  // ------------------------------------------------------------ 铺法（T4.4——满铺/点缀，缺省不指定）

  /** ''=不指定（缺省交策略按画面自定——Owner 裁决位：默认值暂不设）。 */
  let pavingChoice = $state('')

  // ------------------------------------------------------------ 装饰钻集合（读面复用）

  /** ''=智能选钻（自动）缺省项；值为集合 resourceId。 */
  let setChoice = $state('')
  let setOptions = $state<AgentSetSummary[] | null>(null)
  let setLoadFailed = $state(false)

  const selectedSet = $derived(
    setChoice === '' || setOptions === null ? null : (setOptions.find((set) => set.resourceId === setChoice) ?? null),
  )
  const mineSets = $derived((setOptions ?? []).filter((set) => set.scope !== 'market'))
  const marketSets = $derived((setOptions ?? []).filter((set) => set.scope === 'market'))

  // ------------------------------------------------------------ 模型目录（ComposerCard 同源）

  let availableModels = $state<AvailableModel[] | null>(null)
  let availableDefault = $state<{ provider: string; model: string; effort?: string | null } | null>(null)
  /** 任务级模型覆盖（面板域；null=跟随默认——zhumo TaskComposer 同款）。 */
  let pickedModel = $state<{ provider: string; model: string; effort?: string } | null>(null)
  let composerRef = $state<ComposerCard | null>(null)

  /** 挂载即拉（集合目录+模型清单——zhumo「不等点开」同款）。 */
  $effect(() => {
    const api = getBoundAgentApi()
    if (api?.listSets !== undefined) {
      void api
        .listSets()
        .then((out) => {
          setOptions = out
        })
        .catch(() => {
          setLoadFailed = true
        })
    } else {
      setLoadFailed = true
    }
    void (async () => {
      try {
        const out = await modelsApi().getAvailableModels()
        availableModels = out.models
        availableDefault = out.default
      } catch {
        availableModels = null // mock/未配路由——chip 隐藏，沿用既有空态语义
      }
    })()
  })

  /** 强度档选择=把默认模型显式化为覆盖+档（zhumo pickEffort 同款）。 */
  function pickModel(provider: string, model: string): void {
    pickedModel = { provider, model }
  }

  function pickEffort(effort: string | null): void {
    const base =
      pickedModel ??
      (availableDefault !== null ? { provider: availableDefault.provider, model: availableDefault.model } : null)
    if (base === null) return
    pickedModel = { ...base, ...(effort !== null ? { effort } : {}) }
  }

  // ------------------------------------------------------------ 提交（N 图=N 会话并发）

  /** 市场组合复制中（发送位禁用防双发——ComposerCard copyingMarketSet 同式）。 */
  let copyingSet = $state(false)

  const formValid = $derived(images.length > 0 && sizeError === null)

  async function submitFromComposer(text: string): Promise<void> {
    if (!formValid || isAgentSending() || copyingSet) {
      if (images.length === 0) showToast('请先添加至少一张图片')
      return
    }
    // 市场组合：先复制本人副本再绑定 sourceSetId（服务端按 owner 展开——市场源必拒）。
    let sourceSetId: string | undefined
    if (selectedSet !== null) {
      if (selectedSet.scope !== 'market') {
        sourceSetId = selectedSet.resourceId
      } else {
        const api = getBoundAgentApi()
        if (api?.copyMarketSet === undefined) {
          showToast('市场组合复制通道不可用——请改选自己的组合或稍后重试')
          return
        }
        copyingSet = true
        try {
          sourceSetId = (await api.copyMarketSet(selectedSet.resourceId)).resourceId
          showToast(`已复制「${selectedSet.name}」到我的材料——本次开工使用副本`)
        } catch (error) {
          showToast(`复制市场组合失败：${error instanceof Error ? error.message : String(error)}`)
          return
        } finally {
          copyingSet = false
        }
      }
    }
    const firstMessage = buildNewTaskFirstMessage({
      instruction: text,
      widthCm,
      heightCm,
      set: selectedSet,
      ...(pavingChoice === 'full' || pavingChoice === 'accent' ? { pavingStyle: pavingChoice } : {}),
    })
    const ok = await submitNewTask({
      images: images.map((image) => image.meta),
      firstMessage,
      instruction: text,
      ...(sourceSetId !== undefined ? { sourceSetId } : {}),
      ...(pickedModel !== null ? { model: pickedModel } : {}),
    })
    if (ok) oncreated?.() // 失败（含全败）保持面板在场——toast 已报告明细
  }
</script>

<div class="bg-background flex h-full min-h-0 flex-col" data-testid="new-task-panel">
  <header class="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3">
    <h2 class="truncate text-xs font-semibold" data-testid="new-task-title">开始新任务</h2>
    <Button
      size="icon-sm"
      variant="ghost"
      class="size-7"
      aria-label="取消并返回列表（不创建会话）"
      title="取消并返回列表（不创建会话）"
      data-testid="new-task-cancel"
      onclick={() => oncancel?.()}
    >
      <IconX class="size-3.5" aria-hidden="true" />
    </Button>
  </header>
  <p class="sr-only">
    填入图片（可多选）、画布尺寸与装饰钻集合创建贴钻任务；多张图每张独立一个会话并发排钻。
  </p>

  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
    {#if isMock}
      <!-- 阻断面（Owner 需求）：无 daemon（mock）=面板可用但提示演示数据。 -->
      <div
        class="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-[11px] leading-snug text-amber-700"
        role="status"
        data-testid="new-task-demo-banner"
      >
        <IconTriangleAlert class="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span>演示模式（未连接后台）：面板可完整体验——图片与创建走本地演示数据，不产生真实任务。</span>
      </div>
    {/if}

    <!-- [1] 图片（多选必填） -->
    <section data-testid="new-task-images">
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-semibold">
          图片<span class="text-destructive" aria-hidden="true">*</span>
          <span class="ml-1 font-normal text-muted-foreground">可多选</span>
        </h3>
        <input
          bind:this={fileInput}
          type="file"
          accept="image/*"
          multiple
          class="hidden"
          onchange={(event) => void onFilesPicked(event.currentTarget.files)}
        />
        <Button size="sm" variant="outline" data-testid="new-task-add-images" onclick={() => fileInput?.click()}>
          <IconImagePlus class="size-3.5" aria-hidden="true" />
          选择图片…
        </Button>
      </div>
      <div
        class="relative mt-2 rounded-xl border border-dashed p-3 transition-colors {dragActive ? 'border-primary/60 bg-primary/5' : 'border-border'}"
        role="region"
        aria-label="图片选择区，支持拖入图片"
        data-testid="new-task-dropzone"
        ondragover={ondragover}
        ondragleave={ondragleave}
        ondrop={ondrop}
      >
        {#if images.length === 0}
          <p class="py-2 text-center text-[11px] text-muted-foreground" data-testid="new-task-image-empty">
            拖入图片到此处，或点右上「选择图片」——每张图独立开一个会话
          </p>
        {:else}
          <div class="flex flex-wrap gap-1.5" data-testid="new-task-image-chips">
            {#each images as image (image.key)}
              <span
                class="group/img flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-0.5 pl-0.5 pr-1.5"
              >
                <img
                  src={image.demoUrl && image.demoUrl !== '' ? image.demoUrl : agentAssetUrl(image.meta.blobRef)}
                  alt={image.meta.name}
                  class="h-10 w-10 rounded object-cover"
                  title="{image.meta.name}"
                />
                <span class="max-w-28 truncate text-[10px]" data-testid="new-task-image-name">{image.meta.name}</span>
                <button
                  type="button"
                  class="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label="移除图片 {image.meta.name}"
                  data-testid="new-task-image-remove"
                  onclick={() => removeImage(image.key)}
                >
                  <IconX class="h-2.5 w-2.5" />
                </button>
              </span>
            {/each}
          </div>
        {/if}
        {#if uploading}
          <span class="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground" data-testid="new-task-uploading">
            <IconLoader class="h-3 w-3 animate-spin" aria-hidden="true" />
            上传中…
          </span>
        {/if}
        {#if dragActive}
          <div
            class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 text-xs font-medium text-primary"
            data-testid="new-task-drag-overlay"
          >
            松开添加图片
          </div>
        {/if}
      </div>
      <p class="mt-1.5 text-[11px] {formValid ? 'text-muted-foreground' : 'text-muted-foreground/80'}" data-testid="new-task-image-hint">
        {#if images.length > 1}
          {images.length} 张图将并发创建 {images.length} 个会话（每张独立排钻，同一套尺寸/钻组/指令）
        {:else}
          至少 1 张才能创建；单张 ≤4MiB
        {/if}
      </p>
    </section>

    <!-- [2] 画布尺寸（cm） -->
    <section data-testid="new-task-size">
      <h3 class="text-xs font-semibold">画布尺寸（cm）</h3>
      <div class="mt-2 flex items-center gap-2">
        <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
          宽
          <input
            bind:value={widthCm}
            type="number"
            min={CANVAS_CM_MIN}
            max={CANVAS_CM_MAX}
            step="0.5"
            aria-label="画布宽（厘米）"
            data-testid="new-task-width"
            class="block w-20 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
        <span class="text-xs text-muted-foreground" aria-hidden="true">×</span>
        <label class="flex items-center gap-1 text-[11px] text-muted-foreground">
          高
          <input
            bind:value={heightCm}
            type="number"
            min={CANVAS_CM_MIN}
            max={CANVAS_CM_MAX}
            step="0.5"
            aria-label="画布高（厘米）"
            data-testid="new-task-height"
            class="block w-20 rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </label>
      </div>
      {#if sizeError !== null}
        <p class="mt-1 text-[11px] text-destructive" role="alert" data-testid="new-task-size-error">{sizeError}</p>
      {/if}
    </section>

    <!-- [2b] 铺法（满铺/点缀——T4.4；缺省不指定=交策略按画面自定） -->
    <section data-testid="new-task-paving">
      <h3 class="text-xs font-semibold">铺法</h3>
      <select
        bind:value={pavingChoice}
        aria-label="铺法"
        data-testid="new-task-paving-select"
        class="mt-2 block w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="" data-testid="new-task-paving-auto">不指定——由模型按画面自定密度</option>
        <option value="full" data-testid="new-task-paving-full">满铺——整体铺满（高密度）</option>
        <option value="accent" data-testid="new-task-paving-accent">点缀——关键部位点缀（低密度）</option>
      </select>
    </section>

    <!-- [3] 装饰钻集合（listSets 读面） -->
    <section data-testid="new-task-set">
      <h3 class="text-xs font-semibold">装饰钻集合</h3>
      <select
        bind:value={setChoice}
        aria-label="装饰钻集合"
        data-testid="new-task-set-select"
        class="mt-2 block w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <option value="" data-testid="new-task-set-auto">智能选钻（自动）——由模型按画面挑钻</option>
        {#if setOptions !== null}
          {#if mineSets.length > 0}
            <optgroup label="我的组合">
              {#each mineSets as set (set.resourceId)}
                <option value={set.resourceId}>{set.name}（{set.memberCount} 成员）</option>
              {/each}
            </optgroup>
          {/if}
          {#if marketSets.length > 0}
            <optgroup label="材料市场（开工自动复制副本）">
              {#each marketSets as set (set.resourceId)}
                <option value={set.resourceId}>{set.name}（{set.memberCount} 成员）</option>
              {/each}
            </optgroup>
          {/if}
        {/if}
      </select>
      {#if setLoadFailed}
        <p class="mt-1 text-[11px] text-muted-foreground" data-testid="new-task-set-failed">
          集合目录不可用——可先用智能选钻开工，任务中仍可追加钻
        </p>
      {:else if selectedSet?.scope === 'market'}
        <p class="mt-1 text-[11px] text-muted-foreground" data-testid="new-task-set-market-hint">
          市场组合为只读快照——开工自动复制到我的材料
        </p>
      {/if}
    </section>

    <!-- [4] 预设开场（点选填充可编辑——ComposerCard.setPrompt 注入） -->
    <section data-testid="new-task-presets">
      <p class="mb-1.5 text-[11px] text-muted-foreground">预设开场——点选填充输入框，填充后仍可自由修改</p>
      <div class="flex flex-wrap gap-1.5">
        {#each NEW_TASK_PRESETS as preset (preset.label)}
          <button
            type="button"
            class="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-foreground/80 transition-colors hover:border-primary/50 hover:bg-accent-soft"
            data-testid="new-task-preset"
            onclick={() => composerRef?.setPrompt(preset.prompt)}
          >
            {preset.label}
          </button>
        {/each}
      </div>
    </section>
  </div>

  <!-- [5] 指令输入面（复用 ComposerCard——模型/强度/发送同源；附件/集合/触发面
       关闭：图片在面板选择器、集合在面板下拉，面板域不重复建输入面）。
       创建主钮=表单门（≥1 图+尺寸界——指令可空：纯图+表单参数也可开工，模板
       行恒在）；Composer 发送=同路（需非空文本——hasPayload 既有门）。 -->
  <footer class="shrink-0 space-y-2 border-t p-3" data-testid="new-task-composer-wrap">
    <Button
      size="sm"
      class="w-full"
      data-testid="new-task-create"
      disabled={!formValid || isAgentSending() || copyingSet}
      onclick={() => void submitFromComposer(composerRef?.promptText() ?? '')}
    >
      {#if images.length > 1}
        并发创建 {images.length} 个会话（每张图一个）
      {:else}
        创建任务并开工
      {/if}
    </Button>
    {#if images.length > 1}
      <p class="text-[11px] font-medium text-primary" data-testid="new-task-summary">
        多图=每张独立一个会话并发排钻（同一套尺寸/钻组/指令）
      </p>
    {/if}
    <ComposerCard
      bind:this={composerRef}
      onsend={(text) => void submitFromComposer(text)}
      sending={isAgentSending()}
      disabled={!formValid || copyingSet}
      models={availableModels}
      defaultModel={availableDefault}
      currentModel={pickedModel}
      currentEffort={pickedModel?.effort ?? null}
      onsetmodel={pickModel}
      onseteffort={pickEffort}
      attachable={false}
      triggers={false}
      placeholder="描述这次贴钻的要求…（点上方预设可快速填充，填充后仍可自由修改）"
    />
  </footer>
</div>
