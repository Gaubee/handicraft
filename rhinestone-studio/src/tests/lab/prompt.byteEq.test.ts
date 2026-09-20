/**
 * 契约回归基线：composeDrillPrompt 两参形态（templateBody, roles）输出**逐字节**冻结。
 *
 * 采样时点：2026-09-20，add-lab-drill-params-and-blueprint 0.2 改造**之前**的现网行为
 * （effectRefs.ts 旧实现直采）。本文件是 1.2「options.drillParams 注入后既有两参调用
 * 零变化」的字节等价断言基线——任何改动导致内联快照漂移即回归，须当场修复而非更新快照。
 *
 * 〔基线再生 2026-09-21，improve-lab-advanced-ux 点 3〕图号引用字面 v2：
 * `【图N：…】` → `【图N [image #N]：…】`（Owner 显式语义变更——附图显式编号 [image #N]；
 * figureTagOf 单一真源）。红线**性质保持**：三关全关 + 无占位符 = 本新基线逐字节稳定
 * （快照经 -u 一次性再生，此后任何漂移即回归）。
 *
 * 覆盖矩阵：case×{horizontal,vertical,single} × reference 有无 × 纯文生图（无附图）
 * × 模板体空/多行。
 */
import { describe, expect, it } from 'vitest'
import { composeDrillPrompt, describeDrillImageOrder, type DrillPromptImageRoles } from '$lib/presets/effectRefs'

describe('composeDrillPrompt 两参形态字节基线（0.2 改造前直采）', () => {
  it('case(horizontal) + reference + 模板体', () => {
    expect(
      composeDrillPrompt('模板特化正文', { hasCase: true, caseLayout: 'horizontal', hasReference: true }),
    ).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      我上传了2 张图片：
      1. 【图一 [image #1]：案例参照图】：案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。
      2. 【图二 [image #2]：参考图】：需要你处理的目标图像。

      【任务要求】：
      请参照【图一 [image #1]：案例参照图】所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为【图二 [image #2]：参考图】生成对应的 Partial Drill 效果图。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留【图二 [image #2]：参考图】的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在【图二 [image #2]：参考图】的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持【图二 [image #2]：参考图】的原有风格、构图与配色。

      【模板风格补充】：
      模板特化正文

      请输出【图二 [image #2]：参考图】应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('case(vertical) + reference', () => {
    expect(composeDrillPrompt('正文', { hasCase: true, caseLayout: 'vertical', hasReference: true })).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      我上传了2 张图片：
      1. 【图一 [image #1]：案例参照图】：案例参照合成图：上半为未贴钻的原图，下半为其 Partial Drill（局部贴钻）成品效果图。
      2. 【图二 [image #2]：参考图】：需要你处理的目标图像。

      【任务要求】：
      请参照【图一 [image #1]：案例参照图】所展示的「原图 → 贴钻效果」转换风格与选区逻辑，为【图二 [image #2]：参考图】生成对应的 Partial Drill 效果图。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留【图二 [image #2]：参考图】的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在【图二 [image #2]：参考图】的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持【图二 [image #2]：参考图】的原有风格、构图与配色。

      【模板风格补充】：
      正文

      请输出【图二 [image #2]：参考图】应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('case(single) + reference', () => {
    expect(composeDrillPrompt('正文', { hasCase: true, caseLayout: 'single', hasReference: true })).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      我上传了2 张图片：
      1. 【图一 [image #1]：案例参照图】：案例参照图：一张已完成的 Partial Drill（局部贴钻）效果图。
      2. 【图二 [image #2]：参考图】：需要你处理的目标图像。

      【任务要求】：
      请参考【图一 [image #1]：案例参照图】所展示的贴钻风格与选区逻辑，为【图二 [image #2]：参考图】生成对应的 Partial Drill 效果图。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留【图二 [image #2]：参考图】的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在【图二 [image #2]：参考图】的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持【图二 [image #2]：参考图】的原有风格、构图与配色。

      【模板风格补充】：
      正文

      请输出【图二 [image #2]：参考图】应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('case(horizontal) 无 reference', () => {
    expect(composeDrillPrompt('正文', { hasCase: true, caseLayout: 'horizontal', hasReference: false })).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      我上传了一张图片：
      1. 【图一 [image #1]：案例参照图】：案例参照合成图：左半为未贴钻的原图，右半为其 Partial Drill（局部贴钻）成品效果图。

      【任务要求】：
      请参考【图一 [image #1]：案例参照图】所展示的贴钻风格与选区逻辑，生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留画面的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在画面的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持画面的原有风格、构图与配色。

      【模板风格补充】：
      正文

      请输出应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('无 case + reference', () => {
    expect(composeDrillPrompt('正文', { hasCase: false, caseLayout: 'single', hasReference: true })).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      我上传了一张图片：
      1. 【图一 [image #1]：参考图】：需要你处理的目标图像。

      【任务要求】：
      请为【图一 [image #1]：参考图】生成 Partial Drill（局部贴钻）效果图，遵循以下贴钻指导规则。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留【图一 [image #1]：参考图】的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在【图一 [image #1]：参考图】的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持【图一 [image #1]：参考图】的原有风格、构图与配色。

      【模板风格补充】：
      正文

      请输出【图一 [image #1]：参考图】应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('无 case 无 reference（纯文生图——角色声明省略、任务行降级）', () => {
    expect(composeDrillPrompt('正文', { hasCase: false, caseLayout: 'single', hasReference: false })).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      【任务要求】：
      请生成一张 Partial Drill（局部贴钻）风格的完整设计效果图，遵循以下贴钻指导规则。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留画面的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在画面的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持画面的原有风格、构图与配色。

      【模板风格补充】：
      正文

      请输出应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('模板体为空（特化节约束）', () => {
    expect(composeDrillPrompt('', { hasCase: false, caseLayout: 'single', hasReference: true })).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      我上传了一张图片：
      1. 【图一 [image #1]：参考图】：需要你处理的目标图像。

      【任务要求】：
      请为【图一 [image #1]：参考图】生成 Partial Drill（局部贴钻）效果图，遵循以下贴钻指导规则。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留【图一 [image #1]：参考图】的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在【图一 [image #1]：参考图】的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持【图一 [image #1]：参考图】的原有风格、构图与配色。

      请输出【图一 [image #1]：参考图】应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('gemgenArchive 既有调用形态（\'p\' + 双无）', () => {
    expect(composeDrillPrompt('p', { hasCase: false, caseLayout: 'single', hasReference: false })).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      【任务要求】：
      请生成一张 Partial Drill（局部贴钻）风格的完整设计效果图，遵循以下贴钻指导规则。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留画面的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在画面的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持画面的原有风格、构图与配色。

      【模板风格补充】：
      p

      请输出应用局部贴钻后的最终渲染效果图。"
    `)
  })

  it('多行模板体原样保留（trim 边界）', () => {
    expect(
      composeDrillPrompt('  第一行\n第二行  ', { hasCase: true, caseLayout: 'vertical', hasReference: false }),
    ).toMatchInlineSnapshot(`
      "你是一位专业的钻石画（Diamond Painting / Partial Drill）与水钻装饰设计专家。

      我上传了一张图片：
      1. 【图一 [image #1]：案例参照图】：案例参照合成图：上半为未贴钻的原图，下半为其 Partial Drill（局部贴钻）成品效果图。

      【任务要求】：
      请参考【图一 [image #1]：案例参照图】所展示的贴钻风格与选区逻辑，生成一张同风格的 Partial Drill（局部贴钻）完整设计效果图。

      【贴钻指导规则】：
      1. 虚实结合（Partial Drill）：不要全图贴钻。保留画面的大面积背景与次要细节为原始画风/印刷效果。
      2. 选区策略：仅在画面的视觉焦点、核心主体（如：主体的轮廓线、羽毛/花瓣脉络、眼睛、高光区）上叠加水钻装饰。
      3. 材质与折射：贴钻区域需呈现明显的立体感、光线折射感和立体水钻（Rhinestones / Gemstones）的切面光泽。
      4. 画风一致性：未贴钻的背景区域需完全保持画面的原有风格、构图与配色。

      【模板风格补充】：
      第一行
      第二行

      请输出应用局部贴钻后的最终渲染效果图。"
    `)
  })
})

describe('describeDrillImageOrder 旧输入形状输出（UI 徽标消费面兼容）', () => {
  it('case+reference → 图一/图二；无 case → 参考图占图一', () => {
    const both: DrillPromptImageRoles = { hasCase: true, caseLayout: 'horizontal', hasReference: true }
    expect(describeDrillImageOrder(both)).toMatchInlineSnapshot(`
      [
        {
          "figure": "一",
          "figureLabel": "案例参照图",
          "ordinal": 1,
          "role": "case",
        },
        {
          "figure": "二",
          "figureLabel": "参考图",
          "ordinal": 2,
          "role": "reference",
        },
      ]
    `)
    const refOnly: DrillPromptImageRoles = { hasCase: false, caseLayout: 'single', hasReference: true }
    expect(describeDrillImageOrder(refOnly)).toMatchInlineSnapshot(`
      [
        {
          "figure": "一",
          "figureLabel": "参考图",
          "ordinal": 1,
          "role": "reference",
        },
      ]
    `)
    const none: DrillPromptImageRoles = { hasCase: false, caseLayout: 'single', hasReference: false }
    expect(describeDrillImageOrder(none)).toMatchInlineSnapshot(`[]`)
  })
})
