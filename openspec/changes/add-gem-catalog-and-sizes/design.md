# Design: 尺寸与钻形目录 + v2 契约

> 规范性来源（冲突时以 R2 终审裁决为准）：
> - `.agents/documents/2026-09-19-expert-workbench-and-sizes/expert-workbench-and-sizes.md`（v1.1，下称「专家稿」）
> - `.agents/documents/2026-09-19-studio-layers/studio-layers.md`（v1.1，下称「图层稿」）
> - 两轮评审：专家稿 `codex-review-r1.md`（gemspec R1，P0-1~8）；图层稿 `codex-review-r1.md` + `codex-review-r2.md`（R2 终审 `CONDITIONAL GO / W0-GATE-ONLY`）
> - `gpu-research.md`（GPU 定案：CPU 确定性 oracle，GPU 仅预览加速器）
> 所有「现状」断言带 `源码文件:行号`（2026-09-19 源码树实测）。本 change 不宣称任何未实现内容为已完成。

## 0. 定位与门序

### 0.1 五段合流门序中的位置

R2 确立的五段门序（图层稿 §E.7，两稿进入实现切片的唯一顺序）：

```
1. v2 contract gate → 2. engine gate → 3. replay/handoff gate → 4. studio gate → 5. add-project-files 归档同步
```

本 change 承担**段 1 + 段 2 + 目录/资产化/迁移实现**：

- **W0 v2 contract gate**（本 change 第一实现单元，R2 授权的唯一先行范围）；
- **engine gate**（第二实现单元）；
- 内置规格 seed 目录资产（sys-shapes `.gemshape`，Owner 2026-09-20 裁决一）、`.gemshape` 第五格式资产化、四格式迁移完整实现、常量收编与 SS24 补档。

### 0.2 显式不做（其他 change 所有）

| 不做项 | 归属 |
|---|---|
| 图层化（LayerRecord reducer / rest 哨兵 / computeLayer / 历史 fold / PreviewRenderInput） | studio-layers（段 3/4） |
| 专家工作台 UI（改名联动 / 属性面板 / nudge / 对齐分布 / 钻形库上传向导 UI） | rename-and-expert-workbench |
| 实验室高级选项与蓝图效果（drillParams/blueprint 正交选项的 UI 与拼接策略 / 生图 stage 生命周期 / effect-blueprint 子任务 / 任务卡蓝图子态；「双模式/workflowMode」框架已被 Owner 2026-09-20 裁决二退役） | add-lab-drill-params-and-blueprint |
| replay/handoff/export 层化消费（gemprojReplay layers[] 六步链 / buildManualEditHandoff 层模型改写 / studio 导出接线） | studio-layers（段 3） |

本 change 交付 engine 层 `exportGate` 纯函数与 v2 schema 承载位；上述消费面的运行时接线不在本 change。

### 0.3 跨 change 依赖规则（硬前置，写死在 DAG）

1. **任何 add-project-files 2.x serializer 开工前必须先过本 change 的 W0**（R2 §四 P0-4 门序；2.x serializer 直接消费 v2 类型，v1 不成为新的写入真源）。R2 P0-4 同时要求在 2.x 开工前实际修改 `openspec/changes/add-project-files/design.md`、`specs/project-files/spec.md`、`tasks.md`（删旧 v1 2.1–2.5、登记移交与 2.6/2.7 依赖）——**[2026-09-19 已执行：主会话提交 7e56ff2，openspec validate --strict 通过]**。
2. **`.gemshape` 资产化切片（2.2）依赖 AssetProject 实现**（add-project-files 切片 1.1）已落地：`ProjectKind`/`PROJECT_MIME` 契约层已存在（`persistence/projectTypes.ts:17,20-25`），但 AssetNode 接线与 sys 目录 seed 机制属 add-project-files 1.1/4.2 实现面（其 tasks.md 未勾选）。若彼时未落地，2.2 顺延——不阻塞 W0 与 engine gate。
3. **studio-layers 的 engine 消费面（跨层联合 pairwise/exportGate）以本 change engine gate 为硬前置**（图层稿 §E.2 切片依赖序原文）。

### 0.4 四项工作默认（Owner 未正式拍板，待 Owner 批准可推翻；仅列与本 change 相关两项）

1. **蓝图机器级同排布 = 另立独立 change，不进本 change**：`.gemgen` v2 冻结的 `blueprint?` 字段携带「人审参照、非 BOM 数据源」typed 标记；蓝图与效果图逐钻一致/可机读不在本 change 承诺内（专家稿 §C.3 论证 4 / §I.5-1）。推翻后果：结构化布局输出 + 本地 renderer 需另立高成本 change，且 `.gemgen` v2 schema 需评估是否追加结构化布局键。
2. **「送精修」措辞不改**：本 change 的 exportGate 将「送精修」列共同前置，动作名与文件格式名（.gemdoc/精修项目）不动（专家稿 §B.1 / gemspec R1 议题 11 裁决）。推翻后果：归 rename change 联动，不影响本 change 契约。

（另两项工作默认——观察态纯会话态、混合配置滞空预填——属 studio-layers change，不写入本 change。）

### 0.5 Owner 2026-09-20 裁决登记

1. **裁决一（尺寸体系入库）**：「尺寸体系 也要是一种文件格式存储在素材库中（包含 钻石素材图和结构化信息），方便维护」——规格目录真源从 engine 常量表改为素材库 `.gemshape` 资产（含钻石素材图与结构化信息）。
2. **裁决二（双模式退役）**：实验室「双模式/workflowMode」框架被推翻，改为正交高级选项（水钻参数配置 `drillParams` / 蓝图 `blueprint` beta）——`.gemtpl`/`.gemgen` v2 的 `workflowMode` 字段退役（消费规范源 = `openspec/changes/add-lab-drill-params-and-blueprint/`，Owner 重定调全文见其 proposal §Why / design §0.1）。

影响落点：裁决一 → §1.4/§1.6/§3.1/§3.2 与 tasks 0.6/2.1/2.2 及 spec「钻规格目录与唯一身份」Requirement；裁决二 → §1.3 与 tasks 0.3。

---

## 1. W0 v2 contract gate（第一实现单元：类型 + typed error + 迁移入口 + fixture，零业务实现）

### 1.1 canonical 类型唯一化（唯一类型模块，单独提交）

冻结以下类型为全库唯一权威定义（落点：`engine/types.ts` v2 区或独立 `engine/spec.ts`——实现切片定，禁止第二定义点）：

```ts
/** 整图/层级基础规格：形 × 尺寸（无身份字段——身份只在 GemSpecSnapshot.specKey） */
interface BaseSpec {
  shapeId: string            // 'round' | 'square' | 'drop' | 'heart' | 'marquise'（P0）| 'custom'
  sizeLabel: string          // 仅显示用（'SS10' / '3.5mm'），不参与身份
  diameterMm: number         // 最大径（圆=直径；方=边长；水滴/心/马眼=长轴）——间距与渲染的唯一物理依据
  widthMm?: number           // 异形/自定义附宽（内置形可由纵横比常量派生）
  heightMm?: number
  assetId?: string           // shapeId='custom' 时的 .gemshape 资产弱引用
}

/** 序列化/归档/BOM 的稳定身份快照（不可变；每次 run/gemgen 持久化） */
interface GemSpecSnapshot {
  specKey: string            // canonical 稳定键，唯一持久身份：
                             //   builtin 确定性（'round-ss10' / 'square-3.5'）；
                             //   custom = 'custom-<gemshapeAssetId>'（canonical 至少含 assetId）
  ordinal: number            // 清单序号 1..n（蓝图编号即此）；ordinal→specKey 映射随 run/gemgen 持久化
  shapeId: string
  sizeLabel: string
  diameterMm: number
  widthMm?: number
  heightMm?: number
  assetId?: string
  rotationDeg?: number       // 逐钻物化时随附；不参与 specKey 身份、不参与 BOM 聚合键
}

/** 物理画幅锚（画幅级，非层级） */
interface PhysicalCanvas {
  widthMm: number
  heightMm: number
  anchorSource: 'declared' | 'default'   // 成品模式声明 | 2.5 缺省（现状兼容，显式标记）
}

/** 内存目录条目（非序列化；目录真源见 §3.1） */
interface GemSpec extends Omit<GemSpecSnapshot, 'ordinal' | 'rotationDeg'> {
  source: 'builtin' | 'custom'
}
```

裁决与禁令：

- **`specKey` 是唯一持久身份**；「specId」一词废除——不得出现在类型、序列化、BOM、`gemContext`、handoff 任何位置（gemspec v1.1 §A.1.3 原用 `GemSpec.specId`，R2 §三-2 定案 grep 清零持久化 `specId`）。**grep 边界（R1 建议 1 收紧）：禁令针对 `specId` 身份字段/持久化别名（exact key）；§1.4 `.gemshape` 校准来源 `refSpecId` 是独立的引用字段——允许且单独定义，不计入禁令命中（R2 §三-6 原文亦要求可解析 `refSpecId/refSpecSnapshot`）。** 现状源码树（`rhinestone-studio/src` 与 serializer/runtime 面）`specId`/`specKey`/`shapeId`/`diameterMm` 零命中（rg 实测；本 change 与上游评审文档本身出现这些词不适用该断言）。
- **身份不由显示码/浮点径反推**：BOM 键、四格式迁移、SVG/BOM 渲染一律消费 canonical `specKey` 快照，不从 `R10`/`SQ35` 显示码或 `diameterMm` 浮点反推（gemspec R1 议题 2 裁决）。
- **`rotationDeg` 归属**：快照内为可选随附字段（非身份）；`Gem`/`EditGem` 逐钻字段同步携带（§2.3）。此为对两稿分歧的收束：专家稿 §A.2 将 rotationDeg 置于 Gem/EditGem，图层稿 §A.7 写「快照 + 逐钻 rotationDeg」——本 gate 冻结两者并存且语义唯一（快照随附 = 物化产物；BOM 聚合键恒 `specKey × colorId`，不受 rotation 影响）。
- **`GridSpec` v2 重定义为「由 BaseSpec 派生的几何上下文」**：`{ pitchMm, gapMm, rowAngleDeg: 0, pixelsPerMm }`——不再携带 `ss` 语义（现状 `GridSpec{ss,pitchMm,rowAngleDeg,pixelsPerMm}`，types.ts:111-119）；新增 `gapMm` 为 pairwise 判据与 `maxCellPx` 的 gap 单一来源（〔判断·高置信〕：备选「helper 第四参」被 R2 §三-1「不能保留别名」精神排除——单一真源纪律取 grid 携带）。构造入口：
  - `gridFromSpec(spec: BaseSpec, gapMm: number, pixelsPerMm: number): GridSpec`（新标准入口）；
  - `gridFromSs` 降位为圆钻特例构造入口（SS_TABLE 查表不变，grid.ts:11-24/36-38）。
  - 旧 `GridSpec.ss` 消费者（`buildBom` 的 `g.ss`，export.ts:93,99,101；`ProjectSummary.ss`，projectTypes.ts:43；`stores/edit.svelte.ts:514` 摘要构造——R1 裁断 4 补登）随 engine gate 迁移至逐钻快照/新表头；旧 v1 fixture 仅在迁移入口读取 `ss`。
- **`toEditGem`/`fromEditGem`、四格式 v2 serializer、BOM、蓝图 ordinal 全部消费 BaseSpec/GemSpecSnapshot**，round-trip/identity 测试随 W0 冻结（gemspec R1 P0-1 放行条件原文：没有该 gate，三个 change 不切 W1）。

### 1.2 唯一几何 helper（签名冻结，二/三参并存禁令）

R2 §三-1 定案签名（消除专家稿三参与图层稿二参的漂移）：

```ts
/** 圆包络判据：两钻所需最小中心距（px）。mm→px 换算只发生在本 helper 内部——单位恒 px。
 *  dist ≥ (a.diameterMm + b.diameterMm)/2 + grid.gapMm）× grid.pixelsPerMm 判合规 */
function requiredCenterDistancePx(a: GemSpecSnapshot, b: GemSpecSnapshot, grid: GridSpec): number

/** spatial hash cell 尺寸（px）：(max(specs.diameterMm) + grid.gapMm) × grid.pixelsPerMm。
 *  cell 取 max 后 3×3 邻域检索不漏（检索不漏 ≠ 分区结果几何合规——后者由 pairwise 判定） */
function maxCellPx(specs: readonly GemSpecSnapshot[], grid: GridSpec): number
```

- 禁止 mm 裸传 `SpatialIndex`（现状 cell=pitch，`engine/ops.ts:199` / `edit/spatialIndex.ts:15-16`——px 坐标系，传 mm 会漏邻居）。
- 全库只此一处定义；`validate`/`validateEditable`/`resolveConflicts`/`exportGate`/布局产物 gate（§2.1）全部消费，不得另立同义函数。

### 1.3 四格式 v2 版本表与迁移入口

现状：`PROJECTFILE_FORMAT_VERSIONS = {gemproj:1, gemdoc:1}`（projectFile.ts:51-56）、`LABFILE_FORMAT_VERSIONS = {gemtpl:1, gemgen:1}`（labFile.ts:37-41），迁移链骨架在而表空（projectFile.ts:113-128 / labFile.ts:106-121）。W0 将四格式版本表 bump 至 2，注册 v1→v2 迁移入口（纯函数），附 fixture 与测试；**完整迁移语义实现归 §4/切片 2.3，W0 交付迁移入口 + fixture 演练**。

| 格式 | v2 变更（W0 冻结 schema） | v1→v2 迁移补默认 |
|---|---|---|
| `.gemproj` | 顶层 `physics{ss,gapMm,globalDensity,relax}`/`activeStrategy` 退役 → `layers: LayerRecord[]`（≥1，恰一层 `blockIds:'rest'`；每层 `physics{specKey,gapMm,density,relax}` + `strategy` + 层内 `overrides`）；顶层新增 `physicalCanvas?: PhysicalCanvas`。**合流裁决（R2 §三-3）：删除单一顶层 baseSpec，规格 per layer 引用 canonical specKey；快照策略定稿（R1 建议 3 收紧）= 层配置只存 `specKey`，输出/编辑钻物化 `GemSpecSnapshot`——不设「内联快照缓存键」等未定义字段（未冻结 schema 的字段一律不进文件；目录解析在内存目录真源完成）** | 单兜底层：`layers=[{id:'L1',name:'图层 1',blockIds:'rest',strategy:old.activeStrategy,physics:{specKey:'round-'+old.ss 小写（SS_TABLE 派生）,gapMm,density:old.globalDensity,relax},overrides:old.overrides}]`；`physicalCanvas` 缺席 = default |
| `.gemdoc` | `gems[]` 每项 + `shapeId`/`diameterMm`/`rotationDeg?`/`assetId?`；+ `physicalCanvas?` | `shapeId='round'` + `diameterMm=SS_TABLE[grid.ss]` + 无旋转 + physicalCanvas 缺席 |
| `.gemtpl` | + `drillParams?: { enabled: boolean; specs: string[]; physical?: PhysicalCanvas }`（水钻参数配置高级选项：正交开关 + 钻清单 specKey 引用 + 可选画幅——Owner 2026-09-20 裁决二，workflowMode 概念退役；键形消费规范源 = add-lab-drill-params-and-blueprint）+ `blueprint?: { enabled: boolean }`（蓝图高级选项开关，beta 标记随消费 change）+ `gemSpecIds?: string[]`（模板绑定钻清单，字段 P0 落、编辑 UI 归 add-lab-drill-params-and-blueprint）；**不承载顶层 `physicalCanvas` 画幅锚（R1 建议 2 定稿：模板与画幅锚无关——生成任务的画幅声明在 .gemgen 档案；`drillParams.physical?` 为高级选项内可选尺寸信息，不属画幅锚）** | 两键缺席 = 两开关关 / 无清单 |
| `.gemgen` | `image` 键不动（消费兼容）；+ `blueprint?: GemgenImage`（含 `effectRequestId`/`blueprintRequestId` 溯源 + 「人审参照、非 BOM 数据源」typed 标记——行为实现归 add-lab-drill-params-and-blueprint，本 change 只冻结 schema 位）；provenance + `requestMode`（endpoint 语义保留）+ `drillParams`/`blueprint` 正交快照（记录当次任务两开关与参数快照；旧 `mode`→`requestMode` 只读映射）；+ `gemSpecs?: GemSpecSnapshot[]`（ordinal→specKey 持久化映射即此数组）；+ `physicalCanvas?` | 缺席 = 无蓝图 / 两开关关（无正交快照）/ 旧 `mode`→`requestMode` 只读映射 / 无清单 |

LayerRecord 的完整 schema（`'rest'` 哨兵不变量、parser 拒绝面）以图层稿 §E.1 为规范性来源，本 gate 冻结其类型定义供 v2 serializer 消费；层模型的 store/reducer/UI 实现归 studio-layers。

### 1.4 `.gemshape` 新格式与 schema gate（六条，先于 renderer）

`.gemshape` = 格式族第五成员：`ProjectKind` 第五值 + `PROJECT_MIME` 第五值 `application/vnd.rhinestone-studio.gemshape+json`（现状四值，projectTypes.ts:17,20-25）。Schema（专家稿 §A.1.2 + Owner 2026-09-20 裁决一增强，W0 冻结）：

```ts
interface GemshapeFile {
  kind: 'gemshape'; formatVersion: 1; appVersion; createdAt; savedAt; name
  texture: { mime: string; dataUrl: string; width: number; height: number }  // 声明值——以解码实测为准
  vectorPath?: string                                                          // 归一化 SVG path 数据（单位框 0..1）——内置形用于清晰矢量导出；与 texture 至少其一必备
  physical: { widthMm: number; heightMm: number }                            // diameterMm 取 max
  specKey?: string                                                             // canonical 身份键——seed 资产必填（如 round-ss10）；自定义资产由 ingest 时以 custom-<assetId> 派生
  calibration: {
    mode: 'direct' | 'reference'
    refSpecId?: string            // mode=reference：以哪个规格为量纲（如 round-ss10）——必须可解析
    refSpecSnapshot?: GemSpecSnapshot  // 内嵌参考规格快照：refSpecId 解析失败时的审计凭据
  }
}
```

**parser schema gate 六条（出处：gemspec R1 P0-6 / 专家稿 v1.1 §A.1.2，逐条冻结）**：

1. **解码后实际宽高校验**：dataUrl 解码得实际 width/height，与声明不符 = typed error 拒收——声明值不是信任源；
2. **输入上限**：MIME 白名单（可解码集）+ 最大字节数 + 最大像素数（防炸弹贴图与性能失控）；
3. **alpha bounds 非空**：全透明（空 bounds）= 拒收；主径/物理换算一律取 **alpha 内容 bounds** 的主径（非整张贴图外框）；
4. **fit 语义冻结**：physical 宽高与贴图（alpha bounds）纵横比不一致 = **拒绝**（超容差 typed error；容差内按贴图实际纵横比校正 physical 并告警）——不做静默裁剪/contain，比例漂移即物理尺寸谎言；
5. **校准悬空防线**：`mode='reference'` 必须满足 `refSpecId` 可解析**或**内嵌 `refSpecSnapshot` 至少其一；参考规格资产被删除后，已入库钻形保持**可审计**（calibration 快照仍在）但**不可重新校准**；
6. **missing custom asset = visible/typed 状态**：文档引用的 `.gemshape` 缺失时走显式 missing 态（占位渲染 + BOM/导出清单标注），**禁止静默降级为圆钻轮廓后照常导出**（导出前置 gate 拦截）。

补充约束（裁决一）：`vectorPath` 与 `texture` 至少其一必备（同时缺席 = typed error 拒收）；两者并存时导出渲染优先 `vectorPath`（清晰矢量优于贴图缩放）。

校准语义：「拿现有的钻去做参考」= 烘焙式校准——贴图 alpha bounds 主径 px ÷ 参考规格 mm → 反推 physical，物化为 `physical`；`calibration` 只记出处，参考钻后续改动不影响已入库钻形（ManualEditHandoff 同 philosophy）。

### 1.5 物理锚契约与常量单源出口

- `pixelsPerMm := 实际交接 canvas 像素宽 ÷ widthMm`——**锚定实际降采样后的 `image.width`**，不用文件记录宽（`gemprojReplay.ts:158` `dimsMismatch` 路径警示文件记录宽 ≠ 实测宽；dimsMismatch 以实测为准并校验/告警）。W0 冻结 engine 纯函数签名：`pixelsPerMmFromCanvas(canvasWidthPx: number, canvas: PhysicalCanvas | undefined): number`（缺失/非法回退 2.5 且 `anchorSource:'default'` 显式）。
- **`PIXELS_PER_MM` 收编**：engine 单一出口常量（与 GridSpec 同域）；现状三处副本（studio.svelte.ts:56 / gemprojReplay.ts:41 / quickLayout.ts:65）在实现波次切换消费（切片 2.4）＋常量单源断言测试。quickLayout 显式 `anchorSource:'default'`。
- 贯穿链（gemgen provenance → handoff → EditDocument/.gemdoc 及 .gemproj `physicalCanvas`）的**schema 承载位**在本 gate 冻结；运行时接线（handoff 构造/edit store/replay 消费）归 replay/handoff gate（studio-layers）与 expert change——本 change 不做。

### 1.6 目录资产 schema 与迁移 bootstrap（Owner 2026-09-20 裁决一）

- **`.gemshape` 是唯一规格目录格式**：内置规格（`round/square/drop/heart/marquise` × 圆形 SS 档 / 异形 mm 档——主尺寸 = 最大径，纵横比常量可派生 widthMm/heightMm；P1 `oval/star` 同格式增 seed 条目）= `sys-shapes` 系统目录下 seed 的 `.gemshape` 资产（贴图或 vectorPath + 物理宽高 + specKey），幂等 create-only——沿 gemtpl seed 先例：节点存在即跳过（含软删态，删除不复活），确定性节点 id `ast-shape-${specKey}`。seed 数据形状（形 id / 短码 / 中文名 / 贴图或 vectorPath / 物理宽高）在 W0 冻结。
- **engine 仅保留迁移 bootstrap**：SS_TABLE 直径查表（v1→v2 纯函数迁移补默认需要——迁移是纯函数，不能读 IDB 素材库）+ specKey 生成规则常量（`round-ss10` / `square-3.5`）。bootstrap 表不是目录真源。
- **身份纪律（specKey 不可变）**：seed 资产只读——编辑入口仅「另存为自定义」，产生新 specKey 资产；自定义资产创建后 specKey 亦不可变，改物理尺寸 = 另存副本；文档侧靠物化快照（`GemSpecSnapshot`，§1.1 已有裁决）保持稳定，目录漂移不影响旧文档。
- **Owner 理由登记（§0.5 裁决一）**：「方便维护」= 维护即增删/编辑素材库资产，不改代码。实现落 §3.1。

### 1.7 W0 验收（R1 P0-1 修订：contract receipt 与行为测试拆分）

**W0 contract receipt（本 gate 唯一验收面）**：

- **R2 §四 P0-1 前两项验收分句**——修复：在 v2 contract gate 单独提交 `BaseSpec/GemSpecSnapshot/PhysicalCanvas/requiredCenterDistancePx/maxCellPx` 类型；删除 `specId` 持久化别名和二/三参并存。**验收：TypeScript 编译、全库 grep 只有 canonical 名称。**
- **R2 §四 P0-2 全文**——修复：实现 project/lab migration registry 的 v1→v2 fixture，加入 `.gemshape` parser/typed errors、缺失资产状态和导入/pin-GC。**验收：四格式 byte-round-trip、向前拒读、损坏/超限/悬空 ref 拒绝、missing 不得静默导出。**（「缺失资产状态和导入/pin-GC」的运行时部分面在 2.2 vertical slice 证明；W0 交付其类型/schema/typed error 面。）
- **serializer 首写证明（R1 P0-1 补）**：2.x 首个写入路径仅在 W0 receipt 通过后出现，且不存在 v1 新写路径（写路径 grep 收据）。
- 补充放行条件（gemspec R1 §放行条件 1 原文）：「先完成 P0-1、P0-2、P0-4、P0-6 的 contract gate，再实现 engine 与四格式迁移；不接受只扩字段、不扩 `GridSpec`/handoff 的切片。」

**行为测试分句移出（R1 P0-1）**：R2 §四 P0-1 第三项验收分句「跨层 mixed-size/旋转/边界测试全部通过」依赖 engine gate（§2.1）与 replay 层组织——在 §2.6 验收与最终合流门（tasks 3.2）逐字引用收口，**W0 不验收行为测试**（W0-GATE-ONLY 门序：W0 通过即可放行 2.x serializer 与 engine gate 开工）。

---

## 2. engine gate（第二实现单元）

### 2.1 mixed-size pairwise：validate / conflict / exportGate 混合径化

现状：`validate`（validate.ts:17-40）、`validateEditable`（edit.ts:53-76）、`resolveConflicts→resolveGreedy`（edit.ts:130-137 / conflict.ts:27-45）全部单一 `pitch`（threshold = pitch×0.999）。升级：

1. 判据从单一 pitch → **逐对圆包络**：`dist ≥ requiredCenterDistancePx(a,b,grid)`；spatial hash cell 从 pitch → **`maxCellPx`**（px 单位）；
2. **边界与状态语义冻结**（gemspec R1 P0-2 / 专家稿 §D-2）：布局五策略/relax 的输入只接受**单 spec**（base spec——layout 算法不动，混合径布局属 P1+）；其产物进入文档时**强制跑 pairwise gate**，违规不得自动宣称合规；**保存允许 warning（文档可存），导出必须阻断**；load 后与改径/改形后**立即重算 warning**；
3. **`exportGate` 纯函数**（engine 出口）：统一 pairwise 判据的导出前置门，SVG/BOM/PNG/送精修共同前置（UI 接线归 studio-layers/expert change，本 change 交付函数 + 测试）；
4. 测试面：大钻/小钻混合、恰跨 cell 边界、边界 gap、旋转异形（圆包络不变性——rotationDeg 不改变 diameterMm 包络）、20k 钻。

### 2.2 SVG 逐钻规格渲染与 BOM 新键

- `buildSvg`：`<circle>` 快路径保留（round；现状按色分组的 `<circle>` 渲染，export.ts:63-79）；异形按 `.gemshape` 资产归一化 `vectorPath`（素材库真源，经内存目录解析——§3.1）× `diameterMm × pixelsPerMm` 缩放绘制；自定义 `<image>` dataUrl 引用（`gemRadiusPx(grid)` 现状单 grid 参数 → 逐钻 `gemRadiusPx(gem, grid)`，grid.ts:46-48——专家稿 §A.2 引擎清单 1）。
- `buildBom`：聚合键 `colorId` → **canonical `specKey × colorId`**（不由显示码反推）；表头 `规格,形状,尺寸,色名,hex,数量`（现状表头 `色名,hex,ss,数量` 且消费 `g.ss`，export.ts:89-103 内三处 :93/:99/:101——ss 随 GridSpec v2 退役，v1 圆钻迁移后自然落 `round-ssXX` 行）。

### 2.3 Gem / EditGem 字段落地

```ts
interface Gem {
  id: string; x: number; y: number; colorId: string; blockId: string
  shapeId: string        // v1 迁移补 'round'
  diameterMm: number     // 唯一物理依据（逐钻物化快照字段——不引目录 IO，深模块契约不变）
  rotationDeg?: number   // 异形朝向（0=默认朝上；圆钻恒缺省）
  assetId?: string       // shapeId='custom' 时 .gemshape 弱引用（missing 容忍四态 + §1.4 gate 6）
}
// EditGem 同步扩展（origin/moved 语义不变）；
// EditGemFields（update patch 白名单，现状 x/y/colorId，rhinestone-studio/src/lib/stores/edit.svelte.ts:126）扩 'shapeId'|'diameterMm'|'rotationDeg'
```

裁决理由（专家稿 §A.2）：engine 是纯函数深模块，间距校验需逐钻直径——引目录 = 引 IO 依赖；直径随钻位走，目录可变而文档稳定。zod schema 同步（Gem 字段进入公共契约面）。字段编辑 UI（属性面板）归 rename-and-expert-workbench。

### 2.4 CPU deterministic oracle 与性能 P0（GPU 不进 P0）

- **CPU 引擎 = 确定性 oracle**：同 seed 同参逐位重放承诺不变；任何进入文档/导出/重放的数据恒为 CPU 引擎产出（gpu-research.md §0/§7 路线 A）。`ENGINE_VERSION` 永远描述 CPU 引擎（version.ts:16 现值 1）。
- **性能 P0 = CPU CVT 优化**：`repairSpacing` 轮数/早停复诊、像素累加降采样或增量 Delaunay、`medianColor` 计数化——目标 **43s→<10s @1024²，输出逐位不变**（不 bump；gpu-research.md §7 P0-1 实测基线 43.1s）。验收 = 优化前后同参快照逐位相等 + 计时达标。
- **GPU 定位（登记，不在本 change P0）**：WebGPU 预览为 P1 试点（capability-labeled + `navigator.gpu?.requestAdapter()` 探测 + Worker 内懒加载 + CPU fallback；落盘/导出/重放恒 CPU 精算）。WGSL §15.7 允许浮点重结合/融合、不指定舍入模式——跨设备逐位复现规范层面不可得，与「同 seed 逐位重放」正面冲突（gpu-research.md §5）。GPU 试点立项与否为 Owner 拍板项（图层稿 §I.4-4），不阻塞本 change。

### 2.5 ENGINE_VERSION bump

预期 **1→2 随 engine gate**（validate/conflict/export 语义变更——专家稿 §A.2 裁决；横幅诚实性前提，version.ts bump 纪律）。护栏：单规格圆钻文档在 v1/v2 引擎下**钻位逐位不变**对比测试（混合径化对单规格参数空间理论等价：等径圆包络阈值 = pitch）；warning 文案/枚举演进允许（bump 已声明）。SS24 补档随同版本登记说明（§3.1）。

### 2.6 engine gate 验收（出处标注）

- **R2 §四 P0-3（engine 部分）**：「修复：engine gate 完成逐钻 spec、pairwise/exportGate；……验收：……多层导出包含隐藏层且违规硬阻断；BOM 使用 `specKey×colorId`。」（「v1 fixture 迁移后与旧 replay 逐位相等」与六步 layers[] 链归 replay/handoff gate，不在本 change。）
- **R2 §一 P0-2（闭合表）**：「统一签名、单位和 `maxCellPx` 公式；实现全层 concat 的 pairwise、保存 warning/导出 hard block；补大小径、跨 cell、边界 gap、旋转、20k 测试。」（跨层 concat 的层序组织归 studio-layers；判据/门/测试面在本 change。）
- **gpu-research.md §7 P0-1**：CVT 43s→<10s、输出逐位不变（不 bump）。

---

## 3. 目录与自定义钻形资产化

### 3.1 规格目录（素材库真源；Owner 2026-09-20 裁决一）

- **目录 = 素材库**：内置规格（sys-shapes seed——round×SS 十二档 + 四异形×常用 mm 档）与用户自定义钻形同域统一为 `.gemshape` 资产（§1.6），单一真源；专家稿 §A.1.2 原「内置=代码层 / 自定义=素材库」双真源分层方案被裁决一修订。「钻目录」不是单一页面。
- **内存目录 = 解析缓存层**：`specKey → GemSpec` 条目（§1.1 内存条目类型）hydrate 惰性装载（首次解析某资产时入缓存），非序列化、非真源——真源恒为素材库资产。
- **SVG/Canvas 双消费同源**：导出与编辑画布消费同一份 `.gemshape` 资产数据（vectorPath 或贴图缩放；两者并存时导出优先 vectorPath——§1.4 补充约束），按 `diameterMm × pixelsPerMm` 缩放。
- **SS24 补档 = 新增一条 seed 数据**（sys-shapes 下新增 `ast-shape-round-ss24` 条目）：`SS_KEYS` 现缺 SS24（SS22→SS26 跳档，types.ts:12-25；行业标准 SS24≈5.3mm，中置信）。增补不改变既有参数输出（同参同出）→ 按 version.ts 纪律不构成强制 bump；在常量收编完成后补齐，随 ENGINE_VERSION 纪律注释登记（R2 非阻塞建议原文：「收编三处 2.5 常量后再补 SS24 目录项；SS24 不阻塞 v2 gate，但需伴随 ENGINE_VERSION 纪律说明」）。不阻塞 gate。

### 3.2 `.gemshape` 八面 vertical slice（一次性冻结，不以草案直接切片——gemspec R1 议题 10 裁决）

| # | 面 | 内容 |
|---|---|---|
| 1 | projectTypes | `ProjectKind` 第五值 `'gemshape'` + `PROJECT_MIME` 第五值（projectTypes.ts:17,20-25 现四值） |
| 2 | AssetNode | gemshape 资产节点入 AssetNode union；可编辑资产（blobKey 换绑豁免同 gemproj/gemdoc/gemtpl）；specKey 创建后不可变（§1.6 身份纪律——改物理 = 另存副本；seed 资产只读） |
| 3 | 导入路由 | App 全局导入接第五格式 → ingest → 素材库定位（不切页——无直接消费页；「去使用」入口归 expert change 的钻形库 UI） |
| 4 | 素材库 seed | sys-shapes seed 内置规格（`ast-shape-${specKey}` 幂等 create-only——§1.6）+ 用户自定义同域（「钻形」系统目录序插「模板」与「生成结果」之间——配置资产聚簇） |
| 5 | RightSheet 编辑 | gemshape 卡片编辑器（Sheet side=right，沿 gemtpl 双 canonical handler 先例：去使用/去编辑两 canonical handler） |
| 6 | parser + 迁移 | `.gemshape` serialize/parse + §1.4 六条 gate + typed errors + round-trip |
| 7 | 引用 pin/GC 矩阵 | gemdoc/gemgen/内存文档对 `assetId` 的引用 = **弱引用**（missing 四态，EditView referenceAssetId 先例）；被引用资产软删/回收不阻止（容忍），硬清走既有 blob GC；RightSheet 编辑期间 pin 校准参考资产（refSpecId 解析）；删除后引用方 = missing typed + 导出阻断（gate 6）。**missing 四态定名与转移矩阵（R1 建议 4，2.2 验收必需）：① `resolved`（资产可解析——唯一可导出态）；② `soft-deleted`（节点在回收站——占位渲染 + BOM 标注 missing + exportGate 阻断；恢复→resolved）；③ `blob-missing`（节点在而字节丢失/损坏——同上，typed 错误码区分）；④ `wrong-kind/invalid`（节点存在但非 gemshape 或 parse 失败——同上）。硬清（blob GC）后不可恢复（校准快照仍在文档侧可审计）；编辑期 pin 只保护校准参考，不把文档弱引用升级为硬 pin** |
| 8 | 校准向导数据面 | direct（输 mm）/ reference（选规格反推）两模式物化 `physical`（UI 三步向导归 rename-and-expert-workbench，本 change 交付数据面与校准函数） |

### 3.3 常量收编消费切换

三处副本（studio.svelte.ts:56 / gemprojReplay.ts:41 / quickLayout.ts:65）→ import engine 单一出口；同值 2.5 行为零变化；常量单源断言测试（replay/quickLayout/studio 同值）。「第四处复制正在路上」的防线（专家稿 §H-1）。

---

## 4. 迁移与 fixture 细则

- 迁移器复用既有注册骨架（`(from,to)=>migrate` 纯函数链逐版本串行，projectFile.ts:113-128 / labFile.ts:106-121），填充 v1→v2 五条（四格式 + .gemshape 无迁移即 v1 起步）。
- **fixture**：每格式至少一组 v1 真实形态 fixture（gemproj 含 overrides 四表/gemdoc 含手工钻 m- 前缀/gemtpl 全字段/gemgen 含 provenance.mode 旧档）→ 迁移 → v2 → save→load→save **字节等价**（add-project-files design §1.3 纪律）。
- **向前拒读**：formatVersion 大于支持值 → 显式错误（骨架已备，projectFile.ts:69 / labFile.ts:62）。
- **坏输入 typed error**：每格式 parse 的脏输入容错测试沿用 add-project-files 0.2/4.1 口径。
- gemproj v1→v2 迁移的 overrides 块键清理：迁移只搬运（键 = 引擎块 id，v1 即如此——图层稿 R1 议题 2 纠偏）；打开/重放后的 `pruneStaleOverrides` 清点归 replay/handoff gate。

## 5. 测试策略

- **W0 contract**：类型编译门；canonical 名称 grep（specId 持久化清零、helper 唯一定义点）；四格式 fixture 迁移 + byte-round-trip + 向前拒读 + 脏输入 typed error；`.gemshape` 六条 gate 各自的坏输入用例（假宽高/超限/全透明/比例漂移/悬空 ref/missing 导出阻断）；px/mm 不变量（PhysicalCanvas 派生、default 回退显式）。
- **engine**：mixed-size pairwise（大小径混合/恰跨 cell/边界 gap/旋转不变性/20k）；单规格圆钻 v1/v2 钻位逐位不变护栏；BOM specKey×colorId（含同形同尺寸不同自定义资产靠 assetId 区分行）；SVG 三路径（circle/path/image）golden；CPU oracle 同参快照；CVT 优化前后逐位相等 + 计时。
- **资产化**：sys-shapes seed 幂等；gemshape ingest/换绑/软删；引用 missing 四态 + 导出阻断；常量单源断言。
- **基线**：全量 `pnpm test`/`pnpm check` 绿门为收尾前置（R2 §四 P0-5：现存 `gemgenArchive.test.ts` 1 例失败为既有基线债，须修复或显式归因后恢复 864/864，不得把旧失败当作新契约证据）。

## 6. 议题与未决（不阻塞 W0）

| # | 议题 | 状态 |
|---|---|---|
| 1 | 蓝图机器级同排布是否另立 change | 待 Owner 拍板（§0.4-1 默认不进本 change） |
| 2 | v2 contract gate 宿主 = 本 change W0（R2 §三-4 可执行方案） | 本 change 即宿主；Owner 若改裁独立 micro-change，本文档整体迁移 |
| 3 | GPU 预览试点（P1）立项与否 | 待 Owner 拍板（图层稿 §I.4-4）；不阻塞本 change |
| 4 | ENGINE_VERSION 是否因 SS24 补档额外 bump | 随 §2.5/§3.1 纪律说明处理（同参同出不 bump） |
