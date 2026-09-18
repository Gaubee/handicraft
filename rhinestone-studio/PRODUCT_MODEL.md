# 贴钻工作台 · 产品模型（Product Model）

> 版本：v2（2026-09-19，随「素材库」设计引入资产层；v1 见 `.agents/documents/2026-09-18-rhinestone-ia/ia-design.md` §0）
> 地位：**所有界面/功能改动的第一约束**。任何需求动手前先回答「如何进入本模型」；与本文冲突的设计一律 REJECT。

## 一句话

四模块工作台 + 一个资产层：实验室产出「数字油画中间稿」，工作台把中间稿调成「可生产钻位方案」，手动编辑做「钻级精修」，素材库是全部图片资产的唯一真源。

## 对象关系树（Object Modeling）

```
素材库（AssetNode 虚拟文件系统，IndexedDB）
 │   · 案例（系统只读） · 生成结果（按批次） · 上传 · 精修导出 · 回收站
 ├──▶ 实验室 · 参考原图      = 引用资产（assetId）
 ├──▶ 实验室 · 变体效果参考   = preset(案例) | url | 引用资产（assetId）
 ├──▶ 实验室 · 生成任务结果   = 自动入库（source='lab-generate'，任务 meta 只存 assetId）
 ├──▶ 工作台 · 数字油画来源   = 引用资产（handoff 传 assetId 或选图器直选）
 ├──▶ 工作台 · 叠放参考原图   = 引用资产
 └──▶ 手动编辑 · 导出 PNG     = 入库（source='edit-export'）

实验室（真源=提示词/变体） ──handoff(assetId)──▶ 工作台（真源=参数：块覆写/物理/色板）
                                                   │
                                                   └─ManualEditHandoff(烘焙快照)──▶ 手动编辑（真源=EditDocument.gems）
                                                                                        └─▶ SVG / BOM / PNG 导出
```

## 单一真源表（One Concept → One Canonical Location）

| 概念 | 唯一真源 | 快捷入口（converge 到真源） |
|---|---|---|
| 图片资产 | 素材库（AssetNode + blob） | 各模块选图器 Dialog；上传即入库 |
| BYOK 连接 | SettingsDialog（localStorage） | 顶栏状态芯片 |
| 提示词变体 | 实验室 VariantEditor（localStorage） | 任务卡「复用参数」 |
| 生成历史（任务流） | 实验室画廊（localStorage 任务 meta） | —（≠资产；删任务不删资产） |
| 排钻策略选择 | 工作台胶片带/对比模式选中项（activeStrategy） | 导出条只读回显 |
| 块覆写/物理参数 | studio store | 检查器 |
| 色板 | studio store（工作台会话） | 检查器折叠组 |
| 钻面文档 | 手动编辑 EditDocument.gems（烘焙快照） | —（不回流工作台） |

## 交接语义（handoff contract）

- **派生数据 → 烘焙**：工作台→手动编辑的钻位/分块/像素快照，深拷贝收下，参数不回流。
- **不可变资产 → 引用**：图片资产内容永不修改（只有元数据移动/改名），跨模块一律传 `assetId`，消费时取 blob。引用不破坏烘焙语义。

## 双人分工

- 朋友（手艺人）：选图 → 看钻 → 买多少钻。零配置知识可用。
- Owner（技术）：BYOK、prompt、k/seed、JSON。

## 硬规则

1. 「用户该去哪找/管一张图」只有一个答案：素材库。
2. 一个概念两个设置入口 = 结构性失败（策略选择教训：曾双真源已修）。
3. 手动编辑成果不回流工作台管线（图片级参考回流仅 P2）。
4. 三模块管线行为回归零破坏是所有新需求的护栏。
