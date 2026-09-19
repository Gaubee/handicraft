/**
 * 四格式 v1→v2 迁移入口 + v2 契约（gem-catalog W0 0.3，design §1.3 / §4 迁移细则）：
 * - 每格式 v1 真实形态 fixture（gemproj overrides 四表 / gemdoc 含 'm-' 手工钻 / gemtpl 全字段 /
 *   gemgen 含 provenance.mode 旧档）→ 迁移演练（v2 映射击断）
 * - v2 save→load→save 字节等价（四格式；gemtpl 含 v2 新键全开形态）
 * - 向前拒读（formatVersion 3）+ 脏输入 typed error（迁移入口即拒）
 * - gemproj LayerRecord 分区不变量拒绝面（零/多 rest、跨层重复块）
 * - gemproj v1 兼容读面派生（round-ssXX 反查 SS 档；非圆钻 specKey 过渡期拒绝）
 * - gemgen requestMode 拆键（旧 mode 输入经序列化边界映射；mode 不落 v2 字节）
 * 纯函数测试：无 IndexedDB / canvas 依赖。
 */

import { describe, expect, it } from 'vitest'
import { SS_TABLE } from '$lib/engine'
import {
  PROJECTFILE_FORMAT_VERSIONS,
  ProjectFileFieldError,
  ProjectFileVersionError,
  parseGemdoc,
  parseGemproj,
  serializeGemdoc,
  serializeGemproj,
  type GemdocFile,
  type GemdocFileInput,
  type GemprojFile,
  type GemprojFileInput,
} from '$lib/persistence/projectFile'
import {
  LABFILE_FORMAT_VERSIONS,
  LabFileFieldError,
  LabFileVersionError,
  parseGemgen,
  parseGemtpl,
  serializeGemgen,
  serializeGemtpl,
  type GemgenFileInput,
  type GemtplFileInput,
} from '$lib/persistence/labFile'
import { fromSerializedBlock } from '$lib/persistence/projectFile'

function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错但未抛出')
}

const PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const PNG_DATA_URL = `data:image/png;base64,${btoa(String.fromCharCode(...PNG_BYTES))}`

// ---------------------------------------------------------------------------
// v1 真实形态 fixture（手写 JSON——旧档字节面；formatVersion:1）
// ---------------------------------------------------------------------------

const GEMPROJ_V1 = JSON.stringify({
  kind: 'gemproj',
  formatVersion: 1,
  appVersion: '0.1.0-test',
  engineVersion: 1,
  createdAt: 1758000000111,
  savedAt: 1758000000222,
  name: '节日花环·排钻工程',
  source: { kind: 'asset', assetId: 'ast-img-src-1', name: '花环原图.png', width: 960, height: 720, downscale: 0.9375 },
  segment: { k: 8, seed: 1 },
  overrides: {
    disabled: { 'blk-2': true },
    density: { 'blk-3': 0.5 },
    type: { 'blk-2': 'linear' },
    color: { 'blk-5': 'gold' },
  },
  physics: { ss: 'SS12', gapMm: 0.5, globalDensity: 0.8, relax: { boundary: false, repulsion: true } },
  palette: [
    { id: 'red', name: '红', hex: '#C8102E' },
    { id: 'gold', name: '金', hex: '#D4A017' },
  ],
  activeStrategy: 'cvt',
})

/** gemdoc v1 fixture：由 v2 序列化产物降级（剥 gems 规格键 + grid.gapMm；掩码 base64 由序列化层生成）。 */
function makeGemdocV1(): string {
  const v2: GemdocFileInput = {
    appVersion: '0.1.0-test',
    createdAt: 1758000000444,
    savedAt: 1758000000555,
    name: '节日花环·精修文档',
    width: 960,
    height: 720,
    grid: { pitchMm: SS_TABLE.SS10 + 0.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 2.5 },
    palette: [{ id: 'red', name: '红', hex: '#C8102E' }],
    gems: [
      { id: 'g00001', x: 12.5, y: 20.25, colorId: 'red', blockId: 'blk-1', origin: 'layout', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS10 },
      { id: 'm-3', x: 88, y: 64, colorId: 'red', blockId: null, origin: 'manual', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS10 },
    ],
    blocks: [
      {
        id: 'blk-1',
        label: '花环主体',
        mask: { w: 2, h: 2, bits: Uint8Array.from([1, 0, 0, 1]) },
        colorRgb: [200, 16, 46],
        areaPx: 2,
        bbox: { x: 10, y: 20, w: 2, h: 2 },
        widthPx: { max: 2, mean: 1.5 },
        suggested: 'fill',
      },
    ],
    layers: {
      painting: { visible: true, opacity: 1 },
      reference: { visible: true, opacity: 0.6 },
      blocks: { visible: false, opacity: 0.9 },
      gems: { visible: true, opacity: 1 },
    },
    painting: { mime: 'image/png', dataUrl: PNG_DATA_URL },
    provenance: { origin: 'studio-bake', sourceSummary: '语义混合 · 密度 100% · SS10 · 2 钻' },
  }
  const doc = JSON.parse(serializeGemdoc(v2)) as Record<string, unknown>
  doc.formatVersion = 1
  for (const gem of doc.gems as Array<Record<string, unknown>>) {
    delete gem.shapeId
    delete gem.diameterMm
  }
  delete (doc.grid as Record<string, unknown>).gapMm
  // v1 grid 携带 ss 键（真实 v1 文件形态；v2 序列化层已剥离——降级需显式补回）
  ;(doc.grid as Record<string, unknown>).ss = 'SS10'
  return JSON.stringify(doc)
}

const GEMTPL_V1 = JSON.stringify({
  kind: 'gemtpl',
  formatVersion: 1,
  appVersion: '0.1.0-test',
  createdAt: 1758000000333,
  savedAt: 1758000000333,
  name: '花环边框·浆果环带',
  promptBody: '保持节日构图完整。',
  caseBinding: { assetId: 'ast-img-case-1', caseLayout: 'horizontal' },
  candidates: 4,
  provenance: { source: 'builtin-seed', presetId: 'preset-wreath', sourceNote: '内置案例' },
})

const GEMGEN_V1 = JSON.stringify({
  kind: 'gemgen',
  formatVersion: 1,
  appVersion: '0.1.0-test',
  createdAt: 1758000000444,
  savedAt: 1758000000555,
  name: '城市分层·全要素·候选2',
  image: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 1024, height: 1024 },
  provenance: {
    runId: 'run-1',
    templateAssetId: 'ast-tpl-1',
    templateName: '城市分层·全要素',
    promptBody: '保持场景各层次的完整节日构图。',
    composedPrompt: '你是一位专业的钻石画……全文快照',
    caseBinding: { assetId: 'ast-img-case-1', caseLayout: 'horizontal' },
    referenceAssetId: 'ast-img-ref-1',
    candidateIndex: 1,
    mode: 'edit',
    model: 'gpt-image-2.5',
    size: '1024x1024',
  },
})

// ---------------------------------------------------------------------------
// v1 fixture 迁移演练（parse 触发迁移链；断言 v2 映射值）
// ---------------------------------------------------------------------------

describe('v1 fixture 迁移演练（W0 0.3）', () => {
  it('gemproj v1 → v2：单兜底层（rest 哨兵 + specKey 派生 + overrides 搬运）+ v1 读面派生', () => {
    const file = parseGemproj(GEMPROJ_V1)
    expect(file.formatVersion).toBe(2)
    expect(file.layers).toHaveLength(1)
    const layer = file.layers[0]
    expect(layer.id).toBe('L1')
    expect(layer.name).toBe('图层 1')
    expect(layer.blockIds).toBe('rest')
    expect(layer.strategy).toBe('cvt')
    expect(layer.physics).toEqual({
      specKey: 'round-ss12',
      gapMm: 0.5,
      density: 0.8,
      relax: { boundary: false, repulsion: true },
    })
    expect(layer.overrides).toEqual({
      disabled: { 'blk-2': true },
      density: { 'blk-3': 0.5 },
      type: { 'blk-2': 'linear' },
      color: { 'blk-5': 'gold' },
    })
    expect(file.physicalCanvas).toBeUndefined()
    // v1 兼容读面（deprecated derived）：SS12 由 round-ss12 反查
    expect(file.physics).toEqual({ ss: 'SS12', gapMm: 0.5, globalDensity: 0.8, relax: { boundary: false, repulsion: true } })
    expect(file.activeStrategy).toBe('cvt')
    expect(file.overrides.disabled).toEqual({ 'blk-2': true })
  })

  it('gemdoc v1 → v2：gems 补 round + SS_TABLE 查表直径（含 m- 手工钻）；grid 补 gapMm', () => {
    const file = parseGemdoc(makeGemdocV1())
    expect(file.formatVersion).toBe(2)
    expect(file.gems).toHaveLength(2)
    for (const gem of file.gems) {
      expect(gem.shapeId).toBe('round')
      expect(gem.diameterMm).toBe(SS_TABLE.SS10)
    }
    expect(file.gems[1].id).toBe('m-3') // 手工钻前缀原样
    expect('ss' in file.grid).toBe(false) // 过渡键 1.4 起容忍并剥离
    expect(file.grid.pitchMm).toBeCloseTo(SS_TABLE.SS10 + 0.4, 10)
    expect(file.grid.gapMm).toBeCloseTo(0.4, 10) // v1 构造式反推（浮点尾差容差内）
    expect(file.grid.rowAngleDeg).toBe(0)
    expect(file.grid.pixelsPerMm).toBe(2.5)
    expect(file.physicalCanvas).toBeUndefined()
  })

  it('gemtpl v1 → v2：直通归一（drillParams/blueprint/gemSpecIds 缺席 = 两开关关/无清单）', () => {
    const file = parseGemtpl(GEMTPL_V1)
    expect(file.formatVersion).toBe(2)
    expect(file.drillParams).toBeUndefined()
    expect(file.blueprint).toBeUndefined()
    expect(file.gemSpecIds).toBeUndefined()
    expect(file.name).toBe('花环边框·浆果环带')
  })

  it('gemgen v1 → v2：provenance.mode → requestMode 只读映射（原键删除）；可选键位缺席', () => {
    const file = parseGemgen(GEMGEN_V1)
    expect(file.formatVersion).toBe(2)
    expect(file.provenance.requestMode).toBe('edit')
    expect('mode' in file.provenance).toBe(false)
    expect(file.blueprint).toBeUndefined()
    expect(file.gemSpecs).toBeUndefined()
    expect(file.physicalCanvas).toBeUndefined()
    expect(file.provenance.drillParams).toBeUndefined()
    expect(file.provenance.blueprint).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// v2 round-trip 字节等价（save→load→save；§1.3 纪律）
// ---------------------------------------------------------------------------

describe('v2 save→load→save 字节等价（W0 0.3）', () => {
  it('gemproj：v1 迁移产物 round-trip 字节等价', () => {
    const s1 = serializeGemproj(toGemprojInput(parseGemproj(GEMPROJ_V1)))
    const s2 = serializeGemproj(toGemprojInput(parseGemproj(s1)))
    expect(s2).toBe(s1)
    expect(JSON.parse(s1).formatVersion).toBe(2)
  })

  it('gemproj：v2 全键形态（physicalCanvas 声明）round-trip 字节等价', () => {
    const input: GemprojFileInput = {
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '带画幅工程',
      source: { kind: 'asset', assetId: 'a1', name: 'src.png', width: 100, height: 80, downscale: 1 },
      segment: { k: 6, seed: 0 },
      layers: [
        {
          id: 'L1',
          name: '图层 1',
          blockIds: 'rest',
          strategy: 'hex-thin',
          physics: { specKey: 'round-ss10', gapMm: 0.4, density: 1, relax: { boundary: false, repulsion: false } },
          overrides: { disabled: {}, density: {}, type: {}, color: {} },
        },
      ],
      physicalCanvas: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
      palette: [{ id: 'black', name: '黑', hex: '#1A1A1A' }],
    }
    const s1 = serializeGemproj(input)
    expect(s1).toContain('"physicalCanvas"')
    expect(serializeGemproj(toGemprojInput(parseGemproj(s1)))).toBe(s1)
  })

  it('gemdoc：v1 迁移产物 round-trip 字节等价（blocks 引擎形态回灌）', () => {
    const parsed = parseGemdoc(makeGemdocV1())
    const s1 = serializeGemdoc(toGemdocInput(parsed))
    const s2 = serializeGemdoc(toGemdocInput(parseGemdoc(s1)))
    expect(s2).toBe(s1)
  })

  it('gemdoc：v2 全键形态（physicalCanvas + 逐钻规格物化 + 异形旋转）round-trip 字节等价', () => {
    const base = parseGemdoc(makeGemdocV1())
    const input: GemdocFileInput = {
      ...toGemdocInput(base),
      physicalCanvas: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
      gems: base.gems.map((gem, i) => ({
        ...gem,
        shapeId: i === 0 ? 'round' : 'drop',
        diameterMm: i === 0 ? SS_TABLE.SS10 : 4.3,
        ...(i === 1 ? { rotationDeg: 45, assetId: 'ast-shape-drop' } : {}),
      })),
    }
    const s1 = serializeGemdoc(input)
    expect(serializeGemdoc(toGemdocInput(parseGemdoc(s1)))).toBe(s1)
  })

  it('gemtpl：v1 迁移产物 + v2 新键全开形态均字节等价', () => {
    const s1 = serializeGemtpl(parseGemtpl(GEMTPL_V1))
    expect(serializeGemtpl(parseGemtpl(s1))).toBe(s1)

    const withKeys: GemtplFileInput = {
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '高级选项模板',
      promptBody: '正文',
      caseBinding: null,
      candidates: 2,
      drillParams: {
        enabled: true,
        specs: ['round-ss10', 'round-ss16'],
        physical: { widthMm: 210, heightMm: 148, anchorSource: 'default' },
      },
      blueprint: { enabled: true },
      gemSpecIds: ['round-ss10', 'square-3.5'],
      provenance: { source: 'user-created' },
    }
    const t1 = serializeGemtpl(withKeys)
    const t2 = serializeGemtpl(parseGemtpl(t1))
    expect(t2).toBe(t1)
    expect(t1).toContain('"drillParams"')
    expect(t1).toContain('"blueprint"')
    expect(t1).toContain('"gemSpecIds"')
  })

  it('gemgen：v1 迁移产物 round-trip 字节等价 + v2 全键形态（blueprint/gemSpecs/physicalCanvas/正交快照）', () => {
    const s1 = serializeGemgen(toGemgenInput(parseGemgen(GEMGEN_V1)))
    expect(serializeGemgen(toGemgenInput(parseGemgen(s1)))).toBe(s1)

    const withKeys: GemgenFileInput = {
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '蓝图任务档案',
      image: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 1024, height: 1024 },
      blueprint: {
        mime: 'image/png',
        dataUrl: PNG_DATA_URL,
        width: 1024,
        height: 1024,
        effectRequestId: 'req-eff-1',
        blueprintRequestId: 'req-bp-1',
        role: 'human-review-reference',
      },
      gemSpecs: [
        { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: SS_TABLE.SS10 },
        { specKey: 'square-3.5', ordinal: 2, shapeId: 'square', sizeLabel: '3.5mm', diameterMm: 3.5 },
      ],
      physicalCanvas: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
      provenance: {
        runId: 'run-bp',
        templateName: '模板',
        promptBody: '正文',
        composedPrompt: '全文',
        candidateIndex: 0,
        requestMode: 'generate',
        model: 'gpt-image-2.5',
        size: '1024x1024',
        drillParams: { enabled: true, specs: ['round-ss10'] },
        blueprint: { enabled: true },
      },
    }
    const g1 = serializeGemgen(withKeys)
    const g2 = serializeGemgen(toGemgenInput(parseGemgen(g1)))
    expect(g2).toBe(g1)
    expect(g1).toContain('"role":"human-review-reference"')
    const parsed = parseGemgen(g1)
    expect(parsed.gemSpecs?.[1].specKey).toBe('square-3.5')
    expect(parsed.provenance.drillParams?.specs).toEqual(['round-ss10'])
  })
})

// ---------------------------------------------------------------------------
// 向前拒读 + 脏输入 typed error（迁移入口即拒）
// ---------------------------------------------------------------------------

describe('向前拒读与脏输入（W0 0.3）', () => {
  it('四格式 formatVersion 3 → 版本错误且不解析（版本门先于字段校验）', () => {
    for (const [kind, text, parse] of [
      ['gemproj', GEMPROJ_V1, parseGemproj],
      ['gemdoc', makeGemdocV1(), parseGemdoc],
    ] as const) {
      const future = text.replace('"formatVersion":1', '"formatVersion":3')
      const error = captureError(() => parse(future))
      expect(error).toBeInstanceOf(ProjectFileVersionError)
      expect((error as ProjectFileVersionError).foundVersion).toBe(3)
      void kind
    }
    for (const text of [GEMTPL_V1, GEMGEN_V1]) {
      const future = text.replace('"formatVersion":1', '"formatVersion":3')
      const error = captureError(() =>
        text === GEMTPL_V1 ? parseGemtpl(future) : parseGemgen(future),
      )
      expect(error).toBeInstanceOf(LabFileVersionError)
      expect((error as LabFileVersionError).foundVersion).toBe(3)
    }
    expect(PROJECTFILE_FORMAT_VERSIONS).toEqual({ gemproj: 2, gemdoc: 2 })
    expect(LABFILE_FORMAT_VERSIONS).toEqual({ gemtpl: 2, gemgen: 2 })
  })

  it('gemproj v1 脏 physics.ss → 迁移入口 typed error（路径 physics.ss）', () => {
    const dirty = GEMPROJ_V1.replace('"ss":"SS12"', '"ss":"SS11"')
    const error = captureError(() => parseGemproj(dirty))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('physics.ss')
  })

  it('gemdoc v1 脏 grid.pitchMm（小于钻径 → 隐含负 gap）→ 迁移入口 typed error（路径 grid.pitchMm）', () => {
    const dirty = makeGemdocV1().replace(/"pitchMm":[0-9.]+/, '"pitchMm":1')
    const error = captureError(() => parseGemdoc(dirty))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('grid.pitchMm')
  })

  it('gemgen v2 手造 mode-only（无 requestMode）→ typed error（过渡写面只认 serialize 边界映射）', () => {
    const v2 = serializeGemgen(toGemgenInput(parseGemgen(GEMGEN_V1)))
    const dirty = v2.replace('"requestMode":"edit"', '"mode":"edit"')
    const error = captureError(() => parseGemgen(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('provenance.requestMode')
  })

  it('gemproj 序列化边界：mode 形过渡输入（lab store 写面）映射 requestMode，产物不落 mode——以 gemgen 验证', () => {
    const input: GemgenFileInput = {
      appVersion: '0.1.0-test',
      createdAt: 1,
      savedAt: 2,
      name: '过渡写键档案',
      image: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 64, height: 64 },
      provenance: {
        runId: 'run-x',
        templateName: '模板',
        promptBody: 'p',
        composedPrompt: 'c',
        candidateIndex: 0,
        mode: 'edit', // v1 过渡写键（deprecated）
        model: 'gpt-image-2.5',
        size: '1024x1024',
      },
    }
    const text = serializeGemgen(input)
    expect(text).toContain('"requestMode":"edit"')
    expect(text).not.toContain('"mode"')
    // 缺两键 → typed error
    const missing = { ...input, provenance: { ...input.provenance, mode: undefined } }
    const error = captureError(() => serializeGemgen(missing))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('provenance.requestMode')
  })
})

// ---------------------------------------------------------------------------
// gemproj LayerRecord 分区不变量拒绝面 + v1 读面派生边界
// ---------------------------------------------------------------------------

describe('LayerRecord 分区不变量与 v1 读面派生（W0 0.3）', () => {
  const baseInput: GemprojFileInput = JSON.parse(
    serializeGemproj(toGemprojInput(parseGemproj(GEMPROJ_V1))),
  ) as GemprojFileInput

  function withLayers(layers: unknown[]): string {
    return serializeGemproj({ ...baseInput, layers: layers as GemprojFileInput['layers'] })
  }

  it('零 rest 层 → parser 拒收（分区不变量）', () => {
    const error = captureError(() =>
      parseGemproj(
        withLayers([
          {
            id: 'L1',
            name: '显式层',
            blockIds: ['blk-1'],
            strategy: 'cvt',
            physics: { specKey: 'round-ss12', gapMm: 0.5, density: 0.8, relax: { boundary: false, repulsion: false } },
            overrides: { disabled: {}, density: {}, type: {}, color: {} },
          },
        ]),
      ),
    )
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('layers')
    expect((error as ProjectFileFieldError).found).toContain('0 个 rest 层')
  })

  it('多 rest 层 → parser 拒收', () => {
    const restLayer = baseInput.layers[0]
    const error = captureError(() => parseGemproj(withLayers([restLayer, { ...restLayer, id: 'L2' }])))
    expect((error as ProjectFileFieldError).found).toContain('2 个 rest 层')
  })

  it('跨层重复块 id → parser 拒收（路径 layers.1.blockIds.N）', () => {
    const restLayer = baseInput.layers[0]
    const explicit = {
      id: 'L2',
      name: '显式层',
      blockIds: ['blk-9'],
      strategy: 'cvt',
      physics: { specKey: 'round-ss12', gapMm: 0.5, density: 1, relax: { boundary: false, repulsion: false } },
      overrides: { disabled: {}, density: {}, type: {}, color: {} },
    }
    const dup = { ...explicit, id: 'L3', blockIds: ['blk-9'] }
    const error = captureError(() => parseGemproj(withLayers([restLayer, explicit, dup])))
    expect((error as ProjectFileFieldError).path).toBe('layers.2.blockIds.0')
  })

  it('非圆钻 specKey 的 v1 读面派生拒绝（过渡期显式 typed error——replay gate 迁移后解除）', () => {
    const squareInput: GemprojFileInput = {
      ...baseInput,
      layers: [
        {
          ...baseInput.layers[0],
          physics: { ...baseInput.layers[0].physics, specKey: 'square-3.5' },
        },
      ],
    }
    const text = serializeGemproj(squareInput) // 序列化侧不派生读面——合法 v2 字节
    const error = captureError(() => parseGemproj(text))
    expect(error).toBeInstanceOf(ProjectFileFieldError)
    expect((error as ProjectFileFieldError).path).toBe('layers.0.physics.specKey')
    expect((error as ProjectFileFieldError).expected).toContain('round-ssXX')
  })
})

// ---------------------------------------------------------------------------
// 回灌助手（parse 产物 → 再次 serialize 输入；剥离派生/只读面）
// ---------------------------------------------------------------------------

function toGemprojInput(file: GemprojFile): GemprojFileInput {
  const { kind, formatVersion, engineVersion, physics, activeStrategy, overrides, ...input } = file
  void kind
  void formatVersion
  void engineVersion
  void physics
  void activeStrategy
  void overrides
  return input
}

function toGemdocInput(file: GemdocFile): GemdocFileInput {
  const { kind, formatVersion, engineVersion, blocks, ...rest } = file
  void kind
  void formatVersion
  void engineVersion
  return { ...rest, blocks: blocks.map(fromSerializedBlock) }
}

function toGemgenInput(file: ReturnType<typeof parseGemgen>): GemgenFileInput {
  const { kind, formatVersion, provenance, ...rest } = file
  void kind
  void formatVersion
  const { advancedJsonRedacted, ...prov } = provenance
  return {
    ...rest,
    provenance: {
      ...prov,
      ...(advancedJsonRedacted !== undefined ? { advancedJson: advancedJsonRedacted } : {}),
    },
  }
}
