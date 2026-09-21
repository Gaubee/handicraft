/**
 * 内置模板 v2 预设文案（openspec add-lab-effect-prompt-placeholders 切片 4；
 * Owner 2026-09-20「现在的提示词实验室里面的这些模板有明显的问题，都是旧版的」）。
 *
 * v2 = 域指导句（v1 预设既有文案仍成立）+ 效果占位符示例（【案例参照图提示词】独立成行——
 * 演示占位符体系的注入位；案例开关 seed 默认开）。派生自 EFFECT_REF_PRESETS（单一真源，
 * 不复制图片/来源字段）；素材物化沿用基 presetId（复用同一合成图资产，不重复建图）。
 *
 * 〔WYSIWYG 2026-09-21，enforce-lab-prompt-wysiwyg〕DRILL_RULES 归宿〔裁断，可推翻〕：
 * 通用贴钻指导规则并入 v2 模板 seed 正文尾部（可见、逐模板可编辑可删）——运行时组合器
 * 不再有任何隐藏规则注入通道；{ref} 引用改用通用措辞「画面」（seed 是静态的，不随附图
 * 集物化具体图号）。既有已 seed/已编辑的用户模板正文零改动（自然失去规则注入，正是
 * WYSIWYG 语义——create-only seed 不回写）。create-only 幂等：已存在节点（含软删）跳过，
 * 规则尾只惠及新 seed（新库/测试环境）。
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
  /** v2 模板正文（域指导句 + 案例占位符示例行 + 贴钻指导规则尾）。 */
  promptBody: string
  sourceNote: string
}

/**
 * 通用贴钻指导规则（Owner 2026-09-19 原文四条；〔WYSIWYG 迁移 2026-09-21〕原组合器
 * 第④层注入块的字面迁入——{ref} 占位以通用措辞「画面」物化：seed 静态，不随附图集
 * 物化具体图号；用户在模板正文里可自行替换为具体图号引用）。
 */
const DRILL_RULES_GENERIC = [
  '1. 虚实结合（Partial Drill）：不要全图贴钻。保留画面的大面积背景与次要细节为原始画风/印刷效果。',
  '2. 选区策略：仅在画面的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。',
  '3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。',
  '4. 画风一致性：未贴钻的背景区域需完全保持画面的原有风格、构图与配色。',
].join('\n')

/** v2 正文生成：域指导句 + 占位符示例（独立成行）+ 规则尾（可见可编辑可删）。 */
function v2PromptBodyOf(basePrompt: string): string {
  return `${basePrompt}\n【案例参照图提示词】\n\n【贴钻指导规则】：\n${DRILL_RULES_GENERIC}`
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
