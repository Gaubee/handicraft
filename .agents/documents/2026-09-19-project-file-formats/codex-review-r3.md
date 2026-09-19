# add-project-files R3 设计复审（收敛轮）

日期：2026-09-19  
范围：`openspec/changes/add-project-files`、姊妹稿、实验室补充稿、`PRODUCT_MODEL.md`/`TERMS.md` 与 `rhinestone-studio/src/` pre-wave 基线。源码未实现仍不作为本轮设计缺陷，但用于确认实现准备度边界。

## 结论

R2 七项修订中，MIME/thumb、runTx 终态、openIntent claim/ack、lease/CAS、画廊失败分支和双段 gate 均已落到 change 文档；spec 的 MUST/MUST NOT 也已补齐。独立证据：`pnpm check` 通过（0 errors / 0 warnings），`pnpm test -- --reporter=dot` 通过 49 个文件、528 个测试（仍只有 jsdom canvas 警告），`openspec validate add-project-files --strict` 在当前环境实际通过。

最终仍为 **NO-GO**，原因集中且可验证：迁移契约仍有两处正文残留会把实现带回“内容 diff 覆写”，并且 journal 的 `completedNodeIds` 没有覆盖自建 variant 的幂等身份。另有一个实现 gate 的内部依赖（`4.2` 建 `sys-templates`，但当前总序列没有明确先于 `4.3`）需要补成 DAG。不是方向问题，而是迁移数据安全和首波切片顺序仍未完全闭合。

## 1. R2 七项逐项核对

| R2 项 | 状态 | 核对结果 |
|---|---|---|
| 1. 四格式 MIME/thumb | **闭合** | `design.md:33-35,130-131` 已给 `PROJECT_MIME` 四值、kind/MIME/扩展名交叉校验、`summaryUpdatedAt`、gemgen `thumbKey` 物理记录、所有权/GC/fallback；姊妹稿 `:258` 与 spec `:39,69` 已对齐。实现时仍需在 0.5 contract test 断言物理记录包含实际 Blob payload，而不只 metadata tuple。 |
| 2. runTx 终态 | **闭合（实现前置）** | `design.md:129` 已冻结首终态、request-only await、oncomplete 可见性、commit error、旧 node/blob/thumb/hash 保持及全引用 GC；`tasks.md:19` 明确先 contract test 再改造和旧路径回归。真实 `assetStore.ts` 仍是旧实现，这是预期的未实现状态。 |
| 3. openIntent | **闭合（实现前置）** | `design.md:136-137` 已冻结 claim/ack、replace、刷新丢弃、解析先于切视图、目标 DOM/组消失/卸载/滚动失败及成功 ack 条件；`tasks.md:22,60` 已拆 store contract 与 UI 动线。 |
| 4. 迁移 journal | **未闭合，P0** | `design.md:141` 和补充稿 `:231` 的主算法已是 create-only，但补充稿 `:233` 仍写“幂等：步骤 2 的覆写以内容 diff 为条件”；`design.md:78` 也仍写“用户编辑覆写 seed 节点”。这两处正文与 §9.3 相反，不能靠“指向 §9.3”消除歧义。更重要的是，自建 variant 没有稳定目标 id：真实 `assetStore.ts:137-139,409-410` 的普通入库 id 是随机 UUID；若 ingest 成功后在写 `completedNodeIds` 前崩溃，重试会再建一个 gemtpl。 |
| 5. gate 重排 | **部分闭合，P1** | 双段 gate 和 0.4→0.5/1.1→4.1→0.6→0.7→0.8 已写入 `design.md:151-152`、tasks 头注；但 `4.2` 负责创建 `sys-templates`，`4.3` 负责读取/写入模板面板，当前“4.3 → 1.4/2.7/4.2-4.7”总序列没有明确 `4.2 → 4.3`，存在并行误解。 |
| 6. lease/CAS | **基本闭合，P1 细化项** | `design.md:130` 已给 lease 形状、close 幂等、差分 pin、CAS 五步和 typed conflict；`openProject(id)` 未说明 `ownerId` 是每次 lease 生成还是调用方传入，需补一句以免多个宿主计数口径不一致。 |
| 7. 画廊定位 | **闭合（实现前置）** | `design.md:137` 已冻结 `asset:<id>`/`task:<id>`、活任务 precedence、非 gemgen/归档失败状态、data-testid 和所有失败分支；与 claim/ack 状态机一致。 |

## 2. 仍然阻塞的精确缺口

### B6-1：删除迁移覆盖残留

必须把补充稿 `lab-formats-and-gallery.md:233` 改成：

> 全部节点、完成集和 `lab-session` 写入成功后才将 journal 置 `done` 并删除 `VARIANTS_KEY`；任一步失败保留旧 key 和 journal，按完成集重试；不存在任何内容 diff 覆写路径。

并把 `design.md:78` 的“用户编辑覆写 seed 节点”改为“用户编辑内容保持不变；稳定节点存在（含软删）即跳过，缺失才 create-only 创建”。补充稿 E3 PM 立场表（`:514`）可以保留为历史议题，但应明确标注“被 §9.3 推翻，不是实现算法”。

### B6-2：自建 variant 的崩溃幂等

当前 journal 只有 `completedNodeIds`，稳定 `ast-tpl-${presetId}` 只覆盖内置 preset；自建 legacy id 走随机 `ingest`。必须增加一个可验证的稳定身份策略，二选一：

1. 迁移节点 provenance 增加不可变 `legacyVariantId`，重试先按 `(source='legacy-migration', legacyVariantId)` 查找再 ingest；或
2. 所有迁移 variant 使用由 legacy id 派生的确定性节点 id（例如哈希后的 `ast-tpl-legacy-*`），重试以节点存在性跳过。

测试必须注入“自建 variant ingest 成功、完成集写入失败、重启重试”，断言最终只有一个 gemtpl、内容不变、`VARIANTS_KEY` 在全量成功后才删除。仅把 source id 写进完成集不够，因为崩溃可能发生在创建与完成集记录之间。

### B10-1：明确 `4.2 → 4.3` 依赖

`4.2` 的 `sys-templates` 系统目录和 preset seed 是 `4.3` 模板 store 的前置；`4.3` 不应与 `4.2` 无约束并行。建议把实现 DAG 写成：

```text
0.4
  -> (0.5 contract, 1.1 AssetProject implementation, 4.1 labFile parser 可并行)
  -> 0.6 + 0.7(store contract) + 0.8(journal implementation)
  -> 4.2(sys-templates + seed)
  -> 4.3/4.3b
  -> 4.4
  -> 4.5
  -> 4.6
  -> 1.4 + 2.7 + 4.7（按各自依赖收口）
```

`4.2` 与 4.1/0.7 只有在不共享未冻结类型、且不同时跑全量 build/test 时才适合双代理并行。

### B5-1：ownerId 生成规则

在 `openProject(id)` 契约后追加：`ownerId` 由宿主调用方提供并在宿主生命周期内稳定，或由每次 open 自动生成且 lease 唯一；同一 owner 的重复 open 是否算多个引用必须明确。测试至少覆盖同 asset 被两个 owner 打开、一个 owner 重复 close、过期 token close、source/reference 差分重绑。

## 3. 非阻塞观察

- 当前 `openspec validate add-project-files --strict` 已在本环境通过；用户所述 npm error 未复现，应把它归为环境差异而非 change 缺陷。
- `project-format-and-redesign.md:507` 仍有“术语表尚无落盘、建议后续抽 TERMS”的历史建议，与已存在的 `TERMS.md` v1 不一致；它不是实现算法，但应标注为历史反馈或删除，避免后续审阅误判 B9 未完成。
- `design.md:89` 的“gemproj/gemdoc/gemtpl 维持 P1/无缩略”与当前 gemgen P0 方案一致，不是残留冲突；姊妹稿 `:258` 也已按四格式差异写明。
- 真实源码仍有旧 handoff `getAssetBlob` 和旧“转化工作台/送转化”文案；这是 pre-wave 预期，必须留给 0.6/4.7/5.1 实现和 grep gate，不应作为本轮设计回归。

## 4. 评分

| 维度 | R2 | R3 | 变化依据 |
|---|---:|---:|---|
| 设计质量 | 7.3 | **8.0** | 四 MIME/thumb、事务、claim/ack、lease/CAS、画廊失败分支和 spec 强制词已闭合；迁移正文残留和自建 variant 幂等仍阻止 8 分以上。 |
| 实现准备度 | 5.0 | **6.2** | gate 已拆成 contract/implementation，strict spec 与 49/49、528/528 门禁通过；但迁移不能安全重试，且 4.2/4.3 内部依赖仍未写死，源码能力仍未实现。 |
| 综合 | 6.2 | **7.1** | 主要风险已收敛到两个迁移正确性缺口和一个可排序依赖，不再是 R1/R2 的广泛架构悬空。 |

## 5. 最终决定与最小修订集

**Verdict：NO-GO（收敛轮仍未放行实现）。**

达到 GO 只需完成以下最小集合：

1. 删除/改写补充稿 `:233` 与 `design.md:78` 的内容覆写措辞，并把 E3 PM 表标为已被 §9.3 推翻。
2. 为自建 legacy variant 增加稳定迁移身份，补崩溃重试不重复创建测试。
3. 将 `4.2 → 4.3` 写入 tasks/design DAG；补 `ownerId` 生成/复用规则及 lease 测试。

这三项完成后，0.4-0.8 可按现有 contract/implementation gate 进入实现；旧 assetStore 回归和最终浏览器走查仍是实现完成门，不因当前 49/49、528/528 基线绿而提前宣称功能完成。

## 6. 条件 GO 后的推荐并行度

建议最多两个实现代理，且全量 `pnpm test/check/build` 串行运行：

- 串行主线：0.4 → 1.1；0.4 改共享事务执行器，不与其他写入型切片并行。
- 可并行：0.5 contract、4.1 `labFile` parser、0.7 纯 store contract；它们只能消费冻结类型，不改同一模块的实现。
- 依赖收口后：0.6 等 4.1，0.8 journal implementation 等 raw-v2/AssetProject；4.2 完成 `sys-templates` 后再做 4.3/4.3b。
- 画廊链串行：4.4 → 4.5 → 4.6；4.7 与 1.4 可在共同手势/路由契约完成后并行收尾，2.7 只在 0.6/0.7/0.8 和四 parser 均可用后进入。
