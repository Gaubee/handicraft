<!--
 * Orthogonal intents (max 5):
 * 1. [2026-09-19 Shell] 文档态视图：摘要条（左端项目身份 [▦]名●未保存 + 保存/▾ 菜单 + 钻数/来源/尺寸
 *   + 图层入口）+ 只读四层画布；菜单 = 另存为… / 导出精修文件(.gemdoc) / 关闭文档（PM 稿 §C.2.4 线框）。
 *   [2026-09-20 C-3.1 rename-and-expert-workbench] 类 PS 四区骨架：摘要条 + 工具栏（EditToolbar）/
 *   画布 / 属性面板（EditPropertiesPanel）/ 图层面板（EditLayersPanel 右侧栏，移动端折叠浮层）/
 *   状态条（EditStatusBar——[5.7] 画幅读数位接真值 doc.physicalCanvas，studio-layers
 *   ③段 handoff v2 装载后文档态恒携带；缺席/null 保持「未锚定」占位）。
 * 2. [2026-09-20 C-3.2/3.5] 键盘分派接线（editKeyboard）：Esc 清空 / 方向键三档 nudge
 *   （NudgeSession 按键会话合组 undo）/ ⌘Z·⌘⇧Z。
 * 3. [add-project-files 3.3 四入口 converge] 空态重设计（design §4 / PM §C.2.1-2.4）：主 CTA 从素材库
 *   选图（→智能排布，进度+取消）/ 次 打开精修项目（gemdoc 直开 / gemproj 自动转化重放）/ 上传图片；
 *   最近精修项目 ≤4（sys-projects gemdoc updatedAt 降序）；引导行「想先调密度与策略？去排钻工作台送精修」。
 *   四路 converge 同一文档模型（gems/EditDocument），编辑器永不长参数面板（概念混入禁令）。
 * 4. [3.2/3.4 dirty] dirty=未保存口径：●未保存徽标 + beforeunload + 破坏性动作（打开其它/新建图片/关闭文档）
 *   三按钮守卫「保存并继续 / 不保存 / 取消」；切 Tab 不弹（store 单例跨视图存活）。
 * 5. [4.6/§7.4 openIntent + S-4.2] gemdoc 打开意图消费（可见性门）：claim → loadFromGemdoc →
 *   ackSuccess/ackFailure（失败单次 toast 留视图）；dirty 时先过守卫，取消 = ackFailure('guarded-cancelled')。
 *   gemproj 意图仍归 2.x（App 现路由 studio 占位）——本页只提供主动选 gemproj 的转化入口。
 *   [S-4.2] 打开/保存/另存为/导出编排收敛为 documentService 调用（守卫留 UI；payload 真源恒在 store）。
-->

<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import EditCanvas from '../../../components/Edit/EditCanvas.svelte'
  import EditToolbar from '../../../components/Edit/EditToolbar.svelte'
  import EditPropertiesPanel from '../../../components/Edit/EditPropertiesPanel.svelte'
  import EditLayersPanel from '../../../components/Edit/EditLayersPanel.svelte'
  import EditStatusBar from '../../../components/Edit/EditStatusBar.svelte'
  import {
    handleWorkbenchKeydown,
    nudgeStepPx,
    type WorkbenchKeyboardContext,
  } from '../../../components/Edit/editKeyboard'
  import { NudgeSession } from '../../../components/Edit/nudgeSession'
  import { setView, getView } from '$lib/stores/view.svelte'
  import {
    applyPatch,
    beginStroke,
    closeEditDocument,
    endStroke,
    getEditDoc,
    isEditDirty,
    loadFromHandoff,
    redo,
    undo,
  } from '$lib/stores/edit.svelte'
  import { editDocumentService } from '$lib/services/documentService'
  import { quickLayoutFromImage } from '$lib/edit/quickLayout'
  import { replayGemprojAsset } from '$lib/edit/gemprojReplay'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import {
    isAssetProject,
    listChildNodes,
    SYS_PROJECTS_FOLDER_ID,
  } from '$lib/persistence/assetStore'
  import type { AssetProject } from '$lib/persistence/projectTypes'
  import { getHandoffImageBlob } from '$lib/persistence/handoffImage'
  import {
    ackOpenIntentFailure,
    ackOpenIntentSuccess,
    claimOpenIntent,
    peekOpenIntent,
    type OpenIntentClaim,
  } from '$lib/stores/openIntent.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { ComputeAbortedError } from '$lib/workers/computeCore'
  import FileText from '@lucide/svelte/icons/file-text'
  import ImageIcon from '@lucide/svelte/icons/image'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import Upload from '@lucide/svelte/icons/upload'

  const doc = $derived(getEditDoc())
  const dirty = $derived(isEditDirty())

  let layersPanelOpen = $state(false)
  let docMenuOpen = $state(false)
  let uploadInput = $state<HTMLInputElement | null>(null)

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  // ---------------------------------------------------------------------------
  // [C-3.5] 键盘分派接线：nudge 按键会话（500ms 静默合组 undo）+ Esc/⌘Z
  // ---------------------------------------------------------------------------

  const nudgeSession = new NudgeSession({ beginStroke, endStroke, applyPatch })

  function selectedGemsOf(current: NonNullable<ReturnType<typeof getEditDoc>>) {
    const byId = new Map(current.gems.map((g) => [g.id, g] as const))
    const out = []
    for (const id of current.selection) {
      const gem = byId.get(id)
      if (gem) out.push(gem)
    }
    return out
  }

  const keyboardContext: WorkbenchKeyboardContext = {
    hasDocument: () => getEditDoc() !== null,
    selectionCount: () => getEditDoc()?.selection.size ?? 0,
    nudgeStep: (modifiers) => {
      const grid = getEditDoc()?.grid
      return grid !== undefined ? nudgeStepPx(modifiers, grid) : 0
    },
    nudgeSelection: (dx, dy) => {
      const current = getEditDoc()
      if (current === null) return false
      return nudgeSession.nudge(selectedGemsOf(current), dx, dy)
    },
    clearSelection: () => {
      const current = getEditDoc()
      if (current) current.selection.clear()
    },
    undo,
    redo,
  }

  function onKeydown(event: KeyboardEvent): void {
    handleWorkbenchKeydown(event, keyboardContext)
  }

  onDestroy(() => {
    // 视图卸载：在途 nudge 会话立即收组（不留悬空 stroke 组）
    nudgeSession.flush()
  })

  // ---------------------------------------------------------------------------
  // 空态：最近精修项目（sys-projects 下 gemdoc updatedAt 降序 ≤4）
  // ---------------------------------------------------------------------------

  let recentGemdocs = $state<AssetProject[]>([])

  async function refreshRecents(): Promise<void> {
    try {
      const children = await listChildNodes(SYS_PROJECTS_FOLDER_ID)
      recentGemdocs = children
        .filter((n): n is AssetProject => isAssetProject(n) && n.projectKind === 'gemdoc' && n.trashedAt === undefined)
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 4)
    } catch {
      recentGemdocs = []
    }
  }

  $effect(() => {
    void refreshRecents()
  })

  // ---------------------------------------------------------------------------
  // 在途态（智能排布 / gemdoc 打开 / gemproj 重放）：进度文案复用 computeProgress label + 取消
  // ---------------------------------------------------------------------------

  type BusyKind = 'quick-layout' | 'gemdoc-load' | 'gemproj-replay'
  let busy = $state<{ kind: BusyKind; label: string } | null>(null)
  let busyAbort: AbortController | null = null

  function cancelBusy(): void {
    busyAbort?.abort()
  }

  function beginBusy(kind: BusyKind, label: string, controller: AbortController): void {
    busyAbort = controller
    busy = { kind, label }
  }

  function progressLabel(p: { label: string }): void {
    if (busy !== null) busy = { ...busy, label: p.label }
  }

  // ---------------------------------------------------------------------------
  // 入口②：图片 → 智能排布（素材库 / 上传；进度+取消；未保存新文档）
  // ---------------------------------------------------------------------------

  async function startQuickLayout(source: { assetId: string | null; blob: Blob }): Promise<void> {
    if (busy !== null) return
    const controller = new AbortController()
    beginBusy('quick-layout', '正在分块…', controller)
    try {
      const { handoff } = await quickLayoutFromImage(source.blob, {
        signal: controller.signal,
        onProgress: progressLabel,
      })
      loadFromHandoff(handoff, {
        origin: 'quick-layout',
        ...(source.assetId !== null ? { sourceAssetId: source.assetId } : {}),
        name: `精修 · ${handoff.sourceSummary}`,
      })
    } catch (error) {
      if (!(error instanceof ComputeAbortedError)) showToast(`智能排布失败：${errorMessage(error)}`)
    } finally {
      busy = null
      busyAbort = null
    }
  }

  async function pickImageFromLibrary(): Promise<void> {
    if (busy !== null) return
    const selection = await assetPicker.open()
    const picked = selection?.[0]
    if (!picked) return
    const blob = await getHandoffImageBlob(picked.id).catch((error: unknown) => {
      showToast(`图片读取失败：${errorMessage(error)}`)
      return null
    })
    if (blob !== null) runGuarded(() => startQuickLayout({ assetId: picked.id, blob }))
  }

  function uploadImage(files: FileList | null): void {
    const file = files?.[0]
    if (file) runGuarded(() => startQuickLayout({ assetId: null, blob: file }))
  }

  // ---------------------------------------------------------------------------
  // 入口③④：打开项目（gemdoc 直开干净态 / gemproj 自动转化重放烘焙；经守卫）
  // ---------------------------------------------------------------------------

  async function openGemdoc(assetId: string): Promise<boolean> {
    if (busy !== null) return false
    beginBusy('gemdoc-load', '正在打开精修项目…', new AbortController())
    try {
      // [S-4.2] 编排收敛 documentService（守卫已由调用链 runGuarded/意图门裁决 → force 直达）
      const result = await editDocumentService.openFromLibrary(assetId, { force: true })
      if (result.status !== 'opened') {
        throw new Error(
          result.status === 'guard-required' ? '文档未保存，守卫未通过。' : result.message,
        )
      }
      return true
    } catch (error) {
      showToast(`打开精修项目失败：${errorMessage(error)}`)
      return false
    } finally {
      busy = null
      busyAbort = null
    }
  }

  async function openProjectNode(node: AssetProject): Promise<void> {
    if (node.projectKind === 'gemdoc') {
      await openGemdoc(node.id)
      return
    }
    // gemproj：自动格式转化（引擎重放烘焙 → 未保存新文档；provenance.gemprojAssetId 溯源）
    if (busy !== null) return
    const controller = new AbortController()
    beginBusy('gemproj-replay', '正在分块…', controller)
    try {
      const result = await replayGemprojAsset(node.id, { signal: controller.signal, onProgress: progressLabel })
      loadFromHandoff(result.handoff, {
        origin: result.provenance.origin,
        gemprojAssetId: result.provenance.gemprojAssetId,
        name: `精修 · ${result.handoff.sourceSummary}`,
      })
      if (result.droppedOverrides > 0) {
        showToast(`已按当前引擎重放：${result.droppedOverrides} 项块覆写已失效，忽略`)
      }
    } catch (error) {
      if (!(error instanceof ComputeAbortedError)) showToast(`排钻项目转化失败：${errorMessage(error)}`)
    } finally {
      busy = null
      busyAbort = null
    }
  }

  async function pickProjectFromLibrary(): Promise<void> {
    if (busy !== null) return
    const selection = await assetPicker.openForProjects(['gemdoc', 'gemproj'])
    const picked = selection?.[0]
    if (picked) runGuarded(() => openProjectNode(picked))
  }

  function openRecentProject(node: AssetProject): void {
    runGuarded(() => openProjectNode(node))
  }

  // ---------------------------------------------------------------------------
  // [3.4] dirty 守卫：破坏性动作三按钮（保存并继续 / 不保存 / 取消；切 Tab 不弹）
  // ---------------------------------------------------------------------------

  let guardOpen = $state(false)
  let guardBusy = $state(false)
  let guardAction: (() => Promise<void>) | null = null
  /** 守卫期间挂起的 openIntent claim（取消 → ackFailure；完成由动作内 ack）。 */
  let guardClaim: OpenIntentClaim | null = null

  function runGuarded(action: () => Promise<void>): void {
    if (!isEditDirty()) {
      void action()
      return
    }
    guardAction = action
    guardOpen = true
  }

  async function guardSaveAndContinue(): Promise<void> {
    if (guardBusy) return
    guardBusy = true
    try {
      // [S-4.2] 编排收敛 documentService
      const result = await editDocumentService.save()
      if (result.status !== 'saved') throw new Error(result.message)
      showToast('已保存到素材库')
    } catch (error) {
      showToast(`保存失败：${errorMessage(error)}。可改选「不保存」继续。`)
      return
    } finally {
      guardBusy = false
    }
    guardOpen = false
    guardClaim = null
    const action = guardAction
    guardAction = null
    if (action !== null) await action()
    void refreshRecents()
  }

  function guardDiscard(): void {
    guardOpen = false
    guardClaim = null
    const action = guardAction
    guardAction = null
    void action?.()
  }

  function guardCancel(): void {
    const claim = guardClaim
    if (claim !== null) ackOpenIntentFailure(claim.token, 'gemdoc-open-guard-cancelled')
    guardClaim = null
    guardAction = null
    guardOpen = false
  }

  // ---------------------------------------------------------------------------
  // [4.6/§7.4] gemdoc 打开意图消费（可见性门：只在编辑页为当前视图时 claim）
  // ---------------------------------------------------------------------------

  $effect(() => {
    if (getView() !== 'edit') return
    const snapshot = peekOpenIntent()
    if (snapshot === null || snapshot.phase !== 'pending' || snapshot.kind !== 'gemdoc') return
    const claim = claimOpenIntent()
    if (claim === null) return
    const action = async (): Promise<void> => {
      const ok = await openGemdoc(claim.assetId)
      if (ok) ackOpenIntentSuccess(claim.token)
      else ackOpenIntentFailure(claim.token, `gemdoc-open-failed:${claim.assetId}`)
    }
    if (isEditDirty()) {
      guardClaim = claim
      guardAction = action
      guardOpen = true
    } else {
      void action()
    }
  })

  // ---------------------------------------------------------------------------
  // 保存 / 另存为 / 导出 / 关闭（摘要条菜单）
  // ---------------------------------------------------------------------------

  let saveDialogOpen = $state(false)
  let saveDialogMode = $state<'first' | 'fork'>('first')
  let saveName = $state('')
  let saveBusy = $state(false)

  function openSaveDialog(mode: 'first' | 'fork'): void {
    saveDialogMode = mode
    saveName = getEditDoc()?.name ?? ''
    saveDialogOpen = true
  }

  function requestSave(): void {
    if (doc === null || !dirty || saveBusy) return
    if (doc.docId === null) openSaveDialog('first')
    else void performDirectSave()
  }

  async function performDirectSave(): Promise<void> {
    if (saveBusy) return
    saveBusy = true
    try {
      // [S-4.2] 编排收敛 documentService
      const result = await editDocumentService.save()
      if (result.status !== 'saved') throw new Error(result.message)
      showToast('已保存到素材库')
      void refreshRecents()
    } catch (error) {
      showToast(`保存失败：${errorMessage(error)}`)
    } finally {
      saveBusy = false
    }
  }

  async function confirmSaveDialog(): Promise<void> {
    if (saveBusy) return
    saveBusy = true
    try {
      const result =
        saveDialogMode === 'fork'
          ? await editDocumentService.saveAs(saveName)
          : await editDocumentService.save({ name: saveName })
      if (result.status !== 'saved') throw new Error(result.message)
      saveDialogOpen = false
      showToast(saveDialogMode === 'fork' ? '已另存为精修项目' : '已保存到素材库')
      void refreshRecents()
    } catch (error) {
      showToast(`保存失败：${errorMessage(error)}`)
    } finally {
      saveBusy = false
    }
  }

  function downloadBlob(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  /** 导出精修文件：只序列化落磁盘——不清 dirty、不建库节点（[S-4.2] 编排收敛 documentService）。 */
  async function exportGemdocFile(): Promise<void> {
    docMenuOpen = false
    try {
      const result = await editDocumentService.exportGemdoc()
      if (result.status !== 'exported') throw new Error(result.message)
      downloadBlob(result.blob, result.filename)
    } catch (error) {
      showToast(`导出失败：${errorMessage(error)}`)
    }
  }

  function requestCloseDocument(): void {
    docMenuOpen = false
    runGuarded(closeDocument)
  }

  async function closeDocument(): Promise<void> {
    await closeEditDocument()
    void refreshRecents()
  }
</script>

<svelte:window
  onkeydown={onKeydown}
  onbeforeunload={(event) => {
    if (isEditDirty()) {
      event.preventDefault()
      event.returnValue = ''
    }
  }}
/>

{#if doc}
  <div class="flex h-full min-h-0 flex-col gap-3 p-3 lg:p-4" data-testid="edit-workbench">
    <!-- 摘要条（§C.2.4）：左端项目身份 [▦]名●未保存 + 保存/▾ 菜单 + 工具栏；右端钻数/来源/尺寸 + 图层入口 -->
    <header class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" data-testid="edit-summary">
      <span class="flex min-w-0 items-center gap-1.5 font-medium" data-testid="edit-doc-identity">
        <FileText class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
        <span class="max-w-44 truncate" data-testid="edit-doc-name" title={doc.name}>{doc.name}</span>
        {#if dirty}
          <span class="text-destructive" title="未保存" aria-label="未保存">●</span>
        {/if}
      </span>
      {#if dirty}
        <Badge variant="secondary" data-testid="edit-dirty-badge">未保存</Badge>
      {/if}
      <Button
        variant="outline"
        size="xs"
        disabled={!dirty || saveBusy}
        onclick={requestSave}
        data-testid="edit-save-button"
      >
        保存
      </Button>
      <div class="relative">
        <Button
          variant="ghost"
          size="xs"
          onclick={() => (docMenuOpen = !docMenuOpen)}
          data-testid="edit-doc-menu-toggle"
          aria-label="文档菜单"
        >
          ▾
        </Button>
        {#if docMenuOpen}
          <div
            class="absolute left-0 top-full z-30 mt-1 grid w-48 gap-1 rounded-lg border bg-card p-1.5 text-left shadow-lg"
            data-testid="edit-doc-menu"
          >
            <button
              type="button"
              class="hover:bg-muted rounded px-2 py-1.5 text-xs"
              onclick={() => {
                docMenuOpen = false
                openSaveDialog('fork')
              }}
              data-testid="edit-menu-save-as"
            >
              另存为…
            </button>
            <button
              type="button"
              class="hover:bg-muted rounded px-2 py-1.5 text-xs"
              onclick={() => void exportGemdocFile()}
              data-testid="edit-menu-export-gemdoc"
            >
              导出精修文件（.gemdoc）
            </button>
            <button
              type="button"
              class="hover:bg-muted rounded px-2 py-1.5 text-xs"
              onclick={requestCloseDocument}
              data-testid="edit-menu-close"
            >
              关闭文档
            </button>
          </div>
        {/if}
      </div>

      <!-- [C-3.1] 工具栏区：工具三态 + snap + 撤销/重做（⌘Z/⌘⇧Z 见 editKeyboard） -->
      <EditToolbar />

      <span class="font-mono text-base font-semibold tabular-nums" data-testid="edit-gem-count">
        {doc.gems.length.toLocaleString()}
        <span class="text-muted-foreground text-xs font-normal">钻</span>
      </span>
      <span class="text-muted-foreground max-w-56 truncate" data-testid="edit-source-summary" title={doc.sourceSummary}>
        {doc.sourceSummary}
      </span>
      <span class="text-muted-foreground hidden font-mono text-[10px] sm:inline">
        {doc.width}×{doc.height}px
      </span>
      <Button
        variant="ghost"
        size="xs"
        class="ml-auto lg:hidden"
        onclick={() => (layersPanelOpen = !layersPanelOpen)}
        data-testid="edit-layers-toggle"
      >
        图层
      </Button>
    </header>

    <!-- [C-3.1] 四区主体：画布（左）+ 右侧栏（属性面板 / 图层面板，桌面常驻；移动折叠） -->
    <div class="flex min-h-0 flex-1 gap-3">
      <div class="relative min-h-0 min-w-0 flex-1">
        <EditCanvas />

        <!-- 在途覆盖层（打开其它/转化重放时文档仍在，进度+取消盖其上） -->
        {#if busy}
          <div
            class="bg-background/70 absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl backdrop-blur-sm"
            data-testid="edit-busy-overlay"
          >
            <div class="border-primary border-t-primary/30 size-5 animate-spin rounded-full border-2" aria-hidden="true"></div>
            <p class="text-xs font-medium" data-testid="edit-busy-label">{busy.label}</p>
            {#if busy.kind !== 'gemdoc-load'}
              <Button variant="outline" size="sm" onclick={cancelBusy} data-testid="edit-busy-cancel">
                取消
              </Button>
            {/if}
          </div>
        {/if}

        <!-- 图层浮层（移动端：右侧栏折叠，图层入口开浮层——控件同右侧栏组件） -->
        {#if layersPanelOpen}
          <div class="absolute inset-x-3 bottom-3 z-30 mx-auto max-w-sm lg:hidden" data-testid="edit-layers-overlay">
            <EditLayersPanel />
          </div>
        {/if}
      </div>

      <aside
        class="hidden w-60 shrink-0 flex-col gap-3 lg:flex"
        data-testid="edit-right-rail"
        aria-label="属性与图层面板"
      >
        <EditPropertiesPanel />
        <EditLayersPanel />
      </aside>
    </div>

    <!-- [C-3.1/5.7] 状态条：N 钻 / N 选 / 画幅物理读数（EditDocument.physicalCanvas 真值——
         handoff v2/gemdoc 装载后恒有；null 兜底保持「未锚定」占位不显示假值） -->
    <EditStatusBar canvas={doc?.physicalCanvas ?? null} />
  </div>
{:else if busy}
  <!-- 无文档时的在途态（智能排布/转化重放）：进度 + 取消 -->
  <div
    class="bg-gem-dots flex h-full min-h-72 flex-col items-center justify-center gap-3 rounded-xl p-6 text-center"
    data-testid="edit-busy"
  >
    <div class="border-primary border-t-primary/30 size-6 animate-spin rounded-full border-2" aria-hidden="true"></div>
    <p class="text-sm font-medium" data-testid="edit-busy-label">{busy.label}</p>
    <p class="text-muted-foreground text-xs">选图后自动按默认参数排稿，马上就好</p>
    {#if busy.kind !== 'gemdoc-load'}
      <Button variant="outline" size="sm" onclick={cancelBusy} data-testid="edit-busy-cancel">
        取消
      </Button>
    {/if}
  </div>
{:else}
  <!-- 空态重设计（PM 稿 §C.2.4）：主 CTA 选图 / 次打开精修项目 / 上传；最近精修项目；引导行 -->
  <div
    class="bg-gem-dots flex h-full min-h-72 flex-col items-center justify-center gap-5 rounded-xl p-6 text-center"
    data-testid="edit-empty"
  >
    <div class="flex flex-col items-center gap-1.5">
      <h3 class="text-sm font-semibold tracking-tight">从一张图开始钻级精修</h3>
      <p class="text-muted-foreground text-xs">选图后自动智能排布成钻面，再逐钻增删 / 移动 / 换色</p>
    </div>
    <div class="flex flex-wrap items-center justify-center gap-2">
      <Button onclick={() => void pickImageFromLibrary()} data-testid="edit-empty-pick-image">
        <ImageIcon />
        从素材库选图开始
      </Button>
      <Button variant="outline" onclick={() => void pickProjectFromLibrary()} data-testid="edit-empty-open-project">
        <FolderOpen />
        打开精修项目
      </Button>
      <Button variant="outline" onclick={() => uploadInput?.click()} data-testid="edit-empty-upload">
        <Upload />
        上传图片
      </Button>
      <input
        bind:this={uploadInput}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        class="hidden"
        onchange={(e) => {
          uploadImage(e.currentTarget.files)
          e.currentTarget.value = ''
        }}
      />
    </div>
    {#if recentGemdocs.length > 0}
      <div class="flex max-w-lg flex-wrap items-center justify-center gap-1.5" data-testid="edit-empty-recents">
        <span class="text-muted-foreground text-xs">最近：</span>
        {#each recentGemdocs as node (node.id)}
          <button
            type="button"
            class="hover:bg-muted inline-flex h-7 max-w-40 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors"
            title={`打开精修项目「${node.name}」`}
            onclick={() => openRecentProject(node)}
            data-testid="edit-empty-recent"
            data-project-id={node.id}
          >
            <FileText class="text-primary/70 size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate">{node.name}</span>
          </button>
        {/each}
      </div>
    {/if}
    <p class="text-muted-foreground text-xs" data-testid="edit-empty-guide">
      想先调密度与策略？
      <button
        type="button"
        class="text-primary hover:underline"
        onclick={() => setView('studio')}
        data-testid="edit-empty-goto-studio"
      >
        去排钻工作台送精修
      </button>
    </p>
  </div>
{/if}

<!-- dirty 守卫（三按钮：保存并继续 / 不保存 / 取消） -->
<Dialog.Root bind:open={guardOpen}>
  <Dialog.Content class="max-w-sm" data-testid="edit-guard-dialog">
    <Dialog.Header>
      <Dialog.Title>当前精修文档未保存</Dialog.Title>
      <Dialog.Description>
        继续将离开当前文档。未保存的修改（含撤销历史）会随下一步动作丢弃，先保存到素材库更稳妥。
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={guardCancel} data-testid="edit-guard-cancel">
        取消
      </Button>
      <Button variant="outline" size="sm" onclick={guardDiscard} data-testid="edit-guard-discard">
        不保存
      </Button>
      <Button size="sm" disabled={guardBusy} onclick={() => void guardSaveAndContinue()} data-testid="edit-guard-save">
        {guardBusy ? '保存中…' : '保存并继续'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 首次保存 / 另存为：命名弹窗（预填当前名） -->
<Dialog.Root bind:open={saveDialogOpen}>
  <Dialog.Content class="max-w-sm" data-testid="edit-save-dialog">
    <Dialog.Header>
      <Dialog.Title>{saveDialogMode === 'fork' ? '另存为精修项目' : '保存精修项目'}</Dialog.Title>
      <Dialog.Description>
        {saveDialogMode === 'fork'
          ? '以新名称存为素材库中的新精修项目（原项目保持不变）。'
          : '保存到素材库「项目」，之后可从「打开精修项目」续作。'}
      </Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-1.5">
      <label class="text-xs font-medium" for="edit-save-name-input">名称</label>
      <Input id="edit-save-name-input" bind:value={saveName} data-testid="edit-save-name" placeholder="精修 · …" />
    </div>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (saveDialogOpen = false)} data-testid="edit-save-cancel">
        取消
      </Button>
      <Button size="sm" disabled={saveBusy || saveName.trim() === ''} onclick={() => void confirmSaveDialog()} data-testid="edit-save-confirm">
        {saveBusy ? '保存中…' : '保存'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
