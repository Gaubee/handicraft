# 贴钻工作台 · 产品模型（Product Model）

> 版本：v3（2026-09-19，随「add-project-files」四格式家族裁决引入项目文件层；v2 随素材库引入资产层，见 git 历史；v1 见 `.agents/documents/2026-09-18-rhinestone-ia/ia-design.md` §0）
> 地位：**所有界面/功能改动的第一约束**。任何需求动手前先回答「如何进入本模型」；与本文冲突的设计一律 REJECT。

## 一句话

四模块工作台 + 一个资产层：实验室产出「贴钻候选效果图」，排钻设计把效果图调成「可生产钻位方案」，手动编辑做「钻级精修」，素材库是**全部资产（图片 + 项目文件）的唯一真源**。

## 对象关系树（Object Modeling）

```
素材库（AssetNode 虚拟文件系统，IndexedDB）
 │   · 案例（系统只读） · 模板 · 生成结果（按批次） · 项目 · 上传 · 精修导出 · 回收站
 ├──▶ 实验室 · 案例参照图    = 引用资产（assetId + caseLayout；canvas 合成图物化入库，preset 幂等 seed）
 ├──▶ 实验室 · 模板（.gemtpl）= AssetProject 节点（真源；页面内编辑、字段提交换绑写回）
 ├──▶ 实验室 · 生成结果（.gemgen）= 自动入库（不可变档案：内嵌图 + 溯源；source='lab-generate'）
 ├──▶ 排钻设计 · 数字油画来源 = 引用资产（handoff 传 assetId 或选图器直选；gemgen 经单点解析）
 ├──▶ 排钻设计 · 项目（.gemproj）= AssetProject 节点（参数工程：来源+参数，钻位=引擎重放）
 ├──▶ 排钻设计 · 叠放参考原图 = 引用资产
 ├──▶ 手动编辑 · 项目（.gemdoc）= AssetProject 节点（烘焙文档：gems + 内嵌底图）
 └──▶ 手动编辑 · 导出 PNG     = 入库（source='edit-export'）

实验室（真源=库模板 .gemtpl） ──handoff(assetId)──▶ 排钻设计（真源=参数：块覆写/物理/色板，存 .gemproj）
                                                       │
                                                       ├─导出 .gemdoc / 送精修（ManualEditHandoff 烘焙快照）──▶ 手动编辑（真源=EditDocument.gems，存 .gemdoc）
                                                       └─▶ SVG / BOM / PNG 导出
```

## 单一真源表（One Concept → One Canonical Location）

| 概念 | 唯一真源 | 快捷入口（converge 到真源） |
|---|---|---|
| 图片资产 | 素材库（AssetNode + blob） | 各模块选图器 Dialog；上传即入库 |
| BYOK 连接 | SettingsDialog（localStorage） | 顶栏状态芯片 |
| 提示词模板 | 素材库（AssetProject, gemtpl） | 实验室左面板；素材库 RightSheet（同一 TemplateEditor 双宿主） |
| 生成历史（任务流 ∪ 档案） | 实验室画廊（会话任务 ∪ 库内 gemgen） | 素材库双击 gemgen 定位；删任务记录不删档案 |
| 排钻项目文件 | 素材库（AssetProject, gemproj） | 排钻设计页打开/最近列表 |
| 精修项目文件 | 素材库（AssetProject, gemdoc） | 手动编辑页打开/最近列表 |
| 快速排稿参数 | 固定默认（不可调——调参去排钻设计） | 编辑页空态选图直入 |
| 排钻策略选择 | 排钻设计胶片带/对比模式选中项 | 导出条只读回显 |
| 块覆写/物理参数 | studio store（→ 持久化进 .gemproj） | 检查器 |
| 色板 | studio store（→ 持久化进 .gemproj） | 检查器折叠组 |
| 钻面文档 | 手动编辑 EditDocument.gems（→ 持久化进 .gemdoc） | —（不回流排钻管线） |

## 交接语义（handoff contract）

- **派生数据 → 烘焙**：排钻设计→手动编辑的钻位/分块/像素快照，深拷贝收下，参数不回流。
- **不可变资产 → 引用**：图片资产内容永不修改（只有元数据移动/改名），跨模块一律传 `assetId`，消费时取 blob。引用不破坏烘焙语义。
- **项目文件 = 交接语义的文件化**：gemproj = 参数工程可重放；gemdoc = 烘焙快照自包含；gemtpl = 配置资产可编辑；gemgen = 不可变档案（生成即定稿）。
- **模板 → 任务 → 档案是「配置 → 快照 → 档案」降熵链**：模板可编辑（换绑）、任务快照可重试、档案不可变；composedPrompt 全文只存在于档案。
- **图像消费单点**：跨模块取图像字节只经 `getHandoffImageBlob(assetId)`（图片资产直取 / gemgen 解析内嵌图；missing 显式失败）——禁止调用方各写解析分支。

## 双人分工

- 朋友（手艺人）：选图 → 看钻 → 买多少钻。零配置知识可用。
- Owner（技术）：BYOK、prompt、k/seed、JSON。

## 硬规则

1. 「用户该去哪找/管一张图」只有一个答案：素材库。
2. 一个概念两个设置入口 = 结构性失败（策略选择教训：曾双真源已修）。
3. 手动编辑成果不回流排钻管线（图片级参考回流仅 P2）。
4. 三模块管线行为回归零破坏是所有新需求的护栏。
5. 项目文件遵循统一素材库手势：桌面单击选中、双击打开，移动端单击打开；对应页面是一页一格式的唯一消费者（gemproj→排钻设计 / gemdoc→手动编辑 / gemtpl→实验室选中 / gemgen→实验室定位展开）。图片节点同步遵循同一打开模型，重命名仅从选中态工具行/Enter 进入。
6. 编辑器不暴露排钻参数面板（概念混入禁令）。
7. 模板编辑的唯一编辑器 = TemplateEditor 组件，双宿主（实验室面板 / 素材库 RightSheet）共用，编辑态真源 converge 到库资产 .gemtpl（宿主不持副本）。
8. `.gemgen` 不可变（生成即定稿，重试产新档）。

## 契约豁免（显式登记）

- **AssetProject 的 blobKey 随保存换绑**（gemproj/gemdoc/gemtpl）：项目是活文档，保存 = 换绑新内容 blob + 旧 blob 引用计数 GC（单事务）；图片节点的不可变契约原样保留。gemgen 不豁免（不可变）。
