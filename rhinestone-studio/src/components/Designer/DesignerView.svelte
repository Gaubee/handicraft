<!--
 * DesignerView.svelte——设计师工作台宿主（design §1.1 类 PS 四区布局 + 顶/底栏）。
 *
 * Orthogonal intents (max 5):
 * 1. [2026-09-21 redesign-designer-workbench 2.x] 四区骨架装配：顶部文档栏（身份/未保存●/
 *    保存另存菜单/「智能排布…」命令位——2.x 禁用态=无参考底图，弹窗归 5.x）+ 竖排工具栏
 *    （DesignerToolbar）+ 画布（居中）+ 右面板列（上属性/下图层，可折叠）+ 底部状态栏。
 *    移动端降级（底部工具条+抽屉）归本切片末步装配。
 * 2. [2.x 键位接线] 键盘分派（keymap）：工具切换单键 V/B/E/H/Z + Esc 清空 / 方向键三档
 *    nudge（NudgeSession 按键会话合组 undo）/ ⌘Z·⌘⇧Z（design §3 全表命令总线归 6.x）。
 *    [3.x P5] Esc 先裁进行中手势取消（拖移/旋转/改径——不产 undo 组，选择保持）。
 * 3. [空态迁移（语义沿 EditView；三入口重设计归 5.x）] 主 CTA 从素材库选图（→智能排布，
 *    进度+取消）/ 次 打开精修项目（gemdoc 直开 / gemproj 自动转化重放）/ 上传图片；
 *    最近精修项目 ≤4（sys-projects gemdoc updatedAt 降序）；引导行「想先调密度与策略？
 *    去排钻工作台送精修」。四路 converge 同一文档模型，编辑器永不长参数面板。
 * 4. [4.6/§7.4 迁移] dirty=未保存口径：●未保存徽标 + beforeunload + 破坏性动作三按钮守卫
 *    「保存并继续 / 不保存 / 取消」；切 Tab 不弹（store 单例跨视图存活）。
 * 5. [S-4.2 迁移] gemdoc 打开意图消费（可见性门：claim → loadFromGemdoc → ack；失败单次
 *    toast 留视图）；打开/保存/另存为/导出编排收敛 documentService（守卫留 UI）。
 *    [4.3] 产物导出（SVG/BOM/PNG）隐藏层显式确认门在视图（「不含 N 个隐藏层」；取消 =
 *    零产物）；裁剪恒在 service 投影面（projectVisibleGems），UI 确认不是过滤的组成。
-->

<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import DesignerToolbar from './DesignerToolbar.svelte'
  import DesignerCanvas from './DesignerCanvas.svelte'
  import DesignerPropertiesPanel from './DesignerPropertiesPanel.svelte'
  import DesignerLayersPanel from './DesignerLayersPanel.svelte'
  import DesignerDocBar from './DesignerDocBar.svelte'
  import DesignerStatusBar from './DesignerStatusBar.svelte'
  import ConfirmDialog from '../ConfirmDialog.svelte'
  import {
    handleToolKeydown,
    handleWorkbenchKeydown,
    nudgeStepPx,
    type WorkbenchKeyboardContext,
  } from '$lib/designer/keymap'
  import { NudgeSession } from '$lib/designer/nudgeSession'
  import { cancelActiveInteraction, getPropertiesFocus } from '$lib/designer/interaction.svelte'
  import {
    getSnap,
    getTool,
    setSnap,
    setTool,
    type DesignerTool,
  } from '$lib/designer/workbench.svelte'
  import { setView, getView } from '$lib/stores/view.svelte'
  import {
    applyPatch,
    beginStroke,
    canRedo,
    canUndo,
    closeEditDocument,
    endStroke,
    getEditDoc,
    isEditDirty,
    loadFromHandoff,
    redo,
    undo,
  } from '$lib/stores/edit.svelte'
  import { countHiddenGems, editDocumentService } from '$lib/services/documentService'
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
  import ImageIcon from '@lucide/svelte/icons/image'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import Upload from '@lucide/svelte/icons/upload'
  import FileText from '@lucide/svelte/icons/file-text'
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import Eraser from '@lucide/svelte/icons/eraser'
  import Undo2 from '@lucide/svelte/icons/undo-2'
  import Redo2 from '@lucide/svelte/icons/redo-2'

  const doc = $derived(getEditDoc())
  const dirty = $derived(isEditDirty())
  const tool = $derived(getTool())
  const snap = $derived(getSnap())
  const undoable = $derived(canUndo())
  const redoable = $derived(canRedo())

  /** 移动端底部工具条工具集（design §1.4：抓手/缩放不占位——触摸直接双指手势）。 */
  const MOBILE_TOOLS: ReadonlyArray<{ id: DesignerTool; key: string; label: string; icon: typeof MousePointer2 }> = [
    { id: 'select', key: 'V', label: '选择', icon: MousePointer2 },
    { id: 'draw', key: 'B', label: '画笔', icon: PenLine },
    { id: 'erase', key: 'E', label: '橡皮', icon: Eraser },
  ]

  // ---------------------------------------------------------------------------
  // 移动端降级（design §1.4）：底部滑出抽屉（属性/图层分段控件）——右面板列的 <lg 承载
  // ---------------------------------------------------------------------------

  let drawerOpen = $state(false)
  let drawerTab = $state<'properties' | 'layers'>('layers')

  function openDrawer(): void {
    drawerOpen = true
  }

  let uploadInput = $state<HTMLInputElement | null>(null)

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  // ---------------------------------------------------------------------------
  // 键盘分派接线：工具单键 V/B/E/H/Z + nudge 按键会话（500ms 静默合组 undo）+ Esc/⌘Z
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
    setTool,
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
    // [P5 3.x] 进行中手势（拖移/旋转/改径）Esc 优先取消（不产生 undo 组、选择保持），
    // 无进行中手势才落入 Esc 清空选择语义（design §2 通用约束）
    if (event.key === 'Escape' && cancelActiveInteraction()) {
      event.preventDefault()
      return
    }
    if (handleToolKeydown(event, keyboardContext)) return
    handleWorkbenchKeydown(event, keyboardContext)
  }

  onDestroy(() => {
    // 视图卸载：在途 nudge 会话立即收组（不留悬空 stroke 组）
    nudgeSession.flush()
    if (propertiesFocusTimer !== null) clearTimeout(propertiesFocusTimer)
  })

  // ---------------------------------------------------------------------------
  // [P8 3.x] 属性面板定位：画布双击钻 → 选该钻 + 焦点信号 → 滚动到字段并高亮 1.2s
  // （design §2 P8 裁断：非模态——属性面板常驻右侧，双击 = 快速到达）。DOM 查询走
  // designer-properties-fields testid（面板组件不动——并行边界），jsdom scrollIntoView
  // 缺席守卫。
  // ---------------------------------------------------------------------------

  let propertiesFocusTimer: ReturnType<typeof setTimeout> | null = null

  $effect(() => {
    const focus = getPropertiesFocus()
    if (focus === null) return
    const fields = document.querySelector('[data-testid="designer-properties-fields"]')
    if (fields === null) return
    fields.setAttribute('data-focus-gem', focus.gemId)
    const firstRow = fields.firstElementChild
    if (firstRow !== null && typeof firstRow.scrollIntoView === 'function') {
      firstRow.scrollIntoView({ block: 'nearest' })
    }
    if (propertiesFocusTimer !== null) clearTimeout(propertiesFocusTimer)
    propertiesFocusTimer = setTimeout(() => {
      fields.removeAttribute('data-focus-gem')
      propertiesFocusTimer = null
    }, 1200)
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
  // [5.x 空态重设计预告] 选图新建将改为「参考底图 + 0 颗钻」（绝不自动排稿）——本骨架期
  // 沿用现状选图即排（入口重设计归 5.x 切片）。
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
  // [3.4 迁移] dirty 守卫：破坏性动作三按钮（保存并继续 / 不保存 / 取消；切 Tab 不弹）
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
  // [4.6/§7.4 迁移] gemdoc 打开意图消费（可见性门：只在设计页为当前视图时 claim）
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
  // 保存 / 另存为 / 导出 / 关闭（文档栏菜单）
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
    try {
      const result = await editDocumentService.exportGemdoc()
      if (result.status !== 'exported') throw new Error(result.message)
      downloadBlob(result.blob, result.filename)
    } catch (error) {
      showToast(`导出失败：${errorMessage(error)}`)
    }
  }

  // ---------------------------------------------------------------------------
  // [4.3] 产物导出（SVG/BOM/PNG）：隐藏层显式确认门（design §4.4「不含 N 个隐藏层」）
  // ——确认在 UI、裁剪在 service（projectVisibleGems 恒投影，直接调 API 不可绕过）；
  // 取消 = 零产物（不触 service、无 blob、无下载）。
  // ---------------------------------------------------------------------------

  type ExportArtifactKind = 'svg' | 'bom' | 'png'
  const EXPORT_KIND_LABELS: Record<ExportArtifactKind, string> = {
    svg: 'SVG 图',
    bom: 'BOM 清单',
    png: 'PNG 图',
  }
  let exportConfirmState = $state<{ kind: ExportArtifactKind; hiddenLayers: number; hiddenGems: number } | null>(null)
  const exportConfirmDescription = $derived.by(() => {
    const pending = exportConfirmState
    if (pending === null) return ''
    return `导出将不含 ${pending.hiddenLayers} 个隐藏层（${pending.hiddenGems} 颗钻）——隐藏层内容不进产物。仍要导出？`
  })

  function requestArtifactExport(kind: ExportArtifactKind): void {
    const d = getEditDoc()
    if (d === null) return
    const hiddenGems = countHiddenGems(d)
    if (hiddenGems === 0) {
      void performArtifactExport(kind)
      return
    }
    exportConfirmState = { kind, hiddenLayers: d.layers.filter((l) => !l.visible).length, hiddenGems }
  }

  async function performArtifactExport(kind: ExportArtifactKind): Promise<void> {
    const result =
      kind === 'svg'
        ? await editDocumentService.exportSvg()
        : kind === 'bom'
          ? await editDocumentService.exportBom()
          : await editDocumentService.exportPng()
    if (result.status === 'exported') {
      downloadBlob(result.blob, result.filename)
      return
    }
    if (result.status === 'blocked') showToast(result.message)
    else showToast(`导出失败：${result.message}`)
  }

  function confirmArtifactExport(): void {
    const pending = exportConfirmState
    exportConfirmState = null
    if (pending !== null) void performArtifactExport(pending.kind)
  }

  function requestCloseDocument(): void {
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
  <div class="flex h-full min-h-0 flex-col gap-2 p-2 lg:gap-3 lg:p-3" data-testid="designer-workbench">
    <!-- 顶部文档栏（design §1.1：身份 + 未保存● + 智能排布… + 撤销/重做 + 保存/▾ 菜单） -->
    <DesignerDocBar
      onsave={requestSave}
      onsaveas={() => openSaveDialog('fork')}
      onexport={() => void exportGemdocFile()}
      onexportartifact={requestArtifactExport}
      onclose={requestCloseDocument}
      onlayers={openDrawer}
    />

    <!-- 四区主体：竖排工具栏（左）+ 画布（中）+ 右面板列（上属性/下图层） -->
    <div class="flex min-h-0 flex-1 gap-2 lg:gap-3">
      <div class="hidden lg:flex">
        <DesignerToolbar />
      </div>
      <div class="relative min-h-0 min-w-0 flex-1">
        <DesignerCanvas />

        <!-- 在途覆盖层（打开其它/转化重放时文档仍在，进度+取消盖其上） -->
        {#if busy}
          <div
            class="bg-background/70 absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 rounded-xl backdrop-blur-sm"
            data-testid="designer-busy-overlay"
          >
            <div class="border-primary border-t-primary/30 size-5 animate-spin rounded-full border-2" aria-hidden="true"></div>
            <p class="text-xs font-medium" data-testid="designer-busy-label">{busy.label}</p>
            {#if busy.kind !== 'gemdoc-load'}
              <Button variant="outline" size="sm" onclick={cancelBusy} data-testid="designer-busy-cancel">
                取消
              </Button>
            {/if}
          </div>
        {/if}

        <!-- 移动端降级（design §1.4）：底部滑出抽屉——「属性 / 图层」分段控件（右面板列折叠承载） -->
        {#if drawerOpen}
          <div
            class="absolute inset-x-0 bottom-0 z-30 flex max-h-[60vh] flex-col rounded-t-2xl border-t bg-card shadow-xl lg:hidden"
            data-testid="designer-drawer"
            role="dialog"
            aria-label="面板抽屉"
          >
            <div class="flex items-center justify-between border-b px-3 py-2">
              <div class="flex items-center gap-1" role="tablist" aria-label="面板切换">
                <Button
                  size="xs"
                  variant={drawerTab === 'properties' ? 'secondary' : 'ghost'}
                  class="h-6 px-2 text-[11px]"
                  aria-selected={drawerTab === 'properties'}
                  role="tab"
                  onclick={() => (drawerTab = 'properties')}
                  data-testid="designer-drawer-tab-properties"
                >
                  属性
                </Button>
                <Button
                  size="xs"
                  variant={drawerTab === 'layers' ? 'secondary' : 'ghost'}
                  class="h-6 px-2 text-[11px]"
                  aria-selected={drawerTab === 'layers'}
                  role="tab"
                  onclick={() => (drawerTab = 'layers')}
                  data-testid="designer-drawer-tab-layers"
                >
                  图层
                </Button>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onclick={() => (drawerOpen = false)}
                data-testid="designer-drawer-close"
                aria-label="收起面板"
              >
                ✕
              </Button>
            </div>
            <div class="min-h-0 flex-1 overflow-y-auto p-2">
              {#if drawerTab === 'properties'}
                <DesignerPropertiesPanel />
              {:else}
                <DesignerLayersPanel />
              {/if}
            </div>
          </div>
        {/if}
      </div>

      <aside
        class="hidden w-60 shrink-0 flex-col gap-2 lg:flex lg:gap-3"
        data-testid="designer-right-rail"
        aria-label="属性与图层面板"
      >
        <DesignerPropertiesPanel />
        <DesignerLayersPanel />
      </aside>
    </div>

    <!-- 移动端降级（design §1.4）：底部工具条（横滚 icon 条：选择/画笔/橡皮 + 撤销/重做 + 吸附开关；
         抓手/缩放不占位——触摸直接双指手势；lg 以上由竖排工具栏接管） -->
    <div
      class="flex items-center gap-1 overflow-x-auto rounded-xl border bg-card p-1 lg:hidden"
      data-testid="designer-mobile-toolbar"
      role="toolbar"
      aria-label="设计工具（移动端）"
    >
      {#each MOBILE_TOOLS as t (t.id)}
        <Button
          size="icon-sm"
          variant={tool === t.id ? 'secondary' : 'ghost'}
          aria-pressed={tool === t.id}
          title={`${t.label}（${t.key}）`}
          onclick={() => setTool(t.id)}
          data-testid={`designer-mobile-tool-${t.id}`}
        >
          <t.icon class="size-4" aria-hidden="true" />
          <span class="sr-only">{t.label}</span>
        </Button>
      {/each}
      <span class="bg-border mx-0.5 h-4 w-px shrink-0" aria-hidden="true"></span>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={!undoable}
        title="撤销（⌘Z / Ctrl+Z）"
        onclick={() => undo()}
        data-testid="designer-mobile-undo"
      >
        <Undo2 class="size-4" aria-hidden="true" />
        <span class="sr-only">撤销</span>
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={!redoable}
        title="重做（⌘⇧Z / Ctrl+Shift+Z）"
        onclick={() => redo()}
        data-testid="designer-mobile-redo"
      >
        <Redo2 class="size-4" aria-hidden="true" />
        <span class="sr-only">重做</span>
      </Button>
      <span class="bg-border mx-0.5 h-4 w-px shrink-0" aria-hidden="true"></span>
      <Button
        size="xs"
        variant={snap === 'grid' ? 'secondary' : 'ghost'}
        class="h-8 shrink-0 px-2 text-[11px]"
        aria-pressed={snap === 'grid'}
        title={snap === 'grid' ? '吸附：六方格位（点击切自由）' : '吸附：自由落点（点击切格位）'}
        onclick={() => setSnap(snap === 'grid' ? 'free' : 'grid')}
        data-testid="designer-mobile-snap"
      >
        {snap === 'grid' ? '格位' : '自由'}
      </Button>
    </div>

    <!-- 底部状态栏（design §1.2：画幅 popover/缩放比/钻数含隐藏/规格码/间距徽标） -->
    <DesignerStatusBar />
  </div>
{:else if busy}
  <!-- 无文档时的在途态（智能排布/转化重放）：进度 + 取消 -->
  <div
    class="bg-gem-dots flex h-full min-h-72 flex-col items-center justify-center gap-3 rounded-xl p-6 text-center"
    data-testid="designer-busy"
  >
    <div class="border-primary border-t-primary/30 size-6 animate-spin rounded-full border-2" aria-hidden="true"></div>
    <p class="text-sm font-medium" data-testid="designer-busy-label">{busy.label}</p>
    <p class="text-muted-foreground text-xs">选图后自动按默认参数排稿，马上就好</p>
    {#if busy.kind !== 'gemdoc-load'}
      <Button variant="outline" size="sm" onclick={cancelBusy} data-testid="designer-busy-cancel">
        取消
      </Button>
    {/if}
  </div>
{:else}
  <!-- 空态（语义沿旧视图；三入口重设计归 5.x）：主 CTA 选图 / 次打开精修项目 / 上传；最近；引导行 -->
  <div
    class="bg-gem-dots flex h-full min-h-72 flex-col items-center justify-center gap-5 rounded-xl p-6 text-center"
    data-testid="designer-empty"
  >
    <div class="flex flex-col items-center gap-1.5">
      <h3 class="text-sm font-semibold tracking-tight">从一张图开始钻级精修</h3>
      <p class="text-muted-foreground text-xs">选图后自动智能排布成钻面，再逐钻增删 / 移动 / 换色</p>
    </div>
    <div class="flex flex-wrap items-center justify-center gap-2">
      <Button onclick={() => void pickImageFromLibrary()} data-testid="designer-empty-pick-image">
        <ImageIcon />
        从素材库选图开始
      </Button>
      <Button variant="outline" onclick={() => void pickProjectFromLibrary()} data-testid="designer-empty-open-project">
        <FolderOpen />
        打开精修项目
      </Button>
      <Button variant="outline" onclick={() => uploadInput?.click()} data-testid="designer-empty-upload">
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
      <div class="flex max-w-lg flex-wrap items-center justify-center gap-1.5" data-testid="designer-empty-recents">
        <span class="text-muted-foreground text-xs">最近：</span>
        {#each recentGemdocs as node (node.id)}
          <button
            type="button"
            class="hover:bg-muted inline-flex h-7 max-w-40 items-center gap-1 rounded-full border px-2.5 text-xs font-medium transition-colors"
            title={`打开精修项目「${node.name}」`}
            onclick={() => openRecentProject(node)}
            data-testid="designer-empty-recent"
            data-project-id={node.id}
          >
            <FileText class="text-primary/70 size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate">{node.name}</span>
          </button>
        {/each}
      </div>
    {/if}
    <p class="text-muted-foreground text-xs" data-testid="designer-empty-guide">
      想先调密度与策略？
      <button
        type="button"
        class="text-primary hover:underline"
        onclick={() => setView('studio')}
        data-testid="designer-empty-goto-studio"
      >
        去排钻工作台送精修
      </button>
    </p>
  </div>
{/if}

<!-- dirty 守卫（三按钮：保存并继续 / 不保存 / 取消） -->
<Dialog.Root bind:open={guardOpen}>
  <Dialog.Content class="max-w-sm" data-testid="designer-guard-dialog">
    <Dialog.Header>
      <Dialog.Title>当前精修文档未保存</Dialog.Title>
      <Dialog.Description>
        继续将离开当前文档。未保存的修改（含撤销历史）会随下一步动作丢弃，先保存到素材库更稳妥。
      </Dialog.Description>
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={guardCancel} data-testid="designer-guard-cancel">
        取消
      </Button>
      <Button variant="outline" size="sm" onclick={guardDiscard} data-testid="designer-guard-discard">
        不保存
      </Button>
      <Button size="sm" disabled={guardBusy} onclick={() => void guardSaveAndContinue()} data-testid="designer-guard-save">
        {guardBusy ? '保存中…' : '保存并继续'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- 首次保存 / 另存为：命名弹窗（预填当前名） -->
<Dialog.Root bind:open={saveDialogOpen}>
  <Dialog.Content class="max-w-sm" data-testid="designer-save-dialog">
    <Dialog.Header>
      <Dialog.Title>{saveDialogMode === 'fork' ? '另存为精修项目' : '保存精修项目'}</Dialog.Title>
      <Dialog.Description>
        {saveDialogMode === 'fork'
          ? '以新名称存为素材库中的新精修项目（原项目保持不变）。'
          : '保存到素材库「项目」，之后可从「打开精修项目」续作。'}
      </Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-1.5">
      <label class="text-xs font-medium" for="designer-save-name-input">名称</label>
      <Input id="designer-save-name-input" bind:value={saveName} data-testid="designer-save-name" placeholder="精修 · …" />
    </div>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (saveDialogOpen = false)} data-testid="designer-save-cancel">
        取消
      </Button>
      <Button size="sm" disabled={saveBusy || saveName.trim() === ''} onclick={() => void confirmSaveDialog()} data-testid="designer-save-confirm">
        {saveBusy ? '保存中…' : '保存'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>

<!-- [4.3] 产物导出隐藏层确认（design §4.4 显式裁剪：取消 = 零产物；service 恒投影不可绕过） -->
<ConfirmDialog
  open={exportConfirmState !== null}
  destructive={false}
  title={exportConfirmState !== null ? `导出${EXPORT_KIND_LABELS[exportConfirmState.kind]}？` : ''}
  description={exportConfirmDescription}
  confirmLabel="仍要导出"
  onconfirm={confirmArtifactExport}
  oncancel={() => (exportConfirmState = null)}
  confirmTestId="designer-export-confirm"
  cancelTestId="designer-export-confirm-cancel"
/>
