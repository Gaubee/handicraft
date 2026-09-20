<!--
 * DesignerToolbar.svelte——竖排工具栏（design §1.1/§1.2：左列 56px icon 条；Owner 点名「工具栏应该竖排」）。
 *
 * Orthogonal intents (max 2):
 * 1. [2026-09-21 redesign-designer-workbench 2.x] 工具五态（V 选择/B 画笔/E 橡皮/H 抓手/Z 缩放
 *    ——写 workbench 工具真源；tooltip 标注快捷键 `选择 (V)`）+ 栏底吸附开关（格位/自由两态，
 *    design §1.2 非模态开关——写交互态真源）。撤销/重做按钮归顶部文档栏（design §1.2），
 *    不在本栏（旧 EditToolbar 横排退役）。
 * 2. [Guard] 无文档态全禁用（工具态无消费面）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import { getSnap, getTool, setSnap, setTool, type DesignerTool } from '$lib/designer/workbench.svelte'
  import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import Eraser from '@lucide/svelte/icons/eraser'
  import Hand from '@lucide/svelte/icons/hand'
  import ZoomIn from '@lucide/svelte/icons/zoom-in'

  const hasDoc = $derived(getEditDoc() !== null)
  const tool = $derived(getTool())
  const snap = $derived(getSnap())

  /** 工具集（design §1.2 表：贴钻域裁剪五项——吸管/钢笔/文字不纳入）。 */
  const TOOLS: ReadonlyArray<{ id: DesignerTool; key: string; label: string; icon: typeof MousePointer2 }> = [
    { id: 'select', key: 'V', label: '选择', icon: MousePointer2 },
    { id: 'draw', key: 'B', label: '画笔', icon: PenLine },
    { id: 'erase', key: 'E', label: '橡皮', icon: Eraser },
    { id: 'hand', key: 'H', label: '抓手', icon: Hand },
    { id: 'zoom', key: 'Z', label: '缩放', icon: ZoomIn },
  ]
</script>

<div
  class="bg-card flex w-14 shrink-0 flex-col items-center gap-0.5 rounded-xl border p-1 shadow-sm"
  data-testid="designer-toolbar"
  role="toolbar"
  aria-label="设计工具"
  aria-orientation="vertical"
>
  {#each TOOLS as t (t.id)}
    <Button
      size="icon-sm"
      variant={tool === t.id ? 'secondary' : 'ghost'}
      class="size-10"
      disabled={!hasDoc}
      aria-pressed={tool === t.id}
      title={`${t.label} (${t.key})`}
      onclick={() => setTool(t.id)}
      data-testid={`designer-tool-${t.id}`}
    >
      <t.icon class="size-4" aria-hidden="true" />
      <span class="sr-only">{t.label}（{t.key}）</span>
    </Button>
  {/each}

  <span class="bg-border my-1 h-px w-8" aria-hidden="true"></span>

  <!-- 栏底吸附开关（design §1.2：格位/自由两态非模态开关；作用于落钻/拖移落点，3.x 随规格 pitch 重算） -->
  <div
    class="flex flex-col items-center gap-0.5"
    role="group"
    aria-label="吸附"
    data-testid="designer-snap-group"
  >
    <Button
      size="xs"
      variant={snap === 'grid' ? 'secondary' : 'ghost'}
      class="h-6 w-10 px-0 text-[11px]"
      disabled={!hasDoc}
      aria-pressed={snap === 'grid'}
      title="吸附到六方格位（当前规格 pitch）"
      onclick={() => setSnap('grid')}
      data-testid="designer-snap-grid"
    >
      格位
    </Button>
    <Button
      size="xs"
      variant={snap === 'free' ? 'secondary' : 'ghost'}
      class="h-6 w-10 px-0 text-[11px]"
      disabled={!hasDoc}
      aria-pressed={snap === 'free'}
      title="自由落点（不吸附）"
      onclick={() => setSnap('free')}
      data-testid="designer-snap-free"
    >
      自由
    </Button>
  </div>
</div>
