# R5 评审：studio-layers 立项与已实现 change 抽查

- 评审日期：2026-09-20
- 评审 HEAD：`0fadca3`（`studio-layers` 文档提交为 `f71f459`）
- 评审范围：题① `openspec/changes/studio-layers/`；题② `add-gem-catalog-and-sizes`、`rename-and-expert-workbench`、`add-lab-drill-params-and-blueprint` 的已提交实现。
- 工作树说明：当前工作树除本报告外干净；`0fadca3` 已包含 4.2 目录/AssetPicker 接线。题②评分以已提交 HEAD 为主体，按用户边界不把 4.x 接线本身计入 0.x/A/B/C 评分。
- 边界：未跑全量 `pnpm test`；执行了四个 change 的 `openspec validate --strict` 与聚焦 Vitest。

## 题①：studio-layers 立项评审

### 结论

**GO，8.1/10。判定：replay/handoff gate（③段）和 studio gate（④段）可以开工。** 这是“契约和依赖足以开工”的 GO，不是功能已实现或 gate 已闭合的声明。

本稿已把 R1/R2 的 P0 责任切回可执行 DAG：五段门序和硬依赖在 `design.md:14-24,37-54`，`tasks.md:3-17`；W0/engine 是上游前置，1.1 oracle harness 是 1.x 共同前置，1.5 才能做 v2 replay，2.9/3.3 才能宣称本 change 收口。四件套的 strict OpenSpec 校验通过。

### 阻塞 P0

**无新增 P0。** 关键闭合点如下：

- R1 P0-3：`design.md:73-79`、`tasks.md:35` 明确旧 `runLayouts` 固定 fixture oracle、逐位主断言及缓存/进度/取消/reject identity/run 作废/错误隔离/旧结果保留六项矩阵，并写死“证明前不切计算实现”。
- R1 P0-4：`design.md:108-120`、`tasks.md:39` 明确 segment → rest/显式层 → per-layer 派生 → `computeLayer` → 全层 concat/exportGate → handoff 六步链，v1 fixture 逐位等价和 `deriveLegacyGemprojView` 删除均有验收位置；`projectFile.ts` 与 gem-catalog 2.3 的同文件串行规则也落在 `design.md:50`。
- R1 P0-6：`design.md:142-149` 明确 `fold(base, ops) → {state, diagnostics}`、stale 不吞改、100 组压实边界/state hash、历史不序列化及属性测试；`tasks.md:47` 依赖关系完整。
- R1 P0-7：`tasks.md:52`/`design.md:204-207` 将消费矩阵逐行三元组 receipt、死 API grep、端到端走查和全量收尾落为 2.9，而非把设计表当作实现证据。

### 非阻塞建议

1. `computeLayer` 的语义已冻结，但 `design.md:75` 又写“字面签名以实现为准”。1.1 首提交应把导出函数参数/返回类型、`ComputeAbortedError` 和 run token 固定成可 grep 的公共契约，避免“语义冻结、类型漂移”。
2. `design.md:168-170` 与 spec 对背景层/普通隐藏层边界已能读通：背景层不排布、不统计、不导出；普通隐藏层仍计算、统计、导出。实现时应以类型判据和一组反例测试锁死，防止把普通 `visible=false` 错当背景层。
3. 两项工作默认已入档（`design.md:56-59`）：观察态纯会话态、混合配置以最早选中层预填并批量单 op。两项均明确推翻成本，开工前不再需要重新发明数据模型，但应在 2.4/2.5 验收中逐条 receipt 化。

### 八项自由裁断表

| 裁断 | 表态 | 依据 |
|---|---|---|
| `computeLayer` 不新增 worker 协议 | 通过 | `design.md:75`、`tasks.md:35` 复用 `runCompute` 单请求形状，worker 只作实现细节。 |
| `specKey` resolver 可注入，保持 replay/lib 纯度 | 通过 | `design.md:81-86` 明确 builtin bootstrap、custom 注入目录、四态 missing，禁止 replay 直接 import assetStore。 |
| 层对分组在 studio 聚合，不改 engine helper 签名 | 通过 | `design.md:88-94` 先全层 concat 过 `exportGate`，再按 gem→层归属分组。 |
| P0 单 worker 逐层串行，GPU 仅 P1 预留 | 通过 | `design.md:151-155,199-202`；CPU 是确定性 oracle，未把 GPU 能力偷塞进 W0/P0。 |
| dirty 采用保守口径 | 通过 | `design.md:144,147,197`：一切 `StudioOp` 置 dirty，undo 不清，保存才清，导出不清。 |
| 层规格 P0 取 `GemCatalogService` 全目录，不建第二真源 | 通过 | `design.md:51,181`；层配置存 `specKey`，输出物化快照，消费面只依赖目录接口。 |
| 普通隐藏层仍参与计算/统计/导出，背景层单独排除 | 通过 | `design.md:165-170`、spec `:41-51,65-75`，命名语义和反例场景均已写入。 |
| 观察态纯会话态 + 最早选中层为混合配置锚点 | 通过 | `design.md:56-59,157-170`、spec `:29-51`；批量写入是单 `layer.config` op。 |

## 题②：已实现 change 实现质量抽查

### `add-gem-catalog-and-sizes`

**8.2/10；实现质量结论：有条件通过，未见 P0。** W0/engine/2.x 的关键声明均能在源码和测试中找到对应面：`GemSpecSnapshot`/`PhysicalCanvas`/rotation 语义在 `engine/spec.ts:139-168,216-240`；唯一三参几何判据和 `exportGate` 在 engine；`engineGolden.test.ts` 固化 v1 位级黄金，`versionGuard.test.ts` 覆盖 `ENGINE_VERSION=2` 和单规格护栏，`physicalAnchor.test.ts` 覆盖 `PIXELS_PER_MM` 单源，`mixedPairwise.test.ts`/`engineAcceptance.test.ts` 覆盖 mixed-size、旋转、跨 cell 边界及导出硬阻断。SS24 位于 `types.ts:17-31`，目录 seed 与 bootstrap 同源于 `catalog.ts:174-210`，避免把 SS24 当成另一身份。

**P1-1：默认导出 service 没有真实 custom asset resolver。** `exportGate` 的 missing-asset 面只有在 `exportGate.ts:161-177` 收到 resolver 时才执行；`documentService.ts:105-109,268-272` 将 resolver 设为可选，默认实例 `:285-295` 没有注入。因此默认 SVG/BOM/PNG 入口可对 custom 缺失资产放行。修复验收：默认 service 从资产库批量解析并传入 resolver；若运行时尚未接线，则以 typed unavailable/blocked 失败，不能静默 exported。此项是跨 change 接线残余，不阻塞已经完成的纯函数 engine gate。

**P1-2：`GemSchema`/`EditGemSchema` 未反向强制 custom 必带 `assetId`。** `GemSpecSnapshotSchema` 已在 `spec.ts:153-159` 强制该条件，但 `GemSchema`/`EditGemSchema` 的 `superRefine`（`:176-214`）只拒绝“非 custom 带 assetId”。`exportGate.ts:164-166` 也因此可能跳过无 assetId 的 custom。修复验收：公共 schema、`effectiveSpecOf`、brush 入口和 export gate 对 custom 无资产统一返回 typed invalid，并补负向测试。

**非阻塞/通过面：** `.gemshape` texture 必备、vector-only 拒收、seed create-only 与四态引用解析已有 parser/seed 测试；`specCatalog.test.ts:158-180` 覆盖 texture-only/both 矩阵和拒收路径。字节等价与常量单源有双保险，但默认 resolver 接线仍需在 replay/studio gate receipt 中补齐。

### `rename-and-expert-workbench`

**8.0/10；实现质量结论：有条件通过，未见 P0。** 属性面白名单在 `components/Edit/properties.ts:95-130`，custom 不进入内置 select；`components/Edit/brushEngine.ts:53-65,90-119` 从 brush state 源头物化 `shapeId/diameterMm/colorId`，并用与 `validateEditable/exportGate` 同一判据做逐点 pairwise 拒画；document service 的 SVG/BOM/PNG 统一先过 preflight（`services/documentService.ts:215-237,257-282`），保存仍允许 warning。A 轨 wrapper/payload 零复制断言和聚焦测试通过，ESM re-export 环目前只有结构性观察风险，未发现已证运行时故障。

**P1-1：`BrushSpecState` 的类型面允许 custom，却不携带 `assetId`。** `components/Edit/workbench.svelte.ts:23-28` 使用完整 `ShapeId`，而 `brushEngine.ts:53-65` 直接把它写入 `EditGem`；属性面当前又明确把 custom 排除在 UI 之外（`properties.ts:95-100`）。一旦未来规格选择器把 custom 传入 `setBrushSpec`，就会产生无资产引用的 custom 手工钻。修复验收：要么把 brush state 限为内置形，要么增加并贯通 `assetId`，并补 custom 缺资产拒绝测试；该项与 gem-catalog P1-2 必须使用同一契约。

**P1-2：验收 marker 与 service 真源切换点漂移。** `services.acceptance.test.ts:56-62` 仍要求源码标记 `5.6`，而 `gemCatalogService.ts:7-14` 已把真源切换登记改成 `[add-lab 4.2]`。本轮 HEAD 聚焦结果为 expert 侧 7 files passed、85/86 tests，唯一失败就是此静态 marker；功能实现和目录库测试并未失败。修复验收：更新验收 marker 或保留兼容标记，并让聚焦套件全绿。

### `add-lab-drill-params-and-blueprint`

**7.8/10；实现质量结论：有条件通过，未见 P0。** `prompt.ts:300-323` 实现自定义素材去重、四张软上限和 warning；`:425-460` 保证串行/并行蓝图骨架差异、无清单不产编号图例，主图不消费蓝图提示词。`stages.ts:403-420` 是 terminal-only 账本，`:458-501` 覆盖刷新中断合成与新 requestId 重试，`:652-676` 覆盖 main 成功先单图、blueprint 终态再双图两档并存；相应 `stages.persist/contract`、prompt 测试均有断言。

**P1-1：持久化任务快照的 custom spec 校验弱于 W0 canonical schema。** `stages.ts:544-560` 的 `normalizeGemSpecSnapshot` 检查 `shapeId/diameterMm/specKey`，但没有在 `shapeId === 'custom'` 时要求 `assetId`；`:567-590` 因此可能恢复一个无法解析素材的 custom 规格。修复验收：复用或镜像 W0 的 custom asset 反向约束，加入脏账本拒读测试，并让 prompt/export 消费面共享同一 typed error。

**非阻塞建议：** `normalizeLabTaskDrillParams` 的 `materialAssetIds` 目前只过滤字符串（`stages.ts:587-590`），没有去重/上限；提示词层已经在 `prompt.ts:313-323` 去重并截断，因此不会直接突破请求上限，但持久化快照和实际附图计划可能不完全一致，建议统一归一口径。

**范围说明：** `0fadca3` 已包含 4.2 真源目录/AssetPicker 接线，且本轮 `templateAdvancedOptions` 12 例通过；按用户要求，4.x 接线不计入本题 0.x/A/B/C 实现评分，也不把这组通过扩大解释为生命周期全链路已收口。

### 聚焦验证收据

- `openspec validate studio-layers --strict`
- `openspec validate add-gem-catalog-and-sizes --strict`
- `openspec validate rename-and-expert-workbench --strict`
- `openspec validate add-lab-drill-params-and-blueprint --strict`
- Engine：10 files / 78 tests passed。
- Expert：7 files passed，85/86 passed；唯一失败为 HEAD 上的静态 `5.6` marker 漂移。
- Lab：12 files / 135 tests passed（含 4.2 `templateAdvancedOptions`，但 4.x 不纳入评分）。
- 合并的 expert+lab 聚焦集：20 files，19 passed，220/221 passed；单一失败仍是上述 marker。
- 未执行全量 `pnpm test`、`check` 或 `build`，因此不对终版全量绿门作声明。
