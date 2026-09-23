# add-backend-platform W0-W2 实现评审 R3

评审范围：`git diff da899ee..23931f0`，当前 `HEAD=23931f0`，分支
`add-backend-platform-impl`。路径、HEAD、祖先和干净工作区自检通过；`git diff --check`
通过。除本报告外未修改其他文件。

## 结论与评分

**NO-GO，7.5/10（R2 7.0，+0.5）。** 指定的 401 回显 key 路径已闭，after_seq 上限行为也经真实 WS probe 验证；但 P1-5 整体仍未闭：下载分支的 `ImageApiError` 可绕过新 masker，另外 `b64_json`/`data` 特殊字段分支跳过配置密钥替换，可将同一个配置 key 分别写入任务错误面和 `debug.json`。因此尚未满足“全部 P1 闭”门槛。本轮没有新增 P0；原 P1-5 仍是阻塞项。

## 逐项核对

| 项 | 判定 | R3 证据与结论 |
|---|---|---|
| P1-1 disabled 禁写 | **已闭（沿用 R2）** | `daemon/src/rpc.ts` 四写端点均绑定 `requireActiveUser`；R2 的 `rpc.test.ts` 覆盖禁用后读成功、四写拒绝及存储零变化。本轮无相关改动。 |
| P1-2 帧三一致性 | **已闭（沿用 R2）** | `daemon/src/jobs/service.ts` append 成功后才递增/广播；R2 的 `frame-consistency.test.ts` 覆盖中途及首帧 append 失败、实时流/jsonl/回放一致。本轮无相关改动。 |
| P1-3 WS URIError | **已闭（沿用 R2）** | URIError 兜底、IdSchema 与真实进程 400 后探活回归仍在；本轮无相关改动。 |
| P1-4 输入/PNG 上限 | **已闭（沿用 R2）** | base64 前置门、PNG 64MP/96MB/maxOutputLength 和压缩炸弹负向测试均未回退；四门禁本轮通过。 |
| P1-5 脱敏/持久化 | **指定 401 路径已闭；整体 P1 未闭** | 新增 `daemon/tests/generate.test.ts:156-183` 覆盖指定链路。独立复现 `sk-live-secret-9876` → HTTP 401 后，`task.error` 与 `frames.jsonl` 均无明文、均含 `***`。但仍有两条反例，见“P1-5 残余”。 |
| P1-6 adapter/active attempt | **已闭（沿用 R2，边界已标明）** | adapter 运行时对照真实引擎、五策略 layout 和单调性测试仍通过；active partial unique index 落地。跨连接 claim 注释现在如实说明是顺序发起，不再声称并发调度测试；DB 唯一索引仍是原子约束。contracts 不直接 import 引擎是既有独立包边界。 |
| P2-1 二段下载 SSRF | **仍部分闭，按声明留作后续项** | R3 未改 DNS 检查/实际 fetch 的 TOCTOU，也未补齐压缩 IPv4-mapped IPv6、100.64/10 等特殊范围。保留 P2 条件性 SSRF；不要求本轮扩 scope，但在这些边界解决前不得宣称 SSRF 完全闭合。 |
| P2-2 取消/订阅泄漏 | **已闭（沿用 R2）** | 空订阅 Set 删除、cancel/stop AbortSignal、真实 fetch abort 和无孤儿 blob 测试仍有效。 |
| P2-3 after_seq | **实现已闭；自动化边界测试缺一例** | `daemon/src/http.ts:202-210` 对大于 `MAX_SAFE_INTEGER` 的十进制游标拒绝 400。独立启动真实 WS 服务传 `9007199254740992`，握手得到 400。现有 `ws-e2e.test.ts:265-287` 覆盖负数/尾随/浮点/空值，但未加入这个新上限的持久回归断言，建议补测。 |
| P2-4 格式解析/往返 | **仍部分闭，按声明留作后续项** | 四族 envelope/字段 fixture 和篡改拒绝测试维持 R2 状态；`formats.ts` 仍 opaque 保存/回放，未过 persistence parser/projection/reconstruction。按本轮明确的后续波次边界不扩 scope；若仍以 spec 的 resource-model 语义投影作为 W0-W2 验收，则该项仍未闭。 |

## P1-5 残余

1. **下载 typed error 绕过 masker，密钥落入 task/error 帧。** `daemon/src/imgapi/client.ts:310-312` 对 `ImageApiError` 直接 rethrow，跳过后续 `maskSecretsInText`。`downloadImageData()` 的非法 URL 错误会包含原 `urlText`（`:426-430`），重定向错误也会包含 Location（`:459-466`）。最小真实任务复现：上游 200 返回 `data[0].url = "not-a-url-sk-live-secret-9876"`，任务失败后 `task.error` 和 `frames.jsonl` 均包含明文 key。故“下载失败异常 message 必经 masker”尚不成立。
2. **`parsedResponse` 的特殊字符串键绕过密钥替换，密钥落入 debug.json。** `sanitizeDebugValue(value, apiSecret)` 对普通字符串会调用 `maskSecretsInText`，但 `b64_json`/`data` 字符串走 `truncateDebugString(nested)` 旁路（`client.ts:97-109`）。最小成功任务复现：上游 200 返回 `data[0].b64_json = "sk-live-secret-9876"`；任务成功，落盘 `debug.json.parsedResponse` 仍含完整配置 key，而 `responseBodyText` 已显示 `***`。这正是 configured API key，不属于“其他非本密钥凭据形态”的已接受边界。

建议让所有 `ImageApiError` 的消息在外层统一应用密钥/凭据脱敏，并让特殊字段截断前也先经过同一文本 masker；补充非法 URL/重定向和 `b64_json`/`data` 回显的文件级负向测试。修复前 P1-5 不可判整体关闭。

## 附带修复与剩余 P2

- P2-3 的实现经真实 WS probe 验证；缺少 `> MAX_SAFE_INTEGER` 自动化断言，是剩余回归覆盖缺口。
- P2-1 DNS rebinding/地址分类与 P2-4 opaque persistence 仍开放；本轮明确声明为后续项，不要求扩写本轮修复，但均保留为未闭 P2。
- `paving-adapter.test.ts` 已把错误的 `not.toThrow(/未知/)` 改为契约面诚实的 `not.toThrow()`；未知 block ID 的运行时拒绝仍由 `engine.test.ts` 的 `ghost-block` 用例负责。
- claim 测试注释已改为“跨连接顺序发起+唯一索引原子仲裁”，描述与实际执行一致；这不是并发时序测试。
- 其他不属于配置 API key、且不匹配 ≥16 字符 token 形态的上游凭据，按本轮给定范围作为已声明脱敏边界；上述两个 configured-key 反例不在该豁免内。

## 独立复跑四门禁

- `pnpm -C contracts exec vitest run`：**4 files，39/39 tests passed**。
- `pnpm -C daemon exec vitest run`：**21 files，128/128 tests passed**。
- `pnpm -C daemon run test:e2e`：**2 files，3/3 tests passed**。
- `pnpm -C daemon run smoke:engine`：**PASS**，`gemCount=68，dropped=0，svgBytes=3040，bomBytes=103`。

## Standards

未发现违反全局编码规则的硬性问题。一个低影响 Fowler 启发式是 `client.ts` 的配置密钥字面替换在 `maskSecretsInText` 与 `sanitizeBodyText` 中重复；可共用脱敏原语，但不是本轮阻塞项。

## Spec

R3 指定的 401/task/error-frame 路径符合预期；但实际下载 `ImageApiError` 控制流和 `b64_json` 特殊字段绕过仍违反 P1-5 密钥不落盘要求。after_seq 大值行为已过真实握手验证；DNS 与格式边界按用户给定范围保留 P2。

Standards 轴：1 个低影响重复逻辑启发式，无硬性违规；Spec 轴：1 个阻塞 P1-5 残余，最坏问题为配置 API key 仍可持久泄漏。
