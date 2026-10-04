# iter-2 — 出循环修复后的第二轮 Agent 实跑

> add-sam-playbook 迭代 2。8317 daemon 已换装 commit `15d4c99`（strategy.design/task-export 授权反馈走 approvalFaceOf + lint 分级文案 + tree_refine steps precision 全链透传）；KB 带 iter-1 审查八条调整（独立仓 `7fd996f`）。
> 本轮独立新会话，未触碰任何既有会话（尤其 iter-1 会话 `e02ab697`）。全程只观察零介入——仅首发一条 followup（autoApprove=true），WS 随即关闭，无第二条消息。DB 全程 mode=ro。无重跑：任务 20.8 分钟自然终态 done。

## 会话与任务

| 项 | 值 |
|---|---|
| daemon | 127.0.0.1:8317（PID 41319，cwd `贴钻-backend/daemon`，commit **15d4c99**，09:09:27 启动＞commit 09:08:59——确在修复版上；全程未重启） |
| KB | DATA_ROOT/knowledge 独立仓 @ `7fd996f`（八条调整版七件套） |
| 用户 | 匿名（`__anonymous__`，新 token 新会话） |
| 会话 | `411b0686-6731-4bf5-a473-90a52eef5a63`（title=「右天使 · 左天使（24 区域）」项目名派生，auto_approve=1 持久化实证） |
| 任务 | `3b348bb8-82ac-44a4-b332-91a33cdf78dc`（type=agent） |
| 图片 | 同一 PNG 字节（blobRef `6267829d…` 与 iter-1 完全一致，2,984,658 B） |
| 创建路径 | POST /api/auth/anonymous → WS /ws/rpc（RPCLink）→ assets.upload → session.create → session.followup（冻结指令一字不改+20×20cm 表单参数行+attachments 单图+autoApprove=true） |
| 时间窗 | 2026-10-04T01:12:05.688Z → 01:32:51.715Z（**20.8 min**，自然终态 done） |
| 帧统计 | 274 帧：transcript 81 / progress 67 / artifact 59 / activity 64 / approval-request 1 / approval-resolved 1 / done 1 |
| 工具调用 | 32 次（studio MCP 31 + todo_write 1）：tree_rename 8 / tree_reparent 5 / kb_get 4 / tree_merge 3 / tree_refine 3 / task_stones_list 2 / tree_inspect 2 / kb_list·scene_analyze·subject_segment·task_stones_add·todo_write 各 1 |
| SAM 桥调用 | 77 次 wire 请求全部 outcome=ok（geometric 24 + text 53）；**strategy_design 0 次、task_export 0 次** |
| 审批 | 1 个 proposal（studio.task.stones.add `bf11048a`）自动签发（#270 autoApproved=true；grants 行 auto_approved=1，**consumed=0**） |

## 验收五条逐条（含数字）

### ① 三天使完整成层 — **PASS（历轮最完整，无披露性缺口）**
终树 v27（27 节点；26/26 非画布节点 segmentPrompt 非空）：

- 左天使（6 子）：脸 71×99 **fill 66.9%**（4700px）/ 卷发 121×145 **50.9%** / 珍珠袍 94×55 35.7% / **翅 130×200 37.9%（独立层——iter-1 为碎片<1% 并入组，治愈）** / 袍身 40.1% / 冬青花环 70×40 **35.1%（本轮新补）**
- 右天使（6 子）：脸 87×94 **55.0%**（4497px）/ 卷发 148×128 **27.3%**（5172px）/ 白袍 109×189 **47.9%** / 翅 125×219 **47.4%** / 花环 122×56 **29.1%（iter-1 花环 fill 0.7%/37px，治愈）** / 袍身 30.1%
- 中间小天使（3 子）：脸 81×49 48.7% / 头发 97×55 35.2% / **白袍 20×57 36.2%（413px——iter-1 放弃项（9×6 碎片），本轮虽小但成层）**

对比基线：iter-0 右天使头=条带 4.6% → iter-1 脸+发 → **iter-2 脸/发/花环/翅/袍五件全齐且花环非碎片**。

### ② 背景六星逐颗成层 — **PASS（6/6）**
6 个独立星叶（挂夜空背景下）：星星一 24×29 **36.9%** / 星二 27×24 **54.3%** / 星三 27×22 **22.2%** / 星四 33×31 **32.1%** / 星五 33×39 **29.9%** / 星六 37×33 **54.5%**。全部非退化（最小 132 setpx）。fill 均值 38.3% vs iter-1 均值 52.0%——略低但均非碎片。
路径叙事（与 iter-1 同病同药，但本轮是**诊断驱动**）：首轮 instances 枚举未用，仅星六成层 → 夜空域 box+hint 五连全 no-instance → #170 引用 KB《部位拆分与层级》确诊「星星像素不在背景层掩膜域内」→ 同五步改画布根节点 5/5 命中 → reparent 回夜空下+方位命名。

### ③ 花篮完整 — **PASS（粒度回退为整体层）**
「圣诞装饰花篮花环组合」单层 498×165 fill 42.7%（35064px），未拆散。对比 iter-1 的 12 子件（4 蝴蝶结+3 浆果+3 圣诞球+2 松枝）——本轮**未做子件拆分**，「完整」达成但粒度粗一档（硬性要求只说「花篮完整」，判 PASS）。

### ④ 头发流线贴法 — **FAIL（未达提案层）**
strategy_design 全程 0 次调用——任务停在 stones.add 授权门，未产生任何策略指派（iter-1 尚有 dea5fcfc 提案层 hex-thin 三片）。三天使卷发层已在树（fill 27-51%），但贴法/密度指派不存在。

### ⑤ 分享包导出 — **FAIL（阻断点前移）**
无 task_export 调用、无 results 行（DB 查证空）、无 publicId、无排钻、总钻数 N/A。任务终止于 **studio.task.stones.add 的提案 pending 面**——见下「靶子⑤」。

## 四个改进靶子逐项判定（本轮核心考察）

### 靶子⑤ 导出闭环 — **FAIL：阻断点从 strategy.design 前移到 stones.add**
- 时间线：#266 树校验通过 → #268 一次性 task_stones_add 20 款（色域规划合理）→ #269 approval-request → **#270 approval-resolved autoApproved=true（grant 同秒签发）** → #272 工具结果 pending 面返回：`"pending": "等待用户批准（approval-request 已入任务帧流）——先与用户讨论确认要纳入项目的钻；批准后以 {taskId, proposalId} 执行…"`（**无 autoApproved 字段、无「立即执行」指令**）→ #273 agent 终报「⏸ 待批准……请在会话中批准该提案」→ #274 done
- DB 实证：grant `0015c7cf` auto_approved=1、**consumed=0**——授权已在，执行永未发生
- **根因归属（代码级）**：15d4c99 的 approvalFaceOf 只修了 strategy.design 与 task-export 两个返回面；stones.add 面按提交说明**刻意未动**（「autoApprove 覆盖=产品政策 Owner 决策中」）。修复本身有效——但 agent 本轮走到这两个已修面**之前**就先撞上了未修的 stones.add 面（iter-1 的 lint 文案让它在 strategy 阶段停；修复后 unintroduced=warning 的分级指引让它正确地提前走 stones.add 纳钻，于是更早地停在 stones.add 的旧 pending 文案上）
- 附带行为学改善：agent 终报与授权实态**不再自相矛盾**——它如实说「提案已签发，进入用户审批帧」（iter-1 一边说已签发一边要求用户批准已 autoApprove 的提案）；但「免值守会话里停在人工门」这一行为本身仍未解决
- lint 分级文案：strategy lint 本轮**未被触达**，unintroduced=warning 的返回面呈现无从观测；分级语义只在工具描述/KB 文本中出现

### 靶子② precision 落参 — **未复发背离，但也未使用：wire 77/77 confThreshold=0.4，maskMaxSide 0 次**
- 叙事面：agent **零次**宣称「降阈值/升精度」（iter-1 为 4 次假宣称）——KB 铁律「叙事不等于参数生效/说了没带=没做」（#11 kb_list 结果、#104 失败信号对照表均有明文）成功压制了空叙事
- 参数面：唯一决策点在星星 no-instance 警告（#169 给出「换措辞/降 confThreshold/正框聚焦」三选项）——agent 按 KB 优先级选择「换域重发」（画布根），precision 全程无人携带。**叙事-参数背离治愈的判据是「不再假宣称」，而「真正用上 precision」仍无正例**——该能力（含 15d4c99 的 TreeRefineStep 全链透传）在真实攻坚路径中依旧 0 落参
- 注：wire 日志里 6 个提示词各重复 3 次为 subject_segment 服务内建语义梯自动重试（单次调用、无 prompt 清单输入、progress「本片回放 4 + 实跑 66」），非 agent 层同参数重发

### 靶子③ 纪律遵守 — **PASS（三条全守）**
- **变体轮询 ≤2-3**：措辞变体 0 次（iter-1 为 1 轮 5 措辞）——同 hint「bright white star」复用全部伴随不同 box 锚定，属框选非轮询；无违规
- **同参数重发**：无。#157→#172 五步字面相同但 nodeId 从夜空换到画布（掩膜域=处方变量），且 #169 失败后未在原域重试
- **refine 前父掩膜覆盖检查**：显式执行且引用 KB 原文（#170「星星像素不在背景层掩膜域内……KB 明确处方：目标不在父掩膜内时，先在画布根/更大层级上发」）——iter-1 审查指出的「应更早检查父节点覆盖范围」行为缺口本轮闭合
- 附带：开局即 kb_list（iter-1 是分件后）；首轮后主动 tree_merge×3 清掉 4 个「部分N」残留节点（IoU=1.0 复制/泄漏条带）——iter-1 遗留垃圾节点问题自愈

### 靶子④（过程质量，同 iter-1 口径）— 稳定
- 瞬态故障 **0 次**（iter-1 为 4 次 UNAVAILABLE 自愈）——本轮无 LLM 超时/坏 JSON
- 质量门 warnings 全程 46 条：sibling-overlap-consumed 20 / mask-suspicious-fill 6 / mask-suspicious-aspect 6 / mask-parent-iou 6 / no-instance 5 / depth-cap-unresolved 2 / density-cap 1（iter-1 为 41 条，构成近似）
- 预览回流：agentImagePreviews 帧 1 + tree 工具 previewBlobRef 若干；#100/#121 预览参与决策（「碎片膜 部分2（3421px）预览里正是星星残片」）
- 修树强度：tree v27，tree_refine 3 / rename 8 / reparent 5 / merge 3 / inspect 2（iter-1 为 v64：refine 19 / rename 12 / merge 9 / reparent 4）——**修树强度大幅下降**，主因是一次 subject_segment 直接出 24 区域良构初树+两轮 refine 即达标，无需 iter-1 式的反复攻坚

## 与 iter-1 对照表

| 指标 | iter-1（6ee4bca） | iter-2（15d4c99+KB 7fd996f） | Δ |
|---|---|---|---|
| 总时长 | 53.2 min | **20.8 min** | -32.4（星星/右头攻坚轮数骤减） |
| 帧数 | 567 | 274 | -293 |
| 工具调用 | 81 | 32 | -49 |
| 终树 | v64 · 36 节点 | v27 · 27 节点 | 修树强度大降（refine 19→3） |
| SAM wire | 93 次 | 77 次（全 ok） | -16 |
| 逐星 | 6/6（均值 fill 52.0%） | 6/6（均值 38.3%，全非退化） | 持平（画布域换发路径两轮同构） |
| 右天使头 | 脸53.5/发11.5/花环0.7% | 脸55.0/发27.3/**花环29.1%** | 花环治愈 |
| 左翅 | 碎片并入组 | **独立层 37.9%** | 治愈 |
| 中袍 | 放弃（9×6） | 成层（20×57） | 改善 |
| 花篮 | 12 子件 | 1 整体层 | 粒度回退（判 PASS） |
| KB SAM 组调用 | 5 次（分件后查） | 4 次（**开局即查**，处方直接落地） | 时机前置（八条调整生效） |
| instances / excludeBox | 3 / 1 | **0 / 0** | 未用（无对应场景，星星走换域+框选） |
| precision 落参 | 0（+4 次假宣称） | 0（**假宣称 0**） | 背离治愈，能力仍未被用 |
| 变体轮询 | 1 轮 5 措辞（超 2-3 限） | 0 次 | 守纪 |
| 父掩膜覆盖检查 | 无（Codex 指出） | **显式执行并引 KB** | 靶子闭合 |
| 瞬态故障自愈 | 4 次 | 0 次 | 更稳 |
| 停摆门 | strategy lint 门+pending 矛盾叙事 | **stones.add pending 面**（grant 已签未消费） | 阻断点前移，叙事不再矛盾 |
| ④ 头发流线 | 提案层 PASS（hex-thin×3） | FAIL（未达策略层） | 回退 |
| ⑤ 分享包 | FAIL | FAIL（无 results 行/publicId/排钻） | 同败异因 |

## 异常与遗留（下轮出循环修复建议）

1. **P0｜stones.add 授权面是新的免值守断链点**：autoApprove 会话里 grant 自动签发（auto_approved=1）但返回面仍是「等待用户批准」——agent 服从文案停摆，grant consumed=0 过期作废。15d4c99 已注明该面是 Owner 待决产品政策；本轮实证其**在免值守链路上先于两个已修面被触达**，不解决它，approvalFaceOf 修复在「智能选钻」主路径上不可达。可选修法（同 approvalFaceOf 模式）或产品政策明确「stones.add 不自动批」并让文案如实说「本提案需人工批准，批准前可继续无钻操作」。
2. **P1｜precision 仍无正例**：修复后链路可用（契约→treeRefine→segmentOne→wire），但 agent 在唯一决策点选择了 KB 优先级更高的「换域」路径。若无场景逼出降阈值，该能力将继续 0 落参——考虑在失败信号对照表里给出「换域失败且框选也零检出时，precision 是最后手段」的显式排位。
3. 花篮粒度回退（12 子件→整体层）与星星 fill 均值下降（52.0→38.3%）：均为单轮采样的自然波动，非工具面回退；花篮是否需子件级拆分属验收口径问题（「完整」vs「分件」），建议在任务模板中明示。
4. 一次性偏差：本轮星星六的 segPrompt 为首轮遗留措辞（'bright white star in night sky'）与其余五星不一致——纯整饰遗漏，无功能影响。

## 基础设施自证

- daemon 8317 全程未重启（PID 41319 贯穿任务起止）；SAM 桥 77/77 ok；无基础设施故障，**不满足重跑条件，零重跑**
- 只观察不介入：全生命周期仅创建时的 1 条 followup（创建脚本随发随关 WS）；DB 访问全程 `mode=ro`
- 进程回收：创建脚本 node 进程即发即退（EXIT=0）；盯跑 watcher 已正常退出；`ps` 自证无残留（本轮唯一起过的常驻进程=watcher bash 循环，已终止）
- 存档不含对既有会话的任何写操作；iter-0/iter-1 目录未触碰

## 附件

- `create-result.json` — 会话/任务/blob 元数据
- `raw-assistant-transcripts.md` — assistant/工具转录全文
- `raw-tool-timeline.md` — 32 次工具调用时间线
- `raw-watch-log.txt` — 90s 间隔盯跑原始日志（含帧数/状态演进）
- `transcript-excerpts.md` — 关键决策段策展摘录（含 stones.add 终局全证据链）
- `tree-v27-final.json` — 终树快照（blob `ecf540cb…`）
