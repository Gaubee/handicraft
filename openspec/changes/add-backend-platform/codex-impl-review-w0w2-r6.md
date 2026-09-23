# add-backend-platform W0-W2 实现评审 R6

评审范围：`git diff b601577..62452f8`，当前 `HEAD=62452f8`，分支
`add-backend-platform-impl`。工作区路径、自检祖先关系和提交均符合要求；`git diff --check`
通过。除本报告外未修改其他文件。

## 结论与评分

**NO-GO，7.7/10（R5 7.6，+0.1）。** R5 的对象键名逃逸已真实闭合：`deepReplaceSecret` 现在
以纯函数重建普通 JSON 树，同时替换键名和字符串值，成功结果与 `ImageApiError.debug` 两条
出口都生效。R5 hostile 键名、嵌套数组/值变体和 401 error.debug 均通过，`JSON.stringify(debug)`
不再包含 `x:y$z`。但全服务扫描发现一个新的同族 P1：`generate.ts` 的 dry-run fallback 不
调用 `callImagesApi`，却直接把 prompt/advanced/base URL 写入 `debug.json`，所以配置密钥仍可
在 dry-run 持久面明文落盘。故 P1-5 的“任何持久化 debug 字段”不变量仍未整体闭合，不能 GO。

## 逐项判定

| 项 | 判定 | 证据与结论 |
|---|---|---|
| P1-1 disabled 禁写 | **已闭** | 本轮未回退；沿用 `requireActiveUser` 四写端点、disabled 读成功/写拒绝和零变化覆盖。 |
| P1-2 帧三一致性 | **已闭** | 本轮未回退；沿用 append 失败上抛、先落盘后递增/广播及实时流/jsonl/回放一致性测试。 |
| P1-3 WS URIError | **已闭** | 本轮未回退；沿用 URIError 400、IdSchema 与真实进程探活回归。 |
| P1-4 输入/PNG 上限 | **已闭** | 本轮未回退；沿用 base64 前置门、PNG 64MP/96MB/maxOutputLength 和压缩炸弹负向覆盖。 |
| P1-5 脱敏/持久化 | **未闭，P1** | R5 键名/值终门在真实 `callImagesApi` 成功和异常路径闭合；dry-run fallback 仍绕过终门并写入明文，见下文。 |
| P1-6 adapter/active attempt | **已闭** | 本轮未回退；沿用运行时引擎 fixture、真实 layout/单调性、partial unique index 与双连接 claim 覆盖。 |
| P2-1 二段下载 SSRF | **部分闭，按声明保留** | 本轮未改 DNS rebinding/TOCTOU、IPv4-mapped IPv6 和特殊地址段；仍是条件性 SSRF P2。 |
| P2-2 取消/订阅泄漏 | **已闭** | 本轮未回退；沿用空 Set 删除、AbortSignal 到达 fetch、无孤儿 blob 覆盖。 |
| P2-3 after_seq | **已闭** | 上轮已加入 `MAX_SAFE_INTEGER` 边界实现和真实 WS 自动化断言；本轮未回退。 |
| P2-4 格式解析/往返 | **部分闭，按声明保留** | 本轮未改 opaque persistence 边界；四族 envelope/篡改拒绝通过，但未验证 persistence parser/projection/reconstruction。 |

## R5 键名复现与结构完整性

R5 的 hostile 形态独立复跑通过。配置 key=`x:y$z`，上游响应为：

```json
{"data":[{"b64_json":"b2s=","x:y$z":"value-x:y$z","nested":[{"prefix-x:y$z-suffix":"x:y$z"}]}]}
```

成功结果的 `debug` 中 endpoint、requestBody、parsedResponse 键和值、responseBodyText 均不含
`x:y$z`，并被替换为 `***` 形态。401 失败路径同样验证：上游 status text、content-type、
响应 JSON 键和值和 error message 携带 `x:y$z` 时，`error.message` 与 `error.debug` 序列化文本
均无明文。

R5 的测试文件级 hostile fixture 也通过：`daemon/tests/generate.test.ts:222-242` 断言
嵌套键名在 `debug.json` 中零明文且存在 `"***"` 键。普通数组、嵌套对象和键/值混合变体的
直连复现结果一致。因此 `deepReplaceSecret`（`daemon/src/imgapi/client.ts:203-215`）对
JSON-like `callImagesApi` debug 树的键值双面重建成立；未发现新的 `callImagesApi` message
出口或结构化 debug 落盘出口。

## 新发现：dry-run fallback 绕过终门（P1）

`daemon/src/jobs/generate.ts:100-115` 在 `capturedDebug` 为空时直接构造 `debugRecord`，
`generate.ts:120` 原样 `JSON.stringify(debugRecord)` 写入 `debug.json`。`executeGenerate`
的 dry-run 分支（`:132-137`）不调用 `callImagesApi`，所以不会执行
`deepReplaceSecret`。这条路径仍属于 W2.2 生成任务的持久化 debug 面，不能因没有真实 API
外呼而排除；设计文档把密钥读面定义为统一脱敏（`openspec/changes/add-backend-platform/design.md:43`）。

独立真实任务复现：

- `IMG_DRY_RUN=1`；settings 中 `img_api_key = x:y$z`、`img_model = m`；
- 创建 generate 任务，`prompt = x:y$z`，`advanced.nested = x:y$z`；
- 任务 `done`，但 `debug.json` 的 `requestBody.prompt` 和 `requestBody.advanced.nested` 均保留
  `x:y$z` 明文；文件中没有 `***`。

因此本轮虽然闭合了 R5 的键名 P1，仍新增/保留一条可持久化的 P1-5 逃逸。修复应让
fallback debug 也经同一个配置密钥重建器（或在唯一落盘点按有效 settings 做完整键值脱敏），
并补 dry-run 文件级负向测试。

## 边界复验：固定遮罩标记的碰撞

另做了字符边界探针：当配置 key 为 `*`、`**` 或 `***` 时，`replaceConfiguredSecret` 的
固定替换结果 `***` 本身仍包含原 key 子串；例如 key=`**` 的 debug 键名会变成 `****`，
`JSON.stringify(debug).includes('**')` 仍为真。该输入是否在配置 schema 中被禁止尚未冻结，
故记为 **P2 边界/契约缺口**，不是本轮主要 P1；若“不变量”按任意非空字符串严格解释，则需
改用保证不含原密钥的替换标记或拒绝这些配置值。

## 实现质量与 Standards

R6 的纯函数重建比原地变异更容易证明键值全覆盖，且成功/异常双路和 R5 hostile 文件级回归
均有效。未发现新的硬性编码规范违规。低风险质量项是对象键替换可能与既有 `"***"` 键碰撞
而丢失诊断字段，且尚无键碰撞/根数组专门回归；这些不造成密钥逃逸。

## 独立门禁

- contracts：`pnpm -C contracts exec vitest run`，**4 files，39/39 tests passed**。
- daemon：`pnpm -C daemon exec vitest run`，**21 files，132/132 tests passed**。
- daemon E2E：`pnpm -C daemon run test:e2e`，**2 files，3/3 tests passed**。
- engine smoke：`pnpm -C daemon run smoke:engine`，**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- daemon typecheck：`pnpm -C daemon run typecheck`，**0 errors**。

## 最终判定

R5 的对象键名 P1 已闭，P1-1、P1-2、P1-3、P1-4、P1-6 以及 P2-3 继续闭合；但 dry-run
fallback 直接落盘配置密钥是新的 **P1-5**，因此当前结论为 **NO-GO（7.7/10）**。在所有
生成模式共享同一 debug 脱敏终门、并补 dry-run 负向文件测试前，不能给 GO。
