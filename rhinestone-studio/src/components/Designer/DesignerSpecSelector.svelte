<!--
 * DesignerSpecSelector.svelte——当前规格选择器（design §6.2：形×档×色；3.2/3.3 切片）。
 *
 * Orthogonal intents (max 5):
 * 1. [redesign 3.2] 顶部文档栏「当前规格」触发钮 + 弹层（形（内置五形目录 + 自定义形资产）
 *    × 档（目录档位——自定义条目各自成档）× 色（文档色板））；规格码（R10/SQ35/资产名）
 *    人读展示。数据源 = gemCatalogService 零改动消费（specSelector 模块目录态）。
 * 2. [同源纪律] 唯一写入口 = 命令总线 apply-spec（选中钻 ≥1 = 批量改规格单 undo 组 +
 *    恒写 brushSpec 真源——当前规格跟随 design §6.1/§6.2）；开合态在 specSelector 模块
 *    （右键「改规格▸ 更多…」经命令总线 open-spec-selector → UI 钩子唤起同一弹层）。
 * 3. [redesign 3.3 校准向导接线（design §6.3）] 弹层「+ 自定义形…」→ 选贴图（上传图片→
 *    解码成 GemshapeTexture）→ CalibrationWizard 三步向导（文件原地不动，只接调用方；
 *    参考规格列表 = 已注入目录快照，落库端口 = ingestGemshapeFile sys-shapes 真实链路）；
 *    入库后新自定义形直接成为当前规格（apply-spec）+ 目录重拉 + 资产 prefetch。
 * 4. [报错面] 当前 custom 形资产 missing 徽标（brushAssetStatusOf——missing-asset 拒画
 *    防线的显式呈现）；生效目标提示（选中 N 颗 = 改选中钻规格 / 空选 = 设笔刷规格）。
 * 5. [Guard] 无文档态全禁用；目录 loading/error/空态显式呈现（IDB 不可用 = 空目录不抛）。
-->

<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import { customSpecKey, baseSpecDiameterMm, gemSpecIdentityOf } from '$lib/engine'
  import { getEditDoc } from '$lib/stores/edit.svelte'
  import { getBrushSpec, type BrushSpecState } from '$lib/designer/workbench.svelte'
  import { brushAssetStatusOf, resolveBrushAsset, resolveBrushSpec } from '$lib/designer/brushEngine'
  import { execDesignerCommand } from '$lib/designer/commands'
  import {
    getSpecCatalog,
    getSpecCatalogStatus,
    getSpecSelectorOpen,
    groupSpecCatalog,
    loadSpecCatalog,
    setSpecSelectorOpen,
    specCodeOf,
    type ShapeGroup,
  } from '$lib/designer/specSelector.svelte'
  import CalibrationWizard from '../Edit/CalibrationWizard.svelte'
  import type { CalibrationSavePort } from '../Edit/calibration'
  import {
    canvasTextureDecoder,
    serializeGemshape,
    type GemshapeFile,
    type GemshapeTexture,
    type GemshapeTextureDecoder,
  } from '$lib/persistence/gemshapeFile'
  import { ingestGemshapeFile } from '$lib/persistence/assetStore'
  import { PROJECT_MIME } from '$lib/persistence/projectTypes'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Plus from '@lucide/svelte/icons/plus'

  let {
    decode = canvasTextureDecoder,
    savePort = null,
  }: {
    /** 贴图解码器（测试注入确定性替身；缺省 canvas 解码）。 */
    decode?: GemshapeTextureDecoder
    /** 落库端口（测试注入替身；缺省 = ingestGemshapeFile sys-shapes 真实链路）。 */
    savePort?: CalibrationSavePort | null
  } = $props()

  const doc = $derived(getEditDoc())
  const open = $derived(getSpecSelectorOpen())
  const catalog = $derived(getSpecCatalog())
  const status = $derived(getSpecCatalogStatus())
  const groups = $derived(groupSpecCatalog(catalog))

  /** 当前规格三元组（brushSpec 覆盖态 ?? 文档基准派生——resolveBrushSpec 单源）。 */
  const current = $derived(doc !== null ? resolveBrushSpec(doc) : null)

  /** 弹层内待选形（builtin id；null = 跟随当前规格形）。 */
  let pendingShape = $state<string | null>(null)
  const activeShape = $derived(pendingShape ?? current?.shapeId ?? 'round')
  const activeGroup = $derived(groups.find((g) => g.shapeId === activeShape) ?? null)

  /** 生效档位：与当前径相等的档（无匹配取首档——形切换后的缺省档）。 */
  const activeSize = $derived.by(() => {
    const group = activeGroup
    if (group === null) return null
    return group.sizes.find((s) => s.diameterMm === current?.diameterMm) ?? group.sizes[0] ?? null
  })

  /** 触发钮人读标签：目录命中条目规格码；缺席（基准派生/目录未载）按 specKey 身份投影派生。 */
  const currentLabel = $derived.by(() => {
    const c = current
    const d = doc
    if (c === null || d === null) return '—'
    const entry =
      c.shapeId === 'custom'
        ? catalog.find((s) => s.shapeId === 'custom' && s.assetId === c.assetId)
        : catalog.find((s) => s.shapeId === c.shapeId && s.diameterMm === c.diameterMm)
    if (entry !== undefined) return specCodeOf(entry)
    const identity = gemSpecIdentityOf(
      { shapeId: c.shapeId, diameterMm: c.diameterMm, ...(c.assetId !== undefined ? { assetId: c.assetId } : {}) },
      d.grid,
    )
    return specCodeOf({ shapeId: identity.shapeId, sizeLabel: identity.sizeLabel })
  })

  /** 当前色 swatch（色板查色；未知色回退文本）。 */
  const currentColor = $derived.by(() => {
    const c = current
    const d = doc
    if (c === null || d === null) return null
    return d.palette.find((p) => p.id === c.colorId) ?? null
  })

  /** 当前 custom 形资产解析态徽标（missing = 拒画防线显式呈现）。 */
  const customMissing = $derived(
    current?.shapeId === 'custom' && current.assetId !== undefined
      ? brushAssetStatusOf(current.assetId) === 'missing'
      : false,
  )

  // 弹层开启即拉目录（每次重读——校准入库新自定义形后可见）；关闭清理待选形。
  $effect(() => {
    if (open) void loadSpecCatalog()
  })
  $effect(() => {
    if (!open) pendingShape = null
  })

  function applySpec(spec: BrushSpecState, label: string): void {
    execDesignerCommand({ kind: 'apply-spec', spec, label })
  }

  /** 档位应用（内置形：形 + 档 + 当前色全三元组写入）。 */
  function applySize(group: ShapeGroup, sizeIndex: number): void {
    const entry = group.sizes[sizeIndex]
    if (entry === undefined) return
    applySpec(
      { shapeId: entry.shapeId as BrushSpecState['shapeId'], diameterMm: entry.diameterMm, colorId: current?.colorId ?? doc?.palette[0]?.id ?? '' },
      specCodeOf(entry),
    )
  }

  /** 自定义条目应用（形+档+assetId 一体——自定义形各自成档）。 */
  function applyCustom(assetId: string, diameterMm: number, label: string): void {
    applySpec(
      { shapeId: 'custom', diameterMm, colorId: current?.colorId ?? doc?.palette[0]?.id ?? '', assetId },
      label,
    )
  }

  /** 换色应用（形/档取弹层当前生效值——形切换后未点档时取该形首档）。 */
  function applyColor(colorId: string): void {
    const group = activeGroup
    const size = activeSize
    if (group === null || size === null) {
      // 目录缺席（loading/error）：基准派生径换色（builtin round）
      const d = doc
      if (d === null) return
      applySpec(
        {
          shapeId: current?.shapeId ?? 'round',
          diameterMm: current?.diameterMm ?? baseSpecDiameterMm(d.grid),
          colorId,
        },
        '',
      )
      return
    }
    if (group.shapeId === 'custom') {
      // 当前已应用自定义形：换色保持形/档/assetId 不变（色独立维度）
      const c = current
      if (c !== null && c.shapeId === 'custom' && c.assetId !== undefined) {
        applySpec({ shapeId: 'custom', diameterMm: c.diameterMm, assetId: c.assetId, colorId }, '')
      }
      return
    }
    applySpec({ shapeId: group.shapeId as BrushSpecState['shapeId'], diameterMm: size.diameterMm, colorId }, specCodeOf(size))
  }

  // 外点 / Esc 关闭（挂载期 window 监听；触发钮与弹层自身点击不冒泡关闭）
  function onWindowPointerDown(e: PointerEvent): void {
    const el = document.querySelector('[data-testid="designer-spec-selector"]')
    if (el !== null && e.composedPath().includes(el)) return
    setSpecSelectorOpen(false)
  }
  function onWindowKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') setSpecSelectorOpen(false)
  }
  onMount(() => {
    window.addEventListener('pointerdown', onWindowPointerDown, true)
    window.addEventListener('keydown', onWindowKeydown, true)
    return () => {
      window.removeEventListener('pointerdown', onWindowPointerDown, true)
      window.removeEventListener('keydown', onWindowKeydown, true)
    }
  })

  // ---------------------------------------------------------------------------
  // [3.3] 校准向导接线（design §6.3）：「+ 自定义形…」→ 选贴图 → CalibrationWizard
  //（文件原地不动，只接调用方）。入库后新自定义形直接成为当前规格 + 目录重拉 + prefetch。
  // ---------------------------------------------------------------------------

  let wizardOpen = $state(false)
  let wizardSession = false
  let wizardTexture = $state<GemshapeTexture | null>(null)
  let wizardBusy = $state(false)
  let wizardError = $state<string | null>(null)
  let wizardFileInput = $state<HTMLInputElement | null>(null)
  /** 入库结果（ids 来自端口返回；file 来自 onCommitIntent 意图信号——物理尺寸读取面）。 */
  let committedIds = $state<{ assetId: string; specKey: string } | null>(null)
  let committedFile = $state<GemshapeFile | null>(null)

  function openWizard(): void {
    wizardSession = true
    wizardTexture = null
    wizardError = null
    committedIds = null
    committedFile = null
    wizardOpen = true
    setSpecSelectorOpen(false) // 弹层收起，向导对话框接管
  }

  /** 关闭（完成/取消/Esc/外点任意路径幂等）：已入库 → 新自定义形直接成为当前规格。 */
  function settleWizard(): void {
    if (!wizardSession) return
    wizardSession = false
    wizardOpen = false
    wizardTexture = null
    wizardError = null
    const ids = committedIds
    const file = committedFile
    committedIds = null
    committedFile = null
    if (ids === null || file === null) return
    const diameterMm = Math.max(file.physical.widthMm, file.physical.heightMm)
    applySpec(
      { shapeId: 'custom', diameterMm, colorId: current?.colorId ?? doc?.palette[0]?.id ?? '', assetId: ids.assetId },
      file.name,
    )
    void resolveBrushAsset(ids.assetId) // 资产 prefetch（拒画防线就绪）
    void loadSpecCatalog() // 目录重拉（新自定义形入列）
  }

  // Esc/外点路径（Dialog bind:open 直改）兜底收敛到 settle
  $effect(() => {
    if (!wizardOpen) settleWizard()
  })

  function readAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error ?? new Error('读取贴图失败'))
      reader.readAsDataURL(file)
    })
  }

  /** 选贴图：上传图片 → dataURL → 解码实测宽高 → GemshapeTexture（声明值以解码为准的入口预填）。 */
  async function onWizardFile(files: FileList | null): Promise<void> {
    const file = files?.[0]
    if (file === undefined || file === null) return
    wizardBusy = true
    wizardError = null
    try {
      const dataUrl = await readAsDataUrl(file)
      const image = await decode(dataUrl)
      wizardTexture = { mime: file.type !== '' ? file.type : 'image/png', dataUrl, width: image.width, height: image.height }
    } catch (e) {
      wizardError = e instanceof Error ? e.message : String(e)
    } finally {
      wizardBusy = false
    }
  }

  /** 落库端口：注入替身优先；缺省 = ingestGemshapeFile（sys-shapes 真实链路——六 gate 全量）。 */
  const effectiveSavePort: CalibrationSavePort = async (file) => {
    const result =
      savePort !== null
        ? await savePort(file)
        : await (async () => {
            const blob = new Blob([serializeGemshape(file)], { type: PROJECT_MIME.gemshape })
            const { node, file: saved } = await ingestGemshapeFile(blob)
            return { assetId: node.id, specKey: saved.specKey ?? customSpecKey(node.id) }
          })()
    committedIds = result
    return result
  }
</script>

<div class="relative" data-testid="designer-spec-selector">
  <Button
    variant="outline"
    size="xs"
    disabled={doc === null}
    aria-expanded={open}
    title="当前规格（形×档×色）——选中钻时改为选中钻规格"
    onclick={() => setSpecSelectorOpen(!open)}
    data-testid="designer-spec-trigger"
  >
    <span class="font-mono">{currentLabel}</span>
    <!-- 当前色点（色板色 swatch；未知色空心） -->
    <span
      class="inline-block size-3 rounded-full border"
      class:border-dashed={currentColor === null}
      style={currentColor !== null ? `background:${currentColor.hex}` : ''}
      aria-hidden="true"
    ></span>
    <ChevronDown class="size-3" aria-hidden="true" />
  </Button>

  {#if open}
    <div
      class="bg-popover text-popover-foreground absolute left-0 top-full z-40 mt-1 grid w-72 gap-2 rounded-lg border p-2 text-xs shadow-lg"
      data-testid="designer-spec-popover"
      role="dialog"
      aria-label="当前规格选择器"
    >
      <!-- 生效目标提示（design §6.2：选中钻时 = 改选中钻规格） -->
      <p class="text-muted-foreground text-[11px]" data-testid="designer-spec-target-hint">
        {doc !== null && doc.selection.size > 0
          ? `选中 ${doc.selection.size} 颗钻：将改选中钻的规格（一次撤销）`
          : '设为当前笔刷规格'}
      </p>
      {#if customMissing}
        <p class="destructive text-[11px]" data-testid="designer-spec-missing">
          当前自定义形资产已缺失——落钻将被拒绝，请重选规格或重新校准
        </p>
      {/if}

      <!-- 形（内置五形目录组；自定义组条目各自成档） -->
      {#if status === 'loading' || status === 'idle'}
        <p class="text-muted-foreground px-1 py-2 text-[11px]" data-testid="designer-spec-loading">正在读取钻形目录…</p>
      {:else if groups.length === 0}
        <p class="text-muted-foreground px-1 py-2 text-[11px]" data-testid="designer-spec-empty">
          钻形目录为空（素材库 sys-shapes 无可用规格）
        </p>
      {:else}
        <div class="flex flex-wrap gap-1" role="group" aria-label="形状" data-testid="designer-spec-shapes">
          {#each groups as group (group.shapeId)}
            {#if group.shapeId === 'custom'}
              {#each group.sizes as entry (entry.assetId ?? entry.specKey)}
                <button
                  type="button"
                  class="rounded border px-2 py-1 transition-colors hover:bg-accent"
                  class:font-medium={current?.shapeId === 'custom' && current.assetId === entry.assetId}
                  class:border-primary={current?.shapeId === 'custom' && current.assetId === entry.assetId}
                  title={`自定义形 · ${entry.sizeLabel}`}
                  onclick={() => applyCustom(entry.assetId ?? '', entry.diameterMm, specCodeOf(entry))}
                  data-testid="designer-spec-shape-custom-{entry.assetId}"
                >
                  {entry.sizeLabel}
                </button>
              {/each}
            {:else}
              <button
                type="button"
                class="rounded border px-2 py-1 transition-colors hover:bg-accent"
                class:font-medium={activeShape === group.shapeId}
                class:border-primary={activeShape === group.shapeId}
                onclick={() => (pendingShape = group.shapeId)}
                data-testid="designer-spec-shape-{group.shapeId}"
              >
                {group.label}
              </button>
            {/if}
          {/each}
        </div>

        <!-- 档位（当前形的目录档位；custom 已随形一体应用不列档） -->
        {#if activeGroup !== null && activeGroup.shapeId !== 'custom'}
          <div class="grid gap-0.5" role="group" aria-label="尺寸档位" data-testid="designer-spec-sizes">
            {#each activeGroup.sizes as entry, i (entry.specKey)}
              <button
                type="button"
                class="hover:bg-accent flex items-center justify-between rounded px-2 py-1 text-left"
                class:font-medium={current?.shapeId === entry.shapeId && current.diameterMm === entry.diameterMm}
                onclick={() => applySize(activeGroup!, i)}
                data-testid="designer-spec-size-{entry.specKey}"
              >
                <span>{entry.sizeLabel}</span>
                <span class="text-muted-foreground font-mono">{specCodeOf(entry)}</span>
              </button>
            {/each}
          </div>
        {/if}
      {/if}

      <!-- 色（文档色板） -->
      {#if doc !== null && doc.palette.length > 0}
        <div class="flex flex-wrap items-center gap-1 border-t pt-2" role="group" aria-label="颜色" data-testid="designer-spec-colors">
          {#each doc.palette as color (color.id)}
            <button
              type="button"
              class="size-5 rounded-full border-2 transition-transform hover:scale-110"
              class:border-primary={current?.colorId === color.id}
              style="background:{color.hex}"
              title={color.name}
              aria-label={color.name}
              aria-pressed={current?.colorId === color.id}
              onclick={() => applyColor(color.id)}
              data-testid="designer-spec-color-{color.id}"
            ></button>
          {/each}
        </div>
      {/if}

      <!-- [3.3] 校准向导入口（design §6.3：规格选择器「+ 自定义形…」） -->
      <div class="border-t pt-2">
        <Button variant="outline" size="xs" class="w-full justify-center" onclick={openWizard} data-testid="designer-spec-add-custom">
          <Plus class="size-3" aria-hidden="true" />
          自定义形…
        </Button>
      </div>
    </div>
  {/if}

  <!-- [3.3] 校准向导（CalibrationWizard 文件原地不动——只接调用方：贴图由本入口提供，
       落库端口 = ingestGemshapeFile sys-shapes 真实链路（可注入替身）；入库后新自定义形
       直接成为当前规格（settleWizard → apply-spec 命令总线同源）） -->
  <Dialog.Root bind:open={wizardOpen}>
    <Dialog.Content class="max-w-md" data-testid="designer-spec-wizard-dialog">
      <Dialog.Header>
        <Dialog.Title>自定义钻形校准</Dialog.Title>
        <Dialog.Description>
          选一张钻石素材图（贴图），经三步校准入库为新的自定义钻形——入库后直接成为当前规格。
        </Dialog.Description>
      </Dialog.Header>

      {#if wizardError !== null}
        <p class="destructive rounded-md border border-destructive/30 px-2.5 py-1.5 text-xs" data-testid="designer-spec-wizard-error">
          {wizardError}
        </p>
      {/if}

      {#if wizardTexture === null}
        <!-- 入口步：选贴图（上传图片 → 解码 → 向导接管） -->
        <div class="grid gap-2 text-xs" data-testid="designer-spec-wizard-pick">
          <p class="text-muted-foreground">请选择贴图（PNG/JPG/WebP；alpha 内容 bounds 是校准换算依据）。</p>
          <input
            bind:this={wizardFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            class="text-xs"
            onchange={(e) => {
              void onWizardFile(e.currentTarget.files)
              e.currentTarget.value = ''
            }}
            data-testid="designer-spec-wizard-file"
          />
          {#if wizardBusy}
            <p class="text-muted-foreground">解码中…</p>
          {/if}
        </div>
        <Dialog.Footer>
          <Button variant="outline" size="sm" onclick={() => settleWizard()} data-testid="designer-spec-wizard-cancel">
            取消
          </Button>
        </Dialog.Footer>
      {:else}
        <!-- 三步向导（选贴图已完成——贴图注入；参考规格 = 已注入目录快照；落库端口注入） -->
        <div class="max-h-[60vh] overflow-y-auto">
          <CalibrationWizard
            texture={wizardTexture}
            referenceSpecs={getSpecCatalog().length > 0 ? getSpecCatalog() : undefined}
            {decode}
            savePort={effectiveSavePort}
            onCommitIntent={(file) => {
              committedFile = file
            }}
            onClose={() => settleWizard()}
          />
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Root>
</div>
