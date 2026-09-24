# W4.1 实现评审：dsh 内核挂载、降级四态与 MCP 独立环回

## 开头自检

- `pwd`：`/Users/kzf/Pictures/贴钻-backend`
- `HEAD`：`38a7c8a8286ca90a0aac8108084ebf31ef0bc79d`（短 SHA=`38a7c8a`）
- `git merge-base --is-ancestor 6e4c3c2 HEAD`：exit `0`
- `git merge-base --is-ancestor 38a7c8a HEAD`：exit `0`
- 固定评审范围：`git diff 6e4c3c2..38a7c8a`，覆盖 65d0149、bf11ad6、8688353、3b53990、38a7c8a。
- 写入前 `git status --short`：空（工作树干净）。写入后复核应仅出现本报告文件。
- `git diff --check 6e4c3c2 38a7c8a`：通过，无输出。
- `pnpm exec openspec validate add-backend-platform --strict`：未验证。环境中 `VP_BYPASS` 已设置但 PATH 无系统 `openspec`，命令 exit `1`：`vp: VP_BYPASS is set but no system 'openspec' found in PATH`。

## 结论

- P0：无。
- P1：3 项，均影响 W4.1 GO：MCP `unbooted` 窗口放行、token 文件重写不强制 0600、导入失败审计覆盖不完整。
- P2：1 项：`AggregateError.errors` 未纳入缺包分类。
- 评分：`6.5/10`
- 判定：`NO-GO`。四态所需测试场景均通过，但安全降级门、token 权限和失败分类仍未达到冻结契约；修复后需重跑四态 E2E、MCP listener、kernel live，并补 strict validator。

## P1

### P1-1 MCP 降级门错误放行 `unbooted`

证据：`daemon/src/mcp.ts:105-116` 的判断把 `unbooted` 与 `booting/ready` 一并放行；冻结语义只规定终态 `off/missing/error` 返回 501，`booting/ready` 放行。`daemon/src/index.ts:74-91` 明确先 `mcp.listen()`、后 `kernel.boot()`，因此 `unbooted` 是可命中的启动窗口。直接探针用合法 Bearer 请求该状态，返回 `unbooted_status=200`。现有 `daemon/tests/mcp.test.ts:143-163` 仅覆盖 `off/missing/error` 与 `booting/ready`，没有 `unbooted` 断言。

影响：内核尚未开始 boot 时，MCP handler 已可执行，违反“仅 booting/ready 放行”的降级边界。应改为 `unbooted` 501，或在协议上明确并证明该状态永不可达。

### P1-2 已存在 `mcp-token` 的权限不会被收敛到 0600

证据：`daemon/src/mcp.ts:71-74` 以 `writeFileSync(..., { mode: 0o600 })` 覆写 token；POSIX 下 `mode` 只在创建文件时生效，已有文件权限不变。直接探针先创建 0644 文件，再 `listen()`，结果为 `mode=644`，内容虽已轮换但仍对组/其他用户可读。

影响：进程周期 Bearer secret 落盘面可因历史文件、人工创建或部署迁移遗留为 0644，扩大本地账户读取面，和注释声明的“0600”不符。写入后必须显式 `chmod(0o600)`，并补已有文件回归测试。

### P1-3 导入失败审计不能覆盖所有半死树形态

证据：`daemon/src/kernel/boot.ts:194-221` 的二次审计只将 `entry.fiber === undefined` 视为 import failure。上游 `@deepseek-ai/dsh-app-boot` 在 `node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2440-2488` 明确区分：无 fiber（failed to import）、`FIBER_FAILED`（激活失败）和 `FIBER_PENDING`（等待服务）；内部 `auditStartupEntries` 对 optional 失败只 warning，仍可返回 ctx。当前 E2E 仅以 required `@deepseek-ai/dsh-agent-loop` 做整包缺失/入口语法破坏，无法证明 optional `FIBER_FAILED/PENDING` 会被归入 missing 或阻止 ready。

影响：模块已导入但初始化失败的 optional entry 仍可能让 daemon 进入 `ready`，工具/服务树半死而 followup 可用，和“boot 后 import 失败审计恒 0、防半死树”的目标不充分一致。需明确 required/optional 策略并补 optional 失败探针。

## P2

### P2-1 缺包分类器遗漏 `AggregateError.errors`

证据：`daemon/src/kernel/boot.ts:270-282` 只检查当前错误的 `code/message` 与递归 `cause`，不遍历 `AggregateError.errors`。上游 app-boot 在 `node_modules/@deepseek-ai/dsh-app-boot/lib/index.js:2417-2433` 会递归格式化 `AggregateError.errors`。直接探针：`AggregateError([Error(code=ERR_MODULE_NOT_FOUND)])` 传入 `isModuleResolutionFailure` 返回 `false`；只有把该错误放入 `cause` 才返回 `true`。

影响：特定 loader 聚合错误形态会被误判为态③ `error` 而非态② `missing`。补 errors 递归并增加分类测试即可。

## 审查面逐项裁定

| 审查面 | 裁定与证据 |
|---|---|
| 四态 ②：隔离解析根与受害者 | `boot.ts:169-192` 将 `DSH_MODULE_ROOT` 转为 `bareModuleBaseUrl`，并在 E2E 中隔离裸包解析根；`daemon/tests/e2e-kernel.test.ts:339-369` 的整包缺失和入口语法破坏均通过，5/5 E2E 全绿。隔离根机制本身 PASS；但导入审计对 optional failed/pending 不完整，故四态整体 BLOCKED。 |
| 四态 ①/③/④ | `kernel.test.ts` 覆盖 off/error；`kernel-live.test.ts` 使用本地 mock openai-completions 网关验证真实 boot/followup/MCP 工具链；`e2e-kernel.test.ts` 覆盖 normal 端到端。测试通过，但每次真实 boot 有已登记的 typert-loader inactive + `AggregateError` warning，不能把 warning 当作无噪声健康证据。 |
| MCP 绑定/连接双层强制 | `mcp.ts:63-97` 的非 loopback 绑定拒绝、remoteAddress 403、IPv4/IPv6/IPv4-mapped 判定均通过 `mcp.test.ts` 8/8。MCP 独立端口与主 HTTP 隔离也在 E2E 通过。降级 gate 见 P1-1；token 文件权限见 P1-2，整体 FAIL。 |
| 官方 boot/profile/persona 移植保真度 | `boot.ts:94-192` 保留 shufa 的 `initProfile/resolveProfileDir/loadProfile/healProfilesModuleFallback/completeTransitiveMirror/boot` 路径，改为 handicraft preset 与 `kernel/persona.md`；正常 live boot 通过。四态差集增加了自定义审计，但 P1-3、P2-1 显示分类语义尚未完全保真。 |
| W3 冻结面 | PASS。`daemon/src/kernel/sessions.ts:120-123` 帧提交统一走 `jobs.emitFor`；`daemon/tests/sessions-rpc.test.ts` 只有 4 行文案/断言适配，无 clear 状态机、writer fence 或 `approved_ops` 结构回归。`pnpm -C daemon exec vitest run tests/sessions-rpc.test.ts tests/kernel.test.ts` 为 22/22。W3 既有 late-turn/orphan 等 out-of-scope/已接受项未重开。 |
| firehose schema 裁剪 | `firehose-events.ts` 将消费面裁剪至本仓 transcript/tool/done/error 词汇；现有投影单测和 live 帧链通过，未发现丢失本仓契约必需帧类的证据。保留对上游事件族的裁剪边界，后续需以真实生产事件样本补充。 |
| MCP 工具注册时序与诊断投影 | live 测试显式等待 `mcp__studio__*` 再 followup；约 1 秒注册窗口已登记为 backlog。`debugToolNames()` 通过 SessionService 内部 deps 结构投影，属于诊断面脆弱性，不作为本次 P1。 |
| allowBuilds 五项与 dsh 原生件 | `pnpm-workspace.yaml:5-12` 禁用 `dsh-subprocess-local`、`@google/genai`、`koffi`、`node-pty`、`protobufjs` 构建，当前 daemon boot/live 无回归；但 node-pty/koffi 是 dsh 原生 subprocess 能力，禁行会把该能力留在部署边界之外，需文档化安装/平台后果。归 W4 backlog/边界，不作为本波 boot blocker。 |

## 已登记五项问题分级（与本次新增 P1/P2 分开）

1. dsh-base alpha 生态噪声（1 inactive entry + typert `AggregateError`）：`W4 backlog / P2`。当前独立 kernel/live 输出均复现 warning；不阻止现有测试，但不能宣称零噪声健康 boot。
2. MCP 工具注册约 1 秒时序窗：`W4 backlog / P2`。生产用户 followup 通常晚于 boot，测试已显式等待；仍需正式 ready 信号或注册栅栏。
3. `debugToolNames` 结构投影读取 SessionService 内部 deps：`W4 backlog / P2`。仅诊断/测试面，运行主链未受影响。
4. 隔离解析根对 bundle patch 不可见：`W4 backlog / P2 / 测试夹具边界`。本次破坏对象是行包 `dsh-agent-loop`，②a/②b 两个 E2E 均通过；不否定已验证的两类入口故障，但不代表 bundle patch 缺失可被同一缝覆盖。
5. `allowBuilds` 禁止 node-pty/koffi 等原生构建：`W4 backlog / 部署边界`。当前工具 deny-list 与 boot 不依赖这些能力；发布前必须记录平台预构建、安装脚本和原生 subprocess 能力的实际后果。

## 独立测试证据

- `pnpm -C daemon exec vitest run tests/kernel.test.ts`：14/14 passed。
- `pnpm -C daemon exec vitest run tests/e2e-kernel.test.ts`：5/5 passed。
- `pnpm -C daemon exec vitest run tests/mcp.test.ts`：8/8 passed。
- `pnpm -C daemon exec vitest run tests/sessions-rpc.test.ts tests/kernel.test.ts`：22/22 passed。
- `pnpm -C daemon exec vitest run tests/kernel-live.test.ts`：5/5 passed。
- 上述 kernel/kernel-live 实跑均打印同一已登记 warning：`handicraft: warning: 1 entry did not activate`，内部为 typert-loader 两个 codec `AggregateError`。
- `git diff --check 6e4c3c2 38a7c8a`：通过。
- strict OpenSpec validator：未验证，原因见开头自检。

## GO 决策

`NO-GO`（6.5/10）。修复 P1-1/P1-2/P1-3 与 P2-1，补齐 unbooted、已有 token 权限、optional activation failure、AggregateError 分类测试，并在可用环境重跑 strict OpenSpec validator 后再评审。
