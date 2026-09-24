<!--
SetSidebar.svelte——仓储管理工作台·集合侧栏（add-stone-library S7.4，design §7.6）。
当前集合贴图墙+限定名 `<标准ID>/<SKU>`（编号冲突自动区分的落点——Owner 定调五）+
每成员数量/备注行内编辑+移除+汇总（成员数/总数量/缺失警示——五态缺失成员显式
呈现不剔除，红边徽标）+组合切换器（sets.list）+保存面（新建=manual-pick create；
改既有=update baseRevision CAS——漂移→提示刷新重载不盲写）+软删（回收站恢复
占位同 S3.3 形态：restore 无浏览器 RPC 端点，只读呈现不伪造）。
-->

<script lang="ts">
  import { withAuthToken } from '../../lib/stonesAdmin/authUrl'
  import type { StoneGridCell } from '@handicraft/contracts'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Select from '$lib/components/ui/select'
  import Package from '@lucide/svelte/icons/package'
  import RefreshCw from '@lucide/svelte/icons/refresh-cw'
  import Save from '@lucide/svelte/icons/save'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import X from '@lucide/svelte/icons/x'
  import {
    aggregateMembers,
    memberQualifiedName,
    type WarehouseMember,
  } from '$lib/warehouse/setModel'
  import {
    getWarehouseActiveSetId,
    getWarehouseDraftMembers,
    getWarehouseDraftName,
    getWarehouseDraftPurpose,
    getWarehouseCatalogCell,
    getWarehouseSetsList,
    getWarehouseSetsListState,
    isWarehouseActiveSetTrashed,
    isWarehouseDraftDirty,
    isWarehouseSaving,
    isWarehouseStaleDrift,
    reloadAfterDrift,
    removeWarehouseMember,
    saveNewWarehouseSet,
    saveWarehouseChanges,
    setWarehouseDraftName,
    setWarehouseDraftPurpose,
    setWarehouseMemberNote,
    setWarehouseMemberQuantity,
    softDeleteActiveWarehouseSet,
    switchWarehouseSet,
  } from '$lib/warehouse/store.svelte'

  const NEW_DRAFT = '__new__'

  const setsListState = $derived(getWarehouseSetsListState())
  const setsList = $derived(getWarehouseSetsList())
  const activeSetId = $derived(getWarehouseActiveSetId())
  const activeTrashed = $derived(isWarehouseActiveSetTrashed())
  const stale = $derived(isWarehouseStaleDrift())
  const saving = $derived(isWarehouseSaving())
  const dirty = $derived(isWarehouseDraftDirty())
  const draftName = $derived(getWarehouseDraftName())
  const draftPurpose = $derived(getWarehouseDraftPurpose())

  const memberRows = $derived.by(() => {
    const rows: Array<{ member: WarehouseMember; qualifiedName: string; cell: StoneGridCell | undefined }> = []
    for (const member of getWarehouseDraftMembers()) {
      const cell = getWarehouseCatalogCell(member.stoneRef)
      rows.push({ member, cell, qualifiedName: memberQualifiedName(member, cell) })
    }
    return rows
  })
  const aggregate = $derived(aggregateMembers(getWarehouseDraftMembers()))

  const MISSING_STATE_LABELS: Record<Exclude<WarehouseMember['state'], 'resolved'>, string> = {
    'soft-deleted': '已入回收站',
    'blob-missing': '贴图缺失',
    'wrong-kind': '引用类型不符',
    'not-found': '引用不存在',
  }

  const switcherValue = $derived(activeSetId ?? NEW_DRAFT)

  function onSwitch(value: string): void {
    void switchWarehouseSet(value === NEW_DRAFT ? null : value)
  }

  function onQuantity(member: WarehouseMember, raw: string): void {
    const parsed = Number.parseFloat(raw)
    setWarehouseMemberQuantity(member.stoneRef, Number.isInteger(parsed) && parsed > 0 ? parsed : null)
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="warehouse-set-sidebar">
  <!-- 组合切换器 + 名称/用途 -->
  <div class="border-b px-3 py-2" data-testid="warehouse-set-header">
    <div class="flex items-center gap-2">
      <Package class="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
      <Select.Root type="single" value={switcherValue} onValueChange={onSwitch}>
        <Select.Trigger class="h-8 min-w-0 flex-1 text-sm" data-testid="warehouse-set-switcher" aria-label="组合切换器">
          {#if setsListState === 'loading'}
            组合加载中…
          {:else if activeSetId === null}
            新建组合（人工挑拣）
          {:else}
            {draftName || activeSetId}{activeTrashed ? '（已软删）' : ''}
          {/if}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value={NEW_DRAFT} data-testid="warehouse-set-option-new">新建组合（人工挑拣）</Select.Item>
          {#each setsList as set (set.resourceId)}
            <Select.Item value={set.resourceId} data-testid="warehouse-set-option-{set.resourceId}">
              {set.name}（{set.memberCount} 成员）{set.trashed ? ' · 已软删' : ''}
            </Select.Item>
          {/each}
        </Select.Content>
      </Select.Root>
    </div>
    <div class="mt-2 flex flex-col gap-1.5">
      <Input
        class="h-8 text-sm"
        placeholder="组合名（如「卡通人物套餐-A」）"
        data-testid="warehouse-set-name"
        value={draftName}
        disabled={activeTrashed}
        oninput={(event) => setWarehouseDraftName(event.currentTarget.value)}
      />
      <Input
        class="h-8 text-xs"
        placeholder="用途（可选，如「小件卡通订单」）"
        data-testid="warehouse-set-purpose"
        value={draftPurpose}
        disabled={activeTrashed}
        oninput={(event) => setWarehouseDraftPurpose(event.currentTarget.value)}
      />
    </div>
  </div>

  {#if stale}
    <div class="border-destructive/40 bg-destructive/10 flex items-start gap-2 border-b px-3 py-2" data-testid="warehouse-drift-banner" role="alert">
      <p class="text-destructive flex-1 text-xs">
        组合已被其他端修改（revision 漂移）——本地改动未保存。刷新重载后基于最新版本再改（不盲写）。
      </p>
      <Button variant="outline" size="sm" class="h-7 shrink-0" onclick={() => void reloadAfterDrift()} data-testid="warehouse-drift-reload">
        <RefreshCw class="size-3.5" aria-hidden="true" />
        刷新重载
      </Button>
    </div>
  {/if}

  {#if activeTrashed}
    <div class="border-b px-3 py-2" data-testid="warehouse-trashed-note">
      <p class="text-muted-foreground text-xs">
        已软删组合——只读呈现。恢复待 admin API（daemon service 层 restore 未暴露浏览器 RPC，同装饰钻库回收站形态）。
      </p>
    </div>
  {/if}

  <!-- 成员贴图墙（限定名+行内编辑+移除） -->
  <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="warehouse-set-members">
    {#if memberRows.length === 0}
      <p class="text-muted-foreground py-10 text-center text-xs" data-testid="warehouse-set-empty">
        集合为空——在左侧平铺区框选/点选钻后「加入集合」
      </p>
    {:else}
      {#each memberRows as row (row.member.stoneRef)}
        <div
          class="mb-2 flex items-start gap-2 rounded-lg border p-2 {row.member.state !== 'resolved'
            ? 'border-destructive/60 bg-destructive/5'
            : 'border-border/70'}"
          data-testid="warehouse-member-{row.member.stoneRef}"
        >
          <div class="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-zinc-300 dark:bg-zinc-700">
            {#if row.member.textureUrl !== undefined || row.cell !== undefined}
              <img
                src={withAuthToken(row.member.textureUrl ?? row.cell!.textureUrl)}
                alt="{row.qualifiedName} 贴图"
                loading="lazy"
                class="max-h-12 max-w-full object-contain"
                draggable="false"
              />
            {:else}
              <span class="text-muted-foreground text-[10px]" title="缺失成员无贴图——显式态不剔除">无贴图</span>
            {/if}
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1">
              <span class="truncate font-mono text-xs font-semibold" title={row.qualifiedName}>{row.qualifiedName}</span>
              {#if row.member.state !== 'resolved'}
                <Badge variant="destructive" class="h-4 px-1 text-[9px]" data-testid="warehouse-member-missing-{row.member.stoneRef}">
                  {MISSING_STATE_LABELS[row.member.state as Exclude<WarehouseMember['state'], 'resolved'>]}
                </Badge>
              {/if}
            </div>
            {#if row.cell !== undefined && row.cell.sizeMm !== null}
              <span class="text-muted-foreground text-[10px]">{row.cell.sizeMm}mm · {row.cell.name}</span>
            {:else if row.cell !== undefined}
              <span class="text-muted-foreground text-[10px]">{row.cell.name} · 未声明尺寸</span>
            {/if}
            <div class="mt-1 flex items-center gap-1">
              <Input
                class="h-6 w-16 px-1 text-xs"
                type="number"
                min="1"
                step="1"
                placeholder="数量"
                title="备料数量（空=按设计用量另计）"
                data-testid="warehouse-member-qty-{row.member.stoneRef}"
                value={row.member.quantity ?? ''}
                disabled={activeTrashed}
                oninput={(event) => onQuantity(row.member, event.currentTarget.value)}
              />
              <Input
                class="h-6 min-w-0 flex-1 px-1 text-xs"
                placeholder="备注"
                data-testid="warehouse-member-note-{row.member.stoneRef}"
                value={row.member.note ?? ''}
                disabled={activeTrashed}
                oninput={(event) => setWarehouseMemberNote(row.member.stoneRef, event.currentTarget.value)}
              />
            </div>
          </div>
          <button
            type="button"
            class="text-muted-foreground hover:text-destructive rounded p-0.5"
            title="移出集合"
            aria-label="移出集合 {row.qualifiedName}"
            data-testid="warehouse-member-remove-{row.member.stoneRef}"
            disabled={activeTrashed}
            onclick={() => removeWarehouseMember(row.member.stoneRef)}
          >
            <X class="size-3.5" />
          </button>
        </div>
      {/each}
    {/if}
  </div>

  <!-- 汇总（成员数/总数量/缺失警示） -->
  <div class="border-t px-3 py-2 text-xs" data-testid="warehouse-set-summary">
    <span class="text-muted-foreground">
      成员 {aggregate.memberCount} · 总数量 {aggregate.totalQuantity}
      {#if aggregate.undeclaredQuantityCount > 0}
        （{aggregate.undeclaredQuantityCount} 项按设计用量另计）
      {/if}
    </span>
    {#if aggregate.missingCount > 0}
      <p class="text-destructive mt-0.5" data-testid="warehouse-set-missing-warning" role="status">
        缺失 {aggregate.missingCount} 个成员引用（显式呈现不剔除——§7.1 引用保护）
      </p>
    {/if}
  </div>

  <!-- 保存面 -->
  <div class="flex items-center gap-2 border-t px-3 py-2" data-testid="warehouse-set-actions">
    {#if activeSetId === null}
      <Button size="sm" class="h-8 flex-1" disabled={!dirty || saving} onclick={() => void saveNewWarehouseSet()} data-testid="warehouse-save-new">
        <Save class="size-3.5" aria-hidden="true" />
        {saving ? '保存中…' : '存为组合'}
      </Button>
    {:else}
      <Button size="sm" class="h-8 flex-1" disabled={!dirty || saving || stale || activeTrashed} onclick={() => void saveWarehouseChanges()} data-testid="warehouse-save-changes">
        <Save class="size-3.5" aria-hidden="true" />
        {saving ? '保存中…' : '保存修改'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="h-8"
        disabled={saving || activeTrashed}
        title="软删组合（回收站语义——成员弱引用零变更）"
        data-testid="warehouse-delete-set"
        onclick={() => void softDeleteActiveWarehouseSet()}
      >
        <Trash2 class="size-3.5" aria-hidden="true" />
      </Button>
    {/if}
  </div>
</div>
