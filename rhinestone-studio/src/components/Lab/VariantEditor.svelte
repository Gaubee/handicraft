<!--
Orthogonal intents (max 3):
1. [2026-09-19 4.3 库化] 模板手风琴（宿主一）：数据源 = templates store（sys-templates 库投影；
     trigger = 开关+名+×N+案例徽标+[复制]；Content = TemplateEditor + [删除]；增 [新建模板]）。
     空库空态（4.2 seed 失败场景）：「模板库为空」+ [重建内置模板]（重跑 seed）+ [新建模板]。
2. [2026-09-18 R2] 高级请求参数（Advanced JSON + 尺寸）收进独立折叠组，非空时 trigger 带 ● 标记（逃生舱收纳）。
3. [2026-09-18 计划数] 摘要 Badge「N 个 · ×M」与 RunBar 的 ×M 同口径（templates store 的可用模板口径）。
-->

<script lang="ts">
  import * as Accordion from '$lib/components/ui/accordion'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import { Textarea } from '$lib/components/ui/textarea'
  import HelpTip from '../HelpTip.svelte'
  import TemplateEditor from './TemplateEditor.svelte'
  import { parseAdvancedJson } from '$lib/api/client'
  import { materializePresetEffectRef, getForm, updateForm } from '$lib/stores/lab.svelte'
  import { seedBuiltinTemplates } from '$lib/lab/templateSeed'
  import { refresh as refreshLibrary } from '$lib/assets/library.svelte'
  import {
    createTemplate,
    forkTemplate,
    getSelectedTemplateAssetId,
    getTemplateList,
    getUsableTemplates,
    isEnabledTemplate,
    isTemplatesReady,
    refreshTemplates,
    removeTemplate,
    selectTemplate,
    setEnabledTemplate,
  } from '$lib/stores/templates.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Copy from '@lucide/svelte/icons/copy'
  import FolderSync from '@lucide/svelte/icons/folder-sync'

  const templates = $derived(getTemplateList())
  const form = $derived(getForm())

  // 手风琴开合值 = 会话选中模板（templates store lab-session——跨刷新保持与库内容解耦）
  const selectedId = $derived(getSelectedTemplateAssetId())

  const advancedParse = $derived(parseAdvancedJson(form.advancedJson))
  const plannedCount = $derived(getUsableTemplates().reduce((sum, t) => sum + t.candidates, 0))
  const advancedDirty = $derived(form.advancedJson.trim() !== '')

  // 空库重建中（seed 重试）：按钮 loading 锁，防重复点击
  let reseeding = $state(false)
  let creating = $state(false)

  async function handleCreate(): Promise<void> {
    if (creating) return
    creating = true
    try {
      await createTemplate() // 新建即 ingest「模板 N」→ 列表定位并展开
    } finally {
      creating = false
    }
  }

  async function handleFork(assetId: string): Promise<void> {
    await forkTemplate(assetId) // 复制 → 「原名 副本」新节点并选中
  }

  async function handleRemove(assetId: string): Promise<void> {
    await removeTemplate(assetId) // 软删入回收站；选中态在 store 内回落首项
  }

  /** [重建内置模板]：4.2 seed 失败（离线/IDB 不可用）后的恢复入口——重跑幂等 seed。 */
  async function handleReseed(): Promise<void> {
    if (reseeding) return
    reseeding = true
    try {
      const report = await seedBuiltinTemplates({ materializePreset: materializePresetEffectRef })
      if (report.created.length > 0) refreshLibrary().catch(() => undefined)
      await refreshTemplates()
    } finally {
      reseeding = false
    }
  }
</script>

<section class="grid grid-cols-1 gap-2" data-testid="variant-editor">
  <div class="flex items-center gap-2">
    <h2 class="text-sm font-semibold tracking-tight">模板</h2>
    <Badge variant="secondary" class="font-mono tabular-nums">{templates.length} 个 · × {plannedCount}</Badge>
    <span class="ml-auto"></span>
    <Button variant="outline" size="icon-sm" title="新建模板" disabled={creating} onclick={() => void handleCreate()} data-testid="template-create">
      <Plus />
    </Button>
    <span>
      <HelpTip text="每个「模板 × 候选」都是一次独立请求（恒 n:1），并发上限 4。模板保存在素材库（.gemtpl 资产，改即存）；内置模板默认与案例图一一绑定，随请求附送一张「案例参照图」（原图+效果图自动合成的合成图），参考图（目标图）单列其后。提示词由系统自动拼装：图片角色声明 + 通用贴钻规则 + 模板特化正文。" />
    </span>
  </div>

  {#if isTemplatesReady() && templates.length === 0}
    <!-- 空库空态（B.3 状态矩阵：seed 失败且无用户模板） -->
    <div class="rounded-xl border bg-card px-3 py-6 text-center" data-testid="template-library-empty">
      <p class="text-muted-foreground text-xs">模板库为空</p>
      <div class="mt-3 flex flex-wrap items-center justify-center gap-2">
        <Button variant="outline" size="sm" disabled={reseeding} onclick={() => void handleReseed()} data-testid="template-reseed">
          <FolderSync />
          {reseeding ? '重建中…' : '重建内置模板'}
        </Button>
        <Button variant="outline" size="sm" disabled={creating} onclick={() => void handleCreate()}>
          <Plus />
          新建模板
        </Button>
      </div>
    </div>
  {:else if templates.length > 0}
    <Accordion.Root
      type="single"
      value={selectedId ?? undefined}
      onValueChange={(v) => selectTemplate(v === '' ? null : v)}
      class="rounded-xl border bg-card px-3"
    >
      {#each templates as template (template.assetId)}
        <Accordion.Item value={template.assetId} class={isEnabledTemplate(template.assetId) ? '' : 'opacity-55'}>
          <div class="flex items-center gap-2">
            <Switch
              checked={isEnabledTemplate(template.assetId)}
              onCheckedChange={(c) => setEnabledTemplate(template.assetId, c)}
              aria-label={(isEnabledTemplate(template.assetId) ? '禁用' : '启用') + `模板 ${template.name}`}
              data-testid="template-enabled-{template.assetId}"
              title={isEnabledTemplate(template.assetId) ? '点击禁用（不参与生成）' : '点击启用'}
            />
            <Accordion.Trigger class="flex w-full min-w-0 flex-1 items-center py-2.5 text-xs">
              <span class="flex min-w-0 flex-1 items-center gap-2 pr-2">
                <span class="truncate font-medium whitespace-nowrap">{template.name || '未命名模板'}</span>
                <span class="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">×{template.candidates}</span>
                {#if template.caseBinding}
                  <Badge variant="outline" class="shrink-0 text-[10px]" title="该模板绑定了案例参照图（原图+效果图合成为一张合成图）">案例参照图</Badge>
                {/if}
                {#if !isEnabledTemplate(template.assetId)}
                  <Badge variant="outline" class="shrink-0 text-[10px]">已禁用</Badge>
                {/if}
              </span>
            </Accordion.Trigger>
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground"
              title="复制模板（内容副本，案例绑定随带）"
              onclick={() => void handleFork(template.assetId)}
              data-testid="template-fork-{template.assetId}"
            >
              <Copy />
            </Button>
          </div>
          <Accordion.Content class="pb-3">
            <div class="grid gap-2">
              <TemplateEditor templateAssetId={template.assetId} />
              <div class="border-t pt-2">
                <Button
                  variant="ghost"
                  size="xs"
                  class="text-muted-foreground hover:text-destructive justify-self-start"
                  title="删除模板（软删入回收站，生成结果档案保留）"
                  onclick={() => void handleRemove(template.assetId)}
                  data-testid="template-remove-{template.assetId}"
                >
                  <Trash2 />
                  删除模板
                </Button>
              </div>
            </div>
          </Accordion.Content>
        </Accordion.Item>
      {/each}
    </Accordion.Root>
  {:else}
    <div class="rounded-xl border bg-card px-3 py-6 text-center" data-testid="template-library-loading">
      <p class="text-muted-foreground text-xs">正在读取模板库…</p>
    </div>
  {/if}

  <Button variant="outline" size="sm" class="justify-self-start" disabled={creating} onclick={() => void handleCreate()} data-testid="template-create-footer">
    <Plus />
    新建模板
  </Button>

  <Accordion.Root type="single" class="rounded-xl border bg-card px-3">
    <Accordion.Item value="advanced">
      <Accordion.Trigger class="py-2.5 text-xs">
        <span class="flex items-center gap-2">
          <span class="font-medium whitespace-nowrap">高级请求参数</span>
          {#if advancedDirty}
            <span class="bg-primary size-1.5 shrink-0 rounded-full" title="有自定义参数" aria-label="有自定义参数"></span>
          {/if}
          {#if advancedDirty}
            {#if advancedParse.ok}
              <Badge variant="secondary" class="text-[10px]">JSON 有效</Badge>
            {:else}
              <Badge variant="destructive" class="text-[10px]">JSON 非法</Badge>
            {/if}
          {/if}
          <span class="text-muted-foreground text-[11px]">JSON + 尺寸</span>
        </span>
      </Accordion.Trigger>
      <Accordion.Content class="pb-3">
        <div class="grid grid-cols-1 gap-2">
          <label class="grid gap-1.5 text-xs">
            <span class="text-muted-foreground">Advanced JSON（逃生舱：原样合并进请求体）</span>
            <Textarea
              class="field-sizing-content min-h-16 max-h-48 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs"
              placeholder='如 &#123; "background": "transparent", "output_format": "png" &#125;'
              value={form.advancedJson}
              oninput={(e) => updateForm({ advancedJson: e.currentTarget.value })}
            ></Textarea>
            {#if !advancedParse.ok}
              <span class="text-destructive text-xs">{advancedParse.error}</span>
            {/if}
          </label>
          <label class="flex items-center gap-2 text-xs">
            <span class="text-muted-foreground w-16 shrink-0">尺寸</span>
            <Input
              class="h-8 font-mono text-xs tabular-nums"
              placeholder="1024x1024"
              value={form.size}
              onchange={(e) => updateForm({ size: e.currentTarget.value })}
            />
          </label>
        </div>
      </Accordion.Content>
    </Accordion.Item>
  </Accordion.Root>
</section>
