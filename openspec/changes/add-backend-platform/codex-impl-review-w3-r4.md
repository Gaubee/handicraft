# add-backend-platform W3 实现评审 R4

## 开头自检

- `pwd=/Users/kzf/Pictures/贴钻-backend`：通过。
- `HEAD=b7eb0d1`（完整提交 `b7eb0d127099e4abb6c6678ded472b65731594b`）：通过。
- `bd51881` 与 `b7eb0d1` 均为当前 HEAD 祖先：通过（`git merge-base --is-ancestor` 返回 0）。
- 报告写入前工作树除本报告外零改动；本次 diff 文件仅为 `daemon/src/sessions/service.ts` 与 `daemon/tests/sessions-clear.test.ts`。
- 评审范围固定为 `git diff bd51881..b7eb0d1`，未修改源码、R2/R3 冻结报告或其他产物。

## 结论

**GO，8.0/10（相对 R3 的 6.5/10 上升 1.5 分）。**

R3 新增的 P1「`results/` 根路径为普通文件时 `recover()` 因 `ENOTDIR` 崩溃」已闭合。根路径现在先用 `statSync().isDirectory()` 分类；普通文件只尝试 `unlinkSync`，删除失败被局部捕获并返回，不再进入 `readdirSync`，因此恢复流程不会被该异常中断。普通目录仍按 `publicId` 与 `results` 行对账，有行 bundle 保留、无行目录回收。未发现本 diff 新引入的 P0/P1。

## P0

未发现 P0。

## P1

未发现新的 P1。R3 记录的 P1 已闭合：

- `daemon/src/sessions/service.ts:266-278,353-367`：`recover()` 调用 `sweepOrphanResultDirs()`；该函数捕获根路径 `statSync` 异常，将不存在/不可 stat 状态直接跳过；根为非目录时只做 `unlinkSync`，其失败也被捕获后返回。本轮额外探针把根文件父目录改为不可写，`recover()` 仍不抛且文件保留，符合“下轮再试”的约定。
- `daemon/tests/sessions-clear.test.ts:981-1005`：回归先构造普通文件根，断言 `createShareBundle()` 抛 `ENOTDIR|EEXIST|ENOENT`；随后断言 `recover()` 不抛、根文件已删除，并再次发布成功且 `bundle.json` 与一条 `results` 行存在。
- 独立重跑真实 ENOTDIR 探针（临时数据根、关闭数据库后重开服务）：输出 `publishError=ENOTDIR`、`recovered=true`、后续 bundle publicId 存在、`resultRows=1`。这覆盖了 R3 探针的关库/重开边界，不只是在同一对象上调用恢复。
- 独立重跑 `pnpm -C daemon exec vitest run tests/sessions-clear.test.ts`：1 file，30/30 通过；聚焦用例单独运行：1 passed，29 skipped。
- 独立重跑 `pnpm -C daemon run typecheck`：通过；`git diff --check bd51881..b7eb0d1`：通过。

### 自愈边界审查

- 不会把合法 `results` 根目录当异常文件删除：只有 `rootIsDir === false` 才走 `unlinkSync(resultsRoot)`（`service.ts:361-367`）。目录型根继续走原有子目录扫描。
- 正常目录下，非目录子项直接跳过；有对应 `publicId` 的 bundle 目录在 `service.ts:369-376` 被保留；无行目录才由 `rmSync` 回收，删除失败局部吞掉（`:377-380`）。新增既有回归 `sessions-clear.test.ts:956-975` 独立验证“无行删除、有行保留”。
- 根文件 unlink 的 TOCTOU 失败（例如权限、竞态把目标变成目录）均只会进入 catch，不会掩盖 recover 主流程；实测不可写父目录时 `recoverError=none` 且根文件仍在。
- `statSync` 会跟随受信 `dataRoot` 下的符号链接；该信任边界与 R3 原有 `existsSync`/目录扫描行为一致，本 diff 未扩大删除范围。若未来 dataRoot 可被不可信本地用户篡改，应另行增加 `lstat`/realpath containment 防护，但不构成本轮 P1。

## P2

本 diff 未引入新的 P2。上述 symlink 防护属于受信数据根的边界增强项，可归 W4/安全加固，不阻断当前 W3 GO。R3/R2 已登记的其他 W4 风险不在本轮两文件定向修复范围内，本报告不重新升降级。

## 门禁与证据边界

- 本轮独立复跑：`sessions-clear.test.ts` 30/30、ENOTDIR 关库重开探针、unlink 失败探针、daemon typecheck、`git diff --check`。
- 协调方提供的修复后 daemon 181/181、e2e 3/3、smoke 基线一致等作为供给证据保留；本轮没有重复无关全量面。
- `openspec validate` 本轮未验证；当前环境的系统 `openspec` 不可用，不能把协调方 strict receipt冒充独立复跑。

## 评分与最终裁定

| 维度 | 评分 | 依据 |
|---|---:|---|
| results 根异常自愈 | 9.0/10 | 非目录守卫、unlink 失败隔离、真实重启探针和新增回归均通过 |
| 孤儿目录对账 | 8.5/10 | 无行目录删除、有行 bundle 保留，既有回归通过 |
| 证据完整度 | 8.0/10 | 定向 30/30、typecheck、两类手工探针；未重复无关全量面 |
| **W3 综合** | **8.0/10** | 相对 R3 +1.5；R3 阻断 P1 已消除，剩余项为 W4/边界增强 |

**W3 整体结论：GO。**
