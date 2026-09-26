<!--
TaskDetailPanel.svelte — 任务详情轻量面板（add-workbench-pro 1.3，zhumo 模式）。
装载：复用 task.detail RPC 客户端（getBoundAgentApi——与排钻工作台同通道）；预览
缩略图经 taskArtifact 附件通道（strategy-gems-preview.png 优先，服务端已兜底）拉
dataUrl。呈现：任务标题/状态徽章/gems 计数/预览缩略/图层摘要（只读行——名字+
策略徽标+眼睛显隐切换仅视觉）。轻量呈现——不做编辑（拆层/策略直改在排钻工作台，
动作区「打开完整工作台」直达）。
单实例：桌面第三栏与移动 Sheet 经 AgentView 的同一 snippet 渲染（zhumo 先例——
同一时刻只挂一份，SessionStream/Composer 不双挂）。
-->

<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { getBoundAgentApi } from '$lib/agentApi/store.svelte'
  import { openStudioTask } from '$lib/stores/view.svelte'
  import type { ObjectNode, StrategyAssignment, TaskDetailResponse } from '@handicraft/contracts'
  import ExternalLink from '@lucide/svelte/icons/external-link'
  import Eye from '@lucide/svelte/icons/eye'
  import EyeOff from '@lucide/svelte/icons/eye-off'
  import MessageCircle from '@lucide/svelte/icons/message-circle'

  let {
    taskId,
    onBackToChat,
  }: {
    /** 活跃会话最新任务（followup 进行中跟随切换）。 */
    taskId: string
    /** 「继续对话」：回对话栏（AgentView 聚焦输入框/移动端收抽屉）。 */
    onBackToChat: () => void
  } = $props()

  const statusLabel: Record<string, string> = {
    queued: '排队中',
    running: '进行中',
    done: '已完成',
    failed: '失败',
    cancelled: '已取消',
  }

  type Phase = 'loading' | 'error' | 'ready'
  let phase = $state<Phase>('loading')
  let loadError = $state<string | null>(null)
  let detail = $state<TaskDetailResponse | null>(null)
  let previewUrl = $state<string | null>(null)
  /** 逐节点显隐——仅视觉（行划线/眼睛图标切换），不影响数据与预览渲染。 */
  let hiddenNodes = $state<ReadonlySet<string>>(new Set())

  let loadSeq = 0

  async function load(id: string): Promise<void> {
    const seq = ++loadSeq
    phase = 'loading'
    loadError = null
    try {
      const client = getBoundAgentApi()
      if (client === null) throw new Error('Agent API 未绑定——任务详情通道不可用')
      const response = await client.taskDetail(id)
      let nextPreview: string | null = null
      if (response.preview !== null) {
        try {
          const artifact = await client.taskArtifact({ taskId: id, blobRef: response.preview.blobRef })
          nextPreview = `data:${artifact.mime};base64,${artifact.dataBase64}`
        } catch {
          // 预览是辅助面——附件拉取失败降级占位（尚无预览图），不拖垮详情主体。
          nextPreview = null
        }
      }
      if (seq !== loadSeq) return
      detail = response
      previewUrl = nextPreview
      phase = 'ready'
    } catch (error) {
      if (seq !== loadSeq) return
      loadError = error instanceof Error ? error.message : String(error)
      phase = 'error'
    }
  }

  // taskId 变化（切会话/followup 新任务）→ 重新装载并复位逐层显隐（loadSeq 作废迟到结果）。
  $effect(() => {
    const id = taskId
    hiddenNodes = new Set()
    void load(id)
  })

  interface LayerRow {
    node: ObjectNode
    depth: number
    assignment: StrategyAssignment | null
  }

  /** 图层树行集（DFS 先序——根=画布在前；树形与工作台 getWorkbenchLayerRows 同式）。 */
  const layerRows = $derived.by<LayerRow[]>(() => {
    const nodes = detail?.tree?.nodes ?? []
    if (nodes.length === 0) return []
    const byId = new Map(nodes.map((node) => [node.id, node] as const))
    const assignmentById = new Map((detail?.assignments ?? []).map((a) => [a.nodeId, a] as const))
    const rows: LayerRow[] = []
    const walk = (id: string, depth: number): void => {
      const node = byId.get(id)
      if (node === undefined) return
      rows.push({ node, depth, assignment: assignmentById.get(id) ?? null })
      for (const child of node.children) walk(child, depth + 1)
    }
    const root = nodes.find((node) => node.parent === null)
    if (root !== undefined) walk(root.id, 0)
    else for (const node of nodes) walk(node.id, 0)
    return rows
  })

  function kindBadgeVariant(assignment: StrategyAssignment | null): 'secondary' | 'outline' | 'destructive' {
    if (assignment === null) return 'outline'
    if (assignment.strategyKind === 'exclusion') return 'destructive'
    return 'secondary'
  }

  function kindLabel(row: LayerRow): string {
    if (row.assignment !== null) return row.assignment.strategyKind
    return row.node.children.length > 0 ? '层级' : '未指派'
  }

  function statusBadgeVariant(status: string): 'default' | 'secondary' | 'outline' | 'destructive' {
    if (status === 'failed') return 'destructive'
    if (status === 'running' || status === 'queued') return 'default'
    return 'outline'
  }

  function toggleVisible(nodeId: string): void {
    const next = new Set(hiddenNodes)
    if (next.has(nodeId)) next.delete(nodeId)
    else next.add(nodeId)
    hiddenNodes = next
  }
</script>

<div class="bg-background flex h-full min-h-0 flex-col" data-testid="task-detail-panel">
  <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
    <span class="text-xs font-semibold">任务详情</span>
    {#if detail !== null}
      <span class="text-muted-foreground ml-auto font-mono text-[10px]" data-testid="task-detail-layer-count">
        {layerRows.length} 层
      </span>
    {/if}
  </div>

  <div class="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
    {#if phase === 'loading'}
      <p class="text-muted-foreground py-8 text-center text-xs" data-testid="task-detail-loading">正在装载任务详情…</p>
    {:else if phase === 'error'}
      <div
        class="border-destructive/40 bg-destructive/5 space-y-2 rounded-lg border p-3 text-xs"
        data-testid="task-detail-error"
        role="alert"
      >
        <p class="text-destructive leading-relaxed">详情装载失败：{loadError}</p>
        <button
          type="button"
          onclick={() => void load(taskId)}
          class="border-destructive/40 hover:bg-destructive/10 text-destructive rounded border px-2 py-0.5 font-medium transition-colors"
          data-testid="task-detail-retry"
        >
          重试
        </button>
      </div>
    {:else if detail !== null}
      <!-- 标题 + 状态徽章 -->
      <div class="flex items-center gap-2">
        <h3 class="min-w-0 flex-1 truncate text-sm font-medium" title={detail.task.title ?? ''} data-testid="task-detail-title">
          {detail.task.title ?? '（未命名任务）'}
        </h3>
        <Badge variant={statusBadgeVariant(detail.task.status)} class="shrink-0 text-[10px]" data-testid="task-detail-status">
          {statusLabel[detail.task.status] ?? detail.task.status}
        </Badge>
      </div>

      <!-- gems 计数（尚无排钻产物=占位说明） -->
      {#if detail.gems !== null}
        <p class="text-muted-foreground text-xs" data-testid="task-detail-gems">
          <span class="text-foreground font-medium">{detail.gems.count}</span> 颗钻 · 留白区 {detail.gems.excludedRegions}
        </p>
      {:else}
        <p class="text-muted-foreground text-xs" data-testid="task-detail-gems">尚无排钻产物——策略执行完成后出现在这里</p>
      {/if}

      <!-- 预览缩略图（附件通道 dataUrl） -->
      {#if previewUrl !== null}
        <img
          src={previewUrl}
          alt="排钻预览"
          class="bg-muted/40 max-h-72 w-full rounded-lg border object-contain"
          data-testid="task-detail-preview"
        />
      {:else}
        <div class="text-muted-foreground flex h-32 items-center justify-center rounded-lg border border-dashed text-xs" data-testid="task-detail-preview-empty">
          尚无预览图
        </div>
      {/if}

      <!-- 图层摘要（只读行：名字+策略徽标+眼睛显隐切换仅视觉） -->
      <div class="rounded-lg border">
        <p class="text-muted-foreground border-b px-2.5 py-1.5 text-[11px] font-medium">图层摘要（只读——编辑请打开完整工作台）</p>
        {#if layerRows.length === 0}
          <p class="text-muted-foreground px-2.5 py-3 text-center text-[11px]" data-testid="task-detail-layer-empty">
            尚无图层树——先在对话完成识图抠图
          </p>
        {:else}
          <div class="p-1">
            {#each layerRows as row (row.node.id)}
              <div
                class="flex items-center gap-1.5 rounded-md px-1 py-1"
                style="padding-left: {4 + row.depth * 12}px"
                data-testid="task-detail-layer-row"
                data-node-id={row.node.id}
              >
                <span class="min-w-0 flex-1 truncate text-xs {hiddenNodes.has(row.node.id) ? 'text-muted-foreground line-through opacity-60' : ''}">
                  {row.node.objectName}
                </span>
                <Badge variant={kindBadgeVariant(row.assignment)} class="shrink-0 px-1.5 text-[10px]">
                  {kindLabel(row)}
                </Badge>
                <button
                  type="button"
                  onclick={() => toggleVisible(row.node.id)}
                  class="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5"
                  data-testid="task-detail-layer-visible-{row.node.id}"
                  aria-label={hiddenNodes.has(row.node.id) ? `显示 ${row.node.objectName}` : `隐藏 ${row.node.objectName}`}
                  aria-pressed={!hiddenNodes.has(row.node.id)}
                  title={hiddenNodes.has(row.node.id) ? '点击显示该层（仅视觉）' : '点击隐藏该层（仅视觉）'}
                >
                  {#if hiddenNodes.has(row.node.id)}
                    <EyeOff class="size-3.5 opacity-50" aria-hidden="true" />
                  {:else}
                    <Eye class="size-3.5" aria-hidden="true" />
                  {/if}
                </button>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- 动作区（taskId 直达——装载失败也可进完整工作台，其内有独立错误面） -->
  <div class="flex shrink-0 gap-2 border-t p-2.5">
    <Button size="sm" class="min-w-0 flex-1" onclick={() => openStudioTask(taskId)} data-testid="task-detail-open-workbench">
      <ExternalLink class="size-3.5" aria-hidden="true" />
      打开完整工作台
    </Button>
    <Button size="sm" variant="outline" class="min-w-0 flex-1" onclick={onBackToChat} data-testid="task-detail-back-chat">
      <MessageCircle class="size-3.5" aria-hidden="true" />
      继续对话
    </Button>
  </div>
</div>
