/**
 * 模板级「案例图」内置案例（真实来源）+ 生成提示词组装器。
 * [2026-09-19 融合] 模板（原「提示词变体」，[Owner] 改名）与案例一一绑定：
 * 本文件同时是默认模板集合的数据源（见 lab.svelte.ts defaultVariants），
 * preset kind 语义 =「内置案例图」（静态路径直引），无库选择交互。
 *
 * 正交意图：
 * 1. [2026-09-19][Owner 模板重构 + 参照对退役] 提示词 = 组装器拼装：图片角色声明（按实际附图动态编号，
 *    顺序与请求 images 一致：[案例参照图（合成）, 参考图]）+ 任务要求 + 通用贴钻指导规则
 *    （Owner 2026-09-19 提供的四条原文）+ 模板特化体（本文件 prompt 字段，只写选区/风格侧重）。
 *    旧「全钻数字油画中间稿」英文规则（蜡版分色/纯白底）整体废弃——与局部贴钻目标相悖，
 *    且未向模型声明附图角色导致案例图与参考图被混合（Owner 实测反馈）。
 *    [Owner 2026-09-19 裁决] 案例侧只附一张合成参照图（布局模板在图上标注「原图」「效果图」角标），
 *    角色描述按布局（horizontal/vertical/single）说明两半含义，模型不再混图。
 * 2. 每条 prompt = 该案例路线的中文特化建议，彼此差异化；通用规则一律不重复写入模板体。
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
// 生成提示词组装器（[Owner 2026-09-19 模板]，公共骨架原文冻结）
// ---------------------------------------------------------------------------

/**
 * 附图角色（与请求 images 数组顺序一一对应：案例参照图 → 参考图）。
 * [Owner 2026-09-19 参照对退役] 案例侧只有**一张**合成参照图（caseLayout 描述两半含义），
 * 不再有「案例原图 / 案例效果图」两个独立条目。
 */
export interface DrillPromptImageRoles {
  hasCase: boolean
  /** 案例参照图布局：合成横/纵（两半=原图+效果图）或 single（单张效果图）。 */
  caseLayout: CaseRefLayout
  hasReference: boolean
}

export type DrillImageRole = 'case' | 'reference'

export interface OrderedDrillImage {
  /** 请求中的位置（1 起）——与提示词【图一/图二】编号一致 */
  ordinal: 1 | 2
  /** 中文数字（提示词用） */
  figure: '一' | '二'
  /** 提示词角色名，如「案例参照图」 */
  figureLabel: string
  role: DrillImageRole
}

const FIGURES = ['一', '二'] as const

/**
 * 附图序号单一真源：composeDrillPrompt 与实验室 UI 的「图一/二」徽标共用此函数，
 * 界面标注与提示词编号永不漂移（Owner 2026-09-19：用户须能区分 image 1|2）。
 */
export function describeDrillImageOrder(roles: DrillPromptImageRoles): OrderedDrillImage[] {
  const out: OrderedDrillImage[] = []
  const push = (role: DrillImageRole, figureLabel: string): void => {
    const index = out.length as 0 | 1
    out.push({ ordinal: (index + 1) as 1 | 2, figure: FIGURES[index], figureLabel, role })
  }
  if (roles.hasCase) push('case', '案例参照图')
  if (roles.hasReference) push('reference', '参考图')
  return out
}

/** 通用贴钻指导规则（Owner 原文；{ref} = 参考图的角色占位，如【图二：参考图】）。 */
const DRILL_RULES = [
  '1. 虚实结合（Partial Drill）：不要全图贴钻。保留{ref}的大面积背景与次要细节为原始画风/印刷效果。',
  '2. 选区策略：仅在{ref}的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。',
  '3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。',
  '4. 画风一致性：未贴钻的背景区域需完全保持{ref}的原有风格、构图与配色。',
].join('\n')

/** 案例参照图的角色描述：按布局说明两半（或单张）的含义。 */
const CASE_DESC: Record<CaseRefLayout, string> = {
  horizontal: '案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。',
  vertical: '案例参照合成图：上半为未贴钻的原图，下半为其 Partial Drill（局部贴钻）成品效果图。',
  single: '案例参照图：一张已完成的 Partial Drill（局部贴钻）效果图。',
}

/**
 * 拼装完整生成指令：角色声明（动态编号，仅列实际附图）→ 任务要求 → 通用贴钻规则
 * → 模板特化体 → 输出要求。模板体为空时省略特化节；无任何附图（纯文生图）时
 * 角色声明省略、任务行降级为无图表述。
 */
export function composeDrillPrompt(templateBody: string, roles: DrillPromptImageRoles): string {
  const order = describeDrillImageOrder(roles)
  const descOf = (role: DrillImageRole): string =>
    role === 'case' ? CASE_DESC[roles.caseLayout] : '需要你处理的目标图像。'
  const entries = order.map((e) => ({ ...e, desc: descOf(e.role) }))

  const figureOf = (label: string): string | null => {
    const hit = order.find((e) => e.figureLabel === label)
    return hit ? `【图${hit.figure}：${label}】` : null
  }
  const refLabel = figureOf('参考图')
  const countText = order.length === 0 ? '' : `我上传了${order.length === 1 ? '一张图片' : `${order.length} 张图片`}：\n`

  const roleBlock =
    countText +
    entries.map((e) => `${e.ordinal}. 【图${e.figure}：${e.figureLabel}】：${e.desc}`).join('\n')

  const caseLabel = figureOf('案例参照图')
  const composite = roles.caseLayout === 'horizontal' || roles.caseLayout === 'vertical'
  let taskLine: string
  if (caseLabel && composite && refLabel) {
    taskLine = `请参照${caseLabel}所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为${refLabel}生成对应的 Partial Drill 效果图。`
  } else if (caseLabel && refLabel) {
    taskLine = `请参考${caseLabel}所展示的贴钻风格与选区逻辑，为${refLabel}生成对应的 Partial Drill 效果图。`
  } else if (caseLabel) {
    taskLine = `请参考${caseLabel}所展示的贴钻风格与选区逻辑，生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图。`
  } else if (refLabel) {
    taskLine = `请为${refLabel}生成 Partial Drill（局部贴钻）效果图，遵循以下贴钻指导规则。`
  } else {
    taskLine = '请生成一张 Partial Drill（局部贴钻）风格的完整设计效果图，遵循以下贴钻指导规则。'
  }

  const rulesBlock = `【贴钻指导规则】：\n${DRILL_RULES.replaceAll('{ref}', refLabel ?? '画面')}`
  const templateBlock = templateBody.trim() ? `【模板风格补充】：\n${templateBody.trim()}` : ''
  const outputLine = `请输出${refLabel ? refLabel : ''}应用局部贴钻后的最终渲染效果图。`

  return [
    '你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。',
    roleBlock,
    `【任务要求】：\n${taskLine}`,
    rulesBlock,
    templateBlock,
    outputLine,
  ]
    .filter((block) => block !== '')
    .join('\n\n')
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
