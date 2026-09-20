/**
 * [gem-catalog 2.3] 四格式 v1→v2 迁移完整实现 + 五格式 byte-round-trip 矩阵（design §4 迁移细则）：
 * - 全字段 v1 fixture（比 W0 0.3 最小 fixture 更宽）：gemproj embedded source + reference +
 *   overrides 四表多键 / gemdoc 全 provenance + reference + m- 手工钻 + moved 钻 / gemtpl 全字段 /
 *   gemgen provenance.mode 旧档只读映射 → 迁移 → v2 映射击断 + save→load→save 字节等价；
 * - 五格式矩阵（四格式 + .gemshape v1 起步）：round-trip 字节等价 + 向前拒读（supported+1）+
 *   断链拒绝（formatVersion 0：v0→v1 迁移路径不存在 = 版本错误，不猜测解析）；
 * - gemproj overrides 块键搬运（键 = 引擎块 id 原样搬运，v1 即如此——图层稿 R1 议题 2 纠偏）；
 *   打开/重放后的 pruneStaleOverrides 归 replay/handoff gate（本层只搬运）。
 * [2026-09-21 redesign-designer-workbench 1.2 v3 演进]（显式更新）：gemdoc 链终点 v3
 * （v1→v2→v3；v2 字节改手写历史 fixture；矩阵回灌助手随 underlay 入源更新）。
 * 纯函数测试：无 IndexedDB / canvas 依赖。
 */

import { describe, expect, it } from 'vitest'
import { SS_TABLE } from '$lib/engine'
import {
  PROJECTFILE_FORMAT_VERSIONS,
  ProjectFileVersionError,
  maskBitsToBase64,
  parseGemdoc,
  parseGemproj,
  serializeGemdoc,
  serializeGemproj,
  fromSerializedBlock,
  type GemdocFile,
  type GemdocFileInput,
} from '$lib/persistence/projectFile'
import {
  LABFILE_FORMAT_VERSIONS,
  LabFileVersionError,
  parseGemgen,
  parseGemtpl,
  serializeGemgen,
  serializeGemtpl,
  type GemgenFile,
} from '$lib/persistence/labFile'
import { GEMSHAPE_FORMAT_VERSION, GemshapeFieldError, parseGemshape, serializeGemshape } from '$lib/persistence/gemshapeFile'

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

/** v→v' 改版本号的通用助手（保持 JSON 其余字节面）。 */
function withVersion(text: string, version: number): string {
  const doc = JSON.parse(text) as Record<string, unknown>
  doc.formatVersion = version
  return JSON.stringify(doc)
}

// ---------------------------------------------------------------------------
// 全字段 v1 fixture（宽形态：W0 最小 fixture 之外补 embedded source / reference /
// 多键 overrides 四表 / 全 provenance / moved 钻）
// ---------------------------------------------------------------------------

const GEMPROJ_V1_FULL = JSON.stringify({
  kind: 'gemproj',
  formatVersion: 1,
  appVersion: '0.1.0-test',
  engineVersion: 1,
  createdAt: 1758000000111,
  savedAt: 1758000000222,
  name: '全字段·排钻工程',
  source: {
    kind: 'embedded',
    name: '花环原图.png',
    mime: 'image/png',
    dataUrl: PNG_DATA_URL,
    width: 1024,
    height: 768,
    downscale: 0.75,
  },
  reference: { assetId: 'ast-img-ref-9', name: '原图.png' },
  segment: { k: 10, seed: 42 },
  overrides: {
    disabled: { 'blk-1': true, 'blk-7': true },
    density: { 'blk-2': 0.35, 'blk-8': 1 },
    type: { 'blk-2': 'linear', 'blk-9': 'element' },
    color: { 'blk-3': 'red', 'blk-10': 'gold' },
  },
  physics: { ss: 'SS16', gapMm: 0.6, globalDensity: 0.9, relax: { boundary: true, repulsion: true } },
  palette: [
    { id: 'red', name: '红', hex: '#C8102E' },
    { id: 'gold', name: '金', hex: '#D4A017' },
  ],
  activeStrategy: 'hybrid',
})

/** [1.2 v3 演进] gemdoc v2 全字段 fixture：手写历史字节面（v2 形态不可由 serializeGemdoc 产出）。 */
function makeGemdocV2Full(): Record<string, unknown> {
  return {
    kind: 'gemdoc',
    formatVersion: 2,
    appVersion: '0.1.0-test',
    engineVersion: 1,
    createdAt: 1758000000444,
    savedAt: 1758000000555,
    name: '全字段·精修文档',
    width: 960,
    height: 720,
    grid: { pitchMm: SS_TABLE.SS12 + 0.5, gapMm: 0.5, rowAngleDeg: 0, pixelsPerMm: 2.5 },
    palette: [
      { id: 'red', name: '红', hex: '#C8102E' },
      { id: 'gold', name: '金', hex: '#D4A017' },
    ],
    gems: [
      { id: 'g00001', x: 12.5, y: 20.25, colorId: 'red', blockId: 'blk-1', origin: 'layout', moved: true, shapeId: 'round', diameterMm: SS_TABLE.SS12 },
      { id: 'g00002', x: 40, y: 60, colorId: 'gold', blockId: 'blk-2', origin: 'layout', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS12 },
      { id: 'm-1', x: 88, y: 64, colorId: 'red', blockId: null, origin: 'manual', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS12 },
      { id: 'm-12', x: 92, y: 70, colorId: 'gold', blockId: null, origin: 'manual', moved: false, shapeId: 'round', diameterMm: SS_TABLE.SS12 },
    ],
    blocks: [
      {
        id: 'blk-1',
        label: '花环主体',
        mask: { w: 2, h: 2, bits: maskBitsToBase64(Uint8Array.from([1, 0, 0, 1])) },
        colorRgb: [200, 16, 46],
        areaPx: 2,
        bbox: { x: 10, y: 20, w: 2, h: 2 },
        widthPx: { max: 2, mean: 1.5 },
        suggested: 'fill',
      },
      {
        id: 'blk-2',
        label: '浆果',
        mask: { w: 1, h: 2, bits: maskBitsToBase64(Uint8Array.from([1, 1])) },
        colorRgb: [212, 160, 23],
        areaPx: 2,
        bbox: { x: 40, y: 60, w: 1, h: 2 },
        widthPx: { max: 1, mean: 1 },
        suggested: 'element',
      },
    ],
    layers: {
      painting: { visible: true, opacity: 1 },
      reference: { visible: false, opacity: 0.5 },
      blocks: { visible: true, opacity: 0.8 },
      gems: { visible: true, opacity: 1 },
    },
    painting: { mime: 'image/png', dataUrl: PNG_DATA_URL },
    reference: { assetId: 'ast-img-ref-9', name: '原图.png' },
    provenance: {
      origin: 'quick-layout',
      sourceSummary: '混合 · 密度 90% · SS12 · 4 钻',
      sourceAssetId: 'ast-img-src-9',
      gemprojAssetId: 'ast-proj-9',
    },
  }
}

function makeGemdocV1Full(): string {
  const doc = makeGemdocV2Full()
  doc.formatVersion = 1
  for (const gem of doc.gems as Array<Record<string, unknown>>) {
    delete gem.shapeId
    delete gem.diameterMm
  }
  const grid = doc.grid as Record<string, unknown>
  delete grid.gapMm
  grid.ss = 'SS12'
  return JSON.stringify(doc)
}

/** [1.2 v3 演进] gemdoc parse 产物 → 再序列化输入（blocks 源引擎形态回灌）。 */
function toGemdocInput(file: GemdocFile): GemdocFileInput {
  const { kind, formatVersion, engineVersion, underlay, ...rest } = file
  void kind
  void formatVersion
  void engineVersion
  return {
    ...rest,
    underlay: {
      sources: underlay.sources.map((source) =>
        source.key === 'blocks'
          ? { ...source, blocks: source.blocks.map(fromSerializedBlock) }
          : source,
      ),
    },
  }
}

const GEMTPL_V1_FULL = JSON.stringify({
  kind: 'gemtpl',
  formatVersion: 1,
  appVersion: '0.1.0-test',
  createdAt: 1758000000333,
  savedAt: 1758000000333,
  name: '花环边框·浆果环带',
  promptBody: '保持节日构图完整。'.repeat(50),
  caseBinding: { assetId: 'ast-img-case-1', caseLayout: 'horizontal' },
  candidates: 4,
  provenance: { source: 'builtin-seed', presetId: 'preset-wreath', sourceNote: '内置案例' },
})

const GEMGEN_V1_FULL = JSON.stringify({
  kind: 'gemgen',
  formatVersion: 1,
  appVersion: '0.1.0-test',
  createdAt: 1758000000444,
  savedAt: 1758000000555,
  name: '全字段·候选2',
  image: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 1024, height: 1024 },
  provenance: {
    runId: 'run-9',
    templateAssetId: 'ast-tpl-9',
    templateName: '花环边框·浆果环带',
    promptBody: '保持节日构图完整。',
    composedPrompt: '你是一位专业的钻石画设计师……全文快照',
    caseBinding: { assetId: 'ast-img-case-1', caseLayout: 'horizontal' },
    referenceAssetId: 'ast-img-ref-9',
    candidateIndex: 1,
    mode: 'generate',
    model: 'gpt-image-2.5',
    size: '1024x1024',
    advancedJsonRedacted: '{"size":"1024x1024"}',
  },
})

// ---------------------------------------------------------------------------
// 全字段 v1 迁移演练：v2 映射击断 + 迁移产物 round-trip 字节等价
// ---------------------------------------------------------------------------

describe('全字段 v1 fixture 迁移（2.3：W0 最小 fixture 之外的宽形态）', () => {
  it('gemproj：embedded source + reference + overrides 四表多键 块键搬运 → 单 rest 层逐值对齐', () => {
    const migrated = parseGemproj(GEMPROJ_V1_FULL)
    expect(migrated.formatVersion).toBe(2)
    expect(migrated.layers).toHaveLength(1)
    const rest = migrated.layers[0]
    expect(rest.blockIds).toBe('rest')
    expect(rest.strategy).toBe('hybrid')
    expect(rest.physics).toEqual({
      specKey: 'round-ss16',
      gapMm: 0.6,
      density: 0.9,
      relax: { boundary: true, repulsion: true },
    })
    // overrides 块键搬运：键 = 引擎块 id 原样（迁移只搬运；pruneStaleOverrides 归 replay gate）
    expect(rest.overrides.disabled).toEqual({ 'blk-1': true, 'blk-7': true })
    expect(rest.overrides.density).toEqual({ 'blk-2': 0.35, 'blk-8': 1 })
    expect(rest.overrides.type).toEqual({ 'blk-2': 'linear', 'blk-9': 'element' })
    expect(rest.overrides.color).toEqual({ 'blk-3': 'red', 'blk-10': 'gold' })
    // 非迁移面零丢失：embedded source / reference / palette 原样
    expect(migrated.source.kind).toBe('embedded')
    expect(migrated.reference).toEqual({ assetId: 'ast-img-ref-9', name: '原图.png' })
    expect(migrated.palette).toHaveLength(2)
    // 迁移产物 round-trip 字节等价（save→load→save）
    const saved = serializeGemproj(migrated)
    expect(serializeGemproj(parseGemproj(saved))).toBe(saved)
  })

  it('gemdoc：m- 手工钻 + moved 钻 + 全 provenance + reference → 全 gems 补 round/查表直径 + grid gap 反推 + [1.2 v3] 三源/L1 归属', () => {
    const migrated = parseGemdoc(makeGemdocV1Full())
    expect(migrated.formatVersion).toBe(3)
    expect(migrated.grid.gapMm).toBe(0.5)
    expect(migrated.grid.pitchMm).toBeCloseTo(SS_TABLE.SS12 + 0.5, 12)
    for (const gem of migrated.gems) {
      expect(gem.shapeId).toBe('round')
      expect(gem.diameterMm).toBe(SS_TABLE.SS12)
      expect(gem.layerId).toBe('L1')
    }
    expect(migrated.gems.map((g) => g.id)).toEqual(['g00001', 'g00002', 'm-1', 'm-12'])
    expect(migrated.gems[0].moved).toBe(true) // moved 语义搬运
    expect(migrated.gems[2].blockId).toBeNull() // 手工钻 blockId 语义搬运
    // [1.2 v3 演进] reference 弱引用入源；provenance 直传
    const referenceSource = migrated.underlay.sources.find((s) => s.key === 'reference')!
    expect(referenceSource.reference).toEqual({ assetId: 'ast-img-ref-9', name: '原图.png' })
    expect(referenceSource.visible).toBe(false) // v2 reference 层显隐原值（§5.5 无损）
    expect(referenceSource.opacity).toBe(0.5)
    expect(migrated.provenance.sourceAssetId).toBe('ast-img-src-9')
    expect(migrated.provenance.gemprojAssetId).toBe('ast-proj-9')
    const blocksSource = migrated.underlay.sources.find((s) => s.key === 'blocks')!
    expect(fromSerializedBlock(blocksSource.blocks[1]).mask.bits).toEqual(Uint8Array.from([1, 1]))
    const saved = serializeGemdoc(toGemdocInput(migrated))
    expect(serializeGemdoc(toGemdocInput(parseGemdoc(saved)))).toBe(saved)
  })

  it('gemtpl：全字段直通（caseBinding/provenance/promptBody 8000 内全量）', () => {
    const migrated = parseGemtpl(GEMTPL_V1_FULL)
    expect(migrated.formatVersion).toBe(2)
    expect(migrated.caseBinding).toEqual({ assetId: 'ast-img-case-1', caseLayout: 'horizontal' })
    expect(migrated.provenance.presetId).toBe('preset-wreath')
    expect(migrated.candidates).toBe(4)
    const saved = serializeGemtpl(migrated)
    expect(serializeGemtpl(parseGemtpl(saved))).toBe(saved)
  })

  it('gemgen：provenance.mode 旧档只读映射 requestMode（原键不落 v2 字节）；其余 provenance 全量搬运', () => {
    const migrated = parseGemgen(GEMGEN_V1_FULL)
    expect(migrated.formatVersion).toBe(2)
    expect(migrated.provenance.requestMode).toBe('generate')
    expect('mode' in (migrated.provenance as Record<string, unknown>)).toBe(false)
    expect(migrated.provenance.advancedJsonRedacted).toBe('{"size":"1024x1024"}')
    expect(migrated.provenance.caseBinding).toEqual({ assetId: 'ast-img-case-1', caseLayout: 'horizontal' })
    const saved = serializeGemgen(migrated as GemgenFile)
    expect(serializeGemgen(parseGemgen(saved) as GemgenFile)).toBe(saved)
    expect(saved).not.toContain('"mode"')
  })
})

// ---------------------------------------------------------------------------
// 五格式矩阵：byte-round-trip + 向前拒读 + 断环拒绝
// ---------------------------------------------------------------------------

describe('五格式 byte-round-trip 矩阵 + 版本门（2.3）', () => {
  const cases: Array<{
    format: string
    v1: () => string
    supported: number
    save: (migratedText: string) => string // 迁移产物 → 规范保存字节
    load: (text: string) => string // 保存字节 → 再保存（load→save）
    forwardError: unknown
    chainError: unknown
  }> = [
    {
      format: 'gemproj',
      v1: () => GEMPROJ_V1_FULL,
      supported: PROJECTFILE_FORMAT_VERSIONS.gemproj,
      save: (t) => serializeGemproj(parseGemproj(t)),
      load: (t) => serializeGemproj(parseGemproj(t)),
      forwardError: ProjectFileVersionError,
      chainError: ProjectFileVersionError,
    },
    {
      format: 'gemdoc',
      v1: makeGemdocV1Full,
      supported: PROJECTFILE_FORMAT_VERSIONS.gemdoc,
      save: (t) => serializeGemdoc(toGemdocInput(parseGemdoc(t))),
      load: (t) => serializeGemdoc(toGemdocInput(parseGemdoc(t))),
      forwardError: ProjectFileVersionError,
      chainError: ProjectFileVersionError,
    },
    {
      format: 'gemtpl',
      v1: () => GEMTPL_V1_FULL,
      supported: LABFILE_FORMAT_VERSIONS.gemtpl,
      save: (t) => serializeGemtpl(parseGemtpl(t)),
      load: (t) => serializeGemtpl(parseGemtpl(t)),
      forwardError: LabFileVersionError,
      chainError: LabFileVersionError,
    },
    {
      format: 'gemgen',
      v1: () => GEMGEN_V1_FULL,
      supported: LABFILE_FORMAT_VERSIONS.gemgen,
      save: (t) => serializeGemgen(parseGemgen(t) as GemgenFile),
      load: (t) => serializeGemgen(parseGemgen(t) as GemgenFile),
      forwardError: LabFileVersionError,
      chainError: LabFileVersionError,
    },
    {
      format: 'gemshape',
      v1: () =>
        serializeGemshape({
          appVersion: '0.1.0-test',
          createdAt: 1758000000666,
          savedAt: 1758000000777,
          name: '矩阵·自定义钻形',
          texture: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 8, height: 8 },
          vectorPath: 'M 0.1 0.5 L 0.5 0.1 L 0.9 0.5 L 0.5 0.9 Z',
          physical: { widthMm: 3, heightMm: 3 },
          specKey: 'custom-ast-matrix',
          calibration: { mode: 'direct' },
        }),
      supported: GEMSHAPE_FORMAT_VERSION,
      save: (t) => serializeGemshape(parseGemshape(t)),
      load: (t) => serializeGemshape(parseGemshape(t)),
      forwardError: GemshapeFieldError,
      chainError: GemshapeFieldError,
    },
  ]

  for (const c of cases) {
    it(`${c.format}：v1 起点字节 → 迁移/直通 → save→load→save 字节等价（supported = v${c.supported}）`, () => {
      const migrated = c.save(c.v1())
      expect(c.load(migrated)).toBe(migrated)
    })

    it(`${c.format}：formatVersion ${c.supported + 1} → 向前拒读（typed 版本/字段错误，不猜测解析）`, () => {
      const text = withVersion(c.v1(), c.supported + 1)
      const error = captureError(() => c.load(text))
      expect(error).toBeInstanceOf(c.forwardError)
    })

    it(`${c.format}：formatVersion 0 → 断环拒绝（缺 v0→v1 迁移路径 = 版本错误，不猜测解析）`, () => {
      const text = withVersion(c.v1(), 0)
      const error = captureError(() => c.load(text))
      expect(error).toBeInstanceOf(c.chainError)
      if (c.format !== 'gemshape') {
        // 四格式走迁移链：断环 = 版本错误且指明缺失路径
        expect((error as Error).message).toContain('v0→v1')
      } else {
        // .gemshape v1 起步：无迁移链（v0 = 非法版本，非断环）
        expect((error as Error).message).toContain('v1 起步')
      }
    })
  }
})
