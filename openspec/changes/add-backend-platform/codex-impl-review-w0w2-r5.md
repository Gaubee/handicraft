# add-backend-platform W0-W2 实现评审 R5

评审范围：`git diff 1898307..b601577`，当前 `HEAD=b601577`，分支
`add-backend-platform-impl`。工作区路径、自检祖先关系和提交均符合要求；`git diff --check`
通过。除本报告外未修改其他文件。

## 结论与评分

**NO-GO，7.6/10（R4 7.4，+0.2）。** R4 暴露的配置密钥值字段逃逸已通过统一终门收口：成功
结果和 typed error 的 debug 树均经 `deepReplaceSecret`，短特殊字符 `x:y` 已真实替换；401
测试的 `frames.jsonl` 双断言也已恢复。但对“任何 debug 字段均不得出现配置密钥字符串”的
不变量继续做结构化 adversarial 扫描时，发现第五条同族 P1：`deepReplaceSecret` 只替换
对象/数组的字符串值，不替换对象键名；上游响应可以把配置密钥放进 JSON 属性名，最终
`debug.json.parsedResponse` 仍落盘明文。因此全部 P1 仍未闭合，不能 GO。

## 逐项判定

| 项 | 判定 | 证据与结论 |
|---|---|---|
| P1-1 disabled 禁写 | **已闭** | 本轮未回退；沿用此前 `requireActiveUser` 四写端点、disabled 读成功/写拒绝及零变化覆盖。 |
| P1-2 帧三一致性 | **已闭** | 本轮未回退；沿用 append 失败上抛、先落盘后递增/广播及实时流/jsonl/回放一致性测试。 |
| P1-3 WS URIError | **已闭** | 本轮未回退；沿用 URIError 400、IdSchema 与真实进程探活回归。 |
| P1-4 输入/PNG 上限 | **已闭** | 本轮未回退；沿用 base64 前置门、PNG 64MP/96MB/maxOutputLength 和压缩炸弹负向覆盖。 |
| P1-5 脱敏/持久化 | **未闭，P1** | R4 的字符串值/异常路径已闭；JSON 对象键名仍可带配置密钥并进入 `debug.json.parsedResponse`，见下文。 |
| P1-6 adapter/active attempt | **已闭** | 本轮未回退；沿用运行时引擎 fixture、真实 layout/单调性、partial unique index 与双连接 claim 覆盖。 |
| P2-1 二段下载 SSRF | **部分闭，按声明保留** | 本轮未改 DNS rebinding/TOCTOU、IPv4-mapped IPv6 和特殊地址段；仍是条件性 SSRF P2。 |
| P2-2 取消/订阅泄漏 | **已闭** | 本轮未回退；沿用空 Set 删除、AbortSignal 到达 fetch、无孤儿 blob 覆盖。 |
| P2-3 after_seq | **已闭** | 上轮已加入 `MAX_SAFE_INTEGER` 边界实现和真实 WS 自动化断言；本轮未回退。 |
| P2-4 格式解析/往返 | **部分闭，按声明保留** | 本轮未改 opaque persistence 边界；四族 envelope/篡改拒绝通过，但未验证 persistence parser/projection/reconstruction。 |

## R4 反例与 x:y 终门复现

R4 两条已知反例均继续通过：

1. 上游 200 返回非法下载 URL `not-a-url-sk-live-secret-9876`：任务失败，`task.error` 与
   `frames.jsonl` 无明文 key；错误中为 `***` 形态。
2. 上游 200 返回 `data[0].b64_json = sk-live-secret-9876`：任务成功，`debug.json` 无明文
   key 且包含 `***`。

指定 401 回显也通过：上游 401 返回 `rejected sk-live-secret-9876` 后，`task.error` 与
`frames.jsonl` 均无明文，恢复后的 `daemon/tests/generate.test.ts:179-183` 同时断言
`frames.jsonl` 不含明文且含 `***`。

R5 的短密钥成功路径独立复现通过：配置 key=`x:y`，prompt=`x:y`，上游返回合法
`b64_json`；落盘 `debug.json` 的 endpoint、requestBody、responseStatusText、
responseContentType、parsedResponse、responseBodyText 均不含 `x:y`，并出现 `***`。这证明
`callImagesApi` 成功出口的 `deepReplaceSecret`（`daemon/src/imgapi/client.ts:164-224`）确实
覆盖了 R4 暴露的值字段；typed error 也在同一出口处理。

## 新发现：对象键名逃逸（P1）

`deepReplaceSecret`（`client.ts:202-220`）遍历对象时只处理 `v`：

```ts
if (typeof v === 'string') {
  object[k] = replaceConfiguredSecret(v, apiSecret);
} else {
  deepReplaceSecret(v, apiSecret);
}
```

`k` 从未经过 `replaceConfiguredSecret`。上游可以返回 JSON：

```json
{"data":[{"b64_json":"ZmFrZQ==","x:y":"marker","nested":{"x:y":"marker2"}}]}
```

独立 `callImagesApi` 复现中，`JSON.stringify(result.debug)` 仍包含两个 `"x:y"` 键；进一步
跑完整真实任务后，`debug.json` 状态为 `done` 且 `debugHasKey=true`，明文存在于
`debug.parsedResponse`。同一响应的 `responseBodyText` 已把字符串形式的键替换为 `***`，
说明当前漏洞正是 debug 对象树原地脱敏只覆盖值、不覆盖键。

这不是非 JSON 边界或循环引用的理论问题，而是响应 JSON 的合法键名路径，直接违背本轮
声明的“配置密钥字符串不出现在任何持久化 debug 字段”不变量，故保持 **P1**。修复应在
递归构造/原地遍历时同时替换对象键名，或在最终持久化前对结构化 debug 做键和值的统一
重建；并补充对象键名 adversarial 文件级测试。

## 实现质量与 Standards

R5 的结构性终门明显优于逐点追堵：成功结果和异常 debug 双路径统一处理，且恢复了 401
帧文件级回归；`replaceConfiguredSecret` 仍是共享原语。未发现新的硬性编码规范违规。
仅有低影响质量项：`deepReplaceSecret` 使用原地递归和 `as Record<string, unknown>` 类型
断言，适用于当前 JSON-like debug 树但没有循环/Map/Set 语义；这不是本轮 P1。

## 独立门禁

- contracts：`pnpm -C contracts exec vitest run`，**4 files，39/39 tests passed**。
- daemon：`pnpm -C daemon exec vitest run`，**21 files，131/131 tests passed**。
- daemon E2E：`pnpm -C daemon run test:e2e`，**2 files，3/3 tests passed**。
- engine smoke：`pnpm -C daemon run smoke:engine`，**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- daemon typecheck：`pnpm -C daemon run typecheck`，**0 errors**。

## 最终判定

R4 的值字段泄漏和 401 测试覆盖回退已修复；P1-1、P1-2、P1-3、P1-4、P1-6 以及 P2-3
继续闭合。但对象键名逃逸是新的 **P1-5**，因此当前结论为 **NO-GO（7.6/10）**。在
结构化 debug 的键和值都经过配置密钥替换、并补齐对应 adversarial 回归前，不能给 GO。
