<!--
Orthogonal intents (max 5):
1. [2026-09-18 R1] 全出血应用壳：h-screen flex-col overflow-hidden；顶栏 h-12（品牌+Tabs+BYOK 状态芯片）；
   主区 min-h-0 flex-1 由 Tabs.Content 承载两视图；bg-muted/40 恢复图底关系。
   [add-backend-platform W3.1/W3.2] 默认路由=Agent 主面；旧三工作台+素材库收进开发者旗标
   （handicraft.dev.workbenches，默认关——spec「Agent 优先界面形态」）；无旗标时 BYOK 芯片与
   设置面随之退场（Agent 主面零浏览器密钥依赖）。
2. [2026-09-18 R4] lg 以下底部 Tab Bar（56px+安全区）替换顶栏 Tabs；顶栏瘦身只剩品牌+芯片。
3. [2026-09-18 Handoff] handoff 置位 → 自动切排钻设计（编程式 setView——旗标开时生效）；
   全局 Toast 唯一挂载；SettingsDialog 仅旗标开时挂载（BYOK 面随实验室退场）。
4. [4.6 openIntent] 统一意图通道四 kind 分流切视图（design §7.3/§9.2 B3）：App 只 peek 切视图、
   不 claim 不清意图——gemtpl/gemgen 由 LabView 编排消费；gemproj/gemdoc 切到对应页面占位
   （现 studio/edit 骨架；页面内加载项目归 2.x/3.x 切片，本层不清意图留给其消费）。
   [W3.2] 旗标关时意图分流不切旧工作台（导入归 5 的双模式路由）。
5. [add-project-files 2.7 全局导入 + W3.2 双模式] 顶栏隐藏 file input + 入口按钮 + 窗口级 drop
   接四格式（.gemproj/.gemdoc/.gemtpl/.gemgen——扩展名/vendor MIME 双识别，沿 PROJECT_MIME）→
   ingestProjectAsset → 按类型路由：旗标开=导航如旧（openIntent 置意图切页）；旗标关=仅入库
   （存资源+可下载，不导航旧工作台，留在 Agent 主面）；失败三段式 toast；重复导入幂等。
-->

<script lang="ts">
  import * as Tabs from '$lib/components/ui/tabs'
  import LabView from '$lib/components/views/LabView.svelte'
  import StudioView from '$lib/components/views/StudioView.svelte'
  import DesignerView from './components/Designer/DesignerView.svelte'
  import AssetsView from '$lib/components/views/AssetsView.svelte'
  import AgentView from '$lib/components/agent/AgentView.svelte'
  import AssetPickerHost from './components/Assets/AssetPickerHost.svelte'
  import SettingsDialog from './components/SettingsDialog.svelte'
  import ToastStack from './components/ToastStack.svelte'
  import { getView, setView, type ViewId } from '$lib/stores/view.svelte'
  import { getHandoff } from '$lib/stores/handoff.svelte'
  import { peekOpenIntent, setOpenIntent } from '$lib/stores/openIntent.svelte'
  import { getSettings } from '$lib/stores/lab.svelte'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import { isDevWorkbenches } from '$lib/stores/devFlag.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import { ingestProjectAsset } from '$lib/persistence/assetStore'
  import { PROJECT_MIME, projectKindOfMime, type AssetProject, type ProjectKind } from '$lib/persistence/projectTypes'
  import Gem from '@lucide/svelte/icons/gem'
  import Bot from '@lucide/svelte/icons/bot'
  import FlaskConical from '@lucide/svelte/icons/flask-conical'
  import PenLine from '@lucide/svelte/icons/pen-line'
  import FolderOpen from '@lucide/svelte/icons/folder-open'
  import FileUp from '@lucide/svelte/icons/file-up'
  import Settings2 from '@lucide/svelte/icons/settings-2'

  const view = $derived(getView())
  const settings = getSettings()
  /** [W3.2] 传统三工作台开发者旗标（默认关——默认导航只见 Agent 主面）。 */
  const devWorkbenches = $derived(isDevWorkbenches())

  /** 三项齐备才算已配置（与 startRun 的校验口径一致） */
  const configured = $derived(
    settings.baseUrl.trim() !== '' && settings.apiKey.trim() !== '' && settings.model.trim() !== '',
  )

  // 送排钻 handoff 置位 → 自动切到排钻设计（StudioView 挂载后消费并清空 handoff）。
  // [W3.2] 旗标关时旧工作台不可达——handoff 不切视图（Agent 主面不受影响）。
  $effect(() => {
    if (getHandoff() && devWorkbenches) setView('studio')
  })

  // [4.6] openIntent 统一意图通道（四 kind 单通道，B3）：App 只 peek 只切视图——不 claim
  // 不清意图（claim 归实际执行方 LabView；gemproj/gemdoc 的消费归 2.x/3.x 页面切片）。
  // 只响应 pending：claimed（LabView 接手中）/ failed（可诊断驻留态）不重复触发切视图。
  // [gem-catalog 2.2] 第五格式 gemshape：无直接消费页——切素材库定位（AssetsView claim 后
  // 导航至所在目录 + 闪高亮；「去使用」入口归 expert change 的钻形库 UI，design §3.2-3）。
  $effect(() => {
    // [W3.2] 旗标关时意图通道不切旧工作台（无旗标导入不置意图——通道只服务旧动线）。
    if (!devWorkbenches) return
    const intent = peekOpenIntent()
    if (intent === null || intent.phase !== 'pending') return
    if (intent.kind === 'gemproj') setView('studio') // 占位：排钻设计页（现 studio 骨架）
    else if (intent.kind === 'gemdoc') setView('edit') // 占位：设计师工作台页（不加载文档）
    else if (intent.kind === 'gemshape') setView('assets') // 钻形资产：素材库定位（不切走）
    else setView('lab') // gemtpl / gemgen → 实验室（LabView 七步动线消费）
  })

  function switchView(next: ViewId): void {
    setView(next)
  }

  // ---------------------------------------------------------------------------
  // [2.7 全局导入] 四格式识别 + ingest + 路由（失败三段式 toast；重复导入幂等）
  // ---------------------------------------------------------------------------

  /** 四格式扩展名识别（.gemshape 走素材库上传链路，不在本面）。 */
  const IMPORT_EXTENSIONS: Record<string, ProjectKind> = {
    '.gemproj': 'gemproj',
    '.gemdoc': 'gemdoc',
    '.gemtpl': 'gemtpl',
    '.gemgen': 'gemgen',
  }

  const IMPORT_KIND_LABEL: Record<ProjectKind, string> = {
    gemproj: '排钻工程',
    gemdoc: '精修文档',
    gemtpl: '提示词模板',
    gemgen: '生成档案',
    gemshape: '钻形资产',
  }

  /** vendor MIME 优先（无歧义）；File 无类型时回落扩展名。 */
  function projectKindOfFile(file: File): ProjectKind | null {
    if (file.type !== '') {
      const byMime = projectKindOfMime(file.type)
      if (byMime !== null && byMime !== 'gemshape') return byMime
    }
    const dot = file.name.lastIndexOf('.')
    const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : ''
    return IMPORT_EXTENSIONS[ext] ?? null
  }

  /** 导入后按类型路由：旗标开=导航如旧（openIntent 置意图切页——素材库 1.4 canonical）；
   * 旗标关=仅入库不导航（存资源+可下载，留在 Agent 主面——spec「Agent 优先界面形态」）。 */
  function routeImportedProject(node: AssetProject): void {
    if (!devWorkbenches) return
    if (node.projectKind === 'gemproj') {
      setOpenIntent({ kind: 'gemproj', assetId: node.id })
      setView('studio')
    } else if (node.projectKind === 'gemdoc') {
      setOpenIntent({ kind: 'gemdoc', assetId: node.id })
      setView('edit')
    } else if (node.projectKind === 'gemtpl' || node.projectKind === 'gemgen') {
      setOpenIntent({ kind: node.projectKind, assetId: node.id })
      setView('lab')
    }
  }

  let importInput = $state<HTMLInputElement | null>(null)

  async function importProjectFiles(fileList: FileList | File[] | null): Promise<void> {
    if (fileList === null || fileList.length === 0) return
    for (const file of Array.from(fileList)) {
      const kind = projectKindOfFile(file)
      if (kind === null) {
        // 三段式：失败事实 + 原因 + 恢复动作（留在当前页面）
        showToast(
          `无法导入「${file.name}」：不是支持的项目文件（.gemproj / .gemdoc / .gemtpl / .gemgen）。已留在当前页面，请检查文件后重试。`,
        )
        continue
      }
      try {
        // 磁盘 File 常无 vendor MIME——按识别类型重打类型（ingest 的 mime × kind × 文件内 kind 三方交叉校验）
        const blob = file.slice(0, file.size, PROJECT_MIME[kind])
        const dot = file.name.lastIndexOf('.')
        const name = dot > 0 ? file.name.slice(0, dot) : file.name
        const { node } = await ingestProjectAsset({ blob, name, projectKind: kind })
        routeImportedProject(node)
        showToast(
          devWorkbenches
            ? `已导入${IMPORT_KIND_LABEL[node.projectKind]}「${node.name}」`
            : `已存入${IMPORT_KIND_LABEL[node.projectKind]}「${node.name}」（已保存在本机素材库）`,
        )
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        showToast(`导入失败（${file.name}）：${reason}。未入库，请确认文件为本应用导出的对应格式。`)
      }
    }
  }
</script>

<svelte:window
  ondragover={(event) => event.preventDefault()}
  ondrop={(event) => {
    event.preventDefault()
    void importProjectFiles(event.dataTransfer?.files ?? null)
  }}
/>

<Tabs.Root
  value={view}
  onValueChange={(v) => {
    if (v === 'agent' || v === 'assets' || v === 'lab' || v === 'studio' || v === 'edit') switchView(v)
  }}
  class="bg-background text-foreground flex h-screen flex-col overflow-hidden"
>
  <header class="bg-background/80 flex h-12 shrink-0 items-center gap-3 border-b px-4 backdrop-blur">
    <Bot class="text-primary size-4 shrink-0" aria-hidden="true" />
    <h1 class="text-base font-semibold tracking-tight whitespace-nowrap">贴钻工作台</h1>
    <span class="text-muted-foreground hidden text-xs sm:inline">Rhinestone Studio</span>

    <!-- 桌面顶栏 Tabs（lg+）：Agent 主面常驻；旧三工作台+素材库随开发者旗标（默认隐藏）。 -->
    <div class="ml-2 hidden lg:block">
      <Tabs.List>
        <Tabs.Trigger value="agent">Agent</Tabs.Trigger>
        {#if devWorkbenches}
          <Tabs.Trigger value="assets">素材库</Tabs.Trigger>
          <Tabs.Trigger value="lab">提示词实验室</Tabs.Trigger>
          <Tabs.Trigger value="studio">排钻工作台</Tabs.Trigger>
          <Tabs.Trigger value="edit">设计师工作台</Tabs.Trigger>
        {/if}
      </Tabs.List>
    </div>

    <!-- [2.7 全局导入] 隐藏 file input + 顶栏入口按钮：四格式（.gemproj/.gemdoc/.gemtpl/.gemgen） -->
    <input
      bind:this={importInput}
      type="file"
      accept=".gemproj,.gemdoc,.gemtpl,.gemgen"
      multiple
      class="hidden"
      data-testid="app-import-input"
      onchange={(event) => {
        void importProjectFiles(event.currentTarget.files)
        event.currentTarget.value = ''
      }}
    />
    <button
      type="button"
      onclick={() => importInput?.click()}
      data-testid="app-import-button"
      class="ml-auto inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors
        border-border text-muted-foreground hover:bg-muted hover:text-foreground"
      title="导入项目文件（.gemproj / .gemdoc / .gemtpl / .gemgen，或拖入窗口）"
    >
      <FileUp class="size-3.5" aria-hidden="true" />
      <span class="hidden sm:inline">导入</span>
    </button>

    <!-- BYOK 状态芯片：随实验室隐藏退场（Agent 主面零浏览器密钥依赖——spec 服务端密钥管理）。 -->
    {#if devWorkbenches}
      <button
        type="button"
        onclick={openSettings}
        data-testid="byok-chip"
        class="inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors
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
    {/if}
  </header>

  <main class="bg-muted/40 min-h-0 min-w-0 flex-1 overflow-hidden">
    <Tabs.Content value="agent" class="h-full">
      <AgentView />
    </Tabs.Content>
    {#if devWorkbenches}
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
        <DesignerView />
      </Tabs.Content>
    {/if}
  </main>

  <!-- 移动端底部 Tab Bar（48-56px + iOS 安全区）：Agent 常驻；旧工作台随旗标。 -->
  <nav
    class="bg-background/95 supports-[backdrop-filter]:bg-background/80 sticky bottom-0 z-30 flex h-14 shrink-0 items-stretch border-t backdrop-blur pb-[env(safe-area-inset-bottom)] lg:hidden"
    aria-label="模块切换"
  >
    <button
      type="button"
      onclick={() => switchView('agent')}
      aria-current={view === 'agent' ? 'page' : undefined}
      class="flex flex-1 flex-col items-center justify-center gap-0.5 text-xs {view === 'agent'
        ? 'text-primary font-medium'
        : 'text-muted-foreground hover:text-foreground'}"
    >
      <Bot class="size-5" aria-hidden="true" />
      Agent
    </button>
    {#if devWorkbenches}
      <div class="bg-border w-px" aria-hidden="true"></div>
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
        排钻
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
        设计
      </button>
    {/if}
  </nav>
</Tabs.Root>

{#if devWorkbenches}
  <SettingsDialog />
{/if}
<AssetPickerHost />
<ToastStack />
