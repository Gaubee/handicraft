# 项目文件能力（四格式 + 两页重构 + 实验室模板库化）Delta

## ADDED Requirements

### Requirement: 排钻项目文件（.gemproj）
排钻设计页的工作成果 MUST 以 `.gemproj` 参数工程持久化：只存来源图（库内 asset 引用 / 导出内嵌双形态）与参数全集，钻位永不入文件；打开 MUST 为引擎确定性重放。
#### Scenario: 保存与续作
- **WHEN** 用户在排钻设计页调整参数后保存（⌘S）
- **THEN** sys-projects 出现/更新该项目节点（blobKey 换绑），刷新后经「最近项目」打开可续作
#### Scenario: 引擎版本漂移
- **WHEN** 打开 engineVersion 不等于当前引擎的项目
- **THEN** 系统必须显示黄色横幅并按当前引擎重算，失效块覆写逐项清点移除
#### Scenario: 来源缺失
- **WHEN** 项目 source.assetId 解析失败
- **THEN** 画布必须显示错误卡，参数完好，可重新绑定来源图重放或仅导出参数文件

### Requirement: 精修项目文件（.gemdoc）
手动编辑页的工作成果 MUST 以 `.gemdoc` 烘焙文档持久化：gems 全量 + 内嵌 PNG 底图，自包含、独立可开；撤销栈 MUST NOT 序列化。
#### Scenario: 保存与打开
- **WHEN** 编辑文档 dirty 后保存
- **THEN** sys-projects 出现/更新 gemdoc 节点；再次打开为干净文档，manualCounter 从 gems 派生
#### Scenario: 脏态口径
- **WHEN** 自上次保存后有修改
- **THEN** 名称旁必须显示●未保存，刷新/覆盖/打开其它项目前过守卫；导出不清除 dirty

### Requirement: 模板文件（.gemtpl）与模板库化
提示词实验室的模板 MUST 以 `.gemtpl` 持久化于素材库 `sys-templates`；实验室模板面板 MUST 从素材库选取，不硬编码；内置 preset MUST 幂等 seed 为模板资产（create-only，删除不复活）。
#### Scenario: 模板选取与写回
- **WHEN** 用户在实验室新增/编辑/复制/删除模板
- **THEN** 对应 .gemtpl 资产创建/换绑更新/软删，刷新后模板列表与素材库一致
#### Scenario: 双击模板
- **WHEN** 在素材库双击 .gemtpl
- **THEN** 系统切换到实验室并选中该模板，任务画廊按该模板过滤

### Requirement: 生成结果文件（.gemgen）
实验室生成结果的归档产物 MUST 为 `.gemgen` 自包含档案（图片内嵌 + 溯源：模板 assetId/提示词全文快照/参考图 assetId/任务元数据）；.gemgen MUST 不可变（重试产新档）。
#### Scenario: 归档
- **WHEN** 生成结果归档入「生成结果」目录
- **THEN** 产生 .gemgen 资产（非裸图片），携带完整溯源与 256px 缩略（thumbKey 持久化）
#### Scenario: 双击生成结果
- **WHEN** 在素材库双击 .gemgen
- **THEN** 系统切换到实验室，左侧自动关联对应模板，画廊按该模板过滤并滚动定位到该结果且展开；解析失败不离开素材库

### Requirement: 任务画廊 tpl 分组与卡片两态
画廊 MUST 支持 全部/按模板 分组过滤（单选 chips）；卡片 MUST 有收起（默认小图预览）与展开（大图+动作）两态；画廊数据 MUST 为会话任务与库内 gemgen 的并集（assetId 去重，活任务状态覆盖只读投影）。
#### Scenario: 过滤与展开
- **WHEN** 用户选择某模板过滤并展开某结果
- **THEN** 画廊仅显示该模板的结果；收起/展开状态保持，对比 Dialog 入口保留于展开态

### Requirement: 排钻页改名与措辞联动
「转化工作台」MUST 更名「排钻设计」（移动端「排钻」），「送转化」MUST 改「送排钻」，全库（含注释/测试断言/toast/handoff 文案）无旧词残留；「送精修」不变。
#### Scenario: 改名一次改齐
- **WHEN** 本 change 完成
- **THEN** Tab/动作/空态引导/路由全部使用新词

### Requirement: 手动编辑四入口
编辑页 MUST 支持四入口 converge 同一文档模型：送精修 / 素材库选图→快速排稿 / 打开 .gemdoc / 导入 gemdoc；编辑器 MUST NOT 暴露排钻参数面板。
#### Scenario: 选图直入
- **WHEN** 编辑页空态从素材库选图
- **THEN** 默认参数快速排稿（进度可取消）生成未保存新文档，provenance=quick-layout

### Requirement: 素材库项目节点与统一打开手势
AssetProject 节点（projectKind 四分化）MUST 纳入「全部素材」口径与底栏计数；统一手势（含图片节点）MUST 为：桌面单击选中（选中态工具行 [打开]/[重命名]，Enter=打开）、双击打开（移动端单击打开），按格式路由到对应页面（一页一格式）；gemproj 打开期间 MUST 以引用计数 lease pin 其 source/reference（最后 owner 关闭才解除）。
#### Scenario: 双击路由
- **WHEN** 双击 gemproj / gemdoc / gemtpl / gemgen 节点
- **THEN** 分别路由到 排钻设计载入 / 手动编辑载入 / 实验室选中模板 / 实验室关联+定位展开；解析失败不离开素材库；有未保存修改先过守卫
#### Scenario: gemgen 缩略
- **WHEN** gemgen 归档或导入
- **THEN** 系统生成 256px 缩略（显式 thumbKey 持久化），卡片直出缩略不解析完整档案；thumb 缺失时懒解析内嵌图回退

### Requirement: 图像消费单点
所有跨模块图片字节消费 MUST 经 `getHandoffImageBlob(assetId)` 单点出口（图片资产直取 / gemgen 校验后解析内嵌图 / missing 显式 typed error）；HandoffPayload 形状 MUST 保持零变化。
#### Scenario: 送排钻消费 gemgen
- **WHEN** 用户对 .gemgen 结果执行送排钻
- **THEN** handoff 载荷形状不变，studio 经单点出口取得图像字节，零重编码
