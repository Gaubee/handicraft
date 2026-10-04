# iter-5 — 扁平化辅助图 A/B 实验组（add-sam-playbook 第五轮实跑）

> **唯一变量=图片**：`input-flat.png`（Owner OpenAI image edit 扁平化，1280×1280 PNG，sha256 `234def2d…`，2,055,752 B）。其余与 iter-4 完全同口径：8317 daemon 同一进程（PID **48184**，10:03:27 启动，全程未重启，commit **b9c2025**）· KB 独立仓 **f6f0f15** · 冻结指令一字不改 · 20×20cm 表单行 · autoApprove=true。
> 匿名新 token 新会话，未触碰任何既有会话；全程只观察零介入（仅创建时 1 条 followup，脚本即发即退 EXIT=0，WS 随发随关）；DB 全程 mode=ro；**盲测干净——转录零「扁平/辅助图/实验/A/B」字样（91 处 "flat" 命中全部是 `polarity=flat` 布局参数）**。无基础设施故障（daemon/SAM 桥零故障），零重跑，任务 **51.0 分钟自然终态 done**。
> **headline：验收五条全 PASS（第三轮连续全绿）。SAM 分件效率跃升——53 wire 全 ok、零重试、零非默认阈值（iter-4：74 wire/20 次 confThreshold 调整）；一次成树 41 节点零掩膜警告，**全程零 tree_refine/rename/merge**（iter-4：16/12/7 次）；六星 fill 均值 52.4% 历轮最高；袍叶掩膜 54.7/56.7/45.5%（iter-4 同位 26.2/51.0%/466px）。代价：scene_analyze 在扁平图上三连败（GLM-5.3-Flash thinking 超预算/JSON 截断）→ 走「直接注入元素清单」兜底 → 暴露兜底路径坐标系 bug（树 1280 vs 锚点 500）闸死 reparent → 容器节点改策略层 exclusion 处置。分享包 `/r/YUq6rf3uQYfU`（2552 钻全满铺 9-11/cm²，BOM 6 行，bundle source.img sha256=input-flat.png 逐字节一致）。**

## 会话与任务

| 项 | 值 |
|---|---|
| daemon | 127.0.0.1:8317（PID **48184**，与 iter-3/4 同一进程，commit b9c2025） |
| KB | DATA_ROOT/knowledge @ **f6f0f15**（与 iter-4 完全一致，本轮非变量） |
| 用户 | 匿名（`__anonymous__`，新 token 新会话） |
| 会话 | `76b63ed7-5a7b-44cc-a2cd-7cc51648896d` |
| 任务 | `54a92bde-3a48-4478-b3e3-fccc771906ed`（type=agent） |
| 图片 | `input-flat.png` blobRef `234def2d…`（2,055,752 B；上传归一后 blobRef=sha256 复核一致） |
| 创建路径 | POST /api/auth/anonymous → WS /ws/rpc（RPCLink）→ assets.upload → session.create → session.followup（冻结指令+表单行+单图+autoApprove=true）；EXIT=0 |
| 时间窗 | 2026-10-04T05:10:06.078Z → 06:01:07.739Z（**51.0 min**，done） |
| 帧统计 | 304 帧：transcript 117 / activity 84 / artifact 30 / progress 58 / approval-request 7 / approval-resolved 7 / done 1 |
| 工具调用 | **42 次**（iter-4 为 75）：strategy_design 11（7 ok+4 err）/ stones_search 9 / scene_analyze 4（3 err+1 ok）/ task_stones_add 4（propose+execute×2）/ kb_get 3 / todo_write 3 / tree_reparent 2（全 err）/ task_export 2 / kb_list·subject_segment·task_stones_list·stones_list 各 1 |
| SAM 桥 | **53 wire 全 outcome=ok**：40×geometric（box 锚定，注入清单逐元素）+13×text（概念整拓）；**confThreshold 全默认 0.4（非默认 0 次）·maskMaxSide 0 次**（iter-4：74 ok+20 次非默认 0.3/0.25/0.15） |
| 审批 | **7 proposal 全 autoApproved=true**；grant 7 行 **6×consumed=1 + 1×consumed=0**（strategy v1 密度否决未执行，#220 显式说明——非静默弃置） |
| 瞬态故障 | 9 次工具级失败全自愈：scene_analyze 3×llm-bad-json / tree_reparent 2×坐标系闸门 / strategy_design 4×（oversize 1+coverage-incomplete 1+llm-invalid-plan 2）；daemon/SAM 桥零故障 → **不满足重跑条件，零重跑** |

## 验收五条逐条（含数字）

### ① 三天使完整成层 — **PASS**（36 部位叶全指派 + 4 容器 exclusion 显式处置，零静默遗漏）
终树 41 节点（画布+40，**全扁平挂画布**——reparent 被坐标系闸门挡后按 KB 完整成层规则改策略层处置）；掩膜像素实测（fill=掩膜px/bbox px）：
- **左天使**（6 部件）：脸 214×261 **66.6%**（37176px→86 颗）/ 头发 332×388 14.2%（18323px→40 颗流线）/ 冬青冠 332×238 **59.3%**（46852px→69 颗）/ 袍身 368×583 **54.7%**（**117443px**→229 颗）/ 上翅 37.3%+下翅 52.7%（合计 98249px→162 颗流线）
- **右天使**（6 部件，头部完整）：脸 244×260 **63.5%**（40302px→98 颗）/ 头发 380×424 21.3%（34273px→80 颗流线）/ 冬青冠 378×180 43.9%（29870px→39 颗）/ 袍身 482×599 **56.7%**（**163598px**→291 颗）/ 上翅 34.8%+下翅 57.1%（合计 123614px→204 颗流线）
- **中间小孩**（3 部件）：脸 225×257 60.0%（34679px→79 颗）/ 头发 292×261 **2.1%**（1587px→3 颗流线）/ 袍身 358×194 45.5%（**31596px**→44 颗）
- 4 容器节点（左/右天使、中间小孩、花篮）exclusion 显式指派不产钻（防双覆盖间距违规，#123 决策+#303 披露）
- **袍区对比（A/B 核心）**：中袍掩膜 31596px vs iter-4 466px（**68×**）；左袍 117443px/54.7% vs 13782px/26.2%；右袍 163598px/56.7% vs 30478px/51.0%——扁平图袍区大面积实心，SAM 首击成叶

### ② 背景六星逐颗成层 — **PASS（6/6，fill 均值 52.4% 历轮最高）**
六独立星层（全 geometric star 策略，DT-16）：左上角 73×82 **66.4%**→3 颗 / 左上次 66×59 37.6%→4 颗 / 顶部中 63×70 **69.4%**→4 颗 / 左中 52×71 47.4%→1 颗 / 右上 59×71 31.1%→2 颗 / 右中 54×54 62.3%→3 颗（星钻合计 17 颗）。逐轮均值：iter-1 52.0 / iter-2 38.3 / iter-3 40.1 / iter-4 45.8 / **iter-5 52.4**。**零换域、零阈值下降、零 box 兜底**——iter-4 需 KB 规则点名+画布换域+2×纯 box 兜底才达成 6/6。

### ③ 花篮完整 — **PASS（14 子叶）**
花篮容器(exclusion)+松枝×5（53323/35463/14854/15818/5496px→103/72/32/39/19 颗）/ 蝴蝶结×4（→6/14/10/**0** 颗）/ 装饰球×2（7307px 76.2%/7024px 77.8%→13/15 颗）/ 浆果×3（→19/13/13 颗）。对比：iter-1 12 子 / iter-2 1 整体 / iter-3 8 子 / iter-4 17 子（instance 枚举）/ **iter-5 14 子（注入清单命名）**。**红蝴蝶结-右 0 颗**：掩膜 97×95 仅 175px（1.9% fill，细缝）——flow/scatter/hex-pitch 三策略均无法落钻，终报显式披露+建议工作台手动补钻（#237 发现→#254 定性「策略层无解」→#303 披露链完整）。

### ④ 头发流线贴法 — **PASS（BOM 精确对账，历轮最实）**
三个发层全部 `texture-fill mode=flow`：左发 DT-37 40 颗 / 右发 DT-37 80 颗 / 中发 DT-37 3 颗——**123 颗 = BOM DT-37=123 逐颗对上**（iter-4 为 95 颗）。翅膀/袍/松枝/蝶结亦 flow（全图 30 个 texture-fill 节点中 flow 占 24）。方向场降级（无亮度输入）在终报披露。

### ⑤ 分享包导出 — **PASS（第三轮连续）**
- 授权：#287 propose → #288 approval-request `25aed087`（2552 钻/6 款/BOM 6 行/五产物）→ #289 autoApproved=true → #292「autoApproved=true——执行导出」→ #302 返回面 → grant `e2ecfd0d` **consumed=1**
- results 行（DB ro）：**publicId `YUq6rf3uQYfU`** · resultId `f88d3632` · title「任务导出 image-1（2552 钻）」· 2026-10-11 过期
- bundle 7 文件实存：layout.svg 1.0MB / render.png 7.6MB / numbered.png 1.4MB / holes.png 253KB / bom.csv（6 SKU 合计 **2552**：DT-16 袍翅星 947 / DT-35 夜空 750 / DT-22 松绿 373 / DT-71 肤 263 / DT-37 金发 123 / DT-07 正红 96）/ bundle.json / source.img
- **产物基图**：`source.img` sha256 `234def2d…` = input-flat.png 逐字节一致（bundle.json source blob 同指）——流程自动以扁平图为源 ✓；render.png 为扁平底图+满钻覆盖层（客观记录，不判对错）
- 警告：导出 1 条非阻断（夜空 2 颗孤立散钻，#292 分级+#303 披露）；**终版 stones-lint 0 警告 0 阻断**（iter-4：gems 35+island 9+SVG 1）

## 授权链证据（四靶子之一）

| # | 阶段 | 帧 | proposal | grant | consumed |
|---|---|---|---|---|---|
| 1 | stones.add 8 款（rev1→2）propose→autoApproved→执行 | #163→#165→#166→#172 | `75444694` | `da36e31f` | **1** |
| 2 | stones.add DT-16（rev2→3）propose→autoApproved→执行 | #196→#198→#199→#204 | `83f34317` | `ac72cdb0` | **1** |
| 3 | strategy v1（36 tf+4 ex）grant 后**密度否决未执行** | #216→#217→#220 重发 | `2237be81` | `9b2b3e3e` | **0** |
| 4 | strategy v2（30 tf+6 geo+4 ex 满铺）执行 2552 颗 | #223→#224→#227→#233 | `ca241a0a` | `25a727f0` | **1** |
| 5 | strategy v3（0035 定点修正）执行 1651 颗退化 | #240→#241→#250 | `4878f4d7` | `5769311c` | **1** |
| 6 | strategy v4（polarity=flat 钉死复原）执行 2552 颗 | #267→#268→#271→#277 | `c54e338d` | `8dbbbf1a` | **1** |
| 7 | task.export propose→autoApproved→执行 | #287→#288→#289→#294→#302 | `25aed087` | `e2ecfd0d` | **1** |

- 6/7 consumed=1；唯一 consumed=0 是 strategy v1：#220「提案已生成且 autoApproved，但我不直接执行——密度整体偏低（天空 1.5/袍 2.2 vs 满铺基准 12.4/cm²）…重发提案」——**执行前质量否决+显式叙事**，非静默弃置（对照 iter-3 质量否决同型）
- v3 执行后退化（2552→1651，LLM 把 flow polarity 漂移成 dark-dense）被 #254 抓包 → v4 以「显式钉死 polarity=flat+exclusion 固定 rationale 模板」复原最优版——**执行-回归-复原闭环**，两代真实落档终局 v4（manifestRevision 3）
- 返回面 autoApproved=execute-next 条件持续生效：#227/#292 两处「autoApproved=true——立即执行」与返回面标志一致

## 四个取证靶子判定

### 靶子A 调用前父掩膜覆盖检查 — **N/A 路径切换（零域问题需要处置）**
- 本轮无「no-instance 连续→换域」情节：53 wire 全一次命中，**域检查规则无触发场景**（这本身是扁平图增益的最强证据——iter-4 同口径需 #296 点名规则+#303 换域+2×box 兜底）
- KB 失败信号表在**第一次** scene_analyze 失败后被读取（#19），其「warning 与 blocker 区别」「autoApprove 以标志为 execute-next 条件」两条规则在 #227/#292 实际执行

### 靶子B 名实一致 — **PASS（40/40 节点名实相称，零簿记瑕疵）**
- 部位叶全部由注入清单+SAM 掩膜落位：袍身 mask 117k/164k/32k px 落在脸/发之下的躯干区（bbox 实测 262,513 / 618,475 / 383,591）=袍域非整体，名实相称；星层命名含方位（闪光星-左上角等）与 bbox 一一对应；花篮子件命名语义化（松枝-左角…红蝴蝶结-右）
- iter-4 的「来源提示词簿记瑕疵」（segmentPrompt 保留整体词源）本轮不存在——掩膜与命名同源于注入清单

### 靶子C precision 落参 — **PASS（零宣称零携带，叙事-参数零背离）**
- confThreshold≠0.4：**0 次**；maskMaxSide：0 次；全程无任何阈值/精度叙事（无需宣称）——iter-4 为 20 次携带+逐条对账。扁平图使 precision 手段整层下线

### 靶子D 完整成层完成判据/父覆盖 — **PASS（判据三要素全执行，且经受了路径变形考验）**
- **部位→可排钻叶子**：36 部位叶全获 texture-fill/geometry 指派+实钻（中间小孩头发 3 颗亦指派）
- **逐部位核对**：#106 初树即核（「右天使脸/发/冠/袍/双翅齐全、花篮 14 部件全部成层」）；#237 执行回执级逐节点核对（nodeSummaries 发现 0035 覆盖洞→触发修正尝试）；#303 终报逐项核验表（五条×分部件钻数）
- **未覆盖显式披露**：0035 蝴蝶结-右 0 颗三处披露（#237 发现/#254 定性/#303 终报+工作台手动补建议）；无静默遗漏
- **变形考验**：reparent 被闸后未放弃判据——#106 识别双覆盖风险→#123 方案 B 以 exclusion 显式处置容器（「组合层须语义覆盖+实际获得策略指派（exclusion 也算显式处置）」规则原文落地）

## 过程质量

- **纪律**：连续同参重发 0 次（#264 显式引用「未改参数不得重发」后改指令再发）；变体轮询无（无措辞战场）；策略迭代 4 代各有显式理由（密度否决/定点修正/防漂移复原）
- **KB 时机与用法**：kb_list #9 + kb_get 3 条（#19 失败信号表/#23 计数实例/#33 部位拆分）全部先于 subject_segment #43——**按需前装**（失败间隙穿插读取），#41 有归纳复述；对比 iter-4 全前装 5 条。SAM 组 3 条均命中本轮实际战场
- **瞬态故障自愈 9 次**：scene_analyze 3×（thinking 超预算 2+JSON 截断 1→极简指令→最终兜底注入清单）；reparent 2×（锚点未就绪→坐标系冲突→方案 B 绕行）；strategy 4×（stone-filter-oversize 992>200→stones.list 收窄重发/coverage-incomplete→补 4 指派/llm-invalid-plan 2×→固定 rationale 模板）——全部 LLM 侧/参数侧，daemon 与 SAM 桥零故障，**不构成重跑条件**
- **修树强度：零**（refine/rename/merge/inspect 全 0，iter-4 为 16/12/7/3）——一次成树是本轮结构性差异；代价是 reparent 也做不了（坐标系闸门），层级问题转策略层解决
- **终报诚实度**：5 点披露+逐项核验表；**1 处叙事精度瑕疵**：终报分部件钻数与终版布局有出入（左发 48 vs 实 40、左冠 89 vs 69、中发 11 vs 3、星「各 3-4 颗」vs 实 1-4 颗——总数/BOM/关键指派全对，部位级数字系 v2 执行回执记忆，未对 v4 终局复核）

## 与 iter-4 对照表（A/B 同口径）

| 指标 | **iter-4（原版微信图）** | **iter-5（扁平图）** | Δ |
|---|---|---|---|
| 变量 | 对照组 | **图片（唯一变量）** | — |
| 总时长 | 52.4 min | **51.0 min** | ≈持平 |
| 帧数 | 530 | **304** | −43% |
| 工具调用 | 75 | **42** | −44% |
| SAM wire | 74（全 ok） | **53（全 ok）** | −28% |
| **wire 非默认 confThreshold** | **20 次（27%）** | **0 次** | **−100%** |
| SAM 重试/换措辞/换域 | 多轮（16 refine+换域+box 兜底） | **0** | 分件战场消失 |
| 掩膜警告（树侧 lint） | 35 gems+… | **0** | −100% |
| 修树操作（refine/rename/merge） | 16/12/7 | **0/0/0** | −100% |
| scene_analyze | 1 次 bad-json 自愈 | **3 连败→兜底注入清单** | 恶化 |
| 树形态 | 44 节点 7 组嵌套 | 41 节点全扁平+容器 exclusion | 结构变形 |
| 逐星 fill 均值 | 45.8% | **52.4%** | +6.6pp |
| 袍叶（左/右/中） | 13782px·26.2% / 30478px·51.0% / 466px | **117443px·54.7% / 163598px·56.7% / 31596px·45.5%** | 中袍 **68×** |
| 花篮子叶 | 17 | 14（含 1 零钻披露叶） | 略减 |
| 策略代数 | 2 代（执行后升级） | **4 代（否决/最优/退化/复原）** | 迭代更深 |
| grants | 5/5 consumed | 6/7（1 执行前质量否决） | +1 弃置（有叙事） |
| 头发流线钻 | 95 | **123（=BOM 精确）** | +30% |
| 总钻数 | 1315（点缀-混合） | **2552（满铺 9-11/cm²）** | +94% |
| BOM | 14 SKU 混规格 | **6 SKU 统一 2.7mm** | 简化 |
| 分享包 | /P3Sxavl0ShDy | **/r/YUq6rf3uQYfU** | — |
| 导出基图 | 原版图 | **扁平图（source.img sha256 铁证）** | — |

## A/B 初步观察（Owner 假设判定素材）

1. **假设主命题「扁平化输入显著提升 SAM 分件质量」——分件层强证实**：
   - 一次成树（41 节点零警告零修树），53/53 wire 全 ok 全默认阈值——历轮所有分件痛点（no-instance/泄漏/碎片/换域/阈值轮询）**整层消失**；iter-4 同 KB 同指令在原版图上需要 20 次阈值调整+16 次修树才达到同级验收
   - 低对比部位（历轮病灶）直接受益：袍区大面积实心成叶（中袍 466px→31596px）、六星 fill 均值历轮最高、翅膀成对大掩膜（98k/124k px vs 10.5k/18k）
2. **副作用一：视觉理解层变差**——scene_analyze（GLM-5.3-Flash）在扁平图上 3 连败（thinking 吃满输出预算 2 次+JSON 截断 1 次；iter-4 仅 1 败）。扁平图信息密度低但模型反而过度思考，尚不能归因定论（样本 1），但**分件不依赖 scene_analyze 成功**这一点被兜底路径兜住了
3. **副作用二：兜底路径暴露坐标系 bug**——直接注入元素清单建树于 1280 空间，scene-analysis 锚点降采样 500 空间，tree.reparent 被「bbox 锚点错位」拒绝。这是**管线潜在缺陷**（与扁平图无关，原版图走同路径必同样触发），建议产品化前排期修复（锚点升采样或树坐标归一）
4. **策略层出现新失败模式**：LLM 策略代际漂移（v3 polarity 漂移致 2552→1651）——扁平图大掩膜满铺放大了策略参数敏感面；agent 的「执行-回归-抓包-钉参复原」闭环有效，但多消耗 2 代提案+2 次 invalid-plan
5. **产出风格分化**：iter-5 走「统一规格满铺」（6 SKU/2552 颗/9-11cm⁻²），iter-4 走「多规格点缀-混合」（14 SKU/1315 颗）——扁平图的大色块掩膜天然诱导满铺策略；两者均满足验收，风格差异应交 Codex A/B 审查裁量

## 异常与遗留（下轮建议）

1. **P1｜reparent 坐标系闸门（管线 bug，非本轮变量引入）**：树 1280 vs scene-analysis 锚点 500 的坐标系不匹配使一切树重排工具在注入路径下不可用；本轮以 exclusion 绕行属 workaround。建议修复后补一轮验证
2. **P2｜scene_analyze 对扁平图的三连败**：若产品化（发现非扁平图→生成辅助图→面向辅助图分件），需先解决视觉模型对扁平图的稳定性（指令收紧/输出预算控制），否则每次都走注入兜底
3. **P3｜中发薄掩膜**：中间小孩头发 1587px·2.1% fill（iter-4 同位 1723px）→仅 3 颗流线钻，观感可能偏疏；扁平图中发区色块与肤色接近是可能原因
4. **P3｜终报部位级数字未对终局复核**（见过程质量节）——建议 KB 终报规则补「分部件数字以最终 task-layout 为准」
5. 观察项：三款钻引入未使用（PW-3/J51/A52，初选 8 款后策略转全 DT 系）——stones.add 两段式造成，信息披露充分但引入面偏宽

## 基础设施自证

- daemon 8317 全程未重启（PID 48184 贯穿任务起止——与 iter-3/4 同一进程，A/B 前提成立）；SAM 桥 53/53 ok；无基础设施故障，**零重跑**
- 只观察不介入：全生命周期仅创建时 1 条 followup（node 脚本即发即退 EXIT=0，WS 关闭）；DB 访问全程 `mode=ro`（报告所有 DB 数据均来自只读连接）
- 进程回收：创建脚本 node EXIT=0 自退；盯跑 watcher（bash 90s 循环）51 分钟后随任务终态自然退出 exit 0（后台任务 exec_87c7e6ed… 回流完成通知）；`ps -p 48184` 复核 daemon 存活未受扰，无本轮相关残留进程
- 盲测：首发指令与 iter-4 逐字一致（冻结指令+同表单行）；转录全文 grep 零实验词汇泄漏
- 存档不含对既有会话的任何写操作；iter-0/1/2/3/4 目录及 iter-5-flat-ab 下的 experiment.md/input-flat.png/owner-flatten-prompt.md 均未改动

## 附件（本目录）

- `create-result.json` — 会话/任务/blob 元数据（含一字不改首发指令）
- `raw-assistant-transcripts.md` — assistant/工具往返转录全文
- `raw-tool-timeline.md` — 工具调用时间线（42 次去重调用；activity 帧按 activityId 聚合重写——iter-5 帧流无独立 tool kind）
- `raw-watch-log.txt` — 90s 间隔盯跑原始日志（05:10:20Z→终态，全程无缺口）
- `transcript-excerpts.md` — 关键决策段策展 16 段
- `tree-final.json` — 终树（blob `1810f063…`，41 节点，imagePx 1280×1280）
- `strategy-plan-final.json` / `task-layout-final.json` / `stones-lint-final.json` — v4 终局三工件（blob `3fe2482a…`/`0849f72e…`/`4a375d1a…`）
- `scene-analysis.json` — 锚点工件（blob `9121cd2c…`，500×500·11 元素——坐标系闸门实据）
- `analyze-stdout.txt` — 分析器原始输出（审批帧全量/wire 53 条回执）
- `bundle-full/` — 导出五产物原件（bom.csv/layout.svg/render.png/holes.png/numbered.png/bundle.json/source.img=扁平图字节）
- `iter5-create.mjs` / `iter5-watch.sh` / `iter5-status.sh` / `iter5-analyze.py` — 管线脚本存档
