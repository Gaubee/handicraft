/**
 * 选图器运行时协议（add-asset-library design §5 [Codex-R1-B6] 冻结）：
 * 不暴露裸 pickAsset()；App 层挂载唯一 <AssetPickerHost controller>，
 * studio 上下文条 / lab dropzone / 库内入口消费同一 controller 实例。
 *
 * 协议语义：
 * - open(opts?) → Promise<AssetImage[] | null>；resolve=确定选择；
 * - cancel / Esc / 外部点击 / Host 销毁 → resolve(null)；
 * - 并发 open：后到者接管，前一 promise resolve(null)；
 * - multi 半选态在 cancel 后清空；语义单实例（modal/focus 归 controller 持有）。
 */

import type { AssetImage, AssetNodeId } from '$lib/persistence/assetStore'

export interface AssetPickerOpenOptions {
  multi?: boolean
  initialFolderId?: AssetNodeId | null
}

/** 一次 open 请求的渲染依据（Host 据此决定单/多选与初始目录）。 */
export interface AssetPickerRequest {
  id: number
  multi: boolean
  initialFolderId: AssetNodeId | null
}

interface PickerSession {
  request: AssetPickerRequest
  settle: (images: AssetImage[] | null) => void
}

export class AssetPickerController {
  /** 当前请求（null = 选图器关闭）。 */
  request = $state<AssetPickerRequest | null>(null)
  /** 半选态（cancel/resolve 后清空）。 */
  selection = $state<AssetImage[]>([])

  private session: PickerSession | null = null
  private seq = 0
  private keyListener: ((event: KeyboardEvent) => void) | null = null

  open(opts: AssetPickerOpenOptions = {}): Promise<AssetImage[] | null> {
    // 后到者接管：前一等待方立即 resolve(null)（无活动会话时 no-op）。
    this.cancel()
    const request: AssetPickerRequest = {
      id: (this.seq += 1),
      multi: opts.multi ?? false,
      initialFolderId: opts.initialFolderId ?? null,
    }
    const promise = new Promise<AssetImage[] | null>((resolve) => {
      this.session = { request, settle: resolve }
    })
    this.request = request
    this.selection = []
    this.attachKeyListener()
    return promise
  }

  /** 确定选择（Host「确定」）。无活动会话时 no-op。 */
  resolve(images: AssetImage[]): void {
    const session = this.session
    if (!session) return
    const picked = [...images]
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

  /** 点选：multi=切换半选；单选=整替。 */
  pick(image: AssetImage): void {
    if (this.request?.multi) {
      const index = this.selection.findIndex((sel) => sel.id === image.id)
      if (index >= 0) this.selection.splice(index, 1)
      else this.selection.push({ ...image })
    } else {
      this.selection = [{ ...image }]
    }
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
