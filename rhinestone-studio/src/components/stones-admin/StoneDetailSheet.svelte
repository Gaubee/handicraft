<!--
StoneDetailSheet.svelte——装饰钻详情 RightSheet（add-stone-library S3.3，design §4.1
stones.get 四态：resolved/soft-deleted/blob-missing/wrong-kind——竞态降级与 not-found
为防御态）。全文态=stone.json 全文+贴图大图（textureUrl 同源 ETag 缓存）+metadata
折叠+raw JSON 折叠。写面占位：恢复（S1 restore 在 service，无浏览器 RPC 端点）与
软删（delete proposal 走授权桥）均显式呈现「待 admin/MCP 面」——不伪造执行。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import {
    closeStoneDetail,
    getStonesDetailId,
    getStonesDetailState,
    getStonesDetailView,
  } from '$lib/stonesAdmin/store.svelte'
  import AlertTriangle from '@lucide/svelte/icons/alert-triangle'
  import FileWarning from '@lucide/svelte/icons/file-warning'
  import Hash from '@lucide/svelte/icons/hash'
  import PackageX from '@lucide/svelte/icons/package-x'
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw'
  import Trash2 from '@lucide/svelte/icons/trash-2'

  const detailId = $derived(getStonesDetailId())
  const detailState = $derived(getStonesDetailState())
  const view = $derived(getStonesDetailView())

  /** 软删授权桥占位面板开关。 */
  let deletePanelOpen = $state(false)

  const full = $derived(view?.view === 'full' ? view.detail : null)

  function metadataEntries(metadata: Record<string, unknown>): Array<[string, string]> {
    return Object.entries(metadata).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)])
  }
</script>

<Sheet.Root open={detailId !== null} onOpenChange={(next) => { if (!next) closeStoneDetail() }}>
  <Sheet.Content
    side="right"
    showCloseButton={false}
    class="w-full gap-0 sm:max-w-[460px]"
    data-testid="stone-detail-sheet"
    onEscapeKeydown={(e) => {
      e.preventDefault()
      closeStoneDetail()
    }}
    onInteractOutside={(e) => {
      e.preventDefault()
      closeStoneDetail()
    }}
  >
    <div class="bg-border mx-auto mt-2 h-1.5 w-10 shrink-0 rounded-full sm:hidden" aria-hidden="true"></div>

    <Sheet.Header class="flex-row items-center gap-2 border-b px-4 pt-2 pb-3">
      <Sheet.Title class="min-w-0 flex-1 truncate text-sm font-medium" data-testid="stone-detail-title">
        {#if full !== null}
          {full.stone.name}
        {:else}
          装饰钻详情
        {/if}
      </Sheet.Title>
      {#if full !== null}
        <Badge variant="outline" class="font-mono text-xs">{full.stone.sku}</Badge>
        {#if full.state === 'soft-deleted'}
          <Badge variant="destructive" data-testid="stone-detail-trashed-badge">已软删</Badge>
        {/if}
      {/if}
      <Button variant="outline" size="sm" class="shrink-0" onclick={() => closeStoneDetail()} data-testid="stone-detail-close">
        关闭
      </Button>
    </Sheet.Header>
    <Sheet.Description class="sr-only">装饰钻 stone.json 全文与贴图预览</Sheet.Description>

    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
      {#if detailState === 'loading' || detailState === 'idle'}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="stone-detail-loading">加载中…</p>
      {:else if detailState === 'error'}
        <p class="text-destructive py-16 text-center text-sm" data-testid="stone-detail-error">详情加载失败（连接中断或响应不符契约）</p>
      {:else if view === null}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="stone-detail-empty">未选择钻</p>
      {:else if view.view === 'full' && full !== null}
        {@const stone = full.stone}
        <!-- 贴图大图（预览底非纯白 §1.4——currentColor 减色底） -->
        <div
          class="mb-4 flex h-56 items-center justify-center overflow-hidden rounded-xl border border-border/70"
          style="background: color-mix(in srgb, currentColor 6%, transparent)"
          data-testid="stone-detail-texture"
        >
          <img
            src={full.texture.textureUrl}
            alt="{stone.name} 贴图大图"
            class="max-h-full max-w-full object-contain p-3"
            data-testid="stone-detail-texture-img"
          />
        </div>
        <p class="text-muted-foreground -mt-3 mb-4 text-right font-mono text-[11px]">
          {full.texture.width}×{full.texture.height}px · {stone.texture.alphaBounds.w}×{stone.texture.alphaBounds.h} 内容域
        </p>

        {#if full.state === 'soft-deleted'}
          <div class="border-destructive/30 bg-destructive/10 mb-4 flex items-start gap-2.5 rounded-lg border p-3" data-testid="stone-detail-restore-placeholder">
            <RotateCcw class="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div class="min-w-0 text-sm">
              <p class="font-medium">恢复待 admin API</p>
              <p class="text-muted-foreground mt-0.5 text-xs leading-relaxed">
                软删恢复（S1 restore）在 daemon service 层，尚未暴露浏览器 RPC 端点——本视图只读呈现；恢复经 daemon 管理/MCP 面执行。
              </p>
            </div>
          </div>
        {/if}

        <!-- 字段面（§1.3 客观真值：颜色+尺寸为主，其余收纳） -->
        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm" data-testid="stone-detail-fields">
          <dt class="text-muted-foreground">尺寸</dt>
          <dd class="font-mono">{stone.sizeMm !== null ? `${stone.sizeMm}mm` : '未声明（metadata.sizeNote 见下）'}</dd>
          <dt class="text-muted-foreground">色名</dt>
          <dd>{stone.color.name}</dd>
          <dt class="text-muted-foreground">代表色</dt>
          <dd class="flex items-center gap-2">
            <span class="size-4 rounded-full border border-black/10" style="background: #{stone.color.rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}" aria-hidden="true"></span>
            <span class="font-mono text-xs">#{stone.color.rgb.map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}</span>
          </dd>
          <dt class="text-muted-foreground">色系</dt>
          <dd>{stone.color.family}</dd>
          <dt class="text-muted-foreground">质感</dt>
          <dd>{stone.color.finish}</dd>
          <dt class="text-muted-foreground">供应商</dt>
          <dd class="font-mono">{stone.supplier}</dd>
          {#if stone.skuParsed !== undefined}
            <dt class="text-muted-foreground">编码解析</dt>
            <dd class="font-mono text-xs">行 {stone.skuParsed.row} · 前缀 {stone.skuParsed.prefix} → {stone.skuParsed.sizeMm}mm（导入快照）</dd>
          {/if}
          {#if stone.gemshapeRef !== undefined}
            <dt class="text-muted-foreground">钻形关联</dt>
            <dd class="font-mono text-xs">{stone.gemshapeRef}</dd>
          {/if}
          {#if stone.views !== undefined && stone.views.length > 0}
            <dt class="text-muted-foreground">实物视图</dt>
            <dd class="flex flex-wrap gap-1.5">
              {#each stone.views as name (name)}
                <img src="/api/stones/{full.resourceId}/views/{name}" alt="实物视图 {name}" class="h-10 w-10 rounded border border-border/70 object-cover" style="background: color-mix(in srgb, currentColor 6%, transparent)" loading="lazy" />
              {/each}
            </dd>
          {/if}
          <dt class="text-muted-foreground">修订/路径</dt>
          <dd class="min-w-0 text-xs">
            <span class="font-mono">r{full.revision}</span>
            <span class="text-muted-foreground break-all"> · {full.path}</span>
          </dd>
        </dl>

        <!-- metadata 折叠（唯一自由扩展面） -->
        {#if Object.keys(stone.metadata).length > 0}
          <details class="mt-4 rounded-lg border border-border/70 px-3 py-2" data-testid="stone-detail-metadata">
            <summary class="text-muted-foreground cursor-pointer text-xs font-medium">metadata（{Object.keys(stone.metadata).length} 项）</summary>
            <dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              {#each metadataEntries(stone.metadata) as [key, value] (key)}
                <dt class="text-muted-foreground font-mono">{key}</dt>
                <dd class="break-all font-mono">{value}</dd>
              {/each}
            </dl>
          </details>
        {/if}

        <details class="mt-2 rounded-lg border border-border/70 px-3 py-2" data-testid="stone-detail-raw">
          <summary class="text-muted-foreground cursor-pointer text-xs font-medium">stone.json 全文</summary>
          <pre class="scrollbar-thin mt-2 max-h-64 overflow-auto rounded bg-muted/60 p-2 font-mono text-[11px] leading-relaxed">{JSON.stringify(stone, null, 2)}</pre>
        </details>
      {:else if view.view === 'blob-missing'}
        <div class="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm" data-testid="stone-detail-blob-missing">
          <FileWarning class="size-8 opacity-60" aria-hidden="true" />
          <p>贴图或 stone.json 内容缺失（blob-missing）</p>
          <p class="text-xs">物理文件丢失——归运维对账面重建，本视图只读。</p>
        </div>
      {:else if view.view === 'wrong-kind'}
        <div class="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm" data-testid="stone-detail-wrong-kind">
          <PackageX class="size-8 opacity-60" aria-hidden="true" />
          <p>资源类型不符（wrong-kind）</p>
          <p class="text-xs">该 resourceId 不是装饰钻原子目录。</p>
        </div>
      {:else if view.view === 'not-found'}
        <div class="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm" data-testid="stone-detail-not-found">
          <Hash class="size-8 opacity-60" aria-hidden="true" />
          <p>资源不存在</p>
        </div>
      {:else if view.view === 'degraded'}
        <div class="text-muted-foreground flex flex-col items-center gap-2 py-16 text-sm" data-testid="stone-detail-degraded">
          <AlertTriangle class="size-8 opacity-60" aria-hidden="true" />
          <p>解析与读取竞态降级（{view.state}）——重试通常恢复</p>
        </div>
      {/if}
    </div>

    {#if full !== null}
      <Sheet.Footer class="flex-row items-center gap-2 border-t px-4 py-3">
        <span class="text-muted-foreground mr-auto font-mono text-[11px]">{full.resourceId}</span>
        {#if full.state === 'resolved'}
          <Button variant="outline" size="sm" onclick={() => (deletePanelOpen = true)} data-testid="stone-detail-delete">
            <Trash2 class="size-3.5" aria-hidden="true" />
            软删
          </Button>
        {/if}
      </Sheet.Footer>
    {/if}
  </Sheet.Content>
</Sheet.Root>

<!-- 软删授权桥占位：delete proposal 走授权桥（§6 approved-mutation）——浏览器无端点，不伪造。 -->
<Dialog.Root open={deletePanelOpen} onOpenChange={(next) => (deletePanelOpen = next)}>
  <Dialog.Content class="max-w-lg" data-testid="stone-delete-panel">
    <Dialog.Header>
      <Dialog.Title>软删走授权桥</Dialog.Title>
      <Dialog.Description>
        stone.delete 是 approved-mutation：proposal（diff 预览）→ 人工批准 → grant → 执行。浏览器 RPC 面暂无端点——经 Agent/MCP 面发起。
      </Dialog.Description>
    </Dialog.Header>
    <textarea
      readonly
      rows="6"
      class="w-full rounded-md border bg-muted/50 p-2 font-mono text-[11px]"
      data-testid="stone-delete-mcp-json"
      value={JSON.stringify(
        {
          tool: 'stone.delete',
          mode: 'propose → 批准 → 执行 {taskId, proposalId}',
          arguments: { taskId: '<任务上下文>', resourceId: full?.resourceId ?? detailId ?? '' },
        },
        null,
        2,
      )}
    ></textarea>
    <Dialog.Footer>
      <Button variant="outline" size="sm" onclick={() => (deletePanelOpen = false)} data-testid="stone-delete-panel-close">知道了</Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
