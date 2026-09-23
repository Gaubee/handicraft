# add-backend-platform W0-W2 实现评审 R12

评审范围：`git diff 17a4f33..f423ac6`，当前 `HEAD=f423ac6`，分支 `add-backend-platform-impl`。自检通过：`pwd=/Users/kzf/Pictures/贴钻-backend`；`17a4f33` 及此前实现提交均为 HEAD 祖先；评审前工作区干净；`git diff --check 17a4f33..f423ac6` 通过。

## 结论与评分

**NO-GO，7.3/10（R11 7.1，+0.2）。** R12 采用解码等价类正则后，R11 报告的 percent 全转义、任意选择性转义、逐 escape 大小写混合，以及 hex 逐 nibble 混合，均能在真实持久化路径被遮蔽；Base64 四组合仍闭合，设计文本也同步为等价类匹配。

但是 `percentVariantRe` 的原文分支转义写法错误（`daemon/src/imgapi/client.ts:190-192`）：源码使用 `\$&` 的单反斜杠形式，JavaScript 运行时替换结果实际为 `$&`，没有把正则元字符转义。配置形态只拒绝 `*`，因此含 `(`、`)` 的合规 key 会让终门构造正则直接抛 `SyntaxError`；含 `.` 的合规 key 会把无关文本当作密钥误遮蔽。这是本轮新增的边界内 P1，故不能 GO。

## Spec：R11 缺口复现与 R12 等价类验证

使用真实 `createServices`、临时 task store 和合规密钥复验，覆盖成功响应 JSON 值/属性名及 401 `error.message`：

| 形态 | 解码 | `debug.json` | `task.error` | `frames.jsonl` |
|---|---|---|---|---|
| percent 全转义 `%61%62%63%64%65%66%67%68` | `abcdefgh` | 通过 | 通过 | 通过 |
| percent 选择性 `%61bc%64ef%67h` | `abcdefgh` | 通过 | 通过 | 通过 |
| percent 符号 key `x%3Ay%24z-%6Bey123` | `x:y$z-key123` | 通过 | 通过 | 通过 |
| hex 混合 `783A79247a2D6b6579313233` | `x:y$z-key123` | 通过 | 通过 | 通过 |

真实探针结果为：成功任务的三个 percent 变体均不在 `debug.json`；失败任务的三个 percent 变体均不在 `task.error` 和 `frames.jsonl`；hex 混合形态作为响应键和值也不在 `debug.json`，作为 401 message 时两个失败面同样不含该形态。`maskEncodings` 的 Base64 standard/base64url × padded/unpadded 四组合保持通过。

Base64 边界另用长度为 10/11、输出含 `/` 的 key 验证，覆盖 1/2 个 `=` 的 padding 与 Base64URL `_` 字母表；四种形态都能解码回原 key，且都被终门替换。R11 报告中的 `%61%62c%64Ef%67%68` 确实解码为 `abcdEfgh` 而非 `abcdefgh`，不作为有效等价载荷计入；R12 测试改用的组合形态解码正确。

## Spec：新增边界内 P1，正则原文分支未正确转义

`percentVariantRe` 的目标 raw 集合是 `A-Z/a-z/0-9/._~-`，但源码 replacement 字符串只在 `$&` 前写了一个反斜杠；该 JavaScript 字符串运行时仍是 `$&`，所以没有把反斜杠插入正则源码。

真实 `deepReplaceSecret`/任务探针：

- key=`abc(defgh`（长度 9、无 `*`，配置校验接受）时，生成任务失败，`percentVariantRe` 抛 `SyntaxError: Unterminated group`；没有写出 `debug.json`，错误帧和 `task.error` 记录了该正则异常。
- key=`abc)defgh` 同样抛 `SyntaxError: Unmatched ')'`。
- key=`abc.defgh` 时，输入值 `abcXdefgh` 被正则中的未转义 `.` 误替换为 `***`，即非密钥诊断内容被破坏。

这不是 malformed-key 边界：`isImgApiKeyShapeOk` 仅拒绝 `*` 和 trim 后过短值，`.`、`(`、`)` 均是可配置的合规字符。修复应使用源码中的 `\\$&`（或显式 escape helper），并补充这些 key 的成功/错误路径测试。

### 字节集边界

- UTF-8 非 ASCII 字节只能走 `%HH` 分支；Unicode key 的混合大小写 percent 形态可正确解码并被遮蔽。
- unreserved 字节的 raw/`%HH` 任意组合及 `%HH` 每个 hex 位大小写组合均可匹配。
- 但实现把 `!`、`'`、`(`、`)`、`*` 也加入 raw 集（`client.ts:190`），它们不是 RFC 3986 unreserved；`*` 虽被配置校验拒绝，其他字符仍会使实现比 design 的“非 unreserved 仅 `%HH`”更宽，属于边界语义偏差（P2）。例如 key=`abcdef!g` 的 `%61bc%64e%66!g` 解码为原 key，但当前正则仍匹配并替换它。
- Base32、base36、sha256、碎片和自定义映射仍是 design 明确列出的命名集外形态，本轮不计实现分。

## 其他实现质量

- `client.ts:150-156` 的注释仍描述旧的“9 种显式枚举”，与本轮已改为 percent/hex 等价类正则的实现及 design 文本不一致，属 P2 文档漂移。
- `generate.test.ts:542` 的 `hexMix` 深链式 `split/map/split/map/join` 可读性较差；`:547` 的 `toLowerCase().slice(0, 0) +` 是死表达式。均为低风险测试维护问题，不改变 P1 判定。
- 未发现新的持久化写点绕过：成功 debug 仍经 `generate.ts:127-132`，异常 message 仍经 `callImagesApi` 外层 masker 后进入 `JobService.run` catch，帧统一经 `FrameStore.append`。
- Standards 轴无仓库文档硬违规；ESM `.js` 后缀保持正确。主要问题是上述 regex 功能错误，而非风格选择。

## Standards

未发现仓库级 `CODING_STANDARDS.md` 或 `CONTRIBUTING.md`。无新 ESM/import 或类型规则硬违规。低风险维护项为 stale 注释（`client.ts:150-156`）、`hexMix` 的难读链式构造（`generate.test.ts:540-543`）、`pctSel` 的死表达式（`:547`）；其中 regex 转义问题属于功能/Spec 缺陷，不以风格问题降级。

## 独立门禁

- `pnpm --filter @handicraft/contracts test -- --reporter=dot`：4 files，**39/39 passed**。
- `pnpm --filter @handicraft/daemon test -- --reporter=dot`：19 files，**139/139 passed**（脚本排除 E2E）。
- `pnpm --filter @handicraft/daemon exec vitest run --reporter=dot`：21 files，**142/142 passed**。
- `pnpm --filter @handicraft/daemon test:e2e -- --reporter=dot`：2 files，**3/3 passed**。
- `pnpm --filter @handicraft/daemon smoke:engine`：**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- `pnpm --filter @handicraft/daemon typecheck` 与 `pnpm --filter @handicraft/contracts typecheck`：均退出码 0，无错误。

## 最终判定

R12 已结构性关闭 R11 报告的 percent/hex 表示泄漏，且真实三持久面复现通过；但等价类实现对合法 `(` / `)` key 会崩溃、对 `.` key 会误遮蔽，并且 raw 字节集超出 RFC unreserved 定义。因新增边界内 P1，**最终 NO-GO，7.3/10（相对 R11 +0.2）**；全部 P1 尚未闭合，不满足 GO 条件。

评审轴汇总：Spec 有 1 项 P1 与 1 项 P2，最严重为合法密钥触发正则异常；Standards 无硬违规，3 项低风险可维护性问题（旧注释、复杂 hex fixture、死表达式）。
