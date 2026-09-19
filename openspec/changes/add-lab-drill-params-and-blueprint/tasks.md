<!--
Orthogonal intents (max 5):
1. [2026-09-20 Owner 定调] 没有双模式：基础形态恒为 案例参照图+参考图+提示词；其上两个正交、
   独立启用、模板级的高级选项（drillParams / blueprint(beta)）；workflowMode 概念退役
   （requestMode 保留）；蓝图默认串行策略 B、人审参照非 BOM 数据源（design §0）。
2. [2026-09-20 DAG] 0.x（契约冻结，零实现）
       -> 1.x（轨 A 提示词拼接 service）/ 2.x（轨 B 生命周期调度算法）/ 3.x（轨 C 模板编辑器
          高级选项区骨架——依赖 0.1，选择器桩类型）     ← 三轨可并行（依赖仅本 change 0.x）
       -> 4.x（依赖轨：硬前置 = add-gem-catalog W0 + 其 §1.3 workflowMode→正交键修订版）
       -> 5.x（收尾：全量绿门 + Owner 试产回填 + 评审）
   约束：并行实现代理上限 2；全量 pnpm test/check/build 绿门串行执行；轨 A/B 产出为纯函数
   （不 import Svelte），轨 C 组件不持有编辑态副本（record 归 templates store）。
3. [2026-09-20 Data] 模板只存 specKey 引用（ordinal=数组序），run 时物化 GemSpecSnapshot[] 快照
   落任务与 gemgen（gemSpecs）；missing .gemshape = fail-fast typed error，禁静默降级。
4. [2026-09-20 Lifecycle] LabTask 升级 stage 子状态（各自 requestId/status/assetId/error/retryCount，
   父任务派生汇总不落独立真源）；取消/重试/归档 stage 粒度；并发预算按请求数（MAX_CONCURRENCY=4 不变）；
   刷新持久化 terminal-only（活动 stage 中断丢弃、重试新 requestId、恢复=终态快照+参数快照+materialAssetIds——R3 P0）；
   归档 = 自动双档（main success 即单图档、blueprint 终态即双图完整档、两档并存、补偿幂等），重试产新档。
5. [2026-09-20 Process] 不做：尺寸/钻形格式契约（add-gem-catalog W0）、专家工作台、图层化、
   画廊重构（4.5 已落，仅加任务卡蓝图最小子态）；每步绿门 pnpm test + svelte-check + build。
-->

## 0. 契约冻结（零实现；三并行轨与依赖轨的共同前置）

- [ ] 0.1 正交高级选项数据契约（单独提交）：`GemtplDrillParams{enabled,specs:specKey[],physical?}` / `GemtplBlueprint{enabled,refs?≤2}`（.gemtpl v2 正交键——schema 冻结宿主为 add-gem-catalog W0 §1.3 修订版，本切片冻结消费侧类型与 validation：enabled⇒specs≥1、specKey 去重、physical 正数、refs≤2；enabled 标志保留=关灯不丢数据）；任务侧快照 `LabTaskDrillParams{specs:GemSpecSnapshot[],physical?,materialAssetIds}` / `LabTaskBlueprint{strategy,refs}`；workflowMode 退役迁移口径（gemtpl/gemgen v1 两键缺席=关、旧 mode→requestMode 只读映射）；vitest：类型编译 + validation 边界用例
- [ ] 0.2 组装器契约冻结：`composeDrillPrompt(templateBody, roles, {drillParams?})` 扩展签名 + `composeBlueprintPrompt` 新签名 + 附图角色模型 1..n（case/reference/material/blueprint-ref/effect；describeDrillImageOrder n 元化，中文数字至十）；【尺寸与钻规格】注入段文本骨架 + 段序（…模板体→注入段→输出行）+ 素材注入策略（内置形=描述、自定义=附加参考图、附图序 [案例,参考,...素材]、软上限 4）+ 两策略蓝图 prompt 骨架（design §2.2-2.4 逐字为准）；vitest：骨架快照测试（冻结后任何改动须 bump 注释）
- [ ] 0.3 生命周期与蓝图契约冻结：`LabStage{id,kind:'main'|'blueprint',status,dependsOn,requestId,assetId,imageUrl,imageStored,error,debug,retryCount,时间戳}` + `StageEvent`/`reduceStages`/`deriveTaskStatus`/`schedulableStages` 签名（design §3.2）；父任务派生表逐行冻结（design §3.3）；操作粒度（cancelTask/cancelStage/retryStage/retryTask+级联失效 invalidate）；**刷新持久化策略冻结（design §3.3——R3 P0：terminal-only 账本 / 活动 stage 中断丢弃不落账本 / 重试新 requestId / 恢复 = 终态快照+drillParams·blueprint 快照+materialAssetIds / 配额降级不丢终态快照）**；归档时点与部分失败语义（**自动双档：main success 即单图档、blueprint 终态即双图完整档、两档并存、stage 终态自动触发不等用户动作**；provenance.blueprint.status；skipped 投影压缩 cancelled+错误码；重试产新档）；gemgen v2 消费口径（blueprint 键 + provenance.requestMode/gemSpecs/physicalCanvas/blueprint 快照 + blueprintPrompt 全文快照落 provenance）；vitest：契约类型编译 + 派生表枚举断言
- [ ] 0.4 契约 receipt：① TypeScript 编译；② grep 证明——新代码无 `workflowMode` 写路径、`specId` 身份字段清零（沿 add-gem-catalog W0 禁令，refSpecId 除外）；③ 0.1-0.3 的 vitest 全绿；④ 跨 change 同步核对——**已验证通过（2026-09-20，gem-catalog 8e172d2）：add-gem-catalog design §1.3 已按正交键修订**（.gemtpl/.gemgen 无 workflowMode 键，R3 评审基线实测）；4.x 按 DAG 开工，轨道 A/B/C 不受影响〔R3 非阻塞 3：CLOSED〕

## 1. 并行轨 A：提示词拼接 service（不依赖 W0/UI；纯函数）

- [ ] 1.1 service 落地（落点 `src/lib/lab/prompt/` 或 effectRefs 同族扩展，实现定）：结构化数据→提示词片段的纯函数族——【尺寸与钻规格】段生成（physical 比例锚：1mm≈px 与钻径/画幅百分比；缺席退化为相对比例行）、清单行生成（ordinal+规格码+形状+尺寸+素材图交叉引用）、素材附图清单派生（自定义规格→assetId 去重≤4 截断+警告信号返回）；vitest：注入矩阵（drillParams×physical×roles）+ 比例锚数值 + 截断/警告
- [ ] 1.2 `composeDrillPrompt` 扩展接线：roles n 元化 + options.drillParams 注入（段序冻结位）；附图声明生成器与请求 images 数组同源派生（附图序号=角色声明序号不变量）；vitest：n 元序号连续性 + 既有两参调用零变化（回归：现网 prompt 字节等价——drillParams 缺席时输出与旧 composeDrillPrompt 逐字节相等）
- [ ] 1.3 `composeBlueprintPrompt` 实现：策略 B 转换骨架（成品图输入+图例+不增不删不移）与策略 A 同生骨架（无成品图）+ 无钻清单退化（省略编号图例节）；vitest：两策略骨架差异快照 + hasLegend 矩阵 + 旧档重建口径（composedPromptOf 蓝图侧推断）

## 2. 并行轨 B：生命周期调度算法与测试（不依赖 UI/W0；纯函数）

- [ ] 2.1 stage 状态机纯函数：`reduceStages`（dispatch/succeed/fail/cancel/retry/invalidate 六事件）+ `deriveTaskStatus`（design §3.3 派生表）+ `schedulableStages`（dependsOn 全 success 判定 + 并发预算 max-runningCount）；vitest：reduce 全事件×串行/并行两树矩阵 + 派生表逐行 + 依赖不满足不派发
- [ ] 2.2 级联与失效语义：main retry → blueprint invalidate→pending（成品图换代失配）；main error/cancel → blueprint skipped/cancelled；blueprint 单独 retry 不动 main；vitest：失效级联矩阵 + retryCount 递增（新 requestId）
- [ ] 2.3 持久化合成：`PersistedTaskMeta.stages` 序列化/反序列化（**terminal-only——pending/running 不落账本**）+ legacy 账本（无 stages）读时合成单 main stage 只读兼容；vitest：round-trip + legacy 合成 + 配额降级（剥 debug 时终态 stage 快照与 drillParams/blueprint/materialAssetIds 保全）+ **刷新 fixture（R3 P0）**：main pending/running 刷新（活动 stage 丢弃不落账本）、main success+blueprint running 刷新（终态恢复 +「蓝图已中断，可重试」派生态）、失败后重试（新 requestId 不复用）、保存/恢复边界（requestId/assetId/参数快照）

## 3. 并行轨 C：模板编辑器高级选项区组件（依赖 0.1；W0 类型后接选择器）

- [ ] 3.1 高级选项区组件骨架：双开关（水钻参数配置 / 蓝图效果+Beta 徽标+不稳定声明 tooltip）+ 开启后展开表单（钻清单行骨架、画幅物理尺寸可选声明、蓝图参考图槽 ≤2）；桩类型（本地 interface，W0 落地后换 import）；提交=字段提交自动换绑（onchange/blur）；vitest：开关态持久（enabled=false 数据保留）+ 双宿主（手风琴/RightSheet）同 record 互见
- [ ] 3.2 发起面板最小面：run 级蓝图策略单选（默认串行 B；仅当启用蓝图的模板在列时显示）+ 高级选项汇总 chips（只读）；lab-session form 扩展 blueprintStrategy；vitest：策略快照进任务 + 无蓝图模板时选择器不出现
- [ ] 3.3 任务卡蓝图最小子态（展示骨架，数据源接 4.4）：展开位蓝图缩略位 +「人审参照 · 非 BOM 数据源」角标 + 失败/重试中徽标 + 单独重试/取消动作行；收起卡不动；vitest：四态渲染（成功/失败/重试中/旧档无 blueprint）

## 4. 依赖轨（硬前置 = add-gem-catalog W0 + §1.3 修订版；0.4-④ 核对通过后开工）

- [ ] 4.1 labFile v2 正交键接线：gemtpl/gemgen 消费 v2 类型（drillParams/blueprint/gemSpecs/physicalCanvas/provenance.requestMode+blueprint 快照+blueprintPrompt）；v1→v2 迁移语义落位（迁移入口 W0 已冻结：两键缺席=关、旧 mode→requestMode）；vitest：round-trip 字节等价 + v1 fixture 迁移 + 脏输入 typed error（重复 specKey/enabled 空清单/refs>2）
- [ ] 4.2 templates store 与选择器：TemplateRecord + drillParams/blueprint 字段与提交白名单扩展（templates.svelte.ts:62-67,256-278 消费面）；规格选择器真接线（W0 GemSpec 目录枚举 + sys-shapes 资产解析 + AssetPickerHost 蓝图参考图选择）；missing specKey 编辑器警告角标；vitest：字段提交/missing 警告/选择器去重上限（>8 警告不阻断）
- [ ] 4.3 lab store 任务模型 stage 化：LabTask.stages + 快照物化（startRun：specKey→GemSpecSnapshot 解析、missing fail-fast 中文错误、materialAssetIds 派生）；pump/runTask 按 stage 重构（controllers 键 stageId、并发预算按请求数、main 单 stage 时行为=现状回归）；cancelTask/cancelStage/retryStage/retryTask 级联（消费 2.1/2.2 纯函数）；PersistedTaskMeta 接线（消费 2.3）；vitest：startRun 快照/missing 阻断/单 stage 等价回归/操作粒度端到端（jsdom 桩 client）
- [ ] 4.4 蓝图两策略与归档：策略 B 串行依赖（main success→edits 附图 [成品,原图,...素材,...蓝图参考] + composeBlueprintPrompt）+ 策略 A 并行派发；归档升级（archiveGeneratedResult：**自动双档——main success 即单图档、blueprint 终态即双图完整档、两档并存（R3 P0）**、blueprint 键+provenance 四态、补偿链 blueprint 字节回取、蓝图重试产新档（中断/失败同路径，从 main.assetId 归档字节取输入））；任务卡数据源接线（消费 3.3，含「蓝图已中断，可重试」态）；vitest：策略 B 附图序端到端/策略 A 并发/蓝图单独重试/**双档并存（单图先行档+双图档 createdAt 降序）**/自动归档触发（stage 终态即档无用户动作依赖）/reconcileUnarchivedResults 幂等（不重复归档）/重试 requestId 不复用/归档四态+missing custom asset 阻断
- [ ] 4.5 端到端冒烟：BYOK 真实生图（策略 B 全链：模板启用双选项→发起→双图→归档→画廊展开位→送排钻 handoff 零变形）；浏览器走查 design §6 线框动线；Owner 试产 3-5 批错误率回填 design §8-3/§8-5

## 5. 收尾

- [ ] 5.1 全量绿门：`pnpm test`/`pnpm check`/`pnpm build` 全绿 + 兄弟套件（openIntentFlow/galleryUnion/gemgenArchive）零回归 + grep 收尾（无 workflowMode 残留写入、旧两参 composeDrillPrompt 兼容注释登记）
- [ ] 5.2 Codex 评审 → 修订 → 归档候选；归档前 spec 同步：prompt-lab spec 增补高级选项与生命周期条款（specs/lab-drill-params/spec.md delta 为准）、登记对专家稿 §C / gemspec R1 议题 9 workflowMode 半边的推翻注记
