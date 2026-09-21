/**
 * 模板级「案例图」内置案例（真实来源）+ 主图请求提示词组合器（WYSIWYG）。
 * [2026-09-19 融合] 模板（原「提示词变体」，[Owner] 改名）与案例一一绑定：
 * 本文件同时是默认模板集合的数据源（见 lab.svelte.ts defaultVariants），
 * preset kind 语义 =「内置案例图」（静态路径直引），无库选择交互。
 *
 * 〔WYSIWYG 基线再生 2026-09-21，enforce-lab-prompt-wysiwyg〕Owner 裁决「我在模板里面
 * 配置什么就是什么，所见即所得」：旧组合器向请求注入的六层隐藏内容（人设前言/图序
 * 计数行/四变体任务指令行/【贴钻指导规则】块/【模板风格补充】壳/输出指令行）**全部
 * 退场**——composeDrillPrompt 收敛为「占位符替换器」：模板体原样居中不包裹、不 trim；
 * 三开关全关 + 模板体无占位符 ⇒ 发送提示词 ≡ 模板体**逐字节**（prompt.byteEq 新红线，
 * 旧六层基线整体作废再生）。图序声明与参照任务句迁入案例参照图片段默认内容
 * （autoCaseRefFragment——Dialog 所见即此内容）；DRILL_RULES 迁入 v2 模板 seed 正文
 * 尾部（effectRefTemplatesV2）；blueprint 骨架迁入蓝图片段默认内容（prompt.ts）。
 *
 * 正交意图：
 * 1. 片段默认生成器（autoCaseRefFragment）：按实际活跃附图集生成多图介绍
 *    （图序声明行 + 一句参照任务，复合对照/单图两变体并入）——figureTagOf 字面单一真源。
 * 2. 每条 prompt = 该案例路线的中文特化建议，彼此差异化；通用规则不在此处
 *    （seed 正文尾部承载，见 effectRefTemplatesV2）。
 * 3. 图片资产位于 public/presets/（sips -Z 800、单张 ≤150KB），根相对静态路径引用。
 *
 * 消费方契约：只依赖 EffectRefPreset 接口形状与
 * 「resImage 恒非空、srcImage 允许空串（无原图对）」的约定，不依赖条目数量或具体 id。
 * 调查依据：.agents/documents/2026-09-19-effectref-research/cases.md。
 */

export interface EffectRefPreset {
  /** 稳定 id（同时是 public/presets/ 下的文件名主干）。 */
  id: string
  /** 中文名。 */
  name: string
  /** 一句话说明该案例的贴钻转化风格。 */
  summary: string
  /** 该模板的特化正文（中文；选区/风格侧重。公共规则由组装器拼装，不写入此处）。 */
  prompt: string
  /** 案例来源说明（tooltip 展示；真实来源，仅供内部工具静态展示）。 */
  sourceNote: string
  /** 案例原图（印刷品照片/设计稿）；空串 = 仅有效果图、无原图对。 */
  srcImage: string
  /** 案例贴钻效果图（恒存在）。 */
  resImage: string
}

import type { CaseRefLayout } from '$lib/lab/caseComposite'

// ---------------------------------------------------------------------------
// 主图请求提示词组合器（〔WYSIWYG 基线再生 2026-09-21〕六层注入退场）
// [2026-09-20 add-lab 0.2] 附图角色 n 元模型（DrillPromptImageRoles/DrillImageRole/
// OrderedDrillImage/orderDrillImages）的**唯一定义点迁至 $lib/lab/prompt**（组装器契约
// 冻结——蓝图 stage 复用同一序号真源且避免 effectRefs↔lab/prompt 循环边）；本文件
// re-export 保持既有消费面（lab.svelte.ts / EffectRefControl / 既有测试）零变化。
// ---------------------------------------------------------------------------

export type { DrillImageRole, DrillPromptImageRoles, OrderedDrillImage } from '$lib/lab/prompt'
export { orderDrillImages as describeDrillImageOrder } from '$lib/lab/prompt'

import { orderDrillImages, figureTagOf, buildDrillSpecSection, deriveMaterialAttachments, substituteEffectPromptPlaceholders, MATERIAL_ROLE_DESC } from '$lib/lab/prompt'
import type { ComposeDrillPromptOptions, DrillImageRole, DrillPromptImageRoles, EffectPromptSubstitution } from '$lib/lab/prompt'

/** 案例参照图的角色描述：按布局说明两半（或单张）的含义。〔WYSIWYG 迁移 2026-09-21〕
 *  原组合器角色声明块的 CASE_DESC 字面原样迁入片段默认生成器（消费面收窄为 autoCaseRefFragment）。 */
const CASE_DESC: Record<CaseRefLayout, string> = {
  horizontal: '案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。',
  vertical: '案例参照合成图：上半为未贴钻的原图，下半为其 Partial Drill（局部贴钻）成品效果图。',
  single: '案例参照图：一张已完成的 Partial Drill（局部贴钻）效果图。',
}

/** 原图（提示词角色字面冻结为「参考图」）的角色描述（片段默认内容的行文案）。 */
const REFERENCE_ROLE_DESC = '需要你处理的目标图像。'

/** 图序声明行的角色描述（附图角色 → 一句话说明；素材图描述 = prompt.MATERIAL_ROLE_DESC 单一真源）。 */
function roleDescOf(entry: { role: DrillImageRole }, roles: DrillPromptImageRoles): string {
  if (entry.role === 'case') return CASE_DESC[roles.caseLayout]
  if (entry.role === 'material') return MATERIAL_ROLE_DESC
  return REFERENCE_ROLE_DESC
}

/** 图序计数行（附图 1 张/0 张的边界形态；与请求 images 数组同源派生）。 */
function figureCountLineOf(count: number): string {
  if (count === 0) return ''
  return `我上传了${count === 1 ? '一张图片' : `${count} 张图片`}：`
}

/**
 * 案例参照图片段默认内容（auto）——〔WYSIWYG 2026-09-21〕图序声明的唯一承载位：
 * 按实际活跃附图集生成多图介绍（计数行 + 每图一条 figureTagOf 字面声明行）+ 一句参照
 * 任务（复合对照 horizontal/vertical 与单图 single 两变体并入）。Dialog 预填即本函数
 * 输出（所见即所发）；用户可覆盖、可改写、可清空——清空片段/移除占位符 = 不发送任何
 * 图序说明（用户的明确选择）。纯函数：同 roles 同输出。
 */
export function autoCaseRefFragment(roles: DrillPromptImageRoles): string {
  const order = orderDrillImages(roles)
  const caseEntry = order.find((e) => e.role === 'case')
  const refEntry = order.find((e) => e.role === 'reference')
  const composite = roles.caseLayout === 'horizontal' || roles.caseLayout === 'vertical'

  let taskLine: string | null = null
  if (caseEntry !== undefined && refEntry !== undefined && composite) {
    taskLine = `请参照${figureTagOf(caseEntry.ordinal, caseEntry.figureLabel)}所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为${figureTagOf(refEntry.ordinal, refEntry.figureLabel)}生成对应的 Partial Drill 效果图。`
  } else if (caseEntry !== undefined && refEntry !== undefined) {
    taskLine = `请参考${figureTagOf(caseEntry.ordinal, caseEntry.figureLabel)}所展示的贴钻风格与选区逻辑，为${figureTagOf(refEntry.ordinal, refEntry.figureLabel)}生成对应的 Partial Drill 效果图。`
  } else if (caseEntry !== undefined) {
    taskLine = `请参考${figureTagOf(caseEntry.ordinal, caseEntry.figureLabel)}所展示的贴钻风格与选区逻辑，生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图。`
  }

  const lines = [
    figureCountLineOf(order.length),
    ...order.map((e) => `${e.ordinal}. ${figureTagOf(e.ordinal, e.figureLabel)}：${roleDescOf(e, roles)}`),
    ...(taskLine !== null ? [taskLine] : []),
  ]
  return lines.filter((line) => line !== '').join('\n')
}

/**
 * 主图请求提示词组合器（〔WYSIWYG 2026-09-21〕六层注入退场后的纯占位符替换器）：
 * - **模板体原样居中**——无人设前言、无计数行、无任务指令行、无规则块、无【模板风格
 *   补充】壳、无输出指令行；不 trim（空白保真）；
 * - 三开关全关 + 模板体无占位符 ⇒ 返回值 ≡ templateBody **逐字节**（byteEq 公理红线）；
 * - 占位符替换（片段 = 用户覆盖 ?? auto 默认内容；键缺席 = 开关关，占位符原样保留）：
 *   - 【案例参照图提示词】：roles.hasCase 时替换为 options.casePromptFragment ??
 *     autoCaseRefFragment（按活跃附图集生成的多图介绍）；
 *   - 【水钻参数提示词】：options.drillParams 存在时替换为 drillParams.promptFragment ??
 *     buildDrillSpecSection 自动段（order 供素材图交叉引用图号——附图序号单一真源）；
 *   - 【蓝图效果提示词】：options.blueprintPrompt 存在（调用侧已按任务上下文预解析）时替换。
 *
 * [1.2 n 元扩展] options.drillParams 存在 ⇒ 素材附图由 specs 物化派生（自定义形→附加
 * 素材附图，deriveMaterialAttachments 软上限 4 截断）；缺席时 roles.materials 显式通道
 * 生效；两者皆无 = 零素材附图。附图/图号声明等结构面不受占位符影响（纯净性对未放置
 * 占位符者保持——主图请求不因效果开启而变化）。
 */
export function composeDrillPrompt(
  templateBody: string,
  roles: DrillPromptImageRoles,
  options?: ComposeDrillPromptOptions,
): string {
  const drillParams = options?.drillParams
  const materials =
    drillParams !== undefined
      ? deriveMaterialAttachments(drillParams.specs).attached.map((m) => m.specCode)
      : (roles.materials ?? [])
  const order = orderDrillImages({ ...roles, materials })

  const substitution: EffectPromptSubstitution = {}
  if (roles.hasCase) {
    substitution.caseRef = { text: options?.casePromptFragment ?? autoCaseRefFragment({ ...roles, materials }) }
  }
  if (drillParams !== undefined) {
    substitution.drillParams = {
      text:
        drillParams.promptFragment ??
        buildDrillSpecSection({
          specs: drillParams.specs,
          ...(drillParams.physical !== undefined ? { physical: drillParams.physical } : {}),
          ...(options?.canvasWidthPx !== undefined ? { canvasWidthPx: options.canvasWidthPx } : {}),
          order,
        }),
    }
  }
  if (options?.blueprintPrompt !== undefined) {
    substitution.blueprint = { text: options.blueprintPrompt.text }
  }
  return substituteEffectPromptPlaceholders(templateBody, substitution)
}

// ---------------------------------------------------------------------------
// 内置案例（默认模板数据源）
// ---------------------------------------------------------------------------

/**
 * 内置案例素材源版本：任一 preset 的 srcImage/resImage 内容变更时必须 bump，
 * 否则素材库里已物化的合成图（meta 键含此版本）会被幂等复用、永远展示旧内容。
 * v2：new-orleans-* 与 savannah-* 两对文件内容互换修正（原文件名不符实）。
 */
export const PRESET_SOURCE_VERSION = 2

export const EFFECT_REF_PRESETS: EffectRefPreset[] = [
  {
    id: 'new-orleans',
    name: '城市分层·全要素',
    summary: '边框花环＋大字标题＋英雄主体＋骨架链＋点光的全要素分层公式，节日城市场景的完整路线。',
    prompt: '保持场景各层次的完整节日构图：边框花环（浆果逐颗一钻、花瓣闭合平色）＋大字标题实铺单色钻＋主体拆 2-4 个大色块；树枝、栏杆等线性结构走一钻宽骨架链；灯笼、亮窗等光源只贴发光部分。',
    sourceNote: '本仓样本 01（Christmas in 城市系列贴钻套装，印刷稿→贴钻成品对照）',
    srcImage: '/presets/new-orleans-src.jpg',
    resImage: '/presets/new-orleans-res.jpg',
  },
  {
    id: 'savannah',
    name: '城市分层·骨架主角',
    summary: '单一英雄主体＋一钻宽线性骨架链的减层路线，背景压成平面印刷、不加边饰。',
    prompt: '单一英雄主体承载全部视觉：主体拆成 2-3 个最大的闭合色块；周围细长结构（枝干、缆绳、栏杆）化为一钻宽骨架链引向主体；不加边框装饰与散点饰物，背景整体留印。',
    sourceNote: '本仓样本 02（Christmas in 城市系列贴钻套装，印刷稿→贴钻成品对照）',
    srcImage: '/presets/savannah-src.jpg',
    resImage: '/presets/savannah-res.jpg',
  },
  {
    id: 'boston',
    name: '城市分层·字光主角',
    summary: '超大标题字与发光体双主角：字实铺钻、光源只贴发光部、其余压成两色调剪影。',
    prompt: '以超大标题字与发光体为双主角：粗字形单色实铺钻（细衬线并入大形）；灯笼、亮窗、灯柱等只贴发光形体、舍弃灯具结构；其余景物压成两色调剪影留印，小号文字不贴。',
    sourceNote: '本仓样本 03（Christmas in 城市系列贴钻套装，印刷稿→贴钻成品对照）',
    srcImage: '/presets/boston-src.jpg',
    resImage: '/presets/boston-res.jpg',
  },
  {
    id: 'wreath-border',
    name: '花环边框·浆果环带',
    summary: '环形构图：浆果逐颗一钻、叶片闭合平色、蝴蝶结两大色块，环心与环外全部留印。',
    prompt: '环形构图：花环带由叶片（闭合平色＋金芯点）与浆果（逐颗一钻或 3-7 钻小簇）构成；环底蝴蝶结为两大纯色块；环心与环外全部留印，环带保持均匀的钻点节奏。',
    sourceNote:
      'Diamond Dotz Christmas Wreath 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/christmas-wreath-diamond-painting-kit',
    srcImage: '',
    resImage: '/presets/wreath-border-res.jpg',
  },
  {
    id: 'angel-dress',
    name: '人物主体·礼服大色块',
    summary: '单人物路线：礼服铺成两大色块、翼与光环作发光剪影、脸与皮肤留给印刷。',
    prompt: '单人物路线：礼服铺成主色块＋至多一层深褶暗色（仅两级，不做更细明暗）；翼与光环作单色发光剪影；脸部与皮肤留给印刷、绝不点钻；裙摆、束带沿线点缀零星单钻。',
    sourceNote:
      'Diamond Dotz Joy to the World 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/joy-to-the-world',
    srcImage: '/presets/angel-dress-src.jpg',
    resImage: '/presets/angel-dress-res.jpg',
  },
  {
    id: 'hummingbird-bloom',
    name: '动物主体·羽色分区',
    summary: '按羽毛天然分区贴钻、花朵逐瓣闭合成形、喙与花枝走一钻宽骨架链的花园路线。',
    prompt: '按羽毛天然分区（头、喉、胸、翅、尾）逐区贴成闭合色块，分区线即画面线条；花朵逐瓣闭合成形、花芯用对比色小簇；喙、花枝等细载体走一钻宽骨架链；柔和背景全留印。',
    sourceNote:
      'Diamond Dotz Hummingbird Shadow Box 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/hummingbird-shadow-box',
    srcImage: '/presets/hummingbird-bloom-src.jpg',
    resImage: '/presets/hummingbird-bloom-res.jpg',
  },
  {
    id: 'bear-plane',
    name: '英雄主体·细节点缀',
    summary: '大主体分件铺色，护目镜、横幅、小伙伴等趣味细节化作独立小钻簇，天空全留印。',
    prompt: '大主体拆 2-3 个大色块（机身、机翼、骑手）；护目镜、横幅、小伙伴等趣味细节化作彼此分离的 3-10 钻小簇；螺旋桨等运动件简化为深色剪影块；整片天空留印，主体成完整的贴钻岛。',
    sourceNote:
      'Diamond Dotz Aero Bear 产品页（partial coverage 圆钻套装）: https://www.diamonddotz.com/products/aero-bear-diamond-painting-kit',
    srcImage: '/presets/bear-plane-src.jpg',
    resImage: '/presets/bear-plane-res.jpg',
  },
  {
    id: 'greeting-card',
    name: '贺卡小件·强对比简形',
    summary: '小尺寸路线：4-6 个大简形＋最强对比用色，粗体祝词可单色铺钻、细字留印。',
    prompt: '小尺寸贺卡路线：中心母题由 4-6 个大简形构成，剪影优先、相邻形状强对比；粗体祝词可单色实铺钻、细字留印；背景平涂留印，至多散点少量单钻作框饰。',
    sourceNote:
      'Heartful Diamonds Diamond Painting Christmas Greeting Card Set 产品页: https://heartfuldiamonds.com/products/new-diamond-painting-christmas-greeting-card-set',
    srcImage: '',
    resImage: '/presets/greeting-card-res.jpg',
  },
]
