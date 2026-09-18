<!--
Orthogonal intents (max 3):
1. [2026-09-18 R2 PM-B6] 变体手风琴：默认仅第一组展开，trigger=名称+×N+首行预览；
     朋友可不展开直接生成，Owner 展开逐组精调。textarea 自适应高度并限高（vision #13）；
     whitespace-pre-wrap + break-words（N3：field-sizing:content 在桌面宽列下禁用换行 → 首行溢出横向滚动条）。
2. [2026-09-18 R2] 高级请求参数（Advanced JSON + 尺寸）收进独立折叠组，非空时 trigger 带 ● 标记（逃生舱收纳）。
3. [2026-09-18 计划数] 摘要 Badge「N 组 · ×M」与 RunBar 的 ×M 同口径，可核对。
-->

<script lang="ts">
  import * as Accordion from '$lib/components/ui/accordion'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Switch } from '$lib/components/ui/switch'
  import { Textarea } from '$lib/components/ui/textarea'
  import HelpTip from '../HelpTip.svelte'
  import EffectRefControl from './EffectRefControl.svelte'
  import { parseAdvancedJson } from '$lib/api/client'
  import {
    addVariant,
    getForm,
    getVariants,
    removeVariant,
    updateForm,
    updateVariant,
  } from '$lib/stores/lab.svelte'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'

  const variants = $derived(getVariants())
  const form = $derived(getForm())

  /** 手风琴开合值 = 展开中的变体 id（single 手风琴：一次展开一组，允许全收起）。
   *  初始值取首组是有意的一次性捕获：后续增删由 handleAdd/handleRemove 显式维护。 */
  // svelte-ignore state_referenced_locally
  let openVariantId = $state<string | undefined>(variants[0]?.id)

  // hydrate 恢复持久化变体后，展开值可能指向已不存在的 id → 回落第一组
  $effect(() => {
    if (openVariantId && !variants.some((v) => v.id === openVariantId)) {
      openVariantId = variants[0]?.id
    }
  })

  const advancedParse = $derived(parseAdvancedJson(form.advancedJson))
  const plannedCount = $derived(
    variants
      .filter((v) => v.enabled && v.prompt.trim() !== '' && v.candidates >= 1)
      .reduce((sum, v) => sum + v.candidates, 0),
  )
  const advancedDirty = $derived(form.advancedJson.trim() !== '')

  function handleRemove(id: string): void {
    removeVariant(id)
    if (openVariantId === id) openVariantId = variants[0]?.id
  }

  function handleAdd(): void {
    addVariant()
    openVariantId = variants[variants.length - 1]?.id
  }
</script>

<section class="grid grid-cols-1 gap-2" data-testid="variant-editor">
  <div class="flex items-center gap-2">
    <h2 class="text-sm font-semibold tracking-tight">提示词变体组</h2>
    <Badge variant="secondary" class="font-mono tabular-nums">{variants.length} 组 · × {plannedCount}</Badge>
    <span class="ml-auto">
      <HelpTip text="每个「变体 × 候选」都是一次独立请求（恒 n:1），并发上限 4。模板已预填，日常只需微调 1-2 组；生成动作在下方常驻。" />
    </span>
  </div>

  <Accordion.Root
    type="single"
    value={openVariantId}
    onValueChange={(v) => (openVariantId = v === '' ? undefined : v)}
    class="rounded-xl border bg-card px-3"
  >
    {#each variants as variant (variant.id)}
      <Accordion.Item value={variant.id} class={variant.enabled ? '' : 'opacity-55'}>
        <div class="flex items-center gap-2">
          <Switch
            checked={variant.enabled}
            onCheckedChange={(c) => updateVariant(variant.id, { enabled: c })}
            aria-label={(variant.enabled ? '禁用' : '启用') + `变体 ${variant.name}`}
            data-testid="variant-enabled-{variant.id}"
            title={variant.enabled ? '点击禁用（不参与生成）' : '点击启用'}
          />
          <Accordion.Trigger class="flex w-full min-w-0 flex-1 items-center py-2.5 text-xs">
            <span class="flex min-w-0 flex-1 items-center gap-2 pr-2">
              <span class="truncate font-medium whitespace-nowrap">{variant.name || '未命名变体'}</span>
              <span class="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums">×{variant.candidates}</span>
              {#if variant.effectRef}
                <Badge variant="outline" class="shrink-0 text-[10px]" title="该变体挂了「原图 → 贴钻效果」参考对">效果参考</Badge>
              {/if}
              {#if !variant.enabled}
                <Badge variant="outline" class="shrink-0 text-[10px]">已禁用</Badge>
              {/if}
            </span>
          </Accordion.Trigger>
        </div>
        <Accordion.Content class="pb-3">
          <div class="grid grid-cols-1 gap-2">
            <div class="flex items-center gap-2">
              <Input
                class="h-8 flex-1 text-xs font-medium"
                value={variant.name}
                onchange={(e) => updateVariant(variant.id, { name: e.currentTarget.value })}
                aria-label="变体名称"
                placeholder="变体名称"
              />
              <label class="text-muted-foreground flex items-center gap-1 text-xs">
                候选
                <Input
                  class="h-8 w-14 font-mono tabular-nums"
                  type="number"
                  min="1"
                  max="8"
                  value={variant.candidates}
                  onchange={(e) => updateVariant(variant.id, { candidates: Number(e.currentTarget.value) })}
                  aria-label="候选数"
                />
              </label>
              <Button
                variant="ghost"
                size="icon-sm"
                class="text-muted-foreground hover:text-destructive"
                title="删除变体"
                disabled={variants.length <= 1}
                onclick={() => handleRemove(variant.id)}
              >
                <Trash2 />
              </Button>
            </div>
            <Textarea
              class="field-sizing-content text-muted-foreground min-h-24 max-h-64 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
              placeholder="英文生成指令：仅重画值得贴钻的元素为纯色闭合形状，剔除天空/雪地/远景/人物，5-6 色，透明或纯白背景…"
              value={variant.prompt}
              onchange={(e) => updateVariant(variant.id, { prompt: e.currentTarget.value })}
              aria-label="生成指令"
            ></Textarea>
            <div class="border-t pt-2">
              <EffectRefControl variantId={variant.id} effectRef={variant.effectRef ?? null} />
            </div>
          </div>
        </Accordion.Content>
      </Accordion.Item>
    {/each}
  </Accordion.Root>

  <Button variant="outline" size="sm" class="justify-self-start" onclick={handleAdd}>
    <Plus />
    新增变体
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
