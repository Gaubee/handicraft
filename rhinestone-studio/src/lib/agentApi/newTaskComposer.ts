/*
 * 开始新任务面板域（new-task-panel 2026-10-02，Owner 需求「参考朱墨 TaskComposer：
 * 明确让用户填图片（可多）+尺寸+装饰钻集合」）——纯函数层（无 Svelte/无 IO）。
 * 正交意图：
 *   [1] 表单常量与校验：画布尺寸 cm 界（5-100，缺省 20×20；Owner 需求原文）。
 *   [2] 首消息模板拼装：指令+尺寸+用钻集合 → 人话首消息（模型可读；图片走
 *       附件面不进文本——多图并发由 store.submitNewTask 编排，非提示词实现）。
 *   [3] 会话标题推导：N 图=N 会话带序号（「贴钻 · 3 张之 2」/文件名——Owner 需求）。
 *   [4] 预设开场 chips（贴钻管线措辞——点选填充可编辑，面板 ComposerCard 注入）。
 */

import type { AgentSetSummary } from './types.js'

/** 画布尺寸合理界（cm，含端点；缺省 20×20）。 */
export const CANVAS_CM_MIN = 5
export const CANVAS_CM_MAX = 100
export const CANVAS_CM_DEFAULT = 20

/** 尺寸校验（有限数+界内；NaN/越界=false——表单阻塞门）。 */
export function isCanvasCmValid(value: number): boolean {
  return Number.isFinite(value) && value >= CANVAS_CM_MIN && value <= CANVAS_CM_MAX
}

/** 预设开场（贴钻管线措辞；点选填充 ComposerCard 可编辑——zhumo 同款语义）。 */
export const NEW_TASK_PRESETS: Array<{ label: string; prompt: string }> = [
  {
    label: '全自动（识图→排钻→导出）',
    prompt:
      '请全自动完成这张图的贴钻：识别主体轮廓、给出对象树与排钻策略，然后直接生成排钻布局并导出全套产物（SVG/PNG/BOM），过程中关键方案给我确认点。',
  },
  {
    label: '只识图出树，排钻我来',
    prompt:
      '请只做识图和对象树拆解：识别主体轮廓、分层说明每块区域的钻型/颜色/密度建议，先不要执行排钻——我看过对象树后再告诉你怎么排。',
  },
  {
    label: '按我选的组合用钻',
    prompt:
      '请严格使用我在表单里选定的装饰钻集合用钻：不要自行替换钻型或颜色，集合内不够用的地方先标注出来问我，再决定补充或调整密度。',
  },
  {
    label: '样卡复刻',
    prompt:
      '请对照这张样卡图复刻钻图组合：逐区匹配材料市场中最接近的钻（颜色/尺寸/形状），列出替换差异，然后产出排钻布局。',
  },
]

/** 首消息模板输入（set=null=智能选钻缺省项——不绑定 sourceSetId）。 */
export interface NewTaskFormValue {
  /** 用户指令（ComposerCard 文本；可空——纯图+表单参数也可开工）。 */
  instruction: string
  widthCm: number
  heightCm: number
  set: AgentSetSummary | null
}

/**
 * 首消息拼装（模型可读人话；图片走附件面——此处只拼参数行）：
 * 指令段（可空）+「画布尺寸」行+「用钻」行（选定组合带成员数；智能选钻=
 * 明示由模型按画面自选）。尺寸/用钻行恒在——即使指令为空，首消息仍携带
 * 表单语义（纯图开工不丢参数）。
 */
export function buildNewTaskFirstMessage(value: NewTaskFormValue): string {
  const lines: string[] = []
  const instruction = value.instruction.trim()
  if (instruction.length > 0) lines.push(instruction)
  lines.push(`画布尺寸：${value.widthCm}×${value.heightCm} cm`)
  lines.push(
    value.set === null
      ? '用钻：智能选钻——由你按画面自动挑选最合适的钻（颜色/尺寸/形状/密度）'
      : `用钻集合：${value.set.name}（${value.set.memberCount} 成员）`,
  )
  return lines.join('\n')
}

/**
 * 会话标题推导（N 图=N 会话——Owner 需求「标题带序号或图片名」）：
 * - 基名=指令首行截 24 字；无指令=单图取文件名、多图取「贴钻」。
 * - 单图=基名；多图=`基名 · N 张之 i`（例：贴钻 · 3 张之 2）。
 * - 全部截 48 字（会话标题既有界，multiImageSplit 同款）。
 */
export function newTaskSessionTitles(instruction: string, images: ReadonlyArray<{ name: string }>): string[] {
  const count = images.length
  if (count === 0) return []
  const firstLine = instruction.trim().split('\n')[0]?.trim() ?? ''
  const base = firstLine.length > 0 ? firstLine.slice(0, 24) : count > 1 ? '贴钻' : (images[0]!.name || '贴钻')
  return images.map((_, index) => {
    const title = count > 1 ? `${base} · ${count} 张之 ${index + 1}` : base
    return title.slice(0, 48)
  })
}
