# 专家工作台能力（改名 + 工作台骨架 + service 层）Delta

## ADDED Requirements

### Requirement: 模块命名一致（改名联动）
用户可见的模块命名 MUST 为：「排钻设计」（桌面导航，移动端短名「排钻」）与「专家工作台」（桌面导航，移动端短名「专家」）；实验室→排钻设计的交接动作 MUST 称「送排钻」；全库（组件文本/注释/测试断言/toast/错误与 handoff 文案）MUST 无「转化工作台」「送转化」「手动编辑」残留；「送精修」动作、「精修项目」/.gemdoc 文件格式名、应用名「贴钻工作台」MUST NOT 改变。
> 承接 add-project-files 移交切片 5.1（其 design §5/tasks 5.1 移交注记）与专家稿 §B.1 联动表；TERMS 升 v2、PRODUCT_MODEL 升 v4 随本批落地。
#### Scenario: 桌面导航
- **WHEN** 用户查看桌面顶级导航
- **THEN** Tab 依次为 素材库 / 提示词实验室 / 排钻设计 / 专家工作台，无旧词
#### Scenario: 移动端短名
- **WHEN** 用户查看移动端底部 Tab
- **THEN** studio Tab 显示「排钻」（不得用泛称「工作台」）、edit Tab 显示「专家」
#### Scenario: 送排钻动作与反馈
- **WHEN** 用户在任务卡或预览 Dialog 执行交接、以及交接成功/失败
- **THEN** 动作词为「送排钻」，成功 toast 为「已送入排钻设计」，失败提示以「送排钻失败」起头
#### Scenario: 送精修不变
- **WHEN** 用户在排钻设计执行送精修、或触发覆盖确认
- **THEN** 动作词与确认文案仍为「送精修」语义，「.gemdoc/精修项目」命名不变
#### Scenario: 空态引导与导航一致
- **WHEN** 编辑页空态展示引导行「去排钻设计送精修」
- **THEN** 引导行所指 Tab 名与实际导航名一致（现状 Tab 旧词导致的错位消除）

### Requirement: 专家工作台四区布局
专家工作台 MUST 为四区布局：左工具栏（选择/画钻/擦除 + 吸附开关 + 撤销重做）、中央画布（四层合成）、右侧属性面板与图层面板；属性面板 MUST 是选中对象的属性（Inspector 语义），MUST NOT 暴露分块/策略/密度等排钻管线参数面板（概念混入禁令）；未选中时属性面板 MUST 显示空态占位而非隐藏。
#### Scenario: 布局结构
- **WHEN** 打开专家工作台且已有文档
- **THEN** 四区齐备；图层面板提供四层显隐/透明度控制（沿用既有语义）
#### Scenario: 参数面板禁令
- **WHEN** 单选/多选/未选中任意状态
- **THEN** 属性面板仅出现钻对象字段（位置/颜色，及规格字段——见下条 Requirement），不出现排钻参数

### Requirement: 逐钻选择与批量编辑
专家工作台 MUST 支持点选、Shift 点选加/减选、画布框选（相交命中）、Esc 清空；批量属性修改 MUST 合并为单一撤销组；选择规模（N 选）MUST 在属性面板可见。
#### Scenario: 框选与批量改色
- **WHEN** 用户以选择工具框选若干钻并在属性面板改色
- **THEN** 命中钻全部入选、面板显示「N 颗已选」，改色一次撤销即可整体回退

### Requirement: 笔刷工具（画钻/擦除）
画钻笔刷 MUST 以「当前规格（形 × 尺寸 × 色）」落钻：物化 shapeId/diameterMm/colorId 且 origin='manual'；吸附开关 MUST 提供「格位」（默认，吸附当前规格的六方格位）与「自由」两态；与既有钻间距不足时 MUST 拒画并闪红提示；擦除笔刷 MUST 命中即删；一次起笔-收笔的连续笔触 MUST 为单一撤销组。
#### Scenario: 吸附格位落钻
- **WHEN** 吸附=格位时用户在画布涂抹
- **THEN** 落钻中心吸附格位、携带当前规格物化字段；手势层提供笔刷光标与吸附格位高亮
#### Scenario: 冲突拒画
- **WHEN** 落点与既有钻的 pairwise 间距不足
- **THEN** 该钻不落、闪红反馈，既有钻不受影响
#### Scenario: 笔触撤销
- **WHEN** 用户一次笔触后执行撤销
- **THEN** 该笔触全部钻作为一个组整体回退

### Requirement: 属性面板规格字段与校验消费（W0 后）
属性面板 MUST 提供形状/尺寸/朝向（旋转）字段编辑（数值/步进，1°/15° 档）；改尺寸/改形后系统 MUST 立即重算间距警告（实时警告，不阻断编辑）；保存 MUST 允许带警告文档（显示警告徽标），导出 MUST 硬阻断并列出违规清单（消费 engine exportGate）；文档加载后 MUST 重算警告。
#### Scenario: 改径即时警告
- **WHEN** 用户将选中钻尺寸改大导致与邻近钻间距不足
- **THEN** 立即出现警告指示，编辑不被阻断
#### Scenario: 保存放行与导出阻断
- **WHEN** 对含间距违规的文档分别执行保存与导出
- **THEN** 保存成功并带警告徽标；导出被阻断并展示违规清单
#### Scenario: 旋转编辑
- **WHEN** 用户在属性面板输入或步进朝向角度
- **THEN** 旋转值生效、可撤销、随文档序列化

### Requirement: nudge 微移与对齐分布
方向键 MUST 微移 1px；Shift+方向键 MUST 按当前格距 pitch 步进；Alt+方向键 MUST 按 0.1mm 步进；连续按键（按键会话）MUST 合并为单一撤销组；多选 ≥2 MUST 提供左/右/上/下/水平居中/垂直居中对齐，多选 ≥3 MUST 提供水平/垂直等距分布。
#### Scenario: 按键会话合组
- **WHEN** 用户按住方向键连续微移后停止
- **THEN** 该连续操作一次撤销整体回退
#### Scenario: 对齐分布
- **WHEN** 三颗钻被选中并执行垂直等距分布
- **THEN** 钻位重排为等距且该操作为单一撤销组

### Requirement: 钻规格选择与自定义钻形校准
专家工作台 MUST 提供顶部「当前规格」选择器（形/尺寸 + 色板色）驱动画钻笔刷；自定义钻形 MUST 经三步向导入库：选贴图 → 物理尺寸（直接输 mm，或以现有规格参考反推）→ 命名入库；校准 MUST 为烘焙语义（参考规格后续改动不影响已入库钻形的 physical）；向导 MUST 以显式错误拒绝超限贴图、比例漂移、悬空参考（消费 .gemshape parser typed errors）。
#### Scenario: 参考校准
- **WHEN** 用户上传贴图并选择「参考 SS10 圆形（2.8mm）」完成向导
- **THEN** 入库钻形的物理尺寸由贴图内容主径 px ÷ 参考规格换算物化；此后修改或删除参考规格不改变已入库值
#### Scenario: 坏输入拒绝
- **WHEN** 贴图全透明、超大小上限、或声明尺寸与内容纵横比超容差
- **THEN** 向导显示对应 typed 错误并拒绝入库，不产生静默降级资产

### Requirement: 画幅物理读数
专家工作台状态条 MUST 显示画幅物理尺寸（mm）与 px/mm 换算读数，读数值 MUST 来自 PhysicalCanvas 真值（declared/default 锚来源区分呈现）；物理锚贯通前读数位 MUST 留空而非显示未经声明的缺省值。
#### Scenario: 声明画幅读数
- **WHEN** 打开携带 declared PhysicalCanvas 的文档
- **THEN** 状态条按实际交接画布宽换算显示「画幅 WxHmm · N px/mm」

### Requirement: 前端 service 封装层
钻目录消费 MUST 经 gemCatalogService 接口（listSpecs/resolveSpec）：规格数据 W0 前 MUST 由内存 mock 提供、W0 后 MUST 切换为素材库 sys-shapes 的 .gemshape 资产真源（含内置形入库 seed；engine 仅留迁移 bootstrap 查表），切换 MUST 不改变接口签名与消费方；文档的打开/保存/另存/导出编排 MUST 经 documentService 单点（组件不得内联编排）；生成服务 MUST 仅保留接口位，其生命周期契约归姊妹 change add-lab-drill-params-and-blueprint 冻结；service 层 MUST NOT 持有或复制状态真源（真源恒在 store）。
#### Scenario: 目录真源切换
- **WHEN** W0 资产化落地后规格选择器请求数据
- **THEN** 同一 specKey 经 service 解析结果与 mock 期语义一致，消费组件零改动
#### Scenario: 文档编排单点
- **WHEN** 用户从素材库打开 .gemdoc 或保存/导出文档
- **THEN** 编排（parse→载入→lease / serialize→CAS 换绑→dirty 清零）由 documentService 完成，失败以 typed 结果返回 UI 呈现
#### Scenario: 生成接口位不抢真源
- **WHEN** 本 change 归档时检查 generationService
- **THEN** 其仅含接口骨架与归属注释，无生命周期字段预填
