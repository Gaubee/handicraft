<!--
Orthogonal intents (max 4):
1. [2026-09-19 Layout 1.2 / 2026-09-20 studio-layers 2.7 瘦身] 上下文条：来源缩略/名称/尺寸 + 「更换」
     （素材库选图器）+ 参考原图管理 + 取景控制（适应/±/N%——经 props 转发，BlockCanvas 零渲染改动）。
     [2.5/2.7 废除] 预览三模式分段控件 + 全局透明度滑杆（收编背景层源/透明度——检查器背景面板）。
2. [2026-09-20 studio-layers 2.8 项目身份 / add-project-files 2.6 徽标常驻] 已保存/已打开项目：
     项目名 + ●未保存 + 保存（⌘S 同源）+ 项目菜单（另存为…/导出项目文件/关闭项目——内联展开，
     避免 overflow 裁切）+ 首次保存弹命名（默认 = 来源图名去扩展名）+ engineVersion 漂移徽标 +
     打开单次提示「已恢复默认观察布局」。未命名会话（未保存过）dirty = ●未保存徽标常驻（切 Tab
     不弹守卫的替代提醒——store 单例跨视图存活）。[2.6] 换来源图经 guard 域三按钮守卫。
     CAS 冲突/保存失败就地 role=alert（不清会话）。
3. [2026-09-19 受控] 无本地状态镜像残留（透明度滑杆废除后本组件零受控滑杆；命名弹窗输入为纯局部态）。
4. [2026-09-19 R4 / 2.7 移动端] 抽屉入口（图层/历史/检查器）经 onOpenDrawer 回调上抛，抽屉本体在
     StudioView（现行为）；载入错误常驻来源组。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import {
    clearReferenceImage,
    getBlocks,
    getLoadError,
    getPainting,
    getReferenceImage,
    getSourceImage,
    loadFromLibrary,
    setReferenceFile,
  } from '$lib/stores/studio.svelte'
  import {
    buildGemprojExport,
    clearObservationNotice,
    closeStudioProject,
    defaultGemprojName,
    getStudioProject,
    isStudioDirty,
    saveGemproj,
    saveGemprojAs,
  } from '$lib/studio/projectPersistence.svelte'
  import { runStudioGuarded } from '$lib/studio/guard.svelte'
  import ButtonBusy from './ButtonBusy.svelte'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ChevronUp from '@lucide/svelte/icons/chevron-up'
  import History from '@lucide/svelte/icons/history'
  import Layers from '@lucide/svelte/icons/layers'
  import Maximize from '@lucide/svelte/icons/maximize'
  import Minus from '@lucide/svelte/icons/minus'
  import Plus from '@lucide/svelte/icons/plus'
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import Upload from '@lucide/svelte/icons/upload'

  interface Props {
    /** 移动端抽屉入口回调（抽屉本体与现行为留在 StudioView） */
    onOpenDrawer?: (kind: 'layers' | 'history' | 'inspector') => void
    /** 取景控制（迁自 BlockCanvas 浮动工具栏；由 StudioView 经 bind:this 转发到画布实例） */
    onFit?: () => void
    onZoomIn?: () => void
    onZoomOut?: () => void
    zoomPercent?: number | null
  }
  let { onOpenDrawer, onFit, onZoomIn, onZoomOut, zoomPercent = null }: Props = $props()

  const source = $derived(getSourceImage())
  const painting = $derived(getPainting())
  const loadError = $derived(getLoadError())
  const blocks = $derived(getBlocks())
  const reference = $derived(getReferenceImage())

  /** 缩略图：优先渲染已解码像素（离屏不可行时退回 dataUrl；测试直灌路径 dataUrl 为空则不显示） */
  const thumbUrl = $derived.by(() => {
    if (source?.dataUrl) return source.dataUrl
    return ''
  })

  async function onReferenceUpload(e: Event): Promise<void> {
    const input = e.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    if (file) await setReferenceFile(file)
    input.value = ''
  }

  /** [5.1 更换 / 2.6 守卫] 素材库选图器换源（controller 单实例；取消/Esc 不动当前图）；
   *  dirty 会话 = 破坏性动作，选定后先过三按钮守卫（守卫取消 = 保留当前图与修改）。 */
  async function changeSource(): Promise<void> {
    const picked = await assetPicker.open({ multi: false })
    const first = picked?.[0]
    if (!first) return
    const proceed = async (): Promise<void> => {
      // busy 只覆盖取图后的解码/入库/分块启动段（选图器浏览期间按钮背后不转圈）
      sourceBusy = true
      try {
        await loadFromLibrary({ id: first.id, name: first.name })
      } finally {
        sourceBusy = false
      }
    }
    if (isStudioDirty()) runStudioGuarded(proceed)
    else await proceed()
  }

  // [2026-09-19 Busy] 更换 = button 承载：载入期间 spinner + disabled + aria-busy
  let sourceBusy = $state(false)

  // ---- [2.8 项目身份] 保存/另存为/导出/关闭 + ⌘S + 首次保存命名 ----
  const project = $derived(getStudioProject())
  const dirty = $derived(isStudioDirty())
  let saveBusy = $state(false)
  let exportBusy = $state(false)
  let menuOpen = $state(false)
  /** 首次保存命名弹窗（含另存为复用——confirmSaveAs 按项目态分流 saveGemproj{name}/saveGemprojAs）。 */
  let saveAsOpen = $state(false)
  let saveAsName = $state('')
  let saveError = $state<string | null>(null)

  function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  /** 保存入口（按钮/⌘S 同源）：未保存过 → 弹命名（默认来源图名去扩展名）；已保存 → CAS 路径。 */
  async function onSave(): Promise<void> {
    if (!painting) return
    saveError = null
    if (getStudioProject() === null) {
      saveAsName = defaultGemprojName()
      saveAsOpen = true
      return
    }
    saveBusy = true
    try {
      await saveGemproj()
    } catch (error) {
      saveError = messageOf(error) // CAS 冲突等就地提示，会话保持
    } finally {
      saveBusy = false
    }
  }

  async function confirmSaveAs(): Promise<void> {
    saveBusy = true
    try {
      if (getStudioProject() === null) await saveGemproj({ name: saveAsName })
      else await saveGemprojAs(saveAsName)
      saveAsOpen = false
    } catch (error) {
      saveError = messageOf(error)
    } finally {
      saveBusy = false
    }
  }

  /** 导出项目文件（磁盘 .gemproj——embedded 烘焙自包含；导出不清 dirty）。 */
  async function exportProjectFile(): Promise<void> {
    exportBusy = true
    try {
      const out = await buildGemprojExport()
      if (out) downloadBlob(out.blob, out.filename)
    } finally {
      exportBusy = false
    }
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  /** ⌘S 与保存按钮同源（输入框焦点不拦截——保存意图在任何焦点下都成立）。 */
  function onKeydown(e: KeyboardEvent): void {
    if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's') return
    if (!painting) return
    e.preventDefault()
    void onSave()
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="bg-background/80 flex shrink-0 flex-col gap-1.5 border-b px-3 py-2 backdrop-blur lg:h-10 lg:min-w-0 lg:flex-row lg:items-center lg:gap-3 lg:overflow-x-auto lg:py-0 lg:px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
  data-testid="context-bar"
>
  <!-- 来源组：缩略 + 名称 + 尺寸 + 更换 + 参考原图管理 + 载入错误；移动端此行右侧挂抽屉入口 -->
  <div class="flex min-w-0 flex-1 items-center gap-2">
    {#if thumbUrl}
      <img
        src={thumbUrl}
        alt={source?.name ?? ''}
        class="border-input size-6 shrink-0 rounded border object-cover"
      />
    {:else}
      <span class="bg-gem-dots border-input size-6 shrink-0 rounded border" aria-hidden="true"></span>
    {/if}

    {#if source}
      <span class="min-w-0 max-w-40 truncate text-xs font-medium sm:max-w-48 lg:max-w-56" title={source.name}>{source.name}</span>
      <span class="text-muted-foreground hidden shrink-0 font-mono text-[11px] whitespace-nowrap tabular-nums sm:inline">
        {source.width}×{source.height}px{#if source.downscale < 1} · 已降采样 {(source.downscale * 100).toFixed(0)}%{/if}
      </span>
      <!-- [2.6] 未命名会话 dirty 徽标常驻（已保存/已打开项目的 ● 在项目身份组 project-dirty-dot） -->
      {#if dirty && !project}
        <span
          class="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-600"
          title="有未保存的修改"
          data-testid="studio-dirty-badge"
        >
          <span class="size-1.5 rounded-full bg-amber-500" aria-hidden="true"></span>
          未保存
        </span>
      {/if}
    {:else}
      <span class="text-muted-foreground truncate text-xs">未载入数字油画</span>
    {/if}

    <!-- 更换：素材库选图器；载入期间 button 承载 busy -->
    <ButtonBusy
      size="xs"
      variant="outline"
      busy={sourceBusy}
      onclick={() => void changeSource()}
      title="从素材库更换数字油画"
      data-testid="change-source"
    >
      更换
      <ChevronDown />
    </ButtonBusy>

    <!-- 参考原图管理（背景源=参考原图 的素材面——背景面板选择源，此处管理图片本体） -->
    <label class="hidden cursor-pointer lg:flex">
      <span
        class="border-input bg-background hover:bg-muted hover:text-foreground inline-flex h-6 items-center gap-1 rounded-md border px-2 text-xs font-medium shadow-xs transition-colors"
      >
        <Upload class="size-3" />
        上传原图
      </span>
      <input type="file" accept="image/png,image/jpeg,image/webp" class="hidden" onchange={onReferenceUpload} />
    </label>
    {#if reference}
      <Button size="xs" variant="ghost" onclick={clearReferenceImage} title="移除参考原图">清除</Button>
    {/if}

    {#if loadError}
      <span class="text-destructive truncate text-xs" role="alert">{loadError}</span>
    {/if}

    <!-- 移动端抽屉入口（图层/历史/检查器——左列与检查器在移动端为 bottom sheet） -->
    <div class="ml-auto flex shrink-0 items-center gap-1 py-1.5 lg:hidden" data-testid="mobile-param-entry">
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('layers')}>
        <Layers />
        图层
        <ChevronUp class="opacity-60" />
      </Button>
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('history')}>
        <History />
        历史
        <ChevronUp class="opacity-60" />
      </Button>
      <Button variant="outline" size="xs" onclick={() => onOpenDrawer?.('inspector')}>
        <SlidersHorizontal />
        {blocks.length > 0 ? `检查器 · ${blocks.length} 块` : '检查器'}
        <ChevronUp class="opacity-60" />
      </Button>
    </div>
  </div>

  <!-- [2.8 项目身份] 项目名 + ●未保存 + 保存 + 项目菜单（内联展开）+ 漂移徽标 + 单次提示 -->
  {#if project}
    <div class="flex shrink-0 items-center gap-1" data-testid="project-identity">
      <span class="bg-border hidden h-5 w-px shrink-0 lg:block" aria-hidden="true"></span>
      <span class="max-w-32 truncate text-xs font-medium" title={project.name}>{project.name}</span>
      {#if dirty}
        <span class="size-1.5 shrink-0 rounded-full bg-amber-500" title="有未保存的修改" data-testid="project-dirty-dot"></span>
      {/if}
      <ButtonBusy
        size="xs"
        variant="outline"
        busy={saveBusy}
        disabled={!painting}
        onclick={() => void onSave()}
        title="保存（⌘S）"
        data-testid="project-save"
      >
        保存
      </ButtonBusy>
      <Button
        size="icon-xs"
        variant="ghost"
        title="项目菜单"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
        data-testid="project-menu-trigger"
      >
        <ChevronDown />
      </Button>
      {#if menuOpen}
        <div class="flex shrink-0 items-center gap-1" data-testid="project-menu">
          <Button
            size="xs"
            variant="ghost"
            onclick={() => {
              menuOpen = false
              saveAsName = project.name
              saveAsOpen = true
            }}
          >
            另存为…
          </Button>
          <ButtonBusy size="xs" variant="ghost" busy={exportBusy} onclick={() => void exportProjectFile()}>
            导出项目文件
          </ButtonBusy>
          <Button
            size="xs"
            variant="ghost"
            onclick={() => {
              menuOpen = false
              void closeStudioProject()
            }}
          >
            关闭项目
          </Button>
        </div>
      {/if}
      {#if project.engineDrift}
        <span
          class="shrink-0 text-[11px] text-amber-600"
          title="文件由旧引擎版本保存——覆写存活已按层清点，见层列表提示"
          data-testid="engine-drift"
        >
          旧引擎版本
        </span>
      {/if}
      {#if project.observationNotice}
        <span class="text-muted-foreground flex shrink-0 items-center gap-1 text-[11px]" data-testid="observation-notice">
          已恢复默认观察布局
          <button
            type="button"
            class="hover:text-foreground rounded px-0.5 leading-none"
            aria-label="关闭提示"
            onclick={clearObservationNotice}
          >
            ×
          </button>
        </span>
      {/if}
      {#if saveError}
        <span class="text-destructive truncate text-xs" role="alert" data-testid="save-error">{saveError}</span>
      {/if}
    </div>
  {/if}

  <!-- 取景组（桌面，迁自 BlockCanvas 浮动工具栏；移动端画布手势直达） -->
  {#if painting}
    <div class="hidden shrink-0 items-center gap-0.5 lg:flex">
      <span class="bg-border mx-1 h-5 w-px shrink-0" aria-hidden="true"></span>
      <Button size="icon-xs" variant="ghost" title="适应窗口（双击画布同效）" onclick={() => onFit?.()}>
        <Maximize />
      </Button>
      <Button size="icon-xs" variant="ghost" title="放大" onclick={() => onZoomIn?.()}>
        <Plus />
      </Button>
      <Button size="icon-xs" variant="ghost" title="缩小" onclick={() => onZoomOut?.()}>
        <Minus />
      </Button>
      <span class="text-muted-foreground px-1 font-mono text-xs tabular-nums" data-testid="canvas-zoom">
        {zoomPercent !== null ? `${zoomPercent}%` : '—'}
      </span>
    </div>
  {/if}
</div>

<!-- [2.8] 首次保存/另存为命名弹窗（默认 = 来源图名去扩展名；取消不动会话） -->
<Dialog.Root open={saveAsOpen} onOpenChange={(open) => !open && (saveAsOpen = open)}>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title>{getStudioProject() === null ? '保存排钻工程' : '另存为排钻工程'}</Dialog.Title>
      <Dialog.Description>
        当前层集/参数将保存为 .gemproj（素材库「项目」目录）；观察布局不入档。
      </Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-1.5 py-2">
      <label class="text-sm leading-none" for="project-name-input">项目名</label>
      <Input id="project-name-input" bind:value={saveAsName} data-testid="project-name-input" />
    </div>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (saveAsOpen = false)}>取消</Button>
      <ButtonBusy busy={saveBusy} size="sm" onclick={() => void confirmSaveAs()} data-testid="project-name-confirm">
        保存
      </ButtonBusy>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
