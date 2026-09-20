# 贴钻工作台 · 产品模型（Product Model）

> 版本：v5（2026-09-20，随 studio-layers ④段图层化：对象树/流程图补排钻设计图层域（layers/history/computeQueue/projectPersistence 四 store 子模块）；真源表「排钻策略选择」宿主迁移 胶片带→图层配置字段 + 新增「图层结构与配置」行 + 「观察态」边界行；硬规则补 隐藏层口径 与 多选批量单 op）；v4（2026-09-20，随 rename-and-expert-workbench R 轨改名：「手动编辑」模块名退役为「专家工作台」，一句话/对象树/硬规则 3/真源表措辞联动）；v3（2026-09-19，随「add-project-files」四格式家族裁决引入项目文件层；v2 随素材库引入资产层，见 git 历史；v1 见 `.agents/documents/2026-09-18-rhinestone-ia/ia-design.md` §0）
> 地位：**所有界面/功能改动的第一约束**。任何需求动手前先回答「如何进入本模型」；与本文冲突的设计一律 REJECT。

## 一句话

四模块工作台 + 一个资产层：实验室产出「贴钻候选效果图」，排钻设计把效果图按**图层**调成「可生产钻位方案」，专家工作台做「钻级编排精修」，素材库是**全部资产（图片 + 项目文件）的唯一真源**。

## 对象关系树（Object Modeling）

```
素材库（AssetNode 虚拟文件系统，IndexedDB）
 │   · 案例（系统只读） · 模板 · 生成结果（按批次） · 项目 · 上传 · 精修导出 · 回收站
 ├──▶ 实验室 · 案例参照图    = 引用资产（assetId + caseLayout；canvas 合成图物化入库，preset 幂等 seed）
 ├──▶ 实验室 · 模板（.gemtpl）= AssetProject 节点（真源；页面内编辑、字段提交换绑写回）
 ├──▶ 实验室 · 生成结果（.gemgen）= 自动入库（不可变档案：内嵌图 + 溯源；source='lab-generate'）
 ├──▶ 排钻设计 · 数字油画来源 = 引用资产（handoff 传 assetId 或选图器直选；gemgen 经单点解析）
 ├──▶ 排钻设计 · 图层域 = studio store 四子模块：layers（LayerState reducer——层成员/层配置/覆写四表）
 │                      + history（StudioOp fold——参数重放不记结果，永不序列化）
 │                      + computeQueue（脏层追踪 + 单 worker 逐层串行计算）
 │                      + projectPersistence（保存/打开/lease/dirty——④段项目生命周期）
 ├──▶ 排钻设计 · 项目（.gemproj）= AssetProject 节点（参数工程：来源 + layers[] 图层化参数全集，
 │                                  钻位 = 引擎重放；历史与观察态不入档）
 ├──▶ 排钻设计 · 叠放参考原图 = 引用资产
 ├──▶ 专家工作台 · 项目（.gemdoc）= AssetProject 节点（烘焙文档：gems + 内嵌底图）
 └──▶ 专家工作台 · 导出 PNG     = 入库（source='edit-export'）

实验室（真源=库模板 .gemtpl） ──handoff(assetId)──▶ 排钻设计（真源=图层化参数：layers 层配置+块覆写+色板，存 .gemproj）
                                                       │
                                                       ├─导出 .gemdoc / 送精修（ManualEditHandoff 烘焙快照：
                                                       │   全层 concat 逐钻规格 + 画幅物理锚 physicalCanvas）──▶ 专家工作台（真源=EditDocument.gems，存 .gemdoc）
                                                       └─▶ SVG / BOM / PNG 导出（全层并集——含隐藏层，exportGate 前置）
```

## 单一真源表（One Concept → One Canonical Location）

| 概念 | 唯一真源 | 快捷入口（converge 到真源） |
|---|---|---|
| 图片资产 | 素材库（AssetNode + blob） | 各模块选图器 Dialog；上传即入库 |
| BYOK 连接 | SettingsDialog（localStorage） | 顶栏状态芯片 |
| 提示词模板 | 素材库（AssetProject, gemtpl） | 实验室左面板；素材库 RightSheet（同一 TemplateEditor 双宿主） |
| 生成历史（任务流 ∪ 档案） | 实验室画廊（会话任务 ∪ 库内 gemgen） | 素材库双击 gemgen 定位；删任务记录不删档案 |
| 排钻项目文件 | 素材库（AssetProject, gemproj） | 排钻设计页打开/最近列表 |
| 精修项目文件 | 素材库（AssetProject, gemdoc） | 专家工作台页打开/最近列表 |
| 快速排稿参数 | 固定默认（不可调——调参去排钻设计） | 编辑页空态选图直入 |
| 图层结构与配置 | studio layers 域（LayerState reducer：成员/层配置/覆写四表——持久化进 .gemproj layers[]） | 左列图层面板（建/删/并/移块/重命名）+ 检查器层配置卡 |
| 排钻策略选择 | 图层配置字段（每层独立 strategy——宿主迁移史见版本行） | 检查器层配置卡策略 Select（全应用唯一写入点） |
| 块覆写/层物理参数 | studio layers 域（逐层 overrides + 物理四件；→ 持久化进 .gemproj layers[]） | 检查器层配置卡/块详情/分块参数组 |
| 观察态（层可见性/背景/选择/取景） | studio 会话内存（纯会话态——**不入 .gemproj、不入历史**） | 打开恢复默认 + 单次提示；背景层源/透明度在检查器背景面板 |
| 色板 | studio store（→ 持久化进 .gemproj） | 检查器折叠组 |
| 钻面文档 | 专家工作台 EditDocument.gems（→ 持久化进 .gemdoc） | —（不回流排钻管线） |

## 交接语义（handoff contract）

- **派生数据 → 烘焙**：排钻设计→专家工作台的钻位/分块/像素快照，深拷贝收下，参数不回流。
- **不可变资产 → 引用**：图片资产内容永不修改（只有元数据移动/改名），跨模块一律传 `assetId`，消费时取 blob。引用不破坏烘焙语义。
- **项目文件 = 交接语义的文件化**：gemproj = 参数工程可重放；gemdoc = 烘焙快照自包含；gemtpl = 配置资产可编辑；gemgen = 不可变档案（生成即定稿）。
- **模板 → 任务 → 档案是「配置 → 快照 → 档案」降熵链**：模板可编辑（换绑）、任务快照可重试、档案不可变；composedPrompt 全文只存在于档案。
- **图像消费单点**：跨模块取图像字节只经 `getHandoffImageBlob(assetId)`（图片资产直取 / gemgen 解析内嵌图；missing 显式失败）——禁止调用方各写解析分支。

## 双人分工

- 朋友（手艺人）：选图 → 看钻 → 买多少钻。零配置知识可用。
- Owner（技术）：BYOK、prompt、k/seed、JSON。

## 硬规则

1. 「用户该去哪找/管一张图」只有一个答案：素材库。
2. 一个概念两个设置入口 = 结构性失败（策略选择教训：曾双真源已修——图层化后策略写入点 = 检查器层配置卡，全应用唯一）。
3. 专家工作台成果不回流排钻管线（图片级参考回流仅 P2）。
4. 三模块管线行为回归零破坏是所有新需求的护栏。
5. 项目文件遵循统一素材库手势：桌面单击选中、双击打开，移动端单击打开；对应页面是一页一格式的唯一消费者（gemproj→排钻设计 / gemdoc→专家工作台 / gemtpl→实验室选中 / gemgen→实验室定位展开）。图片节点同步遵循同一打开模型，重命名仅从选中态工具行/Enter 进入。
6. 编辑器不暴露排钻参数面板（概念混入禁令）。
7. 模板编辑的唯一编辑器 = TemplateEditor 组件，双宿主（实验室面板 / 素材库 RightSheet）共用，编辑态真源 converge 到库资产 .gemtpl（宿主不持副本）。
8. `.gemgen` 不可变（生成即定稿，重试产新档）。
9. 隐藏层仍参与计算/统计/导出（隐藏 ≠ 排除——状态条按「含 k 隐藏层」口径统计；只导出可见层须另设显式命令，不存在隐式裁剪）。
10. 多选批量写层 = 单个 layer.config op（触碰任一控件写入全部选中层，一次撤销恢复全部原值——批量不得拆为逐层多 op）。

## 契约豁免（显式登记）

- **AssetProject 的 blobKey 随保存换绑**（gemproj/gemdoc/gemtpl）：项目是活文档，保存 = 换绑新内容 blob + 旧 blob 引用计数 GC（单事务）；图片节点的不可变契约原样保留。gemgen 不豁免（不可变）。
