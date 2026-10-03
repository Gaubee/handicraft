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
- [ ] 2.1 MCP 工具升级：subject.segment/layer.split 新参数+策略指引进描述（失败信号↔解法对照+KB 组引导）
- [ ] 2.2 Dialog 升级：排除区绘制（红色虚线叠加——excludeBox）/纯框模式（无指令）/实例枚举结果列表（逐实例预览+可勾选落地）/点选微调（若 1.3 成）
- [ ] 2.3 质量门泄漏类告警文案追加 excludeBox 指引
- [ ] 2.4 测试：工具描述快照+Dialog 各新模式 jsdom+走查

## T3 知识库+skills
- [ ] 3.1 KB 组「SAM 提示词策略」六条目+index（研究落地+Owner 战例+失败信号对照表——与质量门 reason 对齐）
- [ ] 3.2 工具描述↔KB 双向引导接线验证（描述指组名/条目覆盖告警 reason）

## T4 实战迭代循环（Codex 审查驱动）
- [ ] 4.0 基线档案 iter-0（T6b v36 存档：右头冠稀薄/逐星 6 簇/翅掩膜回收数据）
- [ ] 4.1 iter-1：新会话+冻结验收指令（见下）→存档→Codex 审查
- [ ] 4.2 轮间调整（只动 skills/KB）→iter-2…≤5 轮
- [ ] 4.3 Codex「满意」终审留档（+无 P1+评分≥9）
- 冻结验收指令（每轮同一字串，新会话首发）：
  「请对这张三天使圣诞图做全量分件并贴钻导出。硬性要求：1. 三位天使都要完整成层（头/发/袍/翅分开或合理分组，右天使头部不能缺失）2. 背景六颗大星星逐颗成层（不是整片）3. 花篮完整 4. 头发用流线贴法 5. 完成后导出分享包。遇到分件困难时先查知识库『SAM 提示词策略』组。」

## T5 收尾
- [ ] 5.1 全量绿门+8317 换装+归档清单（iter 档案目录索引）
- [ ] 5.2 Owner 交付（升级过程全档案路径+终轮对比 baseline 数据）
