/*
 * [P0 批准唤醒可见性 θ 前端接线，2026-10-01] 系统续跑通知帧解析（单源）。
 * daemon wakeForApproval（task done 分支）在**原任务**帧流上补一条 transcript
 * user 帧（writer-fence 放行非 cancelled 帧——用户此刻订阅的正是原任务）：
 *   text: `系统续跑已开启（新任务 ${wakeTaskId}）——已批准审批 ${proposalId} 的后续执行在该任务中进行`
 * 前端两个消费面共用本解析（防两处正则漂移）：
 *   [1] store.ingestFrame：解析出新 taskId → 登记 activeTasks+replay+subscribe
 *       （服务端发起的续跑轮立即可见——此前只订阅客户端自开任务）。
 *   [2] transcript.projectFrames：该帧渲染为 status 行（系统通知非用户原话——
 *       不进用户气泡）。
 * daemon 帧格式为契约面（engine 零碰）：本模块只做宽容解析（前缀+全角括号
 *锚定；taskId 取非空连续段），文本微调不致前端失联。
 */

/** 续跑通知前缀（daemon kernel/index.ts wakeForApproval 字面）。 */
const RESUME_RUN_PREFIX = '系统续跑已开启（新任务 '

/**
 * 解析系统续跑通知帧文本 → 新任务 id（非通知帧返回 null）。
 * 宽容边界：新任务 id 取「（新任务 」后到首个「）」前的连续非空段——daemon
 * 侧 taskId 形如 `task-<uuid>`（无括号字符），截断容错面向文本微调而非改格式。
 */
export function parseResumeRunNotice(text: string): string | null {
  if (!text.startsWith(RESUME_RUN_PREFIX)) return null
  const rest = text.slice(RESUME_RUN_PREFIX.length)
  const end = rest.indexOf('）')
  if (end <= 0) return null
  const taskId = rest.slice(0, end).trim()
  return taskId.length > 0 ? taskId : null
}

/** 续跑通知的用户可见文案（status 行——原帧文本含裸 taskId/proposalId，入行降噪）。 */
export function resumeRunStatusLabel(): string {
  return '批准已生效——续跑任务已开启，后续执行将自动进行'
}
