# 设计：落实 Scene Understanding 真链（Agent 循环架构）

## §0 Owner 架构定调（2026-09-28 原话+历史裁决——权威）

> 为什么转 Agent 模式而非 ComfyUI：1. Agent 对接原生支持视觉的模型；2. 模型自己看图分析主体、分析怎么拆图；3. 拆图任务交给 SAM3；4. 基于结果迭代。
> Agent 的好处：用户觉得裁图不好可以口头让 Agent 重新发起裁图。**MCP 需要提供 treeView，让 Agent 灵活组装 treeView，而不是硬编码程序生成**。Agent 第一轮拆出面部几个部分→用户说「面部当整体」→Agent 调 MCP 工具合并；用户说「帽子拆细点不同条纹不同效果」→Agent 调 MCP 工具继续拆分。**SAM3 对 Agent 就是 MCP 的一个工具函数**。

停止判据（2026-09-25 Owner 定调四条，contracts effectiveMm/labVariance 字段即为此设）：
1. 图层有效内容 ≈ 钻径量级（~5mm×5mm，钻 2-5mm）
2. 图层颜色容差已低（大范围同色——labVariance 阈值）
3. SAM3 自认不可拆（更佳）
4. 最大迭代硬顶

## §1 架构：Agent 循环（非固定管线）

```
用户上传图 + 口头指令
   ↓
Agent（真 VLM——经 model-route，原生视觉）
   ├─ 看图：主体/元素/层级归属/怎么拆（Scene Graph 语义）
   ├─ 调 studio.subject.segment（SAM3=工具函数）→ mask+bbox
   ├─ 组装/调整 treeView（MCP 工具，见 §2）
   ├─ 读 studio.tree.inspect（判据数据）→ 自评停止条件
   └─ 向用户汇报树结构（对话内呈现）
   ↕ 口头迭代（「面部当整体」/「帽子拆细」/「左手归小丑」）
   ↓ 满意/停止判据
Agent（真 LLM）调 studio.strategy.design → 指派表
   ↓
引擎执行 → gems/预览/导出
```

与现状的差异：S2/S6 从「一次性管线步骤」变为 **Agent 自主决策的工具调用**；树的组装权从程序（demo 硬编码/journey 循环）移到 Agent（经 MCP 工具）。

## §2 MCP 工具面扩展（treeView 组装——核心缺口）

现有：studio.scene.analyze / studio.subject.segment / studio.strategy.design。新增（复用 workbench 内核 CAS 写路径）：

| 工具 | 语义 | 内核复用 |
|---|---|---|
| studio.tree.inspect | 读当前树（节点+层级+mask 引用+**effectiveMm/labVariance 判据数据**+origin） | tree 读面 |
| studio.tree.merge | 合并节点（子→父吸收：mask 并集/bbox 并集/children 移交） | 新（树写面） |
| studio.tree.refine | 对指定节点再拆（限定该节点 mask 区域内调 SAM 多提示→子节点生成） | segment-loop 内核 |
| studio.tree.reparent | 重组归属（移动子树） | layer.reorder 内核 |
| studio.tree.rename | 重命名/标注（drillWorthy 等） | rename 内核 |

每次树写=版本链入史（既有 tree_versions 语义）——用户可在工作台回退 Agent 的任何组装操作。

## §3 真 VLM 落实（S2 live 化）

- prompt 升级 Scene Graph 层级语义（元素含 parent 归属建议+role+decomposable+importance——按 docs/scene-understanding §2.1）；输出 schema 同步。
- live 门开（SAM_ANALYZE_LIVE=1）；visionModel=LLM_VISION_MODEL env（z.ai 视觉模型）。
- key：LLM_API_KEY env（Owner 提供；不入库不入 git）。

## §4 密度语义修正（第六轮反馈 2）

densityPerCm2=绝对颗数密度：daemon 委派层换算=目标密度/(粒径密排密度 hex 相切 2/(√3·d²))。2.3 颗/cm²+2mm 钻≈8% 满铺（左手 5.9cm²→≈13 颗）。

## §5 mock 退役

demo 固定清单/journey 硬编码映射删除；mock 通道仅 test-only（显式命名）；验收数据=真链产物（VLM 层级树+SAM mask+LLM 策略+正确密度）。

## §6 验收门

- 全绿门；真链全跑（key 到位后）：VLM 层级清单→SAM→Agent 组装树→口头迭代演示（合并/拆细两指令）→策略→执行→新验收数据。
- MCP 工具面契约测试（merge/refine/reparent 的树变换+版本入史+CAS）。
- vision 判读+Codex 复核。

## §7 依赖

- Owner 提供 LLM_API_KEY（+视觉模型名）——代码侧零依赖。
- 视觉先行项（羽化/缩略双模式/蒙版开关退役/grid 控件）归 rework-layer-ps-panel 后续波（不阻塞本 change）。

## §8 Codex 意图裁定并入（2026-09-28 /tmp/codex-v6-intent.md）

- **S2 v2 关系格式**：elementId（稳定）/parentElementId（语义父，顶层 null）/relation（semantic|refinement）——S2→树构建器校验 parent 存在/无自指/无环/唯一语义父/根归属唯一，坏关系 typed reject；v1 平铺旧工件=显式兼容（legacy-flat 标记，不按名称猜 anatomy）。
- **「小丑·部分N」归宿三规则**：纯局部 refinement 无独立语义→归入 refinement 分支或直接更新父层有效掩膜；VLM 重入确认为语义部位→改名挂 semantic 子树；确需独立贴钻→明示 refinement 区域叶子（父组不产钻+兄弟不重叠）。
- **密度换算修正（按引擎实际晶格）**：pitchMm=diameterMm+0.4mm gap；baseDensityPerCm2=2/(√3·pitchCm²)（2mm 钻基准≈20.05 颗/cm²）；densityRatio=densityPerCm2/baseDensityPerCm2（2.3→11.5%）。texture-fill 直达与 fallback 同一绝对口径——fallback 只改形态不改目标密度；超容量=明确错误不静默 clamp；<24 颗可读下限→保持绝对密度的降级+提示。产物保留用户口径 densityPerCm2+诊断字段（densityRatio/baseDensityPerCm2）。
- **密度验收**：左手按 mask 有效面积 2.3→≈13 颗（误差门 max(2,20%)）；2.3→4.6 单调近倍增无满铺断点；改钻径/gap/ppm 后仍按 cm² 可预测。
- **无 key 纪律**：key 到位前只报告实现/测试门，不得把 mock 走查写成真链验收。
