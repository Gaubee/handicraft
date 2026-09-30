<!--
  MyMaterialsPanel.svelte——后台「我的材料」面板三分区壳（restructure-materials-story
  W1，2026-09-30 Owner 裁决：「素材库」→「我的材料」——对内账户私有域，故事闭环
  「归档」环：组合归组合、文件归文件、任务归任务）。
  顶部三 pill 子导航（形态照 AdminPage 设置分区移动端 pill 条——桌面同款顶部横条）：
  - 我的贴砖组合：W2b 实装（MySetsSection——组合卡片网格+删除确认+创建入口线头）。
  - 我的文件：AssetsLibAdmin 零逻辑改动挂载（现服务端文件管理；满高链组件内滚）。
  - 我的任务：W2b 实装（MyTasksSection——只读任务行列表+进入会话）。
  缺省落「我的贴砖组合」（W1 注释预留的 W2b 回摆首区裁定：三区均实装后取首 pill
  ——故事「组套」环起始，与导航首项一致）。纯视图状态不进路由（与设置分区一致）。
-->

<script lang="ts">
  import IconLayers from '@lucide/svelte/icons/layers'
  import IconFolderOpen from '@lucide/svelte/icons/folder-open'
  import IconListTodo from '@lucide/svelte/icons/list-todo'
  import AssetsLibAdmin from '$lib/components/assets-lib/AssetsLibAdmin.svelte'
  import MySetsSection from './MySetsSection.svelte'
  import MyTasksSection from './MyTasksSection.svelte'

  type MaterialZone = 'sets' | 'files' | 'tasks'

  const ZONES: Array<{ id: MaterialZone; label: string; icon: typeof IconLayers }> = [
    { id: 'sets', label: '我的贴砖组合', icon: IconLayers },
    { id: 'files', label: '我的文件', icon: IconFolderOpen },
    { id: 'tasks', label: '我的任务', icon: IconListTodo },
  ]

  let zone = $state<MaterialZone>('sets')
</script>

<div class="flex h-full min-h-0 min-w-0 flex-col" data-testid="my-materials-panel">
  <!-- 顶部三 pill 子导航（设置分区移动端 pill 同款形态；桌面同款顶部横条）。 -->
  <div class="bg-background/80 flex items-center gap-1 overflow-x-auto border-b px-3 py-1.5 backdrop-blur">
    {#each ZONES as z (z.id)}
      {@const Icon = z.icon}
      {@const active = zone === z.id}
      <button
        type="button"
        aria-current={active ? 'true' : undefined}
        data-testid="my-materials-tab-{z.id}"
        class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors {active
          ? 'border-transparent bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'}"
        onclick={() => (zone = z.id)}
      >
        <Icon class="size-3.5 shrink-0" aria-hidden="true" />
        {z.label}
      </button>
    {/each}
  </div>

  {#if zone === 'files'}
    <!-- 我的文件：AssetsLibAdmin 零逻辑改动挂载（满高链组件内滚）。 -->
    <div class="min-h-0 flex-1" data-testid="my-materials-section-files">
      <AssetsLibAdmin />
    </div>
  {:else if zone === 'sets'}
    <!-- 我的贴砖组合：W2b 实装（组合卡片网格+删除确认+创建入口——CreateSetDialog 线头）。 -->
    <div class="min-h-0 flex-1" data-testid="my-materials-section-sets">
      <MySetsSection />
    </div>
  {:else}
    <!-- 我的任务：W2b 实装（只读任务行列表——取消/清理属前台会话域）。 -->
    <div class="min-h-0 flex-1" data-testid="my-materials-section-tasks">
      <MyTasksSection />
    </div>
  {/if}
</div>
