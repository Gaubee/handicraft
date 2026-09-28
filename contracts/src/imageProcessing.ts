/**
 * 图像处理设置契约（add-image-processing-settings design §2，2026-09-28）：
 * 四档预设（快速/性能/高质量/自定义）+ 自定义四参数（ppcmTarget 入线降采目标密度、
 * resampleEnabled 总开关、samConfThreshold 检出置信度、samMaskMaxSide 掩码长边上限）。
 * 真源：daemon settings 表 image_processing 键（JSON 快照）；未写入回落 env
 * （PPCM_TARGET/PPCM_RESAMPLE）再回落内置缺省=性能档映射——解析单源在 daemon
 * image-processing-store.ts 的 imageProcessingEffective。
 * 安全：无密钥面；非 custom 档保存时服务端按冻结映射生成 values 快照（入参忽略），
 * 映射单源在 daemon，防客户端篡改。
 * 原始需求 2026-09-28（Owner：设置页图像处理设置——px/cm+SAM 高级参数；三档预设
 * +自定义放开细节参数）。
 */
import { z } from 'zod';

/** 预设档（custom=四参数全放开；前三档为 daemon 冻结映射）。 */
export const IMAGE_PROCESSING_PRESETS = ['fast', 'balanced', 'quality', 'custom'] as const;
export const ImageProcessingPresetSchema = z.enum(IMAGE_PROCESSING_PRESETS);
export type ImageProcessingPreset = z.infer<typeof ImageProcessingPresetSchema>;

/** 入线降采目标密度 clamp（1acf8e2 A/B 裁定：25 缺省=1px 0.4mm<最小钻径 1/5）。 */
export const IMAGE_PPCM_MIN = 10;
export const IMAGE_PPCM_MAX = 50;
/** SAM 检出置信度 clamp（macmini sam3_service DEFAULT_CONFIDENCE=0.4 同界）。 */
export const SAM_CONF_MIN = 0.05;
export const SAM_CONF_MAX = 0.95;
/** SAM 掩码长边下限（macmini 服务护栏 ≥32；null=原尺寸）。 */
export const SAM_MASK_MAX_SIDE_MIN = 32;

/** 自定义档放开的四个参数（=生效值结构；非 custom 档保存映射快照同构）。 */
export const ImageProcessingValuesSchema = z.object({
  /** 入线降采目标密度（px/cm，只降不升语义由管线保证）。 */
  ppcmTarget: z.number().int().min(IMAGE_PPCM_MIN).max(IMAGE_PPCM_MAX),
  /** 入线降采总开关（false=原图透传，=原 PPCM_RESAMPLE=0 逃生舱产品化）。 */
  resampleEnabled: z.boolean(),
  /** SAM 检出置信度阈值（每请求透传；越低越敏感多检出）。 */
  samConfThreshold: z.number().min(SAM_CONF_MIN).max(SAM_CONF_MAX),
  /** SAM 掩码长边降采上限；null=原尺寸（缺省）。 */
  samMaskMaxSide: z.number().int().min(SAM_MASK_MAX_SIDE_MIN).nullable(),
});
export type ImageProcessingValues = z.infer<typeof ImageProcessingValuesSchema>;

/** 存储面（settings 表 image_processing 键的 JSON 体：档位+快照）。 */
export const ImageProcessingSettingsSchema = z.object({
  preset: ImageProcessingPresetSchema,
  values: ImageProcessingValuesSchema,
});
export type ImageProcessingSettings = z.infer<typeof ImageProcessingSettingsSchema>;

/** env 兜底层在场状态（未保存时的来源透出；值已按 clamp 规则解析）。 */
export const ImageProcessingEnvStateSchema = z.object({
  /** PPCM_TARGET 在场（已 clamp 的目标密度）。 */
  ppcmTarget: z.number().int().min(IMAGE_PPCM_MIN).max(IMAGE_PPCM_MAX).optional(),
  /** PPCM_RESAMPLE=0 在场（降采关闭）。 */
  resampleDisabled: z.boolean().optional(),
});
export type ImageProcessingEnvState = z.infer<typeof ImageProcessingEnvStateSchema>;

/** 读面：生效值+来源（settings|env|default）。settings 未保存=null。 */
export const ImageProcessingGetOutputSchema = z.object({
  settings: ImageProcessingSettingsSchema.nullable(),
  source: z.enum(['settings', 'env', 'default']),
  effective: ImageProcessingValuesSchema,
  env: ImageProcessingEnvStateSchema.optional(),
});
export type ImageProcessingGetOutput = z.infer<typeof ImageProcessingGetOutputSchema>;

/**
 * 写面联合分支（P2-2 强化——codex 复核 2026-09-28：custom 必带 values 冻结在
 * contracts schema/type，编译期+schema+运行期约束一致）：reset=true 删 settings 键
 * （回 env/default 跟随；.strict() 拒混入 preset/values 等未知字段）；custom 分支
 * values 必填（缺失 schema 拒）；三个固定预设分支 values 可带可不带（服务端按冻结
 * 映射生成快照，入参忽略）。
 */
export const ImageProcessingSaveInputSchema = z.union([
  z.object({ reset: z.literal(true) }).strict(),
  z.object({ preset: z.literal('custom'), values: ImageProcessingValuesSchema }).strict(),
  z
    .object({
      preset: z.enum(['fast', 'balanced', 'quality']),
      values: ImageProcessingValuesSchema.optional(),
    })
    .strict(),
]);
export type ImageProcessingSaveInput = z.infer<typeof ImageProcessingSaveInputSchema>;

/** 写面输出=读面（保存即回生效态）。 */
export const ImageProcessingSaveOutputSchema = ImageProcessingGetOutputSchema;
export type ImageProcessingSaveOutput = z.infer<typeof ImageProcessingSaveOutputSchema>;
