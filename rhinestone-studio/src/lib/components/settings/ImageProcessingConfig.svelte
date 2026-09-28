<!--
ImageProcessingConfig.svelte — 设置 Sheet「图像处理」分区（add-image-processing-settings
2.3，2026-09-28；Owner 原始指令：设置页提供 px/cm+SAM 高级参数，三档预设+自定义放开细节参数）。
结构（design §6.2）：
- 头部来源行（ModelsConfig 头部 source 透明度行同构）：三态「当前生效：设置（档名）｜
  环境变量（PPCM_TARGET 附值）｜默认（性能档）」。
- 四卡预设组（自研按钮组 role=radiogroup，比照 ModelsConfig tab 条形态）：档名+一句定位+
  关键值预览；本地选中高亮，远端已保存档标「当前」。
- custom 展开区（选中自定义时渲染）：ppcm slider+数值输入+换算提示 / resample switch /
  conf slider / maskMaxSide switch+数值输入。zod 边界（contracts schema）在 UI 面前置：
  非法值禁保存+字段级中文提示。
- 保存条：脏态才可用（比照 ModelsConfig 保存模式）；「恢复跟随环境/默认」次级按钮=
  saveImageProcessing({reset:true})（删 settings 键，确认对话框守门）。
编辑态语义：进入时以远端读面初始化（settings=null 时 effective 恰好匹配某预设映射
才预选该档——不匹配任何映射（如非预设 env 组合）则不预选，radiogroup 全灭+提示
「点击某一档以固定设置」，env 值不冒充已保存档、点任何档即脏可显式保存；custom 参数
以 effective 初始化），不自动保存；保存/reset 成功后以服务端返回读面重建基线。
换算口径：px/cm ⇒ 1 px = 10/ppcm mm（design §1 A/B 裁定 25 px/cm=1px 0.4mm 同源）。
P2-1（codex 复核 2026-09-28）：本地 preset 态 ImageProcessingPreset|null——
baseline preset=null 时点击任何档=脏（修复非预设 env 下「点性能档不产生脏态」）。
-->
<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Slider } from '$lib/components/ui/slider'
  import { Switch } from '$lib/components/ui/switch'
  import ConfirmDialog from '$lib/components/ui/confirm-dialog.svelte'
  import { imageProcessingApi } from '$lib/imageProcessingApi'
  import {
    IMAGE_PPCM_MAX,
    IMAGE_PPCM_MIN,
    ImageProcessingValuesSchema,
    SAM_CONF_MAX,
    SAM_CONF_MIN,
    SAM_MASK_MAX_SIDE_MIN,
    type ImageProcessingGetOutput,
    type ImageProcessingPreset,
    type ImageProcessingValues,
  } from '@handicraft/contracts'

  /**
   * 预设冻结映射的展示侧抄录（保存单源在 daemon：非 custom 档保存只上送 preset，
   * 服务端按映射生成快照——本表仅用于卡片关键值文案与 settings=null 时
   * effective→档位的初始化匹配，展示漂移无写入风险）。
   */
  const PRESET_VALUES: Record<Exclude<ImageProcessingPreset, 'custom'>, ImageProcessingValues> = {
    fast: { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.5, samMaskMaxSide: 1024 },
    balanced: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
    quality: { ppcmTarget: 40, resampleEnabled: true, samConfThreshold: 0.3, samMaskMaxSide: null },
  }

  const PRESET_LABEL: Record<ImageProcessingPreset, string> = {
    fast: '快速档',
    balanced: '性能档',
    quality: '高质量档',
    custom: '自定义',
  }

  const PRESET_CARDS: {
    id: ImageProcessingPreset
    name: string
    tag: string
    preview: string | null
  }[] = [
    { id: 'fast', name: '快速', tag: '更快的识别与传输', preview: '15 px/cm · 置信度 0.50' },
    { id: 'balanced', name: '性能', tag: '推荐平衡（默认）', preview: '25 px/cm · 置信度 0.40' },
    { id: 'quality', name: '高质量', tag: '更高边界精度与检出', preview: '40 px/cm · 置信度 0.30' },
    { id: 'custom', name: '自定义', tag: '自行调整全部参数', preview: null },
  ]

  // ---- 远端读面与本地编辑态 ----
  let remote = $state<ImageProcessingGetOutput | null>(null)
  let error = $state<string | null>(null)
  /** 本地选中档（null=未选——未保存且 effective 不匹配任何预设映射时；P2-1）。 */
  let preset = $state<ImageProcessingPreset | null>(null)
  let values = $state<ImageProcessingValues>({ ...PRESET_VALUES.balanced })
  /** 初始化快照（脏态对比基线；preset=null=未保存且无匹配档——点击任何档即脏）。 */
  let baseline = $state<{ preset: ImageProcessingPreset | null; values: ImageProcessingValues } | null>(null)

  let saving = $state(false)
  let resetting = $state(false)
  let savedFlash = $state(false)
  let resetOpen = $state(false)

  /** 数值输入的进行中文本（null=跟随 values 数值；输入中不打断，slider/重置时清回）。 */
  let ppcmText = $state<string | null>(null)
  let maskText = $state<string | null>(null)

  $effect(() => {
    void load()
  })

  // 卸载清 flash 定时器（$effect 无依赖只跑一次，cleanup 在销毁时执行）。
  let flashTimer: ReturnType<typeof setTimeout> | null = null
  $effect(() => {
    return () => {
      if (flashTimer !== null) clearTimeout(flashTimer)
    }
  })

  async function load(): Promise<void> {
    error = null
    try {
      initFrom(await imageProcessingApi().getImageProcessing())
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
  }

  function initFrom(out: ImageProcessingGetOutput): void {
    remote = out
    if (out.settings !== null) {
      preset = out.settings.preset
      values = { ...out.settings.values }
    } else {
      // P2-1：未保存且 effective 不匹配任何预设映射 → 不预选（env 值不冒充已保存档
      // ——radiogroup 全灭+提示行；点击任何档=脏可显式保存）；恰好匹配才预选该档。
      preset = matchPresetOf(out.effective)
      values = { ...out.effective }
    }
    baseline = { preset, values: { ...values } }
    ppcmText = null
    maskText = null
  }

  function matchPresetOf(v: ImageProcessingValues): Exclude<ImageProcessingPreset, 'custom'> | null {
    for (const id of ['fast', 'balanced', 'quality'] as const) {
      if (valuesEqual(PRESET_VALUES[id], v)) return id
    }
    return null
  }

  /** 字段级等值（conf 为浮点——步进累积误差容差）。 */
  function valuesEqual(a: ImageProcessingValues, b: ImageProcessingValues): boolean {
    return (
      a.ppcmTarget === b.ppcmTarget &&
      a.resampleEnabled === b.resampleEnabled &&
      Math.abs(a.samConfThreshold - b.samConfThreshold) < 1e-9 &&
      a.samMaskMaxSide === b.samMaskMaxSide
    )
  }

  // ---- 派生态：来源行 / 脏态 / 校验 ----

  const sourceText = $derived.by(() => {
    if (remote === null) return '当前生效：未知（读取失败）'
    if (remote.source === 'settings' && remote.settings !== null) {
      return `当前生效：设置（${PRESET_LABEL[remote.settings.preset]}）`
    }
    if (remote.source === 'env') {
      const ppcm = remote.env?.ppcmTarget
      return ppcm !== undefined ? `当前生效：环境变量（PPCM_TARGET=${ppcm} px/cm）` : '当前生效：环境变量'
    }
    return '当前生效：默认（性能档）'
  })

  /** 脏态（P2-1：baseline.preset=null（未保存无匹配）时点击任何档≠null=脏）。 */
  const dirty = $derived(
    baseline !== null &&
      (baseline.preset !== preset || (preset === 'custom' && !valuesEqual(baseline.values, values))),
  )

  /** zod 边界前置（契约 schema 同源）：custom 档 values 整体校验。 */
  const customValid = $derived(preset !== 'custom' || ImageProcessingValuesSchema.safeParse(values).success)

  const ppcmInvalid =
    $derived(preset === 'custom' && (!Number.isInteger(values.ppcmTarget) || values.ppcmTarget < IMAGE_PPCM_MIN || values.ppcmTarget > IMAGE_PPCM_MAX))
  const maskInvalid =
    $derived(preset === 'custom' && values.samMaskMaxSide !== null && (!Number.isInteger(values.samMaskMaxSide) || values.samMaskMaxSide < SAM_MASK_MAX_SIDE_MIN))

  /** 换算提示：px/cm ⇒ 1 px = 10/ppcm mm（25 px/cm ⇔ 0.4mm，A/B 裁定口径）。 */
  const ppcmConversion = $derived.by(() => {
    if (!ppcmInvalid) return `换算：1 px ≈ ${(10 / values.ppcmTarget).toFixed(1)} mm`
    return ''
  })

  const saveDisabled = $derived(baseline === null || !dirty || !customValid || saving)
  const resetDisabled = $derived(remote === null || remote.settings === null || resetting)

  // ---- 交互 ----

  function selectPreset(next: ImageProcessingPreset): void {
    preset = next
  }

  function onPpcmSliderChange(v: number): void {
    values.ppcmTarget = v
    ppcmText = null // 显示切回跟随数值（不打断输入的文本态清回）
  }

  function onPpcmInput(event: Event): void {
    const raw = (event.currentTarget as HTMLInputElement).value
    ppcmText = raw
    const n = Number(raw)
    if (Number.isFinite(n)) values.ppcmTarget = n // 越界值照收——由 zod 前置校验拦保存
  }

  function onMaskToggle(checked: boolean): void {
    values.samMaskMaxSide = checked ? (values.samMaskMaxSide ?? 1024) : null
    maskText = null
  }

  function onMaskInput(event: Event): void {
    const raw = (event.currentTarget as HTMLInputElement).value
    maskText = raw
    const n = Number(raw)
    if (Number.isFinite(n)) values.samMaskMaxSide = n
  }

  function flashSaved(): void {
    if (flashTimer !== null) clearTimeout(flashTimer)
    savedFlash = true
    flashTimer = setTimeout(() => {
      savedFlash = false
    }, 2500)
  }

  async function save(): Promise<void> {
    if (saveDisabled || preset === null) return
    saving = true
    error = null
    try {
      // 非 custom 档不上送 values（服务端按冻结映射生成快照——映射单源在 daemon）。
      const out = await imageProcessingApi().saveImageProcessing(
        preset === 'custom' ? { preset, values: { ...values } } : { preset },
      )
      initFrom(out)
      flashSaved()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      saving = false
    }
  }

  async function confirmReset(): Promise<void> {
    resetting = true
    error = null
    try {
      const out = await imageProcessingApi().saveImageProcessing({ reset: true })
      initFrom(out)
      resetOpen = false
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      resetting = false
    }
  }

  const ppcmDisplay = $derived(ppcmText ?? String(values.ppcmTarget))
  /**
   * slider 视图值=clamp 后的合法值（输入框可暂存越界值——bits-ui 受控 slider 收到
   * 越界 value 会回发修正的 onValueChange，把输入的非法值（如 9）悄悄改写回边界，
   * 导致「非法值→禁保存+提示」前置校验态丢失；slider 只反映合法区间，越界态由
   * 输入框与校验提示承载）。
   */
  const ppcmSliderValue = $derived(
    Math.min(IMAGE_PPCM_MAX, Math.max(IMAGE_PPCM_MIN, values.ppcmTarget)),
  )
  const maskDisplay = $derived(maskText ?? String(values.samMaskMaxSide ?? 1024))
</script>

<div class="flex h-full min-h-0 flex-col gap-3">
  <div class="shrink-0">
    <h3 class="text-sm font-medium">图像处理</h3>
    <p class="mt-0.5 text-[11px] text-muted-foreground">
      管线入线降采与 SAM 检出参数；保存后对下一次请求立即生效（无需重启后端）。
    </p>
    <p class="mt-1 text-[11px] text-muted-foreground" data-testid="image-processing-source-line">
      {sourceText}
    </p>
    {#if remote !== null && preset === null}
      <p class="mt-0.5 text-[11px] text-muted-foreground" data-testid="image-processing-preset-hint">
        当前生效值未匹配任何预设——点击某一档以固定设置
      </p>
    {/if}
  </div>

  {#if error !== null && remote === null}
    <div class="flex flex-col items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-4">
      <p class="text-xs font-medium text-destructive" role="alert" data-testid="image-processing-error">
        图像处理设置加载失败：{error}
      </p>
      <p class="text-[11px] text-muted-foreground">
        daemon 未启动或连接失败时无法读写设置——确认后端已运行再重试。
      </p>
      <Button size="sm" variant="outline" onclick={() => void load()}>重试</Button>
    </div>
  {:else if remote === null}
    <div class="text-xs text-muted-foreground">加载中…</div>
  {:else}
    <!-- 滚动只发生在此容器（满高链：头部/保存条常驻）。 -->
    <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
      <!-- 四卡预设组（自研按钮组：单选语义，比照 ModelsConfig tab 条形态）。 -->
      <div
        role="radiogroup"
        aria-label="图像处理预设"
        data-testid="image-processing-preset-group"
        class="grid grid-cols-2 gap-2"
      >
        {#each PRESET_CARDS as card (card.id)}
          {@const isBaseline = baseline?.preset === card.id}
          <button
            type="button"
            role="radio"
            aria-checked={preset === card.id}
            data-testid="image-processing-preset-{card.id}"
            data-current={isBaseline ? 'true' : undefined}
            class="rounded-lg border p-2.5 text-left transition-colors {preset === card.id
              ? 'border-primary bg-primary/5'
              : 'border-border hover:bg-muted/50'}"
            onclick={() => selectPreset(card.id)}
          >
            <span class="flex items-center gap-1.5 text-xs font-medium">
              {card.name}
              {#if isBaseline}
                <span
                  class="rounded bg-muted px-1 py-px text-[9px] font-normal leading-tight text-muted-foreground"
                  title="已保存的当前档"
                >当前</span>
              {/if}
            </span>
            <span class="mt-0.5 block text-[11px] leading-snug text-muted-foreground">{card.tag}</span>
            {#if card.preview !== null}
              <span class="mt-1 block font-mono text-[10px] text-muted-foreground">{card.preview}</span>
            {/if}
          </button>
        {/each}
      </div>

      <!-- custom 展开区（选中自定义时渲染；{#if} 即销毁——切档丢弃未保存草稿）。 -->
      {#if preset === 'custom'}
        <div
          class="mt-3 flex flex-col gap-4 rounded-lg border bg-muted/30 p-3"
          data-testid="image-processing-custom-panel"
        >
          <!-- ppcmTarget：slider + 数值输入 + 换算提示 -->
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <label class="text-xs text-muted-foreground" for="image-processing-ppcm-input">入线降采目标密度</label>
              <div class="flex items-center gap-1">
                <Input
                  id="image-processing-ppcm-input"
                  data-testid="image-processing-ppcm-input"
                  type="number"
                  class="h-7 w-16 px-2 py-0 text-right text-xs"
                  value={ppcmDisplay}
                  oninput={onPpcmInput}
                />
                <span class="text-xs text-muted-foreground">px/cm</span>
              </div>
            </div>
            <Slider
              type="single"
              data-testid="image-processing-ppcm-slider"
              min={IMAGE_PPCM_MIN}
              max={IMAGE_PPCM_MAX}
              step={1}
              value={ppcmSliderValue}
              onValueChange={onPpcmSliderChange}
              aria-label="入线降采目标密度"
              class="h-8"
            />
            {#if ppcmInvalid}
              <p class="text-[11px] text-destructive" data-testid="image-processing-ppcm-invalid">
                目标密度需为 {IMAGE_PPCM_MIN}..{IMAGE_PPCM_MAX} 的整数（px/cm）
              </p>
            {:else}
              <p class="text-[11px] text-muted-foreground" data-testid="image-processing-ppcm-hint">
                {ppcmConversion}· 关闭降采样后不生效
              </p>
            {/if}
          </div>

          <!-- resampleEnabled -->
          <div class="flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-xs">入线降采样</p>
              <p class="mt-0.5 text-[11px] text-muted-foreground">关闭后原图不做降采样（透传）</p>
            </div>
            <Switch
              data-testid="image-processing-resample-switch"
              checked={values.resampleEnabled}
              onCheckedChange={(checked) => (values.resampleEnabled = checked)}
              aria-label="入线降采样总开关"
            />
          </div>

          <!-- samConfThreshold -->
          <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline justify-between gap-2 text-xs">
              <span class="text-muted-foreground">SAM 检出置信度阈值</span>
              <span class="font-mono text-xs tabular-nums" data-testid="image-processing-conf-value">
                {values.samConfThreshold.toFixed(2)}
              </span>
            </div>
            <Slider
              type="single"
              data-testid="image-processing-conf-slider"
              min={SAM_CONF_MIN}
              max={SAM_CONF_MAX}
              step={0.05}
              value={values.samConfThreshold}
              onValueChange={(v) => (values.samConfThreshold = v)}
              aria-label="SAM 检出置信度阈值"
              class="h-8"
            />
            <p class="text-[11px] text-muted-foreground">越低越敏感（检出更多，噪声也更多）</p>
          </div>

          <!-- samMaskMaxSide：switch + 开启时数值输入；关 = null（原尺寸） -->
          <div class="flex flex-col gap-1.5">
            <div class="flex items-center justify-between gap-2">
              <div class="min-w-0">
                <p class="text-xs">限制掩码长边</p>
                <p class="mt-0.5 text-[11px] text-muted-foreground">关闭时掩码保持原尺寸</p>
              </div>
              <Switch
                data-testid="image-processing-mask-switch"
                checked={values.samMaskMaxSide !== null}
                onCheckedChange={onMaskToggle}
                aria-label="限制 SAM 掩码长边"
              />
            </div>
            {#if values.samMaskMaxSide !== null}
              <div class="flex items-center gap-1 self-end">
                <Input
                  data-testid="image-processing-mask-input"
                  type="number"
                  class="h-7 w-20 px-2 py-0 text-right text-xs"
                  value={maskDisplay}
                  oninput={onMaskInput}
                />
                <span class="text-[11px] text-muted-foreground">px（≥{SAM_MASK_MAX_SIDE_MIN}）</span>
              </div>
              {#if maskInvalid}
                <p class="self-end text-[11px] text-destructive" data-testid="image-processing-mask-invalid">
                  掩码长边需为 ≥{SAM_MASK_MAX_SIDE_MIN} 的整数
                </p>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if error !== null}
      <p class="shrink-0 text-[11px] text-destructive" role="alert" data-testid="image-processing-error">
        保存失败：{error}
      </p>
    {/if}

    <!-- 保存条（脏态门 + 恢复跟随环境/默认次级动作）。 -->
    <div class="flex shrink-0 items-center justify-between gap-2 border-t pt-3">
      <Button
        size="sm"
        variant="outline"
        data-testid="image-processing-reset-button"
        disabled={resetDisabled}
        title={resetDisabled ? '尚未保存设置（已在跟随环境/默认）' : '删除已保存设置，回落环境变量或内置默认'}
        onclick={() => (resetOpen = true)}
      >
        恢复跟随环境/默认
      </Button>
      <div class="flex items-center gap-2">
        {#if dirty}
          <span class="text-[11px] text-muted-foreground" data-testid="image-processing-dirty">未保存更改</span>
        {/if}
        {#if savedFlash}
          <span class="text-[11px] text-muted-foreground" data-testid="image-processing-save-flash">已保存</span>
        {/if}
        <Button
          size="sm"
          data-testid="image-processing-save-button"
          disabled={saveDisabled}
          onclick={() => void save()}
        >
          {saving ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  {/if}
</div>

<ConfirmDialog
  bind:open={resetOpen}
  title="恢复跟随环境/默认"
  description="删除已保存的图像处理设置？生效值将回落到环境变量（PPCM_TARGET / PPCM_RESAMPLE），无环境变量时使用内置默认（性能档）。"
  confirmText="恢复"
  busy={resetting}
  onconfirm={() => void confirmReset()}
/>
