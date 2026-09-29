/*
 * railState.svelte.ts——PS 式轨道 Drawer 开合状态机（rework-workbench-rail-drawers 1.1，
 * design §2 冻结语义）。纯 $state 类 + 工厂：View 层持有实例，ResizeObserver 观察容器
 * 宽（42rem=@2xl 阈值）以布尔 setWide 喂入（jsdom 无布局——逻辑层以纯布尔输入可测，
 * 不依赖观察回调）。
 *
 * 语义（design §2 冻结）：
 * - 每 panel（layers/inspector/history）独立 mode：'auto'（缺省随断点解析）| 'open' |
 *   'closed'（manual 记忆）。
 * - auto 解析：wide=true→按缺省表（图层/属性开——「双 Drawer 缺省展开」；历史缺省收起
 *   ——右侧互斥下属性为右缘主面板，历史经 rail 手动开）；wide=false→收起。
 * - 手动 toggle：open↔closed（进 manual 记忆）；右侧 inspector/history 互斥——开一个=
 *   同侧另一面板显式 closed（防 auto 在 wide 档解析回 open 造成「双开」）。
 * - 宽度跌破断点（wide→false）：全部强制收起+清 manual 记忆（回 auto——auto×窄=收起）。
 * - 升回断点（wide→true）：恢复缺省（auto——图层/属性展开）。manual 记忆仅在 wide 档
 *   内有效：两向越档都回 auto（防「用户手动开后被挤压」与「窄屏手动开后残留」）。
 * - 同值 setWide 幂等（不触清记忆——ResizeObserver 高频回调安全）。
 */

/** 轨道面板（左=layers；右=inspector/history 互斥组）。 */
export type RailPanel = 'layers' | 'inspector' | 'history'

/** 面板开合模式：auto（缺省随断点）/ open / closed（manual 记忆）。 */
export type RailMode = 'auto' | 'open' | 'closed'

/** 右侧同侧互斥组（design §2——同侧同时至多一个展开）。 */
const RIGHT_SIDE: readonly RailPanel[] = ['inspector', 'history']

/** auto×wide 缺省展开表：图层+属性（「双 Drawer」）；历史缺省收起（右侧互斥）。 */
const AUTO_OPEN_ON_WIDE: Readonly<Record<RailPanel, boolean>> = {
  layers: true,
  inspector: true,
  history: false,
}

const AUTO_MODES = (): Record<RailPanel, RailMode> => ({ layers: 'auto', inspector: 'auto', history: 'auto' })

/** 状态机实例面（View 持有+喂入；单测直接驱动）。 */
export interface RailState {
  /** 断点输入（容器宽 ≥42rem 与否——View 层 ResizeObserver 喂入）。 */
  setWide(wide: boolean): void
  /** 当前断点档（只读）。 */
  isWide(): boolean
  /** rail 按钮开合（open↔closed 进 manual；右侧同侧互斥）。 */
  toggle(panel: RailPanel): void
  /** 面板生效开合（Drawer open prop 消费）。 */
  isOpen(panel: RailPanel): boolean
  /** 面板当前模式（测试/诊断只读）。 */
  mode(panel: RailPanel): RailMode
}

class RailStateImpl {
  private wide = $state(false)
  private modes = $state<Record<RailPanel, RailMode>>(AUTO_MODES())

  setWide(wide: boolean): void {
    if (wide === this.wide) return
    this.wide = wide
    // 跌破=强制收+清记忆；升回=恢复缺省——两向都回 auto（auto 随 wide 解析开合）
    this.modes = AUTO_MODES()
  }

  isWide(): boolean {
    return this.wide
  }

  toggle(panel: RailPanel): void {
    if (this.isOpen(panel)) {
      this.modes[panel] = 'closed'
      return
    }
    this.modes[panel] = 'open'
    // 同侧互斥（仅右侧组）：开一个=另一面板显式 closed（不回 auto——auto 在 wide 档
    // 会解析回 open，等于双开；显式 closed 在两档下均为收起）
    if (RIGHT_SIDE.includes(panel)) {
      for (const sibling of RIGHT_SIDE) {
        if (sibling !== panel) this.modes[sibling] = 'closed'
      }
    }
  }

  isOpen(panel: RailPanel): boolean {
    return this.modes[panel] === 'auto' ? this.wide && AUTO_OPEN_ON_WIDE[panel] : this.modes[panel] === 'open'
  }

  mode(panel: RailPanel): RailMode {
    return this.modes[panel]
  }
}

/** 工厂（每视图实例独立——embedded/完整双实例不共享开合记忆）。 */
export function createRailState(): RailState {
  return new RailStateImpl()
}
