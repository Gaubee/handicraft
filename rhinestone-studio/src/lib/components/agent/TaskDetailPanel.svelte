<!--
TaskDetailPanel.svelte — 任务详情面板（task-detail-tabs 2026-10-02：Owner 验收反馈
「任务详情体验差——参考 zhumo 多 tabs 结构：详情预览任务+结果链接+工作台链接，
结果（iframe）与工作台（page-component）分 tab 打开」）。
多标签浏览器隐喻（zhumo TaskDetailPanel 同构）：
  [详情]（固定首 tab）：任务预览——状态徽标（排钻中 Ns/已完成/失败）+输入图预览卡
    （[Owner 2026-10-02]当前正在处理的原图——任务首条消息附件/纯文本延续跟随上一
    任务；缩略点击 Lightbox 大图）+「共 N 颗·M 款」
    徽标（product-polish-w1 T2/T3 gemSummary 迁入）+top 款钻 chips+元数据行（创建
    时间/模型/用时）+导出结果列表卡（session.exports——每 imageId 最新一组；行点击
    开对应结果 tab）+工作台入口卡（「打开工作台」→工作台 tab）+工件清单卡（zhumo
    对照清单 T2 旧读面保留——折叠收纳）。
  [活动]（[4] 固定第二 tab）：任务会话投影时间线（activity 帧 running+终态按
    activityId 配对——TaskActivityTimeline；badge=进行中条目数）。
  [工作台]（固定 tab，page-component 非 iframe）：挂 TaskWorkbenchView（embedded——
    工作台紧凑形态原样搬入 tab；打开时挂载、切走保活不重载——bits-ui Tabs.Content
    常驻挂载+hidden 属性，画布状态/装载门（presence.svelte.ts）零改）。
  [结果 tabs]（每导出一 tab）：iframe 开 /r/{publicId} 分享页（daemon 服务端最小
    HTML；sandbox 同 zhumo；常驻保活）+地址栏工具行（后退/前进/刷新/网址 Enter
    跳转/外链/关闭）——动作不内嵌标签（易误触，zhumo 改版同款）。
  数据面：结果 tabs=会话域 exports（session.exports RPC——复用 MyMaterials
tasks.svelte.ts 读面 ensure/reload/getMyTaskExports，不另开真源）**按任务收窄**
（source/exportedBy 双锚=本任务的导出——走查 2026-10-02：打开其它任务详情时
不静默沿用旧任务导出）；rpc 通道或注入客户端才拉取（mock 演示不空转重连 WS）；
任务终态 done 强制重取（导出随任务落库）。
tab 管理：结果 tab 可关闭（地址栏 X）；标签行横滚；任务切换回详情+保活态重建；
活动结果 tab 的导出消失（重导/撤销）回退详情。单实例：桌面第三栏与移动 Sheet 经
AgentView 同一 snippet 渲染（不双挂）。
[studio-tab-bar 2026-10-02（Owner 验收反馈）] 面板头按钮清理：桌面零按钮
（「继续对话」「完整工作台」退场——详情 tab 已有「打开工作台」入口卡）；tab 栏
升级 studio-tab-bar 形态（zhumo iframe-tab-bar 同构）：tabs 行（严格单行——
overflow-y 锁死，多 tab 只横滚）+右端固定动作区=「打开完整工作台」open
icon-button（跳转入口收敛到此）+移动端关闭钮（收详情 Sheet——onclose 注入）。
[fixture 边界 2026-10-02] mock 模式：款钻 chips 贴图走 hex 色卡占位
（agentStoneTextureUrl）、工件行外链退场改演示标注——虚拟引用不拼 daemon URL。
-->

<script lang="ts">
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Tabs from '$lib/components/ui/tabs'
  import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
  import TaskActivityTimeline from './TaskActivityTimeline.svelte'
  import { openStudioTask } from '$lib/stores/view.svelte'
  import {
    getActiveSession,
    getActiveSessionId,
    getActiveSessionTaskFrames,
    getActiveTasks,
    getAgentDefaultModel,
    getAgentMode,
    getAgentModelOverride,
  } from '$lib/agentApi/store.svelte'
  import { assetRawUrl, attachmentMetasOf, retryRawImageOnError } from '$lib/agentApi/attachments'
  import { agentAssetUrl, isAgentMockMode } from '$lib/agentApi/assetBoundary'
  import { isImageArtifactName } from '$lib/agentApi/artifactKind'
  import {
    ensureMyTaskExports,
    getMyTaskExports,
    isMyTasksClientBound,
    reloadMyTaskExports,
  } from '$lib/myMaterials/tasks.svelte'
  import Lightbox from './Lightbox.svelte'
  import {
    GEM_COUNT_CALIBER_TITLE,
    agentStoneTextureUrl,
    taskGemSummaries,
    taskLayoutRefsOfFrames,
    taskLayoutRefsOfTaskGroups,
    type GemStoneUsage,
  } from '$lib/agentApi/gemSummary.svelte'
  import { activityRunningCount, activeElapsedMs } from '$lib/agentApi/activity.svelte'
  import type { Frame, TaskStatus } from '@handicraft/contracts'
  import ActivityIcon from '@lucide/svelte/icons/activity'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import ArrowRight from '@lucide/svelte/icons/arrow-right'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import FileText from '@lucide/svelte/icons/file-text'
  import Gem from '@lucide/svelte/icons/gem'
  import ImageIcon from '@lucide/svelte/icons/image'
  import Layers from '@lucide/svelte/icons/layers'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import RotateCw from '@lucide/svelte/icons/rotate-cw'
  import X from '@lucide/svelte/icons/x'

  let {
    taskId,
    onclose,
  }: {
    /** 活跃会话最新任务（followup 进行中跟随切换）。 */
    taskId: string
    /** [studio-tab-bar] 移动端关闭钮（收详情 Sheet——AgentView 注入；按钮自身
     *  md:hidden 桌面不显）。 */
    onclose?: () => void
  } = $props()

  // ---------------------------------------------------------------- tab 管理

  /** 活动 tab：detail（固定）/ workbench（固定）/ 结果=publicId。 */
  let active = $state<string>('detail')
  /** 工作台首开后常挂（保活——切走 hidden 不卸载，画布状态不丢）。 */
  let workbenchOpened = $state(false)

  /** 任务切换：回详情 tab；工作台/结果保活态随任务重建（画布属旧任务）；导出
   *  面板状态随任务重置（走查 2026-10-02 minor：结果 iframe/地址记录不静默沿用
   *  旧任务——导出清单本身按任务收窄见 exportGroups）。基线在 effect 内记（挂载轮
   *  只记不重置）——effect 首刷前用户已切 tab（测试 helper 同步点击路径）不被回打。 */
  let lastTaskId: string | null = null
  $effect(() => {
    const current = taskId
    if (lastTaskId === null) {
      lastTaskId = current
      return
    }
    if (current === lastTaskId) return
    lastTaskId = current
    untrack(() => {
      active = 'detail'
      workbenchOpened = false
      urlDraft = ''
      frames = {}
      urls = {}
    })
  })

  /** 工作台 tab 激活（触发器点击或入口卡按钮）→ 首开挂载后常驻。 */
  $effect(() => {
    if (active === 'workbench') workbenchOpened = true
  })

  /** 固定 tab 值集（详情/活动/工作台——其余值域=结果 publicId）。 */
  const FIXED_TABS = new Set(['detail', 'activity', 'workbench'])

  function isResultTab(value: string): boolean {
    return !FIXED_TABS.has(value)
  }

  function openWorkbenchTab(): void {
    workbenchOpened = true
    active = 'workbench'
  }

  // ---------------------------------------------------------------- 任务状态与预览元数据

  const taskStatus = $derived(getActiveTasks().find((task) => task.taskId === taskId)?.status ?? null)
  const taskRunning = $derived(taskStatus === 'running' || taskStatus === 'queued')

  /** 状态徽标（MyTasksSection 同款中性色族——running 显实排秒数走 elapsedSec）。 */
  const STATUS_BADGE: Record<TaskStatus, { label: string; cls: string }> = {
    queued: { label: '排队中', cls: 'bg-muted text-muted-foreground' },
    running: { label: '排钻中', cls: 'bg-primary/10 text-primary' },
    done: { label: '已完成', cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' },
    failed: { label: '失败', cls: 'bg-destructive/10 text-destructive' },
    cancelled: { label: '已取消', cls: 'bg-muted text-muted-foreground' },
  }

  /** 该任务帧组（首帧 ts=创建时间代理；末帧 ts=终态收口）。 */
  const taskFrames = $derived(
    getActiveSessionTaskFrames().find((group) => group.taskId === taskId)?.frames ?? [],
  )
  /** [4] 进行中活动数（「活动」tab 触发器 badge——未配对 running 口径）。 */
  const activityRunning = $derived(activityRunningCount(taskFrames))
  const taskFirstTs = $derived(taskFrames[0]?.ts ?? null)

  /** 运行中秒表（排钻中 Ns——活跃口径起算；终态冻结在活跃累计）。 */
  let nowTs = $state(Date.now())
  $effect(() => {
    if (!taskRunning) return
    const timer = setInterval(() => {
      nowTs = Date.now()
    }, 1000)
    return () => clearInterval(timer)
  })
  /** 用时=活跃工作时长口径（走查 2026-10-02「用时 75222s」跨天帧污染修正：
   *  累加 <30min 的相邻帧间隔——挂机/跨天空闲段不计入；终态=帧间累计收口，
   *  运行中=+末帧→now 尾段（尾段同样受阈值约束）。 */
  const elapsedSec = $derived(
    taskFrames.length > 0
      ? Math.max(0, Math.round((activeElapsedMs(taskFrames, taskRunning ? nowTs : undefined) ?? 0) / 1000))
      : null,
  )

  const session = $derived(getActiveSession())
  const createdAtLabel = $derived.by(() => {
    const fallback = session?.createdAt !== undefined ? Date.parse(session.createdAt) : Number.NaN
    const ts = taskFirstTs ?? fallback
    return Number.isFinite(ts)
      ? new Date(ts).toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
      : '—'
  })
  const modelLabel = $derived.by(() => {
    const model = getAgentModelOverride() ?? getAgentDefaultModel()
    return model === null ? '后台默认' : `${model.provider} / ${model.model}`
  })

  function timeLabel(iso: string): string {
    const date = new Date(iso)
    return `${date.getMonth() + 1}-${date.getDate()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  // ------------------------------------------------------------ 总钻数（T2/T3 迁入）

  /**
   * 该任务（会话域）全部 task-layout 摘要（多图逐图；null 项=未就绪——就绪后
   * $state 自动重渲）。w20 走查 major-2：终态任务的引用集取**整个会话**的任务组
   * （面板任务无 layout 帧——导出任务/识图任务——时回退会话内最新排钻布局，
   * 跨任务读经 sourceTaskId 按来源归档；任务详情=会话投影语义）。运行中任务
   * 不回退（仅本任务帧——重排钻期旧布局数字=stale，「排钻中…」占位语义保留）。
   */
  const gemSummaries = $derived.by(() => {
    const groups = getActiveSessionTaskFrames()
    const refs = taskRunning
      ? taskLayoutRefsOfFrames(groups.find((group) => group.taskId === taskId)?.frames ?? [])
      : taskLayoutRefsOfTaskGroups(groups)
    return taskGemSummaries(taskId, refs).filter(
      (summary): summary is NonNullable<typeof summary> => summary !== null,
    )
  })

  /** 面板徽标口径：跨图合计颗数+去重款数；逐款用量跨图合并（同款颗数相加）。 */
  const gemBadge = $derived.by(() => {
    if (gemSummaries.length === 0) return null
    const byRef = new Map<string, GemStoneUsage>()
    let total = 0
    for (const summary of gemSummaries) {
      total += summary.totalGems
      for (const stone of summary.stones) {
        const existing = byRef.get(stone.stoneRef)
        if (existing !== undefined) existing.count += stone.count
        else byRef.set(stone.stoneRef, { ...stone })
      }
    }
    const stones = [...byRef.values()].sort(
      (a, b) => b.count - a.count || (a.stoneRef < b.stoneRef ? -1 : a.stoneRef > b.stoneRef ? 1 : 0),
    )
    return { total, stones }
  })

  /** chips 折叠（T2：top 5 款 + 其余「+K 款」——工件清单卡同款折叠形态）。 */
  const GEM_CHIP_TOP_N = 5
  let gemChipsOpen = $state(false)
  const gemChipHidden = $derived(gemBadge !== null ? Math.max(0, gemBadge.stones.length - GEM_CHIP_TOP_N) : 0)
  const gemChipStones = $derived(
    gemBadge === null ? [] : gemChipsOpen || gemBadge.stones.length <= GEM_CHIP_TOP_N ? gemBadge.stones : gemBadge.stones.slice(0, GEM_CHIP_TOP_N),
  )

  // ---------------------------------------------------------------- 导出结果（session.exports 复用）

  const sessionId = $derived(getActiveSessionId())

  /** 导出读面可达（rpc 通道或已注入客户端——mock 演示不空转重连 WS）。 */
  const exportsReadable = $derived(getAgentMode() === 'rpc' || isMyTasksClientBound())

  /** [fixture 边界] mock 演示模式：工件/贴图虚拟引用不拼 daemon URL（占位/标注）。 */
  const isMock = $derived(isAgentMockMode())

  const exportsState = $derived(sessionId !== null ? getMyTaskExports(sessionId) : undefined)
  const exportsLoading = $derived(exportsState === undefined || exportsState.status === 'loading')
  const exportsError = $derived(
    exportsState !== undefined && exportsState.status === 'error' ? exportsState.message : null,
  )
  /** 结果 tab 集（每 imageId 最新一组——reloadMyTaskExports 刷新后自动重渲）。
   *  走查 2026-10-02 minor（静默重绑）：清单按任务收窄——只列本任务锚定的导出
   *  （sourceTaskId=本任务布局 / exportedByTaskId=本任务执行导出，双锚=「本任务
   *  的导出」；followup 导出任务与其源排钻任务各自可见）。打开其它任务详情时
   *  导出面板不再静默沿用旧任务的导出。 */
  const exportGroups = $derived.by(() => {
    if (exportsState === undefined || exportsState.status !== 'ready') return []
    return exportsState.groups.filter(
      (group) => group.latest.sourceTaskId === taskId || group.latest.exportedByTaskId === taskId,
    )
  })

  /** 取数编排：会话/任务切换拉清单（ensure 幂等）；任务完成态强制重取（导出随任务落库）。
   *  untrack 必需：ensure/reload 的同步段读 exportsBySession（幂等门）——不隔离会把
   *  该键收进 effect 依赖，reload 的 delete+重写每次落定都再触发自身（异步死循环）。 */
  $effect(() => {
    const sid = sessionId
    const status = taskStatus
    void taskId
    if (sid === null || !exportsReadable) return
    untrack(() => {
      void (status === 'done' ? reloadMyTaskExports(sid) : ensureMyTaskExports(sid))
    })
  })

  /** 活动结果 tab 的导出消失（重导/撤销）→ 回退详情。 */
  $effect(() => {
    if (!isResultTab(active)) return
    if (!exportGroups.some((group) => group.latest.publicId === active)) active = 'detail'
  })

  /** imageId → 展示名（image-1→「图 1」——MyTasksSection 同口径）。 */
  function imageLabel(imageId: string): string {
    const match = /^image-(\d+)$/.exec(imageId)
    return match === null ? imageId : `图 ${Number(match[1]!)}`
  }

  // ---------------------------------------------------------------- 结果地址栏（iframe 导航）

  /** 每个结果 tab 的 iframe 引用与当前地址（同源可读 contentWindow.location）。 */
  let frames = $state<Record<string, HTMLIFrameElement | null>>({})
  let urls = $state<Record<string, string>>({})
  let urlDraft = $state('')

  function resultUrl(publicId: string): string {
    return `${location.origin}/r/${encodeURIComponent(publicId)}`
  }

  /** 切到结果 tab 时同步地址输入框。 */
  $effect(() => {
    if (!isResultTab(active)) return
    const shown = urls[active] ?? resultUrl(active)
    if (urlDraft !== shown) urlDraft = shown
  })

  function activeFrame(): HTMLIFrameElement | null {
    return isResultTab(active) ? (frames[active] ?? null) : null
  }

  function navBack(): void {
    activeFrame()?.contentWindow?.history.back()
  }

  function navForward(): void {
    activeFrame()?.contentWindow?.history.forward()
  }

  function navReload(): void {
    const frame = activeFrame()
    if (frame?.contentWindow) frame.contentWindow.location.reload()
    else if (frame) frame.src = frame.src
  }

  function navGo(): void {
    const frame = activeFrame()
    const input = urlDraft.trim()
    if (frame === null || input.length === 0) return
    const target = /^https?:\/\//.test(input)
      ? input
      : `${location.origin}${input.startsWith('/') ? '' : '/'}${input}`
    frame.src = target
    urlDraft = target
    if (isResultTab(active)) urls[active] = target
  }

  function onFrameLoad(publicId: string): void {
    try {
      const href = frames[publicId]?.contentWindow?.location.href
      if (href) {
        urls[publicId] = href
        if (active === publicId) urlDraft = href
      }
    } catch {
      // 跨源（用户在地址栏跳去外站）：不可读，保持已输入值。
    }
  }

  function openExternal(): void {
    if (!isResultTab(active)) return
    window.open(urls[active] ?? resultUrl(active), '_blank', 'noopener')
  }

  function closeResultTab(): void {
    if (isResultTab(active)) active = 'detail'
  }

  // ---------------------------------------------------------------- 工件清单（zhumo 对照清单 T2 旧读面保留）

  /** 工件清单：来源任务的 artifact 帧——相邻同名去重（与 transcript 投影同口径）。 */
  const artifacts = $derived.by(() => {
    const groups = getActiveSessionTaskFrames()
    const framesOfTask = groups.find((group) => group.taskId === taskId)?.frames ?? []
    const out: Array<{ key: string; name: string; blobRef?: string }> = []
    for (const frame of framesOfTask) {
      if (frame.kind !== 'artifact') continue
      const name = frame.payload.name ?? '产物'
      const prev = out[out.length - 1]
      if (prev !== undefined && prev.name === name) continue
      const blobRef = frame.payload.blobRef
      out.push({ key: `${out.length}-${name}`, name, ...(blobRef !== undefined ? { blobRef } : {}) })
    }
    return out
  })

  /**
   * [w17-critic T5] 图片类工件 → 应用内 Lightbox（items=该任务全部图片类工件——
   * 就近可左右切全组；blobRef 缺席的行不进组）。外链新窗口只作 Lightbox 内保底。
   */
  const imageArtifacts = $derived(
    artifacts
      .filter((art) => art.blobRef !== undefined && isImageArtifactName(art.name))
      .map((art) => ({ blobRef: art.blobRef!, name: art.name })),
  )
  let lightboxIndex = $state<number | null>(null)

  let artifactsOpen = $state(false)

  // ------------------------------------------------------------ 输入图预览（Owner 2026-10-02）

  /**
   * [Owner 2026-10-02「任务详情应该要有当前正在处理的图片的预览」] 输入图投影：
   * 真源=当前任务首个携带附件的 user transcript 帧（followup attachments 线字段——
   * 服务端入线校验后的宽高/媒体类型真相）；纯文本延续任务（无附件帧）回退跟随
   * 会话内上一个带附件任务（任务详情=会话投影语义——与 gemSummaries 终态回退
   * 同式）；全会话无图不渲染占位。
   */
  function firstAttachmentsOf(frames: Frame[]): Array<{ blobRef: string; name: string }> | null {
    for (const frame of frames) {
      if (frame.kind !== 'transcript' || frame.payload.role !== 'user') continue
      const metas = attachmentMetasOf(frame.payload)
      if (metas !== undefined && metas.length > 0) {
        return metas.map((meta) => ({ blobRef: meta.blobRef, name: meta.name }))
      }
    }
    return null
  }

  const inputImages = $derived.by(() => {
    const groups = getActiveSessionTaskFrames()
    const own = firstAttachmentsOf(groups.find((group) => group.taskId === taskId)?.frames ?? [])
    if (own !== null) return own
    const index = groups.findIndex((group) => group.taskId === taskId)
    for (let i = index - 1; i >= 0; i -= 1) {
      const found = firstAttachmentsOf(groups[i]?.frames ?? [])
      if (found !== null) return found
    }
    return []
  })

  /** Lightbox 统一图组：输入图在前+图片工件在后（左右切全组，单一实例复用）。 */
  const lightboxItems = $derived([...inputImages, ...imageArtifacts])

  /** 工件行点击的 Lightbox 序（输入图偏移后）。 */
  function artifactLightboxIndex(blobRef: string): number {
    const index = imageArtifacts.findIndex((item) => item.blobRef === blobRef)
    return index >= 0 ? inputImages.length + index : 0
  }
</script>

<div class="bg-background flex h-full min-h-0 flex-col" data-testid="task-detail-panel">
  <Tabs.Root bind:value={active} class="gap-0 flex h-full min-h-0 flex-1 flex-col">
    <!-- [studio-tab-bar] 标签行 = 可横滚 tabs（严格单行——overflow-y 锁死：横向
         滚动条出现时不再连带撑出垂直滚动条）+ 右端固定动作区（open icon-button
         跳完整工作台；移动端附关闭钮收详情 Sheet）。 -->
    <div class="flex shrink-0 items-stretch border-b" data-testid="studio-tab-bar">
      <Tabs.List
        variant="line"
        class="h-9 min-w-0 flex-1 justify-start gap-1 overflow-x-auto overflow-y-hidden rounded-none border-none px-1.5"
        aria-label="任务详情标签组"
        data-testid="task-detail-tabs"
      >
        <Tabs.Trigger value="detail" class="flex-none gap-1.5 px-2.5 text-xs" data-testid="task-detail-tab-detail">
          <FileText class="size-3.5" aria-hidden="true" />
          任务详情
        </Tabs.Trigger>
        <!-- [4] 活动 tab（固定第二——详情之后、工作台之前）：任务会话投影时间线；
             badge=进行中条目数（未配对 running>0 才显）。 -->
        <Tabs.Trigger value="activity" class="flex-none gap-1.5 px-2.5 text-xs" data-testid="task-detail-tab-activity">
          <ActivityIcon class="size-3.5" aria-hidden="true" />
          活动
          {#if activityRunning > 0}
            <span
              class="bg-primary text-primary-foreground ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums"
              data-testid="task-detail-tab-activity-badge"
              title="进行中的工具调用"
            >{activityRunning}</span>
          {/if}
        </Tabs.Trigger>
        <Tabs.Trigger value="workbench" class="flex-none gap-1.5 px-2.5 text-xs" data-testid="task-detail-tab-workbench">
          <Layers class="size-3.5" aria-hidden="true" />
          工作台
        </Tabs.Trigger>
        {#each exportGroups as group (group.imageId)}
          <Tabs.Trigger
            value={group.latest.publicId}
            class="flex-none px-2.5 text-xs"
            data-testid="task-detail-tab-result"
            data-public-id={group.latest.publicId}
            title="{imageLabel(group.imageId)} 导出分享页（{group.latest.publicId}）"
          >
            {imageLabel(group.imageId)}
          </Tabs.Trigger>
        {/each}
      </Tabs.List>
      <!-- 右端固定动作区（studio-tab-bar）：open icon-button=完整工作台跳转的唯一
           入口（Owner 裁决——详情 tab 的「打开工作台」入口卡保留，面板头文字钮
           退场）；移动端关闭钮（md:hidden——收详情 Sheet，zhumo 同位形态）。 -->
      <div class="flex shrink-0 items-center gap-1 border-l px-1.5" data-testid="task-detail-actions">
        <Button
          size="icon-sm"
          variant="ghost"
          class="size-7"
          onclick={() => openStudioTask(taskId)}
          data-testid="task-detail-open-workbench"
          aria-label="打开完整工作台"
          title="打开完整工作台（同会话继续——无状态迁移）"
        >
          <ExternalLink class="size-3.5" aria-hidden="true" />
        </Button>
        {#if onclose !== undefined}
          <Button
            size="icon-sm"
            variant="ghost"
            class="size-7 md:hidden"
            onclick={onclose}
            data-testid="task-detail-close"
            aria-label="收起任务面板"
            title="收起任务面板"
          >
            <X class="size-3.5" aria-hidden="true" />
          </Button>
        {/if}
      </div>
    </div>

    {#if isResultTab(active)}
      <!-- 结果地址栏：后退/前进/刷新 + 网址 + 浏览器打开 + 关闭 tab（动作不污染 tabs）。 -->
      <div class="bg-card flex shrink-0 items-center gap-1 border-b px-2 py-1.5" data-testid="task-detail-result-toolbar">
        <Button size="icon-sm" variant="ghost" class="size-7" aria-label="后退" data-testid="task-detail-result-back" onclick={navBack}>
          <ArrowLeft class="size-3.5" aria-hidden="true" />
        </Button>
        <Button size="icon-sm" variant="ghost" class="size-7" aria-label="前进" data-testid="task-detail-result-forward" onclick={navForward}>
          <ArrowRight class="size-3.5" aria-hidden="true" />
        </Button>
        <Button size="icon-sm" variant="ghost" class="size-7" aria-label="刷新" data-testid="task-detail-result-reload" onclick={navReload}>
          <RotateCw class="size-3.5" aria-hidden="true" />
        </Button>
        <input
          bind:value={urlDraft}
          class="focus:border-ring bg-background h-7 min-w-0 flex-1 rounded-md border px-2 font-mono text-[11px] outline-none"
          aria-label="结果页地址"
          data-testid="task-detail-result-url"
          onkeydown={(event) => {
            if (event.key === 'Enter') navGo()
          }}
        />
        <Button size="icon-sm" variant="ghost" class="size-7" aria-label="在浏览器中打开" data-testid="task-detail-result-external" onclick={openExternal}>
          <ExternalLink class="size-3.5" aria-hidden="true" />
        </Button>
        <Button size="icon-sm" variant="ghost" class="size-7" aria-label="关闭标签" data-testid="task-detail-result-close" onclick={closeResultTab}>
          <X class="size-3.5" aria-hidden="true" />
        </Button>
      </div>
    {/if}

    <!-- 详情 tab：任务预览（状态/钻数/元数据/导出结果/工作台入口/工件清单）。 -->
    <Tabs.Content value="detail" class="min-h-0 flex-1 overflow-y-auto p-3" data-testid="task-detail-content">
      <!-- 状态徽标 + 总钻数徽标行 -->
      <div class="flex flex-wrap items-center gap-1.5" data-testid="task-detail-status-row">
        {#if taskStatus !== null}
          <span
            class="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold {STATUS_BADGE[taskStatus].cls}"
            data-testid="task-detail-status-badge"
          >
            {STATUS_BADGE[taskStatus].label}<!-- 单行插值（Svelte 编译期剥行内元素边界空格——秒数段不跨行拼）。 -->{#if taskStatus === 'running' && elapsedSec !== null}&nbsp;{elapsedSec}s{/if}
          </span>
        {/if}
        {#if gemBadge !== null}
          <span
            class="bg-primary/10 text-primary inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold"
            data-testid="task-detail-gem-badge"
            title={GEM_COUNT_CALIBER_TITLE}
          >
            <Gem class="size-3 shrink-0" aria-hidden="true" />
            <span>{gemBadge.total.toLocaleString('zh-CN')} 颗 · {gemBadge.stones.length} 款</span>
          </span>
        {:else if taskRunning}
          <span
            class="text-muted-foreground shrink-0 text-[11px]"
            data-testid="task-detail-gem-pending"
            title="任务运行中——排钻结果未定，完成后在此显示总颗数与款数"
          >
            排钻中…
          </span>
        {/if}
      </div>

      {#if inputImages.length > 0}
        <!-- [Owner 2026-10-02] 输入图预览卡：当前任务正在处理的原图（任务首条消息
             附件；纯文本延续任务跟随上一任务）——缩略点击开应用内 Lightbox 大图。
             位置=状态徽标行下方、元数据区上方（任务的「主体」先于派生数据）。 -->
        <div class="mt-2.5 rounded-lg border bg-card p-2.5" data-testid="task-detail-input-images">
          <p class="mb-1.5 flex items-center gap-1 text-xs font-medium">
            <ImageIcon class="size-3 shrink-0" aria-hidden="true" />
            <span>正在处理的图片</span>
            {#if inputImages.length > 1}
              <span class="text-[11px] font-normal text-muted-foreground">{inputImages.length} 张</span>
            {/if}
          </p>
          <div class="flex flex-wrap gap-1.5">
            {#each inputImages as image, index (image.blobRef + ':' + index)}
              <button
                type="button"
                class="h-20 w-20 overflow-hidden rounded-md border border-border transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
                data-testid="task-detail-input-image"
                title="{image.name}——点击查看大图"
                aria-label="查看输入图 {image.name}"
                onclick={() => (lightboxIndex = index)}
              >
                <img
                  src={agentAssetUrl(image.blobRef, 320)}
                  alt={image.name}
                  class="size-full object-cover"
                  loading="lazy"
                  onerror={retryRawImageOnError}
                />
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if gemBadge !== null && gemBadge.stones.length > 0}
        <!-- 款钻用量 chips（T2）：top 5 款贴图缩略+SKU+颗数；其余「+K 款」折叠展开。
             贴图=80% contains+底色 hex 兜底+401 自愈。 -->
        <div class="mt-2.5" data-testid="task-detail-gem-chips">
          <div class="flex flex-wrap items-center gap-1">
            {#each gemChipStones as stone (stone.stoneRef)}
              <span
                class="border-border bg-muted/30 inline-flex h-7 items-center gap-1.5 rounded-full border pl-0.5 pr-2"
                data-testid="task-detail-gem-chip"
                title="{stone.name}（{stone.supplier}/{stone.sku} · 首见规格 {stone.diameterMm}mm）× {stone.count} 颗——{GEM_COUNT_CALIBER_TITLE}"
              >
                <span class="flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full" style="background-color: {stone.hex}26">
                  <img
                    src={agentStoneTextureUrl(stone.stoneRef, stone.hex)}
                    alt=""
                    class="size-[80%] object-contain"
                    loading="lazy"
                    onerror={retryRawImageOnError}
                  />
                </span>
                <span class="max-w-24 truncate text-[11px] font-medium">{stone.sku}</span>
                <span class="text-muted-foreground text-[11px] tabular-nums">×{stone.count}</span>
              </span>
            {/each}
            {#if gemChipHidden > 0}
              <button
                type="button"
                class="text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex h-7 items-center gap-0.5 rounded-full px-2 text-[11px] transition-colors"
                data-testid="task-detail-gem-more"
                aria-expanded={gemChipsOpen}
                onclick={() => (gemChipsOpen = !gemChipsOpen)}
              >
                {gemChipsOpen ? '收起' : `+${gemChipHidden} 款`}
                <ChevronDown class="size-3 transition-transform {gemChipsOpen ? 'rotate-180' : ''}" aria-hidden="true" />
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <!-- 元数据（创建时间/模型/用时）。 -->
      <dl class="mt-3 space-y-1.5 rounded-lg border bg-card p-3 text-xs" data-testid="task-detail-metadata">
        <div class="flex justify-between gap-3">
          <dt class="text-muted-foreground shrink-0">创建时间</dt>
          <dd class="min-w-0 truncate text-right">{createdAtLabel}</dd>
        </div>
        <div class="flex justify-between gap-3">
          <dt class="text-muted-foreground shrink-0">模型</dt>
          <dd class="min-w-0 truncate text-right font-mono text-[11px]">{modelLabel}</dd>
        </div>
        {#if elapsedSec !== null}
          <div class="flex justify-between gap-3">
            <dt class="text-muted-foreground shrink-0">{taskRunning ? '已用时' : '用时'}</dt>
            <dd class="shrink-0 tabular-nums">{elapsedSec}s</dd>
          </div>
        {/if}
      </dl>

      <!-- 导出结果列表卡（session.exports——每 imageId 最新一组；行点击开结果 tab）。 -->
      <div class="mt-3 rounded-lg border bg-card p-3" data-testid="task-detail-exports-card">
        <p class="mb-2 flex items-center gap-1 text-xs font-medium">
          <span>导出结果</span>
          {#if exportGroups.length > 0}
            <span class="text-[11px] font-normal text-muted-foreground">{exportGroups.length} 个</span>
          {/if}
          {#if exportsReadable}
            <button
              type="button"
              class="text-muted-foreground hover:text-foreground hover:bg-muted/60 ml-auto shrink-0 rounded p-0.5 transition-colors"
              data-testid="task-detail-exports-refresh"
              title="刷新导出清单"
              aria-label="刷新导出清单"
              onclick={() => {
                if (sessionId !== null) void reloadMyTaskExports(sessionId)
              }}
            >
              <RefreshCw class="size-3" aria-hidden="true" />
            </button>
          {/if}
        </p>
        {#if !exportsReadable}
          <p class="text-muted-foreground py-3 text-center text-[11px]" data-testid="task-detail-exports-mock">
            本地演示通道无导出历史
          </p>
        {:else if exportsLoading}
          <p class="text-muted-foreground py-3 text-center text-[11px]" role="status" data-testid="task-detail-exports-loading">
            导出清单加载中…
          </p>
        {:else if exportsError !== null}
          <div class="flex items-center gap-2" role="alert">
            <p class="text-destructive min-w-0 flex-1 truncate text-[11px]" title={exportsError} data-testid="task-detail-exports-error">
              导出清单加载失败：{exportsError}
            </p>
            <Button
              size="xs"
              variant="outline"
              onclick={() => {
                if (sessionId !== null) void ensureMyTaskExports(sessionId)
              }}
              data-testid="task-detail-exports-retry"
            >
              重试
            </Button>
          </div>
        {:else if exportGroups.length === 0}
          <p class="text-muted-foreground py-3 text-center text-[11px]" data-testid="task-detail-exports-empty">
            {taskRunning ? '排钻进行中，导出完成后出现在这里' : '尚无导出——对话中让 agent 导出，或在导出门就绪后于工作台导出'}
          </p>
        {:else}
          <div class="space-y-1">
            {#each exportGroups as group (group.imageId)}
              {@const pid = group.latest.publicId}
              <button
                type="button"
                class="hover:bg-muted/60 flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors {active === pid ? 'bg-accent-soft' : ''}"
                data-testid="task-detail-export-row"
                data-public-id={pid}
                title="{imageLabel(group.imageId)}——在结果标签中打开分享页"
                onclick={() => (active = pid)}
              >
                <span class="min-w-0 flex-1 truncate">{imageLabel(group.imageId)}</span>
                <span class="text-muted-foreground shrink-0 text-[10px]">{timeLabel(group.latest.createdAt)}</span>
                <span class="text-primary shrink-0 text-[11px] font-medium">打开</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <!-- 工作台入口卡（结果与工作台分 tab——入口即切换，非跳离面板）。 -->
      <div class="mt-3 flex items-center justify-between gap-2 rounded-lg border bg-card p-3" data-testid="task-detail-workbench-entry">
        <div class="min-w-0">
          <p class="text-xs font-medium">排钻工作台</p>
          <p class="text-muted-foreground mt-0.5 text-[11px]">图层/掩码/策略编辑——同会话画布，切换标签不丢状态</p>
        </div>
        <Button size="sm" class="h-7 shrink-0 px-2 text-[11px]" onclick={openWorkbenchTab} data-testid="task-detail-open-workbench-tab" title="在工作台标签中打开（紧凑形态）">
          <Layers class="size-3.5" aria-hidden="true" />
          打开工作台
        </Button>
      </div>

      {#if artifacts.length > 0}
        <!-- 工件清单卡（T2）：折叠头「导出工件 N」+ 28px 行（名称+外链 raw 新窗口）。 -->
        <div class="mt-3" data-testid="task-artifacts-card">
          <button
            type="button"
            class="flex w-full items-center gap-1 rounded-md px-2 py-1.5 text-left text-xs font-medium transition-colors hover:bg-muted/60"
            aria-expanded={artifactsOpen}
            data-testid="task-artifacts-toggle"
            onclick={() => (artifactsOpen = !artifactsOpen)}
          >
            <span>导出工件</span>
            <span class="text-[11px] font-normal text-muted-foreground">{artifacts.length}</span>
            <ChevronDown
              class="text-muted-foreground ml-auto size-3 shrink-0 transition-transform {artifactsOpen ? 'rotate-180' : ''}"
              aria-hidden="true"
            />
          </button>
          {#if artifactsOpen}
            <div class="mt-1 space-y-0.5">
              {#each artifacts as art (art.key)}
                {#if art.blobRef !== undefined && isImageArtifactName(art.name)}
                  <!-- [w17-critic T5] 图片类工件：点击开应用内 Lightbox（缩放/平移/组内切图）。 -->
                  <button
                    type="button"
                    class="hover:bg-muted/60 flex h-7 w-full items-center justify-between gap-2 rounded-md px-2 text-xs transition-colors"
                    data-testid="task-artifact-row"
                    data-image="true"
                    title="{art.name}——点击查看大图"
                    onclick={() => {
                      if (art.blobRef === undefined) return
                      lightboxIndex = artifactLightboxIndex(art.blobRef)
                    }}
                  >
                    <span class="min-w-0 flex-1 truncate text-left">{art.name}</span>
                    <ImageIcon class="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
                  </button>
                {:else if art.blobRef !== undefined && !isMock}
                  <a
                    href={assetRawUrl(art.blobRef)}
                    target="_blank"
                    rel="noopener"
                    class="flex h-7 items-center justify-between gap-2 rounded-md px-2 text-xs transition-colors hover:bg-muted/60"
                    data-testid="task-artifact-row"
                    title="{art.name}——在新窗口打开"
                  >
                    <span class="min-w-0 flex-1 truncate">{art.name}</span>
                    <ExternalLink class="text-muted-foreground size-3 shrink-0" aria-hidden="true" />
                  </a>
                {:else if art.blobRef !== undefined}
                  <!-- [fixture 边界] mock 演示引用=虚拟 id：不拼 daemon raw URL
                       （越域必 404）——禁点+演示标注。 -->
                  <div
                    class="text-muted-foreground flex h-7 items-center justify-between gap-2 rounded-md px-2 text-xs"
                    data-testid="task-artifact-row"
                    data-demo="true"
                    title="本地演示数据——无产物字节可打开"
                  >
                    <span class="min-w-0 flex-1 truncate">{art.name}</span>
                    <span class="shrink-0 text-[10px]">演示</span>
                  </div>
                {:else}
                  <div class="text-muted-foreground flex h-7 items-center rounded-md px-2 text-xs" data-testid="task-artifact-row">
                    <span class="min-w-0 flex-1 truncate">{art.name}</span>
                  </div>
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/if}
    </Tabs.Content>

    <!-- [4] 活动 tab（任务会话投影——activity 帧 running+终态配对时间线；frames=
         同一帧流 $derived 透传，新帧到达即更新）。 -->
    <Tabs.Content value="activity" class="min-h-0 flex-1" data-testid="task-detail-activity-content">
      <TaskActivityTimeline frames={taskFrames} />
    </Tabs.Content>

    <!-- 工作台 tab（page-component）：首开挂载、切走 bits-ui hidden 保活（画布状态
         属模块级 store+组件常驻——装载门/快捷键门按 presence 可见性自治，零改）。 -->
    <Tabs.Content value="workbench" class="min-h-0 flex-1" data-testid="task-detail-workbench-content">
      {#if workbenchOpened}
        <TaskWorkbenchView {taskId} embedded />
      {/if}
    </Tabs.Content>

    {#each exportGroups as group (group.imageId)}
      <!-- 结果 tab 体=常驻 iframe（inactive 走 hidden 保活不重载）。 -->
      <Tabs.Content value={group.latest.publicId} class="min-h-0 flex-1">
        <iframe
          bind:this={frames[group.latest.publicId]}
          title="{imageLabel(group.imageId)} 导出分享页预览"
          src={resultUrl(group.latest.publicId)}
          class="h-full w-full border-0 bg-white"
          sandbox="allow-scripts allow-same-origin allow-popups allow-downloads"
          data-testid="task-detail-result-frame"
          data-public-id={group.latest.publicId}
          onload={() => onFrameLoad(group.latest.publicId)}
        ></iframe>
      </Tabs.Content>
    {/each}
  </Tabs.Root>

  {#if lightboxIndex !== null && lightboxItems.length > 0}
    <Lightbox items={lightboxItems} index={lightboxIndex} onclose={() => (lightboxIndex = null)} />
  {/if}
</div>
