# add-backend-platform W0-W2 实现评审 R13

评审范围：`git diff f423ac6..53212d5`，当前 `HEAD=53212d5`，分支 `add-backend-platform-impl`。自检通过：`pwd=/Users/kzf/Pictures/贴钻-backend`；`f423ac6` 及此前实现提交均为 HEAD 祖先；评审前工作区除本报告外为空；`git diff --check f423ac6..53212d5` 通过。

## 结论与评分

**GO，8.1/10（R12 7.3，+0.8）。** R12 新增的边界内 P1（含 `(` / `)` 的合规 key 触发 percent 正则构造异常）已闭：`daemon/src/imgapi/client.ts:194-196` 使用真实 replacement 转义 `\\$&`，运行时会把正则元字符转成字面字符；`daemon/tests/generate.test.ts:569-599` 以真实任务路径覆盖成功落盘、`%28/%29` 编码键名和近形文本保留。R12 的 raw 字符集 P2 也已收窄到 RFC 3986 unreserved。

边界内未发现新的 P1/P2。保留一项低风险维护项：`client.ts:151-156` 的注释仍写“9 种显式枚举”，但当前 percent/hex 已改为解码等价类正则；这不影响行为或本轮 GO。

## 关键复现

### `( )` 正则崩溃修复

独立 `deepReplaceSecret` 探针使用合规密钥 `key(123)xy`：

- 原文 `key(123)xy` 和全 percent 形态 `%6b%65y%28123%29xy` 均替换为 `***`；不再抛 `SyntaxError`。
- 真实 `createServices` 任务使用相同密钥和 hostile JSON，任务状态为 `done`；`debug.json` 不含原文或 `%28/%29` 形态，且保留近形 `key(124)xyz`，证明没有误遮蔽。

这直接闭合 R12 报告中的构造崩溃与 `.` 类似未转义误匹配风险。

### `!` 语义边界

独立探针使用 `abcdef!g`：

- `abc%64ef%21g` 被替换为 `***`；非 unreserved 字节通过 `%HH`（大小写不敏感）分支覆盖。
- `abc%64ef!g` 保留原文。该形式把 `!` 作为字面字符混入 percent 表示，不属于当前冻结的标准等价类。

边界符合 RFC 3986：§2.3 的 unreserved 仅为 `ALPHA / DIGIT / - . _ ~`；§2.2 将 `!`、`'`、`(`、`)`、`*` 列为 reserved sub-delims。因此 R13 将 raw 分支收窄为 `[A-Za-z0-9_.~-]` 是正确语义，不应把 `!` 字面混合形态重新纳入实现。`%21` 形式仍被等价类正则覆盖。

### 结构检查

`percentVariantRe` 逐 UTF-8 字节构造 `raw(unreserved)|%HH(case-insensitive)`，`hexVariantRe` 逐 nibble 做大小写等价；原文、键名、成功 debug、错误 message 均统一经过 `maskEncodings`/`deepReplaceSecret` 终门。Base64 standard/base64url 的 padded/unpadded 四组合保持由枚举覆盖。R13 diff 未引入新的持久化写点或绕过路径。

## Spec

- R12 P1：真实 replacement 转义已修复；含括号的合规密钥不再崩溃，且编码等价形态被遮蔽。
- R12 P2：raw 直书集合与 design §2 及 RFC 3986 unreserved 一致；`! ' ( ) *` 不作为 raw 分支标准表示。
- R11/R12 已接受的 percent/hex 解码等价类、Base64 四组合及三持久面终门均保持通过。
- 未发现本轮缺失需求、错误实现或 scope creep。命名集外 base32、sha256、碎片/自定义映射仍属于 design 明确冻结的边界外，不计入本轮实现分。

## Standards

未发现仓库级 `CODING_STANDARDS.md`/`CONTRIBUTING.md` 硬性违规。ESM/TypeScript 规范保持通过。仅有低风险文档漂移：`client.ts:151-156` 仍沿用 R10“9 种显式枚举”的旧注释；测试尾部 `});});` 与常规排版不一致，但不影响语义，也不构成 P1/P2。

## 独立门禁

- `pnpm --filter @handicraft/contracts test -- --reporter=dot`：4 files，**39/39 passed**。
- `pnpm --filter @handicraft/daemon test -- --reporter=dot`：19 files，**140/140 passed**（脚本排除 E2E）。
- `pnpm --filter @handicraft/daemon test:e2e -- --reporter=dot`：2 files，**3/3 passed**。
- `pnpm --filter @handicraft/daemon smoke:engine`：**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- `pnpm --filter @handicraft/daemon typecheck` 与 `pnpm --filter @handicraft/contracts typecheck`：均退出码 0，无错误。
- `pnpm exec vitest run tests/generate.test.ts -t 'P1-5 R12 回归' --reporter=dot`：**1/1 passed**（19 skipped）；独立 runtime probe 亦通过。

## 最终判定

R13 已关闭 R12 的唯一边界内 P1，并按 RFC 3986 正确收窄 percent raw 字节集；`!` 的字面混合形式不属于冻结等价类，而 `%21` 形式已覆盖。边界内 P1 全闭且无新边界内 P1，故本轮 **GO，8.1/10（相对 R12 +0.8）**。

评审轴汇总：Spec 无未闭要求或错误实现；Standards 无硬违规，留 1 项低风险旧注释维护项。最严重残余仅是该注释与当前实现的描述漂移，不影响安全边界或运行结果。
