<!--
Orthogonal intents (max 3):
1. [2026-09-24 S5.1 Pick] StoneGridCell 的可选中投影：主按钮点击=onPick（选中产出
   StonePick 的 UI 入口）；选中态描边+对勾角标。
2. [2026-09-24 S5.2 Preview] 贴图渲染：中性灰底（design §1.4/§5——白钻在纯白底隐形）；
   推荐位携带 ΔE 徽标；未声明尺寸/引用缺失显式标注（§8.1 规则 7——不猜测）。
3. [2026-09-24 S5.2 NearColor] 角标「取色找近似」次按钮：以该钻 colorHex 为目标色
   发起 ΔE 邻近推荐（独立于选中动作——与主按钮平级，不嵌套 button）。
-->
<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import Check from '@lucide/svelte/icons/check'
  import Pipette from '@lucide/svelte/icons/pipette'
  import type { StoneGridCell } from '@handicraft/contracts'
  import type { StoneRefState } from '$lib/stonePicker/source.js'

  let {
    cell,
    textureSrc,
    selected = false,
    deltaE = null,
    refState = null,
    onPick,
    onUseColor = undefined,
  }: {
    cell: StoneGridCell
    /** 已解析的贴图 URL（source.resolveTextureUrl 产物）。 */
    textureSrc: string
    selected?: boolean
    /** ΔE(CIE76) 邻近推荐徽标（null=非推荐位渲染）。 */
    deltaE?: number | null
    /** 选中钻的引用解析态（非 resolved 时显式缺失标注——四态语义）。 */
    refState?: StoneRefState | null
    onPick: (cell: StoneGridCell) => void
    onUseColor?: (cell: StoneGridCell) => void
  } = $props()

  const REF_STATE_LABELS: Record<Exclude<StoneRefState, 'resolved'>, string> = {
    'soft-deleted': '已入回收站',
    'blob-missing': '贴图缺失',
    'wrong-kind': '引用类型不符',
    'not-found': '引用不存在',
  }

  // —— 贴图真实毫米比例（Owner 2026-09-25 定稿）——
  // 缩略不再统一大小：比例基准 REF_MAX_MM=25mm——25mm 基准钻占满格内可用最大边
  // （h-16 容器内 max-h-14=56px），其余尺寸按 sizeMm/25 线性缩放；sizeMm=null
  // （未声明）按中档 6mm 渲染（「未声明」徽标另行标注）；最小渲染边 8px 下限
  // （3mm≈8px 本来就贴下限，防更小尺寸图消失）。
  const TEXTURE_REF_MAX_MM = 25
  const TEXTURE_MAX_EDGE_PX = 56
  const TEXTURE_UNDECLARED_MM = 6
  const TEXTURE_MIN_EDGE_PX = 8

  function textureEdgePx(sizeMm: number | null): number {
    const mm = sizeMm ?? TEXTURE_UNDECLARED_MM
    const edge = Math.min((mm / TEXTURE_REF_MAX_MM) * TEXTURE_MAX_EDGE_PX, TEXTURE_MAX_EDGE_PX)
    return Math.max(TEXTURE_MIN_EDGE_PX, Math.round(edge))
  }
</script>

<div class="group relative flex w-24 shrink-0 flex-col gap-1" data-testid="stone-tile-{cell.resourceId}">
  <button
    type="button"
    data-testid="stone-cell-{cell.resourceId}"
    class="ring-offset-background focus-visible:ring-ring/50 relative flex flex-col gap-1 rounded-lg border p-1.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none {selected
      ? 'border-primary bg-primary/5'
      : 'border-border hover:border-primary/40 hover:bg-muted/50'}"
    aria-pressed={selected}
    onclick={() => onPick(cell)}
  >
    {#if selected}
      <span
        data-testid="stone-cell-check-{cell.resourceId}"
        class="bg-primary text-primary-foreground absolute -top-1.5 -right-1.5 flex size-4 items-center justify-center rounded-full"
      >
        <Check class="size-3" />
      </span>
    {/if}
    <!-- 中性灰底（zinc-300）：白钻在纯白底隐形的防线（design §1.4/§5） -->
    <div class="flex h-16 items-center justify-center rounded-md bg-zinc-300 dark:bg-zinc-700">
      <img
        src={textureSrc}
        alt={cell.name}
        loading="lazy"
        class="max-h-14 max-w-full object-contain"
        style="width: {textureEdgePx(cell.sizeMm)}px; height: {textureEdgePx(cell.sizeMm)}px"
        draggable="false"
      />
    </div>
    <div class="flex min-w-0 flex-col gap-0.5">
      <span class="truncate text-xs font-medium" title="{cell.supplier}/{cell.sku}">{cell.sku}</span>
      <div class="flex items-center gap-1">
        {#if cell.sizeMm !== null}
          <span class="text-muted-foreground text-[10px]">{cell.sizeMm}mm</span>
        {:else}
          <Badge variant="destructive" class="h-4 px-1 text-[10px]" data-testid="stone-size-unset-{cell.resourceId}">
            未声明尺寸
          </Badge>
        {/if}
        {#if deltaE !== null}
          <Badge variant="secondary" class="h-4 px-1 text-[10px]" data-testid="stone-delta-e-{cell.resourceId}">
            ΔE {deltaE.toFixed(1)}
          </Badge>
        {/if}
      </div>
    </div>
  </button>
  {#if refState !== null && refState !== 'resolved' && selected}
    <span
      data-testid="stone-ref-state-{cell.resourceId}"
      class="text-destructive truncate text-[10px]"
      role="status"
    >
      引用缺失：{REF_STATE_LABELS[refState]}
    </span>
  {/if}
  {#if onUseColor !== undefined}
    <button
      type="button"
      data-testid="stone-use-color-{cell.resourceId}"
      class="text-muted-foreground hover:text-foreground absolute top-1 right-1 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
      title="以 {cell.colorHex} 为目标色找近似"
      aria-label="以 {cell.colorHex} 为目标色找近似"
      onclick={() => onUseColor?.(cell)}
    >
      <Pipette class="size-3.5" />
    </button>
  {/if}
</div>
