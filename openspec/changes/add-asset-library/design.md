<!--
Orthogonal intents (max 5):
1. [2026-09-19 Source] PM 设计稿 §2 冻结为实现级契约；§8 议题 1/2/3/5 附立场待 Codex 裁决（裁决前相关段标 [议题N]）。
2. [2026-09-19 Data] 资产不可变（内容永不改，只有元数据动）是跨模块 assetId 引用安全性的基石；path 派生不存储。
3. [2026-09-19 Storage] IndexedDB v2 只增不搬（blob 原地复用）；localStorage 只存迁移 flag；迁移幂等可重跑。
4. [2026-09-19 Boundary] 「派生数据烘焙、不可变资产引用」二分法：中间态不入库，参考原图引用化不破坏烘焙语义。
5. [2026-09-19 Process] C-1/C-2 修订必须在本 change 内同步 add-manual-edit-mode 的 design.md §1（窗口：edit tools 5.x 未开工）。
-->

## Purpose

固化素材库（虚拟文件系统）的数据契约、迁移策略、文件操作语义与三模块接入方式。完整交互规范/状态矩阵/线框见 PM 设计稿 §2.3/§2.5/§2.6，本文只冻结实现级不变量。

## 1. 数据契约（冻结）

```ts
// src/lib/persistence/assetStore.ts（新建；节点模型 = PM §2.2.1 原文冻结）
export type AssetNodeId = string // 'ast-' + crypto.randomUUID()；preset 节点固定 'ast-preset-<presetId>'
export type SystemFolderId = 'sys-cases' | 'sys-generated' | 'sys-uploads' | 'sys-exports' | 'sys-trash'

interface AssetNodeBase {
  id: AssetNodeId
  name: string            // 同父内唯一；冲突自动后缀 ' (2)'
  parentId: string | null // null = 根层；系统目录固定 parentId=null
  createdAt: number
  updatedAt: number       // '最近'集合排序键
}
export interface AssetFolder extends AssetNodeBase {
  type: 'folder'
  system?: SystemFolderId // 系统目录：本身禁删/改名/移动；唯 sys-cases 条目完全只读
}
export type AssetSource = 'upload' | 'lab-generate' | 'edit-export' | 'preset' | 'migrated'
export interface AssetImage extends AssetNodeBase {
  type: 'image'
  refKind: 'blob' | 'external'
  blobKey?: string         // refKind='blob'：既有 images store 的 key（复用不搬）
  externalUrl?: string     // refKind='external'：静态资源直址（案例图，不入 IDB）
  mime: string; width: number; height: number; bytes: number
  source: AssetSource
  meta?: { runId?: string; variantName?: string; candidateIndex?: number; prompt?: string; originNote?: string }
  trashedAt?: number       // 非空 = 在回收站（软删）
}
export type AssetNode = AssetFolder | AssetImage
```

不变量：
- **path 是派生量**：由 parentId 链现算，不存储——重命名/移动永不破坏引用（引用只认 id）。
- **资产不可变**：任何操作不改 blob 与图片内容；可变的只有 name/parentId/updatedAt/trashedAt。
- **环不可能**：移动时沿 parentId 链向上查，目标不可为自身或后代（assetStore 层拒绝，非仅 UI 禁用）。

## 2. 存储与对象生命周期（冻结）

```
DB rhinestone-studio @ version 2（imageStore.ts upgrade）
├─ images     （不动：blob 仓 {id, blob, createdAt}，key 兼容 taskId / effectref-* / 新 assetKey）
└─ assetNodes 新增 keyPath='id' + index: parentId / updatedAt / trashedAt
```

- 节点元数据放 IndexedDB 而非 localStorage（任务 meta 三级降级先例：localStorage 必爆只增不减的树）。localStorage 仅 `rhinestone-studio:asset-migration-v2` flag。
- **objectURL 统一缓存**：assetStore 模块级 `Map<blobKey, objectURL>` + LRU 上限 200 条，超限 revoke 最旧；三模块共用一份（替代现在 lab/compare 各建各撤）。`objectUrlForKey(key): string`、`releaseObjectUrl(key)` 为唯一取用出口。[议题1 相关：blob 仓复用 images store]
- 上传 ingest：MIME 白名单 + 尺寸统计（width/height/bytes 入节点）；失败 toast 三段式，不留半节点。

## 3. 迁移（幂等，启动异步执行，不阻塞首屏）

前置检查 flag 未置位 → ①seed 五系统目录（存在即跳过）→ ②案例图建 `ast-preset-*` external 节点入 sys-cases（按 presetId upsert，随版本更新）→ ③成功任务按 runId 建批次文件夹入 sys-generated（`第 N 次生成 · MM-DD HH:mm`，N 沿用画廊批次序；LEGACY 归「更早」；blob 缺失节点照建、标 missing）→ ④`effectref-` blob 建节点入 sys-uploads（source='migrated'）→ ⑤置 flag。全程 try/catch，任一步失败下次重跑（每步幂等：节点存在即跳过）。**blob 一律不搬不复制**；最坏退化 = v1 行为（各模块直接读 blob key 仍可用）。

## 4. 文件操作语义（冻结）

| 操作 | 语义 | 硬约束（store 层保证） |
|---|---|---|
| 新建文件夹 | 任意用户目录/根层 | 系统目录内禁止 |
| 重命名 | 同父唯一，冲突自动 ` (2)` | 系统目录与 sys-cases 条目禁改 |
| 移动（P0 对话框选目标） | 仅改 parentId | 环检测；目标必须文件夹；sys-cases 条目与系统目录不可移 |
| 删除 | **软删**：parentId→sys-trash，trashedAt=now [议题5] | 系统目录不可删；确认框列明 N 图/M 文件夹 |
| 清空回收站 | **硬删** blob+节点 | 引用集命中者跳过并明示（变体 asset 引用扫描，任务 meta assetId 为弱引用不参与） |
| 下载 | 原 blob 单图/多图 | 文件夹 zip = P2 |

## 5. 三模块接入契约（冻结）

**统一选图器**（`components/Assets/AssetPickerDialog.svelte`，签名先冻——`redesign-studio-layout` 依赖此接口并行）：

```ts
// 打开：单选（默认）或 multi；返回 AssetImage（含 blobKey/externalUrl）
pickAsset(opts?: { multi?: boolean; initialFolderId?: AssetNodeId }): Promise<AssetImage[] | null>
// 内置：快捷集合 chips（最近=updatedAt 降序前 24 / 全部 / 三来源目录）+ 面包屑 + objectURL 网格 + 「上传新图片」（入库当前目录→自动选中）
```

**handoff v2**（lab→studio；dataUrl 载荷仅消费瞬间存在，不再驻留 store）：

```ts
// handoff.svelte.ts
export interface HandoffPayload {
  assetId: string            // 生成时已自动入库；此处仅传 id
  name: string               // 建议名（变体-候选N）
  referenceAssetId?: string  // 实验室参考原图资产 id（若有）
}
```
工作台消费：`getImageBlob(blobKey(assetId))` → dataUrl → 既有解码管线。**送转化 = 存库 + 选中**（生成已入库，增量语义=交接选中）。[议题2]

**实验室**：reference 状态 = `{assetId, previewUrl}`；效果参考 upload kind → `kind:'asset'`（`{assetId}` 替代 uploadKeys），**替换变体参考不再删资产**；生成成功 = putImage(taskId) 不变 + 建节点入预建批次文件夹（startRun 时预建，name `MM-DD HH:mm · N 张`）+ 任务 meta 增 assetId；**清空历史只清任务 meta/画廊，不动资产**（B-1）。[议题3]

**工作台**：空态双 CTA（从素材库选择=主 / 上传=次，均入库+选中）；origin 增 `'library'`；`StudioImage` 增 `assetId?`（解码像素仍是会话私有派生）；参考原图存 `{assetId, dataUrl(渲染缓存)}`。

**手动编辑（C-1/C-2 修订）**：`ManualEditHandoff.referenceDataUrl?: string` → `referenceAssetId?: string`；EditDocument 内 reference 改存 assetId + 渲染层 objectURL 缓存。图层显隐/透明度语义不变；`buildManualEditHandoff` 构造点、EditView 消费点、add-manual-edit-mode/design.md §1 三处同步。导出 PNG = 下载 + 入库 sys-exports（name `精修 · <来源摘要> · MM-DD HH:mm.png`）+ toast「在素材库中查看」。

**行为变更清单（需 changelog + 测试更新）**：B-1 清空历史不删图；B-2 变体换参考保留资产；B-3 上传即入库（存储只增不减，回收站治理）；B-4 刷新后实验室参考原图不再丢失。

## 6. 待 Codex 裁决议题（附 PM 立场）

1. **blob 复用 `images` store vs 新建 `assetBlobs`**——立场：复用（零拷贝迁移、v1 回退自然；新 store 只买语义洁净不值全量搬迁，IDB 无 move 拷贝有配额风险）。
2. **handoff/烘焙边界引用化**——立场：改（「派生烘焙、不可变引用」二分法；省 1-2MB dataUrl 驻留）。若 Codex 坚持 handoff 自包含，降级方案 = dataUrl fallback 双写一版，A-6 合入时切换。
3. **生成归档：批次文件夹 vs 平铺+过滤**——立场：按批次（与画廊 runId 心智同构；无搜索的 P0 平铺不可浏览）。
4. （删除语义软删 vs 硬删 → 见 §4，立场软删；成本≈硬删、误删保护即得。）

## 7. 性能与护栏

- 入库异步化不阻塞生成交互；迁移不阻塞首屏。
- 1 万钻画布 60fps 不回退（工作台回归）；三模块管线现有测试全绿。
- P1（登记不做）：搜索（名称+meta.prompt 前端索引）、标签、树内拖拽、回收站还原 UI + 30 天自动清理、thumbKey 独立缩略图、画廊↔库互查、批量下载。

## 8. 技术约束

Svelte 5 runes；assetStore 为纯数据深模块（不 import Svelte 组件）；TS strict；零新增依赖；IDB 裸 API（沿用 imageStore 模式，不引库）。
