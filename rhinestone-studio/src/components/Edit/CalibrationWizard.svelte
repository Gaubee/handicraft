<!--
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 D-5.4 rename-and-expert-workbench] 自定义钻形校准向导（三步）：
 *    ① 选贴图（texture 注入 + 超限预检 + 解码 alpha bounds——全透明拒收）
 *    ② 物理尺寸二选一：direct 输 mm（纵横比容差校验——比例漂移 typed error）/
 *       reference 选参考规格反推（bakeCalibrationPhysical——叠参考钻信息预览）
 *    ③ 命名入库（另存为副本——内容不可变纪律）。
 * 2. [2026-09-20 D-5.4] typed 错误 UI 呈现：GemshapeFieldError.message 直显
 *    （超限/比例漂移/悬空 ref/全透明）；入库经 serializeGemshape 终检（typed 上浮同显）。
 * 3. [2026-09-20 Boundary] 落库/素材库接线归 2.x vertical slice：savePort 注入位缺席时
 *    仅发另存意图信号（onCommitIntent 携带合法 GemshapeFile）+ 结果态提示「待落库接线」；
 *    参考规格列表缺省自 gemCatalogService 生产单例（[add-lab 4.2] sys-shapes 真源）。
-->

<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { gemCatalog, type CatalogSpec } from '$lib/services/gemCatalogService'
  import {
    alphaBounds,
    canvasTextureDecoder,
    type GemshapeFile,
    type GemshapeTexture,
    type GemshapeTextureDecoder,
  } from '$lib/persistence/gemshapeFile'
  import {
    buildCalibrationDraft,
    buildCalibrationGemshape,
    checkTextureLimits,
    texturePayloadBytes,
    type CalibrationSavePort,
    type PhysicalSizeMode,
  } from './calibration'

  let {
    texture,
    referenceSpecs = [],
    decode = canvasTextureDecoder,
    savePort = null,
    onCommitIntent = null,
    onClose = null,
  }: {
    /** 待校准贴图（入口方提供——素材库选取/上传接线归 2.x）。 */
    texture: GemshapeTexture
    /** 参考规格列表（缺省挂载时经 gemCatalogService 生产单例拉取）。 */
    referenceSpecs?: CatalogSpec[]
    /** 贴图解码器（测试注入确定性替身；缺省 canvas 解码）。 */
    decode?: GemshapeTextureDecoder
    /** 落库端口（2.x 注入真实 ingest；缺席 = 仅意图信号）。 */
    savePort?: CalibrationSavePort | null
    /** 另存意图信号（携带合法 GemshapeFile——落库字节一致的结构）。 */
    onCommitIntent?: ((file: GemshapeFile) => void) | null
    onClose?: (() => void) | null
  } = $props()

  let step = $state<1 | 2 | 3>(1)
  let bounds = $state<{ w: number; h: number } | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)
  let specs = $state<CatalogSpec[]>([])
  let mode = $state<PhysicalSizeMode>('direct')
  let directWidth = $state('')
  let directHeight = $state('')
  let refSpecKey = $state('')
  let name = $state('')
  let committed = $state<{ assetId: string | null; specKey: string | null } | null>(null)

  $effect(() => {
    // 参考规格来源：显式注入优先（快照防外部改动）；缺省经 gemCatalogService 生产单例拉取
    // （[add-lab 4.2] 真源 = sys-shapes .gemshape 资产 hydrate——接口签名不变）
    if (referenceSpecs.length > 0) {
      specs = [...referenceSpecs]
      return
    }
    void gemCatalog
      .listSpecs()
      .then((list) => {
        specs = list
      })
  })

  const textureError = $derived(checkTextureLimits(texture))

  /** 步骤②实时草稿（direct/reference 共用——typed error 直显）。 */
  const draft = $derived.by(() => {
    if (bounds === null) return null
    return buildCalibrationDraft({
      texture,
      bounds,
      mode,
      ...(mode === 'direct'
        ? { direct: { widthMm: Number(directWidth), heightMm: Number(directHeight) } }
        : {
            reference:
              refSpecKey === ''
                ? undefined
                : specs.find((s) => s.specKey === refSpecKey),
          }),
    })
  })

  async function toStep2(): Promise<void> {
    if (textureError !== null) return
    busy = true
    error = null
    try {
      const image = await decode(texture.dataUrl)
      const b = alphaBounds(image)
      if (b === null) {
        error = '贴图全透明（alpha 内容为空）——无法校准，请换带内容的钻石素材图。'
        return
      }
      bounds = { w: b.w, h: b.h }
      step = 2
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    } finally {
      busy = false
    }
  }

  function toStep3(): void {
    if (draft?.ok !== true) return
    step = 3
  }

  async function commit(): Promise<void> {
    if (draft?.ok !== true || name.trim() === '' || busy) return
    busy = true
    error = null
    try {
      const file = buildCalibrationGemshape({
        texture,
        bounds: bounds!,
        mode,
        ...(mode === 'direct'
          ? { direct: { widthMm: Number(directWidth), heightMm: Number(directHeight) } }
          : { reference: specs.find((s) => s.specKey === refSpecKey) }),
        name,
      })
      onCommitIntent?.(file) // 另存意图信号（无论端口在否都发——审计/测试面）
      if (savePort !== null) {
        const saved = await savePort(file)
        committed = { assetId: saved.assetId, specKey: saved.specKey }
      } else {
        committed = { assetId: null, specKey: null } // 落库接线归 2.x——意图已发
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e) // typed GemshapeFieldError 直显
    } finally {
      busy = false
    }
  }

  function mmLabel(v: number): string {
    return String(Math.round(v * 100) / 100)
  }
</script>

<section
  class="mx-auto flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-4"
  data-testid="calibration-wizard"
  aria-label="自定义钻形校准向导"
>
  <header class="flex items-center justify-between">
    <h3 class="text-sm font-semibold tracking-tight">自定义钻形校准</h3>
    <span class="text-muted-foreground font-mono text-[11px]" data-testid="cal-step">步骤 {step}/3</span>
  </header>

  {#if error !== null}
    <p class="destructive rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs" data-testid="cal-error">
      {error}
    </p>
  {/if}

  {#if committed !== null}
    <!-- 入库结果态（另存为副本——内容不可变；落库端口缺席 = 意图信号已发待 2.x 接线） -->
    <div class="grid gap-1.5 text-xs" data-testid="cal-result">
      <p>已产出新自定义钻形「{name}」（另存为副本——原素材不变）。</p>
      {#if committed.specKey !== null}
        <p class="font-mono">specKey：{committed.specKey}</p>
      {:else}
        <p class="text-muted-foreground">另存意图已发出——素材库落库接线归后续（结构已通过 .gemshape 全量校验）。</p>
      {/if}
      {#if onClose !== null}
        <Button size="sm" onclick={() => onClose!()} data-testid="cal-close">完成</Button>
      {/if}
    </div>
  {:else if step === 1}
    <!-- ① 选贴图：贴图信息 + 超限预检 -->
    <div class="grid gap-1 text-xs" data-testid="cal-texture-info">
      <p>贴图：{texture.mime} · {texture.width}×{texture.height}px · 约 {texturePayloadBytes(texture.dataUrl)} 字节</p>
      <p class="text-muted-foreground">贴图来自入口方（素材库选取/上传接线归后续）；alpha 内容 bounds 是校准换算依据。</p>
      {#if textureError !== null}
        <p class="destructive">{textureError.message}</p>
      {/if}
    </div>
    <Button size="sm" disabled={textureError !== null || busy} onclick={() => void toStep2()} data-testid="cal-next">
      {busy ? '解码中…' : '下一步：物理尺寸'}
    </Button>
  {:else if step === 2}
    <!-- ② 物理尺寸：direct / reference 二选一 -->
    <div class="grid gap-2" data-testid="cal-physical">
      <div class="flex gap-3" role="radiogroup" aria-label="校准模式">
        <label class="flex items-center gap-1 text-xs">
          <input type="radio" name="cal-mode" value="direct" checked={mode === 'direct'} onchange={() => (mode = 'direct')} data-testid="cal-mode-direct" />
          直接输入 mm
        </label>
        <label class="flex items-center gap-1 text-xs">
          <input type="radio" name="cal-mode" value="reference" checked={mode === 'reference'} onchange={() => (mode = 'reference')} data-testid="cal-mode-reference" />
          参考规格反推
        </label>
      </div>

      {#if mode === 'direct'}
        <div class="grid grid-cols-2 gap-2">
          <label class="grid gap-1 text-xs" for="cal-direct-width">宽（mm）<Input id="cal-direct-width" bind:value={directWidth} data-testid="cal-direct-width" /></label>
          <label class="grid gap-1 text-xs" for="cal-direct-height">高（mm）<Input id="cal-direct-height" bind:value={directHeight} data-testid="cal-direct-height" /></label>
        </div>
        <p class="text-muted-foreground text-[11px]">贴图 alpha bounds {bounds?.w}×{bounds?.h}px——声明宽高须与其纵横比一致（容差 2%）。</p>
      {:else}
        <label class="grid gap-1 text-xs" for="cal-ref-spec">
          参考规格（拿现有的钻做量纲）
          <select
            id="cal-ref-spec"
            class="border-input bg-background h-8 w-full rounded-md border px-2 text-xs"
            bind:value={refSpecKey}
            data-testid="cal-ref-spec"
          >
            <option value="">— 选择参考规格 —</option>
            {#each specs as s (s.specKey)}
              <option value={s.specKey}>{s.shapeId} · {s.sizeLabel}（{s.diameterMm}mm）</option>
            {/each}
          </select>
        </label>
      {/if}

      <!-- 实时草稿预览：物化 physical 或 typed 错误（比例漂移/悬空 ref） -->
      {#if draft !== null}
        {#if draft.ok}
          <p class="font-mono text-xs" data-testid="cal-physical-preview">
            物化尺寸：{mmLabel(draft.physical.widthMm)}×{mmLabel(draft.physical.heightMm)}mm
            {#if draft.calibration.mode === 'reference'}（按 {draft.calibration.refSpecSnapshot?.sizeLabel ?? ''} 反推）{/if}
          </p>
        {:else}
          <p class="destructive text-xs" data-testid="cal-physical-preview">{draft.error.message}</p>
        {/if}
      {/if}
    </div>
    <div class="flex gap-2">
      <Button variant="outline" size="sm" onclick={() => (step = 1)} data-testid="cal-back">上一步</Button>
      <Button size="sm" disabled={draft?.ok !== true} onclick={toStep3} data-testid="cal-next">下一步：命名入库</Button>
    </div>
  {:else}
    <!-- ③ 命名入库（另存为副本） -->
    <label class="grid gap-1 text-xs" for="cal-name">
      名称
      <Input id="cal-name" bind:value={name} placeholder="如：马眼亮片 5mm" data-testid="cal-name" />
    </label>
    <p class="text-muted-foreground text-[11px]">
      入库 = 另存新钻形资产（内容不可变——后续改校准将再另存副本；calibration 仅记出处，参考钻后续改动不影响本钻形）。
    </p>
    <div class="flex gap-2">
      <Button variant="outline" size="sm" onclick={() => (step = 2)} data-testid="cal-back">上一步</Button>
      <Button size="sm" disabled={name.trim() === '' || draft?.ok !== true || busy} onclick={() => void commit()} data-testid="cal-commit">
        {busy ? '入库中…' : '入库（另存为副本）'}
      </Button>
    </div>
  {/if}
</section>
