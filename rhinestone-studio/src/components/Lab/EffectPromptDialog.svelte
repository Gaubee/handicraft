<!--
EffectPromptDialog.svelte——效果提示词共享 Dialog（openspec add-lab-effect-prompt-placeholders
design §4；Owner 2026-09-20 原话交互：铅笔 icon button 入口 → Dialog 带 textarea + actions）。

三正交效果（案例参照图 / 水钻参数配置 / 蓝图效果）共用本组件：
- textarea 预填**自动生成文案**（autoText——按当前模板配置尽力生成的预览口径，发起时按
  实际任务上下文物化）或用户覆盖文本（currentFragment !== undefined 时）；
- actions 三件：保存（存覆盖 / 空文本 = 清除覆盖回 auto）/ 取消（丢弃）/ 插入到提示词
  （保存片段 + 向主提示词插入占位符——幂等与光标位归宿主回调，本组件只触发）。

编辑态真源 = templates store record（本组件持 draft 缓冲，提交即整体替换覆盖键）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import HelpTip from '../HelpTip.svelte'
  import FileInput from '@lucide/svelte/icons/file-input'

  let {
    open = $bindable(false),
    /** 效果名（标题用，如「案例参照图」）。 */
    effectTitle,
    /** 自动生成文案（预览口径——缺席效果配置时可为空串）。 */
    autoText,
    /** 用户覆盖文本（undefined = 当前为 auto 态）。 */
    currentFragment,
    /** 占位符字面量（插入动作 + 已存在提示）。 */
    placeholderLiteral,
    /** 主提示词已含占位符（插入幂等的可见反馈）。 */
    placeholderAlreadyPresent,
    /** 保存片段（undefined = 清除覆盖回 auto）。 */
    onSave,
    /** 插入到提示词（幂等 + 光标位归宿主）。 */
    onInsert,
  }: {
    open?: boolean
    effectTitle: string
    autoText: string
    currentFragment: string | undefined
    placeholderLiteral: string
    placeholderAlreadyPresent: boolean
    onSave: (fragment: string | undefined) => void
    onInsert: () => void
  } = $props()

  let draft = $state('')

  // 打开时重置 draft：覆盖态回显覆盖文本，auto 态预填自动文案（可编辑后保存为覆盖）
  $effect(() => {
    if (open) draft = currentFragment ?? autoText
  })

  const isOverride = $derived(currentFragment !== undefined)

  /** 保存语义：空文本 = 清除覆盖（回 auto）；非空 = 存覆盖。 */
  function commitFragment(): string | undefined {
    return draft.trim() === '' ? undefined : draft
  }

  function handleSave(): void {
    onSave(commitFragment())
    open = false
  }

  function handleCancel(): void {
    open = false // 丢弃 draft（record 未动）
  }

  function handleInsert(): void {
    const fragment = commitFragment()
    onSave(fragment)
    onInsert() // 幂等：已存在不重复插入（宿主保证）
    open = false
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="max-w-xl">
    <Dialog.Header>
      <Dialog.Title class="text-sm">效果提示词 · {effectTitle}</Dialog.Title>
      <Dialog.Description>
        发起生成时，主提示词中的 {placeholderLiteral} 会被下方文本原文替换（效果关闭时占位符原样保留）。
      </Dialog.Description>
    </Dialog.Header>

    <div class="grid gap-1.5">
      <div class="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px]">
        <span data-testid="effect-prompt-mode">{isOverride ? '当前：自定义覆盖' : '当前：自动生成（预览）'}</span>
        <span>·</span>
        <span>留空保存 = 恢复自动生成</span>
        <HelpTip
          label="效果提示词说明"
          text="自动文案按当前模板配置生成，发起时按实际附图与任务上下文重新物化；编辑保存后为覆盖文本，逐字节进入提示词。"
        />
      </div>
      <Textarea
        class="field-sizing-content min-h-40 max-h-72 w-full min-w-0 overflow-y-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
        bind:value={draft}
        aria-label="{effectTitle}效果提示词"
        data-testid="effect-prompt-textarea"
      ></Textarea>
      {#if placeholderAlreadyPresent}
        <p class="text-muted-foreground text-[11px]" data-testid="effect-prompt-placeholder-present">
          主提示词已含 {placeholderLiteral}——不会重复插入。
        </p>
      {/if}
    </div>

    <Dialog.Footer class="gap-1.5">
      <Button variant="ghost" size="sm" onclick={handleCancel} data-testid="effect-prompt-cancel">取消</Button>
      <Button variant="outline" size="sm" onclick={handleSave} data-testid="effect-prompt-save">保存</Button>
      <Button size="sm" onclick={handleInsert} data-testid="effect-prompt-insert">
        <FileInput />
        插入到提示词
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
