/**
 * canonical 钻规格契约（gem-catalog W0 0.1，design §1.1 规范性冻结）：
 * - 类型面编译（BaseSpec / GemSpecSnapshot / PhysicalCanvas / GemSpec——唯一定义点 engine/spec.ts）
 * - GridSpec v2 派生化：gridFromSpec（标准入口，不写 v1 过渡键 ss）/ gridFromSs（圆钻特例降位，
 *   携带过渡读面 ss 供未迁移消费者）
 * - specId 禁令（exact-key；refSpecId 豁免）——src/lib 源码扫描断言
 * - GRIDSPEC_SS_MIGRATION_CHECKLIST：旧 GridSpec.ss 消费者现场登记核对（engine gate 迁移清单）
 * 纯函数测试：无 IndexedDB / canvas 依赖。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BaseSpecSchema,
  GemSpecSnapshotSchema,
  GRIDSPEC_SS_MIGRATION_CHECKLIST,
  GridSpecSchema,
  PhysicalCanvasSchema,
  SHAPE_IDS,
  SS_TABLE,
  builtinSpecKey,
  customSpecKey,
  gridFromSpec,
  gridFromSs,
  roundSpecKeyOfSs,
  ssOfRoundSpecKey,
  type BaseSpec,
  type GemSpec,
  type GemSpecSnapshot,
  type PhysicalCanvas,
} from '$lib/engine'

// ---------------------------------------------------------------------------
// 类型面（编译期即断言：唯一类型模块消费 + 字段冻结）
// ---------------------------------------------------------------------------

const baseSpecRound: BaseSpec = { shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }
const baseSpecDrop: BaseSpec = {
  shapeId: 'drop',
  sizeLabel: '4.3mm',
  diameterMm: 4.3,
  widthMm: 3.0,
  heightMm: 4.3,
}
const snapshotRound: GemSpecSnapshot = {
  specKey: 'round-ss10',
  ordinal: 1,
  shapeId: 'round',
  sizeLabel: 'SS10',
  diameterMm: SS_TABLE.SS10,
}
const physicalCanvas: PhysicalCanvas = { widthMm: 210, heightMm: 148, anchorSource: 'declared' }
const memoryEntry: GemSpec = { ...snapshotRound, source: 'builtin' }

describe('canonical 类型唯一化（W0 0.1）', () => {
  it('P0 形枚举冻结：round/square/drop/heart/marquise + custom', () => {
    expect([...SHAPE_IDS]).toEqual(['round', 'square', 'drop', 'heart', 'marquise', 'custom'])
  })

  it('类型面对象可构造（编译断言的运行期镜像）', () => {
    expect(baseSpecRound.diameterMm).toBe(2.8)
    expect(baseSpecDrop.heightMm).toBe(4.3)
    expect(snapshotRound.specKey).toBe('round-ss10')
    expect(physicalCanvas.anchorSource).toBe('declared')
    expect(memoryEntry.source).toBe('builtin')
  })

  it('rotationDeg 非身份：可选随附、值域 [0,360)、增删不改 specKey 语义', () => {
    const withRotation: GemSpecSnapshot = { ...snapshotRound, rotationDeg: 45 }
    expect(GemSpecSnapshotSchema.parse(withRotation)).toMatchObject({ specKey: 'round-ss10', rotationDeg: 45 })
    expect(GemSpecSnapshotSchema.parse(snapshotRound)).not.toHaveProperty('rotationDeg')
    // 非身份 = 同 specKey 快照仅 rotationDeg 不同，身份字段逐字段相等
    expect(withRotation.specKey).toBe(snapshotRound.specKey)
    expect(GemSpecSnapshotSchema.safeParse({ ...snapshotRound, rotationDeg: 360 }).success).toBe(false)
    expect(GemSpecSnapshotSchema.safeParse({ ...snapshotRound, rotationDeg: -1 }).success).toBe(false)
  })

  it('zod 契约同源：assetId 仅 custom 允许；custom 必带 assetId；strict 拒未知键', () => {
    // assetId 挂在非 custom 上 → 拒
    expect(BaseSpecSchema.safeParse({ ...baseSpecRound, assetId: 'ast-x' }).success).toBe(false)
    // custom 无 assetId：BaseSpec 允许（弱引用可选）；GemSpecSnapshot 拒（canonical specKey 派生依据）
    expect(BaseSpecSchema.safeParse({ shapeId: 'custom', sizeLabel: '自定', diameterMm: 3, assetId: 'ast-x' }).success).toBe(true)
    expect(GemSpecSnapshotSchema.safeParse({ ...snapshotRound, shapeId: 'custom', assetId: undefined }).success).toBe(false)
    expect(
      GemSpecSnapshotSchema.safeParse({
        specKey: 'custom-ast-x',
        ordinal: 2,
        shapeId: 'custom',
        sizeLabel: '自定',
        diameterMm: 3,
        assetId: 'ast-x',
      }).success,
    ).toBe(true)
    // strict：未知键（含被废除的身份别名字段）不进契约面
    expect(BaseSpecSchema.safeParse({ ...baseSpecRound, extra: 1 }).success).toBe(false)
    expect(PhysicalCanvasSchema.safeParse({ widthMm: 210, heightMm: 148, anchorSource: 'declared', extra: 1 }).success).toBe(false)
    expect(PhysicalCanvasSchema.safeParse({ widthMm: 210, heightMm: 148, anchorSource: 'guess' }).success).toBe(false)
  })

  it('specKey 生成规则：builtin 确定性 / custom 含 assetId / SS 档派生与反查', () => {
    expect(builtinSpecKey('round', 'SS10')).toBe('round-ss10')
    expect(builtinSpecKey('square', '3.5mm')).toBe('square-3.5')
    expect(customSpecKey('ast-shape-x')).toBe('custom-ast-shape-x')
    expect(roundSpecKeyOfSs('SS10')).toBe('round-ss10')
    expect(ssOfRoundSpecKey('round-ss10')).toBe('SS10')
    expect(ssOfRoundSpecKey('square-3.5')).toBeNull()
    expect(ssOfRoundSpecKey('round-ss40')).toBeNull() // 非 SS_KEYS 成员
  })
})

// ---------------------------------------------------------------------------
// GridSpec v2 派生化（types.ts v2 区 + grid.ts 构造入口）
// ---------------------------------------------------------------------------

describe('GridSpec v2 派生化（W0 0.1）', () => {
  it('gridFromSpec 标准入口：pitch = diameterMm + gap；不写 v1 过渡键 ss', () => {
    const grid = gridFromSpec(baseSpecRound, 0.4, 2.5)
    expect(grid).toEqual({ pitchMm: SS_TABLE.SS10 + 0.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 })
    expect('ss' in grid).toBe(false)
    // 异形：唯一物理依据仍是 diameterMm（长轴），宽高不进几何上下文
    expect(gridFromSpec(baseSpecDrop, 0.4, 2.5)).toEqual({ pitchMm: 4.3 + 0.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 })
  })

  it('gridFromSs 圆钻特例降位：携带 v1 过渡读面 ss；除 ss 外与 gridFromSpec 逐字段相等', () => {
    const fromSs = gridFromSs('SS10', 2.5)
    expect(fromSs).toEqual({ ss: 'SS10', pitchMm: SS_TABLE.SS10 + 0.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 })
    const { ss: _ss, ...withOutSs } = fromSs
    void _ss
    expect(withOutSs).toEqual(gridFromSpec(baseSpecRound, 0.4, 2.5))
    // 默认 gap 0.4 不变（v1 行为零变化）
    expect(gridFromSs('SS16', 2.5)).toEqual({ ss: 'SS16', pitchMm: SS_TABLE.SS16 + 0.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 })
  })

  it('GridSpecSchema v2：ss 可选过渡 / gapMm 非负 / 行角字面量 0', () => {
    expect(GridSpecSchema.safeParse({ pitchMm: 3.2, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 }).success).toBe(true)
    expect(GridSpecSchema.safeParse({ ss: 'SS10', pitchMm: 3.2, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 }).success).toBe(true)
    expect(GridSpecSchema.safeParse({ pitchMm: 3.2, gapMm: -0.1, rowAngleDeg: 0, pixelsPerMm: 2.5 }).success).toBe(false)
    expect(GridSpecSchema.safeParse({ ss: 'SS11', pitchMm: 3.2, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 }).success).toBe(false)
    expect(GridSpecSchema.safeParse({ pitchMm: 3.2, gapMm: 0, rowAngleDeg: 0, pixelsPerMm: 2.5 }).success).toBe(true) // gap=0 相切
  })
})

// ---------------------------------------------------------------------------
// specId 禁令（exact-key，refSpecId 豁免）+ 旧消费者迁移清单登记
// ---------------------------------------------------------------------------

/** 收集 src/lib 下全部 .ts/.svelte 源文件路径（跳过 node_modules）。 */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) collectSourceFiles(full, out)
    else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte'))) out.push(full)
  }
  return out
}

const LIB_ROOT = resolve(process.cwd(), 'src/lib')

describe('specId 禁令与迁移清单登记（W0 0.1）', () => {
  it('src/lib 全树无 specId 身份字段/持久化别名（exact-key；refSpecId 豁免不计）', () => {
    // exact-key 禁令形态：`specId:` / `specId =` / 引号键 "specId"/'specId' —— refSpecId（大写 S 的
    // 引用字段）天然不匹配；标识符内前导（如 AspecId 形）由非标识符前导字符类排除
    const exactKeyPatterns = [/[^A-Za-z0-9_]specId\s*[:=]/, /^specId\s*[:=]/m, /["']specId["']\s*:/]
    const offenders: string[] = []
    for (const file of collectSourceFiles(LIB_ROOT)) {
      const text = readFileSync(file, 'utf8')
      for (const pattern of exactKeyPatterns) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern.source}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('GRIDSPEC_SS_MIGRATION_CHECKLIST：三处旧消费者现场仍然在册（engine gate 1.3/1.4 迁移后删除）', () => {
    expect(GRIDSPEC_SS_MIGRATION_CHECKLIST).toHaveLength(3)
    const readLib = (rel: string): string => readFileSync(resolve(LIB_ROOT, rel), 'utf8')
    // buildBom 的 g.ss（export.ts）
    expect(readLib('engine/export.ts')).toMatch(/g\.ss\b/)
    // ProjectSummary.ss（projectTypes.ts）
    expect(readLib('persistence/projectTypes.ts')).toMatch(/ss\?:\s*SSKey/)
    // edit store 摘要构造（stores/edit.svelte.ts）
    expect(readLib('stores/edit.svelte.ts')).toMatch(/grid\.ss\b/)
  })
})
