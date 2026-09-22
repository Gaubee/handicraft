<!--
DAG（切片间依赖；并行上限 2）：
  0 改名 → 1 架构骨架+文档v3 → 2 画布交互核 → {3 笔刷/规格 ∥ 4 图层面板+合并}（可并行，上限 2）
  → 5 文档流+入口 → 6 键位+右键 → 7 智能排布 → 8 移动端 → 9 收尾绿门
Orthogonal intents (max 5):
1. [2026-09-21 Owner] 定调（逐钻微调设计台/贴 PS/竖排工具栏）+ 七裁决（proposal §What）；
   design §1-§7 为执行规范；〔裁断〕项可推翻但需回 Owner/主会话确认后改 design 再改码。
2. [域纪律] 独占 src/components/Designer/**、src/lib/designer/**、src/components/Edit/**（退役/迁移）、
   src/lib/components/views/EditView.svelte→DesignerView、src/lib/stores/edit.svelte.ts、
   src/lib/edit/quickLayout.ts 与 src/lib/edit/gemdocLifecycle.svelte.ts（演进面，design §7.1-②）、
   src/App.svelte（Tab+路由）、tests/designer/**；
   禁改 src/lib/engine/**（全程零行）、src/lib/persistence/**（唯一例外：src/lib/persistence/projectFile.ts
   的 gemdoc v3 schema/迁移，1.2 开窗——R1-P0-1 裁决）、src/lib/services/**（唯一例外：
   src/lib/services/documentService.ts 新增 projectVisibleGems 可见层投影，4.3 开窗——R1-P0-2 裁决）、
   components/Studio|Lab|Assets/**
   （校准向导只接线调用方，不改其文件）；R0 解禁 rhinestone-studio/TERMS.md 与
   rhinestone-studio/PRODUCT_MODEL.md（本 change 承载升版；实路径以 rhinestone-studio/ 为根）。
3. [切片纪律] 每切片：聚焦 solo 测试（pnpm exec vitest run <file>）→ git commit 显式路径（repo 根发起，
   禁 amend，脏文件 30s 重试）；不跑全量；不起 dev server；不跑 dev 进程。
4. [护栏纪律] engine 字节级不动（git diff --stat src/lib/engine 零行）；persistence/services 例外仅
   projectFile.ts（1.2）与 documentService.ts（4.3）两开窗文件且限于声明改动（R1-P0-1/R1-P0-2）；
   quickLayout 计算内核与冻结参数不动
   （仅扩 API）；edit 族既有断言因 schema v3 演进需更新 = 显式更新（commit 收据注明），不得静默删测试。
5. [术语纪律] 全程用「设计师工作台」（移动短名「设计」）「智能排布」「参考底层」「钻石层」；
   禁用词：专家工作台、手动编辑、快速排稿（R0 改齐后 grep 清零，注释/测试断言同口径）。
-->

## 0. R0 改名：专家工作台 → 设计师工作台（独立先行，零功能依赖）

- [x] 0.1 代码面改齐：App.svelte 桌面 Tab「专家工作台」→「设计师工作台」（:173）+ 移动短名「专家」→「设计」（:287）+ openIntent 注释/toast/引导行/tests 断言全库 grep（design §7.4 收据口径）；grep 收据：`rg '专家工作台|手动编辑|快速排稿' src` 零命中（ TERMS/PM 除外）；vitest：solo app.smoke.test.ts + edit 交接面
- [x] 0.2 TERMS v4→v5 + PRODUCT_MODEL v5→v6 升版（文件实路径 rhinestone-studio/TERMS.md、rhinestone-studio/PRODUCT_MODEL.md；TERMS 已被先行占位 change 升至 v4（2026-09-20「参考图→原图」），本 R0 为追加词条再升 v5——非阻塞④）：词条改名（含移动短名「设计」）+「快速排稿→智能排布」更名与禁用映射 + 新增词条「参考底层/钻石层」+ 硬规则 6（智能排布参数小窗修订口径，design §5.3）与硬规则 9（隐藏层导出分模块口径，design §4.4）修订登记 + 版本行；若主会话仍未落档 improve-paving 的「排钻工作台」词条升版，本任务一并改齐（同一 PR 消除双真源窗口）；vitest：solo docs/modelDocs.test.ts（断言随升版显式更新）

## 1. 架构骨架 + 文档模型 v3（依赖 0）

- [x] 1.1 edit store schema v2→v3：LayerState 固定四层 → GemLayerRecord[]（id/name/visible/locked/**可选 opacity 缺省 1.0**，数组序=z 序）+ ReferenceUnderlay（sources[]：每源 {key, visible, opacity} 独立——R1-P0-3）+ **DesignerGem**（= engine EditGem + layerId，store/persistence 域扩展类型；engine 公共 EditGem 与 fromEditGem/toEditGem 零改动——R1-P0-4）；patch 面/undo 组/selection API 语义保留（design §4.1/§7.1-②）；vitest：solo tests/edit/edit.store.test.ts（v3 模型断言 + layerId 生命周期断言：新增/更新/复制（副本 origin='manual'·blockId=null·moved 重置·归当前目标层）/合并/移入/迁移，design §4.1 生命周期表逐行 + 既有断言显式更新清单）
- [x] 1.2 旧档装载迁移 + v3 序列化（**owner = projectFile.ts gemdoc v3 schema/迁移——persistence 例外开窗，R1-P0-1**；唯一序列化出口地位不变，复用既有迁移链注册与向前拒读版本门）：loadFromGemdoc v2 装载 → 内存迁移（gems→「图层 1」+ 旧四层逐字段映射 design §5.5 表：painting/reference/blocks→underlay 三源各 {visible,opacity} 原值、gems 层 visible/opacity→新钻层原值——R1-P0-3）+ 保存即 v3（formatVersion=3 单向版本门，v2 不回写）+ 升档 toast 文案；vitest：solo tests/edit/gemdocV3Migration.test.ts（**验收门四条**：v2 fixture 打开→内存 v3→保存 formatVersion=3→重开等价 / v2 不回写 / serialize→parse→serialize 字节等价 / projectFile 迁移+未知高版本拒读测试；另：四种旧层独立显隐/透明组合迁移等价断言 + v3 round-trip 无未声明漂移）
- [x] 1.3 四区骨架：src/components/Designer/（DesignerView/DesignerToolbar 竖排/DesignerCanvas 槽/DesignerPropertiesPanel/DesignerLayersPanel/DesignerDocBar/DesignerStatusBar）+ src/lib/designer/workbench.svelte.ts（工具/吸附/当前层/指针读数真源）+ App 路由接线；空态引导页占位（入口在 5.x 落）；桌面布局冒烟 + 响应式断点骨架；vitest：solo tests/designer/layout.test.ts

## 2. 画布交互核（依赖 1；选择/移动/手柄/平移缩放）

- [x] 2.1 lib/designer/gestures.ts + DesignerCanvas：P1-P5（单选/Shift 加选/框选跳锁定层/拖移预览-松手单 patch/Shift 轴约束/Alt 拖拽复制 id 自增）+ 命中走 spatialIndex；vitest：solo tests/designer/gestures.select.test.ts（jsdom 指针序列，design §2 逐行）
- [x] 2.2 变换手柄：TransformHandles（旋转柄非 round 才显/四直径柄连续改径 mm 读数气泡/Shift 15° 步进）+ 三通道写同一 update patch 面（design §2.1）；vitest：solo tests/designer/transformHandles.test.ts
- [x] 2.3 视图导航：滚轮光标锚缩放（10%-1600%）+ 空格/中键平移 + H 抓手/Z 缩放工具（拖框放大/Alt 点击缩小）+ 双击空白 100%⇄适配（P9-P12）；vitest：solo tests/designer/viewport.test.ts

## 3. 笔刷与规格（依赖 2；可与 4 并行——并行上限 2）

- [x] 3.1 brushEngine 迁移 + 改造：lib/designer/ 承接（物化带 layerId/origin='manual'；custom 形判据改「必带 assetId」替换内置五形白名单，design §6.2——**条件项随判据同落**：asset resolver（assetId→sys-shapes 资产解析）+ 物化携带 assetId + missing-asset 拒画/报错测试，不得只放宽 UI 判据；冲突拒画/等弧长补钻内核不动）+ 橡皮跳过锁定与隐藏层钻；vitest：solo tests/designer/brush.test.ts（含 custom 三件套断言：resolver/物化 assetId/missing-asset）
- [x] 3.2 规格选择器 + 当前规格跟随：形×档×色（gemCatalogService 零改动消费）写 brushSpec 真源 + 选中钻时 = 批量改规格（单 undo 组）+ hexSnap 吸附随规格 pitch 重算（格位/自由开关语义 design §6.1）；vitest：solo tests/designer/specSelector.test.ts
- [x] 3.3 校准向导接线：规格选择器「+ 自定义形…」→ CalibrationWizard（文件原地不动，只接调用方）；vitest：solo tests/assets/gemshapeDialogs.test.ts 回归

## 4. 图层面板 + 合并（依赖 2；可与 3 并行——并行上限 2）

- [x] 4.1 DesignerLayersPanel：参考底层钉底行展开三源行（每源独立眼睛 + 透明度滑杆，R1-P0-3；聚合眼睛 = 派生 AND，点击全开/全关）+ 钻石层行（P15-P17：选层/双击重命名/眼睛/锁/Alt 孤立显示/拖排 z 序）+ 新建/删除（含钻数确认弹窗；末层保底）；vitest：solo tests/designer/layersPanel.test.ts
- [x] 4.2 层操作命令：合并（⌘E 向下合并 + 面板指定目标层，规格混合共存，单 op 撤销）/ 排序 op / 成组移动归属不变 / 移入图层（吸取排钻移入 BUG 教训：标签标当前层 + 禁用态按真实归属 + 单 op，design §4.3 表）；vitest：solo tests/designer/layerOps.test.ts
- [x] 4.3 隐藏层口径（**owner = documentService 新增 projectVisibleGems(doc) 可见层投影——services 例外开窗，R1-P0-2**：按层 visible 过滤，锁定≠隐藏不参与过滤，为 SVG/BOM/PNG/preflight gate 唯一钻集来源；engine exportGate 零改动——契约=调用方钻集，分叉在调用方）：渲染跳过 + 状态栏「含 N 隐藏」+ 导出确认「不含 N 个隐藏层」（显式裁剪，design §4.4）；vitest：solo tests/designer/hiddenLayerExport.test.ts（**验收门五条**：隐藏一层后三导出均不含该层 / 状态栏仍显总量+隐藏数 / 取消确认零产物 / 可见层 spacing·missing 走同一 gate / 直接调用 export API 不能绕过裁剪）

## 5. 文档流 + 入口（依赖 1+4）

- [x] 5.1 空态三入口：选图新建（主，画布=参考底图+0 颗钻，**绝不动算法**）/ 空白新建（缺省 200×200mm）/ 打开（.gemdoc 迁移 + .gemproj 重放 gemprojReplay 复用）+ 最近列表；旧「快速排稿」入口退役（EditView startQuickLayout 路径删除）；vitest：solo tests/designer/entryFlow.test.ts（选图后钻数=0 断言——纠偏 scenario）
- [x] 5.2 画幅锚定 + 状态栏：选图 default 锚（÷2.5 px/mm，anchorSource 显式）+ 画幅读数点击 popover（宽/高 mm/px_mm/锚来源，改 declared）+ 缩放比/钻数/规格码/间距徽标（design §1.2 底栏规格）；vitest：solo tests/designer/canvasPopover.test.ts
- [x] 5.3 保存/另存/守卫装配：gemdocLifecycle 复用（装载迁移钩子已随 1.2 落；守卫/lease/换绑语义不动）+ documentService 走 4.3 投影面（除投影外导出编排零改动）+ DesignerDocBar 装配（⌘S/⌘⇧S/守卫三分法/未保存徽标）；vitest：solo tests/edit/lifecycle.test.ts 回归（零断言改动收据）

## 6. 键位 + 右键（依赖 2-5；命令总线收口）

- [x] 6.1 lib/designer/keymap.ts + commands.ts 命令总线：design §3 全表（工具/编辑/变换微移含 [ ] 旋转/视图导航含 Tab 折叠/图层操作/文档）三入口同源（键位/菜单/按钮同命令）；nudge 三档与 isEditableTarget 语义随迁保留；vitest：solo tests/designer/keymap.test.ts（全键位矩阵 + 表单聚焦放行）
- [x] 6.2 右键上下文菜单：P13/P14 两态树（复制/剪切/粘贴原位偏移/删除确认/对齐分布（≥2/≥3 动态显隐）/移入图层/改规格；空态：粘贴/智能排布…/画幅/适配/100%）；alignDistribute 纯函数迁移复用；vitest：solo tests/designer/contextMenu.test.ts
- [x] 6.3 键位帮助面板：「?」键 + 顶栏按钮 → 单页速查（design §3.7）；vitest：solo tests/designer/shortcutsHelp.test.ts

## 7. 智能排布工具（依赖 5；原快速排稿工具化）

- [x] 7.1 quickLayout API 扩展：产物模式「整文档 handoff」→「钻数组（EditGem[] 规格物化）」（计算内核/冻结参数/进度取消不动——design §7.1-② 护栏）；vitest：solo tests/edit/quickLayout.test.ts 扩展（同参同出快照保留 + 钻数组模式断言）〔superseded by rework-designer-manual-rhinestone R1——UI 退役，内核保留 add-designer-selection-paths 复用 2026-09-21〕
- [x] 7.2 SmartLayoutPanel + 落点：顶栏「智能排布…」（无参考底图禁用+tooltip）/ 参数小窗（策略×规格×gap×密度）/ 结果落当前层单 undo 组 / 冲突钻丢弃+结果行报数（显式不静默，design §5.3）；vitest：solo tests/designer/smartLayout.test.ts〔superseded by rework-designer-manual-rhinestone R1——UI 退役，内核保留 add-designer-selection-paths 复用 2026-09-21〕

## 8. 移动端降级（依赖 6）

- [x] 8.1 底部工具条 + 抽屉面板 + 触摸手势映射（单指工具/双指捏合缩放平移/长按=菜单；design §1.4）；布局断点 + 顶栏第二行读数；vitest：solo tests/designer/mobile.test.ts（断点冒烟 + 手势映射决策函数）

## 9. 收尾绿门（依赖 0-8 全部）

- [x] 9.1 回归：tests/designer 全族 + tests/edit 全族（既有 workbench.*.test.ts 11 件随交互层迁移重组到 tests/designer/**，断言语义随迁显式更新——语义不变者零改动、模型演进者逐条注明）+ app.smoke/globalImport + assets 校准面 + `pnpm check` 0 错；护栏收据：git diff --stat src/lib/engine 零行 + **persistence/services 例外开窗清单口径**（仅 projectFile.ts 与 documentService.ts 有 diff，且限于 R1-P0-1/R1-P0-2 声明改动，其余文件零行）+ engine 族测试零改动 + quickLayout 同参快照 + documentService/gemdocLifecycle 既有测试零断言变化（新增断言独立成新测试文件）；grep 收据（§0.1 禁用词清零 + 退役清单 `rg -l "components/Edit" src` 归零（校准两文件除外））
- [x] 9.2 走查与评审：design §2 指针清单/§3 键位/§4 图层语义逐行人工走查（journey-first 全链）+ 记分卡自评（coherence/journey/IA/state ≥7）+ 发布会截图测试自评；偏离清单与〔裁断〕确认单回报 Owner/主会话；P2 登记项落档（多选缩放/吸管/游标跳转）〔2026-09-21 勾选：证据 = `openspec/changes/rework-designer-manual-rhinestone/walkthrough-r1.md`（journey-first 全链走查 + coherence/journey/IA/state 四维记分 + 偏离清单全在案）、`walkthrough-r2.md`（回修复验）、`walkthrough-r3.md`（聚焦回归终局 PASS）〕
- [x] 9.2b 〔Owner 指令 2026-09-21〕**vision 子代理真实走查门（Codex 终审前置，硬门）**：全部实现切片+9.1 绿门完成后、Codex 终审之前——主会话起**独立端口** dev server（严禁触碰 Owner 的 5200）+ 种子 fixtures；vision 子代理经真实浏览器全流程走查（设计师四区/笔刷规格/图层操作/导出链/右键与键位/空态三入口；实验室六点反馈面）+ **使用体验反馈报告**（coherence/journey/IA/state 四维 + 问题清单逐条可复现）；问题回修迭代后**重新走查，直至 vision 验收通过**方可进入 Codex 终审；走查截图先过程序化非平凡校验（黑图防线）；server 常驻进程由主会话持有并显式回收〔2026-09-21 勾选：证据 = `openspec/changes/rework-designer-manual-rhinestone/walkthrough-r3.md` 终局裁决 PASS（四轮迭代闭环，过门条件满足、走查门关闭）〕
- [ ] 9.3 真实浏览器验收（非阻塞⑤——jsdom 只证决策核，布局/事件接线以真浏览器走查收据为准）：Owner 重启本地 5200 dev 服务后走查四项——① pointer capture（P5 拖移/P6 旋转/P7 改径会话跨元素不丢焦、Esc 取消）② 原生 contextmenu（P13/P14 两态树定位与命令执行）③ 图层面板拖排（P16 z 序即时生效、SVG/PNG 合成序随之、BOM 行序不变）④ 移动端断点（§1.4 底部工具条/抽屉/双指手势）；走查偏离项登记回报（不静默修）〔非阻塞⑤·Owner 验收项·deferred〕依赖 Owner 重启 5200 后真浏览器走查（pointer capture/contextmenu/拖排/移动断点），不阻塞本 change 交付与归档——任务文本原生即为非阻塞⑤口径
