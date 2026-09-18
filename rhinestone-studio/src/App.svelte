<!--
Orthogonal intents (max 3):
1. [2026-09-18 R1] 全出血应用壳：h-screen flex-col overflow-hidden；顶栏 h-12（品牌+Tabs+BYOK 状态芯片）；
   主区 min-h-0 flex-1 由 Tabs.Content 承载两视图；bg-muted/40 恢复图底关系。
2. [2026-09-18 R4] lg 以下底部 Tab Bar（56px+安全区）替换顶栏 Tabs；顶栏瘦身只剩品牌+芯片。
3. [2026-09-18 Handoff] handoff 置位 → 自动切工作台（编程式 setView）；全局 Toast 与 SettingsDialog 唯一挂载。
-->

<script lang="ts">
  import * as Tabs from '$lib/components/ui/tabs'
  import LabView from '$lib/components/views/LabView.svelte'
  import StudioView from '$lib/components/views/StudioView.svelte'
  import EditView from '$lib/components/views/EditView.svelte'
  import AssetsView from '$lib/components/views/AssetsView.svelte'
  import AssetPickerHost from './components/Assets/AssetPickerHost.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import ToastStack from './components/ToastStack.svelte'
  import { getView, setView, type ViewId } from '$lib/stores/view.svelte'
  import { getHandoff } from '$lib/stores/handoff.svelte'
  import { getSettings } from '$lib/stores/lab.svelte'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import Gem from '@lucide/svelte/icons/gem'
  import FlaskConical from '@lucide/svelte/icons/flask-conical'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import Settings2 from '@lucide/svelte/icons/settings-2'

  const view = $derived(getView())
  const settings = getSettings()

  /** 三项齐备才算已配置（与 startRun 的校验口径一致） */
  const configured = $derived(
    settings.baseUrl.trim() !== '' && settings.apiKey.trim() !== '' && settings.model.trim() !== '',
  )

  // 送转化 handoff 置位 → 自动切到工作台（StudioView 挂载后消费并清空 handoff）
  $effect(() => {
    if (getHandoff()) setView('studio')
  })

  function switchView(next: ViewId): void {
    setView(next)
  }
</script>

<Tabs.Root
  value={view}
  onValueChange={(v) => {
    if (v === 'assets' || v === 'lab' || v === 'studio' || v === 'edit') switchView(v)
  }}
  class="bg-background text-foreground flex h-screen flex-col overflow-hidden"
>
  <header class="bg-background/80 flex h-12 shrink-0 items-center gap-3 border-b px-4 backdrop-blur">
    <Gem class="text-primary size-4 shrink-0" aria-hidden="true" />
    <h1 class="text-base font-semibold tracking-tight whitespace-nowrap">贴钻工作台</h1>
    <span class="text-muted-foreground hidden text-xs sm:inline">Rhinestone Studio</span>

    <!-- 桌面顶栏 Tabs（lg+）；移动端由底部 Tab Bar 接管。[Owner] 素材库居首，默认落地仍为实验室 -->
    <div class="ml-2 hidden lg:block">
      <Tabs.List>
        <Tabs.Trigger value="assets">素材库</Tabs.Trigger>
        <Tabs.Trigger value="lab">提示词实验室</Tabs.Trigger>
        <Tabs.Trigger value="studio">转化工作台</Tabs.Trigger>
        <Tabs.Trigger value="edit">手动编辑</Tabs.Trigger>
      </Tabs.List>
    </div>

    <!-- BYOK 状态芯片：连接状态是全局事实，点击开设置（未配置时即冷启动 CTA） -->
    <button
      type="button"
      onclick={openSettings}
      data-testid="byok-chip"
      class="ml-auto inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors
        {configured
        ? 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
        : 'border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/20'}"
      title={configured ? `已连接 · ${settings.model} · 点击设置` : '连接未配置 · 点击完成冷启动第一步'}
    >
      <span
        class="size-1.5 rounded-full {configured ? 'bg-primary' : 'bg-destructive'}"
        aria-hidden="true"
      ></span>
      <span class="max-w-40 truncate">{configured ? settings.model : '未配置连接'}</span>
      <Settings2 class="size-3.5 opacity-60" aria-hidden="true" />
    </button>
  </header>

  <main class="bg-muted/40 min-h-0 min-w-0 flex-1 overflow-hidden">
    <Tabs.Content value="assets" class="h-full">
      <AssetsView />
    </Tabs.Content>
    <Tabs.Content value="lab" class="h-full">
      <LabView />
    </Tabs.Content>
    <Tabs.Content value="studio" class="h-full">
      <StudioView />
    </Tabs.Content>
    <Tabs.Content value="edit" class="h-full">
      <EditView />
    </Tabs.Content>
  </main>

  <!-- 移动端底部 Tab Bar（48-56px + iOS 安全区），lg 以下替换顶栏 Tabs；素材库居首与桌面同步 -->
  <nav
    class="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-30 flex h-14 shrink-0 items-stretch border-t backdrop-blur pb-[env(safe-area-inset-bottom)] lg:hidden"
    aria-label="模块切换"
  >
    <button
      type="button"
      onclick={() => switchView('assets')}
      aria-current={view === 'assets' ? 'page' : undefined}
      class="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs {view === 'assets'
        ? 'text-primary font-medium'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      <FolderOpen class="size-5" aria-hidden="true" />
      素材库
    </button>
    <div class="bg-border w-px" aria-hidden="true"></div>
    <button
      type="button"
      onclick={() => switchView('lab')}
      aria-current={view === 'lab' ? 'page' : undefined}
      class="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs {view === 'lab'
        ? 'text-primary font-medium'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      <FlaskConical class="size-5" aria-hidden="true" />
      实验室
    </button>
    <div class="bg-border w-px" aria-hidden="true"></div>
    <button
      type="button"
      onclick={() => switchView('studio')}
      aria-current={view === 'studio' ? 'page' : undefined}
      class="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs {view === 'studio'
        ? 'text-primary font-medium'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      <Gem class="size-5" aria-hidden="true" />
      工作台
    </button>
    <div class="bg-border w-px" aria-hidden="true"></div>
    <button
      type="button"
      onclick={() => switchView('edit')}
      aria-current={view === 'edit' ? 'page' : undefined}
      class="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs {view === 'edit'
        ? 'text-primary font-medium'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      <PenLine class="size-5" aria-hidden="true" />
      手动编辑
    </button>
  </nav>
</Tabs.Root>

<SettingsDialog />
<AssetPickerHost />
<ToastStack />
