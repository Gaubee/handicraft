<!--
ConfirmDialog.svelte——破坏性动作确认弹窗公共件（[UX-B] 统一模式：删除类动作一律确认，
说清后果——软删可恢复 / 记录清除不可恢复等；确认才执行，禁止点一下立即删除）。

轻封装 Dialog：受控 open（$bindable）；标题/描述/按钮文案/busy 态由调用方注入；
data-testid 经 confirmTestId/cancelTestId 透传（测试选择器稳定）。放置决策同 ButtonBusy
先例——src/components/ 局部件，不进 src/lib/components/ui/（shadcn-svelte CLI 管理目录）。
-->

<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'

  let {
    open = $bindable(false),
    title,
    description = '',
    confirmLabel = '确认',
    cancelLabel = '取消',
    destructive = true,
    busy = false,
    confirmTestId,
    cancelTestId,
    onconfirm,
    oncancel,
  }: {
    open?: boolean
    title: string
    description?: string
    confirmLabel?: string
    cancelLabel?: string
    /** 破坏类（默认）：标题红字 + destructive 确认键；可恢复类用 false（普通确认键）。 */
    destructive?: boolean
    busy?: boolean
    confirmTestId?: string
    cancelTestId?: string
    onconfirm?: () => void
    /** Dialog 关闭（取消键/Escape/外点）——调用方清理待确认态。 */
    oncancel?: () => void
  } = $props()

  function requestClose(): void {
    open = false
    oncancel?.()
  }
</script>

<Dialog.Root bind:open={open} onOpenChange={(next) => !next && requestClose()}>
  <Dialog.Content class="max-w-sm">
    <Dialog.Header>
      <Dialog.Title class={destructive ? 'text-destructive' : undefined}>{title}</Dialog.Title>
      {#if description}
        <Dialog.Description>{description}</Dialog.Description>
      {/if}
    </Dialog.Header>
    <Dialog.Footer>
      <Button variant="ghost" size="sm" disabled={busy} onclick={requestClose} data-testid={cancelTestId}>
        {cancelLabel}
      </Button>
      <Button
        variant={destructive ? 'destructive' : 'default'}
        size="sm"
        disabled={busy}
        data-testid={confirmTestId}
        onclick={() => onconfirm?.()}
      >
        {busy ? '处理中…' : confirmLabel}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
