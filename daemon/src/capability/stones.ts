/**
 * 装饰钻库 MCP 工具面（add-stone-library design §6/§9——S4.1-S4.4）。
 * 原始需求 2026-09-24（tasks.md S4）：八工具 = readonly（agent 直调）
 * stones.list/search/get/substitutes + approved-mutation（授权桥双模）
 * stone.create/update/delete/import。
 * 授权语义：**零新授权语义**——完整复用 W4.2 authorization.ts（proposal+preview_json
 * diff 预览→人工批准→grant→consumeForExecution→op_digest/revision CAS/TTL）；
 * 双模接法照 studio.generate（带参=发起 proposal；带 proposalId=执行）。
 * owner/审计面（W4.2 R1 P1-1 教训）：全部工具 taskId 必填，服务端以任务行
 * owner_id 作 stone_index/resources 的 owner 过滤与交叉校验（跨用户读写必拒）。
 * 正交意图：
 *   [1] readonly 查询面：list（filter/分页/groupBy/nearColor 排序）/search
 *       （关键字+ΔE+尺寸邻近组合）/get（stone.json 全文+四态标注）/substitutes
 *       （§9 ΔE+尺寸容差过滤、ΔE 升序 tie 用 supplier×sku 稳定序）。
 *   [2] 写工具授权桥双模：propose（diff 预览入库 preview_json）→answer→
 *       execute（consume→service 落库→settleExternal）。create/update/delete=
 *       同一 SQLite 事务（本地恰好一次，照 patch-apply）；import=consume→批执行
 *       →settle 三段（部分失败保留语义，幂等重跑收敛兜底崩溃窗口）。
 *   [3] S2 导入器薄 adapter：runCardImport 冻结接口类型 + 懒加载（S2 落地前
 *       缺席=typed 不可用态；deps.cardImportRunner 为测试/装配注入缝——S2
 *       落地后零改动接线）。
 *   [4] composeRegistries：多 registry 组合（内核把 studio.* 与本面合并为单一
 *       MCP 投影源——重名 fail fast）。
 * 偏差登记（报告面）：readonly 按 owner 隔离（brief S4 指令——design §6 字面的
 * 「共享读」为 §12-1 开放问题默认值，本面从严）；list 过滤在 listIndexRows 投影
 * 行上做 JS 过滤（S3.1 RPC 面再落 SQL 索引查询）。
 */
import { z } from 'zod';
import {
  CardCatalogDraftSchema,
  deltaE76,
  labFromRgb,
  parseSku,
  rgbToHex,
  RgbTupleSchema,
  SkuParsedSchema,
  StoneGridCellSchema,
  SubstituteQuerySchema,
  SupplierSkuProfileSchema,
  type CardCatalogDraft,
  type RgbTuple,
  type StoneFile,
  type SupplierSkuProfile,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import type { JobService } from '../jobs/service.js';
import { StoneService, type CreateStoneInput, type StoneIndexRow, type StonePatch } from '../stones/service.js';
import {
  DEFAULT_FAMILY,
  LOW_CONFIDENCE_THRESHOLD,
  runCardImport as runCardImportImpl,
  type CardImportOptions,
  type CardImportResult,
} from '../stones/importer.js';
import { gateStoneTexture } from '../stones/gates.js';
import type { ApprovalService, ConsumeDenyReason } from './authorization.js';
import { canonicalJson } from './authorization.js';
import type { ApprovedOpRow } from '../db/approvals.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from './core.js';
import { RUNAWAY_LIMIT } from './studio.js';

// ---------------------------------------------------------------- S2 导入器对接面（冻结接线）

/**
 * S2 导入器执行缝（runCardImport 冻结签名的一等类型——生产=静态接线真身；
 * deps.cardImportRunner 为测试/装配替身注入面，签名一致零改动切换）。
 * 幂等：supplier×sku 已存在全 skip、零新建（S2 保证收敛，S4 工具面实证）。
 */
export type CardImportRunner = (
  deps: { service: StoneService; blobs: BlobStore; db: SqliteDb },
  draft: CardCatalogDraft,
  options: CardImportOptions,
) => CardImportResult;

/** 生产执行器=S2 真身直连（静态接线——类型即对接证明，零 adapter 层）。 */
const defaultCardImportRunner: CardImportRunner = (deps, draft, options) => runCardImportImpl(deps, draft, options);

/**
 * propose 预览（结构级分类——不触源图/贴图管线）：existing（supplier×sku 全局
 * 唯一，含软删）→ skip；页声明/bbox 界内/同页重叠三结构失败可判；同码多格=
 * 变体命名组（首格裸码保位，其余执行期定名——§8.1 规则 6b 依赖贴图字节）；
 * 切格/去背景/同字节降级/ΔE 采样以执行报告为准（预览不猜测，显式注明边界）。
 */
function previewCardImport(db: SqliteDb, draft: CardCatalogDraft, targetSupplier: string): {
  newSkus: string[];
  skipped: Array<{ sku: string; reason: string }>;
  structuralFailures: Array<{ sku: string; reason: string }>;
  variantGroups: Array<{ sku: string; cells: number }>;
  families: string[];
  lowConfidence: Array<{ row: number; suggestedName: string; confidence: number }>;
} {
  const existing = new Set(
    (
      db.prepare('SELECT sku FROM stone_index WHERE supplier = ?').all(targetSupplier) as Array<{ sku: string }>
    ).map((row) => row.sku),
  );
  const newSkus: string[] = [];
  const skipped: Array<{ sku: string; reason: string }> = [];
  const structuralFailures: Array<{ sku: string; reason: string }> = [];
  const variantGroups: Array<{ sku: string; cells: number }> = [];
  const cellsOf = (page: number) => draft.sourceImage.pages.find((p) => p.page === page);
  const allCells = draft.styles.flatMap((style) => style.cells.map((cell) => ({ ...cell, row: style.row })));
  const skuCounts = new Map<string, number>();
  for (const cell of allCells) skuCounts.set(cell.sku, (skuCounts.get(cell.sku) ?? 0) + 1);
  const seenSku = new Set<string>();
  for (const cell of allCells) {
    const declared = cellsOf(cell.page);
    if (declared === undefined) {
      structuralFailures.push({ sku: cell.sku, reason: `page-not-declared：草表未声明 page=${cell.page}` });
      continue;
    }
    if (cell.bboxPx.x + cell.bboxPx.w > declared.widthPx || cell.bboxPx.y + cell.bboxPx.h > declared.heightPx) {
      structuralFailures.push({ sku: cell.sku, reason: `bbox-out-of-page：越出声明页界 ${declared.widthPx}×${declared.heightPx}` });
      continue;
    }
    if (existing.has(cell.sku)) {
      skipped.push({ sku: cell.sku, reason: 'supplier-sku-exists：幂等跳过（supplier×sku 已存在）' });
      seenSku.add(cell.sku);
      continue;
    }
    if ((skuCounts.get(cell.sku) ?? 0) > 1) {
      if (!seenSku.has(cell.sku)) {
        variantGroups.push({ sku: cell.sku, cells: skuCounts.get(cell.sku) as number });
        newSkus.push(cell.sku); // 首格裸码保位（草表出现序——§8.1 规则 6b）
        seenSku.add(cell.sku);
      }
      // 其余格：执行期按字节同异定 变体新建 / 源重复跳过——预览不猜测。
      continue;
    }
    newSkus.push(cell.sku);
  }
  return {
    newSkus,
    skipped,
    structuralFailures,
    variantGroups,
    families: [...new Set(draft.styles.map((style) => style.suggestedFamily || DEFAULT_FAMILY))],
    lowConfidence: draft.styles
      .filter((style) => style.confidence < LOW_CONFIDENCE_THRESHOLD || style.suggestedName.length === 0)
      .map((style) => ({ row: style.row, suggestedName: style.suggestedName, confidence: style.confidence })),
  };
}

// ---------------------------------------------------------------- 依赖

export interface StoneCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（approval-request/transcript——任务域工具必需）。 */
  jobs?: JobService;
  /** §3.6 授权桥（approved-mutation 面；缺省时按 core.ts 一律 principal-forbidden）。 */
  approvals?: ApprovalService;
  /** S2 导入器注入缝（测试/装配替身；缺省懒加载 ../stones/importer.js）。 */
  cardImportRunner?: CardImportRunner;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

// ---------------------------------------------------------------- 输入 schema

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（owner 绑定与审计链的上下文——结果集按任务归属用户过滤）');
const ResourceIdField = z.string().min(1).describe('钻原子目录行 id（resourceId=引用键）');
const BlobRefField = z.string().regex(/^[0-9a-f]{64}$/).describe('内容寻址 blob 引用（sha256）');
const ProposalIdField = z.string().min(1).describe('已批准 proposal id（执行模式——grant 服务端内部关联）');

const ListInputSchema = z.object({
  taskId: TaskIdField,
  supplier: z.string().min(1).optional(),
  family: z.string().min(1).optional(),
  sizeMm: z.number().positive().optional(),
  styleRow: z.number().int().optional(),
  sku: z.string().min(1).optional(),
  q: z.string().min(1).optional().describe('关键字（SKU/色名/色系/供应商/十六进制子串）'),
  nearColor: RgbTupleSchema.optional().describe('目标色（0-255）——结果按 ΔE 升序排序'),
  groupBy: z.enum(['family', 'sizeMm', 'style']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  includeTrashed: z.boolean().default(false),
});

const SearchInputSchema = z.object({
  taskId: TaskIdField,
  q: z.string().min(1).optional(),
  nearColor: RgbTupleSchema.optional(),
  maxDeltaE: z.number().positive().default(10),
  sizeMm: z.number().positive().optional(),
  sizeToleranceMm: z.number().min(0).default(0.5),
  supplier: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

const GetInputSchema = z.object({ taskId: TaskIdField, resourceId: ResourceIdField });

const SubstitutesInputSchema = z.object({
  taskId: TaskIdField,
  query: SubstituteQuerySchema.describe('sku | colorRgb+sizeMm 二选一（混给/缺给均拒——契约 strict 交叉拒斥）'),
});

const StoneCreateProposeSchema = z.object({
  supplierProfile: SupplierSkuProfileSchema.describe('供应商 SKU 编码档案（幂等 seed 供应商目录；supplier×sku 唯一性键）'),
  draft: z.object({
    name: z.string().min(1).describe('显示名（如「象牙白 · 2mm」）'),
    sku: z.string().min(1).describe('原始编码（如 J51——溯源键）'),
    skuParsed: SkuParsedSchema.optional().describe('parseSku 物化快照（缺省服务端按档案解析，失败留空不猜测）'),
    sizeMm: z.number().positive().nullable().describe('最大径 mm（客观真值；null=无尺寸声明显式态）'),
    color: z.object({
      name: z.string().min(1),
      rgb: RgbTupleSchema,
      family: z.string().min(1).describe('色系（逻辑分组，可重指）'),
      finish: z.string().min(1),
    }),
    shapeClass: z.string().min(1).optional(),
    gemshapeRef: z.string().min(1).optional(),
    views: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
  texture: z.object({
    blobRef: BlobRefField.describe('贴图 PNG 的 blob 引用（须先经上传面入库）'),
    declaredWidth: z.number().int().positive().describe('声明宽（gate 1 与解码实测对账基准）'),
    declaredHeight: z.number().int().positive(),
  }),
});

const StoneUpdateProposeSchema = z.object({
  resourceId: ResourceIdField,
  patch: z.object({
    name: z.string().min(1).optional(),
    sizeMm: z.number().positive().nullable().optional(),
    color: z
      .object({
        name: z.string().min(1).optional(),
        rgb: RgbTupleSchema.optional(),
        family: z.string().min(1).optional().describe('色系重指=同事务移目录+改投影'),
        finish: z.string().min(1).optional(),
      })
      .optional(),
    shapeClass: z.string().min(1).nullable().optional(),
    gemshapeRef: z.string().min(1).nullable().optional(),
    views: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional().describe('浅合并（键级覆盖）'),
  }),
  texture: z
    .object({
      blobRef: BlobRefField.describe('替换贴图（新内容新 hash——内容寻址，id 不变）'),
      declaredWidth: z.number().int().positive(),
      declaredHeight: z.number().int().positive(),
    })
    .optional(),
});

const StoneImportProposeSchema = z.object({
  draftRef: BlobRefField.describe('样卡草表 CardCatalogDraft JSON 的 blobRef（vision 代理产出）'),
  targetSupplier: z.string().min(1).optional().describe('目标供应商（缺省取草表 supplier——supplier×sku 唯一键的键半）'),
  familyOverrides: z
    .record(z.string().min(1), z.string().min(1))
    .optional()
    .describe('色系策略：suggestedFamily 原文→目标色系（键级覆盖，人审定组）'),
  fallbackFamily: z.string().min(1).optional().describe('suggestedFamily 为空时的兜底色系（缺省「未分组」）'),
});

/**
 * 双模外层 schema：执行模式（{taskId, proposalId}）与 propose 字段（其余键）
 * 互斥——外层全可选（两种形态都能过面），propose 齐备性由 handler 内以
 * *ProposeSchema 二次校验（执行模式误带 propose 字段=显式拒）。
 */
const CreateInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  supplierProfile: StoneCreateProposeSchema.shape.supplierProfile.optional(),
  draft: StoneCreateProposeSchema.shape.draft.optional(),
  texture: StoneCreateProposeSchema.shape.texture.optional(),
});

const UpdateInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  resourceId: ResourceIdField.optional(),
  patch: StoneUpdateProposeSchema.shape.patch.optional(),
  texture: StoneUpdateProposeSchema.shape.texture.optional(),
});

const DeleteInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  resourceId: ResourceIdField.optional(),
});

const ImportInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  draftRef: StoneImportProposeSchema.shape.draftRef.optional(),
  targetSupplier: StoneImportProposeSchema.shape.targetSupplier,
  familyOverrides: StoneImportProposeSchema.shape.familyOverrides,
  fallbackFamily: StoneImportProposeSchema.shape.fallbackFamily,
});

// ---------------------------------------------------------------- registry 组合

/**
 * 多 registry 组合为单一投影源（内核注册处把 studio.* 与 stones/stone.* 合并）。
 * 重名 fail fast（跨 registry 重名=编程错误）；调用路由到首个持有该名的 registry。
 */
export function composeRegistries(registries: readonly CapabilityRegistry[]): CapabilityRegistry {
  const seen = new Set<string>();
  for (const registry of registries) {
    for (const name of registry.names()) {
      if (seen.has(name)) throw new Error(`duplicate capability registration across registries: ${name}`);
      seen.add(name);
    }
  }
  const find = (name: string): CapabilityRegistry | undefined =>
    registries.find((registry) => registry.definitionOf(name) !== null);
  return {
    async call(name, input, principal) {
      const target = find(name);
      if (!target) return { kind: 'denied', reason: 'unsupported-capability', requestedOperation: name };
      return target.call(name, input, principal);
    },
    definitionOf: (name) => find(name)?.definitionOf(name) ?? null,
    describe: () => registries.flatMap((registry) => registry.describe()),
    names: () => registries.flatMap((registry) => [...registry.names()]),
  };
}

// ---------------------------------------------------------------- 字段级 diff（update 预览）

/** update propose 的可序列化 patch（贴图以 blobRef+声明宽高承载——字节不入 payload）。 */
type SerializableStonePatch = Omit<StonePatch, 'texture'>;

interface FieldDiff {
  field: string;
  before: unknown;
  after: unknown;
}

/** 字段级 before/after（只列发生变化的字段——空 patch=无 diff，propose 拒绝）。 */
function diffOfPatch(stone: StoneFile, patch: SerializableStonePatch): FieldDiff[] {
  const diff: FieldDiff[] = [];
  if (patch.name !== undefined && patch.name !== stone.name) diff.push({ field: 'name', before: stone.name, after: patch.name });
  if (patch.sizeMm !== undefined && patch.sizeMm !== stone.sizeMm) diff.push({ field: 'sizeMm', before: stone.sizeMm, after: patch.sizeMm });
  for (const key of ['name', 'rgb', 'family', 'finish'] as const) {
    const next = patch.color?.[key];
    if (next !== undefined && next !== stone.color[key]) {
      diff.push({ field: `color.${key}`, before: stone.color[key], after: next });
    }
  }
  if (patch.shapeClass !== undefined) {
    const next = patch.shapeClass ?? undefined;
    if (next !== (stone.shapeClass ?? undefined)) diff.push({ field: 'shapeClass', before: stone.shapeClass ?? null, after: patch.shapeClass });
  }
  if (patch.gemshapeRef !== undefined) {
    const next = patch.gemshapeRef ?? undefined;
    if (next !== (stone.gemshapeRef ?? undefined)) diff.push({ field: 'gemshapeRef', before: stone.gemshapeRef ?? null, after: patch.gemshapeRef });
  }
  if (patch.views !== undefined && JSON.stringify(patch.views) !== JSON.stringify(stone.views ?? [])) {
    diff.push({ field: 'views', before: stone.views ?? [], after: patch.views });
  }
  if (patch.metadata !== undefined) {
    const beforeKeys = new Set(Object.keys(stone.metadata));
    const afterKeys = new Set([...Object.keys(patch.metadata), ...beforeKeys]);
    const merged: Record<string, unknown> = { ...stone.metadata, ...patch.metadata };
    const changed = [...afterKeys].filter((key) => JSON.stringify(merged[key]) !== JSON.stringify(stone.metadata[key]));
    if (changed.length > 0) {
      diff.push({
        field: 'metadata',
        before: Object.fromEntries(changed.map((key) => [key, stone.metadata[key] ?? null])),
        after: Object.fromEntries(changed.map((key) => [key, merged[key] ?? null])),
      });
    }
  }
  return diff;
}

// ---------------------------------------------------------------- 工具面构造

export function createStoneCapabilities(deps: StoneCapabilitiesDeps): CapabilityRegistry {
  const stones = new StoneService({ db: deps.db, blobs: deps.blobs });
  const streaks = new Map<string, { key: string; count: number }>();

  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return { kind: 'failed', code: 'INVALID_OPERATION', message: `熔断：${reason}。请停止重试，向用户报告失败原因。` };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  function requireApprovals(): ApprovalService {
    if (!deps.approvals) throw new Error('授权桥未装配（approved-mutation 面不可用）');
    return deps.approvals;
  }

  /** 任务行校验（owner 绑定面——studio.ts requireAgentTask 同语义本地面）。 */
  function agentTaskOf(taskId: string): { ownerId: string; sessionId: string | null } {
    const task = deps.db
      .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
    return { ownerId: task.owner_id, sessionId: task.session_id };
  }

  /** resourceId → owner 交叉校验（P1-1：跨用户资源读写必拒）。 */
  function ownedResourceOf(taskId: string, resourceId: string): { ownerId: string; taskOwnerId: string } {
    const task = agentTaskOf(taskId);
    const row = deps.db
      .prepare('SELECT owner_id FROM resources WHERE id = ?')
      .get(resourceId) as { owner_id: string } | undefined;
    if (!row) throw new Error(`资源不存在：${resourceId}`);
    if (row.owner_id !== task.ownerId) {
      throw new Error('资源不属于当前任务归属用户（跨用户资源访问必拒）');
    }
    return { ownerId: row.owner_id, taskOwnerId: task.ownerId };
  }

  function bucketOf(input: unknown): string {
    const taskId = (input as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : 'global';
  }

  function failedOf(reason: ConsumeDenyReason | string, message: string): CapabilityCallResult {
    const code =
      reason === 'stale-revision' ? ('STALE' as const) : reason === 'concurrent' ? ('CONFLICT' as const) : ('INVALID_OPERATION' as const);
    return { kind: 'failed', code, message };
  }

  /** 双模判定（type guard）：proposalId 在场=执行模式；否则 propose 模式（字段齐备性 handler 校）。 */
  function isExecuteMode<T extends { proposalId?: string }>(parsed: T): parsed is T & { proposalId: string } {
    return parsed.proposalId !== undefined;
  }

  function previewBlob(doc: unknown): string {
    return deps.blobs.put(new Uint8Array(Buffer.from(canonicalJson(doc), 'utf8'))).hash;
  }

  function payloadOf(op: ApprovedOpRow): Record<string, unknown> {
    try {
      return JSON.parse(op.payload_json as string) as Record<string, unknown>;
    } catch {
      throw new Error(`proposal 载荷不可解析：${op.proposal_id}`);
    }
  }

  /**
   * 本地恰好一次执行壳（create/update/delete——照 patch-apply）：consume→落库→
   * settleExternal 同一 SQLite 事务。fn 必须同步（better-sqlite3 事务纪律）。
   * 返回值携带 resultRef 时写入 op.result_ref（create=resourceId / import=reportRef）。
   */
  function executeApprovedLocal(
    tool: string,
    input: { taskId: string; proposalId: string },
    fn: (ctx: { op: ApprovedOpRow; payload: Record<string, unknown> }) => { value: Record<string, unknown>; resultRef?: string },
  ): CapabilityCallResult {
    const approvals = requireApprovals();
    const task = agentTaskOf(input.taskId);
    const tx = deps.db.transaction((): CapabilityCallResult => {
      const consume = approvals.consumeForExecution({
        proposalId: input.proposalId,
        taskId: input.taskId,
        userId: task.ownerId,
        tool,
      });
      if (!consume.ok) return failedOf(consume.reason, consume.message);
      const ctx = { op: consume.op, payload: payloadOf(consume.op) };
      const { value, resultRef } = fn(ctx);
      approvals.settleExternal(input.proposalId, resultRef !== undefined ? { kind: 'succeeded', resultRef } : { kind: 'succeeded' });
      return { kind: 'ok', value };
    });
    return tx();
  }

  /**
   * import 执行壳（三段：consume → 批执行 → settle）：S2 导入器逐 cell 落库
   * （各 cell 经 service 自身事务），部分失败=成功行保留+失败清单（§1.6 批量
   * 语义）；崩溃窗口由 recoverNonTerminal 收敛 unknown + 幂等重跑收敛兜底。
   */
  function executeApprovedImport(input: { taskId: string; proposalId: string }): CapabilityCallResult {
    const approvals = requireApprovals();
    const task = agentTaskOf(input.taskId);
    const consume = approvals.consumeForExecution({
      proposalId: input.proposalId,
      taskId: input.taskId,
      userId: task.ownerId,
      tool: 'stone.import',
    });
    if (!consume.ok) return failedOf(consume.reason, consume.message);
    try {
      const payload = payloadOf(consume.op);
      const draftRef = payload['draftRef'];
      if (typeof draftRef !== 'string') throw new Error('proposal 载荷缺 draftRef（数据不一致）');
      const options = payload['options'] as CardImportOptions | undefined;
      if (options === undefined || typeof options.targetSupplier !== 'string' || options.targetSupplier.length === 0) {
        throw new Error('proposal 载荷 options.targetSupplier 缺失（数据不一致）');
      }
      const draftBytes = deps.blobs.read(draftRef);
      if (draftBytes === null) throw new Error(`草表 blob 不存在：${draftRef.slice(0, 12)}…`);
      const draftParsed = CardCatalogDraftSchema.safeParse(JSON.parse(draftBytes.toString('utf8')));
      if (!draftParsed.success) {
        throw new Error(`草表不符 CardCatalogDraft 契约：${draftParsed.error.issues.slice(0, 3).map((i) => i.message).join('; ')}`);
      }
      const runner = deps.cardImportRunner ?? defaultCardImportRunner;
      const result = runner({ service: stones, blobs: deps.blobs, db: deps.db }, draftParsed.data, options);
      approvals.settleExternal(input.proposalId, { kind: 'succeeded', resultRef: result.reportRef });
      deps.jobs?.emitFor(input.taskId, 'transcript', {
        role: 'tool',
        text: `样卡导入完成：新建 ${result.created.length}、跳过 ${result.skipped.length}、失败 ${result.failed.length}、待渲染 ${result.pendingDowngrades.length}（报告 blobRef=${result.reportRef.slice(0, 12)}…）`,
      });
      return {
        kind: 'ok',
        value: {
          created: result.created.length,
          createdResourceIds: result.created,
          skipped: result.skipped,
          failed: result.failed,
          pendingDowngrades: result.pendingDowngrades,
          lowConfidenceCount: result.lowConfidence.length,
          reportRef: result.reportRef,
        },
      };
    } catch (error) {
      approvals.settleExternal(input.proposalId, { kind: 'failed', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  // -------------------------------------------------------------- 查询底座（readonly 共用）

  function hexToRgb(hex: string): RgbTuple {
    return [Number.parseInt(hex.slice(1, 3), 16), Number.parseInt(hex.slice(3, 5), 16), Number.parseInt(hex.slice(5, 7), 16)];
  }

  function deltaEAgainst(target: RgbTuple, hex: string): number {
    const a = labFromRgb(target[0], target[1], target[2]);
    const b = labFromRgb(hexToRgb(hex)[0], hexToRgb(hex)[1], hexToRgb(hex)[2]);
    return deltaE76(a, b);
  }

  /** 确定性比较器：主键升序，tie 用 supplier×sku 稳定序。 */
  function byStableOrder<T>(rows: T[], key: (row: T) => number, supplier: (row: T) => string, sku: (row: T) => string): T[] {
    return [...rows].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka !== kb) return ka - kb;
      const sa = supplier(a);
      const sb = supplier(b);
      if (sa !== sb) return sa < sb ? -1 : 1;
      return sku(a) < sku(b) ? -1 : sku(a) > sku(b) ? 1 : 0;
    });
  }

  /** 投影行 → 网格单元（StoneGridCell 契约——name 由 style×size 合成）。 */
  function gridCellOf(row: StoneIndexRow): z.infer<typeof StoneGridCellSchema> {
    const name = row.size_mm !== null ? `${row.style_name ?? row.sku} · ${row.size_mm}mm` : (row.style_name ?? row.sku);
    return {
      resourceId: row.resource_id,
      sku: row.sku,
      supplier: row.supplier,
      name,
      styleName: row.style_name ?? '',
      family: row.family,
      sizeMm: row.size_mm,
      colorHex: row.color_hex,
      finish: row.finish ?? '',
      textureUrl: `/api/stones/${row.resource_id}/texture.png`,
      trashed: row.trashed === 1,
      updatedAt: row.updated_at,
    };
  }

  interface ListCriteria {
    supplier?: string;
    family?: string;
    sizeMm?: number;
    styleRow?: number;
    sku?: string;
    q?: string;
    includeTrashed?: boolean;
  }

  /** owner 过滤 + 条件过滤（listIndexRows 已按 supplier,sku 稳定序——过滤保序）。 */
  function filterRows(ownerId: string, rows: StoneIndexRow[], criteria: ListCriteria): StoneIndexRow[] {
    return rows.filter((row) => {
      if (row.owner_id !== ownerId) return false;
      if (!criteria.includeTrashed && row.trashed === 1) return false;
      if (criteria.supplier !== undefined && row.supplier !== criteria.supplier) return false;
      if (criteria.family !== undefined && row.family !== criteria.family) return false;
      if (criteria.sizeMm !== undefined && row.size_mm !== criteria.sizeMm) return false;
      if (criteria.styleRow !== undefined && row.style_row !== criteria.styleRow) return false;
      if (criteria.sku !== undefined && row.sku !== criteria.sku) return false;
      if (criteria.q !== undefined) {
        const needle = criteria.q.toLowerCase();
        const haystack = [row.sku, row.supplier, row.family, row.style_name ?? '', row.color_hex].join('\u0000').toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      return true;
    });
  }

  function groupKeyOf(row: StoneIndexRow, groupBy: 'family' | 'sizeMm' | 'style'): string {
    if (groupBy === 'family') return row.family;
    if (groupBy === 'sizeMm') return row.size_mm !== null ? String(row.size_mm) : '未声明';
    return row.style_row !== null ? `row-${row.style_row}` : '未编行';
  }

  // -------------------------------------------------------------- 引用面（delete 预览）

  /**
   * 引用面扫描：今日注册载体=meta.kind='stone-set' 文件行（S7 组合层）。
   * LayoutDocument/策略工件对 stone 的引用归内核 P 任务（StonePick 落地时在此登记）。
   */
  function referenceFaceOf(resourceId: string, ownerId: string): Array<{ kind: 'stone-set'; resourceId: string; name: string }> {
    const rows = deps.db
      .prepare("SELECT id, name, content_hash FROM resources WHERE is_dir = 0 AND owner_id = ? AND meta LIKE '%\"kind\":\"stone-set\"%'")
      .all(ownerId) as Array<{ id: string; name: string; content_hash: string | null }>;
    const hits: Array<{ kind: 'stone-set'; resourceId: string; name: string }> = [];
    for (const row of rows) {
      if (row.content_hash === null) continue;
      const bytes = deps.blobs.read(row.content_hash);
      if (bytes === null) continue;
      try {
        const parsed = JSON.parse(bytes.toString('utf8')) as { stones?: Array<{ stoneRef?: unknown }> };
        if (Array.isArray(parsed.stones) && parsed.stones.some((member) => member.stoneRef === resourceId)) {
          hits.push({ kind: 'stone-set', resourceId: row.id, name: row.name });
        }
      } catch {
        // 损坏的 set 行不放大——引用面扫描跳过（解析态归 S7 读面）。
      }
    }
    return hits;
  }

  // -------------------------------------------------------------- 八工具定义

  const definitions: CapabilityDefinition[] = [
    {
      name: 'stones.list',
      description:
        '装饰钻库浏览（只读）：按 供应商/色系/尺寸/款式行/SKU/关键字 过滤 + 分页 + 分组键投影；'
        + 'nearColor 给定时结果按 ΔE(CIE76) 升序排序。结果集按任务归属用户隔离。',
      authority: 'readonly' as const,
      input: ListInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ListInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, 'stones.list', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const task = agentTaskOf(p.taskId);
          let rows = filterRows(task.ownerId, stones.listIndexRows(), p);
          if (p.nearColor !== undefined) {
            const target = p.nearColor;
            rows = byStableOrder(
              rows,
              (row) => deltaEAgainst(target, row.color_hex),
              (row) => row.supplier,
              (row) => row.sku,
            );
          }
          const total = rows.length;
          const pageRows = rows.slice((p.page - 1) * p.pageSize, p.page * p.pageSize);
          const groupBy = p.groupBy;
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              cells: pageRows.map(gridCellOf),
              total,
              page: p.page,
              pageSize: p.pageSize,
              ...(groupBy !== undefined
                ? {
                    groupKeys: [...new Set(rows.map((row) => groupKeyOf(row, groupBy)))].sort((a, b) =>
                      a < b ? -1 : a > b ? 1 : 0,
                    ),
                  }
                : {}),
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'stones.list', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'stones.search',
      description:
        '装饰钻搜索（只读）：关键字 + ΔE 邻近（nearColor，CIE76≤maxDeltaE）+ 尺寸邻近（|sizeMm 差|≤sizeToleranceMm）'
        + '组合查询——三者至少给一。nearColor 在场按 ΔE 升序（tie 用 supplier×sku 稳定序），否则按尺寸差升序。',
      authority: 'readonly' as const,
      input: SearchInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SearchInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, 'stones.search', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        if (p.q === undefined && p.nearColor === undefined && p.sizeMm === undefined) {
          return noteFailure(bucket, 'stones.search', '至少给一个查询条件（q/nearColor/sizeMm）——不猜测全量浏览意图（浏览用 stones.list）');
        }
        try {
          const task = agentTaskOf(p.taskId);
          let rows = filterRows(task.ownerId, stones.listIndexRows(), {
            ...(p.supplier !== undefined ? { supplier: p.supplier } : {}),
            ...(p.q !== undefined ? { q: p.q } : {}),
          });
          if (p.sizeMm !== undefined) {
            const size = p.sizeMm;
            rows = rows.filter((row) => row.size_mm !== null && Math.abs(row.size_mm - size) <= p.sizeToleranceMm);
          }
          if (p.nearColor !== undefined) {
            const target = p.nearColor;
            rows = byStableOrder(
              rows.filter((row) => deltaEAgainst(target, row.color_hex) <= p.maxDeltaE),
              (row) => deltaEAgainst(target, row.color_hex),
              (row) => row.supplier,
              (row) => row.sku,
            );
          } else {
            const size = p.sizeMm as number;
            rows = byStableOrder(
              rows,
              (row) => Math.abs((row.size_mm ?? size) - size),
              (row) => row.supplier,
              (row) => row.sku,
            );
          }
          noteSuccess(bucket);
          return { kind: 'ok', value: { cells: rows.slice(0, p.limit).map(gridCellOf), total: rows.length } };
        } catch (error) {
          return noteFailure(bucket, 'stones.search', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'stones.get',
      description:
        '单钻详情（只读）：stone.json 全文 + revision + 路径 + 贴图 URL/尺寸 + 引用解析四态标注'
        + '（resolved/soft-deleted/blob-missing/wrong-kind——not-found 为硬清后第五态）。软删态可读（回收站详情）。',
      authority: 'readonly' as const,
      input: GetInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = GetInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, 'stones.get', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          ownedResourceOf(p.taskId, p.resourceId); // owner 交叉校验（跨用户必拒）
          const resolution = stones.resolveStoneRef(p.resourceId);
          if (resolution.state !== 'resolved' && resolution.state !== 'soft-deleted') {
            noteSuccess(bucket);
            return { kind: 'ok', value: { resourceId: p.resourceId, state: resolution.state } };
          }
          try {
            const detail = stones.getStone(p.resourceId);
            noteSuccess(bucket);
            return {
              kind: 'ok',
              value: {
                resourceId: p.resourceId,
                state: resolution.state,
                revision: detail.revision,
                path: detail.path,
                trashed: detail.trashed,
                stone: detail.stone,
                texture: {
                  blobRef: detail.texture.blobRef,
                  width: detail.texture.width,
                  height: detail.texture.height,
                  textureUrl: `/api/stones/${p.resourceId}/texture.png`,
                },
              },
            };
          } catch {
            // resolve 与 get 竞态窗口（blob 在两步之间消失）——以解析态为准呈现。
            noteSuccess(bucket);
            return { kind: 'ok', value: { resourceId: p.resourceId, state: resolution.state } };
          }
        } catch (error) {
          return noteFailure(bucket, 'stones.get', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'stones.substitutes',
      description:
        '缺钻替代查询（只读，§9）：sku 或 colorRgb+sizeMm 二选一定基准；库内按 ΔE≤maxDeltaE(默认10) 且 '
        + '|尺寸差|≤sizeToleranceMm(默认0.5) 过滤，ΔE 升序返回（tie 用 supplier×sku 稳定序）。基准自身排除。',
      authority: 'readonly' as const,
      input: SubstitutesInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SubstitutesInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, 'stones.substitutes', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const task = agentTaskOf(p.taskId);
          let basis: { sku: string; resourceId: string | null; rgb: RgbTuple; sizeMm: number };
          if ('sku' in p.query) {
            const rows = filterRows(task.ownerId, stones.listIndexRows(), { sku: p.query.sku, supplier: p.query.supplier });
            const row = rows[0];
            if (row === undefined) {
              return noteFailure(bucket, 'stones.substitutes', `库内（任务归属范围）未找到 SKU=${p.query.sku}——无法定替代基准`);
            }
            const resolution = stones.resolveStoneRef(row.resource_id);
            if (resolution.state !== 'resolved' || resolution.stone === undefined) {
              return noteFailure(bucket, 'stones.substitutes', `基准钻不可解析（state=${resolution.state}）：${p.query.sku}`);
            }
            if (resolution.stone.sizeMm === null) {
              return noteFailure(bucket, 'stones.substitutes', `基准钻无尺寸声明（sizeMm=null）——无替代基准，不猜测`);
            }
            basis = { sku: row.sku, resourceId: row.resource_id, rgb: resolution.stone.color.rgb, sizeMm: resolution.stone.sizeMm };
          } else {
            basis = { sku: '(color-basis)', resourceId: null, rgb: p.query.colorRgb, sizeMm: p.query.sizeMm };
          }
          const tolerance = p.query.sizeToleranceMm;
          const maxDeltaE = p.query.maxDeltaE;
          const candidates = byStableOrder(
            stones
              .listIndexRows()
              .filter(
                (row) =>
                  row.owner_id === task.ownerId &&
                  row.trashed === 0 &&
                  row.resource_id !== basis.resourceId &&
                  row.size_mm !== null &&
                  Math.abs(row.size_mm - basis.sizeMm) <= tolerance &&
                  (p.query.supplier === undefined || row.supplier === p.query.supplier) &&
                  deltaEAgainst(basis.rgb, row.color_hex) <= maxDeltaE,
              )
              .map((row) => ({ row, deltaE: deltaEAgainst(basis.rgb, row.color_hex) })),
            (entry) => entry.deltaE,
            (entry) => entry.row.supplier,
            (entry) => entry.row.sku,
          );
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              basis: { sku: basis.sku, rgb: basis.rgb, sizeMm: basis.sizeMm, colorHex: rgbToHex(basis.rgb) },
              maxDeltaE,
              sizeToleranceMm: tolerance,
              results: candidates.map(({ row, deltaE }) => ({
                resourceId: row.resource_id,
                sku: row.sku,
                supplier: row.supplier,
                name: gridCellOf(row).name,
                sizeMm: row.size_mm,
                colorHex: row.color_hex,
                deltaE: Math.round(deltaE * 1000) / 1000,
                sizeDiffMm: Math.round(Math.abs((row.size_mm ?? 0) - basis.sizeMm) * 1000) / 1000,
              })),
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'stones.substitutes', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'stone.create',
      description:
        '建钻原子（approved-mutation 双模）：带 supplierProfile/draft/texture = 发起 proposal（贴图六 gate 预检+'
        + '新原子字段全量预览；批准前库内零变更）；带 proposalId = 执行已批准的创建（grant 消费+四步同事务落库）。',
      authority: 'approved-mutation' as const,
      input: CreateInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = CreateInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            'stone.create',
            `参数不合法（双模：发起={taskId,supplierProfile,draft,texture} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.supplierProfile !== undefined || p.draft !== undefined || p.texture !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            const outcome = executeApprovedLocal('stone.create', p, ({ payload, op }) => {
              const textureRef = payload['texture'] as { blobRef?: string; declaredWidth?: number; declaredHeight?: number };
              if (typeof textureRef?.blobRef !== 'string' || typeof textureRef.declaredWidth !== 'number' || typeof textureRef.declaredHeight !== 'number') {
                throw new Error('proposal 载荷 texture 引用不完整（数据不一致）');
              }
              const bytes = deps.blobs.read(textureRef.blobRef);
              if (bytes === null) throw new Error(`贴图 blob 不存在：${textureRef.blobRef.slice(0, 12)}…`);
              const draft = payload['draft'] as Record<string, unknown>;
              const result = stones.createStone({
                ownerId: op.user_id,
                supplierProfile: payload['supplierProfile'] as SupplierSkuProfile,
                draft: {
                  ...draft,
                  texture: { declaredWidth: textureRef.declaredWidth, declaredHeight: textureRef.declaredHeight },
                } as CreateStoneInput['draft'],
                textureBytes: bytes,
              });
              return {
                value: { resourceId: result.resourceId, stoneId: result.stoneId, revision: result.revision, path: result.path, sku: draft['sku'] },
                resultRef: result.resourceId,
              };
            });
            if (outcome.kind === 'ok') noteSuccess(bucket);
            return outcome;
          }
          // ---- propose 模式：gate 预检 + 唯一性前置 + diff 预览（新原子字段全量）。
          const proposeParsed = StoneCreateProposeSchema.safeParse(p);
          if (!proposeParsed.success) {
            throw new Error(
              `发起模式需 {taskId, supplierProfile, draft, texture}（缺一不可——不猜测）：${proposeParsed.error.issues.map((i) => i.message).join('; ')}`,
            );
          }
          const propose = proposeParsed.data;
          const task = agentTaskOf(p.taskId);
          const profile = SupplierSkuProfileSchema.parse(propose.supplierProfile);
          const clash = deps.db
            .prepare('SELECT 1 AS hit FROM stone_index WHERE supplier = ? AND sku = ?')
            .get(profile.supplier, propose.draft.sku);
          if (clash !== undefined) {
            throw new Error(`supplier×sku 已存在：${profile.supplier}/${propose.draft.sku}（唯一性冲突——更新请走 stone.update）`);
          }
          const bytes = deps.blobs.read(propose.texture.blobRef);
          if (bytes === null) throw new Error(`贴图 blob 不存在：${propose.texture.blobRef.slice(0, 12)}…（先经上传面入库）`);
          const gate = gateStoneTexture({
            bytes,
            declaredWidth: propose.texture.declaredWidth,
            declaredHeight: propose.texture.declaredHeight,
            shapeClass: propose.draft.shapeClass ?? 'round',
            sizeMm: propose.draft.sizeMm,
          });
          const skuParsed =
            propose.draft.skuParsed ??
            (() => {
              const result = parseSku(profile, propose.draft.sku);
              return result.ok ? { row: result.row, prefix: result.prefix, sizeMm: result.sizeMm } : undefined;
            })();
          const newAtom = {
            supplier: profile.supplier,
            sku: propose.draft.sku,
            ...(skuParsed !== undefined ? { skuParsed } : {}),
            sizeMm: propose.draft.sizeMm,
            color: propose.draft.color,
            shapeClass: propose.draft.shapeClass ?? 'round',
            ...(propose.draft.gemshapeRef !== undefined ? { gemshapeRef: propose.draft.gemshapeRef } : {}),
            ...(propose.draft.views !== undefined ? { views: propose.draft.views } : {}),
            metadata: propose.draft.metadata ?? {},
            texture: { width: gate.width, height: gate.height, alphaBounds: gate.alphaBounds },
          };
          const before = previewBlob({ note: 'stone-create', exists: false, supplier: profile.supplier, sku: propose.draft.sku });
          const after = previewBlob({ note: 'stone-create', atom: newAtom });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: task.ownerId,
            tool: 'stone.create',
            payload: {
              kind: 'stone-create',
              supplierProfile: profile,
              draft: propose.draft,
              texture: {
                blobRef: propose.texture.blobRef,
                declaredWidth: propose.texture.declaredWidth,
                declaredHeight: propose.texture.declaredHeight,
              },
            },
            preview: { before, after },
            summary: `新建钻原子 ${profile.supplier}/${propose.draft.sku}（${propose.draft.color.name} · ${propose.draft.sizeMm ?? '?'}mm，贴图 ${gate.width}×${gate.height} 实测过六 gate）`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              preview: { newAtom, previewBlobs: { before, after } },
              pending: '等待用户批准（approval-request 已入任务帧流；批准前库内零变化）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'stone.create', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'stone.update',
      description:
        '更新钻原子（approved-mutation 双模）：带 resourceId/patch = 发起 proposal（字段级 diff 预览——baseRevision+'
        + '前后值；贴图替换含 gate 实测）；带 proposalId = 执行（revision CAS 漂移必拒；色系重指同事务移目录）。',
      authority: 'approved-mutation' as const,
      input: UpdateInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = UpdateInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            'stone.update',
            `参数不合法（双模：发起={taskId,resourceId,patch[,texture]} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.resourceId !== undefined || p.patch !== undefined || p.texture !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            const outcome = executeApprovedLocal('stone.update', p, ({ payload, op }) => {
              const resourceId = payload['resourceId'] as string;
              const patch: StonePatch = { ...(payload['patch'] as SerializableStonePatch) };
              const textureRef = payload['texture'] as { blobRef?: string; declaredWidth?: number; declaredHeight?: number } | undefined;
              if (textureRef !== undefined) {
                if (typeof textureRef.blobRef !== 'string' || typeof textureRef.declaredWidth !== 'number' || typeof textureRef.declaredHeight !== 'number') {
                  throw new Error('proposal 载荷 texture 引用不完整（数据不一致）');
                }
                const bytes = deps.blobs.read(textureRef.blobRef);
                if (bytes === null) throw new Error(`贴图 blob 不存在：${textureRef.blobRef.slice(0, 12)}…`);
                patch.texture = { bytes, declaredWidth: textureRef.declaredWidth, declaredHeight: textureRef.declaredHeight };
              }
              const result = stones.updateStone(resourceId, patch, { baseRevision: op.base_revision ?? 0 });
              return { value: { resourceId, revision: result.revision, path: result.path }, resultRef: resourceId };
            });
            if (outcome.kind === 'ok') noteSuccess(bucket);
            return outcome;
          }
          // ---- propose 模式：字段级 diff（baseRevision+前后值）。
          const proposeParsed = StoneUpdateProposeSchema.safeParse(p);
          if (!proposeParsed.success) {
            throw new Error(
              `发起模式需 {taskId, resourceId, patch}（缺一不可——不猜测）：${proposeParsed.error.issues.map((i) => i.message).join('; ')}`,
            );
          }
          const propose = proposeParsed.data;
          const owned = ownedResourceOf(p.taskId, propose.resourceId);
          const detail = stones.getStone(propose.resourceId);
          if (detail.trashed) throw new Error('目标原子在回收站内（先恢复再更新——回收站内不改真值）');
          const diff = diffOfPatch(detail.stone, propose.patch);
          if (propose.texture !== undefined) {
            const bytes = deps.blobs.read(propose.texture.blobRef);
            if (bytes === null) throw new Error(`贴图 blob 不存在：${propose.texture.blobRef.slice(0, 12)}…`);
            const gate = gateStoneTexture({
              bytes,
              declaredWidth: propose.texture.declaredWidth,
              declaredHeight: propose.texture.declaredHeight,
              shapeClass: propose.patch.shapeClass ?? detail.stone.shapeClass ?? 'round',
              sizeMm: propose.patch.sizeMm !== undefined ? propose.patch.sizeMm : detail.stone.sizeMm,
            });
            diff.push({
              field: 'texture',
              before: { width: detail.stone.texture.width, height: detail.stone.texture.height, alphaBounds: detail.stone.texture.alphaBounds },
              after: { width: gate.width, height: gate.height, alphaBounds: gate.alphaBounds },
            });
          }
          if (diff.length === 0) throw new Error('patch 为空 diff（无字段变化——不发起空 proposal）');
          const before = previewBlob({ note: 'stone-update', resourceId: propose.resourceId, baseRevision: detail.revision, fields: Object.fromEntries(diff.map((d) => [d.field, d.before])) });
          const after = previewBlob({ note: 'stone-update', resourceId: propose.resourceId, baseRevision: detail.revision, fields: Object.fromEntries(diff.map((d) => [d.field, d.after])) });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: owned.taskOwnerId,
            tool: 'stone.update',
            resourceId: propose.resourceId,
            baseRevision: detail.revision,
            payload: {
              kind: 'stone-update',
              resourceId: propose.resourceId,
              patch: propose.patch,
              ...(propose.texture !== undefined ? { texture: propose.texture } : {}),
            },
            preview: { before, after },
            summary: `更新钻原子 ${detail.stone.supplier}/${detail.stone.sku}（${diff.map((d) => d.field).join('、')}，base v${detail.revision}）`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              diff: { baseRevision: detail.revision, fields: diff, previewBlobs: { before, after } },
              pending: '等待用户批准（approval-request 已入任务帧流；批准期间资源被改=revision CAS 必拒）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'stone.update', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'stone.delete',
      description:
        '软删钻原子（approved-mutation 双模——回收站语义，硬删=后台人工）：带 resourceId = 发起 proposal（目标原子'
        + '+引用面预览——谁在引用它）；带 proposalId = 执行（递归盖戳+投影 trashed=1，revision CAS 防漂移）。',
      authority: 'approved-mutation' as const,
      input: DeleteInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = DeleteInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            'stone.delete',
            `参数不合法（双模：发起={taskId,resourceId} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.resourceId !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（resourceId 与 proposalId 互斥）');
            }
            const outcome = executeApprovedLocal('stone.delete', p, ({ payload }) => {
              const resourceId = payload['resourceId'] as string;
              const result = stones.softDelete(resourceId);
              return {
                value: { resourceId, trashedRows: result.trashedRows, trashedStones: result.trashedStones, note: '软删=回收站语义（恢复走后台；硬删=人工）' },
                resultRef: resourceId,
              };
            });
            if (outcome.kind === 'ok') noteSuccess(bucket);
            return outcome;
          }
          if (p.resourceId === undefined) throw new Error('发起模式需 {taskId, resourceId}（缺一不可——不猜测）');
          const owned = ownedResourceOf(p.taskId, p.resourceId);
          const detail = stones.getStone(p.resourceId);
          if (detail.trashed) throw new Error('目标原子已在回收站内（幂等拒绝——不重复盖戳）');
          const references = referenceFaceOf(p.resourceId, owned.ownerId);
          const target = {
            resourceId: p.resourceId,
            supplier: detail.stone.supplier,
            sku: detail.stone.sku,
            name: detail.stone.name,
            path: detail.path,
            revision: detail.revision,
          };
          const before = previewBlob({ note: 'stone-delete', target, references });
          const after = previewBlob({ note: 'stone-delete', target: { ...target, trashed: true }, references });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: owned.taskOwnerId,
            tool: 'stone.delete',
            resourceId: p.resourceId,
            baseRevision: detail.revision,
            payload: { kind: 'stone-delete', resourceId: p.resourceId },
            preview: { before, after },
            summary: `软删钻原子 ${detail.stone.supplier}/${detail.stone.sku}（${detail.path}；引用面 ${references.length} 项）`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              target,
              references,
              previewBlobs: { before, after },
              pending: '等待用户批准（软删=回收站语义；硬删走后台人工）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'stone.delete', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'stone.import',
      description:
        '样卡批量导入（approved-mutation 双模，§8）：带 draftRef = 发起 proposal（N 新原子/色系分组/低置信项清单预览'
        + '——CardCatalogDraft 经 S2 导入器 dryRun）；带 proposalId = 执行（单 proposal 整批落库；执行报告 reportRef 入 '
        + 'result_ref；幂等重跑=已存在 SKU 全 skip 收敛）。',
      authority: 'approved-mutation' as const,
      input: ImportInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ImportInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            'stone.import',
            `参数不合法（双模：发起={taskId,draftRef[,targetSupplier]} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.draftRef !== undefined || p.targetSupplier !== undefined || p.familyOverrides !== undefined || p.fallbackFamily !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            const outcome = executeApprovedImport(p);
            if (outcome.kind === 'ok') noteSuccess(bucket);
            return outcome;
          }
          // ---- propose 模式：草表校验 + 结构级预览（批准前库内零变更）。
          const proposeParsed = StoneImportProposeSchema.safeParse(p);
          if (!proposeParsed.success) {
            throw new Error(
              `发起模式需 {taskId, draftRef}（draftRef 缺一不可——不猜测）：${proposeParsed.error.issues.map((i) => i.message).join('; ')}`,
            );
          }
          const propose = proposeParsed.data;
          const task = agentTaskOf(p.taskId);
          const draftBytes = deps.blobs.read(propose.draftRef);
          if (draftBytes === null) throw new Error(`草表 blob 不存在：${propose.draftRef.slice(0, 12)}…（vision 代理产出后先上传）`);
          const draftParsed = CardCatalogDraftSchema.safeParse(JSON.parse(draftBytes.toString('utf8')));
          if (!draftParsed.success) {
            throw new Error(`草表不符 CardCatalogDraft 契约：${draftParsed.error.issues.slice(0, 3).map((i) => i.message).join('; ')}`);
          }
          const draft = draftParsed.data;
          const target = propose.targetSupplier ?? draft.supplier;
          const options: CardImportOptions = {
            targetSupplier: target,
            ownerId: task.ownerId,
            ...(propose.familyOverrides !== undefined || propose.fallbackFamily !== undefined
              ? {
                  familyPolicy: {
                    ...(propose.familyOverrides !== undefined ? { overrides: propose.familyOverrides } : {}),
                    ...(propose.fallbackFamily !== undefined ? { fallbackFamily: propose.fallbackFamily } : {}),
                  },
                }
              : {}),
          };
          // 结构级分类（existing/页声明/bbox/重叠可判；切格与同字节以执行报告为准）。
          const classified = previewCardImport(deps.db, draft, target);
          const before = previewBlob({
            note: 'stone-import',
            targetSupplier: target,
            existingSkus: [...new Set(classified.skipped.map((s) => s.sku))],
          });
          const after = previewBlob({ note: 'stone-import', classified });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: task.ownerId,
            tool: 'stone.import',
            payload: { kind: 'stone-import', draftRef: propose.draftRef, options },
            preview: { before, after },
            summary: `样卡批量导入 ${target}：将新建 ${classified.newSkus.length}、跳过已存在 ${classified.skipped.length}、结构失败 ${classified.structuralFailures.length}（变体组 ${classified.variantGroups.length}、色系分组 ${classified.families.length}、低置信 ${classified.lowConfidence.length} 项显式列出）`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              preview: {
                newCount: classified.newSkus.length,
                newSkus: classified.newSkus,
                skipped: classified.skipped,
                structuralFailures: classified.structuralFailures,
                variantGroups: classified.variantGroups,
                families: classified.families,
                lowConfidence: classified.lowConfidence,
                note: '结构级预览：切格/去背景/跨格同字节/ΔE 交叉验证在执行期判定（以导入报告为准）——预览不猜测',
                previewBlobs: { before, after },
              },
              pending: '等待用户批准（单 proposal 覆盖整批；批准前库内零变更；重跑幂等收敛）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'stone.import', error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  // 授权桥（§3.6）：双模例外照 studio.generate——无 proposalId=propose 面（无副作用，
  // 授权发生在执行模式）；带 proposalId 走 precheckMutation。未装配=一律 principal-forbidden。
  return createCapabilityRegistry(definitions, {
    ...(deps.approvals
      ? {
          mutationAuth: {
            precheck: (name: string, input: unknown) => {
              const proposalId = (input as { proposalId?: unknown } | null | undefined)?.proposalId;
              if (proposalId === undefined) return { ok: true };
              return deps.approvals!.precheckMutation(name, input);
            },
          },
        }
      : {}),
  });
}
