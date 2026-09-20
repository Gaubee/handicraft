<!--
 * DesignerContextMenu.svelte——右键上下文菜单（design §2.2 两态树 + §2 P13/P14）。
 *
 * Orthogonal intents (max 2):
 * 1. [2026-09-21 redesign-designer-workbench 3.x（画布交互核）] 两态树：选中态（≥1 颗——
 *    复制⌘C/剪切⌘X/粘贴⌘V/删除 Delete + 对齐▸(≥2 六式)/分布▸(≥3 两式)/移入图层▸（当前层
 *    标记；锁定/隐藏层禁用；全已在层禁用））；空态（粘贴⌘V/全选当前层⌘A/适配画幅⌘0/100%⌘1）。
 *    design §2.2 空态树的「智能排布…/画幅设置…」分别归 7.x（SmartLayoutPanel）与 5.2
 *    （画幅 popover）——本切片不接线，登记偏离清单。
 * 2. [同源纪律] 全部命令经 execDesignerCommand 命令总线（键位/面板同源——禁第二实现）；
 *    子菜单点击/悬停展开（aria-expanded）；外点/Esc/命令执行即关闭（onClose 回调）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { getEditDoc, type DesignerGem } from '$lib/stores/edit.svelte'
  import { execDesignerCommand } from '$lib/designer/commands'
  import { ALIGN_COMMANDS, DISTRIBUTION_COMMANDS } from '$lib/designer/alignDistribute'
  import { clipboardSize } from '$lib/designer/clipboard'
  import { currentLayerIdOf } from '$lib/designer/workbench.svelte'

  let {
    x,
    y,
    kind,
    onClose,
  }: {
    /** wrap 相对定位（画布容器内绝对定位）。 */
    x: number
    y: number
    /** 两态：钻上（选中态树）/ 空白（空态树）——画布命中裁决后传入。 */
    kind: 'selection' | 'blank'
    onClose: () => void
  } = $props()

  const doc = $derived(getEditDoc())
  const clipSize = $derived(clipboardSize())

  /** 选中钻快照（selection SvelteSet 驱动重渲染）。 */
  const selectedGems = $derived.by(() => {
    const d = doc
    if (!d || d.selection.size === 0) return [] as DesignerGem[]
    const byId = new Map(d.gems.map((g) => [g.id, g] as const))
    const out: DesignerGem[] = []
    for (const id of d.selection) {
      const gem = byId.get(id)
      if (gem) out.push(gem)
    }
    return out
  })
  const count = $derived(selectedGems.length)
  const currentLayerId = $derived(currentLayerIdOf(doc))

  /** 移入图层目标判定：锁定/隐藏层禁用；选中钻已全部在该层 = 禁用（无变更）。 */
  function moveTargetDisabled(layerId: string): boolean {
    const layer = doc?.layers.find((l) => l.id === layerId)
    if (layer === undefined || layer.locked || !layer.visible) return true
    return selectedGems.every((g) => g.layerId === layerId)
  }

  /** 全选当前层可执行性（锁定/隐藏/空层不可）。 */
  const selectAllDisabled = $derived.by(() => {
    const d = doc
    if (!d || currentLayerId === null) return true
    const layer = d.layers.find((l) => l.id === currentLayerId)
    if (layer === undefined || layer.locked || !layer.visible) return true
    return !d.gems.some((g) => g.layerId === currentLayerId)
  })

  function run(cmd: Parameters<typeof execDesignerCommand>[0]): void {
    execDesignerCommand(cmd)
    onClose()
  }

  // 子菜单展开态（悬停/点击展开；同组互斥）
  let openGroup = $state<'align' | 'distribute' | 'move-layer' | null>(null)

  // 外点 / Esc 关闭（挂载期 window 监听；菜单自身点击不冒泡关闭）
  function onWindowPointerDown(e: PointerEvent): void {
    const el = document.querySelector('[data-testid="designer-context-menu"]')
    if (el !== null && e.composedPath().includes(el)) return
    onClose()
  }
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose()
  }
  onMount(() => {
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('keydown', onWindowKeydown, true)
    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('keydown', onWindowKeydown, true)
    }
  })
</script>

<div
  class="bg-popover text-popover-foreground absolute z-40 min-w-44 overflow-visible rounded-lg border p-1 text-xs shadow-lg"
  style="left: {x}px; top: {y}px"
  data-testid="designer-context-menu"
  data-state={kind}
  role="menu"
>
  {#if kind === 'selection'}
    <button type="button" class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5" onclick={() => run({ kind: 'copy' })} data-testid="designer-menu-copy">
      <span>复制</span><span class="text-muted-foreground font-mono">⌘C</span>
    </button>
    <button type="button" class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5" onclick={() => run({ kind: 'cut' })} data-testid="designer-menu-cut">
      <span>剪切</span><span class="text-muted-foreground font-mono">⌘X</span>
    </button>
    <button
      type="button"
      class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 disabled:pointer-events-none disabled:opacity-50"
      disabled={clipSize === 0}
      onclick={() => run({ kind: 'paste' })}
      data-testid="designer-menu-paste"
    >
      <span>粘贴</span><span class="text-muted-foreground font-mono">⌘V</span>
    </button>
    <button type="button" class="text-destructive hover:bg-destructive/10 flex w-full items-center justify-between gap-4 rounded px-2 py-1.5" onclick={() => run({ kind: 'delete-selection' })} data-testid="designer-menu-delete">
      <span>删除{count > 1 ? `（${count} 颗）` : ''}</span><span class="text-muted-foreground font-mono">Delete</span>
    </button>

    {#if count >= 2}
      <div class="bg-border my-1 h-px" role="separator"></div>
      <div class="relative" data-testid="designer-menu-align">
        <button
          type="button"
          class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5"
          aria-expanded={openGroup === 'align'}
          onclick={() => (openGroup = openGroup === 'align' ? null : 'align')}
          onpointerenter={() => (openGroup = 'align')}
        >
          <span>对齐</span><span class="text-muted-foreground">▸</span>
        </button>
        {#if openGroup === 'align'}
          <div class="bg-popover absolute top-0 left-full z-50 ml-0.5 min-w-32 rounded-lg border p-1 shadow-lg" role="menu">
            {#each ALIGN_COMMANDS as cmd (cmd.id)}
              <button type="button" class="hover:bg-accent block w-full rounded px-2 py-1.5 text-left" onclick={() => run({ kind: 'align', mode: cmd.id })} data-testid={`designer-menu-align-${cmd.id}`}>
                {cmd.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
    {#if count >= 3}
      <div class="relative" data-testid="designer-menu-distribute">
        <button
          type="button"
          class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5"
          aria-expanded={openGroup === 'distribute'}
          onclick={() => (openGroup = openGroup === 'distribute' ? null : 'distribute')}
          onpointerenter={() => (openGroup = 'distribute')}
        >
          <span>分布</span><span class="text-muted-foreground">▸</span>
        </button>
        {#if openGroup === 'distribute'}
          <div class="bg-popover absolute top-0 left-full z-50 ml-0.5 min-w-32 rounded-lg border p-1 shadow-lg" role="menu">
            {#each DISTRIBUTION_COMMANDS as cmd (cmd.id)}
              <button type="button" class="hover:bg-accent block w-full rounded px-2 py-1.5 text-left" onclick={() => run({ kind: 'distribute', mode: cmd.id })} data-testid={`designer-menu-distribute-${cmd.id}`}>
                {cmd.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="bg-border my-1 h-px" role="separator"></div>
    <div class="relative" data-testid="designer-menu-move-layer">
      <button
        type="button"
        class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5"
        aria-expanded={openGroup === 'move-layer'}
        onclick={() => (openGroup = openGroup === 'move-layer' ? null : 'move-layer')}
        onpointerenter={() => (openGroup = 'move-layer')}
      >
        <span>移入图层</span><span class="text-muted-foreground">▸</span>
      </button>
      {#if openGroup === 'move-layer'}
        <div class="bg-popover absolute top-0 left-full z-50 ml-0.5 max-h-56 min-w-36 overflow-y-auto rounded-lg border p-1 shadow-lg" role="menu">
          {#each doc?.layers ?? [] as layer (layer.id)}
            <button
              type="button"
              class="hover:bg-accent block w-full rounded px-2 py-1.5 text-left disabled:pointer-events-none disabled:opacity-50"
              disabled={moveTargetDisabled(layer.id)}
              onclick={() => run({ kind: 'move-to-layer', layerId: layer.id })}
              data-testid={`designer-menu-move-layer-${layer.id}`}
            >
              {layer.name}{layer.id === currentLayerId ? '（当前层）' : ''}
              {#if layer.locked} 🔒{:else if !layer.visible} 🙈{/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <button
      type="button"
      class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 disabled:pointer-events-none disabled:opacity-50"
      disabled={clipSize === 0}
      onclick={() => run({ kind: 'paste' })}
      data-testid="designer-menu-paste"
    >
      <span>粘贴</span><span class="text-muted-foreground font-mono">⌘V</span>
    </button>
    <button
      type="button"
      class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5 disabled:pointer-events-none disabled:opacity-50"
      disabled={selectAllDisabled}
      onclick={() => run({ kind: 'select-all-current-layer' })}
      data-testid="designer-menu-select-all"
    >
      <span>全选当前层</span><span class="text-muted-foreground font-mono">⌘A</span>
    </button>
    <div class="bg-border my-1 h-px" role="separator"></div>
    <button type="button" class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5" onclick={() => run({ kind: 'zoom-fit' })} data-testid="designer-menu-fit">
      <span>适配画幅</span><span class="text-muted-foreground font-mono">⌘0</span>
    </button>
    <button type="button" class="hover:bg-accent flex w-full items-center justify-between gap-4 rounded px-2 py-1.5" onclick={() => run({ kind: 'zoom-100' })} data-testid="designer-menu-100">
      <span>100%</span><span class="text-muted-foreground font-mono">⌘1</span>
    </button>
  {/if}
</div>
