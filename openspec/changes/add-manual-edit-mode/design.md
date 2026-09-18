<!--
Orthogonal intents (max 5):
1. [2026-09-19 Source] 设计内化自 .agents/documents/2026-09-19-manual-edit-design/manual-edit-design.md（PM 研究稿）；
   本文件只固化实现级决策，调研证据与线框见研究稿。
2. [2026-09-19 State] 烘焙原则：编辑文档 Gem[] 唯一真源，与工作台参数单向隔离。
3. [2026-09-19 Review] §5 议题为 Codex 讨论点——当前裁决为 PM 立场，允许被推翻并回写本文件。
-->

## Purpose

固化「手动编辑」模块的实现级架构决策。管线定位：

```text
实验室(AI 生成) → 工作台(参数化重算·真源=参数) → 手动编辑(直接操作·真源=Gem[]) → 导出
                                              └── handoff' 快照交接（单向烘焙）──┘
```

## 1. 数据与状态模型

```ts
// 编辑文档（进入时 deepCopy 工作台快照，此后与工作台零耦合）
interface EditDoc {
  gems: Gem[]                 // 唯一真源（对象模型，非栅格）
  blocks: Block[]             // 只读参考（分块层；重分块回工作台）
  palette: Palette
  grid: GridSpec
  layers: { reference: LayerState; painting: LayerState; blocks: LayerState; gems: LayerState } // 显隐+透明度
  selection: Set<string>      // gem id
}
// 撤销：patch 三原子命令栈（add/remove/update），笔刷 stroke 结束时合并提交；禁全量快照（万钻×百步内存不可控）
// 空间索引：编辑器私有 grid-hash（cell=pitch），支撑笔刷命中/碰撞高亮/渲染剔除
```

## 2. 渲染

canvas 主画布（复用工作台 BlockCanvas 的缩放平移/六方绘制经验）；钻面层按 zoom 做 LOD（远距离聚合色块、近距离逐钻）；分块层只读描线。

## 3. P0 工具箱与交互

| 工具 | 行为 | 引擎依赖 |
|---|---|---|
| 画钻笔刷 | 点击=snap 到六方格位落 1 颗（当前色板色）；拖拽=连线等弧长补钻；落点冲突高亮拒画 | 网格几何（编辑器私有） |
| 擦除笔刷 | 命中钻删除 | 空间索引 |
| 单选/框选 + 改色 | 点选/拖框 → selection → 批量换色板色 | — |
| 选块策略填充 | 点选分块 → 选策略 → `layout([block], strategy, density)` 局部重排该块（替换该块旧钻） | layout 复用 |
| 撤销/重做 | patch 栈，stroke 合并 | — |
| 冲突修复 | validate 高亮 → `resolveConflicts` 一键修复 | resolveConflicts 新出口 |
| 导出 | 复用 exportSvg/exportBom（isExportable 阻断语义延续） | 复用 |

左工具栏 + 顶部参数条（笔刷尺寸=连线间距/当前色/当前策略）+ 右侧图层与计数面板（实时钻数与 BOM 摘要）。

## 4. 引擎 API 新出口（进引擎公共面，编辑器不抄实现）

1. `layoutAlongPath(points: Pt[], opts, grid): Gem[]` —— polyline 等弧长采样排钻（沿路径工具的 P1 核心；不借道 skeleton）
2. `resolveConflicts(gems, grid): { gems; dropped }` —— 暴露 layout 内部 `enforceMinDistanceCounted`，与 layout **共用同一实现**防语义漂移
3. `blockFromMask(mask, attrs): Block` —— 任意选区（套索/魔棒 P1）合成 Block 走同一条策略填充管线

## 5. 待 Codex 裁决的议题（当前=PM 立场）

1. 入口形态：第三 Tab + handoff'（当前立场）vs 工作台内子模式
2. 图层粒度：固定四层+颜色过滤（当前）vs 物理多钻面层
3. 钻位对象+空间索引（当前）vs 栅格
4. 引擎三出口：进公共面共用实现（当前）vs 编辑器私有
5. 导出门：spacing 阻断+一键修复（当前）vs 高亮放行；是否加"强制导出"逃生舱

## 6. 技术约束

Svelte 5 runes + 原生 canvas；引擎仍是纯 TS 深模块（三出口走 types.ts 正常演进）；TS strict；零新增依赖。
