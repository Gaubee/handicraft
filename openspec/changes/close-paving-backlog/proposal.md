# 提案：排钻算法清账（Owner 历史提法全量兑现——不留残留）

> R1 评审修订版（5.5→修订）：P0×2（star 立项前提失实/BOM 物料身份门拒收混排）+P1×5 全部落设计。
> **关键纠正**：geometry star 本就是射线策略（geometry.ts:314-331 射线步进布点+design prompt 已暴露
> rays/innerRadiusRatio/rotationDeg 三参数+质心自动锚）——R1 前的「star 只是形状函数」论断失实
> （清点代理沿用了知识图谱 §7.5 的错误记载）。T1 改为**原位升级**，不开新策略族。

## Why

Owner 裁决（2026-10-02 原话）：「早期我提到过很多排钻的算法，你好好思考一下，把该做的都做了，不要给我残留任务。我默认认为我说过的你都做完了，别留烂摊子给我。」

全量清点（research 台账 30 条提法，台账落主仓 `openspec/changes/knowledge-graph-20261002.md` 同目录待归档；出处含 owner-directive-20260924/归档 changes/docs/实验报告）结论：已实现约 21 条、部分 4 条、未实现 5 条（其中 2 条 Owner 已显式降级「后话/你们决定」不欠）。**本 change 兑现其余 5 条**：

1. **star 射线策略补全**——Owner 四参数（owner-directive L25-29：「圆心在哪里/稀疏度如何/射多少条线/初始角度」）现状已实现三（rays/rotationDeg/质心自动锚定，稀疏度走 density 推导）；真缺口=①**r(θ) 逐角边界调制**（现状统一 rMax+掩膜过滤——multistrat §8-8 实证凹口「穿出再穿入」布岛点）②rays 峰数自动检测 ③圆心显式偏移 ④稀疏度显式倍数。
2. **多尺寸混排（Multi-Dec/双尺寸 gap-fill）**——Owner 三次显式触碰（2026-09-19 P2「Multi-Dec」、tech-research「SS20 打底+SS6/SS5 补隙」、客户报告承认「无混排策略」）。**客户产品就是 3mm+10mm 混排=刚需**。链路真缺口三层：指派字段/执行补隙趟/**物料身份门**（task-layout materialIdentityOf 对 ≥2 stones 节点按 colorId 匹配而内核 colorId 恒 ''——现状双 stones 节点 gems 全拒收，混排必先修此门）。
3. **沿路径排钻**——Owner 原话（2026-09-21）：「路径功能意味着要能编辑路径…你可以预留一个 change，后续再做」——预留从未兑现。outline 模式（掩码边界等距线）同时承接边框花环（tech-research B3）。
4. **直线族取向场升级**——multistrat §8-5 回流：PCA 全局取向对曲面刚体只能平行直线族；需逐局部梯度取向场（texture_fill 的 orientationField 已有张量计算可共享）。
5. **钻形×铺法参考标准**——Owner 原话（L84）：「花瓣搭配泪滴状钻，花心搭配大圆钻…形成参考标准体系」——候选集与角度机制已就绪，只差 design prompt 显式指引表。

低优先两件映射承接（不新建）：高光贴（B5）=texture-fill `polarity=bright-dense` 已覆盖；边框花环（B3）=T3 outline 模式承接。

## What Changes

1. **T1 geometry star 原位升级**（**不开新策略族**——避免与既有 star 射线语义重叠）：star 变体增 r(θ) 边界调制（径向签名独立导出件，flower 改引零变更）/rays 缺省峰数自动检测/centerOffsetPx 可选/sparseness 显式倍数；design prompt 的 geometry star 参数说明同步；最大内切圆心退路（质心落掩码外时）**新写**（geometry helpers 现无此函数——R1 纠偏：非「既有」）。
2. **T2 多尺寸混排**：**执行层正交模式**（「打底+补隙」可叠加到任意策略，非新族）：`StrategyAssignment` 增可选 `gapFill?: { stoneRef; minGapRatio }`（superRefine：exclusion/free-code 组合拒；fill 钻须列入该节点 stones）；执行器补隙趟（网格候选+分桶判距，门公式统一引 `gateRequiredPairPx` 单源缺省同式）；**节点内校验门混径化**（validateGemPlacement 增 per-pair 模式——单径标量门会系统性误剔 fill 钻）；**task-layout 物料身份门增混径匹配规则**（多 stones 且 colorId 空时按 gem.diameterMm↔stone sizeMm 唯一匹配——否则双 stones 节点全拒收）；workbench 直改白名单透传 gapFill（继承先例 stoneIdx）。
3. **T3 along-path 策略**：`KernelStrategyKind` 七值→**八值**（唯一新枚举）；`strategies/along_path.ts`：pathSource=`outline`（掩码边界追踪+内缩——承接 B3 边框）|`custom`（pathPts 点列）；等弧长重采样**直接消费既有 `ctx.geometry.resampleOpen/resampleClosed`**（soft_curve 零改动——其内嵌等弧长与骨架分支耦合，不提取）。
4. **T4 直线取向场**：straight_line 增 `orientation: 'global-pca'（缺省）| 'gradient-field'`——**布点核替换**（平行线扫描→方向场 seed+RK 步进延伸弯曲折线族，非扩参级改造）+`lumaB64` 亮度注入通道（无 luma 退化为掩膜形状流——texture_fill 同款语义）+法向分离 `lineSpacingMm`；张量计算共享提取（texture_fill orientationField 已导出解耦——提取或独立镜像双出口）。
5. **T5 钻形搭配指引**：design.ts prompt 增参考标准表（**只写 Owner 原话有的**：花瓣→drop 泪滴、花心→大圆 round；不发明无出处规则）。

## Impact

- contracts：`KernelStrategyKind` 增 `'along-path'`（七→八值）；`StrategyAssignment` 增可选 `gapFill`（strict 下可选键——旧数据 parse 恒过）。
- daemon：strategies/（geometry star 升级/along_path 新增/straight_line 取向场/径向签名独立导出件）；design.ts（执行段补隙趟+门混径化+prompt 面：策略清单/指引表/混排说明）；task-layout.ts（物料身份混径规则）；workbench.ts（直改透传）；registry 注册；`tests/workbench.v4-strategy-defaults.test.ts` 七值断言同步八值。
- studio：engine/ 零改动（红线）；`STRATEGY_KIND_ORDER`（paramsSchema.ts:225 普通数组**无类型完备性**——两处下拉数据源）+`STRATEGY_FORM_SPECS` Record（tsc 兜）须同步 along-path 键。
- specs：strategy-engine spec delta（七值冻结面多处→八值+star 参数面+gapFill 字段+物料混径规则）——见 specs/。
- 映射承接记录：B5→polarity、B3→along-path outline、D10→sandbox geo.*——落 design §0 映射表（仓内可验证位）。
