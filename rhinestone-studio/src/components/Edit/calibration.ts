/*
 * Orthogonal intents (max 3):
 * 1. [2026-09-20 D-5.4 rename-and-expert-workbench] 自定义钻形校准向导（数据面）：
 *    三步模型（选贴图 → 物理尺寸 direct/reference 二选一 → 命名入库）的纯逻辑——
 *    direct = 声明 mm（贴图 alpha bounds 纵横比容差校验，超容差 = 比例漂移 typed error）；
 *    reference = bakeCalibrationPhysical 反推（alpha bounds 主径 px ÷ 参考规格直径 → px/mm）。
 * 2. [2026-09-20 D-5.4] 烘焙校准语义（gemshapeFile design §1.4）：结果物化 physical，
 *    calibration 只记出处（reference 模式内嵌 refSpecSnapshot 审计凭据）——参考钻/目录
 *    后续改动不影响已产出钻形（内容不可变纪律：不就地改，另存副本）。
 * 3. [2026-09-20 Boundary] 落库/素材库接线归 2.x vertical slice：本模块只产出**合法
 *    GemshapeFile 结构**（serializeGemshape 双侧校验通过）+ CalibrationSavePort 注入位
 *    （documentService 风格依赖注入——2.x 注入真实 ingest，测试注入 fake）。
 *    persistence/gemshapeFile 只读消费（禁改）；specKey 缺席（custom 由 ingest 派生
 *    custom-<assetId>——落库时才有 assetId）。
 */

import { APP_VERSION } from '$lib/appVersion'
import type { GemSpecSnapshot } from '$lib/engine'
import type { CatalogSpec } from '$lib/services/gemCatalogService'
import {
  GEMSHAPE_FIT_TOLERANCE,
  GEMSHAPE_TEXTURE_MAX_BYTES,
  GEMSHAPE_TEXTURE_MAX_PIXELS,
  GemshapeFieldError,
  bakeCalibrationPhysical,
  parseGemshape,
  serializeGemshape,
  type GemshapeCalibration,
  type GemshapeFile,
  type GemshapeFileInput,
  type GemshapeTexture,
} from '$lib/persistence/gemshapeFile'

/** base64 载荷字节数（与 gemshapeFile expectTextureDataUrl 同折算——步骤①预检用）。 */
export function texturePayloadBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',')
  const payload = comma >= 0 ? dataUrl.slice(comma + 1) : ''
  return Math.floor((payload.length * 3) / 4)
}

/** 步骤①贴图预检（同步面：字节/像素上限——MIME/dataUrl 形态由终检 serializeGemshape 兜）。 */
export function checkTextureLimits(texture: GemshapeTexture): GemshapeFieldError | null {
  const pixels = texture.width * texture.height
  if (pixels > GEMSHAPE_TEXTURE_MAX_PIXELS) {
    return new GemshapeFieldError(
      'texture',
      `像素 ≤ ${GEMSHAPE_TEXTURE_MAX_PIXELS} 的贴图`,
      `${texture.width}×${texture.height} = ${pixels} px（超限拒收）`,
    )
  }
  const bytes = texturePayloadBytes(texture.dataUrl)
  if (bytes > GEMSHAPE_TEXTURE_MAX_BYTES) {
    return new GemshapeFieldError(
      'texture',
      `≤ ${GEMSHAPE_TEXTURE_MAX_BYTES} 字节的贴图载荷`,
      `约 ${bytes} 字节（超限拒收——防炸弹贴图）`,
    )
  }
  return null
}

export type PhysicalSizeMode = 'direct' | 'reference'

/** 校准草稿输入（bounds = 贴图 alpha 内容 bounds——解码面注入，向导步骤①→② 解出）。 */
export interface CalibrationDraftInput {
  texture: GemshapeTexture
  bounds: { w: number; h: number }
  mode: PhysicalSizeMode
  /** mode='direct'：声明物理宽高（mm）。 */
  direct?: { widthMm: number; heightMm: number }
  /** mode='reference'：参考规格（目录条目——mock 或 sys-shapes 真源同构）。 */
  reference?: CatalogSpec
}

export type CalibrationDraftResult =
  | { ok: true; physical: { widthMm: number; heightMm: number }; calibration: GemshapeCalibration }
  | { ok: false; error: GemshapeFieldError }

/** 参考规格 → 内嵌审计快照（mock 目录无序号面——快照 ordinal 占位 1，5.6 对齐后带真序号）。 */
export function refSpecSnapshotOf(ref: CatalogSpec): GemSpecSnapshot {
  return {
    specKey: ref.specKey,
    ordinal: 1,
    shapeId: ref.shapeId as GemSpecSnapshot['shapeId'],
    sizeLabel: ref.sizeLabel,
    diameterMm: ref.diameterMm,
  }
}

/**
 * 步骤②校准草稿（纯函数；typed error 面 = 超限（步骤①已查）/ 比例漂移（direct 容差外）/
 * 悬空 ref（reference 无参考规格）/ 空 bounds（全透明贴图））。
 */
export function buildCalibrationDraft(input: CalibrationDraftInput): CalibrationDraftResult {
  if (!(input.bounds.w > 0 && input.bounds.h > 0)) {
    return {
      ok: false,
      error: new GemshapeFieldError('texture.alphaBounds', '非空 alpha 内容 bounds', '空 bounds（全透明贴图）'),
    }
  }
  if (input.mode === 'direct') {
    const direct = input.direct
    if (direct === undefined || !(direct.widthMm > 0) || !(direct.heightMm > 0)) {
      return {
        ok: false,
        error: new GemshapeFieldError('physical', '正的宽高 mm（direct 模式必填）', '缺声明或非正'),
      }
    }
    const boundsAspect = input.bounds.w / input.bounds.h
    const physicalAspect = direct.widthMm / direct.heightMm
    const deviation = Math.abs(physicalAspect - boundsAspect) / boundsAspect
    if (deviation > GEMSHAPE_FIT_TOLERANCE) {
      return {
        ok: false,
        error: new GemshapeFieldError(
          'physical',
          `纵横比与贴图 alpha bounds 一致（容差 ${(GEMSHAPE_FIT_TOLERANCE * 100).toFixed(0)}% 内）`,
          `相对偏差 ${(deviation * 100).toFixed(1)}%（比例漂移 = 物理尺寸谎言，拒收）`,
        ),
      }
    }
    return {
      ok: true,
      physical: { widthMm: direct.widthMm, heightMm: direct.heightMm },
      calibration: { mode: 'direct' },
    }
  }
  const ref = input.reference
  if (ref === undefined || !(ref.diameterMm > 0)) {
    return {
      ok: false,
      error: new GemshapeFieldError('calibration.refSpecId', '可解析的参考规格（reference 模式必填）', '悬空参考（未选/不可解析）'),
    }
  }
  try {
    const physical = bakeCalibrationPhysical(input.bounds, {
      mode: 'reference',
      refSpec: { specKey: ref.specKey, diameterMm: ref.diameterMm },
    })
    return {
      ok: true,
      physical,
      calibration: { mode: 'reference', refSpecId: ref.specKey, refSpecSnapshot: refSpecSnapshotOf(ref) },
    }
  } catch (error) {
    return { ok: false, error: error as GemshapeFieldError }
  }
}

/** 步骤③入库输入（草稿 + 命名）。 */
export interface CommitCalibrationInput extends CalibrationDraftInput {
  name: string
  /** 时间戳注入（缺省 Date.now()——确定性测试注入）。 */
  now?: number
}

/**
 * 产出合法 GemshapeFile（另存副本语义——内容不可变：每次入库 = 新资产新 assetId 新 specKey，
 * 本模块不写 specKey（custom 由 ingest 派生 custom-<assetId>，落库归 2.x）；
 * serializeGemshape 双侧同口径校验（typed error 上浮：MIME/dataUrl 形态/悬空校准等终检面）。
 */
export function buildCalibrationGemshape(input: CommitCalibrationInput): GemshapeFile {
  const name = input.name.trim()
  if (name === '') {
    throw new GemshapeFieldError('name', '非空名称', '空白名（命名入库必填）')
  }
  const draft = buildCalibrationDraft(input)
  if (!draft.ok) throw draft.error
  const now = input.now ?? Date.now()
  const fileInput: GemshapeFileInput = {
    appVersion: APP_VERSION,
    createdAt: now,
    savedAt: now,
    name,
    texture: input.texture,
    physical: draft.physical,
    calibration: draft.calibration,
  }
  const text = serializeGemshape(fileInput) // 双侧校验（拒绝即 typed GemshapeFieldError）
  return parseGemshape(text) // 回读 = 与落库字节一致的定稿结构（再过一遍 parse 校验面）
}

/**
 * 另存意图信号注入位（documentService 风格依赖注入）：2.x 注入真实 ingest
 * （sys-shapes 落库 + custom-<assetId> specKey 派生）；本轨缺席 = 向导只发意图信号
 * （onCommitIntent 回调携带合法 GemshapeFile——结构与未来落库字节一致）。
 */
export type CalibrationSavePort = (file: GemshapeFile) => Promise<{ assetId: string; specKey: string }>
