# iter-3 — 授权链全通后的第三轮 Agent 实跑（免值守主路径首次全程闭环）

> add-sam-playbook 迭代 3。8317 daemon 已换装 commit **b9c2025**（stones.add 返回面接入 approvalFaceOf——iter-2 P0 断链点的修法 A）；KB 带 iter-2 审查四条调整（独立仓 `173d748`+`c3bc443`）。
> 本轮独立新会话，未触碰任何既有会话（iter-1 `e02ab697` / iter-2 `411b0686` 均未读写）。全程只观察零介入——仅首发一条 followup（autoApprove=true），WS 随即关闭。DB 全程 mode=ro。无重跑：任务 **99.3 分钟自然终态 done**。
> **headline：④⑤ 首次双 PASS——分享包 `/r/pUdHPBkGQjhk`、1232 钻；五授权全 autoApproved、四 grant consumed=1（一例有意弃置）；precision 首次真实落参 25 次。**

## 会话与任务

| 项 | 值 |
|---|---|
| daemon | 127.0.0.1:8317（PID 48184，cwd `贴钻-backend/daemon`，commit **b9c2025**——10:03:07 提交、10:03:27 启动，确在修复版上；全程未重启） |
| KB | DATA_ROOT/knowledge 独立仓 @ **c3bc443**（=173d748 四条调整 + 部位拆分名实一致补则） |
| 用户 | 匿名（`__anonymous__`，新 token 新会话） |
| 会话 | `f01cc675-f166-41b3-a020-09e1a28afab9`（title=「右侧天使 · 左侧天使（33 区域）」） |
| 任务 | `2f1d5e15-4f1c-45c2-bde0-1c0751c40e04`（type=agent） |
| 图片 | 同一 PNG 字节（blobRef `6267829d…` 与 iter-1/2 完全一致，2,984,658 B；源图=任务指定 JPG 的既有无损 PNG 转换件，sha256 复核一致） |
| 创建路径 | POST /api/auth/anonymous → WS /ws/rpc（RPCLink）→ assets.upload → session.create → session.followup（冻结指令一字不改+20×20cm 表单参数行+attachments 单图+autoApprove=true）；脚本即发即退 EXIT=0 |
| 时间窗 | 2026-10-04T02:04:59.364Z → 03:44:15.362Z（**99.3 min**，自然终态 done） |
| 帧统计 | 625 帧：transcript 236 / activity 178 / artifact 134 / progress 66 / approval-request 5 / approval-resolved 5 / done 1 |
| 工具调用 | 89 次（studio MCP 86 + todo_write 3）：strategy_design 14 / tree_refine 17 / tree_rename 13 / stones_search 8 / kb_get 6 / tree_merge 5 / tree_reparent 5 / scene_analyze 3 / set_create·task_stones_add·task_export·stones_list 各 2 / tree_inspect·kb_list·task_images_list·task_stones_list·task_proposals_list·subject_segment 各 1 |
| SAM 桥 | 97 次 wire 全 outcome=ok（geometric 33 + text 64）；**confThreshold 0.4×72 / 0.3×24 / 0.2×1，maskMaxSide 显式 1 次（1536）——非默认 precision 携带 25 次（25.8%），历轮首次正例** |
| 审批 | 5 proposal 全 autoApproved=true；grant 5 行：**4×consumed=1**（stones.add/set.create/strategy v2/task.export）+ 1×consumed=0（strategy v1 有意弃置过期） |
| 瞬态故障 | 13 次工具级 LLM 失败自愈（scene_analyze 2 + strategy_design 11：GLM-5.3-Flash「只思考不产出」/timeout/bad-json），daemon/SAM 桥零故障 |

## 验收五条逐条（含数字）

### ① 三天使完整成层 — **PASS**（历轮最全件数，含手部新层）
终树 v58（39 节点=画布+5 组节点+**33 可钻叶子**；掩膜像素实测）：
- 左天使（6 子）：脸 90×96 **fill 51.9%**（4481px）/ 卷发 122×120 **41.6%**（6097px）/ 冬青花环 112×56 31.7% / 白袍 164×238 **48.9%**（19074px）/ 上羽扇 89×103 4.4%（401px 羽缘线，见披露）/ 下羽 125×100 30.3%
- 右天使（7 子）：脸 93×89 **68.2%**（5645px，历轮最高）/ 卷发 139×86 27.5% / 花环 120×41 27.6% / 白袍 140×234 **57.0%**（18661px）/ 下羽尖 43×48 53.7% / 内羽缘 0.9% / 上羽缘 1.2%（后两者为羽缘线，见披露）
- 中间小天使（4 子）：脸 75×78 **63.8%**（3733px）/ 卷发 104×63 20.3% / 花环 43×38 **51.9%** / **手 24×19 33.3%（历轮首个手部层，画布域兜底所得）**
- 右天使头部完整（脸 68.2%+发 27.5%+花环 27.6% 三层齐）；首轮 IoU=1.000 泄漏层「右侧天使·部分5」被检出并移除（#132→#137）
- 备注：小天使无独立袍层（整体掩膜含袍区，约 600px 级身体残余未排钻）——按硬性要求「分开**或合理分组**」判 PASS，agent 终报未单独披露此项（遗留观察点，见异常遗留）

### ② 背景六星逐颗成层 — **PASS（6/6）**
六独立星层（掩膜实测）：亮星·右中 19×22 **64.1%** / 左中 22×30 42.4% / 左上 23×31 23.3% / 左缘 27×32 39.5% / 右上 24×38 33.2% / 右下 27×21 38.3%；fill 均值 **40.1%**（iter-1 52.0% / iter-2 38.3%），全部非退化（最小 setpx=166）。策略层六星全部 `geometry shape=star` + Q081 4mm 亮面切角白钻星形镶嵌。路径：首轮 S3-S5 迭代丢 5 星 → 域内措辞+box 五连败 → #186 建立「星位已被挖孔、天空掩膜有洞」域假设 → 画布根纯 box 4/4 命中 → 语义化命名+reparent。

### ③ 花篮完整 — **PASS（8 子件，粒度超 iter-2）**
底部圣诞装饰组 500×165 fill 50.3%（41482px）下 8 子件：松枝 498×165 20.6%（16952px）/ 红蝴蝶结×3（43.7%/70.0%/53.1%）/ 红装饰球×2（72.1%/53.9%）/ 红浆果 261×84 61.2%（13409px→239 钻浓密成簇）/ 白钻光点（48px，1 颗点题）。介于 iter-1（12 子件）与 iter-2（整体单层）之间且结构语义清晰。

### ④ 头发流线贴法 — **PASS（策略+排钻双实证，历轮首次闭环）**
- 策略指派（v2 提案 `e7b86c94`）：三个发层全部 `texture-fill mode=flow + engine=hex-thin`，rationale「卷发沿发流流线排布」——0007 左（density 6.5）/ 0012 右（6.5）/ 0016 小（9.0 细钻）
- 排钻落位（#602 执行回执）：**77/28/26 颗**（合计 131 颗流线钻），小天使用 2.7mm 细钻
- 对比：iter-1 有提案层但未执行（hex-thin×3）；iter-2 未达策略层；**iter-3 提案→执行→落钻全通**

### ⑤ 分享包导出 — **PASS（历轮首次）**
- 授权：#605 approval-request `studio.task.export` proposal `14dc8450`（1232 钻/12 款/BOM 12 行/五产物）→ #606 autoApproved=true → #608 返回面「立即执行」→ #609/#611 执行 → grant `387b0f6c` **consumed=1**
- results 行（DB）：**publicId `pUdHPBkGQjhk`** · resultId `54476f5d` · title「任务导出 image-1（1232 钻）」· 2026-10-11 过期
- bundle 7 文件实存：layout.svg 4.96MB / render.png 3.51MB / numbered.png 913KB / holes.png 148KB / bom.csv（12 SKU 合计 **1232**：PW-4 381 / DT-07 216 / 225 165 / PC-08-4 153 / 14-422 90 / B67 87 / A52 67 / PC-08-3 44 / DT-37 17 / Q081 9 / PW-3 2 / J51 1）/ bundle.json / source.img
- 过程：84 颗跨节点重叠钻 keep-earlier 剔除；5 条孤立钻组 warning（星点/羽缘单颗，非阻断）；SVG 原图层 base64>2MB 降级占位（对位参考用 render.png）

## ④⑤ 端到端授权链证据（本轮生死线——全通）

| # | 阶段 | 帧 | proposal | grant | consumed |
|---|---|---|---|---|---|
| 1 | stones.add propose→autoApproved→**立即执行** | #450→#451→#453（返回面 autoApproved:true+「立即执行」）→#454→#456→#458（manifest rev2） | `926408bf` | `7e14d3c7` | **1** |
| 2 | set.create propose→autoApproved→执行 | #469→#470→#472-476（resourceId 4c8e3aee） | `11ef5354` | `ea814121` | **1** |
| 3 | strategy v1 propose→autoApproved→**质量否决（有意弃置）** | #530→#531→#534「不执行这份提案（令其过期）」 | `07bac1ca` | `00cb3184` | 0（主动） |
| 4 | strategy v2 propose→autoApproved→**立即执行落档** | #588→#589→#591→#592→#594→#601（1232 钻 layout 生成） | `e7b86c94` | `b2905e59` | **1** |
| 5 | task.export propose→autoApproved→**立即执行** | #605→#606→#608→#609→#611→results 行 | `14dc8450` | `387b0f6c` | **1** |

- 返回面三处均见 b9c2025 新文案：`"autoApproved": true, "pending": "会话自动批准已生效——立即以 {taskId, proposalId} 调用执行（勿等待用户）"`（stones.add #453 / strategy #591 / export #608）；agent 每次都照办（#454/#592/#609 三处叙述完全同构）
- iter-2 断链面反转实证：stones.add grant 从 `auto_approved=1,consumed=0`（iter-2 `0015c7cf`）→ **consumed=1**（iter-3 `7e14d3c7`）
- 新行为（超预期）：agent 对 autoApproved 提案做**内容校验后才执行**——v1 提案发现漏夜空节点（lint B67 unused）即弃置；执行策略时学到「层级节点不产钻」规则，细化夜空底色叶子后重提案。KB「autoApprove 以返回 autoApproved=true 标志为 execute-next 条件」被正确执行且未被滥用

## 三个取证靶子判定

### 靶子A 调用前父掩膜覆盖检查 — **演进达成（单探针+域模型前置；无独立 inspect 前置调用）**
- 域假设一次建立（#186 星位挖孔）后**预测性迁移**：#244 左上翼（「上翼弧区在父掩膜外——同星况」一探即换域）、#297 右翼（「同左翼上羽」）、#559 天空角部（「0001 掩膜大面积是洞——不再纠缠该域」）
- **#372 最干净案例**：小天使手部层——#367 父域 0004 box 探针零新增 → 「父域无手部像素（手在父掩膜外）」按**实际掩膜像素（非 bbox）**判域 → 画布域一击成层
- 对比：iter-2 是「五连败后引 KB 诊断」；iter-3 是「≤1 探针即域切换」。未观察到字面意义的「refine 前先 tree_inspect 父掩膜」独立步骤（inspect 全程 2 次：#133 初树基线、#392 终树校验）——规则以「域推理内化」形态生效

### 靶子B 名实一致 — **PASS（无「袍身」式错配层）**
- 终树 39 节点层名↔segmentPrompt 全一致：部位层用部位级提示（脸←cherub face、袍←white beaded robe、翅←white feathered wing），整体层用整体名（三天使←angel … as a whole）
- box 抠取层落位即语义化（#199「把四个『框选区域』改为语义名」）；v58 将英文 prompt 层更名「夜空底色」
- 边界（披露非错配）：0045 夜空底色为碎片合并层（fill 5.7%），终报如实披露残缺合并事实

### 靶子C precision 落参（iter-2 P1 遗留）— **首次正例，25 次**
- 星路径 #173：明示「实际携带 precision:{confThreshold:0.3}……请求参数已实质变更，非同参重发」→ wire 24×0.3 对上
- 翅膀攻坚顶点 #264：「maskMaxSide 1024→1536 + confThreshold 0.2」→ wire 1×（0.2+1536）对上
- 叙事-参数零背离（iter-1 假宣称 pathology 未复发；iter-2 零使用）——「真正用上 precision」的正例出现，且用于 KB 优先级排位内的正确场景（换域失败后的最后手段）

## 过程质量（同 iter-2 口径）

- **纪律**：变体轮询止损显式化——#271「停止在此措辞上消耗（已 3 次变体）」、#322「停止消耗，接受组合方案」；同参数重发 0 次（strategy 同参重试均为 timeout 失败重试；#173 precision 携带时显式声明非同参）
- **质量门**：树侧 warnings 43 条（no-instance 16 / mask-suspicious-fill 12 / mask-parent-iou 6 / sibling-overlap-consumed 5 / mask-suspicious-aspect 2 / density-cap 1 / depth-cap-unresolved 1）+ lint unused 1（v1 提案，触发质量否决）+ 导出 island 5（iter-2 为 46 条，构成近似但本轮 no-instance 占比高——源于挖孔域攻坚）
- **修树强度**：tree v58（refine 17 / rename 13 / merge 5 / reparent 5 / inspect 2）——介于 iter-1（v64）与 iter-2（v27）之间；首轮 subject_segment 直接 33 元素良构初树，修树集中于翅/星/天空三个 SAM 稀疏纹理难点
- **瞬态故障**：13 次（scene_analyze 2 + strategy_design 11），全部 LLM 供应商侧（GLM-5.3-Flash 只思考不产出/超时/bad-json）；agent 处置链完整：原参重试→压缩指令→英文紧凑→反冗思前缀→查提案状态防半签署；**未构成基础设施故障，不满足重跑条件，零重跑**
- **KB 时机**：kb_list+6 条 kb_get **全部先于 scene_analyze**（iter-2 开局即查的延续+选钻知识一并前装）
- **终报诚实度**：4 处如实披露（羽缘低密度点缀/手层 0 钻/夜空碎片层/导出警告），无「已签发却要求批准」式矛盾叙事

## 与 iter-1/iter-2 对照表

| 指标 | iter-1（6ee4bca） | iter-2（15d4c99+KB 7fd996f） | **iter-3（b9c2025+KB c3bc443）** |
|---|---|---|---|
| 总时长 | 53.2 min | 20.8 min | **99.3 min**（+13 次 LLM 瞬态故障约耗 55 min；故障净时长≈45 min） |
| 帧数 | 567 | 274 | 625 |
| 工具调用 | 81 | 32 | 89 |
| 终树 | v64 · 36 节点 | v27 · 27 节点 | v58 · 39 节点（33 可钻叶） |
| SAM wire | 93 次 | 77 次（全 ok） | 97 次（全 ok） |
| 逐星 | 6/6（fill 均值 52.0%） | 6/6（38.3%） | 6/6（40.1%，六星全 geometry-star 策略） |
| 右天使头 | 脸53.5/发11.5/花环0.7% | 脸55.0/发27.3/花环29.1% | **脸68.2/发27.5/花环27.6%** |
| 小天使新件 | — | 白袍 413px | **手部层 152px（历轮首个）** |
| 花篮 | 12 子件 | 1 整体层 | **8 子件** |
| precision 落参 | 0（+4 假宣称） | 0（假宣称 0） | **25 次（24×conf0.3 + 1×conf0.2+maskMaxSide1536），叙事-参数零背离** |
| 变体轮询 | 1 轮 5 措辞（超限） | 0 次 | 显式止损 2 次（「已 3 次变体」停止） |
| 父掩膜覆盖检查 | 无 | 失败后诊断（1 次） | **域模型前置+单探针切换（≥5 次迁移应用）** |
| 名实一致 | 有「袍身」错配 | 有（Codex 指出） | **无错配层** |
| 授权闭环 | lint 门停摆 | stones.add pending 断链（grant consumed=0） | **5 提案全 autoApproved，4 执行 consumed=1，1 例质量否决** |
| ④ 头发流线 | 提案层 PASS（未执行） | FAIL（未达策略层） | **PASS（hex-thin×3，77/28/26 颗落钻）** |
| ⑤ 分享包 | FAIL | FAIL（无 results/publicId/排钻） | **PASS（/r/pUdHPBkGQjhk · 1232 钻 · BOM 12 行 · 五产物）** |
| 瞬态故障自愈 | 4 次 | 0 次 | 13 次（全 LLM 侧，处置链完整） |
| KB 时机 | 分件后查 | 开局即查（SAM 组） | **全前装（SAM 4 条+选钻 2 条，先于一切分件）** |

## 异常与遗留（下轮建议）

1. **P1｜小天使袍区未排钻**：小天使无独立袍层，整体掩膜（0004，fill 49.1%）含袍区但整体层未指派——身体残余约 600px 级区域零钻。终报披露了手层 0 钻但未点名袍区缺口。属「合理分组」口径边界：若严格满钻需补袍叶子或对 0004 指派。建议任务模板明示小主体是否需身体层。
2. **P2｜strategy.design 的 LLM 侧脆弱性**：14 调用 11 败（GLM-5.3-Flash 长指令超时/只思考不产出），agent 靠 5 级收敛策略（压缩→英文→反冗思→格式微调）自救成功，但耗时约 55 min（占全程 55%）。工程侧可考虑分段指派或服务端重试。此为供应商模型问题而非 daemon 代码问题。
3. **P3｜稀疏羽区 SAM 上限**：左上翼/右内上羽缘多措辞+precision 后仍是羽缘勾线（fill<5%），agent 止损接受并以 1 颗/层点题+袍层珍珠垫底补偿。若产品要求稠密羽感，需 KB 增补「羽状稀疏纹理的骨架化贴法」条目（如沿羽枝方向 along-path）。
4. **P4｜夜空底色碎片性**：0045 为缝隙+四角合并层（fill 5.7%，88 颗 B67 打底）；右缘窄条零检出被披露放弃。原始天空分割的残缺性（首轮挖孔）是根因，域切换已是最优处置。
5. 观察项：导出 island warning 5 条（星点/羽缘单颗）与 SVG base64>2MB 降级——均已在返回面如实分级为非阻断。

## 基础设施自证

- daemon 8317 全程未重启（PID 48184 贯穿任务起止）；SAM 桥 97/97 ok；无基础设施故障，**不满足重跑条件，零重跑**
- 只观察不介入：全生命周期仅创建时的 1 条 followup（创建脚本随发随关 WS，EXIT=0）；DB 访问全程 `mode=ro`（本报告所有 DB 数据均来自只读连接）
- 进程回收：创建脚本 node 即发即退；盯跑 watcher（bash 循环）两段共 34+65 min 后随任务终态自然退出（exit 0）；`ps` 自证见 report 末尾附注
- 存档不含对既有会话的任何写操作；iter-0/1/2 目录未触碰
- 图片：任务指定 JPG 的无损 PNG 转换件与 iter-1/2 字节一致（sha256 `6267829d…` 复核），blobRef 相同，严格可比

## 附件

- `create-result.json` — 会话/任务/blob 元数据
- `raw-assistant-transcripts.md` — assistant/工具往返转录全文
- `raw-tool-timeline.md` — 全量工具调用时间线（CALL/RESULT 逐帧）
- `raw-watch-log.txt` — 90s 间隔盯跑原始日志（02:05:09Z→终态；中段 03:03-03:10 观察者重启间隙由手动探针补齐，frames.jsonl 为完整主证据）
- `transcript-excerpts.md` — 关键决策段策展（授权链全证据/覆盖检查/precision/名实一致/纪律）
- `tree-v58-final.json` — 终树快照（blob `81bf1e29…`，v58）
