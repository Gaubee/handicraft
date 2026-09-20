/**
 * 轨 A 1.2 测试：composeDrillPrompt n 元扩展接线。
 * - 双关字节等价回归：drillParams 缺席时，options 各缺席形态输出与两参形态**逐字节相等**
 *   （0.2 改造前直采的 prompt.byteEq.test.ts 基线另行锁死，此处做形态等价矩阵）；
 * - n 元序号连续性（附图序号 = 角色声明序号不变量）+ 素材声明/清单交叉引用同源；
 * - 注入段位次（模板体之后、输出行之前）+ 截断集成 + 主图纯净性（无蓝图词汇）。
 */
import { describe, expect, it } from 'vitest'
import { composeDrillPrompt, type DrillPromptImageRoles } from '$lib/presets/effectRefs'
import type { GemSpecSnapshot, PhysicalCanvas } from '$lib/engine'

const ROLES_MATRIX: DrillPromptImageRoles[] = [
  { hasCase: true, caseLayout: 'horizontal', hasReference: true },
  { hasCase: true, caseLayout: 'vertical', hasReference: false },
  { hasCase: true, caseLayout: 'single', hasReference: true },
  { hasCase: false, caseLayout: 'single', hasReference: true },
  { hasCase: false, caseLayout: 'single', hasReference: false },
]

const roundSs10: GemSpecSnapshot = { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }
const customStar: GemSpecSnapshot = {
  specKey: 'custom-ast-shape-star01',
  ordinal: 2,
  shapeId: 'custom',
  sizeLabel: 'C-star01',
  diameterMm: 5,
  assetId: 'ast-shape-star01',
}
const PHYSICAL: PhysicalCanvas = { widthMm: 210, heightMm: 148, anchorSource: 'declared' }

describe('双关字节等价回归（drillParams 缺席 → 输出与旧两参形态逐字节相等）', () => {
  it('options 各缺席形态 === 两参形态（全角色矩阵 × 空/多行模板体）', () => {
    for (const roles of ROLES_MATRIX) {
      for (const body of ['', '正文', '  第一行\n第二行  ']) {
        const baseline = composeDrillPrompt(body, roles)
        expect(composeDrillPrompt(body, roles, undefined)).toBe(baseline)
        expect(composeDrillPrompt(body, roles, {})).toBe(baseline)
        expect(composeDrillPrompt(body, roles, { drillParams: undefined })).toBe(baseline)
        expect(composeDrillPrompt(body, roles, { canvasWidthPx: 1024 })).toBe(baseline)
      }
    }
  })
})

describe('n 元扩展：素材附图角色声明 + 序号连续性', () => {
  it('roles.materials 显式通道：案例(一) 参考(二) 素材(三/四)；countText 同步 n 元', () => {
    const prompt = composeDrillPrompt('正文', {
      hasCase: true,
      caseLayout: 'horizontal',
      hasReference: true,
      materials: ['custom-a', 'custom-b'],
    })
    expect(prompt).toContain('我上传了4 张图片：')
    expect(prompt).toContain('3. 【图三：钻石素材图·custom-a】')
    expect(prompt).toContain('4. 【图四：钻石素材图·custom-b】')
    // 附图序号 = 角色声明序号：声明行号连续且与【图N】一致
    const declarations = [...prompt.matchAll(/^(\d+)\. 【图([一二三四五六七八九十]+|\d+)：/gm)]
    expect(declarations.map((m) => m[1])).toEqual(['1', '2', '3', '4'])
  })

  it('drillParams 通道（specs 物化派生）：内置形零素材声明，自定义形声明 + 清单交叉引用同图号', () => {
    const prompt = composeDrillPrompt(
      '正文\n【水钻参数提示词】',
      { hasCase: true, caseLayout: 'horizontal', hasReference: true },
      { drillParams: { specs: [roundSs10, customStar], physical: PHYSICAL, materialAssetIds: ['ast-shape-star01'] }, canvasWidthPx: 1024 },
    )
    expect(prompt).toContain('我上传了3 张图片：')
    expect(prompt).toContain('3. 【图三：钻石素材图·custom-ast-shape-star01】')
    expect(prompt).toContain('素材见【图三：钻石素材图·custom-ast-shape-star01】')
    expect(prompt).toContain('1mm ≈ 4.9px。')
    expect(prompt).toContain('  1 = R10 圆形 SS10（直径 2.8mm）')
    // 占位符被替换为段全文（不残留字面量）
    expect(prompt).not.toContain('【水钻参数提示词】')
  })

  it('段位语义（placeholders）：水钻段经占位符进模板体块、输出行之前；缺占位符 = 不注入', () => {
    const withPlaceholder = composeDrillPrompt(
      '特化体内容\n【水钻参数提示词】',
      { hasCase: false, caseLayout: 'single', hasReference: true },
      { drillParams: { specs: [roundSs10], materialAssetIds: [] } },
    )
    // 段进【模板风格补充】块内（替换位=用户书写位），不再独立成段
    const templateBlock = withPlaceholder.split('【模板风格补充】：\n')[1]?.split('\n\n请输出')[0] ?? ''
    expect(templateBlock).toContain('【尺寸与钻规格】')
    expect(withPlaceholder.indexOf('【尺寸与钻规格】')).toBeGreaterThan(withPlaceholder.indexOf('【模板风格补充】'))
    expect(withPlaceholder.indexOf('请输出')).toBeGreaterThan(withPlaceholder.indexOf('【尺寸与钻规格】'))
    // 开 + 缺占位符：正文不注入（不静默追加——发起面板提示的引擎侧语义）
    const withoutPlaceholder = composeDrillPrompt(
      '特化体内容',
      { hasCase: false, caseLayout: 'single', hasReference: true },
      { drillParams: { specs: [roundSs10], materialAssetIds: [] } },
    )
    expect(withoutPlaceholder).not.toContain('【尺寸与钻规格】')
    expect(withoutPlaceholder).not.toContain('只允许使用以下钻')
  })

  it('软上限集成：>4 自定义形仅前 4 附送，截断规格清单行无交叉引用', () => {
    const customs: GemSpecSnapshot[] = Array.from({ length: 6 }, (_, i) => ({
      specKey: `custom-ast-c${i + 1}`,
      ordinal: i + 1,
      shapeId: 'custom' as const,
      sizeLabel: `c${i + 1}`,
      diameterMm: 3,
      assetId: `ast-c${i + 1}`,
    }))
    const prompt = composeDrillPrompt(
      '正文\n【水钻参数提示词】',
      { hasCase: true, caseLayout: 'horizontal', hasReference: true },
      { drillParams: { specs: customs, materialAssetIds: customs.map((c) => c.assetId ?? '') } },
    )
    expect(prompt).toContain('我上传了6 张图片：') // 案例1+参考1+素材4 = 6（截断后）
    expect(prompt).toContain('6. 【图六：钻石素材图·custom-ast-c4】')
    expect(prompt).not.toContain('【图七：钻石素材图')
    expect(prompt).toContain('5 = custom-ast-c5 自定义钻形（最大径 3mm）')
    expect(prompt).not.toContain('5 = custom-ast-c5 自定义钻形（最大径 3mm，素材见')
  })

  it('主图纯净性：drillParams 注入不含任何蓝图词汇（蓝图要求只进蓝图 stage 提示词）', () => {
    const prompt = composeDrillPrompt(
      '正文',
      { hasCase: false, caseLayout: 'single', hasReference: true },
      { drillParams: { specs: [roundSs10, customStar], physical: PHYSICAL, materialAssetIds: [] }, canvasWidthPx: 1024 },
    )
    expect(prompt).not.toContain('蓝图')
  })
})
