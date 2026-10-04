<!--
  [unify-studio-routing sweep ⑥ 测试宿主] TaskDetailPanel 重绑驱动面：面板在 AgentView
  绑 activeTask.taskId（prop 随新 followup 任务漂移）——jsdom 直挂组件无法改 prop，
  本宿主持 $state 并导出 rebind()（Svelte 5 mount 返回组件 exports——测试可编程换绑）。
-->
<script lang="ts">
  import TaskDetailPanel from '$lib/components/agent/TaskDetailPanel.svelte'

  let taskId = $state('')

  export function rebind(next: string): void {
    taskId = next
  }
</script>

{#if taskId !== ''}
  <TaskDetailPanel {taskId} />
{/if}
