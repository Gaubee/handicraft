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
-->
<script lang="ts">
  import IconSend from '@lucide/svelte/icons/send'
  import IconSquare from '@lucide/svelte/icons/square'
  import IconChevronDown from '@lucide/svelte/icons/chevron-down'
  import IconCheck from '@lucide/svelte/icons/check'
  import IconImage from '@lucide/svelte/icons/image'
  import IconX from '@lucide/svelte/icons/x'
  import IconLoader from '@lucide/svelte/icons/loader-circle'
  import IconZap from '@lucide/svelte/icons/zap'
  import IconBoxes from '@lucide/svelte/icons/boxes'
  import { Button } from '$lib/components/ui/button'
  import * as Popover from '$lib/components/ui/popover'
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
     * 入口隐藏，与 uploadAttachment 注入面同款在否语义）。
     */
    loadSetOptions = undefined,
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
  } = $props()

  /** 实例方法（Owner 2026-09-28 复用整卡）：外部注入文本。 */
  export function setPrompt(value: string): void {
    text = value
    requestCaretEnd()
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

  /** 三入口同门（选择/粘贴/拖入）：图片过滤→尺寸门→数量门→去重→上传（首败即停）。 */
  async function onFilesPicked(files: FileList | null): Promise<void> {
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

  /** 拖入（drop 到输入卡区域；dragover 放行 Files 才可落）。 */
  function ondragover(event: DragEvent): void {
    if (Array.from(event.dataTransfer?.types ?? []).includes('Files')) event.preventDefault()
  }

  function ondrop(event: DragEvent): void {
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

  function submit(mode: 'followup' | 'steer' = 'followup'): void {
    const trimmed = text.trim()
    // 纯图门（2.6.3）：空文本+有附件可发；编辑态确认仍需文本（队列编辑回填面）。
    if (!hasPayload || sending || disabled) return
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
    const payloadSourceSetId = mode === 'followup' && selectedSet !== null ? selectedSet.resourceId : undefined
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

  /** 自动长高（1 行 → 4 行封顶内滚）。 */
  let textareaEl = $state<HTMLTextAreaElement | null>(null)
  $effect(() => {
    void text
    const el = textareaEl
    if (el === null) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`
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
  class="relative rounded-xl border border-border bg-card p-2 shadow-sm"
  role="region"
  aria-label="消息输入区，支持拖入图片"
  ondragover={ondragover}
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
       提示+可清除（清除=回到跳过态，不强制选择）。 -->
  {#if selectedSet !== null}
    <div class="mb-1.5 flex flex-wrap gap-1" data-testid="composer-set-chip">
      <span class="flex items-center gap-1.5 rounded-md border border-border bg-muted/40 py-1 pl-1.5 pr-1 text-[10px]">
        <IconBoxes class="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="max-w-40 truncate font-medium">{selectedSet.name}</span>
        <span class="shrink-0 text-muted-foreground">{selectedSet.memberCount} 成员</span>
        <span class="shrink-0 text-muted-foreground/80">· 任务中可追加钻</span>
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
  {/if}
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
  <div class="mt-1 flex items-center gap-2 px-1">
    <div class="flex-1">
      <ContextMeter
        {usage}
        {capacity}
        disabled={disabled || sending || running}
        oncompact={() => onsend('/compact')}
      />
    </div>
    {#if canUpload}
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
        title="附加图片（≤4MiB/张）"
        aria-label="附加图片"
        disabled={uploading || disabled || sending}
        onclick={() => fileInput?.click()}
      >
        <IconImage class="h-3.5 w-3.5" aria-hidden="true" />
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
              {#each filteredSetOptions as option (option.resourceId)}
                <button
                  type="button"
                  class="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted/60 {selectedSet?.resourceId ===
                  option.resourceId
                    ? 'bg-accent-soft'
                    : ''}"
                  data-testid="composer-set-option"
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
                </button>
              {/each}
            {/if}
          </div>
          <div class="border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground" data-testid="composer-set-skip-hint">
            不选=跳过：本项目暂不引入集合成员（发送后仍可在任务中追加钻）
          </div>
        </Popover.Content>
      </Popover.Root>
    {/if}
    {#if groups.length > 0}
      <Popover.Root open={menuOpen} onOpenChange={(open) => (menuOpen = open)}>
        <Popover.Trigger>
          {#snippet child({ props })}
            <button
              type="button"
              {...props}
              class="flex h-7 max-w-[200px] items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              title={running ? '本轮结束后再切换' : '切换本任务使用的模型'}
              aria-label="切换模型"
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
                class="flex h-7 max-w-[140px] items-center gap-1.5 rounded-full border border-border px-2.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                title={running ? '本轮结束后再切换' : '思考强度档位'}
                aria-label="切换思考强度"
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
          disabled={sending || disabled}
          onclick={() => submit('steer')}
          aria-label="引导"
          title="立即引导：不等本轮结束，下一步即生效"
        >
          <IconZap class="h-3.5 w-3.5" aria-hidden="true" />
          <span class="text-[11px]">引导</span>
        </Button>
      {/if}
      <!-- running 时发送=排队（当前轮结束后自动开跑）；idle=常规发送。
           2.6.3 纯图门：文本或附件至少其一即可发。 -->
      <Button
        size="sm"
        class="h-8 w-8 rounded-full p-0"
        data-testid="agent-send"
        disabled={sending || disabled || !hasPayload}
        onclick={() => submit()}
        aria-label={running ? '排队发送' : '发送'}
        title={running ? '排队发送：本轮结束后自动开跑' : '发送'}
      >
        <IconSend class="h-4 w-4" />
      </Button>
    {/if}
  </div>
</div>
