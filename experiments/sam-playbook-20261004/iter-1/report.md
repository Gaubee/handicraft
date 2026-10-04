# iter-1 — 三天使图新会话实战（升级后首轮 Agent 实跑）

> add-sam-playbook 迭代 1。8317 daemon 已换装 commit `6ee4bca`（subject.segment/tree_refine 新参数 + MCP 策略指引 + 知识库「SAM 提示词策略」组七条目）。
> 本轮独立新会话，未触碰任何既有会话（尤其「天使组」cd43f4fa）。全程只观察零介入（autoApprove 创建态=免值守，复刻基线会话有效态）。
> 存档说明：任务简报写的目录名 `sam-playbook-20260904` 为笔误，实际沿用 iter-0 所在的 `sam-playbook-20261004/`。

## 会话与任务

| 项 | 值 |
|---|---|
| daemon | 127.0.0.1:8317（PID 25784，`贴钻-backend/daemon`，commit 6ee4bca） |
| 用户 | 匿名 `f00ff3eb`（`__anonymous__`，与基线同幂等行） |
| 会话 | `e02ab697-192e-441a-aa60-81778d57f06b`（新开，title=指令首行 24 字派生，titlePinned=false） |
| 任务 | `5eb9826d-4329-4e12-95cd-e0084610f6ad`（type=agent） |
| 图片 | `微信图片_20260921172653_27_485.jpg` → sips 归一 PNG 1280×1280（2,984,658 B；blobRef `6267829d…`）——与基线同像素内容（基线 blob 3,757,148 B 为浏览器 canvas 编码） |
| 创建路径 | POST /api/auth/anonymous → WS /ws/rpc（RPCLink）→ assets.upload → session.create → session.followup |
| 首发消息 | 冻结指令一字不改 + 表单参数行（`画布尺寸：20×20 cm` / `用钻：智能选钻…`，buildNewTaskFirstMessage 同式）+ attachments 单图 + autoApprove=true |
| 时间窗 | 2026-10-03T23:46:10.578Z → 2026-10-04T00:39:22.650Z（**53.2 min**，自然终态 done，无重跑） |
| 帧统计 | 567 帧：artifact 134 / transcript 207 / activity 162 / progress 59 / approval-request 2 / approval-resolved 2 / done 1 |
| 工具调用 | 81 次（studio MCP 77 + todo_write 4） |
| SAM 桥调用 | 93 次 HTTP 请求（10-03 目录 55：35 geometric 点+框 + 20 text；10-04 目录 38：box+text 20 / 纯 box 17 / excludeBox+box+text 1），全部 outcome=ok，wire confThreshold 恒 0.4；账本 `5d50d3b7e550fafa` 54 条掩膜 |
| 审批 | 2 个 proposal 均自动签发（2ff3bdb2@00:33:33Z、dea5fcfc@00:38:49Z，autoApproved=true——grants 表实证） |

## 验收五条逐条（含数字）

### ① 三天使完整成层 — **PASS**（两处披露性缺口）
终树 v64（36 节点；35/35 非画布节点 segmentPrompt 非空）：

- 左天使：脸(81×79, fill 37.0%) / 卷发(125×128, 37.3%) / 花环(92×45) / 白袍(165×239, 58.1%)——**无独立翅**（碎片 <1% 并入组，agent 披露）
- 中天使：脸(74×55, 76.3%) / 卷发(95×66, 26.3%) / 花环(61×29)——**无独立袍**（白上白 SAM 碎片 9×6，agent 放弃并披露）
- 右天使（基线短板位）：**脸 70×87 fill 53.5%（3261 px）/ 卷发 115×107 fill 11.5%（1410 px）/ 花环 80×65 fill 0.7%（37 px，碎片层保留）/ 翅 128×347 fill 29.0% / 袍 148×217 fill 31.9%**——头部三件链存在，脸/发掩膜非退化
- 对比基线：iter-0 右天使头=「头冠与头发」细条带 fill 4.6% 仅 9 颗 → iter-1 脸+发实掩膜（花环仍弱，为本轮遗留）

### ② 背景六星逐颗成层 — **PASS（质变）**
6 个独立星节点，掩膜全非退化：

| 节点 | bbox(500px 系) | fill | 提取方式 |
|---|---|---|---|
| 星星·左上 | 61,6 26×21 | 36.8% | `star[instance-6]`（instances='all' 枚举唯一存活） |
| 星星·顶部中央 | 219,2 42×44 | 72.6% | 纯 box（画布节点） |
| 星星·右上 | 462,41 36×44 | 32.6% | 纯 box |
| 星星·左侧 | 37,127 23×21 | 44.7% | 纯 box |
| 星星·右侧 | 468,137 30×36 | 44.8% | 纯 box |
| 星星·右上角 | 475,2 25×30 | 80.3% | 纯 box |

**对比基线：iter-0 = 整片夜空掩膜 35 颗 6 簇不可逐颗 → iter-1 = 6/6 逐颗独立成层。** 路径叙事：instances='all' 仅活 1 颗 → 夜空节点内 box×5 + 变体轮询 + 纯 box 全零检出（no-instance）→ 诊断出「夜空掩膜只覆盖局部天空」→ 改在**画布节点**上纯 box 5/5 成功。

### ③ 花篮完整 — **PASS**
松枝花环组（12 子）：蝴蝶结×4 + 浆果簇×3 + 圣诞球×3 + 松枝×2（`green pine branch` instances='all' 得 instance-1/2，407×164 fill 33.4%）。对比基线（28 区域组）同粒度量级。

### ④ 头发流线贴法 — **PASS（提案层）**
策略提案 dea5fcfc：三片卷发（左/中/右）均指派 `texture-fill/hex-thin` densityPerCm2=7，钻 98-727（#E0CA54 金黄 3mm）。

### ⑤ 分享包导出 — **FAIL**
任务止步于策略提案批准门 + 钻 lint 门（「8 款钻未引入项目（先与用户确认，再经 studio.task.stones.add 纳入）」）。无排钻、无 results 行、无 publicId、无总钻数（N/A）。

## 新能力使用证据（本轮核心考察面）

| 能力 | 使用次数 | 明细 |
|---|---|---|
| kb_list | 1 | #87（初轮分件后发现缺口，主动枚举知识库） |
| **kb_get「SAM 提示词策略」** | **5** | #96 计数与实例枚举 / #100 部位拆分与层级 / #104 失败信号对照表 / #160 背景反选 / #164 排除区与点微调（另有跨组：#212 工艺规则·可读下限 24 颗、#545 密度与单位·baseDensityPerCm2 公式；合计 kb_get 7） |
| instances='all' | 3 | #124 星星枚举（存活 1/6）、#169 星星低阈值重枚举（重复命中去重）、#441 松枝（2 实例全中） |
| excludeBox | 1 | #273 `head` + excludeBox(195,150,105,165) 排除中间天使——命中右脸区域但碎片化 4.13%，随后转紧框路径成功（修漏场景实证：定向有效但不足以解决碎片） |
| 纯 box 步骤 | wire 17 次 / 7 次调用 | #176 诊断（夜空内零检出→确诊掩膜覆盖问题）、**#191 画布 5 星全中**、#259/#280 右头紧框三连（脸+发成）、#393/#400 左翼、#428 中袍 |
| 变体轮询 | 1 轮 5 措辞 | #146 bright/four-pointed/glowing/sparkling/twinkling star（同框换词，全零检出）；另 #340 `green holly leaves` 换词单发 |
| confThreshold/precision 落参 | **0 次** | 叙事 4 处宣称「降阈值/升精度」（#144/#167/#264/#278）但参数均未携带——wire 恒 confThreshold=0.4。**叙事与线格式背离，是本轮最重要的行为学发现**（成功靠紧正框而非阈值） |

## 过程指标与自愈

- 失败自愈 4 次（全 UNAVAILABLE，同轮自恢复，零人工）：#12 scene_analyze llm-bad-json（重试收敛指令成功）；#467 strategy 992>200 超限（族分布探测收窄）；#530 strategy LLM 超时（重试）；#535 strategy 无正文（精简指令后成功）
- 质量门 warnings（全尝试累计 41 条）：no-instance 17 / mask-suspicious-fill 16 / mask-suspicious-aspect 2 / sibling-overlap-consumed 2 / child-consumed 2 / density-cap 1 / depth-cap-unresolved 1
- 掩膜预览回流：9 帧含 agentImagePreviews（基线 6）；agent 多处以预览为决策依据（#257「预览图确认…两张脸并成一个实例」、#278「预览显示掩膜确实命中右天使面部区域」）
- 树版本 64（基线 36）；修树工具面：tree_refine 19 / rename 12 / merge 9 / reparent 4 / inspect 2
- 策略分布（dea5fcfc，31 指派）：texture-fill×25（hex-thin×3 头发、hex-pitch 显式×4、引擎默认×18）+ geometry×6（六星，白 111，density 4）；候选 192 款

## 与 iter-0 基线对照表

| 指标 | iter-0 基线 | iter-1 本轮 | Δ |
|---|---|---|---|
| 总时长 | 39.0 min | 53.2 min | +14.2（多花在星星/右头攻坚 8 轮） |
| 帧数 | 439 | 567 | +128 |
| 终树 | v36 · 32 节点 | v64 · 36 节点 | 修树强度近乎翻倍 |
| 逐星 | 6 簇不可逐颗（35 颗兜底） | **6/6 逐颗成层** | 质变（升级直接靶子命中） |
| 右天使头 | 条带 fill 4.6% · 9 颗 | 脸 53.5% + 卷发 11.5% + 花环 0.7% | 大幅改善（花环仍弱） |
| segmentPrompt 覆盖 | 31/31 | 35/35 | 持平满分 |
| KB SAM 策略组调用 | 组不存在 | 5 次（+2 跨组） | 新能力 |
| instances / excludeBox / 纯 box | 0 / 0 / 0 | 3 / 1 / 17(wire) | 新能力全用上 |
| precision 落参 | 0 | 0（叙事 4 处未落参） | 未改善 |
| 分享包 | /r/XNn0c64ChYEM · 531 颗 | **无**（停在审批+lint 门） | 回退 |

## 异常与遗留

1. **⑤ 失败根因链**：策略 lint「8 款钻未引入项目，先与用户确认」是设计内人工门；叠加 agent 终报语义混乱——#561 已确认提案「已签发」（grants 表 autoApproved 实证），#566 终报仍要求用户「在审批帧中批准 dea5fcfc」。即：免值守会话里 agent 把 lint 门当作硬停点，且对自动签发状态叙述自相矛盾。**未排钻、未导出。**
2. **confThreshold 叙事-参数背离**（见上表）：KB 对照表教了「漏检降 confThreshold」，agent 复述了 4 次但从未真正传参——工具描述/KB 措辞与参数落点之间存在认知断点，建议下轮审查 MCP 工具描述中 precision 参数的显著性。
3. 右天使花环 fill 0.7%（37 px）与中袍/左翅放弃项——SAM 在 500px 珠绣纹理下的固有限制，agent 已如实披露（终报三条限制）。
4. 一次性偏差：目录名 20260904→20261004（简报笔误，已在本文头注明）；图片经 sips 而非浏览器 canvas 转 PNG（同像素、不同编码器，blob 字节不同于基线）。

## 基础设施自证

- daemon 8317 全程未重启（任务起止于同一 PID 25784 会话期）；SAM 本地服务 `sam3-image-f16@0.1.0`，93/93 请求 ok
- 无重跑：任务自然终态 done，不满足「基础设施故障崩死」重跑条件（4 次 UNAVAILABLE 均为 agent 自愈的瞬态 LLM 故障）
- 存档不含对既有会话的任何写操作（DB 全程 mode=ro；WS 仅本会话域内 create/followup）

## 附件

- `create-result.json` — 会话/任务/blob 元数据
- `raw-assistant-transcripts.md` — assistant 全文转录
- `raw-tool-timeline.md` — 81 次工具调用时间线
- `transcript-excerpts.md` — 关键决策段策展摘录（Codex 审查输入）
- `tree-v64-final.json` — 终树快照（blob 56084d… 的 JSON）
