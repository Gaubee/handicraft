# 排钻策略引擎（strategy-engine）Delta — close-paving-backlog

> R2 复核修订：MODIFIED 标题与 base 逐字一致（八值数字进正文）；gapFill 拆「指派工件契约」
> （schema 面）与「策略设计与授权」（执行链面）两条；守卫数字对齐代码真实现状
> （MIN_READABLE_GEMS=3——旧值 24 已废止）；混排 Scenario 径值改正（大径打底小径补隙）。

## MODIFIED Requirements

### Requirement: 七族策略注册表

贴钻策略 SHALL 以统一注册表承载**八族**（texture-fill/soft-curve/flower/straight-line/geometry/exclusion/free-code/**along-path**），契约冻结为 `apply(node+block 投影, params, canvas) → StrategyResult{gems, warnings, excludedRegions?, engineStrategy?}`；分发入口 SHALL 对 kind 先行 schema 校验（LLM 输出边界）再路由实现位，未实现槽 SHALL fail-fast 抛 typed error 而非静默空产；策略上下文 SHALL 注入确定性 PRNG 工厂、几何帮助库（单源——along-path 的等弧长重采样 SHALL 直接消费既有 resampleOpen/resampleClosed 共享件，soft_curve 内嵌实现不动）、gemDiameterPx 与缺省密度 2.3/cm²；引擎既有五策略 SHALL 保持 engineStrategy 声明式委派（包边界红线不变）；内核策略产钻 SHALL 保持 shapeId='round' 约束与 KernelGem 同构（gapFill 补隙钻 diameterMm 按自身 fill 径落位）。

#### Scenario: 八值全量分发

- **WHEN** 以八族任一 kind 调用统一分发入口且 params 合法
- **THEN** 路由到对应实现位产出 StrategyResult（gems+warnings 必备）；kind 为八值之外的字符串在 schema 层先拒

#### Scenario: 沿路径 outline 边框

- **WHEN** 以 along-path、pathSource='outline' 在环形窄边掩码上执行
- **THEN** 钻位沿掩码边界等距线等弧长分布（闭环、钻心距边 ≥0.5 钻径），首尾相接无缺口

### Requirement: 参数化几何族

几何族 star 变体 SHALL 支持完整四参数面：rays（缺省=径向签名峰数自动检测；显式覆写优先）/rotationDeg（初始角）/圆心（缺省掩膜质心+可选 centerOffsetPx 偏移；质心落掩码外 SHALL 退最大内切圆心近似）/sparseness（[0.2,5] 缺省 1——沿射线步长倍数，与 density 推导通道正交）。星射线步进上界 SHALL 按逐角边界签名 r(θ) 调制（min(r(θ)×0.98, rMax)）——凹多边形凹口处射线 SHALL 收短而非统一 rMax 后掩膜过滤（杜绝穿出再穿入的岛点）。径向签名 SHALL 为 flower/star 共享的模块级导出件（flower 消费面行为零变更）；可读下限守卫 SHALL 沿用现状（MIN_READABLE_GEMS=3 全族统一——geometry.ts:260；旧值 24 已于 2026-10-01 走查 P1 废止）。

#### Scenario: 凹五角星无岛点

- **WHEN** 以闭式合成凹五角星掩码执行 shape='star'（rays 缺省）
- **THEN** 峰数自动检测=5；任一钻位于掩膜内且无「凹口穿出再穿入」产生的孤立岛链

### Requirement: 策略指派工件契约

LLM 策略 proposal SHALL 为 StrategyPlan 工件（formatVersion=1）：objectTreeRef 溯源+styleId 接口位+assignments[]；每指派 SHALL 携 nodeId/strategyKind（**八值**）/params/stones（StonePick 列表）/densityPerCm2（缺省 2.3）/rationale；engineStrategy 为可选引擎映射；free-code 指派 SHALL 必携 codeArtifactRef 且非 free-code SHALL NOT 携带；同 plan 内 nodeId SHALL 无重复指派。每指派 SHALL 支持可选多尺寸混排字段 `gapFill{stoneRef, minGapRatio∈[1.0,3.0] 缺省 1.0}`：schema SHALL 拒 gapFill×exclusion（不产钻）/free-code（沙箱自管钻）组合，且 SHALL 要求 gapFill.stoneRef ∈ 该节点 stones[].resourceId（补隙钻须同时列入候选）；gapFill 缺席时指派 SHALL 与既有契约逐位一致（旧数据 parse 恒过）。

#### Scenario: 混排指派合法性

- **WHEN** 指派携带 gapFill 且其 stoneRef 不在节点 stones 候选内，或 strategyKind=exclusion
- **THEN** schema superRefine typed 拒并指明字段

### Requirement: 策略设计与授权（strategy.design 双模）

`strategy.design` SHALL 保持 approved-mutation 双模工具（propose 上下文装配/校验链/execute 执行链既有语义全保留），并扩展：**执行链**中携带 gapFill 的指派 SHALL 在 base 趟（既有策略产钻）后执行补隙趟——fill 钻径从节点 stones 内解析；掩码内网格候选+分桶逐对判距，最小中心距阈值=gateRequiredPairPx(dᵢ, d_f, ppm)×minGapRatio（单源引 sandbox/gate.ts 门公式——minGapRatio=1 缺省时与导出门逐位同式，>1 为收紧因子）；fill 钻 diameterMm SHALL 按自身径落 KernelGem、角度继承最近 base 钻。节点内钻位校验门 SHALL 为逐对混径模式（gateRequiredPairPx(q.diameterMm, g.diameterMm, ppm)；keep-earlier 剔除语义不变——单径标量门不适用于混排）。**物料身份匹配**：task-layout 组装时多 stones 节点且 gem.colorId 为空 SHALL 按 gem.diameterMm↔stone sizeMm 唯一匹配（容差 0.05mm；零命中/多义拒如旧；单 stones 路径不动）——双 stones 节点 SHALL NOT 因 colorId 空被整体拒收。**直改透传**：workbench 直改路径重建指派 SHALL 透传保留 gapFill（微调不静默丢混排配置）。**prompt 面**：策略清单 SHALL 同步八值（along-path 适用面一句）；stones 候选集段 SHALL 携带混排指派说明（补隙钻须列入候选）。

#### Scenario: 客户混排双行 BOM

- **WHEN** 节点指派 base 10.0mm 打底+gapFill 3.0mm 补隙（fill 钻列入 stones）执行并导出
- **THEN** gems 同时含双径钻位且逐对中心距 ≥(dᵢ+dⱼ)/2×ppm×0.999；BOM 按 stoneRef×diameterMm 呈双行；渲染含全部双径钻

#### Scenario: 直改不丢混排

- **WHEN** LLM 指派了 gapFill 的节点在排钻工作台被直改微调密度并保存
- **THEN** 重算指派仍携带原 gapFill 配置，补隙趟照常执行

### Requirement: 语义拟合族

straight-line SHALL 支持 `orientation: 'global-pca'（缺省——现状平行线族逐位不变）| 'gradient-field'`：gradient-field SHALL 为方向场驱动的弯曲折线族布点核（seed+RK 步进延伸，法向分离 lineSpacingMm），亮度输入经 `lumaB64` 通道（缺省退化掩膜形状流并 warning 留痕）；结构张量计算 SHALL 与 texture-fill orientationField 共享单源（或互为镜像的同口径实现）；钻位切线角 SHALL 取局部取向。

#### Scenario: 曲面贴合弯曲

- **WHEN** 合成水平→垂直渐变 lumaB64 fixture 上执行 orientation='gradient-field'
- **THEN** 线族随局部梯度方向连续弯曲（非全局平行），钻位切线角=局部取向

## ADDED Requirements

### Requirement: 钻形×铺法参考标准指引

策略设计（strategy.design）的 stones 候选集上下文 SHALL 携带钻形搭配参考标准表：花瓣区→drop 泪滴形（径向对齐）、花心→round 圆钻（径大于花瓣钻）；其余铺法无硬规则（候选集形状语义就近）。指引 SHALL 仅影响 LLM 选择倾向，不改变 StonePick schema。

#### Scenario: 花形节点搭配倾向

- **WHEN** LLM 对花形节点（含花心+花瓣区）做策略指派且候选集含 drop 与 round 钻
- **THEN** 指派倾向花瓣区选 drop、花心选较大 round（设计冒烟人工判读面）
