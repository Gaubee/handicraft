<!--
Orthogonal intents (max 5):
1. [2026-09-19 Source] PM 设计稿 §2 + Codex-R1 评审（codex-review-r1.md，4.4/10 NO-GO）修订版；
   九项阻塞 B-1~B-9 的闭合方案均标 [Codex-R1-B*]，五议题按 R1 裁决（方向采纳+实现约束修改）落地。
2. [2026-09-19 Resolve] assetId → blob 的解析只经 assetStore 冻结出口（getAsset/getAssetBlob/objectUrlForAsset），
   禁止调用方拼 blob key [Codex-R1-B1]。
3. [2026-09-19 Lifecycle] 引用保护全集 = 变体 asset 引用 + studio 会话引用 + 活动编辑文档引用（硬保护）
   + 任务 meta assetId（弱引用，仅 missing 展示）；删除/清空全走 assetStore 单事务 [Codex-R1-B7]。
4. [2026-09-19 Migration] IDB v2 共享 opener + 幂等步骤全部成功后才写 flag；失败保留可重跑态 [Codex-R1-B4]。
5. [2026-09-19 Compat] 双图效果参考（src+res）是一等契约 [Codex-R1-B2]。
   [Owner 2026-09-19] 前端不做向下兼容：不设 dataUrl 双写/旧 payload 消费/uploadKeys 运行时兼容分支——
   handoff v2 与 referenceAssetId 直接切换；存量本地数据仅经 §3 一次性迁移建节点，旧类型分支即删。
-->

## Purpose

固化素材库（虚拟文件系统）的数据契约、迁移策略、文件操作语义与三模块接入方式。完整交互规范/状态矩阵/线框见 PM 设计稿 §2.3/§2.5/§2.6，本文冻结实现级不变量（含 Codex-R1 修订）。

## 1. 数据契约（冻结）

```ts
// src/lib/persistence/assetStore.ts（新建；节点模型 = PM §2.2.1）
export type AssetNodeId = string // 'ast-' + crypto.randomUUID()；preset 节点固定 'ast-preset-<presetId>-src' / '-res'
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
  blobKey?: string         // refKind='blob'：既有 images store 的 key（复用不搬）；仅 assetStore 内部触达
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

### 1.1 解析出口（assetId → 可用图）[Codex-R1-B1，签名冻结]

```ts
// 唯一合法解析路径；禁止调用方自行 blobKey(assetId) 拼接（节点 id 与 blob key 解耦）
getAsset(assetId): Promise<AssetImage | null>          // 含软删节点（调用方按需过滤）
getAssetBlob(assetId): Promise<Blob | null>            // refKind='blob' 解析 blobKey 后读取；external/缺失/软删 → null
objectUrlForAsset(assetId): Promise<string | null>     // blob → objectURL（LRU 缓存）；external → externalUrl 原样返回
```

测试四态：blob 节点 / 外链节点 / 缺失 blob（key 无记录）/ 软删节点。

## 2. 存储与对象生命周期（冻结）

```
DB rhinestone-studio @ version 2（共享 opener：assetStore 与 imageStore 同用 openDb()，oldVersion→2 upgrade 只建 assetNodes + 三 index）
├─ images     （不动：blob 仓 {id, blob, createdAt}，key 兼容 taskId / effectref-* / 新上传 key）
└─ assetNodes 新增 keyPath='id' + index: parentId / updatedAt / trashedAt
```

- 节点元数据放 IndexedDB 而非 localStorage（只增不减的树必爆 localStorage 配额）；localStorage 仅 `rhinestone-studio:asset-migration-v2` flag。[Codex-R1-B4]
- **objectURL 统一缓存**：模块级 `Map<assetId|blobKey, objectURL>` + LRU 上限 200 条，超限 revoke 最旧；`objectUrlForAsset` 为唯一取用出口，`releaseObjectUrl` 显式释放。
- 上传 ingest：MIME 白名单 + 尺寸统计（width/height/bytes 入节点）；失败 toast 三段式，不留半节点。
- **测试能力前提** [Codex-R1-B4]：fake IDB 扩展（多 objectStore / version upgrade / index 查询 / 事务语义 / 中途失败注入），或改用真实 IndexedDB（vitest + fake-indexeddb 禁新增依赖——优先扩展自有 fake）；迁移测试覆盖：upgrade、index 查询、注入中途失败、重跑收敛、旧 v1 数据回读。

## 3. 迁移（幂等，启动异步执行，不阻塞首屏）

**flag 语义 [Codex-R1-B4]**：全部幂等步骤成功完成后才写 flag；任一步失败保留可重跑状态（下次启动重跑，已完成的步骤按存在即跳过跳过），并记录缺失项（missing 节点）。

1. seed 五系统目录（存在即跳过）。
2. 案例图：每个 preset 的 **src 与 res 两张图各建节点**（id 固定 `ast-preset-<presetId>-src/-res`，external，meta.originNote）入 sys-cases；版本更新按 id upsert。[Codex-R1-B2]
3. 成功任务按 runId 建批次文件夹入 sys-generated（`第 N 次生成 · MM-DD HH:mm`；LEGACY 归「更早」；blob 缺失节点照建、标 missing）。
4. `effectref-*` blob 建节点入 sys-uploads（source='migrated'；**src/res 按 key 后缀配对写回变体 asset 引用**，见 §5）。[Codex-R1-B2]
5. 置 flag。

**blob 一律不搬不复制**；最坏退化 = v1 行为（各模块直接读 blob key 仍可用）。

## 4. 文件操作语义（冻结，含递归与事务）[Codex-R1-B7]

| 操作 | 语义 | 硬约束（store 层单事务保证） |
|---|---|---|
| 新建文件夹 | 任意用户目录/根层 | 系统目录内禁止 |
| 重命名 | 同父唯一，冲突自动 ` (2)` | 系统目录与 sys-cases 条目禁改 |
| 移动（P0 对话框选目标） | 仅改 parentId | 环检测；目标必须文件夹；sys-cases 条目与系统目录不可移 |
| 删除 | **软删**：**递归**移动全部后代入 sys-trash（文件夹及其内容原子同事务，trashedAt=now） | 系统目录不可删；确认框列明 N 图/M 文件夹 |
| 清空回收站 | **硬删**：递归删除节点与 blob | **引用集命中者跳过并明示**（见下）；单事务 |
| 下载 | 原 blob 单图/多图 | 文件夹 zip = P2 |

**引用保护全集 [Codex-R1-B7]**：硬保护 = ①变体 effectRef 的 assetIds（src+res）②studio 会话内引用（内存 registry）③**活动 EditDocument 的 referenceAssetId**（跨模块 active-reference registry，或规定硬清空前活动文档自动解除并转占位态——二选一在实现前冻结，倾向 registry）；弱引用 = 任务 meta assetId（不阻断删除，卡片显示 missing）。全部删除/清空走 assetStore 事务；四类引用各配测试（变体/studio/edit/task-weak）。

## 5. 三模块接入契约（冻结）

**效果引用双图契约 [Codex-R1-B2]**：

```ts
// lab.svelte.ts VariantEffectRef 修订
type VariantEffectRef =
  | { kind: 'preset'; presetId: string }                                    // 不变（preset 派生 src/res 资产 id）
  | { kind: 'url'; srcUrl?: string; resUrl?: string }                       // 不变（逃生舱）
  | { kind: 'asset'; assetIds: { src?: AssetNodeId; res: AssetNodeId } }    // 替代 upload kind；src 可缺省（仅效果图）
// [Owner] 无运行时兼容：旧 upload kind 直接删除；存量 effectref blob 经 §3 迁移建节点（一次性数据前向迁移，非兼容分支）
```

**选图器运行时协议 [Codex-R1-B6]**：不暴露裸 `pickAsset(): Promise`。冻结 `AssetPickerController`（单例，App 层挂载 `<AssetPickerHost controller>`）：

```ts
interface AssetPickerController {
  open(opts?: { multi?: boolean; initialFolderId?: AssetNodeId }): Promise<AssetImage[] | null>
  // resolve=确定选择；cancel/Esc/外部点击/组件销毁 → resolve(null)；并发 open：后到者接管（前一 promise resolve null）
  // 语义单实例：modal/focus 归 controller 持有；multi 半选态在 cancel 后清空
}
```
controller 先行单测（open/resolve/cancel/Esc/并发/销毁），studio 上下文条/空态与 lab dropzone 消费同一实例。

**handoff v2**（[Codex-R1-议题2]；[Owner] 直接切换，不设 dataUrl 双写/旧 payload 消费）：

```ts
export interface HandoffPayload {
  assetId: string            // 生成时已自动入库；经 getAssetBlob 解析（B-1 出口）
  name: string
  referenceAssetId?: string
}
```
工作台消费：`getAssetBlob(assetId)` → dataUrl → 既有解码管线；**missing-asset 显式出口**（错误态+回退空态，不是空画布）。送转化 = 存库 + 选中。

**实验室**：
- reference 状态 = `{assetId, previewUrl}`；**PersistedTaskMeta 增 `referenceAssetId`** [Codex-R1-B3]，上传/选图时持久化；hydrate 后 edit 任务重试按 id 解析（`getAssetBlob` → File），缺失资产给明确失效态（不静默失败）。测试必须跑真实刷新序列：上传 reference → terminal task → reset module → hydrate → retry 成功 + 缺失资产失效态两分支。
- 生成结果归档 [Codex-R1-议题3 修正]：**首个成功结果时懒建批次文件夹**（runId 为幂等键，name `MM-DD HH:mm · N 张`），不采纳 startRun 预建（中途退出/全取消无可恢复 run 记录，预建留空夹）；空批次（全部失败/取消）清理不留夹；blob 写入 + 节点写入 + 任务 meta assetId 更新三步有失败重试/补偿（任务终态持久化时补建节点，幂等）。
- **清空历史只清任务 meta/画廊，不动资产**（B-1；现 `clearHistory` 直接删 blob 的路径是必须显式迁移的行为变更）；任务卡删除 = 软删对应资产 + 隐藏卡片。

**工作台**：空态双 CTA（素材库=主/上传=次，均入库+选中）；origin 增 `'library'`；`StudioImage` 增 `assetId?`；参考原图存 `{assetId, dataUrl(渲染缓存)}`。

**手动编辑（C-1/C-2 修订，链路全覆盖 [Codex-R1-B5]）**：`referenceAssetId` 贯通四处——`ManualEditHandoff`（studio referenceImage 状态持有 assetId → `buildManualEditHandoff` 传递）→ `EditDocument`（存 assetId）→ **`EditCanvas` 异步 resolver**（真实渲染消费者，现读 `d.referenceDataUrl` 处）→ 回收站硬清空保护（§4 引用集③）。resolver 状态机：loading / ready / missing（显式失效层，非空画布）/ soft-deleted（提示+可去回收站）；切换 reference 的清理（objectURL 释放）。导出 PNG = 下载 + 入库 sys-exports + toast「在素材库中查看」。

**行为变更清单**：B-1 清空历史不删图；B-2 变体换参考保留资产；B-3 上传即入库；B-4 刷新后参考原图不再丢失（含重试链路恢复）。

## 6. 议题裁决记录（Codex-R1 终案）

1. **blob 复用 images store**——采纳（PM 立场）；约束修改：解析只经 §1.1 冻结出口。
2. **handoff 引用化 + C-1/C-2**——采纳（方向）；约束修改：EditCanvas 真实消费者入链、编辑引用入硬清空保护、missing 出口。[Owner] 否决 dataUrl 双写：直接切换。
3. **按批次文件夹**——采纳（PM 立场）；约束修改：runId 幂等懒建（非 startRun 预建）+ 空批次清理 + 写入补偿。
4. **布局方案 A**——采纳（见 redesign-studio-layout change）。
5. **P0 软删**——采纳（PM 立场）；约束修改：递归语义冻结 + 引用保护全集 + 单事务。

## 7. GO 前置纵向测试（tracer bullet）[Codex-R1-C]

「上传 → 生成 → 刷新 → 选图 → 送转化 → 送精修 → 清理」最小纵向链路测试先行（fake IDB 扩展就绪后第一件事），作为两 change 转 GO 的验收条件之一。

## 8. 性能与护栏

- 入库异步化不阻塞生成交互；迁移不阻塞首屏。
- 1 万钻画布 60fps 不回退（工作台回归）；三模块管线现有测试全绿。
- P1（登记不做）：搜索、标签、树内拖拽、回收站还原 UI + 30 天自动清理、thumbKey 独立缩略图、画廊↔库互查、批量下载。

## 9. 技术约束

Svelte 5 runes；assetStore 为纯数据深模块（不 import Svelte 组件）；TS strict；零新增依赖；IDB 裸 API（共享 opener 模式）。
