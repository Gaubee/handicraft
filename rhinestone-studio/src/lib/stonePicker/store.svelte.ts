/**
 * 钻表选择器状态 store（add-stone-library design §5——S5.1/S5.2）。
 * 独立于任何页面/路由：组件库自持状态，P3.2 策略层参数面板实例化消费。
 *
 * 排板双形态（design §5 样卡/工艺双心智）：
 * - color（按色）：family（groupBy='family'）→ 款式行（groupBy='style' 子查询）→
 *   尺寸变体（styleRow 过滤子查询，展开行懒加载——请求面有界）。
 * - size（按尺寸）：sizeMm 档（groupBy='sizeMm'）→ 同径色阵（sizeMm 过滤）。
 * '未编行'/'未声明' 桶无过滤参数可用（RPC 面不可表达 IS NULL）→ 家族/全量页取回后
 * 客户端过滤（styleName===''/sizeMm===null——§8.1 规则 7 显式态不猜测）。
 *
 * nearColor ΔE 邻近推荐（S5.2）：nearColor 入 list 查询协议位，结果按 ΔE 升序
 * （rpcSource 现为客户端回退——P3.2 接线服务端排序，见 source.ts 头注）。
 *
 * 选中产出=StonePick 契约（S5.1 核心）：由 StoneGridCell 即时构造（resourceId/sku/
 * supplier/sizeMm/colorHex 五结构化引用字段）；gemshapeRef 经 source.get 异步富集
 * （引用四态非 resolved 时显式标注，不阻断产出——schema 本就 optional）。
 *
 * 加载状态机（八拓扑的前六种——无更新中回写面，读面板无乐观写）：
 * idle/loading/ready/error × 排板面与推荐面各自独立计数。
 * 过期响应防线：loadSeq 单调序号，晚到响应丢弃。
 */
import { StonePickSchema, type RgbTuple, type StoneGridCell, type StonePick } from '@handicraft/contracts'
import {
  hexToRgb,
  sizeMmFromGroupKey,
  styleRowFromGroupKey,
  type StoneListQuery,
  type StonePickerSource,
  type StoneRefState,
} from './source.js'

/** 排板形态（design §5：样卡心智 vs 工艺心智）。 */
export type StonePickerLayout = 'color' | 'size'

/** 单轴加载态（排板面/推荐面各持一份）。 */
export type StonePickerPhase = 'idle' | 'loading' | 'ready' | 'error'

/** 款式行节点（color 形态二级：groupBy='style' 键+懒加载单元）。 */
export interface StyleRowNode {
  key: string
  styleRow: number | null
  cells: StoneGridCell[]
  phase: StonePickerPhase
}

export interface StonePickerStoreOptions {
  /** 搜索去抖（测试注入 0；产品缺省 150ms）。 */
  searchDebounceMs?: number
  /** 尺寸变体/色阵子查询页大小（RPC 上限 200）。 */
  pageSize?: number
}

const SEARCH_DEBOUNCE_MS = 150
const PAGE_SIZE = 200

export class StonePickerStore {
  readonly source: StonePickerSource
  private readonly searchDebounceMs: number
  private readonly pageSize: number

  // ------------------------------------------------------------ 查询面状态
  layout = $state<StonePickerLayout>('color')
  /** 搜索词（SKU/色名/十六进制——q 服务端口径子串匹配）。 */
  q = $state('')
  /**
   * 活跃组合过滤投影位（design §7.5）：非 null 时查询携带 activeSetId 进协议；
   * 组合解析归 set RPC 端点+P3.2 接线——本 store 不实现成员投影（接口位冻结）。
   */
  activeSetId = $state<string | null>(null)

  // ------------------------------------------------------------ 排板面（color）
  boardPhase = $state<StonePickerPhase>('idle')
  boardError = $state('')
  families = $state<string[]>([])
  selectedFamily = $state<string | null>(null)
  styleRows = $state<StyleRowNode[]>([])

  // ------------------------------------------------------------ 排板面（size）
  sizeTiers = $state<string[]>([])
  selectedTier = $state<string | null>(null)
  tierCells = $state<StoneGridCell[]>([])

  // ------------------------------------------------------------ ΔE 邻近推荐
  /** 目标色（null=推荐面板收起）。 */
  nearColor = $state<RgbTuple | null>(null)
  /** hex 输入的回显/校验错误（非法十六进制不猜测）。 */
  nearColorInput = $state('')
  nearColorError = $state('')
  recommendPhase = $state<StonePickerPhase>('idle')
  recommendError = $state('')
  recommendedCells = $state<StoneGridCell[]>([])

  // ------------------------------------------------------------ 选中产出
  selectedCell = $state<StoneGridCell | null>(null)
  selectedPick = $state<StonePick | null>(null)
  /** 选中钻的引用解析态（source.get 回填——四态缺失标注数据源）。 */
  selectedRefState = $state<StoneRefState | null>(null)

  private loadSeq = 0
  private searchTimer: ReturnType<typeof setTimeout> | null = null

  constructor(source: StonePickerSource, options: StonePickerStoreOptions = {}) {
    this.source = source
    this.searchDebounceMs = options.searchDebounceMs ?? SEARCH_DEBOUNCE_MS
    this.pageSize = options.pageSize ?? PAGE_SIZE
  }

  // ------------------------------------------------------------ 生命周期

  /** 初始/布局切换/搜索去抖后的统一入口（重走当前形态的键面+展开面）。 */
  async refresh(): Promise<void> {
    const seq = (this.loadSeq += 1)
    this.boardPhase = 'loading'
    this.boardError = ''
    try {
      if (this.layout === 'color') await this.loadColorBoard(seq)
      else await this.loadSizeBoard(seq)
      if (seq === this.loadSeq) this.boardPhase = 'ready'
    } catch (error) {
      if (seq !== this.loadSeq) return
      this.boardPhase = 'error'
      this.boardError = error instanceof Error ? error.message : String(error)
    }
    if (this.nearColor !== null) void this.refreshRecommendations()
  }

  setLayout(layout: StonePickerLayout): void {
    if (this.layout === layout) return
    this.layout = layout
    this.styleRows = []
    this.tierCells = []
    this.selectedTier = null
    void this.refresh()
  }

  /** 搜索词入站：即时回显 + 去抖刷新（0ms 测试直连）。 */
  setQ(text: string): void {
    this.q = text
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = setTimeout(
      () => {
        this.searchTimer = null
        void this.refresh()
      },
      this.searchDebounceMs,
    )
  }

  /** 活跃组合接口位写入（投影语义归 P3.2——写后刷新走同一查询面）。 */
  setActiveSetId(setId: string | null): void {
    this.activeSetId = setId
    void this.refresh()
  }

  private baseQuery(): Pick<StoneListQuery, 'q' | 'activeSetId'> {
    const query: Pick<StoneListQuery, 'q' | 'activeSetId'> = {}
    if (this.q.trim() !== '') query.q = this.q.trim()
    if (this.activeSetId !== null) query.activeSetId = this.activeSetId
    return query
  }

  // ------------------------------------------------------------ color 形态（三级展开）

  private async loadColorBoard(seq: number): Promise<void> {
    const keysResult = await this.source.list({ ...this.baseQuery(), groupBy: 'family', page: 1, pageSize: 1 })
    if (seq !== this.loadSeq) return
    this.families = keysResult.groupKeys ?? []
    if (this.families.length === 0) {
      this.selectedFamily = null
      this.styleRows = []
      return
    }
    if (this.selectedFamily === null || !this.families.includes(this.selectedFamily)) {
      this.selectedFamily = this.families[0] as string
    }
    await this.loadStyleRows(this.selectedFamily, seq)
  }

  private async loadStyleRows(family: string, seq: number): Promise<void> {
    const keysResult = await this.source.list({ ...this.baseQuery(), family, groupBy: 'style', page: 1, pageSize: 1 })
    if (seq !== this.loadSeq) return
    // '未编行' 无 styleRow 过滤参数——键面照列，展开时走客户端过滤（见 expandStyleRow）。
    this.styleRows = (keysResult.groupKeys ?? []).map((key) => ({
      key,
      styleRow: styleRowFromGroupKey(key),
      cells: [],
      phase: 'idle' as StonePickerPhase,
    }))
  }

  selectFamily(family: string): void {
    if (this.selectedFamily === family) return
    this.selectedFamily = family
    this.styleRows = []
    void (async () => {
      const seq = (this.loadSeq += 1)
      this.boardPhase = 'loading'
      try {
        await this.loadStyleRows(family, seq)
        if (seq === this.loadSeq) this.boardPhase = 'ready'
      } catch (error) {
        if (seq !== this.loadSeq) return
        this.boardPhase = 'error'
        this.boardError = error instanceof Error ? error.message : String(error)
      }
    })()
  }

  /** 款式行展开（懒加载尺寸变体子查询——请求面有界于展开行）。 */
  async expandStyleRow(row: StyleRowNode): Promise<void> {
    if (row.phase === 'loading' || row.cells.length > 0) return
    const family = this.selectedFamily
    if (family === null) return
    const seq = this.loadSeq
    row.phase = 'loading'
    try {
      let result
      if (row.styleRow !== null) {
        result = await this.source.list({ ...this.baseQuery(), family, styleRow: row.styleRow, page: 1, pageSize: this.pageSize })
      } else {
        // 未编行桶：family 页客户端过滤 styleName===''（RPC 面无 IS NULL 参数）。
        const page = await this.source.list({ ...this.baseQuery(), family, page: 1, pageSize: this.pageSize })
        result = { ...page, cells: page.cells.filter((cell) => cell.styleName === '') }
      }
      if (seq !== this.loadSeq) return
      row.cells = result.cells
      row.phase = 'ready'
    } catch (error) {
      if (seq !== this.loadSeq) return
      row.phase = 'error'
      row.cells = []
      this.boardError = error instanceof Error ? error.message : String(error)
    }
  }

  // ------------------------------------------------------------ size 形态（档→色阵）

  private async loadSizeBoard(seq: number): Promise<void> {
    const keysResult = await this.source.list({ ...this.baseQuery(), groupBy: 'sizeMm', page: 1, pageSize: 1 })
    if (seq !== this.loadSeq) return
    this.sizeTiers = keysResult.groupKeys ?? []
    if (this.sizeTiers.length === 0) {
      this.selectedTier = null
      this.tierCells = []
      return
    }
    if (this.selectedTier === null || !this.sizeTiers.includes(this.selectedTier)) {
      this.selectedTier = this.sizeTiers[0] as string
    }
    await this.loadTierCells(this.selectedTier, seq)
  }

  private async loadTierCells(tier: string, seq: number): Promise<void> {
    const sizeMm = sizeMmFromGroupKey(tier)
    const result = await this.source.list({
      ...this.baseQuery(),
      ...(sizeMm !== null ? { sizeMm } : {}),
      page: 1,
      pageSize: this.pageSize,
    })
    if (seq !== this.loadSeq) return
    // 未声明桶（sizeMm===null 无过滤参数）：全量页客户端过滤（§8.1 规则 7 显式态）。
    this.tierCells = sizeMm !== null ? result.cells : result.cells.filter((cell) => cell.sizeMm === null)
  }

  selectTier(tier: string): void {
    if (this.selectedTier === tier) return
    this.selectedTier = tier
    this.tierCells = []
    void (async () => {
      const seq = this.loadSeq
      this.boardPhase = 'loading'
      try {
        await this.loadTierCells(tier, seq)
        if (seq === this.loadSeq) this.boardPhase = 'ready'
      } catch (error) {
        if (seq !== this.loadSeq) return
        this.boardPhase = 'error'
        this.boardError = error instanceof Error ? error.message : String(error)
      }
    })()
  }

  // ------------------------------------------------------------ ΔE 邻近推荐（S5.2）

  /** hex 输入提交：合法→设目标色并刷新推荐；非法→显式错误（不猜测）。 */
  async setNearColorFromHex(hex: string): Promise<void> {
    const rgb = hexToRgb(hex)
    this.nearColorInput = hex
    if (rgb === null) {
      this.nearColorError = '十六进制色值须形如 #AABBCC'
      return
    }
    this.nearColorError = ''
    this.nearColor = rgb
    await this.refreshRecommendations()
  }

  /** 从单元格取目标色（图块代表色→邻近推荐入口）。 */
  async setNearColorFromCell(cell: StoneGridCell): Promise<void> {
    const rgb = hexToRgb(cell.colorHex)
    if (rgb === null) return
    this.nearColorInput = cell.colorHex
    this.nearColorError = ''
    this.nearColor = rgb
    await this.refreshRecommendations()
  }

  async refreshRecommendations(): Promise<void> {
    if (this.nearColor === null) {
      this.recommendedCells = []
      this.recommendPhase = 'idle'
      return
    }
    const seq = this.loadSeq
    this.recommendPhase = 'loading'
    this.recommendError = ''
    try {
      const result = await this.source.list({
        ...this.baseQuery(),
        nearColor: this.nearColor,
        page: 1,
        pageSize: this.pageSize,
      })
      if (seq !== this.loadSeq) return
      this.recommendedCells = result.cells
      this.recommendPhase = 'ready'
    } catch (error) {
      if (seq !== this.loadSeq) return
      this.recommendPhase = 'error'
      this.recommendError = error instanceof Error ? error.message : String(error)
    }
  }

  clearNearColor(): void {
    this.nearColor = null
    this.nearColorInput = ''
    this.nearColorError = ''
    this.recommendedCells = []
    this.recommendPhase = 'idle'
  }

  // ------------------------------------------------------------ 选中产出（StonePick 契约）

  /**
   * 选中单元格：即时产出 StonePick（结构化引用五字段，schema parse 守门）；
   * gemshapeRef 经 source.get 异步富集，引用态非 resolved 时显式标注不阻断。
   */
  selectCell(cell: StoneGridCell): void {
    this.selectedCell = cell
    this.selectedRefState = null
    const pick: StonePick = {
      resourceId: cell.resourceId,
      sku: cell.sku,
      supplier: cell.supplier,
      sizeMm: cell.sizeMm,
      colorHex: cell.colorHex,
    }
    this.selectedPick = StonePickSchema.parse(pick)
    void this.enrichPick(cell.resourceId)
  }

  private async enrichPick(resourceId: string): Promise<void> {
    try {
      const outcome = await this.source.get(resourceId)
      if (this.selectedCell?.resourceId !== resourceId) return
      this.selectedRefState = outcome.state
      if (outcome.gemshapeRef === undefined) return
      if (this.selectedPick?.resourceId === resourceId) {
        this.selectedPick = StonePickSchema.parse({ ...this.selectedPick, gemshapeRef: outcome.gemshapeRef })
      }
    } catch {
      // 富集失败不阻断选中（StonePick gemshapeRef 本就 optional）——引用态留空（未解析≠缺失）。
    }
  }

  clearSelection(): void {
    this.selectedCell = null
    this.selectedPick = null
    this.selectedRefState = null
  }

  /** 测试辅助：清空去抖定时器（防 unmount 后晚到 refresh）。 */
  dispose(): void {
    if (this.searchTimer !== null) clearTimeout(this.searchTimer)
    this.searchTimer = null
    this.loadSeq += 1
  }
}
