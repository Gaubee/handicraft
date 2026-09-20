<!--
TemplateEditor.svelte——可嵌入的模板四件套编辑器（openspec add-project-files 4.3 抽出；
PRODUCT_MODEL v3 硬规则 7：模板编辑的唯一编辑器，双宿主 [实验室手风琴 Content / 素材库
RightSheet(4.3b)] 共用；编辑态真源 converge 到库资产 .gemtpl，宿主不持副本）。

本组件**不含宿主 chrome**（手风琴/抽屉/头部/关闭守卫均归宿主）：只渲染
名称 / 候选数 / 提示词体 textarea（[lab-ux 2] 效果占位符由高级选项区的效果开关开/关自动
插入/移除——无需手动插入入口；用户可在正文中自由移动占位符文本）/
高级选项区（内嵌 TemplateAdvancedOptions：案例参照图开关+选图面 / 水钻参数配置 / 蓝图 beta
+ 每开关的效果提示词 icon 入口）+ 字段提交（onchange/blur → templates store 写队列，B.1.2
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
      placeholder="主提示词正文（开启效果开关会自动插入【案例参照图提示词】【水钻参数提示词】【蓝图效果提示词】占位符，可在正文中自由移动）…"
      value={record.promptBody}
      onchange={(e) => submitTemplateField(templateAssetId, { promptBody: e.currentTarget.value })}
      aria-label="生成指令"
      data-testid="template-prompt-textarea"
    ></Textarea>
    <!-- 高级选项区（案例参照图开关+选图面 / 水钻参数配置 / 蓝图 beta + 效果提示词 icon 入口） -->
    <div class="border-t pt-2">
      <TemplateAdvancedOptions {templateAssetId} />
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
