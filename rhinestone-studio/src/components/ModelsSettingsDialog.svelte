<!--
ModelsSettingsDialog.svelte — 模型服务设置抽屉（zhumo 方案移植块 A，2026-09-28）。
承载形态=zhumo AdminPage 设置分区（二级导航 list-detail 的 models 分支）：
<section class="min-h-0 flex-1 rounded-lg border bg-card p-4"><ModelsConfig /></section>
——models 是满高链组件（h-full min-h-0），滚动所有权在其内部 tab 内容容器，
容器侧只给满高不设滚动。挂载位=App 层唯一实例（openModelsSettings() 全局入口）。
-->
<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import ModelsConfig from '$lib/components/models/ModelsConfig.svelte'
  import {
    closeModelsSettings,
    isModelsSettingsOpen,
  } from '$lib/stores/modelsSettingsDialog.svelte'

  const open = $derived(isModelsSettingsOpen())
</script>

<Sheet.Root
  open={open}
  onOpenChange={(next) => {
    if (!next) closeModelsSettings()
  }}
>
  <Sheet.Content side="right" class="w-[92%] max-w-2xl gap-0 p-0" data-testid="models-settings-sheet">
    <Sheet.Header class="flex-row items-center justify-between border-b px-3 py-2">
      <Sheet.Title class="text-xs font-medium text-muted-foreground">设置 · 大模型服务</Sheet.Title>
    </Sheet.Header>
    <Sheet.Description class="sr-only">
      模型路由与 API Key 配置（多路由 tab 管理、目录画廊、连接测试、默认模型选择）。
    </Sheet.Description>
    <!-- 满高链（zhumo AdminPage models 分区同款）：Sheet 内部 flex 体给满高，
         ModelsConfig 自滚（滚动所有权在其 tab 内容容器）。 -->
    <div class="min-h-0 flex-1 p-3">
      <section class="h-full min-h-0 rounded-lg border bg-card p-4">
        <ModelsConfig />
      </section>
    </div>
  </Sheet.Content>
</Sheet.Root>
