# W4.1 实现评审 R2：R1 四项定向修复复核

## 开头自检

- `pwd=/Users/kzf/Pictures/贴钻-backend`
- `HEAD=b065709`（完整 SHA：`b065709e74b07eee5cb3807b7420af687bbf8634`）
- `281215d` 与 `b065709` 均为 HEAD 祖先：`git merge-base --is-ancestor 281215d HEAD` exit `0`；`git merge-base --is-ancestor b065709 HEAD` exit `0`。
- 固定范围：`git diff 281215d..b065709`；仅含 `daemon/src/mcp.ts`、`daemon/src/kernel/boot.ts`、`daemon/tests/mcp.test.ts`、`daemon/tests/kernel.test.ts`。
- 写入前 `git status --short` 为空；写入后复核为仅有 `?? openspec/changes/add-backend-platform/codex-impl-review-w41-r2.md`，除该报告外工作树零改动。
- `git diff --check 281215d..b065709`：通过。

## 结论

- R1 的 P1-1、P1-2、P1-3、P2-1 均闭合，未发现新的 P1/P2 实现缺陷。
- 评分：**9.3/10**，相对 R1 `6.5/10` 上升 **+2.8**。
- W4.1 整体：**GO**。
- 剩余项是测试精度/版本漂移风险，不阻断本轮 GO：审计回归使用真实健康树，尚未合成独立 optional `FIBER_FAILED`、`FIBER_PENDING` 和 fiber 缺失 fixture；当前实现边界由上游 required/optional 策略与真实探针共同支撑。

## 四项定向复核

### P1-1：MCP `unbooted` 降级门

**PASS。** `daemon/src/mcp.ts:107-120` 现在只允许 `ready`/`booting`，其余状态（包括 `unbooted`、`off`、`missing`、`error`）统一返回 501。`daemon/tests/mcp.test.ts:143-165` 增加 `unbooted` 断言。

独立真实 HTTP 探针结果：合法 Bearer 请求在 `kernelState=unbooted` 时返回 `501`，响应体包含 `unbooted`；booting/ready 放行由同一回归用例覆盖。启动时 `mcp.listen()` 先于 `kernel.boot()` 的窗口因此不再执行 handler。

### P1-2：既有 token 文件权限

**PASS。** `daemon/src/mcp.ts:71-76` 保留写入时 `mode: 0600`，并在写入后显式 `chmodSync(tokenFile, 0o600)`，覆盖 POSIX 下已有文件的权限不随 `writeFileSync({mode})` 改变的问题。

`daemon/tests/mcp.test.ts:167-186` 手工预置 0644 文件后再 `listen()`，断言 0600 与旧内容轮换。独立探针实测：`tokenMode=600`、`tokenRotated=true`。未发现 token 内容或 listener 时序回归。

### P1-3：boot 审计策略与 optional FAILED 边界

**PASS，且不支持“所有 optional FAILED 一律降级”的更严格裁决。**

`daemon/src/kernel/boot.ts:196-255` 的策略明确分层：

- `fiber===undefined`（插件 import 失败）对任意非 disabled 行计入 `importFailures`，释放 fiber、还原环境并抛出带 `kernelImportFailure` 标记的错误；上游 mount 将其分类为 `missing`，整树降级。
- `fiber.state !== 2`（包括 `FIBER_FAILED=3`、`FIBER_PENDING=0` 以及当前依赖版本可能出现的其它非 ACTIVE 值）不降级，写入 `record.inactiveActivation` 并输出警告。
- required 失败由上游 `dsh-app-boot` 自身拒绝启动，进入 error/mount 降级路径；本地审计不重复吞掉该策略。

依据已读取的实际上游源码 `node_modules/.pnpm/@deepseek-ai+dsh-app-boot@0.1.6-alpha.1.../lib/index.js`：`requiredStartupEntryIds` 在 2408-2416；`auditStartupEntries` 在 2496-2515 将 required/Bootstrap 失败抛错、optional 失败仅 warning。当前真实 boot 反复实测为 `79 ACTIVE + 1 fiber=3 (typert-loader) + 0 import failure`，kernel 仍为 `ready`，且 warning 与 `record.inactiveActivation` 均可见。全量/聚焦实跑均复现同一可解释的 typert codec `AggregateError` 噪声，没有把它静默成健康零告警，也没有误杀可用树。

若改成“所有 optional FAILED/PENDING → missing/error”，会把上述可复现的 typert-loader codec 噪声升级成健康树误杀，直接违反上游 required/optional 语义。可验证的更严格替代方案只能是：仅对 required id 或 bootstrap include 的 FAILED/PENDING 降级，继续保留 optional 的 warning + `inactiveActivation`；而这已由上游 `auditStartupEntries` 实现，当前策略与其一致。

### P2-1：`AggregateError.errors` 分类

**PASS。** `daemon/src/kernel/boot.ts:294-317` 在既有 `cause` 递归之外遍历 `typed.errors`，任一成员含 `ERR_MODULE_NOT_FOUND`/模块解析特征即返回 true。

`daemon/tests/kernel.test.ts:156-170` 覆盖“聚合成员含缺包→true”和“纯无关聚合→false”。独立探针结果：`aggregate=true`、`plainAggregate=false`。

## 独立验证

- `pnpm -C daemon exec vitest run tests/mcp.test.ts tests/kernel.test.ts --reporter=verbose`：**25/25**。
- `pnpm -C daemon test`（排除 e2e）：**24 files / 208 tests passed**。
- `pnpm -C daemon typecheck`：**通过**。
- `pnpm -C daemon exec vitest run tests/e2e-kernel.test.ts`：**5/5**。
- `pnpm -C daemon test:e2e`：**3 files / 8 tests passed**。
- `pnpm -C contracts test`：**4 files / 39 tests passed**。
- `pnpm -C daemon run smoke:engine`：**PASS**，`{"gemCount":68,"dropped":0,"svgBytes":3040,"bomBytes":103}`，与既有基线逐字一致。
- `git diff --check 281215d..b065709`：通过。

协调方给出的其余门禁（daemon 216/216 的统计口径、typecheck、e2e 8/8、smoke、contracts 39/39、diff 四文件）与本地复跑结果一致；本报告只将本地实际运行的数字列为独立证据。

## Standards / Spec

- Standards：PASS。未发现仓库标准硬违规；新增 `inactiveActivation` 类型明确、无 `any`/`ts-nocheck`，改动范围严格为四文件。唯一可选 Fowler smell 是 `inactiveActivation.state` 以 `fiber=<n>` 字符串承载状态（`boot.ts:213,222-224`），符合当前日志/审计展示用途，不阻断。
- Spec：PASS。MCP 仅 booting/ready 放行、token 既有文件收敛、import failure 整树降级、optional 非活跃显式可见、AggregateError 聚合分类均与 W4.1 §6.4 和上游启动策略一致；无 scope creep。

## 最终裁定

**GO（9.3/10；R1 6.5/10，+2.8）。** 四项 R1 定向修复已由源码、回归测试、真实 boot/HTTP 探针及完整 daemon/contract/smoke 门禁闭合。保留的 typert-loader `fiber=3` 是已解释且已显式暴露的上游 optional 噪声，不应通过全量 FAILED 降级来“消除”。
