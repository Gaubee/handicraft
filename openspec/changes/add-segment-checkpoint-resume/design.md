# Design：段循环断点续跑

> 评审修订版（research R1，6/10→修订）：P0×2（reqHash 含 taskId / createdAt 未注入）+
> P1×3（SliceExhausted 穿越机制 / vlmReentry 分叉 / 静默杀宣称）+ P2×7 全部落设计。

## 0. 数据流总览

```
agent ──调用──▶ studio.subject.segment（同参数）
                  │
                  ▼
        SubjectSegmentExecutor.runLoop
                  │  fp = sha256(imageBlobRef|imagePx|canvasCm|elements 规范化)
                  ▼
        DATA_ROOT/segment-ledgers/<fp16>.jsonl ──加载──▶ Map<reqHash, entry>
                  │
                  ▼
        deps.segment / deps.analyze 适配器（每请求）：
          reqHash = sha256(canonicalJson(project(request)))   [★投影剔 taskId]
          ├─ 命中 → 回放（segment=blob 读掩码 / analyze=内嵌 elements）  [零桥调用]
          ├─ 未命中 → 预算检查 → 桥.run() → 桥 materialize 已落 mask blob
          │            └─ throwIfCancelled 复查 ──▶ 追记账本行 ──▶ 进度帧
          └─ 预算耗尽（且本片已银行 ≥1 段）→ SliceBudgetExhausted
               └─ 适配器抛出 → callBridge 包成 bridge-failure(cause) →
                  runLoop .catch 拆 cause 链识别 → status:'checkpointed' 正常返回
                  ▼
        循环终态 → persistTreeWithPreview → status:'done'（+replayedSegments 审计面）
```

## 1. 确定性回放的正确性依据

- segment-loop.ts 头注冻结：「同 deps 脚本 ⇒ 同请求序同产物」。逐面核对：
  - 首轮元素序 `relations.orderedIndices`：深度排序+同深度数组序，确定性（contracts/kernel.ts 注释明写）；
  - 后续轮 frontier 序：创建序入队（:992/:1116/:1127），nextSeq 确定性 id 源；
  - 兄弟消解胜者裁定三分支全确定（drillWorthy → popcount 小者 → 创建序早者，:641-646）；
  - 提示模板/stop-criteria/Lab 测量：纯函数无时钟无随机。
- **vlmReentry 分叉（R1-P1-4）**：`deps.analyze` 是真 VLM 调用（:1023-1046），hint 覆写会改变后续请求。**处置：analyze 响应同样入账本**（条目 kind='analyze'，elements 内嵌 JSON）——回放时 analyze 也命中，hint 恢复一致 → 后续请求序保持确定。两个 deps 注入面（segment/analyze）都走同一适配器模式。
- **reqHash 投影（R1-P0-1）**：`SamSegmentRequest` 锚点含 `taskId`（调用方上下文，非分解内容）——**哈希输入做白名单投影**：
  `{ kind, imageBlobRef, imagePx, canvasCm, prompt, iteration, confThreshold?, maskMaxSide? }`
  （剔除 taskId——followup/steer 落新 task 后条目才能跨任务命中；analyze 同理）。tuned 请求经 zod strict schema 过滤无杂键；`tuneSegmentRequest` 仅在非 undefined 时展开键，undefined 漂移被 JSON 序列化自然吸收；canonicalJson 键排序递归。
- 分叉安全：判据参数（maxGemDiameterMm/maxIterations/maxNodes）不进请求正文、只影响请求序——参数漂移自然表现为 miss → 走真桥，无错配。tuner 中途改设置同理由 miss 兜底（代价=丢该段进度，重请求）。
- **同轮同文请求去重留痕（R1-P2-6）**：两个元素 box+hint 完全相同时首轮请求同文 → 同 reqHash → 回放复用一响应（原本是两次独立 SAM 采样）。属可接受的微语义漂移（省一次采样），代码注释留痕。
- **回放掩码等价性**：桥 `materialize` 的 mask 恒为画布尺寸归一后 blob（`nearestResampleMaskBits` 后 putTaskArtifact，sam-bridge.ts:1221-1229）→ `resolveMaskBits` 读回与首轮一致 → `ensureCanvasMask` 校验自然通过。
- 同轮重复请求语义：未封停 frontier 节点每轮以不同 `iteration` 重询（SAM 随机采样是设计行为）——跨轮 hash 不同，回放不做轮间去重。

## 2. 账本（segment-ledger.ts）

- **路径**：`DATA_ROOT/segment-ledgers/<fp16>.jsonl`，`fp16`=指纹 sha256 前 16 hex。
- **指纹**：`sha256(canonicalJson({ imageBlobRef, imagePx, canvasCm, elements }))`——elements 为 resolveElements 产物（工件读回或直注，均过 zod parse，键序由 canonicalJson 消化）。不含 taskId/判据参数：指纹职责仅「同分解输入归同一账本」；条目级分叉由投影后 reqHash 兜底。
- **行格式**（jsonl 逐行 appendFileSync，同 frames.jsonl 纪律；判别联合）：
  ```json
  {"v":1,"kind":"segment","reqHash":"…64hex","maskBlobRef":"…64hex","score":0.83,"model":"…","ts":"ISO"}
  {"v":1,"kind":"analyze","reqHash":"…64hex","elements":[…],"ts":"ISO"}
  ```
  首行 header `{"v":1,"fp":"…","taskId0":"…","createdAt":"ISO"}`（审计面，加载不依赖）。
- **容错与确定性**：坏尾行（崩溃半行）跳过；maskBlobRef 读不到的行跳过（自愈=重请求）；**同 reqHash 多行取首行**（驱逐竞态下旧循环补记可能与新循环并发写同 hash——内容同为合法响应，首行制保证回放确定）。
- **单写者假设（R1-P2-4）**：appendFileSync 跨进程无锁——本设计假设单 daemon 实例独占 DATA_ROOT（现状成立：8317 唯一生产实例）。验收用独立实例须配独立 DATA_ROOT。
- **GC**：boot 时扫目录删 mtime > `SEGMENT_LEDGER_GC_DAYS`（缺省 14）的文件；不做 blob 存在性回查（读放大不值，缺失自愈）。会话三段清不级联删账本。
- **blob 生命周期诚实框定（R1 遗漏面）**：mask blob 经 putTaskArtifact 挂在**首次实跑任务**的 fence/ref_count 下（jobs/service.ts）——跨 task 续跑在**原会话存活期内**成立（followup/steer 新 task 正是此形态）；原会话被清 → blob 释放 → 账本成死条目 → 回放 miss 自愈重跑。跨会话不承诺。

## 3. 适配器改造（segment-tool.ts runLoop）

```
deps.segment(request):
  throwIfCancelled()                        // 照旧（回放也尊重驱逐/终态）
  tuned = tuneSegmentRequest(request, tuner)
  reqHash = sha256(canonicalJson(project(tuned)))
  hit = ledger.get(reqHash)
  if hit: return replay(hit)                // 不逐段发帧（见下）
  if liveIssued > 0 && now() >= deadline: throw new SegmentBudgetExhaustedError(…)
  run = bridge.run(tuned, {signal})         // 真桥
  throwIfCancelled()                        // 响应后复查（R1-P2-7：驱逐竞态串行化）
  ledger.append({reqHash, maskBlobRef: run.mask.blobRef, score, model, ts})
  liveIssued++; emitProgress(live)          // 实跑段逐段一帧
  return …

回放收束：回放阶段结束（首帧实跑前）发**一帧汇总**（「回放 r 段完成，继续实跑」）
——回放不逐段发帧（R1-P2-3：n 段图反复重放前缀，逐段发帧=O(n²) 洪泛进
frames.jsonl 与时间线；汇总帧后总帧量 O(n)）。
```

- **进度帧**：`jobs.emitFor(taskId, 'progress', { text: '语义抠图 · 累计 N 段（本片回放 r + 实跑 l）· 待细分 f' })`；ratio 不可知（frontier 动态）省略。
- deps.analyze 适配器同构（命中回放 elements；未命中真调用+追记）。

## 4. 时间切片（T2）

- **预算**：`deadline = loopStartedAt + sliceMs`；`sliceMs = env SEGMENT_TOOL_SLICE_MS` 缺省 `600_000`（10min；20min MCP 窗留 2× 余量）。检查仅在实跑桥调用前（回放免费；在途不中断）。
- **零进展护栏**：`liveCalls === 0` 时永不切片（liveCalls=实跑桥调用总数，含 analyze——vlmReentry 片可只银行 analyze 行而 liveSegments 横盘）——保证每片至少银行 **1 次桥调用**，杜绝「checkpointed→重调→又 0 段」agent 死循环。
- **SliceBudgetExhausted 识别链（R1-P1-3，咽喉设计）**：适配器抛 `SegmentBudgetExhaustedError`（executor 私有类）→ segment-loop `callBridge`（:751-762）将其包成 `SegmentLoopError('bridge-failure', {cause})` → runLoop 的 `.catch`（segment-tool.ts:628）**在通用 wrap 之前**判定：
  ```ts
  error instanceof SegmentLoopError && error.kind === 'bridge-failure'
    && error.cause instanceof SegmentBudgetExhaustedError
  ```
  → 组装 checkpointed 正常返回（cause 链两层包装均传 cause，保真）。不走 abort/cancelled 面（与驱逐/终态取消语义纠缠）。
- **收敛面**：
  ```ts
  { status:'checkpointed', ledgerFp, bankedSegments, replayedSegments, liveSegments,
    message:'切片预算到点，已银行 N 段。请以与首次调用完全一致的入参再次调用本工具续跑，直至 status=done。' }
  ```
- **熔断面**：checkpointed 走 `noteSuccess`（清连败计数）——正常结果不进 RUNAWAY。
- **超窗兜底（杀而不死）**：即使片被桥队列拖过 MCP 窗/看门狗窗，agent 重试+驱逐后账本仍在——重调回放续跑，**进度单调不减**。

## 5. 看门狗口径（T3，kernel/index.ts）

`watchdogFrameProgress` 增：
```ts
case 'progress':
  progress = true; activity = true; break;
```
- **措辞修正（R1-P1-5）**：progress 帧不能宣称「静默杀消失」——桥并发 1+队列深 8+单请求超时 5min，多任务挤队列时等待期可 >30min FOLLOWUP 窗且零帧，首窗杀仍会发。真实语义=**杀而不死**：杀后账本保留，重调即续跑。
- **emitter 事实（R1-P2-1）**：progress 帧现有生产 emitter 在 job 族（jobs/engine.ts、jobs/generate.ts、sleep-job.ts）；看门狗只武装 agent 任务（armWatchdog 仅 agent 会话路径调用），job 帧永不进 watchdogFrameProgress。本变更后 agent 任务首个 progress emitter=段循环适配器。发出纪律冻结：**progress 帧=机器验证的进展**（掩码/工件已落库才发）——后续 emitter 必须遵守（写入 watchdogFrameProgress 注释）。
- 待批保护/双窗熔断/静默杀语义不动（progress 只把真进展集合加一元）。
- **可测性（R1-P2-5）**：watchdogFrameProgress 导出为纯函数供单测（现私有且 daemon 无 watchdog 测试先例）。

## 6. 跨任务续跑（T4）

- followup/steer 落新 task 新会话（kernel/index.ts:63-65）→ 账本按内容指纹全局键控 + **reqHash 投影剔 taskId**（§1）→ 新 task 同图同 sceneAnalysisRef 条目级命中。
- 边界（§2 blob 生命周期）：原会话存活期内有效；原会话清理后自愈重跑。
- 前提：agent 续跑**复用会话历史中的原 sceneAnalysisRef/入参**（重新 scene.analyze 产新 elements→新指纹→新账本）。工具描述显式写明。

## 7. 结果面（破坏性更新）

```ts
type SubjectSegmentOutcome =
  | { status:'done'; treeArtifactRef; previewRef; warnings; channel; iterations;
      totalNodes; nodes; meta; replayedSegments: number }
  | { status:'checkpointed'; ledgerFp; bankedSegments; replayedSegments;
      liveSegments; message }
```
- **时钟注入（R1-P0-2）**：`SubjectSegmentDeps` 增 `now?: () => string`，透传给 runSegmentLoop deps（finalizeSegmentLoop 的 createdAt 用 `deps.now?.() ?? new Date()`，segment-loop.ts:1224 已有注入位——executor 现未接线）。测试传固定值 → 「树 blob 逐字节一致」断言可执行；生产缺省真时钟。
- 消费方=agent 叙事面+测试；studio 泛渲染工具结果，无结构化消费方。

## 8. 风险与边界

| 风险 | 处置 |
|---|---|
| materialize 落 blob 与账本 append 间隙崩溃 | 该段重做（at-least-once，单段代价）；blob 无引用残留由内容寻址去重 |
| agent 不链式续调 | 结果 message 显式指令+工具描述；最坏=用户「继续」，账本仍生效 |
| 桥队列等待期零帧被看门狗杀（多任务并发） | 杀而不死：账本保留，重调续跑；单任务场景无队列竞争（Owner 291 段痛点正是单任务） |
| 同 hash 并发双写（驱逐竞态） | 首行制回放（§2）；append 在响应后复查之后（§3） |
| 多 daemon 实例并发写同一账本 | 单写者假设（§2），验收独立实例配独立 DATA_ROOT |
| ENOSPC（机器前科） | 账本增量=segment 行 ~200B 文本（analyze 行 elements 内嵌为 KB 级）；掩码 blob 本来就要写 |
| 元素清单大 | 哈希输入 KB 级 JSON，无性能问题 |
| 账本 v1 演进 | 行带 v 字段；加载按行容错，schema 演进按行跳过 |

## 9. 明确不做（本变更外）

- 看门狗/超时阈值调参（FOLLOWUP_TIMEOUT_MS/MCP_TOOL_CALL_TIMEOUT_MS 不动）。
- 桥层自动重试/熔断（61e168b 已有超时三件套）。
- 账本 UI 管理面（进度帧已上时间线）。
- 291 段并行化（SAM 桥并发 1=macmini 单卡物理约束——另议）。
- 桥队列等待期心跳帧（杀而不死已覆盖；心跳会稀释 progress=机器验证进展的纪律）。
