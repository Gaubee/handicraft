<!--
Orthogonal intents (max 3):
1. [2026-09-19 Delivery] 纵向 tracer bullet：先"快照→画钻→导出"最小闭环，再扩工具。
2. [2026-09-19 Safety] 编辑器不变量（烘焙隔离/patch 可逆/导出门）以 vitest 证明。
3. [2026-09-19 Process] 本清单为草稿——Codex 讨论定稿后修订再实施。
-->

## 1. 编辑文档与烘焙（P0 地基）

- [ ] 1.1 EditDoc 状态模块（runes）：快照深拷贝、四层显隐、selection；vitest：烘焙隔离（工作台参数变更后编辑文档零变化）
- [ ] 1.2 patch 命令栈（add/remove/update 三原子、stroke 合并、上限裁剪）；vitest：任意操作序列可完整回退
- [ ] 1.3 handoff' 交接：工作台「送手动编辑」→ 视图切换 → 快照载入（复用 view/handoff 模式）

## 2. 画布与渲染

- [ ] 2.1 编辑画布：四层合成渲染（参考/中间稿/分块只读/钻面）、缩放平移复用、LOD 两档
- [ ] 2.2 空间索引（grid-hash cell=pitch）：命中/邻域查询；vitest：与暴力法对账

## 3. P0 工具箱

- [ ] 3.1 画钻笔刷（snap 落子 + 拖拽连线补钻 + 冲突拒画）、擦除笔刷；vitest：笔刷产出的钻集过 validate
- [ ] 3.2 单选/框选 + 批量改色
- [ ] 3.3 选块策略填充：`layout([block], strategy)` 局部重排 + 撤销为一个 patch
- [ ] 3.4 冲突高亮 + 一键修复（resolveConflicts 出口）；修复后 isExportable 必须为真

## 4. 引擎三出口

- [ ] 4.1 `layoutAlongPath` / `resolveConflicts` / `blockFromMask` 进引擎公共面（与内部实现共用一份代码）；各配 vitest（不变量+与 layout 语义一致性）

## 5. 导出与收尾

- [ ] 5.1 编辑器 ExportBar（复用引擎导出；spacing 阻断延续）+ 实时 BOM 摘要
- [ ] 5.2 绿门：全量测试零回归、svelte-check 0/0、build；编排者浏览器走查（笔刷手感/撤销/导出）
