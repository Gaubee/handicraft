<!--
AdvancedParamsEditor.svelte——高级请求参数结构化编辑器（improve-lab-advanced-ux 点 6；
Owner 2026-09-21：Tabs 三页——可视化（默认）/ JSON 预览（只读）/ JSON 编辑；未知字段 =
自定义可删减 key-value（value 用 JSON 字面量严格 parse，非法行内错误不落库）；尺寸 =
宽高双 input + icon-button 快选 Dialog（比例分组 chips 平铺）。

数据模型（双向同源）：唯一存储 = lab store form.advancedJson（字符串）+ form.size（'WxH'）。
可视化页与 JSON 页都从同一 parse 派生、写路径各自 serialize 回 form——store/持久化/请求体
零改动（旧载荷字符串 size 自动回填双 input）。字段注册表 = lib/lab/advancedParams（可扩展）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Tabs from '$lib/components/ui/tabs'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { parseAdvancedJson } from '$lib/api/client'
  import { getForm, updateForm } from '$lib/stores/lab.svelte'
  import {
    ADVANCED_KNOWN_FIELDS,
    ADVANCED_KNOWN_KEYS,
    formatJsonValueLiteral,
    formatSizeString,
    parseJsonValueLiteral,
    parseSizeString,
    serializeAdvancedParams,
    sizePresetGroupsFor,
    validateKnownFieldValue,
    type SizeValue,
  } from '$lib/lab/advancedParams'
  import Plus from '@lucide/svelte/icons/plus'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import Frame from '@lucide/svelte/icons/frame'

  const form = $derived(getForm())
  const advancedParse = $derived(parseAdvancedJson(form.advancedJson))
  const advancedValue = $derived(advancedParse.ok ? advancedParse.value : null)

  // ---------------------------------------------------------------------------
  // 可视化页：已知字段控件（值变更 → 重序列化提交；「默认」哨兵 = 键缺席）
  // ---------------------------------------------------------------------------

  /** 应用单键变更（set/delete）→ 确定性序序列化 → form（非法 JSON 态下不可达——JSON 页先修）。 */
  function applyField(mutate: (draft: Record<string, unknown>) => void): void {
    if (advancedValue === null) return
    const draft: Record<string, unknown> = { ...advancedValue }
    mutate(draft)
    updateForm({ advancedJson: serializeAdvancedParams(draft) })
  }

  /** enum 值（'' = 默认哨兵 → 键剥除）。 */
  function handleEnumChange(key: string, value: string): void {
    applyField((draft) => {
      if (value === '') delete draft[key]
      else draft[key] = value
    })
  }

  // number 字段行内缓冲与错误（合法才提交——非法不落库）
  let numberDrafts = $state<Record<string, string>>({})
  let numberErrors = $state<Record<string, string>>({})

  function handleNumberChange(key: string, text: string): void {
    numberDrafts = { ...numberDrafts, [key]: text }
    if (text.trim() === '') {
      // 清空 = 回到默认（键剥除）——与 enum 哨兵同语义
      numberErrors = { ...numberErrors, [key]: '' }
      applyField((draft) => delete draft[key])
      return
    }
    const parsed = parseJsonValueLiteral(text)
    if (!parsed.ok) {
      numberErrors = { ...numberErrors, [key]: parsed.error }
      return
    }
    const field = ADVANCED_KNOWN_FIELDS.find((f) => f.key === key)
    if (field === undefined) return
    const invalid = validateKnownFieldValue(field, parsed.value)
    if (invalid !== null) {
      numberErrors = { ...numberErrors, [key]: invalid }
      return
    }
    numberErrors = { ...numberErrors, [key]: '' }
    applyField((draft) => {
      draft[key] = parsed.value
    })
  }

  // ---------------------------------------------------------------------------
  // 可视化页：自定义 key-value 行（未知字段；value = JSON 字面量严格 parse）
  // ---------------------------------------------------------------------------

  interface CustomRow {
    key: string
    /** 编辑中的字面量文本（合法时已落 form；非法时行内错误缓冲）。 */
    literal: string
    error: string
  }

  let customRows = $state<CustomRow[]>([])
  let customRowSeq = 0
  /** 外部同步标记：form.advancedJson 变化非本页发起时重建行（JSON 页编辑/复用参数等）。 */
  let customRowsSource: string | null = null

  $effect(() => {
    const current = form.advancedJson
    if (current === customRowsSource) return
    customRowsSource = current
    customRows = Object.entries(advancedValue ?? {})
      .filter(([key]) => !ADVANCED_KNOWN_KEYS.has(key))
      .map(([key, value]) => ({ key, literal: formatJsonValueLiteral(value), error: '' }))
  })

  function setCustomRowLiteral(index: number, literal: string, error: string): void {
    customRows = customRows.map((row, i) => (i === index ? { ...row, literal, error } : row))
  }

  /** 行内 value 字面量变更：严格 parse——合法落 form、非法行内错误不落库。 */
  function handleCustomLiteral(index: number, text: string): void {
    const row = customRows[index]
    if (row === undefined) return
    const parsed = parseJsonValueLiteral(text)
    if (!parsed.ok) {
      setCustomRowLiteral(index, text, parsed.error)
      return
    }
    setCustomRowLiteral(index, text, '')
    applyField((draft) => {
      if (ADVANCED_KNOWN_KEYS.has(row.key)) delete draft[row.key]
      draft[row.key] = parsed.value
    })
  }

  function removeCustomRow(index: number): void {
    const row = customRows[index]
    if (row === undefined) return
    customRows = customRows.filter((_, i) => i !== index)
    applyField((draft) => delete draft[row.key])
  }

  // 新增自定义键行（key + 字面量 value 齐备才落）
  let newKeyText = $state('')
  let newValueText = $state('')
  let newRowError = $state('')

  const newKeyTaken = $derived(newKeyText.trim() !== '' && (newKeyText in (advancedValue ?? {}) || ADVANCED_KNOWN_KEYS.has(newKeyText)))

  function addCustomRow(): void {
    const key = newKeyText.trim()
    if (key === '') {
      newRowError = '键名不能为空'
      return
    }
    if (ADVANCED_KNOWN_KEYS.has(key)) {
      newRowError = '该键是已知字段——请在上方控件设置'
      return
    }
    if (key in (advancedValue ?? {})) {
      newRowError = '键已存在'
      return
    }
    const parsed = parseJsonValueLiteral(newValueText)
    if (!parsed.ok) {
      newRowError = parsed.error
      return
    }
    newRowError = ''
    applyField((draft) => {
      draft[key] = parsed.value
    })
    newKeyText = ''
    newValueText = ''
  }

  // ---------------------------------------------------------------------------
  // JSON 页（编辑）：draft 只在合法时落 form（非法 → 行内错误不落库）；
  // 外部变更（可视化页/复用参数）经 committed 标记回流 draft——不打断编辑中的非法缓冲。
  // ---------------------------------------------------------------------------

  let jsonDraft = $state('')
  let jsonError = $state('')
  let jsonCommitted: string | null = null

  $effect(() => {
    const current = form.advancedJson
    if (current !== jsonCommitted) {
      jsonDraft = current
      jsonCommitted = current
      jsonError = ''
    }
  })

  function handleJsonInput(event: Event): void {
    jsonDraft = (event.currentTarget as HTMLTextAreaElement).value
    const parsed = parseAdvancedJson(jsonDraft)
    if (parsed.ok) {
      jsonCommitted = jsonDraft
      jsonError = ''
      updateForm({ advancedJson: jsonDraft }) // 原文透传（保持用户格式）
    } else {
      jsonError = parsed.error
    }
  }

  // ---------------------------------------------------------------------------
  // 尺寸：双 input（不手写 WxH）+ 快选 Dialog（比例分组 chips）
  // ---------------------------------------------------------------------------

  let widthText = $state('')
  let heightText = $state('')
  let sizeError = $state('')

  $effect(() => {
    const parsed = parseSizeString(form.size)
    widthText = parsed ? String(parsed.width) : ''
    heightText = parsed ? String(parsed.height) : ''
    sizeError = ''
  })

  function commitSize(): void {
    if (widthText.trim() === '' || heightText.trim() === '') {
      sizeError = '' // 单侧未填 = 填写中
      return
    }
    const width = Number(widthText)
    const height = Number(heightText)
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
      sizeError = '宽高须为正整数（px）'
      return
    }
    sizeError = ''
    updateForm({ size: formatSizeString({ width, height }) })
  }

  function handleSizeWidth(event: Event): void {
    widthText = (event.currentTarget as HTMLInputElement).value
    commitSize()
  }

  function handleSizeHeight(event: Event): void {
    heightText = (event.currentTarget as HTMLInputElement).value
    commitSize()
  }

  let sizePickOpen = $state(false)
  const sizeParsed = $derived(parseSizeString(form.size))
  const sizeGroups = $derived(sizePresetGroupsFor(sizeParsed))

  function pickSize(value: SizeValue): void {
    updateForm({ size: formatSizeString(value) })
    sizePickOpen = false
  }

  const ratioLabel = (value: SizeValue): string => `${value.width} × ${value.height}`
</script>

<Tabs.Root value="visual" data-testid="advanced-params-editor">
  <Tabs.List>
    <Tabs.Trigger value="visual" data-testid="advanced-tab-visual">可视化</Tabs.Trigger>
    <Tabs.Trigger value="preview" data-testid="advanced-tab-preview">JSON 预览</Tabs.Trigger>
    <Tabs.Trigger value="edit" data-testid="advanced-tab-edit">JSON 编辑</Tabs.Trigger>
  </Tabs.List>

  <!-- 可视化页（默认）：已知字段控件 + 自定义 key-value + 尺寸双 input -->
  <Tabs.Content value="visual" class="mt-2 grid gap-2" data-testid="advanced-visual">
    {#if advancedValue === null}
      <p class="text-destructive text-xs" data-testid="advanced-visual-invalid">
        当前 JSON 非法（旧数据或外部写入）——请到「JSON 编辑」页修复后再用可视化编辑。
      </p>
    {:else}
      <div class="grid gap-1.5" data-testid="advanced-known-fields">
        {#each ADVANCED_KNOWN_FIELDS as field (field.key)}
          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span class="text-muted-foreground w-24 shrink-0">{field.label}</span>
            {#if field.type === 'enum'}
              <select
                class="border-input bg-background h-7 rounded-md border px-1.5 text-[11px]"
                aria-label="{field.label}（{field.key}）"
                data-testid="adv-known-{field.key}"
                value={advancedValue[field.key] !== undefined ? String(advancedValue[field.key]) : ''}
                onchange={(e) => handleEnumChange(field.key, e.currentTarget.value)}
              >
                <option value="">默认（未设置）</option>
                {#each field.options ?? [] as option (option)}
                  <option value={option}>{option}</option>
                {/each}
              </select>
            {:else}
              <Input
                class="h-7 w-20 font-mono tabular-nums"
                type="text"
                inputmode="numeric"
                placeholder="默认"
                value={advancedValue[field.key] !== undefined ? formatJsonValueLiteral(advancedValue[field.key]) : (numberDrafts[field.key] ?? '')}
                onchange={(e) => handleNumberChange(field.key, e.currentTarget.value)}
                aria-label="{field.label}（{field.key}）"
                data-testid="adv-known-{field.key}"
              />
            {/if}
            {#if field.hint}
              <span class="text-muted-foreground/70">{field.hint}</span>
            {/if}
            {#if numberErrors[field.key]}
              <span class="text-destructive" data-testid="adv-known-error-{field.key}">{numberErrors[field.key]}</span>
            {/if}
          </div>
        {/each}
      </div>

      <div class="grid gap-1.5 border-t pt-2" data-testid="advanced-custom-fields">
        <span class="text-muted-foreground text-[11px]">自定义字段（未知键——value 用 JSON 字面量，如 42 / "png" / true）</span>
        {#each customRows as row, index (row.key)}
          <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span class="w-24 shrink-0 truncate font-mono" title={row.key}>{row.key}</span>
            <Input
              class="h-7 w-40 font-mono"
              value={row.literal}
              onchange={(e) => handleCustomLiteral(index, e.currentTarget.value)}
              aria-label="自定义字段 {row.key} 的值（JSON 字面量）"
              data-testid="adv-custom-value-{row.key}"
            />
            {#if row.error}
              <span class="text-destructive" data-testid="adv-custom-error-{row.key}">{row.error}</span>
            {/if}
            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:text-destructive ml-auto"
              aria-label="删除自定义字段 {row.key}"
              onclick={() => removeCustomRow(index)}
              data-testid="adv-custom-remove-{row.key}"
            >
              <Trash2 />
            </Button>
          </div>
        {/each}
        <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <Input
            class="h-7 w-24 font-mono"
            placeholder="键名"
            value={newKeyText}
            onchange={(e) => (newKeyText = e.currentTarget.value)}
            aria-label="新增自定义字段键名"
            data-testid="adv-custom-new-key"
          />
          <Input
            class="h-7 w-32 font-mono"
            placeholder='如 42 / "png"'
            value={newValueText}
            onchange={(e) => (newValueText = e.currentTarget.value)}
            aria-label="新增自定义字段值（JSON 字面量）"
            data-testid="adv-custom-new-value"
          />
          <Button variant="outline" size="xs" disabled={newKeyTaken} onclick={addCustomRow} data-testid="adv-custom-add">
            <Plus />
            添加
          </Button>
          {#if newRowError}
            <span class="text-destructive" data-testid="adv-custom-new-error">{newRowError}</span>
          {/if}
        </div>
      </div>

      <div class="grid gap-1.5 border-t pt-2" data-testid="advanced-size">
        <div class="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span class="text-muted-foreground w-24 shrink-0">尺寸</span>
          <Input
            class="h-7 w-20 font-mono tabular-nums"
            type="number"
            min="1"
            step="1"
            placeholder="1024"
            value={widthText}
            onchange={handleSizeWidth}
            aria-label="图宽（px）"
            data-testid="adv-size-w"
          />
          <span class="text-muted-foreground">×</span>
          <Input
            class="h-7 w-20 font-mono tabular-nums"
            type="number"
            min="1"
            step="1"
            placeholder="1024"
            value={heightText}
            onchange={handleSizeHeight}
            aria-label="图高（px）"
            data-testid="adv-size-h"
          />
          <span class="text-muted-foreground">px</span>
          <Button
            variant="outline"
            size="icon-sm"
            class="text-muted-foreground hover:text-foreground"
            title="快选常用尺寸（按比例分组）"
            aria-label="快选常用尺寸"
            onclick={() => (sizePickOpen = true)}
            data-testid="adv-size-pick"
          >
            <Frame />
          </Button>
        </div>
        {#if sizeError}
          <p class="text-destructive text-[11px]" data-testid="adv-size-error">{sizeError}</p>
        {/if}
      </div>
    {/if}
  </Tabs.Content>

  <!-- JSON 预览页（只读） -->
  <Tabs.Content value="preview" class="mt-2" data-testid="advanced-json-preview">
    <pre
      class="bg-muted/40 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap"
      data-testid="adv-json-preview-text"
    >{form.advancedJson.trim() === '' ? '（未设置——请求体不合并任何高级参数）' : form.advancedJson}</pre>
  </Tabs.Content>

  <!-- JSON 编辑页（合法才落库） -->
  <Tabs.Content value="edit" class="mt-2 grid gap-1.5" data-testid="advanced-json-edit">
    <Textarea
      class="field-sizing-content min-h-24 max-h-64 w-full min-w-0 overflow-y-auto font-mono text-xs leading-relaxed"
      placeholder='如 &#123; "background": "transparent", "seed": 42 &#125;'
      value={jsonDraft}
      oninput={handleJsonInput}
      aria-label="Advanced JSON 编辑（合法才保存）"
      data-testid="adv-json-edit-textarea"
    ></Textarea>
    {#if jsonError}
      <p class="text-destructive text-xs" data-testid="adv-json-edit-error">{jsonError}（未保存——修复后自动保存）</p>
    {:else}
      <p class="text-muted-foreground text-[11px]" data-testid="adv-json-edit-ok">合法 JSON 自动保存；未知字段会出现在「可视化」页的自定义字段区。</p>
    {/if}
  </Tabs.Content>
</Tabs.Root>

<!-- 尺寸快选 Dialog：比例分组 + 尺寸 chips 平铺（标准集 + 自定义已输入值） -->
<Dialog.Root bind:open={sizePickOpen}>
  <Dialog.Content class="max-w-md">
    <Dialog.Header>
      <Dialog.Title class="text-sm">快选尺寸</Dialog.Title>
      <Dialog.Description>按比例分组的常用尺寸（OpenAI 标准集）；当前输入的非标尺寸也会出现在末组。</Dialog.Description>
    </Dialog.Header>
    <div class="grid gap-2" data-testid="adv-size-pick-dialog">
      {#each sizeGroups as group (group.ratio)}
        <div class="grid gap-1" data-testid="adv-size-group">
          <span class="text-muted-foreground text-[11px] font-medium">{group.ratio}</span>
          <div class="flex flex-wrap gap-1.5">
            {#each group.sizes as size (ratioLabel(size))}
              <Button
                variant={sizeParsed !== null && sizeParsed.width === size.width && sizeParsed.height === size.height ? 'default' : 'outline'}
                size="xs"
                class="font-mono tabular-nums"
                onclick={() => pickSize(size)}
                data-testid="adv-size-chip-{size.width}x{size.height}"
              >
                {ratioLabel(size)}
              </Button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  </Dialog.Content>
</Dialog.Root>
