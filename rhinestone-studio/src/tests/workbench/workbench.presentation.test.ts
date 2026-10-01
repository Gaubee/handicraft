/*
 * [rework-layer-ps-panel-presentation] 表现层三件单元/组件测试（Codex D/E 验收）：
 *   [U1] 羽化（D1/D2——纯前端渲染层软化）：
 *     - 距离场软化 alpha 剖面：垂直边 fixture 3px/5px 两档——外 0/内 255/边界带
 *       线性渐变（无硬阶梯=相邻步进 ≤ 单档步长）、无 halo（mask 外恒 0）；
 *     - 斜边 fixture：沿法线单调渐变（无回跳）；
 *     - 半像素/采样对齐（D1-3）：mask 像素中心采样语义——bbox 像素中心比例落位
 *       断言（不机械加半像素——变换链一致即锁定）；
 *     - 几何不变式（D2-4）：drawImage 源区域/合成序与羽化前一致、二值 bits 不被
 *       改写、destination-in 通路保留；
 *     - 主图/缩略共用软化结果：缩略 drawImage 的源=软化主位图（同身份）。
 *   [U2] 缩略双模式（E1）：
 *     - containPlacement 几何单源直测（fixture 画布 120×160 → 32×32）；
 *     - 面板 segmented 在场+「蒙版」产品开关退役（不在 DOM）；
 *     - 切换 ps→thumb data-mode 面、节点 id/选中/fx 徽标颗数不随模式变化；
 *     - setShowMasks dev-only 注入面照常驱动蒙版叠加（诊断链退役不移除）。
 *   [U3] grid overlay（E2/E3）：
 *     - 单一定位根：预览模式与背景簇同根（observation-grid 内两单元）；
 *     - 根 pointer-events-none+grid 单元 pointer-events-auto（事件命中面）；
 *     - 两组件不再各自 absolute 定位（class 无 absolute 与顶部/左右定位对）。
 * jsdom 无布局/无 2d canvas——宽度三档与像素级渐变由真浏览器走查承接（截图+
 * 程序化像素校验），本套锁定结构面与纯函数面。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount, tick, unmount, type Component } from 'svelte'
import TaskWorkbenchView from '$lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte'
import type { ObjectNode } from '@handicraft/contracts'
import type { MaskBits, MaskEntry } from '$lib/components/studio/taskWorkbench/maskBits.svelte.js'
import { MockAgentApi } from '$lib/agentApi/mock'
import { WORKBENCH_FIXTURE_TASK_ID } from '$lib/agentApi/workbenchFixtures'
import { bindAgentApi, initAgentStore, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { resetViewForTests } from '$lib/stores/view.svelte'
import {
  getShowMasks,
  getThumbMode,
  resetWorkbenchForTests,
  setPreviewMode,
  setShowMasks,
  setThumbMode,
} from '$lib/components/studio/taskWorkbench/store.svelte'
import { resetCanvasStageForTests } from '$lib/components/studio/taskWorkbench/canvasStage.svelte'
import { resetToastsForTests } from '$lib/stores/toast.svelte'
import {
  composeCutoutSurfaces,
  containPlacement,
  getCutoutEntryOf,
  requestCutouts,
  resetCutoutsForTests,
  setCutoutFeatherWidthPxForTests,
  type Cutout2dContext,
  type CutoutHost,
} from '$lib/components/studio/taskWorkbench/cutout.svelte.js'

// ---------------------------------------------------------------- stub 宿主（记录 image 身份——共用软化断言锚）

interface CtxCall {
  op: 'drawImage' | 'putImageData' | 'clearRect'
  image?: unknown
  args: number[]
}

interface StubCtx extends Cutout2dContext {
  calls: CtxCall[]
  lastPut: { data: Uint8ClampedArray } | null
}

interface StubCanvas {
  width: number
  height: number
  ctx: StubCtx
}

function makeStubCtx(): StubCtx {
  const ctx: StubCtx = {
    globalCompositeOperation: 'source-over',
    calls: [],
    lastPut: null,
    drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh) {
      ctx.calls.push({ op: 'drawImage', image, args: [sx, sy, sw, sh, dx, dy, dw, dh] })
    },
    createImageData(w: number, h: number) {
      return { data: new Uint8ClampedArray(w * h * 4) }
    },
    putImageData(image) {
      ctx.lastPut = image
      ctx.calls.push({ op: 'putImageData', args: [image.data.length / 4] })
    },
    clearRect() {
      ctx.calls.push({ op: 'clearRect', args: [] })
    },
  }
  return ctx
}

const stubHost: CutoutHost = {
  createCanvas(): HTMLCanvasElement | null {
    const ctx = makeStubCtx()
    return { width: 0, height: 0, ctx } satisfies StubCanvas as unknown as HTMLCanvasElement
  },
  contextOf(canvas: HTMLCanvasElement): Cutout2dContext | null {
    return (canvas as unknown as StubCanvas).ctx
  },
  loadImage: async () => ({ width: 120, height: 160 }),
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function bitsOf(w: number, h: number, inside: (x: number, y: number) => boolean): MaskBits {
  const bits = new Uint8Array(w * h)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) bits[y * w + x] = inside(x, y) ? 1 : 0
  }
  return { w, h, bits }
}

/** 垂直边 alpha 剖面（bbox 与 mask 同尺寸——srcPerMask=1：列 x 的 alpha 取行中位）。 */
function columnAlphaProfile(maskCtx: StubCtx, w: number, y: number): number[] {
  const out: number[] = []
  for (let x = 0; x < w; x += 1) out.push(maskCtx.lastPut!.data[(y * w + x) * 4 + 3]!)
  return out
}

beforeEach(() => {
  resetCutoutsForTests(stubHost)
})

afterEach(() => {
  resetCutoutsForTests()
})

// ---------------------------------------------------------------- [U1] 羽化

describe('U1 羽化（Codex D1/D2——mask 距离场软化 alpha）', () => {
  /** 16×16 mask：左半 inside（x<8）——垂直边在 x=7/8 之间；bbox 同尺寸（比例 1:1）。 */
  const VERTICAL_EDGE = () => bitsOf(16, 16, (x) => x < 8)

  it('3px 档：外 0/内 255/边界带线性渐变——无硬阶梯无 halo', () => {
    setCutoutFeatherWidthPxForTests(3)
    const ctx = makeStubCtx()
    const maskCtx = makeStubCtx()
    composeCutoutSurfaces(ctx, maskCtx, { maskCanvas: true }, { width: 16, height: 16 }, VERTICAL_EDGE(), { x: 0, y: 0, w: 16, h: 16 })
    const profile = columnAlphaProfile(maskCtx, 16, 5)
    // 边界外（x≥8）：恒 0——无 halo（羽化只向内软化，边界外保持全透明）
    for (let x = 8; x < 16; x += 1) expect(profile[x]).toBe(0)
    // 深入内部（x≤4，距边 ≥4px > 3px 档）：稳定 255
    for (let x = 0; x <= 4; x += 1) expect(profile[x]).toBe(255)
    // 边界带（x=5..7）：d=3,2,1 → 255,170,85 线性渐变
    expect(profile[5]).toBe(255)
    expect(profile[6]).toBe(170)
    expect(profile[7]).toBe(85)
    // 无硬阶梯：相邻步进 ≤ 单档步长（255/3=85）+舍入容差
    for (let x = 1; x < 16; x += 1) {
      expect(Math.abs(profile[x]! - profile[x - 1]!)).toBeLessThanOrEqual(86)
    }
  })

  it('5px 档：软化带展宽（d=1..5 → 51..255）；3→5 档同 fixture 渐变带单调展宽', () => {
    setCutoutFeatherWidthPxForTests(5)
    const maskCtx = makeStubCtx()
    composeCutoutSurfaces(makeStubCtx(), maskCtx, { maskCanvas: true }, { width: 16, height: 16 }, VERTICAL_EDGE(), { x: 0, y: 0, w: 16, h: 16 })
    const profile = columnAlphaProfile(maskCtx, 16, 9)
    expect(profile[7]).toBe(51) // d=1 → 255/5
    expect(profile[6]).toBe(102) // d=2
    expect(profile[5]).toBe(153) // d=3
    expect(profile[4]).toBe(204) // d=4
    expect(profile[3]).toBe(255) // d=5 —— 稳定区
    for (let x = 8; x < 16; x += 1) expect(profile[x]).toBe(0)
    // 相邻步进 ≤ 255/5+舍入
    for (let x = 1; x < 16; x += 1) {
      expect(Math.abs(profile[x]! - profile[x - 1]!)).toBeLessThanOrEqual(52)
    }
  })

  it('斜边 fixture：沿法线单调渐变（对角带 mask——行内先升后降、无回跳）', () => {
    setCutoutFeatherWidthPxForTests(3)
    // 对角带 19≤x+y≤30：法线宽 12/√2≈8.49px——带中心法距 ≈4.2px > 3px 档（稳定区在场）
    const diag = bitsOf(24, 24, (x, y) => x + y >= 19 && x + y <= 30)
    const maskCtx = makeStubCtx()
    composeCutoutSurfaces(makeStubCtx(), maskCtx, { maskCanvas: true }, { width: 24, height: 24 }, diag, { x: 0, y: 0, w: 24, h: 24 })
    // 对角带沿 +x 穿越剖面：进入带（法线方向渐入——单调升）→ 带中（255）→ 离开带
    //（单调降）。断言=峰前单调不减+峰后单调不增（连续渐变无回跳）。
    for (const y of [3, 10, 18]) {
      const row: number[] = []
      for (let x = 0; x < 24; x += 1) row.push(maskCtx.lastPut!.data[(y * 24 + x) * 4 + 3]!)
      let peak = 0
      for (let x = 1; x < row.length; x += 1) if (row[x]! > row[peak]!) peak = x
      for (let x = 1; x <= peak; x += 1) expect(row[x]).toBeGreaterThanOrEqual(row[x - 1]!)
      for (let x = peak + 1; x < row.length; x += 1) expect(row[x]).toBeLessThanOrEqual(row[x - 1]!)
      // 峰值=带中心（法距 >3px——3px 档稳定区 255）
      expect(row[peak]).toBe(255)
      // 行首=带外（全透明；行尾在斜带走向下可能仍处带内——带外恒 0 的 halo 断言
      // 由垂直边用例的 8 列全零覆盖）
      expect(row[0]).toBe(0)
    }
  })

  it('mask 采样像素中心语义（半像素对齐 fixture——D1-3）：上采样边界落位与像素中心一致', () => {
    // 4×4 mask：右半 inside（x≥2）——bbox 8×8 上采样（每 mask 单元=2×2 bbox 像素）
    const bits = bitsOf(4, 4, (x) => x >= 2)
    const maskCtx = makeStubCtx()
    composeCutoutSurfaces(makeStubCtx(), maskCtx, { maskCanvas: true }, { width: 8, height: 8 }, bits, { x: 0, y: 0, w: 8, h: 8 })
    // bbox 像素中心 (x+0.5)/8*4=x/4+0.25 → x<3 落 mask x=0/1（outside）、x≥4 落 x=2/3（inside）；
    // x=3 中心=1.75 → floor=1=outside。断言边界恰在 x=3/4 之间（像素中心语义，无机械半像素偏移）
    const profile = columnAlphaProfile(maskCtx, 8, 4)
    for (let x = 0; x <= 3; x += 1) expect(profile[x]).toBe(0)
    for (let x = 4; x <= 7; x += 1) expect(profile[x]).toBeGreaterThan(0)
  })

  it('几何不变式（D2-4）：drawImage 源区域/合成序不变、bits 不被改写、destination-in 保留', () => {
    const bits = VERTICAL_EDGE()
    const bitsSnapshot = Uint8Array.from(bits.bits)
    const ctx = makeStubCtx()
    const maskCtx = makeStubCtx()
    composeCutoutSurfaces(ctx, maskCtx, { maskCanvas: true }, { width: 120, height: 160 }, bits, { x: 24, y: 28, w: 16, h: 16 })
    const draws = ctx.calls.filter((call) => call.op === 'drawImage')
    // 主面：原图 bbox 区域（24,28,16,16）→ (0,0,16,16)；destination-in 合入蒙版画布
    expect(draws[0]?.args).toEqual([24, 28, 16, 16, 0, 0, 16, 16])
    expect(draws[1]?.args).toEqual([0, 0, 16, 16, 0, 0, 16, 16])
    expect(draws.length).toBe(2)
    // 二值 mask 位面零改写（只读派生——二值契约不变）
    expect(Array.from(bits.bits)).toEqual(Array.from(bitsSnapshot))
  })

  it('主图/缩略共用软化结果：缩略 drawImage 源=软化主位图（同身份）+羽化只改 alpha 数值面', async () => {
    setCutoutFeatherWidthPxForTests(3)
    const node: ObjectNode = {
      id: 'n-hat',
      objectName: '帽子',
      category: 'clothing',
      mask: { kind: 'inline', w: 16, h: 16, dataBase64: '' },
      bbox: { x: 36, y: 28, w: 16, h: 16 },
      parent: 'root',
      children: [],
      effectiveMm: 10,
      labVariance: 8,
      drillWorthy: true,
      origin: 'test',
    } as unknown as ObjectNode
    const ready: MaskEntry = { phase: 'ready', bits: VERTICAL_EDGE(), error: null, ref: 'blob:mask-a' }
    requestCutouts([node], {
      baseImageUrl: 'data:image/png;base64,xxx',
      baseImageRef: 'base-1',
      getMaskEntry: () => ready,
    })
    await flush()
    const entry = getCutoutEntryOf('n-hat')
    expect(entry.phase).toBe('ready')
    const thumb = entry.thumb as unknown as StubCanvas
    // 缩略从软化主位图缩采样（drawImage 源=主 canvas 同身份——共用同一软化结果；
    // 主位图自身的软化 alpha 剖面已在 composeCutoutSurfaces 级用例锁定）
    const thumbDraw = thumb.ctx.calls.find((call) => call.op === 'drawImage')
    expect(thumbDraw?.image).toBe(entry.canvas)
  })
})

// ---------------------------------------------------------------- [U2] 缩略双模式

describe('U2 缩略双模式（Codex E1——几何单源+面板面）', () => {
  it('containPlacement：整画布 120×160 contain 32×32 → scale=0.2 居中（4×0 偏移）；更大正方形=半格缩放', () => {
    const place = containPlacement(32, 32, 120, 160)
    expect(place.scale).toBeCloseTo(0.2)
    expect(place.ox).toBeCloseTo(4)
    expect(place.oy).toBeCloseTo(0)
    // fixture 帽子 bbox (36,28,48,30) 放回：缩略格内 x=4+36*0.2=11.2（保留全局空间关系）
    expect(11.2).toBeCloseTo(place.ox + 36 * place.scale)
    // 64×64 内容进 32×32 盒 → scale=0.5 居中满幅（无留边）
    const big = containPlacement(32, 32, 64, 64)
    expect(big.scale).toBeCloseTo(0.5)
    expect(big.ox).toBe(0)
    expect(big.oy).toBe(0)
  })
})

// ---------------------------------------------------------------- [U2/U3] 组件结构面（jsdom）

describe('presentation 组件面（segmented/退役蒙版开关/grid 单根）', () => {
  const mountedDisposers: Array<() => void> = []

  beforeEach(async () => {
    localStorage.clear()
    resetAgentStoreForTests()
    resetWorkbenchForTests()
    resetCanvasStageForTests()
    resetViewForTests('studio')
    resetToastsForTests()
    bindAgentApi(new MockAgentApi({ speed: 0 }))
    await initAgentStore()
  })

  afterEach(() => {
    mountedDisposers.splice(0).forEach((dispose) => dispose())
    document.body.innerHTML = ''
    localStorage.clear()
  })

  async function mountWorkbench(): Promise<void> {
    const target = document.createElement('div')
    document.body.appendChild(target)
    const instance = mount(TaskWorkbenchView as unknown as Component<Record<string, unknown>>, {
      target,
      props: { taskId: WORKBENCH_FIXTURE_TASK_ID },
    })
    mountedDisposers.push(() => {
      unmount(instance)
      target.remove()
    })
    await tick()
  }

  function q(selector: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(selector)
  }

  async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms
    while (!cond() && Date.now() < deadline) {
      await tick()
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (!cond()) throw new Error('waitUntil 超时')
  }

  it('U2：headerBar trim/ps segmented 在场；「蒙版」产品开关退役（不在 DOM）；根行缩略两模式均原图', async () => {
    await mountWorkbench()
    await waitUntil(() => document.querySelectorAll('[data-testid="workbench-layer-row"]').length === 5)
    const segmented = q('[data-testid="workbench-thumb-mode"]')
    expect(segmented).not.toBeNull()
    expect(segmented?.getAttribute('role')).toBe('radiogroup')
    expect(q('[data-testid="workbench-thumb-mode-trim"]')).not.toBeNull()
    expect(q('[data-testid="workbench-thumb-mode-ps"]')).not.toBeNull()
    // 「蒙版」产品开关退役——DOM 不在场（dev-only 注入面经 store 驱动）
    expect(q('[data-testid="workbench-mask-toggle"]')).toBeNull()
    // 根「画布」行两模式均原图（base 面）
    expect(q('[data-testid="workbench-layer-thumb-n-canvas"]')?.getAttribute('data-phase')).toBe('base')
  })

  it('U2：切换 ps→thumb data-mode 面+节点 id/选中/fx 徽标颗数不变（观察态不写树）', async () => {
    await mountWorkbench()
    await waitUntil(() => document.querySelectorAll('[data-testid="workbench-layer-row"]').length === 5)
    const idsBefore = [...document.querySelectorAll('[data-testid="workbench-layer-row"]')].map((row) => row.getAttribute('data-node-id'))
    const fxBefore = [...document.querySelectorAll('[data-testid^="workbench-layer-fx-"]')].map((badge) => badge.getAttribute('data-gem-count'))
    // 选中帽子
    q('[data-testid="workbench-layer-select-n-hat"]')!.click()
    await tick()
    expect(q('[data-testid="workbench-layer-select-n-hat"]')?.getAttribute('aria-pressed')).toBe('true')

    q('[data-testid="workbench-thumb-mode-ps"]')!.click()
    await tick()
    expect(getThumbMode()).toBe('ps')
    expect(q('[data-testid="workbench-layer-thumb-n-hat"]')?.getAttribute('data-mode')).toBe('ps')
    expect(q('[data-testid="workbench-layer-thumb-n-clown"]')?.getAttribute('data-mode')).toBe('ps')
    // 观察态：节点 id/选中/fx 颗数不变
    const idsAfter = [...document.querySelectorAll('[data-testid="workbench-layer-row"]')].map((row) => row.getAttribute('data-node-id'))
    const fxAfter = [...document.querySelectorAll('[data-testid^="workbench-layer-fx-"]')].map((badge) => badge.getAttribute('data-gem-count'))
    expect(idsAfter).toEqual(idsBefore)
    expect(fxAfter).toEqual(fxBefore)
    expect(q('[data-testid="workbench-layer-select-n-hat"]')?.getAttribute('aria-pressed')).toBe('true')

    q('[data-testid="workbench-thumb-mode-trim"]')!.click()
    await tick()
    expect(getThumbMode()).toBe('trim')
    expect(q('[data-testid="workbench-layer-thumb-n-hat"]')?.getAttribute('data-mode')).toBe('trim')
  })

  it('U2：setShowMasks dev-only 注入面照常驱动蒙版叠加（诊断链保留）', async () => {
    await mountWorkbench()
    await waitUntil(() => document.querySelectorAll('[data-testid="workbench-layer-row"]').length === 5)
    expect(document.querySelectorAll('[data-mask-on="true"]')).toHaveLength(0)
    setShowMasks(true)
    await tick()
    await waitUntil(() => document.querySelectorAll('[data-mask-on="true"]').length > 0)
    expect(getShowMasks()).toBe(true)
    setShowMasks(false)
    await tick()
    await waitUntil(() => document.querySelectorAll('[data-mask-on="true"]').length === 0)
  })

  it('U3：单一定位根——预览模式与背景簇同在 observation-grid 内；根不接收指针；无独立 absolute 定位', async () => {
    await mountWorkbench()
    await waitUntil(() => q('[data-testid="workbench-preview-mode"]') !== null)
    const root = q('[data-testid="workbench-observation-root"]')
    const grid = q('[data-testid="workbench-observation-grid"]')
    expect(root).not.toBeNull()
    expect(grid).not.toBeNull()
    // 根=container query 基准（inline-size）+不接收指针（不遮画布主体）
    expect(root?.style.containerType).toBe('inline-size')
    expect(root?.classList.contains('pointer-events-none')).toBe(true)
    expect(grid?.classList.contains('pointer-events-auto')).toBe(true)
    // [w19-critic P0] 避让轨全高（inset-y-0）后 flex 缺省 stretch 曾把可见 grid 拉满
    // 列高（434×764 磨砂大卡盖画布——上轮 avoidLeft/avoidRight 避让改造引入）：
    // 根 items-start + grid h-fit/self-start 双保险=grid 自撑内容高（紧凑 pill 形态）。
    expect(root?.classList.contains('items-start')).toBe(true)
    expect(grid?.classList.contains('h-fit')).toBe(true)
    expect(grid?.classList.contains('self-start')).toBe(true)
    // 两单元同根：preview-mode 与 base-controls 都在 grid 内
    const preview = q('[data-testid="workbench-preview-mode"]')!
    const base = q('[data-testid="workbench-base-controls"]')!
    expect(grid!.contains(preview)).toBe(true)
    expect(grid!.contains(base)).toBe(true)
    // 各自 absolute 坐标退役：两单元不再持 absolute/定位 top-left 对
    for (const el of [preview, base]) {
      expect(el.classList.contains('absolute')).toBe(false)
      expect(el.style.top + el.style.left + el.style.right).toBe('')
    }
    // 事件命中面：预览按钮点击改 previewMode（命中不串写到背景面）
    const before = q('[data-testid="workbench-preview-holes"]')?.getAttribute('aria-pressed')
    expect(before).toBe('false')
    q('[data-testid="workbench-preview-holes"]')!.click()
    await tick()
    expect(q('[data-testid="workbench-preview-holes"]')?.getAttribute('aria-pressed')).toBe('true')
    // 背景眼睛独立命中（显隐切换——与预览模式不串写）
    const eyePressed = q('[data-testid="workbench-base-toggle"]')?.getAttribute('aria-pressed')
    q('[data-testid="workbench-base-toggle"]')!.click()
    await tick()
    expect(q('[data-testid="workbench-base-toggle"]')?.getAttribute('aria-pressed')).not.toBe(eyePressed)
    expect(q('[data-testid="workbench-preview-holes"]')?.getAttribute('aria-pressed')).toBe('true')
    setPreviewMode('rendered')
  })
})
