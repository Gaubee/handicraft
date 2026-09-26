/*
 * commands.ts——工作台命令总线（add-workbench-pro 2c 快捷键命令总线 P0）。
 *
 * Orthogonal intents (max 3):
 * 1. [单点定义] 命令={id+标题+快捷键+执行+可用谓词}单源清单：键位/工具条按钮/
 *    ? 帮助面板同源消费（design §2「命令总线单点定义」——designer commands 同款
 *    纪律）。键位真源对齐 designer/keymap（V 选择/H 平移/Z 缩放——§0 红线）。
 * 2. [键分派] handleWorkbenchKeydown：IME 组字/输入框聚焦保护（isEditableTarget+
 *    isComposing——W10 P1 同款谨慎）→ ⌘/Ctrl 组合（undo/redo 域路由+缩放组）→
 *    Alt+↑↓ 图层键盘重排（a11y）→ 单键（工具/笔刷/Delete/F2/Esc/[]/?）。命中且
 *    生效=preventDefault+true；门槛不满足=false 放行浏览器默认。
 * 3. [Pure] 纯 TS 零 runes——exec 读 store/canvasStage 现值；jsdom 用合成
 *    KeyboardEvent 直接驱动（designer keymap 同式）。
 */

import { isEditableTarget, isImeComposing } from '$lib/canvaskit.js'
import {
  fitCanvasView,
  setWorkbenchTool,
  zoomCanvasStep,
  zoomCanvasTo,
} from './canvasStage.svelte.js'
import {
  adjustBrushRadius,
  enterBrushMode,
  exitBrushMode,
  getBrushSession,
  getSelectedNodeId,
  getWorkbenchPhase,
  isHelpOpen,
  moveSelectedLayer,
  redoCurrentDomain,
  requestDeleteLayer,
  requestRenameSelected,
  selectNode,
  setHelpOpen,
  toggleHelpOpen,
  undoCurrentDomain,
} from './store.svelte'

/** 工作台命令 id（菜单/按钮/键位同源寻址键）。 */
export type WorkbenchCommandId =
  | 'tool.select'
  | 'tool.hand'
  | 'tool.zoom'
  | 'brush.toggle'
  | 'brush.radius.dec'
  | 'brush.radius.inc'
  | 'layer.delete'
  | 'layer.rename'
  | 'layer.move-up'
  | 'layer.move-down'
  | 'undo'
  | 'redo'
  | 'zoom.fit'
  | 'zoom.100'
  | 'zoom.in'
  | 'zoom.out'
  | 'mode.exit'
  | 'help.toggle'

export interface WorkbenchCommand {
  id: WorkbenchCommandId
  /** 标题（帮助面板/工具条 tooltip 同源）。 */
  title: string
  /** 快捷键显示（⌘=Cmd/Ctrl 双平台——帮助面板呈现）。 */
  keys: string
  /** 可用谓词（false=帮助面板置灰+键位层放行浏览器默认）。 */
  when(): boolean
  /** 执行（返回是否生效——false 不 preventDefault）。 */
  exec(): boolean | Promise<boolean>
}

function isReady(): boolean {
  return getWorkbenchPhase() === 'ready'
}

function hasSelection(): boolean {
  return isReady() && getSelectedNodeId() !== null
}

/**
 * 命令清单（单源——? 帮助面板/工具条/键位分派全部经此；新增命令=加一行+分派接线）。
 */
export const WORKBENCH_COMMANDS: ReadonlyArray<WorkbenchCommand> = [
  // ---- 工具（键位真源=designer/keymap：V 选择/H 平移/Z 缩放）----
  { id: 'tool.select', title: '选择工具（点选层/命中测试）', keys: 'V', when: isReady, exec: () => setWorkbenchTool('select') },
  { id: 'tool.hand', title: '平移工具（拖拽画布）', keys: 'H', when: isReady, exec: () => setWorkbenchTool('hand') },
  { id: 'tool.zoom', title: '缩放工具（点击放大/Alt+点击缩小）', keys: 'Z', when: isReady, exec: () => setWorkbenchTool('zoom') },
  // ---- 笔刷（B=2b 既有——2c 收编入总线）----
  {
    id: 'brush.toggle',
    title: '笔刷编辑选中层遮罩（进入/退出）',
    keys: 'B',
    when: isReady,
    exec: () => (getBrushSession().active ? (exitBrushMode(), true) : enterBrushMode()),
  },
  { id: 'brush.radius.dec', title: '笔刷半径 −2px', keys: '[', when: () => getBrushSession().active, exec: () => (adjustBrushRadius(-2), true) },
  { id: 'brush.radius.inc', title: '笔刷半径 +2px', keys: ']', when: () => getBrushSession().active, exec: () => (adjustBrushRadius(2), true) },
  // ---- 图层 ----
  { id: 'layer.delete', title: '删除选中层子树（确认后执行）', keys: 'Delete', when: hasSelection, exec: () => requestDeleteLayer(getSelectedNodeId()!) },
  { id: 'layer.rename', title: '重命名选中层（inline 编辑）', keys: 'F2', when: hasSelection, exec: () => requestRenameSelected() },
  { id: 'layer.move-up', title: '选中层上移一位（同父序）', keys: 'Alt+↑', when: hasSelection, exec: () => moveSelectedLayer(-1) },
  { id: 'layer.move-down', title: '选中层下移一位（同父序）', keys: 'Alt+↓', when: hasSelection, exec: () => moveSelectedLayer(1) },
  // ---- undo/redo（D-3 域路由——store.undoCurrentDomain 单实现）----
  { id: 'undo', title: '撤销（当前域：遮罩>视图态/结构/参数按焦点路由）', keys: '⌘Z / Ctrl+Z', when: isReady, exec: () => undoCurrentDomain() },
  { id: 'redo', title: '重做（遮罩域先行——其余域 2d）', keys: '⇧⌘Z / Ctrl+Y', when: isReady, exec: () => redoCurrentDomain() },
  // ---- 视图（designer viewport 宿主同款：⌘0/⌘1/⌘±）----
  { id: 'zoom.fit', title: '适配画幅', keys: '⌘0 / Ctrl+0', when: isReady, exec: () => fitCanvasView() },
  { id: 'zoom.100', title: '缩放至 100%', keys: '⌘1 / Ctrl+1', when: isReady, exec: () => zoomCanvasTo(1) },
  { id: 'zoom.in', title: '放大一档（中心锚）', keys: '⌘+ / Ctrl+=', when: isReady, exec: () => zoomCanvasStep(1.25) },
  { id: 'zoom.out', title: '缩小一档（中心锚）', keys: '⌘- / Ctrl+-', when: isReady, exec: () => zoomCanvasStep(0.8) },
  // ---- 模式/帮助 ----
  {
    id: 'mode.exit',
    title: '退出当前模式（帮助面板>笔刷>选中）',
    keys: 'Esc',
    when: () => isReady(),
    exec: () => {
      // 取消链：确认面由各自对话框就近消费；此处帮助面板>笔刷>清空选中
      if (isHelpOpen()) {
        setHelpOpen(false)
        return true
      }
      if (getBrushSession().active) {
        exitBrushMode()
        return true
      }
      if (getSelectedNodeId() !== null) {
        selectNode(null)
        return true
      }
      return false
    },
  },
  { id: 'help.toggle', title: '快捷键与命令速查', keys: '?', when: isReady, exec: () => (toggleHelpOpen(), true) },
]

const COMMAND_BY_ID = new Map(WORKBENCH_COMMANDS.map((command) => [command.id, command] as const))

/** 按命令寻址执行（工具条/菜单入口——键位同源单实现）。返回是否生效。 */
export function execWorkbenchCommand(id: WorkbenchCommandId): boolean | Promise<boolean> {
  const command = COMMAND_BY_ID.get(id)
  if (command === undefined || !command.when()) return false
  return command.exec()
}

/** 帮助面板行（命令清单+快捷键+当前可用性——命令总线驱动，无第二张表）。 */
export interface WorkbenchCommandRow {
  id: WorkbenchCommandId
  title: string
  keys: string
  available: boolean
}

export function getWorkbenchCommandRows(): WorkbenchCommandRow[] {
  return WORKBENCH_COMMANDS.map((command) => ({
    id: command.id,
    title: command.title,
    keys: command.keys,
    available: command.when(),
  }))
}

// ---------------------------------------------------------------- 键分派（designer keymap 同式纪律）

function settle(event: KeyboardEvent, done: boolean | Promise<boolean>): boolean {
  // Promise（undo/redo 异步）恒视为已接管——命令已起（结果经 toast 反馈）
  if (typeof done === 'boolean' && !done) return false
  event.preventDefault()
  return true
}

/**
 * 键分派：命中且生效=true（并 preventDefault）；未命中/门槛不满足/输入框聚焦/IME
 * 组字=false（放行浏览器默认）。⌘=Cmd/Ctrl 双平台。
 */
export function handleWorkbenchKeydown(event: KeyboardEvent): boolean {
  if (event.defaultPrevented) return false
  if (isImeComposing(event) || isEditableTarget(event.target)) return false
  if (!isReady()) return false

  const key = event.key
  const lower = key.toLowerCase()
  const meta = event.metaKey || event.ctrlKey

  // ---- ⌘/Ctrl 组合：undo/redo + 缩放组（designer ⌘Z/⌘⇧Z/⌘Y/⌘0/⌘1/⌘± 同表）----
  if (meta && !event.altKey && (lower === 'z' || lower === 'y')) {
    const redo = lower === 'y' || event.shiftKey
    return settle(event, redo ? execWorkbenchCommand('redo') : execWorkbenchCommand('undo'))
  }
  if (meta && !event.shiftKey && !event.altKey) {
    switch (lower) {
      case '0':
        return settle(event, execWorkbenchCommand('zoom.fit'))
      case '1':
        return settle(event, execWorkbenchCommand('zoom.100'))
      case '=':
      case '+':
        return settle(event, execWorkbenchCommand('zoom.in'))
      case '-':
      case '_':
        return settle(event, execWorkbenchCommand('zoom.out'))
    }
    return false
  }
  if (meta) return false // 其余 ⌘ 组合不劫持（浏览器/输入法面）

  // ---- Alt+方向：图层键盘重排（a11y——等价拖拽的同父序移）----
  if (event.altKey) {
    if (key === 'ArrowUp') return settle(event, execWorkbenchCommand('layer.move-up'))
    if (key === 'ArrowDown') return settle(event, execWorkbenchCommand('layer.move-down'))
    return false
  }

  // ---- 单键（无修饰）：工具/笔刷/图层/模式/帮助 ----
  switch (lower) {
    case 'v':
      return settle(event, execWorkbenchCommand('tool.select'))
    case 'h':
      return settle(event, execWorkbenchCommand('tool.hand'))
    case 'z':
      return settle(event, execWorkbenchCommand('tool.zoom'))
    case 'b':
      return settle(event, execWorkbenchCommand('brush.toggle'))
    case 'f2':
      return settle(event, execWorkbenchCommand('layer.rename'))
    case '?':
      return settle(event, execWorkbenchCommand('help.toggle'))
  }
  switch (key) {
    case 'Delete':
    case 'Backspace':
      return settle(event, execWorkbenchCommand('layer.delete'))
    case 'Escape':
      return settle(event, execWorkbenchCommand('mode.exit'))
    case '[':
    case '{':
      return settle(event, execWorkbenchCommand('brush.radius.dec'))
    case ']':
    case '}':
      return settle(event, execWorkbenchCommand('brush.radius.inc'))
  }
  return false
}
