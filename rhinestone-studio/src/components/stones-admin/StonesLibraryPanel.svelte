<!--
StonesLibraryPanel.svelte——后台「装饰钻库」面板（split-admin-portal 善后，Owner
裁决 2026-09-30：「装饰钻库和组合/套装库这两个面板完全可以合并起来管理。组合/
套装库本质上只是一个分组功能」）。
单一意图：装饰钻库面板的视角切换壳——顶部小 tab「钻型|组合」：
- 钻型 = StonesAdminView 零改动挂载（左树供应商→色系→款式+样卡网格）。
- 组合 = WarehouseView 零改动挂载（多标准分组流+SetSidebar——组合=钻库分组视角，
  不再是 resources 独立子分区；App dev 旗标旧工作台入口不受影响）。
切换即重挂载（两视图各自 store 自初始化/onMount）；满高链交组件内滚。
-->

<script lang="ts">
  import IconBoxes from '@lucide/svelte/icons/boxes'
  import IconGem from '@lucide/svelte/icons/gem'
  import StonesAdminView from './StonesAdminView.svelte'
  import WarehouseView from '../warehouse/WarehouseView.svelte'

  type LibraryView = 'stones' | 'sets'

  const VIEWS: Array<{ id: LibraryView; label: string; icon: typeof IconGem }> = [
    { id: 'stones', label: '钻型', icon: IconGem },
    { id: 'sets', label: '组合', icon: IconBoxes },
  ]

  let view = $state<LibraryView>('stones')
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="stones-library-panel">
  <!-- 顶部小 tab：钻型|组合（组合=分组视角——与库内 groupBy 切换同款 pill 形态）。 -->
  <div class="bg-background/80 flex items-center border-b px-3 py-1.5 backdrop-blur">
    <span
      class="border-border/70 bg-muted/40 flex h-8 items-center gap-0.5 rounded-lg border p-0.5"
      role="group"
      aria-label="钻库视角"
      data-testid="stones-view-switch"
    >
      {#each VIEWS as v (v.id)}
        {@const Icon = v.icon}
        {@const active = view === v.id}
        <button
          type="button"
          onclick={() => (view = v.id)}
          data-testid="stones-view-tab-{v.id}"
          class="flex items-center gap-1 rounded-md px-2 py-1 text-xs transition-colors
            {active ? 'bg-background text-foreground shadow-sm font-medium' : 'text-muted-foreground hover:text-foreground'}"
          aria-pressed={active}
        >
          <Icon class="size-3.5 shrink-0" aria-hidden="true" />
          {v.label}
        </button>
      {/each}
    </span>
  </div>

  {#if view === 'stones'}
    <!-- 钻型视角：StonesAdminView 零改动挂载（自初始化）。 -->
    <div class="min-h-0 flex-1" data-testid="stones-view-panel-stones">
      <StonesAdminView />
    </div>
  {:else}
    <!-- 组合视角：WarehouseView 零改动挂载（多标准分组流+SetSidebar）。 -->
    <div class="min-h-0 flex-1" data-testid="stones-view-panel-sets">
      <WarehouseView />
    </div>
  {/if}
</div>
