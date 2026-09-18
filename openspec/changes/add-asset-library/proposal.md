<!--
Orthogonal intents (max 4):
1. [2026-09-19 User] 需求 5：新增「素材库」模块——虚拟文件系统（支持文件夹），图片资产唯一真源。
2. [2026-09-19 User] 需求 6：实验室/工作台/手动编辑三模块的图片管理全部基于素材库重构（上传即入库、跨模块引用、回收站治理）。
3. [2026-09-19 Data] 资产不可变 + blob/节点分离 + 存量零拷贝迁移（既有 images store 原地复用）。
4. [2026-09-19 Contract] handoff 引用化（dataUrl 载荷 → assetId），联动修订 add-manual-edit-mode 的 referenceDataUrl 契约（改动窗口：edit tools 5.x 未开工）。
-->

## Why

现状图片资产散落四套互不知情的存储（会话内存 / IndexedDB 扁平 / 静态 presets / 烘焙 dataUrl）：刷新即丢、跨模块复用靠重传、删除即永久消失、变体换参考无感丢素材。缺统一资产层是三模块图片管理怪相的共同根因（证据盘点见 PM 设计稿 §1）。

## What Changes

- **新增第四模块「素材库」**：虚拟文件系统（文件夹/重命名/移动/软删回收站/清空含引用保护），桌面树+网格、移动端目录选择器+2 列网格。
- **数据层**：`assetStore`（AssetNode 节点模型 + IndexedDB v2 `assetNodes` store + objectURL LRU 缓存）；blob 复用既有 `images` store，零拷贝。
- **存量迁移**：启动幂等懒迁移——seed 五个系统目录（案例/生成结果/上传/精修导出/回收站）、taskId blob 按批次建文件夹、effectref blob 归上传目录，只建节点不搬数据。
- **三模块接入**：统一选图器 Dialog（浏览/最近/上传即入库）；实验室参考图与效果参考 asset 化、生成结果自动归档、清空历史与资产解耦；工作台空态双 CTA + 参考原图 asset 化；手动编辑导出 PNG 入库 + `referenceAssetId` 契约修订（C-1/C-2）。
- **handoff 引用化**：lab→studio 交接从 dataUrl 改 assetId；送转化 = 存库 + 选中。

## Non-Goals

- 不做云同步/后端/协作分享（纯前端约束不变）。
- 不动引擎（`$lib/engine` 零改动）。
- 不做搜索/标签/拖拽移动/缩略图独立缓存/还原 UI（P1，见 design §P1）。
- 不资产化编辑文档与中间态（派生数据烘焙原则不变；仅原料与成品入库）。
- 不在本 change 内重排工作台布局（`redesign-studio-layout` 另行）。

## Evidence

- PM 设计稿（一手）：`.agents/documents/2026-09-19-asset-library-design/asset-library-and-studio-redesign.md` §1-§2、§6
- 产品模型：`rhinestone-studio/PRODUCT_MODEL.md`（本次同步建立）
- 现状断点源码证据：`lab.svelte.ts` L162/L300-311/L577-580/L838-847、`imageStore.ts` L6-8、`studio.svelte.ts` L74-82、`effectRefs.ts`
