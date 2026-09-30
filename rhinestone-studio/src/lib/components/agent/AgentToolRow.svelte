<!--
  工具调用行（zhumo 对照清单 T1 2026-09-28：默认紧凑单行，点开才展开）：
  - 紧凑态 = 工具名标签行（text-[11px] font-medium text-muted-foreground）+ 单行摘要卡
    （.tool-card mt-0.5 px-2 py-1.5，truncate——结果摘要单行截断或「（无输出）」，约 31px 高）。
    参数 JSON 严禁默认平铺（走查实拍：几百 px 大卡 + 撑出横向滚动）。
  - 点开才渲染展开卡（.tool-card mt-1 max-h-64 space-y-1 overflow-y-auto p-2）：
    「调用参数：」「结果：」两段 whitespace-pre-wrap break-all（长行硬断——不再撑宽滚动容器）。
  - running（等待结果）= 摘要卡扫光（无可展开内容，不可点）。
-->
<script lang="ts">
  let {
    toolName,
    argsText = '',
    result = null,
    running = false,
  }: {
    toolName: string
    argsText?: string
    result?: string | null
    running?: boolean
  } = $props()

  let open = $state(false)

  /** 单行摘要：结果 ?? 参数 ?? 空态文案。 */
  const summary = $derived(result ?? argsText ?? '')
</script>

<div class="flow-item">
  <div class="px-1">
    <button
      type="button"
      class="block w-full cursor-pointer rounded-md text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
      data-testid="agent-tool-row"
      aria-expanded={open}
      aria-label="工具调用 {toolName}（点开查看调用参数与完整结果）"
      title={running ? undefined : '点开查看调用参数与完整结果'}
      disabled={running}
      onclick={() => (open = !open)}
    >
      <span class="block text-[11px] font-medium text-muted-foreground">{toolName}</span>
      <span class="tool-card mt-0.5 block truncate px-2 py-1.5 {running ? 'sweep rounded-md' : ''}">
        {#if running}
          <span class="text-muted-foreground">调用中…</span>
        {:else if summary.length > 0}
          {summary}
        {:else}
          <span class="text-muted-foreground">（无输出）</span>
        {/if}
      </span>
    </button>
    {#if open && !running}
      <div class="tool-card mt-1 max-h-64 space-y-1 overflow-y-auto p-2" data-testid="agent-tool-detail">
        {#if argsText.length > 0}
          <div class="min-w-0">
            <span class="text-muted-foreground">调用参数：</span>
            <span class="break-all whitespace-pre-wrap">{argsText}</span>
          </div>
        {/if}
        {#if result !== null}
          <div class="min-w-0">
            <span class="text-muted-foreground">结果：</span>
            <span class="break-all whitespace-pre-wrap">{result}</span>
          </div>
        {/if}
      </div>
    {/if}
  </div>
</div>
