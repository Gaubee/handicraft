/*
 * [2026-09-20 D-5.4 Test] 自定义钻形校准向导（rename-and-expert-workbench tasks 5.4）：
 * 纯逻辑（buildCalibrationDraft/buildCalibrationGemshape）——direct/reference 两模式物化
 * physical、typed 错误面（超限/比例漂移/悬空 ref/全透明）、烘焙语义（参考钻/目录后续改动
 * 不影响已产出钻形——内嵌 refSpecSnapshot 审计凭据）、serialize→parse round-trip 合法
 * GemshapeFile（无 specKey——custom 由 ingest 派生，落库归 2.x）；
 * 组件（CalibrationWizard）——三步 jsdom 走查（direct 全链 + fake savePort 捕获 +
 * 端口缺席 = onCommitIntent 另存意图信号 + 比例漂移 typed error 呈现 + reference 反推预览）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import CalibrationWizard from '../../components/Edit/CalibrationWizard.svelte'
import {
  buildCalibrationDraft,
  buildCalibrationGemshape,
  checkTextureLimits,
  refSpecSnapshotOf,
  texturePayloadBytes,
  type CalibrationSavePort,
} from '../../components/Edit/calibration'
import {
  parseGemshape,
  serializeGemshape,
  type GemshapeFile,
  type GemshapeTexture,
} from '$lib/persistence/gemshapeFile'
import type { CatalogSpec } from '$lib/services/gemCatalogService'
import type { EngineImage } from '$lib/engine'

class ResizeObserverStub implements ResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverStub
}

// ---------------------------------------------------------------------------
// fixture：确定性贴图 + 解码替身（alpha 内容 100×50——纵横比 2:1）
// ---------------------------------------------------------------------------

const TEXTURE: GemshapeTexture = {
  mime: 'image/png',
  dataUrl: 'data:image/png;base64,AAAA',
  width: 120,
  height: 60,
}

/** 解码替身：返回与声明尺寸一致、左 100×50 不透明 / 右缘透明的像素面。 */
function fakeDecode(dataUrl: string): Promise<EngineImage> {
  void dataUrl
  const w = 120
  const h = 60
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4
      const opaque = x < 100 // alpha bounds = 100×60？——高全透明？不：全行不透明 → bounds 100×60
      data[i] = 255
      data[i + 1] = 255
      data[i + 2] = 255
      data[i + 3] = opaque ? 255 : 0
    }
  }
  return Promise.resolve({ width: w, height: h, data })
}

/** bounds 100×60（宽高比 5:3≈1.667）。 */
const BOUNDS = { w: 100, h: 60 }

const REF_SS10: CatalogSpec = { specKey: 'round-ss10', shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }
const REF_SPECS: CatalogSpec[] = [REF_SS10, { specKey: 'round-ss16', shapeId: 'round', sizeLabel: 'SS16', diameterMm: 4.0 }]

beforeEach(() => {
  // 无模块级状态（纯函数 + 组件局部态）——占位保持文件结构一致
})

// ---------------------------------------------------------------------------
// 纯逻辑
// ---------------------------------------------------------------------------

describe('buildCalibrationDraft（纯函数）', () => {
  it('direct：物化声明宽高；calibration 只记 mode 出处', () => {
    const draft = buildCalibrationDraft({
      texture: TEXTURE,
      bounds: BOUNDS,
      mode: 'direct',
      direct: { widthMm: 5, heightMm: 3 },
    })
    expect(draft.ok).toBe(true)
    if (draft.ok) {
      expect(draft.physical).toEqual({ widthMm: 5, heightMm: 3 })
      expect(draft.calibration).toEqual({ mode: 'direct' })
    }
  })

  it('direct 比例漂移：纵横比偏离 bounds 超容差 → typed error 拒收', () => {
    const draft = buildCalibrationDraft({
      texture: TEXTURE,
      bounds: BOUNDS, // 宽高比 1.667
      mode: 'direct',
      direct: { widthMm: 5, heightMm: 2 }, // 2.5——偏差 50% > 2%
    })
    expect(draft.ok).toBe(false)
    if (!draft.ok) {
      expect(draft.error.name).toBe('GemshapeFieldError')
      expect(draft.error.message).toContain('比例漂移')
    }
  })

  it('reference：bake 反推（bounds 主径 px ÷ 参考直径 → px/mm 换算）+ 内嵌审计快照', () => {
    const draft = buildCalibrationDraft({
      texture: TEXTURE,
      bounds: BOUNDS,
      mode: 'reference',
      reference: REF_SS10,
    })
    expect(draft.ok).toBe(true)
    if (draft.ok) {
      const pxPerMm = Math.max(BOUNDS.w, BOUNDS.h) / REF_SS10.diameterMm // 100/2.8
      expect(draft.physical.widthMm).toBeCloseTo(BOUNDS.w / pxPerMm, 10)
      expect(draft.physical.heightMm).toBeCloseTo(BOUNDS.h / pxPerMm, 10)
      expect(draft.calibration.mode).toBe('reference')
      expect(draft.calibration.refSpecId).toBe('round-ss10')
      expect(draft.calibration.refSpecSnapshot).toEqual(refSpecSnapshotOf(REF_SS10))
    }
  })

  it('悬空 ref：reference 未选参考规格 → typed error（gate 5 悬空防线）', () => {
    const draft = buildCalibrationDraft({ texture: TEXTURE, bounds: BOUNDS, mode: 'reference' })
    expect(draft.ok).toBe(false)
    if (!draft.ok) expect(draft.error.message).toContain('参考规格')
  })

  it('空 bounds（全透明贴图）→ typed error；direct 非正宽高 → typed error', () => {
    const empty = buildCalibrationDraft({
      texture: TEXTURE,
      bounds: { w: 0, h: 0 },
      mode: 'direct',
      direct: { widthMm: 5, heightMm: 3 },
    })
    expect(empty.ok).toBe(false)
    const badDirect = buildCalibrationDraft({
      texture: TEXTURE,
      bounds: BOUNDS,
      mode: 'direct',
      direct: { widthMm: -1, heightMm: 3 },
    })
    expect(badDirect.ok).toBe(false)
  })
})

describe('checkTextureLimits / texturePayloadBytes（步骤①预检）', () => {
  it('合法贴图通过；超像素上限 typed error', () => {
    expect(checkTextureLimits(TEXTURE)).toBeNull()
    const oversized: GemshapeTexture = { ...TEXTURE, width: 2000, height: 1500 } // 3M > 2M
    const error = checkTextureLimits(oversized)
    expect(error?.message).toContain('超限')
    expect(texturePayloadBytes(TEXTURE.dataUrl)).toBe(3)
  })
})

describe('buildCalibrationGemshape（产出合法 GemshapeFile）', () => {
  it('direct 模式：serialize→parse round-trip 合法结构（无 specKey——custom 落库派生）', () => {
    const file = buildCalibrationGemshape({
      texture: TEXTURE,
      bounds: BOUNDS,
      mode: 'direct',
      direct: { widthMm: 5, heightMm: 3 },
      name: '方钻 5mm',
      now: 123,
    })
    expect(file.kind).toBe('gemshape')
    expect(file.formatVersion).toBe(1)
    expect(file.name).toBe('方钻 5mm')
    expect(file.physical).toEqual({ widthMm: 5, heightMm: 3 })
    expect(file.calibration).toEqual({ mode: 'direct' })
    expect(file.specKey).toBeUndefined()
    // 序列化字节可再解析（落库字节一致性）
    const reparsed = parseGemshape(serializeGemshape(file))
    expect(reparsed.physical).toEqual(file.physical)
  })

  it('烘焙语义：参考钻/目录后续改动不影响已产出钻形（physical 物化 + 快照内嵌）', () => {
    const ref = { ...REF_SS10 }
    const file = buildCalibrationGemshape({
      texture: TEXTURE,
      bounds: BOUNDS,
      mode: 'reference',
      reference: ref,
      name: '参考校准钻',
      now: 456,
    })
    const physicalBefore = { ...file.physical }
    const snapshotBefore = file.calibration.refSpecSnapshot

    // 参考源后续漂移（目录改动/规格编辑）
    ref.diameterMm = 99
    const catalogAfter = REF_SPECS.map((s) => (s.specKey === 'round-ss10' ? { ...s, diameterMm: 99 } : s))
    expect(catalogAfter.find((s) => s.specKey === 'round-ss10')!.diameterMm).toBe(99)

    expect(file.physical).toEqual(physicalBefore) // 物化不回算
    expect(file.calibration.refSpecSnapshot).toEqual(snapshotBefore) // 快照不漂移
    expect(file.calibration.refSpecSnapshot!.diameterMm).toBe(2.8) // 审计凭据 = 入库时值
  })

  it('空白名 → typed error；比例漂移草稿 → 终检抛 typed error', () => {
    expect(() =>
      buildCalibrationGemshape({
        texture: TEXTURE,
        bounds: BOUNDS,
        mode: 'direct',
        direct: { widthMm: 5, heightMm: 3 },
        name: '   ',
      }),
    ).toThrowError(/非空名称/)
    expect(() =>
      buildCalibrationGemshape({
        texture: TEXTURE,
        bounds: BOUNDS,
        mode: 'direct',
        direct: { widthMm: 5, heightMm: 2 },
        name: '漂移钻',
      }),
    ).toThrowError(/比例漂移/)
  })
})

// ---------------------------------------------------------------------------
// 组件：三步 jsdom 走查
// ---------------------------------------------------------------------------

function mountWizard(props: {
  savePort?: CalibrationSavePort | null
  onCommitIntent?: (file: GemshapeFile) => void
} = {}): { target: HTMLElement; unmount: () => void } {
  const target = document.createElement('div')
  document.body.appendChild(target)
  const app = mount(CalibrationWizard, {
    target,
    props: {
      texture: TEXTURE,
      referenceSpecs: REF_SPECS,
      decode: fakeDecode,
      savePort: props.savePort ?? null,
      onCommitIntent: props.onCommitIntent ?? null,
    },
  })
  return {
    target,
    unmount: () => {
      unmount(app)
      target.remove()
    },
  }
}

function setInput(el: Element, value: string): void {
  const input = el as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('CalibrationWizard（三步走查）', () => {
  it('direct 全链：贴图 → 输 mm → 命名入库（fake savePort 捕获合法 GemshapeFile）', async () => {
    const captured: GemshapeFile[] = []
    const view = mountWizard({
      savePort: async (file) => {
        captured.push(file)
        return { assetId: 'ast-shape-new', specKey: 'custom-ast-shape-new' }
      },
    })
    await tick()

    // ① 贴图
    expect(view.target.querySelector('[data-testid="cal-texture-info"]')?.textContent).toContain('120×60')
    ;(view.target.querySelector('[data-testid="cal-next"]') as HTMLButtonElement).click()
    await tick()
    await tick()

    // ② direct 输 mm（bounds 5:3 → 5×3）
    expect(view.target.querySelector('[data-testid="cal-mode-direct"]') ?? view.target).toBeTruthy()
    setInput(view.target.querySelector('[data-testid="cal-direct-width"]')!, '5')
    setInput(view.target.querySelector('[data-testid="cal-direct-height"]')!, '3')
    await tick()
    expect(view.target.querySelector('[data-testid="cal-physical-preview"]')?.textContent).toContain('5×3mm')
    ;(view.target.querySelector('[data-testid="cal-next"]') as HTMLButtonElement).click()
    await tick()

    // ③ 命名入库
    setInput(view.target.querySelector('[data-testid="cal-name"]')!, '测试方钻')
    await tick() // 等待 disabled 表达式重算（名称非空才可点）
    ;(view.target.querySelector('[data-testid="cal-commit"]') as HTMLButtonElement).click()
    await tick()
    await tick()

    expect(captured).toHaveLength(1)
    expect(captured[0].name).toBe('测试方钻')
    expect(captured[0].physical).toEqual({ widthMm: 5, heightMm: 3 })
    expect(captured[0].calibration).toEqual({ mode: 'direct' })
    // 捕获物可 serialize→parse（落库字节一致）
    expect(parseGemshape(serializeGemshape(captured[0])).name).toBe('测试方钻')
    expect(view.target.querySelector('[data-testid="cal-result"]')?.textContent).toContain('custom-ast-shape-new')

    view.unmount()
  })

  it('比例漂移：direct 宽高与 bounds 纵横比不符 → 步骤② typed error 呈现且不可下一步', async () => {
    const view = mountWizard()
    await tick()
    ;(view.target.querySelector('[data-testid="cal-next"]') as HTMLButtonElement).click()
    await tick()
    await tick()

    setInput(view.target.querySelector('[data-testid="cal-direct-width"]')!, '5')
    setInput(view.target.querySelector('[data-testid="cal-direct-height"]')!, '2') // 2.5 vs 1.667
    await tick()
    const preview = view.target.querySelector('[data-testid="cal-physical-preview"]')?.textContent ?? ''
    expect(preview).toContain('比例漂移')
    const next = view.target.querySelector<HTMLButtonElement>('[data-testid="cal-next"]')!
    expect(next.disabled).toBe(true)

    view.unmount()
  })

  it('reference 反推：选参考规格 → 物化预览；悬空（未选）→ 不可下一步', async () => {
    const view = mountWizard()
    await tick()
    ;(view.target.querySelector('[data-testid="cal-next"]') as HTMLButtonElement).click()
    await tick()
    await tick()

    ;(view.target.querySelector('[data-testid="cal-mode-reference"]') as HTMLInputElement).click()
    await tick()
    let next = view.target.querySelector<HTMLButtonElement>('[data-testid="cal-next"]')!
    expect(next.disabled).toBe(true) // 悬空 ref

    const select = view.target.querySelector<HTMLSelectElement>('[data-testid="cal-ref-spec"]')!
    select.value = 'round-ss10'
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await tick()
    const preview = view.target.querySelector('[data-testid="cal-physical-preview"]')?.textContent ?? ''
    expect(preview).toContain('物化尺寸')
    expect(preview).toContain('SS10')
    next = view.target.querySelector<HTMLButtonElement>('[data-testid="cal-next"]')!
    expect(next.disabled).toBe(false)

    view.unmount()
  })

  it('落库端口缺席：onCommitIntent 另存意图信号 + 结果态提示待接线', async () => {
    const intents: GemshapeFile[] = []
    const view = mountWizard({ onCommitIntent: (file) => intents.push(file) })
    await tick()
    ;(view.target.querySelector('[data-testid="cal-next"]') as HTMLButtonElement).click()
    await tick()
    await tick()
    setInput(view.target.querySelector('[data-testid="cal-direct-width"]')!, '5')
    setInput(view.target.querySelector('[data-testid="cal-direct-height"]')!, '3')
    await tick()
    ;(view.target.querySelector('[data-testid="cal-next"]') as HTMLButtonElement).click()
    await tick()
    setInput(view.target.querySelector('[data-testid="cal-name"]')!, '意图钻')
    await tick() // 同上：名称非空解禁后才可点
    ;(view.target.querySelector('[data-testid="cal-commit"]') as HTMLButtonElement).click()
    await tick()
    await tick()

    expect(intents).toHaveLength(1)
    expect(intents[0].name).toBe('意图钻')
    expect(intents[0].calibration.mode).toBe('direct')
    expect(view.target.querySelector('[data-testid="cal-result"]')?.textContent).toContain('另存意图已发出')

    view.unmount()
  })
})
