# 专家工作台与尺寸钻形体系 · 产品级设计

> 版本：v1.1（2026-09-19，修订稿；Codex R1 5.6/10 NEEDS-WORK 已处置，见 §I——12 议题裁决与 P0-1~8 全部落档）
> 最高约束：Owner 需求原文（2026-09-19，见 §0.1）——本文一切裁决与其冲突处以原文为准并显式标注。
> 姊妹稿纪律沿用：`.agents/documents/2026-09-19-project-file-formats/project-format-and-redesign.md` 的「PM 立场为工作裁决、Codex 裁决前对应切片不实现」原则。§G 议题表同规。**R1 已裁决**（2026-09-19，同目录 `codex-review-r1.md`，5.6/10 NEEDS-WORK）：被推翻/收紧的立场已在正文以 [R1 推翻/收紧] 标注并改写，终局落档 §I；§G 保留 v1 立场存档并加 [R1] 标注。
> 证据分级标注：〔源码〕= 源码符号一手；〔Owner〕= 用户一手原话；〔行业〕= 公开检索（中置信，注来源）；〔判断〕= PM 推断（注置信度）。
> 本文不产出视觉 token（OJO 赛道留待方向拍板后另出简报）。

---

## 0. 决策框架

### 0.1 Owner 需求原文（逐字）

> 「你先别急着做，这不是补救就能解决的。我要的是一个类似PS的工作台。是要能对每个钻进行微调编排的。是要能 选择钻形的和尺寸的（可以自定义：上传一个贴图，并设置它的尺寸，允许拿现有的钻去做参考的）。
> 另外最重要的是，你目前不论哪个页面（提示词实验室转化工作台手动编辑），都没有考虑过尺寸的的问题。没有尺寸，那么生成的图就会有问题。
> 提示词实验室这里关于尺寸是可选的。因为用户可能基于提示词一次性就生成了带钻石排布的设计，这时候就需要尺寸信息。同时提示词中也要有钻的信息：我们需要再设置面板中启用相关的设置：可用用哪些钻，每个钻的尺寸多少编号是什么，到时候生成的图中，应该是两张图：一张是效果图，一张是蓝图（上面有钻的编号数字）。
> 但有些时候提示词只是将图片转化成另外一种结构化的图片，方便后续排钻用的，所以这时候不需要尺寸信息。
> 这里有好几个任务，你自己去分解。『手动编辑』这个改名成『专家工作台』」

### 0.2 需求解构（Owner 原文的任务拆分）

| # | Owner 语句片段 | 解构出的任务 | 归属章节 |
|---|---|---|---|
| R1 | 「类似PS的工作台…对每个钻进行微调编排」 | 手动编辑重定义为「专家工作台」：钻级选择/改属性/微移/对齐分布的编排工具集 | §B |
| R2 | 「选择钻形的和尺寸的（可以自定义：上传一个贴图，并设置它的尺寸，允许拿现有的钻去做参考的）」 | 钻目录体系：内置形 × 尺寸 × 色 × 编号；自定义钻形 = 上传贴图 + 设物理尺寸 + 以现有钻参考校准 | §A |
| R3 | 「不论哪个页面…都没有考虑过尺寸的问题。没有尺寸，那么生成的图就会有问题」〔Owner 定性：当前最大缺口〕 | 物理（mm）与像素（px）双轨语义 + 三页各自的尺寸消费模型 | §A.3 |
| R4 | 「用户可能基于提示词一次性就生成了带钻石排布的设计，这时候就需要尺寸信息」 | 实验室「成品设计」模式：物理画幅声明 + 钻清单注入提示词 | §C |
| R5 | 「设置面板中启用相关的设置：可用哪些钻，每个钻的尺寸多少编号是什么」 | 钻清单设置面板（从钻目录勾选）+ 编号体系设计 | §A.1 / §C.2 |
| R6 | 「生成的图中，应该是两张图：一张是效果图，一张是蓝图（上面有钻的编号数字）」 | 双图输出机制 + 蓝图编号可靠性方案 + .gemgen 双图归档 | §C.3 / §C.4 |
| R7 | 「有些时候提示词只是将图片转化成另外一种结构化的图片，方便后续排钻用的，所以这时候不需要尺寸信息」 | 实验室「结构化中间稿」模式 = 现状行为显式命名（尺寸可选/不注入） | §C.1 |
| R8 | 「这里有好几个任务，你自己去分解」 | openspec change 划分与切片波次 | §E |

### 0.3 总裁决（一句话版）

1. **尺寸与钻形是地基，先于一切界面**：新增「钻规格（GemSpec）」概念——形 × 尺寸构成规格，规格 × 色构成 BOM 行；`Gem`/`EditGem` 增加 `shapeId`/`diameterMm`/`rotationDeg` 载荷字段（§A.2）。
2. **编号 = 规格码，不是实例码**：Owner 说的「每个钻的编号」语境是「可用钻清单」的种类编号（形+尺寸短码如 R10/SQ35），色独立走色板；蓝图上标「种类号（图例式 1..n）」而非每钻唯一序号（§A.1.4，§C.3）。
3. **目录双真源分层**：内置形+SS 尺寸表 = engine 常量（SS_TABLE 先例）；自定义钻形 = 新项目格式 `.gemshape`（格式族第五成员），真源素材库（§A.1.2）。
4. **物理锚 = pixelsPerMm 派生 [R1 收紧·P0-4]**：成品模式声明物理画幅 → `pixelsPerMm = 实际交接 canvas 宽px / widthMm`；冻结 `PhysicalCanvas{widthMm,heightMm,anchorSource:'declared'|'default'}` 贯穿 gemgen→handoff→EditDocument/gemdoc，锚定**实际降采样后**的 canvas 宽（dimsMismatch 校验），quickLayout 显式 default=2.5（§A.3）。
5. **手动编辑 → 专家工作台**：改名 + 编排工具集（属性面板/nudge/对齐分布 P0；**旋转 = 属性面板数值/步进编辑升 P0**——[R1 推翻原 P1 降级·议题 6]；旋转手柄/切向对齐仍 P1）（§B）。
6. **实验室双模式为 run 级开关**：结构化中间稿（现状，无尺寸）/ 成品设计（尺寸+钻清单+双图）（§C.1）。
7. **双图 = 效果图 generate + 携带效果图的 `/images/edits` 蓝图请求**（[R1 推翻「两次独立请求」原案·议题 1/P0-3]——第二次请求以效果图为输入，蓝图 prompt 描述「本图→施工蓝图」转换任务）；蓝图为「**人审参照、非 BOM 数据源**」（UI/档案双标记），编号图例为必须、逐钻标号为尽力而为；机器级同排布显式超出本 change（§C.3）。
8. **四格式 formatVersion 1→2 + 新格式 .gemshape**：迁移注册基建在而**迁移表当前为空**（[R1 纠偏]）；时序 [R1 推翻原案·P0-5]——**2.x 开工前先落「v2 contract gate」**（四格式 v2 类型/迁移入口/BaseSpec/物理锚字段冻结，2.x serializer 直接消费 v2 类型，v1 不成为写入真源），完整迁移实现仍归 add-gem-catalog；bump 不并入未归档的 add-project-files（§E.1/E.2）。

---

## §A 尺寸与钻形数据模型（地基，跨三页）

### A.1 钻目录（Gem Catalog）

#### A.1.1 形状（Shape）内置集

〔行业·中置信〕烫钻（hotfix rhinestone）常见形状：圆形（绝对主流）、方形、水滴/梨形（drop/pear）、心形（heart）、马眼/橄榄形（marquise）、椭圆形（oval）；异形通常按 mm（或 PP 制）售卖而非 SS 制——SS 尺寸体系主要描述圆钻（来源：Rhinestone Guy SS/PP/mm 指南、Fire Mountain Gems 换算表、Crystal Ninja SS3–SS50 图表，见文末来源）。

裁决内置形状集（P0 五形 + P1 两形）：

| 形 id | 中文名 | 短码 | 几何 | P0/P1 |
|---|---|---|---|---|
| `round` | 圆形 | R | 圆（现状唯一形） | P0（= 现状兼容） |
| `square` | 方形 | SQ | 正方形（边长 = 尺寸） | P0 |
| `drop` | 水滴 | DP | 梨形轮廓 | P0 |
| `heart` | 心形 | HT | 心形轮廓 | P0 |
| `marquise` | 马眼 | MQ | 两端尖橄榄形 | P0 |
| `oval` | 椭圆 | OV | 椭圆 | P1 |
| `star` | 星形 | ST | 五角星 | P1 |

- 内置形 = engine 常量（新文件 `engine/shapes.ts`：形 id / 短码 / 中文名 / 归一化轮廓 path 数据），**不入库、不序列化、随 ENGINE_VERSION 语义演进**（SS_TABLE 先例，〔源码〕grid.ts 头注「SS→mm 非线性永远查表」同款纪律）。
- 尺寸体系双轨（〔行业〕SS 制描述圆钻、异形按 mm 的行业事实 + Owner「可以自定义…设置它的尺寸」）：
  - 圆形：沿用 SS_KEYS 十二档（SS6=2.0mm … SS34=7.1mm，〔源码〕SS_TABLE），直径 = SS 表值；
  - 异形与自定义：直接 mm 数值（主尺寸 = 最大径；方形 = 边长，水滴/心/马眼 = 长轴）。异形附标准纵横比（内置常量，如水滴长宽比 1.5:1），用户可覆写宽（P1）。

#### A.1.2 目录的真源与 .gemshape 新格式

「钻目录」不是单一页面，是**两层配置资产**：

```
钻目录（概念）
 ├─ 内置规格（round×SS 十二档 + 四异形×常用 mm 档）＝ engine 常量，代码层真源
 └─ 自定义钻形（用户上传贴图 + 物理尺寸 + 参考校准）＝ .gemshape 库资产，素材库真源
```

裁决：**自定义钻形 = 新项目格式 `.gemshape`**（projectKind `'gemshape'`；MIME `application/vnd.rhinestone-studio.gemshape+json`；格式族第五成员），真源 = 素材库新系统目录 `sys-shapes`（「钻形」，目录序插在「模板」与「生成结果」之间——配置资产聚簇）。反对两案：

- 反对「塞进 gemtpl」：模板是提示词配置，钻形是物理素材定义，概念混入（PRODUCT_MODEL 硬规则 6 的精神）；
- 反对「纯内存/不落盘」：Owner 的自定义钻形是可复用资产（多个设计复用同一颗自定义钻），不持久化 = 数据损失路径。

Schema 草案（契约冻结在对应 change 的 contract gate，此处为 PM 立场）：

```ts
interface GemshapeFile {
  kind: 'gemshape'
  formatVersion: 1
  appVersion: string
  createdAt: number
  savedAt: number
  name: string                    // 用户命名，如「金色五角星」
  texture: {                      // 贴图内嵌（gemgen image 先例：dataUrl 为唯一字节载体）
    mime: string                  // [R1·P0-6] MIME 白名单（可解码集），parser 校验
    dataUrl: string
    width: number                 // px（声明值——parser 解码后以实际宽高覆盖校验，不符拒收）
    height: number
  }
  physical: { widthMm: number; heightMm: number }   // 贴图物理尺寸（diameterMm 取 max）
  calibration: {                  // 校准来源（仅溯源展示，不参与计算）
    mode: 'direct' | 'reference'  // 直接输 mm / 以现有钻参考
    refSpecId?: string            // mode=reference 时：以哪个规格为量纲（如 round-ss10）——[R1·P0-6] 必须可解析
    refSpecSnapshot?: GemSpecSnapshot  // [R1·P0-6] 内嵌参考规格快照：refSpecId 解析失败时的审计凭据
  }
}
```

「拿现有的钻去做参考」〔Owner〕的语义落地 = **校准流程**：用户上传贴图后，二选一设定物理尺寸——(a) 直接输入 mm；(b) 选一颗现有规格（如 SS10 圆钻，2.8mm），系统将「贴图主径 px ÷ 参考规格 mm」作为该贴图的 px/mm 比例，反推 physical 尺寸（**贴图主径 px = alpha 内容 bounds 的主径**，非整张贴图外框——[R1·P0-6] 定义冻结）。校准结果物化为 `physical`（快照），`calibration` 只记出处——参考钻后续改动不影响已入库钻形（烘焙语义，与 ManualEditHandoff 同 philosophy）。

**[R1 收紧·P0-6] .gemshape schema gate（parser 层冻结，先于 renderer 落地）**：

1. **解码后实际宽高校验**：dataUrl 解码得实际 width/height，与声明不符 = typed error 拒收——声明值不是信任源；
2. **输入上限**：MIME 白名单 + 最大字节数 + 最大像素数（防炸弹贴图与性能失控）；
3. **alpha bounds 非空**：全透明（空 bounds）= 拒收；主径/物理换算一律取 alpha 内容 bounds；
4. **fit 语义冻结**：physical 宽高与贴图（alpha bounds）纵横比不一致 = **拒绝**（超容差 typed error；容差内按贴图实际纵横比校正 physical 并告警）——不做静默裁剪/contain，比例漂移即物理尺寸谎言；
5. **校准悬空防线**：mode='reference' 必须满足 refSpecId 可解析**或**内嵌 refSpecSnapshot 至少其一；参考规格资产被删除后，已入库钻形保持**可审计**（calibration 快照仍在）但**不可重新校准**；
6. **missing custom asset = visible/typed 状态**：文档引用的 .gemshape 缺失时走显式 missing 态（占位渲染 + BOM/导出清单标注），**禁止静默降级为圆钻轮廓后照常导出**（导出前置 gate 拦截）。

#### A.1.3 规格与序列化/渲染

- **GemSpec（内存概念，非独立文件）** = `{ specId, shapeId, sizeLabel, diameterMm, source: 'builtin'|'custom', assetId? }`。内置规格 specId 确定性（`round-ss10`、`square-3.5`）；自定义规格 specId = `custom-<gemshapeAssetId>`。
- **[R1 收紧·P0-1/议题 2] GemSpecSnapshot（序列化/归档/BOM 的稳定身份，契约冻结）** = `{ specKey, ordinal, shapeId, sizeLabel, diameterMm, widthMm?, heightMm?, assetId? }`——稳定身份**不由显示码反推**：`specKey` 为 canonical 稳定键（BOM 键数据源；同形同尺寸的不同自定义资产靠 `assetId` 区分，canonical 至少含 assetId）；`ordinal` 为清单序号 1..n（蓝图编号即此），**ordinal→specKey 映射随每次 run/gemgen 持久化保存**；`sizeLabel` 仅显示用，不参与身份。
- **渲染双轨**：内置形 = 矢量轮廓（engine/shapes.ts 的归一化 path，按 diameterMm 缩放绘制，SVG/Canvas 双消费——exportSvg 与 EditCanvas 共用同一 path 数据源）；自定义形 = 贴图 drawImage（physical 尺寸 × pixelsPerMm → px，SVG 侧 `<image>` dataUrl 引用）。〔判断·高置信〕贴图方案必然：用户上传的就是位图，强制转矢量超 P0 范围；B 端风险（贴图边缘白边/非透明背景）在钻形库 UI 提供「透明背景建议」文案 + P1 裁剪工具。
- **规格不入 Gem 序列化**：钻位序列化的是物化快照字段（shapeId + diameterMm，见 A.2），自定义形另由 `assetId` 引用（弱引用 + missing 容忍四态，reference 先例〔源码〕EditView referenceAssetId；[R1 收紧·P0-6] missing 态为 visible/typed 且导出阻断，**不得静默回退圆钻后照常导出**——见 A.1.2 gate 6）。裁决理由：目录条目可删可改，钻位文档必须自包含可渲染（回退轮廓仅限画布占位，不进导出物）。

#### A.1.4 编号体系（Owner 明示「每个钻…编号是什么」）

三个候选：

| 方案 | 形态 | 优势 | 劣势 |
|---|---|---|---|
| a. 组合码 | `R10-RED`（形+尺寸+色拼码） | 自描述 | 色无法稳定入码（中文色名/色板可编辑）；目录维度耦合：改色即改码；码长，蓝图钻位上标不下 |
| b. 条目自增码 | 目录条目 01/02/03… | 最短 | 不自描述；跨项目不稳定（本项目 01 ≠ 彼项目 01）；与既有 colorId 体系平行再造一套 ID |
| c. **规格码（采用）** | `R10`（圆 SS10）/ `SQ35`（方 3.5mm）/ `DP06`（水滴 6mm）/ `C-star01`（自定义） | 短、稳定（形×尺寸确定即确定）、与采购语义一致（买钻按规格买）；色沿用色板 colorId，正交不耦合 | 同形同尺寸不同色共享码——但 BOM 本就按「规格×色」两列聚合，蓝图色由平涂色表现，无歧义 |

裁决：**方案 c**。BOM 聚合键从 `colorId` 升级为 **canonical GemSpecSnapshot 键（`specKey`，至少含 assetId）× `colorId`**——[R1 收紧·议题 2] 键取快照 canonical 值，**不由显示码（R10/SQ35）反推**（显示码仅作人读列）；蓝图图例行 = `编号：规格码 · 色名`（如 `1：R10 · 正红`）。「编号」的语义锚定见 §C.3——Owner 语境是「可用钻清单」的种类编号，不是每钻实例的唯一序号（几百个唯一序号在生成图上既画不准也没消费方）。

### A.2 Gem 数据模型升级

〔源码〕现状 `Gem { id; x; y; colorId; blockId }`——无 shape/尺寸字段；`EditGem` 同。升级（**P0 一次性带全，避免 gemdoc 二次 bump**）：

```ts
interface Gem {
  id: string
  x: number
  y: number
  colorId: string
  blockId: string
  shapeId: string        // 'round'（缺省，v1 迁移补）| 'square'|'drop'|...| 'custom'
  diameterMm: number     // 最大径（圆=直径；方=边长；水滴/心/马眼=长轴）——间距校验与渲染缩放的唯一物理依据
  rotationDeg?: number   // 异形朝向（0 = 默认朝上；圆钻恒缺省）——P0 渲染支持、P1 编辑工具
  assetId?: string       // shapeId='custom' 时的 .gemshape 弱引用（missing 容忍，回退圆轮廓）
}
// EditGem 同步扩展（origin/moved 语义不变）；EditGemFields（update patch 白名单）扩 'shapeId'|'diameterMm'|'rotationDeg'
```

裁决理由（字段为什么是物化快照而非 specId 引用）：engine 是纯函数深模块（〔源码〕edit.ts 头注「引擎不依赖编辑器」），间距校验需要逐钻直径——引目录 = 引 IO 依赖，违背深模块契约；直径随钻位走，规格目录可变而文档稳定。

**[R1 收紧·P0-1] BaseSpec 与 GridSpec 派生关系（契约冻结）**：`BaseSpec = { shapeId, sizeLabel, diameterMm, widthMm?, heightMm?, assetId? }`（整图基础规格，.gemproj physics / 布局入口 / handoff 携带）；**`GridSpec` 重定义为「由 BaseSpec 派生的几何上下文」**（pitchMm/rowAngleDeg/pixelsPerMm 等），不再独立携带 `ss` 语义，`gridFromSs` 降位为 BaseSpec 构造入口的圆钻特例（SS_TABLE 查表不变）。`toEditGem/fromEditGem`、四格式 v2 serializer、BOM、蓝图 ordinal 全部消费 BaseSpec/GemSpecSnapshot，round-trip/identity 测试随 W0 冻结——没有该 gate，三个 change 不切 W1（§I.3 放行条件 1）。

**对四个文件格式的 schema 影响**（formatVersion 全族 1→2；[R1 纠偏] 迁移注册基建在〔源码〕labFile `registerLabFileMigration` + projectFile 同构，但**迁移表当前为空**——实现归 W0/W2，时序见 §E.1）：

| 格式 | v1→v2 变更 | 迁移补默认 |
|---|---|---|
| `.gemproj` | `physics{ss,gapMm,…}` → `physics{baseSpec{shapeId,sizeLabel,diameterMm,widthMm?,heightMm?,assetId?}, gapMm, globalDensity, relax}`；新增 `physicalCanvas?: PhysicalCanvas`（[R1·P0-4] 原 declaredPhysical 草案升级为含 anchorSource 的 PhysicalCanvas，见 A.3）；`overrides` schema 预留 `spec?` 覆写位（P1 落地；图层稿裁决后可能被「策略归层」吸收，见 §D 末备注）。**[2026-09-19 R2 合流勘误：本行「顶层 physics.baseSpec」写法已被 studio-layers codex-review-r2 §三-3 推翻——v2 gemproj 无单一顶层 baseSpec，规格归层（layers[].specKey），画幅级仅保留 PhysicalCanvas 等字段；规范定义以 openspec/changes/add-gem-catalog-and-sizes（W0 contract gate）为准，本行仅存档]** | `baseSpec = {shapeId:'round', sizeLabel: old.ss, diameterMm: SS_TABLE[old.ss]}` |
| `.gemdoc` | `gems[]` 每项 + shapeId/diameterMm/(rotationDeg)/(assetId)；+ `physicalCanvas?` | round + grid.ss 查表直径 + 无旋转 |
| `.gemtpl` | + `workflowMode?: 'structured'|'product'`（缺省 structured；[R1·议题 9/P0-7] 原 `mode?` 草案废弃——与 endpoint 语义同字段冲突）；+ `gemSpecIds?: string[]`（模板绑定钻清单，字段 P0 落、编辑 UI P1，见 §C.1） | 两键缺席 = structured / 无清单 |
| `.gemgen` | `image` 键**不动**（消费兼容）；新增可选 `blueprint?: GemgenImage`（含 `effectRequestId`/`blueprintRequestId` 溯源 + 「人审参照、非 BOM 数据源」typed 标记，见 C.3/C.4）；`provenance` + `workflowMode?`/`requestMode?`（[R1·议题 9] 两字段分离）、`gemSpecs?: GemSpecSnapshot[]`（含 ordinal→specKey 持久化映射）、`physicalCanvas?` | 缺席 = 无蓝图（旧档） |

每次 bump 附 round-trip 字节等价测试（〔源码〕add-project-files design §1.3 既定纪律）。ENGINE_VERSION 同步 bump（1→2：validate/conflict/export 语义变更，横幅诚实性前提〔源码〕design §1.1）。

**engine 影响面清单**（P0 边界详见 §D）：

1. `grid.ts`：`gemRadiusPx(grid)` → `gemRadiusPx(gem, grid)`（逐钻）；`SS_TABLE`/`gridFromSs` 不动（base spec 构造入口不变）；
2. `validate.ts` / `edit.ts validateEditable` / `conflict.ts resolveGreedy`：判据从单一 pitch → 逐对，**唯一 helper `requiredCenterDistancePx(a, b, grid)`（单位恒 px）**；spatial hash cell = `maxCellPx`（px 单位，见 §D-2 [R1·P0-2]——禁止 mm 裸传 SpatialIndex）；
3. `export.ts buildSvg`：`<circle>` → 按 shapeId 分发（圆保留 circle 快路径；异形 path；自定义 `<image>`）；`buildBom` 聚合键 `colorId` → **canonical `GemSpecSnapshot.specKey`（至少含 assetId）× `colorId`**（[R1 收紧·议题 2] 不由显示码反推），表头加规格码/形状/尺寸列；
4. `layout` 五策略生成**不动**（仍按 base spec 单一 pitch 排布——混合径布局属 P1+，见 §D）；
5. `types.ts` zod schema 同步（Gem 字段进入公共契约面）。

### A.3 物理 vs 像素的双轨语义

〔源码〕现状：`GridSpec.pixelsPerMm` 是 mm↔px 唯一换算系数，但取值恒为常量 `PIXELS_PER_MM = 2.5`（且在 studio.svelte.ts / edit/gemprojReplay.ts / edit/quickLayout.ts 三处重复定义——见 §H 摩擦）；实验室 `size='1024x1024'` 是**生成图像素尺寸**（API 参数），与物理无关——这就是 Owner 说的「没有考虑过尺寸」的技术本质：三页只有像素轨，物理轨只在 grid 层隐性存在且锚死 2.5。

**换算锚裁决 [R1 收紧·P0-4：PhysicalCanvas 契约 + 全链贯通]**：

```ts
interface PhysicalCanvas {
  widthMm: number
  heightMm: number
  anchorSource: 'declared' | 'default'   // 声明来源（成品模式）｜2.5 缺省（现状兼容）
}
```

- `pixelsPerMm := 实际交接 canvas 像素宽 ÷ widthMm`——**锚定实际降采样后的 canvas 宽（`image.width`）**，不用文件记录宽：〔源码〕gemprojReplay `dimsMismatch` 路径警示「文件记录尺寸 ≠ 实际降采样尺寸」，盲用文件宽 = 错误 px/mm；dimsMismatch 时以实测为准并校验/告警。锚点由「成品设计」模式声明（PhysicalCanvas），其余场景缺省 2.5 且显式标 `anchorSource:'default'`（quickLayout 同规——显式 default=2.5）。
- **贯穿链**：`gemgen provenance → 送排钻 handoff → EditDocument/.gemdoc`（及 .gemproj `physicalCanvas`）全链路承载 PhysicalCanvas；三处 `PIXELS_PER_MM=2.5` 副本收编为 engine 单一出口（§H-1）。
- **校验**：宽高正数、与画幅 px 纵横比一致性校验、缺失/错误声明回退 default 并标注。
- **不变量测试**：2048→1024 降采样、非正方形画幅、缺失/错误声明回退、保存再加载后钻径像素值不变。
- 一颗 SS10 钻在任何 pixelsPerMm 下的物理直径恒 2.8mm——像素直径 = 2.8 × pixelsPerMm。整幅物理尺寸 = 图像 px 尺寸 ÷ pixelsPerMm（排钻设计/专家工作台的画幅标尺读数）。

**三页各自需要哪个轨**：

| 页 | 像素轨（px） | 物理轨（mm） | 缺口修复 |
|---|---|---|---|
| 提示词实验室 | API `size`（生成分辨率；[R1·议题 9] 结构化 `{widthPx,heightPx}`） | **可选**（成品模式）：PhysicalCanvas 声明 → prompt 比例锚 + gemgen provenance 存档 | §C |
| 排钻设计 | 图像像素（画布坐标） | 主导：pitch/gap/钻径全物理；新增 physicalCanvas 感知（重放 pixelsPerMm = 实际 canvas 宽 ÷ widthMm，anchorSource 区分 declared/default）+ 画幅物理尺寸展示 | §D |
| 专家工作台 | 画布坐标（渲染） | 每钻 diameterMm + 整幅物理尺寸读数（标尺/状态条）+ nudge 的 0.1mm 步进 | §B |

---

## §B 专家工作台（改名 + PS 化重定位）

### B.1 改名联动表

| 位置 | 现值（〔源码〕TERMS v1） | 新值 | 备注 |
|---|---|---|---|
| 顶级导航（桌面） | 手动编辑 | **专家工作台** | Owner 明示 |
| 移动端 Tab | 手动编辑（4 字过长，移动端现值待查证） | **专家**（2 字短名） | 沿「排钻」短名先例 |
| TERMS 词条「手动编辑」 | 钻级精修模块 | 改词条：专家工作台 = 钻级编排与精修模块；禁用词：手动编辑、精修编辑器 | 禁用词**加入**「手动编辑」（历史名退役） |
| TERMS 词条「排钻设计」禁用词 | 转化工作台、**工作台** | 调整：禁用词改为「转化工作台」；「工作台」从排钻设计禁用词移除（被新模块名合法占用），但独立使用「工作台」仍不注册（避免歧义） | TERMS 需 v2，显式登记此冲突消解 |
| 送精修（排钻→编辑交接） | 送精修 | **不变**〔判断〕：动作语义（烘焙交接）没变，改名只改模块名；「送专家工作台」冗长 | Codex 议题 11 可复议 |
| 精修项目（.gemdoc） | 精修项目 | **不变**：文件格式名/资产 kind 不随模块改名（gemdoc 语义仍是烘焙文档） | 同上 |
| 编辑页空态引导文案 | 「去排钻设计送精修」 | 不变 | — |
| PRODUCT_MODEL | 手动编辑做「钻级精修」 | 专家工作台做「钻级编排精修」；对象树/真源表同步 v4 | §E.1 |

### B.2 每钻微调编排（PS 感工具集，P0/P1 分层裁决）

整体布局（现状「左工具栏 + 顶部参数条 + 右侧图层/计数面板」〔源码〕add-manual-edit-mode design §3 骨架保留，右面板扩容）：

```
┌──────────────────────────────────────────────────────────────────────┐
│ [▦] 项目名 ●未保存   │ 工具: ▢选择 ✚画钻 ⌫擦除 │ snap:◎pitch ○自由 │ ⌘Z ⌘⇧Z │
├────┬────────────────────────────────────────────────┬────────────────┤
│ 工 │                                                │ 属性(选中态)    │
│ 具 │                                                │ ┌────────────┐ │
│ 栏 │                                                │ │ 形状 [圆形▾]│ │
│    │              画布（四层合成）                    │ │ 尺寸 [SS10▾]│ │
│ 选 │                                                │ │ 颜色 [■ 正红]│ │
│ 画 │              选中钻: 高亮描边                   │ │ 朝向 [  0°▾]│ │ ←P0 数值/步进（[R1] 升 P0）
│ 擦 │              + 尺寸角标(2.8mm)                  │ └────────────┘ │
│    │                                                │ 对齐/分布(≥2选)│
│    │   状态条: 2,341 钻 · 画幅 210×148mm · 4.9px/mm │ ⟵⟶↑↓ ⊞ 等距  │
│    │                                                │ 图层/计数/BOM  │
└────┴────────────────────────────────────────────────┴────────────────┘
```

| 工具 | 行为 | P0/P1 | 语义要点 |
|---|---|---|---|
| 选择/框选+批量改属性 | selection → 属性面板改形/尺寸/色（update patch） | **P0** | 改形/改尺寸入 `EditGemFields`；批量 = 一个 undo 组；改尺寸后立即触发 spacing 重校验（实时警告，不阻断编辑） |
| nudge 微移 | 方向键 = 1px；Shift+方向 = 当前钻 pitch 步进；Alt+方向 = 0.1mm | **P0** | PS 肌肉记忆；nudge 产生的 update patch 按「一次按键会话」（keydown 起至 500ms 无新按键）合组 undo |
| 对齐 | 多选 ≥2：左/右/上/下/水平居中/垂直居中 | **P0** | Owner「编排」的核心词——对齐是编排的最小完备集 |
| 分布 | 多选 ≥3：水平等距/垂直等距 | **P0** | 同上 |
| 删除 | Delete/Backspace | **P0** | 现有 selection 语义沿用 |
| 画钻笔刷（重定义，见 B.3） | 当前 spec 落钻 | **P0** | — |
| 擦除笔刷 | 命中删除 | **P0** | 旧契约沿用 |
| 选块策略填充 | layout([block]) 局部重排 | **P0** | 旧契约沿用（新钻带 base spec 字段） |
| 撤销/重做/一键修复/导出 | — | **P0** | 旧契约全部沿用（§B.4 声明） |
| 旋转·属性面板 | 朝向数值输入 + 步进（1°/15° 档）；入 `EditGemFields`，undo/渲染/SVG 同步冻结 | **P0** | [R1 推翻原 P1 降级·议题 6] 异形钻可选到却无 P0 修正入口 =「选择形状」能力不完整 |
| 旋转手柄 / 路径切向对齐 | 画布旋转手柄 +「对齐到路径切向」 | **P1** | 交互增强（非修正能力），维持 P1 |
| 阵列/步进重复 | 行×列×间距批量布钻 | **P1** | PS 感增强，非编排必需 |
| 套索/魔棒/路径工具 | — | P1/P1+ | 旧契约排期沿用 |

### B.3 笔刷重定义（在钻形/尺寸模型上）

- **画钻笔刷 = 当前选中规格（形 × 尺寸 × 色）**：「当前 spec」选择器住在顶部参数条（形状/尺寸下拉 + 色板色），笔刷落钻即物化该 spec 为钻位字段（shapeId/diameterMm/colorId，origin='manual'）。
- 落点吸附开关（顶部「snap」）：`pitch`（默认，吸附到当前 spec 的六方格位——**旧契约「snap 六方格位落钻」沿用**）/ `自由`（完全自由坐标，PS 自由放置感）。冲突拒画沿用（与既有钻 pairwise 间距不足时拒画并闪红）。
- 拖拽连线等弧长补钻：沿用，等弧长步距 = 当前 spec 的 pitch。
- 擦除笔刷：沿用（过 selection/整图层无差别）。

### B.4 与 add-manual-edit-mode 旧契约的继承/覆盖声明（显式覆盖登记）

| 旧契约条目（design.md） | 处置 | 说明 |
|---|---|---|
| §1 数据契约（EditDocument/ManualEditHandoff/双 validate/色板禁删/撤销栈规格） | **沿用** | EditGem 字段扩展（A.2）为增量，签名与语义不变 |
| §1 ManualEditHandoff 字段 | **沿用+扩展** | + `baseSpec`（BaseSpec 快照）与 `physicalCanvas`（PhysicalCanvas）随 grid 携带（[R1·P0-1/P0-4]）；宽高/paintingSnapshot 不变 |
| §2 渲染性能基线（1k/10k/20k 钻 60fps 任务化） | **沿用** | 异形 path/贴图渲染计入基准（新增 20k 异形 case） |
| §3 工具表·画钻笔刷「snap 六方格位」 | **覆盖** | → 「当前 spec + snap 可关（pitch/自由）」（B.3）；Owner「类似 PS 的工作台」直接指向自由度提升 |
| §3 工具表其余行（擦除/选块填充/撤销/一键修复/导出） | **沿用** | — |
| §4 引擎出口排期（resolveConflicts P0；blockFromMask/layoutAlongPath P1） | **沿用** | — |
| §5 五议题终裁 | **沿用** | 本轮不推翻任何终裁 |
| add-project-files §4「编辑器永不长参数面板（概念混入禁令）」 | **沿用（边界重述）** | 属性面板是**选中对象的属性**（PS Inspector 语义），不是管线参数面板——不改分块/策略/密度，概念混入禁令不破 |

**归档注记要求**：add-manual-edit-mode change 归档时在 spec 同步中登记本轮对 §3 画钻笔刷行的覆盖，避免 openspec specs 与实现漂移（§H 摩擦 3）。

### B.5 自定义钻形管理 UI 与图层

钻形库（入口：专家工作台左工具栏「钻形库」按钮 + 素材库 sys-shapes 目录双击「去使用」= 设为当前 spec；管理 = RightSheet 编辑器，沿 gemtpl 双 canonical handler 先例）：

```
┌─ 钻形库 ──────────────────────────────────────────────┐
│ [内置形]  ●○○○○ ○○○○○  (R/SQ/DP/HT/MQ × 尺寸档下拉)  │
│ [我的钻形] ┌────┐ ┌────┐ ┌─────────────┐              │
│            │ ⬟金 │ │ ❤红 │ │  ＋ 上传贴图  │              │
│            │ 5mm │ │ 6mm │ │  设尺寸/参考  │              │
│            └────┘ └────┘ └─────────────┘              │
└───────────────────────────────────────────────────────┘
上传向导（Dialog 三步）：
 ①选贴图 → ②物理尺寸：[__]mm 直接输入  或  ●参考现有钻 [SS10 圆形▾]
   （参考模式预览：贴图叠加在参考钻轮廓上，主径对齐）→ ③命名入库
```

图层/参考底图：四层（painting/reference/blocks/gems）显隐+透明度沿用〔源码〕EditDocument.layers；**锁定**（层锁防止误编辑 painting/reference——它们本就不可编辑，锁是 P1 视觉强化）P1。整幅物理尺寸读数（状态条「画幅 210×148mm · 4.9px/mm」）P0——尺寸可见性是 Owner R3 的最小兑现。

---

## §C 实验室双模式

### C.1 模式开关（workflowMode）与请求语义分离

Owner 的两种情形（R4/R7）：**同一实验室的两种任务意图**，不是两个模块。裁决：**run 级开关**（发起生成时生效），住设置面板区、默认「结构化中间稿」。

**[R1 收紧·议题 9/P0-7] 字段分离（推翻 v1 的 `mode` 复用草案）**：既有 `RunMode = 'generate'|'edit'` 是 **endpoint 语义**（API 请求类型；LabTask 与 gemgen provenance 同名使用〔源码〕），产品工作流语义不得同字段混载：

| 字段 | 值域 | 语义 | 宿主 |
|---|---|---|---|
| `requestMode` | `'generate' \| 'edit'` | API endpoint 类型（原 `LabTask.mode` 改名，旧档迁移只读兼容） | LabTask / gemgen provenance |
| `workflowMode` | `'structured' \| 'product'` | 产品工作流（结构化中间稿 / 成品设计） | run 表单态 / gemgen provenance / gemtpl v2 |

| workflowMode | 名称（TERMS 注册） | 语义 | 尺寸 | 钻清单 | 输出 |
|---|---|---|---|---|---|
| structured（现状显式命名） | **结构化中间稿** | 图 → 结构化贴钻效果图，供排钻设计继续加工（现状 composeDrillPrompt 四规则行为） | 不注入 | 不注入 | 单图（现状） |
| product（新增） | **成品设计** | 提示词一次性生成带钻排布的成品设计 | **必填**（PhysicalCanvas，§A.3） | **勾选目录规格**（GemSpecSnapshot） | 双图（效果图 + 蓝图，§C.3） |

结构化配套 [R1 收紧·议题 9]：`form.size` 从自由字符串（`'1024x1024'`，正则兜底散在 sizeFallbackOf——§H-4）升级为结构对象 `{widthPx, heightPx}`；物理画幅独立走 PhysicalCanvas 声明，两轨不混一个字符串；`gemContext` 只在 `workflowMode='product'` 注入，任务/档案快照完整记录两字段。

层级裁决：模式是 run 级（会话表单态，同 size/advancedJson 平级——〔源码〕lab store form）；**模板可携带偏好**（gemtpl v2 `workflowMode?` + `gemSpecIds?`，P1 落 UI）——模板 = 配置资产，成品设计模板绑定其常用钻清单是自然演化，但 P0 不做（避免 TemplateEditor 双宿主联动扩面）。〔判断·中高置信〕

### C.2 设置面板与提示词注入

```
┌─ 实验室 · 设置区 ────────────────────────────────────┐
│ 模式  (●) 结构化中间稿  ( ) 成品设计                   │
│ ── 以下仅成品模式可见 ────────────────────────────── │
│ 画幅物理尺寸  [210]×[148] mm  [A4▾][A5▾][自定义]      │
│ 可用钻清单  [管理钻形库]                               │
│   ☑ 1 R10  圆形 SS10 2.8mm   ☐ 4 SQ35 方形 3.5mm     │
│   ☑ 2 DP06 水滴 6mm          ☐ 5 HT05 心形 5mm       │
│   ☑ 3 MQ08 马眼 8mm          ☐ … 自定义钻形…          │
│ 输出  效果图 + 蓝图（编号图例）                        │
└──────────────────────────────────────────────────────┘
```

- 钻清单勾选上限 [R1 推翻硬上限·议题 12]：**默认 8 + 可读性警告**——超过默认值时警告「编号可辨性可能下降」（对齐 SegmentOptions k 的 6..10 心智与蓝图可读性〔判断·中置信〕）但**不阻断**勾选（真实项目可能就是多规格 BOM，硬上限会拒绝真实数据表达）；图例支持分页/按形状分组；若供应商/模型侧存在硬限制，由模型能力配置表达，不在产品层拍死。
- **提示词注入 = composeDrillPrompt 组装器扩展**（不写入模板体——骨架永不入 gemtpl 的既定裁决〔源码〕add-project-files §7.1 沿用）：新增第三参 `gemContext?: { physical: PhysicalCanvas; specs: GemSpecSnapshot[] }`（[R1·议题 2/9] snapshot 含 ordinal→specKey 持久化映射；只在 workflowMode='product' 注入），组装器在「通用贴钻规则」后拼入「成品设计约束」节：

```
【尺寸与钻规格】
画幅物理尺寸 210×148mm（横向 A5）。图宽对应 1024px：1mm ≈ 4.9px。
SS10 圆钻直径 2.8mm ≈ 画幅宽度的 1.33%——所有钻按此物理比例绘制。
只允许使用以下钻（编号将用于蓝图）：
  1 = R10 圆形 SS10（直径 2.8mm）
  2 = DP06 水滴形 6mm（长轴 6mm）
  3 = MQ08 马眼形 8mm（长轴 8mm）
```

比例锚（钻径/画幅宽 百分比）是给模型的最强尺寸信号——mm 对生成模型是无量纲记号，比例有实感〔判断·中高置信〕。

### C.3 双图输出：蓝图机制与编号可靠性

方案对比（v1.1 [R1 推翻原 (a) 案改写]）：

| 方案 | 机制 | 判定 |
|---|---|---|
| (a) **效果图 generate + 携带效果图的 `/images/edits` 蓝图请求（采用·v1.1）** | 第一次请求生成效果图；第二次请求**以效果图为输入**走 `/images/edits`，蓝图 prompt 描述「本图 → 施工蓝图」的**转换任务**；两次各自 n:1，恒单图契约〔源码〕client 头注不破 | 采用（[R1] 议题 1/P0-3 裁决）：排布一致性的来源从「两次随机生成的祈祷」变为「图像编辑的输入约束」；代价 = 双倍配额 + 第二请求的图片上传与独立失败态（UI 显式提示，§C.4 子任务状态承接） |
| (a′) 两次独立 generate（v1 原案） | 蓝图 prompt 单独 generate | **[R1 推翻]**：两次独立随机请求无共享 latent/坐标，第二次只读到「蓝图 prompt」，无法证明复现第一次钻位——只保证「两个提示词」不保证语义配对；「视觉上像一对但钻位不同」的图送排钻 = 错误生产依据 |
| (b) 单请求多图 | API `n:2` 出图 | 否决：n>1 语义是「两个候选」不是「一对语义不同的图」；且 client 恒 n:1 是既定契约〔源码〕；gpt-image-1 等即便支持 n，两张图 prompt 不同则不可用 |
| (c) 蓝图后处理渲染 | 本地解析效果图标钻 → canvas 重绘 | 否决：效果图钻位无坐标数据，检测不可靠（这是把最难的问题留给最弱的环节） |

**蓝图 prompt 要求**（组装器生成；第二请求携带效果图、`requestMode='edit'`，与效果图同 run 发起）：

```
【第二张：施工蓝图】（输入 = 上面的效果图）将这张效果图转换为白底平面施工蓝图：
保留图中每个钻位的排布位置、真实形状轮廓（圆形/水滴/心形/马眼/方形）与物理比例，
去除背景与光照，每颗钻平涂其颜色；每个钻位中心标注其编号数字（1/2/3…，与清单一致），
字号不小于钻径；右下角图例列出编号对应规格（可分页/分组）。不新增、不移动、不删除任何钻位。
```

**「人审参照、非 BOM 数据源」标记语义（v1.1 新增，[R1] 议题 1/P0-3）**：

- **UI 层**：蓝图卡/预览固定角标「人审参照 · 非 BOM 数据源」；送排钻入口若以蓝图为视觉凭据，显式要求人工确认；
- **档案层**：gemgen v2 `blueprint` 键记录 `effectRequestId`/`blueprintRequestId` 与失败原因（typed），并携带人审参照标记——蓝图元数据自描述「不可作为 BOM 数据源」；BOM 一律由排钻设计/专家工作台引擎重算。

**编号与配对可靠性论证（v1.1 [R1 推翻原论证重写]）**：生成模型画数十上百个数字必然有错标/漏标/糊字〔判断·高置信〕。可靠性分层：

1. **配对机制先于编号机制**：`/images/edits` 以效果图为输入，排布保持是编辑任务的约束而非重采样运气〔判断·中高置信：edits 对空间结构的保持显著强于独立生成，**但仍非逐钻可验证副本**——见第 4 条〕；
2. **编号是种类号不是实例号**（§A.1.4）：默认 ≤8 的图例式编号（可超，见 §C.2 警告语义），错误代价 = 相邻种类混淆（可被人眼比对图例发现），不是数百唯一序号的不可核对状态；
3. **蓝图的第一信息通道是「形状轮廓 + 平涂色 + 物理比例」**——这三者正是排钻要消费的；数字是第二通道（人核对用）；
4. **机器级同排布显式超出本 change**：本方案不承诺蓝图与效果图逐钻一致/可机读——若 Owner 验收标准要求机器级同排布，须**另立「结构化布局输出 + 本地 renderer」独立 change**（结构化布局数据 → 本地确定性渲染），不接受 prompt-only 证据（§I.5-1 待 Owner 拍板）；
5. Owner 原话「上面有钻的编号数字」**忠实兑现** = 逐钻标号保留在方案内；W3 Owner 试产 3-5 批实证错误率回填本节（若实证不可接受，降级备选 =「图例必须 + 逐钻标号仅要求 element 级大钻位」——幅度调整不动摇方向）。

### C.4 归档影响

- `.gemgen` v2（A.2 表）：`image`（效果图）不动 + `blueprint?`（可选键，含 effectRequestId/blueprintRequestId 溯源与人审参照 typed 标记，§C.3）；provenance + workflowMode/requestMode、gemSpecs（GemSpecSnapshot[] + ordinal→specKey 映射）、physicalCanvas。不可变性不破（生成即定稿，双图一并定稿；重试产新档）。
- 任务模型 [R1 收紧·议题 8/P0-3]：LabTask 拆 **effect / blueprint 两个子任务状态**，各自 `requestId / status / assetId / error / retryCount`（blueprint 子任务含图片上传与独立失败态）；**父任务状态 = 派生汇总**（不落独立真源）：effect 成功 + blueprint 成功 → success；effect 成功 + blueprint 失败 → 任务可归档、带「蓝图失败」徽标（blueprint 子任务可单独重试，计数入 retryCount）；effect 失败 → failed（blueprint 不发起）。gemgen v2 键序冻结 effect 在前、blueprint 在后；部分失败语义 = 蓝图缺席或带失败标记。画廊/导入测试显式覆盖四态：蓝图失败 / 重试中 / 旧档无 blueprint / missing custom asset。
- 画廊两态卡：展开位 = 效果图横幅 + 蓝图缩略（并排/切换 tab，蓝图侧带「人审参照」角标）；收起卡不动（缩略仍取效果图 thumb）；预览 Dialog 对比器扩为「效果 vs 蓝图」叠加〔源码〕对比器职责自然延伸。

---

## §D 排钻设计页影响

〔源码〕现状 `physics{ss, gapMm}` 是 grid 级单一规格（studio store `ss = $state('SS10')` + `gapMm`）——所有钻同径同形。

**P0 最小面**（裁决：P0 = 数据贯通 + 校验/导出升级，布局算法不动）：

1. 检查器 physics 区：`SS 下拉` → `基础规格`（形+尺寸；圆钻档位仍 SS 制）——**整图 base spec**，五策略按 base spec 排布（现行为，只是 spec 可不再是圆 SS 档）；
2. 间距/冲突判据升级 [R1 收紧·P0-2]：validate/validateEditable/resolveConflicts/enforceMinDistance 四处从单一 pitch → **逐对圆包络**，全部走**唯一 helper `requiredCenterDistancePx(a, b, grid)`（单位恒 px**——mm→px 换算只在 helper 内发生，禁止 mm 裸传 SpatialIndex）；spatial hash cell = **`maxCellPx`** =（max diameterMm + gapMm）× pixelsPerMm（px 单位）。**边界与状态语义冻结**：布局五策略/relax 的输入只接受**单 spec**（base spec）；其产物进入文档时**强制跑 pairwise gate**，违规不得自动宣称合规；**保存允许 warning（文档可存），导出必须阻断**（export 前置 pairwise gate）；load 后与改径/改形后**立即重算 warning**。测试面：大钻/小钻混合、恰跨 cell 边界、边界 gap、旋转异形（圆包络不变性）、20k 钻——专家工作台改径后的混合径文档在此被正确校验；
3. BOM 导出：聚合键 `colorId` → **canonical GemSpecSnapshot 键（specKey，至少含 assetId）× colorId**（[R1 收紧·议题 2] 不由显示码反推，同 A.2 清单 3），表头 `规格,形状,尺寸,色名,hex,数量`（v1 圆钻迁移后自然落 R10 行）；
4. SVG 导出：异形 path / 自定义 image（A.2 清单 3）；
5. physicalCanvas 感知（[R1·P0-4] 原 declaredPhysical 表述升级）：gemgen（成品模式）送排钻时，重放 `pixelsPerMm = 实际交接 canvas 宽px / widthMm`（anchorSource 区分 declared/default）替代 2.5 常量；检查器展示画幅物理尺寸（只读）。

**P1 全量面**：块级 spec 覆写（overrides.spec——「背景 SS16 圆、主体轮廓 MQ08 马眼」的参数化表达）；布局算法感知混合径（六方网格多径嵌套是研究级课题，明确不进 P0）。〔判断·高置信〕P0 圆包络近似保守安全（永不重叠、略留缝），足以支撑专家工作台的混合径工作流闭环。

> **备注（2026-09-19 · 并行重构声明）**：排钻设计的**图层化重构**设计正在并行推进（Owner 新指令：图层模型 / 每层配置 / 策略归层 / 历史面板 / GPU 渲染调研）。本节 §D 将被图层模型进一步修订——「整图单一 base spec」的 P0 表述在图层稿裁决后可能升级为「每层 base spec」，P1 的 `overrides.spec` 块级覆写方向也可能被「策略归层/每层配置」吸收或重定义。**两稿合流点 = 「每层 base spec × 本稿 GemSpec/GemSpecSnapshot」**：图层稿负责层的结构与配置归属，本稿负责层内钻规格数据模型；合流细节**待图层稿裁决后回填**（§I.5-3）。

---

## §E 分解与切片

### E.1 openspec change 划分（裁决 + 依赖序）

| change | 范围 | 依赖 |
|---|---|---|
| **add-gem-catalog-and-sizes**（基础层） | engine/shapes.ts + Gem/EditGem 字段 + BaseSpec/GemSpecSnapshot/GridSpec 派生契约（P0-1）+ engine 校验/导出升级（requiredCenterDistancePx/maxCellPx，P0-2）+ PhysicalCanvas 贯穿（P0-4）+ 四格式 v2 迁移 + .gemshape 新格式（[R1·议题 10] 八面 vertical slice：projectTypes/MIME/AssetNode/导入路由/素材库 seed/RightSheet/parser+迁移/引用 pin-GC 矩阵，含 P0-6 schema gate）+ BOM 新表 | 无（可立即启动；**并承接 P0-5 的 v2 contract gate 前置交付**） |
| **rename-and-expert-workbench** | 改名联动（TERMS v2/PRODUCT_MODEL v4）+ 属性面板/nudge/对齐分布/删除 + 笔刷 spec 化 + 钻形库 UI（上传/校准/管理）+ 画幅物理读数 | 依赖基础层字段 |
| **lab-dual-mode-and-blueprint** | 双模式开关（workflowMode/requestMode 分离）+ 钻清单面板（默认 8 + 可读性警告）+ composeDrillPrompt gemContext + 双阶段任务模型（generate → 携带效果图的 /images/edits，effect/blueprint 子任务状态）+ gemgen v2 双图归档 + 画廊两态卡/对比器 | 依赖基础层目录（2 与 3 可并行） |

**与未归档 add-project-files 的关系（v1.1 [R1 推翻原时序·P0-5]）**：原案「等 add-project-files 归档后紧随启动」**被 R1 推翻**——当前四类 parser/serializer 均固定 v1 且迁移表为空，add-project-files 2.x（studio 保存生命周期）尚未落地；若等归档，2.x 会先按 v1 写入，随后被迫改保存 API/类型/测试 = 确定性返工。**新裁决（时序反转）**：**2.x 开工前先落「v2 contract gate」**——小范围前置契约切片，冻结四格式 v2 类型、迁移入口、BaseSpec/物理锚字段与测试夹具（零业务实现）；**2.x serializer 直接消费 v2 类型，v1 不成为新的写入真源**；完整迁移实现（migration map 填充、round-trip 全量）仍归 add-gem-catalog-and-sizes。v2 bump 仍**不并入** add-project-files（不重开其已裁议题），但契约先行同步（gate 宿主与跨 change 排期待 Owner 拍板，§I.5-2）。PRODUCT_MODEL v4 / TERMS v2 随 rename change 落盘。

### E.2 每 change 任务波次草案（沿用「契约冻结→双代理→增量测试→Codex 评审」流水线）

```
add-gem-catalog-and-sizes:
  W0 契约 gate（放行条件 = §I.3-1，R1 原文）: shapes.ts 常量表 / Gem schema /
     BaseSpec+GemSpecSnapshot+GridSpec 派生关系（P0-1）/ 四格式 v2 schema + .gemshape schema
     含 P0-6 gate（解码校验/上限/alpha bounds/fit/校准悬空/missing typed）/ pairwise 唯一 helper
     （requiredCenterDistancePx + maxCellPx，px 单位，P0-2）/ PhysicalCanvas 贯穿契约（P0-4）/
     BOM canonical 键 —— 全部类型+typed error 冻结，零实现；并交付 P0-5 v2 contract gate
     （四格式 v2 类型/迁移入口/测试夹具，2.x serializer 直接消费，v1 不成写入真源）
  W1 engine 实现（shapes/validate/conflict/export + helper 落地）+ 单测
     （不变量 + round-trip + 迁移链 + mixed-size/恰跨 cell/边界 gap/旋转异形/20k）
  W2 格式层（labFile/projectFile v2 迁移 + gemshape 序列化与 schema gate）+ assetStore sys-shapes
  W3 Codex 评审 → 修订 → 归档候选

rename-and-expert-workbench:
  W0 契约 gate（放行条件 = §I.3-2）: EditGemFields 扩展（含 rotationDeg 数值/步进编辑，P0）/
     属性面板-nudge-对齐分布交互契约 / 保存-导出 pairwise warning 消费契约（保存 warning、导出阻断）/
     钻形库三步向导契约
  W1 改名联动（TERMS/PRODUCT_MODEL/导航/测试断言 grep 收尾）
  W2 编辑器工具集实现（双代理：工具栏+属性面板 ∥ nudge/对齐分布算法）
  W3 钻形库 UI + 20k 异形渲染基准
  W4 Codex 评审

lab-dual-mode-and-blueprint:
  W0 契约 gate（放行条件 = §I.3-3）: workflowMode/requestMode 字段分离 + size {widthPx,heightPx}
     结构化（P0-7）/ GemSpecSnapshot + ordinal→specKey 持久化映射 / gemContext 组装契约 /
     effect-blueprint 双阶段子任务状态机（各自 requestId/status/assetId/error/retryCount，P0-3）/
     gemgen v2 键序 + 部分失败语义
  W1 模式开关 + 钻清单面板（默认 8 + 可读性警告）+ prompt 注入（含 composedPrompt 快照链路）
  W2 双阶段请求（generate → 携带效果图的 /images/edits）+ gemgen v2 归档 + 画廊两态卡
  W3 蓝图 prompt 实证迭代（Owner 试产 3-5 批，错误率回填 §C.3 论证）
  W4 Codex 评审
```

---

## §F 记分卡（本设计稿自评）

```
Product coherence:   9/10  钻规格/GemSpec 进入对象树（目录双真源分层+真源表新增行），四格式/PRODUCT_MODEL/TERMS 联动齐
Journey continuity:  8/10  成品模式全链（面板→prompt→双图→归档→画廊→送排钻物理锚）闭环；蓝图错误率实证留 W3 才闭合
IA integrity:        9/10  钻形库单一真源（素材库）+ 双 canonical handler；编号=规格码避免第三套 ID 体系
Interaction clarity: 8/10  属性面板/nudge/对齐分布语义确定；笔刷 snap 开关的双态需走查验证
State visibility:    8/10  画幅物理读数/尺寸角标/蓝图失败徽标；自定义形 missing 四态复用
Visual quality:      —     本文不评（无视觉产出，P0 原则：异形渲染与现有圆钻视觉纪律一致）
VERDICT: SHIP（作为 PM 立场稿；§G 议表 Codex 裁决前对应切片不实现）
发布会截图测试: 能——「专家工作台：选中一颗水滴钻，属性面板显示 DP06/6mm/朝向 32°，画幅 210×148mm」
              一图同时讲清微调编排+尺寸体系两大新能力。
```

> v1.1 注：上表为 v1 自评存档。Codex R1 复核 5.6/10 NEEDS-WORK（§I）——放行以 §I.3 三 change W0 gate 为准，自评不作为实现基线凭据。

---

## §G 给 Codex 的议题清单（附 PM 立场；v1 存档 + [R1] 裁决标注）

> v1.1 注：R1 已裁决（§I.1）。本表 PM 立场为 v1 存档，被推翻/收紧处以 [R1] 标注并给出 v1.1 立场；终局以 §I 为准。

| # | 议题 | PM 立场 | 备选/反对案 |
|---|---|---|---|
| 1 | 蓝图编号与配对可靠性 | [R1 推翻原立场·v1.1] 效果图 generate → **携带效果图的 `/images/edits`**（蓝图 prompt = 转换任务）；「形状轮廓+平涂色+比例」为主通道、图例编号必须、逐钻标号尽力（字号≥钻径）；蓝图 = **人审参照、非 BOM 数据源**（UI/档案双标记）；W3 Owner 试产实证回填 | 机器级同排布 = 另立「结构化布局输出 + 本地 renderer」change（待 Owner 拍板，§I.5-1）；否决 (b) 单请求 n:2（候选对语义）与 (c) 后处理渲染（坐标不可得）；**[R1 已推翻] v1 立场「两次独立 generate」**——无共享 latent/坐标，语义配对不可证 |
| 2 | 编号体系 | 规格码（形×尺寸短码 R10/SQ35/DP06）+ 色沿用色板；BOM 键 = spec×color。[R1 收紧] 身份 = GemSpecSnapshot（specKey/ordinal/assetId…），ordinal→specKey 持久化映射；BOM 键用 canonical snapshot 不由显示码反推（§A.1.3） | 反对形×尺寸×色组合码（色不稳定、码长）与自增码（跨项目不稳、平行 ID 体系） |
| 3 | 自定义钻形渲染 | 贴图内嵌 dataUrl + 圆包络间距近似；内置形矢量 path（SVG/Canvas 同源）。[R1 收紧·P0-6] .gemshape 先落 schema gate（解码校验/上限/alpha bounds/fit 语义/校准悬空/missing typed），再做 renderer（§A.1.2） | 矢量化转换（超 P0）；精确形状间距（P1+ 研究级） |
| 4 | engine 多形间距 P0 范围 | pairwise 圆包络（保守安全）+ layout 五策略不动（base spec 单一 pitch）；混合径布局 P1+。[R1 收紧·P0-2] 唯一 px helper requiredCenterDistancePx + maxCellPx；布局输入只收单 spec，产物入文档强制 pairwise gate；保存 warning/导出阻断/load+改径重算（§D-2） | 全量（多径六方嵌套进 P0——反对：阻塞地基交付） |
| 5 | formatVersion 2 时机 | [R1 推翻原时序·v1.1] **2.x 开工前先落 v2 contract gate**（四格式 v2 类型/迁移入口/BaseSpec/物理锚冻结）；2.x serializer 直接消费 v2 类型，v1 不成写入真源；完整迁移实现仍归 add-gem-catalog（§E.1） | 并入 add-project-files（反对：重开已裁议题）；**[R1 已推翻] v1 立场「归档后紧随」**——2.x 将先写 v1 再返工 |
| 6 | 专家工作台 P0 工具集边界 | [R1 推翻·v1.1] 属性面板（**含旋转数值/步进编辑，升 P0**）/nudge/对齐分布/删除/笔刷 spec 化 P0；旋转手柄/切向对齐/阵列 P1（§B.2） | 旋转进 P0（v1 反对案）——**[R1 采纳此备选]**：异形钻可选到却无 P0 修正入口 =「选择形状」能力不完整 |
| 7 | 尺寸物理锚 | PhysicalCanvas（widthMm/heightMm/anchorSource）+ pixelsPerMm = **实际交接 canvas 宽px** ÷ widthMm + prompt 比例锚；缺省 2.5 显式 default 兼容现状。[R1 收紧·P0-4] 全链贯穿 gemgen→handoff→EditDocument/gemdoc，锚定实际降采样 canvas 宽 + dimsMismatch 校验（§A.3） | 全局改标定（反对：破坏重放确定性） |
| 8 | 蓝图子请求的任务状态 | 双子请求独立落状态（blueprint 失败不拖死 effect 成功；可单独重试蓝图）。[R1 收紧·议题 8] 拆 effect/blueprint 子任务 schema（各自 requestId/status/assetId/error/retryCount），父任务 = 派生汇总（§C.4） | 原子双成功才 success（反对：一张糊图重跑两张配额） |
| 9 | 实验室模式层级 | run 级开关 P0 + gemtpl v2 字段（workflowMode/gemSpecIds）P1 落 UI。[R1 收紧·议题 9/P0-7] requestMode 与 workflowMode 字段分离；size 结构化 {widthPx,heightPx}（§C.1） | 模板级先行（反对：TemplateEditor 双宿主联动过早扩面）；字段复用 endpoint mode（**[R1 已推翻]**：破坏重试/归档/旧档解析） |
| 10 | .gemshape 新格式 vs 挪用 gemtpl | 新格式（第五成员）+ sys-shapes 目录 + RightSheet 管理。[R1 收紧] 不以草案直接切片——八面（projectTypes/MIME/AssetNode/导入路由/seed/RightSheet/parser+迁移/引用 pin-GC 矩阵）一次性冻结（§E.1/E.2） | 挪用 gemtpl（反对：概念混入） |
| 11 | 「送精修」措辞是否随改名 | 不改（动作语义未变；「精修项目/.gemdoc」文件名亦不动）——[R1 支持，维持] rename change 内以 grep + UI 断言确认「专家工作台」与「送精修」组合不歧义 | 随改「送专家工作台」（冗长；且 gemdoc 改名 = 格式层无谓 churn） |
| 12 | 钻清单勾选上限 | [R1 推翻硬上限·v1.1] **默认 8 + 可读性警告**（不阻断）；图例分页/分组；模型侧硬限制由模型能力配置表达（§C.2） | 不设限（反对：编号可辨性坍塌）；**[R1 已推翻] v1 立场「硬上限 8」**——会拒绝真实项目的多规格 BOM |

---

## §H 摩擦反馈（一手文件/源码的不清晰与不适配处）

1. **PIXELS_PER_MM=2.5 三处重复定义**（studio.svelte.ts:56 / edit/gemprojReplay.ts:41 / edit/quickLayout.ts:65）——物理锚改造（physicalCanvas 感知）若不先收归单源（建议入 engine，与 GridSpec 同居），第四处复制正在路上。已在 §D 影响面 5 隐含，建议基础层 change 的 W0 显式列「常量收编」任务。[R1 非阻塞建议同向；已并入 §A.3 PhysicalCanvas 契约——quickLayout 显式 default=2.5]
2. **SS_KEYS 缺 SS24**（SS22→SS26 跳档；行业标准序列含 SS24≈5.3mm〔行业·中置信〕）——不阻塞本轮（自定义 mm 尺寸可表达任意径），但目录化时建议补齐并 bump ENGINE_VERSION 说明。
3. **add-manual-edit-mode 未归档即被覆盖**：其 design.md §3 笔刷行（snap 六方格位）本轮覆盖，但该 change 尚未归档——openspec specs 尚未同步。处理：本文 §B.4 覆盖声明为凭，归档时由 spec 同步步骤登记（add-project-files 的「修文对齐」先例可行）。
4. **LabSettings/form.size 是自由字符串**（'1024x1024'，正则兜底散在 sizeFallbackOf）——双模式加物理尺寸时应一并结构化（{w,h} + 物理声明），否则字符串解析将继续增殖。基础层 change 的 gemContext 契约里一并冻结。[R1·议题 9/P0-7 已吸收：size → {widthPx,heightPx}，物理走 PhysicalCanvas，旧字符串只读迁移兼容，§C.1]
5. **TERMS「工作台」禁用词与新模块名正面冲突**（排钻设计禁用词含「工作台」）——Terms v1 建表时未预见复用；§B.1 给出消解方案（禁用词表按「独立使用」限定），提示词条注册表的禁用词语义需要更精细的注记规范。

---

## §I Codex R1 落档（v1.1 处置记录）

> 评审输入：同目录 `codex-review-r1.md`（2026-09-19）。评分 **5.6/10 NEEDS-WORK**——「暂不能作为三个 change 的规范性基础直接进入实现切片」。本节为逐条处置落档；处置状态如实标注（已改写 / 修复中 / 待回填），不以自评替代验证。

### I.1 12 议题裁决 → 落档位置

| # | 裁决（一句话） | 落档位置 |
|---|---|---|
| 1 | 推翻「两次独立 generate」：第二请求改携带效果图的 `/images/edits`；蓝图 = 人审参照非 BOM 数据源；图例必须保留；机器级同排布超出本 change | §C.3（核心改写）、§0.3-7、§G-1 |
| 2 | 支持规格码，需补稳定身份契约：GemSpecSnapshot（specKey/ordinal/assetId…）冻结，ordinal→specKey 持久化映射，BOM 键用 canonical snapshot 不由显示码反推 | §A.1.3、§A.2（BaseSpec 块 + engine 清单 3）、§A.1.4 |
| 3 | 支持贴图 + 圆包络，但 .gemshape 必须先补 schema gate（解码校验/上限/alpha bounds/fit 语义/校准悬空/missing typed），再做 renderer | §A.1.2（gate 六条） |
| 4 | 推翻「pairwise + layout 不动即可闭环」表述：唯一 px 单位 helper + maxCellPx；布局输入只收单 spec；布局/relax 产物入文档强制 pairwise gate | §D-2 |
| 5 | 推翻「归档后紧随」时序：2.x 开工前先落 v2 contract gate；2.x serializer 直接消费 v2 类型，v1 不成写入真源 | §E.1（关系段）、§E.2（W0）、§0.3-8 |
| 6 | 推翻旋转 P1 降级：属性面板数值/步进编辑升 P0；手柄/切向对齐仍 P1 | §B.2（表 + ASCII）、§0.3-5、§G-6 |
| 7 | 推翻「三件套已贯通」结论：PhysicalCanvas 贯穿 gemgen→handoff→EditDocument/gemdoc；锚定实际降采样 canvas 宽；dimsMismatch 校验；quickLayout 显式 default=2.5 | §A.3、§D-5、§B.4、§G-7 |
| 8 | 支持独立状态，需拆子任务 schema：effect/blueprint 各自 requestId/status/assetId/error/retryCount，父任务派生汇总 | §C.4、§G-8 |
| 9 | 支持 run 级，推翻字段复用：requestMode 与 workflowMode 两字段分离；size 结构化 {widthPx,heightPx}，物理声明独立 | §C.1（字段分离表）、§C.2、§A.2（gemtpl/gemgen 行）、§G-9 |
| 10 | 支持新格式，不能以草案直接切片：八面（projectTypes/MIME/AssetNode/导入路由/seed/RightSheet/parser+迁移/引用 pin-GC 矩阵）一次性冻结 | §E.1（change 1 范围）、§E.2（W0）、§G-10 |
| 11 | 支持不改「送精修」：改用户可见模块名/TERMS/文案一致性，不动动作动词与文件格式名 | §B.1（维持）、§G-11 |
| 12 | 推翻硬上限 8：默认值 8 + 可读性警告；图例分页/分组 | §C.2、§G-12 |

### I.2 P0 阻塞 → 处置对照

| P0 | 处置要点 | 修订位置 | 状态 |
|---|---|---|---|
| P0-1 BaseSpec/GemSpecSnapshot/GridSpec 无统一可实现契约 | 冻结 BaseSpec、GemSpecSnapshot{specKey,ordinal,shapeId,sizeLabel,diameterMm,widthMm?,heightMm?,assetId?}；GridSpec = 派生几何上下文（gridFromSs 降位圆钻特例）；ordinal→specKey 持久化映射；BOM 键 canonical 不由显示码反推 | §A.1.3、§A.2、§A.1.4 | 契约已落稿；类型 + round-trip/identity 测试冻结归 add-gem-catalog W0（**待实现**） |
| P0-2 pairwise 单位/覆盖面/保存后状态未定义 | 唯一 helper requiredCenterDistancePx(a,b,grid)（单位 px）+ maxCellPx；布局只收单 spec、产物入文档强制 pairwise gate；保存 warning、**导出阻断**；load/改径后重算 warning | §D-2、§A.2（engine 清单 2） | 契约已落稿（**待实现**） |
| P0-3 蓝图非同一设计的可验证副本 | 默认第二请求携带效果图走 `/images/edits`；档案记 effectRequestId/blueprintRequestId 与失败原因；送排钻人工确认；禁蓝图作 BOM 数据源 | §C.3（(a) 案 + 标记语义 + 论证 4）、§C.4 | 已改写；W3 Owner 试产实证回填（**待回填**） |
| P0-4 物理锚未贯穿重放链 | PhysicalCanvas{widthMm,heightMm,anchorSource} 全链承载（gemgen→handoff→EditDocument/gemdoc）；锚定实际降采样 image.width；dimsMismatch 校验；quickLayout 显式 default=2.5；常量收编 engine 单一出口 | §A.3、§D-5、§B.4、§A.3 三页表 | 契约已落稿；px/mm 不变量测试归 W0/W1（**待实现**） |
| P0-5 v2 时序致 add-project-files 2.x 返工 | 时序反转：2.x 开工前先落 v2 contract gate（四格式 v2 类型/迁移入口/BaseSpec/物理锚/测试夹具）；2.x serializer 直接消费 v2 类型，v1 不成写入真源；完整迁移实现仍归 add-gem-catalog | §E.1（关系段）、§E.2（W0 gate 末行）、§0.3-8 | 已改写；gate 宿主与跨 change 排期待 Owner 拍板（§I.5-2） |
| P0-6 .gemshape 不能防坏图/比例漂移/悬空校准 | 解码后实际宽高校验、MIME/字节/像素上限、alpha bounds 非空（主径定义冻结）、fit 语义冻结（超容差拒绝）、reference 需可解析 refSpecId 或内嵌 refSpecSnapshot、missing = visible/typed 禁静默降级导出 | §A.1.2（schema 注记 + gate 六条）、§A.1.3（missing 态） | 契约已落稿（**待实现**） |
| P0-7 实验室新 mode 与既有 LabTask.mode 冲突 | requestMode('generate'|'edit') 与 workflowMode('structured'|'product') 字段分离；size → {widthPx,heightPx} 结构化、物理独立；旧档字符串/旧 mode 迁移只读兼容 | §C.1（字段分离表）、§C.2、§A.2（gemtpl/gemgen 行） | 契约已落稿（**待实现**） |
| P0-8 基线未绿 + 新契约无测试落点 | 见 I.4 基线复跑处置；typed contract tests 落点并入各 change W0 gate（§E.2） | §E.2（三个 W0） | **修复中**（openIntentFlow 3 例）/ 负载抖动定性（undo 1 例）；测试落点**待实现** |

### I.3 三个 change 的放行条件（R1 原文逐条，已并入 §E.2 各 W0 gate）

1. **add-gem-catalog-and-sizes**：先完成 P0-1、P0-2、P0-4、P0-6 的 contract gate，再实现 engine 与四格式迁移；不接受只扩字段、不扩 `GridSpec`/handoff 的切片。
2. **rename-and-expert-workbench**：依赖基础层稳定后实现；旋转属性提升 P0，编辑器保存/导出必须消费 pairwise warning。
3. **lab-dual-mode-and-blueprint**：依赖 P0-3、P0-7 和双阶段任务 schema；双图只能作为人审参照，直到有结构化布局证据。

在这些条件完成前，本稿只作契约修订与交互原型基线，不作为三个 change 的规范性实现基线。

### I.4 Codex 独立基线复跑（P0-8 事实基线，如实存档）

- 结果：`pnpm test`，66 个测试文件 64 个通过，**860/864** 用例通过，4 失败；大量 jsdom canvas 警告**不构成**失败原因。
- 处置（如实标注，不以复述代替修复）：
  - `lab/openIntentFlow.test.ts` **3 例断言失败**——定性：跨切片语义迁移所致，**修复中**（归属相关切片修复，非本稿新契约引入）；
  - `edit/undo.test.ts` **1 例超时**——定性：负载抖动（**定性存档，复跑监控**；再现则升级排查，先排除孤儿进程/负载因素再归因代码）。
- 该基线**不作为**三 change 新契约已闭合的证据；新契约验收以各 W0 typed contract tests 为准（**待回填**）。

### I.5 未决项（Owner 拍板 ×2 + 图层稿合流 ×1）

1. **[Owner 拍板] 蓝图机器级同排布是否立项**：本稿立场 = 蓝图是人审参照、非 BOM 数据源（§C.3）；若 Owner 验收标准要求蓝图与效果图逐钻一致/可机读，须另立「结构化布局输出 + 本地 renderer」独立 change（高成本），不接受 prompt-only 证据。
2. **[Owner 拍板] v2 contract gate 宿主与跨 change 排期**：机制已定（gate 先行、2.x serializer 直接消费 v2 类型、v1 不成写入真源，§E.1），但 gate 落在 add-gem-catalog W0 提前启动还是独立前置 micro-change、add-project-files 2.x 如何插队，涉及其 change 冻结任务的范围调整，跨 change 排期裁决权在 Owner。
3. **[图层稿合流] §D 排钻影响将被图层化重构稿修订**：Owner 已另行发起排钻设计图层化重构（图层/每层配置/策略归层/历史面板/GPU 调研）；两稿合流点 = 「每层 base spec × 本稿 GemSpec/GemSpecSnapshot」，**待图层稿裁决后回填**（见 §D 末备注）。

---

## 来源（行业检索，中置信）

- [Crystal Ninja — Rhinestone Size Guide SS3–SS50](https://www.crystalninja.com)
- [Rhinestone Guy — What Rhinestone Size Should You Use? SS, PP & MM Guide](https://shop.rhinestoneguy.com)
- [Fire Mountain Gems — Rhinestone Conversion Chart](https://www.firemountaingems.com)
- [Rhinestone HQ — Size Chart](https://rhinestonehq.com)
- [RG Pros — Swarovski Flat Back Rhinestone Color Chart（Preciosa 交叉色号）](https://www.rgpros.com)
- [Bluestreak Crystals — Hotfix vs Non-Hotfix Preciosa Flatback Crystals](https://www.bluestreakcrystals.com)

要点：SS 制（SS3–SS50）主要描述圆钻，SS6≈2.0/SS10≈2.8/SS20≈4.6–4.8mm；异形按 mm/PP 售卖；色号体系 Preciosa 数字色号与 DMC 式交叉表并存。与 engine SS_TABLE（SS6=2.0…SS34=7.1）一致，佐证现表可信。
