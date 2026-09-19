# 实验室高级选项与生图生命周期（lab-drill-params）Delta

## ADDED Requirements

### Requirement: 模板正交高级选项（水钻参数配置 + 蓝图效果）

提示词实验室 MUST 以两个**正交、独立启用**的模板级高级选项扩展基础形态（案例参照图+参考图+提示词），不存在「双模式」：`水钻参数配置（drillParams）`= 开关+可用钻清单（specKey 引用素材库 .gemshape/内置规格，含每钻尺寸与编号）+可选 `PhysicalCanvas` 尺寸声明；`蓝图效果（blueprint，beta）`= 开关+可选蓝图参考图（≤2）。两开关 MUST 持久化于 `.gemtpl` v2 正交键（`workflowMode` 字段概念退役），四象限组合（双关/仅钻参数/仅蓝图/双开）全部合法；关闭开关 MUST NOT 丢弃已填数据（`enabled` 标志语义）。

> [2026-09-20 Owner 重定义] 本条推翻专家稿 §C.1「双模式/workflowMode」框架（`.agents/documents/2026-09-19-expert-workbench-and-sizes/expert-workbench-and-sizes.md`）；gemgen provenance 同步以正交键替代 workflowMode（requestMode endpoint 语义保留）。schema 冻结宿主 = add-gem-catalog W0 §1.3 修订版。

#### Scenario: 按需启用（模板制作时）
- **WHEN** 用户在模板编辑器打开「水钻参数配置」，勾选 3 个规格并声明画幅 210×148mm 后保存，再打开「蓝图效果」并加 1 张蓝图参考图
- **THEN** .gemtpl v2 携带 drillParams（enabled=true、specs 3 项、physical）与 blueprint（enabled=true、refs 1 项）两正交键；刷新与双宿主（实验室/素材库 RightSheet）均如实回显
#### Scenario: 关灯不丢数据
- **WHEN** 用户关闭「水钻参数配置」开关后保存，再重新打开
- **THEN** 已填清单与画幅声明原样保留（键内 enabled=false），不因开关切换丢失
#### Scenario: v1 旧模板读入
- **WHEN** 打开 formatVersion 1 的 .gemtpl（无正交键）
- **THEN** 经 v1→v2 迁移读入后两开关均为关，全程无 v1 写入路径
#### Scenario: 清单校验
- **WHEN** drillParams.enabled=true 但清单为空，或清单含重复 specKey，或 blueprint 参考图超过 2 张
- **THEN** 序列化层以 typed error 拒写并给出字段路径；清单超过 8 条仅显示可读性警告不阻断

### Requirement: 提示词拼接服务（结构化注入）

高级选项开启后其结构化数据 MUST 由组装器纯函数**拼接到提示词**（总装骨架永不写入模板体）：drillParams 注入【尺寸与钻规格】段（画幅物理尺寸+比例锚（1mm≈px、钻径/画幅百分比，物理声明缺席时退化为相对比例）+编号清单）；自定义钻素材图 MUST 作为附加参考图随请求附送（附于案例/参考之后，每资产一条角色声明，软上限 4 超出截断并警告），内置形 MUST 仅描述注入不附图；附图序号与角色声明序号 MUST 恒一致（n 元扩展）。

#### Scenario: 双开注入
- **WHEN** drillParams（3 规格+画幅）与蓝图同时启用的任务发起主图请求
- **THEN** 主图提示词含【尺寸与钻规格】段（比例锚数值正确、清单 1..3 与模板数组序一致），自定义规格贴图按 [案例,参考,...素材] 顺序附送且提示词逐图声明；主图提示词不含任何蓝图要求（蓝图要求只进蓝图 stage 提示词）
#### Scenario: 物理声明缺席
- **WHEN** drillParams 启用但未声明画幅物理尺寸
- **THEN** 注入段省略画幅/px 锚行，改为按钻径之比表现相对大小，清单保留
#### Scenario: 基础形态零变化
- **WHEN** 两开关均关闭的任务发起请求
- **THEN** 提示词与请求附图与现状逐字节等价（回归护栏）

### Requirement: 生图生命周期（stage 树编排）

生图 MUST 从单次请求升级为有生命周期的编排：任务 = stage 树（恰一个主图 stage + 启用蓝图时一个蓝图 stage），stage 可依赖前序产物（串行策略 blueprint dependsOn main）；每个 stage MUST 独立持有 `requestId/status/assetId/error/retryCount`，父任务状态 MUST 为派生汇总（不落独立真源）；取消/重试 MUST 支持 stage 粒度（蓝图可单独取消/重试，主图重试 MUST 级联失效并重置蓝图 stage——成品图换代后旧蓝图必然失配）；并发预算 MUST 按请求数计（数值 4 不变，单 stage 任务行为与现状等价）。

#### Scenario: 蓝图失败不拖死主图
- **WHEN** 主图成功而蓝图请求失败
- **THEN** 父任务态为 success 并带「蓝图失败」徽标；蓝图 stage 可单独重试（从主图产物取输入，零重新生成主图），重试计入 retryCount 并生成新 requestId
#### Scenario: 主图重试级联
- **WHEN** 用户重试主图 stage
- **THEN** 主图重新请求，蓝图 stage 一并重置为待调度；旧蓝图产物不参与新归档
#### Scenario: 账本恢复
- **WHEN** 刷新后恢复任务账本
- **THEN** stage 状态随 PersistedTaskMeta 恢复；无 stages 的 legacy 旧账合成单主图 stage 只读兼容

### Requirement: 蓝图两策略（默认串行）

蓝图 stage MUST 支持两策略且**默认串行 B**：A 并行同生（一次 run 同时派发两请求，蓝图无成品图输入——随机性大，默认关闭、UI 明示）；B 串行依赖（主图成功后以 [成品图, 参考原图, ...钻石素材图, ...蓝图参考图] 发 `/images/edits`，提示词为施工蓝图转换任务：保留排布/轮廓/物理比例、平涂色、有钻清单时逐钻标号+图例、不增不删不移钻位）。策略 MUST 为任务级可选（发起面板，快照进任务与档案），模板只存开关不锁策略；无钻清单时蓝图要求 MUST 退化为无编号纯转换。

#### Scenario: 串行默认链
- **WHEN** 启用蓝图的任务以默认策略发起
- **THEN** 主图成功后自动派发蓝图 edit 请求，附图序与提示词声明一致；蓝图消费主图字节为输入
#### Scenario: 并行实验
- **WHEN** 用户在发起面板选择并行策略
- **THEN** 两请求同时派发，蓝图请求不含成品图，UI 标注「同生模式随机性大」
#### Scenario: 策略不入模板
- **WHEN** 保存启用蓝图的模板
- **THEN** .gemtpl 只记录开关与参考图，不含任何策略字段

### Requirement: 蓝图 Beta 标记与人审参照定位

蓝图效果 MUST 标记为 beta（UI 徽标 + 「可能不稳定、可能被其它工作流替代」声明）；蓝图 MUST 定位为**人审参照、非 BOM 数据源**：蓝图卡固定角标、`.gemgen` blueprint 键携带 typed 标记；BOM 一律由排钻设计/专家工作台引擎重算，机器级同排布（结构化布局输出+本地 renderer）显式超出本能力（另立 change）。

#### Scenario: beta 可见性
- **WHEN** 用户在模板编辑器或发起面板接触蓝图开关/策略
- **THEN** 恒见 Beta 徽标与不稳定声明 tooltip
#### Scenario: 非 BOM 声明
- **WHEN** 蓝图在画廊展开位或预览 Dialog 展示
- **THEN** 携带「人审参照 · 非 BOM 数据源」角标，且不存在任何以蓝图为 BOM 数据源的导出入口

### Requirement: 双图归档与部分失败语义

`.gemgen` v2 MUST 在主图键之外以可选 `blueprint` 键承载蓝图（成功时含图与 effectRequestId/blueprintRequestId 溯源）；归档条件 = 主图成功且（蓝图未启用或蓝图终态），双图一并定稿（档案不可变）；蓝图失败/取消时档案 MUST 落 `provenance.blueprint.status` 失败态而不含蓝图图；归档后蓝图重试 MUST 产新档（旧档保留）；蓝图提示词全文 MUST 随档案快照（审计链闭合）。

#### Scenario: 双图一并定稿
- **WHEN** 串行策略下主图与蓝图先后成功
- **THEN** 单个 .gemgen 含 image 与 blueprint 双键及双提示词全文快照、策略与清单（gemSpecs/physicalCanvas）溯源
#### Scenario: 部分失败归档
- **WHEN** 主图成功、蓝图失败且用户不再重试即归档
- **THEN** .gemgen 含主图与 provenance.blueprint.status=failed（含错误信息），无蓝图图；画廊展开位显示失败徽标
#### Scenario: 旧档兼容
- **WHEN** 画廊并集读入无 blueprint 键的旧 .gemgen
- **THEN** 按无蓝图态正常展示，无错误
