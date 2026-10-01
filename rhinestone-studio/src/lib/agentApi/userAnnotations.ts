/*
 * [w17-critic T1] 用户帧系统注记剥离：daemon followup 把机器注记追加进用户消息
 * 正文（kernel/index.ts 字面）：
 *   `[任务绑定 taskId=<id>——调用 studio.* 工具时 taskId 参数一律用这个值]`
 *   `[本消息附带 N 张图片（…）；主图集 imageId→blobRef 映射按输入顺序：…（含 blobRef 全串）]`
 * 回放/实时流里这些方括号块原样进用户气泡=正文混入 dev-speak（critic 03/04 截图）。
 * 投影层剥离为 {body=用户原话, notes=注记原文, taskId}——气泡正文保持原话，
 * 注记降级为气泡角落小图标 title（悬停可见，信息不丢）。
 * 剥离边界：只认尾部的 `任务绑定`/`本消息附带` 前缀块（daemon 追加位置）；用户
 * 自己打的同前缀方括号文本极罕见且语义相同——可接受。`[上下文补充]` 是前端
 * 注入前缀（用户可见意图），不剥。
 */

export interface UserFrameAnnotations {
  /** 用户原话（注记块剥离+首尾空白收净）。 */
  body: string
  /** 被剥离的注记原文（title 悬浮聚合展示；空=无注记）。 */
  notes: string[]
  /** 任务绑定注记解析出的 taskId（无则 null）。 */
  taskId: string | null
}

const ANNOTATION_PREFIXES = ['[任务绑定 taskId=', '[本消息附带'] as const

/** 判定一行是否为 daemon 追加的注记块。 */
function isAnnotationLine(line: string): boolean {
  return ANNOTATION_PREFIXES.some((prefix) => line.startsWith(prefix))
}

/** 剥离用户帧尾部的系统注记块（逐行自尾部回溯——daemon 追加在正文之后）。 */
export function extractUserAnnotations(text: string): UserFrameAnnotations {
  const lines = text.split('\n')
  const notes: string[] = []
  let taskId: string | null = null
  while (lines.length > 0) {
    const last = lines[lines.length - 1]!.trim()
    if (last === '') {
      lines.pop()
      continue
    }
    if (!isAnnotationLine(last)) break
    notes.unshift(last)
    const bind = /^\[任务绑定 taskId=([^\]——]+)[\]——]/.exec(last)
    if (bind !== null && taskId === null) taskId = bind[1]!.trim()
    lines.pop()
  }
  return { body: lines.join('\n').trim(), notes, taskId }
}
