<!--
GemshapeSheet.svelte——gemshape 钻形资产查看 RightSheet（openspec add-gem-catalog-and-sizes
2.2 vertical slice，design §3.2-5；沿 TemplateEditSheet 先例的素材库 RightSheet）。

设计裁决（design §1.6 身份纪律 / R3 P0-2 修复冻结）：
- **编辑器 = 查看 + 「另存为自定义副本」入口，无就地改内容**——.gemshape 内容不可变
  （texture/vectorPath/physical/calibration/specKey 任何变更 = 另存新资产，不参与 blobKey
  换绑）；节点改名等元数据编辑走网格行内重命名（既有机制），不在本 Sheet。
- 「去使用」入口归 rename-and-expert-workbench 的钻形库 UI（design §3.2-3）——本 Sheet 不设。
- 编辑期 pin 校准参考（design §3.2-7）：calibration.mode='reference' 且 refSpecId 对应资产
  存在时 pin 该参考资产（防止编辑期间被硬清），关闭即解除——只保护校准参考，不升级文档弱引用。
- 态机：loading → ready（字段+贴图预览）/ error（parse 失败或字节缺失——wrong-kind 可见）/
  missing（节点不存在或已在回收站）。异步解析经 cancelled 旗防陈旧回写。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { SHAPE_IDS } from '$lib/engine'
  import {
    forkGemshapeAsset,
    getProject,
    pinGemshapeCalibrationRef,
    unpinAsset,
  } from '$lib/persistence/assetStore'
  import { parseGemshape, type GemshapeFile } from '$lib/persistence/gemshapeFile'
  import { getImageBlob } from '$lib/persistence/imageStore'
  import type { AssetProject } from '$lib/persistence/projectTypes'
  import { showToast } from '$lib/stores/toast.svelte'
  import Copy from '@lucide/svelte/icons/copy'
  import Ruler from '@lucide/svelte/icons/ruler'
  import Shapes from '@lucide/svelte/icons/shapes'

  let {
    assetId = null as string | null,
    onclose,
    onforked,
  }: {
    /** 打开对象（null = 关闭）。 */
    assetId?: string | null
    /** 关闭请求（内建关闭路径全部改道此处；本 Sheet 无未落盘缓冲，直接关闭）。 */
    onclose: () => void
    /** 另存副本成功（新节点 id——调用方刷新定位）。 */
    onforked?: (nodeId: string) => void
  } = $props()

  let file = $state<GemshapeFile | null>(null)
  let node = $state<AssetProject | null>(null)
  let loadState = $state<'loading' | 'ready' | 'error' | 'missing'>('loading')
  let errorMessage = $state('')
  let forking = $state(false)

  /** 编辑期 pin 的校准参考节点 id（null = 未 pin）。 */
  let pinnedRefNodeId: string | null = null

  function releasePinnedRef(): void {
    if (pinnedRefNodeId === null) return
    unpinAsset(pinnedRefNodeId)
    pinnedRefNodeId = null
  }

  $effect(() => {
    const id = assetId
    releasePinnedRef()
    file = null
    node = null
    errorMessage = ''
    loadState = id === null ? 'missing' : 'loading'
    if (id === null) return
    let cancelled = false
    void (async () => {
      const project = await getProject(id)
      if (cancelled) return
      if (project === null || project.projectKind !== 'gemshape' || project.trashedAt !== undefined) {
        node = project
        loadState = 'missing'
        errorMessage = project === null ? '资产不存在（可能已被永久删除）。' : '资产在回收站中或不是钻形资产。'
        return
      }
      node = project
      const blob = await getImageBlob(project.blobKey).catch(() => null)
      if (cancelled) return
      if (blob === null) {
        loadState = 'error'
        errorMessage = '贴图字节缺失（物理记录丢失）——资产不可用（blob-missing）。'
        return
      }
      try {
        const parsed = parseGemshape(await blob.text(), { mime: project.mime })
        if (cancelled) return
        file = parsed
        loadState = 'ready'
        // 编辑期 pin 校准参考（参考资产存在才 pin；悬空 ref 不 pin 不报错——快照可审计）
        if (parsed.calibration.mode === 'reference' && parsed.calibration.refSpecId !== undefined) {
          const pinned = await pinGemshapeCalibrationRef(parsed.calibration.refSpecId)
          if (!cancelled) pinnedRefNodeId = pinned
        }
      } catch (error) {
        if (cancelled) return
        loadState = 'error'
        errorMessage = error instanceof Error ? error.message : String(error)
      }
    })()
    return () => {
      cancelled = true
      releasePinnedRef()
    }
  })

  /** 组件销毁兜底解除 pin（$effect cleanup 已覆盖；双保险防异步竞态漏网）。 */
  $effect(() => {
    return () => releasePinnedRef()
  })

  const shapeId = $derived.by(() => {
    const key = file?.specKey ?? ''
    const head = key.split('-')[0]
    return (SHAPE_IDS as readonly string[]).includes(head) ? head : 'custom'
  })
  const shapeName = $derived.by(() => {
    if (shapeId === 'custom') return '自定义钻形'
    const names: Record<string, string> = { round: '圆钻', square: '方钻', drop: '水滴', heart: '心形', marquise: '马眼' }
    return names[shapeId] ?? shapeId
  })
  const diameterMm = $derived(file === null ? 0 : Math.max(file.physical.widthMm, file.physical.heightMm))
  const calibrationLine = $derived.by(() => {
    const c = file?.calibration
    if (c === undefined) return ''
    if (c.mode === 'direct') return '直接输入（direct）'
    const ref = c.refSpecId ?? '（悬空——凭内嵌快照可审计）'
    return `以 ${ref} 为量纲（reference）`
  })

  async function forkCopy(): Promise<void> {
    if (node === null || forking) return
    forking = true
    try {
      const result = await forkGemshapeAsset(node.id)
      showToast(`已另存为自定义副本「${result.node.name}」`)
      onforked?.(result.node.id)
      onclose()
    } catch (error) {
      showToast(`另存副本失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      forking = false
    }
  }
</script>

<Sheet.Root open={assetId !== null} onOpenChange={(next) => { if (!next) onclose() }}>
  <Sheet.Content
    side="right"
    showCloseButton={false}
    class="w-full gap-0 sm:max-w-[440px]"
    data-testid="gemshape-sheet"
    onEscapeKeydown={(e) => {
      e.preventDefault()
      onclose()
    }}
    onInteractOutside={(e) => {
      e.preventDefault()
      onclose()
    }}
  >
    <div class="bg-border mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full sm:hidden" aria-hidden="true"></div>

    <Sheet.Header class="flex-row items-center gap-2 border-b px-4 pt-2 pb-3">
      <Sheet.Title class="min-w-0 flex-1 truncate text-sm font-medium" data-testid="gemshape-sheet-title">
        {node?.name || file?.name || '钻形资产'}
      </Sheet.Title>
      <Button variant="outline" size="sm" class="shrink-0" onclick={() => onclose()} data-testid="gemshape-sheet-close">
        关闭
      </Button>
    </Sheet.Header>
    <Sheet.Description class="sr-only">
      查看钻形资产的贴图、物理尺寸与校准出处；内容不可变，修改需另存为自定义副本。
    </Sheet.Description>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)]" data-testid="gemshape-sheet-body">
      {#if loadState === 'loading'}
        <p class="text-muted-foreground py-8 text-center text-xs" data-testid="gemshape-sheet-loading">正在读取钻形资产…</p>
      {:else if loadState === 'missing' || loadState === 'error'}
        <p class="text-destructive py-8 text-center text-xs" data-testid="gemshape-sheet-error" role="alert">{errorMessage}</p>
      {:else if file !== null}
        <!-- 贴图预览（钻石素材图——alpha 剪影） -->
        <div
          class="bg-muted/50 mx-auto mt-4 flex aspect-square w-full max-w-56 items-center justify-center rounded-lg border p-4"
          data-testid="gemshape-sheet-texture"
        >
          <img src={file.texture.dataUrl} alt={node?.name ?? '钻形贴图'} class="max-h-full max-w-full object-contain" draggable="false" />
        </div>

        <dl class="mt-4 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-xs">
          <dt class="text-muted-foreground flex items-center gap-1"><Shapes class="size-3.5" aria-hidden="true" />形状</dt>
          <dd class="flex items-center gap-1.5">
            {shapeName}
            {#if file.specKey !== undefined}
              <Badge variant="secondary" class="px-1.5 text-[10px]" data-testid="gemshape-sheet-speckey">{file.specKey}</Badge>
            {/if}
          </dd>

          <dt class="text-muted-foreground flex items-center gap-1"><Ruler class="size-3.5" aria-hidden="true" />物理尺寸</dt>
          <dd class="tabular-nums" data-testid="gemshape-sheet-physical">
            {file.physical.widthMm} × {file.physical.heightMm} mm（最大径 {diameterMm} mm）
          </dd>

          <dt class="text-muted-foreground">贴图</dt>
          <dd class="tabular-nums">{file.texture.width} × {file.texture.height} px · {file.texture.mime.replace('image/', '').toUpperCase()}</dd>

          <dt class="text-muted-foreground">矢量</dt>
          <dd>{file.vectorPath !== undefined ? '已携带（导出优先矢量）' : '未携带（按贴图缩放渲染）'}</dd>

          <dt class="text-muted-foreground">校准</dt>
          <dd data-testid="gemshape-sheet-calibration">{calibrationLine}</dd>
        </dl>

        <div class="border-t mt-5 pt-4">
          <p class="text-muted-foreground text-[11px] leading-relaxed">
            钻形资产内容不可变：修改尺寸或校准会「另存为自定义副本」（新资产、新身份键），原资产保持不变。
          </p>
          <Button size="sm" class="mt-3 w-full" onclick={() => void forkCopy()} disabled={forking} data-testid="gemshape-sheet-fork">
            <Copy />
            {forking ? '另存中…' : '另存为自定义副本'}
          </Button>
        </div>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
