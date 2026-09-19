# 改名联动 + 专家工作台（rename-and-expert-workbench）

## Why

- **Owner 裁决（2026-09-20 原话，本 change 时序总纲）**：「rename-and-expert-workbench 这个理论上是可以做一些同步推进的。组件的开发、service 的开发（前端 service 的封装）、架构的开发等等」——本 change 不必等 add-gem-catalog-and-sizes 的 v2 契约链走完：改名批、架构拆分、不依赖 v2 类型的 UI 骨架、service 封装层四轨并行先行；逐钻规格编辑等消费 W0 类型的部分显式排后（见 What Changes 依赖轨）。
- **改名批是移交债**：add-project-files 5.1（「转化工作台→排钻设计」「送转化→送排钻」全库联动）已移交本 change（`openspec/changes/add-project-files/tasks.md:81-83` 移交注记）；专家稿 §B.1 裁决「手动编辑→专家工作台」（移动端短名「专家」）。现状用户可见命名**新旧混用**：顶级 Tab 仍「转化工作台/手动编辑」（`rhinestone-studio/src/App.svelte:78-79`），而编辑页空态引导已写「去排钻设计送精修」（`rhinestone-studio/src/lib/components/views/EditView.svelte:609`）——引导行指向一个不存在的 Tab 名；移动端 studio Tab 现用泛称「工作台」（`App.svelte:156`），违反 TERMS v1 排钻设计词条的禁用词。
- **架构债（R2 终审非阻塞建议原文）**：「先把 studio.svelte.ts 拆成 layers、history、computeQueue 子模块，避免图层/历史/队列继续堆入单一 `$state` 文件」（`.agents/documents/2026-09-19-studio-layers/codex-review-r2.md` §五）。其中 layers/history/computeQueue 域的宿主拆分按 studio-layers 边界协调；本 change 只拆**与图层无关**的域（载入/导出/handoff/文档态），压缩 studio-layers 落地时的冲突面。现状 `src/lib/stores/studio.svelte.ts` 1091 行、`src/lib/stores/edit.svelte.ts` 752 行。
- **前端无 service 封装层**：组件直连 store 与 persistence（如 StudioStatusBar 的送精修/导出 busy 编排内联，`src/components/Studio/StudioStatusBar.svelte:82-121`）；钻目录概念在源码零存在（`shapeId`/`diameterMm`/`specKey` rg 零命中，add-gem-catalog-and-sizes proposal Why 节实测）。W0 类型落地后，属性面板/规格选择器/笔刷需要一层**可 mock、可切换真源**的消费接口——先行定义接口与内存 mock，W0 后切真源，避免 UI 面二次返工。
- **专家工作台 UI 现状缺口**：EditCanvas 为四层合成 + 缩放平移 + 点选（`src/components/Edit/EditCanvas.svelte` 头注 1-2、点选命中 :263）；无框选/多选/笔刷工具 UI/属性面板（add-manual-edit-mode tasks §5「笔刷编辑闭环」全未落地，其 tasks.md 全未勾选）。patch/stroke/undo 底层机制已在（`edit.svelte.ts:126` EditGemFields、:445/:451 beginStroke/endStroke、:324-337 selection API），缺的是工具层与面板层。

## What Changes

- **改名批（R 轨，独立可先行，零依赖）**：「转化工作台」→「排钻设计」（移动端「排钻」）；「手动编辑」→「专家工作台」（移动端「专家」）；「送转化」→「送排钻」；全库 grep 一次改齐（组件文本/注释/测试断言/toast/handoff 文案）；**「送精修」动作文案不改**（已生效工作默认，专家稿 §B.1 / gemspec R1 议题 11 裁决）；「.gemdoc/精修项目」文件格式名不改；TERMS 升 v2、PRODUCT_MODEL 升 v4（登记为任务）。
- **架构轨（A 轨，并行）**：studio.svelte.ts 拆非图层域子模块（图像载入/导出编排/送精修构造）；edit.svelte.ts 拆 gemdoc 生命周期与文档态子模块；**零行为变化重构**，公共 API 面不变 + 同参快照护栏。
- **组件轨（C 轨，并行，不依赖 v2 类型）**：专家工作台类 PS 四区布局骨架（工具栏/画布/属性面板/图层面板占位）；逐钻选择/框选/多选交互；笔刷交互原型（画钻/擦钻/吸附格位指示的手势层，算法后接）；属性面板字段渲染框架（规格字段位预留，等 W0 类型）。
- **service 轨（S 轨，并行）**：`src/lib/services/` 前端 service 封装层——钻目录 service（`resolveSpec(specKey)`/`listSpecs()`，底层 W0 后接素材库 `.gemshape`/sys-shapes，含内置形入库 seed）；文档 service（打开/保存/导出编排）；生成 service 接口位（实验室生图生命周期由姊妹 change add-lab-drill-params-and-blueprint 定义，本 change 只留接口零实现）。接口 + 内存 mock 可测；W0 前用 mock、W0 后切真源。
- **依赖轨（D 轨，排后，硬前置标注）**：逐钻微调（改形/改尺寸/旋转——消费 GemSpecSnapshot/EditGemFields 扩展）；规格选择器与自定义钻形校准向导 UI（消费 .gemshape）；笔刷算法落地（吸附六方格位 + 当前 spec 物化）；保存/导出 pairwise warning 消费；画幅物理读数接线——均标「add-gem-catalog W0/engine gate 后」。
- **不做（显式边界）**：图层化与排钻设计页生命周期（studio-layers）；实验室高级选项与蓝图（姊妹 change add-lab-drill-params-and-blueprint）；尺寸/规格数据契约本体与四格式迁移（add-gem-catalog-and-sizes）；「送精修」措辞与 .gemdoc/精修项目命名。

## Impact

- **改名面**：`src/App.svelte`（桌面 :78-79 / 移动 :156/:168 Tab + 注释）、`src/components/Studio/*`（StudioStatusBar :121 toast、StudioContextBar :176）、`src/components/Lab/PreviewDialog.svelte:180`、`src/lib/stores/*`（lab :1272-1297、gallery :496、handoff :2、view :4-5、toast :2、studio :469/:485 注释与提示文案）、`src/lib/components/views/*`（LabView :242、StudioView :29）、`src/tests/**`（rg 2026-09-20 实测 11 个测试文件含旧词：lifecycle/editUnbound/app.smoke/editReferenceAsset/openIntentFlow/labAssetIntegration/lab.store/edit.store/studio.interactions/pipeline/helpers）、`TERMS.md`（v1→v2）、`PRODUCT_MODEL.md`（v3→v4）。
- **新建**：`src/lib/services/`（gemCatalogService / documentService / generationService 接口位）；store 拆分子模块（`*.svelte.ts`，如 studio/imageSource、studio/exportSink、studio/editHandoff、edit/gemdocLifecycle、edit/documentStatus）；`src/components/Edit/` 工作台骨架组件（工具栏/属性面板/图层面板）。
- **不动**：引擎算法与确定性语义、四格式 parser/serializer（v2 归 add-gem-catalog）、素材库数据层、送精修烘焙链路行为、撤销栈规格。
- **依赖关系**：依赖轨硬前置 = add-gem-catalog-and-sizes W0（0.x 契约 gate）+ engine gate（tasks 1.2 exportGate / 1.4 EditGemFields 扩展 / 2.x .gemshape 资产化 sys-shapes）；并行轨零 v2 契约消费，与 W0 无冲突面；与 studio-layers 的 store 拆分域互斥（图层/历史/计算队列域归其统筹）。
