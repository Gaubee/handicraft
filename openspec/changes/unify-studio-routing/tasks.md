# unify-studio-routing · tasks（核心批：统一路由层）

sweep 八项不在本批（proposal §2.2——后续批）。

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
