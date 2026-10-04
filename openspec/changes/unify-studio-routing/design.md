# unify-studio-routing · design（核心批：统一路由层）

## 0. 架构勘察结论（本批素材）

### 0.1 页面态模型（现状）

- **顶层**（`src/lib/router.svelte.ts`，已有）：hash 路由三分发 `#/login` → LoginPage、
  `#/admin/{tab}` → AdminPage、其余 → 前台壳（home）。`startRouter()` 监听
  hashchange/popstate 更新 `router.route`；`navigate()` = `location.hash` 赋值。
- **前台壳内部**（`src/lib/stores/view.svelte.ts`，组件态——本批改造对象）：
  - `current: ViewId`（'agent' | 'assets' | 'stones' | 'warehouse' | 'lab' | 'studio'
    | 'strategy' | 'edit'）——App.svelte 顶栏 Tabs 受控绑定；**切 tab 不写 URL**
    （模块级 $state，刷新即回 agent）。
  - `studioTaskId: string | null`——studio 视图任务上下文（SessionStream/FrameView/
    TaskDetailPanel 的「打开任务详情」`openStudioTask` 置位；TaskWorkbenchView 返回
    `closeStudioTask` 清空）——**不写 URL**。
  - StudioView 内部 `studioMode: 'select' | 'engine'` 组件实例态（引擎实验入口）——
    **不写 URL**。
  - TaskDetailPanel（Agent 第三栏/移动 Sheet）tabs：`active = 'detail' | 'activity' |
    'workbench' | 结果tab(值=导出 publicId)` 组件态——**不写 URL**。
- **会话子锚**（`src/lib/agentApi/sessionRoute.svelte.ts` + `store.svelte.ts`，已有）：
  `#/t/{id}`（选中镜像 replaceState / 反向派发）、`#/new`（composer）——本仓唯一已
  URL 化的页面态，双向同步编排成熟（选中→hash 镜像不进栈；hash→选中派发不回写）。
- **admin 四区**（accounts/resources/kb/settings）：已路由（AdminPage 侧栏走 navigate）。
- **设置面**：ModelsSettingsDialog（admin 专属抽屉）/ SettingsDialog（BYOK，随开发旗标）
  ——弹窗瞬态，无路由（维持）。

### 0.2 全仓 pushState/replaceState 清单（grep 复核：37 处字面命中，真实调用点 4 处）

| # | 位置 | 调用 | 形态 | 读回逻辑 | 归置 |
|---|------|------|------|----------|------|
| 1 | `sessionRoute.svelte.ts:55` | `history.pushState` | composer 创建成功叠 `#/t/{id}` 锚 | hashchange/popstate 反向派发（startSessionRouteSync） | 收编 router.writeHash(push) |
| 2 | `sessionRoute.svelte.ts:56` | `history.replaceState` | 选中会话镜像 `#/t/{id}`（防历史污染） | 同上 | 收编 router.writeHash(replace) |
| 3 | `urlFlags.ts:18` | `history.replaceState` | `?api=rpc`/`?workbenches=1` 引导后清 query（保 hash） | 无（一次性引导，localStorage 持久） | 收编 router.stripSearchParams |
| 4 | `demoDelay.svelte.ts:50` | `history.replaceState` | `?demoDelay=` 清 query——**bug：写成 pathname 丢 hash** | 无（sessionStorage 持久） | 收编 router.stripSearchParams（顺修丢 hash） |

其余 33 处命中 = 测试 spy/夹具（19）与注释文档（14），非调用点。`location.hash =` 赋值
散布 4 处（router.navigate/resetRouterForTests、sessionRoute 降级 fallback/reset）——
一并收编进 router 单文件。

### 0.3 admin 区与 studio 区边界

- `#/login`/`#/admin/*` = 独立壳（无前台顶栏）；前台壳 = home 路由专属。
- 本批路由改造只在 **home 路由内部**扩展视图段；login/admin 语义零改。
- 会话锚只在 home 的 **agent 视图**下有意义（writeSessionHash 增加 view 门——studio
  路由下不镜像、不派发，切回 agent 时由视图镜像从 store 补 session 段）。

### 0.4 既有 URL 消费面（兼容红线）

- `#/t/{id}`：8317 既有书签/分享（裸 `#/` = 默认最新会话）——形状与语义零改。
- `#/new`：composer 深链——零改。
- `?api=rpc` / `?workbenches=1` / `?demoDelay=`：boot 期 query 引导，与 hash 正交——
  保留（demoDelay 修为清参不丢 hash）。
- daemon 静态托管：纯 hash 路由零服务端配置——选型约束（见 §1）。

## 1. 路由模型选型：hash 路由（延续既有形态）

proposal 建议「若无既有形态推荐 history+path」——勘察结论是**既有形态强且成体系**：
全部 4 个真实调用点写的都是 hash/清 query；`#/t/{id}` 已是外部可依赖深链面（8317
书签）；daemon 静态托管零配置是本仓既有架构裁决（router.svelte.ts 头注）。history+path
需要服务端 fallback 重写，违反 proposal「不改后端路由」的不做条款。**选 hash**。

## 2. 路由表（终态）

| hash | Route（判别联合字段） | 视图态 |
|------|----------------------|--------|
| `#/` | home · view=agent | Agent 主面（默认最新会话） |
| `#/new` | home · view=agent · composer | Agent 新建态（中栏 composer） |
| `#/t/{sessionId}` | home · view=agent · session | 会话详情（详情 tab 缺省） |
| `#/t/{sessionId}/activity` | … · taskTab=activity | 任务详情面板·活动 tab |
| `#/t/{sessionId}/workbench` | … · taskTab=workbench | 任务详情面板·工作台 tab（embedded） |
| `#/t/{sessionId}/r/{publicId}` | … · taskTab=result · taskResultId | 任务详情面板·结果 tab（iframe 分享页） |
| `#/studio` | home · view=studio | 排钻工作台·模式选择 |
| `#/studio/engine` | home · view=studio · studioEngine | 引擎实验（旧排钻面板） |
| `#/studio/task/{taskId}` | home · view=studio · studioTask | 任务详情工作台（完整形态） |
| `#/assets` `#/stones` `#/warehouse` `#/lab` `#/strategy` `#/edit` | home · view=… | 开发面（随 handicraft.dev.workbenches 旗标；无旗标深链回退 `#/`） |
| `#/login` | login | 登录页（零改） |
| `#/admin/{accounts\|resources\|kb\|settings}` | admin · tab | 后台四区（零改） |

- 「工作台」双义消解：顶栏 tab「排钻工作台」= `#/studio`；Agent 面板内「工作台 tab」=
  `#/t/{id}/workbench`（紧凑形态）；「完整工作台」= `#/studio/task/{taskId}`。
- 解析容错：未知段回落（`#/studio/foo` → `#/studio`；`#/t/{id}` 尾段非法忽略）。
- **不进 URL 的瞬态**（proposal 边界规范）：设置抽屉/Lightbox/移动详情 Sheet 开合、
  工作台 rail Drawer 开合与断点态、混合滑杆、图层选中/笔刷、composer 表单草稿、
  handoff/openIntent 瞬时信号（消费即清）。

## 3. 双向同步模型（沿用 sessionRoute 成熟模式，扩为两段分区）

```
用户动作/UI 选中（程序向）          浏览器回退/前进/深链/手改（URL 向）
  状态先行（同步写 $state）           hashchange/popstate
  → hash 镜像（router.writeHash）     → parse → 反向派发写 $state（不回写）
     · 显式导航 push（进栈可回退）        · view 段 → startViewRouteSync（view store）
     · 自动镜像 replace（防历史污染）     · session 段 → startSessionRouteSync（既有）
```

- **状态先行**：所有 store 写函数同步改 $state 再镜像——既有调用方（60+ 测试与组件）
  零迁移；镜像事件不回派（调用方状态已是真源，hashchange 只在真 URL 事件时触发）。
- **分区监听**：view 段（view/studioTask/studioEngine/taskTab/taskResultId）归
  `view.svelte.ts`（新增 startViewRouteSync）；session 段（session/composer）归
  sessionRoute（既有）。同一 hashchange 两监听器各写各字段，互不覆盖。
- **跨段格式化**：视图镜像进入 agent 视图时需补 session 段——经 provider 注入
  （`bindViewRouteSessionSource`，initAgentStore 绑定 getActiveSessionId + composer 态），
  避免 view ↔ agentApi/store 静态环（store 不导入 view、view 不导入 store）。
- **push/replace 语义**：tab 切换/openStudioTask/openTaskTab/引擎进退=push（回退还
  原）；选中会话镜像/closeStudioTask/导出消失回退 detail/旗标回退重定向=replace。
- **镜像保留规则**：同会话镜像保留 taskTab 段（深链 `#/t/s1/workbench` init 对齐不
  被镜像剥段）；换会话镜像剥 taskTab 段（任务切换回详情——面板既有语义）。

## 4. history 调用收编（router 单出口）

`router.svelte.ts` 新增内部执行器（全仓唯一 history 调用点，白名单文件）：

- `writeHash(hash, {push?})`：pushState/replaceState + 即时同步 `router.route`（修既有
  stale-route 微瑕）+ jsdom History-impl 异常降级 `location.hash` 赋值（sessionRoute
  既有降级语义上移）。
- `stripSearchParams(names)`：boot 期清 query（保 hash）——urlFlags/demoDelay 改用。
- `navigate(to, {replace?})`：缺省 `location.hash` 赋值（自然 push+hashchange，语义
  零改）；replace 走 writeHash。

sessionRoute.writeSessionHash / urlFlags / demoDelay 全部改走上述出口；守卫测试
（§6）以正则断言 src 内（排除 tests/ 与 router.svelte.ts）零直接调用。

## 5. 落点清单（文件面）

| 文件 | 改动 |
|------|------|
| `src/lib/router.svelte.ts` | Route 扩 view/session/tab 字段；parseHash/routeHash 全表；writeHash/stripSearchParams 执行器；ViewId/TaskTab 类型源 |
| `src/lib/stores/view.svelte.ts` | 保留 API（getView/setView/openStudioTask/closeStudioTask）+ 新增 getStudioMode/setStudioMode、getTaskTab/openTaskTab、startViewRouteSync、bindViewRouteSessionSource；镜像走 router |
| `src/lib/agentApi/sessionRoute.svelte.ts` | writeSessionHash 改走 writeHash + view 门 + 同会话保留 tab 段；reset 委托 router |
| `src/lib/agentApi/store.svelte.ts` | initAgentStore 绑定 view 路由 session provider（+composer 态 getter 复用既有 isComposerActive 若无则内联读） |
| `src/lib/agentApi/demoDelay.svelte.ts` | replaceState → stripSearchParams（修丢 hash） |
| `src/lib/stores/urlFlags.ts` | replaceState → stripSearchParams |
| `src/App.svelte` | startViewRouteSync() 启动；无旗标深链回退 $effect（dev 视图 → replace `#/`）；Tabs value 用回退安全视图 |
| `src/lib/components/views/StudioView.svelte` | studioMode 组件态 → view store（进/出引擎实验=路由导航） |
| `src/lib/components/agent/TaskDetailPanel.svelte` | active 本地态 → view store taskTab/taskResultId（tab 切换/导出行/关闭钮=路由导航）；workbenchOpened 保活态保留本地 |
| `src/lib/components/studio/taskWorkbench/TaskWorkbenchView.svelte` | onBack 语义保持（closeStudioTask+openSession+setView——镜像序自然收口 `#/t/{id}`） |
| 测试 | router.test.ts 扩表；新增 routing/viewRoute.test.ts（同步矩阵）+ routing/appUrlSync.test.ts（App 级 jsdom）+ routing/historyGuard.test.ts（收编守卫）；受影响既有测试按新 URL 断言微调 |

## 6. 验证设计

1. **parse/format 往返**：全路由表 × routeHash(parseHash(h))≡h（规范形）+ 非法回落矩阵。
2. **App 级 jsdom**：顶栏切「排钻工作台」→ hash `#/studio`；引擎实验进入 → `#/studio/engine`；
   openStudioTask → `#/studio/task/{id}`；刷新还原（重挂载 App 同 hash → 同视图）；
   history.back → 回上一视图态；任务详情面板 tab 切换 → `#/t/{id}/workbench|r/{pid}`。
3. **收编守卫**：src 内（排除 tests/、router.svelte.ts）`\.(pushState|replaceState)\s*\(`
   与 `location\.hash\s*=[^=]` 归零（fs 扫描断言）。
4. **既有面回归**：sessionRoute.test / newTaskComposer.test / autoApproveToggle /
   taskDetailTabs / appRouting / app.smoke / studio/* / workbench/* 全绿；`pnpm check` 0 错。
5. mock api 模式判定（?api=rpc）与 workbenches 旗标引导——urlFlags 行为等价（清参保 hash）。
