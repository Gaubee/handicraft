# Design: 装饰钻库（Decorative Stone 独立管理体系）

> 决策源：Owner 补充定调三（`../add-subject-sam-pipeline/owner-directive-20260924.md` 原话冻结）。样卡事实源：`experiments/stone-catalog-20260924/card-text.txt`（钰航两页，PDF 文本已提取）。冲突处以原话为准。

## 0. 冻结红线

- **真正客观的数据=颜色+尺寸**；SS+Shape+Cut+Color+Effect 七字段模型降级为云数据参考；其余一切进扩展元数据。
- **可贴原子** = {贴图（去背景留主体）、尺寸(mm)、颜色、其它元数据}；存 JSON，字段自由扩展——不建关系型钻表。
- **沿用素材库的文件文件夹管理方案**：虚拟文件系统模式（目录树+文件行+软删+引用保护+内容寻址去重），落位 daemon 资产面。
- **引擎零改动**（`add-subject-sam-pipeline` §0 红线沿用）：stone 一切引擎消费经 adapter 纯函数（§9），引擎不 import stone 契约。
- **AI 录入/修改走授权桥**（W4.2 approved-mutation 语义）：readonly 工具 agent 直调，写工具必经 proposal→人工批准→grant。

## 1. 数据模型与文件夹方案

### 1.1 落位决策：复用 resources 表 + stone_index 投影表

三案对比：

| 方案 | 内容 | 裁决 |
|---|---|---|
| A. 复用 W2 `resources` 表（`daemon/src/db/schema.ts:57`）+ 新增 `stone_index` 投影表 | 文件夹方案直接映射：目录行（is_dir=1）+ 文件行（content_hash→blobs）；owner/revision CAS/parent_id 树全复用；筛选面走投影表 | **采纳** |
| B. 独立 `stones` 新表 | 丢弃既有 owner 归属/revision CAS/blob 引用计数/清理 outbox 机能，重复建设；且「后台资源管理器」需同时读两套资源面 | 否决 |
| C. 纯 `resources.meta` JSON LIKE 查询 | meta 是 TEXT JSON（schema.ts:66 偏差说明），色系/尺寸/供应商筛选无法索引，规模上来后不可用；且无类型保证 | 否决 |

裁决 A 的关键不变量：**resources 行是唯一真源，stone_index 是同事务维护的可重建投影**（由 stone.json 写入路径全量回填；可 `REINDEX` 重建——不构成第二真源）。blob 内容寻址去重直接复用（`blobs` sha256 + ref_count，schema.ts:46-55）：同贴图字节跨原子只存一份。

### 1.2 原子目录布局与目录树

每颗钻=一个「原子目录」（Owner 可贴原子的文件夹投影）：

```
stones/                              ← 系统根（meta.role='stones-root'；幂等 seed，首次访问建）
└── yuhang/                          ← 供应商目录（meta.role='supplier'，meta.skuProfile=SKU 编码档案 §2）
    ├── 白色系/                       ← 色系目录（导入时按草表建议建；逻辑 tag 可批量移组）
    │   ├── 51-象牙白/                ← 款式行目录（行号+色名——样卡一行=一款式）
    │   │   ├── J51/                  ← 原子目录（SKU=J51：2mm × 象牙白）
    │   │   │   ├── stone.json        ← 核心字段+自由扩展（文件行，meta.kind='stone'）
    │   │   │   ├── 贴图.png          ← 去背景主体贴图（文件行，meta.kind='stone-texture'）
    │   │   │   └── views/            ← 可选多视图照片（实物摄影，非渲染源）
    │   │   │       └── 斜视.jpg
    │   │   ├── A51/                  ← 3mm × 象牙白（同款式行 7 尺寸变体）
    │   │   ├── B51/ C51/ E51/ F51/ G51/
    │   │   └── …
    │   └── 52-珍珠白/
    ├── 红色系/
    │   └── 60-正红/…
    └── 大径行/                        ← 行 76/78（12-25mm 档）——色系归属同草表建议
        └── 76-古铜金/
            ├── J76/                  ← 12mm（band [76,78]：J=12——§2 行段漂移实证）
            └── A76/ … G76/           ← 14/16/18/20/22/25mm
```

分层推荐（供应商/色系/款式行/SKU 原子 四层）理由：

1. **款式行目录与样卡同构**（样卡一行=一款式×7 尺寸）——导入器按行建目录最自然，「这个颜色有哪些尺寸」的物理浏览免费获得。
2. **色系是易变分组**（草表建议→人审修正），物理目录移动成本低（path 为 parent_id 链派生量，不存储——沿 IDB 素材库不变量，`add-asset-library/design.md` §1），批量重指=批量改 parent_id 单事务。
3. 原子目录名=SKU 码（ASCII），自包含可移动；款式/色系信息同时物化在 stone.json 内（不依赖路径反推——引用只认 resourceId，沿「path 是派生量」纪律）。

替代结构（供应商/尺寸档/…）登记为可选项：尺寸维度由 `stone_index` 查询投影免费提供（§4 网格 `groupBy=sizeMm`），不需要物理目录承担。

### 1.3 stone.json schema（contracts `stones.ts`，Zod 冻结）

```ts
const StoneColorSchema = z.object({
  name: z.string(),                                   // '象牙白'（人审定名）
  rgb: z.tuple([z.number(), z.number(), z.number()]), // 0-255 主体代表色（贴图/样卡取样）
  family: z.string(),                                 // '白色系'（逻辑分组，可重指）
  finish: z.string(),                                 // 质感：glossy|matte|metallic|pearl|iridescent|自由串
});

const StoneFileSchema = z.object({
  kind: z.literal('stone'),
  formatVersion: z.literal(1),
  id: z.string(),                       // 'stn-' + uuid（resourceId 独立于原子目录行 id）
  name: z.string(),                     // 显示名 '象牙白 · 2mm'
  supplier: z.string(),                 // 'yuhang'
  sku: z.string(),                      // 原始编码 'J51'（溯源；唯一性=supplier×sku）
  skuParsed: SkuParsedSchema.optional(), // {row:51, prefix:'J', sizeMm:2}（导入时物化快照）
  sizeMm: z.number().positive(),        // 最大径 mm——客观真值（唯一物理依据，引擎消费此值）
  color: StoneColorSchema,
  texture: z.object({                   // 贴图（必备——去背景留主体）
    file: z.literal('贴图.png'),        // 原子目录内文件名
    mime: z.literal('image/png'),
    width: z.number().int(), height: z.number().int(),   // 声明值，入库以解码实测为准（gate 1）
    alphaBounds: z.object({ x: z.number().int(), y: z.number().int(),
                            w: z.number().int(), h: z.number().int() }),
  }),
  shapeClass: z.string().optional(),     // 几何归类：'round'|'cabochon'|'pearl'|'resin-dome'|…（缺省 'round'）
  gemshapeRef: z.string().optional(),    // 可选关联 .gemshape 资产 id（§3——渲染形状定义，单向弱引用）
  views: z.array(z.string()).optional(), // views/ 下文件名清单（实物照片，非渲染源）
  metadata: z.record(z.string(), z.unknown()),  // 自由扩展（Owner「字段自由扩展」：库存/采购/工艺备注/批次…）
  createdAt: z.string(), updatedAt: z.string(),
});
```

不变量：核心字段（kind/formatVersion/id/supplier/sku/sizeMm/color/texture）冻结；`metadata` 是唯一自由扩展面——**新需求先落 metadata，稳定后再提升为一等字段**（版本纪律：formatVersion bump 才允许核心字段变更）。`supplier×sku` 唯一（stone_index UNIQUE 约束承载）；`sizeMm` 永远存直值（快照哲学：编码档案/色系后续漂移不影响已入库钻——沿 `.gemshape` calibration 快照先例）。

### 1.4 贴图规范（六条 gate，复用 `.gemshape` 纪律同源）

沿 `add-gem-catalog-and-sizes/design.md` §1.4 六条 parser gate 纪律（`.gemshape` 先例），适配为 stone 贴图入库校验：

1. **解码实测宽高**：声明 width/height 与解码实测不符=typed error 拒收。
2. **输入上限**：仅 PNG；≤2MB；≤4096px 边长；像素总量上限（防炸弹贴图）。
3. **alpha bounds 非空**：全透明拒收；主径/物理换算取 alpha 内容 bounds（非画布外框）。
4. **fit 语义**：alpha bounds 主径纵横比 vs `shapeClass` 期望比（round/cabochon≈1:1）超容差=拒绝——比例漂移即物理尺寸谎言（不做静默裁剪）。
5. **分辨率下限**：alpha bounds 主径 ≥64px 绝对下限；建议 ≥32px/mm（2mm→64px，25mm→800px）。
6. **missing texture=typed 显式态**：文档/渲染引用的贴图缺失→显式 missing（占位+导出清单标注），禁静默降级圆钻轮廓照常导出。

内容规范：sRGB、透明底（背景 alpha=0）；主体边缘抗锯齿羽化 ≤2px（允许软边，禁大面积半透明）；渲染底色建议非纯白（浅灰/画布纹理——`add-subject-sam-pipeline/design.md` §10.5 回流：白钻-白底对比度）。

### 1.5 stone_index 投影表（SQLite 迁移 v5）

```sql
CREATE TABLE IF NOT EXISTS stone_index (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id),  -- 原子目录行 id
  owner_id    TEXT NOT NULL,
  supplier    TEXT NOT NULL,
  sku         TEXT NOT NULL,
  style_row   INTEGER,          -- 款式行号（51）
  style_name  TEXT,             -- '象牙白'
  family      TEXT NOT NULL,    -- '白色系'
  size_mm     REAL NOT NULL,    -- 2.0（sizeMm 直值冗余，免 parse blob）
  color_hex   TEXT NOT NULL,    -- '#FFFFF0'（rgb 冗余，ΔE/筛选用）
  finish      TEXT,
  trashed     INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  UNIQUE(supplier, sku)
);
CREATE INDEX IF NOT EXISTS idx_stone_family ON stone_index(family);
CREATE INDEX IF NOT EXISTS idx_stone_size ON stone_index(size_mm);
CREATE INDEX IF NOT EXISTS idx_stone_supplier ON stone_index(supplier, style_row);
```

维护规则：stone.json 任何写入（create/update/import/色系重指/软删/恢复）在**同一 SQLite 事务**内 upsert/删除对应行；投影可由 resources+blob 全量重建（运维端点/启动校验登记，非 P0）。

### 1.6 操作语义（沿素材库纪律移植）

| 操作 | 语义 | 约束 |
|---|---|---|
| 新建原子 | 目录行+stone.json 文件行+贴图文件行+blob 四步同事务 | `supplier×sku` 唯一；同父目录名冲突自动 ` (2)` |
| 更新 | stone.json 字段级 patch→新 blob→revision+1（CAS：grant 绑定 baseRevision，漂移必拒——W4.2 §3.6 同规） | 贴图替换=新内容新 hash（内容寻址），id 不变 |
| 软删 | 原子目录树递归 `meta.trashedAt`（stone_index.trashed=1），列表默认过滤 | 系统根/供应商档案目录禁删 |
| 硬删（清空回收站） | 递归删资源行；blob 按 ref_count 归零才物理删 | 引用集命中跳过并明示 |
| 引用保护 | LayoutDocument/策略工件/会话对 stone 的引用=**弱引用**（missing 四态：resolved/soft-deleted/blob-missing/wrong-kind——照 `.gemshape` missing 四态先例，gem-catalog design §3.2 面 7）；硬清不阻断、消费方显式 missing | 编辑期 pin 归 P3 旅程 |
| 幂等导入 | import 按 `supplier×sku` 存在即跳过（report 列明 skipped） | 重跑收敛 |

写权限：admin/owner 可写；anonymous 沿「禁写不禁读」；**AI 写=approved-mutation 授权桥**（§6）。

## 2. SKU 编码解析器（供应商档案可配）

钰航样卡文本实证（card-text.txt）：**同一前缀字母在不同行段映射不同 mm**——

| 行段 | J | A | B | C | E | F | G |
|---|---|---|---|---|---|---|---|
| 51-75（页 1） | 2 | 3 | 4 | 5 | 6 | 8 | 10 |
| 76-78（页 2 上） | 12 | 14 | 16 | 18 | 20 | 22 | 25 |
| 80-89（页 2 下） | 2 | 3 | 4 | 5 | 6 | 8 | 10 |

（行 77/79 样卡缺席——解析器必须容忍稀疏行。）故映射表**必须按行段（band）配置**，不做全局表：

```ts
const SupplierSkuProfileSchema = z.object({
  supplier: z.string(),                    // 'yuhang'
  displayName: z.string(),                 // '钰航'
  bands: z.array(z.object({
    rows: z.tuple([z.number().int(), z.number().int()]),   // [51,75] 闭区间
    sizeMmByPrefix: z.record(z.string(), z.number().positive()),  // {J:2,A:3,…}
  })),
  styleKey: z.literal('row'),              // 款式号=行号（其它供应商编码位次变化时扩）
});

parseSku(profile: SupplierSkuProfile, code: string):
  | { ok: true; supplier; row: number; prefix: string; sizeMm: number }
  | { ok: false; reason: 'prefix-unknown' | 'row-out-of-band' | 'malformed' }
// 'J51' → {row:51, prefix:'J', sizeMm:2}；'J76' → {row:76, prefix:'J', sizeMm:12}
```

档案存供应商目录行 `meta.skuProfile`；导入与查询共用同一 parseSku（contracts 双端可用）。stone.json 内物化 `skuParsed` 快照+`sizeMm` 直值——档案后续修订不回写已入库钻。

## 3. 与 `.gemshape` 的关系（互不替代）

| | stone（本 change） | `.gemshape`（gem-catalog） |
|---|---|---|
| 本体 | **可贴原子素材**：供应链 SKU（颜色×尺寸×贴图）——「有什么钻可以贴」 | **引擎渲染形状定义**：几何/矢量/贴图渲染协议——「这颗钻怎么画」 |
| 真源 | daemon resources（服务端，MCP/后台/前台共源） | 前端 IDB 素材库（sys-shapes seed+自定义） |
| 消费者 | 钻表选择器/策略设计器/BOM 供应链清单 | engine buildSvg/renderGemsPng（vectorPath/texture 渲染） |

关系=**单向可选弱引用**：`stone.gemshapeRef?: string` 指向某 `.gemshape`（如 round 轮廓矢量）用于渲染加速/清晰导出；缺省=stone 自身贴图按 §9 adapter 渲染。`.gemshape` 不知道 stone（不反向引用）。两者不共享 id 空间/存储；SS 目录降级云数据不 `.gemshape` 机制（`.gemshape` 作为渲染形状定义继续有效——降级的是「SS 七字段=供应链真源」的模型假设）。

## 4. 后台资源管理器（daemon 面）

### 4.1 服务与 API

新 daemon 深模块 `daemon/src/stones/service.ts`（纯数据面，不 import 前端）承载全部逻辑；RPC（oRPC-over-WS，沿 `rpc.ts` 形态）+ HTTP（贴图字节）两投影：

| 端点 | 语义 |
|---|---|
| `stones.tree(rootId?, includeTrashed?)` | 目录树（folder 行投影：id/name/role/childCount） |
| `stones.list(filter: {supplier?, family?, sizeMm?, styleRow?, sku?, q?, groupBy?: 'family'\|'sizeMm'\|'style', page, pageSize, includeTrashed?})` | stone_index JOIN resources 筛选分页 |
| `stones.get(id)` | stone.json 全文+贴图/视图 URL+resourceId/revision |
| `stones.substitutes(query)` | §8 |
| `GET /api/stones/{id}/texture.png`（auth 作用域 HTTP） | 贴图字节（blob 直读+ETag=hash；views 同法 `/views/{name}`） |

同一 service 函数是 MCP `stone.list/search/get` 的 handler 底座——**API 与 MCP 单一真源**。

### 4.2 样卡式网格视图数据协议（后台 UI 消费）

```ts
interface StoneGridCell {
  resourceId: string;          // 原子目录行 id
  sku: string; supplier: string;
  name: string;                // '象牙白 · 2mm'
  styleName: string; family: string;
  sizeMm: number; colorHex: string; finish: string;
  textureUrl: string;          // /api/stones/{id}/texture.png
  trashed: boolean; updatedAt: string;
}
// stones.list 返回 { cells: StoneGridCell[]; total; groupKeys?: string[] }——
// 后台网格=样卡复刻（行=款式/色系分组，列=尺寸档），贴图作单元格缩略图。
```

后台 UI 挂载：rhinestone-studio 内「装饰钻库」管理视图（开发者/管理员旗标，与隐藏素材库 tab 并列；区别=数据源是 daemon resources 而非本地 IDB）。视图含：树导航+网格+详情（RightSheet 沿素材库先例）+回收站+导入向导入口。

## 5. 前台展示（钻表选择器）

策略设计器/参数面板（`add-subject-sam-pipeline` P3.2 消费）用的选钻组件：

- **按色排板**：`groupBy='family'`→款式行→尺寸变体行内切换（样卡心智）。
- **按尺寸排板**：`groupBy='sizeMm'`→同径色阵（工艺心智：先定钻径再配色）。
- **搜索**：SKU/色名/拼音/十六进制；`q` 走 stone_index。
- **ΔE 邻近推荐**：给定目标色（图块代表色），`stones.list` 附 `nearColor` 参数返回按 ΔE 排序候选（CIE76，引擎 `color.ts labFromRgb/deltaE` 同源换算，服务端计算）。
- 选中产出：`StonePick { resourceId, sku, sizeMm, colorHex, gemshapeRef? }`——策略参数引用钻的唯一形态（不内嵌贴图数据）。

贴图渲染规范：透明底 PNG 经 `textureUrl` 取字节→引擎 resolveAsset 消费（§9）；预览底色非纯白（§1.4）。

## 6. MCP 工具面（capability 三分类 + 授权桥）

新 `capability/stones.ts`（registry 注册，MCP 投影自动——`capability/mcp.ts` 直传）。命名空间 `stone.*`，投影 `mcp__studio__stone_*`：

| 工具 | 分类 | 语义 |
|---|---|---|
| `stone.list` | readonly | 目录/筛选浏览（§4.1 filter 同参） |
| `stone.search` | readonly | 关键字+ΔE 邻近+尺寸邻近组合查询 |
| `stone.get` | readonly | 单钻详情+贴图 URL |
| `stone.substitutes` | readonly | 缺钻替代查询（§8） |
| `stone.create` | approved-mutation | 建原子（目录+stone.json+贴图 blob；贴图经字节上传参数或既有 blob 引用） |
| `stone.update` | approved-mutation | 字段 patch/色系重指/贴图替换（revision CAS） |
| `stone.delete` | approved-mutation | 软删（回收站）；硬删=后台人工 |
| `stone.import` | approved-mutation | 样卡批量导入（§7——proposal diff 预览：N 新原子/色系分组/低置信项清单） |

权限分级理由（与 W4.2 十工具同构）：读面 agent 直调零风险（owner 过滤沿 `requireAgentTask`/`requireOwnedResource` 形态——stone 库读面按 §1.6 共享读语义放宽 owner 过滤为全员可读，taskId 校验保留审计链）；**写面全部 approved-mutation**——AI 录入=proposal（diff 预览入 `preview_json`）→人工批准→grant→执行（op_digest 内容摘要+baseRevision CAS+TTL，全沿 `authorization.ts` 既有机制，零新授权语义）。无 proposal 级工具（stone 写操作无「先算后批」的两段计算语义，diff 即预览）。

批量语义：`stone.import` 单 proposal 覆盖整批（逐 cell 结果入 result_ref 报告）；部分失败=成功行保留+失败行清单（幂等重跑跳过已成功 SKU）。

## 7. 样卡导入链（定调三「AI 帮人录入」直接落地）

```
① 上传样卡（人/AI 经后台或 MCP）→ blob（PDF/PNG 两页）
② vision 切格取色 → CardCatalogDraft（card-catalog-draft.json——并行 vision 代理正在产出，本 change 冻结其消费 schema）
③ stone.import(draftRef, options{targetSupplier, familyPolicy}) → proposal（diff 预览）
④ 人工批准（授权桥）→ 执行：
     逐 cell：bboxPx 切图 → 去背景（首版=白底阈值 alpha+≤2px 羽化；gate §1.4 六条校验）
     → 贴图.png→blob → stone.json→blob（sizeMm 取 band 映射直值；rgb 取 cell 取样；name/family 取草表）
     → resources 树（§1.2）+ stone_index 同事务
⑤ 导入报告（人看图双轨：网格前后对照+逐行 成功/跳过/失败 清单——沿内核「输出留存可审查」哲学）
```

CardCatalogDraft 消费 schema（contracts 冻结；vision 草表字段名以本 schema 为对接契约）：

```ts
const CardCatalogDraftSchema = z.object({
  schemaVersion: z.literal(1),
  supplier: z.string(),                          // 'yuhang'
  sourceImage: { blobRef: string; pages: { page: number; widthPx: number; heightPx: number }[] },
  bands: SupplierSkuProfileSchema.shape.bands,   // 与 §2 档案同构（vision 从样卡版式读出）
  styles: z.array(z.object({
    row: z.number().int(),                       // 51
    suggestedName: z.string(),                   // '象牙白'（空串=待人工命名）
    suggestedFamily: z.string(),                 // '白色系'
    rgb: z.tuple([z.number(), z.number(), z.number()]),
    confidence: z.number().min(0).max(1),
    cells: z.array(z.object({ sku: z.string(), page: z.number().int(),
                              bboxPx: { x: number, y: number, w: number, h: number } })),
  })),
});
```

低置信项（confidence<0.7 或 suggestedName 空）在 proposal 预览中显式列出=人工把关点；导入不猜测命名（`待命名-<row>` 兜底+后台补名）。

## 8. 缺钻替代查询

`stone.substitutes(query: { sku? | colorRgb + sizeMm?, maxDeltaE?=10, sizeToleranceMm?=0.5, supplier? })`：

1. **库内替代**：stone_index 全量（或同供应商）按 `ΔE(lab(color.rgb), lab(candidate.rgb)) ≤ maxDeltaE` 且 `|sizeMm 差| ≤ sizeToleranceMm` 过滤，按 `ΔE+尺寸差` 加权排序返回。
2. **跨体系参考**（SS 云数据——Owner「之前建的只能当云数据」）：`CloudCatalogEntry { system: 'ss', label: 'SS10', diameterMm, colorName, rgb? }` 消费接口位冻结（云数据建设另立）；换算=sizeMm↔SS 直径表（引擎 SS_TABLE 数值同源）+颜色 ΔE（云数据须携带 rgb，缺 rgb 降级为仅尺寸建议+色名提示）。输出标注「云数据参考，非库存承诺」。

ΔE 实现=CIE76（`engine/color.ts` 同源算法，contracts 内复制纯函数——**服务端不 import engine**，双端一致测试锁死）。

## 9. 引擎接口（只定契约，实现消费归内核 P 任务）

三个 adapter 纯函数契约（contracts 冻结签名；daemon/前端实现，引擎零改动）：

```ts
/** stone → BaseSpec（排布间距）：sizeMm 是唯一物理依据 */
specOfStone(stone: StoneFile): { shapeId: 'round' | 'custom'; diameterMm: number; assetId?: string }
// shapeId='custom' 当且仅当 gemshapeRef 存在（assetId=gemshapeRef）；否则 'round'+sizeMm 圆包络。

/** stone → PaletteColor（调色板/ΔE 映射）：mapColors 最近邻换算直接可用 */
paletteColorOfStone(stone: StoneFile): { id: `stn-${stone.id}`; name: string; hex: string }

/** stone 贴图 → 渲染源（buildSvg <image> / renderGemsPng resolveAsset 消费） */
resolveStoneTexture(textureBytes: Uint8Array): { mime: 'image/png'; dataUrl: string; width: number; height: number }
// 形态与 daemon/src/shape-assets.ts assetResolverOf 产物同构（ShapeAssetSource.image）。
```

排布消费路径（接口约定，非实现）：尺寸 mm→`diameterMm`→`gridFromSpec` pitch/pairwise（`requiredCenterDistancePx` 圆包络——现有 v2 机制直接吃 stone.sizeMm）；颜色→`paletteColorOfStone` 入调色板→`mapColors` ΔE 映射；贴图→渲染 resolveAsset。策略设计器（内核 S6）的「钻规格表」= `stones.list` 投影（StonePick 列表）——本 change S0 契约是其硬前置。

## 10. 测试策略

- **contracts**：StoneFile/schema round-trip+坏输入 typed error（六条 gate 逐条：假宽高/超限/全透明/比例漂移/低分辨率/missing）；parseSku 三行段+稀疏行+malformed；CardCatalogDraft 校验。
- **daemon**：stones service 树操作（唯一名冲突/环不可能/path 派生）；stone_index 同事务一致性（写后即查+投影重建等价）；软删/硬删 blob ref_count GC；引用 missing 四态；import 幂等重跑（跳过已存在 SKU）；substitutes ΔE/尺寸排序确定性。
- **MCP**：readonly 直调/无授权写必拒（principal-forbidden）/proposal→grant→apply 全链/revision 漂移拒/CAS 重放拒（沿 W4.2 测试面复用）。
- **adapter**：specOfStone/paletteColorOfStone/resolveStoneTexture 纯函数单测（含 gemshapeRef 两分支）；ΔE 双端一致（contracts vs engine color.ts 同值断言）。
- **E2E 冒烟**：上传样卡 fixture（钰航两页缩样）→草表→import→后台网格可见→前台选择器可选→substitutes 返回。

## 11. 开放问题（不阻塞 S0-S2）

| # | 问题 | 默认（可推翻） |
|---|---|---|
| 1 | stone 库共享语义：admin 写/全员读 vs 按 owner 隔离 | 共享读+admin/授权桥写（沿「禁写不禁读+admin 豁免」）；多账户细化待 Owner |
| 2 | 色系分类标准（谁定分类法） | 草表建议+人审修正；不预设固定色系枚举 |
| 3 | 去背景首版质量：白底样卡阈值法对渐变底/反光钻的失败率 | 首版仅承诺白底样卡；失败 cell 报告留人工修图入口 |
| 4 | 钰航以外的供应商编码形态（前缀位次/非数字行号） | SupplierSkuProfile bands+styleKey 可扩；首个新供应商接入时定扩法 |
| 5 | 库存/采购字段是否提升一等（现 metadata） | 不提升；供应链管理另立 change |
| 6 | gemshapeRef 的自动配对（round cabochon 矢量 seed） | P1：sys-shapes 建 'dome' 轮廓 seed 后自动配；P0 手填 |
| 7 | SS 云数据建设时序与数据源（Preciosa/Swarovski 公开目录数字化） | 本 change 只冻结 CloudCatalogEntry 消费位 |
| 8 | views/ 实物照片的采集规范与用途（采购核对 vs 颜色校准） | 仅展示用途；颜色校准以 stone.color.rgb 为准 |
