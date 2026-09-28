# zhumo 方案 1:1 移植：模型设置 + chat 面板（2026-09-28）

> Owner 裁决原文：「模型的设置你没有完全复刻 zhumo 提供的方案……你提供好我配置好就这么简单，你现在只是提供了一个表单给我填=偷懒。还有 chat 面板也是，zhumo 已做好，1:1 复刻就对了」。
> 源=`/Users/kzf/Documents/书法/shufa-server`（只读；webui/src/lib/components/{models,agent}/ + daemon/src/{models-catalog,models-store,test-route-connection}.ts + zcode-presets.ts + contracts/src/api/models.ts）。目标=本仓（HEAD=500729b 基线）。契约新增面走本 change 冻结流程（contracts/src/models.ts + index barrel）。

## 块 A：模型设置（多路由真源化）

| 源（shufa-server） | 行数 | 落点（贴钻-backend） | 移植形态 |
|---|---|---|---|
| contracts/src/api/models.ts | 152 | contracts/src/models.ts（+index barrel） | 1:1；+ModelRouteInfoSchema（bootstrap 投影——zhumo 放 webui types 本地，贴钻收敛进契约） |
| daemon/src/models-store.ts | 195 | daemon/src/models-store.ts | 1:1；legacy 收编源=settings llm_* → .env LLM_*（config.llm——贴钻旧单路由在 .env 不在 settings 表）；buildRoutesBundle 输出贴钻 ModelRoutesBundle 形（efforts 不进桥——settings.yaml 模型条目只携带 id/contextWindow，effort 消费面属后续波） |
| daemon/src/models-catalog.ts | 129 | daemon/src/models-catalog.ts | 1:1（zcode 策展 + models.dev 刷新缓存） |
| daemon/src/zcode-presets.ts | 3198 | daemon/src/zcode-presets.ts | 生成文件整拷；import 改 @handicraft/contracts |
| daemon/src/test-route-connection.ts | 99 | daemon/src/test-route-connection.ts | 1:1（三协议 probe 矩阵 + 脱敏 + 10s 超时，永不 throw） |
| daemon rpc admin.models 五端点 | — | daemon/src/rpc.ts models 六端点 | 语义 1:1；挂 `models` 分区（get/save/catalog/catalogRefresh/test/available）；守卫 requireActiveUser/requireAuth（贴钻默认单账户——zhumo 的 requireAdminOrWizard 分级不适用，适配点） |
| webui models/ 五组件 | 529+418+357+394+165 | rhinestone-studio/src/lib/components/models/ 五组件 | 逐文件 1:1（含 skill-creator-v2 结构复刻注释的层级关系）；api 面→$lib/modelsApi（orpc WS 守门 parse）；类型真源=@handicraft/contracts |
| AdminPage models 分区挂载 | — | src/components/ModelsSettingsDialog.svelte + App.svelte 顶栏常驻按钮 | zhumo AdminPage `<section class="min-h-0 flex-1 rounded-lg border bg-card p-4">` 满高链形态，承载位=右 Sheet（贴钻无后台二级导航——单分区收敛为抽屉） |
| ui/{popover,confirm-dialog} | — | $lib/components/ui/ | 整拷（贴钻缺的 UI 原子） |

**真源演进**（zhumo 同款）：settings 表三键 models_routes/models_keys/models_default；.env LLM_* 四键齐备 → 首次读取收编物化（路由带存储态 legacy 标记，key 一并落库）；bootstrap.modelRoute 投影 source='env'（引导值）/‘settings’（用户保存后标记消失=.env 不再被读）。kernel boot（daemon/src/kernel/index.ts resolveModelRoutes）：settings 真源优先 → .env fallback；save 后桥接面（dsh-home settings.yaml/.credentials.yaml）即时重写，行热加载无需重启。

**密钥红线**：apiKey 只经 save 输入（空=保留旧值）；任何输出面 hasKey 布尔回显；密钥任何界面都不回显；settings.yaml 只落 apiKeyEnv 引用、.credentials.yaml refs 落 DSH_HOME（0600，不入 git）——沿 W4.1 机制原样。

## 块 B：chat 面板（zhumo agent/ 组件树换装）

| 源组件 | 行数 | 落点 | 形态 |
|---|---|---|---|
| agent-flow.css | 176 | agent/agent-flow.css | 整拷 |
| DisclosureRow | 49 | agent/DisclosureRow.svelte | 整拷 |
| UserBubble | 77 | agent/UserBubble.svelte | 整拷（markstream-svelte） |
| ReasoningRow | 79 | agent/ReasoningRow.svelte | 整拷 |
| AgentToolRow | 86 | agent/AgentToolRow.svelte | 整拷 |
| TriggerMenu | 197 | agent/TriggerMenu.svelte | 整拷（挂载传 triggers=false——贴钻内核 facade 无 commands/skills 注册表面，适配点） |
| ContextMeter | 131 | agent/ContextMeter.svelte | 整拷 |
| QueueDrawer | 410 | agent/QueueDrawer.svelte | 1:1；message_id→id（贴钻外环契约）+ held 位置派生被动段 + 贴钻 testid + onclear 保留位 |
| TranscriptView | 245 | agent/TranscriptView.svelte | 1:1 + frame 分支（贴钻石有帧走 FrameView 原样渲染——审批卡/策略提案卡/产物 chip/完成入口） |
| ComposerCard | 648 | agent/ComposerCard.svelte | 1:1；uploadAttachment/composerCatalog 注入化 props（贴钻待接线，缺省禁用）；toast→showToast；贴钻 W10「⚡引导」直达按钮保留（zhumo W10m 收敛为队列行模式——双路并存，测试与已验证交互依赖直达位） |
| TaskComposer | 202 | 不移植 | 贴钻新建流程=会话制（createSession 即对话），无「新建任务态」挂载位（适配点） |
| TaskDetailPanel | 384 | 保留贴钻版 | 贴钻详情=工作台紧凑形态（rework-layer-model v4 裁决）——zhumo 的视频+结果标签页为书法域形态，不适用（适配点） |
| ListDetailPage 组织 | 570 | SessionStream.svelte 重写（zhumo chatColumn 形态） | header→横幅→TranscriptView→footer(QueueDrawer+ComposerCard)；AgentView 三栏/Sheet 骨架保留零改 |
| stores/tasks 投影 | — | $lib/agentApi/transcript.svelte.ts | TranscriptItem/projectFrames/pendingQueueItems（贴钻 Frame 契约投影；inject/queue/steer 待发气泡标签） |

**store 队列升级**（外环真源承载 zhumo W10k/W10m 全交互）：AgentQueueItem +held（暂停段边界单源）；lockAgentQueue/reorderAgentQueue/setAgentQueueItemMode/setAgentQueueReordering；dispatch 单一有序序列（queue=开轮锚点等 done；steer=运行中立即投递/idle 开新轮；inject=不唤醒，在下一次实际投递时前缀并入；暂停段整段不自动跑；失败回填队头+熔断）。替换原 QueuePanel.svelte（已删）。

## 验证

- daemon：typecheck 绿；models-store.test 8/8（迁移收编/真源化/密钥保留/悬空防御/bundle/路由信息/effort 算法）
- studio：svelte-check 0 error；agent 测试 56/56（threeChannel 15 全绿——W10 三通道/队列/暂离编辑语义全保留）；strategyDesigner/agentDetailLayout/agentFace 全绿（全局 jsdom ResizeObserver 桩 setup）
- 断言形态更新（语义不变，载体随 zhumo 形态）：通道反馈条→全局 toast（W10g）；「立刻发送」占位→撤除（W10m 裁决：模式徽标承载）；队列点击展开→自动展开（W10m）；停止位 running+有输入常驻（Codex UX P2）

## 适配点清单（如实偏离）

1. models RPC 守卫=登录态（贴钻默认单账户），非 zhumo 的管理员/向导窗口分级
2. 旧链迁移源=.env LLM_*（贴钻无 settings llm_* 表键历史）；legacy 标记不出输出面（zhumo 会泄漏进 rpc 返回）
3. ComposerCard 附件/触发面板为注入化 props 且挂载关闭（贴钻无 uploadAttachment 管线与内核命令注册表面）
4. TaskComposer/TaskDetailPanel(zhumo) 不移植（贴钻会话制/工作台紧凑形态裁决）
5. ⚡引导直达按钮保留（zhumo W10m 删除——贴钻双路并存）
6. bundle.default 不携带 effort（settings.yaml agent-default-model 两字段形）；ModelsDefault.effort 存储保留、内核消费属后续波
