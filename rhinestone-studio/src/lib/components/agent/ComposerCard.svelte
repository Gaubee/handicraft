<!--
  指令输入卡（照 shufa-server ComposerCard.svelte 1:1 移植，2026-09-28 zhumo
  方案移植块 B；走查 R6 按 skill-creator-v2 ComposerCard 重写）：
  附件行（图片附件）→ 自动长高 textarea → 工具行
  （左簇：上下文表；右簇：附加图片 + 模型 chip + 强度 chip + 发送）。
  2026-09-25 前台对齐（Owner 指令「抄 skill-creator-v2」）：
  - 思考强度 chip：活动模型 efforts 档位（zcode 转数据源）；「跟随默认」= 不覆盖；
    running 禁用（本轮结束后再切，服务端同款拒绝）。
  - ContextMeter：上下文占用环 + 用量面板 + 压缩（oncompact 经 onsend("/compact")）。
  - 触发面板（DSH 官方一致）：`/` = 内核命令注册表（composer.list，插件系统
    注册——非硬编码；选中即发送）、`$` = 内核技能注册表（user-invocable；
    选中留 $name token，daemon 展开为官方 skill-invocation 双消息注入）。
  贴钻适配（结构 1:1，服务面注入化）：
  - uploadAttachment/composerCatalog 为可选注入 props（缺省 undefined 时附件/
    触发面板由 attachable/triggers 关闭；组件实现完整保留）。
  - 通道反馈（W10）走贴钻全局 toast（showToast）。
  - 贴钻 W10 语义保真：running+有输入时保留「⚡ 引导」直达按钮（zhumo W10m
    删 Zap 改队列行模式——贴钻测试与已验证交互依赖直达位，双路并存）。
  [split-admin-portal 2.6.2/2.6.5] 附件结构化接线（形态不变，载荷改道）：
  - 发送载荷=文本原样+附件元数据（onsend 第三参——blobRef 随 followup
    attachments 线字段投递，服务端物料桥进 dsh 图像内容块；zhumo 的
    「[图片附件 name]：path」文本注入行废止）。
  - 注入面 uploadAttachment(file: File)（File→base64→assets.upload 由注入方
    承载）；选择/粘贴（clipboardData.files）/拖入（drop）三入口同门：
    ≤4MiB/张+≤4 张/条+同名同大小去重+失败 toast（首败即停）。
  - 纯图消息：空文本+有附件可发送（契约「text 或 attachments 至少其一」；
    steer+附件被服务端拒——Zap 只在有文本时出现）。
  [quick-start-panel 2026-09-30] 拖放面强化（新会话快速开始 Owner 需求）：
  - 卡根 testid=composer-dropzone + dragover 高亮态「松开添加图片」
    （pointer-events-none overlay——事件面仍归卡根，不劫持 dragleave）；
  - addFiles 实例方法：SessionStream 新会话空态整面 dropzone 的收图入口
    （与选择/粘贴/拖入三入口同门——过滤/尺寸/数量/去重/上传全复用）。
  [product-polish-w2 2026-10-01 Wave1 验收改造（Owner 指令）]：
  - 工具行升级 `[Add][自动批准] … [Context][Model][Effect][Send]`：Add=图片钮
    改名「添加图片」；自动批准=从状态条迁入的 toggleButton（压缩态 icon+「自动」
    /开启态 primary 描边/窄卡容器查询收纯 icon）；强度 chip（zhumo 补抄）由
    SessionStream 接线 currentEffort/onseteffort（任务级覆盖，null=跟随默认）。
  - 审批 zStack（T3）：待审批队列非空（含过期未处理）→ textarea 整块替换为
    层叠审批卡（后卡顶部露出 ~6px+计数徽标；top-inline-end 左右箭头/键盘 ←/→
    切卡；按帧序逐个处理；过期卡操作区变「跳过」=本地清卡不入审批账；草稿
    文本保留在组件状态——栈清空即恢复）。
-->
<script lang="ts">
  import IconSend from '@lucide/svelte/icons/send'
  import IconSquare from '@lucide/svelte/icons/square'
  import IconChevronDown from '@lucide/svelte/icons/chevron-down'
  import IconChevronLeft from '@lucide/svelte/icons/chevron-left'
  import IconChevronRight from '@lucide/svelte/icons/chevron-right'
  import IconCheck from '@lucide/svelte/icons/check'
  import IconImage from '@lucide/svelte/icons/image'
  import IconX from '@lucide/svelte/icons/x'
  import IconLoader from '@lucide/svelte/icons/loader-circle'
  import IconZap from '@lucide/svelte/icons/zap'
  import IconBoxes from '@lucide/svelte/icons/boxes'
  import IconShieldCheck from '@lucide/svelte/icons/shield-check'
  import { Button } from '$lib/components/ui/button'
  import * as Popover from '$lib/components/ui/popover'
  import ApprovalCard from './ApprovalCard.svelte'
  import { routeAvatarColor, routeLetter, formatTokenCount, resolveDefaultEffort } from '$lib/components/models/route-meta'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { AvailableModel } from '@handicraft/contracts'
  import {
    MAX_ATTACHMENTS_PER_MESSAGE,
    MAX_ATTACHMENT_BYTES,
    type AttachmentMeta,
  } from '$lib/agentApi/attachments'
  import type { AgentSetSummary } from '$lib/agentApi/types'
  import TriggerMenu, { type MenuEntry } from './TriggerMenu.svelte'
  import ContextMeter from './ContextMeter.svelte'

  /** 附件面（2.6 结构化：blobRef 一等字段；rawUrl 预览闭包由注入方构造）。 */
  export interface ComposerAttachment extends AttachmentMeta {
    size: number
    rawUrl: (width?: number) => string
  }

  /**
   * [product-polish-w2 T3] 审批栈条目（注入面形状：PendingApproval+expired 投影
   * ——expired=TTL 已过或来源任务已终态，由 SessionStream 计算注入；过期卡操作区
   * 变「跳过」）。
   */
  export interface ApprovalItem {
    requestId: string
    tool: string
    proposalId: string
    summary: string
    expiresAt: string
    preview: { before: string; after: string }
    /** 归属项目标签（可选——旧 daemon 帧）。 */
    projectLabel?: string
    expired: boolean
  }

  let {
    onsend,
    disabled = false,
    sending = false,
    placeholder = '描述你的贴钻需求，例如：帮我把这张爱心线稿排满红色圆钻…',
    /** 可用模型清单（null/空 = 无已配路由，模型/强度 chip 隐藏）。 */
    models = null,
    defaultModel = null,
    /** 任务级模型覆盖（null = 跟随后台默认）。 */
    currentModel = null,
    /** 任务级思考强度档（null = 跟随默认）。 */
    currentEffort = null,
    /** 任务运行中：模型/强度菜单禁用（本轮结束后再切换）。 */
    running = false,
    /** 最近一轮用量（ContextMeter；null = 尚无回合）。 */
    usage = null,
    /** 活动模型上下文窗口（null = 回退 128k 假定值）。 */
    capacity = null,
    onsetmodel,
    onseteffort,
    /** 停止当前轮（W10）：running 态回调；缺省时 running 仍可排队发送。 */
    onstop = null,
    /** 附件面开关（贴钻无附件管线时关掉——上传依赖注入面）。 */
    attachable = true,
    /** 附件上传注入（file→BlobRef 元数据；缺省 undefined = 附件位禁用）。 */
    uploadAttachment = undefined,
    /** 触发面板开关（/命令、$技能）：会话内语义。 */
    triggers = true,
    /** 内核目录注入（命令+技能注册表；缺省 undefined = 触发面板建议关闭）。 */
    composerCatalog = undefined,
    /** 队列编辑态（W10b）：发送按钮变「确认修改」，Enter=确认、Escape=取消。 */
    editingActive = false,
    /** 进入编辑时回填的队列文本（变化触发填充；null=非编辑）。 */
    editingDraft = null,
    onconfirmedit = null,
    oncanceledit = null,
    /** 顶栏动作注入（贴钻 SessionStream 头部「取消任务」等动作位）。 */
    headerAction = undefined,
    /**
     * 集合候选注入（add-task-stones-manifest-export 1.2）：新会话首条消息的
     * sourceSetId 选择面（sets.list 摘要——注入方承载 rpc 通道；缺省 undefined =
     * 入口隐藏，与 uploadAttachment 注入面同款在否语义）。[product-polish-w1 T3]
     * 候选带 scope 分组（mine 置顶/market 市场组——选择器分组渲染）。
     */
    loadSetOptions = undefined,
    /**
     * 市场组合复制注入（product-polish-w1 T1/T3）：选中市场组合发送首条消息时
     * 先复制为本人副本（返回副本 resourceId 绑定 sourceSetId——服务端 followup
     * 按 owner 展开，市场源必拒副本合法）。缺省 undefined=市场组选择后发送被拦
     * （toast 明示通道不可用）。
     */
    copyMarketSet = undefined,
    /**
     * [product-polish-w2 T2] 会话级自动批准开关（null=隐藏——rpc 模式注入；从
     * 状态条迁入工具行的 toggleButton：压缩态 icon+「自动」，开启态 primary 描边；
     * 卡宽不足时收成纯 icon——title 保说明）。
     */
    autoApprove = null,
    onsetautoapprove = null,
    /**
     * [product-polish-w2 T3] 待审批队列（帧序=按序逐个处理；非空时 textarea 整块
     * 替换为审批 zStack——工具行保留，发送禁用；全部处理完恢复 textarea，草稿
     * 文本保留在组件状态）。
     */
    approvals = [],
    /** 跳过审批卡回调（过期/终态卡的本地清卡——不入审批账）。 */
    onskipapproval = null,
  }: {
    onsend: (text: string, mode?: 'followup' | 'steer', attachments?: AttachmentMeta[], sourceSetId?: string) => void
    onstop?: (() => void) | null
    editingActive?: boolean
    editingDraft?: string | null
    onconfirmedit?: ((text: string) => void) | null
    oncanceledit?: (() => void) | null
    disabled?: boolean
    sending?: boolean
    placeholder?: string
    models?: AvailableModel[] | null
    defaultModel?: { provider: string; model: string; effort?: string | null } | null
    currentModel?: { provider: string; model: string } | null
    currentEffort?: string | null
    running?: boolean
    usage?: { in: number; out: number } | null
    capacity?: number | null
    onsetmodel?: (provider: string, model: string) => void
    onseteffort?: (effort: string | null) => void
    attachable?: boolean
    uploadAttachment?: ((file: File) => Promise<ComposerAttachment>) | null
    triggers?: boolean
    composerCatalog?: (() => Promise<{ commands: MenuEntry[]; skills: MenuEntry[] }>) | null
    headerAction?: import('svelte').Snippet
    loadSetOptions?: (() => Promise<AgentSetSummary[]>) | null
    copyMarketSet?: ((resourceId: string) => Promise<string>) | null
    autoApprove?: boolean | null
    onsetautoapprove?: ((on: boolean) => void) | null
    approvals?: ApprovalItem[]
    onskipapproval?: ((requestId: string) => void) | null
  } = $props()

  /** 实例方法（Owner 2026-09-28 复用整卡）：外部注入文本。 */
  export function setPrompt(value: string): void {
    text = value
    requestCaretEnd()
  }

  /** 实例方法（quick-start-panel 2026-09-30）：外部拖放收图入口（新会话空态
   * 整面 dropzone）——与选择/粘贴/拖入三入口同门（onFilesPicked 单真源）。 */
  export function addFiles(files: File[] | FileList): void {
    void onFilesPicked(files)
  }

  let text = $state('')
  let menuOpen = $state(false)
  let effortOpen = $state(false)
  /** 附件（走查 R7 语义：图片 ≤4MiB/张+2.6.5 ≤4 张/条；chip 缩略预览，
   * 发送走结构化 attachments 载荷——blobRef 由注入方上传取得）。 */
  let attachments = $state<ComposerAttachment[]>([])
  let uploading = $state(false)
  let fileInput = $state<HTMLInputElement | null>(null)

  const canUpload = $derived(attachable && uploadAttachment !== undefined && uploadAttachment !== null)
  /** 可发送载荷（2.6.3 纯图门：文本或附件至少其一）。 */
  const hasPayload = $derived(text.trim().length > 0 || attachments.length > 0)

  // ------------------------------------------------------------ 集合选择（1.2）

  /** 注入面在否（与附件面同款——mock 演示模式无 rpc 通道即隐藏）。 */
  const canPickSet = $derived(loadSetOptions !== undefined && loadSetOptions !== null)
  let setMenuOpen = $state(false)
  let setQuery = $state('')
  /** 候选清单（null=未拉取——首次打开选择器时惰性加载缓存一次）。 */
  let setOptions = $state<AgentSetSummary[] | null>(null)
  let setLoadStarted = false
  let setLoadFailed = $state(false)
  /** 选中集合（null=跳过——空 manifest，entries=[]）。 */
  let selectedSet = $state<AgentSetSummary | null>(null)

  $effect(() => {
    if (!setMenuOpen) return
    if (setOptions !== null || setLoadFailed || setLoadStarted) return
    if (loadSetOptions === undefined || loadSetOptions === null) return
    setLoadStarted = true
    void loadSetOptions()
      .then((out) => {
        setOptions = out
      })
      .catch(() => {
        // 拉取失败一次即停（空态提示；重开选择器再试）。
        setLoadFailed = true
        setLoadStarted = false
      })
  })

  const filteredSetOptions = $derived.by(() => {
    const options = setOptions ?? []
    const q = setQuery.trim().toLowerCase()
    if (q === '') return options
    return options.filter((option) => option.name.toLowerCase().includes(q))
  })

  /** 分组投影（product-polish-w1 T3——N1「挑组合」）：我的组合置顶+材料市场组
   *  （默认折叠；scope 缺省=mine——旧 fixture 兼容）。 */
  const mineSetOptions = $derived(filteredSetOptions.filter((option) => option.scope !== 'market'))
  const marketSetOptions = $derived(filteredSetOptions.filter((option) => option.scope === 'market'))
  let marketGroupOpen = $state(false)

  /**
   * 实例方法（product-polish-w1 T2）：外部预选集合（我的材料组合卡「开工」→
   * createSession 后经 composerOutbox 注入——新会话 Composer 集合选择器预选该
   * 组合；与 setPrompt 同款注入面，N1 动线「挑组合→开工」一步进首条消息）。
   */
  export function presetSet(option: AgentSetSummary): void {
    selectedSet = option
  }

  function pickSet(option: AgentSetSummary): void {
    selectedSet = option
    setMenuOpen = false
    setQuery = ''
  }

  function clearSet(): void {
    selectedSet = null
  }

  /** 更新时间紧凑投影（YYYY-MM-DD——选择器行内展示，不做相对时间计算）。 */
  function formatSetUpdatedAt(iso: string): string {
    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (value: number): string => String(value).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  }

  function isImageFile(file: File): boolean {
    return file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.name)
  }

  /** 三入口同门（选择/粘贴/拖入+外部 dropzone）：图片过滤→尺寸门→数量门→去重→上传（首败即停）。 */
  async function onFilesPicked(files: FileList | File[] | null): Promise<void> {
    if (files === null || files.length === 0) return
    if (uploadAttachment === undefined || uploadAttachment === null) return
    const images = Array.from(files).filter(isImageFile)
    if (images.length === 0) return
    uploading = true
    try {
      for (const file of images) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          notice(`「${file.name}」超过 4MiB 上限，未添加`)
          continue
        }
        if (attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE) {
          notice(`单条消息最多 ${MAX_ATTACHMENTS_PER_MESSAGE} 张图片`)
          break
        }
        if (attachments.some((a) => a.name === file.name && a.size === file.size)) continue
        try {
          const uploaded = await uploadAttachment(file)
          attachments = [...attachments, uploaded]
        } catch (error) {
          notice(`图片上传失败：${error instanceof Error ? error.message : String(error)}`)
          break
        }
      }
    } finally {
      uploading = false
      if (fileInput !== null) fileInput.value = ''
    }
  }

  /** 粘贴（clipboardData.files——截图直贴；文本粘贴不受影响）。 */
  function onpaste(event: ClipboardEvent): void {
    const files = event.clipboardData?.files
    if (files === undefined || files.length === 0) return
    event.preventDefault()
    void onFilesPicked(files)
  }

  /** 拖放高亮（dragover Files 持续置位；dragleave 离卡/落定复位——relatedTarget
   *  仍在卡内则忽略，子元素边界穿越不闪断；无上传链（mock）不亮灯）。 */
  let dragActive = $state(false)

  /** 拖入（drop 到输入卡区域；dragover 放行 Files 才可落）。 */
  function ondragover(event: DragEvent): void {
    if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return
    event.preventDefault()
    if (canUpload) dragActive = true
  }

  function ondragleave(event: DragEvent): void {
    const zone = event.currentTarget
    const next = event.relatedTarget
    if (zone instanceof Node && next instanceof Node && zone.contains(next)) return
    dragActive = false
  }

  function ondrop(event: DragEvent): void {
    dragActive = false
    const files = event.dataTransfer?.files
    if (files === undefined || files.length === 0) return
    event.preventDefault()
    void onFilesPicked(files)
  }

  function removeAttachment(blobRef: string): void {
    attachments = attachments.filter((a) => a.blobRef !== blobRef)
  }

  interface ModelGroup {
    provider: string
    iconUrl?: string
    models: AvailableModel[]
  }

  const groups = $derived.by(() => {
    const byProvider = new Map<string, ModelGroup>()
    for (const item of models ?? []) {
      let group = byProvider.get(item.provider)
      if (group === undefined) {
        group = { provider: item.provider, models: [] }
        if (item.iconUrl !== undefined) group.iconUrl = item.iconUrl
        byProvider.set(item.provider, group)
      }
      group.models.push(item)
    }
    return [...byProvider.values()]
  })

  const activeModel = $derived(
    currentModel ?? (defaultModel !== null && groups.length > 0 ? defaultModel : null),
  )

  /** chip 标签：活动模型名（默认态标注「（默认）」——裸模型名分不清是任务
   覆盖还是后台默认）；同 id 跨路由时加 provider 前缀区分。 */
  const chipLabel = $derived.by(() => {
    if (activeModel === null) return '默认'
    const sameIdProviders = groups
      .filter((g) => g.models.some((m) => m.model === activeModel.model))
      .map((g) => g.provider)
    const prefix = sameIdProviders.length > 1 ? `${activeModel.provider}/` : ''
    const suffix = currentModel === null ? '（默认）' : ''
    return `${prefix}${activeModel.model}${suffix}`
  })

  /** 模型是否为后台默认（picker 行内「默认」标记）。 */
  function isDefaultModel(provider: string, model: string): boolean {
    return (
      currentModel === null &&
      defaultModel !== null &&
      defaultModel.provider === provider &&
      defaultModel.model === model
    )
  }

  /** 活动模型的档位目录（无数据 = 强度 chip 隐藏）。 */
  const activeEfforts = $derived.by(() => {
    if (activeModel === null) return []
    return (
      models?.find((m) => m.provider === activeModel.provider && m.model === activeModel.model)
        ?.efforts ?? []
    )
  })

  /** 默认档显示值：后台配置档（default.effort）?? 目录算法档（efforts[ceil(N/2)]）；
   无目录=null（「模型默认」= 内核自选）。 */
  const defaultEffortValue = $derived.by(() => {
    if (defaultModel?.effort) return defaultModel.effort
    return resolveDefaultEffort(activeEfforts)
  })

  function isActive(provider: string, model: string): boolean {
    return activeModel !== null && activeModel.provider === provider && activeModel.model === model
  }

  // ------------------------------------------------------------ 触发面板状态

  /** 光标是否在首行（面板锚定条件；input/click/keyup 同步）。 */
  let caretOnFirstLine = $state(true)
  let slashMenu = $state<{ handleKeydown: (event: KeyboardEvent) => boolean } | null>(null)
  let kbMenu = $state<{ handleKeydown: (event: KeyboardEvent) => boolean } | null>(null)

  /** 内核目录（命令+技能；首次触发 `/` 或 `$` 时惰性拉取缓存一次）。 */
  let composerCommands = $state<MenuEntry[]>([])
  let skillEntries = $state<MenuEntry[]>([])
  let composerLoaded = $state(false)
  let composerFailed = $state(false)

  $effect(() => {
    if ((!text.startsWith('/') && !text.startsWith('$')) || composerLoaded || composerFailed) return
    if (composerCatalog === undefined || composerCatalog === null) return
    composerLoaded = true
    void composerCatalog()
      .then((out) => {
        composerCommands = out.commands
        skillEntries = out.skills
      })
      .catch(() => {
        // 拉取失败一次即停（空态提示；下次重新进入组件再试）。
        composerFailed = true
      })
  })

  function onSlashSelect(value: string): void {
    // 命令选中即执行发送（daemon 经内核 commands 分流，不进 LLM）。
    text = ''
    onsend(value)
  }

  function onSkillSelect(value: string): void {
    // 技能选中留 `$name ` token（官方语义：用户原话随行，daemon 展开注入）。
    const lines = text.split('\n')
    lines[0] = `${value} `
    text = lines.join('\n')
    requestCaretEnd()
  }

  function syncCaret(): void {
    const el = textareaEl
    if (el === null) return
    const before = el.value.slice(0, el.selectionStart ?? 0)
    caretOnFirstLine = !before.includes('\n')
  }

  // ------------------------------------------------------------ 提交与键盘

  /** 队列编辑回填（W10b）：editingDraft 变化即填充（页面层点「编辑」时置入）。 */
  $effect(() => {
    if (editingDraft !== null && editingActive) text = editingDraft
  })

  /** 页面层协调用（bind:this）：进入编辑前查输入框是否有未发送内容
   （Owner 设计：有内容拒绝编辑模式）。 */
  export function draftLength(): number {
    return text.trim().length
  }

  /** 市场组合复制中（product-polish-w1 T3：发送先复制再绑定——期间发送位禁用防双发）。 */
  let copyingMarketSet = $state(false)

  async function submit(mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    const trimmed = text.trim()
    // 纯图门（2.6.3）：空文本+有附件可发；编辑态确认仍需文本（队列编辑回填面）。
    if (!hasPayload || sending || disabled || copyingMarketSet) return
    // 队列编辑态（W10b）：发送=确认修改（文本回冻结段首条），不走 onsend。
    if (editingActive) {
      if (trimmed.length === 0) return
      onconfirmedit?.(trimmed)
      text = ''
      attachments = []
      return
    }
    // 结构化载荷（2.6.2）：文本原样+附件元数据（blobRef 随 followup.attachments
    // 投递——服务端物料桥进 dsh 图像内容块；不再拼「[图片附件]」文本行）。
    // 1.2：sourceSetId 与 attachments 同级（仅常规发送携带——steer+sourceSetId
    // 被服务端 typed 拒，引导是裸文本改口）。
    const payloadAttachments =
      attachments.length > 0
        ? attachments.map(({ blobRef, name, mime, width, height }) => ({ blobRef, name, mime, width, height }))
        : undefined
    // 市场组合自动复制（product-polish-w1 T3/T1）：选中市场组合发首条消息=先复制
    // 为本人副本，副本 resourceId 绑定 sourceSetId（服务端按 owner 展开——市场源
    // 必拒，副本合法）；复制失败 toast+中止（不裸发市场源吃 typed 拒）。
    let payloadSourceSetId: string | undefined
    if (mode === 'followup' && selectedSet !== null) {
      if (selectedSet.scope !== 'market') {
        payloadSourceSetId = selectedSet.resourceId
      } else {
        if (copyMarketSet === undefined || copyMarketSet === null) {
          notice('市场组合复制通道不可用——请改选自己的组合或稍后重试')
          return
        }
        copyingMarketSet = true
        try {
          payloadSourceSetId = await copyMarketSet(selectedSet.resourceId)
          notice(`已复制「${selectedSet.name}」到我的材料——本次开工使用副本`)
        } catch (error) {
          notice(`复制市场组合失败：${error instanceof Error ? error.message : String(error)}`)
          return
        } finally {
          copyingMarketSet = false
        }
      }
    }
    onsend(trimmed, mode, payloadAttachments, payloadSourceSetId)
    // W10 通道反馈：运行中发送走队列/引导，等待被消费——即时告知去向。
    if (running) notice(mode === 'steer' ? '已引导当前轮——下一步即生效' : '已排队——当前轮结束后自动开跑')
    text = ''
    attachments = []
    // 集合选择随首条消息消费（会话此后已有任务——选择器由页面层隐藏，此处一并清场）。
    selectedSet = null
  }

  /** 通道反馈（W10；贴钻走全局 toast——输入框内不再内嵌提示条）。 */
  function notice(message: string): void {
    showToast(message)
  }

  /** 停止当前轮（W10）：turn 收口帧与任务 done 状态由 WS 流到达。 */
  function stop(): void {
    onstop?.()
  }

  function onkeydown(event: KeyboardEvent): void {
    // 触发面板键盘先占（任一消费即止）。
    if (slashMenu?.handleKeydown(event)) return
    if (kbMenu?.handleKeydown(event)) return
    if (event.key === 'Escape' && editingActive) {
      event.preventDefault()
      oncanceledit?.()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      submit()
    }
  }

  /** 自动长高（1 行 32px → 5 行 160px 封顶内滚；zhumo 对照清单 T3——空态不再常驻 5 行高）。 */
  let textareaEl = $state<HTMLTextAreaElement | null>(null)
  $effect(() => {
    void text
    const el = textareaEl
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 32), 160)}px`
  })

  // ------------------------------------------------------------ 审批 zStack（product-polish-w2 T3）

  /** 待审批队列非空=textarea 整块替换为审批卡层叠视图（工具行保留，发送禁用）。 */
  const approvalActive = $derived(approvals.length > 0)
  /** 当前卡序（0 起；处理完一张自动落位下一张——Math.min 收敛）。 */
  let approvalIndex = $state(0)
  const safeApprovalIndex = $derived(Math.min(approvalIndex, Math.max(approvals.length - 1, 0)))
  /** 后卡顶部露出条数上限（视觉暗示——计数徽标显全量）。 */
  const APPROVAL_PEEK_CAP = 3
  const approvalPeeks = $derived(Math.min(Math.max(approvals.length - 1, 0), APPROVAL_PEEK_CAP))

  function switchApproval(delta: number): void {
    if (!approvalActive) return
    const next = safeApprovalIndex + delta
    if (next < 0 || next >= approvals.length) return
    approvalIndex = next
  }

  /** 键盘切卡（←/→；焦点在栈容器上——tabindex=0，点击卡片即聚焦）。 */
  function onApprovalKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      switchApproval(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      switchApproval(1)
    }
  }

  /** 栈当前卡 → ApprovalCard 的帧形状（store 投影→契约帧 payload 同形）。 */
  const currentApproval = $derived(approvals[safeApprovalIndex] ?? null)
  /** 过期卡的跳过闭包（非过期=null——ApprovalCard 只在 expired+inline 位出跳过钮）。 */
  const approvalSkip = $derived.by(() => {
    const item = currentApproval
    if (item === null || !item.expired) return null
    const requestId = item.requestId
    return () => onskipapproval?.(requestId)
  })
  const currentApprovalFrame = $derived.by(() => {
    const item = currentApproval
    if (item === null) return null
    return {
      seq: 0,
      ts: Date.now(),
      kind: 'approval-request' as const,
      payload: {
        requestId: item.requestId,
        tool: item.tool,
        proposalId: item.proposalId,
        summary: item.summary,
        expiresAt: item.expiresAt,
        preview: item.preview,
        ...(item.projectLabel !== undefined ? { projectLabel: item.projectLabel } : {}),
      },
    }
  })

  function requestCaretEnd(): void {
    queueMicrotask(() => {
      const el = textareaEl
      if (el !== null) el.selectionStart = el.selectionEnd = el.value.length
    })
  }
</script>

<!--  P3-1（2026-09-29 复核）：拖放根显式语义（role=region 地标 + aria-label）——
      svelte a11y 静态元素交互告警消除；键盘等价通道=「附加图片」按钮（原生
      button 可聚焦，focus-visible 环补显式样式）。 -->
<div
  class="composer-card relative rounded-xl border border-border bg-card p-2 shadow-sm"
  role="region"
  aria-label="消息输入区，支持拖入图片"
  data-testid="composer-dropzone"
  ondragover={ondragover}
  ondragleave={ondragleave}
  ondrop={ondrop}
>
  <!-- 触发面板（锚定卡片上方；键盘留 textarea，见 onkeydown 先占序）。 -->
  {#if triggers}
    <TriggerMenu
      trigger="/"
      entries={composerCommands}
      {text}
      {caretOnFirstLine}
      menuLabel="命令"
      dataSlot="slash-menu"
      emptyMessage={composerFailed ? '命令目录不可用' : composerLoaded ? '无匹配命令' : '加载命令…'}
      sourceLabel="内核命令注册表"
      onSelect={(value) => onSlashSelect(value)}
      bind:this={slashMenu}
    />
    <TriggerMenu
      trigger="$"
      entries={skillEntries}
      {text}
      {caretOnFirstLine}
      menuLabel="技能"
      dataSlot="skill-menu"
      emptyMessage={composerFailed ? '技能目录不可用' : composerLoaded ? '无匹配技能' : '加载技能…'}
      sourceLabel="内核技能注册表（user-invocable）"
      onSelect={(value) => onSkillSelect(value)}
      bind:this={kbMenu}
    />
  {/if}

  {#if headerAction !== undefined}
    <div class="mb-1 flex items-center justify-end gap-1.5">
      {@render headerAction()}
    </div>
  {/if}

  {#if attachments.length > 0 || uploading}
    <div class="mb-1.5 flex flex-wrap gap-1" data-testid="composer-attachments">
      {#each attachments as att (att.blobRef)}
        <span class="group/att relative flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-0.5 pl-0.5 pr-1.5">
          <img
            src={att.rawUrl(96)}
            alt={att.name}
            class="h-8 w-8 rounded object-cover"
            title="{att.name}（{att.width}×{att.height}）"
          />
          <span class="max-w-28 truncate text-[10px]">{att.name}</span>
          {#if att.convertedToPng}
            <span class="shrink-0 rounded bg-muted px-1 text-[9px] leading-4 text-muted-foreground" data-testid="composer-attachment-converted">已转 PNG</span>
          {/if}
          <button
            type="button"
            class="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label="移除附件 {att.name}"
            data-testid="composer-attachment-remove"
            onclick={() => removeAttachment(att.blobRef)}
          >
            <IconX class="h-2.5 w-2.5" />
          </button>
        </span>
      {/each}
      {#if uploading}
        <span class="flex items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[10px] text-muted-foreground">
          <IconLoader class="h-3 w-3 animate-spin" aria-hidden="true" />
          上传中…
        </span>
      {/if}
    </div>
  {/if}
  {#if canUpload}
    <input
      bind:this={fileInput}
      type="file"
      accept="image/*"
      multiple
      class="hidden"
      onchange={(event) => void onFilesPicked(event.currentTarget.files)}
    />
  {/if}
  <!-- 集合选择 chip（1.2）：选中集合的只读呈现——名称+成员数+「任务中可追加」
       提示+可清除（清除=回到跳过态，不强制选择）。[T3] 市场组合加只读快照提示行
       （发送时自动复制到我的材料——副本绑定 sourceSetId）。 -->
  {#if selectedSet !== null}
    <div class="mb-1.5 flex flex-wrap gap-1" data-testid="composer-set-chip">
      <span class="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-1.5 pr-1 text-[10px]">
        <IconBoxes class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="max-w-40 truncate font-medium">{selectedSet.name}</span>
        <span class="shrink-0 text-muted-foreground">{selectedSet.memberCount} 成员</span>
        {#if selectedSet.scope === 'market'}
          <span class="shrink-0 rounded bg-primary/10 px-1 text-primary">市场</span>
        {:else}
          <span class="shrink-0 text-muted-foreground/80">· 任务中可追加钻</span>
        {/if}
        <button
          type="button"
          class="flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          aria-label="移除集合 {selectedSet.name}"
          data-testid="composer-set-chip-remove"
          onclick={clearSet}
        >
          <IconX class="h-2.5 w-2.5" />
        </button>
      </span>
    </div>
    {#if selectedSet.scope === 'market'}
      <!-- 单行插值（Svelte 行内空白折叠——文案整体放一个 span 内）。 -->
      <p class="text-muted-foreground mb-1.5 px-0.5 text-[10px]" data-testid="composer-set-market-hint">
        市场组合为只读快照——开工自动复制到我的材料
      </p>
    {/if}
  {/if}
  {#if approvalActive}
    <!-- [product-polish-w2 T3] 审批 zStack：待审批（含过期未处理）非空时 textarea
         整块替换——按帧序排队逐个处理；后卡顶部露出 ~6px+计数徽标；top-inline-end
         左右箭头切卡（键盘 ←/→ 同门）。草稿保留在 text 状态（栈清空即恢复）。 -->
    <div
      class="relative mt-1 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      role="toolbar"
      aria-label="待审批队列（{safeApprovalIndex + 1}/{approvals.length}，左右方向键切换）"
      tabindex="0"
      data-testid="composer-approval-stack"
      onkeydown={onApprovalKeydown}
    >
      <!-- top-inline-end：计数徽标+左右切卡。 -->
      <div class="mb-1 flex items-center justify-end gap-1 px-1">
        <span class="text-muted-foreground font-mono text-[10px]" data-testid="composer-approval-count">
          {safeApprovalIndex + 1}/{approvals.length}
        </span>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="上一张审批卡"
          title="上一张（←）"
          data-testid="composer-approval-prev"
          disabled={safeApprovalIndex === 0}
          onclick={() => switchApproval(-1)}
        >
          <IconChevronLeft class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="flex h-6 w-6 items-center justify-center rounded border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          aria-label="下一张审批卡"
          title="下一张（→）"
          data-testid="composer-approval-next"
          disabled={safeApprovalIndex >= approvals.length - 1}
          onclick={() => switchApproval(1)}
        >
          <IconChevronRight class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <!-- 层叠视觉：后卡顶部露出 ~6px（上限 3 条——计数徽标显全量）。 -->
      <div class="relative" style="padding-top: {approvalPeeks * 6}px">
        {#each Array(approvalPeeks) as _, depth (depth)}
          <div
            class="absolute inset-x-0 rounded-xl border border-border/70 bg-muted/50"
            style="top: {(approvalPeeks - 1 - depth) * 6}px; height: 10px"
            aria-hidden="true"
          ></div>
        {/each}
        {#if currentApprovalFrame !== null}
          <div class="relative z-10" data-testid="composer-approval-card-{safeApprovalIndex + 1}">
            <ApprovalCard
              frame={currentApprovalFrame}
              pending={true}
              inline={true}
              showActions={true}
              onskip={approvalSkip}
            />
          </div>
        {/if}
      </div>
    </div>
  {:else}
    <textarea
      bind:this={textareaEl}
      bind:value={text}
      {onkeydown}
      oninput={syncCaret}
      onclick={syncCaret}
      onkeyup={syncCaret}
      onpaste={onpaste}
      data-testid="agent-composer"
      placeholder={editingActive ? '编辑队列消息（Enter 确认，Esc 取消）…' : placeholder}
      rows="1"
      class="block w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-6 outline-none placeholder:text-muted-foreground/70"
    ></textarea>
  {/if}
  <!-- [product-polish-w2 T2] 工具行升级（Owner 指令）：`Add 自动批准] [Context Model
       Effect Send`——左簇=添加图片+集合选择+自动批准 toggle（从状态条迁入）；右簇=
       上下文表+模型 chip+强度 chip+发送位。自动批准压缩态 icon+「自动」、开启态
       primary 描边；卡宽不足时容器查询收成纯 icon（title 保说明）。
       [w17-critic T3] 窄卡（移动端 390px）残元素裁切修复：工具行 flex-wrap（右簇
       整簇换行不溢出）+ chip 宽容器查询收缩（模型/强度名窄卡截断可读）。 -->
  <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
    <div class="flex shrink-0 items-center gap-1.5">
      {#if canUpload}
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
          title="添加图片（≤4MiB/张）"
          aria-label="添加图片"
          disabled={uploading || disabled || sending}
          onclick={() => fileInput?.click()}
        >
          <IconImage class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      {/if}
      {#if autoApprove !== null && onsetautoapprove !== null && onsetautoapprove !== undefined}
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none {autoApprove
            ? 'border-primary/60 bg-primary/10 text-primary'
            : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'}"
          role="switch"
          aria-checked={autoApprove === true}
          title="自动批准：开启后本会话的排钻/图层/导出等批准自动通过——免值守跑批（对开启后的新批准生效）"
          aria-label="自动批准（开启后本会话的排钻/图层/导出等批准自动通过——免值守跑批）"
          data-testid="composer-auto-approve"
          disabled={disabled}
          onclick={() => onsetautoapprove(!(autoApprove ?? false))}
        >
          <IconShieldCheck class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span class="auto-approve-label shrink-0 font-medium">自动</span>
        </button>
      {/if}
      {#if canPickSet}
      <!-- 集合选择入口（1.2）：附件位旁同款图标位（单选 Popover——搜索+集合名+
           成员数+更新时间；跳过=不选，空态/脚注明示「本项目暂不引入集合成员」）。 -->
      <Popover.Root
        open={setMenuOpen}
        onOpenChange={(open) => {
          setMenuOpen = open
          if (!open) setQuery = ''
        }}
      >
        <Popover.Trigger>
          {#snippet child({ props })}
            <button
              type="button"
              {...props}
              class="flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 {selectedSet !==
              null
                ? 'text-primary'
                : 'text-muted-foreground'}"
              title="选择素材集合（项目钻清单来源，仅首条消息可选）"
              aria-label="选择素材集合"
              data-testid="composer-set-trigger"
              disabled={disabled || sending}
            >
              <IconBoxes class="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content class="w-72 p-0" data-testid="composer-set-popover">
          <div class="border-b border-border p-2">
            <input
              bind:value={setQuery}
              type="text"
              placeholder="搜索集合…"
              aria-label="搜索集合"
              data-testid="composer-set-search"
              class="block w-full rounded-md border border-border bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/70"
            />
          </div>
          <div class="max-h-64 overflow-y-auto p-1" data-testid="composer-set-list">
            {#if setOptions === null && !setLoadFailed}
              <div class="px-2 py-1.5 text-xs text-muted-foreground">加载集合…</div>
            {:else if setLoadFailed}
              <div class="px-2 py-1.5 text-xs text-muted-foreground">集合目录不可用（关闭后重试）</div>
            {:else if filteredSetOptions.length === 0}
              <div class="px-2 py-1.5 text-xs text-muted-foreground">无匹配集合——本项目暂不引入集合成员</div>
            {:else}
              <!-- 分组（product-polish-w1 T3——N1「挑组合」）：我的组合置顶；材料市场
                   组合默认折叠（搜索时自动展开——查询命中不藏行）。 -->
              {#snippet setOptionRow(option: AgentSetSummary, market: boolean)}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {selectedSet?.resourceId ===
                  option.resourceId
                    ? 'bg-accent-soft'
                    : ''}"
                  data-testid="composer-set-option"
                  data-scope={market ? 'market' : 'mine'}
                  aria-label="选择集合 {option.name}"
                  onclick={() => pickSet(option)}
                >
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {#if selectedSet?.resourceId === option.resourceId}
                      <IconCheck class="h-3 w-3" aria-hidden="true" />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{option.name}</span>
                    <span class="block truncate text-[10px] text-muted-foreground">
                      {option.memberCount} 成员 · {formatSetUpdatedAt(option.updatedAt)}
                    </span>
                  </span>
                  {#if market}
                    <span class="shrink-0 rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">市场</span>
                  {/if}
                </button>
              {/snippet}
              {#if mineSetOptions.length > 0}
                <div class="px-2 pb-0.5 pt-1 text-[10px] font-medium text-muted-foreground" data-testid="composer-set-group-mine">
                  我的组合
                </div>
                {#each mineSetOptions as option (option.resourceId)}
                  {@render setOptionRow(option, false)}
                {/each}
              {/if}
              {#if marketSetOptions.length > 0}
                <button
                  type="button"
                  class="flex w-full items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-muted/40"
                  data-testid="composer-set-group-market"
                  aria-expanded={marketGroupOpen || setQuery.trim() !== ''}
                  onclick={() => (marketGroupOpen = !marketGroupOpen)}
                >
                  <IconChevronDown
                    class="h-3 w-3 shrink-0 transition-transform {(marketGroupOpen || setQuery.trim() !== '') ? '' : '-rotate-90'}"
                    aria-hidden="true"
                  />
                  <span>材料市场组合（{marketSetOptions.length}）</span>
                </button>
                {#if marketGroupOpen || setQuery.trim() !== ''}
                  {#each marketSetOptions as option (option.resourceId)}
                    {@render setOptionRow(option, true)}
                  {/each}
                {/if}
              {/if}
            {/if}
          </div>
          <div class="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground" data-testid="composer-set-skip-hint">
            不选=跳过：本项目暂不引入集合成员（发送后仍可在任务中追加钻）· 市场组合开工自动复制到我的材料
          </div>
        </Popover.Content>
      </Popover.Root>
    {/if}
    </div>
    <div class="min-w-0 flex-1"></div>
    <!-- 右簇：Context + Model + Effect + Send（zhumo 对照清单 T3 同组 gap-1.5）。 -->
    <div class="flex shrink-0 items-center gap-1.5">
      <ContextMeter
        {usage}
        {capacity}
        disabled={disabled || sending || running}
        oncompact={() => onsend('/compact')}
      />
    {#if groups.length > 0}
      <Popover.Root open={menuOpen} onOpenChange={(open) => (menuOpen = open)}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <button
              type="button"
              {...props}
              class="composer-chip composer-chip-model flex h-7 max-w-[200px] items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={running ? '本轮结束后再切换' : '切换本任务使用的模型'}
              aria-label="切换模型"
              data-testid="composer-model-chip"
              disabled={running || disabled}
            >
              <span class="truncate">{chipLabel}</span>
              <IconChevronDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            </button>
          {/snippet}
        </Popover.Trigger>
        <Popover.Content class="w-64 p-0">
          <div class="max-h-72 overflow-y-auto p-1">
            {#each groups as group (group.provider)}
              <div class="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium text-muted-foreground">
                {#if group.iconUrl}
                  <img
                    src={group.iconUrl}
                    alt=""
                    class="h-3.5 w-3.5 rounded object-contain dark:invert"
                    onerror={(event) => ((event.currentTarget as HTMLImageElement).style.display = 'none')}
                  />
                {:else}
                  <span
                    class="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-[8px] font-semibold text-white"
                    style="background: {routeAvatarColor({ provider: group.provider })}"
                    aria-hidden="true">{routeLetter({ provider: group.provider })}</span
                  >
                {/if}
                <span class="truncate">{group.provider}</span>
              </div>
              {#each group.models as item (item.provider + '::' + item.model)}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {isActive(item.provider, item.model)
                    ? 'bg-accent-soft'
                    : ''}"
                  data-testid="composer-model-option"
                  onclick={() => {
                    menuOpen = false
                    onsetmodel?.(item.provider, item.model)
                  }}
                >
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {#if isActive(item.provider, item.model)}
                      <IconCheck class="h-3 w-3" aria-hidden="true" />
                    {/if}
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block truncate">{item.name}</span>
                    {#if item.contextWindow !== undefined}
                      <span class="block truncate text-[10px] text-muted-foreground">
                        {formatTokenCount(item.contextWindow)} 上下文
                      </span>
                    {/if}
                  </span>
                  {#if (item.inputTypes ?? ['text']).includes('image')}
                    <IconImage class="h-3 w-3 shrink-0 text-muted-foreground" aria-label="支持图片输入" />
                  {/if}
                  {#if isDefaultModel(item.provider, item.model)}
                    <span class="shrink-0 rounded-full border border-border px-1.5 py-0.5 text-[9px] text-muted-foreground">默认</span>
                  {/if}
                </button>
              {/each}
            {/each}
            {#if defaultModel !== null}
              <div class="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
                后台默认：{defaultModel.provider} / {defaultModel.model}
              </div>
            {/if}
          </div>
        </Popover.Content>
      </Popover.Root>
      {#if activeEfforts.length > 0 && onseteffort !== undefined}
        <Popover.Root open={effortOpen} onOpenChange={(open) => (effortOpen = open)}>
          <Popover.Trigger>
            {#snippet child({ props })}
            <button
              type="button"
              {...props}
              class="composer-chip composer-chip-effort flex h-7 max-w-[140px] items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={running ? '本轮结束后再切换' : '思考强度档位'}
              aria-label="切换思考强度"
              data-testid="composer-effort-chip"
              disabled={running || disabled}
            >
                {#if currentEffort !== null}
                  <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden="true"></span>
                {/if}
                <span class="truncate">{currentEffort ?? (defaultEffortValue !== null ? `${defaultEffortValue}（默认）` : '模型默认')}</span>
                <IconChevronDown class="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
              </button>
            {/snippet}
          </Popover.Trigger>
          <Popover.Content class="w-48 p-0">
            <div class="max-h-64 overflow-y-auto p-1">
              <button
                type="button"
                class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {currentEffort ===
                null
                  ? 'bg-accent-soft'
                  : ''}"
                data-testid="composer-effort-default"
                onclick={() => {
                  effortOpen = false
                  onseteffort(null)
                }}
              >
                <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                  {#if currentEffort === null}
                    <IconCheck class="h-3 w-3" aria-hidden="true" />
                  {/if}
                </span>
                <span>{defaultEffortValue !== null ? `${defaultEffortValue}（默认）` : '模型默认'}</span>
              </button>
              {#each activeEfforts as effort (effort)}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {currentEffort ===
                    effort
                      ? 'bg-accent-soft'
                      : ''}"
                  data-testid="composer-effort-option"
                  onclick={() => {
                    effortOpen = false
                    onseteffort(effort)
                  }}
                >
                  <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {#if currentEffort === effort}
                      <IconCheck class="h-3 w-3" aria-hidden="true" />
                    {/if}
                  </span>
                  <span>{effort}</span>
                </button>
              {/each}
            </div>
          </Popover.Content>
        </Popover.Root>
      {/if}
    {/if}
    {#if editingActive}
      <!-- W10b 队列编辑：发送位变「确认修改」+ 取消（Owner 设计）。 -->
      <Button
        size="sm"
        variant="outline"
        class="h-8 w-8 rounded-full p-0"
        data-testid="agent-edit-cancel"
        disabled={disabled}
        onclick={() => oncanceledit?.()}
        aria-label="取消编辑"
        title="取消编辑（队列按原样放回）"
      >
        <IconX class="h-4 w-4" />
      </Button>
      <Button
        size="sm"
        class="h-8 w-8 rounded-full p-0"
        data-testid="agent-edit-confirm"
        disabled={sending || disabled || text.trim().length === 0}
        onclick={() => submit()}
        aria-label="确认修改"
        title="确认修改（该条及其后按原序放回队列）"
      >
        <IconCheck class="h-4 w-4" />
      </Button>
    {:else if running && !hasPayload && onstop !== null}
      <!-- W10 三态：运行中且无可发载荷 → 停止（打断，任务回 done 可续聊）；
           2.6.3 纯图门——有附件即视作有输入（发送位不退场）。 -->
      <Button
        size="sm"
        class="h-8 w-8 rounded-full p-0 hover:bg-destructive/10 hover:text-destructive"
        data-testid="agent-stop"
        disabled={disabled}
        onclick={stop}
        aria-label="停止生成"
        title="停止生成（已排队的消息保留）"
      >
        <IconSquare class="h-3.5 w-3.5 fill-current" />
      </Button>
    {:else}
      {#if running && onstop !== null}
        <!-- 停止常驻（Codex UX P2：不与发送互斥——主操作位稳定，随时可停）。 -->
        <Button
          size="sm"
          class="h-8 w-8 rounded-full p-0 hover:bg-destructive/10 hover:text-destructive"
          data-testid="agent-stop"
          disabled={disabled}
          onclick={stop}
          aria-label="停止生成"
          title="停止生成（已排队的消息保留）"
        >
          <IconSquare class="h-3.5 w-3.5 fill-current" />
        </Button>
      {/if}
      {#if running && text.trim().length > 0}
        <!-- 贴钻 W10 语义保真：引导直达按钮（steer 立即投递当前任务——下一 step
             边界生效；zhumo W10m 收敛为队列行模式选择，贴钻双路并存）。2.6.3：
             steer 只面向文本（steer+附件被服务端 typed 拒——有附件时走排队发送）。 -->
        <Button
          size="sm"
          variant="outline"
          class="h-8 rounded-full px-2.5"
          data-testid="agent-steer"
          disabled={sending || disabled || approvalActive}
          onclick={() => submit('steer')}
          aria-label="引导"
          title="立即引导：不等本轮结束，下一步即生效"
        >
          <IconZap class="h-3.5 w-3.5" aria-hidden="true" />
          <span class="text-[11px]">引导</span>
        </Button>
      {/if}
      <!-- running 时发送=排队（当前轮结束后自动开跑）；idle=常规发送。
           2.6.3 纯图门：文本或附件至少其一即可发。[T3] 市场组合复制中禁用（防双发）；
           [product-polish-w2 T3] 审批栈在场=发送禁用（textarea 已被审批卡替换——
           处理完恢复）。 -->
      <Button
        size="sm"
        class="h-8 w-8 rounded-full p-0"
        data-testid="agent-send"
        disabled={sending || disabled || !hasPayload || copyingMarketSet || approvalActive}
        onclick={() => void submit()}
        aria-label={running ? '排队发送' : '发送'}
        title={running ? '排队发送：本轮结束后自动开跑' : '发送'}
      >
        {#if copyingMarketSet}
          <IconLoader class="h-4 w-4 animate-spin" aria-hidden="true" />
        {:else}
          <IconSend class="h-4 w-4" />
        {/if}
      </Button>
    {/if}
    </div>
  </div>

  {#if dragActive}
    <!-- 拖放高亮（pointer-events-none——事件面仍归卡根，overlay 不劫持 drag 序列）。 -->
    <div
      class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 text-xs font-medium text-primary"
      data-testid="composer-drag-overlay"
    >
      松开添加图片
    </div>
  {/if}
</div>

<!-- [product-polish-w2 T2] 容器查询（卡宽自适应——比视口媒体查询更贴近「工具行
     宽度不够」的真实边界）：窄卡时自动批准收成纯 icon（title 保说明）。 -->
<style>
  .composer-card {
    container-type: inline-size;
  }
  @container (max-width: 600px) {
    .auto-approve-label {
      display: none;
    }
  }
  /* [w17-critic T3] 窄卡 chip 收缩（flex-wrap 之外给长模型名留可读宽度）。 */
  @container (max-width: 480px) {
    .composer-chip-model {
      max-width: 132px;
    }
    .composer-chip-effort {
      max-width: 104px;
    }
  }
</style>
