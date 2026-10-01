<!--
SessionStream.svelte — 会话流（zhumo 方案移植块 B，2026-09-28 组件级 1:1 换装）。
形态=zhumo ListDetailPage chatColumn：header（标题+状态+取消/清空）→ 失败/断线
横幅 → TranscriptView（转录流）→ footer（QueueDrawer + ComposerCard）。
贴钻 store 绑定保留（W10 三通道/队列外环/审批卡/暂离编辑语义全数由 zhumo 组件
树承载）：
- 三通道：ComposerCard 发送位（running 空输入=停止 / running 有输入=⚡引导+排队
  / idle=发送）——steer/stop/队列反馈走全局 toast；
- 队列：QueueDrawer（拖动排序/暂停段/模式改档/编辑/删除/清空——前端外环本地
  真源，zhumo W10m 交互全量）；
- 审批卡/策略提案卡/产物 chip/完成入口：TranscriptView 的 frame 分支走贴钻
  FrameView 原样渲染；
- composerOutbox 注入（策略参数表单指令）：ComposerCard.setPrompt 实例方法。
- 附件面（split-admin-portal 2.6.2）：rpc 模式 attachable+uploadAttachment 注入
  （file→assets.upload→BlobRef；raw 缩略 URL 走 daemonToken 存储层）——mock
  演示模式无服务端素材桥，附件位隐藏。
- 快速开始面板（quick-start-panel 2026-09-30，Owner「像 zhumo 一样开箱即用」）：
  新会话空态（无任务行/无队列）输入区上方渲染预设 chips（点选=setPrompt 填充，
  不自动发送、仍可编辑）+ 空态整面 dropzone（dragover 高亮「松开添加图片」，
  drop 收图走 ComposerCard.addFiles——与选择/粘贴同门的上传链）。三正交之一
  （预设 chips+附件拖放+自由文本兜底——zhumo TaskComposer 同款）。
-->
<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import TranscriptView from './TranscriptView.svelte'
  import QueueDrawer from './QueueDrawer.svelte'
  import ComposerCard from './ComposerCard.svelte'
  import ResultCard from './ResultCard.svelte'
  import {
    beginAgentQueueEdit,
    cancelActiveTask,
    cancelAgentQueueEdit,
    clearActiveSession,
    clearAgentQueue,
    confirmAgentQueueEdit,
    getActiveSession,
    getActiveSessionFrames,
    getActiveSessionTaskFrames,
    getActiveTask,
    getActiveTasks,
    getAgentConnection,
    getAgentEffortOverride,
    getAgentError,
    getAgentMode,
    getAgentModelOverride,
    getAgentQueue,
    getAgentQueueEditingId,
    getAgentQueueLockBoundary,
    getAgentQueueReordering,
    getBoundAgentApi,
    getPendingApproval,
    getPendingApprovals,
    getSessionResult,
    getSessionAutoApprove,
    isAgentCancelling,
    isAgentClearing,
    isAgentSending,
    lockAgentQueue,
    removeAgentQueueItem,
    reorderAgentQueue,
    sendFollowup,
    setAgentDefaultModel,
    setAgentEffortOverride,
    setAgentModelOverride,
    setAgentQueueItemMode,
    setAgentQueueReordering,
    setSessionAutoApprove,
    skipPendingApproval,
    stopActiveTask,
  } from '$lib/agentApi/store.svelte'
  import { pendingQueueItems, projectFrames } from '$lib/agentApi/transcript.svelte'
  import { assetRawUrl, type AttachmentMeta } from '$lib/agentApi/attachments'
  import { clearComposerText, peekComposerSetPreset, clearComposerSetPreset, peekComposerText } from '$lib/agentApi/composerOutbox.svelte'
  import type { AgentSetSummary } from '$lib/agentApi/types'
  import { modelsApi } from '$lib/modelsApi'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { AvailableModel, TaskDetailProjectStones } from '@handicraft/contracts'
  import Ban from '@lucide/svelte/icons/ban'
  import Boxes from '@lucide/svelte/icons/boxes'
  import Trash2 from '@lucide/svelte/icons/trash-2'

  // [add-workbench-pro 1.4] 顶栏扩展位（可选 snippet——AgentView 注入移动端「详情」按钮）。
  let { headerAction }: { headerAction?: Snippet } = $props()

  const session = $derived(getActiveSession())
  const frames = $derived(getActiveSessionFrames())
  /** 按任务分组的帧流（v6 复核 P1-5：投影携带来源 taskId——历史任务 done/审批/
   *  产物帧只路由其自身任务，不由最新任务顶替）。 */
  const taskFrames = $derived(getActiveSessionTaskFrames())
  const activeTask = $derived(getActiveTask())
  const approval = $derived(getPendingApproval())
  /**
   * [product-polish-w2 T3] 待审批队列（帧序=按序逐个处理）+expired 投影（TTL 已过
   * 或来源任务已终态——过期卡操作区变「跳过」）。非空时 ComposerCard textarea
   * 整块替换为审批 zStack，转录流的审批卡转信息态（不双开操作面）。
   */
  const pendingApprovals = $derived(
    getPendingApprovals().map((item) => ({
      ...item,
      expired:
        new Date(item.expiresAt).getTime() < Date.now() ||
        ['done', 'failed', 'cancelled'].includes(
          getActiveTasks().find((task) => task.taskId === item.taskId)?.status ?? '',
        ),
    })),
  )
  const approvalStackActive = $derived(pendingApprovals.length > 0)
  const result = $derived(getSessionResult(session?.id ?? null))
  const running = $derived(activeTask?.status === 'running' || activeTask?.status === 'queued')
  const connection = $derived(getAgentConnection())
  const disconnected = $derived(connection === 'closed' || connection === 'error')
  const queueItems = $derived(getAgentQueue())
  const queueEditingId = $derived(getAgentQueueEditingId())

  /** 转录条目（贴钻帧投影（任务分组）+ 队列待发气泡合并——zhumo W10l 同款）。 */
  const transcriptItems = $derived.by(() => {
    const projected = projectFrames(taskFrames)
    return [...projected, ...pendingQueueItems(queueItems, projected.length)]
  })

  // 可用模型（挂载即拉——zhumo 同款；失败静默隐藏 chip）。[product-polish-w2 T2]
  // 默认模型回填 store（effort-only 覆盖的模型身份源——followupModelPayload 投影）。
  let availableModels = $state<AvailableModel[] | null>(null)
  let availableDefault = $state<{ provider: string; model: string; effort?: string | null } | null>(null)
  onMount(() => {
    void (async () => {
      try {
        const out = await modelsApi().getAvailableModels()
        availableModels = out.models
        availableDefault = out.default
        setAgentDefaultModel(out.default !== null ? { provider: out.default.provider, model: out.default.model } : null)
      } catch {
        availableModels = null // mock 模式/daemon 未配路由——chip 隐藏
        setAgentDefaultModel(null)
      }
    })()
  })

  /** 活动模型上下文窗口（ContextMeter 容量；null=回退 128k 假定值）。
   *  [product-polish-w2 T2] 任务级模型覆盖优先（chip 切模型即跟随）。 */
  const activeCapacity = $derived.by(() => {
    const override = getAgentModelOverride()
    const identity =
      override !== null
        ? override
        : availableDefault !== null && availableModels !== null
          ? { provider: availableDefault.provider, model: availableDefault.model }
          : null
    const current =
      identity !== null && availableModels !== null
        ? availableModels.find((m) => m.provider === identity.provider && m.model === identity.model)
        : null
    return current?.contextWindow ?? null
  })

  let root = $state<HTMLDivElement | null>(null)
  let composerRef = $state<ComposerCard | null>(null)
  let confirmingClear = $state(false)
  /** 本实例的编辑会话（进入时回填文本；queueEditingId 为全局冻结标记）。 */
  let editingActive = $state(false)
  let editingDraft = $state<string | null>(null)

  // [add-subject-sam-pipeline P3.2] 策略参数表单指令注入：经 ComposerCard.setPrompt
  // 实例方法注入（空=直接置入，非空=换行追加——用户草稿不覆盖；消费即清空）。
  // 可见性守卫：Agent 与策略设计两个 tab 各挂一个本组件实例——隐藏实例让位。
  $effect(() => {
    const injected = peekComposerText()
    if (injected === null) return
    if (root === null || root.closest('[hidden]') !== null) return
    composerRef?.setPrompt(injected)
    clearComposerText()
  })

  /** ComposerCard 发送回调（Enter/按钮/steer 同源；文本+附件结构化载荷——2.6.2）。
   *  三通道分发在 store.sendFollowup：running+followup=入队、steer=立即投递、
   *  idle=常规开跑；通道反馈 toast 由 ComposerCard 内部发出。1.2：sourceSetId
   *  随首条消息同级投递（选择器只在新会话首条输入态出现——后续轮次不携带）。 */
  async function onComposerSend(
    text: string,
    mode: 'followup' | 'steer' = 'followup',
    attachments?: AttachmentMeta[],
    sourceSetId?: string,
  ): Promise<void> {
    if (editingActive) return // 编辑态由 onconfirmedit 承接
    await sendFollowup(text, mode, attachments ?? [], sourceSetId)
  }

  // ------------------------------------------------------------ 集合选择（1.2）

  /** 会话是否已有消息：任务行在场即有（每次常规 followup 必建 task）；队列非空
   *  亦视作已过首条（入队仅在运行中发生——首条早已发出）。 */
  const sessionStarted = $derived(taskFrames.length > 0 || queueItems.length > 0)

  /** 集合选择器可见性：仅 rpc+新会话首条输入态（W0 冻结——sourceSetId 仅首个
   *  常规 followup 有效；已有消息的会话隐藏，改显清单摘要）。 */
  const setPickerActive = $derived(getAgentMode() === 'rpc' && !sessionStarted)

  // [product-polish-w1 T2] 组合预选注入（我的材料组合卡「开工」→ createSession 后经
  // composerOutbox 单槽注入）：新会话 Composer 集合选择器预选该组合（N1 动线
  // 「挑组合→开工」一步进首条消息——发送即带 sourceSetId）。同款可见性守卫+消费
  // 即清空；仅新会话首条输入态消费（已有任务的会话选择器隐藏——注入滞留到下个
  // 新会话，不丢「开工」意图）。
  $effect(() => {
    const preset = peekComposerSetPreset()
    if (preset === null) return
    if (root === null || root.closest('[hidden]') !== null) return
    if (!setPickerActive) return
    composerRef?.presetSet(preset)
    clearComposerSetPreset()
  })

  /** 集合候选注入（rpc 真身=agentApi.listSets——sets.list 同路由摘要投影；
   *  async 形态=未绑定面拒绝进 Promise，不穿透 Composer 的惰性加载 effect）。 */
  async function loadSetOptions(): Promise<AgentSetSummary[]> {
    const api = getBoundAgentApi()
    if (api?.listSets === undefined) throw new Error('当前模式不支持集合选择')
    return api.listSets()
  }

  /** [product-polish-w1 T3] 市场组合复制注入（rpc 真身=agentApi.copyMarketSet——
   *  sets.copyFromMarket 白名单面）→副本 resourceId（Composer 发送链绑定 sourceSetId）。 */
  async function copyMarketSetInjection(resourceId: string): Promise<string> {
    const api = getBoundAgentApi()
    if (api?.copyMarketSet === undefined) throw new Error('当前模式不支持市场组合复制')
    const copy = await api.copyMarketSet(resourceId)
    return copy.resourceId
  }

  /** 项目钻清单摘要（后续轮次）：task.detail.projectStones 投影（session 锚——
   *  会话内任一 task 同投影；取最新任务读）。新会话首条未发=无 manifest 不显。 */
  let projectStones = $state<TaskDetailProjectStones | null>(null)
  $effect(() => {
    const taskId = activeTask?.taskId
    if (taskId === undefined || getAgentMode() !== 'rpc') {
      projectStones = null
      return
    }
    let cancelled = false
    projectStones = null
    void (async () => {
      try {
        const detail = await getBoundAgentApi()?.taskDetail(taskId)
        if (!cancelled) projectStones = detail?.projectStones ?? null
      } catch {
        // 详情不可用（任务已清理/旧 daemon 无投影）——摘要隐藏，不占错误面。
        if (!cancelled) projectStones = null
      }
    })()
    return () => {
      cancelled = true
    }
  })

  // ------------------------------------------------------------ 附件面（2.6）

  /** rpc 模式才开附件位（mock 演示无服务端素材桥——uploadAssetImage 仅 rpc 真身）。 */
  const attachable = $derived(getAgentMode() === 'rpc')

  // ------------------------------------------------------------ 快速开始（quick-start-panel 2026-09-30）

  /** 预设开场（点选填充，仍然可编辑；措辞覆盖贴钻真实工具面——识图排钻/样卡
   *  复刻（材料市场匹配）/多图批量（导出三件套）/精细修钻（图层分块））。 */
  const QUICK_START_PRESETS: Array<{ label: string; prompt: string }> = [
    {
      label: '识图排钻（推荐）',
      prompt:
        '请分析这张图片，识别主体轮廓并规划贴钻排布：给出对象树与策略计划，说明每块区域用的钻型、颜色与密度，然后生成可执行的排钻布局。',
    },
    {
      label: '样卡复刻',
      prompt:
        '请对照我上传的样卡图，复刻它的钻图组合：逐区匹配材料市场中最接近的钻（颜色/尺寸/形状），列出替换差异，并产出排钻布局。',
    },
    {
      label: '多图批量',
      prompt: '我会上传多张图，请每张独立开一个任务分别排钻，各自导出三件套（SVG/PNG/BOM）。',
    },
    {
      label: '精细修钻',
      prompt: '请进入精修模式，我需要逐块调整钻的密度与边界，请先给出当前布局的分块视图和可调参数。',
    },
  ]

  /** 空态拖放高亮（dragover Files 置位；dragleave 离区/落定复位）。 */
  let quickDragActive = $state(false)
  /** 空态拖放区激活门：新会话（无任务行/无队列）+rpc 附件面（mock 无上传链不接拖放）。 */
  const quickDropActive = $derived(!sessionStarted && attachable)

  function onQuickDragover(event: DragEvent): void {
    if (!quickDropActive) return
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    quickDragActive = true
  }

  function onQuickDragleave(event: DragEvent): void {
    const zone = event.currentTarget
    const next = event.relatedTarget
    if (zone instanceof Node && next instanceof Node && zone.contains(next)) return
    quickDragActive = false
  }

  /** 空态整面收图：drop→ComposerCard.addFiles（过滤/尺寸/数量/去重/上传同门）。 */
  function onQuickDrop(event: DragEvent): void {
    quickDragActive = false
    if (!quickDropActive) return
    const files = event.dataTransfer?.files
    if (files === undefined || files.length === 0) return
    event.preventDefault()
    composerRef?.addFiles(files)
  }

  /** 上传注入：api.uploadAssetImage（file→base64→[非 PNG 先 canvas 归一转 PNG]→
   * assets.upload→BlobRef+宽高）→ComposerAttachment（rawUrl 预览闭包——token 渲染
   * 时现读，登录态代际跟随）。W5 P0-2：转换事实双呈现——chip「已转 PNG」徽标
   * （convertedToPng 随 AttachmentMeta 流转）+ 全局 toast。 */
  async function uploadAttachment(file: File): Promise<{
    blobRef: string
    name: string
    mime: string
    width: number
    height: number
    size: number
    rawUrl: (width?: number) => string
  }> {
    const api = getBoundAgentApi()
    if (api?.uploadAssetImage === undefined) throw new Error('当前模式不支持图片上传')
    const uploaded = await api.uploadAssetImage(file)
    if (uploaded.convertedToPng) showToast(`「${file.name}」已转换为 PNG 上传`)
    return {
      ...uploaded,
      size: file.size,
      rawUrl: () => assetRawUrl(uploaded.blobRef),
    }
  }

  // ------------------------------------------------------------ 队列编辑（W10b 暂离编辑）

  /** 进入编辑：输入框有未发送内容拒绝（Owner 设计）；文本回填，全局冻结自动开跑。 */
  function onQueueEdit(id: string): void {
    if (editingActive) return
    if ((composerRef?.draftLength() ?? 0) > 0) {
      showToast('输入框有未发送内容——发送或清空后再编辑排队消息')
      return
    }
    const text = beginAgentQueueEdit(id)
    if (text === null) return
    editingDraft = text
    editingActive = true
  }

  function onQueueEditCancel(): void {
    editingActive = false
    editingDraft = null
    composerRef?.setPrompt('') // 贴钻语义：取消=队列原样放回 + composer 清空
    cancelAgentQueueEdit()
  }

  function onQueueEditConfirm(text: string): void {
    editingActive = false
    editingDraft = null
    confirmAgentQueueEdit(text)
  }

  function onClear(): Promise<void> {
    if (!confirmingClear) {
      confirmingClear = true
      showToast('再次点击确认清空：会话、任务与私有资源将被回收（分享链接保留）')
      return Promise.resolve()
    }
    confirmingClear = false
    return clearActiveSession()
  }
</script>

{#if session === null}
  <div class="text-muted-foreground flex h-full items-center justify-center text-sm" bind:this={root}>选择或创建一个会话开始</div>
{:else}
  <div class="bg-background flex h-full min-h-0 flex-col" data-testid="agent-stream" bind:this={root}>
    <header class="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      <h2 class="truncate text-sm font-semibold" data-testid="agent-stream-title">{session.title}</h2>
      <!-- 状态 pill 中文化+实心化（zhumo 对照清单 T5）：最近任务状态——「进行中」
           （running/queued，primary 砖红底白字 9px）/「失败」（destructive 实心同款）/
           「已完成」（secondary）；无任务不占位（替换原英文「active」灰 pill）。 -->
      {#if activeTask !== null}
        {#if activeTask.status === 'running' || activeTask.status === 'queued'}
          <Badge class="shrink-0 text-[9px]" data-testid="agent-task-status">进行中</Badge>
        {:else if activeTask.status === 'failed'}
          <Badge class="bg-destructive text-destructive-foreground shrink-0 text-[9px]" data-testid="agent-task-status">失败</Badge>
        {:else if activeTask.status === 'done'}
          <Badge variant="secondary" class="shrink-0 text-[9px]" data-testid="agent-task-status">已完成</Badge>
        {/if}
      {/if}
      <!-- [product-polish-w2 T1] 项目钻清单摘要（从输入区上方迁入——与「进行中」同类
           的任务状态消息；title 显全量信息）。 -->
      {#if sessionStarted && projectStones !== null}
        <span
          class="text-muted-foreground flex min-w-0 shrink items-center gap-1 truncate rounded-md border border-border bg-muted/30 px-1.5 py-0.5 text-[10px]"
          data-testid="composer-project-stones"
          title="项目钻清单：{projectStones.sourceSetName ?? '未引入集合'} · {projectStones.entryCount} 款钻 · revision {projectStones.revision}（任务中可追加钻——追加走任务内 stones.add）"
        >
          <Boxes class="h-3 w-3 shrink-0" aria-hidden="true" />
          <!-- 单行插值（Svelte 行内空白折叠——数字段不跨行拼）。 -->
          <span class="truncate">{projectStones.entryCount} 款钻 · rev {projectStones.revision}</span>
        </span>
      {/if}
      <div class="ml-auto flex items-center gap-1.5">
        {@render headerAction?.()}
        {#if running}
          <Button size="sm" variant="ghost" data-testid="agent-cancel" disabled={isAgentCancelling()} onclick={cancelActiveTask}>
            <Ban class="size-3.5" aria-hidden="true" />
            取消任务
          </Button>
        {/if}
        <Button
          size="sm"
          variant="ghost"
          data-testid="agent-clear"
          class="text-destructive hover:text-destructive"
          disabled={isAgentClearing()}
          onclick={onClear}
        >
          <Trash2 class="size-3.5" aria-hidden="true" />
          清空会话
        </Button>
      </div>
    </header>

    {#if getAgentError()}
      <div class="border-destructive/30 bg-destructive/10 text-destructive px-4 py-1.5 text-xs" data-testid="agent-error">
        {getAgentError()}
      </div>
    {/if}
    {#if disconnected}
      <div class="bg-muted text-muted-foreground px-4 py-1.5 text-xs" data-testid="agent-disconnected">
        连接已断开，正在重连——恢复后将按已收帧游标自动回放补齐
      </div>
    {/if}

    <!-- 新会话空态整面拖放区（quick-start）：无消息+rpc 附件面在场时激活——
         dragover 高亮「松开添加图片」，drop 收图走 ComposerCard.addFiles。 -->
    <div
      class="relative flex min-h-0 flex-1 flex-col"
      role="region"
      aria-label="对话转录区，新会话支持拖入图片"
      data-testid={quickDropActive ? 'quick-start-dropzone' : undefined}
      ondragover={onQuickDragover}
      ondragleave={onQuickDragleave}
      ondrop={onQuickDrop}
    >
      <TranscriptView
        items={transcriptItems}
        {running}
        emptyHint="描述你想做的贴钻作品——例如：帮我把这张爱心线稿排满红色圆钻，密度高一点"
        pendingRequestId={approval?.requestId ?? null}
        suppressApprovalActions={approvalStackActive}
      />
      {#if quickDragActive}
        <!-- 拖放高亮（pointer-events-none——事件面仍归本容器，不劫持 drag 序列）。 -->
        <div
          class="pointer-events-none absolute inset-3 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 text-sm font-medium text-primary"
          data-testid="quick-start-drag-overlay"
        >
          松开添加图片
        </div>
      {/if}
    </div>

    {#if result && (activeTask?.status === 'done' || frames.some((f) => f.kind === 'done'))}
      <div class="border-t px-4 py-3">
        <ResultCard {result} />
      </div>
    {/if}

    <footer class="border-t p-3">
      {#if !sessionStarted}
        <!-- 快速开始面板（quick-start-panel 2026-09-30）：新会话空态输入区上方
             预设 chips——点选=填充（不自动发送、仍可编辑），与附件/集合选择三正交。 -->
        <div class="mb-2" data-testid="quick-start-presets">
          <p class="mb-1.5 text-[11px] text-muted-foreground">快速开始——点选预设填充输入框，或直接拖入图片</p>
          <div class="flex flex-wrap gap-1.5">
            {#each QUICK_START_PRESETS as preset (preset.label)}
              <button
                type="button"
                class="rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-foreground/80 transition-colors hover:border-primary/50 hover:bg-accent-soft"
                data-testid="quick-start-preset"
                onclick={() => composerRef?.setPrompt(preset.prompt)}
              >
                {preset.label}
              </button>
            {/each}
          </div>
        </div>
      {/if}
      <!-- [product-polish-w2 T1/T2] 项目钻清单摘要迁 header、自动批准迁 ComposerCard
           工具行（toggleButton）——footer 输入区上方只留消息队列手风琴（QueueDrawer，
           zhumo 拼卡位对齐）。 -->
      <!-- 队列抽屉（zhumo W10c/W10m 形态——外环本地真源：拖动排序/暂停段/改模式/编辑）。 -->
      <QueueDrawer
        items={queueItems}
        lockBoundary={getAgentQueueLockBoundary()}
        editingId={queueEditingId}
        reordering={getAgentQueueReordering()}
        running={running}
        onedit={onQueueEdit}
        oncancel={onQueueEditCancel}
        onremove={removeAgentQueueItem}
        onsetmode={setAgentQueueItemMode}
        onlock={lockAgentQueue}
        onreorder={reorderAgentQueue}
        onreordering={setAgentQueueReordering}
        onclear={clearAgentQueue}
      />
      <!-- [product-polish-w2 T2/T3] 工具行接线：模型/强度 chip 任务级覆盖（zhumo 语义
           null=跟随默认——store 会话域真源，随下一次 followup 携带）；自动批准 toggle
           从状态条迁入（rpc 域注入，逻辑不动）；审批 zStack（帧序队列+expired 投影，
           跳过=本地清卡）。 -->
      <ComposerCard
        bind:this={composerRef}
        onsend={(text, mode, attachments, sourceSetId) => void onComposerSend(text, mode, attachments, sourceSetId)}
        onstop={() => void stopActiveTask()}
        editingActive={editingActive}
        editingDraft={editingDraft}
        onconfirmedit={onQueueEditConfirm}
        oncanceledit={onQueueEditCancel}
        sending={isAgentSending()}
        disabled={session.status !== 'active'}
        models={availableModels}
        defaultModel={availableDefault}
        {running}
        capacity={activeCapacity}
        attachable={attachable}
        uploadAttachment={attachable ? uploadAttachment : undefined}
        loadSetOptions={setPickerActive ? loadSetOptions : undefined}
        copyMarketSet={setPickerActive ? copyMarketSetInjection : undefined}
        placeholder={!sessionStarted ? '点上方预设可快速填充，填充后仍可自由修改…' : undefined}
        triggers={false}
        currentModel={getAgentModelOverride()}
        currentEffort={getAgentEffortOverride()}
        onsetmodel={(provider, model) => setAgentModelOverride(provider, model)}
        onseteffort={(effort) => setAgentEffortOverride(effort)}
        autoApprove={attachable ? getSessionAutoApprove() : null}
        onsetautoapprove={setSessionAutoApprove}
        approvals={pendingApprovals}
        onskipapproval={skipPendingApproval}
      />
    </footer>
  </div>
{/if}
