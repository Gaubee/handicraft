# add-backend-platform W3 实现评审 R3

## 开头自检

- `pwd=/Users/kzf/Pictures/贴钻-backend`：通过。
- `HEAD=77e8d5dd51a7bf7f0634585963faa7ecfed54f57`：通过。
- `f166b77` 与 `77e8d5d` 均为当前 `HEAD` 祖先：通过。
- 评审前工作树干净；本次仅新增本报告，未修改 R2 冻结报告或源码：通过。
- 评审范围固定为 `git diff f166b77..77e8d5d`；改动仅 6 个 daemon 文件，前端与引擎目录均未触碰。

## 结论

**NO-GO，6.5/10（相对 R2 的 6.0/10 上升 0.5 分）。**

R2 指定的两项 P1-1 残留和风险③本身均已通过源码、历史探针镜像和新增回归闭合；但本次 results 孤儿清扫引入了新的启动恢复 P1：`results/` 若是普通文件，`recover()` 会在 `readdirSync(resultsRoot)` 抛 `ENOTDIR`，导致 daemon 恢复流程中止。该状态正是发布目录失败回归构造的持久 IO 异常形态，因此不能给 GO。

## P0

未发现 P0。

## P1

### P1-1 R2 残留②：cancelled writer fence 已闭合

- `daemon/src/writer-fence.ts:31-37,41-49`：`taskWriterAllowed()` 和 `assertTaskWritable()` 均显式拒绝 `task.status === 'cancelled'`；帧、任务产物、分享包共用该谓词。
- `daemon/src/jobs/engine.ts:148-180`：pave/layout 与 validate/verdict 写入前均补 `bailIfCancelled()`。
- 历史探针镜像独立复跑：无会话任务置 `cancelled` 后，`putTaskArtifact()` 抛 `ArtifactFenceError`，输出 `status=cancelled, put=false, blobs=0`。
- 新回归 `daemon/tests/sessions-clear.test.ts:841-867` 同时验证 `putTaskArtifact()` 与 `createShareBundle()` 拒绝、`blobs=0`、`results=0`、无 results 目录；定向测试通过。

**裁定：闭合。**

### P1-1 R2 残留①：发布全阶段统一回收已闭合

- `daemon/src/share.ts:83-131`：`stage×3` 增量 `push`、bundle 目录发布和 SQLite 提交全部位于同一 `try/catch`；中段异常时已成功返回的 stage 已在 `staged` 列表中，可进入 `reclaimPublished()`。
- `daemon/tests/sessions-clear.test.ts:869-916`：注入第二次 stage 抛错，断言 blobs 树零文件、blob/result 行为零、outbox 为零、results 不存在。
- `daemon/tests/sessions-clear.test.ts:918-954`：将 `results/` 占位为普通文件，mkdir 发布失败后断言三份 staged 文件全回收、零 blob/result 行、零 outbox。
- `reclaimPublished()` 的 deduped 跳过在 `daemon/src/share.ts:160-169` 是正确的：deduped 项没有本次新物理文件，事务回滚也会撤销 ref_count 增量；非 deduped 项直接删除，删除失败才入 outbox（`:171-185`）。
- 既有权限失败回归仍通过，证明内联回收失败可进入持久 outbox 并在恢复权限后收敛。

**裁定：闭合。** 未发现 stage push 时序、deduped 误删或正常 outbox 兜底链的新漏洞。

### 新 P1：results 根路径损坏会使 recover 崩溃

证据：

- `daemon/src/sessions/service.ts:351-367` 的 `sweepOrphanResultDirs()` 仅判断 `existsSync(resultsRoot)`，随后无条件 `readdirSync(resultsRoot)`；它没有像子目录检查那样处理根路径为普通文件、权限错误或其他 `readdir` 异常。
- 独立探针复现：将 `data/results` 写成普通文件，调用 `createShareBundle()` 得到预期 `ENOTDIR`；关闭并重开服务后调用 `sessions.recover()`，实际得到 `recover_error=Error: ENOTDIR: not a directory, scandir '.../data/results'`。
- 这不是抽象的外部假设：同一 R2 目录发布失败回归正是以 `results/` 普通文件构造（`daemon/tests/sessions-clear.test.ts:918-954`），但该测试未继续调用 `recover()`。

**定级：P1，阻 GO。** 启动恢复应把 results 根路径异常视为可处理的 IO 状态，而不是让整个恢复流程抛出；至少需捕获 `readdirSync` 失败并保证 recover 继续，且为该异常形态补重启回归。若产品决定自动替换普通文件，还需明确其持久化/备份语义，不能静默覆盖未知文件。

## P2

未发现新的独立 P2。重连交错测试等 R2 历史非阻断缺口不在本次定向范围内，也未重新升降级。

## 风险③ 定向复核：results 孤儿 bundle 清扫已闭合

- `daemon/src/sessions/service.ts:266-278`：`recover()` 在 outbox/recovery 主流程中调用 `sweepOrphanResultDirs()`；`maintenance()` 未调用，符合“避免在途发布窗口竞态”的设计取舍。
- `daemon/src/sessions/service.ts:351-367`：按 results 下一级 publicId 目录对账 `getResultByPublicId()`；无 result 行的目录递归删除，有行目录保留。
- 新回归 `daemon/tests/sessions-clear.test.ts:956-979`：手工孤儿目录被删除，真实有 result 行的 bundle 保留，results 行数仍为 1。

**裁定：风险③闭合（在 results 根目录本身可读为目录的正常前提下）。** 上述新 P1 是该清扫函数对损坏根路径的异常处理缺口，不否定“有行/无行目录对账”语义本身。

## 独立门禁与证据

本轮按用户要求未重跑无关全量面，仅执行定向门禁：

- `pnpm -C daemon exec vitest run tests/sessions-clear.test.ts`：1 file，29/29 通过。
- `pnpm -C daemon run typecheck`：通过。
- `pnpm -C daemon run test:e2e`：2 files，3/3 通过。
- `pnpm -C daemon run smoke:engine`：PASS，`gemCount=68,dropped=0,svgBytes=3040,bomBytes=103`，与基线逐字一致。
- `git diff --check f166b77..77e8d5d`：通过。
- `git diff --name-only f166b77..77e8d5d -- rhinestone-studio/src/lib/engine`：空；前端与引擎零触碰成立。
- `openspec validate`：本轮未重跑；R2 已记录本机 `VP_BYPASS` wrapper 缺系统 `openspec`，不把协调方供给的 strict 结果冒充本地复验。

## 评分与最终裁定

| 维度 | 评分 | 依据 |
|---|---:|---|
| cancelled writer fence | 9.0/10 | 共享谓词、engine 前置检查、历史探针镜像和新增回归均通过 |
| share 全阶段回收 | 8.5/10 | stage/目录/事务统一 catch，deduped 与 outbox 链审查通过 |
| results 孤儿清扫 | 7.0/10 | 有行/无行目录对账正确，但损坏 results 根路径会令 recover 崩溃 |
| 独立证据完整度 | 8.0/10 | 定向 29/29、typecheck、E2E、smoke 全绿；未重跑无关全量门禁 |
| **综合** | **6.5/10** | 相对 R2 +0.5；两个目标残留已收口，但新增 P1 阻断 |

**最终结论：NO-GO。** 修复 `sweepOrphanResultDirs()` 对 `results/` 根路径非目录/不可读异常的处理并补 recover 重启回归后，再进行下一轮定向复核。
