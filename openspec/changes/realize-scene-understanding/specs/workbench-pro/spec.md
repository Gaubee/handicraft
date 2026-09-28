## ADDED Requirements

### Requirement: S2 场景理解真 VLM 链（Owner 第六轮裁决）

场景分析 SHALL 经既有模型路由真实外呼多模态 VLM（live 门开；key 只走 env），产出层级 Scene Graph（元素含 parent/children 归属——docs/scene-understanding 方案语义）；树构建 SHALL 按 VLM 的 parent 关系组织（主体→部位）。固定清单 mock SHALL 退役为 test-only 桩。

#### Scenario: 层级产物

- **when** 上传含主体与部件的图片 → VLM 输出元素含层级归属（如「左手」parent=「小丑」）→ 树为解剖层级而非平铺
- **when** key 缺失 → typed 拒 live-disabled（不静默回落 mock）

### Requirement: S2 v2 显式关系格式（Codex B1 裁定 2026-09-28）

S2 scene-analysis SHALL 升 formatVersion 2：elements 携 elementId（同工件内唯一稳定 id）/parentElementId（语义父；顶层 null）/relation（semantic|refinement）。parent SHALL 为显式稳定语义引用，不得从名称或 bbox 包含关系事后猜测。S2→ObjectTree 构建器 SHALL 校验 parent 存在/无自指/无环/唯一语义父/根归属唯一——坏关系 typed reject（不静默按数组序挂载）。v1 平铺旧工件 SHALL 显式兼容（legacy-flat——全部挂画布，不按名称猜 anatomy）。SAM 细分子节点 SHALL 标注 origin/relation=refinement（「X·部分N」不冒充解剖部位——B2 归宿三规则）。

#### Scenario: v2 关系产物

- **when** VLM 输出结构化清单（左手 parentElementId=小丑）→ 树构建按拓扑序父先子后挂载，子掩码=父∩子（防外溢）
- **when** 元素关系坏（parent 缺失/自指/成环/格式混用）→ typed 拒 bad-relation
- **when** v1 平铺工件读回 → legacy-flat 全部顶层（显式兼容）
- **when** 语义父元素零实例 → 子元素上挂最近有实例祖先/顶层+warning（内容保全）

### Requirement: Agent 树组装 MCP 工具五件（design §2——Owner Agent 循环定调）

内核 SHALL 提供 studio.tree.inspect/merge/refine/reparent/rename 五工具（MCP 投影 mcp__studio__tree_*）：Agent 经工具组装/迭代 treeView（用户口头反馈=合并/拆细指令）。写工具 SHALL 复用 workbench 内核 CAS 写路径（expectedTreeBlobRef vs 帧流电流树——漂移必拒 cas-mismatch）；每次树写 SHALL 版本链入史（tree_versions cause 扩 tree-merge/tree-refine）。inspect SHALL 携停止判据数据（effectiveMm/labVariance）+relation+origin（判据四条：钻径量级~5mm/色容差低/SAM 自认不可拆/迭代硬顶）。

#### Scenario: 合并与拆细

- **when** 用户说「面部当整体」→ Agent 调 tree.merge（子→父吸收：mask 并集+bbox 并集+children 移交+判据重算；指派收敛 v5 组不产钻）
- **when** 用户说「帽子拆细点」→ Agent 调 tree.refine（限定节点 mask 区域内 SAM 多提示→refinement 子节点，每提示一步版本入史）
- **when** expectedTreeBlobRef 漂移 → cas-mismatch 必拒（零写入）
- **when** 根被吸收/吸收方向倒置成环 → typed 拒（root-protected/cycle）

### Requirement: 密度绝对颗数语义（第六轮反馈 2+Codex C2 公式修正版）

densityPerCm2 SHALL 为绝对颗数密度（颗/cm²——用户/策略层唯一口径）；引擎乘数 SHALL 按引擎实际晶格换算：baseDensityPerCm2=2/(√3·pitchCm²)（pitchMm=diameterMm+gapMm——GridSpec 含 gap 冻结语义），densityRatio=densityPerCm2/baseDensityPerCm2。超基准容量 SHALL typed 拒（禁止静默 clamp 到满铺）。texture-fill 直达/fallback hex/显式引擎路径 SHALL 消费同一绝对口径（fallback 只改形态不改目标密度）。产物 SHALL 保留用户口径 densityPerCm2+诊断字段（densityRatio/baseDensityPerCm2）。

#### Scenario: 密度换算

- **when** 5.9cm² 图层以 2.3 颗/cm² 指派 2mm 钻 → 产钻 ≈13 颗（误差门 max(2,20%)——非 71）
- **when** 2.3→4.6 → 颗数单调近倍增（无满铺断点）
- **when** 目标密度超钻径基准容量（如 2mm 钻 >≈20 颗/cm²）→ typed 拒 density-capacity-exceeded
