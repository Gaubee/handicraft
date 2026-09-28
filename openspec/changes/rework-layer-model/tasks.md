# Tasks：图层模型 PS 化重构（v4）

## 波 1：渲染语义层

- [x] 1.1 cutout.svelte.ts 抠图层合成管线（destination-in+内容寻址 LRU+坏 mask 降级+缩略图派生）+单元测试（缓存命中/失效/降级）——`workbench.cutout.test.ts` 12 用例
- [x] 1.2 主视图图层化渲染：背景层（可隐藏）+图层抠图叠加（树序=z 序）+钻子层（随层显隐传递）+选中/hover 交互态（描边+标签仅交互时）——移除常驻 bbox 条框/标签/组徽标（WorkbenchLayerStage/Item；走查 01-08 截图）
- [x] 1.3 钻渲染迁 canvas（层坐标系+空间索引命中/hover 单颗）+previewMode 三模式在层模型下的语义重定（numbered 图例移侧栏）
- [x] 1.4 treeView 对齐：图层行缩略图=抠图缩略渲染（LayerCutoutThumb——替换蒙版色块）；钻布局虚拟子行（规格+颗数——assignments 派生）

## 波 2：容器查询工作台+详情合一

- [x] 2.1 TaskWorkbenchView 容器查询（container-type+@container 断点 @lg=32rem）：紧凑形态（迷你画布+图层列表+选中层摘要+关键操作）/完整形态；历史 dock 入 ⋯ 菜单
- [x] 2.2 TaskDetailPanel 改造=挂载工作台紧凑形态（删只读摘要实现；同 store；「打开完整工作台」=纯放大）+AgentView 桌面右栏/移动 sheet 双形态回归

## 波 3：纹理优先缺省

- [x] 3.1 demo 映射回归（高帽/绒球/鼻/双手→texture-fill；上衣保留 straight-line；卷发保留 soft-curve）+Inspector 策略推荐决策树与引导文案+策略设计 prompt 纹理优先表述（前半已入 29f2a37；本轮=Inspector 决策树+daemon prompt 快照同步）

## 波 4：验收

- [x] 4.1 全绿门（contracts/daemon/studio 测试+typecheck+svelte-check+build）——contracts 170/170、daemon 858/858（strategy-design 快照随 prompt 决策树句同步）、studio workbench+agent 172/172+svelte-check 0/0+build 通过+perf-gate 17/18（decode.layer.4K2 为既有挂账，基线同）
- [x] 4.2 真浏览器走查：抠图层正确性/显隐传递/z 序/交互态/三形态/纹理缺省——截图+断言（`.agents/images/2026-09-27-layer-model-v4/` 13 张+CDP 断言两步零失败；走查脚本 /tmp/walk-v4）
- [x] 4.3 vision 走查（零条框判定+PS 感）+Codex 复核+spec delta 同步+验收报告（MainAgent 阶段）

## 波 5：v4 修复轮（Codex NO-GO 7.7/10 + MainAgent vision 走查定案——2026-09-28）

- [x] 5.1 F1 紧凑工作台补关键操作（Codex P1-1）：紧凑态策略直改（族选择+密度——applyLayerStrategy 同一写路径）+掩码重算/放弃命令（stale/error/incomplete 就近恢复链）——`workbench.v4.test.ts` [E] F1 两用例（策略更改+重算入口）
- [x] 5.2 F2 双任务视图不串 store（Codex P1-2）：装载门按视图归属（embedded→agent/完整→studio；store 无主宽松装载、有主严格归属+taskId 校验重载）——A/B 任务（clown/willow）来回切换集成测试+同任务双实例选中保留
- [x] 5.3 F3 快捷键可见性门（Codex P1-3）：presence.svelte.ts（checkVisibility/hidden 链双态）——⌘Z/Delete/F2/Alt+方向/?/空格 在隐藏工作台（lab/agent Tab、双实例）不截获不触发
- [x] 5.4 F4 不可见层不合成（Codex P1-4）：可见节点集（hiddenDeepIdsOf 单源——渲染/命中/请求三面同式）接入 requestCutoutsForTree；条目随请求集收缩释放；LRU 增字节预算 512MiB（超限逐出最旧）——`workbench.cutout.test.ts` [F] 两用例
- [x] 5.5 F5 树根=背景层（MainAgent B1）：根行眼睛驱动 baseImage 显隐（与工具栏背景簇同真源双向）+根行缩略=原图+根行不选中/不承接命中（选中限图层节点）+旧 view-state 快照 root.hidden 读回剔除
- [x] 5.6 F6 390px 工具行重叠（vision P2）：@max-lg 预览模式条靠左+右侧预留背景胶囊带+图标化+横滚；背景胶囊/颗数读数收紧——r2 走查 390/320 两控件完整可见可点
- [x] 5.7 F7 演示可辨性+断言加严：a) 种子底色改 #2a2e37 深底；b) 隐藏背景走查断言=截图像素 diff（非层区域必变——r2 走查）；c) 斜纹实证：codec 往返无损+纯色区零偏离+真照片无对角周期（/tmp/stripe-forensics.ts——非 codec 伪影非数据特性，记录即止）
- [x] 5.8 F8 P2 清单：a) GemSpatialIndex 桶边界（半径覆盖所有桶登记——跨 X/Y/角点+重叠 z 序测试）；b) 钻子行继承祖先显隐（降显+data-inherited-hidden 标记——画布/命中/面板三面断言）；c) design.md/TaskWorkbenchView 注释 inline-size 同步；d) cutout/layerRender 来源头+时间戳+as unknown as 改窄适配；e) tasks.md EOF 空行清除

## 波 6：v4 修复轮二（Codex 二轮 NO-GO 7.5/10——2026-09-28）

- [x] 6.1 G1 F1 真闭合：紧凑策略参数判别值（Codex 二轮 P1-1）——paramsSchema 增 `strategyDefaultsOf`（族→最小合法 params：判别联合族必需判别值）+`STRATEGY_KIND_ORDER` 决策树序单源（紧凑态/Inspector 两份数组收敛）；紧凑态应用与 Inspector 应用载荷（paramsForApply 基座）同源；jsdom 断言请求 params 含判别值（geometry={shape:star}/texture-fill={mode:scatter}/soft-curve={}）+重算/放弃按钮真点击终态断言（ready 收敛/行移除+门阻减一）
- [x] 6.2 G1 真浏览器窄容器真 daemon 策略更改：r3 走查 A（独立 daemon 18870+隔离 DATA_ROOT+Chrome CDP）——嵌入工作台 460px<32rem 实际触发容器查询+checkVisibility 真身；geometry+密度 2.0 经真 daemon 直接生效（toast+回显+帽子点阵 28→32 引擎真身重算）；daemon 侧落库断言（walkthrough-v4-r3-verify：plan 工件 n-hat={shape:star}/密度 2.0/钻继承、gems planRef 推进、68 颗点阵）——种子脚本 daemon/scripts/walkthrough-v4-r3-seed.ts（补 plan/gems 工件）
- [x] 6.3 G2 F2 真闭合：异步写命令任务代次栅栏（Codex 二轮 P1-2）——renameLayer/applyLayerStrategy 入口捕获 {requestTaskId, loadSeq}，每次 await 后写共享状态前校验（跨任务=放弃写；同任务代次漂移=定向刷新收敛）；artifact 后续请求用捕获 task id；延迟响应交错测试两例（rename/策略重算：A 在途→切 B 装载→放回 A 响应——B 的 nodes/detail/assignments/gems 不被污染，切回 A 真源读回）；装载门 idle 旁路收紧为始终要求归属视图匹配（测试宿主显式 setView——2c/2d/v3/final/view 五测试文件 beforeEach 同步）
- [x] 6.4 G3 F4 真闭合：在途合成订阅竞态（Codex 二轮 P1-4）——requestCutouts 按 key 合并 promise（InFlightCutout.subscribers 当前可见订阅者集）：同键在途重显=合并订阅+登记 loading entry（修复跳过不登记形态的重显永久 idle）；完成只向当前请求集回填；无可见订阅者的结果不占缓存；「开始→隐藏→重显→resolve 只合成一次+ready」/「隐藏→resolve 不复活 entry 不占缓存」两用例；预算口径定名 cache-owned estimate（CUTOUT_CACHE_OWNED_BYTES_MAX——注释明示不含 WorkbenchLayerItem 消费副本/并发合成临时面，总内存上限=后续架构项）；r3 走查 B 重显收敛 ready 实证
- [x] 6.5 G4 证据与收尾（Codex 二轮 P2）——a) F7b 像素 diff 断言入库 experiments/layer-model-v4/pixel-diff-f7b.ts（r2 帧复跑 PASS：非层 99.0%必变/画布外 0.0%/帽子红 42.6%/脸肤 79.7%）；b) 来源头补齐 layerTree.ts（hiddenDeepIdsOf v4 意图）/TaskWorkbenchView.svelte/WorkbenchCanvasStage.svelte（原始需求+时间戳）；c) F3 checkVisibility 真浏览器走查（r3 走查 B3-B5：lab 视图 hidden 属性→UA display:none 放行 6 键+CSS display:none 非 hidden 属性场景+恢复接管）——截图 r3-01..04 入 .agents/images/2026-09-27-layer-model-v4/

## 波 7：v4 修复轮三（Codex 三轮 NO-GO 7.8/10——2026-09-28）

- [x] 7.1 H1 free-code 需载荷族直改门（Codex 三轮 P1-1）——strategyDefaultsOf 返回类型区分可静态默认族/需载荷族（free-code=requires-payload：daemon FreeCodeParamsSchema XOR 二选一+design.ts persistFreeCodeArtifact 要求 params.source——空对象直改必败）；紧凑态别族切入=按钮禁用+引导提案提示（FREE_CODE_PROPOSAL_HINT 单源）/同族重应用=原指派载荷整组重发（source 不丢）；Inspector free-code 分支双面（同族=密度+重应用按钮/别族=阻止提示无直改按钮）；daemon 侧七族真源测试 daemon/tests/workbench.v4-strategy-defaults.test.ts（static 六族逐族过 registry paramsSchema+free-code {} 必拒+同族载荷过 schema）+studio UI 门 3 例；真浏览器窄容器走查 8/8（460px 嵌入工作台——别族切入阻止+柳树缎带层同族重应用成功 toast，截图 r4-01/02 入 .agents/images/2026-09-27-layer-model-v4/）
- [x] 7.2 H2 任务代次栅栏泛化到全部异步写命令（Codex 三轮 P1-2）——split/reorder/delete/tree revert/mask retry/discard/brush patch 逐一入口捕获 {requestTaskId, loadSeq}+RPC 固定捕获 id+每个 await 后写共享状态前校验+跨任务丢弃/同任务代次漂移定向刷新+refresh 后收尾再验归属；viewWriteChain 入队绑定 task/epoch（过期项不发出、viewRevision 写入与失败回滚先验栅栏——旧快照不回滚新任务投影）；waitForMaskEditSettled 固定捕获 id 轮询；exportTask RPC 同式；A→B 延迟响应交错测试 8 例（split/reorder+B 下一次 CAS 基线正确——Codex 点名树引用链/delete/mask retry/brush patch/view-state 成功+失败/tree revert）
- [x] 7.3 H3 在途合成订阅 key 漂移（Codex 三轮 P2）——完成判定按当前期望键（entries.get(id).key===本键）过滤订阅者：同节点换 maskRef/bbox 后旧 flight 结果无当前消费者不占缓存不逐出有效项（此前 subscribers 非空即 cachePut 旧画布）；测试 2 例（同 ID 换 maskRef 延迟完成+小预算预填 keeper 不被逐出；隐藏→重显→再隐藏→resolve 级联——Codex 建议用例）
- [x] 7.4 H4 r3 走查 verifier 收紧（Codex 三轮 P2）——taskId+seedPlanRef 必填（usage exit 2）+强制目标任务（C0）+C5 拆 C5a（seedPlanRef 须真实在目标任务 plan 帧历史——封「任意不同 ref」旁路）/C5b（planRef≠种子代）+C6 预期下界断言（缺省 68 对齐声明）；四路径实证（正确参数 C0-C6 全 PASS count=68≥68/错误 seedRef C5a 抓 exit 1/不存在 task 拒 exit 1/无参 usage exit 2——r3 隔离 DATA_ROOT 只读复跑）
- [x] 7.5 绿门：contracts 170/170、daemon 862/862（+七族新测 4）、studio 201 文件 2496 passed/1 skipped（+13 新测）、daemon/studio typecheck+svelte-check 0/0、vite build 通过、git diff --check PASS；走查资源回收（vite 5190+Chrome CDP 9334 关闭，Owner 8317/5200 全程未触碰——pid 93981 监听如常）

## 终态（2026-09-28）

- **Codex 五轮评审链**：7.7→7.5→7.8→8.3→8.6→**9.1 GO**（报告归档 codex-review.md）。修复轮四波：r2（F1-F8）/r3（G1-G4）/r4（H1-H4）/MainAgent 亲修两轮（6007380 栅栏残余+测试收紧）。
- 绿门终态：contracts 170/170；daemon 862/862；studio **2500 passed/1 skipped**；typecheck×2+svelte-check 0/0+build；diff-check PASS。挂账：decode.layer.4K2（既有，contracts 解码路径）。
- 真浏览器走查：r4 8/8（free-code 阻止/同族重应用）+r3 6/6（紧凑真 daemon 策略落库）+r2 15 断言+像素 diff（非层区 99% 必变——F7b 入库 experiments/layer-model-v4/pixel-diff-f7b.ts）。
- 存量真 bug 揪出并修复：Tailwind preflight img max-width 把背景层压 0 宽（max-w-none）；LRU 共享 canvas 争抢；种子 PNG 无伪影（斜纹=摩尔纹定案）。
- Owner 验收环境：8317=v4 数据根（journey-clown-rich-v4-20260928——纹理优先真识别 858 颗）+新 dist。
