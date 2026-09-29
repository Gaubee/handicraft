/**
 * 任务导出 MCP 工具面（add-task-stones-manifest-export 4.2/4.3——arch-decisions B1/B2/B3
 * 裁定的唯一实现位）。原始需求 2026-09-29（Owner：导出工具化 SVG/PNG/BOM）。
 *
 * 工具形态（B1 冻结）：**一个逻辑工具 studio.task.export，proposal/execute 双模**；
 * 不暴露 kind 分支——每次执行恒产该 imageId 三件套（SVG+PNG+BOM 同一 task-layout
 * 快照，防多工具调用的版本漂移/重复审批/产物不对应）。多图任务按 imageId 连续调用，
 * 各自产一组三件套。
 *
 * 导出管道（B2 冻结——engine 只读复用红线）：
 *   task-layout.<imageId>.json（唯一输入——planRef/treeRef/manifestRevision 三锚绑定）
 *     → lint 重算（unresolvable=hard 阻断；unintroduced=warning 不阻断——A3 政策/
 *       安全分离）+ workbench mask 门（mask-incomplete/stale/recompute-error）+
 *       engine validate（warnings 面）+ engine exportGate（spacing/mask/missing-asset
 *       安全门）——三门全部通过才产产物
 *     → buildSvg + renderGemsPng（daemon 透明底钻位光栅——B2 偏差 8）+ buildTaskBom
 *       （daemon 适配器按 stoneRef 聚合——engine buildBom 只有规格×色口径，不含
 *       supplier/SKU，不冒充项目备料 BOM）
 *     → createShareBundle（三元组+/r/{publicId} 发布+manifest 审计字段）+ artifact
 *       帧三条（task-export.<imageId>.{svg,png,bom}）。
 *
 * engine 复用选型（红线 1 落实）：**公共出口直接 import**——`rhinestone-studio/engine`
 * barrel（buildSvg/exportGate/validate/types），先例=capability/studio.ts:39、
 * png/render.ts:26、jobs/engine.ts:29（daemon 侧 engine 消费的既有唯一通道；
 * strategies 子树的「不 import 引擎」红线不覆盖 capability 层）。零抄录零改动。
 *
 * 授权（B1 偏差 4：导出会发布分享 result——保留 proposal/approval 双模）：propose=
 * {taskId, sourceTaskId?, imageId?, expectedManifestRevision?}（跑门+产物摘要+
 * approval request，proposalId 绑定 sessionId/sourceTaskId/imageId/taskLayoutRef/
 * manifestRevision——B1「proposalId 必须绑定 task、sourceTask、imageId、owner、
 * layout/manifest revision」）；execute={taskId, proposalId}（grant 消费+按绑定
 * taskLayoutRef 定版快照产三件套——内容寻址 blob 不可变，批准后策略重跑不漂移）。
 *
 * 产物面（4.3——B3）：bundle（results/<publicId>+/r/ 分享+manifest.source 审计）+
 * artifact 帧三条 + MCP 返回 {resultId,publicId,bundle,source,warnings}（无 base64
 * 大文件）+ task.exports.list 多图历史读面（B3.5——tasks.result_id 单列被后一次导出
 * 覆盖后，前一组 result 行经本面按 imageId 重新定位）。
 *
 * 多图裁定（B1/A5）：单图可省 imageId（缺省 image-1）；多图必指定（会话首条主图集
 * imageIds 审计——tasks.params 冻结面，缺席=单图域）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  TaskImageIdSchema,
  TaskLayoutSchema,
  taskLayoutArtifactName,
  type StoneLintResult,
  type StonesManifest,
  type TaskImageId,
  type TaskLayout,
} from '@handicraft/contracts';
import {
  exportGate,
  validate,
  buildSvg,
  type Block,
  type Gem,
  type GridSpec,
  type Palette,
} from 'rhinestone-studio/engine';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { getSessionProject } from '../db/sessions.js';
import type { JobService } from '../jobs/service.js';
import { renderGemsPng } from '../png/render.js';
import { createShareBundle } from '../share.js';
import { assetResolverOf, resolveShapeAssetStateOf, shapeResolverOf } from '../shape-assets.js';
import { exportGateOf, maskEditStatusesOf } from '../kernel/workbench.js';
import { latestTaskArtifactRefs, lintTaskStoneRefs } from '../kernel/project-lint.js';
import { loadObjectTreeArtifact } from '../kernel/vision/tree-persist.js';
import { treeToBlocks } from '../kernel/vision/tree-to-blocks.js';
import type { ApprovalService, ConsumeDenyReason } from './authorization.js';
import type { ApprovedOpRow } from '../db/approvals.js';
import { createCapabilityRegistry, type CapabilityCallResult, type CapabilityDefinition, type CapabilityRegistry } from './core.js';
import { RUNAWAY_LIMIT } from './studio.js';

export const TASK_EXPORT_TOOL_NAME = 'studio.task.export';
export const TASK_EXPORTS_LIST_TOOL_NAME = 'studio.task.exports.list';

/** 帧名三元组（4.3——任务详情/下载面按 imageId 定位）。 */
export function taskExportArtifactNames(imageId: TaskImageId): { svg: string; png: string; bom: string } {
  return { svg: `task-export.${imageId}.svg`, png: `task-export.${imageId}.png`, bom: `task-export.${imageId}.bom` };
}

/** 结果历史返回上界（B3.5 读面有界）。 */
const MAX_EXPORT_HISTORY = 50;

// ---------------------------------------------------------------- 输入 schema

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（行动者/审批归属——服务端以任务行解析所属会话/项目）');
const SourceTaskIdField = z
  .string()
  .min(1)
  .describe('排钻真值所属 task（strategy-plan/tree/task-layout 工件域；缺省=当前 taskId；须同 owner 同会话）');
const ImageIdField = TaskImageIdSchema.describe('主图集 imageId（单图可省——缺省 image-1；多图任务必指定）');

/** 双模外层（照 task-stones 先例：外层全可选，propose 齐备性 handler 内二次校验）。 */
const ExportInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: z.string().min(1).optional().describe('已批准 proposal id（执行模式——grant 服务端内部关联）'),
  sourceTaskId: SourceTaskIdField.optional(),
  imageId: ImageIdField.optional(),
  expectedManifestRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('发起时读到的项目 manifest revision（可选 CAS 基线——漂移=STALE）'),
});

const ExportsListInputSchema = z.object({
  taskId: TaskIdField,
  imageId: ImageIdField.optional().describe('按 imageId 过滤（缺省=全部图）'),
  sourceTaskId: SourceTaskIdField.optional().describe('按排钻真值 task 过滤（缺省=全部）'),
});

// ---------------------------------------------------------------- 任务域 helpers

interface AgentTaskRef {
  ownerId: string;
  sessionId: string | null;
}

function agentTaskOf(db: SqliteDb, taskId: string): AgentTaskRef {
  const task = db
    .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
    .get(taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
  return { ownerId: task.owner_id, sessionId: task.session_id };
}

/**
 * 会话主图集 imageId 集（A5 冻结分配的审计面——会话首个 agent task 的 tasks.params
 * imageIds；缺席（W1 前存量/纯文本会话）=空=单图域缺省 image-1）。
 */
function sessionImageIdsOf(db: SqliteDb, sessionId: string): TaskImageId[] {
  const row = db
    .prepare("SELECT params FROM tasks WHERE session_id = ? AND type = 'agent' ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(sessionId) as { params: string | null } | undefined;
  if (row === undefined || row.params === null) return [];
  try {
    const parsed = JSON.parse(row.params) as { imageIds?: unknown };
    if (!Array.isArray(parsed.imageIds)) return [];
    return parsed.imageIds.filter((id): id is TaskImageId => typeof id === 'string' && TaskImageIdSchema.safeParse(id).success);
  } catch {
    return [];
  }
}

/** imageId 解析：显式给=用之；省略=单图域缺省 image-1，多图域 typed 拒（B1 裁定）。 */
function resolveImageId(db: SqliteDb, sessionId: string, imageId: TaskImageId | undefined): TaskImageId {
  if (imageId !== undefined) return imageId;
  const imageIds = sessionImageIdsOf(db, sessionId);
  if (imageIds.length > 1) {
    throw new Error(`多图任务必须指定 imageId（会话主图集：${imageIds.join('、')}——每图独立三件套，不拼接）`);
  }
  return 'image-1';
}

/** 排钻真值 task 解析（B1：与当前 task 同 owner、同 session——跨会话引用必拒）。 */
function requireSourceTask(db: SqliteDb, calling: AgentTaskRef, sourceTaskId: string): void {
  if (calling.sessionId === null) throw new Error(`任务 ${sourceTaskId} 的会话不存在（导出以会话项目为锚）`);
  const source = agentTaskOf(db, sourceTaskId);
  if (source.ownerId !== calling.ownerId) throw new Error('sourceTaskId 与当前任务归属不符（跨用户导出必拒）');
  if (source.sessionId !== calling.sessionId) throw new Error('sourceTaskId 与当前任务不在同一会话（跨会话导出必拒）');
}

/**
 * task-layout 工件读回（latest-by-name 帧 → blob → TaskLayoutSchema 终验）。
 * 缺席=null（调用方 typed 拒）；损坏/不符契约=typed 拒（真源腐蚀不静默降级）。
 */
export function readTaskLayoutArtifact(
  deps: { blobs: BlobStore; config: AppConfig },
  sourceTaskId: string,
  imageId: TaskImageId,
): { layout: TaskLayout; blobRef: string } | null {
  const blobRef = latestTaskArtifactRefs(deps.config, sourceTaskId).get(taskLayoutArtifactName(imageId));
  if (blobRef === undefined) return null;
  const bytes = deps.blobs.read(blobRef);
  if (bytes === null) throw new Error(`task-layout 工件不可读（blobRef=${blobRef.slice(0, 12)}…）`);
  let parsed: ReturnType<typeof TaskLayoutSchema.safeParse>;
  try {
    parsed = TaskLayoutSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new Error(
      `task-layout 工件不是合法 JSON（blobRef=${blobRef.slice(0, 12)}…）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed.success) {
    throw new Error(
      `task-layout 工件不符契约（blobRef=${blobRef.slice(0, 12)}…）：${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return { layout: parsed.data, blobRef };
}

/** 按 proposal 绑定 ref 定版读回（内容寻址 blob 不可变——批准后策略重跑不漂移）。 */
function readTaskLayoutByRef(blobs: BlobStore, blobRef: string): TaskLayout {
  const bytes = blobs.read(blobRef);
  if (bytes === null) throw new Error(`proposal 绑定的 task-layout 不可读（blobRef=${blobRef.slice(0, 12)}…）`);
  return TaskLayoutSchema.parse(JSON.parse(bytes.toString('utf8')));
}

// ---------------------------------------------------------------- 导出适配器（B2）

/** layout → engine Gem[]（colorId=stoneRef——与 palette 键/BOM 行同键，见生成器冻结裁量）。 */
function engineGemsOf(layout: TaskLayout): Gem[] {
  return layout.gems.map((gem) => ({
    id: gem.id,
    x: gem.x,
    y: gem.y,
    colorId: gem.stoneRef,
    blockId: gem.blockId,
    shapeId: gem.shapeId,
    diameterMm: gem.diameterMm,
    ...(gem.rotationDeg !== undefined ? { rotationDeg: gem.rotationDeg } : {}),
    ...(gem.assetId !== undefined ? { assetId: gem.assetId } : {}),
  }));
}

/** layout.grid → engine GridSpec（pitchMm=baseSpec.diameterMm+gapMm——gridFromSpec 同构）。 */
function engineGridOf(layout: TaskLayout): GridSpec {
  return {
    pitchMm: layout.grid.baseSpec.diameterMm + layout.grid.gapMm,
    gapMm: layout.grid.gapMm,
    rowAngleDeg: 0,
    pixelsPerMm: layout.grid.pixelsPerMm,
  };
}

/** layout.palette → engine Palette（键序确定性）。 */
function enginePaletteOf(layout: TaskLayout): Palette {
  return Object.entries(layout.palette)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, color]) => ({ id, name: color.name, hex: color.hex }));
}

/**
 * 掩膜块重建（B2「mask 不进 layout——导出门需要时按引用」）：按 layout.source.treeRef
 * 定版读回树工件 + treeToBlocks（与策略执行同一真值链）→ 带 mask 的 engine Block[]
 * （validate/exportGate 的 mask 面消费）。树工件损坏=typed 拒。
 */
function rebuildMaskedBlocks(deps: { blobs: BlobStore }, layout: TaskLayout): Block[] {
  const tree = loadObjectTreeArtifact(deps.blobs, layout.source.treeRef);
  const result = treeToBlocks(
    tree,
    { readBlob: (ref) => deps.blobs.read(ref) },
    { gemDiameterPx: layout.grid.baseSpec.diameterMm * layout.grid.pixelsPerMm },
  );
  if (!result.ok) {
    throw new Error(`task-layout 绑定树的掩膜重建失败（${result.reason}——treeRef 与工件不一致）`);
  }
  return result.blocks as unknown as Block[];
}

/**
 * 任务 BOM（B2 冻结）：daemon 适配器按 **stoneRef（×规格快照）** 聚合实际使用量——
 * supplier/SKU/规格（gem diameterMm 快照）/色名/hex/数量 + 备料参考列（manifest
 * quantity 对照；未引入=空清单无参考）。同规格同色不同供应商不合并成一行（engine
 * buildBom 的规格×色口径不具备——不冒充项目备料 BOM，仅作几何交叉核对）。
 * 表头/合计行与 engine buildBom 同形（UTF-8 BOM + CRLF——Excel 中文友好）。
 */
export function buildTaskBom(layout: TaskLayout, manifest: StonesManifest | null): string {
  const quantityByRef = new Map((manifest?.entries ?? []).map((entry) => [entry.stoneRef, entry.quantity] as const));
  interface Row {
    count: number;
    supplier: string;
    sku: string;
    diameterMm: number;
    name: string;
    hex: string;
  }
  const rowsByKey = new Map<string, Row>();
  const firstRowByRef = new Set<string>();
  const bomRows: Array<Row & { stoneRef: string; reference: string }> = [];
  for (const gem of layout.gems) {
    const key = `${gem.stoneRef}\u0000${gem.diameterMm}`;
    const existing = rowsByKey.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    const paletteEntry = layout.palette[gem.stoneRef];
    rowsByKey.set(key, {
      count: 1,
      supplier: gem.supplier,
      sku: gem.sku,
      diameterMm: gem.diameterMm,
      name: paletteEntry?.name ?? `${gem.supplier}/${gem.sku}`,
      hex: gem.colorHex,
    });
  }
  // 确定性排序：数量降序 → stoneRef 字典序 → 规格升序（engine buildBom 同式首键）。
  const sorted = [...rowsByKey.entries()].sort((a, b) => {
    const byCount = b[1].count - a[1].count;
    if (byCount !== 0) return byCount;
    const refA = a[0].split('\u0000')[0]!;
    const refB = b[0].split('\u0000')[0]!;
    if (refA !== refB) return refA < refB ? -1 : 1;
    return a[1].diameterMm - b[1].diameterMm;
  });
  for (const [key, row] of sorted) {
    const stoneRef = key.split('\u0000')[0]!;
    // 备料参考：同 stoneRef 多规格行只首行给值（避免重复计数）；未引入=「未引入」。
    const reference = quantityByRef.has(stoneRef)
      ? firstRowByRef.has(stoneRef)
        ? ''
        : String(quantityByRef.get(stoneRef))
      : '未引入';
    firstRowByRef.add(stoneRef);
    bomRows.push({ stoneRef, reference, ...row });
  }
  const out: string[] = ['供应商,SKU,规格,色名,hex,数量,备料参考'];
  for (const row of bomRows) {
    out.push(
      `${row.supplier},${row.sku},${row.diameterMm}mm,${row.name},${row.hex},${row.count},${row.reference}`,
    );
  }
  out.push(`合计,,,,,${layout.gems.length},`);
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- 门面（三门 + lint）

/** 导出门结果（B4 阻断矩阵的单一表述）：blockers 空=放行。 */
interface ExportGateOutcome {
  ok: boolean;
  /** 硬阻断清单（mask 门 blockers + lint unresolvable + engine exportGate violations）。 */
  blockers: string[];
  /** 非阻断警告（lint unintroduced + engine validate warnings）。 */
  warnings: string[];
  lint: StoneLintResult | null;
}

/**
 * 三门重算（propose 与 execute 共用——studio.export「gate 复验」同纪律）：
 *   [1] workbench mask 门（exportGateOf——mask-incomplete/stale/recompute-error，
 *       B4.7 各自命中 hard blocker）；
 *   [2] lint 重算（A3 导出前重算：unresolvable=hard；unintroduced=warning 不阻断——
 *       偏差 2；manifest 只增不减，revision 漂移=审计面不阻断）；
 *   [3] engine exportGate（spacing/mask violation/missing-asset 安全门）+ validate
 *       （warnings 面——engine 校验经公共出口对照，非抄录）。
 */
function runExportGates(
  deps: { db: SqliteDb; blobs: BlobStore; config: AppConfig },
  input: { sessionId: string; sourceTaskId: string; layout: TaskLayout },
): ExportGateOutcome {
  const blockers: string[] = [];
  const warnings: string[] = [];
  // [1] mask 门（sourceTask 的 mask_edit_states 真源重算——rpc taskExport 同门）。
  const maskGate = exportGateOf(maskEditStatusesOf(deps.db, input.sourceTaskId));
  if (!maskGate.allowed) {
    blockers.push(`mask 门阻断（${maskGate.blockers.join(', ')}）——先在排钻工作台解决遮罩编辑告警`);
  }
  // [2] lint 重算（无 plan 工件=null——layout 在场 ⇒ plan 曾落档，null=状态不一致拒）。
  let lint: StoneLintResult | null = null;
  const linted = lintTaskStoneRefs(
    { db: deps.db, blobs: deps.blobs, config: deps.config },
    { sessionId: input.sessionId, sourceTaskId: input.sourceTaskId, imageId: input.layout.source.imageId },
  );
  if (linted === null) {
    blockers.push('lint 无数据源（sourceTask 无 strategy-plan 工件——与 task-layout 在场矛盾，状态不一致）');
  } else {
    lint = linted.result;
    const unresolved = linted.result.items.filter((item) => item.category === 'unresolvable');
    for (const item of unresolved) {
      blockers.push(`lint 硬错：stoneRef ${item.stoneRef} 不可解析（库外/软删——不能靠添加清单消除）`);
    }
    for (const item of linted.result.items.filter((entry) => entry.category === 'unintroduced')) {
      warnings.push(
        `lint 警告：stoneRef ${item.stoneRef}（${item.supplier ?? '?'}/${item.sku ?? '?'}）未引入项目清单——先与用户确认，经 studio.task.stones.add 纳入（不阻断导出）`,
      );
    }
  }
  // [3] engine validate（warnings）+ exportGate（安全门——spacing/mask violation/missing-asset）。
  const gems = engineGemsOf(input.layout);
  const grid = engineGridOf(input.layout);
  const blocks = rebuildMaskedBlocks(deps, input.layout);
  for (const warning of validate(gems, grid, blocks)) {
    warnings.push(`engine validate：${warning.kind}——${warning.detail}`);
  }
  const verdict = exportGate(gems, {
    grid,
    blocks,
    resolveShapeAsset: (assetId: string) => resolveShapeAssetStateOf(deps.blobs, input.layout.shapeAssets, assetId),
  });
  if (!verdict.ok) {
    blockers.push(
      `exportGate 阻断（${verdict.violations.length} 项违规）：${verdict.violations
        .map((violation) => `[${violation.kind}] ${violation.detail}`)
        .join('；')}`,
    );
  }
  return { ok: blockers.length === 0, blockers, warnings, lint };
}

// ---------------------------------------------------------------- 工具面构造

export interface TaskExportCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  config: AppConfig;
  /** 帧提交单点（approval-request/artifact/transcript——任务域工具必需）。 */
  jobs?: JobService;
  /** §3.6 授权桥（approved-mutation 面；缺省=一律 principal-forbidden）。 */
  approvals?: ApprovalService;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

export function createTaskExportCapabilities(deps: TaskExportCapabilitiesDeps): CapabilityRegistry {
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

  function bucketOf(input: unknown): string {
    const taskId = (input as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : 'global';
  }

  function failedOf(reason: ConsumeDenyReason | string, message: string): CapabilityCallResult {
    const code =
      reason === 'stale-revision' ? ('STALE' as const) : reason === 'concurrent' ? ('CONFLICT' as const) : ('INVALID_OPERATION' as const);
    return { kind: 'failed', code, message };
  }

  function isExecuteMode<T extends { proposalId?: string }>(parsed: T): parsed is T & { proposalId: string } {
    return parsed.proposalId !== undefined;
  }

  function payloadOf(op: ApprovedOpRow): Record<string, unknown> {
    try {
      return JSON.parse(op.payload_json as string) as Record<string, unknown>;
    } catch {
      throw new Error(`proposal 载荷不可解析：${op.proposal_id}`);
    }
  }

  /** proposal 载荷结构（propose/execute 两端共用约束）。 */
  interface TaskExportPayload {
    kind: 'task-export';
    sessionId: string;
    sourceTaskId: string;
    imageId: TaskImageId;
    taskLayoutRef: string;
    manifestRevision: number;
  }

  function parsePayload(raw: Record<string, unknown>): TaskExportPayload {
    if (
      raw['kind'] !== 'task-export' ||
      typeof raw['sessionId'] !== 'string' ||
      typeof raw['sourceTaskId'] !== 'string' ||
      typeof raw['imageId'] !== 'string' ||
      typeof raw['taskLayoutRef'] !== 'string' ||
      typeof raw['manifestRevision'] !== 'number'
    ) {
      throw new Error('proposal 载荷不完整（kind/sessionId/sourceTaskId/imageId/taskLayoutRef/manifestRevision——数据不一致）');
    }
    const imageId = TaskImageIdSchema.safeParse(raw['imageId']);
    if (!imageId.success) throw new Error(`proposal 载荷 imageId 非法：${raw['imageId']}`);
    return {
      kind: 'task-export',
      sessionId: raw['sessionId'],
      sourceTaskId: raw['sourceTaskId'],
      imageId: imageId.data,
      taskLayoutRef: raw['taskLayoutRef'],
      manifestRevision: raw['manifestRevision'],
    };
  }

  /** 三件套构造（纯函数面——同一 task-layout 快照产 SVG/PNG/BOM；门已由调用方复验）。 */
  function buildTriple(layout: TaskLayout, manifest: StonesManifest | null): {
    svg: string;
    png: Uint8Array;
    bom: string;
  } {
    const gems = engineGemsOf(layout);
    const grid = engineGridOf(layout);
    const palette = enginePaletteOf(layout);
    const svg = buildSvg(gems, grid, {
      width: layout.imageWidth,
      height: layout.imageHeight,
      palette,
      resolveShape: shapeResolverOf(deps.blobs, layout.shapeAssets),
    });
    const png = renderGemsPng({
      gems,
      palette,
      grid,
      width: layout.imageWidth,
      height: layout.imageHeight,
      resolveAsset: assetResolverOf(deps.blobs, layout.shapeAssets),
    });
    const bom = buildTaskBom(layout, manifest);
    return { svg, png, bom };
  }

  /** 会话项目 manifest 读回（门 lint 已重算——BOM 备料参考列消费；无行=null）。 */
  function sessionManifestOf(sessionId: string): StonesManifest | null {
    const row = getSessionProject(deps.db, sessionId);
    if (row === null) return null;
    const bytes = deps.blobs.read(row.blob_ref);
    if (bytes === null) throw new Error(`manifest blob 不可读（blobRef=${row.blob_ref.slice(0, 12)}…）`);
    return JSON.parse(bytes.toString('utf8')) as StonesManifest;
  }

  const definitions: CapabilityDefinition[] = [
    {
      name: TASK_EXPORT_TOOL_NAME,
      description:
        '任务导出（approved-mutation 双模——B1：一个逻辑工具，恒产该图三件套 SVG+PNG+BOM）。'
        + '发起={taskId, sourceTaskId?, imageId?, expectedManifestRevision?}（服务端重算 lint+几何校验+导出门，'
        + '返回产物摘要/警告与 approval request——unintroduced=警告不阻断，库外/软删/mask/spacing 违规=硬阻断）；'
        + '执行={taskId, proposalId}（消费 grant，按 proposal 绑定的 task-layout 快照产三件套分享 bundle+/r/ 链接+'
        + '任务帧三产物）。单图可省 imageId；多图任务每图独立调用（各自一组三件套）。'
        + '导出前若无 task-layout.<imageId>.json（策略未执行或生成被拒），先完成/修正策略执行。',
      authority: 'approved-mutation' as const,
      input: ExportInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ExportInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            TASK_EXPORT_TOOL_NAME,
            `参数不合法（双模：发起={taskId[,sourceTaskId][,imageId][,expectedManifestRevision]} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          // ================================================================ propose 模式
          if (!isExecuteMode(p)) {
            if (p.sourceTaskId !== undefined && p.sourceTaskId === p.taskId) {
              throw new Error('sourceTaskId 与 taskId 相同时省略该参数（不需要显式自指）');
            }
            const task = agentTaskOf(deps.db, p.taskId);
            if (task.sessionId === null) {
              throw new Error(`任务 ${p.taskId} 不属于任何会话——导出以会话项目为锚（A1），无项目语义`);
            }
            const sourceTaskId = p.sourceTaskId ?? p.taskId;
            requireSourceTask(deps.db, task, sourceTaskId);
            const imageId = resolveImageId(deps.db, task.sessionId, p.imageId);
            // —— task-layout 定位（唯一输入——缺席/损坏均 typed 拒）
            const found = readTaskLayoutArtifact(deps, sourceTaskId, imageId);
            if (found === null) {
              throw new Error(
                `任务 ${sourceTaskId} 尚无 ${taskLayoutArtifactName(imageId)} 渲染快照——先完成策略执行`
                + '（studio.strategy.design 执行/layer.strategy.set 直改即同链生成；曾因「多候选钻无法唯一匹配/custom 形」被拒时，'
                + '改为每节点恰一款标准五形钻后重跑策略）',
              );
            }
            const layout = found.layout;
            if (layout.source.imageId !== imageId) {
              throw new Error(`task-layout 工件 imageId 锚不符（${layout.source.imageId} ≠ ${imageId}——帧名与内容不一致）`);
            }
            // —— 可选 manifest CAS 基线（B1「可带 expectedManifestRevision」——漂移=STALE）。
            const projectRow = getSessionProject(deps.db, task.sessionId);
            if (projectRow === null) {
              throw new Error('会话尚无项目钻清单（task-layout 在场则必有——状态不一致）');
            }
            if (p.expectedManifestRevision !== undefined && p.expectedManifestRevision !== projectRow.revision) {
              return {
                kind: 'failed',
                code: 'STALE',
                message: `manifest revision CAS 基线漂移：expected=${p.expectedManifestRevision} current=${projectRow.revision}——以 currentRevision=${projectRow.revision} 重新发起`,
              };
            }
            // —— 三门重算（阻断矩阵——B4.7）。
            const gates = runExportGates(deps, { sessionId: task.sessionId, sourceTaskId, layout });
            if (!gates.ok) {
              return {
                kind: 'failed',
                code: 'INVALID_OPERATION',
                message: `导出被门阻（${gates.blockers.length} 项）：\n${gates.blockers.join('\n')}`,
              };
            }
            // —— 产物摘要（B1：返回产物摘要+warning+approval request）。
            const manifest = sessionManifestOf(task.sessionId);
            const bom = buildTaskBom(layout, manifest);
            const bomRowCount = bom.trimEnd().split('\r\n').length - 2; // 表头+合计 之外
            const materials = Object.entries(layout.palette)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([stoneRef, color]) => ({ stoneRef, name: color.name, hex: color.hex }));
            const issued = requireApprovals().propose({
              taskId: p.taskId,
              userId: task.ownerId,
              tool: TASK_EXPORT_TOOL_NAME,
              payload: {
                kind: 'task-export',
                sessionId: task.sessionId,
                sourceTaskId,
                imageId,
                taskLayoutRef: found.blobRef,
                manifestRevision: projectRow.revision,
              },
              preview: { before: found.blobRef, after: found.blobRef },
              summary:
                `任务导出 ${imageId}：${layout.gems.length} 钻 / ${materials.length} 款物料 / BOM ${bomRowCount} 行`
                + `（SVG+PNG+BOM 三件套分享 bundle——源 task ${sourceTaskId.slice(0, 8)}…·manifest v${projectRow.revision}）`
                + (gates.warnings.length > 0 ? `·${gates.warnings.length} 条警告（不阻断）` : ''),
            });
            noteSuccess(bucket);
            return {
              kind: 'ok',
              value: {
                proposalId: issued.proposalId,
                requestId: issued.requestId,
                expiresAt: issued.expiresAt,
                summary: {
                  imageId,
                  sourceTaskId,
                  gemCount: layout.gems.length,
                  materials,
                  bomRowCount,
                  image: { width: layout.imageWidth, height: layout.imageHeight },
                  anchors: { taskLayoutRef: found.blobRef, manifestRevision: projectRow.revision },
                },
                lint: gates.lint,
                warnings: gates.warnings,
                pending: '等待用户批准（approval-request 已入任务帧流）——批准后以 {taskId, proposalId} 执行',
              },
            };
          }
          // ================================================================ execute 模式
          if (p.sourceTaskId !== undefined || p.imageId !== undefined || p.expectedManifestRevision !== undefined) {
            throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
          }
          const approvals = requireApprovals();
          const task = agentTaskOf(deps.db, p.taskId);
          if (task.sessionId === null) throw new Error(`任务 ${p.taskId} 不属于任何会话（数据不一致）`);
          const consume = approvals.consumeForExecution({
            proposalId: p.proposalId,
            taskId: p.taskId,
            userId: task.ownerId,
            tool: TASK_EXPORT_TOOL_NAME,
          });
          if (!consume.ok) return failedOf(consume.reason, consume.message);
          const payload = parsePayload(payloadOf(consume.op));
          if (task.sessionId !== payload.sessionId) {
            throw new Error(
              `proposal 载荷会话绑定漂移（${payload.sessionId} ≠ 任务会话 ${task.sessionId}）——重新发起提案`,
            );
          }
          // —— 定版快照读回（proposal 绑定 taskLayoutRef——内容寻址不可变）+ 门复验。
          const layout = readTaskLayoutByRef(deps.blobs, payload.taskLayoutRef);
          const gates = runExportGates(deps, { sessionId: payload.sessionId, sourceTaskId: payload.sourceTaskId, layout });
          if (!gates.ok) {
            approvals.settleExternal(p.proposalId, {
              kind: 'failed',
              message: `导出门复验阻断：${gates.blockers.join('；')}`,
            });
            return {
              kind: 'failed',
              code: 'INVALID_OPERATION',
              message: `导出被门阻（批准期间状态漂移，${gates.blockers.length} 项）：\n${gates.blockers.join('\n')}`,
            };
          }
          const manifest = sessionManifestOf(payload.sessionId);
          const triple = buildTriple(layout, manifest);
          const manifestDrift =
            manifest !== null && manifest.revision !== payload.manifestRevision
              ? `manifest revision 漂移（提案 v${payload.manifestRevision} → 当前 v${manifest.revision}——清单只增不减，不阻断）`
              : null;
          // —— bundle 发布（withinCommit=op 结算同事务——studio.export P1-3 恰好一次同款）。
          const bundle = createShareBundle(
            { config: deps.config, db: deps.db, blobs: deps.blobs },
            {
              taskId: p.taskId,
              ownerId: task.ownerId,
              title: `任务导出 ${payload.imageId}（${layout.gems.length} 钻）`,
              files: {
                svg: Buffer.from(triple.svg, 'utf8'),
                bom: Buffer.from(triple.bom, 'utf8'),
                png: triple.png,
              },
              source: {
                sourceTaskId: payload.sourceTaskId,
                imageId: payload.imageId,
                taskLayoutRef: payload.taskLayoutRef,
                manifestRevision: payload.manifestRevision,
              },
              withinCommit: (committed) =>
                approvals.settleExternal(p.proposalId, { kind: 'succeeded', resultRef: committed.resultId }),
            },
          );
          // —— artifact 帧三条（4.3——任务详情/下载面按 imageId 定位；blobRef=bundle 三元组）。
          const names = taskExportArtifactNames(payload.imageId);
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.svg, name: names.svg });
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.png, name: names.png });
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.bom, name: names.bom });
          deps.jobs?.emitFor(p.taskId, 'transcript', {
            role: 'tool',
            text: `任务导出完成（${payload.imageId}）：分享链接 /r/${bundle.publicId}（SVG+BOM+PNG 三件套）`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              resultId: bundle.resultId,
              publicId: bundle.publicId,
              bundle: bundle.blobRefs,
              source: {
                sourceTaskId: payload.sourceTaskId,
                imageId: payload.imageId,
                taskLayoutRef: payload.taskLayoutRef,
                manifestRevision: payload.manifestRevision,
              },
              warnings: [...(manifestDrift !== null ? [manifestDrift] : []), ...gates.warnings],
              download: `/r/${bundle.publicId}`,
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_EXPORT_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: TASK_EXPORTS_LIST_TOOL_NAME,
      description:
        '任务导出历史（只读——B3.5）：按当前任务所属会话列出全部导出 result（每图三件套 bundle），'
        + '可按 imageId/sourceTaskId 过滤。tasks.result 只指向最后一组 bundle——本面是多图历史与'
        + '旧结果下载入口的持久索引（resultId/publicId/三元组 blobRef/过期时间）。',
      authority: 'readonly' as const,
      input: ExportsListInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ExportsListInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, TASK_EXPORTS_LIST_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const task = agentTaskOf(deps.db, p.taskId);
          if (task.sessionId === null) {
            throw new Error(`任务 ${p.taskId} 不属于任何会话——导出历史以会话项目为锚`);
          }
          // 会话域 result 行（owner 双重校验）→ bundle.json manifest 的 source 审计面过滤。
          const rows = deps.db
            .prepare(
              `SELECT r.id, r.public_id, r.task_id, r.bundle_path, r.created_at, r.expires_at
               FROM results r JOIN tasks t ON r.task_id = t.id
               WHERE t.session_id = ? AND r.owner_id = ? AND r.revoked_at IS NULL
               ORDER BY r.created_at DESC LIMIT ?`,
            )
            .all(task.sessionId, task.ownerId, MAX_EXPORT_HISTORY) as Array<{
            id: string;
            public_id: string;
            task_id: string;
            bundle_path: string;
            created_at: string;
            expires_at: string | null;
          }>;
          const exports: Array<Record<string, unknown>> = [];
          for (const row of rows) {
            // 非任务导出 result（studio.export 独立 layout 面）无 source 审计字段——跳过。
            let manifest: { blobRefs?: { svg: string; bom: string; png: string }; source?: { sourceTaskId: string; imageId: string; taskLayoutRef: string; manifestRevision: number } };
            try {
              manifest = JSON.parse(readFileSync(path.join(row.bundle_path, 'bundle.json'), 'utf8'));
            } catch {
              continue; // bundle 目录缺失/损坏=不可下载面，不进历史清单
            }
            if (manifest.source === undefined) continue;
            const source = manifest.source;
            if (p.imageId !== undefined && source.imageId !== p.imageId) continue;
            if (p.sourceTaskId !== undefined && source.sourceTaskId !== p.sourceTaskId) continue;
            exports.push({
              resultId: row.id,
              publicId: row.public_id,
              exportedByTaskId: row.task_id,
              source,
              bundle: manifest.blobRefs ?? null,
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              download: `/r/${row.public_id}`,
            });
          }
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              sessionId: task.sessionId,
              total: exports.length,
              exports,
              note: '每行=一次已执行导出（三件套 bundle；/r/{publicId} 下载入口；过期/撤销后自动缺席）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_EXPORTS_LIST_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  // 授权桥（§3.6）：双模例外照 task-stones——无 proposalId=propose 面（无副作用——
  // 门+摘要+approval request，授权发生在执行模式）；带 proposalId 走 precheckMutation。
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
