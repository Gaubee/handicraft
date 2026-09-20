/**
 * labFile 序列化层契约全量（openspec add-project-files design §7.1/§7.2 + §1.3 + §2）：
 * round-trip 字节等价（含 gemtpl 未变更字段零漂移 + 键序快照）/ formatVersion 向前拒读 /
 * 迁移链空链语义 / 脏输入矩阵（typed error + 字段路径）/ 防御上限（promptBody 8000 截断、
 * candidates 1-8 clamp——localStorage 防线由 schema 校验接管，补充稿 §F-5）/
 * advancedJsonRedacted N3 打码同口径 / gemgenImageBlob 零重编码 / MIME 与 PROJECT_MIME 对齐。
 * 纯函数测试：无 IndexedDB、无 localStorage 依赖。
 */

import { describe, expect, it } from 'vitest'
import {
  GEMTPL_CANDIDATES_MAX,
  GEMTPL_CANDIDATES_MIN,
  GEMTPL_PROMPT_BODY_MAX,
  LABFILE_FORMAT_VERSIONS,
  LabFileFieldError,
  LabFileKindError,
  LabFileVersionError,
  gemgenImageBlob,
  labFileMime,
  parseGemgen,
  parseGemtpl,
  serializeGemgen,
  serializeGemtpl,
  type GemgenFile,
  type GemgenFileInput,
  type GemtplFile,
  type GemtplFileInput,
} from '$lib/persistence/labFile'
import { PROJECT_MIME } from '$lib/persistence/projectTypes'

// ---------------------------------------------------------------------------
// 样本（满字段 / 最小字段；时间戳取不易撞车的非整值）
// ---------------------------------------------------------------------------

const APP_VERSION = '0.1.0-test'

/** PNG 魔数头 + IHDR 前缀样本（字节等价断言用，非完整 PNG） */
const PNG_BYTES = [
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]
const PNG_B64 = btoa(String.fromCharCode(...PNG_BYTES))
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`

const gemtplFull: GemtplFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000111,
  savedAt: 1758000000222,
  name: '城市分层·全要素',
  promptBody: '保持场景各层次的完整节日构图：边框花环＋大字标题实铺单色钻。',
  caseBinding: { assetId: 'ast-img-case-1', caseLayout: 'horizontal' },
  candidates: 4,
  provenance: { source: 'builtin-seed', presetId: 'new-orleans', sourceNote: '本仓样本 01' },
}

const gemtplMinimal: GemtplFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000333,
  savedAt: 1758000000333,
  name: '模板 2',
  promptBody: '',
  caseBinding: null,
  candidates: 1,
  provenance: { source: 'user-created' },
}

const gemgenFull: GemgenFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000444,
  savedAt: 1758000000555,
  name: '城市分层·全要素·候选2',
  image: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 1024, height: 1024 },
  provenance: {
    runId: 'run-1',
    templateAssetId: 'ast-tpl-new-orleans',
    templateName: '城市分层·全要素',
    promptBody: '保持场景各层次的完整节日构图。',
    composedPrompt: '你是一位专业的钻石画……全文快照（审计真源）',
    caseBinding: { assetId: 'ast-img-case-1', caseLayout: 'horizontal' },
    referenceAssetId: 'ast-img-ref-1',
    candidateIndex: 1,
    requestMode: 'edit',
    model: 'gpt-image-2.5',
    size: '1024x1024',
    advancedJson: '{"apiKey":"sk-x","background":"transparent"}',
  },
}

const gemgenMinimal: GemgenFileInput = {
  appVersion: APP_VERSION,
  createdAt: 1758000000666,
  savedAt: 1758000000666,
  name: '花环边框·浆果环带·候选1',
  image: { mime: 'image/png', dataUrl: PNG_DATA_URL, width: 512, height: 512 },
  provenance: {
    runId: 'run-2',
    templateName: '花环边框·浆果环带',
    promptBody: '',
    composedPrompt: '你是一位专业的钻石画……',
    candidateIndex: 0,
    requestMode: 'generate',
    model: 'gpt-image-2.5',
    size: '1024x1024',
  },
}

/** gemgen 不可变档案回灌序列化：advancedJsonRedacted → advancedJson（打码幂等，字节等价前提） */
function gemgenToInput(file: GemgenFile): GemgenFileInput {
  const { advancedJsonRedacted, ...provenance } = file.provenance
  return {
    ...file,
    provenance: {
      ...provenance,
      ...(advancedJsonRedacted !== undefined ? { advancedJson: advancedJsonRedacted } : {}),
    },
  }
}

/** 捕获式断言辅助：返回抛出的错误实例（避免断言链丢失字段访问） */
function captureError(fn: () => unknown): unknown {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error('预期抛错但未抛出')
}

function blobBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(reader.result)
      else reject(new Error('blobBytes 结果异常'))
    }
    reader.onerror = () => reject(reader.error ?? new Error('FileReader 读取失败'))
    reader.readAsArrayBuffer(blob)
  })
}

// ---------------------------------------------------------------------------
// round-trip 字节等价（§1.3 纪律：每次 bump 附往返测试）
// ---------------------------------------------------------------------------

describe('labFile round-trip 字节等价', () => {
  it('gemtpl 满字段：serialize→parse→serialize 字节等价', () => {
    const s1 = serializeGemtpl(gemtplFull)
    const s2 = serializeGemtpl(parseGemtpl(s1))
    expect(s2).toBe(s1)
  })

  it('gemtpl 最小字段：字节等价（可选键缺席不落键）', () => {
    const s1 = serializeGemtpl(gemtplMinimal)
    const s2 = serializeGemtpl(parseGemtpl(s1))
    expect(s2).toBe(s1)
    const parsed = parseGemtpl(s1)
    expect(Object.keys(parsed.provenance)).toEqual(['source'])
  })

  it('gemgen 满字段：字节等价（advancedJsonRedacted 打码幂等）', () => {
    const s1 = serializeGemgen(gemgenFull)
    const s2 = serializeGemgen(gemgenToInput(parseGemgen(s1)))
    expect(s2).toBe(s1)
  })

  it('gemgen 最小字段：字节等价', () => {
    const s1 = serializeGemgen(gemgenMinimal)
    const s2 = serializeGemgen(gemgenToInput(parseGemgen(s1)))
    expect(s2).toBe(s1)
  })

  it('gemtpl 未变更字段零漂移：仅 savedAt 变化的重序列化，其余字节稳定', () => {
    const s1 = serializeGemtpl(gemtplFull)
    const file = parseGemtpl(s1)
    const newSavedAt = file.savedAt + 4321
    const s2 = serializeGemtpl({ ...file, savedAt: newSavedAt })
    expect(s2).not.toBe(s1)
    // 把新 savedAt 段替换回旧值后必须与原字节完全一致（其余字段零漂移）
    expect(s2.replace(`"savedAt":${newSavedAt}`, `"savedAt":${file.savedAt}`)).toBe(s1)
  })

  it('键序 = schema 声明序（确定性序列化的回归快照）', () => {
    expect(Object.keys(JSON.parse(serializeGemtpl(gemtplFull)))).toEqual([
      'kind',
      'formatVersion',
      'appVersion',
      'createdAt',
      'savedAt',
      'name',
      'promptBody',
      'caseBinding',
      'candidates',
      'provenance',
    ])
    expect(Object.keys(JSON.parse(serializeGemtpl(gemtplFull)).provenance)).toEqual([
      'source',
      'presetId',
      'sourceNote',
    ])
    expect(Object.keys(JSON.parse(serializeGemgen(gemgenFull)))).toEqual([
      'kind',
      'formatVersion',
      'appVersion',
      'createdAt',
      'savedAt',
      'name',
      'image',
      'provenance',
    ])
    expect(Object.keys(JSON.parse(serializeGemgen(gemgenFull)).image)).toEqual(['mime', 'dataUrl', 'width', 'height'])
    expect(Object.keys(JSON.parse(serializeGemgen(gemgenFull)).provenance)).toEqual([
      'runId',
      'templateAssetId',
      'templateName',
      'promptBody',
      'composedPrompt',
      'caseBinding',
      'referenceAssetId',
      'candidateIndex',
      'requestMode',
      'model',
      'size',
      'advancedJsonRedacted',
    ])
    expect(Object.keys(JSON.parse(serializeGemgen(gemgenMinimal)).provenance)).toEqual([
      'runId',
      'templateName',
      'promptBody',
      'composedPrompt',
      'candidateIndex',
      'requestMode',
      'model',
      'size',
    ])
  })
})

// ---------------------------------------------------------------------------
// 版本纪律：向前拒读 + 迁移链（§1.3）
// ---------------------------------------------------------------------------

describe('labFile 版本纪律', () => {
  it('LABFILE_FORMAT_VERSIONS：两格式当前均为 v2（gem-catalog W0 0.3 bump）', () => {
    expect(LABFILE_FORMAT_VERSIONS.gemtpl).toBe(2)
    expect(LABFILE_FORMAT_VERSIONS.gemgen).toBe(2)
  })

  it('gemtpl formatVersion+1 → LabFileVersionError 且不解析（版本门先于字段校验）', () => {
    const newer = JSON.stringify({
      kind: 'gemtpl',
      formatVersion: LABFILE_FORMAT_VERSIONS.gemtpl + 1,
      // 混入脏字段：若被字段校验先命中说明版本门失效
      promptBody: 123,
    })
    const error = captureError(() => parseGemtpl(newer))
    expect(error).toBeInstanceOf(LabFileVersionError)
    expect((error as LabFileVersionError).message).toContain('更新版本')
  })

  it('gemgen formatVersion+1 → LabFileVersionError 且不解析', () => {
    const newer = JSON.stringify({ kind: 'gemgen', formatVersion: LABFILE_FORMAT_VERSIONS.gemgen + 1 })
    const error = captureError(() => parseGemgen(newer))
    expect(error).toBeInstanceOf(LabFileVersionError)
    expect((error as LabFileVersionError).message).toContain('更新版本')
  })

  it('formatVersion 0（旧版本且迁移链为空）→ LabFileVersionError 报迁移路径缺失', () => {
    const older = JSON.stringify({ kind: 'gemtpl', formatVersion: 0 })
    const error = captureError(() => parseGemtpl(older))
    expect(error).toBeInstanceOf(LabFileVersionError)
    expect((error as LabFileVersionError).message).toContain('迁移')
  })

  it('formatVersion 非整数 → LabFileFieldError(formatVersion)', () => {
    const dirty = JSON.stringify({ kind: 'gemtpl', formatVersion: 1.5 })
    const error = captureError(() => parseGemtpl(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('formatVersion')
  })
})

// ---------------------------------------------------------------------------
// kind / MIME 交叉校验（design §2 三者对齐）
// ---------------------------------------------------------------------------

describe('labFile kind/MIME 交叉校验', () => {
  it('serialize 产物 MIME 与 PROJECT_MIME 对齐（唯一真源消费，不重定义）', () => {
    expect(labFileMime('gemtpl')).toBe(PROJECT_MIME.gemtpl)
    expect(labFileMime('gemtpl')).toBe('application/vnd.rhinestone-studio.gemtpl+json')
    expect(labFileMime('gemgen')).toBe(PROJECT_MIME.gemgen)
    expect(labFileMime('gemgen')).toBe('application/vnd.rhinestone-studio.gemgen+json')
  })

  it('kind 错（gemgen 文本喂 parseGemtpl）→ LabFileKindError', () => {
    const error = captureError(() => parseGemtpl(serializeGemgen(gemgenMinimal)))
    expect(error).toBeInstanceOf(LabFileKindError)
    expect((error as LabFileKindError).field).toBe('kind')
    expect((error as LabFileKindError).expected).toBe('gemtpl')
    expect((error as LabFileKindError).found).toBe('gemgen')
  })

  it('MIME 不符（gemgen MIME 喂 parseGemtpl）→ LabFileKindError(mime)', () => {
    const error = captureError(() => parseGemtpl(serializeGemtpl(gemtplFull), { mime: PROJECT_MIME.gemgen }))
    expect(error).toBeInstanceOf(LabFileKindError)
    expect((error as LabFileKindError).field).toBe('mime')
  })

  it('MIME 门先于 JSON 解析（坏文本 + 错 MIME → 报 MIME 不符）', () => {
    const error = captureError(() => parseGemgen('not json', { mime: 'application/json' }))
    expect(error).toBeInstanceOf(LabFileKindError)
    expect((error as LabFileKindError).field).toBe('mime')
  })
})

// ---------------------------------------------------------------------------
// 脏输入矩阵（typed error + 字段路径）
// ---------------------------------------------------------------------------

describe('labFile 脏输入矩阵', () => {
  /** 从合法 gemtpl 样本出发做字段级篡改（保持其余字段合法，定位路径归属） */
  function dirtyGemtpl(patch: (file: GemtplFile) => Record<string, unknown>): string {
    return JSON.stringify(patch(parseGemtpl(serializeGemtpl(gemtplFull))))
  }

  /** 从合法 gemgen 样本出发做字段级篡改 */
  function dirtyGemgen(patch: (file: GemgenFile) => Record<string, unknown>): string {
    return JSON.stringify(patch(parseGemgen(serializeGemgen(gemgenFull))))
  }

  it('gemtpl createdAt 非数字 → LabFileFieldError(createdAt)', () => {
    const error = captureError(() => parseGemtpl(dirtyGemtpl((f) => ({ ...f, createdAt: 'yesterday' }))))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('createdAt')
  })

  it('gemtpl 缺 caseBinding 键 → LabFileFieldError(caseBinding)', () => {
    const error = captureError(() => parseGemtpl(dirtyGemtpl((f) => ({ ...f, caseBinding: undefined }))))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('caseBinding')
  })

  it('gemtpl 缺 provenance → LabFileFieldError(provenance)', () => {
    const error = captureError(() => parseGemtpl(dirtyGemtpl((f) => ({ ...f, provenance: undefined }))))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('provenance')
  })

  it('gemtpl 缺 kind → 路径 kind', () => {
    const error = captureError(() => parseGemtpl(dirtyGemtpl((f) => ({ ...f, kind: undefined }))))
    expect((error as LabFileFieldError).path).toBe('kind')
  })

  it('gemtpl promptBody 非字符串 → 路径 promptBody', () => {
    const error = captureError(() => parseGemtpl(dirtyGemtpl((f) => ({ ...f, promptBody: 123 }))))
    expect((error as LabFileFieldError).path).toBe('promptBody')
  })

  it('gemtpl caseLayout 非法 → 路径 caseBinding.caseLayout', () => {
    const error = captureError(() =>
      parseGemtpl(dirtyGemtpl((f) => ({ ...f, caseBinding: { assetId: 'a', caseLayout: 'diagonal' } }))),
    )
    expect((error as LabFileFieldError).path).toBe('caseBinding.caseLayout')
  })

  it('gemtpl provenance.source 非法 → 路径 provenance.source', () => {
    const error = captureError(() =>
      parseGemtpl(dirtyGemtpl((f) => ({ ...f, provenance: { ...f.provenance, source: 'magic' } }))),
    )
    expect((error as LabFileFieldError).path).toBe('provenance.source')
  })

  it('gemgen 缺 runId → 路径 provenance.runId', () => {
    const error = captureError(() =>
      parseGemgen(dirtyGemgen((f) => ({ ...f, provenance: { ...f.provenance, runId: undefined } }))),
    )
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('provenance.runId')
  })

  it('gemgen requestMode 非法 → 路径 provenance.requestMode（v2 拆键——requestMode 为唯一写键）', () => {
    const error = captureError(() =>
      parseGemgen(dirtyGemgen((f) => ({ ...f, provenance: { ...f.provenance, requestMode: 'upscale' } }))),
    )
    expect((error as LabFileFieldError).path).toBe('provenance.requestMode')
  })

  it('gemgen 缺 image → 路径 image', () => {
    const error = captureError(() => parseGemgen(dirtyGemgen((f) => ({ ...f, image: undefined }))))
    expect((error as LabFileFieldError).path).toBe('image')
  })

  it('gemgen image.mime 缺失 → 路径 image.mime', () => {
    const error = captureError(() =>
      parseGemgen(dirtyGemgen((f) => ({ ...f, image: { ...f.image, mime: undefined } }))),
    )
    expect((error as LabFileFieldError).path).toBe('image.mime')
  })

  it('gemgen dataUrl 非 data URL → 路径 image.dataUrl', () => {
    const error = captureError(() =>
      parseGemgen(dirtyGemgen((f) => ({ ...f, image: { ...f.image, dataUrl: 'https://example.com/x.png' } }))),
    )
    expect((error as LabFileFieldError).path).toBe('image.dataUrl')
  })

  it('gemgen dataUrl 头部 mime 与 image.mime 不一致 → 路径 image.dataUrl', () => {
    const error = captureError(() =>
      parseGemgen(
        dirtyGemgen((f) => ({ ...f, image: { ...f.image, dataUrl: `data:image/jpeg;base64,${PNG_B64}` } })),
      ),
    )
    expect((error as LabFileFieldError).path).toBe('image.dataUrl')
  })

  it('gemgen candidateIndex 负数 → 路径 provenance.candidateIndex', () => {
    const error = captureError(() =>
      parseGemgen(dirtyGemgen((f) => ({ ...f, provenance: { ...f.provenance, candidateIndex: -1 } }))),
    )
    expect((error as LabFileFieldError).path).toBe('provenance.candidateIndex')
  })

  it('非 JSON 文本 → LabFileFieldError(文档根)', () => {
    const error = captureError(() => parseGemtpl('not json at all'))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('')
  })

  it('数组根 → LabFileFieldError(文档根)', () => {
    const error = captureError(() => parseGemgen('[]'))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('')
  })
})

// ---------------------------------------------------------------------------
// 防御上限：promptBody 8000 截断 / candidates 1-8 clamp（schema 校验接管，补充稿 §F-5）
// ---------------------------------------------------------------------------

describe('labFile 防御上限', () => {
  it('promptBody 9000 字符 → 序列化时 8000 截断', () => {
    const long = '钻'.repeat(9000)
    const text = serializeGemtpl({ ...gemtplFull, promptBody: long })
    const parsed = parseGemtpl(text)
    expect(parsed.promptBody.length).toBe(GEMTPL_PROMPT_BODY_MAX)
    expect(parsed.promptBody).toBe('钻'.repeat(8000))
  })

  it('parse 侧同口径：手工超长文件读取时截断', () => {
    const dirty = JSON.stringify({ ...parseGemtpl(serializeGemtpl(gemtplFull)), promptBody: 'x'.repeat(9000) })
    expect(parseGemtpl(dirty).promptBody.length).toBe(GEMTPL_PROMPT_BODY_MAX)
  })

  it('candidates 越界 clamp：99→8、0→1、2.9→2（floor 同 normalizeVariants）', () => {
    const base = parseGemtpl(serializeGemtpl(gemtplFull))
    const clamp = (candidates: number): number =>
      parseGemtpl(JSON.stringify({ ...base, candidates })).candidates
    expect(clamp(99)).toBe(GEMTPL_CANDIDATES_MAX)
    expect(clamp(0)).toBe(GEMTPL_CANDIDATES_MIN)
    expect(clamp(2.9)).toBe(2)
  })

  it('serialize 侧同样 clamp + 截断（写路径防御，杜绝非法字节落盘）', () => {
    const text = serializeGemtpl({ ...gemtplFull, candidates: 99, promptBody: 'y'.repeat(9000) })
    const parsed = parseGemtpl(text)
    expect(parsed.candidates).toBe(GEMTPL_CANDIDATES_MAX)
    expect(parsed.promptBody.length).toBe(GEMTPL_PROMPT_BODY_MAX)
  })

  it('candidates NaN（运行时脏值）→ serialize 拒绝（typed error，不产出非法 JSON）', () => {
    const error = captureError(() => serializeGemtpl({ ...gemtplFull, candidates: Number.NaN }))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('candidates')
  })
})

// ---------------------------------------------------------------------------
// advancedJsonRedacted（N3 打码同口径，design §9.3 E11）
// ---------------------------------------------------------------------------

describe('labFile advancedJsonRedacted 打码', () => {
  it('serialize 边界统一打码：敏感键 → ***（与 maskAdvancedJsonForPersist 同口径）', () => {
    const parsed = parseGemgen(serializeGemgen(gemgenFull))
    expect(parsed.provenance.advancedJsonRedacted).toBe('{"apiKey":"***","background":"transparent"}')
  })

  it('空 advancedJson → advancedJsonRedacted 键缺席', () => {
    const text = serializeGemgen({ ...gemgenFull, provenance: { ...gemgenFull.provenance, advancedJson: '' } })
    const parsed = parseGemgen(text)
    expect(parsed.provenance.advancedJsonRedacted).toBeUndefined()
    expect(text.includes('"advancedJsonRedacted"')).toBe(false)
  })

  it('非法 JSON 兜底原样保留（同口径：上游运行时校验已拦截）', () => {
    const parsed = parseGemgen(
      serializeGemgen({ ...gemgenFull, provenance: { ...gemgenFull.provenance, advancedJson: '{bad' } }),
    )
    expect(parsed.provenance.advancedJsonRedacted).toBe('{bad')
  })
})

// ---------------------------------------------------------------------------
// gemgenImageBlob（dataUrl → Blob 零重编码，B2 单点消费的纯函数半成品）
// ---------------------------------------------------------------------------

describe('labFile gemgenImageBlob', () => {
  it('dataUrl round-trip 字节等价（PNG 魔数头样本）+ type 取档案 image.mime', async () => {
    const file = parseGemgen(serializeGemgen(gemgenFull))
    const blob = await gemgenImageBlob(file)
    expect(blob.type).toBe('image/png')
    const bytes = new Uint8Array(await blobBytes(blob))
    expect(Array.from(bytes)).toEqual(PNG_BYTES)
  })

  it('坏 dataUrl → LabFileFieldError(image.dataUrl)', async () => {
    const parsed = parseGemgen(serializeGemgen(gemgenMinimal))
    const bad: GemgenFile = { ...parsed, image: { ...parsed.image, dataUrl: 'not-a-data-url' } }
    const error = await gemgenImageBlob(bad).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('image.dataUrl')
  })

  it('base64 载荷非法（charset 合法但解码失败）→ LabFileFieldError(image.dataUrl)', async () => {
    const parsed = parseGemgen(serializeGemgen(gemgenMinimal))
    // "A" 是合法 base64 字符但长度不对齐，atob 解码失败
    const bad: GemgenFile = { ...parsed, image: { ...parsed.image, dataUrl: 'data:image/png;base64,A' } }
    const error = await gemgenImageBlob(bad).then(
      () => null,
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('image.dataUrl')
  })
})

// ---------------------------------------------------------------------------
// [add-lab 4.1] 正交高级选项键接线（gemtpl blueprint.refs 键位补齐 + gemgen 蓝图快照/
// blueprintPrompt + drillParams 脏输入防线：重复 specKey / enabled 空清单 / refs>2）
// ---------------------------------------------------------------------------

describe('labFile 正交高级选项键（add-lab 4.1）', () => {
  const gemtplAdvanced: GemtplFileInput = {
    ...gemtplFull,
    drillParams: { enabled: true, specs: ['round-ss10', 'square-3.5'] },
    blueprint: { enabled: true, refs: ['ast-ref-1', 'ast-ref-2'] },
  }

  const gemgenAdvanced: GemgenFileInput = {
    ...gemgenFull,
    gemSpecs: [
      { specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 },
    ],
    physicalCanvas: { widthMm: 210, heightMm: 148, anchorSource: 'declared' },
    provenance: {
      ...gemgenFull.provenance,
      drillParams: { enabled: true, specs: ['round-ss10'] },
      blueprint: { strategy: 'serial', status: 'success' },
      blueprintPrompt: '【任务：施工蓝图转换】……全文快照',
    },
  }

  it('gemtpl blueprint.refs 落键：round-trip 字节等价 + parse 恢复 refs', () => {
    const s1 = serializeGemtpl(gemtplAdvanced)
    expect(serializeGemtpl(parseGemtpl(s1))).toBe(s1)
    const parsed = parseGemtpl(s1)
    expect(parsed.blueprint).toEqual({ enabled: true, refs: ['ast-ref-1', 'ast-ref-2'] })
    expect(parsed.drillParams).toEqual({ enabled: true, specs: ['round-ss10', 'square-3.5'] })
    expect(s1).toContain('"blueprint"')
  })

  it('gemgen 蓝图快照 + blueprintPrompt + gemSpecs/physicalCanvas：round-trip 字节等价', () => {
    const s1 = serializeGemgen(gemgenAdvanced)
    const round: GemgenFileInput = {
      ...parseGemgen(s1),
      provenance: (() => {
        const { advancedJsonRedacted, ...rest } = parseGemgen(s1).provenance
        return { ...rest, ...(advancedJsonRedacted !== undefined ? { advancedJson: advancedJsonRedacted } : {}) }
      })(),
    }
    expect(serializeGemgen(round)).toBe(s1)
    const parsed = parseGemgen(s1)
    expect(parsed.provenance.blueprint).toEqual({ strategy: 'serial', status: 'success' })
    expect(parsed.provenance.blueprintPrompt).toBe('【任务：施工蓝图转换】……全文快照')
    expect(parsed.gemSpecs?.[0].specKey).toBe('round-ss10')
    expect(parsed.physicalCanvas).toEqual({ widthMm: 210, heightMm: 148, anchorSource: 'declared' })
  })

  it('gemgen 蓝图快照带 error / failed / cancelled / parallel 形态 round-trip', () => {
    for (const snapshot of [
      { strategy: 'serial' as const, status: 'failed' as const, error: '蓝图生成失败：HTTP 500' },
      { strategy: 'parallel' as const, status: 'cancelled' as const, error: 'SKIPPED_UPSTREAM' },
      { strategy: 'parallel' as const, status: 'cancelled' as const },
    ]) {
      const s1 = serializeGemgen({ ...gemgenFull, provenance: { ...gemgenFull.provenance, blueprint: snapshot } })
      expect(parseGemgen(s1).provenance.blueprint).toEqual(snapshot)
      expect(s1).toContain(`"status":"${snapshot.status}"`)
    }
  })

  it('脏输入：drillParams 重复 specKey → 路径 drillParams.specs.<i>（身份唯一性禁令）', () => {
    const dirty = serializeGemtpl(gemtplAdvanced).replace(
      '"specs":["round-ss10","square-3.5"]',
      '"specs":["round-ss10","round-ss10"]',
    )
    const error = captureError(() => parseGemtpl(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('drillParams.specs.1')
  })

  it('脏输入：enabled=true + 空清单 → 路径 drillParams.specs；enabled=false + 空清单 = 关灯空态合法', () => {
    const dirty = serializeGemtpl(gemtplAdvanced).replace(
      '"specs":["round-ss10","square-3.5"]',
      '"specs":[]',
    )
    const error = captureError(() => parseGemtpl(dirty))
    expect((error as LabFileFieldError).path).toBe('drillParams.specs')
    // 关灯空态：enabled=false + 空清单合法（数据保留语义的镜像——关灯可清空）
    const off = serializeGemtpl({ ...gemtplFull, drillParams: { enabled: false, specs: [] } })
    expect(parseGemtpl(off).drillParams).toEqual({ enabled: false, specs: [] })
  })

  it('脏输入：blueprint.refs>2 → 路径 blueprint.refs（BLUEPRINT_REFS_MAX 硬上限）', () => {
    const dirty = serializeGemtpl(gemtplAdvanced).replace(
      '"refs":["ast-ref-1","ast-ref-2"]',
      '"refs":["ast-ref-1","ast-ref-2","ast-ref-3"]',
    )
    const error = captureError(() => parseGemtpl(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('blueprint.refs')
  })

  it('脏输入：blueprint.refs 重复 → 路径 blueprint.refs.<i>', () => {
    const dirty = serializeGemtpl(gemtplAdvanced).replace(
      '"refs":["ast-ref-1","ast-ref-2"]',
      '"refs":["ast-ref-1","ast-ref-1"]',
    )
    const error = captureError(() => parseGemtpl(dirty))
    expect((error as LabFileFieldError).path).toBe('blueprint.refs.1')
  })

  it('脏输入：gemgen provenance.blueprint 快照形状非法 → 路径 provenance.blueprint.<字段>', () => {
    const badStrategy = serializeGemgen(gemgenAdvanced).replace('"strategy":"serial"', '"strategy":"fast"')
    expect((captureError(() => parseGemgen(badStrategy)) as LabFileFieldError).path).toBe(
      'provenance.blueprint.strategy',
    )
    const badStatus = serializeGemgen(gemgenAdvanced).replace('"status":"success"', '"status":"skipped"')
    expect((captureError(() => parseGemgen(badStatus)) as LabFileFieldError).path).toBe(
      'provenance.blueprint.status',
    )
  })

  it('gemgen 缺 requestMode（手造 v2 无键）→ 路径 provenance.requestMode（唯一写键）', () => {
    const dirty = JSON.stringify({ ...parseGemgen(serializeGemgen(gemgenFull)) })
      .replace('"requestMode":"edit",', '')
    const error = captureError(() => parseGemgen(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('provenance.requestMode')
  })
})

// ---------------------------------------------------------------------------
// [R6 P1-1] custom 身份链持久化边界闭合：gemgen.gemSpecs custom 规格缺 assetId
// = parse 入口 typed reject（engine customAssetIdMissing 单一语义源；不延迟到 engine/导出门）
// ---------------------------------------------------------------------------

describe('labFile custom assetId typed reject（R6 P1-1）', () => {
  const withSpecs = serializeGemgen({
    ...gemgenFull,
    gemSpecs: [{ specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 2.8 }],
  })

  it('gemSpecs.0 shapeId=custom 且 assetId 缺席 → 路径 gemSpecs.0.assetId', () => {
    const dirty = withSpecs.replace('"shapeId":"round"', '"shapeId":"custom"')
    const error = captureError(() => parseGemgen(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('gemSpecs.0.assetId')
    expect((error as LabFileFieldError).message).toContain('custom')
  })

  it('gemSpecs.0 shapeId=custom 且 assetId 空串 → 同路径拒读（空串 = 缺）', () => {
    const dirty = withSpecs.replace(
      '"shapeId":"round","sizeLabel"',
      '"shapeId":"custom","assetId":"","sizeLabel"',
    )
    const error = captureError(() => parseGemgen(dirty))
    expect((error as LabFileFieldError).path).toBe('gemSpecs.0.assetId')
  })

  it('serialize 侧运行时脏值（custom 规格无 assetId）同口径拒绝——无半载荷字节产出', () => {
    const error = captureError(() =>
      serializeGemgen({
        ...gemgenFull,
        gemSpecs: [{ specKey: 'custom-ast-shape-1', ordinal: 1, shapeId: 'custom', sizeLabel: '自定义 3.2', diameterMm: 3.2 }],
      }),
    )
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('gemSpecs.0.assetId')
  })

  it('合法面不受影响：custom 携 assetId round-trip 字节等价；builtin gemSpecs 零回归', () => {
    const s1 = serializeGemgen({
      ...gemgenFull,
      gemSpecs: [
        { specKey: 'custom-ast-shape-1', ordinal: 1, shapeId: 'custom', sizeLabel: '自定义 3.2', diameterMm: 3.2, assetId: 'ast-shape-1' },
      ],
    })
    const round: GemgenFileInput = {
      ...parseGemgen(s1),
      provenance: (() => {
        const { advancedJsonRedacted, ...rest } = parseGemgen(s1).provenance
        return { ...rest, ...(advancedJsonRedacted !== undefined ? { advancedJson: advancedJsonRedacted } : {}) }
      })(),
    }
    expect(serializeGemgen(round)).toBe(s1)
    expect(parseGemgen(s1).gemSpecs?.[0].assetId).toBe('ast-shape-1')
    // builtin 规格（round，无 assetId）照常
    expect(parseGemgen(withSpecs).gemSpecs?.[0].specKey).toBe('round-ss10')
  })
})

// ---------------------------------------------------------------------------
// [placeholders add-lab-effect-prompt-placeholders 1.1] 效果提示词占位符键：
// gemtpl caseRef / drillParams.promptFragment / blueprint.promptFragment +
// gemgen provenance.fragmentSources——round-trip 字节等价 + 缺席零漂移 + 脏输入
// ---------------------------------------------------------------------------

describe('labFile 效果提示词占位符键（placeholders 1.1）', () => {
  const gemtplPlaceholders: GemtplFileInput = {
    ...gemtplFull,
    promptBody: '正文……\n【案例参照图提示词】\n【水钻参数提示词】\n【蓝图效果提示词】',
    caseRef: { enabled: true, promptFragment: '案例片段覆盖文本' },
    drillParams: { enabled: true, specs: ['round-ss10'], promptFragment: '水钻片段覆盖文本' },
    blueprint: { enabled: true, refs: ['ast-ref-1'], promptFragment: '蓝图片段覆盖文本' },
  }

  it('满键 round-trip 字节等价 + parse 恢复三片段覆盖', () => {
    const s1 = serializeGemtpl(gemtplPlaceholders)
    expect(serializeGemtpl(parseGemtpl(s1))).toBe(s1)
    const parsed = parseGemtpl(s1)
    expect(parsed.caseRef).toEqual({ enabled: true, promptFragment: '案例片段覆盖文本' })
    expect(parsed.drillParams?.promptFragment).toBe('水钻片段覆盖文本')
    expect(parsed.blueprint?.promptFragment).toBe('蓝图片段覆盖文本')
    expect(parsed.promptBody).toContain('【案例参照图提示词】')
  })

  it('键序快照：caseRef 落在 candidates 与 drillParams 之间', () => {
    const keys = Object.keys(JSON.parse(serializeGemtpl(gemtplPlaceholders)) as Record<string, unknown>)
    expect(keys.indexOf('caseRef')).toBeGreaterThan(keys.indexOf('candidates'))
    expect(keys.indexOf('caseRef')).toBeLessThan(keys.indexOf('drillParams'))
  })

  it('缺席零漂移：无 caseRef/片段的既有样本字节与既有形态一致（可选键缺席不落键）', () => {
    const s1 = serializeGemtpl(gemtplFull)
    expect(s1).not.toContain('"caseRef"')
    expect(s1).not.toContain('"promptFragment"')
    expect(serializeGemtpl(parseGemtpl(s1))).toBe(s1)
  })

  it('caseRef 无片段形态（仅开关）round-trip；空串片段 = 空覆盖合法', () => {
    const s1 = serializeGemtpl({ ...gemtplFull, caseRef: { enabled: false } })
    expect(parseGemtpl(s1).caseRef).toEqual({ enabled: false })
    expect(serializeGemtpl(parseGemtpl(s1))).toBe(s1)
    const s2 = serializeGemtpl({ ...gemtplFull, caseRef: { enabled: true, promptFragment: '' } })
    expect(parseGemtpl(s2).caseRef).toEqual({ enabled: true, promptFragment: '' })
  })

  it('脏输入：caseRef.enabled 非 boolean → 路径 caseRef.enabled', () => {
    const dirty = serializeGemtpl(gemtplPlaceholders).replace('"caseRef":{"enabled":true', '"caseRef":{"enabled":"on"')
    const error = captureError(() => parseGemtpl(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('caseRef.enabled')
  })

  it('脏输入：drillParams.promptFragment 非 string → 路径 drillParams.promptFragment', () => {
    const dirty = serializeGemtpl(gemtplPlaceholders).replace(
      '"promptFragment":"水钻片段覆盖文本"',
      '"promptFragment":42',
    )
    const error = captureError(() => parseGemtpl(dirty))
    expect((error as LabFileFieldError).path).toBe('drillParams.promptFragment')
  })

  it('脏输入：blueprint.promptFragment 非 string → 路径 blueprint.promptFragment', () => {
    const dirty = serializeGemtpl(gemtplPlaceholders).replace(
      '"promptFragment":"蓝图片段覆盖文本"',
      '"promptFragment":null',
    )
    const error = captureError(() => parseGemtpl(dirty))
    expect((error as LabFileFieldError).path).toBe('blueprint.promptFragment')
  })

  it('gemgen provenance.fragmentSources round-trip 字节等价 + 脏枚举 typed reject', () => {
    const withSources = serializeGemgen({
      ...gemgenFull,
      provenance: { ...gemgenFull.provenance, fragmentSources: { case: 'auto', drill: 'override' } },
    })
    const round: GemgenFileInput = {
      ...parseGemgen(withSources),
      provenance: (() => {
        const { advancedJsonRedacted, ...rest } = parseGemgen(withSources).provenance
        return { ...rest, ...(advancedJsonRedacted !== undefined ? { advancedJson: advancedJsonRedacted } : {}) }
      })(),
    }
    expect(serializeGemgen(round)).toBe(withSources)
    expect(parseGemgen(withSources).provenance.fragmentSources).toEqual({ case: 'auto', drill: 'override' })
    const dirty = withSources.replace('"case":"auto"', '"case":"manual"')
    const error = captureError(() => parseGemgen(dirty))
    expect(error).toBeInstanceOf(LabFileFieldError)
    expect((error as LabFileFieldError).path).toBe('provenance.fragmentSources.case')
  })

  it('fragmentSources 空对象归一为键缺席（serialize 不落空键）', () => {
    const s1 = serializeGemgen({
      ...gemgenFull,
      provenance: { ...gemgenFull.provenance, fragmentSources: {} },
    })
    expect(s1).not.toContain('"fragmentSources"')
  })
})
