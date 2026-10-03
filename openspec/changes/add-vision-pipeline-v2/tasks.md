# tasks — add-vision-pipeline-v2

> 状态图例：[x] 完成 / [ ] 待做 / [~] 进行中（执行者标注）。
> 执行顺序建议：T1→T2（管线核心）→T4（treeView 协同）→T3（参数面）→T5（Dialog）→T6（验收）。
> 先行已落地（独立提交）：prompt 英文为主改造（子代理，另行 commit）。

## T1 掩膜分辨率语义（D2）
- [ ] 1.1 segment 桥结果上采样回 imagePx（最近邻；尺寸断言=树 imagePx）
- [ ] 1.2 递归细分输入恒用原分辨率（子层掩膜不得低于父层帧）
- [ ] 1.3 测试：请求侧降采样生效+结果侧原分辨率+旧账本回放 miss 一次实跑（warning）

## T2 segmentPrompt 字段+质量门（D4/D5）
- [ ] 2.1 contracts ObjectNode 增 `segmentPrompt?: string`（schema 测试：旧树兼容）
- [ ] 2.2 循环落节点时写本次指令原文（tree_refine 同链）
- [ ] 2.3 质量门：填充率/宽高比/父 IoU 先验（参数可配；typed warning 不丢结果）
- [ ] 2.4 掩膜预览回流 agent（多模态载荷通道+成本开关）
- [ ] 2.5 测试：右发类泄漏掩膜被门拦截+agent 重试叙事；中发空膜披露

## T3 precision 参数化（D3）
- [ ] 3.1 contracts segment 工具入参 `precision?{maskMaxSide,confThreshold}`
- [ ] 3.2 MCP 工具描述更新（调参建议语义——效果差可升精度重试）
- [ ] 3.3 账本 reqHash 含 precision；测试：不同精度不串账

## T4 treeView 重做协同（Owner 已派 Codex 执行）
- [ ] 4.1 画布=树根（可选/可抠图/普通形态）
- [ ] 4.2 滚动锚定结构级解决（Codex 重做交付）
- [ ] 4.3 图层行显示 segmentPrompt（依赖 2.1）

## T5 工作台抠图 Dialog（D6）
- [ ] 5.1 任务描述结构 store（队列预埋形态）
- [ ] 5.2 Dialog：目标预览+指令+参数+试跑+结果预览+命名+落地
- [ ] 5.3 落地=父层内子层（tree_refine 链）+画布同权
- [ ] 5.4 测试：全流程 jsdom（mock 桥）+落地树断言

## T6 三天使回归验收
- [ ] 6.1 生产会话重跑抠图流程（补 segmentPrompt+新精度语义）
- [ ] 6.2 验收口径 1-7（design §验收）逐项+vision 子代理浏览器级走查
- [ ] 6.3 部署 8317+新分享包交付
