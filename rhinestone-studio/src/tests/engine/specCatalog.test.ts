/**
 * 目录资产 schema + 迁移 bootstrap（gem-catalog W0 0.6，design §1.6 / Owner 裁决一）：
 * - specKey 确定性（SS_TABLE 直径 × 生成规则 join；同输入同输出）
 * - vectorPath 归一化（单位框 0..1）不变量
 * - seed 幂等 create-only（ast-shape-${specKey} 存在即跳过——含软删态，删除不复活）
 * - seed fixture 矩阵与 0.4 同源：texture-only / both 合法 + vector-only 拒收
 * - 身份不可变纪律的机制面（确定性节点 id；短码不参与身份）
 * 纯函数测试。
 */

import { describe, expect, it } from 'vitest'
import { SS_KEYS, SS_TABLE, builtinSpecKey } from '$lib/engine'
import {
  BUILTIN_SHAPES,
  ROUND_SS_BOOTSTRAP,
  gemshapeSeedNodeId,
  planGemshapeSeeds,
  type GemshapeSeedSpec,
} from '$lib/engine'
import {
  GemshapeFieldError,
  parseGemshape,
  serializeGemshape,
  validateVectorPath,
} from '$lib/persistence/gemshapeFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错但未抛出')
}

const TEXTURE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo'

/** P0 五形代表档位 seed 样本（短码人读；specKey 必填——seed 数据形状冻结面）。 */
const SEED_SAMPLES: readonly GemshapeSeedSpec[] = [
  {
    specKey: 'round-ss10',
    shapeId: 'round',
    shortCode: 'R10',
    nameZh: '圆钻 SS10',
    texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 64, height: 64 },
    physical: { widthMm: 2.8, heightMm: 2.8 },
  },
  {
    specKey: 'square-3.5',
    shapeId: 'square',
    shortCode: 'SQ35',
    nameZh: '方钻 3.5mm',
    texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 64, height: 64 },
    vectorPath: 'M 0.05 0.05 L 0.95 0.05 L 0.95 0.95 L 0.05 0.95 Z',
    physical: { widthMm: 3.5, heightMm: 3.5 },
  },
  {
    specKey: 'drop-4.3',
    shapeId: 'drop',
    shortCode: 'DP43',
    nameZh: '水滴 4.3mm',
    texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 48, height: 64 },
    vectorPath: 'M 0.5 0.05 C 0.85 0.4 0.9 0.75 0.5 0.95 C 0.1 0.75 0.15 0.4 0.5 0.05 Z',
    physical: { widthMm: 3, heightMm: 4.3 },
  },
  {
    specKey: 'heart-4.5',
    shapeId: 'heart',
    shortCode: 'HT45',
    nameZh: '心形 4.5mm',
    texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 64, height: 60 },
    physical: { widthMm: 4.5, heightMm: 4.4 },
  },
  {
    specKey: 'marquise-5x2.5',
    shapeId: 'marquise',
    shortCode: 'MQ5025',
    nameZh: '马眼 5×2.5mm',
    texture: { mime: 'image/png', dataUrl: TEXTURE_DATA_URL, width: 80, height: 40 },
    vectorPath: 'M 0.05 0.5 Q 0.5 0.05 0.95 0.5 Q 0.5 0.95 0.05 0.5 Z',
    physical: { widthMm: 2.5, heightMm: 5 },
  },
]

describe('迁移 bootstrap 表与 specKey 确定性（W0 0.6）', () => {
  it('ROUND_SS_BOOTSTRAP：SS_TABLE 直径 × round-ssXX 派生键逐行一致（SS_KEYS 声明序）', () => {
    expect(ROUND_SS_BOOTSTRAP).toHaveLength(SS_KEYS.length)
    ROUND_SS_BOOTSTRAP.forEach((row) => {
      expect(row.diameterMm).toBe(SS_TABLE[row.ss])
      expect(row.specKey).toBe(`round-${row.ss.toLowerCase()}`)
    })
    expect(ROUND_SS_BOOTSTRAP[2]).toEqual({ ss: 'SS10', diameterMm: 2.8, specKey: 'round-ss10' })
  })

  it('specKey 确定性：同输入同输出；短码/显示码不参与身份（不由显示码反推）', () => {
    expect(builtinSpecKey('round', 'SS10')).toBe(builtinSpecKey('round', 'SS10'))
    expect(builtinSpecKey('round', 'SS10')).toBe('round-ss10')
    expect(builtinSpecKey('square', '3.5mm')).toBe('square-3.5')
    expect(builtinSpecKey('marquise', '5x2.5mm')).toBe('marquise-5x2.5')
    // SS24 现缺（SS22→SS26 跳档）——补档 = 2.1 新增 seed 条目，不进 bootstrap 表
    expect(SS_KEYS).not.toContain('SS24')
    expect(ROUND_SS_BOOTSTRAP.some((row) => row.specKey === 'round-ss24')).toBe(false)
  })

  it('P0 五形元数据冻结：round/square/drop/heart/marquise（短码人读，不参与身份）', () => {
    expect(BUILTIN_SHAPES.map((shape) => shape.shapeId)).toEqual(['round', 'square', 'drop', 'heart', 'marquise'])
    expect(BUILTIN_SHAPES.map((shape) => shape.nameZh)).toEqual(['圆钻', '方钻', '水滴', '心形', '马眼'])
  })
})

describe('vectorPath 归一化不变量（W0 0.6）', () => {
  it('seed 样本的 vectorPath 全部通过单位框校验（0..1；语法子集）', () => {
    for (const seed of SEED_SAMPLES) {
      if (seed.vectorPath !== undefined) {
        expect(() => validateVectorPath(seed.vectorPath, 'vectorPath')).not.toThrow()
      }
    }
  })

  it('单位框外坐标 / 弧命令 → 拒收（与 0.4 gate 同源）', () => {
    expect(captureError(() => validateVectorPath('M 0 0 L 1.5 0.5 Z', 'vectorPath'))).toBeInstanceOf(GemshapeFieldError)
    expect(captureError(() => validateVectorPath('M 0 0 A 0.5 0.5 0 0 1 1 1', 'vectorPath'))).toBeInstanceOf(
      GemshapeFieldError,
    )
  })
})

describe('seed 幂等 create-only（W0 0.6）', () => {
  it('空库：全量 create（声明序）；确定性节点 id ast-shape-${specKey}', () => {
    const plan = planGemshapeSeeds(SEED_SAMPLES, new Set<string>())
    expect(plan.skipped).toEqual([])
    expect(plan.create.map((seed) => seed.specKey)).toEqual(SEED_SAMPLES.map((seed) => seed.specKey))
    expect(gemshapeSeedNodeId('round-ss10')).toBe('ast-shape-round-ss10')
  })

  it('节点存在即跳过（含软删态——删除不复活，绝不覆盖）', () => {
    const existing = new Set(['ast-shape-round-ss10', 'ast-shape-square-3.5'])
    const plan = planGemshapeSeeds(SEED_SAMPLES, existing)
    expect(plan.skipped).toEqual(['ast-shape-round-ss10', 'ast-shape-square-3.5'])
    expect(plan.create.map((seed) => seed.specKey)).toEqual(['drop-4.3', 'heart-4.5', 'marquise-5x2.5'])
  })

  it('二次运行（首轮 create 全部落库后）：create 为空、全量 skipped——幂等', () => {
    const afterFirstRun = new Set(SEED_SAMPLES.map((seed) => gemshapeSeedNodeId(seed.specKey)))
    const plan = planGemshapeSeeds(SEED_SAMPLES, afterFirstRun)
    expect(plan.create).toEqual([])
    expect(plan.skipped).toHaveLength(SEED_SAMPLES.length)
  })
})

describe('seed fixture 矩阵（与 0.4 同源——texture 必备 / vector-only 拒收）', () => {
  /** seed 样本 → .gemshape 文本（2.1 落库形态的纯函数面）。 */
  function seedToGemshape(seed: GemshapeSeedSpec): string {
    return serializeGemshape({
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: seed.nameZh,
      texture: { ...seed.texture },
      ...(seed.vectorPath !== undefined ? { vectorPath: seed.vectorPath } : {}),
      physical: { ...seed.physical },
      specKey: seed.specKey,
      calibration: { mode: 'direct' },
    })
  }

  it('texture-only 与 both 两类 seed 全部合法（parse 过六 gate 的同步面）', () => {
    for (const seed of SEED_SAMPLES) {
      const file = parseGemshape(seedToGemshape(seed), { mime: PROJECT_MIME.gemshape })
      expect(file.specKey).toBe(seed.specKey)
      expect(file.physical).toEqual(seed.physical)
      expect(file.vectorPath ?? undefined).toBe(seed.vectorPath ?? undefined)
      expect(seedToGemshape(seed)).toBe(seedToGemshape(seed)) // 序列化确定性
    }
  })

  it('vector-only seed（texture 缺席）→ typed error 拒收（seed 数据形状同样强制贴图必备）', () => {
    const vectorOnlySeed = JSON.stringify({
      kind: 'gemshape',
      formatVersion: 1,
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '矢量-only seed',
      vectorPath: 'M 0.1 0.1 L 0.9 0.9 Z',
      specKey: 'round-ss10',
      physical: { widthMm: 2.8, heightMm: 2.8 },
      calibration: { mode: 'direct' },
    })
    const error = captureError(() => parseGemshape(vectorOnlySeed))
    expect(error).toBeInstanceOf(GemshapeFieldError)
    expect((error as GemshapeFieldError).path).toBe('texture')
    expect((error as GemshapeFieldError).found).toContain('vector-only')
  })
})
