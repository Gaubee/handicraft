<!--
TemplateEditor.svelte——可嵌入的模板四件套编辑器（openspec add-project-files 4.3 抽出；
PRODUCT_MODEL v3 硬规则 7：模板编辑的唯一编辑器，双宿主 [实验室手风琴 Content / 素材库
RightSheet(4.3b)] 共用；编辑态真源 converge 到库资产 .gemtpl，宿主不持副本）。

本组件**不含宿主 chrome**（手风琴/抽屉/头部/关闭守卫均归宿主）：只渲染
名称 / 候选数 / 提示词体 textarea（支持效果占位符光标位插入——placeholders 切片 3）/
高级选项区（内嵌 TemplateAdvancedOptions：案例参照图开关+选图面 / 水钻参数配置 / 蓝图 beta
+ 每开关的效果提示词铅笔入口）+ 字段提交（onchange/blur → templates store 写队列，B.1.2
自动换绑）+ 轻量保存态指示。

props 契约（冻结给 4.3b RightSheet 复用）：
- templateAssetId: string——唯一 prop；record 一律从共享 store 读取（$derived），
  宿主不得传入编辑副本（传入 = 漂移的开始，C.5.3）。
-->

<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import TemplateAdvancedOptions from './TemplateAdvancedOptions.svelte'
  import { getTemplateRecord, submitTemplateField } from '$lib/stores/templates.svelte'

  let { templateAssetId }: { templateAssetId: string } = $props()

  const record = $derived(getTemplateRecord(templateAssetId))

  // 主提示词 textarea 元素引用（效果占位符的光标位插入锚点）+ 光标上下文标记
  let promptTextarea = $state<HTMLTextAreaElement | null>(null)
  /** 用户是否聚焦过主提示词（未聚焦 = 无光标信息 → 插入走追加末尾，防 selectionStart=0 误插段首）。 */
  let promptFocusedOnce = false

  /**
   * [placeholders] 效果占位符插入（幂等 + 光标位）：
   * - 已存在（includes）→ 不重复插入（Owner 2026-09-20 原话）；
   * - 有光标信息（textarea 曾聚焦，selectionStart 持久于 blur 后）→ 插在光标处（选区被替换）；
   * - 无光标信息 → 追加末尾（非空正文前补换行，占位符独立成行）。
   * 提交走 promptBody 字段通道（8000 截断入口沿 store）。
   */
  function insertIntoPromptBody(text: string): void {
    const current = record?.promptBody
    if (!record || current === undefined || current.includes(text)) return
    let next: string
    let caret: number | null = null
    const el = promptTextarea
    if (el && promptFocusedOnce && typeof el.selectionStart === 'number') {
      const start = el.selectionStart
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : start
      next = current.slice(0, start) + text + current.slice(end)
      caret = start + text.length
    } else {
      next = current === '' ? text : `${current.replace(/\n$/, '')}\n${text}`
      caret = null
    }
    submitTemplateField(templateAssetId, { promptBody: next })
    if (el && caret !== null) {
      // 光标恢复到插入内容之后（连续插入位）；受控 value 更新后落位
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = caret as number
      })
    }
  }
</script>

{#if record}
  <div class="grid grid-cols-1 gap-2" data-testid="template-editor">
    <div class="flex items-center gap-2">
      <Input
        class="h-8 flex-1 text-xs font-medium"
        value={record.name}
        onchange={(e) => submitTemplateField(templateAssetId, { name: e.currentTarget.value })}
        aria-label="模板名称"
        placeholder="模板名称"
        data-testid="template-name-input"
      />
      <label class="text-muted-foreground flex items-center gap-1 text-xs">
        候选
        <Input
          class="h-8 w-14 font-mono tabular-nums"
          type="number"
          min="1"
          max="8"
          value={record.candidates}
          onchange={(e) => submitTemplateField(templateAssetId, { candidates: Number(e.currentTarget.value) })}
          aria-label="候选数"
          data-testid="template-candidates-input"
        />
      </label>
    </div>
    <Textarea
      class="field-sizing-content text-muted-foreground min-h-24 max-h-64 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
      placeholder="主提示词正文（可插入【案例参照图提示词】【水钻参数提示词】【蓝图效果提示词】占位符——各效果铅笔按钮内可插入）…"
      value={record.promptBody}
      onchange={(e) => submitTemplateField(templateAssetId, { promptBody: e.currentTarget.value })}
      aria-label="生成指令"
      data-testid="template-prompt-textarea"
      bind:ref={promptTextarea}
      onfocus={() => (promptFocusedOnce = true)}
    ></Textarea>
    <!-- 高级选项区（案例参照图开关+选图面 / 水钻参数配置 / 蓝图 beta + 效果提示词铅笔） -->
    <div class="border-t pt-2">
      <TemplateAdvancedOptions {templateAssetId} {insertIntoPromptBody} />
    </div>
    {#if record.saving}
      <p class="text-muted-foreground text-[11px]" data-testid="template-saving">保存中…</p>
    {:else if record.lastError}
      <p class="text-destructive text-[11px]" data-testid="template-save-error" role="alert">保存失败：{record.lastError}</p>
    {/if}
  </div>
{:else}
  <p class="text-muted-foreground text-xs" data-testid="template-editor-missing">模板不存在或已从模板库移除。</p>
{/if}
