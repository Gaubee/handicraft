# add-backend-platform W0-W2 实现评审 R8

评审范围：`git diff c3ad6b0..6767dde`，当前 `HEAD=6767dde`，分支
`add-backend-platform-impl`。自检通过：工作区路径正确、`c3ad6b0` 及此前实现提交均为祖先；
`git diff --check` 通过。除本报告外未修改其他文件。

## 结论与评分

**NO-GO，7.2/10（R7 7.4，-0.2）。** R8 修复了 R7 指出的两条具体路径：
`generate.ts` 使用 `effective.apiKey.trim()`，`a***b` 的失败回显测试也已加入；但所谓
“marker 双向检查即可封死重组”的结构论证不成立。替换结果仍可通过 marker 的**部分前缀/后缀**与
相邻原文拼出密钥，并且上游可返回 Base64/percent 编码的凭据而绕过 exact-substring 终门。
这些路径已通过真实函数调用和真实任务文件复现，P1-5 仍未闭，不能 GO。

## 逐项判定

| 项 | 判定 | 证据与结论 |
|---|---|---|
| P1-1 disabled 禁写 | **已闭（回归通过）** | 沿用 `requireActiveUser` 四写端点、disabled 禁写/读成功及存储零变化覆盖；本轮未回退。 |
| P1-2 帧三一致性 | **已闭（回归通过）** | `JobService.emitFrame` 仍先 append，成功后才递增序号并广播；append 失败、实时流/jsonl/回放一致性继续通过。 |
| P1-3 WS URIError | **已闭（回归通过）** | URIError 400、IdSchema 和真实进程探活回归继续通过。 |
| P1-4 输入/PNG 上限 | **已闭（回归通过）** | base64 前置门、PNG 64MP/96MB/maxOutputLength 三重有界和压缩炸弹负向覆盖继续通过。 |
| P1-5 脱敏/持久化 | **未闭，P1** | R7 两个具体反例已修复，但 partial-overlap 可使密钥回到 `debug.json`；编码形态可把可恢复凭据写入 `parsedResponse/responseBodyText`；错误路径同样依赖未充分证明的终门。 |
| P1-6 adapter/active attempt | **已闭（回归通过）** | paving-adapter 运行时引擎 fixture/真实 layout/单调性、partial unique index 和双连接 claim 覆盖继续通过。 |
| P2-1 二段下载 SSRF | **部分闭，边界仍保留** | https、DNS 私网拒绝、同源重定向复验、流式上限、signal 继续通过；DNS rebinding TOCTOU、IPv4-mapped/100.64/10 等已声明边界本轮未改。 |
| P2-2 取消/订阅泄漏 | **已闭（回归通过）** | 空 Set 删除、AbortSignal 到达 fetch、无孤儿 blob 覆盖继续通过。 |
| P2-3 after_seq | **已闭** | `MAX_SAFE_INTEGER` 超界拒绝与安全边界自动化断言继续通过。 |
| P2-4 格式解析/往返 | **部分闭，边界仍保留** | 四族真实解析与 adversarial 篡改拒绝继续通过；opaque persistence parser/projection/reconstruction 仍是已声明边界。 |

## R7 反例复验

### 空格密钥

settings `img_api_key = "  x:y$z  "`、dry-run prompt=`x:y$z`、advanced.nested=`x:y$z`
的真实任务复验结果为 `done`；`debug.json` 与 `frames.jsonl` 均不含 `x:y$z`。当前
`generate.ts:120` 传入 `effective.apiKey.trim()`，与 `callImagesApi` 的
`settings.apiKey.trim()` 口径一致。该反例已闭。

### R7 的 `a***b` 重组

使用 settings key=`a***b`，注入网络异常文本 `upstream echoed aa***bb` 的真实任务复验结果为
`failed`；`task.error` 和 `frames.jsonl` 均不含 `a***b`。R7 载荷已闭，但它只覆盖 marker
整体出现在密钥中的情形。

## 完整对抗穷举与新 P1

### 1. 双向 marker 检查仍不是充分条件

R8 的实现是：

```ts
if (!candidate.includes(apiSecret) && !apiSecret.includes(candidate)) return candidate;
```

这只排除了 marker 整体是密钥子串或密钥整体是 marker 子串，并没有排除替换后密钥跨 marker 的
部分边界。可检验的最小反例：

```text
secret S = "a*"
input  T = "aa*"
marker M = "***"       // M 不含 S，S 不含 M，故 R8 仍选择 M
split(T, S).join(M) = "a***"
"a***".includes("a*") === true
```

直接调用当前导出的 `deepReplaceSecret` 得到：

```json
{"prompt":"a***"}
```

真实 dry-run job 也已复现：任务 `done`，`debug.json` 的 prompt 为 `"a***"`，全文
`includes("a*") === true`。因此仍违反密钥不得出现在持久化 debug 的不变量。

更病态的密钥同时包含 `***`、`[REDACTED]`、`█`、`▇`、`#` 时，`secretMarker` 退化为空串；
“删除密钥片段”也不能自动证明相邻剩余字符不会重组原文。该分支本轮虽未找到比 `a*` 更短的
新独立路径，但不能作为结构闭合证明。

### 2. 编码形态绕过 exact-substring 终门

对配置 key=`x:y$z` 做真实 200 响应探针：

- `data[0].b64_json = eDp5JHo=`（即 `x:y$z` 的 Base64）时，任务 `done`，`debug.json` 的
  `parsedResponse` 和 `responseBodyText` 均持久化 `eDp5JHo=`；原文未出现，但该值解码后就是
  配置密钥。
- 普通上游字段回显 `x%3Ay%24z` 时，编码串同样进入 debug。它不需要经过 token 正则，也不会被
  `replaceConfiguredSecret` 命中。

`b64_json` 的字段形状本来就被正常成功路径接受，因此这不是不可达的 malformed 输入，而是合法
JSON 响应中的可恢复凭据旁路。若安全不变量是“凭据不得持久化”，exact `includes(secret)` 检查
不足以覆盖该面，属于 **P1-5 同族凭据泄漏**。若产品只冻结了“原始字面串不得出现”，则这是至少
P2 的契约缺口；无论采用哪种口径，当前实现都不能据此宣称终门结构完整。

### 3. 规范化与写点穷举

- `effective.apiKey.trim()` 与 `callImagesApi` 的 `settings.apiKey.trim()` 已一致；空白包裹
  canonical 密钥反例通过。
- `debug.json` 物理写点只有 `daemon/src/jobs/generate.ts:125`；真实/异常 API debug 先过
  `callImagesApi` 出口，dry-run/fallback 在该点前过 `safeDebug`。
- `frames.jsonl` 只有 `FrameStore.append` 写点，log 帧来自 `debugSummary(safeDebug)`。
- `task.error` 与 error 帧集中在 `JobService.run` catch（`service.ts:124-135`）。
  `JobService` 本身不是全局脱敏器；错误安全依赖 runner 自己的终门，marker partial-overlap
  已证明该依赖不充分。

因此未发现第七个**独立物理写点**遗漏；但“所有写点都经过某个终门”不等于“终门满足凭据不出
持久面的不变量”。R8 仍未达到用户要求的可检验结构闭合。

修复需要让最终持久化文本对任意输入满足至少 `serialized.includes(secret) === false`，并明确是否
禁止可逆编码的凭据落盘；marker 应在替换后验证完整结果，碰撞时删除/编码该片段，或采用无任何
前后边界重叠的专用格式，而不是只检查 marker 的整段包含关系。应补 `a*`/各候选边界、病态空串、
Base64/percent 回显及失败路径文件级断言。

## 实现质量与 Standards

本轮改动方向清晰：统一 dry-run 与真实 API 的 canonical secret，并把 R7 失败路径固化成回归测试。
但 `secretMarker` 的注释把一个必要条件误写成充分条件，导致“结构性封死”结论过强；新增测试只覆盖
`a***b`，没有覆盖 `a*`、`a**` 等 partial-overlap，也没有断言编码凭据不可持久化，测试仍有假绿空间。
`generate.ts:16` 的新增 import 仍缺既有风格中的 `.js` 后缀，是低影响维护问题，不是本轮 P1 根因。

## 独立门禁

- contracts：`pnpm -C contracts test`，**4 files，39/39 tests passed**。
- daemon 标准门禁：`pnpm -C daemon test`，**19 files，133/133 tests passed**（脚本排除 e2e）。
- daemon 全量：`pnpm -C daemon exec vitest run`，**21 files，136/136 tests passed**。
- daemon E2E：`pnpm -C daemon run test:e2e`，**2 files，3/3 tests passed**。
- engine smoke：`pnpm -C daemon run smoke:engine`，**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- daemon typecheck：`pnpm -C daemon run typecheck`，**0 errors**。

## 最终判定

R7 的空格密钥和 `a***b` 具体回归均已闭，P1-1、P1-2、P1-3、P1-4、P1-6 以及 P2-2/P2-3
继续闭合；P2-1/P2-4 保持既有边界。但 `deepReplaceSecret` 的双向 marker 检查仍被真实
`a*` partial-overlap 载荷击穿，且 Base64/percent 编码凭据可进入 debug 持久面。因此 **P1 未全闭，
最终 NO-GO，7.2/10**。
