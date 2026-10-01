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
  [product-polish-w1 T4] 编辑态（本人组合）：头部「编辑」进入——成员行内改数量/
  移除+搜索添加成员（SetStoneSearchPicker 共用件——CreateSetDialog 同形态）；
  保存=sets.update（SetPatch 增删/数量 diff+CAS baseRevision）；revision-conflict
  typed 呈现。市场模式（market=true，普通用户看 admin 组合）：只读快照+「复制到
  我的材料」CTA（T1 白名单复制——副本可编辑）。
-->

<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { withAuthToken } from '$lib/stonesAdmin/authUrl'
  import { memberCellOf, memberPlaceholderOf, SET_MEMBER_STATE_LABEL } from '$lib/stonesAdmin/setMembers'
  import SetStoneSearchPicker from '../stones-admin/SetStoneSearchPicker.svelte'
  import {
    copyMarketSetToMy,
    getMarketSetsError,
    getMySetDetail,
    isMarketSetCopying,
    updateMySet,
  } from '$lib/myMaterials/sets.svelte'
  import { showToast } from '$lib/stores/toast.svelte'
  import type { StoneGridCell } from '@handicraft/contracts'
  import type { SetsCreateResult } from '$lib/warehouse/client'
  import type { SetSummary, SetsGetOutput, SetsUpdateOutput } from '$lib/warehouse/schemas'
  import X from '@lucide/svelte/icons/x'

  /** 渐进渲染块大小（首屏 60——848 成员量级严禁一次全渲染）。 */
  const CHUNK = 60

  let {
    summary,
    open = true,
    onclose,
    market = false,
    oncopied = null,
    onsaved = null,
  }: {
    /** 目标组合（null=关闭——头部字段 get 前即可呈现）。 */
    summary: SetSummary | null
    /** 受控开合（父级先收动画再卸载——bits-ui 关闭过渡帧不能读已销毁引用）。 */
    open?: boolean
    onclose: () => void
    /** 市场模式（T4：普通用户看 admin 组合——只读快照+复制 CTA；编辑位退场）。 */
    market?: boolean
    /** 市场复制成功回调（MySetsSection 切到副本详情/刷新）。 */
    oncopied?: ((created: SetsCreateResult) => void) | null
    /** 编辑保存成功回调（MySetsSection 刷新清单）。 */
    onsaved?: ((result: SetsUpdateOutput) => void) | null
  } = $props()

  type DetailState = 'idle' | 'loading' | 'ready' | 'error'

  let detail = $state<SetsGetOutput | null>(null)
  let detailState = $state<DetailState>('idle')
  let errorMessage = $state('')
  let visibleCount = $state(CHUNK)
  /** 装载令牌（切换目标/重试时弃旧响应——竞态守卫）。 */
  let loadToken = 0

  // ------------------------------------------------------------ 编辑态（T4）

  /** 编辑草稿成员（快照自 detail.members；quantity 0=按设计用量另计）。 */
  interface DraftMember {
    stoneRef: string
    quantity: number
    /** 展示标签（qualifiedSku / cell sku·supplier / 短 ref）。 */
    label: string
    /** 本次编辑新增（未保存——「新」徽标）。 */
    isNew: boolean
  }

  let editing = $state(false)
  let draftMembers = $state<DraftMember[]>([])
  let saving = $state(false)
  let saveError = $state<string | null>(null)
  /** 市场复制错误（copyMarketSetToMy 失败——store 错误面读回）。 */
  let copyError = $state<string | null>(null)

  const members = $derived(detail?.members ?? [])
  const visibleMembers = $derived(members.slice(0, visibleCount))
  const visibleDraftMembers = $derived(draftMembers.slice(0, visibleCount))

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

  /** 目标变化（打开/切换）→ 拉成员快照；关闭即复位（编辑态一并清场）。 */
  $effect(() => {
    const resourceId = summary?.resourceId
    detail = null
    errorMessage = ''
    visibleCount = CHUNK
    editing = false
    draftMembers = []
    saveError = null
    copyError = null
    if (resourceId === undefined) {
      detailState = 'idle'
      return
    }
    void load(resourceId)
  })

  // ------------------------------------------------------------ 编辑操作（T4）

  function enterEdit(): void {
    if (detail === null) return
    draftMembers = detail.members.map((member) => ({
      stoneRef: member.stoneRef,
      quantity: member.quantity ?? 0,
      label: memberCellOf(member) !== null
        ? `${memberCellOf(member)!.sku} · ${memberCellOf(member)!.supplier}`
        : (member.qualifiedSku ?? member.stoneRef),
      isNew: false,
    }))
    saveError = null
    visibleCount = Math.max(CHUNK, draftMembers.length)
    editing = true
  }

  function cancelEdit(): void {
    editing = false
    draftMembers = []
    saveError = null
    visibleCount = CHUNK
  }

  /** 搜索挑选共用件 toggle 回调（CreateSetDialog 同语义：在选=移除/未选=追加）。 */
  function toggleDraftMember(cell: StoneGridCell): void {
    if (draftMembers.some((draft) => draft.stoneRef === cell.resourceId)) {
      draftMembers = draftMembers.filter((draft) => draft.stoneRef !== cell.resourceId)
      return
    }
    draftMembers = [
      ...draftMembers,
      { stoneRef: cell.resourceId, quantity: 0, label: `${cell.sku} · ${cell.supplier}`, isNew: true },
    ]
    visibleCount = Math.max(visibleCount, draftMembers.length)
  }

  function setDraftQuantity(stoneRef: string, raw: string): void {
    const parsed = Number.parseFloat(raw)
    const value = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0
    draftMembers = draftMembers.map((draft) => (draft.stoneRef === stoneRef ? { ...draft, quantity: value } : draft))
  }

  function removeDraftMember(stoneRef: string): void {
    draftMembers = draftMembers.filter((draft) => draft.stoneRef !== stoneRef)
  }

  /** 保存=SetPatch diff（增删/数量——CAS baseRevision=当前 revision）。 */
  async function save(): Promise<void> {
    if (detail === null || saving) return
    if (draftMembers.length === 0) {
      saveError = '成员清单不可清空（删空组合请走「删除」）'
      return
    }
    const currentQuantity = new Map(detail.set.stones.map((member) => [member.stoneRef, member.quantity ?? 0]))
    const draftIds = new Set(draftMembers.map((draft) => draft.stoneRef))
    const removeMembers = [...currentQuantity.keys()].filter((ref) => !draftIds.has(ref))
    const addMembers = draftMembers
      .filter((draft) => !currentQuantity.has(draft.stoneRef))
      .map((draft) => ({ stoneRef: draft.stoneRef, ...(draft.quantity > 0 ? { quantity: draft.quantity } : {}) }))
    const updateMembers = draftMembers
      .filter((draft) => currentQuantity.has(draft.stoneRef) && currentQuantity.get(draft.stoneRef) !== draft.quantity)
      .map((draft) => ({ stoneRef: draft.stoneRef, quantity: draft.quantity > 0 ? draft.quantity : null }))
    if (removeMembers.length === 0 && addMembers.length === 0 && updateMembers.length === 0) {
      editing = false // 无变更=直接收起（不发生空 CAS 写）
      return
    }
    saving = true
    saveError = null
    try {
      const result = await updateMySet({
        resourceId: detail.resourceId,
        baseRevision: detail.revision,
        patch: {
          ...(removeMembers.length > 0 ? { removeMembers } : {}),
          ...(addMembers.length > 0 ? { addMembers } : {}),
          ...(updateMembers.length > 0 ? { updateMembers } : {}),
        },
      })
      editing = false
      showToast(`组合已保存（revision ${result.revision}）`)
      onsaved?.(result)
      await load(detail.resourceId)
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error)
    } finally {
      saving = false
    }
  }

  /** 市场组合→我的材料（T1 复制语义——副本 origin 溯源+成员快照）。 */
  async function copyToMy(): Promise<void> {
    if (summary === null || isMarketSetCopying()) return
    copyError = null
    const created = await copyMarketSetToMy(summary.resourceId)
    if (created === null) {
      copyError = getMarketSetsError() ?? '复制失败（稍后重试）'
      return
    }
    showToast(`已复制「${summary.name}」到我的材料`)
    oncopied?.(created)
  }
</script>

<Sheet.Root {open} onOpenChange={(next) => { if (!next) onclose() }}>
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

    <!-- 头部：名称 + 成员数徽标 + 编辑/关闭（summary 直供——get 前不空闪） -->
    <Sheet.Header class="flex-row items-center gap-2 shrink-0 border-b px-4 pt-2 pb-3">
      <Sheet.Title class="min-w-0 flex-1 truncate text-sm font-medium" data-testid="my-set-detail-title">
        {summary?.name ?? '组合详情'}
      </Sheet.Title>
      {#if summary !== null}
        <Badge variant="secondary" class="shrink-0 text-xs" data-testid="my-set-detail-count">{summary.memberCount} 款钻</Badge>
      {/if}
      {#if market}
        <Badge class="bg-primary/10 text-primary shrink-0 text-[10px]" data-testid="my-set-detail-market-badge">市场</Badge>
      {/if}
      {#if summary !== null && !market && !editing && (detailState === 'ready' || detailState === 'error')}
        <Button variant="outline" size="sm" class="shrink-0" onclick={enterEdit} data-testid="my-set-detail-edit">
          编辑
        </Button>
      {/if}
      {#if editing}
        <Button variant="ghost" size="sm" class="shrink-0" onclick={cancelEdit} data-testid="my-set-detail-edit-cancel">
          取消编辑
        </Button>
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
        <span class="ml-auto shrink-0 font-mono">r{editing ? (detail?.revision ?? summary.revision) : summary.revision}</span>
      </div>
    {/if}

    {#if market}
      <!-- 市场模式提示（T4：只读快照——复制到我的材料后可编辑）。 -->
      <div class="bg-primary/5 text-primary flex shrink-0 items-center gap-1.5 border-b px-4 py-2 text-xs" data-testid="my-set-detail-market-hint-row">
        <span data-testid="my-set-detail-market-hint">市场组合为只读快照——复制到我的材料后可编辑</span>
      </div>
    {/if}

    <!-- 滚动成员区（固定头/脚分界——末行不贴底缘切断） -->
    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4 pb-8">
      {#if editing}
        <!-- ============================================================ 编辑态（T4） -->
        <div class="space-y-4" data-testid="my-set-detail-edit-panel">
          <!-- 搜索添加成员（共用件——CreateSetDialog 同形态） -->
          <SetStoneSearchPicker
            testidPrefix="set-edit"
            pickedResourceIds={draftMembers.map((draft) => draft.stoneRef)}
            ontoggle={toggleDraftMember}
          />

          <!-- 成员草稿行（行内改数量/移除；新增「新」徽标） -->
          <div class="space-y-2">
            <p class="text-muted-foreground text-xs">
              成员（{draftMembers.length}）——数量 0 = 按设计用量另计；保存按 diff 提交（revision CAS）
            </p>
            {#if draftMembers.length === 0}
              <p class="text-destructive rounded-md border border-destructive/30 px-3 py-3 text-center text-xs" data-testid="my-set-detail-edit-empty">
                成员清单不可清空（删空组合请走「删除」）
              </p>
            {:else}
              <ul class="space-y-1.5" data-testid="my-set-detail-edit-list">
                {#each visibleDraftMembers as draft (draft.stoneRef)}
                  <li class="border-border/70 flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs" data-testid="my-set-detail-edit-row-{draft.stoneRef}">
                    <span class="min-w-0 flex-1 truncate font-mono">{draft.label}</span>
                    {#if draft.isNew}
                      <span class="bg-primary/10 text-primary shrink-0 rounded px-1 text-[9px]" data-testid="my-set-detail-edit-new-{draft.stoneRef}">新</span>
                    {/if}
                    <label class="flex shrink-0 items-center gap-1">
                      <span class="text-muted-foreground">数量</span>
                      <Input
                        class="h-7 w-16 text-right font-mono"
                        type="number"
                        min="0"
                        step="1"
                        value={draft.quantity}
                        data-testid="my-set-detail-edit-qty-{draft.stoneRef}"
                        oninput={(event) => setDraftQuantity(draft.stoneRef, event.currentTarget.value)}
                      />
                    </label>
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-destructive shrink-0"
                      onclick={() => removeDraftMember(draft.stoneRef)}
                      data-testid="my-set-detail-edit-remove-{draft.stoneRef}"
                      aria-label="移除成员 {draft.label}"
                    >
                      <X class="size-3.5" aria-hidden="true" />
                    </button>
                  </li>
                {/each}
              </ul>
              {#if visibleCount < draftMembers.length}
                <div class="flex justify-center">
                  <Button variant="outline" size="sm" onclick={() => (visibleCount += CHUNK)} data-testid="my-set-detail-edit-load-more">
                    加载更多（已显示 {visibleCount}/{draftMembers.length}）
                  </Button>
                </div>
              {/if}
            {/if}
          </div>

          {#if saveError !== null}
            <p class="border-destructive/30 bg-destructive/10 text-destructive rounded-md p-2 text-xs leading-relaxed" data-testid="my-set-detail-edit-error" role="alert">
              {saveError}{saveError.includes('revision') ? '（清单已被他处更新——关闭重开后再编辑）' : ''}
            </p>
          {/if}
        </div>
      {:else if detailState === 'idle' || detailState === 'loading'}
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
                  <span class="text-muted-foreground text-[11px]">{member.quantity !== undefined ? `数量 ${member.quantity}` : '按设计用量另计'}</span>
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
        {#if editing}
          <span class="text-muted-foreground truncate text-[11px]">保存按 diff 提交（sets.update · revision CAS）</span>
          <Button size="sm" variant="outline" class="ml-auto shrink-0" disabled={saving} onclick={cancelEdit} data-testid="my-set-detail-edit-footer-cancel">
            取消
          </Button>
          <Button size="sm" class="shrink-0" disabled={saving || draftMembers.length === 0} onclick={() => void save()} data-testid="my-set-detail-save">
            {saving ? '保存中…' : '保存修改'}
          </Button>
        {:else if market}
          {#if copyError !== null}
            <span class="text-destructive min-w-0 flex-1 truncate text-[11px]" role="alert" data-testid="my-set-detail-copy-error">{copyError}</span>
          {:else}
            <span class="text-muted-foreground truncate font-mono text-[11px]" title={summary.resourceId}>{summary.resourceId}</span>
          {/if}
          <Button size="sm" class="ml-auto shrink-0" disabled={isMarketSetCopying()} onclick={() => void copyToMy()} data-testid="my-set-detail-copy">
            {isMarketSetCopying() ? '复制中…' : '复制到我的材料'}
          </Button>
        {:else}
          <span class="text-muted-foreground truncate font-mono text-[11px]" title={summary.resourceId}>{summary.resourceId}</span>
          <span class="text-muted-foreground ml-auto shrink-0 font-mono text-[11px]" data-testid="my-set-detail-readscope">成员解析 · sets.get</span>
        {/if}
      </Sheet.Footer>
    {/if}
  </Sheet.Content>
</Sheet.Root>
