# add-project-files R4 终审（收口轮）

日期：2026-09-19  
范围：change 全部设计/任务/spec、姊妹稿、实验室补充稿、`PRODUCT_MODEL.md`/`TERMS.md`，以及 `rhinestone-studio/src/` pre-wave 基线。

## 结论

R3 三个语义缺口已经基本落地：迁移算法改为 create-only、内置和自建 variant 都有确定性节点 id、lease ownerId/CAS 规则和 `4.2 → 4.3` 硬前置已进入设计正文。独立门禁再次通过：

- `pnpm check`：0 errors / 0 warnings
- `pnpm test -- --reporter=dot`：49 个文件、528 个测试全绿（仅 jsdom canvas 警告）
- `openspec validate add-project-files --strict`：当前环境通过

但终审仍为 **NO-GO**。不是数据模型或异步时序还缺契约，而是还有两处会直接改变执行结果的文档冲突：`tasks.md` 顶部仍保留 R3 之前的旧实现顺序，且补充稿 §E-3 PM 立场仍写“用户编辑覆写 seed”，没有标明已被 §9.3 推翻。实现者按 tasks 头注或补充稿议题表执行，仍可能回到错误迁移/并行顺序。

## 1. R3 三项逐项核对

| R3 缺口 | 状态 | 证据与判断 |
|---|---|---|
| 迁移覆写残留 | **算法闭合，文档仍有一处未标废** | `design.md:78,119,141`、补充稿 `:231,233` 已明确 create-only、内容覆写作废、确定性 id、完成集判定；全文已无“内容 diff 为条件”表述。但补充稿 `:514` 的 §E-3 PM 立场仍写“用户编辑覆写 seed”，未加“已被 §9.3 推翻/非实现算法”标记。应将该行改为历史立场并显式指向 §9.3，避免议题表与实现契约双读。 |
| 自建 variant 稳定身份 | **闭合** | `design.md:141` 已冻结 `ast-tpl-legacy-${legacyId}`，ingest 前 `get`（含软删）存在即跳过并记完成；`tasks.md:55` 已加入“ingest 成功+完成集写失败+重启重试最终仅一个 gemtpl”测试。真实普通入库使用随机 UUID 的风险已被确定性 id 消除。实现时仍应对 `legacyId` 做非空/长度/规范化校验，避免异常 localStorage key；这是 P1 防御性建议，不再是本轮阻塞。 |
| DAG 与 ownerId | **主契约闭合，tasks 头注未同步，仍阻塞** | `design.md:152-164` 已给完整 DAG、4.2 硬前置、并行上限 2、绿门串行；`tasks.md:54-55` 已标 4.2 是 4.3 硬前置；`design.md:130`/`tasks.md:20` 已冻结宿主稳定 ownerId、每次 open 独立 lease/token、stale close no-op 和四项测试。但 `tasks.md:3-4` 仍写旧顺序 `...→4.3→1.4/2.7/4.2-4.7`，与设计 DAG 相反，必须改为同一 DAG 或删除旧简写。 |

## 2. 仍然阻塞的精确修复

### P1-1：补充稿 §E-3 的 PM 立场标记

将 `.agents/documents/2026-09-19-lab-formats/lab-formats-and-gallery.md:514` 改为类似：

> 立场（**已被 change design §9.3 推翻，仅保留为历史 PM 议题记录**）：退役并一次性迁移；实现算法采用 create-only、确定性迁移 id、journal 完成集，不允许内容覆写。

这样 `A.4.3`、§E-3、change §9.3 三处才不会产生实现级双读。

### P1-2：删除 tasks 头注旧 DAG

将 `tasks.md:3-4` 的旧简写替换为与 `design.md:153-164` 完全相同的顺序：

```text
0.4
  -> 0.5 / 1.1 / 4.1（仅消费冻结类型，可并行）
  -> 0.6 + 0.7(store contract) + 0.8
  -> 4.2
  -> 4.3 / 4.3b
  -> 4.4
  -> 4.5
  -> 4.6
  -> 1.4 + 2.7 + 4.7（按各自依赖收口）
```

并保留“全量 test/check/build 串行、并行代理最多 2 个”的约束。当前 tasks 第 4.2/4.3 条目本身已经正确，问题只在顶部旧路由仍会误导编排。

## 3. 已闭合契约的复核摘要

- 四格式 `PROJECT_MIME`、kind/MIME/扩展名交叉校验、gemgen `thumbKey` 物理记录和 fallback 已在 `design.md:33-35` 落定；姊妹稿/spec 对齐。
- `runTx` 首终态、request-only await、commit error 可见性、旧 node/blob/thumb/hash 保持和全引用 GC 已在 `design.md:129` 落定；0.4 先 contract test 再改共享执行器。
- `openIntent` 已是原子 claim/ack，刷新丢弃、replace、定位失败不清 token、成功展开高亮后 ack 已在 `design.md:136-137` 落定；0.7 store contract 与 4.6 UI 测试拆开。
- lease/CAS 已在 `design.md:130` 落定：宿主稳定 ownerId、每次 open 独立引用、stale close no-op、差分 pin、typed conflict 不写孤儿。
- GalleryEntry key、活任务 precedence、非 gemgen/归档失败和 DOM 定位失败分支已在 `design.md:137` 落定。
- 迁移 journal 的 raw-v2 reader、`{version,state,completedNodeIds,sessionWritten,oldKeyDeleted,backupKey,startedAt}`、30 天备份 TTL、IDB/localStorage 非原子恢复和 deterministic legacy id 已在 `design.md:141` 落定；算法测试已进入 `tasks.md:55`。

## 4. 评分

| 维度 | R3 | R4 | 变化依据 |
|---|---:|---:|---|
| 设计质量 | 8.0 | **8.3** | 三项语义修订已闭合，尤其迁移重试和 lease owner 规则达到可测试级；仅剩补充稿历史立场标记漂移。 |
| 实现准备度 | 6.2 | **6.8** | deterministic id、DAG、四 lease 测试和 strict spec 门禁已补齐；tasks 头注旧顺序仍会误导首波编排，且真实功能源码仍未实现。 |
| 综合 | 7.1 | **7.5** | 主要风险已从数据/竞态缺陷收敛到两处执行文档同步；修正后即可按 gate 进入实现。 |

## 5. 最终决定

**Verdict：NO-GO。**

达成 GO 的最小修订只有两项：

1. 标记补充稿 §E-3 的“用户编辑覆写 seed”只是已推翻的历史 PM 立场，并指向 §9.3。
2. 删除/改写 `tasks.md` 顶部旧 DAG，使其与 `design.md §9.5` 完全一致。

这两项完成后，没有剩余的 R3 级数据模型、事务、迁移幂等、意图时序、lease/CAS 或画廊定位阻塞；可转 **GO** 进入实现。R3 §6 的并行度建议确认继续作为最终执行方案：最多 2 个代理，0.4 独占，0.5/1.1/4.1 可并行，4.2→4.3 串行，4.4→4.5→4.6 串行，最终绿门串行。

## 7. R5 终判

R5 只复核 R4 两项最小修订，均已闭合：

1. 补充稿 §E-3 `:514` 已明确标注“已被 §9.3 推翻、仅保留历史 PM 议题记录”，并明确 create-only、确定性迁移 id、journal 完成集、30 天备份 TTL 和禁止内容覆写。
2. `tasks.md:3-13` 已替换为与 `design.md:153-164` 一致的完整 DAG：0.4 独占 → 0.5/1.1/4.1 并行 → 0.6+0.7+0.8 → 4.2 → 4.3/4.3b → 4.4 → 4.5 → 4.6 → 1.4+2.7+4.7；并行代理上限 2、全量绿门串行约束一致。

全文 `rg` 复核确认旧迁移措辞仅存在于明确的“作废/推翻”语境，没有裸实现指令残留。R5 复核门禁仍为 `pnpm check` 0/0、Vitest 49/49 文件与 528/528 测试通过、`openspec validate add-project-files --strict` 通过。

**最终 Verdict：GO。**

| 维度 | R4 | R5 |
|---|---:|---:|
| 设计质量 | 8.3 | **8.4** |
| 实现准备度 | 6.8 | **7.0** |
| 综合 | 7.5 | **7.7** |

R3 §6 并行度建议正式确认为最终执行方案：最多 2 个实现代理；0.4 独占；0.5/1.1/4.1 可并行；0.6、0.7、0.8 收口后进入 4.2；4.2→4.3/4.3b 串行；4.4→4.5→4.6 串行；1.4、2.7、4.7 按依赖收口；全量 `test/check/build` 串行。
