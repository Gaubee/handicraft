<!--
ImportWizard.svelte——样卡导入向导（add-stone-library S3.3，design §8 链）。
步进：源图多页上传（sourcePages blob 映射）→ 粘贴/引用 AI 草表（CardCatalogDraft
JSON 全量校验）→ 预览摘要（结构级客户端可证事实——新原子数/切格以服务端 preview
与执行报告为准）→ 执行（stones.importRun 人工直发——操作者即批准人；与 agent/
MCP 面 proposal 流并存，两者收敛同一 runCardImport）。报告步=执行产物（四清单见
ImportReportView）。执行器=store.runStoneImport（源图页 uploadAsset 入库→importRun）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import ImportReportView from './ImportReportView.svelte'
  import {
    type ImportWizardStep,
    bindWizardImportExecutor,
    getImportWizardDraft,
    getImportWizardDraftError,
    getImportWizardDraftText,
    getImportWizardExecuteError,
    getImportWizardPages,
    getImportWizardReport,
    getImportWizardStep,
    getImportWizardTargetSupplier,
    isImportWizardExecuting,
    isImportWizardOpen,
    closeImportWizard,
    summarizeDraft,
    wizardCanAdvance,
    wizardExecuteImport,
    wizardGoBack,
    wizardGoNext,
    wizardRemoveSourcePage,
    wizardSetDraftText,
    wizardSetSourceFiles,
    wizardSetTargetSupplier,
  } from '$lib/stonesAdmin/wizard.svelte'
  import { runStoneImport } from '$lib/stonesAdmin/store.svelte'
  import ChevronLeft from '@lucide/svelte/icons/chevron-left'
  import ChevronRight from '@lucide/svelte/icons/chevron-right'
  import FileUp from '@lucide/svelte/icons/file-up'
  import Play from '@lucide/svelte/icons/play'

  // 执行器接线：源图页 blob 入库 + stones.importRun 人工直发（store 数据底座）。
  bindWizardImportExecutor(runStoneImport)

  const open = $derived(isImportWizardOpen())
  const step = $derived(getImportWizardStep())
  const pages = $derived(getImportWizardPages())
  const draftText = $derived(getImportWizardDraftText())
  const draft = $derived(getImportWizardDraft())
  const draftError = $derived(getImportWizardDraftError())
  const targetSupplier = $derived(getImportWizardTargetSupplier())
  const report = $derived(getImportWizardReport())
  const executing = $derived(isImportWizardExecuting())
  const executeError = $derived(getImportWizardExecuteError())

  const summary = $derived(draft !== null ? summarizeDraft(draft, pages.map((page) => page.page)) : null)

  const STEP_LABEL: Record<ImportWizardStep, string> = {
    sources: '1 源图',
    draft: '2 草表',
    preview: '3 预览',
    execute: '4 执行',
    report: '报告',
  }

  let fileInput = $state<HTMLInputElement | null>(null)

  function onFiles(files: FileList | null): void {
    if (files === null || files.length === 0) return
    wizardSetSourceFiles(Array.from(files))
  }
</script>

<Dialog.Root open={open} onOpenChange={(next) => { if (!next) closeImportWizard() }}>
  <Dialog.Content class="flex max-h-[85vh] w-full max-w-2xl flex-col gap-0 p-0" data-testid="import-wizard">
    <Dialog.Header class="flex-row items-center gap-2 border-b px-4 py-3">
      <Dialog.Title class="text-sm font-semibold">样卡导入向导</Dialog.Title>
      <div class="ml-2 flex items-center gap-1" data-testid="import-wizard-steps">
        {#each Object.entries(STEP_LABEL) as [key, label] (key)}
          {#if key === step}
            <Badge variant="secondary">{label}</Badge>
          {:else if key === 'report'}
            {#if report !== null}<Badge variant="outline">{label}</Badge>{/if}
          {:else}
            <span class="text-muted-foreground text-xs">{label.replace(/^\d /, '')}</span>
          {/if}
        {/each}
      </div>
      <Button variant="outline" size="sm" class="ml-auto" onclick={() => closeImportWizard()} data-testid="import-wizard-close">关闭</Button>
    </Dialog.Header>
    <Dialog.Description class="sr-only">上传样卡源图并粘贴 AI 草表，经授权桥导入装饰钻库</Dialog.Description>

    <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
      {#if step === 'sources'}
        <section data-testid="import-wizard-sources">
          <p class="text-muted-foreground mb-3 text-sm leading-relaxed">
            上传样卡源图（每页一张 PNG——cells 引用页须由此直供；单页草表可省略，走服务端 blobRef 回退）。
          </p>
          <input
            bind:this={fileInput}
            type="file"
            accept="image/png"
            multiple
            class="hidden"
            data-testid="import-wizard-file-input"
            onchange={(event) => {
              onFiles(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
          />
          <Button variant="outline" size="sm" onclick={() => fileInput?.click()} data-testid="import-wizard-upload">
            <FileUp class="size-3.5" aria-hidden="true" />
            选择源图（可多选）
          </Button>
          {#if pages.length > 0}
            <ul class="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="import-wizard-pages">
              {#each pages as page (page.page)}
                <li class="border-border/70 relative overflow-hidden rounded-lg border" data-testid="import-wizard-page-{page.page}">
                  <div class="flex h-24 items-center justify-center" style="background: color-mix(in srgb, currentColor 6%, transparent)">
                    <img src={page.url} alt="源图第 {page.page} 页" class="max-h-full max-w-full object-contain p-1" />
                  </div>
                  <div class="flex items-center gap-1 px-2 py-1 text-[11px]">
                    <span class="font-mono">页 {page.page}</span>
                    <span class="text-muted-foreground truncate">{page.file.name}</span>
                    <button
                      type="button"
                      class="text-muted-foreground hover:text-destructive ml-auto shrink-0"
                      onclick={() => wizardRemoveSourcePage(page.page)}
                      data-testid="import-wizard-remove-{page.page}"
                      aria-label="移除第 {page.page} 页"
                    >
                      ×
                    </button>
                  </div>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {:else if step === 'draft'}
        <section data-testid="import-wizard-draft">
          <p class="text-muted-foreground mb-2 text-sm leading-relaxed">
            粘贴 AI 草表 JSON（vision 代理按 CardCatalogDraft 契约产出——供应商/行段/款式行/格 bbox）。
          </p>
          <textarea
            rows="10"
            class="w-full rounded-md border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed"
            placeholder="粘贴 CardCatalogDraft JSON（vision 样卡识别产出）"
            data-testid="import-wizard-draft-input"
            value={draftText}
            oninput={(event) => wizardSetDraftText(event.currentTarget.value)}
          ></textarea>
          {#if draftError !== null}
            <p class="text-destructive mt-2 rounded-md bg-destructive/10 p-2 text-xs leading-relaxed" data-testid="import-wizard-draft-error">
              {draftError}
            </p>
          {:else if draft !== null}
            <p class="mt-2 text-xs text-emerald-600 dark:text-emerald-400" data-testid="import-wizard-draft-ok">
              草表校验通过：{draft.styles.length} 款式 · {draft.styles.reduce((sum, style) => sum + style.cells.length, 0)} 格 · 引用页
              {[...new Set(draft.styles.flatMap((style) => style.cells.map((cell) => cell.page)))].sort((a, b) => a - b).join('、')}
            </p>
          {/if}
          <label class="mt-3 block text-xs">
            <span class="text-muted-foreground">落库供应商（targetSupplier——缺省取草表）</span>
            <Input
              class="mt-1 font-mono"
              data-testid="import-wizard-target-supplier"
              value={targetSupplier}
              oninput={(event) => wizardSetTargetSupplier(event.currentTarget.value)}
            />
          </label>
        </section>
      {:else if step === 'preview' && summary !== null}
        <section data-testid="import-wizard-preview">
          <dl class="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-3">
            <div><dt class="text-muted-foreground text-xs">供应商</dt><dd class="font-mono">{summary.supplier}</dd></div>
            <div><dt class="text-muted-foreground text-xs">款式行</dt><dd>{summary.styleCount}</dd></div>
            <div><dt class="text-muted-foreground text-xs">格数</dt><dd>{summary.cellCount}</dd></div>
            <div class="col-span-2"><dt class="text-muted-foreground text-xs">色系</dt><dd>{summary.families.length > 0 ? summary.families.join('、') : '（草表未含）'}</dd></div>
            <div><dt class="text-muted-foreground text-xs">行段</dt><dd class="font-mono text-xs">{summary.bands.map((band) => `${band.rows[0]}-${band.rows[1]}:${band.prefixes.join('/')}`).join(' ')}</dd></div>
          </dl>

          <div class="mt-3 rounded-lg border border-border/70 p-3 text-xs" data-testid="import-wizard-page-mapping">
            <p class="mb-1 font-medium">源图页映射</p>
            <p class="text-muted-foreground">草表引用页 {summary.referencedPages.length > 0 ? summary.referencedPages.join('、') : '（无）'} · 已上传 {summary.uploadedPages.length > 0 ? summary.uploadedPages.join('、') : '（无）'}</p>
            {#if summary.missingPages.length > 0}
              <p class="mt-1 text-amber-600 dark:text-amber-400" data-testid="import-wizard-missing-pages">
                缺页：{summary.missingPages.join('、')}——执行前须补传（否则 proposal 发起即拒）。
              </p>
            {:else if summary.singlePageFallbackAvailable}
              <p class="text-muted-foreground mt-1">单页草表——可走服务端 sourceImage.blobRef 回退。</p>
            {/if}
          </div>

          {#if summary.lowConfidence.length > 0}
            <div class="mt-3 rounded-lg border border-amber-500/40 p-3 text-xs" data-testid="import-wizard-low-confidence">
              <p class="mb-1 font-medium text-amber-600 dark:text-amber-400">低置信/待命名（{summary.lowConfidence.length}）——导入以「待命名-行」兜底，预览显式列出</p>
              <ul class="flex flex-wrap gap-1.5">
                {#each summary.lowConfidence as item (item.row)}
                  <li class="rounded bg-muted/70 px-1.5 py-0.5 font-mono">
                    行 {item.row}
                    <span class="text-muted-foreground">· {item.reason === 'unnamed' ? '待命名' : `置信 ${item.confidence.toFixed(2)}`}</span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}

          <p class="text-muted-foreground mt-3 text-xs leading-relaxed" data-testid="import-wizard-preview-note">
            本预览为结构级客户端事实：新建原子数/已存在跳过/切格质量以服务端 proposal preview 与导入报告为准——预览不猜测。
          </p>
        </section>
      {:else if step === 'execute'}
        <section data-testid="import-wizard-execute-step">
          <div class="mx-auto w-full max-w-[85%] rounded-xl border border-border/80 bg-card p-3.5 shadow-sm">
            <div class="mb-2 flex items-center gap-2">
              <Badge variant="outline" class="font-mono text-xs">stones.importRun</Badge>
              <Badge variant="secondary">人工直发（操作者即批准人）</Badge>
            </div>
            <p class="text-sm leading-relaxed">
              样卡批量导入 {targetSupplier || '（未定）'}：结构预览 {summary?.styleCount ?? 0} 款式 · {summary?.cellCount ?? 0} 格
              {#if summary !== null && summary.lowConfidence.length > 0}· 低置信 {summary.lowConfidence.length} 项{/if}
              ——执行后逐格切图过六 gate，幂等重跑收敛（已存在 supplier×sku 跳过）。
            </p>
            {#if summary !== null && summary.missingPages.length > 0}
              <p class="mt-2 rounded bg-destructive/10 p-2 text-xs text-destructive" data-testid="import-wizard-execute-missing-pages">
                缺页：{summary.missingPages.join('、')}——执行前须补传源图。
              </p>
            {/if}
            <div class="mt-3 flex justify-end gap-2">
              <Button
                size="sm"
                disabled={executing || (summary !== null && summary.missingPages.length > 0)}
                onclick={() => void wizardExecuteImport()}
                data-testid="import-wizard-execute"
                title="stones.importRun——人工直发执行导入（操作者即批准人）"
              >
                <Play class="size-3.5" aria-hidden="true" />
                {executing ? '导入中…' : '执行导入'}
              </Button>
            </div>
          </div>
          {#if executeError !== null}
            <p class="text-destructive mx-auto mt-3 max-w-[85%] rounded-md bg-destructive/10 p-2 text-xs leading-relaxed" data-testid="import-wizard-execute-error">
              {executeError}
            </p>
          {/if}
          <p class="text-muted-foreground mx-auto mt-3 max-w-[85%] text-xs leading-relaxed" data-testid="import-wizard-execute-note">
            人工直发=操作者即批准人（审计记 owner=当前用户）；agent/MCP 面的 stone.import proposal 流并存——两者在 daemon 侧收敛到同一 runCardImport（幂等共享）。
          </p>
        </section>
      {:else if step === 'report' && report !== null}
        <div class="h-[60vh]" data-testid="import-wizard-report">
          <ImportReportView {report} />
        </div>
      {/if}
    </div>

    {#if step !== 'report'}
      <div class="flex items-center gap-2 border-t px-4 py-3">
        {#if step !== 'sources'}
          <Button variant="outline" size="sm" onclick={() => wizardGoBack()} data-testid="import-wizard-back">
            <ChevronLeft class="size-3.5" aria-hidden="true" />
            上一步
          </Button>
        {/if}
        <span class="text-muted-foreground mr-auto text-xs">{STEP_LABEL[step]}</span>
        {#if step !== 'execute'}
          <Button size="sm" disabled={!wizardCanAdvance()} onclick={() => wizardGoNext()} data-testid="import-wizard-next">
            下一步
            <ChevronRight class="size-3.5" aria-hidden="true" />
          </Button>
        {/if}
      </div>
    {/if}
  </Dialog.Content>
</Dialog.Root>
