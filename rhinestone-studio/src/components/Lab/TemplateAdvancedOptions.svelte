<!--
TemplateAdvancedOptions.svelte——模板高级选项区（openspec add-lab-drill-params-and-blueprint
C 3.1 + add-lab-effect-prompt-placeholders 切片 3；design §0.2/§1.1/§6.1/§4：三个正交、
独立启用、模板级的高级选项 + 每开关的效果提示词铅笔入口）。

宿主 = TemplateEditor 内嵌（双宿主同步受益：实验室手风琴与素材库 RightSheet 同 record 互见，
add-project-files 4.3b 先例）；编辑态真源 = templates store record（本组件不持副本，
PRODUCT_MODEL 硬规则 7）；提交 = 字段提交自动换绑（onchange/blur → submitTemplateField，
design §1.1「提交模型」）。

- 案例参照图（placeholders 新增：原必选绑定 → 功能开关）：开关 + 选图配置面（内嵌
  EffectRefControl——拼接合成/单张案例/粘贴链接三 tab 沿用，仅当开关开时可用；关灯不丢绑定）。
  读面归一 caseRefEnabledOf：键缺席 + 绑定在 = 开（旧模板零行为变化）。
- 水钻参数配置：开关 + 钻清单（specKey 引用；编号=数组序）+ 画幅物理尺寸必填声明
  （[lab-ux 5] 勾选式可选退役——恒显宽高输入 + 必填标记；startRun fail-fast 兜底）。
  写入门 enabled⇒specs≥1 的 UI 对齐：空清单拨开开关 = 展开表单等首个规格（不落非法键），
  首个规格入单即点亮 enabled；关灯提交 {enabled:false, specs 原样}（数据保留，UX 底线）。
- 蓝图效果（beta）：开关 + Beta 徽标 + 不稳定声明 tooltip（design §4.4）+ 原图槽 ≤2。
  [lab-ux 4] refs 槽 = 缩略平铺 + 点击大图预览（id 只进 title/alt 与预览角注——素材库懒解析
  objectURL；missing 态占位图标；空态引导选择）。
- [placeholders] 每开关旁效果提示词 icon button（[lab-ux 1] TextQuote——文本+引号＝提示词语义，
  弃 Pencil）→ 共享 EffectPromptDialog（textarea 预填自动文案 + 保存/取消/插入到提示词；
  插入幂等与光标位经宿主 insertIntoPromptBody 回调）。
- 规格选择器 = 真源目录（gemCatalogService sys-shapes 资产 hydrate）；missing specKey 显示
  「规格缺失」警告角标；策略选择不入模板（任务级，发起面板——design §4.3）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import * as Dialog from '$lib/components/ui/dialog'
  import HelpTip from '../HelpTip.svelte'
  import EffectRefControl from './EffectRefControl.svelte'
  import EffectPromptDialog from './EffectPromptDialog.svelte'
  import {
    BLUEPRINT_REFS_MAX,
    caseRefEnabledOf,
    validateGemtplDrillParams,
  } from '$lib/lab/advancedOptions'
  import {
    appendEffectPromptPlaceholder,
    autoBlueprintPromptFragment,
    buildDrillSpecSection,
    deriveMaterialAttachments,
    EFFECT_PROMPT_PLACEHOLDERS,
    orderDrillImages,
    removeEffectPromptPlaceholder,
    type DrillPromptImageRoles,
    type EffectPromptKey,
  } from '$lib/lab/prompt'
  import { autoCaseRefFragment } from '$lib/presets/effectRefs'
  import { gemCatalog, type CatalogSpec } from '$lib/services/gemCatalogService'
  import type { GemSpecSnapshot } from '$lib/engine'
  import { getReference } from '$lib/stores/lab.svelte'
  import { assetPicker } from '$lib/assets/controller.svelte'
  import { ensureLibraryReady, getUrl as getAssetUrl, nodeById } from '$lib/assets/library.svelte'
  import { getTemplateRecord, submitTemplateField } from '$lib/stores/templates.svelte'
  import X from '@lucide/svelte/icons/x'
  import Plus from '@lucide/svelte/icons/plus'
  import TextQuote from '@lucide/svelte/icons/text-quote'
  import ImageIcon from '@lucide/svelte/icons/image'
  import ImageOff from '@lucide/svelte/icons/image-off'

  let { templateAssetId }: { templateAssetId: string } = $props()

  const record = $derived(getTemplateRecord(templateAssetId))
  const drill = $derived(record?.drillParams)
  const blueprint = $derived(record?.blueprint)
  // [placeholders] 案例开关读面归一：caseRef 键缺席 + 绑定在 = 开（旧模板零行为变化）
  const caseOn = $derived(caseRefEnabledOf(record?.caseRef, record?.caseBinding ?? null))

  // 「空清单拨开」中间态：开关视觉展开表单等首个规格（record 尚未落 enabled=true）
  let drillPendingOpen = $state(false)
  const drillOn = $derived(drill?.enabled === true || drillPendingOpen)
  const blueprintOn = $derived(blueprint?.enabled === true)

  // ---------------------------------------------------------------------------
  // 钻形目录（真源 = gemCatalogService sys-shapes 资产 hydrate——mock 目录退役为夹具）
  // ---------------------------------------------------------------------------

  const catalog = gemCatalog
  /** 目录选项（选择器数据源；真源 = sys-shapes .gemshape 资产：内置 seed 声明序 + 自定义入库序）。 */
  let catalogSpecs = $state<CatalogSpec[]>([])
  /** 清单 specKey → 目录条目解析缓存（undefined = missing——警告角标判据，发起侧 fail-fast 归 4.3）。 */
  let specViews = $state<Record<string, CatalogSpec | undefined>>({})

  $effect(() => {
    let cancelled = false
    void catalog.listSpecs().then((specs) => {
      if (!cancelled) catalogSpecs = specs
    })
    return () => {
      cancelled = true
    }
  })

  // record.specs 变化 → 逐键解析展示视图（清单行规格码/形状/尺寸；未知键显示占位）
  $effect(() => {
    const specs = drill?.specs ?? []
    const key = specs.join('\u0000')
    let cancelled = false
    void (async () => {
      const resolved: Record<string, CatalogSpec | undefined> = {}
      for (const specKey of specs) {
        resolved[specKey] = await catalog.resolveSpec(specKey)
      }
      if (!cancelled) specViews = resolved
    })()
    return () => {
      cancelled = true
    }
  })

  /** 软上限警告（文案单一真源 = advancedOptions validation；>8 只警告不阻断）。 */
  const drillWarnings = $derived.by(() => {
    if (drill === undefined) return [] as string[]
    try {
      return validateGemtplDrillParams(drill).warnings.map((w) => w.message)
    } catch {
      return [] as string[]
    }
  })

  // ---------------------------------------------------------------------------
  // 水钻参数配置提交（写入门对齐：enabled=true 仅在 specs≥1 时提交）
  // [lab-ux 2] promptBody 可选通道：开关换档时与效果键同一 patch 提交（占位符注入/移除
  // 单次落盘——append/remove 纯函数在调用侧按换档方向物化）。
  // ---------------------------------------------------------------------------

  function submitDrill(
    patch: { enabled?: boolean; specs?: string[]; physical?: PhysicalPatch; promptFragment?: string | null },
    promptBody?: string,
  ): void {
    const base = drill ?? { enabled: false, specs: [] as string[] }
    // physical 语义：patch 显式携带（含 null=撤销声明）用之；否则沿用 base（提交面局部补丁）
    const physical = 'physical' in patch ? patch.physical : base.physical
    // promptFragment 语义：null = 清除覆盖；undefined = 沿用 base
    const promptFragment = patch.promptFragment === null ? undefined : (patch.promptFragment ?? base.promptFragment)
    const next = {
      enabled: patch.enabled ?? base.enabled,
      specs: patch.specs ?? [...base.specs],
      ...(physical !== undefined && physical !== null ? { physical } : {}),
      ...(promptFragment !== undefined ? { promptFragment } : {}),
    }
    submitTemplateField(templateAssetId, { drillParams: next, ...(promptBody !== undefined ? { promptBody } : {}) })
  }

  function toggleDrill(next: boolean): void {
    if (next) {
      // 空清单 + 从未配置：不落 enabled=true（validate 门拒写），先展开表单等首个规格
      if ((drill?.specs.length ?? 0) === 0) {
        drillPendingOpen = true
        return
      }
      // [lab-ux 2] 开关开 → 占位符缺席时自动注入（已存在任何位置不动）
      submitDrill({ enabled: true }, appendEffectPromptPlaceholder(record?.promptBody ?? '', 'drillParams'))
    } else {
      drillPendingOpen = false
      // 关灯不丢清单（数据保留）+ [lab-ux 2] 自动移除占位符
      if (drill !== undefined) {
        submitDrill({ enabled: false }, removeEffectPromptPlaceholder(record?.promptBody ?? '', 'drillParams'))
      }
    }
  }

  function addSpec(event: Event): void {
    const select = event.currentTarget as HTMLSelectElement
    const key = select.value
    select.value = '' // 允许重复打开同一选项
    if (!key) return
    const specs = drill?.specs ?? []
    if (specs.includes(key)) return // UI 先挡去重（validate 门同约束）
    // 首个规格入单即点亮开关（pendingOpen 收敛）；关灯态加规格保持 enabled 原值
    // [lab-ux 2] enabled false→true 换档 = 开关点亮 → 注入占位符（同 patch）
    const wasEnabled = drill?.enabled === true
    const willEnabled = drill?.enabled ?? drillPendingOpen
    submitDrill(
      { specs: [...specs, key], enabled: willEnabled },
      willEnabled && !wasEnabled ? appendEffectPromptPlaceholder(record?.promptBody ?? '', 'drillParams') : undefined,
    )
    drillPendingOpen = false
  }

  function removeSpec(key: string): void {
    const specs = drill?.specs ?? []
    const next = specs.filter((s) => s !== key)
    // 移除至空：enabled 退 false（enabled⇒specs≥1 写入门；空清单=关灯空态合法）
    // [lab-ux 2] enabled true→false 换档 = 开关熄灭 → 移除占位符（同 patch）
    const wasEnabled = drill?.enabled === true
    const willEnabled = next.length === 0 ? false : (drill?.enabled ?? false)
    submitDrill(
      { specs: next, enabled: willEnabled },
      wasEnabled && !willEnabled ? removeEffectPromptPlaceholder(record?.promptBody ?? '', 'drillParams') : undefined,
    )
  }

  // ---------------------------------------------------------------------------
  // 画幅物理尺寸（[lab-ux 5] 必选——Owner 2026-09-21「不该是可选，而是必选」：
  // 勾选式声明退役；宽高输入恒在（drillOn 时），两值合法即提交；未声明 = 必填提示 +
  // startRun fail-fast 兜底）
  // ---------------------------------------------------------------------------

  type PhysicalPatch = { widthMm: number; heightMm: number; anchorSource: 'declared' } | null

  /** 宽高输入缓冲（record 为真源；外部提交变化时重置对齐——未声明时留空由 placeholder 示例）。 */
  let widthText = $state('')
  let heightText = $state('')
  let physicalError = $state(false)
  const physicalDeclared = $derived(drill?.physical !== undefined)

  $effect(() => {
    widthText = drill?.physical !== undefined ? String(drill.physical.widthMm) : ''
    heightText = drill?.physical !== undefined ? String(drill.physical.heightMm) : ''
    physicalError = false
  })

  function commitPhysical(): void {
    // 单侧未填 = 填写中（不算错误——必填提示承担反馈；两值齐才校验提交）
    if (widthText.trim() === '' || heightText.trim() === '') {
      physicalError = false
      return
    }
    const widthMm = Number(widthText)
    const heightMm = Number(heightText)
    if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0) {
      physicalError = true // 不提交（record 保持旧值）；缓冲保留供修正
      return
    }
    physicalError = false
    submitDrill({ physical: { widthMm, heightMm, anchorSource: 'declared' } })
  }

  function handleWidthChange(event: Event): void {
    widthText = (event.currentTarget as HTMLInputElement).value
    commitPhysical()
  }

  function handleHeightChange(event: Event): void {
    heightText = (event.currentTarget as HTMLInputElement).value
    commitPhysical()
  }

  // ---------------------------------------------------------------------------
  // 蓝图效果提交（beta；AssetPickerHost 选图接线——refs ≤2 去重，validate 门兜底）
  // ---------------------------------------------------------------------------

  function submitBlueprint(
    patch: { enabled?: boolean; refs?: string[]; promptFragment?: string | null },
    promptBody?: string,
  ): void {
    const base = blueprint
    const promptFragment =
      patch.promptFragment === null ? undefined : (patch.promptFragment ?? base?.promptFragment)
    submitTemplateField(templateAssetId, {
      blueprint: {
        enabled: patch.enabled ?? base?.enabled ?? false,
        ...(patch.refs !== undefined ? { refs: patch.refs } : base?.refs !== undefined ? { refs: [...base.refs] } : {}),
        ...(promptFragment !== undefined ? { promptFragment } : {}),
      },
      ...(promptBody !== undefined ? { promptBody } : {}),
    })
  }

  function toggleBlueprint(next: boolean): void {
    // [lab-ux 2] 开关即注入/移除（占位符与效果键同一 patch 单次落盘）
    const body = record?.promptBody ?? ''
    submitBlueprint(
      { enabled: next },
      next ? appendEffectPromptPlaceholder(body, 'blueprint') : removeEffectPromptPlaceholder(body, 'blueprint'),
    )
  }

  function removeBlueprintRef(assetId: string): void {
    submitBlueprint({ refs: (blueprint?.refs ?? []).filter((r) => r !== assetId) })
  }

  /** 从素材库选蓝图参考图（App 层 AssetPickerHost 单实例协议：open → resolve 资产集）。 */
  async function addBlueprintRef(): Promise<void> {
    const remaining = BLUEPRINT_REFS_MAX - (blueprint?.refs?.length ?? 0)
    if (remaining <= 0) return
    const picked = await assetPicker.open({ multi: true, initialFolderId: 'sys-uploads' })
    if (picked === null || picked.length === 0) return
    const refs = [...(blueprint?.refs ?? [])]
    for (const image of picked) {
      if (refs.length >= BLUEPRINT_REFS_MAX) break
      if (!refs.includes(image.id)) refs.push(image.id)
    }
    submitBlueprint({ refs })
  }

  // ---------------------------------------------------------------------------
  // [lab-ux 4] 蓝图参考图缩略预览（Owner 2026-09-21：id 尾巴不可读——要图片预览）
  // 缩略 URL = 素材库懒解析 objectURL（getUrl：undefined=解析中 / null=blob 失效）；
  // 资产 id 只进 title/alt 与预览角注，不做正文；点击缩略开预览 Dialog。
  // ---------------------------------------------------------------------------

  /** 缩略解析态：'loading' | 'missing' | url。missing = 节点不在库 或 blob 已失效。 */
  function refThumbState(assetId: string): { kind: 'loading' } | { kind: 'missing' } | { kind: 'url'; url: string } {
    const url = getAssetUrl(assetId)
    if (url !== undefined && url !== null) return { kind: 'url', url }
    if (url === null || nodeById(assetId) === null) return { kind: 'missing' }
    return { kind: 'loading' }
  }

  /** 预览中的蓝图参考图资产 id（null = 预览关）。 */
  let previewRefId = $state<string | null>(null)
  let previewRefOpen = $state(false)
  const previewRefState = $derived(previewRefId !== null ? refThumbState(previewRefId) : null)

  // 蓝图开且有 refs 时确保素材库投影就绪（getUrl 懒解析的唯一触发面；幂等）
  $effect(() => {
    if (blueprint?.enabled === true && (blueprint.refs?.length ?? 0) > 0) void ensureLibraryReady()
  })

  function shapeLabel(spec: CatalogSpec | undefined): string {
    const shapeNames: Record<string, string> = {
      round: '圆形',
      square: '方形',
      drop: '水滴',
      heart: '心形',
      marquise: '马眼',
      custom: '自定义',
    }
    return spec === undefined ? '未知' : (shapeNames[spec.shapeId] ?? spec.shapeId)
  }

  // ---------------------------------------------------------------------------
  // 案例参照图功能开关（placeholders：原必选绑定 → 正交开关；关灯不丢绑定）
  // ---------------------------------------------------------------------------

  function toggleCase(next: boolean): void {
    // 从未配置 + 关灯 + 无绑定 = 无事可做（不落 enabled:false 空键）
    if (!next && record?.caseRef === undefined && !record?.caseBinding) return
    // [lab-ux 2] 开关即注入/移除（占位符与效果键同一 patch 单次落盘）
    const body = record?.promptBody ?? ''
    submitTemplateField(templateAssetId, {
      promptBody: next ? appendEffectPromptPlaceholder(body, 'caseRef') : removeEffectPromptPlaceholder(body, 'caseRef'),
      caseRef: {
        enabled: next,
        ...(record?.caseRef?.promptFragment !== undefined ? { promptFragment: record.caseRef.promptFragment } : {}),
      },
    })
  }

  // ---------------------------------------------------------------------------
  // 效果提示词 Dialog（三开关共用；TextQuote 入口 → 预填自动文案 + 保存/取消——[lab-ux 2]
  // 「插入到提示词」退役：占位符由开关开/关自动注入/移除，用户在主提示词中自由移动）
  // ---------------------------------------------------------------------------

  /** 打开中的效果（null = 关）。 */
  let promptDialogEffect = $state<EffectPromptKey | null>(null)
  /** Dialog 开合（bind:open——关闭动作归 Dialog 内部，effect 键保留供下次内容稳定）。 */
  let promptDialogOpen = $state(false)
  /** 自动文案预览（打开前按当前模板配置生成；异步解析目录后落位）。 */
  let promptAutoText = $state('')

  const effectTitleOf: Record<EffectPromptKey, string> = {
    caseRef: '案例参照图',
    drillParams: '水钻参数配置',
    blueprint: '蓝图效果',
  }

  const currentFragmentOf = $derived.by((): string | undefined => {
    switch (promptDialogEffect) {
      case 'caseRef':
        return record?.caseRef?.promptFragment
      case 'drillParams':
        return record?.drillParams?.promptFragment
      case 'blueprint':
        return record?.blueprint?.promptFragment
      default:
        return undefined
    }
  })

  const placeholderAlreadyPresent = $derived(
    promptDialogEffect !== null && (record?.promptBody ?? '').includes(EFFECT_PROMPT_PLACEHOLDERS[promptDialogEffect]),
  )

  /** 目录解析（Dialog 预览用；missing 跳过——预览口径，发起时 fail-fast 归 runStage）。 */
  async function resolveSpecSnapshots(specKeys: readonly string[]): Promise<GemSpecSnapshot[]> {
    const out: GemSpecSnapshot[] = []
    for (const [index, key] of specKeys.entries()) {
      const spec = await catalog.resolveSpec(key)
      if (spec === undefined) continue
      out.push({
        specKey: spec.specKey,
        ordinal: index + 1,
        shapeId: spec.shapeId as GemSpecSnapshot['shapeId'],
        sizeLabel: spec.sizeLabel,
        diameterMm: spec.diameterMm,
        ...(spec.widthMm !== undefined ? { widthMm: spec.widthMm } : {}),
        ...(spec.heightMm !== undefined ? { heightMm: spec.heightMm } : {}),
        ...(spec.assetId !== undefined ? { assetId: spec.assetId } : {}),
      })
    }
    return out
  }

  /** 水钻自动文案预览（buildDrillSpecSection——无附图上下文的代表序；发起时按实际图号物化）。 */
  async function previewDrillFragment(): Promise<string> {
    const specs = await resolveSpecSnapshots(drill?.specs ?? [])
    if (specs.length === 0) return '（先在上方选择钻清单——自动文案将生成【尺寸与钻规格】段）'
    const materials = deriveMaterialAttachments(specs).attached.map((m) => m.specCode)
    const order = orderDrillImages({ hasCase: false, caseLayout: 'single', hasReference: false, materials })
    return buildDrillSpecSection({
      specs,
      ...(drill?.physical !== undefined ? { physical: drill.physical } : {}),
      order,
    })
  }

  /** 蓝图自动文案预览（autoBlueprintPromptFragment 串行策略代表形态——片段默认内容可见面；发起时按任务上下文物化同一函数输出）。 */
  async function previewBlueprintFragment(): Promise<string> {
    const specs = await resolveSpecSnapshots(drill?.specs ?? [])
    const materials = deriveMaterialAttachments(specs).attached.map((m) => m.specCode)
    return autoBlueprintPromptFragment(
      { hasEffect: true, hasReference: !!getReference(), materials, blueprintRefs: (blueprint?.refs ?? []).length },
      { blueprint: { hasLegend: specs.length > 0, specs } },
    )
  }

  /**
   * 案例自动文案预览（autoCaseRefFragment——按当前模板附图集形态尽力生成；发起时按
   * 实际附图物化同一函数输出，所见即所发）。水钻开时素材图进附图集（图号连续）。
   */
  async function previewCaseFragment(): Promise<string> {
    const binding = record?.caseBinding ?? null
    const materials =
      drill?.enabled === true
        ? deriveMaterialAttachments(await resolveSpecSnapshots(drill.specs)).attached.map((m) => m.specCode)
        : []
    const roles: DrillPromptImageRoles = {
      hasCase: caseOn && binding !== null,
      caseLayout: binding?.caseLayout ?? 'single',
      hasReference: !!getReference(),
      materials,
    }
    return autoCaseRefFragment(roles)
  }

  async function openEffectPrompt(effect: EffectPromptKey): Promise<void> {
    const r = record
    if (!r) return
    promptAutoText =
      effect === 'caseRef'
        ? await previewCaseFragment()
        : effect === 'drillParams'
          ? await previewDrillFragment()
          : await previewBlueprintFragment()
    promptDialogEffect = effect
    promptDialogOpen = true
  }

  /** 保存片段覆盖（undefined = 清除覆盖回 auto）——整键提交保其余字段。 */
  function handleEffectPromptSave(effect: EffectPromptKey, fragment: string | undefined): void {
    if (effect === 'caseRef') {
      // 从未配置 + 关灯 + 无覆盖 = 不落空键
      if (record?.caseRef === undefined && !caseOn && fragment === undefined && !record?.caseBinding) return
      submitTemplateField(templateAssetId, {
        caseRef: { enabled: caseOn, ...(fragment !== undefined ? { promptFragment: fragment } : {}) },
      })
    } else if (effect === 'drillParams') {
      submitDrill({ promptFragment: fragment ?? null })
    } else {
      submitBlueprint({ promptFragment: fragment ?? null })
    }
  }
</script>

{#if record}
  <div class="grid gap-2" data-testid="advanced-options">
    <!-- 案例参照图（placeholders：原必选绑定 → 功能开关；选图面收纳 EffectRefControl） -->
    <div class="grid gap-1.5" data-testid="case-section">
      <div class="flex min-h-6 items-center gap-2 text-xs font-medium">
        <Switch checked={caseOn} onCheckedChange={toggleCase} data-testid="case-switch" aria-label="案例参照图" />
        案例参照图
        {#if caseOn && record.caseBinding}
          <span class="text-muted-foreground font-mono text-[10px]">已绑定</span>
        {/if}
        <span class="ml-auto"></span>
        <!-- [lab-ux 1] TextQuote（文本+引号）＝提示词片段语义；outline 边框+悬停+tooltip＝可辨识按钮 -->
        <Button
          variant="outline"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground"
          title="编辑提示词片段（案例参照图）"
          aria-label="编辑案例参照图提示词片段"
          onclick={() => void openEffectPrompt('caseRef')}
          data-testid="effect-prompt-edit-caseRef"
        >
          <TextQuote />
        </Button>
      </div>
      <p class="text-muted-foreground text-[11px] leading-snug" data-testid="case-hint">
        开关开 = 案例参照图随请求附送，{EFFECT_PROMPT_PLACEHOLDERS.caseRef} 自动插入主提示词；关 = 不附送
        （绑定保留）并自动移除占位符。效果正文替换该占位符（可在主提示词中自由移动）。
      </p>
      {#if caseOn}
        <div class="grid gap-1.5 pl-6" data-testid="case-form">
          <EffectRefControl templateAssetId={templateAssetId} caseBinding={record.caseBinding} />
        </div>
      {/if}
    </div>

    <!-- 水钻参数配置（drillParams 正交开关） -->
    <div class="grid gap-1.5 border-t pt-2" data-testid="drill-section">
      <label class="flex min-h-6 items-center gap-2 text-xs font-medium">
        <Switch checked={drillOn} onCheckedChange={toggleDrill} data-testid="drill-switch" aria-label="水钻参数配置" />
        水钻参数配置
        {#if drillOn}
          <span class="text-muted-foreground font-mono text-[10px] tabular-nums" data-testid="drill-specs-count">
            {drill?.specs.length ?? 0} 规格
          </span>
        {/if}
        <span class="ml-auto"></span>
        <!-- [lab-ux 1] TextQuote（文本+引号）＝提示词片段语义；outline 边框+悬停+tooltip＝可辨识按钮 -->
        <Button
          variant="outline"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground"
          title="编辑提示词片段（水钻参数配置）"
          aria-label="编辑水钻参数配置提示词片段"
          onclick={() => void openEffectPrompt('drillParams')}
          data-testid="effect-prompt-edit-drillParams"
        >
          <TextQuote />
        </Button>
      </label>

      {#if drillOn}
        <div class="grid gap-1.5 pl-6" data-testid="drill-form">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-muted-foreground text-[11px]">可用钻清单</span>
            <select
              class="border-input bg-background h-7 rounded-md border px-1.5 text-[11px]"
              aria-label="从钻形目录选择规格"
              data-testid="drill-spec-add"
              onchange={addSpec}
            >
              <option value="">＋ 从钻形目录选择…</option>
              {#each catalogSpecs as spec (spec.specKey)}
                {#if !(drill?.specs ?? []).includes(spec.specKey)}
                  <option value={spec.specKey}>{spec.sizeLabel} {shapeLabel(spec)}（{spec.diameterMm}mm）</option>
                {/if}
              {/each}
            </select>
          </div>

          {#if (drill?.specs.length ?? 0) === 0}
            <p class="text-muted-foreground text-[11px]" data-testid="drill-empty-hint">
              先从目录选择至少 1 个规格，开关才会点亮（清单将拼进生成提示词）。
            </p>
          {:else}
            <ul class="grid gap-0.5" data-testid="drill-spec-list">
              {#each drill?.specs ?? [] as specKey, index (specKey)}
                <li class="flex min-w-0 items-center gap-1.5 text-[11px]" data-testid="drill-spec-row" data-spec-key={specKey}>
                  <span class="text-muted-foreground w-4 shrink-0 text-right font-mono tabular-nums">{index + 1}</span>
                  <span class="font-mono">{specKey}</span>
                  {#if specViews[specKey]}
                    <span class="text-muted-foreground">{shapeLabel(specViews[specKey])} {specViews[specKey]?.sizeLabel} · {specViews[specKey]?.diameterMm}mm</span>
                  {:else}
                    <span class="text-destructive" data-testid="drill-spec-missing" title="规格不在钻形目录中（素材已删除或损坏）——发起生成时将阻断该模板">⚠ 规格缺失</span>
                  {/if}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-muted-foreground hover:text-destructive ml-auto"
                    aria-label="移除规格 {specKey}"
                    onclick={() => removeSpec(specKey)}
                    data-testid="drill-spec-remove"
                  >
                    <X />
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}

          {#each drillWarnings as warning (warning)}
            <p class="text-muted-foreground text-[11px]" data-testid="drill-warning">{warning}</p>
          {/each}

          <!-- [lab-ux 5] 画幅必选：勾选退役，恒显宽高输入 + 必填标记（未声明 → 必填提示） -->
          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span class="text-muted-foreground flex items-center gap-0.5" data-testid="drill-physical-label">
              画幅物理尺寸
              <span class="text-destructive font-medium" title="必填">＊</span>
              <span class="text-muted-foreground/70">（必填）</span>
            </span>
            <Input
              class="h-7 w-16 font-mono tabular-nums"
              type="number"
              min="1"
              step="0.1"
              placeholder="210"
              value={widthText}
              onchange={handleWidthChange}
              aria-label="画幅宽（mm，必填）"
              data-testid="drill-physical-w"
            />
            <span class="text-muted-foreground">×</span>
            <Input
              class="h-7 w-16 font-mono tabular-nums"
              type="number"
              min="1"
              step="0.1"
              placeholder="148"
              value={heightText}
              onchange={handleHeightChange}
              aria-label="画幅高（mm，必填）"
              data-testid="drill-physical-h"
            />
            <span class="text-muted-foreground">mm</span>
          </div>
          {#if drillOn && !physicalDeclared}
            <p class="text-destructive text-[11px]" data-testid="drill-physical-required">
              水钻参数配置需要画幅物理尺寸——请填写宽高（发起生成时将拦截未填写的模板）。
            </p>
          {/if}
          {#if physicalError}
            <p class="text-destructive text-[11px]" data-testid="drill-physical-error">宽高须为正数（mm）。</p>
          {/if}
        </div>
      {/if}
    </div>

    <!-- 蓝图效果（beta 正交开关；策略不入模板——发起面板按次选择，design §4.3） -->
    <div class="grid gap-1.5 border-t pt-2" data-testid="blueprint-section">
      <div class="flex min-h-6 items-center gap-2 text-xs font-medium">
        <Switch checked={blueprintOn} onCheckedChange={toggleBlueprint} data-testid="blueprint-switch" aria-label="蓝图效果" />
        蓝图效果
        <Badge variant="outline" class="text-[10px]" data-testid="blueprint-beta">Beta</Badge>
        <HelpTip label="蓝图 beta 说明" text="蓝图效果可能不稳定，未来可能被其它工作流替代。" />
        <span class="ml-auto"></span>
        <!-- [lab-ux 1] TextQuote（文本+引号）＝提示词片段语义；outline 边框+悬停+tooltip＝可辨识按钮 -->
        <Button
          variant="outline"
          size="icon-sm"
          class="text-muted-foreground hover:text-foreground"
          title="编辑提示词片段（蓝图效果）"
          aria-label="编辑蓝图效果提示词片段"
          onclick={() => void openEffectPrompt('blueprint')}
          data-testid="effect-prompt-edit-blueprint"
        >
          <TextQuote />
        </Button>
      </div>

      {#if blueprintOn}
        <div class="grid gap-1.5 pl-6" data-testid="blueprint-form">
          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span class="text-muted-foreground">蓝图参考图</span>
            <span class="font-mono tabular-nums" data-testid="blueprint-refs-count">
              {(blueprint?.refs ?? []).length} / {BLUEPRINT_REFS_MAX}
            </span>
            <Button
              variant="outline"
              size="xs"
              onclick={() => void addBlueprintRef()}
              disabled={(blueprint?.refs ?? []).length >= BLUEPRINT_REFS_MAX}
              title="从素材库选择蓝图参考图（上传的新图自动入库并选中）"
              data-testid="blueprint-ref-add"
            >
              <Plus />
              从素材库选
            </Button>
          </div>
          {#if (blueprint?.refs ?? []).length > 0}
            <!-- [lab-ux 4] 缩略平铺（Owner：id 尾巴不可读——要图片预览）；点击开大图预览 -->
            <ul class="flex flex-wrap gap-1.5" data-testid="blueprint-ref-list">
              {#each blueprint?.refs ?? [] as assetId (assetId)}
                {@const thumb = refThumbState(assetId)}
                <li class="relative shrink-0" data-testid="blueprint-ref-row" data-asset-id={assetId}>
                  <button
                    type="button"
                    class="ring-ring/40 hover:ring-primary/40 bg-muted/30 relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-md ring-1 transition-shadow"
                    title="预览蓝图参考图（资产 {assetId}）"
                    aria-label="预览蓝图参考图 {assetId}"
                    onclick={() => {
                      previewRefId = assetId
                      previewRefOpen = true
                    }}
                    data-testid="blueprint-ref-thumb"
                  >
                    {#if thumb.kind === 'url'}
                      <img src={thumb.url} alt="蓝图参考图 {assetId}" class="size-full object-cover" draggable="false" />
                    {:else if thumb.kind === 'missing'}
                      <span class="text-muted-foreground grid size-full place-items-center" data-testid="blueprint-ref-thumb-missing" title="素材缺失或已删除">
                        <ImageOff class="size-4" />
                      </span>
                    {:else}
                      <span class="text-muted-foreground grid size-full place-items-center">
                        <ImageIcon class="text-muted-foreground/50 size-4 animate-pulse" />
                      </span>
                    {/if}
                  </button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-muted-foreground hover:text-destructive absolute -top-1.5 -right-1.5 size-5 rounded-full border bg-background p-0"
                    aria-label="移除蓝图参考图 {assetId}"
                    onclick={() => removeBlueprintRef(assetId)}
                    data-testid="blueprint-ref-remove"
                  >
                    <X class="size-3" />
                  </Button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-muted-foreground text-[11px] leading-snug" data-testid="blueprint-ref-empty">
              还没有蓝图参考图——点击「从素材库选」添加（至多 {BLUEPRINT_REFS_MAX} 张，随蓝图请求附送并声明为蓝图参考）。
            </p>
          {/if}
          <p class="text-muted-foreground text-[11px] leading-snug">
            开启后追加蓝图生成要求与原图；生成策略（串行/并行）在发起面板按次选择，默认串行。
          </p>
        </div>
      {/if}
    </div>
  </div>

  <!-- [lab-ux 4] 蓝图参考图大图预览（点击缩略开；资产 id 只进标题/角注不做正文） -->
  {#if previewRefId !== null}
    <Dialog.Root bind:open={previewRefOpen}>
      <Dialog.Content class="max-w-lg">
        <Dialog.Header>
          <Dialog.Title class="text-sm">蓝图参考图预览</Dialog.Title>
          <Dialog.Description>
            随蓝图请求附送（附图序声明见提示词）。资产 id 仅作索引：<span class="font-mono text-[11px]" data-testid="blueprint-ref-preview-id">{previewRefId}</span>
          </Dialog.Description>
        </Dialog.Header>
        {#if previewRefState?.kind === 'url'}
          <img
            src={previewRefState.url}
            alt="蓝图参考图 {previewRefId}"
            class="max-h-[60vh] w-full rounded-lg border object-contain"
            draggable="false"
            data-testid="blueprint-ref-preview-img"
          />
        {:else if previewRefState?.kind === 'missing'}
          <div class="text-muted-foreground flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs" data-testid="blueprint-ref-preview-missing">
            <ImageOff class="mr-1.5 size-4" />
            素材缺失或已删除（可移除后重新选择）
          </div>
        {:else}
          <div class="text-muted-foreground flex aspect-square items-center justify-center rounded-lg border border-dashed text-xs" data-testid="blueprint-ref-preview-loading">
            解析中…
          </div>
        {/if}
      </Dialog.Content>
    </Dialog.Root>
  {/if}

  <!-- 效果提示词共享 Dialog（三开关共用单实例；effect = 打开中的效果键；[lab-ux 2] 动作收敛保存/取消） -->
  {#if promptDialogEffect !== null}
    <EffectPromptDialog
      bind:open={promptDialogOpen}
      effectTitle={effectTitleOf[promptDialogEffect]}
      autoText={promptAutoText}
      currentFragment={currentFragmentOf}
      placeholderLiteral={EFFECT_PROMPT_PLACEHOLDERS[promptDialogEffect]}
      {placeholderAlreadyPresent}
      onSave={(fragment) => handleEffectPromptSave(promptDialogEffect as EffectPromptKey, fragment)}
    />
  {/if}
{:else}
  <p class="text-muted-foreground text-xs" data-testid="advanced-options-missing">模板不存在或已从模板库移除。</p>
{/if}
