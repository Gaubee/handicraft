<!--
ModelsSettingsDialog.svelte — 设置抽屉·多分区壳（zhumo AdminPage list-detail 目标形态；
2026-09-28 zhumo 方案移植块 A 起步，add-image-processing-settings 2.2 升级双分区）。
左侧窄导航「模型服务 / 图像处理」+右侧当前分区内容；容器查询（@container）——
宽空间（≥26rem）导航为竖排侧栏，窄空间折叠为顶部横条（nav 自身横滚）。
分区切换用 {#if} 重挂载（不做保活）：ModelsConfig 读面自愈（挂载即 load），图像处理
分区进页以远端读面重新初始化编辑态——切换分区=丢弃未保存草稿，符合「不自动保存」语义。
models 分区：满高链组件（h-full min-h-0），滚动所有权在其内部 tab 内容容器，
容器侧只给满高不设滚动。挂载位=App 层唯一实例（openModelsSettings() 全局入口）。
-->
<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import ModelsConfig from '$lib/components/models/ModelsConfig.svelte'
  import ImageProcessingConfig from '$lib/components/settings/ImageProcessingConfig.svelte'
  import {
    closeModelsSettings,
    getSettingsSection,
    isModelsSettingsOpen,
    setSettingsSection,
    type SettingsSection,
  } from '$lib/stores/modelsSettingsDialog.svelte'

  const open = $derived(isModelsSettingsOpen())
  const section = $derived(getSettingsSection())

  const SECTIONS: { id: SettingsSection; label: string }[] = [
    { id: 'models', label: '模型服务' },
    { id: 'image-processing', label: '图像处理' },
  ]
</script>

<Sheet.Root
  open={open}
  onOpenChange={(next) => {
    if (!next) closeModelsSettings()
  }}
>
  <!-- 走查 F1：基类 sheet-content 的 data-[side=right]:sm:max-w-sm(384px) 属性选择器
       特异性压制本类 max-w-2xl——同前缀+important 后缀夺回宽度，@[26rem] 竖排侧栏
       分支（416px 起）在桌面才可达。 -->
  <Sheet.Content
    side="right"
    class="w-[92%] max-w-2xl data-[side=right]:sm:max-w-2xl! gap-0 p-0"
    data-testid="settings-sheet"
  >
    <Sheet.Header class="flex-row items-center justify-between border-b px-3 py-2">
      <Sheet.Title class="text-xs font-medium text-muted-foreground">设置</Sheet.Title>
    </Sheet.Header>
    <Sheet.Description class="sr-only">
      模型服务（路由 / API Key / 默认模型）与图像处理（预设档 / 自定义参数）设置分区。
    </Sheet.Description>
    <!-- list-detail：@container 容器查询——窄空间导航横条（默认态，移动优先），
         @[26rem]: 起竖排侧栏。 -->
    <div class="@container flex min-h-0 flex-1 flex-col">
      <nav
        aria-label="设置分区"
        data-testid="settings-nav"
        class="flex shrink-0 flex-row items-stretch gap-1 overflow-x-auto border-b px-2 py-1.5 @[26rem]:w-40 @[26rem]:flex-col @[26rem]:gap-1 @[26rem]:border-b-0 @[26rem]:border-r @[26rem]:px-3 @[26rem]:py-3"
      >
        {#each SECTIONS as s (s.id)}
          <button
            type="button"
            data-testid="settings-nav-{s.id}"
            aria-current={section === s.id ? 'page' : undefined}
            class="h-8 shrink-0 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors {section === s.id
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-muted hover:text-foreground'}"
            onclick={() => setSettingsSection(s.id)}
          >
            {s.label}
          </button>
        {/each}
      </nav>
      <div class="min-h-0 flex-1 p-3">
        {#if section === 'models'}
          <!-- 满高链（zhumo AdminPage models 分区同款）：容器只给满高，ModelsConfig 自滚。 -->
          <section class="h-full min-h-0 rounded-lg border bg-card p-4">
            <ModelsConfig />
          </section>
        {:else}
          <section class="h-full min-h-0 rounded-lg border bg-card p-4">
            <ImageProcessingConfig />
          </section>
        {/if}
      </div>
    </div>
  </Sheet.Content>
</Sheet.Root>
