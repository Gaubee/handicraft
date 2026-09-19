<!--
TemplateEditor.svelte——可嵌入的模板四件套编辑器（openspec add-project-files 4.3 抽出；
PRODUCT_MODEL v3 硬规则 7：模板编辑的唯一编辑器，双宿主 [实验室手风琴 Content / 素材库
RightSheet(4.3b)] 共用；编辑态真源 converge 到库资产 .gemtpl，宿主不持副本）。

本组件**不含宿主 chrome**（手风琴/抽屉/头部/关闭守卫均归宿主）：只渲染
名称 / 候选数 / 提示词体 textarea / 案例参照绑定（内嵌 EffectRefControl）四件套 +
高级选项区（内嵌 TemplateAdvancedOptions，[C3.1] 水钻参数配置/蓝图 beta 正交开关）+
字段提交（onchange/blur → templates store 写队列，B.1.2 自动换绑）+ 轻量保存态指示。

props 契约（冻结给 4.3b RightSheet 复用）：
- templateAssetId: string——唯一 prop；record 一律从共享 store 读取（$derived），
  宿主不得传入编辑副本（传入 = 漂移的开始，C.5.3）。
-->

<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import EffectRefControl from './EffectRefControl.svelte'
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
      placeholder="英文生成指令：仅重画值得贴钻的元素为纯色闭合形状，剔除天空/雪地/远景/人物，5-6 色，透明或纯白背景…"
      value={record.promptBody}
      onchange={(e) => submitTemplateField(templateAssetId, { promptBody: e.currentTarget.value })}
      aria-label="生成指令"
      data-testid="template-prompt-textarea"
    ></Textarea>
    <div class="border-t pt-2">
      <EffectRefControl templateAssetId={templateAssetId} caseBinding={record.caseBinding} />
    </div>
    <!-- [C3.1] 高级选项区（水钻参数配置 / 蓝图 beta）——双宿主同 record 互见，提交走 store validate 门 -->
    <div class="border-t pt-2">
      <TemplateAdvancedOptions templateAssetId={templateAssetId} />
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
