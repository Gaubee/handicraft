# shufa→贴钻 同步分析（2026-09-25）

> 只读分析报告，未动两仓任何代码。源= `/Users/kzf/Documents/书法`（git root，branch main，HEAD=2691b82；任务书写的 master/子目录 shufa-server 实为同仓子目录，路径以 `shufa-server/` 前缀落在仓库根下）。目标= `/Users/kzf/Pictures/贴钻-backend`（HEAD=97ff581）。
>
> **时间线锚点**：shufa 仓 09-23 17:50 初始提交（朱墨），全历史都在一周内；`4111deb..2691b82` 是任务书给的主区间。贴钻 W4.1 移植=09-24 13:35（对应 shufa 09-24 早间的 df40a4e/ad6bb46 状态），W4.2=09-24 14:45–17:05。**同步缺口主要是 shufa 09-25 波（60fde54..2691b82 六提交）+ 版本漂移实证（新发现）**。

## 0. 结论速览

| 优先级 | 项 | 一句话 |
|---|---|---|
| **P1-1** | @deepseek-ai 全树版本收敛到 0.1.6-alpha.1 | typert-loader inactive 的根因高度疑似 alpha.1/alpha.2 混装；shufa 全树 alpha.1 无此故障 |
| P2-1 | 内核会话标题回填（2691b82） | session/title 帧→task 行 title；贴钻已有用户手填 title，内核标题做回填/补缺 |
| P2-2 | 轮内 usage 药丸（60fde54） | usage 家族 schema + 累计器；贴钻帧词汇不同需对照重写（usage 附到 done 帧 payload） |
| P2-3 | skill-filesystem 注册表打通机制（50ac577+ce25c13） | 机制照抄（patch 按 id 覆盖，**绝不 cordis.yml 插同 id entry**）；时机等贴钻出现技能消费面（W4.3+） |
| P3 | W4.3 参考：resume/模型热切（ad6bb46）、composer 目录+$skill/slash 分流（c9e09d7/7445fec）、selectTask 竞态守卫（dff6ab2）、agent 前端组件模式（2691b82/7445fec）、ZCode Registry 目录（7dce9f8/4111deb/d000f3a） | 贴钻对应面尚未开建，先记模式 |
| 已同步/已防御 | df40a4e 失败可见（W4.1 已含 error 明文）、f21e4ea SPA no-cache（http.ts:428 已有）、4d1c025 randomUUID（studio 已有 `'randomUUID' in crypto` 守卫） | 无需动作 |

## 1. 逐提交关联度表

### 1.1 主区间 09-25 波（60fde54..2691b82，同步缺口主体）

| commit | 改动面 | 与贴钻关系 | 理由 |
|---|---|---|---|
| 2691b82 对话区三轮 | kernel/sessions.ts +11（onSessionTitle 回调）；db/schema v5 tasks.title 列；db/tasks updateTaskTitleBySession；tasks/service applySessionTitle+投影；contracts TaskItem.title；boot.ts session-title-llm patch 行；webui ReasoningRow/TranscriptView/AgentToolRow | **择段同步（P2-1）+ 参考（P3）** | 标题链路是通用内核面特性（贴钻 session 已有用户手填 title——见 contracts/src/session.ts:24——内核标题做回填正合适）；session-title-llm patch 行（不配 provider/model 则 LLM 提炼恒败、回落首句截断）是隐性必要件；前端组件是 agent face 参考 |
| 7e65a0a 撤除 @ 面板 | kernel/sessions.ts −54（listUserFiles/ctx.fs 面）；rpc composer.files 撤；tasks/service userFiles 撤；contracts composer 收窄 | **无关（净效果=撤销）** | shufa 自己撤掉了 71ea8d8 加的面；贴钻从未有过 @ 文件面板。唯一保留值：若将来做文件浏览，ctx.fs containment 守卫（resolve+contains 防越权）模式可参考 |
| 71ea8d8 @ 面板接 ctx.fs | kernel/sessions.ts +55（KernelFsLike/listUserFiles）；rpc composer.files；tasks/service userFiles | **无关（随后被 7e65a0a 撤销）** | 加了又撤；同步它=同步一个死特性。教训保留：面板数据源走 DSH 标准服务而非自拼 fs |
| ce25c13 技能路径锚定+撤出禁用清单 | kernel/prompts.ts defaultSkillDocPath 改模块位置锚定（修 envFile 锚定悬空 bug）；tool-surface KERNEL_DISABLED_TOOL_ROWS 撤 skill-filesystem | **择段同步（P2-3 一半）+ 贴钻无此 bug** | 贴钻 prompts.ts:14 已是 fileURLToPath 模块锚定（persona.md），路径锚定 bug 不存在；「撤出禁用清单」是否同步取决于贴钻是否要技能注册表（见 §3） |
| 50ac577 skill-filesystem 挂载改 patch 按 id 覆盖 | kernel/boot.ts（cordis.patch.yml 加 skill-filesystem config 覆盖行，撤 cordis.yml entry 式插入） | **参考（机制照抄，时机后置）** | 关键教训：base bundle 已含 skill-filesystem row，cordis.yml 再插同 id entry → duplicate loader entry id → 整树挂（mini 实证）；官方按 row 覆盖面=cordis.patch.yml，last write winning per row |
| c9e09d7 $///@ 面板对齐 DSH 官方行为 | kernel/sessions.ts +142（listCommands 探针缓存/listUserSkills/deliverSkillInvocation 官方双消息注入）；boot.ts +skillsDir+skill-filesystem row（后被 50ac577 修正）；rpc composer.list；daemon 依赖 +dsh-skill；tasks/service composerCatalog | **参考（P3，W4.3+）** | composer 目录（/命令+$技能出自内核注册表，非产品硬编码）与 $skill 官方注入语义（用户原话在前+skill-invocation 源 instructions 在后）是 W4.3 编辑旅程的成熟参考；贴钻无任何 composer 端点（rpc.ts 只有 session.* / stones / sets） |
| 7445fec 前台对齐 skill-creator-v2 | sessions.ts +67（followup 内 slash 分流/$skill 分流+reasoningEffort）；db/schema v4 model_effort 列；tasks service effort 三态（undefined/null/值）；resources.ts path 投影；webui ContextMeter/TriggerMenu/TaskComposer/ComposerCard | **参考（P3）** | 任务级 effort 列与 reasoningEffort 透传是通用面，但贴钻 tasks 表是 job/agent 型+params JSON（无 model_* 列），单路由 modelSelection() 同步——真要支持需连同多路由波一起设计；webui 组件是 agent face 参考 |
| d000f3a source 撤出输出面 | contracts models、extract 脚本、zcode-presets、webui | 无关（models admin 内务） | 仅当贴钻采纳目录（P3）时连带 |
| 4111deb 目录主体对齐 ZCode Registry | models-catalog −60（pi-ai 内置长尾退出）、zcode-presets 为主源 | **参考（P3）** | 贴钻 kernel/model-route.ts 是 W4.1 单路由（.env LLM_*→settings.yaml 桥），「settings 表 models_* 多路由」明确归后续波；届时 extract-zcode-presets.mjs+目录法直接可搬 |
| dceed9f 模型 id 补全预填 efforts | webui only | 无关 | models admin UI |
| 7dce9f8 接入 ZCode Registry 预设 | +extract-zcode-presets.mjs（253 行）+zcode-presets.ts（3214 行生成物，20 provider/244 模型，contextWindow+efforts） | **参考（P3）** | 同 4111deb；生成物勿手改、随上游 revision 重跑的工作法值得沿用 |
| 60fde54 五项遗留收尾 | firehose-events +58（TokenUsageSchema 家族+MessageUsage/AttemptUsage/usageOfAttemptStream）；sessions.ts +79（轮内 usage 累计器+turn/end 收割）；wizard/结果页（贴钻无关） | **择段同步（P2-2）** | usage 药丸是通用内核面；贴钻 firehose-events.ts 只有 5 个 schema（Message/TurnEnd/ToolCall/ToolResult/ObjectPayload），无 title/usage/chunk/todo 家族——同步需对照重写（帧词汇不同） |

### 1.2 09-24 波（大部分已被 W4.1 移植覆盖或与贴钻无关）

| commit | 与贴钻关系 | 理由 |
|---|---|---|
| ad6bb46 聊天中切换模型（disposeLive+resume 热切+任务级 model 列） | 参考（P3） | W4.3 多轮/换模型的直接参考；贴钻 sessions.ts 无 resume/followup/disposeLive（A5 明确归 W4.3） |
| df40a4e 失败必须可见（error 明文全链） | **已同步** | 贴钻 sessions.ts settle() 已带 reason.error.message/code 明文（TurnEndEventSchema 已含 error 面）；W4.1 移植时已覆盖 |
| 39fcf91/f612af8/19878e5 models 五轮重构+路由修复 | 无关/参考 | shufa models admin 产品面；19878e5（模型 id 不回传父级）是表单数据流 bug，贴钻无该面 |
| 4d1c025 randomUUID secure context 崩溃 | **已防御** | rhinestone-studio 已有 `typeof crypto !== 'undefined' && 'randomUUID' in crypto` 守卫（openIntent.svelte.ts:60、lab.svelte.ts:210、assetStore.ts:223） |
| 05e2541/012e584/f44ccd8/7dda4be warm（HF 下载/Xet/续传） | 无关 | whisper 模型预热，贴钻无此面 |
| be8ac79/7f6f06f/a52a5d4/9a851bf/61b5593/538fdbc wizard 系列 | 无关 | 安装向导（python/whisper/管理员）shufa 产品面 |
| 58e844b LOGO | 无关 | — |
| f21e4ea SPA 入口 no-cache | **已同步** | 贴钻 http.ts:428-434 已是 index.html no-cache+hash 资产长缓存+SPA 回退 |
| b9ca0e4/e9bd4d6 向导实时日志/账号语义 | 无关 | — |
| 31fac14 知识库条目渲染崩溃（渲染期懒写 $state 被禁） | 参考（P3） | Svelte 5 通用陷阱（渲染期不得写 $state）；rhinestone-studio 同为 Svelte 5，走查时留意同款 |
| ae8e3b4 书法领域知识库 | 无关 | 领域特化 |
| bfe1ebe 结果页 500（data.json 与契约不符 transcript.model=null） | 无关 | shufa analysis 管道；但「落盘 JSON 必须过同一 Zod 契约」的教训通用 |
| 70d8ffe 需求补账四件（气泡省略/乐观显示/转录对齐/附件） | 参考（P3） | agent face 前端参考（乐观帧+真实 user 帧去重在 dff6ab2 里也见到） |
| ff4dd29 目标三项（kb 搜索/视频播放/双栏标签） | 无关 | shufa 产品面 |
| dff6ab2 selectTask 竞态守卫 | 参考（P3） | **贴钻当前无同款 bug**——rhinestone-studio 无任务切换 store（agent face 未建）。模式值得在贴钻建 agent face 时直接照抄：切换先清 results、三个异步落点后校验 selectedId===taskId、等待期切走立即退订（localhost 走查会掩盖竞态——响应顺序恒定） |
| 2d7387a 详情面板 shadcn Tabs+三栏可拖拽+移动端抽屉 | 参考（P3） | 贴钻 studio 面已自有体系；仅 agent face 将来可参考三栏/抽屉模式 |
| 3f131c7/1f6d072/07f0542/22cceb5/5f85559 webui 走查修复/视频播放器/logo | 无关 | shufa 产品面（07f0542 移动端面板状态常驻的思路可留意） |
| 9163541 初始提交 | 无关 | 基线 |

## 2. 应同步清单（优先级排序）

### P1-1：@deepseek-ai 依赖树版本收敛到 0.1.6-alpha.1 线（修复类）

- **源**：无单 commit——两仓 `node_modules/.pnpm` 版本清单实证（2026-09-25）。shufa 全树 137 个 @deepseek-ai 包**统一 0.1.6-alpha.1**（lockfile 09-23 冻结）；贴钻直接依赖同样钉 alpha.1（两边 daemon/package.json 完全同款 9 包），但传递依赖在 09-24 安装时漂移到 **0.1.6-alpha.2**（typert-loader/typert-registry/typert-protocol/session/llm/…大面积 alpha.2，另有 0.1.5-rc.3 残留双版本）。W4.1 R2 评审自己把「版本漂移风险」列为未闭合残余项。
- **贴钻目标文件**：`daemon/package.json`（可加 pnpm overrides）+ 根 `pnpm-lock.yaml`（重装再生）。
- **移植方式**：对照 shufa 的 `pnpm-lock.yaml` 参考线收敛——最稳妥是根 package.json `pnpm.overrides` 把 `@deepseek-ai/*` 钉到 0.1.6-alpha.1 后 `pnpm install` 重新生成 lockfile；或直接更新全部直接依赖钉到 alpha.2 一致线（**不建议**——shufa 参考线=alpha.1，跨线会引入未经两仓验证的新组合）。
- **验证**：`pnpm -C daemon test`（全量）、`tests/e2e-kernel.test.ts`（5/5）、真实 boot 探针后 `kernelState=ready` 且 boot record `inactiveActivation` **为空**（typert-loader 转 ACTIVE）；`tests/kernel.test.ts` 的 inactiveActivation 断言按新基线修正。若收敛后 typert-loader 仍 fiber=3，则确属上游 optional 噪声，维持 W4.1 R2 裁定（warning+显式暴露，不降级不误杀）。

### P2-1：内核会话标题回填（源 2691b82）

- **源文件**：`shufa-server/daemon/src/kernel/sessions.ts`（onSessionTitle dep+session/title 帧投影）、`firehose-events.ts`（SessionTitleEventSchema）、`db/tasks.ts`（updateTaskTitleBySession）、`db/schema.ts`（v5 title 列）、`tasks/service.ts`（applySessionTitle+TaskItem.title 投影）、`kernel/boot.ts`（**session-title-llm patch 行**——不配 provider/model 则 LLM 提炼恒败「no logged request route」，标题恒回落首句截断）。
- **贴钻目标文件**：`daemon/src/kernel/firehose-events.ts`（+SessionTitleEventSchema）、`kernel/sessions.ts`（projectEvent 加 `session/title` case→回调；注意贴钻帧词汇是 A1 五类，标题**不落帧**、直接回调即可）、`db/jobs.ts`（tasks 表加 title 列 or 复用既有 session title 语义）、`db/schema.ts`（migration v6）、`kernel/boot.ts`（cordis.patch.yml 追加 session-title-llm 行，provider/model 取 resolveSingleRoute 结果）、`contracts/src/session.ts`（title 投影——贴钻 SessionCreateInput 已有手填 title，语义定为「内核标题仅回填空缺/或覆盖策略由编排者定」）。
- **移植方式**：择段对照重写（贴钻帧提交走 jobs.emitFor 单点、无 FrameStore 环；shufa 的 commitFrames 钩子位在贴钻对应 projectEvent 内）。
- **验证**：`tests/sessions-rpc.test.ts`、`tests/kernel.test.ts`、`tests/e2e-kernel.test.ts` 全绿；新增「session/title 事件→task 行 title 回写（幂等/空串丢弃）」单测；boot 探针确认 patch 行写入（无默认模型时缺省行也要写，回落语义与 shufa 一致）。

### P2-2：轮内 usage 药丸（源 60fde54）

- **源文件**：`firehose-events.ts`（TokenUsageSchema/TokenUsageSample/MessageUsageEventSchema/AttemptUsageEventSchema/usageOfAttemptStream——TokenUsage 消费面按 dsh-llm types.d.ts 实证）、`kernel/sessions.ts`（TurnUsageAccumulator：turn/start 清零→message/attempt 逐样本累加→turn/end 收割；超安全整数整轮放弃宁缺毋错）、`test/frame-projection.test.ts`（91 行投影测试）。
- **贴钻目标文件**：`kernel/firehose-events.ts`（+usage 家族）、`kernel/sessions.ts`（累计器；收割点=贴钻 settle(done) 路径，usage 附到 done 帧 payload——贴钻无 turn-end 帧）。
- **移植方式**：对照重写（收割落点不同；schema 家族可近乎原样搬）。
- **验证**：新增 usage 累计/溢出放弃/缺桶不算 0 单测（照 shufa frame-projection.test.ts 用例形状）；`tests/kernel.test.ts`/`tests/kernel-live.test.ts` 全绿。

### P2-3：skill-filesystem 注册表打通（源 50ac577+ce25c13）——条件触发

- **触发条件**：贴钻出现技能消费面（W4.3 旅程若需要 $skill/技能注入，或产品技能要进内核注册表）。当前贴钻 preset 是 persona-only+deny-list 双层收窄（W4.1 语义），skill-filesystem 在禁用清单是**有意为之**，现状不算 bug。
- **届时照抄的机制**（贴钻目标 `kernel/boot.ts`+`kernel/tool-surface.ts`+新增 skillsDir option）：
  1. **绝不能**在 cordis.yml 里插 `id: skill-filesystem` entry——base bundle 已有该 row，duplicate loader entry id 会**整树挂**（shufa mini 实证：plugin tree failed）；必须走 `cordis.patch.yml` 按 id 覆盖 config（`includeDefaultRoots: false` + `customSkillDirs: [<skills 根>]`），cordis 语义 last write winning per row。
  2. 同步把 `skill-filesystem` 从 KERNEL_DISABLED_TOOL_ROWS 撤出（贴钻 tool-surface.ts:18 现仍在清单）；`tool-skill`（模型自取技能工具）保持禁用——技能消费走 host 注入。
  3. skills 根锚定用模块位置（贴钻 prompts.ts 已同法，无 shufa 的 envFile 悬空 bug）。
- **验证**：boot 探针 `ctx.skills.list()` 含产品技能、`ctx.commands` 可探针（shufa 实证输出形状：skills=[<product>(user)] + commands=/compact /feedback /goal /permission /plan）；kernel 四态 E2E 不回归。
- **allowBuilds 面**：贴钻根 pnpm-workspace.yaml 已有 allowBuilds（dsh-subprocess-local/koffi/node-pty=false，better-sqlite3/esbuild=true）且真实 boot 79 ACTIVE——挂载面无需照抄 shufa（shufa 反而没有 allowBuilds 配置）。仅在未来升 dsh 版本引入新原生包时 revisit。

### P3：参考类（不逐行同步，开建对应面时取用）

1. **W4.3 多轮/换模型**（ad6bb46+c9e09d7/7445fec 的 sessions 面）：resume（内核 session log 重建 LLM 历史+帧 jsonl 末尾 seed）、disposeLive（换模型只 dispose 不动帧）、followup 的 slash 分流（ctx.commands.execute，未命中回落普通消息）与 `$skill` 官方双消息注入（用户原话在前+renderSkillContent 以 skill-invocation 源在后）、composerCatalog（命令探针一次缓存+技能注册表投影——数据源=内核注册表非硬编码）。贴钻 sessions.ts 到时对照重写，注意其 subscribe/stream/answer 面贴钻已有等价物（jobs.emitFor/rpc.answer）。
2. **agent face 前端**（2691b82+7445fec+70d8ffe+dff6ab2）：ReasoningRow 的测量式按需展开（流式折叠摘要+自动展开，定稿短文直显/长文手动展开，scrollHeight 测量与 UserBubble/AgentToolRow 同源）；ContextMeter 上下文水位；TriggerMenu/ComposerCard；乐观帧+真实 user 帧去重；**selectTask 竞态守卫模式**（见 §1.2 dff6ab2 行——localhost 走查掩盖竞态的教训直接引用）。rhinestone-studio 现无任何 agent/transcript 组件（已 grep 证实），这些是未来新面的起点参考。
3. **ZCode Registry 模型目录**（7dce9f8/4111deb/d000f3a）：extract-zcode-presets.mjs（上游 Apache-2.0，zcode-builtin.json→生成物，随 revision 重跑）+zcode-presets.ts（20 provider/244 模型含 contextWindow/efforts）。贴钻多路由波（「settings 表 models_*」）开建时整体搬，含 d000f3a 的「source 只作后端管道标记不进输出面」裁决。
4. **通用工程教训**：31fac14（Svelte 5 渲染期禁写 $state）、bfe1ebe（落盘 JSON 与契约同源校验）、7e65a0a（面板触发对齐 DSH 官方面——产品不自造第三种触发）。

## 3. 特别回答：typert-loader inactive 能否由 shufa 的 skill-filesystem 打通解决

**不能——不是同族问题。证据链：**

1. **是两个独立插件**。dsh-base 的 cordis.patch.yml（`daemon/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:39-45,276-277`）同时含 `typert-loader`（@deepseek-ai/dsh-typert-loader）与 `skill-filesystem`（@deepseek-ai/dsh-skill-filesystem）两行，互不依赖。
2. **shufa 的打通不触碰 typert**。50ac577/ce25c13 只做两件事：skill-filesystem 的挂载方式从「cordis.yml 插 entry（dup 整树挂）」改为「patch 按 id 覆盖」+ 从禁用清单撤出。shufa 仓 grep `typert` 零命中——它从未有 typert 问题需要修。
3. **typert-loader 的失败机制**（贴钻侧 dsh-typert-loader@alpha.2 lib/index.js 源码实证）：监听 `internal/plugin` 事件→对每个插件 loadManifest→`ctx.typert.register(manifest)`，任一 contributor 注册失败即聚合抛 `AggregateError("N typert contributor(s) failed to register")`→fiber=3。这是**插件内容器注册失败**，不是挂载面（row/entry）问题。
4. **根因高度疑似贴钻树版本漂移**（P1-1）：贴钻 dsh-base@0.1.6-alpha.1（bundle 定义者）混装 alpha.2 的 typert-loader/typert-registry/typert-protocol 与大面积 alpha.2 插件（manifest 生产者）——alpha.1 bundle 行声明的 config/清单契约 vs alpha.2 注册表期待的 codec 契约错位，恰好落进 contributor 注册失败。shufa 全树 alpha.1 一致，无此故障（ce25c13 探针：commands/skills 注册表实证可用）。
5. **处置建议**：先做 P1-1 版本收敛再观察；收敛后仍 fiber=3 才按上游 optional 噪声保留（W4.1 R2 已裁定：warning+inactiveActivation 显式暴露，不得全量 FAILED 降级误杀健康树）。skill-filesystem 打通照抄与否与此问题**完全解耦**（见 P2-3 触发条件）。

## 4. 分析方法与证据局限

- git 只用 log/diff/show；跨仓 diff 用工作树文件直比（shufa 工作树=HEAD=2691b82 干净态，贴钻=97ff581）。
- typert 结论基于静态证据（bundle yml/插件源码/两仓版本清单）；未起 daemon 实测（零常驻纪律）。若需终验，P1-1 收敛后跑一次 boot 探针看 inactiveActivation 即可闭环。
- shufa `data/dsh-home/profiles/kernel/` 下的 cordis*.yml 是**陈旧落盘**（仍见 skill-filesystem disabled——09-25 前某次 boot 的残留），不代表 HEAD 代码行为；boot.ts 每次 boot 重写这两文件。
