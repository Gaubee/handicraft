# 实验室高级选项（水钻参数 + 蓝图）与生图生命周期（add-lab-drill-params-and-blueprint）

## Why

- **Owner 2026-09-20 重新定调（原话，推翻此前「双模式」框架）**：「3.1 提示词实验室双模式并不是真正意义上的『双模式』，而是一种『结构化编辑提示词』的能力：目的是将钻石素材、尺寸信息等数据信息引入……是在 案例参照图+参考图（原图）+提示词（包含对案例图和原图的一些描述和要求） 的基础上，增加了 钻石素材图和尺寸信息，这些信息也都是要拼接到提示词里面去的。所以在前端看来，只是提供了一个『高级选项』，打开这个开关，填充必要信息就可以了。3.2 同理，蓝图效果也只是一个『高级选项』……不论是『蓝图效果』还是『水钻参数配置』，都是正交的可以独立启用的……在底层，你需要做的是实现生图功能的生命周期，在此基础上去实现蓝图效果」（全文见 design §0.1）。
- 源码现状：实验室任务模型是**单次请求无生命周期**——`LabTask` 单 `status`/单 `assetId`/单 `error`（`rhinestone-studio/src/lib/stores/lab.svelte.ts:100-140`），`runTask` 一次组包一次请求（`lab.svelte.ts:989-1124`），`pump` 按任务粒度调度（`lab.svelte.ts:958-968`），取消/重试均为任务粒度（`lab.svelte.ts:1193-1240`）——蓝图这类「依赖前序产物的第二请求」在现模型上不可表达。
- 提示词组装器只有两参形态 `composeDrillPrompt(templateBody, roles)`、附图角色仅 案例/参考 两类且序号锁死 1|2（`rhinestone-studio/src/lib/presets/effectRefs.ts:51-56,70-85,107-153`）——钻石素材图/尺寸信息/蓝图要求没有任何注入通道。
- 模板格式无高级选项承载：`GemtplFile` 只有 promptBody/caseBinding/candidates/provenance 四面（`rhinestone-studio/src/lib/persistence/labFile.ts:159-180`）；生成档案 `GemgenFile` 只有单 `image` 键（`labFile.ts:190-225`）。
- 既有设计稿的「双模式/workflowMode」框架（`.agents/documents/2026-09-19-expert-workbench-and-sizes/expert-workbench-and-sizes.md` §C；gemspec R1 议题 9/P0-7；add-gem-catalog design §1.3 gemtpl/gemgen v2 行）已被 Owner 2026-09-20 推翻，须按正交高级选项口径重写（`workflowMode` 字段概念退役；`requestMode` endpoint 语义保留）。

## What Changes

- **核心重构定调**：没有「双模式」。实验室基础形态恒为 案例参照图+参考图+提示词；其上是两个**正交、独立启用、模板级持久化**的高级选项：
  - **水钻参数配置（drillParams）**：开关 + 可用钻清单（引用素材库 `.gemshape`/内置规格，每钻尺寸与编号）+ 可选尺寸信息（`PhysicalCanvas` 结构化声明，可选）；开启后这些数据**拼接到提示词**——自定义钻素材图作为附加参考图（附图角色扩展），内置形走描述注入（拼接策略在 design §2 冻结）。
  - **蓝图效果（blueprint，beta）**：开关 + beta 标记（UI 徽标 + 文档声明「可能不稳定、可能被其它工作流替代」）；开启后追加蓝图提示词要求 + 可追加蓝图参考图。
  - 两开关落在 `.gemtpl` v2 正交键上（制作模板时按需启用）；`workflowMode` 概念退役，`.gemgen` v2 provenance 同步改为正交快照键（跨 change 修订：add-gem-catalog design §1.3 由主会话同步修订，本 change 以修订后口径为准）。
- **生图生命周期（底层能力，先行切片）**：生图从「单次请求」升级为 stage 树编排——主图 stage → 可选蓝图 stage，stage 可依赖前序产物，支持串行依赖生成；`LabTask` 升级为 stage 子状态（各自 `requestId/status/assetId/error/retryCount`，父任务状态 = 派生汇总不落独立真源——沿 gemspec R1 议题 8/P0-3 方向）；取消/重试/归档按 stage 粒度；调度器细化为 stage 级并发预算。
- **蓝图两策略**：A 并行同生（一次 run 同时发两请求——随机性大，默认关闭）；B 串行依赖（先生成成品图，再以 成品图+原图+钻石素材图+提示词追加+蓝图参考图 发 `/images/edits` 生成蓝图——**默认策略**）；策略为任务级可选（发起面板），模板只存开关不锁策略。蓝图定位 = **人审参照、非 BOM 数据源**（已生效工作默认；机器级同排布另立 change）。
- **并行轨道三线**（Owner 2026-09-20 裁决「同2…组件化开发、service 开发、算法研发和测试」）：提示词拼接 service（结构化数据→提示词片段纯函数，可先行 mock 测试）、生图生命周期调度算法与测试（stage 状态机纯函数，不依赖 UI）、模板编辑器高级选项区组件（开关+表单骨架；规格选择器等 add-gem-catalog W0 类型落地后接线）。
- **不做（显式边界）**：尺寸/钻形格式契约与 `.gemshape` schema（add-gem-catalog W0 已有）、专家工作台（rename-and-expert-workbench）、图层化（studio-layers）、画廊重构（add-project-files 4.5 已落——本 change 仅加任务卡蓝图最小子态）。

## Impact

- 新建：提示词拼接 service（`src/lib/lab/` 下新模块或 effectRefs 扩展——落点由实现切片定，签名以本 change 契约冻结为准）、stage 状态机纯函数模块（调度算法，UI 无关）。
- 扩展：`presets/effectRefs.ts`（组装器签名扩展 + 附图角色模型 1..n）、`stores/templates.svelte.ts`（TemplateRecord + drillParams/blueprint 字段与提交白名单）、`stores/lab.svelte.ts`（LabTask→stages、pump/runTask stage 化、startRun 快照、取消/重试粒度）、`persistence/taskStore.ts`（PersistedTaskMeta stage 持久化 + legacy 合成迁移）、`persistence/labFile.ts`（消费 v2 正交键——schema 冻结归 add-gem-catalog W0 §1.3 修订版）、TemplateEditor（高级选项区组件，双宿主）、实验室发起面板（策略选择）、任务卡（蓝图子态）。
- 格式影响：`.gemtpl`/`.gemgen` v2 正交键（drillParams/blueprint/gemSpecs/physicalCanvas/provenance.requestMode）；v1 旧档迁移只读兼容（两键缺席 = 两开关关；旧 `mode`→`requestMode` 映射）。
- 依赖关系：并行轨 A/B/C 只依赖本 change 0.x 契约（可立即启动，并行代理上限 2）；依赖轨 4.x 硬前置 = add-gem-catalog W0（canonical 类型 + 四格式 v2 版本表）**及其 §1.3 workflowMode→正交键修订**（主会话执行）；蓝图实证（Owner 试产 3-5 批）归收尾前回填。
