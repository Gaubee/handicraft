# Tasks

> R1 评审修订：新增 1.4（reqHash 投影）/2.5（SliceBudgetExhausted 识别链）/5.5（跨 taskId 回放）/5.6（时钟注入）；3.2/5.3 吸收 P2 修正。

## T1 断点账本+回放适配器

- [ ] 1.1 新建 `daemon/src/kernel/vision/segment-ledger.ts`：指纹（canonicalJson 键排序递归）/reqHash/append/load（Map 构建+坏尾行容错+坏 blobRef 行跳过+**同 hash 首行制**）/header 行；纯函数与 IO 分离；**append 后同步更新内存 Map**（同文请求即时命中，不重复真跑）。
- [ ] 1.2 `segment-tool.ts` runLoop 装配：fp 计算（resolveElements 后）→ 账本加载 → segment/analyze 双适配器接入命中回放/未命中追记（segment 的 maskBlobRef 取 `run.mask.blobRef`；analyze 条目内嵌 elements JSON）。
- [ ] 1.3 回放路径取消纪律：回放请求前 `throwIfCancelled()` 照旧（驱逐/终态对纯回放片同样生效）。
- [ ] 1.4 **reqHash 投影（R1-P0-1）**：哈希输入白名单 `{kind, imageBlobRef, imagePx, canvasCm, prompt, iteration, confThreshold?, maskMaxSide?}`——剔 taskId；投影函数带注释（跨任务命中依据+同文请求去重微语义漂移留痕）。

## T2 时间切片

- [ ] 2.1 `SEGMENT_TOOL_SLICE_MS` env（缺省 600_000）解析。
- [ ] 2.2 适配器预算检查：实跑桥调用前，`liveIssued>0 && now>=deadline` → 抛 `SegmentBudgetExhaustedError`（executor 私有类）。
- [ ] 2.3 **SliceBudgetExhausted 识别链（R1-P1-3）**：runLoop `.catch` 通用 wrap 之前判 `SegmentLoopError(bridge-failure) && cause instanceof SegmentBudgetExhaustedError` → checkpointed 正常返回（cause 两层包装均传 cause，拆链可行；不走 abort 面）。
- [ ] 2.4 `SubjectSegmentOutcome` 判别联合（status:'done'|'checkpointed'）；done 增 `replayedSegments`；checkpointed 携带 ledgerFp/banked/replayed/live/message。
- [ ] 2.5 capability handler：checkpointed 走 noteSuccess；工具描述更新（同参重调=断点续跑；续跑必须携带与首次完全一致的入参，复用会话历史中的原 sceneAnalysisRef）。

## T3 进度帧+看门狗

- [ ] 3.1 适配器进度帧：**实跑段逐段一帧**；回放阶段收束为**每片一帧汇总**（防 O(n²) 洪泛）；text 携带累计/回放/实跑/frontier 计数，ratio 省略。
- [ ] 3.2 `kernel/index.ts` `watchdogFrameProgress`：progress 帧=真进展；**导出为纯函数供单测**；注释冻结「progress=机器验证的进展（掩码/工件已落库才发）」纪律与 job 族 emitter 不进看门狗的事实。
- [ ] 3.3 contracts 微改（R2 精确四处）：`frame.ts` AGENT_FRAME_KINDS 增列 `'progress'` + `frame.ts:39` 交集注释改 `{done, error, progress}` + `frame.test.ts:23-30` 数组断言加 `'progress'` + `frame.test.ts:36` 交集断言改 `['done','error','progress']`（**并集断言不动**——progress 本在 job 族，FrameKindSchema.options 不变）。

## T4 GC+boot 接线

- [ ] 4.1 `SEGMENT_LEDGER_GC_DAYS`（缺省 14）+ boot 时 mtime 清扫（fire-and-forget，失败不阻塞 boot）。

## T5 时钟注入（R1-P0-2）

- [ ] 5.0 `SubjectSegmentDeps` 增 `now?: () => string` → runSegmentLoop deps.now 透传（finalize createdAt 确定性）；生产缺省真时钟。

## 测试（daemon=vitest+tsc）

- [ ] 5.1 `segment-ledger.test.ts`：指纹稳定性（同输入同 fp；任一锚点/元素变→fp 变）；投影 reqHash（taskId 变→hash 不变；prompt/iteration 变→hash 变）；append/load 往返；坏尾行/坏 blobRef 行容错；同 hash 首行制；mtime GC（注入 now）。
- [ ] 5.2 executor 续跑集成测（mock 桥录制面 `segmentRequests`）：
  - 基线：一次性跑完 → 记录桥请求列 R、树 blob X、账本行数 n（时钟注入固定值）；
  - 切片链：sliceMs 压到「每片 1 段实跑」→ 反复 invoke 至 done → 最终树 blob==X（**逐字节**）、桥实跑请求去重后==R（零重复重请求）、片数==n；
  - 进程重启模拟：新 executor 实例（重载账本文件）续跑 → 同上断言；
  - checkpointed 返回 kind='ok' 且熔断计数清零。
- [ ] 5.3 **跨 taskId 回放（R1-P0-1 回归网）**：同 fp 换 taskId 再 invoke → 全部命中零新增桥请求直至 done。
- [ ] 5.4 看门狗单测（导出纯函数面）：含 progress 帧的窗口 → progress=true；既有帧分类语义不回归（transcript/artifact/approval 各分支）。
- [ ] 5.5 **analyze 账本续跑测（R1-R1）**：vlmReentry=true 集成测——自注支持 analyze 的 mock 桥（内置 mock analyze=unimplemented）+输入 vlmReentry=true：切片链+跨 taskId 回放，断言 analyze 请求经账本去重（二次 invoke 零新增 analyze 桥调用）、最终树与基线一致（时钟注入）。
- [ ] 5.6 回归：既有 segment-tool/segment-loop/kernel 测试全绿（tsc+vitest）；contracts frame.test.ts 守卫更新后全绿。

## 验收

- [ ] 6.1 真链冒烟（独立实例+独立 DATA_ROOT+真 macmini 桥，勿动 8317/5200）：真图任务逐片链式完成；时间线见进度帧；五产物导出完整。
- [ ] 6.2 kill 恢复演练：切片中途 kill daemon → 重启 → 同参再调 → 从账本续跑（sam-logs 留存比对无重复段请求）。
- [ ] 6.3 零进展护栏：纯回放片至少银行 1 段实跑，agent 永不空转。
