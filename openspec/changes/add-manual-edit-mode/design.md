<!--
Orthogonal intents (max 5):
1. [2026-09-19 Source] PM 研究稿（manual-edit-design.md）+ Codex 评审 R1（codex-review-r1.md，5.5/10）
   两轮对撞后的终版设计；关键修订均标注 [Codex-R1]。
2. [2026-09-19 State] 烘焙原则 + 显式交接类型：编辑文档 Gem[] 唯一真源，与工作台单向隔离。
3. [2026-09-19 Contract] 契约先行：EditDocument/ManualEditHandoff/钻位 origin/双 validate/色板删除
   语义在实现前冻结（Codex 阻塞问题 1-4 的闭环）。
-->

## Purpose

固化「手动编辑」模块的实现级架构。管线定位：

```text
实验室(AI 生成) → 工作台(参数化重算·真源=参数) → 手动编辑(直接操作·真源=Gem[]) → 导出
                    └── ManualEditHandoff 显式交接（单向烘焙快照）──┘
```

## 1. 数据与状态契约（Codex-R1 修订后冻结）

```ts
// 显式交接类型——不复用仅传图片的 handoff [Codex-R1 议题1]
interface ManualEditHandoff {
  gems: Gem[]; blocks: Block[]; palette: Palette; grid: GridSpec
  width: number; height: number        // 导出必需（exportSvg 需要）[Codex-R1 阻塞1/议题5]
  sourceSummary: string                // 来源策略/密度/SS 摘要（只读展示）
  paintingSnapshot: EngineImage        // 不可变快照 [Codex-R1 议题2 补1]
  referenceDataUrl?: string            // 参考原图（若有，不可变快照）
}

// 编辑文档（进入时深拷贝快照，此后与工作台零耦合）
interface EditDocument {
  gems: EditGem[]                      // 唯一真源（对象模型）
  blocks: Block[]                      // 只读参考（重分块回工作台）
  palette: EditPalette
  grid: GridSpec
  width: number; height: number
  layers: { painting; reference; blocks; gems: LayerState }  // 固定四层，显隐+透明度
  selection: Set<string>
}
// 钻位——独立类型，不做 extends Gem 的字段收窄（blockId 可空与 Gem.blockId: string 冲突，[Codex-R2 阻塞1]）
interface EditGem {
  id: string                            // 手工钻 = 'm-' 前缀编辑器自增（如 'm-42'）；来源钻沿用 layout 输出 id（二者命名空间不重叠）
  x: number; y: number
  colorId: string
  blockId: string | null                // 语义="来源块"引用，不代表几何归属；手工钻为 null
  origin: 'layout' | 'manual'           // 来源钻 vs 手工钻 [Codex-R1 议题3/阻塞3]
  moved: boolean                        // layout 钻被移动过即 moved=true
  ss: Gem['ss']; shape: Gem['shape']; material: Gem['material']
}
// 边界转换（纯函数，编辑器私有）：Gem → EditGem（进入快照时，origin='layout'/moved=false）
// EditGem → Gem（导出时：blockId 为 null 则以 '__manual' 占位——exportSvg/BOM 只消费 colorId/ss，
// blockId 占位不影响产物；导出前不跑归属校验）
```

**校验双层拆分——引擎新公共出口（签名冻结）** [Codex-R1 议题3 / R2 阻塞6]：

```ts
// 引擎新增（与既有 validate/isExportable 并存，工作台管线零影响）：
interface EditWarning { kind: 'spacing' | 'mask-hint'; detail: string; gemIds: string[] }
function validateEditable(gems: EditGem[], grid: GridSpec, blocks?: Block[]): EditWarning[]
function isExportableEditable(gems: EditGem[], grid: GridSpec): boolean  // = 无 spacing 违规
```

- 物理层（恒查，编辑器主门）：任意两钻中心距 ≥ pitch —— `spacing` 硬门，阻断导出
- 归属层（仅 origin='layout' 且 !moved 的钻，需传入 blocks）：钻心在来源块掩码内 —— `mask-hint` 提示级，不阻断（手工移动/新增钻天然脱离掩码约束）

**色板删除语义** [Codex-R1 阻塞2]：被引用的色板色**禁删**（badge 显示引用数），引导先批量改色；孤儿色（无钻引用）可直接删。不做"删除后降级导出"。

**撤销栈规格** [Codex-R1 阻塞4]：patch 三原子（add/remove/update）；一个 pointerdown→up 的 stroke 合并为一个 undo 组（含选块填充/一键修复这类命令操作各成一组）；预算 = 100 undo 组，超限裁最旧，redo 栈在新操作时清空；单 stroke 产出 >2000 钻时拒绝执行并 toast 提示（防巨型 patch）。

**烘焙后工作台参数变更不回流**（原烘焙原则不变）；再次「送精修」= 覆盖确认（编辑中且有未导出修改时弹确认）。

## 2. 渲染与性能基线 [Codex-R1 阻塞5]

canvas 四层合成（缩放平移复用工作台经验）。**性能门槛任务化**：先建只读画布基准（1k/10k/20k 钻 × 缩放/平移/命中，60fps 目标），不过线则实现脏区分块渲染（空间索引复用）后再接笔刷——不把性能当假设。

## 3. P0 工具箱与交互

| 工具 | 行为 | 语义要点 |
|---|---|---|
| 画钻笔刷 | snap 六方格位落钻；拖拽连线等弧长补钻 | 新钻 origin='manual'、blockId=null；落点冲突拒画 |
| 擦除笔刷 | 命中删除 | 过 selection/整图层无差别 |
| 单选/框选+批量改色 | selection → 换色板色 | update patch |
| 选块策略填充 | `layout([block], strategy, density)` 局部重排 | **只替换该块内 origin='layout' 且 !moved 的来源钻**；手工钻与 moved 钻保留，与新钻冲突时手工侧优先让位规则反转（新钻让位）[Codex-R1 阻塞3] |
| 撤销/重做 | patch 栈 | 见 §1 规格 |
| 一键修复 | resolveConflicts 引擎出口 | **显式、可撤销、可解释**（列出将删除的钻及原因），绝不默认静默丢钻 [Codex-R1 议题5] |
| 导出 | exportSvg/exportBom | EditDocument 持有 width/height/palette；spacing 违规阻断（island 仍提示放行） |

左工具栏 + 顶部参数条 + 右侧图层/计数面板（实时钻数与 BOM 摘要）。颜色过滤仅是渲染/编辑过滤，不改变归属与导出语义 [Codex-R1 议题2 补2]。

## 4. 引擎出口（Codex-R1 重排：按需进公共面）

| 出口 | 时机 | 契约 |
|---|---|---|
| `resolveConflicts` + `validateEditable`/`isExportableEditable` | **P0** | 签名冻结（[Codex-R2 阻塞2/6]）：<br>`resolveConflicts<T extends Gem & { origin?: 'manual'\|'layout'; moved?: boolean }>(gems: T[], grid): { gems: T[]; removed: Array<{ gem: T; reason: string }> }`<br>保留优先级：**origin manual > moved layout > unmoved layout > 稳定输入序**；layout 管线传入无优先级字段的纯 Gem[] 时退化为现行为——与内部消解共用同一实现，零语义漂移 |
| `blockFromMask(mask, …)` | P1（套索/魔棒定案时冻结字段合成规则） | Block 必填字段（label/bbox/areaPx/widthPx/suggested）的合成规则届时定义 |
| `layoutAlongPath(points, …)` | P1+（路径工具前） | 先冻结 Pt/颜色/来源区域/越界/既有钻冲突语义 |

全部从 engine/index.ts 导出；每出口配 vitest（不变量 + 与 layout 语义一致性）。

## 5. 五议题终裁记录（Codex-R1 对撞结果）

1. 入口=第三 Tab + **显式 ManualEditHandoff**（有条件同意→补显式类型，已入 §1）
2. 图层=固定四层+颜色过滤（同意；补不可变快照与"过滤仅渲染"两条限定）
3. 钻位=对象模型（同意；blockId 改"来源块"+可空，validate 拆双层）
4. 三出口=按需渐进（反对现稿一次性冻结→采纳：P0 仅 resolveConflicts）
5. 导出门=spacing 硬门阻断 + 一键修复显式可撤销（同意硬门；否决默认丢钻语义；P0 不设强制导出逃生舱）

## 6. 技术约束

Svelte 5 runes + 原生 canvas；引擎仍是纯 TS 深模块；TS strict；零新增依赖。
