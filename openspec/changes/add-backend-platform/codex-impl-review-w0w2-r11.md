# add-backend-platform W0-W2 实现评审 R11

评审范围：`git diff 89a62db..17a4f33`，当前 `HEAD=17a4f33`，分支 `add-backend-platform-impl`。自检通过：`pwd=/Users/kzf/Pictures/贴钻-backend`；`89a62db` 及此前实现提交均为 HEAD 祖先；评审前工作区仅有本报告；`git diff --check 89a62db..17a4f33` 通过。

## 结论与评分

**NO-GO，7.1/10（R10 7.0，+0.1）。** R11 正确补齐了 R10 指出的带/不带 padding 的标准 Base64、带/不带 padding 的 Base64URL、percent 全大写/全小写转义写法以及 hex 全小写/全大写写法；对象键、debug 字符串值和异常 message 仍共用终门，四门禁也保持全绿。

但当前 design.md:43 将 percent 冻结为“全部标准表示变体”，实现只枚举 `encodeURIComponent` 的保留字符布局及其大小写折叠。RFC percent-encoding 允许 unreserved 字节被选择性或全部 percent-escape，且每个 `%HH` 的 hex 位大小写可独立组合；同样，hex 编码的每个 nibble 大小写独立，不是只有全小写/全大写两种字符串。以下合规密钥的有效直译编码仍进入持久面，因此边界内 P1-5c 未闭，不能 GO。

## R10 三类变体复核

使用真实 `createServices`、临时 task store 和合规 key（trim 后长度至少 8、无 `*`）复验：

| 形态 | 标准解码 | `debug.json` | `task.error` | `frames.jsonl` |
|---|---|---|---|---|
| Base64 padded / unpadded | key | 通过 | 通过 | 通过 |
| Base64URL padded / unpadded | key | 通过 | 通过 | 通过 |
| percent canonical 大写/小写 hex 位 | key | 通过 | 通过 | 通过 |
| hex 全小写/全大写 | key | 通过 | 通过 | 通过 |

探针同时将各形态作为成功响应 JSON 属性名、字符串值以及 401 `error.message`；`deepReplaceSecret`（`daemon/src/imgapi/client.ts:256-269`）和 `maskSecretsInText`（`:121-123`）均确实覆盖这些 R10 形态。没有发现新的 debug/error 写点绕过：成功 debug 由 `generate.ts:127-132` 写入，失败 message 由 `JobService.run` catch 写入 task 与 error frame，帧统一经 `FrameStore.append`。

## 边界内对抗复现：P1-5c 仍未闭

当前 `encodingForms`（`client.ts:158-173`）生成的 percent 形态来自 `encodeURIComponent(apiSecret)`，只改变已有 `%HH` 的大小写；它没有生成“把原本 unreserved 的字符也转义”的等价形式。以合规 key=`abcdefgh` 为例：

```text
%61%62%63%64%65%66%67%68
%61bc%64efgh
%61%62c%64Ef%67%68
```

三者都由 `decodeURIComponent` 还原为 `abcdefgh`，但都不在 9 形态中；`TOKEN_RUN_RE` 也不会匹配 `%`。真实任务结果如下：

- 200 成功响应把上述三形态放入 `debug.parsedResponse` 的值和 JSON 属性名后，`debug.json` 三者均保留明文。
- 401 响应 `error.message` 携带同一三形态后，三者均进入 `task.error` 与 `frames.jsonl`。

另以 key=`x:y$z-key123` 生成逐 nibble 混合大小写 hex：`783A79247a2D6b6579313233`。`Buffer.from(value, 'hex').toString()` 返回原 key，但该值既不同于全小写也不同于全大写；它作为响应属性名在 `debug.json` 中保留。对应 401 message 本次被 `TOKEN_RUN_RE` 偶然遮蔽，不能把这条通用正则当作 hex 编码终门；percent 变体已稳定复现同一错误面泄漏。这不是 base32、sha256、碎片或自定义映射等 design 明确列出的命名集外形态，而是当前“percent/hex 全部标准表示变体”措辞内的可解码表示，故保持 P1 严重度。

### 覆盖判定

- Base64：实现覆盖 standard/base64url 两字母表与 padded/unpadded 四组合；未发现本冻结命名集内遗漏。
- Percent：**未覆盖** unreserved 字节的全转义、选择性转义，以及 `%HH` 逐 escape 混合大小写组合。
- Hex：**未覆盖**逐 nibble 混合大小写组合；全小写/全大写只覆盖两个角点。
- 编码顺序：按长度降序替换，能避免 padded 形态被 unpadded 先截断；本身无新问题。

若产品意图只保护 `encodeURIComponent` 的 canonical 布局和两个全局大小写角点，应把 design.md:43 明确收窄；在当前文本下，应扩展等价类或改用规范化/解码匹配后再判闭。

## 新发现与实现质量

- **P1-5c（边界内，未闭）**：上述 percent 全/选择性转义和 hex 混合大小写可在 debug/error 三持久面泄漏。无 P0，无其他新 P1。
- **P2（低风险风格）**：`daemon/tests/generate.test.ts:513` 使用 `});});` 合并关闭 `it`/`describe`，语法有效但不符合文件其余逐层格式，应拆成两行；不影响行为或门禁。
- Standards 轴未发现 documented-standard 硬违规；ESM `.js` 后缀已对齐。`encodingForms` 是单一集中实现，未新增重复脱敏原语。测试体较长但仍是同一安全矩阵，属于轻微可维护性提示，不改变评分主因。
- R10 之前已记录的 DNS rebinding TOCTOU、地址范围细化和 opaque persistence 等 P2 本轮未触及，沿用既有边界，不重开为新问题。

## 独立门禁

- `pnpm --filter @handicraft/contracts test -- --reporter=dot`：4 files，**39/39 passed**。
- `pnpm --filter @handicraft/daemon test -- --reporter=dot`：19 files，**138/138 passed**（脚本排除 E2E）。
- `pnpm --filter @handicraft/daemon exec vitest run --reporter=dot`：21 files，**141/141 passed**。
- `pnpm --filter @handicraft/daemon test:e2e -- --reporter=dot`：2 files，**3/3 passed**。
- `pnpm --filter @handicraft/daemon smoke:engine`：**PASS**，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- `pnpm --filter @handicraft/daemon typecheck` 与 `pnpm --filter @handicraft/contracts typecheck`：均退出码 0，无错误。

## 最终判定

R11 让 R10 指出的四类 Base64/URL-safe 及全局 percent/hex 大小写角点真正闭合，评分小幅上升；但真实文件级对抗仍证明“全部标准 percent 表示”和逐字符大小写等价类不在终门内。因边界内仍有 P1-5c，**最终 NO-GO，7.1/10**。全部 P1 尚未闭合，因此不满足 GO 条件。
