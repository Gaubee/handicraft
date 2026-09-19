/**
 * [gem-catalog engine gate 1.3] 导出升级：
 * - buildSvg 三渲染路径 golden：round circle 快路径（v1 字节形态保留）/ 异形 vectorPath 缩放 /
 *   custom `<image>`（并存优先矢量）；custom 未解析 = 占位渲染 + data-missing 标记；
 * - gemRadiusPx 逐钻签名（gem, grid）+ 过渡重载（grid）同值（gridFromSs 构造链）；
 * - buildBom 聚合键 canonical specKey×colorId：v1 圆钻自然落 round-ssXX 行；同规格不同自定义
 *   资产 assetId 区分行；合计行；missing 标注（resolveShape 接线时）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildBom,
  buildSvg,
  gemRadiusPx,
  gridFromSpec,
  gridFromSs,
  SS_TABLE,
  type Gem,
  type Palette,
} from '$lib/engine'

const PPM = 2.5
const GAP = 0.4
const grid = gridFromSs('SS10', PPM)
const PALETTE: Palette = [
  { id: 'red', name: '红', hex: '#C8102E' },
  { id: 'gold', name: '金', hex: '#D4AF37' },
]

function gem(
  id: string,
  x: number,
  y: number,
  colorId: string,
  spec: Partial<{ shapeId: string; diameterMm: number; rotationDeg: number; assetId: string }> = {},
): Gem {
  return {
    id,
    x,
    y,
    colorId,
    blockId: 'blk',
    shapeId: (spec.shapeId ?? 'round') as Gem['shapeId'],
    diameterMm: spec.diameterMm ?? SS_TABLE.SS10,
    ...(spec.rotationDeg !== undefined ? { rotationDeg: spec.rotationDeg } : {}),
    ...(spec.assetId !== undefined ? { assetId: spec.assetId } : {}),
  }
}

describe('gemRadiusPx 签名迁移（tasks 1.3）', () => {
  it('逐钻 (gem, grid) 与过渡 (grid) 在 gridFromSs 构造链下同值（v1 语义零变化）', () => {
    for (const ss of ['SS6', 'SS10', 'SS34'] as const) {
      const g = gridFromSs(ss, PPM)
      const perGem = gemRadiusPx({ shapeId: 'round', diameterMm: SS_TABLE[ss] }, g)
      const gridForm = gemRadiusPx(g)
      expect(perGem).toBe(gridForm)
      expect(perGem).toBeCloseTo((SS_TABLE[ss] / 2) * PPM, 12)
    }
  })

  it('逐钻直径驱动：同 grid 异径钻半径不同', () => {
    const g = gridFromSpec({ shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 }, GAP, PPM)
    expect(gemRadiusPx({ shapeId: 'round', diameterMm: 7.1 }, g)).toBeCloseTo((7.1 / 2) * PPM, 12)
    expect(gemRadiusPx({ shapeId: 'round', diameterMm: 2.0 }, g)).toBeCloseTo((2.0 / 2) * PPM, 12)
  })
})

describe('buildSvg 三渲染路径（golden）', () => {
  const DROP_PATH = 'M0.5,0.05 C0.75,0.3 0.95,0.55 0.5,0.95 C0.05,0.55 0.25,0.3 0.5,0.05 Z'

  it('round：circle 快路径保留（v1 字节形态）', () => {
    const svg = buildSvg([gem('a', 10, 10, 'red')], grid, { width: 100, height: 80, palette: PALETTE })
    expect(svg).toContain('<circle cx="10.50" cy="10.50" r="3.50"/>') // SS10 r=2.8/2×2.5=3.5
    expect(svg).not.toContain('<path')
    expect(svg).not.toContain('<image')
  })

  it('异形 vectorPath：单位框 path × diameterMm×ppm 缩放（含旋转）', () => {
    const svg = buildSvg(
      [
        gem('d1', 20, 20, 'red', { shapeId: 'drop', diameterMm: 4.3 }),
        gem('d2', 40, 20, 'red', { shapeId: 'drop', diameterMm: 4.3, rotationDeg: 90 }),
      ],
      grid,
      {
        width: 100,
        height: 80,
        palette: PALETTE,
        resolveShape: (g) =>
          g.shapeId === 'drop' ? { vectorPath: DROP_PATH } : undefined,
      },
    )
    const s = 4.3 * PPM // 10.75
    // d1（20,20）：无旋转——translate(左上 = 钻心 − s/2) + scale
    expect(svg).toContain(`<path d="${DROP_PATH}" transform="translate(15.13 15.13) scale(${s} ${s})"/>`)
    // d2（40,20）：旋转 90°（绕盒心 s/2 = 5.375）
    expect(svg).toContain(
      `<path d="${DROP_PATH}" transform="translate(35.13 15.13) rotate(90 5.375 5.375) scale(${s} ${s})"/>`,
    )
    expect(svg).not.toContain('<image')
  })

  it('custom：`<image>` dataUrl 引用（旋转绕钻心）；vectorPath 并存时优先矢量', () => {
    const dataUrl = 'data:image/png;base64,AAAA'
    const svg = buildSvg(
      [
        gem('c1', 10, 10, 'gold', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-1' }),
        gem('c2', 30, 10, 'gold', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-2', rotationDeg: 45 }),
      ],
      grid,
      {
        width: 100,
        height: 80,
        palette: PALETTE,
        resolveShape: (g) => ({ image: { dataUrl, width: 64, height: 64 } }),
      },
    )
    const s = 3.0 * PPM // 7.5
    expect(svg).toContain(`<image href="${dataUrl}" x="6.75" y="6.75" width="${s}" height="${s}"/>`)
    expect(svg).toContain(
      `<image href="${dataUrl}" x="26.75" y="6.75" width="${s}" height="${s}" transform="rotate(45 30.50 10.50)"/>`,
    )
    // 并存优先矢量
    const both = buildSvg([gem('c1', 10, 10, 'gold', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-1' })], grid, {
      width: 100,
      height: 80,
      palette: PALETTE,
      resolveShape: () => ({ vectorPath: DROP_PATH, image: { dataUrl, width: 64, height: 64 } }),
    })
    expect(both).toContain('<path')
    expect(both).not.toContain('<image')
  })

  it('custom 未解析：占位渲染 + data-missing 标记（不静默降级为普通圆钻）', () => {
    const svg = buildSvg([gem('c1', 10, 10, 'gold', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-x' })], grid, {
      width: 100,
      height: 80,
      palette: PALETTE,
      resolveShape: () => undefined,
    })
    expect(svg).toContain('data-gemshape-missing="ast-x"')
    expect(svg).toContain('stroke-dasharray="2 2"')
    // 未接线（无 resolveShape）：custom 无目录数据同样占位 + missing 标记——不静默降级为普通圆钻
    //（目录接线归 2.2/studio gate；导出硬阻断判据在 exportGate missing-asset 面另测）
    const unwired = buildSvg([gem('c1', 10, 10, 'gold', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-x' })], grid, {
      width: 100,
      height: 80,
      palette: PALETTE,
    })
    expect(unwired).toContain('data-gemshape-missing="ast-x"')
  })
})

describe('buildBom 聚合键 specKey×colorId（tasks 1.3）', () => {
  it('基准圆钻（gridFromSs 构造链同值）自然落 round-ss10 行；同径异色分行', () => {
    const csv = buildBom(
      [gem('a', 0, 0, 'red'), gem('b', 8, 0, 'red'), gem('c', 16, 0, 'gold')],
      PALETTE,
      grid,
    )
    const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(lines[0]).toBe('规格,形状,尺寸,色名,hex,数量')
    expect(lines).toEqual([
      '规格,形状,尺寸,色名,hex,数量',
      'round-ss10,圆钻,SS10,红,#C8102E,2',
      'round-ss10,圆钻,SS10,金,#D4AF37,1',
      '合计,,,,,3',
    ])
  })

  it('同规格不同自定义资产 assetId 区分行 + 合计行', () => {
    const gems = [
      gem('a', 0, 0, 'red'),
      gem('b', 8, 0, 'red'),
      gem('c1', 16, 0, 'red', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-1' }),
      gem('c2', 24, 0, 'red', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-2' }),
      gem('c3', 32, 0, 'red', { shapeId: 'custom', diameterMm: 3.0, assetId: 'ast-1' }),
    ]
    const csv = buildBom(gems, PALETTE, grid, {
      resolveShape: (g) => (g.assetId === 'ast-1' ? { image: { dataUrl: 'data:image/png;base64,AAAA', width: 8, height: 8 } } : undefined),
    })
    const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(lines).toEqual([
      '规格,形状,尺寸,色名,hex,数量',
      // 计数降序，同数按聚合键字典序：custom-ast-1(2) 先于 round-ss10(2)
      'custom-ast-1,custom,自定义,红,#C8102E,2',
      'round-ss10,圆钻,SS10,红,#C8102E,2',
      'custom-ast-2（资产缺失）,custom,自定义,红,#C8102E,1', // ast-2 未解析 → 清单标注 missing（gate 6）
      '合计,,,,,5',
    ])
  })

  it('builtin 异形 mm 档 specKey（square-3.5 形态）', () => {
    const csv = buildBom(
      [gem('s1', 0, 0, 'red', { shapeId: 'square', diameterMm: 3.5 })],
      PALETTE,
      grid,
    )
    const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(lines[1]).toBe('square-3.5,方钻,3.5mm,红,#C8102E,1')
  })
})
