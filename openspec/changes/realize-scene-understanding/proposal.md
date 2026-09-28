# 提案：落实 Scene Understanding 真链（VLM+Scene Graph——Owner 第六轮裁决）

## Why

Owner 裁决（2026-09-28 原话）：「不要去做 mock 了，直接落实 VLM。我需要产品级的可落地的产出。」

事实盘点（如实）：
- 最初方案（docs/scene-understanding-验证与架构评估.md，2026-09-23）早已定调：Image → **Scene Graph**（Elements 含 id/category/role/mask/**parent/children**/decomposable/importance）→ 贴钻策略 → 几何引擎；Scene Graph 生成用强 VLM **经既有模型路由**（z.ai 网关+openai-completions+LLM_API_KEY env——Owner 2026-09-23 裁决）。
- 现实偏差：S2 场景分析一直用**固定清单 mock**（demo 脚本硬编码 12 部位+平铺无层级）；S6 策略设计同为 mock 脚本代演。骨架（SceneAnalyzer live 门+model-route+fetch 外呼+schema 校验）已在，但从未真跑。
- key 现状：.env LLM_API_KEY 空、credentials ZAI_API_KEY=mock——**开发环境从未有真 key**（外呼 401 实证）。
- Owner 第六轮反馈五点中「树结构平铺怪」「密度 2.3 语义错位」的根因均在此：树的骨架是手写平铺数组非 VLM 层级产物；demo 的密度-颗数链未按绝对密度换算。

## What Changes

1. **S2 真 VLM（Scene Graph 语义）**：prompt 从平铺 elements 升级为层级 Scene Graph（parent/children 归属+role+decomposable 判据——按最初方案）；输出 schema 同步；树构建按 VLM 的 parent 挂层级（主体→部位）。live 门开（SAM_ANALYZE_LIVE=1）。
2. **S6 真 LLM**：策略设计 live 化（同路由真外呼；纹理优先决策树 prompt 已在）。
3. **密度语义修正**：densityPerCm2=绝对颗数密度——daemon 换算层改为「目标颗数密度/粒径密排密度」的引擎乘数（2.3 颗/cm²+2mm 钻≈8% 满铺），契约注释冻结语义；demo 断言同步（左手应≈13 颗非 71）。
4. **mock 全面退役**：demo/演示数据全部换真管线产物（VLM 层级清单+SAM 真分割+LLM 真策略）；mock 通道仅保留为测试桩（命名显式 test-only）。
5. **key 注入面**：LLM_API_KEY（+LLM_VISION_MODEL 指向视觉模型）由 Owner 提供 env 值——代码侧零依赖（配置面已在），key 到位即可全链真跑。

## Impact
- daemon：scene-analyze prompt/schema+树构建层级化+密度换算+strategy-design live。
- studio：无破坏（消费面不变）；demo 脚本换真链参数。
- 不动：engine/（密度换算在 daemon 委派层）；canvaskit/undo/契约既有面。
