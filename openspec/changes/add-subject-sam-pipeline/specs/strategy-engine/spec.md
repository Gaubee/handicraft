# strategy-engine Specification（delta）

## ADDED Requirements

### Requirement: 七族策略注册表

贴钻策略 SHALL 以统一注册表承载七族（texture-fill/soft-curve/flower/straight-line/geometry/exclusion/free-code），契约冻结为 `apply(node+block 投影, params, canvas) → StrategyResult{gems, warnings, excludedRegions?, engineStrategy?}`；分发入口 SHALL 对 kind 先行 schema 校验（LLM 输出边界）再路由实现位，未实现槽 SHALL fail-fast 抛 typed error 而非静默空产；策略上下文 SHALL 注入确定性 PRNG 工厂（mulberry32——同 seed 同果）、几何帮助库（单源）、gemDiameterPx 与缺省密度 2.3/cm²；引擎既有五策略（hex-thin/hex-pitch/poisson/hybrid/cvt）SHALL 降为基础几何族成员经 engineStrategy 声明式委派（指派显式指定或几何族可读下限不足降级），strategies 子树 SHALL NOT import 引擎函数（包边界红线——引擎消费一律经接线层注入缝路由公共出口）；内核策略产钻 SHALL 约束 shapeId='round'、diameterMm 按画布标度换算（KernelGem 与引擎 Gem 同构）。

#### Scenario: 七值全量分发

- **WHEN** 以七族任一 kind 调用统一分发入口且 params 合法
- **THEN** 路由到对应实现位产出 StrategyResult（gems+warnings 必备）；kind 为七值之外的字符串在 schema 层先拒

#### Scenario: 确定性回放上下文

- **WHEN** 同一节点+同参数+同 seed 经上下文工厂两次执行
- **THEN** 两次产出逐钻一致（注入 rng=确定性 PRNG，密度缺省 2.3 颗/cm²）

#### Scenario: 引擎委派不破红线

- **WHEN** 指派带 engineStrategy（显式）或几何族结果带声明式降级
- **THEN** 该节点块经接线层注入缝路由引擎公共出口产钻，不消费内核执行器 gems；注入缝缺席=typed 拒不静默空产

### Requirement: 参数化几何族

几何族 SHALL 覆盖六形状（star 星射线/heart/circle/rect/ellipse/spiral——判别键 shape 变体），各族参数 schema SHALL 以 Zod 冻结（rays/innerRadiusRatio/rotationDeg/turns/pitchMm/decay 等，缺省密度推导）；预览 SHALL 确定（同参同果）；SHALL 设最小可读下限守卫：掩膜内留钻数低于下限（全族 24；星形另需每射线 ≥3 或总数 ≥24 取大）SHALL 不自产钻，声明式降级到指派的引擎策略（缺省 hex-pitch）并记 reason='geometry-min-size' 的降级注记+warning。

#### Scenario: 星射线参数化

- **WHEN** 以 shape='star'、rays/innerRadiusRatio/rotationDeg 参数在已知掩膜上执行
- **THEN** 产钻呈射线排布且全部落在节点掩膜内；同参数重跑逐钻一致

#### Scenario: 可读下限降级

- **WHEN** 一个小节点经星射线布钻后掩膜内仅存 16 颗（< 下限 24）
- **THEN** 不输出该批钻，StrategyResult.engineStrategy 携 {reason:'geometry-min-size'} 降级注记与 warning（degraded）——由接线层路由引擎缺省策略

### Requirement: 语义拟合族

语义拟合族（参数极简+拟合吃重）SHALL 覆盖四族并以真实 fixture 断言把守：texture-fill（mode=scatter 满铺散布/flow 沿亮度梯度流线/hybrid 描线+满铺混合；ρ 极性 polarity=dark-dense|bright-dense|flat——纹理亮暗二分在节点内自适应）；soft-curve（Zhang-Suen 细化骨架线+沿线贝塞尔布钻）；flower（极坐标分解=花心圆布+花瓣扇区，petals 可缺省自动检测 3-64）；straight-line（PCA 主轴平行线族）；各族产钻 SHALL 全部落在节点掩膜内。

#### Scenario: 纹理流线方向跟随

- **WHEN** 对胡须/缎带类线主导节点以 mode='flow' 执行纹理族
- **THEN** 产钻沿亮度梯度流线排布（方向跟随），同参数同 seed 重跑逐钻一致

#### Scenario: 极性目标命中

- **WHEN** 以 polarity='dark-dense' 在亮暗二分节点上执行 texture-fill
- **THEN** 钻位密度集中于暗部目标区域（fixture 程序化断言目标命中），不匀撒全节点

#### Scenario: 花形极坐标分解

- **WHEN** 对花朵节点执行 flower 族且未显式给 petals
- **THEN** 花瓣数自动检测落于 3-64，产钻呈花心+花瓣扇区结构且全在掩膜内

### Requirement: 排除族与未贴区明示

排除 SHALL 为显式指派才生效的策略（kind=exclusion——drillWorthy=false 非硬规则，Owner「先别做排除」定调）：apply SHALL 产零 Gem+warning（excluded）+excludedRegions 注记（nodeId/label/reason/areaCm2——面积按块面积 px 换算 cm²），供 BOM 按节点分组明示「未贴区域」；reason SHALL 为一等参数（人读溯源，缺省=开关语义）。

#### Scenario: 显式指派零钻

- **WHEN** LLM/用户对某节点显式指派 exclusion 并给出 reason「灯光不贴」
- **THEN** 该节点产零颗钻，StrategyResult.excludedRegions 含该节点注记（reason 随行），BOM 面可见未贴区

#### Scenario: 排除非硬规则

- **WHEN** 节点 drillWorthy=false 但策略指派为非 exclusion 族
- **THEN** 排除不自动生效——是否产钻由实际指派的策略决定（开关只是建议面，无硬编码跳过）

### Requirement: 自由代码沙箱

自由代码族（LLM 自写 JS 排钻算法）SHALL 在 JS worker 沙箱内有界执行：逃逸面 SHALL 硬化（constructor 链逃逸断链/强制 use strict/eval 与 Function 遮蔽/动态 import 与 require 字面量语法 screen 拒收/process 桩/计时器与网络面遮蔽/原型污染 null-prototype+freeze/异常堆栈清洗不出境/结构化克隆拒函数走私）；语法 screen SHALL fail-closed（剥注释后模式匹配，误命中只增拒绝）；有界性 SHALL 三线（CPU=白名单几何库调用计数预算/墙钟=超时 worker.terminate/内存=resourceLimits+结果数组长度上限+postMessage 体积上限）；代码体积 SHALL 有上限（256KB）；注入面 SHALL=节点 mask+画布标度+钻规格+几何函数库+确定性 Rand(seed)（无网络/无 fs/无 import）；输出 SHALL 过校验链：Zod 逐颗（KernelGem 白名单投影）→强制引擎校验门（两两中心距 ≥ 所需×0.999；钻心像素中心落在掩膜内——违例颗 keep-earlier 序剔除+warning）→全灭或 schema 拒=typed error（gate-empty）；同 code+同 seed SHALL 可回放（审计/重跑）；失败 SHALL 抛 typed SandboxFailureError（结构化 stage 分类，供上层有界重试回 LLM——重试决策归调用方）。

#### Scenario: 逃逸面硬化

- **WHEN** 用户代码尝试 fn.constructor('return process')()、动态 import('node:fs')、require 字面量或 fetch/setTimeout
- **THEN** 构造链/全局遮蔽使探测失败或语法 screen 直接拒收（forbidden-syntax 携 token 名），无一可达宿主能力

#### Scenario: 三线有界

- **WHEN** 用户代码分别构造死循环、阻塞长任务、超量产出
- **THEN** 墙钟界超时被 terminate（阻塞态毫秒级可杀）、几何库调用计数超预算 soft-kill、结果数组/postMessage 体积超上限 typed 拒——宿主线程不失控

#### Scenario: 非法输出零逃逸

- **WHEN** 沙箱返回缺字段/越界坐标/间距违例/掩膜外钻位
- **THEN** 校验链逐颗剔除违例（keep-earlier 确定性）+warnings 溯源到原始输出序；全灭时 typed 拒（gate-empty），无一颗非法钻进入合并导出

#### Scenario: 同 seed 回放

- **WHEN** 同一 CodeStrategyArtifact（source+entryPoint+seed）执行两次
- **THEN** 两次产出逐钻一致（含剔除序）——审计与重跑可依赖

### Requirement: 策略指派工件契约

LLM 策略 proposal SHALL 为 StrategyPlan 工件（formatVersion=1）：objectTreeRef 溯源+styleId 接口位（词表空缺省透传）+assignments[]；每指派 SHALL 携 nodeId/strategyKind（七值）/params/stones（StonePick 列表——引用既有钻库 resourceId，不发明双键）/densityPerCm2（缺省 2.3）/rationale（可审性）；engineStrategy 为可选引擎映射（几何族降级时显式落引擎面）；free-code 指派 SHALL 必携 codeArtifactRef 且非 free-code SHALL NOT 携带（schema superRefine 拒）；同 plan 内 nodeId SHALL 无重复指派；free-code 源码 SHALL 工件化为 CodeStrategyArtifact（内容寻址 blob：language=javascript/source/entryPoint/seed/declaredApiCalls 声明面）。

#### Scenario: free-code 工件化强约束

- **WHEN** LLM 产出 free-code 指派（params 内联 source）或非 free-code 指派误携 codeArtifactRef
- **THEN** 前者被工件化为内容寻址 blob 且指派落 codeArtifactRef 引用（declaredApiCalls 提取随行）；后者 schema 拒收

#### Scenario: 重复指派拒收

- **WHEN** 同一 plan 内两指派指向同一 nodeId
- **THEN** schema 校验拒（nodeId 重复指派），proposal 不成立

### Requirement: 策略设计与授权（strategy.design 双模）

`strategy.design` SHALL 为 approved-mutation 双模工具：propose 模式（携 treeArtifactRef）装配设计上下文（ObjectTree 工件读回+钻候选投影[supplier/family/activeSetId 三键可组过滤，候选超上限 200 typed 拒要求收窄重发]+registry 七族指引表）→LLM 纯文本生成（冻结协议/temperature 0/超时与 max_tokens 有界）→JSON 抽取容错→校验链→proposal 入审批族 strategy-design；execute 模式（携 proposalId）经人工批准→grant→consumeForExecution→执行→settle 同一事务。校验链 SHALL：strategyKind 七值校验；stoneIdx 锚定（1 基引用候选表，幻觉 idx typed 拒；daemon 真源回填 StonePick；每节点至少 1 款有尺寸的钻——exclusion 除外）；逐节点 params 经 registry paramsSchema 校验（typed 携节点+字段）；producing 集全覆盖（未知节点拒/非产出层的层级节点禁指派/漏配节点必拒列名）。activeSetId 组合投影 SHALL 绑定 CAS（批准期间组合成员或 revision 变化=执行期 stale-revision 必拒），跨用户组合与回收站内组合 SHALL 拒。执行链 SHALL：逐节点 applyStrategy 真执行+engineStrategy 委派经注入缝（缺席 typed 拒）→gems 汇总过强制校验门（间距/掩膜违例颗剔除+全灭 typed 拒）→三工件落档（strategy-plan.json/strategy-gems.json/叠加预览 PNG）+strategy-design-logs 交换留存（不含 key）；真实外呼 SHALL 受真连门控制（缺省 mock=typed 拒 live-disabled）；工具名 SHALL 过 tool-surface deny 名单且连败 SHALL 触发 RUNAWAY 熔断。

#### Scenario: 幻觉引用必拒

- **WHEN** LLM 指派引用候选表之外的 stoneIdx（如 200 款候选时引 idx=999）
- **THEN** 校验链 typed 拒（携节点与该 idx），不静默截断或猜测替换

#### Scenario: producing 集全覆盖

- **WHEN** plan 漏配一个产块节点、或对画布容器根（非产出层）发指派、或指派不存在节点
- **THEN** 分别以漏配清单/层级节点禁指派/未知节点 typed 拒——提案不进审批

#### Scenario: 组合投影 CAS

- **WHEN** propose 时以 activeSetId 限定候选且批准前该组合被增删成员（revision 前进）
- **THEN** 执行期 consume 以 stale-revision 拒（STALE），不按漂移后的组合执行

#### Scenario: execute 恰好一次

- **WHEN** 已批准 proposal 被 execute 消费
- **THEN** consume→逐节点执行→强制门→settle 在同一事务内恰好一次完成；三工件与叠加预览落任务产物，gems 违例颗被剔除（全灭 typed 拒）

#### Scenario: 真连门缺省关

- **WHEN** 未设 STRATEGY_DESIGN_LIVE=1 到达 LLM 线面
- **THEN** typed 拒（live-disabled），缺省路径不外呼

### Requirement: 策略层编辑边界（两层编辑铁律）

Agent 对话层 SHALL 为策略层且仅策略层：可编辑对象=每图层的策略种类/参数/密度/钻规格/排除开关（图层级）；一切策略层变更 SHALL 经 proposal→人工批准→grant 的授权通道生效，SHALL NOT 旁路直写；单颗钻的增删移微调 SHALL NOT 出现在本管线任何策略层工具面（归设计师工作台既有单钻编辑层）；策略设计器 UI 的人工调参 SHALL 以「生成调整指令」回到对话由 Agent 重新提案并再审批，SHALL NOT 绕过审批直改既成指派或钻位。

#### Scenario: 图层级编辑过审批

- **WHEN** 人工在策略设计器调整某图层参数并确认
- **THEN** 变更以结构化调整指令注入对话输入框，由 Agent 重新提案→人工批准后才生效——无直写通道改既成 plan

#### Scenario: 单钻编辑不在策略层

- **WHEN** 在 Agent 对话/策略设计器面寻求修改单颗钻位置
- **THEN** 本管线无此工具面（策略层工具均为图层级指派与执行）；单钻微调由设计师工作台承载（既有地基）

### Requirement: 工件读通道（tasks.artifact）

daemon SHALL 提供 tasks.artifact 工件字节读面（{taskId, blobRef|name}→{name, mime, dataBase64}）：归属 SHALL 校验任务行（不存在=NOT_FOUND；跨用户=FORBIDDEN，admin 例外）；引用 SHALL 限定合法集=该任务帧流 artifact 帧（按 name 取最新同名帧；按 blobRef 须命中任一 artifact 帧）∪ 所属会话附件 blob，集外引用 SHALL 拒（防以自身 taskId 读任意 hash 的 blob 读 oracle）；尺寸 SHALL 护栏（blob 行 size > 8MiB typed 拒 artifact-too-large——先查行后读字节不先分配）；mime SHALL 按工件名扩展名映射，无扩展名附件按魔数嗅探（PNG/JPEG），兜底 application/octet-stream。

#### Scenario: 跨用户访问必拒

- **WHEN** 用户 B 以用户 A 的 taskId 请求工件（B 非 admin）
- **THEN** FORBIDDEN 拒——B 读不到 A 的任务工件（admin 例外面独立）

#### Scenario: blob 读 oracle 防护

- **WHEN** 持自己 taskId 传入一个不属于该任务 artifact 帧∪会话附件集的 blobRef
- **THEN** NOT_FOUND 拒（引用不在合法集），即便该 hash 在库中存在也不回字节

#### Scenario: 尺寸上限护栏

- **WHEN** 命中工件的 blob 行 size 超过 8MiB
- **THEN** typed 拒（artifact-too-large 携实值与上限），不读字节不返回部分内容

#### Scenario: 按名取最新

- **WHEN** 同名工件（如 object-tree.json）在帧流中被多次 emit 后按 name 请求
- **THEN** 返回最新一帧的 blobRef 内容（逆序扫描最新优先）
