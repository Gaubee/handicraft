<!--
 * DesignerDocBar.svelte——顶部文档栏（design §1.2：模块标识 + 文档名 + 未保存徽标｜
 * 智能排布…｜撤销/重做（与 ⌘Z 同源）｜保存/另存菜单）。
 *
 * Orthogonal intents (max 2):
 * 1. [2026-09-21 redesign-designer-workbench 2.x → 7.2] 文档身份区（[▦] 名 ●未保存）+
 *    智能排布命令位（design §5.3：无参考底图禁用 + tooltip「需要参考底图」——工具输入=
 *    底图；[7.2] 经命令总线 open-smart-layout 打开参数小窗，右键空态「智能排布…」同源）+
 *    [6.3/§3.7] 键位速查「⌨」按钮（「?」键同源 toggle）+ [3.2] 当前规格选择器
 *    （design §6.2 顶部文档栏位——DesignerSpecSelector 自持态与命令接线）+ 撤销/重做按钮
 *    （按钮与 ⌘Z/⌘⇧Z 同命令面——键盘分派在 DesignerView keymap 接线）。
 * 2. 保存/▾ 菜单（另存为… / 导出精修文件 / [4.3] 导出 SVG·BOM·PNG 产物三入口——隐藏层
 *    确认门在视图装配（design §4.4 显式裁剪）/ 关闭文档——守卫三分法归视图装配；本组件只发
 *    回调）+ 移动端图层入口（过渡：抽屉归移动端切片）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { canRedo, canUndo, getEditDoc, isEditDirty, redo, undo } from '$lib/stores/edit.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { execDesignerCommand } from '$lib/designer/commands'
  import { smartLayoutUnderlayReady } from '$lib/designer/smartLayout.svelte'
  import { toggleShortcutsHelp } from '$lib/designer/viewState.svelte'
  import DesignerSpecSelector from './DesignerSpecSelector.svelte'
  import FileText from '@lucide/svelte/icons/file-text'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import Undo2 from '@lucide/svelte/icons/undo-2'
  import Redo2 from '@lucide/svelte/icons/redo-2'
  import Keyboard from '@lucide/svelte/icons/keyboard'

  let {
    onsave,
    onsaveas,
    onexport,
    onexportartifact,
    onclose,
    onlayers,
  }: {
    /** 保存（直存已有 docId；首次保存弹命名由视图装配）。 */
    onsave: () => void
    onsaveas: () => void
    onexport: () => void
    /** [4.3] 产物导出（SVG/BOM/PNG）——隐藏层确认门在视图装配（design §4.4 显式裁剪）。 */
    onexportartifact: (kind: 'svg' | 'bom' | 'png') => void
    /** 关闭文档（经视图 dirty 守卫三分法）。 */
    onclose: () => void
    /** 移动端图层面板入口（过渡 callback）。 */
    onlayers: () => void
  } = $props()

  const doc = $derived(getEditDoc())
  const dirty = $derived(isEditDirty())
  const undoable = $derived(canUndo())
  const redoable = $derived(canRedo())

  let docMenuOpen = $state(false)

  /** [7.2] 智能排布可用性：无参考底图禁用 + tooltip「需要参考底图」（design §5.3——
   *  smartLayoutUnderlayReady 单源判据 = underlay.sources 含 painting/reference 源；
   *  修正 2.x 骨架期 paintingSnapshot.width>0 恒真误判——空白起步 1×1 内存占位不构成底图）。 */
  const smartLayoutReady = $derived(smartLayoutUnderlayReady(doc))

  function requestSmartLayout(): void {
    // [7.2] 经命令总线 open-smart-layout（右键空态「智能排布…」同入口；参数小窗随本切片装配）
    if (!execDesignerCommand({ kind: 'open-smart-layout' })) {
      showToast('需要参考底图后才能智能排布')
    }
  }
</script>

<header class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs" data-testid="designer-doc-bar">
  <span class="flex min-w-0 items-center gap-1.5 font-medium" data-testid="designer-doc-identity">
    <FileText class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
    <span class="max-w-44 truncate" data-testid="designer-doc-name" title={doc?.name}>{doc?.name}</span>
    {#if dirty}
      <span class="text-destructive" title="未保存" aria-label="未保存">●</span>
    {/if}
  </span>
  {#if dirty}
    <Badge variant="secondary" data-testid="designer-dirty-badge">未保存</Badge>
  {/if}

  <Button
    variant="outline"
    size="xs"
    disabled={!smartLayoutReady}
    title={smartLayoutReady ? '按参考底图智能排布（参数小窗）' : '需要参考底图'}
    onclick={requestSmartLayout}
    data-testid="designer-smart-layout"
  >
    <Sparkles class="size-3.5" aria-hidden="true" />
    智能排布…
  </Button>

  <!-- [3.2] 当前规格选择器（design §6.2 顶部文档栏位：形×档×色——写 brushSpec 真源经命令总线） -->
  <DesignerSpecSelector />

  <div class="flex items-center gap-0.5" role="group" aria-label="历史">
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={!undoable}
      title="撤销（⌘Z / Ctrl+Z）"
      onclick={() => undo()}
      data-testid="designer-undo"
    >
      <Undo2 class="size-3.5" aria-hidden="true" />
      <span class="sr-only">撤销</span>
    </Button>
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={!redoable}
      title="重做（⌘⇧Z / Ctrl+Shift+Z）"
      onclick={() => redo()}
      data-testid="designer-redo"
    >
      <Redo2 class="size-3.5" aria-hidden="true" />
      <span class="sr-only">重做</span>
    </Button>
    <!-- [6.3/§3.7] 键位速查顶栏按钮入口（「?」键同源——viewState 单真源 toggle） -->
    <Button
      variant="ghost"
      size="icon-xs"
      title="键位速查（?）"
      onclick={toggleShortcutsHelp}
      data-testid="designer-shortcuts-help-button"
    >
      <Keyboard class="size-3.5" aria-hidden="true" />
      <span class="sr-only">键位速查</span>
    </Button>
  </div>

  <Button
    variant="outline"
    size="xs"
    disabled={!dirty}
    onclick={onsave}
    data-testid="designer-save-button"
  >
    保存
  </Button>
  <div class="relative">
    <Button
      variant="ghost"
      size="xs"
      onclick={() => (docMenuOpen = !docMenuOpen)}
      data-testid="designer-doc-menu-toggle"
      aria-label="文档菜单"
    >
      ▾
    </Button>
    {#if docMenuOpen}
      <div
        class="absolute left-0 top-full z-30 mt-1 grid w-48 gap-1 rounded-lg border bg-card p-1.5 text-left shadow-lg"
        data-testid="designer-doc-menu"
      >
        <button
          type="button"
          class="hover:bg-muted rounded px-2 py-1.5 text-xs"
          onclick={() => {
            docMenuOpen = false
            onsaveas()
          }}
          data-testid="designer-menu-save-as"
        >
          另存为…
        </button>
        <button
          type="button"
          class="hover:bg-muted rounded px-2 py-1.5 text-xs"
          onclick={() => {
            docMenuOpen = false
            onexport()
          }}
          data-testid="designer-menu-export-gemdoc"
        >
          导出精修文件（.gemdoc）
        </button>
        <!-- [4.3] 产物导出三入口：隐藏层确认门在视图（service 恒投影——API 不可绕过） -->
        <button
          type="button"
          class="hover:bg-muted rounded px-2 py-1.5 text-xs"
          onclick={() => {
            docMenuOpen = false
            onexportartifact('svg')
          }}
          data-testid="designer-menu-export-svg"
        >
          导出 SVG 图
        </button>
        <button
          type="button"
          class="hover:bg-muted rounded px-2 py-1.5 text-xs"
          onclick={() => {
            docMenuOpen = false
            onexportartifact('bom')
          }}
          data-testid="designer-menu-export-bom"
        >
          导出 BOM 清单（CSV）
        </button>
        <button
          type="button"
          class="hover:bg-muted rounded px-2 py-1.5 text-xs"
          onclick={() => {
            docMenuOpen = false
            onexportartifact('png')
          }}
          data-testid="designer-menu-export-png"
        >
          导出 PNG 图
        </button>
        <button
          type="button"
          class="hover:bg-muted rounded px-2 py-1.5 text-xs"
          onclick={() => {
            docMenuOpen = false
            onclose()
          }}
          data-testid="designer-menu-close"
        >
          关闭文档
        </button>
      </div>
    {/if}
  </div>

  <Button
    variant="ghost"
    size="xs"
    class="ml-auto lg:hidden"
    onclick={onlayers}
    data-testid="designer-drawer-toggle"
  >
    面板
  </Button>
</header>
