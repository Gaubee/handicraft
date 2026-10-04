# T7a — live 旗舰回归（provider 未配置态全链）· add-flat-aux-segmentation T1-T6

> 8317 daemon @ **ba20c68**（T1 风格检测/T2 参考图层编排/T3 四图引用/T4 双通道+归属门/T5 导出原图门/T6 工作台条目/路由 sweep；PID 66748，2026-10-04 22:23:28 启动，全程未重启）。KB 独立仓 @ **b35032e**（=f6f0f15+bbox 归属核对判据）。图=三天使原版微信图 photographic（sips 转 PNG，blobRef `6267829d…` 与 iter-1/2/3/4 逐字节一致）。冻结指令+20×20cm 表单行+autoApprove=true+盲测，全程只观察零介入，DB mode=ro。
> **headline：前置三验全命中（style=photographic → #18 typed 软回退警告帧 → 工作画布 500×500）；验收五条全 PASS；归属门 4 条 attribution-gaps 明细留痕+被 agent 显式披露；导出原图门 source.img 字节=上传 blob 恒等。分件与 iter-4 同构性成立但有显著战术差异（夜空满铺底/中袍 60 钻/六星密铺——归因见 §对比）。**

## 0. run1 意外发现：原版 JPEG 字节 = S0 管线级死链（产品缺陷，移交 Owner）

按简报上传原版微信 JPG 字节（274101B）→ agent 三面探测全被拒：scene_analyze `image-decode-failed（仅支持 PNG——S0 归一面）`（#9-11）/ subject_segment elements 直注同拒（#27-29）/ pave-preview 同拒（#32-34）。根因（代码实证）：`scene-analyze.ts:427-433` 的 `decodePng` 在 `applyIntakeResample` **之前**——JPEG 永远到不了归一面。agent 无文件转换工具，6.3 分钟诚实终报终态 done 零分件（转录存档 `jpeg-deadlink-run/`）。
**定性**：上传面接受任意格式 ↔ 视觉管线 PNG-only 的管线级不兼容——实验目的（style 触发）无法达成，构成基础设施故障，按铁律**豁免重跑 1 次（已用）**。run2 恢复历轮口径（sips 转 PNG，sha256 `6267829d…` 与 iter-4 逐字节一致）。建议：上传面转码归一或显式拒收+提示，而非入会话后死链。

## 会话与任务（run2）

| 项 | 值 |
|---|---|
| daemon | 127.0.0.1:8317（PID 66748，ba20c68 贯穿 run1+run2 未重启） |
| KB | DATA_ROOT/knowledge @ b35032e |
| 用户 | 匿名（`__anonymous__`，新 token 新会话） |
| 会话 | `2c37154f-a88b-4983-a275-609c56fabb6e` |
| 任务 | `34260f3e-603f-43f9-809d-910a42c53d65`（type=agent；run1 死链任务 `65766bd3-b1e8-46be-9511-0b079254c1fe` 另档） |
| 图片 | blobRef `6267829d…` 2,984,658B（=iter-1/2/3/4 同字节） |
| 创建路径 | POST /api/auth/anonymous → WS /ws/rpc（RPCLink）→ assets.upload → session.create → session.followup（冻结指令一字不改+表单行+autoApprove=true）；脚本即发即退 EXIT=0 |
| 时间窗 | 2026-10-04T14:35:20.182Z → 17:08:40.479Z（**153.1 min** 自然终态 done；其中 LLM 提供端故障拖延约 60-70min，见异常 2） |
| 帧统计 | 743 帧：transcript 307 / activity 238 / artifact 120 / progress 58 / approval-request 9 / approval-resolved 9 / log 1 / done 1 |
| 工具调用 | 119 次（studio MCP 115+todo_write 4）：strategy_design 26 / stones_list 20 / stones_search 19 / tree_rename 11 / tree_reparent 10 / tree_refine 9 / task_stones_add 6 / scene_analyze 2 / tree_inspect 2 / set_create 2 / task_export 2 / kb_get 2 / kb_list 1 / subject_segment 1 / task_proposals_list 1 / task_stones_list 1 |
| SAM 桥 | 81 次 wire 全 outcome=ok；confThreshold 非默认 9 次（0.3×1 / 0.25×8——集中在星域攻坚段，叙事↔wire 零背离）；maskMaxSide 0 次 |
| 审批 | 9 提案全 autoApproved=true；grants 9 行 **8×consumed=1 + 1×consumed=0**（e24102e8 不完整指派方案被 agent 主动弃置——#454 拒绝执行漏指派夜空/花环/金发三大面） |
| 瞬态故障 | LLM 提供端 20 次（strategy_design 19 fail：超时为主+坏 JSON+思考块吃满+stoneIdx 格式自纠；scene_analyze 1 bad-json）；daemon/SAM 桥零故障 |

## 前置三验（DB 只读，首帧后查）

1. **scene-analysis style=photographic ✓** — 工件帧 #17（blob `d2a8a7ea…`）`"style":"photographic"`，30 元素六星逐颗列出，分析锚 500×500/e8a00855。
2. **reference-image 软回退 ✓** — 帧流 #18（log，紧随 #17、S3 前）：`[参考图层] reference-image-unconfigured：image-edit 路由未配置（后台模型设置需一条 api=openai-image-edit 且带密钥的路由）——参考图层生成跳过，分件回退原图`。工件面 **reference-image.png / reference-image-report.json 双缺席**（未配置态在源图读取前返回）。DB settings.models_routes 仅 zai-api/anthropic-messages 一条对话路由。**agent 在 #21 叙述感知并正确转述**（「参考图层未配置（image-edit 路由缺），分件回退原图」）——软回退对 agent 透明且不阻塞。
3. **工作画布 500×500 ✓** — intake-image.png（#10/#16 幂等同锚，blob `e8a00855…`）PNG 实测 500×500/738260B（1280 上传→20cm×25px/cm 规范网格）；scene-analysis 与终树 v44 声明一致，ppm 2.5。

## 验收五条逐条（含数字）

### ① 三天使完整成层 — PASS
终树 v44（36 节点=画布+7 组+29 叶[27 产钻+2 exclusion]）：
- **左天使**（4 直接子+左头发容器 2 子）：脸 11 钻（68.8% fill 同族位） / 金发 6 / 冬青花环 9（#226 主动补拆——右有左无的对称性核对）/ 翅膀 83（flow）/ 长袍 27（37.2% fill）
- **右天使**（5 叶齐）：脸 10 / 头发 7 / 冬青花环 18（45.6%）/ 翅膀 7（flow）/ 长袍 **172**（55.3% fill）——头部三层全，脸在
- **中间小天使**（3 叶）：脸 27（68.8%）/ 头发 6（25.9%）/ **长袍 60（69.1% fill，8139px）**

### ② 背景六星逐颗成层 — PASS（6/6 全出钻 culled=0，fill 均值 53.4%）
六独立产钻叶（inline 掩膜实测）：中上大星 41×37 48.5%（7 钻）/ 左上 26×21 36.8%（3）/ 左上角 50×57 **75.4%**（24）/ 顶部中 53×49 **78.6%**（23）/ 右上 36×38 31.1%（3）/ 左缘 37×45 50.0%（8）——合计 68 颗星钻。攻坚链（历轮最深）：S2 识别 5 颗→细分 4 box 零检出+泄漏碎屑膜→泛称「bright star」1 颗→**#151 KB《失败信号对照表》诊断「星=背景掩膜孔洞，refine 只在父掩膜内枚举」→画布层提升发 4/4 命中→归位背景子树**→#138 树实测 bbox 对照补齐第 6 颗。策略层六星 texture-fill 密铺（d8>夜空 d7 抢树序先铺）——#704 六星 culled 全 0。

### ③ 花篮完整 — PASS（7 子件）
底部松枝花环组 7 子：松枝体 213 钻（42.1% fill）+ 蝴蝶结×4（6/7/8/11）+ 装饰球×2（3/5）。（iter-4 为 17 子 instance 枚举——粒度差异见 §对比归因）

### ④ 头发流线贴法 — PASS（策略+排钻双实证）
三发全部 `texture-fill mode=flow`：左金发 Q154 浅金 6 颗 / 中发 DT-11 金棕 6 / 右发 204-3772 深棕 7（终报「浅金→金棕→深棕渐变」；BOM Q154=6+DT-11=6+204-3772=7 对上）；翅膀/长袍/松枝/蝴蝶结亦 flow。

### ⑤ 分享包导出 — PASS
- 授权：#721 approval-request `studio.task.export`（1172 钻/27 分件/11 物料/BOM 11 行/五产物/1 条警告不阻断）→ #722 autoApproved → grant `e451f650` consumed=1
- results 行：**publicId `aXMPb8THHBcP`** · title「任务导出 image-1（1172 钻）」· 2026-10-11 过期
- bundle 7 文件实存：layout.svg 2.80MB / render.png 3.90MB / numbered.png 831KB / holes.png 169KB / bom.csv / bundle.json / source.img 2,984,658B
- BOM 11 SKU 合计 **1172**：PC-10-3 408（夜空）/ 3770 259（袍翅白）/ 3818AB 213（松枝）/ PW-3 158（星）/ 225 48（脸肤）/ DT-06 32（蝴蝶结）/ PC-08-3 27（花环绿）/ Q014 8 / 204-3772 7 / DT-11 6 / Q154 6
- 版型校验 0 异常（layoutAlignment 抽样 200 anomalies=0）

## 授权链证据

| # | 阶段 | 帧 | proposal | grant consumed |
|---|---|---|---|---|
| 1 | set.create 生产组合 34 款 | #438→#439 | `1d38c6de` | **1** |
| 2 | strategy v1（25 节点，**agent 拒绝执行**——漏指派夜空/花环/金发） | #450→#451 | `e24102e8` | **0（完整性弃置）** |
| 3 | strategy v2（29 节点全覆盖，LLM 故障期签发） | #535→#536 | `c493e853` | **1** |
| 4 | task.stones.add 11 款 | #640→#641 | `87814077` | **1** |
| 5 | strategy v3（29 节点+树序修正） | #659→#660 | `321cc47d` | **1** |
| 6 | task.stones.add 2 款（DT-11/DT-06） | #676→#677 | `d6a82c60` | **1** |
| 7 | strategy v4 终局（六星改 texture-fill 密铺） | #690→#691 | `d45b8991` | **1** |
| 8 | task.stones.add 2 款（Q154/PC-10-3） | #707→#708 | `13ba4d4b` | **1** |
| 9 | task.export | #721→#722 | `c7899d62` | **1** |

- v1 弃置是**质量正面证据**：#454 发现指派表漏掉三大铺钻面（夜空 0001/花环 0005/左金发 0008）拒绝执行——与 iter-3 的质量否决弃置同性质；后续 #459 发现「容器节点不产钻」平台约定才是跳过根因，改走补产钻叶正道
- v2→v4 非弃置而是**执行后升级**（1350 颗→树序修正→1344 颗→六星密铺 1172 颗终局），与 iter-4 v1→v2 升级形态同构

## 四个取证靶子判定

### 靶子A 调用前父掩膜覆盖检查 — PASS（KB 规则原文+根因诊断+换域，历轮最深）
- **#151 最强证据**：「按知识库《失败信号对照表》诊断①：**目标不在『星空夜空背景』掩膜内（SAM 把白色星光瓣当作了蓝天掩膜的孔洞，而 refine 只在父掩膜内枚举）**。对策：提升到画布层发（画布掩膜=全图，星星像素必在其中）」→ #164 画布层 4/4 命中零警告——比 iter-4 #296 的「掩膜有洞」假设更进一步，是**掩膜孔洞根因的结构性诊断**
- **#466 二次迁移**：外圈天空「根本不在任何节点掩膜内」→ 画布层抠 sky（500×353 全幅零警告 labVariance 9.42 均质）压树底
- 同族迁移：#133（树实测 bbox 对照）/ #138（六星逐颗定位核对）

### 靶子B 名实一致 — PASS
27 产钻叶名↔掩膜逐一相称：部位叶用部位级提示词（脸←cherub face/袍←white pearl robe/翅←pearl wings）；六星语义命名（左上/左上角/顶部中/右上/左缘/中上大星）；2 exclusion 叶显式命名+理由（`bright star 1`=细碎残星与主星重复留白 / `碎屑残膜（不产钻）`=分割残膜非实体）。无整片掩膜配部位名、无泄漏层残留命名。

### 靶子C precision 落参 — PASS（9 次，零背离）
#118 KB 要点提取点名 `precision:{confThreshold:0.3}` → wire 0068 `conf=0.3` 对上；0.25×8 全部在四星画布层攻坚序列（0069-0076）与叙事序列吻合。合计非默认 9/81（11.1%；iter-4 20/74=27%）——量级下降但场景正确（换措辞/换域之后的手段；本轮画布层换域在 precision 之先奏效）。

### 靶子D 袍区闭合 — PASS（历轮最强）
中天使长袍：**8139px 掩膜 69.1% fill 60 颗**（iter-3 无袍叶 P1 → iter-4 466px 7 颗 → 本轮 8139px 60 颗）；三天使袍区全指派全落钻（左 27/右 172/中 60）。29 指派↔29 叶一一对应，无悬空。leaf-union 对父剪影覆盖：左 52.5%/右 41.0%/中 42.8%（父组含臂间空隙——iter-4 同法口径互有出入）。

## 新面四证据（T1-T6 live）

1. **T1 风格检测**：scene-analysis `style:"photographic"` ✓（前置三验①）
2. **T2 参考图层软回退（provider 未配置态）**：#18 typed warning 帧+双工件缺席+agent #21 感知叙述 ✓（前置三验②）——分件/树锚/账本全链走原图（intake 500×500 锚），任务零阻塞
3. **T4 归属门**：bundle.json audit.**attributionGaps 4 条明细**（kind=leaf-covered-by-leaf：亮星右上 100%/左缘 98.7%/顶部中 98.4%/左上角 98.3% 被「夜空（满铺底）」叶覆盖，overlapPx/regionPx 逐条留痕）——**正是简报预测的「三天使图同色粘连位」形态：星-夜空兄弟重叠**。v1 披露不阻断语义 live 验证：#725 agent 叙述「4 条归属缺口为『星星在夜空掩膜内』的披露性警告，星层钻已实际保留」+终报遗留披露第 1 条吸收 ✓
4. **T5 导出原图门**：**source.img sha256 `6267829d…` = 上传 PNG 字节级恒等** ✓；audit.sourceImage={from:"session-attachment", blobRef, mime} 引用留痕 ✓；参考图层零泄漏（本就未生成——软回退态天然满足）
- 附：audit.layoutAlignment（抽样 200/anomalyRate 0/suspicious false）与 audit.partCounts 亦留痕
- **T6 工作台条目/路由面**：RPC 直连会话不经过 UI——按简报跳过（vision 走查另批）

## 与 iter-4 对比（同图同字节，变量=daemon b9c2025→ba20c68 + KB f6f0f15→b35032e）

| 指标 | iter-4（b9c2025+KB f6f0f15） | **T7a（ba20c68+KB b35032e）** |
|---|---|---|
| 总时长 | 52.4 min | **153.1 min**（LLM 提供端 19 次 strategy_design 故障拖延 ~60-70min；有效工时同族 ~85min） |
| 帧数/工具 | 530 / 75 | 743 / 119（strategy_design 26 次因故障重试占增量主体） |
| 终树 | v53·44 节点·37 产钻叶 | **v44·36 节点·27 产钻叶+2 exclusion** |
| 总钻数/SKU | 1315 / 14 | **1172 / 11** |
| 夜空 | 天空 7 颗点缀留黑（披露风格） | **满铺底 408 颗（pavingStyle=full 显式落参 23/26 次）** |
| 中天使袍 | 466px·7 钻 | **8139px·60 钻（69.1% fill）** |
| 六星 fill | 45.8%（4×star+2×box 兜底） | **53.4%（4 画布层语义+2 前期，全部 culled=0）** |
| 花篮粒度 | 17 子（instance 枚举） | **7 子（松枝体+4 蝴蝶结+2 球）** |
| 头发流线 | 95 颗（发叶掩膜 42.0%/31.4%） | **19 颗（发叶掩膜更收敛 26.9%/24.2%/25.9%）** |
| precision 落参 | 20 次（27%） | 9 次（11.1%） |
| 授权闭环 | 5 提案 5 消耗 | **9 提案 8 消耗+1 完整性弃置** |
| KB 时机 | 开局全前装（6 条） | **分件困难时查（3 条：#107 list+#111 失败信号对照表+#115 措辞规律）——遵冻结指令「遇到分件困难时先查」的时机语义** |
| 归属门/导出原图门 | 无此面 | **4 条 attribution-gaps+source.img 字节恒等** |

**同构性判定：成立（部位结构/攻坚域/KB 线/授权链形态同族），战术差异显著且可归因**：
1. **夜空满铺 vs 点缀**：最大观感差异源。**pavingStyle 缺省假说不成立**——agent 23/26 次显式传 full（T4 4.4 新参数面首次 live 使用即被 agent 主动采用；3 次压缩重试省略=缺省交策略）。iter-4 无此参数时 agent 自选了点缀留黑。归因=pavingStyle 入参的存在改变了 agent 的铺法默认倾向。
2. **中袍 60 钗 vs 7 钻**：本轮中袍掩膜 8139px（iter-4 466px）——同一 SAM 线在不同 prompting 轨迹下的掩膜尺度差（本轮「white pearl robe of middle angel below faces」整段提示 vs iter-4 残段提示）。叠加满铺语义，袍区钻数放大 8.6×。**更好方向的偏差**。
3. **花篮 7 子 vs 17 子**：iter-4 用 instance 枚举逐实例；本轮按语义类分组（松枝体一片+蝶结×4+球×2）。历轮花篮粒度方差本就大（12/1/8/17），归因主候选=LLM 非确定性，次候选=KB b35032e 归属判据让 agent 更关注「容器-叶归属正确性」而非「子件粒度最大化」（#459/#466 补产钻叶论证「掩膜天然互斥」即为该判据的程序化思维）。
4. **六星密铺工程学（新行为）**：keep-earlier 树序发现（#549 夜空底排最前剔除 4 星钻）→树序修正 v44→#673 geometry 星形仍输夜空底→#687 texture-fill 密铺 d8>d7+夜空最后铺→culled=0。这是排钻引擎树序语义的首次 live 工程化利用——与归属门披露的「星叠夜空」效果互为表里。
5. **路由无涉**：RPC 直连，未经 UI 路由面。

## 异常与遗留

1. **P1（产品缺陷，移交 Owner）**：JPEG 上传死链（§0）——建议上传面转码或显式拒收。
2. **P2**：LLM 提供端故障 20 次拖延 ~60-70min（strategy_design 19 fail：超时/坏 JSON/思考块吃满/stoneIdx 格式）；agent 处置链完整且聪明（#588 查提案状态防重复签发/#617 压缩 rationale/#627 格式样例自纠/#637 趁恢复间隙先做无 LLM 步骤），但暴露「29 节点×长 rationale 的输出长度是超时瓶颈」——建议 strategy_design 提示词模板内置紧凑格式或分批指派。
3. **P3**：左袍 fill 37.2% 偏薄（iter-4 同名 P2 延续；本轮 27 颗密度不低但掩膜收敛）。
4. 观察项：SVG 原图层 >2MB 降级占位（iter-4 同款）；两块碎屑残膜显式留白已注记 BOM；e24102e8 grant consumed=0 悬置（弃置语义正当）。
5. 盯跑操作记录：watcher 110min cap 触发一次后重启延长期（65min cap），任务终态后随 TASK TERMINAL 自然退出；不构成对任务的介入。

## 基础设施自证

- daemon 8317 全程未重启（PID 66748 贯穿 run1+run2；daemons 健康探针 200）；SAM 桥 81/81 ok；run1 JPEG 死链按铁律重跑 1 次（唯一豁免，已用），run2 零重跑自然终态
- 只观察不介入：全生命周期仅创建时 1 条 followup（脚本即发即退 EXIT=0，WS 关闭）；DB 全程 mode=ro
- 进程回收：两个创建脚本 node EXIT=0 自退；watcher run1 随终态退出、run2 终态后自然退出；`ps` 复核零残留（本次会话启动的常驻进程清单：watcher bash×2[已退]、node 创建脚本×2[已退]——无孤儿）
- run1/run2 均为全新匿名会话，未读写任何既有会话；iter-0..6 目录未触碰

## 附件

- `create-result.json` / `create-result-run2.json` — 两 run 会话/任务/blob 元数据
- `preflight-checks.md` — 前置三验证据（含 run1 死链记录）
- `jpeg-deadlink-run/` — run1 全转录+终报（JPEG 死链产品缺陷证据）
- `raw-assistant-transcripts.md` — run2 全文转录
- `raw-tool-timeline.md` — 119 次工具调用时间线
- `transcript-excerpts.md` — 32 段关键决策策展（软回退感知/星域攻坚/指派完整性门/keep-earlier/六星密铺/归属门披露）
- `tree-final.json` / `scene-analysis.json` / `strategy-plan-final.json` / `task-layout-final.json` / `stones-lint-final.json` — 终版工件
- `bundle.json` + `bundle-full/` — 导出七产物原件（含 source.img）
- `analyze-stdout.txt` — 分析器原始输出
- `t7a-create.mjs` / `t7a-create-run2.mjs` / `t7a-analyze.py` — 复现脚本
