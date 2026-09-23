# add-backend-platform W0-W2 实现评审 R10（终判轮）

评审范围：`git diff bbfb41f..89a62db`，当前 `HEAD=89a62db`，分支 `add-backend-platform-impl`。自检通过：`pwd=/Users/kzf/Pictures/贴钻-backend`；`bbfb41f` 及此前实现提交均为 HEAD 祖先；评审前工作区干净；`git diff --check bbfb41f..89a62db` 通过。

## 结论与评分

**NO-GO，7.0/10（R9 7.0，+/-0.0）。** R10 已关闭 R9 暴露的两个 canonical 形态缺口：编码 JSON 属性名现在经过 `maskEncodings`，异常 message 也经过同一编码终门；dry-run 在早退前拒绝已配置的病态 key；ESM import 后缀已对齐。标准四形态矩阵全部通过。

但按 design §2 当前文字，`base64/percent/hex 直译编码` 没有冻结为单一大小写、padding 或 alphabet 表示。未补 padding 的 base64、大小写变体的 percent、大小写变体的 hex 都是同一编码族的有效直译表示，不属于 hash/碎片等边界外形式。它们仍可进入持久化 debug/error 面，故 P1-5 没有在冻结边界内完全闭合，终判不能 GO。

## R9 缺口收口复核

| 项 | 判定 | 证据 |
|---|---|---|
| 编码 JSON 属性名 | 已闭（canonical） | `deepReplaceSecret` 对键和值均调用 `maskEncodings`（`daemon/src/imgapi/client.ts:238-247`）。真实成功任务中 raw、canonical base64、`encodeURIComponent` percent、lowercase hex 属性名均未进入 `debug.json`。 |
| 401 编码 message | 已闭（canonical） | `maskSecretsInText` 改为先调用 `maskEncodings`（`client.ts:121-123`）。真实 401 任务的 `task.error` 和 `frames.jsonl` 对四种 canonical 形态均无明文。JobService 的两处持久写点继续集中在 catch（`daemon/src/jobs/service.ts:124-135`）。 |
| dry-run 病态 key | 已闭 | `generatePreCreate` 在 dry-run 早退前读取 settings/.env，并对非空 key 执行 `isImgApiKeyShapeOk`（`daemon/src/jobs/generate.ts:22-30`）。`a*`、`***[REDACTED]█▇#`、`bad*key123`、首尾空格包裹的过短 key 均在创建阶段拒绝。 |
| import 后缀 | 已闭 | `generate.ts:16` 改为 `../imgapi/client.js`。 |

## 四形态 × 三持久面矩阵

使用合规 key=`x:y$z123`（trim 后长度 8、无 `*`），通过真实 `createServices` 任务写入临时 task store。canonical 形态为 raw、带 padding 的 base64、`encodeURIComponent`（大写十六进制 percent）、lowercase hex。

| 形态 | debug 字符串值 | debug JSON 键名 | task.error | frames.jsonl |
|---|---|---|---|---|
| raw | 通过 | 通过 | 通过 | 通过 |
| base64 | 通过 | 通过 | 通过 | 通过 |
| percent | 通过 | 通过 | 通过 | 通过 |
| hex | 通过 | 通过 | 通过 | 通过 |

成功面同时检查了 `parsedResponse` 与 `responseBodyText`；失败面注入 401 的 `error.message`，并逐文件读取 `frames.jsonl`。成功 log 帧仍只有 `debugSummary(endpoint/status/duration)`，没有隐藏的完整 debug 写点。

## 边界内最终穷举：P1-5c

将同一 key 编码为以下有效变体：

- 未补 `=` 的 base64：`eDp5JHoxMjM`；
- percent 编码大小写变体：`x%3ay%24z123`；
- hex 大小写变体：`783A79247A313233`。

标准解码分别还原为 `x:y$z123`。真实任务结果：

- 成功 `debug.json` 的 `parsedResponse.echoProps` 仍保留这三种变体作为属性名；未补 padding 的 base64 和小写 percent 也作为字符串值保留。大写 hex 值可能被长度正则偶然打成尾 4 位，但其 JSON 键仍泄漏。
- 401 失败路径中，未补 padding 的 base64 与小写 percent 仍出现在 `task.error` 和 `frames.jsonl`；大写 hex 被 `TOKEN_RUN_RE` 偶然遮住，不能视为结构保证。

因此这是 **P1-5c（边界内）**：R9 修复只替换三个 canonical 生成结果，未对同一编码族做规范化/解码等价匹配。design.md:43 写的是编码族“base64/percent/hex 直译编码”，没有限定 canonical padding 或大小写；这些变体不应被归入已声明的任意 hash/碎片非目标。若 Owner 希望只保护 canonical 拼写，必须先把 design 不变量改成明确的 canonical 语法；在当前 spec 下应判未闭。

## 终门与写点审计

物理写点仍无遗漏：

```
callImagesApi success -> deepReplaceSecret -> generate safeDebug -> debug.json
callImagesApi ImageApiError.message -> maskSecretsInText -> JobService catch
JobService error frame/task.error -> frames.jsonl + DB
dry-run/fallback -> deepReplaceSecret -> 同一 debug/log 面
```

非 JSON `responseBodyText` 的 `sanitizeBodyText` catch 分支中间态只做 token-run/original 替换，但结果离开 `callImagesApi` 前仍经过 `deepReplaceSecret`；本次未形成另一条物理逃逸。所有当前发现集中在 `maskEncodings` 的编码等价类覆盖不足，而不是新的写点遗漏。

## 既有项目项与 Standards

P1-1、P1-2、P1-3、P1-4、P1-6 及 P2-2/P2-3 的既有关闭结论本轮未回退。P2-1 的 DNS rebinding TOCTOU/地址范围与 P2-4 的 opaque persistence 仍是先前记录的边界项，本轮未重开。

未发现仓库级 `CODING_STANDARDS.md` 或 `CONTRIBUTING.md`；R9 的 import 后缀问题已修复。Standards 轴无硬违规；`generate.ts` 仍同时承担预检、执行和 debug 落盘，属于低风险 Divergent Change 启发式，不影响安全结论。仓库也没有 `docs/agents/issue-tracker.md`，本轮以用户指定 OpenSpec design 和固定 commit diff 为 Spec 真源。

## 独立门禁

- `pnpm -C contracts test`：4 files，**39/39 passed**。
- `pnpm -C daemon test`：19 files，**137/137 passed**（脚本排除 E2E）。
- `pnpm -C daemon exec vitest run`：21 files，**140/140 passed**。
- `pnpm -C daemon run test:e2e`：2 files，**3/3 passed**。
- `pnpm -C daemon run smoke:engine`：**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- `pnpm -C daemon run typecheck`：退出码 0，无错误输出。

## 最终判定

R10 已关闭 R9 指出的 canonical 键名、canonical error message 和 dry-run 病态配置路径；但最终对抗穷举发现同一冻结编码族的非 canonical 有效表示仍可落入 debug/error 持久面，故 **边界内 P1-5 未全闭**。当前结论为 **NO-GO，7.0/10（相对 R9 无变化）**。要达到 GO，需明确冻结 canonical 表示并据此调整 spec，或让 `maskEncodings` 覆盖 base64 padding/alphabet 与 percent/hex 大小写等价类后重新复验。
