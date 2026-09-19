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
    mode: 'edit',
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
    mode: 'generate',
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
      'mode',
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
      'mode',
      'model',
      'size',
    ])
  })
})

// ---------------------------------------------------------------------------
// 版本纪律：向前拒读 + 迁移链（§1.3）
// ---------------------------------------------------------------------------

describe('labFile 版本纪律', () => {
  it('LABFILE_FORMAT_VERSIONS：两格式当前均为 v1', () => {
    expect(LABFILE_FORMAT_VERSIONS.gemtpl).toBe(1)
    expect(LABFILE_FORMAT_VERSIONS.gemgen).toBe(1)
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

  it('gemgen mode 非法 → 路径 provenance.mode', () => {
    const error = captureError(() =>
      parseGemgen(dirtyGemgen((f) => ({ ...f, provenance: { ...f.provenance, mode: 'upscale' } }))),
    )
    expect((error as LabFileFieldError).path).toBe('provenance.mode')
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
