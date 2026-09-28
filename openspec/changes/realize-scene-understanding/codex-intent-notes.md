# 项目架构记录

## Owner 第六轮验收反馈（2026-09-28）

- `rework-layer-ps-panel` v5 已冻结“只有叶子节点产钻，组不产钻”；其 S2 `SceneElement` 仍是平铺元素，不能把当前 parent/children 结构校验等同于主体到部位的语义建模。
- 层级 Scene Graph、Agent 可迭代组装 treeView、`densityPerCm2` 绝对语义归入现有 `openspec/changes/realize-scene-understanding/` 草案；避免重复新建同范围 change。SAM 细分产生的临时节点须保留来源，并能经 tree inspect/rename/reparent/merge 整理，不以“部分 N”代替语义归属。
- 引擎 `density` 是相对晶格密度。daemon adapter 的基准必须使用实际 `GridSpec.pitchMm`（包含 gap），不能固定除以 2.3，也不能只按钻径相切密排容量换算。
- `realize-scene-understanding` 的真 VLM/S6 外呼验收依赖 Owner 配置有效 `LLM_API_KEY` 与视觉模型名；mock 走查不得记作真链验收。
- 羽化与半像素对齐、图层缩略 `trim/ps` 双模式、图层栏退役“蒙版”开关、画布浮动控件单一 grid 编排归 `rework-layer-ps-panel` 后续表现波；不改变 v5 的叶子产钻语义。
- 本轮完整意图与验收裁定见 `/tmp/codex-v6-intent.md`；实现状态仍以 OpenSpec change、源码和实跑证据为准。
