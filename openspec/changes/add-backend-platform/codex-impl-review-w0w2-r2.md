# add-backend-platform W0-W2 实现评审 R2

评审范围：`git diff 0ed750c..HEAD`，当前 `HEAD=da899ee`，分支
`add-backend-platform-impl`。祖先断言、路径、分支及工作区自检均通过；`git diff
--check 0ed750c..HEAD` 通过。除本报告外未修改其他文件。

## 结论与评分

**NO-GO，7.0/10（上轮 5.0/10，+2.0）。** P1-1 至 P1-4、P1-6 的生产实现已闭；P1-5 的 debug 文件成功路径已修，但失败响应中的原始密钥仍能经 error message 落入任务 DB 与 `frames.jsonl`，所以六项 P1 未全部闭合。本轮无新 P0/P1；另有 5 项 P2 残余/测试证据问题。评分显著上升，但按“全部 P1 闭且无新 P1”门槛仍必须 NO-GO。

## 逐项核对

| 项 | 判定 | 实现与独立证据 |
|---|---|---|
| P1-1 disabled 禁写 | **已闭** | `daemon/src/rpc.ts:64-71,126-134,138-168,182-193` 用 `requireActiveUser` 绑定 upload/create/cancel/import，读面仍用 `requireAuth`。`daemon/tests/rpc.test.ts:169-224` 验证 disabled 用户 bootstrap/list/get 成功、四写端点 `FORBIDDEN`，tasks/blobs/resources 零变化。 |
| P1-2 帧三一致性 | **已闭** | `daemon/src/jobs/service.ts:222-239` 固定 append→seq→broadcast，append 异常上抛；`daemon/tests/frame-consistency.test.ts:73-138` 注入中途/首帧写失败，核对实时帧、`frames.jsonl`、afterSeq 回放和 failed 收敛。 |
| P1-3 WS URIError | **已闭** | `daemon/src/http.ts:130-147` 捕获畸形 `%`、过 `IdSchema` 后才升级；`daemon/tests/e2e-full.test.ts:145-162` 真实子进程对 `/ws/tasks/%` 得到 400，随后 `/api/bootstrap` 成功且子进程仍存活。 |
| P1-4 输入/PNG 上限 | **已闭** | `daemon/src/rpc.ts:112-123` 在 base64 解码前后双门，upload/import 共用；`daemon/src/png/codec.ts:139-167` 具备 64MP、96MB IDAT、`maxOutputLength` 三重限制。`daemon/src/png/codec.test.ts:114-158` 覆盖超像素、压缩炸弹、巨 IDAT，`daemon/tests/rpc.test.ts:229-300` 覆盖匿名输入拒绝和真实 pave 炸弹失败/进程存活。 |
| P1-5 debug 脱敏/顺序 | **部分闭；P1 未闭** | `daemon/src/imgapi/client.ts:97-131,257-265` 对 JSON 递归脱敏、非 JSON token 打码并做密钥兜底；`daemon/src/jobs/generate.ts:93-120` 在 `provider.result` 后读取真实 debug，修复 fallback 顺序。字段级及成功 `debug.json` 文件断言通过。但 `parsedResponse.error.message` 不属于敏感键名，未被 `sanitizeDebugValue` 改写；`readApiErrorMessage()` 又把原文拼进异常，JobService 随后持久化到 task params/error 帧。最小真实任务复现确认密钥进入 `tasks.get().task.error` 与 `frames.jsonl`。这仍是原 P1 的上游响应密钥持久泄漏，只是从 debug.json 转到了错误路径。 |
| P1-6 adapter/active attempt | **实现已闭；测试有边界** | `daemon/src/jobs/engine.ts:63-85` 以 `paveArgsOf` 单点转换；`daemon/tests/paving-adapter.test.ts:64-124` 运行时 import 引擎 `STRATEGY_IDS`，五策略真实 `layout()`、确定性、密度单调和派生参数均通过。`daemon/src/db/schema.ts:163-171` 增加 active partial unique index，`daemon/src/db.test.ts:124-172` 用双连接验证唯一约束拒绝第二 claim；两次同步 insert 实际是先后执行，不是并发时序测试，但数据库唯一索引本身提供提交原子仲裁。`contracts` 仍手写镜像而不直接 import 引擎，但漂移在 daemon 测试中被可执行地发现，属于已声明的独立发布依赖折衷。 |
| P2-1 二段下载 SSRF | **部分闭** | 已有 https-only、逐跳 DNS 检查、同源重定向、流式上限和 signal（`daemon/src/imgapi/client.ts:395-487`；`daemon/tests/imgapi.test.ts:180-276`）。但 DNS 检查后 `fetchImpl(current)` 再按 hostname 解析（`:416-434`），仍有 rebinding/TOCTOU；压缩 IPv4-mapped IPv6（如 `::ffff:7f00:1`）及 `100.64.0.0/10` 等特殊段也未完整拒绝。因 URL 来自受信上游响应/配置，定 **P2 条件性 SSRF**，不升级为 P1。 |
| P2-2 取消/订阅泄漏 | **已闭** | `daemon/src/jobs/service.ts:153-168,202-212` cancel/stop abort，空 Set 删除订阅 key；`daemon/tests/frame-consistency.test.ts:142-243` 验证订阅表无残留、真实 generate fetch 收到 abort 且无孤儿 blob。 |
| P2-3 after_seq | **部分闭** | `daemon/src/http.ts:202-210` 已拒绝负数、浮点和尾随字符，但正则后直接 `Number()`，超长数字可成为 `Infinity` 或不安全整数，仍不等价 `TaskFramesInputSchema`（`contracts/src/tasks.ts:198-204`）的有限整数语义。定 **P2**，应加 `Number.isSafeInteger(afterSeq)`。 |
| P2-4 四族格式/篡改 | **部分闭** | `daemon/tests/formats.test.ts:121-260` 已覆盖四族 DB 行/meta/blob/envelope/已知字段和 kind/version/缺字段篡改拒绝，零残留断言有效。但 `daemon/src/formats.ts:96-120,123-143` 仍只保存并原样回放 blob，新增 fixture 字段没有经过 persistence parser/projection/reconstruction；提交已诚实声明该边界。因此原 P2 的 adversarial/元数据部分闭，资源模型语义验证仍是 **P2 未闭**，除非明确接受 W2 opaque resource 口径。 |

## 新发现

### P1-5 残余：错误消息绕过 debug 脱敏进入任务持久面

`daemon/src/imgapi/client.ts:267-273,314-320` 用未脱敏的 `parsed.error.message` 拼接 `ImageApiError.message`；`daemon/src/jobs/service.ts:124-136,248-253` 又把该 message 写入 error 帧和 task params。最小真实任务复现中，上游 401 回显 `sk-live-secret-9876` 后，`debug.responseBodyText` 已打码，但 `debug.parsedResponse`、异常 message、`tasks.get().task.error` 和 `frames.jsonl` 仍含明文 key。虽然要上游主动回显秘密才触发，但这是敏感凭据持久泄露，保留原 P1 严重度；应在任何 debug/error 持久化前对整棵响应和错误摘要统一脱敏，并加失败路径文件级断言。

### P2：adapter 测试中一条断言可假绿

`daemon/tests/paving-adapter.test.ts:135-139` 的
`not.toThrow(/未知/)` 并不证明未知 region ID 被拒；任意其他异常也能通过。生产路径
`daemon/src/jobs/engine.ts:150-156` 有明确拒绝逻辑，且 `daemon/tests/engine.test.ts:110-127` 独立验证了 `ghost-block` 失败，因此这是测试质量问题而非新的运行时 P1，但该 fixture 本身不能作为未知 ID 的有效证据。

### P2：双连接 claim 用例并非并发时序

`daemon/src/db.test.ts:159-168` 先同步执行 `claim(db, 'c1')`，再同步执行 `claim(db2, 'c2')`，没有重叠或 barrier；名称/注释中的“并发”不准确。partial unique index 已直接保证同 proposal 最多一个 active attempt，故不是实现缺陷，但这条用例只能证明跨连接唯一约束可见，不能单独证明并发 claim 路径的调度行为。

## 独立复跑四门禁

- `pnpm -C contracts exec vitest run`：**4 files，39/39 tests passed**。
- `pnpm -C daemon exec vitest run`：**21 files，127/127 tests passed**。
- `pnpm -C daemon run test:e2e`：**2 files，3/3 tests passed**。
- `pnpm -C daemon run smoke:engine`：**PASS**，`gemCount=68，dropped=0，svgBytes=3040，bomBytes=103`。

## 实现质量

本轮把上轮主要安全/一致性阻塞落到了单点守卫、write-through 帧存储、有界 PNG 解码、真实子进程回归和 SQLite partial unique index；测试不再只是 happy path。实现质量明显提升。剩余风险集中在外部 DNS 解析的地址绑定、HTTP 数值边界和格式资源层尚未真正解析投影；这些不影响本轮 GO 条件，但不应在后续报告中宣称为完全闭合。
