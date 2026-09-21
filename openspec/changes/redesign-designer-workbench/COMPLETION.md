# COMPLETION — redesign-designer-workbench 交付口径声明（2026-09-21，Codex 终审 P1-2 处置）

> 依据 `openspec/changes/rework-designer-manual-rhinestone/codex-implementation-review.md`（NEEDS-WORK 7.8）P1-2 裁定与本 change tasks.md 9.x 处置。本文件声明本 change 的**交付口径**与**证据边界**，作为归档裁决的输入；不替代任何验收收据。

## 一、交付口径

本 change 按「实现全交付 + 走查门关闭 + Owner 真浏览器验收显式 deferred（非阻塞⑤）」口径宣告完成：

- 切片 0-8 与 9.1 全部勾选在案（tasks.md 既有状态，Codex 终审核对未质疑）。
- 9.2 / 9.2b 本日勾选：证据 = **rework change 目录** `walkthrough-r1.md`（journey-first 全链走查 + 四维记分 + 偏离清单）、`walkthrough-r2.md`（回修后全量重走，收窄）、`walkthrough-r3.md`（四轮迭代闭环，终局裁决 **PASS**，过门条件满足、走查门关闭）。走查门在 rework change 期执行（R5.2 门即本 change 9.2b 的 Owner 指令落点），故证据文件落在该目录。
- 9.3 **不勾**，显式 deferred：见 tasks.md 9.3 行尾注记——〔非阻塞⑤·Owner 验收项·deferred〕依赖 Owner 重启 5200 后真浏览器走查，不阻塞本 change 交付与归档（任务文本原生即为非阻塞⑤口径）。

## 二、已交付面清单

- 0 改名（专家→设计师工作台）+ TERMS/PRODUCT_MODEL 升版；1 架构骨架 + 文档模型 v3（层/三源 underlay/DesignerGem + v2→v3 迁移）；2 画布交互核（选择/框选/拖移复制/变换手柄/视图导航）；3 笔刷与规格（brushEngine 迁移 + custom 形 assetId 判据 + 规格选择器 + 校准接线）；4 图层面板与层操作（三源行/合并/移入 + 4.3 隐藏层投影 documentService 开窗）；5 文档流三入口 + 画幅锚定 + 保存装配；6 键位命令总线 + 右键两态树 + 速查面板；7 智能排布工具化（后由 rework change R1 退役 UI、保留内核）；8 移动端降级；9.1 全族回归绿门（护栏收据在案）。

## 三、证据分层（诚实边界——吸收 Codex 终审「证据分层」节要求）

三层证据**不得合并表述为独立浏览器验收**：

1. **jsdom 决策核（独立可复跑）**：tests/designer 全族 + tests/edit 全族（2026-09-21 全量 2053 passed / 1 skipped / 1 已知负载 flake 复跑绿；`svelte-check` 0 错）。证明的是决策核、调用链与状态回归——jsdom/recording canvas 不能冒充浏览器 E2E。
2. **vision 走查证据（supplied walkthrough evidence）**：rework change `walkthrough-r1/r2/r3.md`——vision 子代理经真实浏览器（独立端口 5210 dev server，主会话持有并回收）全流程走查，截图先过程序化非平凡校验（黑图防线），四轮回修迭代至 r3 终局 PASS（PNG 像素级导出验证、空画幅拦截、重命名聚焦、⌥ 旋转、B15 入口等）。该层是**走查方供给的证据**，非独立复验。
3. **Owner 待验项（deferred，未决）**：9.3 四项——pointer capture / 原生 contextmenu / 图层拖排 z 序 / 移动端断点，待 Owner 重启本地 5200 后真浏览器走查；偏离项登记回报（不静默修）。本层缺席不阻塞交付与归档，但**不得宣称已验**。

## 四、后续处置记录

- Codex 终审 P1-1（blocks 边界跨行索引，PNG 与画布同错）已在本日代码提交修复：`lib/designer/blockOutline.ts` 单源 helper（越界邻居恒非本块 + 显式网格边界守卫），pngRender 与 DesignerCanvas 两消费面收敛同源，满宽/满高/不漂移断言 + PNG/画布消费面各一断言在案。
- 既有债按终审口径不重新打开（重命名预填未全选、seed 平坦剪影、templatesStore 负载 flake、P2-5 图层疑点等）；归档期处置项：`add-manual-edit-mode` 僵尸 change。
