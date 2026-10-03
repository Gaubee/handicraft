# tasks — add-vision-pipeline-v2

> 状态图例：[x] 完成 / [ ] 待做 / [~] 进行中（执行者标注）。
> 执行顺序建议：T1→T2（管线核心）→T4（treeView 协同）→T3（参数面）→T5（Dialog）→T6（验收）。
> 先行已落地（独立提交）：prompt 英文为主改造（子代理，另行 commit）。

## T1 掩膜分辨率语义（D2）
> 现状实证（2026-10-04 子代理）：请求侧降采样=macmini 服务端缩**掩码**（sam3_service.py
> do_segment PIL NEAREST；daemon 图像原样送线+maskMaxSide 参数透传）；结果侧升采样
> 自 80f973e（add-image-processing-settings Codex 复核）已在桥 materialize 收口。本批
> 补齐：共享纯函数抽位（vision/mask-resample.ts）+旧账本低分辨率条目回放自愈留痕
> （warning）+四路测试（纯函数/segment-one 全链/递归恒原分辨率/账本自愈）。
- [x] 1.1 segment 桥结果上采样回 imagePx（最近邻；尺寸断言=树 imagePx）（桥 materialize 既有 80f973e；T1 抽 vision/mask-resample.ts 共享纯函数+单测）
- [x] 1.2 递归细分输入恒用原分辨率（子层掩膜不得低于父层帧）（实证 anchors 恒定；segment-loop 测试锁全轮请求 imagePx 恒定+全树掩膜==bbox 帧内+低分辨率 bad-mask 拒收）
- [x] 1.3 测试：请求侧降采样生效+结果侧原分辨率+旧账本回放 miss 一次实跑（warning）（segment-one 全链 maskMaxSide 透传+归一化落树；segment-resume 旧条目自愈 ledger-stale-mask warning+树逐字节==基线）

## T2 segmentPrompt 字段+质量门（D4/D5）
> 2026-10-04 子代理落地：segmentPrompt 口径=**Agent 原始指令**（首轮=元素 hint/name；
> 细分轮=翻译前 broadSemanticPrompt 原文——译文只在 SAM 请求侧）；质量门=typed
> warning 级三先验（vision/mask-quality.ts 纯函数：填充率≥5%/宽高比∈[0.5,2] 且高度
> >90%×父（无父回画布）/父 IoU≤0.95——各自独立 reason，不丢结果不阻断）；预览回流
> =MCP image content 通道（capability/mcp.ts 约定字段 agentImagePreviews 提升+
> dataBase64 文本面剥离防 token 双计；开关 SEGMENT_AGENT_MASK_PREVIEW 缺省开、
> SEGMENT_AGENT_MASK_PREVIEW_MAX_SIDE 缺省 512、节点特写 cap 4）。
- [x] 2.1 contracts ObjectNode 增 `segmentPrompt?: string`（schema 测试：旧树兼容）
- [x] 2.2 循环落节点时写本次指令原文（tree_refine 同链）
- [x] 2.3 质量门：填充率/宽高比/父 IoU 先验（参数可配；typed warning 不丢结果）
- [x] 2.4 掩膜预览回流 agent（多模态载荷通道+成本开关）
- [x] 2.5 测试：右发类泄漏掩膜被门拦截+agent 重试叙事；中发空膜披露

## T3 precision 参数化（D3）
> 2026-10-04 子代理落地：contracts SegmentPrecisionSchema 单源（subject.segment 工具
> 入参 precision?{maskMaxSide,confThreshold}——T5 Dialog 参数面复用）；调用序
> tuneSegmentRequest（配置补缺省）→ applySegmentPrecision（显式覆写）→ reqHash/送桥
> ——precision 落进请求 ⇒ segmentRequestHash 天然分账（不同精度回放 miss 重跑）。
- [x] 3.1 contracts segment 工具入参 `precision?{maskMaxSide,confThreshold}`
- [x] 3.2 MCP 工具描述更新（调参建议语义——效果差可升精度重试）
- [x] 3.3 账本 reqHash 含 precision；测试：不同精度不串账

## T4 treeView 重做协同（Owner 已派 Codex 执行）
- [x] 4.1 画布=树根（可选/可抠图/普通形态）（56c3235 Codex 重做）
- [x] 4.2 滚动锚定结构级解决（Codex 重做交付；a026f4e 改自然树序——父在上子缩进，画布根恒顶部）
- [x] 4.3 图层行显示 segmentPrompt（依赖 2.1）（T5 批落地：行名称区弱化次行「指令：原文」
  9px muted+行 tooltip 追溯；无值不渲染占位——旧树零变化）

## T5 工作台抠图 Dialog（D6）
> 2026-10-04 子代理落地：dryRun 挂 layer.split（试跑真跑分段+账本照记不落树，确认同参
> 账本命中回放零二次桥调——segmentOne 接入断点账本 segmentOneLedgerFingerprint
> scope='segment-one' 分桶）；契约三字段 dryRun/precision/layerName+输出 trial 面
> {preview(恒带 trial-mask-overlay), replayed}；store=segmentTasks.svelte.ts 任务数组+
> activeId（队列预埋）；入口=图层面板拆分按钮（画布根同权）；mock layerSplit 改单子层
> （daemon 同构）+dryRun/layerName/precision/mock 账本回放标记。裁定全文见 design D6 增注。
- [x] 5.1 任务描述结构 store（队列预埋形态）（segmentTasks.svelte.ts——六态状态机）
- [x] 5.2 Dialog：目标预览+指令+参数+试跑+结果预览+命名+落地（SegmentDialog.svelte——
  precision 空=「跟随配置」语义；试跑预览 dataBase64 直渲；命名空=回退提示语命名链）
- [x] 5.3 落地=父层内子层（tree_refine 链）+画布同权（landSegmentLayer——applySegmentOutput
  与拆层同款 fence/toast/undo 语义）
- [x] 5.4 测试：全流程 jsdom（mock 桥）+落地树断言（workbench.segmentDialog.test.ts 三测：
  RPC 载荷断言 dryRun/precision/layerName+树未变+落地树/自定义名/segmentPrompt 原文+T4.3 行渲染；
  daemon/tests/segment-one.test.ts T5 四测：试跑不落树/确认零桥调/precision 不串账/无账本兼容；
  workbench.test.ts：TaskWorkbench 层 dryRun 不入版本史+确认入史）
> Codex R1 修复批（2026-10-04，P1+P2-1/3/5+P2-2 文档）：
> - P1 预览绑定确认：任务记试跑基态快照 {instruction, precision, targetNodeId, treeBlobRef}
>   （layerName 不入对比）；参数漂移=回 draft+预览作废+「参数已变更，请重新试跑」；树基态
>   漂移=确认禁用+提示；确认请求携 `trialTreeBlobRef`（LayerSplitInput 可选新字段——服务端
>   不一致 typed 拒 `trial-stale-tree` 不落树；旧调用零变化）。
> - P2-1 试跑预览/质量判定改兄弟互斥**后**最终形态（segment-one 预览掩膜=finalChildBits；
>   完全吞没=零叠加预览+child-consumed 文案点名胜者兄弟；前端空检出分支区分「无落地结果
>   （被兄弟 X 吞没）」与零检出）。
> - P2-3 忙碌态关窗闸：trialing/landing 中 Escape/外点/关闭钮一律不关（Content 行为闸
>   ignore+受控 open 镜像重申+X 隐藏；取消钮既有 disabled 语义不变）。
> - P2-5 precision 独立文本草稿（taskId 键控）：失焦/试跑时校验——空=跟随配置、非法/越界
>   =错误提示且不参与试跑；逐字输入中间态不清空（「6」→「64」可续输）。
> - 附带修复：workbench.segmentDialog.test.ts 的 mock spy 原型污染
>   （旧写法 Object.assign(getPrototypeOf(base), base) 把 spy 挂上 MockAgentApi.prototype，
>   跨测试串状态——改 Object.create(base) 原型链代理）。

## T6 三天使回归验收
- [x] 6.1 生产会话重跑抠图流程（补 segmentPrompt+新精度语义）（task 5ca7c664，39.0min，76 桥响应全 400×400）
- [x] 6.2 验收口径 1-7（design §验收）逐项+vision 子代理浏览器级走查（口径 1/2/3/4/5/7 DB 取证 PASS+口径 6 走查 6/6 PASS；分享包 /r/XNn0c64ChYEM 531 颗）
- [x] 6.3 部署 8317+新分享包交付（新包 /r/XNn0c64ChYEM；8317 已换装至 622c824 全修复批——studio 重建+重启，studio/share 双 200）
