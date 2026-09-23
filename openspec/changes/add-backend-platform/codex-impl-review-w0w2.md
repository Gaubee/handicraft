# add-backend-platform W0-W2 实现评审

评审范围：`git diff 7fc245c..HEAD`，HEAD=`0c2e210`。自检通过：工作区为
`/Users/kzf/Pictures/贴钻-backend`，`7fc245c` 与 `b335ef0` 均为 HEAD 祖先，
七个实现提交均在链上；固定 diff 中 `rhinestone-studio/src` 零改动。除本报告外无其他工作树改动。

## 结论与评分

**NO-GO，5.0/10。** 功能主链和门禁均可运行，但默认匿名写面、帧持久化一致性、
畸形 WS 输入、资源上限及 debug 脱敏仍有可验证阻塞。无 P0；有 6 项 P1、4 项 P2。

## 阻塞问题

### P0

无。

### P1

1. **禁用用户仍能写入。** `daemon/src/auth.ts:160-174` 保留 disabled 用户认证，
   `daemon/src/rpc.ts:51-55` 的所有端点只使用 `requireAuth`；因此 disabled token 仍可
   `assets.upload`（90-100）、`tasks.create/cancel`（104-134）、`resources.import`
   （148-160）。违反 spec §匿名账户 `spec.md:26` 的“禁写不禁读”。
   修复：增加 `requireActiveUser`，绑定所有 mutation；测试 disabled 用户读成功、各写端点
   拒绝且 DB/blob 无变化。

2. **jsonl 写失败被吞掉，WS 仍广播且序号前进。** `daemon/src/jobs/frame-store.ts:17-25`
   捕获所有 append 错误后返回；`daemon/src/jobs/service.ts:176-191` 仍更新 seq、通知
   subscribers。客户端可能收到无法回放的帧，违反 spec `:40-44` 的不丢帧语义。
   修复：append 失败抛出/返回失败；仅在落盘成功后递增并广播，失败使任务进入 failed；
   注入只读/写失败存储测试实时流、jsonl、afterSeq 回放三者一致。

3. **畸形 WS 路径可同步抛 `URIError`。** `daemon/src/http.ts:129-134` 在 upgrade
   回调中直接 `decodeURIComponent(taskMatch[1])`，`/ws/tasks/%` 独立 probe 已得到
   `URIERROR_CONFIRMED`。未捕获异常可终止 daemon。
   修复：捕获 URIError，返回 400 并关闭 socket；严格校验 IdSchema；真实 WS 回归后再请求
   `/api/bootstrap` 确认进程存活。

4. **输入大小与 PNG 解压边界不足，存在匿名 DoS。** `daemon/src/rpc.ts:90-99` 先
   `Buffer.from(base64)` 再检查 32 MiB；`resources.import`（148-160）无上限。
   `daemon/src/png/codec.ts:99-160` 无 IHDR 像素上限、IDAT 上限或 inflate 输出上限，
   直接 `inflateSync` 后按攻击者尺寸分配。匿名默认开启，故无需账户。
   修复：在 base64 字符串边界拒绝并限制解码结果；import 同样限额；PNG 在 inflate 前限制
   宽×高/压缩输入，并使用有界解压或 `maxOutputLength`；补超长、超像素、压缩炸弹进程存活测试。

5. **上游原始响应可将 token/key 落到 debug.json。** `daemon/src/imgapi/client.ts:227-228`
   仅 `parsedResponse` 脱敏，`responseBodyText` 保留原文；`daemon/src/jobs/generate.ts:109-111`
   直接写入任务目录 `debug.json`。上游回显 bearer/API key 即可持久泄露。
   修复：原文先 JSON 解析后递归脱敏再序列化；非 JSON 只保留无敏感的截断摘要；测试嵌套
   `authorization`/`api_key` 和纯文本回显不得出现在 debug 文件。

6. **W0 排布契约不是可验证真源，active attempt 并发约束未实现。**
   `contracts/src/paving.ts:2-5` 明确采用手工镜像，`contracts/src/paving.test.ts:25-40`
   只重复常量；未实现 tasks.md:15/design.md:61-72 要求的真实 engine adapter→`layout()`
   等价 fixture。`contracts/src/session.ts:278-286` 与 `daemon/src/db/schema.ts:146-158`
   只有 `proposalId+attemptNo`、`retryRequestId` 唯一约束，没有“同 op 仅一个 active attempt”
   的数据库/原子 claim 约束。当前字面边界虽通过，后续引擎或并发实现会静默漂移。
   修复：共享/直接 re-export engine schema，并以真实引擎输出做深比较；增加 active 状态 partial
   unique index 或事务 claim，并发测试只产生一个 active attempt。

### P2

1. **条件性 SSRF、无界二段下载及取消信号丢失。** `daemon/src/imgapi/client.ts:245-256`
   直接 fetch 上游 `data[0].url`，无协议/私网 IP/重定向/大小/超时限制，二段 fetch 未传 abort
   signal。`IMG_BASE_URL` 当前由部署配置控制，故为上游条件性 SSRF/资源风险而非普通匿名可控 SSRF。
   修复：仅允许 https，拒绝 loopback/link-local/private/reserved，禁跨域重定向，限制流式下载，
   传递 signal，并用 redirect/private URL mock 测试。

2. **WS 订阅及取消后的生成资源泄漏。** `daemon/src/jobs/service.ts:163-171` 退订后保留空
   Set，按 taskId 永久增长；`service.ts:121-128` 只置取消位，`generate.ts:70-87` 在 runner
   内临时创建 InlineProvider，JobService 无法调用 provider.cancel，外层取消后外呼可能继续
   并写 blob。修复：空 Set 时删除 key；由 JobService 持有 AbortController/provider 引用，在
   cancel/stop 时 abort，并验证无孤儿 blob。

3. **`after_seq` 查询绕过契约整数校验。** `daemon/src/http.ts:188` 使用 `parseInt`，可接受
   `-1`、`1junk` 等并归零；contracts `tasks.ts:197-204` 要求非负整数。修复：严格正则与
   `TaskFramesInputSchema` 等价校验，非法 query 返回 400，补负数/浮点/尾随字符测试。

4. **格式往返测试可能假绿。** `daemon/src/formats.ts:96-120` 将整文档原样写入 blob，
   `:123-143` 原样回放；虽然四族深比较 4/4 通过，但未验证服务器资源模型对字段、资产引用、
   顺序和工程参数的解析/重建。W0 paving 也只是字面镜像测试。修复：保留原样 round-trip，
   另加真实 resource projection/reconstruction fixture 和 adversarial 字段断言。

## 逐波核对矩阵

| 波次 | 已复证 | 结论 |
|---|---|---|
| W0 | §3.5 的 create/list/get/followup/answer/cancel/clear/retry/replay/result 与 task.result schema；`retryRequestId`、`attempts` 字段和两项 DDL 唯一约束；Frame job/agent 两族、strict approval payload、afterSeq；density `(0,1]`、gapMm≥0、五 strategy 含 cvt、空 region/未知 ID/非法值拒绝。 | **部分通过**：手工镜像替代真源引用；缺真实 adapter→`layout()` 等价 fixture；同 op 单 active attempt 未落地。 |
| W1 | 根 workspace、contracts exports、十表 DDL、tasks `{job,agent}`、`attempts` 唯一约束、BlobStore sha256/ref_count、`<sha256>.<rowGen>`、staging→rename→DB 顺序、匿名自愈、admin upsert、`.env` 原位回写；engine smoke 真实 import/layout/exportSvg。 | **基础通过但不可验收**：禁用写面和匿名资源上限为 P1；W3 cleanup outbox/物理回收不计入本轮。 |
| W2 | oRPC-over-WS、task jsonl/afterSeq、dry-run、半配置拒绝、debug 结构、engine exportGate 阻断、PNG 软光栅五形/rotation/透明/custom、缺 assetId 与 `PNG_ASSET_UNRESOLVED` 分立、分享 containment/Range、四族 round-trip、真实 dist 托管进程 E2E。 | **功能主链通过，安全/一致性未通过**：P1-2 至 P1-5、P2-1 至 P2-4 阻断；W3/W4 Agent 与 W5.3 ComputeProvider 收口未计入。 |

## 独立复跑门禁

- `pnpm -C contracts exec vitest run`：**4 files, 39/39 tests passed**。
- `pnpm -C daemon exec vitest run`：**19 files, 92/92 tests passed**。
- `pnpm -C daemon run test:e2e`：**2 files, 3/3 tests passed**。
- `pnpm -C daemon run smoke:engine`：**PASS**，真实引擎调用结果
  `gemCount=68, dropped=0, svgBytes=3040, bomBytes=103`。
- 独立异常 probe：`/ws/tasks/%` -> **URIERROR_CONFIRMED**。

## 实现质量评价

包边界、BlobStore 代际路径、引擎 public export、PNG 软光栅和真实子进程 E2E 结构清晰；
但安全边界依赖测试未触达的假设：错误被吞掉、外部输入先分配后校验、raw debug 与 parsed debug
脱敏不一致，且契约真源由人工抄录。完成全部 P1 并补充对应负向测试后再复审。
