<!--
WorkbenchParamsPanel.svelte — 策略卡（add-task-detail-layer-workbench 2.4——D-1 直接生效）。
StrategyParamsForm 复用改造：schema 驱动表单同式（paramsSchema 七族投影），
但编辑回写**不注入对话**——「应用」按钮直调 layer.strategy.set RPC，单节点指派
替换→execute 真身重算→点阵/预览即刻刷新（人类主权面直改；Agent 对话场景的
提案→批准铁律只属于会话面，两场景独立入口）。策略族可切换（kind select）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import type { KernelStrategyKind } from '@handicraft/contracts'
  import {
    STRATEGY_FORM_SPECS,
    discriminantValueOf,
    fieldsFor,
  } from '$lib/strategyDesigner/paramsSchema'
  import {
    applyLayerStrategy,
    getApplyError,
    getAssignmentOf,
    getNodeOf,
    getSelectedNodeId,
    isApplying,
  } from './store.svelte'
  import Zap from '@lucide/svelte/icons/zap'

  const KIND_OPTIONS = Object.values(STRATEGY_FORM_SPECS).map((spec) => ({
    value: spec.kind,
    label: spec.label,
  }))

  const selectedId = $derived(getSelectedNodeId())
  const node = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const assignment = $derived(selectedId === null ? null : getAssignmentOf(selectedId))
  const applying = $derived(isApplying())
  const applyError = $derived(getApplyError())

  /** 当前编辑的策略族（选中层变化→回指派真值；手动切换→新族草稿从空起）。 */
  let kindDraft = $state<KernelStrategyKind | null>(null)

  $effect(() => {
    const current = assignment
    kindDraft = current === null ? null : current.strategyKind
  })

  const spec = $derived(kindDraft === null ? null : STRATEGY_FORM_SPECS[kindDraft])

  /** 表单草稿（输入框字符串态——应用时按字段控制类型回转）。 */
  let draft = $state<Record<string, string>>({})
  let densityText = $state('')

  $effect(() => {
    // 选中层/策略族变化 → 草稿重置为该族当前值（新族=空——缺省交服务端推导）。
    const current = assignment
    const next: Record<string, string> = {}
    if (current !== null && kindDraft === current.strategyKind) {
      for (const [key, value] of Object.entries(current.params)) {
        next[key] = value === undefined || value === null ? '' : String(value)
      }
    }
    draft = next
    densityText =
      current !== null && kindDraft === current.strategyKind ? String(current.densityPerCm2) : ''
  })

  const fields = $derived(kindDraft === null ? [] : fieldsFor(kindDraft, draft))

  function setField(key: string, value: string): void {
    draft = { ...draft, [key]: value }
  }

  /** 应用载荷：数字字段回转 number；空串省略（缺省语义交 daemon 推导）；判别键显式携带。 */
  function paramsForApply(): Record<string, unknown> {
    if (kindDraft === null || spec === null) return {}
    const out: Record<string, unknown> = {}
    for (const field of fields) {
      const raw = draft[field.key] ?? ''
      if (raw === '') continue
      out[field.key] = field.control === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw
    }
    if (spec.discriminant !== undefined) {
      out[spec.discriminant.key] = draft[spec.discriminant.key] ?? discriminantValueOf(spec, draft)
    }
    return out
  }

  async function onApply(): Promise<void> {
    if (selectedId === null || kindDraft === null) return
    const density = Number(densityText)
    await applyLayerStrategy(
      selectedId,
      kindDraft,
      paramsForApply(),
      Number.isFinite(density) && density > 0 ? density : undefined,
    )
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="workbench-params-panel">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">图层策略</span>
    <span class="text-muted-foreground ml-auto text-[10px]">应用=直接重算（不注入对话）</span>
  </div>

  <div class="scrollbar-thin min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
    {#if assignment === null && node === null}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs" data-testid="workbench-params-empty">
        在图层管理选择一个图层查看/调整策略
      </p>
    {:else if node !== null && node.children.length > 0}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs" data-testid="workbench-params-hierarchy">
        层级节点不承载策略指派——选择其子层，或先拆分出更细的层
      </p>
    {:else if node === null}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs" data-testid="workbench-params-empty">
        该图层已不在树中（可能已被拆分替换）——重新选择
      </p>
    {:else if kindDraft === null}
      <!-- 未指派层：选族起排（strategy.set 支持新指派） -->
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <Badge variant="outline">未指派</Badge>
          <span class="truncate text-sm font-medium">{node.objectName}</span>
        </div>
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs">选择策略族</span>
          <select
            class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
            value=""
            onchange={(event) => {
              const next = event.currentTarget.value as KernelStrategyKind
              if (next in STRATEGY_FORM_SPECS) kindDraft = next
            }}
            data-testid="workbench-kind-select"
          >
            <option value="" disabled>选择策略族…</option>
            {#each KIND_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>
      </div>
    {:else if spec === null}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs">未知策略族</p>
    {:else if kindDraft === 'free-code'}
      <!-- free-code：参数经代码工件（沙箱执行）——工作台直改面不承载源码编辑 -->
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <Badge variant="secondary">{spec.label}</Badge>
          <span class="truncate text-sm font-medium">{node.objectName}</span>
        </div>
        <p class="text-muted-foreground text-[11px] leading-relaxed">
          自由代码层的参数经代码工件承载——请在 Agent 会话中调整后重新提案；工作台直改面不提供源码编辑。
        </p>
      </div>
    {:else}
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <Badge variant={kindDraft === 'exclusion' ? 'destructive' : 'secondary'} data-testid="workbench-params-kind">{spec.label}</Badge>
          <span class="truncate text-sm font-medium">{node.objectName}</span>
        </div>
        <p class="text-muted-foreground text-[11px] leading-relaxed">{spec.note}</p>

        <!-- 策略族切换（直改面主权：换族=整组参数按新族缺省重建） -->
        <label class="block space-y-1">
          <span class="text-muted-foreground text-xs">策略族</span>
          <select
            class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
            value={kindDraft}
            onchange={(event) => {
              const next = event.currentTarget.value as KernelStrategyKind
              if (next in STRATEGY_FORM_SPECS) kindDraft = next
            }}
            data-testid="workbench-kind-select"
          >
            {#each KIND_OPTIONS as option (option.value)}
              <option value={option.value}>{option.label}</option>
            {/each}
          </select>
        </label>

        {#if spec.discriminant !== undefined}
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs">{spec.discriminant.label}</span>
            <select
              class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
              value={draft[spec.discriminant.key] ?? discriminantValueOf(spec, draft)}
              onchange={(event) => setField(spec.discriminant!.key, event.currentTarget.value)}
              data-testid="workbench-params-discriminant"
            >
              {#each spec.discriminant.options as option (option.value)}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </label>
        {/if}

        {#each fields as field (field.key)}
          <label class="block space-y-1">
            <span class="text-muted-foreground flex items-center gap-1 text-xs">
              {field.label}
              {#if field.optional}<span class="opacity-60">（可空）</span>{/if}
              {#if field.derived}<span class="opacity-60">（服务端派生·只读）</span>{/if}
            </span>
            {#if field.control === 'number'}
              <input
                type="number"
                value={draft[field.key] ?? ''}
                min={field.min}
                max={field.max}
                step={field.step}
                disabled={field.derived}
                oninput={(event) => setField(field.key, event.currentTarget.value)}
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs disabled:opacity-60"
                data-testid="workbench-params-field-{field.key}"
              />
            {:else if field.control === 'select'}
              <select
                value={draft[field.key] ?? ''}
                disabled={field.derived}
                onchange={(event) => setField(field.key, event.currentTarget.value)}
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
                data-testid="workbench-params-field-{field.key}"
              >
                {#each field.options ?? [] as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            {:else}
              <input
                type="text"
                value={draft[field.key] ?? ''}
                disabled={field.derived}
                oninput={(event) => setField(field.key, event.currentTarget.value)}
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs disabled:opacity-60"
                data-testid="workbench-params-field-{field.key}"
              />
            {/if}
            {#if field.help}
              <span class="text-muted-foreground/80 block text-[10px]">{field.help}</span>
            {/if}
          </label>
        {/each}

        {#if kindDraft !== 'exclusion'}
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs">密度（颗/cm²）</span>
            <input
              type="number"
              min="0.1"
              step="0.1"
              bind:value={densityText}
              class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs"
              data-testid="workbench-params-field-density"
            />
          </label>
        {/if}

        {#if assignment !== null && assignment.stones.length > 0}
          <div class="space-y-1">
            <span class="text-muted-foreground text-xs">用钻（沿用当前指派——候选表锚定）</span>
            <div class="flex flex-wrap gap-1.5" data-testid="workbench-params-stones">
              {#each assignment.stones as stone (stone.resourceId)}
                <span class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]" title="{stone.supplier} · {stone.resourceId}">
                  <span class="size-2 rounded-full border border-black/10" style="background: {stone.colorHex}" aria-hidden="true"></span>
                  {stone.sku}{stone.sizeMm !== null ? ` · ${stone.sizeMm}mm` : ''}
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <Button size="sm" class="w-full" disabled={applying} onclick={() => void onApply()} data-testid="workbench-apply-strategy">
          <Zap class="size-3.5" aria-hidden="true" />
          {applying ? '重算中…' : '应用（直接生效）'}
        </Button>
        {#if applyError !== null}
          <p class="text-destructive text-[11px] leading-relaxed" data-testid="workbench-apply-error" role="alert">
            应用失败：{applyError}
          </p>
        {/if}
        <p class="text-muted-foreground/80 text-center text-[10px]">
          应用后立即按新参数重算该层点阵并刷新全图预览（D-1 人类主权面直改——不经对话提案）
        </p>
      </div>
    {/if}
  </div>
</div>
