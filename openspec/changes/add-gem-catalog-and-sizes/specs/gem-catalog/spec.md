# 钻规格目录能力（尺寸/钻形 + v2 契约 + .gemshape）Delta

## ADDED Requirements

### Requirement: 钻规格目录与唯一身份
钻规格（形 × 尺寸）MUST 以两层配置资产存在：内置规格（圆形 × SS 档 + 四异形 × mm 档）为 engine 常量（不入库、不序列化、随 ENGINE_VERSION 语义演进），自定义钻形为 `.gemshape` 素材库资产；`GemSpecSnapshot.specKey` MUST 为唯一持久身份（builtin 确定性键 / custom 含 assetId），`specId` 持久化别名 MUST 清零，身份 MUST NOT 由显示码或浮点直径反推。
#### Scenario: 规格解析
- **WHEN** 任何序列化/迁移/BOM 场景需要确定一颗钻的规格身份
- **THEN** 以 canonical `specKey` 快照解析（如 `round-ss10` / `custom-<assetId>`），显示码（R10/SQ35）仅作人读列
#### Scenario: 内置形渲染同源
- **WHEN** SVG 导出与编辑画布渲染同一内置异形
- **THEN** 两者消费 engine/shapes.ts 同一份归一化轮廓 path 数据（按 diameterMm × pixelsPerMm 缩放）

### Requirement: 混合尺寸间距校验与导出门
任意两钻的间距判据 MUST 为唯一 helper `requiredCenterDistancePx(a, b, grid)` 的圆包络（`dist ≥ (d_i+d_j)/2 + gap`，mm→px 换算只发生在 helper 内，单位恒 px）；spatial hash cell MUST 为 `maxCellPx`（max diameter + gap，px）；`validate`/`validateEditable`/`resolveConflicts` MUST 混合径化；布局五策略输入 MUST 保持单规格，其产物进入文档时 MUST 强制过 pairwise gate；间距违规文档 MUST 允许保存（warning）但 MUST 阻断导出（`exportGate` 为 SVG/BOM/PNG/送精修共同前置）。
#### Scenario: 混合径违规
- **WHEN** 文档同时包含大钻与小钻且存在中心距不足的钻对
- **THEN** 校验按逐对包络报告违规清单（确定性排序），文档可保存并显示 warning
#### Scenario: 导出阻断
- **WHEN** 对存在 spacing 违规的文档执行 SVG/BOM/PNG 导出或送精修
- **THEN** exportGate 硬阻断并给出违规明细；不产出导出物

### Requirement: 逐钻规格导出
SVG 导出 MUST 按逐钻规格渲染（圆钻 circle 快路径 / 内置异形 path / 自定义钻形 `<image>`）；BOM 聚合键 MUST 为 canonical `specKey × colorId`（同形同尺寸不同自定义资产靠 assetId 区分），表头 MUST 含 规格,形状,尺寸,色名,hex,数量。
#### Scenario: BOM 聚合
- **WHEN** 文档含多规格多色钻
- **THEN** BOM 按 specKey×colorId 聚合计数，规格列显示规格码与尺寸，含合计行

### Requirement: 物理画幅与 px/mm 单源
物理画幅 MUST 以 `PhysicalCanvas{widthMm, heightMm, anchorSource}` 承载于 `.gemproj`/`.gemdoc`/`.gemgen` 的 v2 schema（`.gemtpl` MUST NOT 承载画幅锚——模板与物理画幅无关，product 模式的画幅声明在生成任务与 .gemgen 档案）；`pixelsPerMm` MUST 锚定实际降采样后的 canvas 像素宽（`实际宽 ÷ widthMm`，dimsMismatch 以实测为准）；缺失/非法声明 MUST 回退 default 2.5 且显式 `anchorSource:'default'`；`PIXELS_PER_MM` MUST 收编为 engine 单一出口（三处重复副本清零）。
#### Scenario: 降采样锚定
- **WHEN** 声明 210×148mm 的画幅实际以 1024px 宽交接（源图曾降采样）
- **THEN** pixelsPerMm = 1024 ÷ 210（以实测 image.width 为锚，不盲用文件记录宽），一颗 2.8mm 钻的物理直径恒 2.8mm
#### Scenario: 常量单源
- **WHEN** 全库检索 px/mm 缺省常量
- **THEN** 仅 engine 单一出口一处定义，studio/replay/quickLayout 同值消费

### Requirement: 四格式 v2 版本门与迁移
四格式（.gemproj/.gemdoc/.gemtpl/.gemgen）MUST bump formatVersion 1→2 并注册 v1→v2 纯函数迁移（gemproj 顶层 physics/activeStrategy 化入 layers[]、每层 specKey；gemdoc gems 逐钻补规格字段；gemtpl 补 workflowMode/gemSpecIds；gemgen 拆 requestMode/workflowMode + 可选 blueprint/gemSpecs/physicalCanvas）；每次 bump MUST 附 save→load→save 字节等价 round-trip 测试；超前版本 MUST 向前拒读；坏输入 MUST 给 typed error。
#### Scenario: v1 旧档迁移
- **WHEN** 打开任一格式的 v1 文件
- **THEN** 迁移为 v2 后正常消费（圆钻补 round + SS_TABLE 查表直径；gemproj 参数落入单一兜底层），round-trip 字节等价
#### Scenario: 向前拒读
- **WHEN** 文件 formatVersion 高于当前支持
- **THEN** 显式 typed error 拒读，不猜测解析

### Requirement: 自定义钻形资产（.gemshape 第五格式）
自定义钻形 MUST 为第五种 ProjectKind 资产（sys-shapes「钻形」系统目录、RightSheet 编辑、全局导入路由、可换绑保存）；校准 MUST 为烘焙式（direct 输 mm / reference 以现有规格反推），结果物化 physical、calibration 仅记出处；文档对钻形资产的引用 MUST 为弱引用（missing 四态容忍），被引用资产删除后文档 MUST 呈现 missing typed 状态且导出阻断，MUST NOT 静默降级为圆钻后照常导出。
#### Scenario: 上传入库
- **WHEN** 用户上传贴图并完成校准（直接输 mm 或选参考规格）
- **THEN** 产生 .gemshape 资产（内嵌贴图 + physical 快照 + calibration 出处），可在素材库管理
#### Scenario: 引用资产缺失
- **WHEN** 打开引用了已删除 .gemshape 的文档
- **THEN** 画布占位渲染 + BOM/导出清单标注 missing，导出被 gate 阻断，不回退圆钻轮廓导出

### Requirement: .gemshape 输入防线
`.gemshape` parser MUST 强制六条 schema gate：解码后实际宽高与声明不符拒收；MIME 白名单 + 字节/像素上限；alpha bounds 非空（主径/换算取 alpha 内容 bounds）；physical 与贴图纵横比超容差拒绝（不做静默裁剪/contain）；reference 校准必须 refSpecId 可解析或内嵌 refSpecSnapshot；missing 资产 typed 不得静默降级导出。
#### Scenario: 坏贴图拒收
- **WHEN** 导入声明宽高与解码不符 / 超限 / 全透明 / 比例漂移超容差的 .gemshape
- **THEN** 分别以对应 typed error 拒收，不产生半入库资产
#### Scenario: 悬空校准审计
- **WHEN** 校准参考的规格资产被删除
- **THEN** 已入库钻形凭内嵌 refSpecSnapshot 保持可审计，但不可重新校准

### Requirement: CPU 确定性与性能
CPU 引擎 MUST 保持确定性 oracle 地位（同 seed 同参逐位重放；任何进入文档/导出/重放的数据恒为 CPU 产出）；GPU MUST NOT 出现在 P0（WebGPU 仅 P1 预览试点：capability-labeled + CPU fallback）；CPU CVT 优化 MUST 达到 1024² 图 43s→<10s 且输出逐位不变（不 bump ENGINE_VERSION）；validate/conflict/export 语义变更 MUST bump ENGINE_VERSION（预期 1→2，横幅诚实性前提）。
#### Scenario: CVT 优化零漂移
- **WHEN** CVT 优化前后以同参数运行
- **THEN** 钻位输出逐位相等且耗时 <10s（1024² 基准），ENGINE_VERSION 不因该优化 bump
#### Scenario: 单规格护栏
- **WHEN** v1/v2 引擎对同一单规格圆钻文档重放
- **THEN** 钻位逐位不变（混合径化对单规格参数空间等价），引擎语义变更经 ENGINE_VERSION 显式声明
