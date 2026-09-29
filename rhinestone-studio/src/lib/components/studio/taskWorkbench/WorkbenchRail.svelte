<!--
WorkbenchRail.svelte——PS 式竖工具条（rework-workbench-rail-drawers 1.3，design §1/§3）。
两实例（side='left'|'right'）常驻不收起（工具条=轨道不是面板）：
- 左=画布工具组（选择/平移/缩放/笔刷+缩放档位——自 WorkbenchCanvasStage 外提，
  图标/命令调用/testid 同源：点击仍走 commands.ts 命令总线）+分隔线+「图层」toggle
  （开=active 高亮——开合左 Drawer）。
- 右=「属性」（开合 Inspector Drawer）、「历史」（开合历史 Drawer——右侧同侧互斥）、
  「快捷键帮助」（help.toggle 命令——与 ? 键/⋯ 菜单同一总线入口）。
按钮 36×36（w-9 h-9）icon+title tooltip+active 态；容器 w-11 竖排 gap-1 py-2、
bg-background/60 backdrop-blur-sm、z-30（恒高于 Drawer——rail 恒可点）。
工具状态真源在 store/canvasStage（按钮=命令总线触发器——rail 零自有状态）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { execWorkbenchCommand } from './commands.js'
  import { enterBrushMode, exitBrushMode, getBrushSession, getSelectedNodeId } from './store.svelte'
  import { getCanvasView, getWorkbenchTool, zoomCanvasTo } from './canvasStage.svelte.js'
  import Hand from '@lucide/svelte/icons/hand'
  import History from '@lucide/svelte/icons/history'
  import Keyboard from '@lucide/svelte/icons/keyboard'
  import Layers from '@lucide/svelte/icons/layers'
  import Maximize from '@lucide/svelte/icons/maximize'
  import Minus from '@lucide/svelte/icons/minus'
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2'
  import Paintbrush from '@lucide/svelte/icons/paintbrush'
  import Plus from '@lucide/svelte/icons/plus'
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal'
  import ZoomIn from '@lucide/svelte/icons/zoom-in'

  let {
    side,
    layersOpen = false,
    inspectorOpen = false,
    historyOpen = false,
    onToggleLayers,
    onToggleInspector,
    onToggleHistory,
  }: {
    side: 'left' | 'right'
    /** 左 Drawer（图层）生效开合——active 态。 */
    layersOpen?: boolean
    /** 右 Drawer（属性）生效开合——active 态。 */
    inspectorOpen?: boolean
    /** 右 Drawer（历史）生效开合——active 态。 */
    historyOpen?: boolean
    onToggleLayers?: () => void
    onToggleInspector?: () => void
    onToggleHistory?: () => void
  } = $props()

  const tool = $derived(getWorkbenchTool())
  const brush = $derived(getBrushSession())
  const selectedId = $derived(getSelectedNodeId())
  const view = $derived(getCanvasView())

  /** 笔刷开关（自 Stage 外提——B 键同源命令总线语义：激活=退出、未激活=进入）。 */
  function onToggleBrush(): void {
    if (brush.active) exitBrushMode()
    else enterBrushMode()
  }
</script>

<div
  class="bg-background/60 backdrop-blur-sm z-30 flex w-11 shrink-0 flex-col items-center gap-1 py-2
    {side === 'left' ? 'border-r' : 'border-l'}"
  role="toolbar"
  aria-label={side === 'left' ? '画布工具与图层' : '面板与帮助'}
  data-testid="workbench-rail-{side}"
>
  {#if side === 'left'}
    <Button
      variant="ghost"
      size="icon"
      class="size-9 {tool === 'select' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
      onclick={() => void execWorkbenchCommand('tool.select')}
      aria-pressed={tool === 'select'}
      data-testid="workbench-tool-select"
      title="选择工具（V）——点选层/命中测试；钻上悬停看规格"
    >
      <MousePointer2 class="size-4" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="size-9 {tool === 'hand' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
      onclick={() => void execWorkbenchCommand('tool.hand')}
      aria-pressed={tool === 'hand'}
      data-testid="workbench-tool-hand"
      title="平移工具（H）——拖拽画布；空格按住临时平移"
    >
      <Hand class="size-4" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="size-9 {tool === 'zoom' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
      onclick={() => void execWorkbenchCommand('tool.zoom')}
      aria-pressed={tool === 'zoom'}
      data-testid="workbench-tool-zoom"
      title="缩放工具（Z）——点击放大/Alt+点击缩小；滚轮恒可锚定缩放"
    >
      <ZoomIn class="size-4" aria-hidden="true" />
    </Button>
    <div class="bg-border my-0.5 h-px w-6" aria-hidden="true"></div>
    <Button
      size="icon"
      variant={brush.active ? 'default' : 'ghost'}
      class="size-9"
      disabled={selectedId === null && !brush.active}
      onclick={onToggleBrush}
      data-testid="workbench-brush-toggle"
      title="笔刷编辑选中层遮罩（B）——include/exclude 涂抹→提交重算"
    >
      <Paintbrush class="size-4" aria-hidden="true" />
    </Button>
    <div class="bg-border my-0.5 h-px w-6" aria-hidden="true"></div>
    <Button
      variant="ghost"
      size="icon"
      class="text-muted-foreground size-9"
      onclick={() => void execWorkbenchCommand('zoom.out')}
      data-testid="workbench-zoom-out"
      title="缩小一档（⌘-）"
    >
      <Minus class="size-4" aria-hidden="true" />
    </Button>
    <span class="text-muted-foreground text-center font-mono text-[10px] leading-none" data-testid="workbench-zoom-readout">
      {Math.round(view.scale * 100)}%
    </span>
    <Button
      variant="ghost"
      size="icon"
      class="text-muted-foreground size-9"
      onclick={() => void execWorkbenchCommand('zoom.in')}
      data-testid="workbench-zoom-in"
      title="放大一档（⌘+）"
    >
      <Plus class="size-4" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="text-muted-foreground size-9"
      onclick={() => void execWorkbenchCommand('zoom.fit')}
      data-testid="workbench-zoom-fit"
      title="适配画幅（⌘0）"
    >
      <Maximize class="size-4" aria-hidden="true" />
    </Button>
    <button
      type="button"
      class="text-muted-foreground hover:bg-accent hover:text-accent-foreground size-9 rounded-md font-mono text-[10px] transition-colors"
      onclick={() => zoomCanvasTo(1)}
      data-testid="workbench-zoom-100"
      title="缩放至 100%（⌘1）"
    >
      1:1
    </button>
    <div class="bg-border my-0.5 mt-auto h-px w-6" aria-hidden="true"></div>
    <!-- 图层开合（PS 同款：工具组末位+分隔——左 Drawer 开关） -->
    <Button
      variant="ghost"
      size="icon"
      class="size-9 {layersOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
      onclick={() => onToggleLayers?.()}
      aria-pressed={layersOpen}
      data-testid="rail-layers-toggle"
      title="图层（左面板开合——列表/可见性/锁定）"
    >
      <Layers class="size-4" aria-hidden="true" />
    </Button>
  {:else}
    <Button
      variant="ghost"
      size="icon"
      class="size-9 {inspectorOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
      onclick={() => onToggleInspector?.()}
      aria-pressed={inspectorOpen}
      data-testid="rail-inspector-toggle"
      title="属性（右面板开合——策略直改/钻选择；与历史互斥）"
    >
      <SlidersHorizontal class="size-4" aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      class="size-9 {historyOpen ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'}"
      onclick={() => onToggleHistory?.()}
      aria-pressed={historyOpen}
      data-testid="rail-history-toggle"
      title="历史（右面板开合——版本链/回退；与属性互斥）"
    >
      <History class="size-4" aria-hidden="true" />
    </Button>
    <div class="bg-border my-0.5 mt-auto h-px w-6" aria-hidden="true"></div>
    <Button
      variant="ghost"
      size="icon"
      class="text-muted-foreground size-9"
      onclick={() => void execWorkbenchCommand('help.toggle')}
      data-testid="rail-help-toggle"
      title="快捷键速查（?）"
    >
      <Keyboard class="size-4" aria-hidden="true" />
    </Button>
  {/if}
</div>
