<!--
TemplateAdvancedOptions.svelte——模板高级选项区（openspec add-lab-drill-params-and-blueprint
C 3.1；design §0.2/§1.1/§6.1：两个正交、独立启用、模板级的高级选项）。

宿主 = TemplateEditor 内嵌（双宿主同步受益：实验室手风琴与素材库 RightSheet 同 record 互见，
add-project-files 4.3b 先例）；编辑态真源 = templates store record（本组件不持副本，
PRODUCT_MODEL 硬规则 7）；提交 = 字段提交自动换绑（onchange/blur → submitTemplateField，
design §1.1「提交模型」）。

- 水钻参数配置：开关 + 钻清单（specKey 引用；编号=数组序）+ 画幅物理尺寸可选声明。
  写入门 enabled⇒specs≥1 的 UI 对齐：空清单拨开开关 = 展开表单等首个规格（不落非法键），
  首个规格入单即点亮 enabled；关灯提交 {enabled:false, specs 原样}（数据保留，UX 底线）。
- 蓝图效果（beta）：开关 + Beta 徽标 + 不稳定声明 tooltip（design §4.4）+ 参考图槽 ≤2 骨架
  （refs 数据面与提交面已通；AssetPickerHost 选图接线归 4.2；refs 落盘归 4.1）。
- 规格选择器 = 桩目录（gemCatalogService 内存 mock，W0 前真源；4.2 换真源接口不变）；
  策略选择不入模板（任务级，发起面板——design §4.3，本区不呈现）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import HelpTip from '../HelpTip.svelte'
  import {
    createInMemoryGemCatalogService,
    type CatalogSpec,
  } from '$lib/services/gemCatalogService'
  import {
    BLUEPRINT_REFS_MAX,
    validateGemtplDrillParams,
  } from '$lib/lab/advancedOptions'
  import { getTemplateRecord, submitTemplateField } from '$lib/stores/templates.svelte'
  import X from '@lucide/svelte/icons/x'
  import Plus from '@lucide/svelte/icons/plus'

  let { templateAssetId }: { templateAssetId: string } = $props()

  const record = $derived(getTemplateRecord(templateAssetId))
  const drill = $derived(record?.drillParams)
  const blueprint = $derived(record?.blueprint)

  // 「空清单拨开」中间态：开关视觉展开表单等首个规格（record 尚未落 enabled=true）
  let drillPendingOpen = $state(false)
  const drillOn = $derived(drill?.enabled === true || drillPendingOpen)
  const blueprintOn = $derived(blueprint?.enabled === true)

  // ---------------------------------------------------------------------------
  // 钻形目录（桩：gemCatalogService 内存 mock——W0 后 4.2 换真源，接口签名不变）
  // ---------------------------------------------------------------------------

  const catalog = createInMemoryGemCatalogService()
  /** 目录选项（选择器数据源；mock = round × SS 十二档）。 */
  let catalogSpecs = $state<CatalogSpec[]>([])
  /** 清单 specKey → 目录条目解析缓存（undefined = 未知规格——4.2 接 missing 警告角标）。 */
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
  // ---------------------------------------------------------------------------

  function submitDrill(patch: { enabled?: boolean; specs?: string[]; physical?: PhysicalPatch }): void {
    const base = drill ?? { enabled: false, specs: [] as string[] }
    // physical 语义：patch 显式携带（含 null=撤销声明）用之；否则沿用 base（提交面局部补丁）
    const physical = 'physical' in patch ? patch.physical : base.physical
    const next = {
      enabled: patch.enabled ?? base.enabled,
      specs: patch.specs ?? [...base.specs],
      ...(physical !== undefined && physical !== null ? { physical } : {}),
    }
    submitTemplateField(templateAssetId, { drillParams: next })
  }

  function toggleDrill(next: boolean): void {
    if (next) {
      // 空清单 + 从未配置：不落 enabled=true（validate 门拒写），先展开表单等首个规格
      if ((drill?.specs.length ?? 0) === 0) {
        drillPendingOpen = true
        return
      }
      submitDrill({ enabled: true })
    } else {
      drillPendingOpen = false
      if (drill !== undefined) submitDrill({ enabled: false }) // 关灯不丢清单（数据保留）
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
    submitDrill({ specs: [...specs, key], enabled: drill?.enabled ?? drillPendingOpen })
    drillPendingOpen = false
  }

  function removeSpec(key: string): void {
    const specs = drill?.specs ?? []
    const next = specs.filter((s) => s !== key)
    // 移除至空：enabled 退 false（enabled⇒specs≥1 写入门；空清单=关灯空态合法）
    submitDrill({ specs: next, enabled: next.length === 0 ? false : (drill?.enabled ?? false) })
  }

  // ---------------------------------------------------------------------------
  // 画幅物理尺寸（可选声明；physical? undefined = 未声明）
  // ---------------------------------------------------------------------------

  type PhysicalPatch = { widthMm: number; heightMm: number; anchorSource: 'declared' } | null

  /** 宽高输入缓冲（record 为真源；外部提交变化时重置对齐）。 */
  let widthText = $state('')
  let heightText = $state('')
  let physicalError = $state(false)
  const physicalDeclared = $derived(drill?.physical !== undefined)

  $effect(() => {
    widthText = drill?.physical !== undefined ? String(drill.physical.widthMm) : '210'
    heightText = drill?.physical !== undefined ? String(drill.physical.heightMm) : '148'
    physicalError = false
  })

  function togglePhysical(declared: boolean): void {
    if (declared) {
      const widthMm = Number(widthText) || 210
      const heightMm = Number(heightText) || 148
      submitDrill({ physical: { widthMm, heightMm, anchorSource: 'declared' } })
    } else {
      submitDrill({ physical: null }) // 撤销声明（physical 键剥除）
    }
  }

  function commitPhysical(): void {
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
  // 蓝图效果提交（beta；refs 数据面已通，AssetPickerHost 选图接线归 4.2）
  // ---------------------------------------------------------------------------

  function toggleBlueprint(next: boolean): void {
    submitTemplateField(templateAssetId, {
      blueprint: {
        enabled: next,
        ...(blueprint?.refs !== undefined ? { refs: [...blueprint.refs] } : {}),
      },
    })
  }

  function removeBlueprintRef(assetId: string): void {
    const refs = blueprint?.refs ?? []
    submitTemplateField(templateAssetId, {
      blueprint: { enabled: blueprint?.enabled ?? false, refs: refs.filter((r) => r !== assetId) },
    })
  }

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
</script>

{#if record}
  <div class="grid gap-2" data-testid="advanced-options">
    <!-- 水钻参数配置（drillParams 正交开关） -->
    <div class="grid gap-1.5" data-testid="drill-section">
      <label class="flex min-h-6 items-center gap-2 text-xs font-medium">
        <Switch checked={drillOn} onCheckedChange={toggleDrill} data-testid="drill-switch" aria-label="水钻参数配置" />
        水钻参数配置
        {#if drillOn}
          <span class="text-muted-foreground font-mono text-[10px] tabular-nums" data-testid="drill-specs-count">
            {drill?.specs.length ?? 0} 规格
          </span>
        {/if}
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
                    <span class="text-destructive" title="规格不在目录中（4.2 接真目录 missing 判定）">⚠ 未知规格</span>
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

          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <label class="flex items-center gap-1">
              <input
                type="checkbox"
                class="accent-primary size-3"
                checked={physicalDeclared}
                onchange={(e) => togglePhysical(e.currentTarget.checked)}
                data-testid="drill-physical-declare"
              />
              <span class="text-muted-foreground">画幅物理尺寸（可选）</span>
            </label>
            {#if physicalDeclared}
              <Input
                class="h-7 w-16 font-mono tabular-nums"
                type="number"
                min="1"
                step="0.1"
                value={widthText}
                onchange={handleWidthChange}
                aria-label="画幅宽（mm）"
                data-testid="drill-physical-w"
              />
              <span class="text-muted-foreground">×</span>
              <Input
                class="h-7 w-16 font-mono tabular-nums"
                type="number"
                min="1"
                step="0.1"
                value={heightText}
                onchange={handleHeightChange}
                aria-label="画幅高（mm）"
                data-testid="drill-physical-h"
              />
              <span class="text-muted-foreground">mm</span>
            {/if}
          </div>
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
              disabled
              title="素材库选图接线归依赖轨 4.2（AssetPickerHost）"
              data-testid="blueprint-ref-add"
            >
              <Plus />
              从素材库选
            </Button>
          </div>
          {#if (blueprint?.refs ?? []).length > 0}
            <ul class="grid gap-0.5" data-testid="blueprint-ref-list">
              {#each blueprint?.refs ?? [] as assetId (assetId)}
                <li class="flex min-w-0 items-center gap-1.5 text-[11px]" data-testid="blueprint-ref-row" data-asset-id={assetId}>
                  <span class="text-muted-foreground truncate font-mono" title={assetId}>…{assetId.slice(-8)}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    class="text-muted-foreground hover:text-destructive ml-auto"
                    aria-label="移除蓝图参考图"
                    onclick={() => removeBlueprintRef(assetId)}
                    data-testid="blueprint-ref-remove"
                  >
                    <X />
                  </Button>
                </li>
              {/each}
            </ul>
          {/if}
          <p class="text-muted-foreground text-[11px] leading-snug">
            开启后追加蓝图生成要求与参考图；生成策略（串行/并行）在发起面板按次选择，默认串行。
          </p>
        </div>
      {/if}
    </div>
  </div>
{:else}
  <p class="text-muted-foreground text-xs" data-testid="advanced-options-missing">模板不存在或已从模板库移除。</p>
{/if}
