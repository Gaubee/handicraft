/*
 * [add-subject-sam-pipeline P3.2] 策略设计器 store 测试。
 * 覆盖：帧流→工件引用集派生；旅程链派生（willow 全旅程 done/heart 空会话 pending）；
 * provider 装载（幂等守卫/会话切走卸载/未知引用降级）；画布投影（ppm/半径/颜色/
 * 逐节点显隐/排除框线）；调整指令注入对话输入通道。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MockAgentApi } from '$lib/agentApi/mock'
import { bindAgentApi, openSession, resetAgentStoreForTests } from '$lib/agentApi/store.svelte'
import { peekComposerText, resetComposerOutboxForTests } from '$lib/agentApi/composerOutbox.svelte'
import { MockStrategyArtifacts, STRATEGY_FIXTURE_BLOB_REFS, STRATEGY_FIXTURE_GEMS } from '$lib/strategyDesigner/fixtures'
import type { StrategyArtifactsProvider } from '$lib/strategyDesigner/artifacts'
import {
  bindStrategyArtifactsProvider,
  getRenderBoxes,
  getRenderGems,
  getStrategyArtifacts,
  getStrategyJourney,
  getStrategyLayerRows,
  getStrategyAssignmentRows,
  getStrategyPpm,
  getStrategyRefs,
  isNodeVisible,
  isStrategyLoading,
  queueNodeAdjustInstruction,
  resetStrategyDesignerForTests,
  selectStrategyNode,
  syncStrategyArtifacts,
  toggleNodeVisible,
} from '$lib/strategyDesigner/store.svelte'

const flush = async (ms = 10): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function openWillow(): Promise<void> {
  await openSession('fixt-session-willow')
}

async function openHeart(): Promise<void> {
  await openSession('fixt-session-heart')
}

beforeEach(() => {
  resetAgentStoreForTests()
  resetStrategyDesignerForTests()
  resetComposerOutboxForTests()
  bindAgentApi(new MockAgentApi({ speed: 0 }))
})

afterEach(() => {
  resetAgentStoreForTests()
  resetStrategyDesignerForTests()
  resetComposerOutboxForTests()
})

describe('帧流派生：工件引用集', () => {
  it('willow 会话（全旅程）→ 三工件引用齐备（取各名最新帧；taskId 溯源随帧）', async () => {
    await openWillow()
    expect(getStrategyRefs()).toEqual({
      tree: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.treeJson, taskId: 'fixt-task-willow-1' },
      treePreview: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.treePreview, taskId: 'fixt-task-willow-1' },
      plan: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.planJson, taskId: 'fixt-task-willow-1' },
      gems: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsJson, taskId: 'fixt-task-willow-1' },
      gemsPreview: { blobRef: STRATEGY_FIXTURE_BLOB_REFS.gemsPreview, taskId: 'fixt-task-willow-1' },
    })
  })

  it('heart 会话（旧引擎旅程，无策略工件名）→ 引用集全空', async () => {
    await openHeart()
    expect(getStrategyRefs()).toEqual({ tree: null, treePreview: null, plan: null, gems: null, gemsPreview: null })
  })
})

describe('帧流派生：旅程链', () => {
  it('willow：六步全 done（审批已 resolved）+工件名透出', async () => {
    await openWillow()
    const steps = getStrategyJourney()
    expect(steps.map((step) => step.status)).toEqual(['done', 'done', 'done', 'done', 'done', 'done'])
    expect(steps.find((step) => step.key === 'segment')?.blobRef).toBe(STRATEGY_FIXTURE_BLOB_REFS.treeJson)
    expect(steps.find((step) => step.key === 'design')?.artifactName).toBe('strategy-plan.json')
    expect(steps.find((step) => step.key === 'preview')?.blobRef).toBe(STRATEGY_FIXTURE_BLOB_REFS.gemsPreview)
  })

  it('空会话（starry 无任务）→ 全 pending + input 引导注记', async () => {
    await openSession('fixt-session-starry')
    const steps = getStrategyJourney()
    expect(steps.every((step) => step.status === 'pending')).toBe(true)
    expect(steps.find((step) => step.key === 'input')?.note).toContain('上传图')
  })
})

describe('provider 装载（幂等守卫）', () => {
  it('willow 引用集 → mock bundle 装载（树 6 节点/指派 4/gems 19）', async () => {
    await openWillow()
    syncStrategyArtifacts()
    await flush()
    expect(isStrategyLoading()).toBe(false)
    const bundle = getStrategyArtifacts()
    expect(bundle).not.toBeNull()
    expect(bundle!.tree.nodes).toHaveLength(6)
    expect(bundle!.plan.assignments).toHaveLength(4)
    expect(bundle!.gems.gems).toHaveLength(19)
    expect(bundle!.sourceImageUrl).toBeNull() // 无附件注记 → 原图降级态（P3.2-channel 两态之一）
  })

  it('幂等：同引用集重复 sync 不重装（计数 provider 一次）', async () => {
    let loads = 0
    const inner = new MockStrategyArtifacts()
    const counting: StrategyArtifactsProvider = {
      async load(refs) {
        loads += 1
        return inner.load(refs)
      },
    }
    bindStrategyArtifactsProvider(counting)
    await openWillow()
    syncStrategyArtifacts()
    await flush()
    syncStrategyArtifacts()
    await flush()
    expect(loads).toBe(1)
  })

  it('会话切走（引用集空）→ 卸载清空；切回重装', async () => {
    await openWillow()
    syncStrategyArtifacts()
    await flush()
    expect(getStrategyArtifacts()).not.toBeNull()

    await openHeart()
    syncStrategyArtifacts()
    await flush()
    expect(getStrategyArtifacts()).toBeNull()

    await openWillow()
    syncStrategyArtifacts()
    await flush()
    expect(getStrategyArtifacts()).not.toBeNull()
  })

  it('provider 不持有引用 → null 降级不报错', async () => {
    bindStrategyArtifactsProvider({ load: async () => null })
    await openWillow()
    syncStrategyArtifacts()
    await flush()
    expect(getStrategyArtifacts()).toBeNull()
    expect(isStrategyLoading()).toBe(false)
  })
})

describe('树/指派/画布投影', () => {
  beforeEach(async () => {
    await openWillow()
    syncStrategyArtifacts()
    await flush()
  })

  it('图层树行集：DFS 先序（画布根在前）+指派归位（层级节点 null）', () => {
    const rows = getStrategyLayerRows()
    expect(rows.map((row) => row.node.id)).toEqual(['n-canvas', 'n-willow', 'n-branch', 'n-flower', 'n-ribbon', 'n-lamp'])
    expect(rows.find((row) => row.node.id === 'n-willow')?.assignment).toBeNull() // 层级节点
    expect(rows.find((row) => row.node.id === 'n-branch')?.assignment?.strategyKind).toBe('texture-fill')
  })

  it('指派表行：objectName 回填+kindLabel+参数摘要+首钻色', () => {
    const rows = getStrategyAssignmentRows()
    expect(rows).toHaveLength(4)
    const branch = rows.find((row) => row.nodeId === 'n-branch')!
    expect(branch.objectName).toBe('柳树·枝条')
    expect(branch.kindLabel).toBe('纹理贴图')
    expect(branch.paramsSummary).toContain('mode=flow')
    expect(branch.primaryStone?.colorHex).toBe('#3F7A3B')
    const lamp = rows.find((row) => row.nodeId === 'n-lamp')!
    expect(lamp.strategyKind).toBe('exclusion')
    expect(lamp.primaryStone).toBeNull()
  })

  it('ppm=contracts derivePixelsPerMm 同源（100px/5cm → 2）+ 钻半径=diameterMm×ppm/2', () => {
    expect(getStrategyPpm()).toEqual({ ppm: 2, exact: true })
    const branchGem = getRenderGems().find((gem) => gem.nodeId === 'n-branch')!
    expect(branchGem.radiusPx).toBeCloseTo(3) // 3mm × 2 / 2
  })

  it('点阵颜色=指派 StonePick colorHex；无钻节点回退灰', () => {
    const gems = getRenderGems()
    expect(gems).toHaveLength(19)
    expect(gems.filter((gem) => gem.nodeId === 'n-flower').every((gem) => gem.colorHex === '#E16FA8')).toBe(true)
    expect(gems.every((gem) => /^#[0-9A-F]{6}$/.test(gem.colorHex))).toBe(true)
  })

  it('逐节点显隐：toggle 隐藏花朵 → 点阵 11 颗+花朵框线退场（显隐藏于点阵与框线两面）', () => {
    toggleNodeVisible('n-flower')
    expect(isNodeVisible('n-flower')).toBe(false)
    expect(getRenderGems()).toHaveLength(11)
    expect(getRenderBoxes().map((box) => box.node.id)).not.toContain('n-flower')
    toggleNodeVisible('n-flower')
    expect(getRenderGems()).toHaveLength(19)
  })

  it('框线排除语义色：灯头（exclusion+drillWorthy=false）双标记', () => {
    const lamp = getRenderBoxes().find((box) => box.node.id === 'n-lamp')!
    expect(lamp.excluded).toBe(true)
    const branch = getRenderBoxes().find((box) => box.node.id === 'n-branch')!
    expect(branch.excluded).toBe(false)
  })
})

describe('调整指令注入（图层级人机面）', () => {
  beforeEach(async () => {
    await openWillow()
    syncStrategyArtifacts()
    await flush()
  })

  it('选中层+参数 → 指令入队（节点锚/参数/密度/用钻齐全）', () => {
    selectStrategyNode('n-branch')
    const ok = queueNodeAdjustInstruction('n-branch', { mode: 'flow', polarity: 'bright-dense' }, 3.0)
    expect(ok).toBe(true)
    const text = peekComposerText()
    expect(text).toContain('nodeId=n-branch')
    expect(text).toContain('polarity=bright-dense')
    expect(text).toContain('密度：3 颗/cm²')
    expect(text).toContain('J-303 深柳绿 3mm')
  })

  it('未知节点/未指派层 → false 不入队', () => {
    expect(queueNodeAdjustInstruction('n-willow', {}, 2.3)).toBe(false) // 层级节点无指派
    expect(peekComposerText()).toBeNull()
  })
})

describe('fixture 事实（柳树场景）', () => {
  it('gems 工件：19 颗/灯头留白注记/warnings 空（镜面 daemon 文档形状）', () => {
    expect(STRATEGY_FIXTURE_GEMS.gems).toHaveLength(19)
    expect(STRATEGY_FIXTURE_GEMS.excludedRegions).toHaveLength(1)
    expect(STRATEGY_FIXTURE_GEMS.excludedRegions[0]?.nodeId).toBe('n-lamp')
    // 钻点全部落在画布 100×100 内（渲染面坐标合法）
    for (const gem of STRATEGY_FIXTURE_GEMS.gems) {
      expect(gem.x).toBeGreaterThanOrEqual(0)
      expect(gem.x).toBeLessThanOrEqual(100)
      expect(gem.y).toBeGreaterThanOrEqual(0)
      expect(gem.y).toBeLessThanOrEqual(100)
    }
  })
})
