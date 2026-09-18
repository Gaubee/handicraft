<!--
Orthogonal intents (max 3):
1. [2026-09-19 Delivery] 依 Codex-R1 八步重排：契约冻结 → 引擎最小闭环 → 快照载入 → 性能基线 →
   笔刷闭环（第一个可验收 tracer bullet）→ 选块填充 → 导出门 → P1 扩展。
2. [2026-09-19 Safety] 契约/不变量（烘焙隔离、origin 区分、双 validate、撤销预算、性能门槛）
   先于功能落地，全部 vitest 证明。
3. [2026-09-19 Process] 本清单已吸收 Codex-R1 评审；R2 确认后开工。
-->

## 1. 契约冻结（Codex-R1：先于一切实现）

- [ ] 1.1 类型冻结：ManualEditHandoff / EditDocument / EditGem（origin/moved/blockId 语义/`m-` ID 策略）；vitest：类型级契约测试 + ID 与 layout 重编号隔离
- [ ] 1.2 校验双层拆分：spacing 恒查（物理门）；mask 归属检查仅 origin='layout' 且 !moved、编辑器内降级提示；vitest：手工钻/移动钻的 mask 豁免、spacing 违规恒报
- [ ] 1.3 色板删除语义：被引用色禁删（引用数 badge）、孤儿色可删；vitest
- [ ] 1.4 撤销栈规格：三原子 patch、stroke 合并、100 组预算裁旧、redo 清空、>2000 钻 stroke 拒绝；vitest：任意序列完整回退、预算裁剪行为

## 2. 引擎最小闭环（P0 仅一出口）

- [ ] 2.1 `resolveConflicts(gems, grid)` 进引擎公共面：返回 removed 明细（gem+reason），保留优先级 **manual > moved layout > unmoved layout > 稳定输入序**（design.md §4）；与 layout 内部消解共用实现；vitest：与 layout 输出语义一致性 + removed 报告正确性。（前置：EditGem/EditWarning/ConflictMeta 类型与 toEditGem/fromEditGem 已落 types.ts/edit.ts）
- [ ] 2.2 空间索引（编辑器私有 grid-hash cell=pitch）：命中/邻域；vitest 与暴力法对账

## 3. 第三 Tab + 快照载入（生命周期完整）

- [ ] 3.1 view 增 'edit'；工作台「送精修」→ ManualEditHandoff（gems/blocks/palette/grid/width/height/snapshot/sourceSummary）→ 深拷贝入 EditDocument
- [ ] 3.2 生命周期：再次送精修覆盖确认（有未导出修改时）、工作台参数变更不回流（vitest 烘焙隔离）、刷新/无 handoff 进入的空态

## 4. 只读画布 + 性能基线（性能不当假设）

- [ ] 4.1 四层合成渲染（painting/reference/blocks 只读/gems）+ 缩放平移 + 点选命中
- [ ] 4.2 基准：1k/10k/20k 钻渲染/平移/命中测速（60fps 目标）；不过线先做脏区分块渲染再进 §5

## 5. 笔刷编辑闭环（第一个可验收 tracer bullet）

- [ ] 5.1 画钻笔刷（snap+连线补钻+冲突拒画，新钻 origin='manual'）、擦除；vitest：产出钻集过 spacing 校验
- [ ] 5.2 单选/框选 + 批量改色（update patch）
- [ ] 5.3 撤销/重做接通（stroke 组粒度）
- [ ] 5.4 闭环验收：快照 → 笔刷编辑 → undo/redo → validateEditable → exportSvg/exportBom（EditDocument 持 width/height/palette；isExportableEditable 仅 spacing 阻断）

## 6. 选块策略填充（保手工钻）

- [ ] 6.1 `layout([block], strategy, density)` 局部重排：只替换 origin='layout' 且 !moved 的来源钻；手工钻/moved 钻保留，冲突时新钻让位；整个操作=一个 undo 组；vitest：手工钻存活断言

## 7. 导出门 + 显式一键修复

- [ ] 7.1 编辑器导出栏：spacing 阻断（island 提示放行）+ 实时 BOM 摘要
- [ ] 7.2 一键修复：先预览将删除的钻（列表+原因）→ 确认执行（resolveConflicts）→ 作为一个 undo 组可撤销

## 8. P1 扩展（另批任务，此处仅登记）

- [ ] blockFromMask（字段合成规则届时冻结）/ layoutAlongPath / 套索/魔棒选区 / 密度笔刷 / 沿路径工具 / 颜色分组过滤视图增强
