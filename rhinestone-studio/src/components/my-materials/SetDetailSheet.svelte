<!--
  SetDetailSheet.svelte——「我的材料 → 我的贴砖组合」组合详情 RightSheet（Owner
  验收 2026-09-30：点「客户全色系生产组合」等组合卡片应打开详情面板，可预览这个
  特殊格式的「文件/文件夹」）。形态照 StoneDetailSheet（右滑出 Sheet + 固定头/滚
  动体/固定脚三段）。
  数据面：sets.get 读时解析成员快照（store getMySetDetail 直通——绑定 client 复
  用 lib/myMaterials/sets.svelte.ts 注入形态，不另起连接）；头部字段取传入
  SetSummary（get 前即可呈现，不空闪）。
  成员渲染（复用 lib/stonesAdmin/setMembers 投影，与材料市场组合视图同口径）：
  - resolved → memberCellOf 投影轻量卡（贴图 80% contains + SKU + 供应商 + 数量）。
  - 非 resolved → memberPlaceholderOf 占位（五态中文标签+限定名/短 ref——如实缺图，
    不伪造钻卡）。
  大成员量分块渐进（全色系组合 848 量级——严禁一次全渲染）：首屏 CHUNK=60，
  「加载更多」每块 +60。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { withAuthToken } from '$lib/stonesAdmin/authUrl'
  import { memberCellOf, memberPlaceholderOf, SET_MEMBER_STATE_LABEL } from '$lib/stonesAdmin/setMembers'
  import { getMySetDetail } from '$lib/myMaterials/sets.svelte'
  import type { SetSummary, SetsGetOutput } from '$lib/warehouse/schemas'

  /** 渐进渲染块大小（首屏 60——848 成员量级严禁一次全渲染）。 */
  const CHUNK = 60

  let {
    summary,
    onclose,
  }: {
    /** 目标组合（null=关闭——头部字段 get 前即可呈现）。 */
    summary: SetSummary | null
    onclose: () => void
  } = $props()

  type DetailState = 'idle' | 'loading' | 'ready' | 'error'

  let detail = $state<SetsGetOutput | null>(null)
  let detailState = $state<DetailState>('idle')
  let errorMessage = $state('')
  let visibleCount = $state(CHUNK)
  /** 装载令牌（切换目标/重试时弃旧响应——竞态守卫）。 */
  let loadToken = 0

  const members = $derived(detail?.members ?? [])
  const visibleMembers = $derived(members.slice(0, visibleCount))

  /** 更新时间呈现（本地化短格式）。 */
  function formatUpdatedAt(iso: string): string {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { dateStyle: 'short', timeStyle: 'short' })
  }

  async function load(resourceId: string): Promise<void> {
    const token = ++loadToken
    detailState = 'loading'
    errorMessage = ''
    try {
      const out = await getMySetDetail(resourceId)
      if (token !== loadToken) return
      detail = out
      detailState = 'ready'
    } catch (error) {
      if (token !== loadToken) return
      detail = null
      errorMessage = error instanceof Error ? error.message : String(error)
      detailState = 'error'
    }
  }

  /** 目标变化（打开/切换）→ 拉成员快照；关闭即复位。 */
  $effect(() => {
    const resourceId = summary?.resourceId
    detail = null
    errorMessage = ''
    visibleCount = CHUNK
    if (resourceId === undefined) {
      detailState = 'idle'
      return
    }
    void load(resourceId)
  })
</script>

<Sheet.Root open={summary !== null} onOpenChange={(next) => { if (!next) onclose() }}>
  <Sheet.Content
    side="right"
    showCloseButton={false}
    class="w-full gap-0 sm:max-w-[720px]"
    data-testid="my-set-detail-sheet"
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

    <!-- 头部：名称 + 成员数徽标 + 关闭（summary 直供——get 前不空闪） -->
    <Sheet.Header class="flex-row items-center gap-2 shrink-0 border-b px-4 pt-2 pb-3">
      <Sheet.Title class="min-w-0 flex-1 truncate text-sm font-medium" data-testid="my-set-detail-title">
        {summary?.name ?? '组合详情'}
      </Sheet.Title>
      {#if summary !== null}
        <Badge variant="secondary" class="shrink-0 text-xs" data-testid="my-set-detail-count">{summary.memberCount} 款钻</Badge>
      {/if}
      <Button variant="outline" size="sm" class="shrink-0" onclick={() => onclose()} data-testid="my-set-detail-close">
        关闭
      </Button>
    </Sheet.Header>
    <Sheet.Description class="sr-only">组合成员快照预览（sets.get 读时解析）</Sheet.Description>

    <!-- 次头行：用途/更新时间/修订（弱化元信息——design 同卡片行内口径） -->
    {#if summary !== null}
      <div class="text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-xs">
        {#if summary.purpose}
          <span class="min-w-0 max-w-full truncate" title={summary.purpose} data-testid="my-set-detail-purpose">用途：{summary.purpose}</span>
        {/if}
        <span title={summary.updatedAt}>更新于 {formatUpdatedAt(summary.updatedAt)}</span>
        <span class="ml-auto shrink-0 font-mono">r{summary.revision}</span>
      </div>
    {/if}

    <!-- 滚动成员区（固定头/脚分界——末行不贴底缘切断） -->
    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4 pb-8">
      {#if detailState === 'idle' || detailState === 'loading'}
        <p class="text-muted-foreground py-16 text-center text-sm" data-testid="my-set-detail-loading" role="status">成员装载中…</p>
      {:else if detailState === 'error'}
        <div class="flex flex-col items-center gap-2 py-16 text-center" data-testid="my-set-detail-error" role="alert">
          <p class="text-destructive text-sm">成员装载失败（连接中断或响应不符契约）</p>
          <p class="text-muted-foreground max-w-md break-all text-xs">{errorMessage}</p>
          {#if summary !== null}
            <Button variant="outline" size="sm" class="mt-1" onclick={() => void load(summary.resourceId)} data-testid="my-set-detail-retry">
              重试
            </Button>
          {/if}
        </div>
      {:else if members.length === 0}
        <div class="text-muted-foreground flex flex-col items-center gap-2 py-16 text-center" data-testid="my-set-detail-empty">
          <p class="text-sm">组合暂无成员</p>
          <p class="text-xs opacity-80">成员清单为空（契约面空成员拒——防御态）</p>
        </div>
      {:else}
        <div class="grid gap-2" style="grid-template-columns: repeat(auto-fill, minmax(128px, 1fr))" data-testid="my-set-detail-grid">
          {#each visibleMembers as member (member.stoneRef)}
            {@const cell = memberCellOf(member)}
            {#if cell !== null}
              <!-- resolved 轻量卡：贴图 80% contains + SKU + 供应商 + 数量 -->
              <div
                class="border-border/70 bg-card flex h-40 flex-col overflow-hidden rounded-xl border text-left"
                data-testid="my-set-detail-member-{member.stoneRef}"
                title="{cell.name}（{cell.sku}）"
              >
                <span class="bg-zinc-300 dark:bg-zinc-700 relative flex w-full flex-1 items-center justify-center overflow-hidden" style="min-height: 3rem">
                  <img
                    src={withAuthToken(cell.textureUrl)}
                    alt="{cell.name} 贴图"
                    loading="lazy"
                    decoding="async"
                    class="h-[80%] w-[80%] object-contain"
                    data-testid="my-set-detail-member-img-{member.stoneRef}"
                  />
                </span>
                <span class="flex flex-col gap-0.5 px-2 py-1.5">
                  <span class="flex items-center gap-1.5">
                    <span class="size-2.5 shrink-0 rounded-full border border-black/10" style="background: {cell.colorHex}" aria-hidden="true"></span>
                    <span class="text-foreground font-mono text-xs font-semibold tracking-tight">{cell.sku}</span>
                    <span class="text-muted-foreground ml-auto text-[11px]">{cell.sizeMm !== null ? `${cell.sizeMm}mm` : ''}</span>
                  </span>
                  <span class="text-muted-foreground truncate font-mono text-[11px]">{cell.supplier}</span>
                  <span class="text-muted-foreground text-[11px]">{member.quantity !== undefined ? `数量 ${member.quantity}` : '按设计用量另计'}</span>
                </span>
              </div>
            {:else}
              <!-- 非 resolved 占位：五态中文标签+限定名/短 ref（如实缺图——不伪造钻卡） -->
              {@const placeholder = memberPlaceholderOf(member)}
              <div
                class="border-border/70 bg-card flex h-40 flex-col overflow-hidden rounded-xl border text-left"
                data-testid="my-set-detail-member-{member.stoneRef}"
                title="{placeholder.label}（{SET_MEMBER_STATE_LABEL[placeholder.state]}）"
              >
                <span class="bg-zinc-300 dark:bg-zinc-700 relative flex w-full flex-1 items-center justify-center overflow-hidden" style="min-height: 3rem">
                  {#if placeholder.textureUrl !== undefined}
                    <img
                      src={withAuthToken(placeholder.textureUrl)}
                      alt="{placeholder.label} 贴图"
                      loading="lazy"
                      decoding="async"
                      class="h-[80%] w-[80%] object-contain opacity-70"
                    />
                  {:else}
                    <span class="text-muted-foreground text-[10px]">无贴图</span>
                  {/if}
                  <span class="bg-destructive/90 text-destructive-foreground absolute top-1 left-1 rounded px-1 py-0.5 text-[10px] font-medium">
                    {SET_MEMBER_STATE_LABEL[placeholder.state]}
                  </span>
                </span>
                <span class="flex flex-col gap-0.5 px-2 py-1.5">
                  <span class="text-foreground/80 truncate font-mono text-xs">{placeholder.label}</span>
                  <span class="text-muted-foreground text-[11px]">{placeholder.quantity !== undefined ? `数量 ${placeholder.quantity}` : '按设计用量另计'}</span>
                </span>
              </div>
            {/if}
          {/each}
        </div>

        <!-- 分块渐进收口（首屏 60 +「加载更多」每块 +60） -->
        {#if visibleCount < members.length}
          <div class="mt-3 flex justify-center">
            <Button variant="outline" size="sm" onclick={() => (visibleCount += CHUNK)} data-testid="my-set-detail-load-more">
              加载更多（已显示 {visibleCount}/{members.length}）
            </Button>
          </div>
        {:else}
          <p class="text-muted-foreground mt-3 text-center text-[11px]" data-testid="my-set-detail-all-loaded">
            已全部呈现 {members.length} 项成员 · 成员快照（sets.get 读时解析）
          </p>
        {/if}
      {/if}
    </div>

    {#if summary !== null}
      <Sheet.Footer class="flex-row items-center gap-2 shrink-0 border-t px-4 py-3" data-testid="my-set-detail-footer">
        <span class="text-muted-foreground truncate font-mono text-[11px]" title={summary.resourceId}>{summary.resourceId}</span>
        <span class="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]" data-testid="my-set-detail-readscope">成员解析 · sets.get</span>
      </Sheet.Footer>
    {/if}
  </Sheet.Content>
</Sheet.Root>
