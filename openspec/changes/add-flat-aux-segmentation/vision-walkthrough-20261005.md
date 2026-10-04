# Vision 双走查（2026-10-05 · 8317 · HEAD 159d72c · 8/8 PASS）

> 交付前浏览器双走查（vision 子代理 · agent-browser · 判读前逐图验非黑 nonzero 0.997-1.0）。
> 截图存档：`/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/final-walk-20261005/`（14 张）。

## A——路由层统一（unify-studio-routing）

| # | 项 | 判定 | 要点 |
|---|---|---|---|
| A1 | 顶栏视图切换→hash 逐项变更 | PASS | 任务视图 `#/t/{id}`、排钻工作台 `#/studio`、引擎实验 `#/studio/engine`、返回还原；顶栏回 Agent tab 还原上次任务 URL（路由记忆）。开发面视图（assets/stones/warehouse/lab 等）随 devWorkbenches 旗标默认隐藏（App.svelte:426——2026-10-02 Owner 裁决），路由段已注册旗标开即用 |
| A2 | 任务详情 tabs→URL/刷新/回退 | PASS | `#/t/{id}` 详情/`/activity`/`/workbench`/`/r/{publicId}` 结果；刷新保持；回退逐项还原选中 tab |
| A3 | 会话深链直开 | PASS | 冷开 `#/t/{id}` 与 `/workbench` 均正确还原视图。**观察（P3 打磨）**：`/workbench` 冷开还原后 URL 归一化剥掉后缀（此刻刷新落详情 tab）——非阻塞，记 backlog |
| A4 | 数据源芯片 | PASS | rpc 入口=「服务器」态，点击切「演示数据」（fixture 会话+MOOK 角标）反向亦通 |
| A5 | 匿名进入 | PASS | 点匿名进入→弹窗关、顶栏「匿名用户」芯片、应用可操作不卡死（54d35ef 修复实证） |

## B——参考图层条目（add-flat-aux-segmentation T6）

| # | 项 | 判定 | 要点 |
|---|---|---|---|
| B1 | 三态条目（image-edit 未配置→应=未生成态） | PASS | 实况「**参考图层 未生成 · 分件用原图**」+挂锁+「重新生成」钮；SPAN 非 treeitem、不在可排钻层集合=结构不可选；转录区含 typed 错 `reference-image-unconfigured` 旁证 |
| B2 | 重新生成→typed 拒 | PASS | 实录文案「发起失败：image-edit 路由未配置（后台模型设置需一条 api=openai-image-edit 且带密钥的路由）——重新生成是外部计费调用，配置后再发起」；未签提案未外呼；autoApprove 会话未被绕过（前置 typed 拒） |
| B3 | 分享包 /r/aXMPb8THHBcP | PASS | 五产物同源 fetch 全 200+魔数正确（png 3.9MB/holes 169KB/numbered 831KB/SVG 2.8MB/BOM UTF-8）；原图/产物双滑杆混合预览像素级生效（产物 0% 显出三天使原图）。**观察（打磨）**：大图懒加载期间短暂 complete:false+滚动重复请求——性能优化空间 |

## 处置

- A3 URL 归一化、B3 懒加载：P3 打磨项入 backlog（非阻塞、不拦交付）。
- A1 开发面旗标门控：既定设计（Owner 2026-10-02 裁决），非路由缺口——unify-studio-routing「所有页面走路由层」承诺成立。
- B1/B2 即 codex-final-r1 终审「没有证明」清单第 5 项（工作台 UI 三态真实浏览器链路）的补充证据，增量复审已采信。
