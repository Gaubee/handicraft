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

  - **Codex R1 复核（2f72b34 落档，6.8/10）**：P1=试跑预览未绑定确认语义（改指令/精度不清旧预览、树基态不校验——用户可批准没见过的掩膜）；P2×5=预览在兄弟互斥前生成/D2 文档「请求图像降采样」措辞与实现不符（实际=服务端推理原图+返回掩码降采样）/落地中可关窗/多模态无能力适配降级/precision 逐字输入中间态清空；P3=贯穿父层合法细长（发丝羽枝）仍告警。处置：P1+P2-1/2/3/5 派修复批；P2-4 持有至 T6b live 证据；P3 入挂账。R2 复核待修复批落地后跑增量。
  - **T6b 进行中**：三天使新管线全量重分件（子代理盯跑 30-90min），完成后口径 1-4/7 DB 取证+新分享包。**8317 重启冻结令**：T6b 期间禁止重启（tsx 开机加载，代码提交不影响在跑进程——修复批可并行开发）。

  - **T6b 重分件回归全 PASS（task 5ca7c664，39.0min，子代理 DB 只读取证）**：指令一字不改经 WS RPC `session.followup` 送达（匿名 owner token）；S2 34 元素→56 段/6 轮迭代→8 轮修补→v36（32 节点）→策略两轮 414→**531 颗**→导出 `/r/XNn0c64ChYEM`（7 产物含 source.img 3.76MB，2026-10-10 过期）。**口径 1-5/7 全 PASS**：①右发 bbox 100×81 宽高比 1.23∈[0.5,1.5]、置位仅占人体区 2.8% 无流下（v1=0.33 满身高）②中发填充率 41%≫5%（40 颗，v1 仅 1 颗）③左翅 181×238（v1 91×64 大幅回收）④76 桥响应掩膜全 {(400,400)}+32 节点 maskDim==bboxDim 零不符⑤31/31 非画布节点 segmentPrompt 非空⑦6 帧含 agentImagePreviews（tree-overlay 400×400）+自主重试叙事原文（「幸亏有预览图，这种错误绝不能带进排钻」「预览把关下不让任何泄漏掩膜进入排钻」）。**P2-4 live 答案：GLM-5.3-Flash 吃 image 块零报错零熔断**——能力适配降级收窄为其它部署面挂账。观察：precision 参数 0 次使用（agent 偏好换措辞+停止判据）；4 refine 节点 category 字段被填整句英文提示（schema 卫生挂账）；右头冠+发掩膜稀薄 9 颗（agent 自评唯一遗留短板——需「指派附亮度场」才能切回流线密度）；走查测试星被重分件自然吸收。
  - **R1 修复批落地（c3e09f3，15 文件+729/−69）**：P1 试跑快照绑定（trialSnapshot{instruction,precision,targetNodeId,treeBlobRef}+漂移回 draft+服务端 trialTreeBlobRef 校验 typed 拒 trial-stale-tree）/P2-1 预览与质量判定移到兄弟互斥后单源 finalChildBits（吞没=零叠加+点名兄弟文案）/P2-3 忙碌锁窗/P2-5 precision 草稿态/P2-2 design D2 措辞对齐实现；附带修 mock spy 原型污染。R2 增量复核进行中。**工具教训：codex-callback 若在 prompt 提交后立刻挂会抓到上一轮残留 done 态——先确认 agent_status=working 再挂。**

  - **R2（7.1/10）+修复批 c3e09f3+R3 终审（7.3/10）放行归档**：R2 判 P2-1/3/5+原型污染闭合、P1 部分闭合→新两 P1（确认未绑定服务端试跑凭证——tuner 实时读配置致 reqHash 漂移静默新桥调；树守卫 TOCTOU——桥在途期树可被推进而 recordTreeVersion 无 CAS）；修复批 622c824（D2 措辞全局收敛+P3 子层掩膜逐字节比较 cropBitsOf+外点关窗测试**变异验证**拆闸必红）；两 P1 立后续 change `add-segment-trial-voucher`（f3f1e25，凭证绑定 tree/image/target/reqHash/掩膜引用+typed stale/expired+树发布 CAS——D6 任务队列/微服务愿景的地基）；R3 终审「可按运行时验收完成、两 P1 明确 deferred 放行归档」。评分曲线 6.8→7.1→7.3。收尾：tasks.md 措辞终收敛 3c92b5d→R3 落档 ca1c403→**change 归档 f25bda7**；codex TUI Ctrl+C 退出+workspace w8A close（agent list 0 复核）；8317 换装至 622c824（studio 重建+重启，studio/share 双 200）。**Codex TUI 教训：完成后「New activity」浮层下 agent prompt 不触发执行——需短提示踢活（R2 首投失效实录）。**

  - **Owner 两反馈当日修复（a5e3750+0c978ac，8317 已换装）**：①Dialog 参数区可用性（「两个 input-text 填什么都不知道/默认值没显示」）——`task.detail` 增必带 `segmentDefaults{maskMaxSide,confThreshold}`（`imageProcessingEffective` 与 SAM tuner 同源；admin 读面不可复用故搭工作台响应）；Dialog 字段=术语标签+number 输入+空态 placeholder 展示服务端真实生效值+弱化说明+P2-5 草稿态零回退。②属性面板无法选钻（vision 复现+根因双实证：钻库 990>200 时 `projectStoneCandidates`（LLM prompt 有界面）被 task.detail/resolveStones 误用——oversize 抛错被 catch 置空→色板恒空+应用必拒）——UI 面单开 `projectStonePalette`（无 200 上限/同稳定序/与 agent filter 后 idx 两编号空间），两消费点切接+回归测。**教训：复用投影函数前核对失败面语义是否同域（LLM 有界≠UI 有界）。**
  - **SAM 玩法盘点（Owner 问询 2026-10-04，答复已给）**：桥协议现成=①多实例枚举（text 请求天然返回全部实例逐个 mask——逐星/逐花产品短板的解）②boxNegative 负例框（右发泄漏类问题的指令级解）③纯 box 几何抠图；需动 macmini 服务=④点提示（SAM3.1 processor 无 append_points，SequenceGeometryEncoder 有 points 配置位；务实近似=微框模拟点）；label 回传字段被丢弃可捡回做命名建议/交叉校验。**Owner 随后下达完整升级令（goal）**：①②③④全做+MCP 工具升级+抠图 Dialog 升级+skills 升级+Agent 实战+Codex 审查循环（每轮新会话存档不覆盖）+知识库辅助提示词决策（Owner 战例：「三个天使」只出两个→「background」剔除+反选出全部——需要官方语料研究支撑）。

  - **add-sam-playbook 启动（2026-10-04 Owner 升级令）**：change 立项 550b604（D1 实例枚举/D2 负框/D3 纯box/D4 点提示/D5 MCP+KB/D6 迭代循环——每轮新会话存档 iter-N、Codex 满意+无P1+≥9 终线、≤5 轮护栏）+iter-0 基线 4f4b4d5（T6b v36 锚点+冻结验收指令）。**研究重磅（3204020）**：①计数词=合并触发器（论文实证训练 NP 无计数语义+issue#586 量化词致相关实例并一 mask——「三个天使恒出两个」机制解释）②Meta 官方 18 条 agent system prompt 被挖出（藏 sam3/agent/system_prompts/——禁数词/禁否定/特称回退泛称/绝不重发同词/单数+事后选mask）③阈值 0.5→0.3 提召回（一作 alcinos 亲述）④措辞敏感性离散不可预测（shoe✓/shoes✗、person✗/a person✓→变体组并集策略）⑤背景反选=issue#409 验证的正规工作流（Owner 战例全中适用三条件）。**知识库『SAM 提示词策略』组七件套已落 DATA_ROOT**（kb 实时读盘即生效）：计数与实例枚举/背景反选/措辞规律（六要六禁）/负框与点微调/部位拆分与层级/失败信号对照表（告警 reason↔动作）。负面结论如实：无官方提示风格指南文档/SA-Co 原始 prompt 未公开/计数合并机制单源需本地 A/B。

  - **双修复浏览器级验证 PASS（vision 子代理，/tmp/zcode-8317-verify/ 8 截图）**：V1 钻选择 992 款候选色板渲染+点选/取消 aria-pressed 全通（未点应用无落源）；V2 参数区 placeholder=「跟随配置（当前 原尺寸）/（当前 0.4）」+两段说明文案+number 语义 DOM 实证；V3 无回归（Dialog 开关/32 行 segmentPrompt 次行/画布根无次行）。**注意：admin 视图侧栏只见自己会话——生产会话要匿名视图才可见**（rpc 模式下登出看完整列表）。
  - **iter-1 实跑（53.2min，会话 e02ab697/任务 5eb9826d，档案 iter-1/）**：**验收 4/5 PASS**——①三天使成层（右头脸 fill 53.5% vs 基线 4.6% 条带）②**六星逐颗质变**（6/6 独立节点 fill 32.6-80.3% vs 基线 6 簇不可逐颗——升级直接靶子命中）③花篮 12 子④头发流线；⑤导出 FAIL=免值守会话把策略 lint 门当硬停（「8 款钻未引入项目」+agent 终报矛盾：#561 提案 autoApproved 实签发 vs #566 仍要求用户批准——基线会话不踩此坑因历史轮已引入钻）。**新能力全被真实使用**：kb_get×5（遇阻 12min 首查）+kb_list/instances='all'×3/excludeBox×1（head 排中间天使）/纯 box wire 17 次（画布 5 星全中+右头紧框三连成=两大突破功臣）/变体轮询 5 措辞零中后正确止损。**结构性发现：confThreshold/precision 落参 0 次**（叙事 4 处宣称降阈值 wire 恒 0.4——叙事-参数背离与基线同病）。过程：567 帧/81 工具/93 SAM 全 ok/树 v64/segmentPrompt 35/35/warnings 41/4 次 UNAVAILABLE 自愈。Codex 审查轮启动（codex-sam-iter）。
  - **iter-5 A/B 终裁+产品化立项（e3ba3b7/65c8c78）**：**实验组 9.1>对照 9.0——增益成立，Owner 条件达成**。归因收窄（OpenAI 重绘含几何变化，非纯扁平化单变量；单组顺序执行）；风格两可（点缀 1315/14 SKU vs 满铺 2552/6 SKU 都满足冻结指令——建议密度风格写成明确选项）；scene_analyze 三连败=供应商/输出预算问题（thinking 吃满+JSON 截断）非图片问题；**P1 树编辑锚点确认**（tree.ts:108 只取最新 scene-analysis imageBlobRef→reparent 被 tree-persist 尺寸保护拒——修复=树工件显式记掩膜源图+树编辑用匹配引用+1280树/500图定向回归，不放宽保护）；产品化最小范围三条入 `add-flat-aux-segmentation` proposal（四图引用分离/几何一致性门+导出必须原图/scene-analysis 有界重试+策略风格冻结）。**发版暂不放行**（坐标对齐双门未过）。
  - **add-sam-playbook 迭代循环闭合（bebbc4a，2026-10-04）**：iter-4 纯 KB 轮（唯一变量=完成判据规则）——上轮 P1 双修复（中天使白袍 600px 无叶未披露→466px 叶+指派+BOM 对上 7 颗实钻；#106 需求清单逐部位核对+#111 掩膜级推理+5 点披露零静默）；grant 5/5 consumed 首次零弃置；1315 颗 /r/P3Sxavl0ShDy；六星 fill 45.8% 历轮最高。**Codex 判定：满意 9.0/10 无 P1——D6 满意线达成（曲线 7.8→8.3→8.7→9.0）**。Owner 验收观察项：左袍 P2（fill 26.2% 偏薄+15.4kpx 残余未进终报披露——Codex 明示勿设 fill<30% 通用触发器，交 Owner）/两 P3（leaf-union 未量化/导出前缺独立树走查锚点）。**Owner 平行指令：扁平化辅助图 A/B（iter-5）**——Owner 用 OpenAI image edit+七条扁平化提示词处理天使图（轮廓绝对保持/内部扁平化/去装饰性表面细节），假设扁平风格输入提升 SAM 分件；实验设计=iter-4 对照组 vs iter-5 盲测组（唯一变量=图，agent 不知情）；提示词逐字冻结于 iter-5-flat-ab/owner-flatten-prompt.md；若评分提升→产品化（非扁平检测→辅助图生成→全层面面向辅助图抠图→导出仍原图）。
  - **iter-1 Codex 审查+出循环修复启动（44c602d 落档）**：审查 7.8/10 不满意——复核修正：⑤根因非 lint 门（unintroduced 本是 warning）而是 **strategy.design 返回面没走 approvalFaceOf**（design.ts:2114 无条件「等待用户批准」→autoApprove 会话 agent 看不到 execute 指令，停在提案）；④仅提案层 PASS；六星质变成立但归因修正（1 颗 instances=all/5 颗纯 box）；行为面：变体轮询超限（5 个 vs KB 2-3）+一次同参数重发。**两问题均判出循环修代码**：①approvalFaceOf 接入+autoApproved:true+execute 指令+unintroduced 非阻断规则+免值守回归链（stones.add 是否被 autoApprove 覆盖=产品政策留 Owner）②TreeRefineStep 增 precision 全链透传（contracts:1206/workbench:1833 断链实证）。子代理修复中；**KB 八条调整主线程落地**（index 读取顺序+叙事≠参数铁律/对照表 precision 示例+父掩膜域+warning-blocker 区分/枚举域限定/措辞默认优先/部位父覆盖检查/背景反选无求反工具如实标注/点状态更新）。**架构事实新发现：DATA_ROOT/knowledge 是 KB 自管的独立 git 仓（store.ts 的 this.git() 调用）——外层仓 git add 只会得到脏 gitlink（已清理），KB 变更必须在其自己仓提交（7fd996f）**；此前 3204020/da1b0b2 两笔「KB 入库」实为空操作（带空格中文目录路径 add 静默无匹配）。
  - **T1.3+T2 落地（e986ae9+46f8408）**：①桥层点接入——wire 对象映射（v1.1.0 要对象非元组）+`SAM_POINTS_TOPK_FLOOR=8`+候选三级选择序纯函数（containsPoints 优先→多数包含（画布坐标系计数）→面积平局→`point-candidates-unmatched` warning）+UNSUPPORTED 旧服务回退保留；②暴露面——subject.segment 描述带「提示词策略浓缩七条+失败信号→动作对照+KB 组引导」；LayerSplitInput/SegmentOneInput 增 `box?`（正框覆写，缺省=父外接）+excludeBox/instances 透传；**P1 快照扩容三字段**（改排除区不重试跑漏洞堵死）；Dialog 三模式（排除区拖画 offsetWidth 比例反解回 imagePx/纯框/实例枚举网格——子集勾选记 follow-up）；质量门泄漏告警文案带 excludeBox 指引。绿门：contracts 275/vision 204/studio 2980/svelte-check 0。**fifo 遗留结论：daemon 生产桥=SSH 直连每连接新进程（代码无 fifo 传输），78097/17097 为遗留孤儿不影响 8317——清理建议交 Owner。**③缺口发现+T2.5 派发：tree_refine 工具面（Agent 修漏主路径）原只有 hints[]——补 steps[{hint?,box?,excludeBox?,instances?}] 互斥形态（iter-1 右头冠修漏的前提）。
  - **T1 落地（602ad2b+29399a4）**：text prompt 真源=`sam-bridge.ts` SamTextPromptSchema——`excludeBox?`（**桥 materialize 归一化后画布坐标矩形清零**——best 与 all 逐实例同减；不透传线上）+`text` 可选（superRefine text/box 至少一项=纯 box 合法）+`topK`；contracts SegmentOneInput `instances:'best'|'all'`+excludeBox+`SegmentOneTrial.instancePreviews`；**all 扇出全链**：互斥后单源（resolveSiblingOverlaps 统一消解）/低分实例门（box 提示防垃圾多检出）/≤24 截断 `instances-truncated` warning/命名基名+N（空实例不占号保序）/segmentPrompt+[instance-N]/账本行带逐实例 blobRef 回放幂等（best/all 天然分账——topK 入 reqHash）。341+273 绿。
  - **④ macmini 原生点服务上线（v1.1.0，报告+产物集落 experiments）**：`Prompt.append_points`+`add_points_prompt`（**单次 grounding pass**——时延不随点数涨：纯点 5.1s/全组合 7.0s）+服务面 prompt.points 像素入参归一化+每 detection 附 `containsPoints`；**回归三组逐位一致**（text/text+box/纯 box 改前后 maskPx+score 同值）；**新坑**：`concat_padded_sequences` GPU scatter 不支持 int64（首跑全 INTERNAL；box 存活因传 bool——修复=processor 层 bool 标签）；**双正点可能无候选含全部正点**（292k px 实例两候选 containsPoints 均 false——桥层回退策略必须）；负点=软先验复现（−656px≈噪声）；PROTOCOL 矩阵 points ✅+boxNegative 加⚠️无空间排除注记。**fifo 常驻 78097/stale 17097 内存仍是旧代码**——direct 路径（daemon 桥）新连接即 1.1.0；fifo 面需 stop/start（未越权，留 Owner）。
  - **spike 纠偏（25e1f2c，2026-10-04）**：macmini 实证推翻两假设——①**线上 boxNegative 无空间排除语义**（负点收缩 0.15-0.18%≈噪声；负框反涨 +233px；脸上负框压死全部检出；协议矩阵 ✅ 只验「掩码非空」）→D2 改 **excludeBox=桥响应后确定性像素减法**（不透传线上）；②**微框近似点全尺寸否决**（4/8/16/32px 语义=框住的小物本身，IoU≈0）→D4 裁定 **macmini 原生点包装**（f16 权重点编码器全在+15 次原生推理实证；~30 行 append_points/add_point_prompt+topK 候选全给；桥层筛选「含全部正点∧不含负点」；**负点=软先验不承诺排除**；单点常部件级→多正点拉全 51k→292k）。知识库条目同步纠偏（负框与点微调→排除区与点微调；对照表/枚举/措辞三处 boxNegative 引用清零）。**教训：协议矩阵的「支持」必须核语义不能只看「有返回」；spike 先行救了整个 playbook 的错误地基。**

  - **iter-6 干净 A/B 终裁（2026-10-04）**：500px 铁证重跑（首树 500/2.5+intake blobRef 与 iter-5 一致=确定性推导实证）。**扁平化增益成立**（分件质量：星 45.8→70.1%/袍 ~55%；效率：阈值 20→1/时长 −38%；BOM 6 SKU 复现）；**伪影清单**（零修树=坐标闸门假零 iter-6 实修 26/scene_analyze 三连败=1280 分辨率伪影 500px 一次成/68× 中袍=分辨率收益）；**同色粘连=真实新代价**（扁平化×分辨率交互——中袍归属 P1：区域 97.5% 被邻层覆盖有钻视觉完整但语义归属缺失未披露，①改记「视觉覆盖通过/语义归属 P1」）；iter-5 的 9.1 修订为原始运行分（不再作单变量分数）；iter-6 记 8.8。**产品化=条件 GO（研发/灰度）/发布 NO-GO**——五门前置：四图引用分离/几何一致性门/导出必须原图（iter-6 source.img 仍是扁平图）/归属核对接入导出门（KB b35032e 规则方向对但需自动门禁）/密度策略冻结；**双通道设计建议**（扁平图管结构分件+原图管视觉细节与导出）。Codex 提醒：673a87d 同时改 intake+segment 入线——本轮是「坐标清洁后的工程 A/B」非严格固定代码实验，百分比保守解读。
  - **Owner 报障 512×512mm 双 bug 定位+路由统一立项（2026-10-04）**：会话 76b63ed7 图层属性 512×512mm 根因=**双 bug 叠加**——①工作画布推导不定元：iter-5 原样 PNG 上传跳过重采样→imagePx 1280/ppm6.4，对照组 JPEG 上传→500px/ppm2.5（同表单 20×20cm！修复=画布恒=canvasCm×有效 ppm 与格式无关）②UI mm 换算用配置缺省 ppm2.5 而非布局真源 ppm（1280/2.5=512mm 假象）。**A/B 分辨率混杂变量如实披露**：iter-5 的 68× 中袍等数字含分辨率红利（500→1280px 工作画布），Codex 归因收窄预警二次命中——iter-6 修复后同 500px 重跑才是干净对照。另 Owner 指令：路由层统一（工作台/拍钻 URL 不变——SPA 无路由层+20 处零散 pushState）+残留不留——`unify-studio-routing` change 立项（6c383eb，含八项 sweep 清单）。
  - **add-sam-playbook 全战役收口（966c113 归档+push，2026-10-04）**：T5 全量门三包绿（daemon 1522/1522/contracts/studio 2979+2 负载 flake 隔离复跑绿）；change 归档；产品化转 `add-flat-aux-segmentation`（65c8c78 立项，Codex 最小范围三条为骨架）。**全程档案**：`experiments/sam-playbook-20261004/`（research/spike/points-upgrade/iter-0..4/iter-5-flat-ab+每轮 codex-review）。评分曲线 iter 循环 7.8→8.3→8.7→9.0 满意闭合；A/B 9.1>9.0 增益成立。8317 终态=b9c2025。macmini 服务 v1.1.0（direct 面生效；fifo 78097/stale 17097 遗留孤儿待 Owner 清理）。**待 Owner 决策清单**：①stones.add 是否被 autoApprove 覆盖=产品政策（当前 DB 已覆盖+文案已对齐 A；收紧 B 需显式决策）②密度/选钻风格（点缀 vs 满铺）写成产品选项③左袍 fill 26.2% P2 观察项④背景反选掩膜求反能力挂账（管线级）⑤GLM-5.3-Flash 供应商稳定性（iter-3 11/14+iter-5 三连败前科）。

**2026-10-05 SAM 升级战役终审交付（参考图层产品化+路由统一收口）**：
- **Owner 质询连环（「效果很差」「我要求的辅助图层呢？」）+配置事件**：旗舰分享包 aXMPb8THHBcP（原图分件产物）被 Owner 判效果差；根因=参考图层自动生成从未真实跑过（image-edit 未配置=软回退原图——正是裁决位①）。**Owner 随即给出本地服务配置**（BASE_URL=http://127.0.0.1:20002/openai-image/v1，gpt-image-2.5，免密钥本地服务），指令「规范化管理（理论上存储到 env file 就行）」——落位：**settings 真源**存 local-image-edit 路由（合并保存，anthropic 路由+default 零扰动；2026-09-28 裁决 settings 唯一真源、.env 初始化后不再读）+ `daemon/.env` 灾备记录块（注释形态）。**免密钥放宽**（5a9255d）：resolveImageEditRoute 此前强制带密钥（无密钥=null）与本地免密钥服务冲突——keyless 路由合法+无密钥不发 authorization 头。**T6.3 手动导入**（BYOK 补充线，5a9255d+189d27f）：task.reference.import 直写面（userOwnsBlobRef 归属+与生成同一道 IoU 门+不过 typed 拒带数字+过门帧 latest-wins 压过禁用=再激活/压过旧生成=替换+report provider=manual-import）；studio 三面+WorkbenchReferenceLayer「导入」按钮；daemon 5 例+studio 2 例绿。
- **参考图层旗舰首跑（ref-layer-flagship，任务 160df9a7·会话 e090f309）——全链铁证**：JPEG 直传 274101B（run1 死链同字节）→归一 4d9eddcf→S2 style=photographic→**本地 gpt-image-2.5 自动生成参考图层→IoU 0.912 过门（srcCov 0.829/refCov 0.776，服务端 1254→500 网格对齐）→分件树 37 版全锚参考图层 09ee4adc**——自动生成路径产品内首跑全程真实生效。**77min 熔断于 strategy.design**：文本网关连续 9×300s 不返回（每次顶满 daemon 侧超时被掐）→RUNAWAY_LIMIT=5 同错熔断——GLM-5.3-Flash 供应商稳定性（挂账 P2）升级为整跑杀手新证。**对策**：STRATEGY_DESIGN_LLM_TIMEOUT_MS=600000 入 start-8317.sh+重启（PID 换新）；续跑 da43f63f（9min 纪律性收口：无死锁授权残留+mofang 100 款入 manifest+卡点如实上报「旧树工件引用查不到、不猜不重跑」——agent 纪律优秀）；解卡 daf94d33（喂 treeArtifactRef cb323423 v37 终树+sceneAnalysisRef 17d3d090+canvasCm 20×20——跨任务树引用缺口记为新观察：每 followup=新任务，树/参考图层皆任务域，跨任务复用只能靠内容寻址断点或人工喂引用，产品面待议）。
- **codex-final-r1 终审+增量复审双轮闭合**（gpt-6.1-sol xhigh，全文落档 worktree `add-flat-aux-segmentation/codex-final-r1.md`）：终审独立复算 T7a 产物级证据全一致（source.img SHA-256 三方比对）；开 4 需修/补证+4 Owner 裁决位；增量复审（7min）确认 ①③④闭合——**add-flat-aux-segmentation 8.7/10 研发/灰度条件 GO（正式归档 NO-GO——真实 image-edit 未实跑）、unify-studio-routing 8.8/10 Studio 路由 GO（daemon 分享页文案留后批）、旗舰证据链 7.8/10**。战役一句话：坐标/引用/导出/路由工程骨架打通，JPEG 入线+任务闭合+转换器职责+UI 三态证据补齐；真实参考图层生成四类旗舰（成功/失败/IoU 不过/分件采用）待 Owner 配置 image-edit 路由后补跑。
- **补证①（JPEG live 回归 12/12，档案 `experiments/sam-playbook-20261004/t7a-flagship/jpeg-live-regression/`）**：HEAD 159d72c（8317）重放 run1 同字节原版微信 JPG 274101B→followup 单漏斗归一（agent 收归一 PNG ref 4d9eddcf≠上传 627d3260、PNG 魔数 1280×1280）→帧流+tasks.params 零 JPEG ref（无 ref 双源）→S2 photographic 正常→~2min done；导出链以「代码契约+live 入线证据」闭合（sessionImageSet→sourceImageOfSession→T5.1 字节级断言同源，Codex 采信并保留边界=非本跑 live export receipt）。**补证③④**：tasks.md 真值勾选（顶层 1.1/1.3/1.4/1.5/6.2/7.2 勾选附落地引用——1.4=LLM maxTokens 界+RUNAWAY_LIMIT=5 熔断；7.2 四态测试复核在位 reference-image.test.ts:615/:396-434/:453+flat-aux-t6:212-227；7.1 保持开放标注边界；7.3 收口）+转换器职责显式化（零行为变更——服务端 followup=权威归一单源/客户端 canvas=预转换优化/收敛契约=入线恒 PNG 非逐字节同 PNG；23+套件绿+svelte-check 0 错）。
- **vision 双走查 8/8 PASS**（worktree `add-flat-aux-segmentation/vision-walkthrough-20261005.md`+截图 14 张 `experiments/sam-playbook-20261004/final-walk-20261005/`）：路由 A1-A5（hash 逐项变更/刷新回退还原/深链/数据源芯片双向/匿名进入不卡死）+参考图层 B1-B3（未生成态实况+挂锁+结构不可选/重新生成 typed 拒实录+autoApprove 不被绕过/分享包五产物 200+魔数+混合预览像素级生效）——B1/B2 即终审「没有证明」清单第 5 项（UI 三态真实浏览器链路）证据，增量复审采信。**#/assets 旗标门控核实为既定设计**（App.svelte:426 devWorkbenches 默认关——2026-10-02 Owner 裁决），非路由缺口。**P3 打磨新挂账**：`#/t/{id}/workbench` 冷开还原后 URL 归一化剥后缀（刷新落详情 tab）；分享页大图懒加载期滚动重复请求。
- **worktree 终态提交链**：643023c→159d72c（JPEG 归一+术语 v5+超时）→f2a7bde（终审落档+补证①③④）→dce3d88（增量复审落档+走查归档+7.3 收口）——f2a7bde/dce3d88 为纯注释/文档增量**零运行时差**，8317（PID 80133，159d72c）无需换装。主仓 9f986fb（live 回归档案）。
- **待 Owner 裁决（4+5）**：①pavingStyle 默认（full/accent/强制显式）②归属门 v1「披露不阻断」是否维持 ③routing daemon 文案后批是否接受 ④真实 image-edit 与旗舰重跑前是否接受现状归档发布（=配置一条 api=openai-image-edit 带密钥路由后补四类旗舰证据）；另有前批遗留：stones.add autoApprove 政策 B/macmini fifo 78097+17097 清理/背景反选掩膜求反挂账/GLM-5.3-Flash 供应商稳定性。
- **新指令已勘察排队（Owner 2026-10-04/05 中途指令，未开工）**：A 选钻 Dialog 重设计（992 格平铺→Dialog 搜索/分组+真实贴图——StoneCandidateRow 契约缺 textureUrl 是色块根因；成品级 StonePicker 组件已存在未接线；969/992 有真贴图）B 提示词工作台 MCP 化（=「提示词实验室」LabView 纯浏览器 BYOK——组装纯函数 604 行/模板 IDB/变体矩阵均浏览器私有；最小闭环=组装函数收编 daemon+模板真源落服务端+工具进 MCP 面）。

- **参考图层旗舰四幕终局（2026-10-05 晨，交付 `/r/CIEFA73NChu4`·936 颗·27 分件·BOM 9 行）**：幕一 160df9a7（77min 熔断——strategy LLM 9×300s 顶满不返回→RUNAWAY 熔断；参考图层链全成：IoU 0.912 过门+树 37 版全锚参考图层 09ee4adc）；幕二 da43f63f（9min 纪律收口：无死锁授权+卡点如实上报不瞎重跑）；幕三 daf94d33（40min **废案**：跨任务树被 artifact-task-mismatch 拒→同入参重建，但参考图层是任务域——新任务零参考帧→树锚回原图 c81d0e53，产出 /r/X1XKrl6YAWtr 不可交付）；幕四 f92a04c5（54min **交付**：failed≠cancelled 可写但 grant 绑定运行时任务（旧任务 3 次 propose 全 grant-expired）→agent 自解「绑定任务上下文+treeArtifactRef 锚定 v37 树」一次打通）。**对策已固化**：STRATEGY_DESIGN_LLM_TIMEOUT_MS=600000（start-8317.sh）；幕四 26 次策略调用全过。**vision 质检**（39 图证 `experiments/sam-playbook-20261004/refcheck-20261005/`）：新旧对比质变（旧=不可读宝蓝墙纸/白钻 13%，新=三角构图清晰/白钻 44%/BOM 图例四方一致 936）；混合对位 PASS；**三短板**：右翼主羽缺口+夜空钻越权占位、左翼下羽薄、六星代表性不足（大右星 0 白钻/顶中星空/余星 2-4 颗）——星叶掩膜 fill 70% ≠ 成品钻覆盖（密度语义颗/cm² 绝对值：星物理 ~1cm²→2-3 颗属策略密度分配面，非分件失败）。**产品缺口新证**：跨任务树引用栅栏+参考图层任务域（fail-resume 断档根因）+GLM 网关大规模 prompt 不返回。

- **Owner 实弹连环修复+选钻 Dialog 落地（2026-10-05 午，bca470e）**：①「打开完整工作台→尚无图层树」——根因=终局任务树域空（跨任务锚定）；**tree.adopt 跨任务树领养 RPC** 落地（同会话校验+内容寻址零拷贝双工件帧+journey 版本链播种幂等，3 例绿）+**Owner 实弹二连**：领养后画布仍空=树锚图（参考图层 blob）不在 taskArtifact 合法引用集（任务帧∪会话附件）——adopt 补锚帧 object-tree-anchor.png（可读性守卫）；贴图 404=23 款 pending 空原子目录（A88 实证）——chipTextureFallback（401 自愈一次后隐藏 img 透 hex 色底）。②**选钻 Dialog**（Owner 原需求「无脑平铺→Dialog 搜索/分组+真实配图」）：StoneCandidateRow +textureUrl/styleName/finish（投影批量 SQL 判定贴图在场——真实库 42.6→1.3ms 双口径验证一致 969/23）+WorkbenchStonePickerDialog（搜索/仅看已选/分组懒渲染/全部平铺/贴图格+无贴图占位/已选托盘/应用语义「空选=沿用」）+Inspector 入口按钮+已选缩略横排；contracts 286/daemon 102/studio 224 聚焦绿。8317 双部署（daemon 重启×2+dist 构建）。**待 Owner 点头**：23 款 pending 重跑导入补贴图（数据根修）。**新挂账**：import 归属账本缺口（任务域产物不在 userOwnsBlobRef——session_blob_refs 对任务工件 0 行）；gemSummary chip 兜底 import 路径自纠（子代理 svelte-check 抓出）。

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
