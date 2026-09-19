<!--
Orthogonal intents (max 5):
1. [2026-09-20 Owner 并行裁决，design §0.1] 四轨并行 DAG：
     1.x（改名批 R）/ 2.x（架构轨 A：store 拆非图层域）/ 3.x（组件轨 C：UI 骨架与交互）/
     4.x（service 轨 S：接口+内存 mock）——四轨零相互依赖、零 v2 契约消费，可并行（代理上限 2）
       -> 5.x（依赖轨 D：逐钻微调/规格选择器/校准向导/笔刷算法/pairwise 消费/真源切换/物理读数；
            5.9 handoff/gemdoc payload v2 消费接线——硬前置 = studio-layers replay/handoff gate）
            硬前置 = add-gem-catalog-and-sizes W0（0.x）+ engine gate（1.2 exportGate / 1.4 EditGemFields）
            + 2.x .gemshape 资产化（5.3/5.4/5.6）；5.7/5.9 另需 studio-layers replay/handoff gate 贯通
       -> 6.x（收尾：全量绿门 + 评审 + 归档候选）
   约束：全量 pnpm test/check/build 绿门串行执行；A 轨零行为变化（公共 API 面不变 + 同参快照）；
   架构轨不碰 studio-layers 重写域（图层/历史/计算队列）与 handoff/gemdoc payload 符号
   （owner = studio-layers replay/handoff gate——A 轨涉 payload 文件只做搬移 + re-export 薄 wrapper，
   design §2.2 ownership 交接表，R3 P0 修复冻结）。
2. [2026-09-19 Contract] 「送精修」动作文案与 .gemdoc/精修项目命名不改（已生效工作默认，
   专家稿 §B.1 / gemspec R1 议题 11）；「贴钻工作台」app 名不改。
3. [2026-09-20 Data] 钻目录真源 = 入库口径：内置形以 .gemshape 资产 seed 入 sys-shapes，
   engine 仅留迁移 bootstrap 查表（主会话修订口径，design §0.4）；gemCatalogService W0 前内存 mock
   （SS_TABLE 派生）、W0 后切真源，接口签名不变。
4. [2026-09-19 UX] 专家工作台 = 选中对象属性面板（PS Inspector 语义），编辑器永不长排钻参数面板
   （概念混入禁令沿用）；属性面板规格字段位预留，W0 前不注册形/尺寸/朝向控件。
5. [2026-09-19 Process] 本 change 不做：图层化/排钻设计页生命周期（studio-layers）、实验室高级选项与
   蓝图（add-lab-drill-params-and-blueprint）、尺寸契约本体（add-gem-catalog-and-sizes W0）；
   每步绿门 pnpm test + svelte-check + build；改名批 grep 收据含注释/测试断言/toast/handoff 文案。
-->

## 1. 改名批（R 轨：独立可先行，零依赖）

- [ ] 1.1 导航与用户可见文案：App.svelte 桌面 Tab（:78 转化工作台→排钻设计、:79 手动编辑→专家工作台）+ 移动 Tab（:156 工作台→排钻、:168 手动编辑→专家）；PreviewDialog.svelte:180 送转化→送排钻；gallery.svelte.ts:496 与 lab.svelte.ts:1294 toast「已送入转化工作台」→「已送入排钻设计」；lab.svelte.ts:1285/:1297「送转化失败」→「送排钻失败」；studio.svelte.ts:485「重新送转化」→「重新送排钻」；StudioContextBar.svelte:176 title；StudioStatusBar.svelte:121「已送入手动编辑（烘焙快照，与工作台参数隔离）」→「已送入专家工作台（烘焙快照，与排钻设计参数隔离）」；「送精修」按钮/覆盖确认（StudioStatusBar.svelte:388/:415/:421-427）与 EditView.svelte:609 引导行**不动**；vitest：断言联动后全绿
- [ ] 1.2 注释/头注联动：App.svelte:9/:40/:51、stores/handoff.svelte.ts:2、stores/view.svelte.ts:4-5、stores/toast.svelte.ts:2、stores/studio.svelte.ts:469、views/LabView.svelte:242、views/StudioView.svelte:29/:108 等注释位旧词换新（「送精修」注释语义不动）
- [ ] 1.3 测试断言联动（rg 2026-09-20 实测含旧词的 11 个测试文件）：edit/lifecycle.test.ts、edit/editUnbound.test.ts、app.smoke.test.ts、edit/editReferenceAsset.test.ts、lab/openIntentFlow.test.ts、lab/labAssetIntegration.test.ts、lab/lab.store.test.ts、edit/edit.store.test.ts、studio/studio.interactions.test.ts、studio/pipeline.test.ts、edit/helpers.ts——断言中 Tab 名/toast/引导行同步新词
- [ ] 1.4 TERMS.md 升 v2：词条「手动编辑」→「专家工作台」（定义：钻级编排与精修模块；禁用词：手动编辑、精修编辑器）；新增词条「专家」（移动端短名）；词条「排钻设计」禁用词去「工作台」（独立使用仍不注册——专家稿 §B.1 冲突消解）；头部 v1→v2 版本登记
- [ ] 1.5 PRODUCT_MODEL.md 升 v4：一句话（「手动编辑做钻级精修」→「专家工作台做钻级编排精修」）、对象树两处节点、硬规则 3 措辞、真源表「钻面文档」行使用位置；版本行 v3→v4 登记
- [ ] 1.6 grep 收据验收：rg '转化工作台|送转化' src 零命中；rg '手动编辑' src 零命中（禁用词）；「工作台」残留白名单 = app 名「贴钻工作台」（App.svelte:70）+「专家工作台」合法组合（泛称注释顺带消歧不强制，design §1.4）；TERMS/PRODUCT_MODEL 版本行核对

## 2. 架构轨（A 轨：store 拆非图层域子模块，零行为变化；可与 1/3/4 并行）

> 边界（design §2.2）：不拆 studio-layers 重写域（分块/覆写/色板/五策略布局/进度取消；edit patch/undo/选择/图层显隐）；studio「文档态」无现状不拆（归 studio-layers）；**handoff/gemdoc payload 符号 owner = studio-layers replay/handoff gate——A 轨涉 payload 文件只做搬移 + 根 re-export 薄 wrapper，payload 内容/schema/round-trip 零改动（R3 P0 修复冻结；本 change v2 消费接线归 5.9）**；子模块 $state 宿主纪律（.svelte.ts）；单向依赖禁循环。
>
> 文件级 ownership 表（R3 P0 修复冻结；详版见 design §2.2 交接表）：
>
> | 涉及文件（搬迁后落点） | 符号 | owner | A 轨允许的先行改动 |
> |---|---|---|---|
> | studio.svelte.ts :960-1007 → `studio/editHandoff.svelte.ts` | buildManualEditHandoff / sourceSummary / ManualEditHandoff（类型） | studio-layers replay/handoff gate；本 change 5.9 接线 | 搬移 + 根 re-export 薄 wrapper（payload 零改动） |
> | edit.svelte.ts :208-263 → `edit/gemdocLifecycle.svelte.ts` | loadFromHandoff / pin 编排 | studio-layers replay/handoff gate | 同上（v2 消费零改动） |
> | edit/gemdocLifecycle.svelte.ts（:479-716 域） | EditDocument / gemdoc serialize-parse / round-trip | studio-layers replay/handoff gate；本 change 5.9 接线 | 同上（schema 与 round-trip 零改动） |
>
> 表外符号（imageSource/exportSink/documentStatus）owner = 本 change A 轨；gate 完成前无 payload 第二修改点（2.6 adapter 验收核对）。

- [ ] 2.1 studio.svelte.ts（1091 行）拆 `src/lib/studio/imageSource.svelte.ts`（图像载入域 :349-560：解码/降采样/素材库选择/上传/测试直灌）；公共导出面经 store 根 re-export 兼容
- [ ] 2.2 studio.svelte.ts 拆 `src/lib/studio/exportSink.svelte.ts`（导出编排 :928-959 + PNG 入库 :1008-1044）
- [ ] 2.3 studio.svelte.ts 拆 `src/lib/studio/editHandoff.svelte.ts`（送精修构造 :960-1007：buildManualEditHandoff/sourceSummary）——**仅文件搬移 + store 根 re-export 薄 wrapper：payload 零改动**（buildManualEditHandoff/ManualEditHandoff 的 v2 改写 owner = studio-layers replay/handoff gate；本 change 消费接线归 5.9——R3 P0）
- [ ] 2.4 edit.svelte.ts（752 行）拆 `src/lib/edit/gemdocLifecycle.svelte.ts`（载入 :208-263 + gemdoc 保存/打开/关闭/另存为/导出 :479-716）——**仅文件搬移 + store 根 re-export 薄 wrapper：loadFromHandoff v2 消费、EditDocument/gemdoc schema 与 round-trip 零改动**（owner = studio-layers replay/handoff gate；本 change 消费接线归 5.9——R3 P0）
- [ ] 2.5 edit.svelte.ts 拆 `src/lib/edit/documentStatus.svelte.ts`（dirty/docId/blobKey/lease 状态位 :154-192 相关 + 身份读取器/重命名 :717-733）
- [ ] 2.6 A 轨零行为验收：既有测试全绿**零断言改动**（studio pipeline/interactions、edit lifecycle/undo/quickLayout/store 族）+ 同参快照（quickLayout 同参同出、gemdoc round-trip 字节等价）+ 公共 API 消费面 diff 为零 + pnpm check + **adapter 验收（R3 P0）**：2.3/2.4 搬移后旧 API re-export 编译通过、既有测试零变化、payload 符号（buildManualEditHandoff/loadFromHandoff/ManualEditHandoff/EditDocument）语义面 diff 为零、gate 完成前无 payload 第二修改点（rg/import 面核对）

## 3. 组件轨（C 轨：专家工作台 UI 骨架，不依赖 v2 类型；可与 1/2/4 并行）

- [ ] 3.1 四区布局骨架：工具栏（选择/画钻/擦除 + snap 开关 + ⌘Z/⌘⇧Z）/ 画布 / 属性面板（空态·单选·N 选三态框架）/ 图层面板（现有四层显隐/透明度控件迁入）；桌面四区、移动折叠；状态条画幅读数位**预留不显示假值**（design §3.2/议题 3）；vitest：布局冒烟 + 属性面板无排钻参数面板断言（概念混入禁令）
- [ ] 3.2 选择交互扩展：框选（marquee 手势 + 相交命中 → setSelection，走 edit/spatialIndex.ts，1 万钻 60fps 基线内）+ Shift 点选加选/减选（toggleSelection :330）+ Esc 清空 + N 选计数反馈；vitest：pointer 序列（点选/加选/框选/清空）+ 命中正确性
- [ ] 3.3 笔刷手势层原型：工具分派层（现状 pointer :520-523 仅平移/点选）；画钻/擦除起笔-move-收笔手势；笔刷光标预览；吸附格位高亮（现行 GridSpec pitch 临时格）；snap 开关（格位/自由）；产出「笔刷意图流」抽象（落点序列+工具+snap 态，算法接口预埋——落钻行为归 5.5）；vitest：意图流形状 + 手势起收组（beginStroke :445/endStroke :451）
- [ ] 3.4 属性面板字段框架：字段描述符（key/label/控件/读写器/undo 组策略）→ 控件渲染；值写入统一 update patch、N 选批量 = 单 undo 组；改色字段先行（EditGemFields 现状 x/y/colorId，edit.svelte.ts:126）；形状/尺寸/朝向**控件位预留不注册**（5.1）；vitest：三态显示 + 批量改色单组 undo + 混合值占位
- [ ] 3.5 nudge 与对齐分布（〔裁断归本轨〕零 v2 依赖，design §3.6）：方向键 1px / Shift=pitch 步进 / Alt=0.1mm；按键会话合组 undo（keydown 起至 500ms 无新按键）；对齐六式（≥2）/ 等距分布（≥3）；vitest：三档步进值 + 会话合组 + 对齐分布几何断言 + 批量单组
- [ ] 3.6 C 轨验收：jsdom pointer/keyboard 全序列 + 1 万钻选择/框选性能抽查（60fps）+ pnpm check

## 4. service 轨（S 轨：前端 service 封装层；可与 1/2/3 并行）

- [ ] 4.1 `src/lib/services/gemCatalogService.ts`：`GemCatalogService` 接口（listSpecs/resolveSpec）+ 本地最小 `CatalogSpec` 结构类型 + 内存 mock（round × SS_KEYS 十二档自 SS_TABLE engine/grid.ts:11 派生；specKey 确定性生成 'round-ssXX'）；vitest：mock 确定性/幂等/未知 specKey 返回 undefined
- [ ] 4.2 `src/lib/services/documentService.ts`：openFromLibrary/save/saveAs/exportGemdoc/exportSvg/Bom/Png 编排（依赖注入 edit store 状态面 + persistence + assetStore；守卫信号返回不弹窗）；收敛 StudioStatusBar/EditView 内联编排为 service 调用；**不复制 handoff/document payload（ManualEditHandoff/EditDocument 的构造与解析真源恒在 edit store 与 replay gate owner——R3 非阻塞建议 2，design §4.3 声明）**；vitest：编排成功/CAS conflict/parse 失败/lease 过期失败注入 + 无 payload 第二实现断言（payload 构造与解析只经 store/replay gate owner 既有 API）
- [ ] 4.3 `src/lib/services/generationService.ts`：仅 interface 骨架 + 归属注释（生命周期契约由 add-lab-drill-params-and-blueprint 冻结；禁止预填字段——design §4.4）；vitest：仅类型编译
- [ ] 4.4 S 轨验收：service 无 UI 依赖断言（import 面检查）+ mock 单测全绿 + 切换点预埋登记（真源切换归 5.6）

## 5. 依赖轨（D 轨：排后；硬前置逐条标注）

- [ ] 5.1 属性面板规格字段注册【硬前置：add-gem-catalog W0 0.1 + engine gate 1.4（EditGemFields 扩展 shapeId/diameterMm/rotationDeg）】：形状/尺寸/朝向三字段控件注册进 3.4 框架；改尺寸后立即 pairwise 重校验（实时警告不阻断——消费 1.2 混合径 validateEditable）；批量 = 单 undo 组；vitest：字段 round-trip（改形/改径/旋转 → 序列化回读）+ 改径触发重校验
- [ ] 5.2 保存/导出 pairwise warning 消费【硬前置：engine gate 1.2 exportGate】：保存允许 warning（文档可存+徽标）、导出硬阻断（违规清单 UI）；load 后与改径/改形后立即重算 warning——专家稿 §I.3-2 放行条件原文义务；vitest：保存放行/导出阻断/重算时机三态
- [ ] 5.3 规格选择器【硬前置：W0 + 2.x sys-shapes seed】：顶部「当前 spec」选择器（形/尺寸下拉 + 色板色——专家稿 §B.3）；数据源 = gemCatalogService；vitest：选择态驱动笔刷当前 spec + 列表来自 service
- [ ] 5.4 自定义钻形校准向导 UI【硬前置：W0 0.4 schema gate 六条 + 2.2 面 8 校准数据面】：三步向导（选贴图 → 物理尺寸 direct/reference 二选一（reference 模式叠参考钻轮廓预览）→ 命名入库）；烘焙校准语义（calibration 只记出处）；typed 错误 UI 呈现（超限/比例漂移/悬空 ref）；vitest：direct/reference 两模式物化 physical + 参考钻后续改动不影响已入库（烘焙）
- [ ] 5.5 笔刷算法落地【硬前置：W0 + 1.4】：画钻 = 当前 spec 物化（shapeId/diameterMm/colorId，origin='manual'）；吸附六方格位 = 当前 spec pitch 格位；冲突拒画闪红（pairwise 判据）；擦除命中删除；消费 3.3 意图流；vitest：物化字段断言 + 格心落位 + 拒画条件 + stroke 组 undo
- [ ] 5.6 gemCatalogService 真源切换【硬前置：2.x sys-shapes seed 落地】：mock → sys-shapes .gemshape 资产（含内置形入库 seed——入库口径 design §0.4）；engine 迁移 bootstrap 查表仅兜旧档；vitest：切换点等价（同 specKey 解析一致）+ mock 退役为测试夹具
- [ ] 5.7 画幅物理读数接线【硬前置：studio-layers replay/handoff gate 贯通 PhysicalCanvas】：状态条读数位接真值（画幅 mm + px/mm；anchorSource 区分 declared/default 显示）；vitest：declared/default 两态读数 + 降采样锚不变量（消费端呈现）
- [ ] 5.8 D 轨验收：上述全部 vitest 面 + 消费端到端（选 spec → 笔刷落钻 → 属性面板改径 → 警告 → 保存放行/导出阻断）jsdom 走查
- [ ] 5.9 handoff/gemdoc payload v2 消费接线【硬前置：studio-layers replay/handoff gate 验收完成（③ 段 gate；非本仓编号）——R3 P0 修复新增切片】：buildManualEditHandoff v2 payload 消费（各层 concat、逐钻 GemSpecSnapshot、PhysicalCanvas——按 gate 冻结契约）/ loadFromHandoff v2 消费 / EditDocument·gemdoc schema 与 round-trip 接线；落点 = A 轨 2.3/2.4 搬移出的 `editHandoff.svelte.ts`/`gemdocLifecycle.svelte.ts`（payload 首个修改点，此前 A 轨只维护薄 wrapper）；vitest：逐层 handoff identity + round-trip（沿 gate 验收口径）+ 无双写路径断言（rg/import 面：payload 构造唯一入口）

## 6. 收尾 gate

- [ ] 6.1 全量绿门：pnpm test / pnpm check / pnpm build 串行全绿；改名 grep 收据复跑（§1.6 口径）
- [ ] 6.2 Codex 评审 → 修订 → 归档候选；归档时 spec 同步登记：add-manual-edit-mode §3 画钻笔刷行的覆盖承接（专家稿 §B.4 归档注记要求——本 change 落地「当前 spec + snap 可关」后，由本 change spec 同步承接登记，防 design 与 spec 分叉）
