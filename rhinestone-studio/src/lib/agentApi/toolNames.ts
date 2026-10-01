/*
 * [w17-critic T1] 工具名显示映射（人话翻译壳）：daemon 经 dsh-mcp-client 投影的
 * 工具名形如 `mcp__studio__studio.scene.analyze`，转录流/审批卡原样裸奔是最大
 * AI-tell 之一。本模块单源提供：
 *   [1] toolDisplayName：去 `mcp__<server>__` 前缀 + 常用工具中文名映射
 *       （映射外原名保留——宁可英文也不误译）。
 *   [2] 工具帧文本解析：daemon sessions.ts 把工具调用/结果压进 transcript tool
 *       帧文本（`调用工具 <name>（参数 <json>）` / `工具结果（<name>）：<text>`）
 *       ——投影层解析回结构化（名称走映射、参数/结果入展开卡），替代整段平铺。
 * 映射表覆盖 capability 面注册的 studio、stones、set 前缀工具族（daemon
 * registry 为真源；新增工具未映射时原名呈现，不阻塞）。
 */

/** 常用工具中文名（键=去前缀后的工具名）。 */
const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  // 场景/抠图/策略管线（add-subject-sam-pipeline 主线）
  'studio.scene.analyze': '识图分析',
  'studio.subject.segment': '抠图分件',
  'studio.strategy.design': '策略设计',
  // 图层树
  'studio.tree.inspect': '图层树检视',
  'studio.tree.refine': '图层细化',
  'studio.tree.rename': '图层重命名',
  'studio.tree.reparent': '图层归属调整',
  'studio.tree.merge': '图层合并',
  // 任务域（工件/用钻/图集/提案）
  'studio.task.export': '导出任务工件',
  'studio.task.exports.list': '查看导出清单',
  'studio.task.images.list': '查看主图集',
  'studio.task.proposals.list': '查看提案记录',
  'studio.task.stones.add': '追加用钻',
  'studio.task.stones.list': '查看用钻清单',
  // 生成/导出/BOM
  'studio.generate': '生成图片',
  'studio.export': '导出',
  'studio.export-dryrun': '导出试算',
  'studio.bom': '用钻清单',
  'studio.pave-preview': '排钻预览',
  // 修改提案/撤销
  'studio.patch-propose': '修改提案',
  'studio.patch-apply': '应用修改',
  'studio.undo': '撤销',
  // 项目/模板/知识库
  'studio.projects': '查看项目',
  'studio.templates': '查看模板',
  'studio.kb_get': '知识库读取',
  'studio.kb_list': '知识库检索',
  // 钻库/组合（stones.* / set.*）
  'stones.list': '钻库检索',
  'stones.search': '钻库搜索',
  'stones.get': '钻款详情',
  'stones.substitutes': '替换钻推荐',
  'stones.add': '新增钻款',
  'set.list': '组合列表',
  'set.get': '组合详情',
  'set.create': '新建组合',
  'set.update': '保存组合',
  'set.delete': '删除组合',
}

/** 去 MCP 域前缀（`mcp__<server>__<tool>` → `<tool>`；非该形态原样返回）。 */
export function stripMcpPrefix(name: string): string {
  const match = /^mcp__[a-zA-Z0-9_-]+__(.+)$/.exec(name)
  return match?.[1] ?? name
}

/** 工具名显示（去前缀+中文映射；未知工具保原名——不猜译）。 */
export function toolDisplayName(name: string): string {
  const stripped = stripMcpPrefix(name)
  return TOOL_DISPLAY_NAMES[stripped] ?? stripped
}

/** 是否已映射为中文名（未映射面 title 补原名语义由调用方决定——本函数供测试锚）。 */
export function isMappedToolName(name: string): boolean {
  return TOOL_DISPLAY_NAMES[stripMcpPrefix(name)] !== undefined
}

/** 工具调用帧文本（`调用工具 <name>（参数 <args>）`——daemon sessions.ts 字面）。 */
export interface ToolCallParsed {
  name: string
  args: string
}

/** 解析工具调用帧文本；非该形态返回 null（宽容：参数段可缺省）。 */
export function parseToolCallText(text: string): ToolCallParsed | null {
  const match = /^调用工具 (.+?)（参数 (.*)）$/s.exec(text.trim())
  if (match !== null) return { name: match[1]!, args: match[2]! }
  const bare = /^调用工具 ([^（]+)$/.exec(text.trim())
  return bare !== null ? { name: bare[1]!.trim(), args: '' } : null
}

/** 解析工具结果帧文本（`工具结果（<name>）：<text>`；无括号名形态返回 null）。 */
export function parseToolResultText(text: string): { name: string; text: string } | null {
  const match = /^工具结果（(.+?)）：([\s\S]*)$/.exec(text.trim())
  return match !== null ? { name: match[1]!, text: match[2]! } : null
}
