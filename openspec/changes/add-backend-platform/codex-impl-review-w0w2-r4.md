# add-backend-platform W0-W2 实现评审 R4

评审范围：`git diff 23931f0..1898307`，当前 `HEAD=1898307`，分支
`add-backend-platform-impl`。工作区路径、自检祖先关系和提交均符合要求；`git diff --check`
通过。除本报告外未修改其他文件。

## 结论与评分

**NO-GO，7.4/10（R3 7.5，-0.1）。** R3 报告中的两个已知 P1-5 绕过均已真实闭合：下载 typed
error 的统一出口脱敏生效，`b64_json`/`data` 的先截断后脱敏生效；`after_seq` 也补上了
`MAX_SAFE_INTEGER` 自动化边界。然而对“所有 debug 落盘字段”的独立扫查发现同族新 P1：
`requestBody`、`endpoint`、`responseStatusText`、`responseContentType` 仍可绕过配置密钥兜底，
其中短/特殊形态配置 key 已真实落入 `debug.json`。此外，R3 的 401 回归测试删除了原有
`frames.jsonl` 文件读取和断言，形成测试覆盖退化。因此全部 P1 尚未闭合，不能 GO。

## 逐项判定

| 项 | 判定 | 证据与结论 |
|---|---|---|
| P1-1 disabled 禁写 | **已闭** | 本轮未回退；沿用 R2/R3 的 `requireActiveUser` 四写端点和 disabled 读成功/写拒绝覆盖。 |
| P1-2 帧三一致性 | **已闭** | 本轮未回退；沿用 append 失败上抛、先落盘后递增/广播及实时流/jsonl/回放一致性测试。 |
| P1-3 WS URIError | **已闭** | 本轮未回退；沿用 URIError 400、IdSchema 和真实进程探活回归。 |
| P1-4 输入/PNG 上限 | **已闭** | 本轮未回退；沿用 base64 前置门、PNG 64MP/96MB/maxOutputLength 和压缩炸弹负向覆盖。 |
| P1-5 脱敏/持久化 | **未闭，P1** | R3 两条绕过已闭，但新增 debug 字段同族绕过仍可将配置 key 写入 `debug.json`，见下文。 |
| P1-6 adapter/active attempt | **已闭** | 本轮未回退；沿用运行时引擎 fixture、真实 layout/单调性、partial unique index 与双连接 claim 覆盖。 |
| P2-1 二段下载 SSRF | **部分闭，按声明保留** | 本轮未改 DNS rebinding/TOCTOU、IPv4-mapped IPv6 和特殊地址段；仍是条件性 SSRF P2，不升级本轮范围。 |
| P2-2 取消/订阅泄漏 | **已闭** | 本轮未回退；沿用空 Set 删除、AbortSignal 到达 fetch、无孤儿 blob 覆盖。 |
| P2-3 after_seq | **已闭** | `daemon/src/http.ts:202-210` 拒绝超过 `Number.MAX_SAFE_INTEGER`；`daemon/tests/ws-e2e.test.ts:280-282` 真实断言 `9007199254740992 -> 400`、`9007199254740991 -> 101`。 |
| P2-4 格式解析/往返 | **部分闭，按声明保留** | 本轮未改 opaque persistence 边界；四族 envelope/篡改拒绝仍通过，但未验证 persistence parser/projection/reconstruction。 |

## P1-5 R3 反例复现

两条 R3 反例均独立复跑通过：

1. 上游 200 返回 `data[0].url = "not-a-url-sk-live-secret-9876"`：任务失败，`task.error`
   为 `结果图 URL 非法：not-a-url-***`，`frames.jsonl` 无 `sk-live-secret-9876` 且有 `***`。
2. 上游 200 返回 `data[0].b64_json = "sk-live-secret-9876"`：任务成功，`debug.json`
   无明文 key 且包含 `***`。

指定 401 路径也复跑通过：上游 401 回显 `sk-live-secret-9876` 后，`task.error` 与
`frames.jsonl` 均无明文，错误中出现 `***`。统一外层 `callImagesApi` 出口位于
`daemon/src/imgapi/client.ts:164-190`，因此下载 `ImageApiError` 和普通网络异常的 message
均会经过 masker；特殊 `b64_json`/`data` 分支位于 `:97-109`，已改为先截断后脱敏。

## 新发现：debug 全字段仍有 P1 泄漏面

`daemon/src/imgapi/client.ts:278-280` 的 `createDebug(endpoint, requestBody)` 调用
`sanitizeDebugValue(requestBody)` 时没有传入 `apiSecret`。`daemon/src/jobs/generate.ts:119-120`
随后对整个 `debugRecord` 原样 `JSON.stringify` 落盘。因此配置 key 若不是被
`TOKEN_RUN_RE` 偶然匹配的长串，仍会原样进入 `debug.json.requestBody`；这不是 R3 两个
特殊字段反例所覆盖的面。

独立真实任务复现：配置 `img_api_key = x:y$z`，prompt 同为 `x:y$z`，上游返回合法
`b64_json`；任务状态为 `done`，但 `debug.json.requestBody.prompt` 仍为 `x:y$z`，文件中
存在完整配置 key。该结果证明“配置密钥本体在所有 debug 落盘字段均被兜底替换”尚未成立。

同一问题还存在于未经过文本 masker 的字段：

- `client.ts:278-279` 的 `endpoint` 和 `requestBody`；
- `client.ts:293-295` 直接写入的 `responseStatusText` 与 `responseContentType`，若上游将配置 key
  回显到状态文本或 header，也会随 `debug.json` 原样持久化。

这与 R3 已闭的 `parsedResponse`、`responseBodyText`、错误 message 不是不同安全要求，而是
同一个“任何 debug 落盘字段不得包含 configured secret”的 P1-5 不变量，故不能宣称整体收口。

## 测试质量回退

`daemon/tests/generate.test.ts:179-181` 的原 401 回归在本轮 diff 中从读取并断言
`frames.jsonl` 变为只计算 `framesPath` 后直接进入 `finally`；标题仍声称验证帧持久面。
新增的非法 URL 用例确实补了 `frames.jsonl` 负向断言，但没有恢复 401 路径自身的文件级断言，
定为 P2 测试覆盖退化，不改变新 P1 的安全结论。

## 独立门禁

- contracts：`pnpm -C contracts exec vitest run`，**4 files，39/39 tests passed**。
- daemon：`pnpm -C daemon exec vitest run`，**21 files，130/130 tests passed**。
- daemon E2E：`pnpm -C daemon run test:e2e`，**2 files，3/3 tests passed**。
- engine smoke：`pnpm -C daemon run smoke:engine`，**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- daemon typecheck：`pnpm -C daemon run typecheck`，**0 errors**。

## 实现质量

本轮把 R3 暴露的两个具体绕过改成了更可靠的 `callImagesApi` 统一异常出口，并把特殊字段
改为“先截断后脱敏”；这两处实现和对应文件级反例测试有效，after_seq 边界也形成了真实 WS
回归。`replaceConfiguredSecret` 抽取消除了此前重复原语，未发现新的硬性编码规范违规。
但 debug 记录仍采用“构造时部分脱敏、落盘时原样序列化”的分散模型，导致请求面和响应元信息
字段漏过统一不变量；同时删除既有 401 帧断言削弱了回归证据。

## 最终判定

P1-1、P1-2、P1-3、P1-4、P1-6 已闭，P2-3 已闭；R3 两条 P1-5 反例和指定 401 路径均已
验证通过。但新发现的 configured-secret debug 全字段泄漏仍是 **P1**，所以当前结论为
**NO-GO（7.4/10）**。修复前不能给 GO；需让 `endpoint`、`requestBody`、状态文本/响应头等
所有写入 `ImageTaskDebug` 的字段共享配置密钥 masker，并恢复 401 用例的 `frames.jsonl` 文件级断言。
