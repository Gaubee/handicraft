<!--
ImportReportView.svelte——样卡导入报告四清单（add-stone-library S3.3，S2.5 冻结视图）。
成功/跳过/失败/pendingDowngrades（§8.1 规则 3 跨格同字节降级）+ 低置信清单
（proposal 预览的人工把关点）+ 汇总条。消费 daemon CardImportReport 的 UI 子集
（WizardImportReport 校验后注入——未来 stones.import RPC 端点的落点缝）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { reportListsOf, type ImportReportLists, type WizardImportReport } from '$lib/stonesAdmin/wizard.svelte'

  let { report }: { report: WizardImportReport } = $props()

  const lists: ImportReportLists = $derived(reportListsOf(report))

  const sections = $derived(
    [
      { key: 'created', label: '成功', tone: 'text-emerald-600 dark:text-emerald-400', items: lists.created.map((item) => ({ sku: item.sku, note: item.finalSku !== item.sku ? `→ ${item.finalSku}` : `行 ${item.row}` })) },
      { key: 'skipped', label: '跳过', tone: 'text-muted-foreground', items: lists.skipped.map((item) => ({ sku: item.sku, note: item.reason ?? '' })) },
      { key: 'failed', label: '失败', tone: 'text-destructive', items: lists.failed.map((item) => ({ sku: item.sku, note: item.reason ?? '' })) },
      { key: 'pendingDowngrades', label: '待渲染（pendingDowngrades）', tone: 'text-amber-600 dark:text-amber-400', items: lists.pendingDowngrades.map((item) => ({ sku: item.sku, note: item.reason ?? '' })) },
    ] as const,
  )
</script>

<div data-testid="import-report" class="flex h-full min-h-0 flex-col">
  <div class="flex flex-wrap items-center gap-2 pb-3" data-testid="import-report-summary">
    <Badge variant="secondary">供应商 {report.supplier}</Badge>
    <Badge variant="secondary">行 {report.summary.rows}</Badge>
    <Badge class="bg-emerald-600/15 text-emerald-700 dark:text-emerald-400 border-transparent" variant="outline">成功 {report.summary.created}</Badge>
    <Badge variant="outline">跳过 {report.summary.skipped}</Badge>
    <Badge variant="destructive">失败 {report.summary.failed}</Badge>
    <Badge variant="outline" class="border-amber-500/40 text-amber-600 dark:text-amber-400">待渲染 {report.summary.pending}</Badge>
    <Badge variant="outline">低置信 {report.summary.lowConfidence}</Badge>
    {#if report.summary.needsReviewRows > 0}
      <Badge variant="outline" class="border-amber-500/40 text-amber-600 dark:text-amber-400">需复核行 {report.summary.needsReviewRows}</Badge>
    {/if}
  </div>

  <div class="scrollbar-thin grid min-h-0 flex-1 auto-rows-min gap-3 overflow-y-auto sm:grid-cols-2">
    {#each sections as section (section.key)}
      <section class="rounded-lg border border-border/70 p-2.5" data-testid="import-report-{section.key}">
        <h4 class="mb-1.5 flex items-center gap-2 text-xs font-semibold">
          <span class="{section.tone}">{section.label}</span>
          <span class="text-muted-foreground font-mono text-[11px]">{section.items.length}</span>
        </h4>
        {#if section.items.length === 0}
          <p class="text-muted-foreground text-xs">（无）</p>
        {:else}
          <ul class="space-y-0.5">
            {#each section.items as item, index (`${section.key}-${index}`)}
              <li class="flex gap-2 text-xs">
                <span class="font-mono font-medium">{item.sku}</span>
                {#if item.note !== ''}
                  <span class="text-muted-foreground truncate" title={item.note}>{item.note}</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}

    {#if report.lowConfidence.length > 0}
      <section class="rounded-lg border border-amber-500/30 p-2.5 sm:col-span-2" data-testid="import-report-low-confidence">
        <h4 class="mb-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400">低置信全量清单（人工把关点）</h4>
        <ul class="flex flex-wrap gap-1.5">
          {#each report.lowConfidence as item, index (index)}
            <li class="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px]">
              {item.sku}
              <span class="text-muted-foreground">· 行 {item.row} · {item.outcome}</span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>
