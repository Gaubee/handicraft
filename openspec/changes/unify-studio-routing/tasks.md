# unify-studio-routing · tasks（核心批：统一路由层 + sweep 批 §5）

sweep 批见 §5（2026-10-04 studio 面七项闭环；daemon 部分显式留后批 §5.9）。

## 1. 路由层

- [x] 1.1 router.svelte.ts：Route 扩 home 视图段（view/session/composer/taskTab/
      taskResultId/studioTask/studioEngine）+ ViewId/TaskTab 类型源；parseHash 全表
      解析（容错回落）+ routeHash 规范形互逆
- [x] 1.2 history 执行器：writeHash(push/replace + jsdom 降级 + router.route 即时
      同步)、stripSearchParams(保 hash)、navigate(replace 变体)
- [x] 1.3 view.svelte.ts：API 保留 + studioMode/taskTab 状态提升 + startViewRouteSync
      （hashchange/popstate/启动同步）+ bindViewRouteSessionSource provider
- [x] 1.4 sessionRoute：writeSessionHash 改走 writeHash；view 门（非 agent 视图不
      镜像不派发）；同会话镜像保留 tab 段、换会话剥段；reset 委托 router
- [x] 1.5 urlFlags / demoDelay：清参改走 stripSearchParams（demoDelay 修丢 hash bug）

## 2. App 层接入

- [x] 2.1 App.svelte：startViewRouteSync 启动；无旗标 dev 视图深链回退（replace `#/`）；
      Tabs value 绑定回退安全视图；handoff/openIntent/导入路由效果零改（setView 自动镜像）
- [x] 2.2 StudioView：studioMode → view store（引擎实验进/出 = 路由导航）
- [x] 2.3 TaskDetailPanel：tabs（detail/activity/workbench/result）→ view store 路由态；
      导出行/关闭钮/触发器全走 openTaskTab；任务切换回详情语义保持
- [x] 2.4 TaskWorkbenchView.onBack：closeStudioTask(replace)+openSession+setView(push)
      ——终态 `#/t/{id}`
- [x] 2.5 store.svelte.ts：initAgentStore 绑定 view 路由 session provider（session id +
      composer 态）

## 3. 测试

- [x] 3.1 router.test.ts：新路由表 parse 回落矩阵 + routeHash 互逆扩表
- [x] 3.2 routing/viewRoute.test.ts：视图/子态双向同步矩阵（setView 镜像、深链派发、
      同会话保段/换会话剥段、composer 回填）
- [x] 3.3 routing/appUrlSync.test.ts：App 级 jsdom——tab 切换 URL 变更、openStudioTask、
      刷新还原、history.back 回退、任务详情 tab 路由、无旗标 dev 深链回退
- [x] 3.4 routing/historyGuard.test.ts：src 收编守卫（pushState/replaceState/
      location.hash 赋值 归零，白名单 router.svelte.ts）
- [x] 3.5 既有测试回归绿 + `pnpm check` 0 错

## 4. 收尾

- [x] 4.1 design.md/tasks.md 落档（本文件）
- [x] 4.2 显式路径 git commit

## 5. sweep 批（studio 面——2026-10-04 后续批；proposal §2.2）

- [x] 5.1 匿名进入失效：loginAnonymous 取 token 后不再经 adminApi().me()（me()
      只读登录键位 token——匿名 token 在独立键位 → tokenless WS 必拒「需要登录」
      → false → 弹窗不关；T6a 断头根因）。修=确定性投影 ANONYMOUS_SESSION_USER
      （session.svelte.ts；失败仍留窗+错误）。测试=session.test.ts 成功关窗（me
      不可用仍成功）+失败留窗两态
- [x] 5.2 rpc 入口可发现：顶栏常驻「演示数据/服务器」芯片（App.svelte——状态可见
      +点击 rpc↔mock 切换：setAgentApiMode 写键+整页重载重建 WS/会话；?api=rpc
      深链同键兼容）。测试=agentApiModeToggle.test.ts（键写面互逆+芯片状态+切换
      toast+深链共享键面）
- [x] 5.3 零检出双文案互斥：SegmentDialog renderedWarnings——零子层终态不渲染
      score-missing 警（「按默认置信入树」宣称与终态相拗；服务端在父∩子裁剪前
      发警）；有子层保留。测试=workbench.segmentDialog.test.ts 两态互斥断言
- [x] 5.4 tab 双高亮：app.css 顶栏锚焦点层级——非激活聚焦=ring 置空+1px 细描边
      （弱指示）；激活聚焦=outline none（选中实底=唯一强高亮）。守卫测试=
      topbarTabHierarchy.test.ts（基类压制+顶栏锚类断言）
- [x] 5.5 旧 bundle 残留审批卡：answerApproval 捕获服务端死 proposal 拒绝
      （已过期/已处理/不存在/跨会话——authorization.ts 文案契约）→本地清卡+toast
      （不再反复请求批准）；瞬态错误卡保留可重试。测试=approvalStack.test.ts
      ⑪⑫（判死清卡+瞬态留卡）
- [x] 5.6 导出后静默重绑：TaskDetailPanel 重绑可见化——元数据「当前任务」行
      （首条用户指令短标+title=taskId 常驻）+taskId 漂移 toast 点名新任务。
      测试=taskDetailTabs.test.ts（宿主 rebind 驱动）
- [x] 5.7 用时跨天口径显示：formatActivityDuration 增 h 档（≥1h 显 h m——
      「75222s」巨数秒不直出）；面板元数据/running 徽标共用（计算口径=既有
      activeElapsedMs 活跃窗口）。测试=taskActivityTimeline.test.ts h 档表+
      面板沿用断言
- [x] 5.8 图例贴图缩略（numbered.png）——已由 19af98b 批闭合（色点→贴图缩略+
      预乘防光晕），本批复核无残留
- [ ] 5.9 daemon 部分（e2e 分享页文案漂移——http.ts「下载 PNG」vs 测试期望）：
      **显式留给后批**（本批不碰 daemon）

绿门：受影响单文件测试全绿（session/loginPage/agentApiModeToggle/
workbench.segmentDialog/approvalStack/taskDetailTabs/taskActivityTimeline/
agentFace/autoApproveToggle/sessionUserSync/zhumoParity/agentDetailLayout/
appUrlSync/viewRoute/router/adminPage/appRouting/app.smoke/humanizeShell/
app.globalImport——globalImport 首轮并行负载抖动，单跑复绿）+ `pnpm check` 0 错。
