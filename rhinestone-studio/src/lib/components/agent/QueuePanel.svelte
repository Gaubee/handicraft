<!--
QueuePanel.svelte — 投递队列面板（add-agent-three-channel 2.3，对齐 shufa W10c
b6cec8a/eb125a1 手风琴形态）：composer 上方紧贴长出的抽屉——收起=预览条（条数+
下一条文本），展开=完整列表。行=模式徽标+单行文本+actions（编辑/删除/立刻发送位）。
贴钻队列=前端持有外环（后端无 inbox RPC 面）：读/删/编辑为本地真源操作；「立刻发送」
与拖动排序依赖 shufa W10e/W10c 的 queueSendNow/queueReorder 端点——后端待补，UI
位保留禁用态（不做旁路）。
-->
<script lang="ts">
  import { slide } from 'svelte/transition'
  import ChevronDown from '@lucide/svelte/icons/chevron-down'
  import Pencil from '@lucide/svelte/icons/pencil'
  import SendHorizontal from '@lucide/svelte/icons/send-horizontal'
  import Trash2 from '@lucide/svelte/icons/trash-2'
  import type { AgentQueueItem } from '$lib/agentApi/store.svelte'

  let {
    items,
    editingId = null,
    onedit,
    oncancel,
    onremove,
    onclear,
  }: {
    items: AgentQueueItem[]
    /** 暂离编辑中的条目 id（null=非编辑态）。 */
    editingId?: string | null
    onedit: (id: string) => void
    oncancel: () => void
    onremove: (id: string) => void
    onclear: () => void
  } = $props()

  const MODE_LABEL: Record<AgentQueueItem['mode'], string> = {
    queue: '排队',
    steer: '引导',
    inject: '注入',
  }

  let open = $state(false)
</script>

{#if items.length > 0 || editingId !== null}
  <div
    class="mb-2 overflow-hidden rounded-t-lg border border-b-0 border-border bg-muted/40"
    data-testid="agent-queue-panel"
  >
    <!-- 手风琴头（W10c）：收起=预览（条数+下一条文本）；展开=完整列表。 -->
    <button
      type="button"
      class="flex w-full items-center gap-1.5 px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70"
      data-testid="agent-queue-toggle"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >
      <ChevronDown class="size-3 shrink-0 transition-transform {open ? '' : '-rotate-90'}" aria-hidden="true" />
      <span>投递队列（{items.length}）</span>
      {#if editingId !== null}
        <span class="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-600">编辑中（自动开跑已暂停）</span>
        <span class="flex-1"></span>
        <span
          role="button"
          tabindex="0"
          class="rounded px-1.5 py-0.5 text-[10px] text-amber-600 underline underline-offset-2 hover:bg-amber-500/10"
          data-testid="agent-queue-cancel-edit"
          onclick={(event) => {
            event.stopPropagation()
            oncancel()
          }}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.stopPropagation()
              oncancel()
            }
          }}
        >
          取消编辑
        </span>
      {:else if items.length > 0}
        <span class="min-w-0 flex-1 truncate text-muted-foreground/70" data-testid="agent-queue-preview">
          下一条：{items[0]?.text}
        </span>
      {:else}
        <span class="flex-1"></span>
      {/if}
    </button>

    {#if open}
      <div class="border-t border-border/60 px-2 py-1.5" transition:slide={{ duration: 140 }}>
        <p class="flex items-center gap-2 px-0.5 pb-1 text-[10px] text-muted-foreground/60">
          <span>逐条生效 · 当前轮结束（含打断）后自动开跑</span>
          <span class="flex-1"></span>
          <button
            type="button"
            class="rounded px-1 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-40"
            data-testid="agent-queue-clear"
            disabled={items.length === 0}
            onclick={onclear}
          >
            清空
          </button>
        </p>
        <ul class="flex flex-col gap-1">
          {#each items as item (item.id)}
            <li
              class="flex items-center gap-2 rounded border border-border/60 bg-card px-2 py-1 text-[12px] {item.id === editingId ? 'border-amber-500/50 bg-amber-500/5' : ''}"
              data-testid="agent-queue-item"
              data-queue-id={item.id}
            >
              <span
                class="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] {item.mode === 'queue'
                  ? 'bg-primary/10 text-primary'
                  : item.mode === 'steer'
                    ? 'bg-amber-500/15 text-amber-600'
                    : 'bg-violet-500/15 text-violet-600'}"
                title={item.mode === 'queue' ? '当前轮结束后自动开跑' : item.mode === 'steer' ? '下一 step 边界影响当前轮' : '注入上下文（不作为对话轮）'}
              >
                {MODE_LABEL[item.mode]}
              </span>
              <span class="text-foreground/90 min-w-0 flex-1 truncate" title={item.text}>{item.text}</span>
              <!-- 编辑：该条暂离冻结+文本回填 composer（W10b 暂离编辑——前端持有外环的本地形态）。 -->
              <button
                type="button"
                class="text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30 shrink-0 rounded p-1"
                data-testid="agent-queue-edit"
                title="编辑（文本回输入框，编辑期间自动开跑暂停）"
                aria-label="编辑该消息"
                disabled={editingId !== null && editingId !== item.id}
                onclick={() => onedit(item.id)}
              >
                <Pencil class="size-3" />
              </button>
              <!-- 立刻发送（W10e 位）：依赖 queueSendNow 端点——后端待补，禁用占位（不做旁路）。 -->
              <button
                type="button"
                class="text-muted-foreground shrink-0 rounded p-1 disabled:cursor-not-allowed disabled:opacity-30"
                data-testid="agent-queue-sendnow"
                title="立刻发送——后端待补（对齐 shufa W10e queueSendNow：提队头+打断开轮），暂不可用"
                aria-label="立刻发送（后端待补）"
                disabled
              >
                <SendHorizontal class="size-3" />
              </button>
              <button
                type="button"
                class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive shrink-0 rounded p-1"
                data-testid="agent-queue-remove"
                title="从队列删除"
                aria-label="删除该消息"
                onclick={() => onremove(item.id)}
              >
                <Trash2 class="size-3" />
              </button>
            </li>
          {/each}
        </ul>
        <p class="px-0.5 pt-1 text-[10px] text-muted-foreground/50">拖动排序后端待补（shufa W10c queueReorder 对齐位）</p>
      </div>
    {/if}
  </div>
{/if}
