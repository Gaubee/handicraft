/**
 * 选图器运行时协议（add-asset-library design §5 [Codex-R1-B6] 冻结）：
 * 不暴露裸 pickAsset()；App 层挂载唯一 <AssetPickerHost controller>，
 * studio 上下文条 / lab dropzone / 库内入口消费同一 controller 实例。
 *
 * 协议语义：
 * - open(opts?) → Promise<AssetImage[] | null>；resolve=确定选择；
 * - openForProjects(kinds) → Promise<AssetProject[] | null>（[add-project-files 3.3]
 *   项目模式：只可选指定 kind 的项目节点，初始目录 sys-projects；Host 隐藏图片与上传）；
 * - cancel / Esc / 外部点击 / Host 销毁 → resolve(null)；
 * - 并发 open：后到者接管，前一 promise resolve(null)；
 * - multi 半选态在 cancel 后清空；语义单实例（modal/focus 归 controller 持有）。
 */

import type { AssetImage, AssetNodeId } from '$lib/persistence/assetStore'
import type { AssetProject, ProjectKind } from '$lib/persistence/projectTypes'

export interface AssetPickerOpenOptions {
  multi?: boolean
  initialFolderId?: AssetNodeId | null
}

/** 项目模式初始目录（项目默认落位；sys-projects 幂等 seed 由 assetStore 保证）。 */
export const ASSET_PICKER_PROJECTS_FOLDER: AssetNodeId = 'sys-projects'

/** 一次 open 请求的渲染依据（Host 据此决定单/多选、初始目录与可选节点类型）。 */
export interface AssetPickerRequest {
  id: number
  multi: boolean
  initialFolderId: AssetNodeId | null
  /** 项目模式：只可选指定 kind 的项目节点（缺席 = 图片模式，既有行为）。 */
  projectKinds?: ProjectKind[]
}

/** 可选节点（图片模式 = AssetImage；项目模式 = AssetProject——由请求模式保证，类型窄化在 open* 出口）。 */
export type AssetPickerSelection = AssetImage | AssetProject

interface PickerSession {
  request: AssetPickerRequest
  settle: (selection: AssetPickerSelection[] | null) => void
}

export class AssetPickerController {
  /** 当前请求（null = 选图器关闭）。 */
  request = $state<AssetPickerRequest | null>(null)
  /** 半选态（cancel/resolve 后清空）。 */
  selection = $state<AssetPickerSelection[]>([])

  private session: PickerSession | null = null
  private seq = 0
  private keyListener: ((event: KeyboardEvent) => void) | null = null

  private startSession(request: AssetPickerRequest): void {
    this.cancel()
    this.session = { request, settle: () => {} }
    this.request = request
    this.selection = []
    this.attachKeyListener()
  }

  open(opts: AssetPickerOpenOptions = {}): Promise<AssetImage[] | null> {
    const request: AssetPickerRequest = {
      id: (this.seq += 1),
      multi: opts.multi ?? false,
      initialFolderId: opts.initialFolderId ?? null,
    }
    this.startSession(request)
    // 图片模式 Host 只 pick 图片节点——联合窄化由请求模式在运行时保证
    const promise = new Promise<AssetPickerSelection[] | null>((resolve) => {
      if (this.session) this.session.settle = resolve
    })
    return promise.then((selection) => (selection === null ? null : (selection as AssetImage[])))
  }

  /** 项目模式（单选）：只可选指定 kind 的项目节点；resolve 元素为 AssetProject。 */
  openForProjects(kinds: readonly ProjectKind[]): Promise<AssetProject[] | null> {
    const request: AssetPickerRequest = {
      id: (this.seq += 1),
      multi: false,
      initialFolderId: ASSET_PICKER_PROJECTS_FOLDER,
      projectKinds: [...kinds],
    }
    this.startSession(request)
    const promise = new Promise<AssetPickerSelection[] | null>((resolve) => {
      if (this.session) this.session.settle = resolve
    })
    return promise.then((selection) => (selection === null ? null : (selection as AssetProject[])))
  }

  /** 确定选择（Host「确定」）。无活动会话时 no-op。 */
  resolve(selection: AssetPickerSelection[]): void {
    const session = this.session
    if (!session) return
    const picked = [...selection]
    this.teardown()
    session.settle(picked)
  }

  /** 取消（取消按钮 / Esc / Dialog 外部点击同路径）。 */
  cancel(): void {
    const session = this.session
    if (!session) return
    this.teardown()
    session.settle(null)
  }

  /** Host 销毁：等待方不得悬挂（design §5「组件销毁 → resolve(null)」）。 */
  destroy(): void {
    this.cancel()
  }

  isSelected(assetId: string): boolean {
    return this.selection.some((image) => image.id === assetId)
  }

  /** 点选图片：multi=切换半选；单选=整替。 */
  pick(image: AssetImage): void {
    if (this.request?.multi) {
      const index = this.selection.findIndex((sel) => sel.id === image.id)
      if (index >= 0) this.selection.splice(index, 1)
      else this.selection.push({ ...image })
    } else {
      this.selection = [{ ...image }]
    }
  }

  /** 点选项目节点（项目模式单选整替；类型过滤归 Host 渲染层）。 */
  pickProject(project: AssetProject): void {
    this.selection = [{ ...project }]
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') this.cancel()
  }

  private attachKeyListener(): void {
    if (typeof document === 'undefined' || this.keyListener) return
    this.keyListener = (event) => this.onKeyDown(event)
    document.addEventListener('keydown', this.keyListener)
  }

  private teardown(): void {
    this.session = null
    this.request = null
    this.selection = []
    if (this.keyListener) {
      document.removeEventListener('keydown', this.keyListener)
      this.keyListener = null
    }
  }
}

/** App 层唯一实例（design §5：单例，App 挂载一个 Host）。 */
export const assetPicker = new AssetPickerController()
