# SAM3 文本提示最佳实践 —— 网络研究报告

- 日期：2026-10-04
- 研究子代理产出，服务于「SAM3 文本提示最佳实践知识库」
- 场景约束：本地 SAM3.1（macmini），支持 text / box / boxNegative 提示，points 不可用
- 触发问题：Owner 实测「三个天使」只抠出两个；「background」+ 掩膜反选反而拿到三个天使 + 星星 + 花篮

---

## 0. 结论速览（TL;DR）

1. **SAM3 的文本提示在训练层面就被限定为「简单名词短语（名词 + 可选修饰语）」**。论文原文：概念限定为「a noun and optional modifiers」组成的简单 NP，且模型「is not designed for long referring expressions or queries requiring reasoning」。「三个天使 / three angels」里的数词不在训练分布内，计数语义从未被训练——计数是靠「分割出全部实例后数 mask 数」实现的下游任务。
2. **计数词不仅无效，还可能有害**：GitHub issue #586 实测「One girl」这类量化提示会让全局 cross-attention 把高相关的多个实例**合并成一个 mask**（SBS 双目图中左右两眼的女孩合成一 mask）。这与我们「三天使只出两个 mask」的失败模式高度吻合——很可能两个天使被并成了一个 mask。
3. **单复数与措辞敏感性是 SAM3 最著名的社区痛点**：官方仓库维护者（SAM3 一作 Nicolas Carion，GitHub id alcinos）亲自给出的解法是**降置信阈值提召回**（0.5 → 0.3）；社区多例实测「shoe 有效 / shoes 无效」「person 无效 / a person 有效」「people/person/human 无效 / kids 有效」。
4. **「背景反选」是已被社区验证的正规工作流**：issue #409 给出完整代码——`background` 文本提示 + `confidence_threshold=0.0` + 取最高分 mask，再求补集。Owner 的实战发现与该模式完全一致。
5. **Meta 官方对「复杂查询」的标准答案是分解**：官方 `sam3_agent` 的 system prompt（Meta 亲写，用于教 MLLM 调 SAM3）包含 18 条提示词规则，核心思想：短名词短语、禁用数词/关系词/比较词、先过召回再精选、失败就换同义改述且**绝不重复同一提示词**。

---

## 1. 来源清单

### A. 官方一手信源（Meta / facebookresearch）

| # | 来源 | 关键内容 |
|---|------|---------|
| A1 | SAM 3 论文 arXiv:2511.16719（HTML 全文） https://arxiv.org/abs/2511.16719 | NP 约束、SA-Co 数据引擎、训练提示词生成方式、局限性附录 |
| A2 | 官方仓库 https://github.com/facebookresearch/sam3 | README 示例、负提示行为、examples 笔记本 |
| A3 | `examples/sam3_agent.ipynb`（仓库内） | MLLM 分解复杂查询的官方范式 |
| A4 | `sam3/agent/system_prompts/system_prompt.txt`（仓库内，gh api 读取） | **Meta 亲写的 18 条 SAM3 提示词规则**（本报告最重磅语料） |
| A5 | HuggingFace 模型卡 https://huggingface.co/facebook/sam3 | 官方提示示例（ear/dial/laptop/handle/person）、负 box 用法 |
| A6 | Ultralytics 文档 https://docs.ultralytics.com/models/sam-3/ | 生态侧示例与 FAQ（red apple / striped cat / yellow school bus） |

### B. 学术侧证

| # | 来源 | 关键内容 |
|---|------|---------|
| B1 | Shykula, Karpiv, Kohut. *Calibrating Promptable Concept Segmentation via Paraphrase Consistency*, ICML 2026（OpenReview / https://icml.cc/virtual/2026/74287） | SAM3 中置信分数不可靠；假阳性「tied to specific prompt phrasings」；EPC 改述一致性校准 |
| B2 | *SAM3-LiteText: An Anatomical Study of the SAM3 Text Encoder*, ICMR'26（ACM DL） | 文本编码器解剖；仅用 exemplar 易假阳性 |
| B3 | Chakrabarty & Soni. *Comparing SAM 2 and SAM 3 for Zero-Shot Segmentation of 3D Medical Data*, arXiv:2511.21926 | SAM3 零样本域外弱点实证 |
| B4 | L-SAM3（arXiv 2025）等推理分割后续工作 | 佐证「SAM3 原生不做推理式指代表达」 |

### C. 社区实证（GitHub issues / Reddit / ComfyUI 生态）

| # | 来源 | 关键内容 |
|---|------|---------|
| C1 | issue #165 + 评论（2025-11） | `person/human` 失效 `shoe` 有效；**「a person」修复**；**维护者：阈值降到 0.3 提召回**；「'shoes' is not working, but 'shoe' works well. Seems very senstive to text」 |
| C2 | issue #253 + 评论 | 同图 `person` 检不出、`child` 能检出 |
| C3 | issue #295 | `people/person/human` 全空，仅 `kids` 有效 |
| C4 | issue #315 + 评论 | `people` 空 tensor（阈值 0.5）；多人复现 |
| C5 | issue #393 + 评论 | 「person **without** safety helmet」否定措辞高置信（>0.9）误检；回复引用论文局限：不支持指代表达 |
| C6 | issue #409 + 评论（2026） | **背景反选完整工作流**：`background` 提示 + `confidence_threshold=0.0` + argmax 取 mask |
| C7 | issue #535 | 光杆名词 `beverage` 正常；「The white beverage on the upper shelf」失效；larger/smaller/left/right/first layer 等修饰全乱 |
| C8 | issue #586（2026-06） | **量化提示（'One girl'）导致相关实例并成一个 mask**（全局 cross-attention 分组） |
| C9 | Reddit r/MachineLearning 帖 1p1y74p（仅搜索快照可读，正文被验证墙挡） | 快照引用：「SAM3 is missing hundreds of RoIs per image」、poor delineation、blurry 区域弱 |
| C10 | ComfyUI 生态（1038lab/ComfyUI-RMBG#182、RunComfy/instasd 节点文档，经搜索索引） | mask 求反（`1-mask`）+ 膨胀/腐蚀清边是通用 foreground fail → segment background & invert 模式 |

> 说明：Reddit 帖正文（www/old/.json 三种方式）均被反爬墙拦截，本报告仅采信搜索引擎快照中的一句引用，不做过度解读。

---

## 2. 官方提示词语料全景

### 2.1 训练语料是什么样的（论文一手结论）

SA-Co 数据引擎三个阶段生成训练用「概念」：

- 第一阶段用「a simple captioner and parser」提 NP；第二阶段升级为「a Llama-based pipeline that also proposes hard negative NPs adversarial to SAM 3」；第三阶段「extracting NPs from the image alt-text」并从 **22.4M 节点、基于 Wikidata 的本体**（17 个顶级类目、72 个子类）里挖概念。
- 硬约束原文：**「We restrict concepts to those defined by simple noun phrases (NPs) consisting of a noun and optional modifiers.」** 论文并明确 SAM3「is not designed for long referring expressions or queries requiring reasoning」。
- **训练提示词中没有计数词**。计数只在评测里作为下游任务出现（CountBench 95.6%、PixMo-Count 87.3%，靠数检测实例）。
- 任务定义：一条文本提示返回**该概念的全部实例**（PCS 任务），与 SAM1/2 「一个视觉提示只出一个实例」相反。
- 硬负样本（hard negatives）是训练核心：用上一代模型的假阳性做对抗负例，加入后 IL_MCC「from 0.44 to 0.68」——这解释了 boxNegative 为什么是官方一等公民提示类型。

### 2.2 官方文档/模型卡实际用的示例（全部枚举）

- 论文/README：「yellow school bus」「red apple」「striped cat」「large circular shape」「a player in white」「a player in red」
- HF 模型卡：`ear`、`dial`、`laptop`、`handle`（配负 box 排除烤箱把手）、`person`
- Ultralytics：「person」「bus」「glasses」「person with red cloth」「person wearing a hat」

**模式归纳：官方示例全部是「光杆单数名词」或「名词 + 1~2 个视觉属性修饰语（颜色/纹理/大小）」。没有任何一个官方示例使用复数、数词、空间关系词或否定词。**（官方实证）

### 2.3 Meta agent system prompt——藏在仓库里的官方提示工程指南

`sam3/agent/system_prompts/system_prompt.txt` 是 Meta 教 MLLM 如何向 SAM3 发提示的规则集，等于官方提示工程守则。逐条摘译关键规则（引文为短引）：

1. segment_phrase 参数定义：「**A short and simple noun phrase**, e.g., rope, bird beak, speed monitor, brown handbag, person torso」。
2. 「**do not use complicated descriptors like numbers** or mention text that is written on the image as the segment_phrase tool does not have OCR capabilities」——**禁用数词**（官方明文）。
3. 「You should **avoid identifying concepts using actions, relationships, or comparatives**; instead, call segment_phrase on a more general phrase…use "vase" instead of "the bigger vase", use "dog" instead of "the dog lying down"」——禁动作/关系/比较级，改用泛称过召回再精选。
4. 「If your call to segment_phrase does not generate any useful mask(s)…**try calling the segment_phrase tool again using a more general noun phrase**. For example, if the "text_prompt" "elementary school teacher" does not give any mask(s), you can call segment_phrase again with the "text_prompt": "person".」——特称失败回退泛称。
5. 「when "sundial" does not produce any mask(s), you may want to try grounding "statue"」——冷门名词回退上位词。
6. 「If the results…are not what you expected, you can always call segment_phrase again using a different "text_prompt". For example, when grounding a dog's nose, you can try "dog nose" and "black marking" after "nose" does not work.」——**同义改述轮询**。
7. 「**Be concise** and get the right keywords; **don't make your "text_prompt" long**.」
8. 「**Do not ever use the exact same "text_prompt" more than once.**」——不重试同一提示词，永远换措辞。
9. 「If the initial user input query refers only to one specific object instance of a category…you should call segment_phrase with a "text_prompt" that is **the singular form of the category**…and then use the select_masks_and_return…tool to narrow down」——**单数形式 + 事后选 mask**（官方明文）。
10. 人物类目标：只用「"person", "man", "girl", "firefighter"」这类整体指称，不要抠部位/属性。
11. 覆盖面守恒：「never propose a "text_prompt" that covers more area than the initial user input query」及对称的 less area 规则——提示词与目标区域之间不欠不过。
12. 修正用户措辞示例：用户说「the red laptop」而图里是紫色时，应改发「purple laptop computer」——**以图中真实视觉属性为准选词，而不是照抄用户措辞**。

（引文均出自仓库现行文件，短引合理使用。）

### 2.4 负提示的官方语义

- 文本负提示：README——「Phrases that have no matching objects (negative prompts) have no masks」，即文本负提示不是「排除算子」，而是「本来就期望零结果」的查询。**想表达「A 但非 B」不能用否定词句**（C5 实证：`person without safety helmet` 在全员戴帽的图上仍高置信检出）。
- 负 box：HF 模型卡示例「Segment 'handle' but exclude the oven handle using a negative box」，label 0 = 排除区域。**空间排除的官方正道是 boxNegative，不是否定文本。**

---

## 3. 社区实证汇总（按主题）

### 3.1 措辞敏感性（单复数 / 同义选择）

- #165：`person`/`human` 零结果，`shoe` 正常；改 **`a person`** 后正常；`shoes` 失效 `shoe` 正常（多人复现）。
- #253：同图 `person` 检不出、`child` 可检出；HF spaces 版 transformers 实现反而能检出 `person`（实现间存在差异）。
- #295：`people`/`person`/`human` 全空，`kids` 有效。
- #315：`people` 空 tensor（conf 0.5）。
- 解读：不是「复数一定坏」（`kids` 本身就是复数形态），而是**每个概念的可用表层形式是离散、不可预测的**——训练 NP 来自 alt-text 抽取，哪些字符串形式落在分布内因概念而异。可操作结论：**把「同义/单复数/冠词变体」当作一组并行探针**，而不是猜一个「正确形式」。（社区多源 + 官方分布解释）

### 3.2 阈值与召回

- #165 维护者（alcinos，SAM3 一作）：「It's 0.5 by default, you can try lowering to 0.3 to improve recall.」
- #409：背景场景直接建议 `confidence_threshold=0.0` 后取 argmax。
- 解读：**「检不出」很多时候是「低于阈值」而非「模型没看到」**。诊断欠分割时应先降阈值看原始分数分布，再定提示词罪名。（官方实证）

### 3.3 否定 / 关系 / 空间 / 比较词全部失效

- #393：`person without safety helmet` 高置信误检（>0.9）；社区回复直接引论文局限条款，建议拆成 `helmet` + `person` 后处理。
- #535：`The white beverage on the upper shelf`、`White and transparent beverage` 效果差；`larger/smaller/left/right/first layer` 修饰判断错误。
- 官方 agent prompt 同向禁令（见 2.3 条 3）。（官方+社区双源）

### 3.4 计数词的行为

- #586：SBS 立体图上「One girl」让 SAM3 的 cross-attention「group highly correlated left/right features into a single semantic mask」——**量化词触发相关实例合并**。
- 推论（单源推测，但机制与我们观测吻合）：「三天使 → 恒两个 mask」很可能是两个高相似天使实例被并成一 mask + 第三个独立成 mask。对策是**去掉数词用裸名词**，让检测器做实例级枚举，计数由下游完成。

### 3.5 背景反选工作流（问题 4 的直接答案）

- #409 提问原文：「I try to describe the background part, but the model's performance is poor (usually produce nothing)」——直接描述背景成分（如「the table behind」）不行，但**光杆 `background` 概念可以**。
- heyoeyo 的可运行解法：`Sam3Processor(model, confidence_threshold=0.0)` → `set_text_prompt(prompt="background")` → `torch.argmax(scores)` 取最优 mask（或取 top-3 / 按面积选择）→ 求补得前景。视频场景建议逐帧检测或用背景 mask 引导 SAM2 跟踪，「the tracking model wasn't trained to track backgrounds」。
- ComfyUI 生态把「分割易侧 → `1-mask` 求反 → dilate/erase 清 1px 光晕缝」作为通用模式（C10）。
- 适用条件归纳（社区多源）：背景相对均质/风格化、前景多实例且互相相似（逐个点名困难）、前景概念在训练分布外而「背景」概念在分布内。**贴钻图（纯色底 + 密集小件）恰好完全满足这三条**——Owner 的成功不是巧合，是这个工作流的标准适用域。
- 边界注意：反选把「所有非背景」都给了你（所以拿到了三天使 + 星星 + 花篮），需要**按连通域/几何特征做后分件**，且边缘质量取决于背景 mask 边缘质量（需膨胀/腐蚀收边）。

### 3.6 Reddit 快照（弱证据，仅一条）

「SAM3 is missing hundreds of RoIs per image」（r/MachineLearning 帖快照）——密集小目标场景召回不足是社区共识级抱怨，与我们贴钻小件场景直接相关。帖子正文无法访问，不展开。（单源）

---

## 4. 学术侧证：为什么措辞敏感是结构性的

- EPC 论文（B1）实测：SAM3 置信分数「are reliable only at the extremes」，中段 [0.2, 0.6) 集中大部分假阳性；**假阳性与特定措辞绑定（tied to specific prompt phrasings）**，而真检测锚定在真实视觉实体上。其 EPC 方法：对提示词跑一组预生成改述，中置信检测**只有当至少一个改述独立重定位到同一区域时才保留**，可去掉 35% 假阳性（precision +8.1pp）。对我们的逆向启示：**改述集合也可以当召回放大器**——一个概念的多个表层形式并集，再按重合度去重/投票。
- SAM3-LiteText（B2）：文本编码器可裁 88% 参数不掉点——文本侧语义容量有限，进一步佐证「简单 NP 就是全部输入带宽」。
- 医学对比（B3）：域外概念零样本泛化差（论文附录 B 自己也承认 aircraft types、medical terms 等细粒度域外概念零样本困难）。「天使/花篮/星星」属于插画风格域，域偏移是召回不稳的另一个来源。

---

## 5. 可落地提示词规则清单（知识库初稿）

每条标注证据强度：【官】= 官方实证（论文/仓库/维护者）；【多】= 社区多源；【单】= 单源或推测。

| # | 规则 | 强度 |
|---|------|------|
| R1 | 提示词 = 「单数光杆名词」或「名词 + ≤2 个视觉属性（颜色/纹理/大小）」，总长短小精悍 | 【官】 |
| R2 | **禁用数词/计数词**（three、One…）；计数交给「全实例分割后数 mask」 | 【官】（agent prompt 明文）+【单】（#586 合并机制） |
| R3 | 禁用空间关系（left/on the upper shelf）、比较级（bigger）、动作（lying down）、否定（without）；这些需求改用：boxNegative（空间排除）、拆概念 + 后处理（关系/属性逻辑） | 【官】+【多】 |
| R4 | 否定文本不是排除算子；「A 但非 B」永远走 boxNegative 或掩膜差集，不走「A without B」 | 【官】+【多】（#393） |
| R5 | 首选提示失败时**换词重试而非原词重跑**：泛称回退（teacher→person、sundial→statue）、同义改述（nose→dog nose→black marking）、上位/下位词轮换 | 【官】（agent prompt 多条） |
| R6 | 单复数/冠词变体是离散可用的：为每个概念准备变体组（angel / an angel / angels / cherub / winged figure），取并集再按 IoU/中心距去重 | 【多】（#165/#253/#295）+【单】（EPC 思路迁移） |
| R7 | 诊断「漏检」先降阈值看分数分布（0.5→0.3→0.0），区分「没看到」与「低于阈值」 | 【官】（维护者回复） |
| R8 | 多实例相似目标：用裸单数名词触发实例级枚举；若 mask 数 < 期望且疑似合并，去掉一切修饰/数词重跑 | 【官】（R2 推论）+【单】 |
| R9 | 前景概念难命中而背景均质时：`background` + threshold 0 + argmax + 掩膜求反 + 形态学收边；反选结果需连通域分件 | 【多】（#409 完整代码 + ComfyUI 生态） |
| R10 | 人物/角色类目标用整体指称（person/man/girl/firefighter），不抠部位属性 | 【官】 |
| R11 | 提示词覆盖面与目标区域守恒：不欠（用 microphone 代替持麦者）不过（用 jeans 代替破洞区域） | 【官】 |
| R12 | 选词以图中真实视觉为准，不照抄需求文档措辞（红紫色调用 purple 不用 red） | 【官】 |
| R13 | 域外/风格化概念（插画天使、贴钻件）预期召回不稳，策略默认带 R5/R6 轮询 + R9 兜底 | 【官】（附录 B）+【多】 |
| R14 | 不同实现（HF transformers vs 官方 repo vs playground）同提示词结果可能不同，playground 调好的词要本地复测 | 【多】（#253、#275） |
| R15 | 复杂查询（「最左边穿蓝马甲的孩子」）的官方范式是 MLLM 分解成多个简单 NP 调用 + mask 选择；无 MLLM 时人工拆解成等价的 NP 序列 + boxNegative | 【官】（sam3_agent） |

---

## 6. 对「三天使」场景的具体策略建议

### 方案 A：裸名词 + 计数校验 + 改述轮询（首选，成本最低）

1. 发 `angel`（单数光杆名词，不带任何修饰）。期望：PCS 任务语义下返回**全部**天使实例。
2. **降阈值**（0.3 起步，必要时 0.0）拿原始分数分布，确认没有低分漏网。
3. 若 mask 数 <3：换词轮询 `angels` / `an angel` / `cherub` / `winged figure` / `flying angel`，每次**并集 + IoU 去重**（同一天使不同措辞的两个 mask 合并）。
4. 计数校验放在掩膜层（数连通 mask），永远不放进提示词。

预期依据：R1/R2/R5/R6/R7；「三个天使只出两个」的最可能机制是数词触发实例合并（#586）或第三天使分数低于 0.5（#165 维护者），两个对策都覆盖。

### 方案 B：背景反选（已实战验证，作为 A 的兜底或交叉验证）

Owner 已验证有效。规范化流程（吸收 #409 + ComfyUI 实践）：

1. `background`，threshold 0，取 argmax（或 top-3 按面积）得 bg_mask；
2. fg = 1 − bg_mask；
3. **形态学收边**（对 bg_mask 膨胀 1-2px 再求反），消除贴钻件边缘的背景色光晕——贴钻工艺对边缘残留敏感，这一步在我们场景比通用场景更重要；
4. 连通域分件：天使（大件）、星星（小对称件）、花篮（大件）按面积/长宽比/拓扑分桶，而不是让 SAM3 再去逐类点名。

适用条件核对（R9）：纯色/均质背景 ✓、前景密集相似 ✓、逐类点名困难 ✓。风险：拿到的是「一切非背景」，分件逻辑完全落在后处理；bg_mask 边缘质量决定成品边缘质量。

### 方案 C：box + text 组合（局部修补用）

- 对 A/B 遗漏的单个天使：box 圈住该天使 + text `angel` 收紧；box 圈住混入的杂物 + boxNegative 排除。
- HF 模型卡的官方范例就是这个形态（'handle' + 负 box 排烤箱把手），正对我们部署支持的提示组合。
- 注意正 box 在 SAM3 语义里会「泛化到同类全部实例」（论文：exemplar 正样本泛化到 category），**只想修一个实例时要配合 mask 选择/后过滤**，不能指望 box 只出那一个。

### 决策树（建议入知识库）

```
需求：图中的 N 个 X
├─ 提示词层：X 的单数光杆名词（禁数词/关系词/否定词）→ 阈值 0.3 起测
│   ├─ mask 数 == N → 通过
│   ├─ mask 数 < N → 降阈值到 0 看分数 → 仍缺 → 改述轮询（复数/冠词/同义/上下位）并集去重
│   └─ mask 数 > N 或混入杂物 → boxNegative 排除 / 按几何特征后过滤
├─ 提示词层穷尽仍 < N → 背景反选：background(th=0) → argmax → 求反 → 收边 → 连通域分件
└─ 分件边界不清 → box+text 局部修补（box 会泛化到同类，需后过滤）
```

### 对「三天使」为什么 Owner 两种策略一败一成的机制解释（写进知识库的教学案例）

- 「三个天使」失败：数词出分布（训练 NP 无计数语义）+ 量化词触发相关实例合并（#586 的 cross-attention 分组）→ 恒两 mask。
- 「background」成功：background 是 alt-text 高频 NP（分布内概念），贴钻图背景均质（易分割），反选把「逐个点名三个相似天使」的难题换成「一次性拿全部前景再分件」——把实例枚举从检测器搬到后处理，绕开检测器最弱的一环。

---

## 7. 负面结论（明确未找到的东西，防编造）

1. **未找到任何官方「提示词风格指南」文档**：论文、README、HF 模型卡、Ultralytics 均不提供措辞建议（HF 卡尤其薄，无 FAQ）。最接近官方指南的是 agent system prompt（本报告 2.3），但它藏在仓库深处、面向 MLLM 而非人类用户。
2. **未找到训练语料的原始 prompt 样本集**：SA-Co 的 NP 生成方式有论文描述（alt-text 抽取 + Llama 管线 + Wikidata 本体），但 4M 概念的具体字符串未公开，无法直接统计单复数分布。
3. **未找到「计数词导致实例合并」的论文级系统研究**：#586 是唯一的机制性观测（单源），EPC 论文只覆盖置信校准不覆盖计数。本报告对三天使失败机制的归因标注为【单】级推测，需本地 A/B 实证（angel vs three angel 同图对比 mask 数）补强。
4. **未找到 singular vs plural 的受控消融研究**（Grounding DINO/SAM3 均无），社区证据全是 issue 级别个案，但量大且方向一致。
5. **Reddit r/MachineLearning 讨论帖正文不可达**（反爬），只有搜索快照一句话，按弱证据处理。
6. Meta 官网 SAM3/SAM3.1 博客页面抓取 404（ai.meta.com 反爬），SAM3.1 的变更细节（Object Multiplex 等）只有搜索摘要级确认，未取到原文。

---

## 8. 知识库落地建议（给编排者的三条）

1. 把第 5 节 R1-R15 直接作为知识库规则表的初稿列，每条已带证据强度标签；后续本地 A/B 实验结果可以逐条把【单】升级或证伪。
2. 第 6 节决策树建议实现成提示词策略选择器：输入（概念词、期望件数、背景均质度）→ 输出（提示词变体组 + 阈值 + 兜底路径）。
3. 高优先级本地验证实验（成本低、信息量大）：同一三天使图跑 `angel` / `an angel` / `angels` / `three angels` / `cherub` 五个提示词 × 阈值 {0.5, 0.3, 0.0}，记录 mask 数与分数分布——一次实验同时验证 R2、R6、R7、R8 并把机制解释从【单】升到【官/多】级。

（完）
