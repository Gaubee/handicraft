/**
 * 内置模板 v2 预设文案（openspec add-lab-effect-prompt-placeholders 切片 4；
 * Owner 2026-09-20「现在的提示词实验室里面的这些模板有明显的问题，都是旧版的」）。
 *
 * v2 = 域指导句（v1 预设既有文案仍成立）+ 效果占位符示例（【案例参照图提示词】独立成行——
 * 演示占位符体系的注入位；案例开关 seed 默认开）。派生自 EFFECT_REF_PRESETS（单一真源，
 * 不复制图片/来源字段）；素材物化沿用基 presetId（复用同一合成图资产，不重复建图）。
 *
 * 节点约定（templateSeed 消费）：id = `ast-tpl-<baseId>-v2`、provenance.presetId = `<baseId>-v2`。
 */

import { EFFECT_REF_PRESETS } from '$lib/presets/effectRefs'

/** v2 模板条目（基 preset 派生——promptBody 换占位符新版文案）。 */
export interface EffectRefTemplatePresetV2 {
  /** v2 presetId（= `<baseId>-v2`；seed 节点 id 与 provenance.presetId 同源）。 */
  id: string
  /** 基 presetId（素材物化 / 旧内置软删判定共用）。 */
  baseId: string
  name: string
  /** v2 模板正文（域指导句 + 案例占位符示例行）。 */
  promptBody: string
  sourceNote: string
}

/** v2 正文生成：域指导句 + 占位符示例（独立成行；案例开关 seed 默认开 → 发起即真实注入）。 */
function v2PromptBodyOf(basePrompt: string): string {
  return `${basePrompt}\n【案例参照图提示词】`
}

/** 派生 v2 预设全集（EFFECT_REF_PRESETS 声明序）。 */
export const EFFECT_REF_PRESETS_V2: readonly EffectRefTemplatePresetV2[] = EFFECT_REF_PRESETS.map(
  (preset) => ({
    id: `${preset.id}-v2`,
    baseId: preset.id,
    name: preset.name,
    promptBody: v2PromptBodyOf(preset.prompt),
    sourceNote: preset.sourceNote,
  }),
)
