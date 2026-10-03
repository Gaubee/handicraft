# Codex 复核 R1 — add-vision-pipeline-v2（2026-10-04）

- 复核人：Codex（gpt-6.1-sol xhigh，herdr agent codex-vision-v2）
- 对象：0fd4c10 / 41f4838 / 54b587d / 463eec9 / eabf90e + 变更文档
- 评分：**6.8/10**——「后端契约、账本和分辨率处理扎实，但两个核心预览一致性问题会让用户确认的结果与可见结果不符，当前不建议按 D6 状态放行验收。」
- 与 80f973e 对比：仅限 D2 面可比（本轮保留桥边界上采样+补旧账本自愈）；整体验收不可直接对比（本轮新增质量门/多模态通道/工作台交互）。

## 阻塞问题

### P1 试跑预览没有绑定确认时的指令、精度和树基态
- `segmentTasks.svelte.ts:101` 修改指令或精度时只更新字段，不清除旧预览；`SegmentDialog.svelte:49` 仍允许确认
- 确认请求会使用新指令/精度，而 RPC 每次都解析最新树；请求指纹不同→重新调 SAM；同指纹但父掩膜已变时也可能得到不同最终子层。界面仍展示旧预览和旧实跑标记，用户可能批准一个没有落地的掩膜
- 修复建议：保存试跑的有效请求指纹及树基态；指令/精度或目标掩膜变化后禁用确认并要求重跑；服务端确认时也应校验快照；layerName 仍应排除在指纹之外

## P2

1. **试跑图与最终子层可能不同**：`segment-one.ts:531` 试跑预览生成于兄弟互斥**前**；互斥会裁剪/吞没子层但预览仍用互斥前的 cleaned。应基于互斥后的最终子层生成预览与质量判定；子层被吞没时显示明确无落地结果。补测部分重叠与完全吞没两况
2. **D2 文档与实际降采样语义不一致**：design.md:34 写 SAM 请求图像降采样；实际 `sam3_service.py:327` 在推理后缩小**返回掩膜**、`segment-one.test.ts:393` 断言原图字节原样送线。按当前实现更新 D2 与参数说明（maskMaxSide 保留输出边缘细节，不能修正语义漏检/整片泄漏）
3. **落地进行中仍可关闭 Dialog**：`SegmentDialog.svelte:120` 关闭事件无条件清空活动任务；Escape/外点可关窗而落地 RPC 继续改树。忙碌时应阻止关闭或实现真实取消；补测试跑中/落地中关闭
4. **多模态降级只有全局手动开关，没有消费端能力适配**：`mcp.ts:87` 无条件发 image block；无按 agent 能力降级或「视觉证据不可用」明示。建议按消费端能力发送；不支持时保留告警并明示预览不可用，补测该路径
5. **precision 输入逐字输入中间态清空**：`SegmentDialog.svelte:59` 输入直接解析为精度；低于 32 的中间值变 null、控件值又从精度衍生，替换已有值时首数字后清空。为文本草稿保留独立字符串，失焦/试跑时校验呈现错误

## P3

- 质量门对贯穿父层的合法细长结构（发丝/羽枝）仍会告警——warning 级不丢结果；建议加入超阈值真实合法样例再校准。IoU 并集为零有保护，未发现生产路径除零

## 质量评价（原文要点）

D2 结果掩膜归一化/递归原分辨率/旧账本坏掩膜摘除重跑留痕均有实现；D4 保留原始指令并兼容旧树；D3 有效 maskMaxSide 与 confThreshold 进请求哈希；D6 layerName 不入哈希、精度入哈希、掩膜 blob 失效触发重跑。主要缺陷集中在试跑预览与最终落地的一致性、Dialog 对试跑状态与在途操作的约束。

> 处置记录（MainAgent）：P1+P2-1/3/5+P2-2 文档派修复批——**已修复（2026-10-04 修复批子代理）**：
> - **P1**：segmentTasks 记试跑基态快照 {instruction, precision, targetNodeId, treeBlobRef}（layerName 不入对比）；漂移=回 draft+预览作废+确认禁用+提示重跑；树基态漂移（树引用≠快照）=确认禁用+提示；确认请求携 `LayerSplitInput.trialTreeBlobRef`（可选新字段，旧调用零变化），服务端 `segmentOneSplit` 不一致 typed 拒 `trial-stale-tree` 不落树（附 currentTreeBlobRef 刷新锚）；mock 同构守卫
> - **P2-1**：segment-one 试跑预览与质量判定改兄弟互斥**后**最终子层（finalChildBits 单源）；完全吞没=零叠加预览+`child-consumed` 文案点名胜者兄弟；前端空检出分支区分「无落地结果（被兄弟 X 吞没）」与零检出；补部分重叠（预览字节级=裁剪后形态渲染）与完全吞没两测
> - **P2-3**：忙碌态（trialing/landing）Escape/外点/关闭钮一律不关（Content `escapeKeydownBehavior/interactOutsideBehavior=ignore`+受控 open 镜像重申+X 隐藏）；补试跑中/落地中/preview-ready 可关三测
> - **P2-5**：precision 两输入独立文本草稿（taskId 键控），失焦/试跑时校验——空=跟随配置、非法/越界=错误提示且不参与试跑；「6」→「64」逐字输入不清空已测
> - **P2-2**：design D2 措辞对齐实现（服务端推理用原图/返回掩膜降采样省带宽/桥边界升回 imagePx；maskMaxSide=桥参数透传+参数语义注记）
> - 附带发现并修复：workbench.segmentDialog.test.ts mock spy 原型污染（`Object.assign(getPrototypeOf(base), base)` 把 spy 挂上 MockAgentApi.prototype 跨测试串状态——改 `Object.create(base)`）
>
> P2-4 持有至 T6b live 证据（GLM-5.3-Flash image 块兼容性）再定级；P3 入挂账。
