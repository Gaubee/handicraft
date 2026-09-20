# redesign-designer-workbench 立项评审 R1

评审对象：`2f56af2` 四件套（proposal/design/tasks/spec）

## 结论

**NO-GO（当前不可分发实现）**。

Owner 定调、七项裁决和“逐钻微调 + PS 贴近 + 竖排工具栏”均忠实落档；16 个 Requirement / 28 个 Scenario 也覆盖了主要交互面。问题不在方向，而在四件套仍有跨文件契约不能同时成立：schema v3 迁移被要求实现却把 persistence 冻结，隐藏层导出口径被要求改变却把 document service/export gate 冻结，旧四层“无损”坍缩缺少可逆字段定义，且 `EditGem.layerId` 与冻结 engine/转换面没有落点。修复这些 P0 后可重新评审；在此之前不应把任务 DAG 分发给实现者。

本结论只评文档可实现性与契约正确性，不因当前源码尚未实现新功能扣分。

## 阻塞 P0

### P0-1：v2→v3 的实现边界自相矛盾

- **证据**：proposal 要求 `gemdoc schema v2→v3 + 旧档迁移`（`proposal.md:41-44`）；tasks 1.1/1.2 要求迁移、保存即 v3、v2 fixture round-trip（`tasks.md:27-31`）。但 design §7.1 将 `persistence 全域`列为“冻结复用/零改动”（`design.md:358-364`），且 5.3 又写 `gemdocLifecycle` 零改动复用（`tasks.md:51-55`）。当前唯一序列化入口仍声明 `gemdoc: 2`（`rhinestone-studio/src/lib/persistence/projectFile.ts:55-65`），`GemdocFile` 仍是固定四层 `Record<EditLayerKey, LayerState>`（`:307-328`），解析也只读固定四层（`:799-812`）。
- **为何阻塞**：不修改 persistence/schema 入口就无法产生 v3、读取 v2 后保存 v3，或保证单向版本门；仅改 store/lifecycle 会绕过“唯一出口”并制造第二格式真源。
- **可验证修复**：在 design §7.1 明确 v3 migration owner（允许修改 `projectFile.ts`，或新增唯一 versioned adapter 并由其接管 persistence）；补 v2→v3 迁移表、未知/高版本行为、旧档 toast 和保存版本门。验收：v2 fixture 打开→内存 v3→保存 `formatVersion=3`→重开等价；v2 输入不被原样回写；`serialize→parse→serialize` 字节等价；`projectFile` 迁移/拒读测试通过。

### P0-2：隐藏层导出分叉与“冻结 export/service”不能同时成立

- **证据**：design/spec 明确设计师工作台隐藏层不参加 SVG/BOM/PNG 与明细统计，并在导出前显式提示（`design.md:259-262`、`spec.md:95-100`）；tasks 4.3 仍要求“导出门 `exportGate` 复用零改动”（`tasks.md:45-49`）。当前 `documentService` 的 SVG/BOM/PNG 都直接把全量 `doc.gems` 送入导出/renderer（`rhinestone-studio/src/lib/services/documentService.ts:222-256`），preflight gate 也只接全量 `doc.gems`（`:268-303`）；engine gate 的契约同样是调用方 concat 后的全层钻集，不含 visibility 维度（`rhinestone-studio/src/lib/engine/exportGate.ts:14-16,90-98`）。
- **为何阻塞**：仅跳过渲染不能满足 BOM/统计/PNG；仅 UI 提示也不能改变导出产物。若 service 不投影可见层，规格场景必失败；若 gate 接 visibility，又违反“engine/service 零改动”的护栏。
- **可验证修复**：明确“分叉 owner”是 service 层可见层投影，或允许 export API 增加带层元数据的输入；定义隐藏层计数、空可见层、锁定层与显式确认取消语义。验收：同一文档隐藏一层后 SVG/BOM/PNG 均不含该层，状态栏仍显示总量与隐藏数，取消确认不产物；可见层 spacing/missing-asset 仍走同一 gate；直接调用 export API 也不能绕过裁剪。

### P0-3：旧固定四层到 underlay 的“无损”映射未定义且当前模型无法承载

- **证据**：spec 宣称旧 `数字油画/参考原图/分块描线/钻面` 必须“无损映射”为 underlay 三源开关，并保存 round-trip 等价（`spec.md:109-117`）；design 的新 underlay 只有 `sources`、一个总 `visible` 和一个总 `opacity`（`design.md:218-236`、`:241-245`），迁移表也只写“坍缩为三源开关”（`:304-313`）。旧 gemdoc 当前每个四层都有独立 `visible/opacity`（`rhinestone-studio/src/lib/persistence/projectFile.ts:799-812`），而新钻层只定义 `visible/locked`，没有旧 `gems.opacity` 的承载位（`design.md:225-235`）。
- **为何阻塞**：旧档可表达“painting 30% + reference 80% + blocks 隐藏 + gems 50%”，目标模型没有逐源透明度或钻层透明度；“三源开关/总透明度”无法证明信息无损，round-trip 断言没有确定答案。
- **可验证修复**：二选一并写入规范：① underlay 增加每源可见性/透明度、钻层增加等价 opacity，给出逐字段映射；或 ② 将“无损”改为明确的有损迁移，列出优先级、折叠规则、用户提示与不变字段。验收至少覆盖四种旧层独立显隐/透明度组合，迁移后视觉/状态字段按表一致，保存 v3 再开不发生未声明漂移。

### P0-4：`gem.layerId` 的真源与冻结 engine/边界转换不闭合

- **证据**：design §4.1 把 `EditGem.layerId` 定为对象模型真源（`design.md:216-239`）；tasks 1.1 也要求新增该字段（`tasks.md:27-30`）。但 design §7.1 冻结整个 engine（`:358-364`），当前公共 `EditGem` 没有 `layerId`（`rhinestone-studio/src/lib/engine/types.ts:97-116`），`fromEditGem`/`toEditGem` 只转换现有字段（`rhinestone-studio/src/lib/engine/edit.ts:22-52`），当前 gemdoc 记录也没有该字段（`rhinestone-studio/src/lib/persistence/projectFile.ts:914-954`）。
- **为何阻塞**：若直接扩公共类型/转换器，违反 engine 零改动；若在 store 加私有交叉类型，冻结的转换与序列化面会丢失归属，无法实现合并、排序、旧档 round-trip 和导出过滤。
- **可验证修复**：明确 `DesignerGem` 扩展类型及其唯一投影边界，或解除 engine/edit/persistence 中必要的最小修改并列出 owner；规定 `layerId` 在 add/update/remove、复制、合并、迁移、序列化、导出投影中的生命周期。验收：跨层选择/复制/合并/撤销、排序不改 `gems[]` 顺序、v3 保存重开、导出过滤均逐条保留 `layerId`。

## 产品模型冲突裁断

- **隐藏层分模块口径：合理，但当前只能算“裁断已接受、契约未闭”**。排钻工作台的层是参数编排/生产并集，设计师工作台的层是内容组织；因此“设计师隐藏即不产出”与显式导出提示符合两种心智模型，也没有漂移 Owner 的逐钻定位。必须在 R0 以 PM v6 固化，并由一个明确的可见层投影 owner 实现，否则仍是 P0-2。
- **硬规则 6 修订：合理且无方向漂移**。“编辑器不以排钻参数为工作方式”保留了概念边界；将参数小窗限定在用户显式点击的“智能排布”命令，既支持算法工具化，又没有恢复选图自动排稿。R0 需同时写明：参数小窗不持久化为设计师工作台的主模型、不出现在常驻属性面板、无底图不可执行，并补一条命令直达测试。

## 非阻塞建议

- `design.md:117` 将“层排序”说成影响导出合成序，而现有 BOM 生成按规格/颜色聚合排序；应区分 SVG/PNG z 序与 BOM 行序，避免把“导出序”误读为 BOM 行序。
- P5 Alt 拖拽应明确副本 `origin`、`blockId`、`moved` 和跨层复制后的归属；当前仅规定 `m-` id（`design.md:105-108`），不足以约束导出/掩码语义。
- P7 连续改径只说“engine spec 域校验”（`design.md:107-108`），应给出最小/最大直径、非法输入回滚和一次 undo 组的判据。
- `tasks.md:8-13` 的域路径应写成实际 `rhinestone-studio/TERMS.md`、`rhinestone-studio/PRODUCT_MODEL.md`，并明确 `projectFile.ts` 是否属于冻结 persistence；当前 HEAD 仍为 TERMS v3、PRODUCT_MODEL v5（`rhinestone-studio/TERMS.md:3-5`、`rhinestone-studio/PRODUCT_MODEL.md:1-4`），R0 v4/v6 是待交付而非已闭合契约。
- 17 手势/右键树的 jsdom 纯函数面设计充分（`design.md:96-148,399-405`），但应在 9.2 之外增加至少一条真实浏览器验收，覆盖 pointer capture、原生 contextmenu、拖排和移动断点；jsdom 只能证明决策核，不能证明布局/事件接线。
- “不看旧实现”与“迁移纯函数/继承行为规格”同时出现（`design.md:75,337-367`）；建议改成“旧组件不复用，纯函数契约可迁移”，避免实现者误删测试地基。

## 8 项〔裁断〕表态

| 裁断 | 表态 | 依据/落档要求 |
|---|---|---|
| 多选不显示变换手柄 | **接受** | 降低离散规格缩放歧义；以对齐/分布/批量属性替代，已登记 P2（`design.md:130-132`）。 |
| `[ / ]` 让渡给旋转 | **接受** | 本产品无独立笔刷大小语义，规格选择器承载直径；键位表与 spec 一致（`design.md:175-183`、`spec.md:45-53`）。 |
| 双击钻为非模态属性定位 | **接受，需验收可发现性** | 常驻 Inspector 下语义连贯；应测试滚动定位/高亮而非打开第二 popover（`design.md:109`）。 |
| 空白新建缺省 200×200mm | **接受，必须标“缺省可改”** | 不与选图 default 锚混淆；状态栏改为 declared 的规则已写入（`design.md:266-283`、`spec.md:102-107`）。 |
| 笔刷 custom 形放宽为“必须 assetId” | **有条件接受** | 与 catalog 的 custom 身份契约一致；须在 R5 同时补 source/asset resolver、物化和 missing-asset 测试，不得只放宽 UI（`design.md:325-333`）。 |
| 吸管首版不纳入 | **接受，P2** | 色板/规格选择器足以覆盖首版，裁剪理由与 Owner 方向不冲突（`design.md:61-73`）。 |
| 智能排布不占工具栏、放顶部命令 | **接受** | 算法降为显式命令，保持工具模态不污染；需保留无底图禁用和结果落当前层（`design.md:71-75,285-297`）。 |
| Tab 折叠右侧面板而非 PS 全隐 | **接受** | 是针对本产品属性/图层双源的合理偏离；应把“折叠状态是否持久化/移动端映射”写入交互态契约（`design.md:185-202`）。 |

## 评分（0-10）

**5.8 / 10，NO-GO。**

| 维度 | 分数 | 依据 |
|---|---:|---|
| Owner 忠实性 | 9.0 | 原话、七裁决、竖排工具栏、空白起步和工具化排布均明确落档。 |
| 交互规格完整度 | 8.0 | 17 手势、7 组键位、右键两态树、jsdom 测试面覆盖充分。 |
| 图层模型清晰度 | 6.0 | `layerId`/blockIds 分叉解释正确，但公共类型/转换边界未闭合。 |
| 兼容与持久化契约 | 3.0 | v3 迁移与 persistence 冻结矛盾；旧四层无损映射缺字段规则。 |
| 导出/产品模型一致性 | 4.0 | 分模块裁断合理且已登记，但隐藏层过滤无法由冻结 service/gate 实现。 |
| DAG/验收可执行性 | 5.0 | 主 DAG 形状正确、并行上限 2 明确；P0 跨边界依赖未进入任务 owner/验收门。 |
| 文档可分发性 | 4.0 | `openspec validate --strict --changes redesign-designer-workbench` 本 change 通过，但上述 P0 使实现者无法按单一契约落码。 |

验证记录：`openspec validate --strict --changes redesign-designer-workbench` 对本 change 通过；同次全仓校验另有既存 `add-manual-edit-mode` 无 delta 失败，不归因于本 change。聚焦 `pnpm exec vitest run src/tests/docs/modelDocs.test.ts`：1 file / 9 tests 通过。`git diff --check 2f56af2^ 2f56af2` 通过。
