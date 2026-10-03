# 贴钻工作台·知识图谱（2026-10-02 handoff 版）

> 供下一个会话接续认知。作者：本轮 MainAgent（remix 编排者）。配合 handoff 文档 `/tmp/handoff-rhinestone-20261002.md` 使用（该文件含本文件不重复的会话级细节）。

## 0. 一句话现状

产品已从「实验室工具」走到「生产验收实例常驻」：8317 daemon（start-8317.sh 固化 JWT/SAM 桥/LIVE 全套 env）+ 三栏 zhumo 同构 Agent 主面（列表|对话|详情多 tabs）+ 五产物导出矩阵 + 会话三级自动命名 + 角度函数全策略。Owner 只做最终验收，日常以「你持续推进」授权自治。

## 1. 双仓结构（关键——别搞混）

| 路径 | 角色 |
|---|---|
| `/Users/kzf/Pictures/贴钻/` | **主仓**（默认分支）。openspec/、docs/、experiments/（DATA_ROOT 等）、客户材料在此。8317 的 DATA_ROOT=主仓 `experiments/journey-clown-rich-v5-20260928/data-root` |
| `/Users/kzf/Pictures/贴钻-backend/` | **实现 worktree**（分支 `add-backend-platform-impl`，已领先主仓多轮未合并）。daemon/、rhinestone-studio/、contracts/ 的全部实现在此。**尚未回主仓合并/开 PR** |

- 新会话默认 CWD 大概率=主仓；动代码要 cd 到 worktree。
- worktree 与主仓的 spec 同源（openspec/ 在主仓；worktree 里有自己的 openspec/ 副本——以 worktree 内的为准做变更，主仓的 changes/ 是历史归档+本图谱）。

## 2. 架构分层（worktree 内）

```
contracts/          zod 契约唯一真源（帧模型/RPC schema）——frame.ts 的 kind 两族+activity
daemon/             tsx 直跑（无 build）。8317 经 scripts/start-8317.sh
  src/kernel/       DSH 内核宿主：boot（dsh 插件栈）/sessions（firehose→帧投影+AOP 活动帧）
  src/kernel/strategies/  排钻策略族（7 值 KernelStrategyKind）：texture_fill/soft_curve/
                          straight_line/flower/geometry/exclusion/sandbox(free-code)
  src/capability/   MCP 工具面（task-export 五产物/studio/layout-doc…）
  src/png/          纯 TS 渲染：texture-render（贴图合成）/hole-template/numbered-sheet/
                    svg-layers/bitmap-font/cjk-font
  src/sessions/     会话服务+FrameStore（tasks/<id>/frames.jsonl+WS+afterSeq 重放）
  src/stones/       钻库（resolveStoneRef 四态门；http.ts raw 面）
rhinestone-studio/  Svelte 5+shadcn-svelte+Vite 8 前端（build 后由 daemon 托管 dist）
  src/lib/agentApi/ 前端 agent 域（store/router/sessionRoute/toolNames/activity/
                    gemSummary/assetBoundary/newTaskComposer/daemonToken…）
  src/lib/engine/   ★零改动红线（只读复用的前端引擎）
  src/lib/components/agent/  AgentView（三栏）/ComposerCard（审批 zStack+工具行）/
                    TaskDetailPanel（多 tabs）/NewTaskComposer（中栏表单）/
                    TaskActivityTimeline/Lightbox/TranscriptView
```

## 3. 本轮（2026-10-02 一天）落成的能力

按提交倒序（全部在 worktree，HEAD=61815b7）：

1. **61815b7+7403ff4** 段循环断点续跑（291 段超窗根治——openspec change `add-segment-checkpoint-resume`）：断点账本（`DATA_ROOT/segment-ledgers/<fp16>.jsonl`，reqHash 投影剔 taskId=跨任务命中）+10min 时间切片（checkpointed 正常返回 agent 链式续调）+progress 帧喂看门狗+boot GC。真链冒烟三相实证（进程组击杀/链式续跑/断点闭环）。research 评审两轮 6→8.5 GO。**待 Owner 验收**
2. **3c4b6c3** 新建会话继承自动批准开关（`submitNewTask` 透传 `sessionAutoApprove`）
2. **9c3b8ba** 细节批修：过期审批卡「重新发起」（清卡+合成指令走 followup）/「删除会话」改名（daemon clear 本就三段式真删）/任务详情图片预览卡/自动开关回归护栏
3. **8520d3a** 新建面板移中栏（zhumo 现行三栏——此前误抄其历史注）+排钻工作台常驻顶栏（Owner 裁决，其余开发面仍随 `dev.workbenches` 旗标）
4. **2497918** 验收四连修：新会话融合（点击零创建）/fixture 边界三面（rpc 不锚 mock/mock 资源 dataUrl 零越域——`assetBoundary.ts`）/studio-tab-bar（open icon-button 唯一跳工作台）/tab 竖条（line 变体 ::after 超盒 1px×overflow-y）
5. **0ebf5d9** NewTaskComposer 表单（多图/尺寸/钻集合/预设）+多图=N 会话并发（Owner 口径：**多图不是提示词实现**）+会话三级命名（fallback→provider LLM→识图升级「小丑」；`title_owner` 守门 v15：user rename 永不被覆盖；dsh-session-title 插件 dsh-base 本带，bounds 补中文口径 120B）
6. **a784f87** 导出矩阵五产物（render.png=贴图效果图/holes.png 黑点 1-bit/numbered.png 编号工作图=BOM 行号单源/layout.svg 四层 source-holes-numbers-gems/bom.csv）+任务详情多 tabs（zhumo 形态：详情|活动|工作台+结果 iframe tab 保活+地址栏）+activity 帧（契约+AOP firehose 单点）+角度函数全策略（直线同角/曲线切线/花径向+心切向/geometry 全族——罗盘基准 atan2+90 实证锚定）

## 4. Owner 口径与产品语义（认知核心——照此决策）

- **zhumo 是抄作业的标尺**：`~/Dev/Github/zhumo/shufa-server/webui/src/lib/components/agent/`。教训×2：抄要抄**现行代码**不抄头注历史注（新建面板位置踩过）；抄漏会被点名（Effect chip）。
- **导出语义**（客户 ComfyUI 习惯，`主仓 docs/客户工作流分析报告.md`）：效果图（贴图渲染，客户确认/报价）/黑点模板（刻膜定位）/编号工作图（数字油画打法，编号=stoneRef=ID 图例）/四层 SVG（CDR 下游）/BOM。
- **角度统一理论**（Owner 原话）：角度=局部方向场，**线条纹理铺法最通用**（texture-fill 是主力，占 9/12 节点），星/花/圆=几何拟合后的方向稳定化。已全策略接入。
- **多图=并发多会话**（不是提示词）。
- **免值守**：自动批准（会话级开关，propose 时刻生效不追补；新建会话继承开关值）；审批卡过期=跳过（本地清卡）或重新发起（合成指令重 propose）。
- **title 不进模型输入**；user rename=pin。
- **王老板/排钻师/管家** persona（`openspec/changes/product-polish-w1/stage0-personas.md`）是打磨简报的共同锚。

## 5. 数据流速记

- 帧：`tasks/<id>/frames.jsonl`（seq 单调）+WS 推送+`afterSeq` 重放；kind=transcript|approval×2|artifact|done|error|**activity**|progress|log。activity 帧=工具调用 running→终态配对（activityId）。
- 会话↔任务：sessionId=taskId（dsh 会话域）；任务工件走 blobs 内容寻址+`putTaskArtifact`（**不入附件账本**——raw 面有 blobRef 直读兜底，JSON 工件 415 不出口）。
- SAM 桥：macmini MLX（SSH），单次分割 p50≈5.3s（3264 次实测）；大任务串行累计是瓶颈（291 段单=3.8h）——**断点续跑已落地**（时间切片 SEGMENT_TOOL_SLICE_MS 缺省 10min；账本 `DATA_ROOT/segment-ledgers/`；同参重调=续跑，跨 task/跨 kill/跨 ssh 中断均可恢复；「杀而不死」——队列长等待被看门狗杀后重调即续）。
- 导出门：`gateRequiredPairPx` 与引擎 `requiredCenterDistancePx×0.999` 直连（EXPORT_GATE_GRID_GAP_MM=0）。
- token：daemonToken 单源（登录/匿名双键位+晚到守卫）；JWT_SECRET 固化于 DATA_ROOT/.jwt-secret。

## 6. 红线（违反会被 Owner 点名）

1. **engine/ 零改动**（rhinestone-studio/src/lib/engine/ 只读复用）
2. **子代理不做 git 写**——MainAgent 统一显式路径提交；`perf-receipt-20260927.json` 提交前恢复 HEAD
3. 5200 端口=他人进程严禁触碰；8317=Owner 验收 daemon（换装用 start-8317.sh，纯前端变更只需重建 dist **不重启**）
4. LLM key 只走后台表单/env，绝不落盘/截图/URL/git
5. macmini 只写 `~/sam3-spike/`；~/.dsh 零写（daemon 用 DATA_ROOT/dsh-home）
6. 并行子代理分域防竞写（本轮惯例：daemon 域/studio agent 域/App 顶栏域分开）
7. 测试基座：studio=vitest（`pnpm --filter … exec vitest run <file>` 直通）；daemon=vitest+tsc；flake 三重实证定性（隔离复跑/超时加宽/A-B 对照）
8. rg 陷阱：`-rn` 的 `-r` 是 replace——用 `rg -n`；zsh `==`/glob 报错分开跑

## 7. 残留工作（下会话接手清单）

**2026-10-02 下午续（断点续跑会话）**：
- 断点续跑 E2E 走查两轮（`experiments/segment-e2e-20261002/walkthrough{,-round2}/`）：第一轮链式 ✅（4×checkpointed→自动续调→done）+进度帧 ✅，导出死于空钻库缺陷→修复（`0b0956b` stone.create.builtin）；第二轮全绿：**五产物全过**（454 颗 9 款，BOM 数量一致）+P2 四项全 PASS（图例贴图缩略/用时秒级吻合/tab 双清/导出面板收窄）+内置钻审批卡形态确认（agent 主动发起 53 条，人工批准——**会话自动开关不覆盖钻库物化面**）+P3 新策略真链被采用（along-path×冬青花环 outline）。
- 本会话提交链（worktree）：7403ff4/61815b7（断点续跑 spec+impl）→1f0fe42（e2e 文案）→b73a041/01c565e（排钻清账 spec+impl）→1f75b1d/0b0956b（内置钻 spec+impl）→19af98b（走查 minor 五件）。
- 排钻清账（close-paving-backlog）已兑现：star 原位升级/多尺寸混排 gapFill/along-path 第八族/直线取向场/钻形搭配指引——**Owner 台账「说过的都做完」口径达成**（存疑 4 项已裁定不欠，映射承接 3 项入 change design §0）。
- 走查附带发现：① E2E/第二实例须显式 `MCP_PORT`（8318 被 8317 的 MCP 监听占用——缺省冲突时工具零挂载，现已入 ready reason 观察面）；② 8320 默认入口=mock 演示模式，真实链路要 `?api=rpc`；③ 主仓 `微信图片_20260921172653_27_485.jpg` 实为**三圣诞天使图**（此前会话口径误称小丑图）。
- **第二轮新挂账（不阻塞验收）**：[中] 内置钻审批唤醒后回合终止（agent 问「下一步做哪步」需人工续跑——免值守断档点+0 款钻可静默「完成」同族）；[低] 审批续跑后 S2 重起未复用 done 对象树（浪费 ~11min）；[低] 导出五链接无 Content-Disposition: attachment（内联打开非下载）；[低] ~~会话识图命名升级仍未生效~~ **已修**（见下）。
- **Owner 质询连环修复（2026-10-03 凌晨，worktree 9d19b13/8663df4/cebf91a/07a22c7）**：①自动审批「等待用户批准」无条件文案（11 propose 点）→autoApproved 透传+条件化（走查人工卡实为当时开关未开——代理误诊「不覆盖钻库面」，中央分支本就通用）；②会话 LLM 命名 56/56 会话 100% 回退根治（dsh-base title 请求 max_tokens=64 被推理模型 thinking 烧光——同路由直探实证 64=零正文/2048=完整标题；boot patch 覆盖 2048）；③表单派生标题 titlePinned=false 不钉死（此前 UI 表单流结构性拿不到 LLM 标题）；④驻留页面实时显形（自动标题写 bump updated_at+前端叙述/终态帧前沿节流刷新）。真链终验：零刷新三级标题（预览→LLM 语义→识图「右侧天使 · 左侧天使（25 区域）」）。**8317 已终装全部修复**。
- **生产完整任务交付（2026-10-03 晨，vision 子代理 ego-browser 全程，走查档案=`experiments/segment-e2e-20261002/prod-run-8317/`）**：8317 生产实例真跑到底（会话 cd43f4fa，三圣诞天使图 20×20cm）——**377 颗/15 款/五产物全自洽**（BOM 合计/SVG 三层 data-col/编号图例/UI 四方一致=377），全程零审批点击，会话链接 `http://127.0.0.1:8317/#/t/cd43f4fa-2684-4349-b2c7-3af5419c133b`、分享页 `/r/TeQP8AmADFXT`。附带定案：①标题三级升级生产复现（识图「天使组 · 底部圣诞装饰组（28 区域）」零刷新）；②「重新发起」=从头重跑非断点续跑（卡死恢复代价 ~20min——新挂账）；③**免值守开关卡死根因收口（16ec7a8，8317 已换装）**：开关值此前只搭车下一条 followup 落库，「提交后开开关」的免值守场景服务端恒 0→propose 不签发 grant 卡死 10m41s（DB 实证：卡 approved_ops 有行而 grants 无行；第二遍「重新发起」恰携带开关值故全通——与 lint 内容无关）——新增 `session.setAutoApprove` RPC 即时落库（contracts/daemon/studio 三层；乐观+失败回滚+幂等双通道；daemon 1408/contracts 260 全绿，studio 除两枚漂移负载抖外全过）。
- **Owner 午后连环报障批修（2026-10-03 下午，worktree 7bd3d04/59e9c3b/53505bb/2330967/f7c4d65/9ba9f14，8317 逐项换装）**：
  - **结果页预览+下载（7bd3d04）**：iframe sandbox 缺 `allow-downloads`（sandboxed iframe 内 anchor download 被 Chromium 静默拦截）+ 分享页重写为 `<details>` 折叠预览（BOM 服务端预渲染表格）+ `/files/{key}` 补 `Content-Disposition: attachment`（挂账「内联打开」收口）+ e2e 文案对齐（挂账 #9 daemon e2e 6 败收口）。vision 终验 4/4（真实下载落盘 63365B magic 校验过）。
  - **导航回归单层（59e9c3b）**：Owner「不喜欢底部导航」——lg 断点双形态废弃，底栏移除、顶栏 tabs 全宽常驻（窄窗横滚）。
  - **分享页原图混合（53505bb→f7c4d65 三轮迭代）**：bundle 增 `source` 可选产物（导出时原图字节入包永久留存；旧包 `/files/source` 走任务链回退）+ png/holes/numbered 手风琴双透明度滑杆+canvas 实时混合+混合图下载。两轮 Owner 反馈修正：①**透明度观感根因=产物底 alpha 差异**（render 88.2% 透明 vs holes/numbered 0%——fg 缺省 100% 整幅盖死；修=白底产物缺省 55%，vision 像素级实证 toDataURL 恒定=「拖了没变」的硬证据）；②**编号图分区混合**（右侧图例列不参与——图例带宽自适应，服务端解码 render.png 下发 `data-mix-region`，产物整幅打底+分区 clip 重绘，图例列字节级恒等实证）；③脚本加固（控件必显/原图单次加载/失败不静默——初版 Promise.all 任一失败整块静默隐藏的形态被证伪但结构仍加固）。SVG 不设混合（四层本含 #source）；BOM 非图像。
  - **两 UI 报障（9ba9f14）**：顶栏 tabs 滚动条隐藏（`.app-topbar-tabs` scoped 双前缀）；**会话列表断线恢复补拉**（首载恰落服务端重启断线窗口→列表空+无重试路径=侧栏永久空；修=连接 open 且列表空自动补拉+in-flight 守卫；服务端健康经 orpc 真客户端探针证）。
  - **新导出链路（会话内重导出实证）**：新分享包 `/r/1jSB41qyap65`（task 97f8b7b2）——bundle 内嵌 source.img 3.7MB+manifest mime+审计 imageId+分区/缺省值全在场（程序化核验+子代理浏览器级验证双轨）。
  - 走查档案：`prod-run-8317/{result-page-fix,mix-nav-fix,reexport}/`。
- **打印级高清导出+终验回归闭环（2026-10-03 晚，worktree 03d0948/65005ce）**：
  - **300DPI 导出**（03d0948）：EXPORT_DPI（env，缺省 300，<72 回落）→ px/mm 统一缩放 k 代入 gems/grid/宽高（纯物理坐标系同比缩放）；SVG 矢量不动；numbered 相对量纲自动同比。黑点模板**透明底**（刻膜介质——1-bit 黑不透明/全透明）；分享页每手风琴「底色」控件（默认透明=原字节直下；选色=平铺 toBlob 同名落盘，混合画布底色联动）；TASK_ARTIFACT_MAX_BYTES 8→32MiB（rpc 测试改 BlobStore 直写注入——与 assets 上传 base64 闸正交）。
  - **11 项需求全量终验**（Owner 要求清单化+子代理验证）：round1 7 PASS+4 FAIL → 根因二：①raw-dl 锚作用域回归（锚在 summary 内、.mix 容器外——querySelector 必 null→TypeError 中止 forEach：黑点/编号混合块隐藏+平铺/混合下载全失效）→65005ce 修复（closest("details") 取锚+null 守卫+护栏断言；分享页逐请求生成=存量包即时生效）；②「分辨率未达标」系简报预期错（按 20cm 算 2362）——**layout 物理真值 canvasCm=16×16cm@ppm2.5=400px 自洽，1890px 恰=160mm@300DPI 打印标准**。round2 复验 5/5 全 PASS（图例列字节级恒等/平铺 alpha 采样/SHA 对账/IHDR 1890）。高清包 `/r/w5qBSZWz9xYe`；档案 `prod-run-8317/final-walkthrough/{,round2/}`。
  - **[Owner 待裁决] 表单尺寸≠落地画布**：任务表单 20×20cm → layout 落地 16×16cm（策略层在 SAM 处理分辨率 25px/cm 的 400px 画布上排钻——canvasCm 由 400px/2.5ppm 推导）。石头物理尺寸（3mm）在 16cm 画布内自洽；但若客户按 20cm 下单，打印件比订单小 20%。策略层是否应忠实表单尺寸（在 20cm 口径重投影排钻）待 Owner 定。
  - **Codex 复核**（Owner 指令，gpt-6.1-sol xhigh，herdr agent codex-print-review）：审 16ec7a8^..HEAD 九提交；评分 **6.7/10 Conditional Go**；P1×2（导出资源预算/断线恢复竞态）+P2-3（混合禁用态）当日修复（2679f82）；其余 P2 七条挂账（1-bit 文件级契约/像素中心/cover-fit 契约/CSV RFC4180+公式注入/autoApprove CAS/fallback Range+realpath/http.ts 拆模块）。herdr agent prompt 用**位置参数**（--text 会报 unknown option 且易误读为成功——当日三次踩坑）。
  - **编号图透明底统一**（74fa9d4）：Owner 口径「出来的图都将要是透明底」——numbered 白底是我保守裁量；画布透明+四绘制方法补 alpha 通道真 source-over（此前只合成 RGB 假设 alpha 恒 255）；测试暗像素判定补 alpha 闸。
  - **Agent 自适应排钻验证**（Owner 测试目的：验证 agent 能否按自然语言需求自适应；vision 子代理仅传话+观察，需求原文一字不改）：头发流线+头饰贴钻+面部排除+星星背景 → **8.9/10 成立**。新包 `/r/ASGGtkhCLqnH`（472 颗·6 款，1833s 单轮零停轮）。头发=along-path 弧形链（六角网格特征分 0.35 vs 均布基线 0.71——程序化判据）；面部 0 钻+exclusion×3+BOM 肤粉 SKU 消失；星星 2/9 反转（其余 SAM 整片天空掩膜不可逐星——agent 诚实披露+降级，非幻觉交付）；右头饰 SAM 掩膜 9px 薄条零实例——agent 保面部降级。**断档点在上游 SAM 分割物理边界，不在需求理解**（五要素全落节点+自主修两处分件遗漏+识破整幅掩膜陷阱）。档案 `prod-run-8317/adaptive-test/`。
  - **Owner 五点反馈回流 round2**（反馈原文一字不改发回同会话；策略指引先行注入 493ec8f：流线优先+同角色一致性）：agent 全量重分件 21 节点→缺口审计→tree_refine×13/merge×7/rename×8 至 v41（六星/左发/双翅/右发/花篮全补成节点——右发首次零实例后换措辞成功）→策略五连败五自愈（oversize/bad-json/timeout/node-unknown/coverage-incomplete 零人工）→重排导出。**五点判定 4.5/5**：①六星逐颗 ✓（35 颗=6 簇）②头发右天使 0→有 ✓ 但中发冠 1 颗（掩膜物理上限，主动披露）③一致性 ✓（三发区/双翅/双袍逐字同参+NN 均距 15.89/15.88 实证；agent 答「统一非故意」）④双翅 ✓（翅缘弧，羽面掩膜收缩仍空——过程有记录）⑤花篮流线 ✓（六角特征分 0.518 vs 0.703、各向异性 11.1 vs 5.9——方向性程序化判据）。**整图 472→211 颗=flow 稀疏副作用**（如实标注待 Owner 口径）。新包 `/r/E7oQ7UJ0Ga63`。评分 8.8/10。档案 `prod-run-8317/adaptive-round2/`。

- **add-vision-pipeline-v2 执行启动（2026-10-04，Owner「可以继续推进了」）**：
  - **T4 treeView 完结**：56c3235（Codex 重做：画布=真实树根可选/可拆分/可折叠+keyed 行+折叠视口锚定）+ **a026f4e 自然树序翻转**（Owner 二次纠偏：PS 逆序惯例不适用包含树——去 `rows.reverse()`，父在上子缩进、画布根恒顶部；v5/2d/treeScroll 三测试文件按自然序语义重写：treeScroll 锚行改在被折叠子树**下方**、collapse −3·ROW_H/expand +84 位移补偿；workbench 198/198+svelte-check 0 err）。
  - **T1 掩膜分辨率语义已派子代理**（D2：maskMaxSide 只作用于 SAM 请求侧；返回掩膜最近邻上采样回 tree.imagePx 才落树；递归细分输入恒原分辨率；segment-loop/segment-one 双通道；上采样共享纯函数；reqHash 变化致旧账本回放 miss 一次预期内）。
  - **排序决策**：T2+T3 合并一批（同触 daemon 契约/门控文件，避免双子代理冲突）→ T5 Dialog（依赖 T3 precision 入参+T2 试跑预览通道）→ T6 三天使回归（重跑分件补 segmentPrompt+验收口径 1-7+vision 走查+8317 部署+新分享包）。T5 不提前并行：试跑/参数落地真依赖 T2/T3 契约，先做壳后接线=同组件两轮返工。

  - **T1 落地（0fd4c10，子代理）**：现状实证颠覆简报假设——D2 语义在桥边界**已成立**（80f973e 起服务端 PIL NEAREST 缩掩码省带宽+桥 `materialize` 处最近邻上采样回 imagePx 才落库；`maskMaxSide` 是请求参数透传、图像恒原样送线、递归恒原图）；真缺口=旧账本低分辨率掩膜回放被静默 drop——补 `ledger-stale-mask` typed warning+progress 帧双留痕；`nearestResampleMaskBits` 抽共享纯函数（`vision/mask-resample.ts`，6 测含 3×2→7×5 手算逐位对照）；回放端到端测（篡改 maskBlobRef→续跑仅该段实跑+树逐字节==基线）。vision 157/157 绿。
  - **预存失败收口（41f4838）**：`strategy-design.test.ts`「确定性快照」实为**快照过期**非不确定性（`toBe(b)` 双调用一致性通过）——493ec8f 指引文案进 prompt 未更新快照；`-u` 后 38/38 绿，diff 恰两行新指引+一行 params 重写。

  - **T2+T3 落地（54b587d，子代理，19 文件+1491/−22）**：①ObjectNode `segmentPrompt?`（min(1) 拒空串；**记原始指令**——细分轮=翻译前 broadSemanticPrompt 原文/segmentOne=hint 原文，译文只在 SAM 请求侧 trace；画布根/旧节点不伪造）；②质量门 `vision/mask-quality.ts` 三先验 typed warning 不丢不阻——`mask-suspicious-fill`（置位/bbox<5%）/`mask-suspicious-aspect`（bbox 宽高比 ∉[0.5,2] **且** 高>90%·父高基准（无父回画布高）——细长合法、细长贯穿父才可疑）/`mask-parent-iou`（子父 IoU>0.95——泄漏型恒 1）；③预览回流 `vision/agent-preview.ts`：工具结果带 `agentImagePreviews[]`（树叠加总览+病态特写缩略图 base64 双轨 blobRef）→ MCP `toToolResult` 提升为 image content block（`dataBase64` 从 JSON 文本面剥离防 token 双计）；开关 `SEGMENT_AGENT_MASK_PREVIEW`（'0' 关，**缺省开**）+`..._MAX_SIDE` 512px+特写 cap 4；④precision：`SegmentPrecisionSchema`（contracts 单源）挂 `SubjectSegmentToolInputSchema`，`applySegmentPrecision` 显式值压 tuner，reqHash 含 precision（同参回放零桥调/换精度全 miss 重跑）；工具描述写明「效果差可升精度重试」调参语义。绿门：daemon 全量 1463 绿+contracts 265+typecheck 三包 0 错；泄漏双命中/空膜命中/中文 hint 英译场景（桥收英文树记原文）全测。**T6 关注项**：agent 真会话的 image content block 兼容性（SDK 层已验证解析，LLM 侧待生产验证）。

  - **T5 落地（463eec9，子代理，19 文件+1553/−208）**：①dryRun 契约挂 `layer.split`（实证拆分按钮链=store.splitLayer→layer.split→segmentOneSplit→segmentOne 原子）：`dryRun/precision/layerName` 三可选入参+`trial:{preview,replayed}` 输出；试跑=真跑分段+账本照记但不落树不入史零 artifact 帧；**确认=同参再调账本命中回放零二次桥调**（`segmentOneLedgerFingerprint` scope='segment-one' 分桶；layerName 不入 reqHash/precision 入）；②`segmentTasks.svelte.ts` 任务描述 store（六态状态机+任务数组+activeId——队列/微服务拆分预埋）；③`SegmentDialog.svelte`（目标预览+指令+precision「跟随配置」+试跑 SAM 实跑/账本回放徽标+质量门警告+命名落地）；旧 inline 拆分箱退役；④T4.3 segmentPrompt 弱化次行（无值不渲染）。绿门：contracts 268/daemon 1468/studio 2970（新 segmentDialog 3 测）/svelte-check 0/perf 18/18。
  - **T6a Dialog 走查 6/6 PASS（vision 子代理，/tmp/rhino-walk/）**：画布根同权开窗→SAM 实跑徽标→掩膜叠加预览（400×400 data-URL 红叠加）→命名落地（「走查测试星」挂画布下+自动选中）→segmentPrompt 次行全树恰 1 行（旧节点零渲染）→同参重试「账本回放」徽标+**兄弟吞没守卫正确拒收泄漏掩膜**（重叠 68538px 移出树）。三观察入挂账：匿名进入钮失效（200+token 已写但不关弹窗）/rpc 模式入口不可发现（缺省 MOCK，需 ?api=rpc）/零检出态双文案语义相拗。
  - **英译 live 失败根因+修复（eabf90e）**：T6a 暴露中文指令「英译失败降级原样直送」→只读探针分阶段定位（DATA_ROOT 真库）：路由/HTTP 全通，卡响应形状——**GLM-5.3-Flash 是思考模型，max_tokens=64 全被 thinking 块吃尽**（stop_reason=max_tokens，text 块从未出现）。修复：`SUBJECT_TRANSLATE_MAX_TOKENS` 64→4096（scene.analyze 8192/strategy.design 16384 同代预算档；输出侧 200 字符整形上界不变）；live 复证 `"the wings of the left angel"`（4.8s）。**探针教训：探针自身把 64 写死差点误判修复无效——探针必须引用被测常量。**

**挂账（Owner 已知/提过）**：
1. 任务详情打开导出后面板静默重绑导出任务（走查 minor）
2. 旧任务「用时 75222s」跨天口径（帧污染）
3. tab 双高亮观感（焦点态+选中态并存）
4. ~~291 段全分解超窗——断点续跑~~ **已落地**（61815b7，change `add-segment-checkpoint-resume` 待归档；Owner 验收入口=8317 需换装新 daemon——start-8317.sh）
5. ~~星形排钻策略~~ **记载失实已纠**（2026-10-02 清点核实：geometry star 本就是射线策略——四参数已实现三；真缺口=凹形 r(θ) 调制等四增量，正在 `close-paving-backlog` change 兑现）
6. XLSX 导出/说明书 TIF（客户习惯的剩余件，后置）
7. 图例贴图缩略（numbered.png 图例现为色点）
8. LLM 生成抖动余量/“X·部分N”碎片命名人化/mofang sizeMm 数据治理/200 款候选上限/服务端缩略缩放（更早挂账，见归档 changes）
9. （2026-10-02 终审发现的**分支存量**）daemon e2e 6 败：分享页文案漂移（http.ts:374「下载 PNG」vs 测试期望「下载 效果图 PNG」）——不在断点续跑 diff 内，未顺手修（范围纪律），需单独小修

**结构性待办**：
9. **worktree 回主仓**：add-backend-platform-impl 领先主仓 12+ 提交未合并——需要 Owner 决定合并节奏（rebase 时检查 main 的底层法则变更）
10. openspec changes 整理：worktree 的活跃 changes（10 个）随最终归档批量处理
11. Stage 0 persona 锚仍待 Owner 校准（product-polish-w1）

**验证环境**：
- 8317 在跑（新代码已换装）；admin/admin8888；匿名开
- 角度效果对比图：`/tmp/flower-drop-rotated.png` vs `/tmp/flower-drop-unrotated.png`（重启会丢——重要可重生成：texture-render 测试面）
- 走查截图：主仓 `.agents/images/w20-export-matrix/`（及更早 w8-w19 各轮）

## 8. 新会话快速上手三步

1. `cd /Users/kzf/Pictures/贴钻-backend && git log --oneline -15`（本文 §3 对照）
2. 打开 8317（匿名直落）走一遍：新建表单（中栏）→任务详情多 tabs→活动时间线→导出五产物
3. 接残留清单（§7）按 Owner 优先级推进；zhumo 参照路径见 §4
