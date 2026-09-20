<!--
Orthogonal intents (max 5):
1. [2026-09-20 Owner] 五点原话 + 继承开关修订（proposal 落档）：二级图层树/PS 历史/建议清零+密度0/
   块列表废除+移入修复+排序重命名/块级继承开关。裁决 D1-D8 可推翻（design §0）。
2. [域纪律] 独占 components/Studio/**、stores/studio*、lib/studio/**、views/StudioView、tests/studio/**；
   App.svelte 仅 Tab label 一处；禁改 TERMS.md/PRODUCT_MODEL.md/Lab/Assets/engine/persistence。
3. [切片纪律] 每切片：聚焦 solo 测试（pnpm exec vitest run <file>）→ git commit 显式路径（repo 根发起，
   禁 amend，脏文件重试）；不跑全量；不起 dev server。
4. [护栏纪律] 既有 oracle/逐位相等护栏因模型扩展需更新断言 = 语义演进显式更新（commit 收据注明），
   不得静默删测试。
5. [收尾] 受影响族回归（studio 全族+app.smoke+edit 交接面）+ pnpm check 0 错 + grep 收据
   （「建议」UI 清零 / 排钻设计清零（TERMS·PM·modelDocs 除外）/ 移动端「排钻」保留）。
-->

## 1. 二级图层树 + 排序 + 移入修复（点 1/4/5）

- [ ] 1.1 `layer.reorder` op + reducer（layers.svelte.ts：applyLayerReorder 排列校验/诊断 no-op；canonicalParamStateJson 天然含数组序）+ `jointViewOf` 联合口径改层 id 稳定序（computeQueue；现状两序恒等行为零变化）；vitest：solo layers.test.ts + computeQueue.test.ts
- [ ] 1.2 移入图层修复：store 根 `moveBlockToLayer`（prevOwner+目标双标脏 immediate）+ LayerPanel merge/create/delete 补标脏 + BlockDetail 菜单真实归属禁用态 + 标签「移入图层 · 当前：图层N」；vitest：solo studio.interactions.test.ts（移动后双层数据面断言）
- [ ] 1.3 LayerPanel 树化：一级行折叠钮 + 子行（#No/钻数/「独」徽标）+ 子行选择 = selectBlock（画布⇄面板双向同步 + 自动展开）+ 一级行 HTML5 拖排（layer.reorder）；Inspector 删「块列表」组 + BlockList.svelte 退役（死 grep 清零）；vitest：solo panels.test.ts + selection.test.ts（显式更新既有断言）

## 2. 历史 PS 游标模型（点 2）

- [ ] 2.1 history.svelte.ts：redoBuffer → cursor（undo/redo 只动游标 refold；dispatch 截断前向；压实同步减 cursor；canUndo/canRedo/getUndoDepth/新增 getHistoryCursor）；vitest：solo history.test.ts 全矩阵（列表恒定/截断覆盖/合组/压实/跨重分块/事件面——显式更新深度语义断言）
- [ ] 2.2 HistoryPanel 游标灰显（≥cursor 行灰显只读 + 当前态高亮 + 计数文案）；vitest：solo panels.test.ts 历史段

## 3. 块级「继承」开关（点 5 + 修订）

- [ ] 3.1 overrides.config 表 + 开关/配置写入 reducer（首次关闭摄父层快照；再关恢复休眠；开=保留休眠）+ block.override 扩 patch（inherit/config）+ canonicalParamStateJson 纳入 + toLayerRecord 剥离（会话态登记）；vitest：solo layers.test.ts（开关双向/休眠/快照起点/fold 等价）
- [ ] 3.2 computeQueue 合成计算单元（`${layerId}#${blockId}` 二次 resolveLayerPlans + 批合并 + jointView 合并/聚合 + 状态点感知）+ store 根 mutator（开关/配置 → 标脏）；vitest：solo computeQueue.test.ts 行为证明（继承块随父层变 / 独立块不随）
- [ ] 3.3 BlockDetail 继承开关 UI（开=只读父层值+「继承中」标记；关=策略/规格可编辑）+ 树子行「独」徽标接线；vitest：solo panels.test.ts

## 4. UI 清理 + 密度 0%（点 3）

- [ ] 4.1 「建议 填充」badge 删除（BlockDetail）+ 全库 UI「建议」提示 grep 清零收据；vitest：solo panels.test.ts
- [ ] 4.2 密度 0：clampDensity 下界 0 + 滑杆 min 0（块/层）+ effectiveBlocks 排除生效 0 密度块（root + replayLayers 双面）+ 保存投影（块 0→disabled；层 0→0.01+成员 disabled）；vitest：solo layers.test.ts + projectPersistence.test.ts + walkthrough.test.ts（0% 无钻口径）

## 5. 改名（代码面）

- [ ] 5.1 排钻设计→排钻工作台全库改齐（App Tab/StudioStatusBar toast/EditView 引导/gallery·lab toast/注释/tests 断言）；TERMS·PRODUCT_MODEL·modelDocs.test.ts 不动；Lab/Assets 文案行遇脏文件 30s 重试、持续阻塞缓期回报；grep 收据（排钻设计清零（除外清单）+ 移动端「排钻」保留）；vitest：solo app.smoke.test.ts + edit 交接面（lifecycle/editUnbound）

## 6. 收尾

- [ ] 6.1 回归：tests/studio 全族 + app.smoke + edit 交接面 + `pnpm check` 0 错；偏离清单与 grep 收据回报（含 v3 登记项：密度 0/独立配置入档、TERMS/PM 升版留主会话）
