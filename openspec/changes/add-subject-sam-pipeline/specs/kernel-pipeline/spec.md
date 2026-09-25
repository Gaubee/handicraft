# kernel-pipeline Specification（delta）

## ADDED Requirements

### Requirement: 画布尺寸声明与 pixelsPerMm 推导

画布物理尺寸 SHALL 为一等输入：`canvasCm{w,h}`（cm）+ 归一底图 `imagePx{width,height}` 构成尺寸声明工件，随各阶段工件（SceneAnalysis/ObjectTree）留存作锚点；pixelsPerMm SHALL 由纯函数从声明推导（x/y 两轴均值），纵横比相对偏差超过容差（缺省 2%）SHALL 显式拒（typed 结果携 aspectCm/aspectPx 数值），SHALL NOT 猜测缩放。

#### Scenario: 纵横比不符显式拒

- **WHEN** 声明 canvasCm 为 3:4 而 imagePx 为 1:1（相对偏差 33% > 2%）
- **THEN** 推导返回 `{ok:false, reason:'aspect-mismatch'}` 并随行 aspectCm=0.75 与 aspectPx=1 供调用方报告，不产出任何 pixelsPerMm

#### Scenario: 栅格舍入内放行且取两轴均值

- **WHEN** 声明纵横比与像素纵横比之差在整数栅格舍入量级（≤2%）
- **THEN** 推导成功，pixelsPerMm=px/(cm×10) 的 x/y 两轴均值（无主轴偏好，同输入同输出）

### Requirement: object-tree 工件契约

主体分割产物 SHALL 为单根树状 `object-tree` 工件（formatVersion=1）：扁平节点表+parent/children 双向指针，每节点携带 id（全树唯一且即引擎 blockId 寻址空间）/objectName（中文语义名）/category/mask/bbox（画布像素坐标锚点，mask 为 bbox 局部坐标）/effectiveMm/labVariance/drillWorthy/origin（vlm+sam3 | manual-lasso | auto-color）；schema SHALL 冻结为 strict 并校验树一致性（id 唯一/parent 必存在/children 双向闭合/无自指/children 无重复/恰一根），违例 SHALL 拒收并指明节点。

#### Scenario: 路灯父子归属

- **WHEN** 一根路灯被拆为「路灯·杆」与「路灯·灯头」两节点挂于路灯节点之下
- **THEN** 树工件通过 schema 校验：路灯节点的 children 含两子 id，两子节点的 parent 均指回路灯 id，全树恰一根

#### Scenario: 破损树拒收

- **WHEN** 构造 parent 指向不存在节点、或出现两个根、或 children 与 parent 指针不闭合的树
- **THEN** schema 校验逐项拒收，错误信息指明破裂节点与断裂方式（parent 不存在/必须恰一根/父子非双向）

#### Scenario: mask 二态线格式

- **WHEN** 节点 mask 以 inline 态（base64-01 编码）或 blob 态（内容寻址引用+随行 w/h）任一形态出现
- **THEN** 两态均保持引擎 Mask2D 同构语义（w×h 字节、逐字节 ∈ {0,1}、行主序 bbox 局部坐标）；inline 态解码长度 ≠ w×h、取值越界、非法 base64（含尾垫形态不符）一律拒收

### Requirement: 具名常量冻结

跨层物理常量 SHALL 以具名常量冻结于 contracts：默认贴钻密度 2.3 颗/cm²（策略指派与策略上下文的缺省值）；ΔE76 三档阈值 3/10/25（NEAR=感知无差自动替代/FAMILY=同色族自动+备注/COARSE=粗粒度兜底上限，超 25 拒绝）。常量语义 SHALL 单源（CIE76 与 Lab 管线同源），调用方 SHALL 引用常量而非内联字面量。

#### Scenario: 密度缺省贯通

- **WHEN** LLM 策略指派未显式给出 densityPerCm2
- **THEN** StrategyAssignment 落默认值 2.3（颗/cm²），策略上下文工厂缺省同源

#### Scenario: ΔE 阈值单源消费

- **WHEN** 停止判据取色容差缺省阈值
- **THEN** 该阈值=三档中档 10（DELTA_E_FAMILY），与钻替代决策序共用同一冻结常量源

### Requirement: 树→Block 适配

ObjectTree SHALL 适配为引擎同构 Block[]（不 import 不改动引擎）：blockId=node.id（同寻址空间）；树展开 SHALL 为叶子必产块、中间节点按 drillWorthy 产块（drillWorthy=false 的叶子仍产块——排除是策略层关注，几何基座必须存在）；每块 SHALL 附 origin 标注（originBlockId=父块 id/parentNodeId/nodeCategory/drillWorthy/nodeOrigin/effectiveMm/labVariance/depth/isLeaf/colorSource）；节点代表色 SHALL 经调用方注入（nodeColors），缺省确定性灰 [128,128,128]+colorSource='fallback' 标注，SHALL NOT 静默发明颜色；mask 维度 ≠ bbox 维度 SHALL typed 拒（mask-dims-mismatch）。

#### Scenario: 同寻址与父子标注

- **WHEN** 一棵含层级节点的树经适配器展开
- **THEN** 每个 Block 的 id=对应节点 id；子块的 origin.originBlockId=父块 id（树父未产块时为 null）而 origin.parentNodeId 始终保留树父节点 id（树链完整可溯）

#### Scenario: 非钻叶子仍产块

- **WHEN** 树含 drillWorthy=false 的灯光叶子节点（父为画布容器根未产块）
- **THEN** 该叶子产出 Block（几何基座存在），origin.drillWorthy=false 供排除族消费跳过产钻

#### Scenario: 维度不符拒收

- **WHEN** 节点 mask 的 w/h 与 bbox 的 w/h 不一致
- **THEN** 适配 typed 拒（mask-dims-mismatch 携 nodeId 与两侧维度），不猜平移或缩放

#### Scenario: 颜色注入与灰回退标注

- **WHEN** 调用方注入 nodeColors 中位色/未注入该节点
- **THEN** 前者 colorRgb=注入色且 colorSource='node-color'；后者 colorRgb=[128,128,128] 且 colorSource='fallback'（确定性，不因缺数据拒整树）

### Requirement: 迭代停止判据

迭代抠图停止判定 SHALL 为确定性纯函数，四判据各自独立评估、任一触发即停：尺寸（effectiveMm ≤ K×maxGemDiameterMm，K 缺省 2.5）/颜色（labVariance ≤ ΔE 阈值，缺省 10）/模型自评（信号 ≠ new-instances 即停——实测主停止器）/硬顶（iteration ≥ maxIterations 或 totalNodes ≥ maxNodes）；触发原因 SHALL 按权重序排列（hard-cap > model > size > color），主导原因=首因；驱动参数（钻径/K/ΔE 阈值/两硬顶）非正或非有限 SHALL typed 拒，SHALL NOT 兜底猜测。

#### Scenario: 尺寸判据触发

- **WHEN** 节点 effectiveMm=5mm，钻规格最大径 2mm，K=2.5（阈值 5mm）
- **THEN** 尺寸判据 stop=true，verdict 携 effectiveMm 与 thresholdMm 数值

#### Scenario: 模型自评为主停止器

- **WHEN** 节点仍大于尺寸阈值但模型信号=no-new-instance
- **THEN** 综合 stop=true 且 reasons 含 'model'；若同时未触发硬顶，primaryReason='model'

#### Scenario: 硬顶权重绝对优先

- **WHEN** 同一节点同时触发硬顶与尺寸判据
- **THEN** reasons=['hard-cap','size',…]——硬顶恒列首位，主导原因='hard-cap'

#### Scenario: 坏参数显式拒

- **WHEN** 以 maxGemDiameterMm=0 或 maxNodes=0 调用评估
- **THEN** 抛 RangeError 指明参数名与实值，不产出裁决

### Requirement: VLM 全图语义分析（scene.analyze）

`scene.analyze` SHALL 为双通道全图分析：通道 A（SAM 桥 analyze）优先，桥返回 unsupported SHALL 显式降通道 B（结果面 demotedFrom 留痕，不留静默），桥的其他 operational 失败（超时/传输/坏响应/队列满）SHALL typed 上抛不降级；通道 B 经既有 LLM 路由调视觉模型（冻结 openai-completions 协议、temperature 0、超时与 max_tokens 有界），响应经 JSON 抽取容错与 elements schema 校验（拒=typed error 携原文摘要）；输入 SHALL 校验原图存在、PNG 可解码且像素尺寸与 imagePx 一致（bbox 锚点错位必拒）；产物 SHALL 为 SceneAnalysis 工件（putTaskArtifact 同事务落 blob）+交换留存（scene-analyze-logs——不含 apiKey、不含图 base64）；真实外呼 SHALL 受 env 真连门控制（缺省 mock=typed 拒 live-disabled）；工具面 SHALL 以 readonly 直调注册（studio.scene.analyze，MCP 投影过 tool-surface deny 名单）。

#### Scenario: 桥 unsupported 显式降级

- **WHEN** 装配的 SAM 桥对 analyze 请求返回 unimplemented（桥侧无 VLM 能力）
- **THEN** 走通道 B（LLM 视觉路由）产出 SceneAnalysis，结果面携带降级标记，交换留存可见降级路径

#### Scenario: 桥 operational 失败不降级

- **WHEN** 桥 analyze 因超时或传输故障失败
- **THEN** typed error 上抛（bridge-failed），不静默转入通道 B——可用性降级归一键模式职责

#### Scenario: 锚点错位拒收

- **WHEN** imageBlobRef 解码出的 PNG 实际宽高与入参 imagePx 不一致
- **THEN** typed error 拒（image-decode-failed/尺寸不符），不产生错位 boxPx 的元素清单

#### Scenario: 真连门缺省关

- **WHEN** 未设置 SAM_ANALYZE_LIVE=1 而调用到达通道 B
- **THEN** typed 拒（live-disabled），LLM key 只走 env→config 不入留存

### Requirement: macmini SAM 桥协议与队列

daemon↔macmini 的模型推理 SHALL 经 SAM 桥：请求两类（segment/analyze），prompt 为文本或几何（points≥1 含 include/exclude 标签+可选 box），携 taskId/imageBlobRef/imagePx/canvasCm/iteration 锚点；传输 SHALL 为并发 1 串行队列+每请求 120s 超时界+排队等待上限（超出显式拒）+取消传播（排队中取消=移出，执行中取消=结果丢弃不落库）；响应侧 SHALL 支持迟到响应按请求 id 丢弃、会话死亡对全部 pending typed 拒且下次 send 重生会话、finish 优雅关闭；产物 SHALL 回传 BlobStore（putTaskArtifact fence 同事务）并留存到 DATA_ROOT/sam-logs（req-resp JSON+mask+overlay 图——输出留存可审查）；模型零检出 SHALL 表达为全零 inline mask（count=0）而非错误。

#### Scenario: 并发 1 与超时界

- **WHEN** 多个 segment 请求同时到达且桥正在执行其一
- **THEN** 其余请求入队串行；任一请求超过 120s 未响应即 typed 超时拒，队列等待者超过上限显式拒

#### Scenario: 取消传播

- **WHEN** 一个排队中的请求与一个执行中的请求分别被取消
- **THEN** 排队者移出队列不发送；执行者结果到达后被丢弃、不落库不产工件

#### Scenario: 输出留存可审查

- **WHEN** 任一桥请求完成（含降级路径外的失败前请求）
- **THEN** sam-logs 留存目录含请求/响应 JSON 与掩码/叠加图产物，blob 工件经 fence 同事务回传

#### Scenario: 零检出非错误

- **WHEN** SAM3 对提示返回零实例
- **THEN** 桥表达为全零 inline mask（count=0），不构成传输或模型错误

### Requirement: 迭代抠图循环（subject.segment）

迭代抠图 SHALL 为显式状态机（state{nodes/frontier/sealed/iter}+纯转移 step，依赖全注入可回放）：首轮=SceneAnalysis.elements 逐元素几何提示（box 中心 include 点+box；桥几何面不可用降级为 hint 文本提示）；后续轮=frontier 未停节点宽泛语义提示（英文 hint 优先、父名+整体泛化、深度分层措辞）；子节点 mask SHALL=父 mask∩子 mask（位与防外溢）；停止判据内嵌（每节点每轮评估，stop 即封叶出 frontier）；轮开始 SHALL 硬顶前置检查（达硬顶即全封停，不把注定封停的请求送上线）；maxIterations 缺省=画布面积标定 ⌈cm²/100⌉+2，maxNodes 缺省 256；低分实例（score<0.5）SHALL 不入树且父分支按模型判据判停；桥响应掩码维度 SHALL 与 imagePx 一致（不符 typed 拒）；收口 SHALL 为多主体→根=画布容器（drillWorthy=false 不产块）、单主体→根=该主体。

#### Scenario: 首轮元素提示与降级

- **WHEN** 首轮对元素「hat」发桥请求且桥支持几何提示
- **THEN** 提示=box 中心 include 点+box；桥几何面不可用时降级为该元素 hint 文本提示

#### Scenario: 子掩膜防外溢

- **WHEN** 后续轮模型返回的子节点掩膜越出父节点掩膜
- **THEN** 入树掩膜=父∩子位与结果，子节点不外溢父边界

#### Scenario: 硬顶前置零请求

- **WHEN** 轮开始时 iteration ≥ maxIterations 或节点数 ≥ maxNodes
- **THEN** 全部 frontier 节点直接封停，本轮不再发出任何桥请求

#### Scenario: 弱实例不入树

- **WHEN** 模型返回 score=0.3 的新实例
- **THEN** 该实例不入树（无垃圾节点），父分支按模型判据（low-score）判停

#### Scenario: 面积标定迭代硬顶

- **WHEN** 画布 20×30cm 与 40×50cm 分别取缺省 maxIterations
- **THEN** 分别为 ⌈600/100⌉+2=8 与 ⌈2000/100⌉+2=22（双轴同权，20×30 与 30×20 同预算）

#### Scenario: 树收口形态

- **WHEN** 首轮检出两个互不包含的主体（人物+树）
- **THEN** 终树根=画布容器节点（全画布 mask、drillWorthy=false、不产块），两主体为其子；单主体时根=该主体自身

### Requirement: 循环加固与警告面

循环 SHALL 实施五项加固且警告 SHALL 落在循环层结果面（SegmentLoopResult.warnings+逐步 meta），SHALL NOT 入侵 ObjectNode 树 schema：兄弟掩膜互斥（同层兄弟两两相交时 drillWorthy 优先保留→次小 maskPx 胜出→平局创建序早者；交集从败者清零并重算紧 bbox/effectiveMm/labVariance；败者完全吞没=移出树且其子节点移交祖辈保树闭合，warning=sibling-overlap-consumed；多遍收敛至稳定）；frontier 强制细分（非 drillWorthy 且 effectiveMm > 最大钻径×3 的节点不得 sealed，硬顶截断时 warning=depth-cap-unresolved 显式留痕）；掩膜碎片清理（入树前 4-连通域面积过滤，阈值=⌈max(200px, 0.05%×画幅)⌉，全碎片=零可用实例照旧 no-instance）；hint→category 固定映射（34 键 trim+lowercase 精确匹配，未知透传 hint 本身，空兜底 'subject'，VLM 显式 category 优先）；score 非空门禁（typeof number 门——运行时 null 不落入 low-score 误杀；检出节点 score 缺失=warning score-missing，零检出=no-instance 不入树无警告）。

#### Scenario: 兄弟重叠消解

- **WHEN** person 与 hat 兄弟掩膜相交（交集占 hat 36%）
- **THEN** 交集从败者位与清零并重算其统计量；胜者逐位不变；败者若因此归零则移出树（子节点移交祖辈）并记 sibling-overlap-consumed 警告；多遍消解收敛后总置位像素单调不增（保终止）

#### Scenario: 大块非钻层强制细分

- **WHEN** 一个占画幅 35% 的非 drillWorthy 节点（effectiveMm > 最大钻径×3）在某轮触发尺寸判据
- **THEN** 该节点不得因此 sealed，继续留在 frontier 细分；仅硬顶截断才允许停且记 depth-cap-unresolved 警告留痕

#### Scenario: 碎片清理阈值

- **WHEN** 掩膜含约 90 个 ≤200px 碎片连通域，画幅 736×736（阈值=271px）
- **THEN** 低于阈值的连通片被剔除后入树；若全部碎片低于阈值则该检出照 no-instance 路径不入树

#### Scenario: 类别确定性

- **WHEN** 元素 hint='streetlight' 无显式 category / hint='magic wand' / hint 为空
- **THEN** category 分别为映射表值 'light'、透传 'magic wand'、兜底 'subject'——同 hint 恒同 category（无随机兜底）

#### Scenario: score 缺失与 null 门禁

- **WHEN** 检出节点响应缺 score 字段（或运行时为 null）
- **THEN** null 不触发 low-score 误杀（typeof number 门）；缺失记 score-missing 警告；模型零检出=no-instance 不入树且不产该警告

### Requirement: 桥不可达降级一键模式

桥不可达时 SHALL 降级为一键模式（颜色结构分块）：桥先行（单发宽泛语义提示），单次调用内连续失败达阈值（缺省 2）SHALL 降级并记 warning{reason:'bridge-unavailable', 耗时}；调用方取消 SHALL 传播且不降级；降级算法 SHALL 确定性（Lab 空间 kmeans：固定网格采样+farthest-first 选心+固定 12 次 Lloyd+微簇死亡+4-连通域 0.5cm² 面积门，无随机源——同图同参同树）；产物 SHALL 为 ObjectTree（根=画布 drillWorthy=false，子=色区域节点 origin='auto-color'，类别=color-region）且 SHALL 可直喂树→Block 适配器。

#### Scenario: 连续失败触发降级

- **WHEN** 桥 transport 两次尝试皆败（阈值 2）
- **THEN** 不再第三次尝试，产出颜色分块树+bridge-unavailable 警告（含耗时）；取消传播的失败不计数不降级

#### Scenario: 降级产物确定性可回放

- **WHEN** 同一图同一参数连续跑两次降级分块
- **THEN** 两棵树逐字节一致（内容 hash 相等）；小于 0.5cm² 的连通域不产节点；全树 mask 逐位与 kmeans 标签分割一致

#### Scenario: 降级树喂适配器

- **WHEN** 降级产物树送入树→Block 适配器
- **THEN** 适配成功（origin='auto-color' 随块透出），后续策略链路对降级树与正常树无形态分叉

### Requirement: 树工件持久化双轨

object-tree SHALL 以「人看图+机用工件」双轨持久化：机用轨=ObjectTree JSON 落任务产物 blob（DFS 根起先序规范序列化；inline mask 超过分界（缺省 4096 字节=w×h）转内容寻址 blob、工件内留 blobRef，0=全转 blob）；人看轨=树视图叠加预览图工件；一切写入 SHALL 经 putTaskArtifact（工件 fence 与写入同事务，cancelled/cleared/已删行任务拒写）；读回面 SHALL 支持两态 mask 重建为位图。

#### Scenario: inline→blob 分界

- **WHEN** 持久化一棵含大掩码节点的树（节点 mask 字节数 > 4096）
- **THEN** 该节点 mask 转为 blob 引用（w/h 随行），小掩码保持 inline；落盘形态 DFS 先序且与 blob 内容逐字节同源

#### Scenario: fence 拒写

- **WHEN** 对已取消（cancelled）任务持久化树工件
- **THEN** ArtifactFenceError 拒写，不产半途工件

#### Scenario: 双轨同出

- **WHEN** 树定型走 persistTreeWithPreview 编排
- **THEN** 同一调用产出 object-tree.json 工件与树视图叠加预览图工件（预览含归属连线/标注，供人审查）
