# tasks — add-sam-playbook

> 状态图例：[x] 完成 / [ ] 待做 / [~] 进行中。
> Owner 令（2026-10-04）：①②③④做掉（⑤VLM 不做）→MCP→Dialog→skills→Agent 实战→Codex 审查循环至满意；每轮新会话存档不覆盖。

## T0 前置研究（并行）
- [~] 0.1 官方提示词语料/例子网络研究 → `experiments/sam-playbook-20261004/research-sam3-prompt-corpus.md`
- [x] 0.2 macmini 点提示 spike → `.../spike-points.md`（**否决微框近似**；原生点可行；**boxNegative 实测无效**→D2 改 excludeBox 像素减法；负点=软先验）

## T1 能力面（daemon 桥+契约）
- [x] 1.1 text prompt 增 excludeBox（spike 纠偏：boxNegative 无效不暴露）+text 放宽 optional（契约 schema+superRefine 至少一项）
- [x] 1.2 桥 wire 映射：excludeBox 剥除不上线（daemon materialize 像素减法——best 与逐实例同减）；纯 box 组装（线上现成语义）
- [x] 1.3 points 打通（macmini 服务 v1.1.0 原生点+回归逐位一致；桥层 e986ae9：wire 对象映射+topK 地板 8+候选三级选择序「containsPoints 优先→多数包含→面积平局→unmatched warning」+UNSUPPORTED 旧服务回退保留）
- [x] 1.4 SegmentOneInput 增 `instances?: 'best'|'all'`（all=逐实例子层：独立掩膜/质量门/预览/互斥；命名+序号；≤24 实例护栏）+**循环链同步**（subject.segment 输入暴露+segment-loop 首轮/后续轮扇出+账本逐实例行回放）
- [x] 1.5 测试：schema（excludeBox/纯 box/instances 三态/superRefine 拒）+桥映射（excludeBox 剥除+纯 box wire 形状+topK 透传）+实例枚举全链（24 上限双分支/互斥/segmentPrompt 后缀/dryRun 逐实例预览/同参回放零二次桥调/best≠all reqHash）+excludeBox 减法（区域内零+区域外逐位不变+边缘裁剪）

## T2 暴露面（MCP+Dialog）
- [x] 2.1 MCP 工具升级：subject.segment/layer.split 新参数+策略指引进描述（失败信号↔解法对照+KB 组引导）
- [~] 2.2 Dialog 升级：排除区绘制（红色虚线叠加——excludeBox）/纯框模式（无指令）/实例枚举结果列表（逐实例预览+可勾选落地）已落地（2026-10-04 T2；子集勾选落地记 follow-up——落地恒全量）/点选微调（若 1.3 成）
- [x] 2.3 质量门泄漏类告警文案追加 excludeBox 指引
- [x] 2.4 测试：工具描述快照+Dialog 各新模式 jsdom+走查
- [x] 2.5 tree_refine 步进化（Agent refinement 工具吃到 T1/T2 新能力）：TreeRefineInput 增 `steps?`（1..8 步，逐步 hint/box/excludeBox/instances 透传 segmentOne；每步「hint 与 box 至少一项」；与 hints 互斥恰一存在——旧形态零变化）+MCP 描述泄漏修法（excludeBox 框住泄漏区——框内像素从结果掩膜扣除）/instances 教法/步内参数策略块（指向 KB「SAM 提示词策略」组）

## T3 知识库+skills
- [ ] 3.1 KB 组「SAM 提示词策略」六条目+index（研究落地+Owner 战例+失败信号对照表——与质量门 reason 对齐）
- [ ] 3.2 工具描述↔KB 双向引导接线验证（描述指组名/条目覆盖告警 reason）

## T4 实战迭代循环（Codex 审查驱动）
- [ ] 4.0 基线档案 iter-0（T6b v36 存档：右头冠稀薄/逐星 6 簇/翅掩膜回收数据）
- [ ] 4.1 iter-1：新会话+冻结验收指令（见下）→存档→Codex 审查
- [x] 4.1.1 出循环修复（iter-1 Codex 审查裁定两项，`experiments/sam-playbook-20261004/iter-1/codex-review.md`，2026-10-04）：
  ①授权反馈契约——strategy.design propose/execute 返回面与 studio.task.export propose 面走 approvalFaceOf（autoApprove 会话返回 autoApproved=true+「立即执行」指令——iter-1 agent 停在提案阶段的根因，design.ts 原 2114/task-export.ts 原 1022 两处无条件「等待用户批准」）+lint 分级文案落返回/描述（unintroduced=warning 非阻断继续流程；unresolvable+导出侧 mask/spacing=硬阻断停止待确认）+免值守回归链测试（design→execute→export propose→export execute 全程零 session.answer；断言 unintroduced 只进 warnings 不阻断、export 出 bundle）；studio.task.stones.add 授权面**不动**（autoApprove 是否覆盖=产品政策 Owner 决策中）。
  ②TreeRefineStepSchema 增 `precision?: {maskMaxSide?, confThreshold?}`（复用 SegmentPrecisionSchema）contracts→treeRefine→segmentOne 全链透传（底层本就支持——修复前 refine 路径不可达，「降阈值」只存在于叙事）+describe 警示「降阈值必须实际落参，叙事宣称无效，以 wire 回执为准」+测试断言 wire 回执（带参步 confThreshold=0.3/maskMaxSide=1536 落 wire；未带步两字段缺席）。
  附带：subject.segment/tree.refine 工具描述追加三规则（precision 必须落参以 wire 回执为准/lint 非阻断/autoApprove execute-next）。
  测试：strategy-design 42 绿/tree-tools 27 绿/capability-task-export 19 绿/contracts workbench 31 绿/approval-auto-approve+mcp 15 绿；daemon+contracts typecheck 双绿。
- [ ] 4.2 轮间调整（只动 skills/KB）→iter-2…≤5 轮
  - [x] 4.2.1 iter-2 修法 A（Codex 裁定，`experiments/sam-playbook-20261004/iter-2/codex-review.md` §3/§4——授权反馈契约，超出「只动 skills/KB」由裁定授权）：studio.task.stones.add propose 返回面接入 approvalFaceOf（原 task-stones.ts 无条件「等待用户批准」——propose() 在 autoApprove 会话已签发 grant 并返回 autoApproved=true，iter-2 DB 实证 auto_approved=1/consumed=0：文案说谎致 agent 停摆、grant 作废）；autoApprove 会话透传 autoApproved=true+「立即以 {taskId, proposalId} 调用执行（勿等待用户）」；手动审批路径文案原样零漂移（不扩权——B=autoApprove 是否覆盖 stones.add 的政策收紧属 Owner 决策，中央授权政策零触碰）；工具描述补 autoApprove 会话执行说明一句。测试：capability-task-stones 免值守两条（autoApprove=发起 autoApproved=true+零 session.answer 执行消费 grant 成功+grants 行 consumed=1；手动=等待文案+未批执行 grant-missing 拒）。
- [ ] 4.3 Codex「满意」终审留档（+无 P1+评分≥9）
- 冻结验收指令（每轮同一字串，新会话首发）：
  「请对这张三天使圣诞图做全量分件并贴钻导出。硬性要求：1. 三位天使都要完整成层（头/发/袍/翅分开或合理分组，右天使头部不能缺失）2. 背景六颗大星星逐颗成层（不是整片）3. 花篮完整 4. 头发用流线贴法 5. 完成后导出分享包。遇到分件困难时先查知识库『SAM 提示词策略』组。」

## T5 收尾
- [ ] 5.1 全量绿门+8317 换装+归档清单（iter 档案目录索引）
- [ ] 5.2 Owner 交付（升级过程全档案路径+终轮对比 baseline 数据）
