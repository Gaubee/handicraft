/*
 * [2026-09-20 studio-layers 2.5] 观察态 + 渲染三分 + 背景层收编 previewMode（tasks 2.5，工作默认一）：
 * - 观察态族不入档：serializeGemproj 字节面（层可见性/背景源与透明度/层块选择翻转 → 序列化字节不变）；
 * - 「隐藏 ≠ 排除」名义化：隐藏层照常进入联合结果/统计口径/导出门（状态条「含 k 隐藏层」数据面）；
 * - 渲染三分常量（SELECTED 1.0 / DESELECTED 0.8 固定不可调 / BACKGROUND 默认 0.5 可调）；
 * - previewMode 三模式收编映射（gems⇔none/painting⇔painting/reference⇔reference；默认源 =
 *   数字油画 50%——Owner 授权默认值变更，对现状 previewMode='gems' 显式登记）；
 * - 打开工程恢复默认观察态（restoreDefaultObservationState + 装载面 setParamState 复位语义）。
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { serializeGemproj, type GemprojFileInput } from '$lib/persistence/projectFile'
import {
  DESELECTED_LAYER_OPACITY,
  SELECTED_LAYER_OPACITY,
  BACKGROUND_OPACITY_DEFAULT,
  defaultBackgroundObservation,
  fromLayerRecord,
  restoreDefaultObservationState,
  toLayerRecord,
} from '$lib/studio/layers.svelte'
import {
  getBackgroundObservation,
  getHiddenLayerCount,
  getLayerResult,
  getLayers,
  getSelectionOrder,
  initDefaultLayers,
  jointViewOf,
  loadFromEngineImage,
  resetStudioForTests,
  setBackgroundObservation,
  setLayerVisible,
  waitForStudioIdle,
  getExportCheck,
  getBlocks,
} from '$lib/stores/studio.svelte'
import { dispatchStudioOp } from '$lib/studio/history.svelte'
import { STARTER_PALETTE } from '$lib/engine'
import { fixtureShapes } from '../engine/helpers'

beforeEach(() => {
  resetStudioForTests()
  initDefaultLayers()
})

/** 序列化输入装配（2.8 saveGemproj 之前的字节面单源：观察态不入 GemprojFileInput）。 */
function gemprojInputOf(): GemprojFileInput {
  const layers = getLayers().map(toLayerRecord)
  return {
    appVersion: 'test',
    createdAt: 1,
    savedAt: 1,
    name: '观察态测试',
    source: { kind: 'embedded', name: 'obs.png', mime: 'image/png', dataUrl: 'data:image/png;base64,x', width: 4, height: 4, downscale: 1 },
    segment: { k: 8, seed: 1 },
    layers,
    palette: STARTER_PALETTE.map((c) => ({ ...c })),
  }
}

describe('2.5 观察态不入档（save 字节面）', () => {
  it('层可见性/背景源与透明度/层选择翻转 → serializeGemproj 字节不变', async () => {
    loadFromEngineImage(fixtureShapes(), 'obs.png', 'handoff')
    await waitForStudioIdle()
    dispatchStudioOp({ t: 'layer.create', name: '前景', blockIds: [getBlocks()[0]!.id] })
    const before = serializeGemproj(gemprojInputOf())
    // 观察态族全翻转（结构/参数零改动）
    setLayerVisible('L1', false)
    setLayerVisible('L2', false)
    setBackgroundObservation({ source: 'reference', opacity: 0.9 })
    const after = serializeGemproj(gemprojInputOf())
    expect(after).toBe(before) // 观察态不入 .gemproj（工作默认一）
    // fromLayerRecord 装载面：visible 恢复默认 true（投影 round-trip 不携带）
    for (const record of getLayers().map(toLayerRecord)) {
      expect('visible' in record).toBe(false)
      expect(fromLayerRecord(record).visible).toBe(true)
    }
  })
})

describe('2.5 「隐藏 ≠ 排除」名义化契约', () => {
  it('隐藏层照常进入联合结果/统计口径/导出门（隐藏 ≠ 排除）', async () => {
    loadFromEngineImage(fixtureShapes(), 'hidden.png', 'handoff')
    await waitForStudioIdle()
    const visibleAll = jointViewOf(getLayers()).gems.length
    expect(visibleAll).toBeGreaterThan(0)
    const checkVisible = getExportCheck()
    setLayerVisible('L1', false)
    expect(getHiddenLayerCount()).toBe(1)
    // 隐藏是纯观察态：计算/统计/导出口径不变
    expect(jointViewOf(getLayers()).gems.length).toBe(visibleAll)
    expect(jointViewOf(getLayers()).gems.length).toBe(visibleAll)
    const checkHidden = getExportCheck()
    expect(checkHidden.ready).toBe(checkVisible.ready)
    expect(checkHidden.exportable).toBe(checkVisible.exportable)
    expect(checkHidden.warnings.length).toBe(checkVisible.warnings.length)
    setLayerVisible('L1', true)
    expect(getHiddenLayerCount()).toBe(0)
  })

  it('层可见性切换不触发重算（纯观察态——entry 身份保持）', async () => {
    loadFromEngineImage(fixtureShapes(), 'obs-idle.png', 'handoff')
    await waitForStudioIdle()
    const before = getLayerResult('L1')
    setLayerVisible('L1', false)
    expect(getLayerResult('L1')).toBe(before) // 同一 entry（未重算）
  })
})

describe('2.5 渲染三分常量（固定值——UI 不提供调节面）', () => {
  it('SELECTED 1.0 / DESELECTED 0.8 / BACKGROUND 0.5', () => {
    expect(SELECTED_LAYER_OPACITY).toBe(1)
    expect(DESELECTED_LAYER_OPACITY).toBe(0.8)
    expect(BACKGROUND_OPACITY_DEFAULT).toBe(0.5)
    expect(defaultBackgroundObservation()).toEqual({ source: 'painting', opacity: 0.5, visible: true })
  })
})

describe('2.5 previewMode 收编映射（背景层「源」）', () => {
  it('背景源三态直写观察态（收编后唯一写面——默认源 = 数字油画，Owner 授权默认值变更）', () => {
    expect(getBackgroundObservation().source).toBe('painting')
    expect(getBackgroundObservation().opacity).toBe(0.5)
    setBackgroundObservation({ source: 'none' })
    expect(getBackgroundObservation().source).toBe('none')
    setBackgroundObservation({ source: 'reference' })
    expect(getBackgroundObservation().source).toBe('reference')
    setBackgroundObservation({ opacity: 0.85 })
    expect(getBackgroundObservation().opacity).toBe(0.85)
  })

  it('打开工程恢复默认观察态（全层可见 + 背景默认源/50% + 单次提示数据面）', async () => {
    loadFromEngineImage(fixtureShapes(), 'restore.png', 'handoff')
    await waitForStudioIdle()
    dispatchStudioOp({ t: 'layer.create', name: '前景' })
    setLayerVisible('L1', false)
    setLayerVisible('L2', false)
    setBackgroundObservation({ source: 'reference', opacity: 0.9 })
    // 打开工程装载面（2.8 openProject 消费）：restoreDefaultObservationState + 选择复位
    const background = restoreDefaultObservationState(getLayers())
    expect(background).toEqual({ source: 'painting', opacity: 0.5, visible: true })
    expect(getLayers().every((l) => l.visible)).toBe(true)
    expect(getSelectionOrder().length).toBeGreaterThan(0) // 选择集经 setParamState 复位语义保持
  })
})
