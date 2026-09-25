<!--
StrategyParamsForm.svelte — 图层级策略/参数表单（add-subject-sam-pipeline P3.2）。
schema 驱动通用渲染器：strategyDesigner/paramsSchema 的七族字段描述（daemon
registry paramsSchema 的 UI 投影）→ 控件映射（number→数字界输入/select→下拉/
text→文本/derived→只读）；判别键（mode/shape）切换变体字段集。
编辑回写=「生成调整指令」注入对话输入框（人调参数→Agent 重新提案→批准——
不旁路直写，两层编辑铁律）。free-code 层=codeArtifact 链接+源码只读预览。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { showToast } from '$lib/stores/toast.svelte'
  import {
    STRATEGY_FORM_SPECS,
    discriminantValueOf,
    fieldsFor,
  } from '$lib/strategyDesigner/paramsSchema'
  import {
    getAssignmentOf,
    getNodeOf,
    getSelectedNodeId,
    getStrategyArtifacts,
    queueNodeAdjustInstruction,
  } from '$lib/strategyDesigner/store.svelte'
  import Code2 from '@lucide/svelte/icons/code-2'
  import MessageSquareQuote from '@lucide/svelte/icons/message-square-quote'

  const selectedId = $derived(getSelectedNodeId())
  const node = $derived(selectedId === null ? null : getNodeOf(selectedId))
  const assignment = $derived(selectedId === null ? null : getAssignmentOf(selectedId))
  const artifacts = $derived(getStrategyArtifacts())
  const spec = $derived(assignment === null ? null : STRATEGY_FORM_SPECS[assignment.strategyKind])
  const codeArtifact = $derived(
    assignment !== null && assignment.codeArtifactRef !== undefined
      ? artifacts?.codeArtifacts[assignment.codeArtifactRef] ?? null
      : null,
  )

  /** 表单草稿（输入框字符串态——数字在指令时按字段控制类型回转）。 */
  let draft = $state<Record<string, string>>({})
  let densityText = $state('')

  $effect(() => {
    // 选中层变化 → 草稿重置为当前指派真值（放弃未注入的本地编辑）。
    const current = assignment
    const next: Record<string, string> = {}
    if (current !== null) {
      for (const [key, value] of Object.entries(current.params)) {
        next[key] = value === undefined || value === null ? '' : String(value)
      }
    }
    draft = next
    densityText = current === null ? '' : String(current.densityPerCm2)
  })

  const fields = $derived(assignment === null ? [] : fieldsFor(assignment.strategyKind, draft))

  function setField(key: string, value: string): void {
    draft = { ...draft, [key]: value }
  }

  /**
   * 指令载荷：数字字段回转 number；空串字段省略（缺省语义交 daemon 推导）。
   * 判别键显式携带（用户所选变体）——否则指令侧回缺省变体，错报用户选择。
   */
  function paramsForInstruction(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of fields) {
      const raw = draft[field.key] ?? ''
      if (raw === '') continue
      out[field.key] = field.control === 'number' && Number.isFinite(Number(raw)) ? Number(raw) : raw
    }
    if (spec?.discriminant !== undefined) {
      out[spec.discriminant.key] = draft[spec.discriminant.key] ?? discriminantValueOf(spec, draft)
    }
    return out
  }

  function onCompose(): void {
    if (assignment === null || node === null) return
    const density = Number(densityText)
    const ok = queueNodeAdjustInstruction(node.id, paramsForInstruction(), Number.isFinite(density) && density > 0 ? density : assignment.densityPerCm2)
    showToast(
      ok
        ? '调整指令已注入左侧对话输入框——发送后 Agent 将按新参数重新提案，等待你批准'
        : '当前图层无策略指派，无法生成调整指令',
    )
  }
</script>

<div class="flex h-full min-h-0 flex-col" data-testid="strategy-params-form">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">图层策略与参数</span>
    <span class="text-muted-foreground ml-auto text-[10px]">图层级 · 禁单钻编辑</span>
  </div>

  <div class="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
    {#if assignment === null || node === null || spec === null}
      <p class="text-muted-foreground px-1 py-6 text-center text-xs" data-testid="strategy-params-empty">
        {selectedId === null
          ? '在图层树选择一个图层查看/调整策略（图层级参数）'
          : selectedId !== null && node !== null && node.children.length > 0
            ? '层级节点不承载策略指派——展开选择其产块子层'
            : '该图层暂无指派——待 strategy.design 提案'}
      </p>
    {:else if assignment.strategyKind === 'free-code'}
      <!-- free-code：codeArtifact 链接 + 源码只读预览（参数经工件，无表单面） -->
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <Badge variant="secondary">{spec.label}</Badge>
          <span class="text-muted-foreground truncate font-mono text-[10px]" title={assignment.codeArtifactRef ?? ''} data-testid="strategy-params-code-ref">
            codeArtifact {assignment.codeArtifactRef?.slice(0, 10) ?? '—'}…
          </span>
        </div>
        <p class="text-muted-foreground text-[11px] leading-relaxed">{spec.note}</p>
        <p class="text-xs leading-relaxed" data-testid="strategy-params-rationale">{assignment.rationale}</p>
        {#if codeArtifact !== null}
          <div class="space-y-1">
            <div class="text-muted-foreground flex flex-wrap items-center gap-1 font-mono text-[10px]" data-testid="strategy-params-code-meta">
              <Code2 class="size-3" aria-hidden="true" />
              <span>entryPoint={codeArtifact.entryPoint}</span>
              <span>· seed={codeArtifact.seed}</span>
              <span>· API: {codeArtifact.declaredApiCalls.join(', ')}</span>
            </div>
            <pre
              class="bg-muted overflow-x-auto rounded-lg border p-2 font-mono text-[10px] leading-relaxed"
              data-testid="strategy-params-code-source"
            >{codeArtifact.source}</pre>
          </div>
        {:else}
          <p class="text-muted-foreground text-[11px]" data-testid="strategy-params-code-missing">源码工件未装载（内容通道待接线）——引用见上方 codeArtifact</p>
        {/if}
      </div>
    {:else}
      <!-- 参数化族：schema 驱动表单 -->
      <div class="space-y-2">
        <div class="flex items-center gap-2">
          <Badge variant={assignment.strategyKind === 'exclusion' ? 'destructive' : 'secondary'} data-testid="strategy-params-kind">{spec.label}</Badge>
          <span class="truncate text-sm font-medium">{node.objectName}</span>
        </div>
        <p class="text-muted-foreground text-[11px] leading-relaxed">{spec.note}</p>

        {#if spec.discriminant !== undefined}
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs">{spec.discriminant.label}</span>
            <select
              class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs"
              value={draft[spec.discriminant.key] ?? discriminantValueOf(spec, draft)}
              onchange={(event) => setField(spec.discriminant!.key, event.currentTarget.value)}
              data-testid="strategy-params-discriminant"
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
              {#if field.derived}<span class="opacity-60">（daemon 派生·只读）</span>{/if}
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
                data-testid="strategy-params-field-{field.key}"
              />
            {:else if field.control === 'select'}
              <select
                value={draft[field.key] ?? ''}
                disabled={field.derived}
                onchange={(event) => setField(field.key, event.currentTarget.value)}
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
                data-testid="strategy-params-field-{field.key}"
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
                class="border-input bg-background w-full rounded-md border px-2 py-1.5 text-xs disabled:opacity-60"
                data-testid="strategy-params-field-{field.key}"
              />
            {/if}
            {#if field.help}
              <span class="text-muted-foreground/80 block text-[10px]">{field.help}</span>
            {/if}
          </label>
        {/each}

        {#if assignment.strategyKind !== 'exclusion'}
          <label class="block space-y-1">
            <span class="text-muted-foreground text-xs">密度（颗/cm²）</span>
            <input
              type="number"
              min="0.1"
              step="0.1"
              bind:value={densityText}
              class="border-input bg-background w-full rounded-md border px-2 py-1.5 font-mono text-xs"
              data-testid="strategy-params-field-density"
            />
          </label>
        {/if}

        {#if assignment.stones.length > 0}
          <div class="space-y-1">
            <span class="text-muted-foreground text-xs">用钻（指派 StonePick）</span>
            <div class="flex flex-wrap gap-1.5" data-testid="strategy-params-stones">
              {#each assignment.stones as stone (stone.resourceId)}
                <span class="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]" title="{stone.supplier} · {stone.resourceId}">
                  <span class="size-2 rounded-full border border-black/10" style="background: {stone.colorHex}" aria-hidden="true"></span>
                  {stone.sku}{stone.sizeMm !== null ? ` · ${stone.sizeMm}mm` : ''}
                </span>
              {/each}
            </div>
          </div>
        {/if}

        <div class="space-y-1">
          <span class="text-muted-foreground text-xs">指派理由（LLM proposal）</span>
          <p class="bg-muted/60 rounded-md px-2 py-1.5 text-[11px] leading-relaxed" data-testid="strategy-params-rationale">{assignment.rationale}</p>
        </div>

        <Button size="sm" class="w-full" onclick={onCompose} data-testid="strategy-params-compose">
          <MessageSquareQuote class="size-3.5" aria-hidden="true" />
          生成调整指令（注入对话）
        </Button>
        <p class="text-muted-foreground/80 text-center text-[10px]">
          表单不直写——指令经 Agent 对话重新提案（strategy.design）后批准生效
        </p>
      </div>
    {/if}
  </div>
</div>
