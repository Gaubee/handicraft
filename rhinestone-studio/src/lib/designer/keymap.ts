/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-21 redesign-designer-workbench 2.x] 设计师工作台键盘分派（纯决策函数，
 *    迁移并扩展自旧 Edit 域 editKeyboard 模块（§7.4 退役清单））：工具切换单键 V/B/E/H/Z（design §3.1）
 *    + Esc 清空选择 + 方向键三档微移（默认 1px、Shift=网格 pitch、Alt=0.1mm 精调）
 *    + ⌘Z·⌘⇧Z·⌘Y（Ctrl 同）撤销重做。输入控件聚焦时一律放行（不劫持表单键）；
 *    工具单键在无修饰键时生效。
 * 2. [3.x 键位全表] handleCommandKeydown：编辑（⌘C/⌘X/⌘V、Delete/Backspace、⌘D）/
 *    变换（⌥[ ⌥] 旋转 ±15°、⇧ 细档 5°、⌘A 全选当前层）/ 视图（⌘+ ⌘- ⌘0 ⌘1、Tab 折叠
 *    右面板列、? 速查）/ 文档（[5.3] ⌘S 保存 · ⌘⇧S 另存为）/ [6.1] 图层操作组（⌘⇧N
 *    新建 / ⌘E 向下合并 / ⌘[ ⌘] 下移上移 / ⌘⇧[ ⌘⇧] 置底置顶——design §3.5）——全部经
 *    commands 命令总线（design §7.2 同源纪律：键位/菜单/面板同命令）。
 *    [rework R3.2 键位重映射（design §3.3 裁决）]：[ ] 让渡笔刷直径 -/+（仅画笔/橡皮
 *    工具——命令层门控；⇧=粗档；'{' '}' 布局变体同键收录）；旋转迁移 ⌥[ ⌥]（细旋转
 *    保留 + ⌘T 主通道归 R4）。
 *    [rework R4.1 ⌘T 段（design §3.1）]：⌘T=enter-transform（自由变换态）；变换态激活期
 *    Enter=confirm-transform、其余命令/工具/撤销键让位（视图组与速查放行）；Esc 经视图层
 *    取消注册表先行（变换态取消最优先）。
 * 3. [Pure] 纯 TS——vitest 用合成 KeyboardEvent 语义直接驱动，DesignerView 只做接线。
 *    nudgeStepPx/isEditableTarget 语义与测试断言随迁保留（design §7.4 退役清单行）。
 */

import type { GridSpec } from '$lib/engine'
import type { DesignerTool } from './workbench.svelte'
import { execDesignerCommand } from './commands'
import { isTransformModeActive } from './interaction.svelte'
import { toggleRightRail, toggleShortcutsHelp } from './viewState.svelte'
// [add-workbench-pro 2c §0 抽取] 表单聚焦判定真源上移 lib/canvaskit（designer 与
// taskWorkbench 双消费单源）；re-export 保持既有 import 面零变化。
import { isEditableTarget } from '$lib/canvaskit.js'
export { isEditableTarget } from '$lib/canvaskit.js'

export interface WorkbenchKeyboardContext {
  hasDocument(): boolean
  selectionCount(): number
  /** 三档步进（px）——实现方按当前文档 grid 换算（nudgeStepPx）。 */
  nudgeStep(modifiers: { shift: boolean; alt: boolean }): number
  /** 微移已选钻（dx/dy 已按步进换算的 px）；返回是否实际生效 */
  nudgeSelection(dxPx: number, dyPx: number): boolean
  clearSelection(): void
  /** 工具切换（V/B/E/H/Z 命中时写入交互态真源）。 */
  setTool(tool: DesignerTool): void
  undo(): boolean
  redo(): boolean
}

/** 方向键三档步进（design §3.3）：默认 1px；Shift = pitch（px）；Alt = 0.1mm×pixelsPerMm
 *  （Shift+Alt 并按时取精调档——细粒度优先）。 */
export function nudgeStepPx(
  modifiers: { shift: boolean; alt: boolean },
  grid: Pick<GridSpec, 'pitchMm' | 'pixelsPerMm'>,
): number {
  if (modifiers.alt) return 0.1 * grid.pixelsPerMm
  if (modifiers.shift) return grid.pitchMm * grid.pixelsPerMm
  return 1
}

/** 工具切换键位表（design §3.1；无修饰键时生效——⌘Z 等组合键不冲突）。 */
export const TOOL_KEY_BINDINGS: ReadonlyArray<{ key: string; tool: DesignerTool }> = [
  { key: 'v', tool: 'select' },
  { key: 'b', tool: 'draw' },
  { key: 'e', tool: 'erase' },
  { key: 'h', tool: 'hand' },
  { key: 'z', tool: 'zoom' },
]

/**
 * 键分派：命中返回 true（并 preventDefault），未命中返回 false（放行浏览器默认）。
 * 输入控件聚焦 / 无文档（除 Esc 清空亦无面）时直接放行。
 * [rework R4.1] ⌘T 变换态激活期：全键让位（防 pending 基线漂移）——变换盒为唯一焦点。
 */
export function handleWorkbenchKeydown(event: KeyboardEvent, ctx: WorkbenchKeyboardContext): boolean {
  if (event.defaultPrevented) return false
  if (isEditableTarget(event.target)) return false
  if (isTransformModeActive()) return false // ⌘Z/方向键等在变换态让位（Enter/Esc 由命令层与取消链先行）

  const key = event.key
  // 撤销/重做：⌘Z / ⌘⇧Z / ⌘Y（Ctrl 同）
  if ((event.metaKey || event.ctrlKey) && !event.altKey && (key === 'z' || key === 'Z' || key === 'y' || key === 'Y')) {
    const done = key === 'y' || key === 'Y' ? ctx.redo() : event.shiftKey ? ctx.redo() : ctx.undo()
    if (done) {
      event.preventDefault()
      return true
    }
    return false
  }
  if (event.metaKey || event.ctrlKey) return false

  // Esc：清空选择
  if (key === 'Escape') {
    if (!ctx.hasDocument()) return false
    ctx.clearSelection()
    event.preventDefault()
    return true
  }

  // 方向键微移（无选中不动）
  const arrow: Array<{ key: string; dx: number; dy: number }> = [
    { key: 'ArrowLeft', dx: -1, dy: 0 },
    { key: 'ArrowRight', dx: 1, dy: 0 },
    { key: 'ArrowUp', dx: 0, dy: -1 },
    { key: 'ArrowDown', dx: 0, dy: 1 },
  ]
  const hit = arrow.find((a) => a.key === key)
  if (hit === undefined) return false
  if (!ctx.hasDocument() || ctx.selectionCount() === 0) return false
  const step = ctx.nudgeStep({ shift: event.shiftKey, alt: event.altKey })
  if (ctx.nudgeSelection(step * hit.dx, step * hit.dy)) {
    event.preventDefault()
    return true
  }
  return false
}

/**
 * 工具切换分派（design §3.1——V/B/E/H/Z；design §3 纪律：无修饰键时生效、无文档不切换）。
 * 命中返回 true 并 preventDefault；其余返回 false（交给 handleWorkbenchKeydown 的其余分组）。
 */
export function handleToolKeydown(event: KeyboardEvent, ctx: Pick<WorkbenchKeyboardContext, 'hasDocument' | 'setTool'>): boolean {
  if (event.defaultPrevented) return false
  if (isEditableTarget(event.target)) return false
  if (isTransformModeActive()) return false // [R4.1] 变换态不切工具（Enter/Esc 收束后恢复）
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  const binding = TOOL_KEY_BINDINGS.find((b) => b.key === event.key.toLowerCase())
  if (binding === undefined || !ctx.hasDocument()) return false
  ctx.setTool(binding.tool)
  event.preventDefault()
  return true
}

// ---------------------------------------------------------------------------
// [3.x 键位全表] 命令分派（design §3.2/§3.3/§3.4/§3.7——全部经 commands 命令总线）
// ---------------------------------------------------------------------------

/** Tab / ? 等视图态命令需要的最小上下文。 */
export type CommandKeyContext = Pick<WorkbenchKeyboardContext, 'hasDocument'>

/** [R3.2] 笔刷直径键步进（design §4.3）：细档 0.5mm；⇧ 粗档 2mm（PS 笔刷惯例两档）。 */
export const BRUSH_DIAMETER_STEP_MM = 0.5
export const BRUSH_DIAMETER_COARSE_STEP_MM = 2

/**
 * 命令键分派（design §3 全表本切片接线面）：命中返回 true（并 preventDefault），
 * 未命中/门槛不满足返回 false（放行浏览器默认）。⌘ = Ctrl/Win 双写；Alt 修饰中仅
 * ⌥[ ⌥] 细旋转入命令表（[R3.2 §3.3 迁移]），其余 Alt 归手势（Alt 拖拽复制 §2 P5）。
 */
export function handleCommandKeydown(event: KeyboardEvent, ctx: CommandKeyContext): boolean {
  if (event.defaultPrevented) return false
  if (isEditableTarget(event.target)) return false
  const key = event.key
  const meta = event.metaKey || event.ctrlKey

  // [rework R4.1 §3.1] ⌘T 变换态键面：Enter=确认（单 patch 提交）；Esc 已在视图层经取消
  // 注册表先行（变换态取消最优先）；视图组（⌘+/-/0/1）与速查（Tab/?）放行；其余命令
  // （编辑/图层/笔刷/旋转）让位——变换盒为唯一焦点，防 pending 基线漂移。
  if (isTransformModeActive()) {
    if (key === 'Enter') {
      return settle(event, execDesignerCommand({ kind: 'confirm-transform' }))
    }
    const k = key.toLowerCase()
    const viewKey =
      meta && !event.shiftKey && !event.altKey && (k === '0' || k === '1' || k === '=' || k === '+' || k === '-')
    if (!viewKey && key !== 'Tab' && key !== '?') return false
  }

  if (meta && event.shiftKey && !event.altKey) {
    // [5.3] ⌘⇧S 另存为（design §3 文档组——与保存同走命令总线，经 UI 钩子弹命名）
    if (key.toLowerCase() === 's') {
      return settle(event, execDesignerCommand({ kind: 'save-as' }))
    }
    // [6.1] ⌘⇧N 新建图层（design §3.5 图层操作组；Shift+N 布局产 'N'——toLowerCase 归一）
    if (key.toLowerCase() === 'n') {
      return settle(event, execDesignerCommand({ kind: 'new-layer' }))
    }
    // [6.1] ⌘⇧[ / ⌘⇧] 当前层置底 / 置顶（Shift+[ ] 多数布局产 '{' / '}'——同键双收录）
    if (key === '{' || key === '[') {
      return settle(event, execDesignerCommand({ kind: 'reorder-layer', to: 'bottom' }))
    }
    if (key === '}' || key === ']') {
      return settle(event, execDesignerCommand({ kind: 'reorder-layer', to: 'top' }))
    }
    return false
  }

  if (meta && !event.shiftKey && !event.altKey) {
    switch (key.toLowerCase()) {
      case 'c':
        return settle(event, execDesignerCommand({ kind: 'copy' }))
      case 'x':
        return settle(event, execDesignerCommand({ kind: 'cut' }))
      case 'v':
        return settle(event, execDesignerCommand({ kind: 'paste' }))
      case 'd':
        return settle(event, execDesignerCommand({ kind: 'deselect' }))
      case 'a':
        return settle(event, execDesignerCommand({ kind: 'select-all-current-layer' }))
      case 's':
        // [5.3] ⌘S 保存（design §3 文档组——DocBar 保存按钮/菜单同源命令）
        return settle(event, execDesignerCommand({ kind: 'open-save' }))
      case 'e':
        // [6.1] ⌘E 向下合并（design §3.5——当前层并入下一可见未锁层，mergeDownTargetOf 同源）
        return settle(event, execDesignerCommand({ kind: 'merge-layer-down' }))
      case 't':
        // [rework R4.1 §3.1] ⌘T 自由变换态（选中 ≥1 出包围盒；空选集命令门槛 false 放行）
        return settle(event, execDesignerCommand({ kind: 'enter-transform' }))
      case '0':
        return settle(event, execDesignerCommand({ kind: 'zoom-fit' }))
      case '1':
        return settle(event, execDesignerCommand({ kind: 'zoom-100' }))
      case '=':
      case '+':
        return settle(event, execDesignerCommand({ kind: 'zoom-in' }))
      case '-':
      case '_':
        return settle(event, execDesignerCommand({ kind: 'zoom-out' }))
      case '[':
        // [6.1] ⌘[ 当前层下移一层（z 序——design §3.5）
        return settle(event, execDesignerCommand({ kind: 'reorder-layer', to: 'down' }))
      case ']':
        // [6.1] ⌘] 当前层上移一层（z 序——design §3.5）
        return settle(event, execDesignerCommand({ kind: 'reorder-layer', to: 'up' }))
    }
    return false
  }

  // [R3.2 §3.3 迁移] ⌥[ ⌥] 细旋转 ±15°（⇧=5°；'{' '}' 布局变体同键收录——Alt+Shift 组合
  // 在多数布局产出同键位）；⌘⌥ 组合不进（meta 分支已先返）。
  if (event.altKey && !meta) {
    if (key === '[' || key === '{') {
      return settle(event, execDesignerCommand({ kind: 'rotate', stepDeg: event.shiftKey ? -5 : -15 }))
    }
    if (key === ']' || key === '}') {
      return settle(event, execDesignerCommand({ kind: 'rotate', stepDeg: event.shiftKey ? 5 : 15 }))
    }
    return false // 其余 Alt 归手势面（Alt 拖拽复制 / Alt+方向键精调档）
  }

  switch (key) {
    // [R3.2 §3.3 让渡] [ ] = 笔刷直径 −/+（仅画笔/橡皮工具下——命令层门控，非画笔工具
    // 返回 false 放行浏览器默认；⇧=粗档；'{' '}' 布局变体同键收录）
    case '[':
    case '{':
      return settle(
        event,
        execDesignerCommand({
          kind: 'adjust-brush-diameter',
          deltaMm: event.shiftKey ? -BRUSH_DIAMETER_COARSE_STEP_MM : -BRUSH_DIAMETER_STEP_MM,
        }),
      )
    case ']':
    case '}':
      return settle(
        event,
        execDesignerCommand({
          kind: 'adjust-brush-diameter',
          deltaMm: event.shiftKey ? BRUSH_DIAMETER_COARSE_STEP_MM : BRUSH_DIAMETER_STEP_MM,
        }),
      )
    case 'Delete':
    case 'Backspace':
      return settle(event, execDesignerCommand({ kind: 'delete-selection' }))
    case 'Tab':
      // Tab 折叠/展开右面板列（design §3.4 裁断）；拦默认焦点移动
      if (!ctx.hasDocument()) return false
      toggleRightRail()
      event.preventDefault()
      return true
    case '?':
      // 键位速查（design §3.7：「?」= Shift+/）
      if (!ctx.hasDocument()) return false
      toggleShortcutsHelp()
      event.preventDefault()
      return true
  }
  return false
}

function settle(event: KeyboardEvent, done: boolean): boolean {
  if (!done) return false
  event.preventDefault()
  return true
}

// ---------------------------------------------------------------------------
// [design §3.7] 键位速查面板数据（单页全表——已接线面；[6.1] 图层操作组已随命令总线接线）
// ---------------------------------------------------------------------------

export const SHORTCUT_HELP_SECTIONS: ReadonlyArray<{
  title: string
  rows: ReadonlyArray<{ keys: string; label: string }>
}> = [
  {
    title: '工具',
    rows: [
      { keys: 'V', label: '选择工具' },
      { keys: 'B', label: '画笔工具' },
      { keys: 'E', label: '橡皮工具' },
      { keys: 'H', label: '抓手工具' },
      { keys: 'Z', label: '缩放工具' },
      { keys: '空格（按住）', label: '临时抓手平移' },
    ],
  },
  {
    title: '编辑',
    rows: [
      { keys: '⌘Z / ⌘⇧Z（⌘Y）', label: '撤销 / 重做' },
      { keys: '⌘C / ⌘X / ⌘V', label: '复制 / 剪切 / 粘贴（原位偏移一格）' },
      { keys: 'Delete / Backspace', label: '删除选中（批量需确认）' },
      { keys: '⌘D / Esc', label: '取消选择' },
      { keys: 'Alt+拖拽', label: '复制并拖移副本' },
      // [R4.2 §3.5 对齐表同步] Shift/Alt 框选加减选行
      { keys: 'Shift+框选 / Alt+框选', label: '框选并入选区 / 从选区减去' },
    ],
  },
  {
    title: '变换与微移',
    rows: [
      // [R4.1 §3.1] ⌘T 自由变换（单选专用柄退役——交互统一）
      { keys: '⌘T', label: '自由变换（角柄等比缩放 Ø / 外柄旋转；⇧ = 15° 步进；Enter 确认 · Esc 取消）' },
      { keys: '方向键', label: '微移 1px' },
      { keys: '⇧+方向键', label: '微移一格（当前规格 pitch）' },
      { keys: 'Alt+方向键', label: '微移 0.1mm（精调档）' },
      // [R3.2 §3.3 让渡] [ ] = 笔刷直径（画笔/橡皮下）；旋转迁移 ⌥[ ⌥]
      { keys: '[ / ]', label: '笔刷直径 − / +（画笔/橡皮工具下；⇧ = 粗档）' },
      { keys: '⌥[ / ⌥]', label: '逆 / 顺时针旋转 15°（⇧ = 5°）' },
      { keys: '⌘A', label: '全选当前层钻' },
    ],
  },
  {
    title: '图层操作',
    rows: [
      { keys: '⌘⇧N', label: '新建图层' },
      { keys: '⌘E', label: '向下合并（并入下一可见未锁层）' },
      { keys: '⌘[ / ⌘]', label: '当前层下移 / 上移一层（z 序）' },
      { keys: '⌘⇧[ / ⌘⇧]', label: '当前层置底 / 置顶' },
      { keys: 'Alt+点眼睛', label: '孤立显示该层（再按恢复）' },
      { keys: '双击层名', label: '重命名图层' },
    ],
  },
  {
    title: '文档',
    rows: [
      { keys: '⌘S', label: '保存（首存弹命名；守卫三分法）' },
      { keys: '⌘⇧S', label: '另存为…' },
    ],
  },
  {
    title: '视图',
    rows: [
      { keys: '⌘+ / ⌘-', label: '放大 / 缩小一档' },
      { keys: '⌘0 / ⌘1', label: '适配画幅 / 100%' },
      { keys: '滚轮', label: '以光标为锚缩放（10%-1600%）' },
      { keys: '空格·中键拖', label: '平移视图' },
      { keys: '双击空白', label: '100% ⇄ 适配画幅' },
      { keys: 'Tab', label: '折叠 / 展开右侧面板列' },
      { keys: '?', label: '键位速查' },
    ],
  },
]
