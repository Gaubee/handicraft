# add-backend-platform W0-W2 实现评审 R7

评审范围：`git diff 62452f8..c3ad6b0`，当前 `HEAD=c3ad6b0`，分支
`add-backend-platform-impl`。工作区路径、祖先关系和 diff hygiene 自检通过；除本报告外未修改其他文件。

## 结论与评分

**NO-GO，7.4/10（R6 7.7，-0.3）。** R7 确实把 dry-run fallback 接到了统一的
`deepReplaceSecret`，并为 `*` 增加动态替换标记；但新增的替换语义不能证明“配置密钥不出现在任何
持久化面”。我独立复现了两类真实 P1：

1. 密钥 `a***b`、输入 `aa***bb` 时，`***` 替换后重新拼回 `a***b`，`debug.json` 的
   prompt/advanced 明文恢复为密钥；同一类上游网络异常还会进入 `task.error` 与
   `frames.jsonl`。
2. 配置密钥为 ` x:y$z ` 时，dry-run 终门使用未 trim 的原值，而请求路径使用
   `settings.apiKey.trim()`；prompt/advanced 中的 canonical 值 `x:y$z` 在 `debug.json` 明文保留。

因此 P1-5 仍未闭，不能给 GO。R7 不是新增独立写点遗漏，而是同一终门在重叠替换和配置规范化边界上仍不满足不变量。

## 逐项判定

| 项 | 判定 | 证据与结论 |
|---|---|---|
| P1-1 disabled 禁写 | **已闭（回归通过）** | 沿用 `requireActiveUser` 四写端点、disabled 禁写/读成功及存储零变化覆盖；本轮未回退。 |
| P1-2 帧三一致性 | **已闭（回归通过）** | `daemon/src/jobs/service.ts:231-238` 仍是先 `append`，成功后才递增序号并广播；append 失败、实时流/jsonl/回放一致测试继续通过。 |
| P1-3 WS URIError | **已闭（回归通过）** | URIError 400、IdSchema 约束和真实进程探活回归继续通过。 |
| P1-4 输入/PNG 上限 | **已闭（回归通过）** | base64 前置门、PNG 64MP/96MB/maxOutputLength 三重上限和压缩炸弹负向覆盖继续通过。 |
| P1-5 脱敏/持久化 | **未闭，P1** | R7 的 dry-run 终门接线真实存在，但 `deepReplaceSecret` 依赖有缺陷的整段替换原语；重叠 marker 和未 trim canonical secret 均可使配置密钥重新落盘/进入错误持久面。 |
| P1-6 adapter/active attempt | **已闭（回归通过）** | paving-adapter 运行时引擎 fixture/真实 layout/单调性、partial unique index 和双连接 claim 覆盖继续通过。 |
| P2-1 二段下载 SSRF | **部分闭，边界仍保留** | https、DNS 私网拒绝、同源重定向复验、流式上限、signal 继续通过；DNS rebinding TOCTOU、压缩 IPv4-mapped/100.64/10 等 R2 已声明边界本轮未改。 |
| P2-2 取消/订阅泄漏 | **已闭（回归通过）** | 空 Set 删除、AbortSignal 到达 fetch、无孤儿 blob 覆盖继续通过。 |
| P2-3 after_seq | **已闭** | `MAX_SAFE_INTEGER` 超界拒绝及安全边界自动化断言继续通过。 |
| P2-4 格式解析/往返 | **部分闭，边界仍保留** | 四族真实解析与 adversarial 篡改拒绝继续通过；opaque persistence parser/projection/reconstruction 仍是已声明后续边界。 |

## R7 反例复现

### 1. dry-run 与 `*` 边界

R6 的 `x:y$z` dry-run 反例继续通过：未加空格的配置密钥会被替换，`debug.json` 与
`frames.jsonl` 均不含明文；密钥为 `*` 时，动态 marker 选 `[REDACTED]`，`debug.json` 的
prompt 不再是原始 `"*"`。

但把 marker 当作“只要 marker 不包含 secret 就安全”并不成立。直接跑真实 job：

- settings `img_api_key = a***b`；
- dry-run prompt 和 `advanced.nested = aa***bb`；
- 任务 `done`，`debug.json` 输出 `prompt = "a***b"`、`nested = "a***b"`，
  `JSON.stringify(debug).includes("a***b") === true`；
- `frames.jsonl` 的 debug 摘要只含 endpoint/status，因此该成功样例未把 prompt 带入帧，但
  终门不变量已经被 debug 文件违反。

配置规范化反例同样可复现：

- settings `img_api_key = " x:y$z "`；
- dry-run prompt/advanced 使用 `x:y$z`；
- 任务 `done`，`debug.json` 两处均保留 `x:y$z` 明文。

根因是 `daemon/src/jobs/generate.ts:120` 传入 `effective.apiKey`，而真实 API 终门在
`daemon/src/imgapi/client.ts:187` 使用 `settings.apiKey.trim()`；`resolveImgConfig` 在
`daemon/src/config.ts:240-245` 返回 settings 原值，不做规范化。

### 2. 失败路径的同族复现

为确认这不是仅成功 debug 文件的边界，我用真实 API 模式设置 key=`a***b`，让注入的 fetch
抛出包含 `aa***bb` 的网络错误。`callImagesApi` 的 `maskSecretsInText` 先替换成 `***`，
随后得到错误文本 `a***b`；任务最终：

- `task.error = "计算任务未成功（failed：网络请求失败：upstream echoed a***b）"`；
- `frames.jsonl` 的 error 帧包含相同明文。

`daemon/src/jobs/service.ts:124-135` 会把 runner 的 message 原样送入 error 帧和任务 params；这条链
只有在上游终门语义正确时才安全，不能抵消 marker 重叠复原。

## 持久化写点穷举

源码扫描结果如下：

- `debug.json` 的唯一写点是 `daemon/src/jobs/generate.ts:125`。成功/失败 API debug 都先
  经过 `callImagesApi` 出口，dry-run/fallback 经过 `safeDebug`，故本轮没有发现“另一个独立
  debug.json 写点绕过终门”的第七个路径。
- `frames.jsonl` 的物理写点集中在 `daemon/src/jobs/frame-store.ts:18-22`，所有帧由
  `JobService.emitFrame` 统一 append；log 帧使用 `debugSummary(safeDebug)`。
- `task.error`/error 帧的统一落点是 `JobService.run` catch（`service.ts:124-135`），但
  `JobService` 本身不是全局脱敏器；它把 runner message 原样保存。因此“路径经过统一落点”不等于
  “任何任意 runner 错误都自动安全”。在本 change 的图像 API 链路中，正常错误 message 依赖
  `callImagesApi` 外层 masker；本轮复现证明该 masker 的替换原语仍可泄漏。

结论：**没有发现新的独立物理写点遗漏；但终门本身未结构闭合，不能据此宣称第七面已关闭。**
修复应至少做到：使用 canonical `trim()` secret（dry-run 与真实请求一致），并采用不会因前后文
拼接重构原 secret 的替换策略（例如先验证替换后文本不含 secret，失败则删除/编码，而不是只检查
marker 自身）。同时应补重叠 marker、空白 canonical secret 和失败路径的文件级测试。

## 实现质量与 Standards

R7 的方向是正确的：把 `deepReplaceSecret` 导出并在 `generate.ts` 唯一 debug 落盘点前统一过门，
成功路径和异常路径的结构位置清晰；`*` 的动态 marker 也比固定 `***` 更接近目标。不过：

- `secretMarker()`（`client.ts:154-158`）只检查候选 marker 是否含 secret，没有检查替换结果的
  邻接拼接，因此不满足其注释宣称的“不泄漏”保证。
- `generate.ts:16` 的新增 import 缺少既有风格中的 `.js` 后缀；当前 typecheck/tsx 可通过，属于低影响
  可维护性问题，不是本轮 P1 根因。
- R7 新增的 `*` 测试只断言 prompt 不再原样等于 `"*"`，没有断言
  `JSON.stringify(debug)`/frames/task.error 全文不含 secret；重叠与 trim 反例也未覆盖，故测试存在
  假绿空间。

## 独立门禁

- contracts：`pnpm -C contracts test`，**4 files，39/39 tests passed**。
- daemon 标准门禁：`pnpm -C daemon test`，**19 files，131/131 tests passed**（脚本排除 e2e）。
- daemon 全量补跑：`pnpm -C daemon exec vitest run`，**21 files，134/134 tests passed**。
- daemon E2E：`pnpm -C daemon run test:e2e`，**2 files，3/3 tests passed**。
- engine smoke：`pnpm -C daemon run smoke:engine`，**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- daemon typecheck：`pnpm -C daemon run typecheck`，**0 errors**。

## 最终判定

P1-1、P1-2、P1-3、P1-4、P1-6 已闭，P2-2/P2-3 已闭；P2-1/P2-4 的既有边界维持声明状态。
但 P1-5 的 dry-run 接线仍受重叠替换和 secret normalization 两个真实路径击穿，且失败路径可进入
`task.error`/`frames.jsonl`。因此 **P1 未全闭，最终 NO-GO，7.4/10**。
