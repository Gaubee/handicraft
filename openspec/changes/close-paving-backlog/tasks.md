# Tasks

> R1 评审修订：1.x 重写（原位升级非新族）/2.x 补物料门+门混径+透传/3.1 改直接消费既有共享件/4.x 补 lumaB64+核替换/新增 7.x specs delta。

## T1 geometry star 原位升级

- [x] 1.1 径向签名独立导出件：flower.ts `radialSignatureAndPetals`+circularSmooth 提为模块级共享导出（不进 GeometryHelpers 注入面）；flower 改引，返回形状不变，既有测试逐位绿门。
- [x] 1.2 geometry star 增量：r(θ) 边界调制（凹口射线收短）+rays 缺省峰数自动检测+`centerOffsetPx?`+`sparseness [0.2,5] default 1`；质心落掩码外退最大内切圆心近似（**新写**粗网格工程近似）。
- [x] 1.3 design prompt 的 geometry star 参数说明同步（四参数全暴露）；星心钻/可读下限守卫沿用（回归断言）。
- [x] 1.4 单测：凹五角星闭式合成 fixture（峰检测=5/凹口射线长度=r(θ) 调制生效——**不再有穿出岛点**/四参数显式覆写/质心掩码外退路）。

## T2 多尺寸混排（gapFill）

- [x] 2.1 contracts：`StrategyAssignment.gapFill?: {stoneRef; minGapRatio default 1.0}`+superRefine（exclusion/free-code 组合拒；stoneRef∈stones[].resourceId）；缺省缺席=现状逐位兼容断言。
- [x] 2.2 design.ts 执行段补隙趟：stones 内查 fill 径+网格候选+分桶判距（**单源引 gateRequiredPairPx(a,b,ppm)×minGapRatio 语义**——mm 入 px 出）+fill 角度继承就近 base。
- [x] 2.3 **validateGemPlacement per-pair 混径模式**（design.ts:1307 节点内门——单径标量门改逐对 gateRequiredPairPx(q.d,g.d)）；keep-earlier 语义不变；跨节点门已逐对注记（本节点判距+跨节点兜底=已知取舍入 code 注释）。
- [x] 2.4 **task-layout materialIdentityOf 混径规则**：stones≥2 且 gem.colorId 空→按 diameterMm↔sizeMm 唯一匹配（容差 0.05mm；零命中/多义拒如旧）；单 stones 路径不动。
- [x] 2.5 workbench 直改白名单透传 gapFill（先例 stoneIdx 继承）；design prompt 混排指派说明（fill 钻须列入 stones）。
- [x] 2.6 测试：双径混排端到端（gems 双径+BOM 双行+导出渲染含 fill 钻）；per-pair 门 fill 钻不被误剔（旧单径门下的反例断言）；分桶与朴素逐对等价性；直改后 gapFill 保留；superRefine 组合拒；大 fixture（>500 钻）秒级。

## T3 along-path 策略

- [x] 3.1 contracts `KernelStrategyKind` 增 `'along-path'`（七→八值）+registry 注册+design prompt 清单/指引表同步。
- [x] 3.2 `strategies/along_path.ts`：pathSource outline（boundaryTrace 新增+法向内缩）/custom（pathPts）；等弧长**直接消费 ctx.geometry.resampleOpen/resampleClosed**（soft_curve 零改动）；closed/首尾守卫；角度=切线。
- [x] 3.3 studio 同步：STRATEGY_FORM_SPECS 增键（Record tsc 兜）+**STRATEGY_KIND_ORDER 增项（点名：普通数组无完备性——两处下拉数据源）**+workbench.v4 七值断言测试同步。
- [x] 3.4 单测：outline 闭合环布点/折线等弧长/内缩缺省 0.5 钻径/custom 空路径 typed 拒/凹形掩码边界。

## T4 直线取向场

- [x] 4.1 texture_fill orientationField 提取共享（params 窄化显式入参；唯一调用点改引）——提取成本过高则独立镜像同口径（标注互为镜像）；既有测试逐位绿门。
- [x] 4.2 straight_line 布点核替换：`orientation:'global-pca'|'gradient-field'`+`lumaB64?`（无 luma=掩膜形状流降级+warning）+`lineSpacingMm?`（法向分离）+seed+RK 步进延伸弯曲折线族；缺省 global-pca 逐位兼容。
- [x] 4.3 单测：合成梯度 lumaB64 fixture（水平→垂直渐变——线族随场弯曲）；缺省路径逐位回归；luma 缺席降级 warning。

## T5 钻形搭配指引

- [x] 5.1 design.ts prompt 指引表（花瓣→drop/花心→round 大径——仅 Owner 原话规则）+knowledge-base 文档同步。
- [x] 5.2 设计冒烟：花形节点指派搭配倾向判读（既有 design 测试不破）。

## T6 specs delta + 收口

- [x] 6.1 specs/strategy-engine delta：七值冻结面（注册表/plan/工具三处）→八值+along-path Requirement（ADDED）；star 参数面增强+gapFill 字段+物料混径规则（MODIFIED）——Scenario 覆盖凹形调制/混排双行 BOM/沿路径边框。
- [x] 6.2 全量聚焦绿门：daemon tsc+strategies/design/task-layout/workbench 测试；contracts 测试；studio vitest（paramsSchema/strategyDesigner）+tsc。
- [x] 6.3 视觉验收：workbench 预览四图（星射线凹形/混排/边框路径/曲面直线）vision 子代理判读+落盘 experiments/。
- [x] 6.4 台账映射承接落仓内：本 change design §0 表即交付物（B5→polarity、B3→outline、D10→geo.*）；主仓 knowledge-graph §7.5 的 star 失实记载**顺手修正**（worktree 无法改主仓——记入收尾清单由 MainAgent 在主仓改）。
