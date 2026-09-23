# add-backend-platform W0-W2 实现评审 R9

评审范围：`git diff 6767dde..bbfb41f`，当前 `HEAD=bbfb41f`，分支 `add-backend-platform-impl`。
自检通过：`pwd=/Users/kzf/Pictures/贴钻-backend`；`6767dde`、`62452f8`、`c3ad6b0`、`da899ee` 均为 HEAD 祖先；评审前工作区干净；`git diff --check 6767dde..bbfb41f` 通过。

## 结论与评分

**NO-GO，7.0/10（R8 7.2，-0.2）。** R8 收窄了威胁边界，且合规密钥在 debug 字符串值中的 raw/base64/percent/hex 四种形态确实都被替换。但终门没有在所有持久化出口实施同一冻结规则：编码形态作为 JSON 属性名进入 `debug.json`；上游 401 错误 message 中的 base64 与 percent 编码进入 `task.error` 和 `frames.jsonl`。这些都在 design 明文冻结的边界内，P1-5 未闭，不能 GO。

## R8 三组复现

使用真实 `createServices` 任务和任务目录文件复验；配置 key=`x:y$z123`（长度 8、无 `*`，属合规密钥）。

| R8 复现 | R9 结果 |
|---|---|
| `a*` 部分重叠（key=`a*`，prompt=`aa*`） | 真实调用模式创建被拒，提示 key 形态非法；dry-run 模式却创建并完成，`debug.json` prompt 变为 `a***`，仍包含 `a*`。说明此前攻击依赖的病态形态没有在所有任务创建路径消除。按冻结的“合规密钥”持久化承诺，此例作为边界外/Owner 决策单列，不计入 7.0 分；若“创建时拒绝”也覆盖 dry-run，则是额外实现缺口。 |
| 全标记病态 key=`***[REDACTED]█▇#` | 真实调用模式创建被拒。dry-run 可创建；prompt=`S[0:4] + S + S[4:]`（S 为该 key）经空 marker 删除中间 S 后又拼回完整 S，`debug.json` prompt 仍为完整 key。与 `a*` 一样属于 malformed-key 边界裁决，不计分。 |
| base64(key) 回显 | `b64_json` 字符串值现已从 `debug.json` 消失，R8 所加的值路径修复通过。扩展为四形态×写面的探针后仍发现 JSON 键和 error 写面缺口，详见下文。 |

## 冻结边界内缺陷

### P1-5a：编码 JSON 属性名泄漏到 debug

`deepReplaceSecret` 的字符串值调用 `maskEncodings`，但对象键只调用 `replaceConfiguredSecret`（[client.ts:238](/Users/kzf/Pictures/贴钻-backend/daemon/src/imgapi/client.ts:238)）。对真实成功响应的 `echoProps` 使用 key 的 base64、percent、hex 编码作为 JSON 属性名，值设为无害 marker；成功任务写出的 `debug.json.parsedResponse.echoProps` 保留三个编码键。原文键会被换成 `***`，但冻结边界还明确包含三种直译编码。

### P1-5b：错误文本只做原文和 token-run 脱敏

`maskSecretsInText` 只调用 `replaceConfiguredSecret` 与长度至少 16 的 `TOKEN_RUN_RE`（[client.ts:121](/Users/kzf/Pictures/贴钻-backend/daemon/src/imgapi/client.ts:121)）；`callImagesApi` 的 typed error 出口仍只使用该函数（[client.ts:215](/Users/kzf/Pictures/贴钻-backend/daemon/src/imgapi/client.ts:215)）。用 key=`x:y$z123` 对应的 401 message 复现：原文被替换；`eDp5JHoxMjM=`（base64，长度小于正则门槛）和 `x%3Ay%24z123`（percent）保留在 `task.error` 与 `frames.jsonl` error 帧。hex 形式本次被长 token 正则偶然遮掉，不构成统一编码终门。JobService 在 catch 中原样复制 message 到两处持久面（[service.ts:124](/Users/kzf/Pictures/贴钻-backend/daemon/src/jobs/service.ts:124)）。

### 四形态 × 三持久面

合规 key=`x:y$z123`；响应值、响应属性名及 401 message 均由真实任务路径写入临时 task store。下表中的“error”指 DB 的 `task.error`，“frames”指 `frames.jsonl` error 帧。

| 形态 | `debug.json` 字符串值 | `debug.json` 属性名 | `task.error` | `frames.jsonl` |
|---|---|---|---|---|
| 原文 | 已遮蔽 | 已遮蔽 | 已遮蔽 | 已遮蔽 |
| base64 | 已遮蔽 | **泄漏** | **泄漏** | **泄漏** |
| percent | 已遮蔽 | **泄漏** | **泄漏** | **泄漏** |
| hex | 已遮蔽 | **泄漏** | 被 `TOKEN_RUN_RE` 偶然遮蔽 | 被 `TOKEN_RUN_RE` 偶然遮蔽 |

debug 值列验证覆盖 `parsedResponse` 及 `responseBodyText`；属性名列通过上游合法 JSON 对象字段验证。成功帧的 log 只写 `debugSummary`（endpoint/status/duration），不承载上游响应字段；失败帧则原样复制 error message，故与 task.error 有相同泄漏。失败任务不写 `debug.json`，但这不能补偿另外两个持久面。

## 边界判断与写点审计

将承诺明确限制为“合规 key 的原文、base64、percent、hex 直译形态”是可执行的有限安全边界；不追踪任意 hash、碎片、自定义映射也可作为本地单用户 daemon 的 Owner 威胁模型裁决。这里接受的是边界范围本身，不是“任意哈希在信息论上可逆”的字面论证；哈希是否可恢复取决于密钥熵及攻击者先验，设计应将其表述为明确的非目标。

实现目前**不满足已冻结边界**：`maskEncodings` 仅覆盖值，不覆盖键和 error message；而 design §2 的不变量覆盖所有持久化 debug/error 面（[design.md:43](/Users/kzf/Pictures/贴钻-backend/openspec/changes/add-backend-platform/design.md:43)）。因此这不是把威胁范围继续扩大的边界争议，而是边界内 P1 未闭。

病态 key 的创建拒绝还有一处边界文字不一致：`generatePreCreate` 在读取有效配置和执行形态校验前就因 `imgDryRun` 返回（[generate.ts:22](/Users/kzf/Pictures/贴钻-backend/daemon/src/jobs/generate.ts:22)）。真实调用任务会拒绝 `a*`/全标记 key，但 dry-run task 会接受，且上述文件复现可把病态 key 留入 debug。持久化不变量限定的是合规 key，因此本报告依用户要求把此项列为 **Spec/Owner 裁决，不计实现分**：请明确 dry-run 是否豁免病态 key 的创建拒绝；若不豁免，应在 dry-run 早退前校验已配置的非空 key。

物理写点核对：成功 debug 仅由 `generate.ts:126` 写入，之前会经过 `deepReplaceSecret`；帧统一经 `JobService.emitFrame` → `FrameStore.append`；失败 message 则在 JobService catch 写 error 帧和 task row。没有发现第四个独立写点；缺陷是终门覆盖语义不一致，而非写点绕过。

## 既有项目项

R8 报告中 P1-1 至 P1-4、P1-6 及 P2-2/P2-3 的关闭结论，本轮代码差异未触及且回归门禁继续通过；P2-1 DNS TOCTOU/地址范围与 P2-4 opaque persistence 边界沿用既有记录，本轮不重开。R9 唯一边界内阻塞项仍为 P1-5。

## Standards

未发现仓库级 `CODING_STANDARDS.md` 或 `CONTRIBUTING.md`。低影响风格问题：本轮新增的 `generate.ts:16` 对本地 ESM 模块导入未写 `.js` 后缀，而同文件其余相对导入使用 `.js`；typecheck 通过，该项不影响本轮安全判定。仓库缺少 `docs/agents/issue-tracker.md`；本次以用户指定的 OpenSpec design 和固定 commit diff 为 Spec 真源。

## 独立门禁

- `pnpm -C contracts test`：4 files，39/39 passed。
- `pnpm -C daemon test`：19 files，134/134 passed（不含 E2E）。
- `pnpm -C daemon run test:e2e`：2 files，3/3 passed。
- `pnpm -C daemon run smoke:engine`：PASS，`gemCount=68`、`dropped=0`、`svgBytes=3040`、`bomBytes=103`。
- `pnpm -C daemon run typecheck`：退出码 0，无错误输出。

## 最终判定

R8 让合规密钥的 debug 字符串值覆盖四种直译形态，并在真实调用准入路径拒绝含 `*`/过短 key；但**P1-5 未闭**：编码属性名仍写入 debug，base64 与 percent 错误回显仍写入 task.error 和 frames。按“所有边界内 P1 闭合才 GO”的准则，最终 **NO-GO，7.0/10（较 R8 7.2 下降 0.2）**。dry-run 对 malformed key 的豁免另列 Owner/Spec 裁决，不计入本轮实现评分。
