/**
 * 图像处理设置存储（add-image-processing-settings tasks 1.2 / design §1+§3）。
 * settings 表 KV 键 image_processing（JSON 体=ImageProcessingSettingsSchema——档位
 * +values 快照，零迁移）。生效值解析单源（读面与 kernel 消费共用）：
 *   [1] settings 键在场且 JSON 合法（过 ImageProcessingSettingsSchema）→ 真源
 *       （source='settings'，effective=快照 values）。
 *   [2] 未写入且 env 在场（PPCM_TARGET 可解析 或 PPCM_RESAMPLE 在场）→ env 解析
 *       （source='env'：ppcmTarget=resolveIntakeResampleConfig 同款 clamp 10..50
 *       坏值 25；resampleEnabled=PPCM_RESAMPLE!=='0'；SAM 两字段无 env 键=回落
 *       性能档映射）。
 *   [3] 否则内置缺省=性能档映射（source='default'）。
 * 预设冻结映射单源在本模块（IMAGE_PROCESSING_PRESET_VALUES——design §1）：非
 * custom 档保存时服务端按映射生成 values 快照落库（入参 values 忽略——防客户端
 * 篡改）；custom 档 values 必填（缺失 throw→rpc 面 typed 拒 invalid-input）。
 * 与 models-store 的差异：无密钥面、无桥接文件重写、无 models_initialized 式终局
 * 标记——reset=删键回到 env/default 跟随（期望语义：UI「恢复跟随环境/默认」动作）。
 * 坏 JSON 容错按未写入处理（parseJson 先例），不 throw。
 */
import {
  ImageProcessingSettingsSchema,
  type ImageProcessingEnvState,
  type ImageProcessingGetOutput,
  type ImageProcessingPreset,
  type ImageProcessingSaveInput,
  type ImageProcessingSettings,
  type ImageProcessingValues,
} from '@handicraft/contracts';
import type { SqliteDb } from './db/database.js';
import { deleteSetting, getSetting, putSetting } from './db/store.js';
import {
  PPCM_RESAMPLE_ENV,
  PPCM_TARGET_ENV,
  resolveIntakeResampleConfig,
} from './kernel/vision/intake-resample.js';

/** settings 表 KV 键（JSON 体=ImageProcessingSettingsSchema）。 */
const KEY_IMAGE_PROCESSING = 'image_processing';

/**
 * 预设冻结映射（design §1——映射单源在 daemon）：快速=15px/cm+conf 0.50+掩码压
 * 1024；性能=25px/cm+conf 0.40+原尺寸（当前生产行为逐字段等价——缺省即现状零漂移）；
 * 高质量=40px/cm+conf 0.30+原尺寸。已保存用户存的是快照——映射定义演进不影响。
 */
export const IMAGE_PROCESSING_PRESET_VALUES = {
  fast: { ppcmTarget: 15, resampleEnabled: true, samConfThreshold: 0.5, samMaskMaxSide: 1024 },
  balanced: { ppcmTarget: 25, resampleEnabled: true, samConfThreshold: 0.4, samMaskMaxSide: null },
  quality: { ppcmTarget: 40, resampleEnabled: true, samConfThreshold: 0.3, samMaskMaxSide: null },
} as const satisfies Record<Exclude<ImageProcessingPreset, 'custom'>, ImageProcessingValues>;

// ---------------------------------------------------------------- 读面（解析单源）

/** settings 键读回（坏 JSON/不符 schema=未写入容错——不 throw）。 */
function loadSettings(db: SqliteDb): ImageProcessingSettings | null {
  const raw = getSetting(db, KEY_IMAGE_PROCESSING);
  if (raw === null) return null;
  try {
    const check = ImageProcessingSettingsSchema.safeParse(JSON.parse(raw));
    return check.success ? check.data : null;
  } catch {
    return null; // 坏 JSON 按未写入（下次保存覆盖）。
  }
}

/** env 在场状态解析（present=source 判据；ppcmTarget 仅在 PPCM_TARGET 可解析时投影——已 clamp 界内）。 */
function envStateOf(
  env: NodeJS.ProcessEnv,
):
  | { present: false }
  | { present: true; state?: ImageProcessingEnvState; effective: ImageProcessingValues } {
  const targetRaw = Number(env[PPCM_TARGET_ENV]?.trim() ?? '');
  const targetParseable = Number.isFinite(targetRaw) && targetRaw > 0;
  const resamplePresent = env[PPCM_RESAMPLE_ENV] !== undefined;
  if (!targetParseable && !resamplePresent) {
    return { present: false };
  }
  // ppcmTarget/开关沿用 resolveIntakeResampleConfig 同款解析（clamp 10..50、坏值 25、
  // PPCM_RESAMPLE=0 关）——env 面宽容；SAM 两字段无 env 键=回落性能档映射。
  const resolved = resolveIntakeResampleConfig(env);
  const state: ImageProcessingEnvState = {
    ...(targetParseable ? { ppcmTarget: resolved.ppcmTarget } : {}),
    ...(resamplePresent && env[PPCM_RESAMPLE_ENV]?.trim() === '0'
      ? { resampleDisabled: true }
      : {}),
  };
  return {
    present: true,
    state,
    effective: {
      ppcmTarget: resolved.ppcmTarget,
      resampleEnabled: resolved.enabled,
      samConfThreshold: IMAGE_PROCESSING_PRESET_VALUES.balanced.samConfThreshold,
      samMaskMaxSide: IMAGE_PROCESSING_PRESET_VALUES.balanced.samMaskMaxSide,
    },
  };
}

/** 冻结映射 → 快照副本（防共享引用被调用方改动）。 */
function snapshotOf(preset: Exclude<ImageProcessingPreset, 'custom'>): ImageProcessingValues {
  return { ...IMAGE_PROCESSING_PRESET_VALUES[preset] };
}

/**
 * 读面（生效值+来源）：settings → env → default 单源解析。source='settings' 时
 * env 字段不投影（settings 真源——env 不参与）；source='default' 时同（无 env 可言）。
 */
export function loadImageProcessing(
  db: SqliteDb,
  env: NodeJS.ProcessEnv = process.env,
): ImageProcessingGetOutput {
  const stored = loadSettings(db);
  if (stored !== null) {
    return { settings: stored, source: 'settings', effective: { ...stored.values } };
  }
  const envState = envStateOf(env);
  if (envState.present) {
    return {
      settings: null,
      source: 'env',
      effective: envState.effective,
      ...(envState.state !== undefined ? { env: envState.state } : {}),
    };
  }
  return { settings: null, source: 'default', effective: snapshotOf('balanced') };
}

/** 内部消费单源面（scene.analyze intake provider / SAM 每请求调谐——调用时解析，不缓存）。 */
export function imageProcessingEffective(
  db: SqliteDb,
  env: NodeJS.ProcessEnv = process.env,
): ImageProcessingValues {
  return loadImageProcessing(db, env).effective;
}

// ---------------------------------------------------------------- 写面

/**
 * 保存（返回读面=保存即回生效态）：
 * - reset 分支：删 settings 键 → 回 env/default 跟随。
 * - custom：values 必填（缺失 throw——rpc 面 typed 拒 invalid-input）。
 * - 非 custom：入参 values 忽略，按冻结映射生成快照落库（映射单源在 daemon）。
 */
export function saveImageProcessing(
  db: SqliteDb,
  input: ImageProcessingSaveInput,
  env: NodeJS.ProcessEnv = process.env,
): ImageProcessingGetOutput {
  if (!('preset' in input)) {
    // reset 分支（联合中唯一无 preset 的分支）：删键 → 回 env/default 跟随。
    deleteSetting(db, KEY_IMAGE_PROCESSING);
    return loadImageProcessing(db, env);
  }
  const preset = input.preset;
  const values: ImageProcessingValues =
    preset === 'custom'
      ? (() => {
          if (input.values === undefined) {
            throw new Error('自定义档必须携带 values（四参数全放开——缺失 typed 拒 invalid-input）');
          }
          return { ...input.values };
        })()
      : snapshotOf(preset);
  putSetting(db, KEY_IMAGE_PROCESSING, JSON.stringify({ preset, values }));
  return loadImageProcessing(db, env);
}
