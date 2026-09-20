<!--
Orthogonal intents (max 3):
1. [2026-09-18 R2 PM-B1] 生成主行动条：sticky 吸底常驻；未配置 BYOK 时按钮变「配置连接」
     直开设置 Dialog（冷启动一步直达），startRun 校验保留为兜底；runError 内联到按钮旁（反馈不错位）。
2. [2026-09-18 计划数] plannedCount 与变体区摘要共享口径：×N 可核对（每个「变体×候选」= 一次请求）。
3. [2026-09-20 C3.2] 发起面板最小面（design §6.2/§4.3）：run 级蓝图策略单选（仅当启用蓝图的
     模板在列时显示；默认串行 B，并行实验 A 明示随机性；策略不入模板——快照进任务）+
     高级选项汇总 chips（只读；钻清单不可在此编辑，canonical 唯一归模板编辑器）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import HelpTip from '../HelpTip.svelte'
  import {
    cancelAll,
    getForm,
    getSettings,
    hasReference,
    isBusy,
    startRun,
    updateForm,
  } from '$lib/stores/lab.svelte'
  import { getUsableTemplates } from '$lib/stores/templates.svelte'
  import { caseRefEnabledOf } from '$lib/lab/advancedOptions'
  import { EFFECT_PROMPT_PLACEHOLDERS, hasEffectPromptPlaceholder } from '$lib/lab/prompt'
  import { openSettings } from '$lib/stores/settingsDialog.svelte'
  import Sparkles from '@lucide/svelte/icons/sparkles'
  import Ban from '@lucide/svelte/icons/ban'
  import Settings2 from '@lucide/svelte/icons/settings-2'

  const settings = $derived(getSettings())
  const form = $derived(getForm())

  let runError = $state('')

  const configured = $derived(
    settings.baseUrl.trim() !== '' && settings.apiKey.trim() !== '' && settings.model.trim() !== '',
  )
  // [4.3] 计划数口径与模板区摘要共享（templates store 的可用模板：启用 × 非空提示词 × 候选 ≥1）
  const usableTemplates = $derived(getUsableTemplates())
  const plannedCount = $derived(usableTemplates.reduce((sum, t) => sum + t.candidates, 0))

  // [C3.2] 高级选项汇总（只读 chips 口径；策略选择器的显隐键 = 启用蓝图的可用模板数）
  const blueprintTemplateCount = $derived(usableTemplates.filter((t) => t.blueprint?.enabled === true).length)
  const drillTemplateCount = $derived(usableTemplates.filter((t) => t.drillParams?.enabled === true).length)

  // [placeholders] 「开关开而主提示词缺占位符」派生提示（design §4：一次性=非阻断派生 Hint，
  // 条件消除即消失——不弹重复 toast、不阻断发起；正文不注入的可见信号）
  const placeholderHints = $derived.by(() => {
    const out: string[] = []
    for (const t of usableTemplates) {
      const name = t.name || '未命名模板'
      if (
        caseRefEnabledOf(t.caseRef, t.caseBinding) &&
        t.caseBinding !== null &&
        !hasEffectPromptPlaceholder(t.promptBody, 'caseRef')
      ) {
        out.push(`「${name}」案例参照图已开启但主提示词缺少 ${EFFECT_PROMPT_PLACEHOLDERS.caseRef}`)
      }
      if (t.drillParams?.enabled === true && !hasEffectPromptPlaceholder(t.promptBody, 'drillParams')) {
        out.push(`「${name}」水钻参数配置已开启但主提示词缺少 ${EFFECT_PROMPT_PLACEHOLDERS.drillParams}`)
      }
      if (t.blueprint?.enabled === true && !hasEffectPromptPlaceholder(t.promptBody, 'blueprint')) {
        out.push(`「${name}」蓝图效果已开启但主提示词缺少 ${EFFECT_PROMPT_PLACEHOLDERS.blueprint}`)
      }
    }
    return out
  })

  function setStrategy(value: 'serial' | 'parallel'): void {
    updateForm({ blueprintStrategy: value })
  }

  function handleRun(): void {
    runError = ''
    const result = startRun()
    if (!result.ok) runError = result.error ?? '发起失败'
  }
</script>

<div class="grid gap-2" data-testid="run-bar">
  {#if configured}
    {#if blueprintTemplateCount > 0}
      <!-- 蓝图策略（run 级单选；模板只存开关不锁策略——design §4.3） -->
      <fieldset class="grid gap-1" data-testid="blueprint-strategy">
        <legend class="flex items-center gap-1 text-xs font-medium">
          蓝图策略
          <Badge variant="outline" class="text-[10px]">Beta</Badge>
          <HelpTip
            label="蓝图策略说明"
            text="串行：先生成成品效果图，再连同原图与钻素材一起请求蓝图（更可靠）。并行：与成品图同时生成，省一跳但两者排布一致性不可证、随机性大。"
          />
        </legend>
        <div class="flex flex-wrap gap-x-3 gap-y-1">
          <label class="flex cursor-pointer items-center gap-1 text-xs" data-testid="blueprint-strategy-serial">
            <input
              type="radio"
              name="blueprint-strategy"
              class="accent-primary"
              checked={form.blueprintStrategy === 'serial'}
              onchange={() => setStrategy('serial')}
            />
            串行（推荐）
          </label>
          <label class="flex cursor-pointer items-center gap-1 text-xs" data-testid="blueprint-strategy-parallel">
            <input
              type="radio"
              name="blueprint-strategy"
              class="accent-primary"
              checked={form.blueprintStrategy === 'parallel'}
              onchange={() => setStrategy('parallel')}
            />
            并行实验
          </label>
        </div>
        {#if form.blueprintStrategy === 'parallel'}
          <p class="text-muted-foreground text-[11px]" data-testid="blueprint-strategy-hint">
            同生模式随机性大：蓝图与成品图排布一致性不可证，仅供实验对比。
          </p>
        {/if}
      </fieldset>
    {/if}

    {#if drillTemplateCount > 0 || blueprintTemplateCount > 0}
      <!-- 高级选项汇总 chips（只读；编辑归模板编辑器——One Concept → One Canonical Location） -->
      <div class="flex flex-wrap gap-1" data-testid="advanced-chips">
        {#if drillTemplateCount > 0}
          <Badge variant="secondary" class="text-[10px]" title="本次将按模板钻清单经占位符拼接【尺寸与钻规格】段">
            水钻参数 × {drillTemplateCount}
          </Badge>
        {/if}
        {#if blueprintTemplateCount > 0}
          <Badge variant="secondary" class="text-[10px]" title="本次将追加蓝图生成（策略见上）">
            蓝图 × {blueprintTemplateCount}
          </Badge>
        {/if}
      </div>
    {/if}

    {#if placeholderHints.length > 0}
      <!-- [placeholders] 开关开而占位符缺失：非阻断提示（正文不注入的可见信号；条件消除即消失） -->
      <div
        class="text-muted-foreground grid gap-0.5 rounded-md border border-dashed px-3 py-2 text-[11px] leading-snug"
        data-testid="placeholder-missing-hint"
      >
        {#each placeholderHints as hint (hint)}
          <p>{hint}——该效果正文不会进入本次提示词（在模板的铅笔按钮里可插入占位符）。</p>
        {/each}
      </div>
    {/if}

    <div class="flex items-center gap-2">
      <Button
        class="flex-1"
        onclick={handleRun}
        disabled={plannedCount === 0}
        data-testid="run-button"
      >
        <Sparkles />
        {hasReference() ? `开始生成（edits）× ${plannedCount}` : `开始生成（generations）× ${plannedCount}`}
      </Button>
      {#if isBusy()}
        <Button variant="outline" onclick={() => cancelAll()} title="取消全部进行中的任务">
          <Ban />
          取消全部
        </Button>
      {/if}
    </div>
  {:else}
    <div class="flex flex-col gap-1.5">
      <Button class="w-full" onclick={openSettings} data-testid="run-button">
        <Settings2 />
        配置连接
      </Button>
      <p class="text-muted-foreground text-center text-xs">
        尚未配置 Base URL / API Key / 模型 —— 完成配置后即可生成
      </p>
    </div>
  {/if}

  {#if runError}
    <p
      class="text-destructive rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs"
      data-testid="run-error"
      role="alert"
    >
      {runError}
    </p>
  {/if}
</div>
