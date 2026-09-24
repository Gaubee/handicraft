/**
 * studio 能力集（design §3 工具清单 W4.2 全量实装；RUNAWAY 熔断语义照
 * shufa-server capability/analysis.ts 的 noteFailure/RUNAWAY_LIMIT 移植）。
 * 原始需求 2026-09-23（tasks.md W4.2）：
 *   readonly：studio.projects / studio.templates / studio.pave-preview（§3.4 排布
 *             四参数一等公民——strategy/density/gapMm/seed(+relax/region) 契约真源
 *             镜像直通引擎）/ studio.export-dryrun（gate 预检+export proposal 签发）
 *             / studio.bom。
 *   proposal：studio.patch-propose（区域级修改草案——不动真值；diff+preview+
 *             approval-request 帧）。
 *   approved-mutation（§3.6 授权桥）：studio.patch-apply（单 op 落库——claim+落库
 *             同事务=本地恰好一次）/ studio.generate（双模：带参数=发起 proposal；
 *             带 proposalId=执行——attempt 账本+provider 幂等键分支）/ studio.export
 *             （执行=本地 bundle 恰好一次）/ studio.undo（§3.6.7 撤销三族补偿面）。
 * 熔断（design §2 RUNAWAY_LIMIT=5）：任务域工具按 taskId 分桶（W4.1 收口）；
 * 同桶同工具连续相同失败达上限 → onRunaway。
 */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DensitySpecSchema,
  GapMmSchema,
  RegionSchema,
  RelaxSchema,
  SeedSchema,
  SpecRefSchema,
  StrategyIdSchema,
} from '@handicraft/contracts';
import {
  buildBom,
  buildSvg,
  exportGate,
  gridFromSpec,
  layout,
  mapColors,
  segment,
  STARTER_PALETTE,
  validate,
} from 'rhinestone-studio/engine';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { resolveImgConfig, type AppConfig } from '../config.js';
import type { JobService } from '../jobs/service.js';
import { decodePng, encodePng } from '../png/codec.js';
import { renderGemsPng } from '../png/render.js';
import { createShareBundle } from '../share.js';
import { callImagesApi } from '../imgapi/client.js';
import type { ApprovalService } from './authorization.js';
import { canonicalJson } from './authorization.js';
import {
  applyPatchChanges,
  loadLayoutDocument,
  PatchProposeInputSchema,
  rewriteLayoutDocument,
  type LayoutDocument,
} from './layout-doc.js';
import { undoExport, undoGenerate, undoPatchGroup } from './undo.js';
import { createCapabilityRegistry, type CapabilityCallResult, type CapabilityRegistry } from './core.js';

/** 同一任务同一工具连续相同失败次数上限（超过即熔断）。 */
export const RUNAWAY_LIMIT = 5;

/** generate 执行器（测试替身注入面——两类 provider fixture 的缝）。 */
export type GenerateExecutor = (
  payload: { prompt: string; size?: string; imageRef?: string; advanced?: unknown },
  ctx: { idemKey: string; attemptId: string; proposalId: string; attemptNo: number },
) => Promise<Uint8Array>;

/**
 * 崩溃模拟哨兵（测试面）：executor 抛出时 generate 不结算任何状态——op/attempt
 * 停留 running，重启后由 recoverNonTerminal 收敛 unknown（崩溃瞬间的真实语义）。
 */
export class SimulatedCrashError extends Error {
  constructor(message = '模拟崩溃（外部调用后/写回前）') {
    super(message);
    this.name = 'SimulatedCrashError';
  }
}

export interface StudioCapabilitiesDeps {
  db: SqliteDb;
  /** 内容寻址存储（真值文档/预览/产物——W4.2 工具面必需；缺省时工具面收窄）。 */
  blobs?: BlobStore;
  /** 帧提交单点（approval-request/artifact/transcript——任务域工具必需）。 */
  jobs?: JobService;
  /** §3.6 授权桥（proposal 签发/grant 消费/attempt 账本）。 */
  approvals?: ApprovalService;
  /** export 族撤销回收入口（SessionService.revokeResult）。 */
  revokeResult?: (resultId: string) => void;
  /** generate 执行器替身（缺省=生产执行器：dry-run 占位/真实 callImagesApi）。 */
  generateExecutor?: GenerateExecutor;
  /** 配置面（生产执行器的 dry-run 判定与 IMG_* 解析）。 */
  config?: AppConfig;
  /**
   * 熔断回调（W4.1 接线：cancel 会话 + 任务 failed；shufa abortRunaway 同义）。
   * W4.2 起任务域工具按 taskId 分桶；无任务上下文的工具用 'global' 桶。
   */
  onRunaway?: (bucket: string, detail: string) => void;
}

/** 失败连击账本（bucket+key → count）。 */
interface FailureStreak {
  key: string;
  count: number;
}

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（followup 注入提示中的 taskId——审批帧与归属绑定的上下文）');

const BlobRefField = z.string().regex(/^[0-9a-f]{64}$/);

const PavePreviewInputSchema = z.object({
  taskId: TaskIdField.optional(),
  imageRef: BlobRefField.describe('上传图 blobRef'),
  strategy: StrategyIdSchema,
  density: DensitySpecSchema.default(1),
  gapMm: GapMmSchema,
  seed: SeedSchema.default(1),
  relax: RelaxSchema.default({ boundary: false, repulsion: false }),
  region: RegionSchema.optional(),
  spec: SpecRefSchema,
  shapeAssets: z.record(z.string(), BlobRefField).optional(),
  pixelsPerMm: z.number().positive().default(8),
  segmentK: z.number().int().min(6).max(10).default(8),
});

const GenerateProposeInputSchema = z.object({
  taskId: TaskIdField,
  prompt: z.string().min(1),
  size: z.string().optional(),
  imageRef: BlobRefField.optional(),
  advanced: z.record(z.string(), z.unknown()).optional(),
});

const MutationExecuteInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: z.string().min(1),
});

const ExportDryrunInputSchema = z.object({
  taskId: TaskIdField.optional(),
  resourceId: z.string().min(1),
  propose: z.boolean().optional(),
});

const BomInputSchema = z.object({ resourceId: z.string().min(1) });

const UndoInputSchema = z.object({
  family: z.enum(['patch', 'generate', 'export']),
  resourceId: z.string().min(1).optional(),
  proposalId: z.string().min(1).optional(),
  resultId: z.string().min(1).optional(),
  group: z.string().min(1).optional(),
});

export function createStudioCapabilities(deps: StudioCapabilitiesDeps): CapabilityRegistry {
  const streaks = new Map<string, FailureStreak>();

  /** 失败记账 + 熔断判定（照 shufa analysis.ts noteFailure 语义）。 */
  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return {
        kind: 'failed',
        code: 'INVALID_OPERATION',
        message: `熔断：${reason}。请停止重试，向用户报告失败原因。`,
      };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  /** 成功清零（连续语义：成功打断连击）。 */
  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  function requireBlobs(): BlobStore {
    if (!deps.blobs) throw new Error('BlobStore 未装配（工具面不可用）');
    return deps.blobs;
  }

  function requireApprovals(): ApprovalService {
    if (!deps.approvals) throw new Error('授权桥未装配（approved-mutation 面不可用）');
    return deps.approvals;
  }

  /** 任务行校验（任务域工具的归属绑定面）。 */
  function requireAgentTask(
    taskId: string,
    userId?: string,
  ): { ownerId: string; sessionId: string | null } {
    const task = deps.db
      .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
    if (userId !== undefined && task.owner_id !== userId) throw new Error('任务归属与操作者不符');
    return { ownerId: task.owner_id, sessionId: task.session_id };
  }

  const projectsInput = z.object({ limit: z.number().int().min(1).max(100).optional() });

  const definitions = [
    {
      name: 'studio.projects',
      description:
        '列出当前用户保存的贴钻工程/文档资源（id、名称、格式、大小、更新时间）。只读；用于确定后续排钻/编辑操作针对的资源。',
      authority: 'readonly' as const,
      input: projectsInput,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = projectsInput.safeParse(input);
        if (!parsed.success) {
          return noteFailure('global', 'studio.projects', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const limit = parsed.data.limit ?? 20;
        try {
          const rows = deps.db
            .prepare(
              'SELECT id, name, meta, size, updated_at FROM resources WHERE is_dir = 0 ORDER BY updated_at DESC LIMIT ?',
            )
            .all(limit) as { id: string; name: string; meta: string | null; size: number; updated_at: string }[];
          noteSuccess('global');
          return {
            kind: 'ok',
            value: {
              projects: rows.map((row) => ({
                id: row.id,
                name: row.name,
                kind: kindOfMeta(row.meta),
                size: row.size,
                updatedAt: row.updated_at,
              })),
            },
          };
        } catch (error) {
          return noteFailure('global', 'studio.projects', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.templates',
      description: '列出可用的贴钻模板资源（.gemtpl 导入的模板——id、名称、版本、更新时间）。只读。',
      authority: 'readonly' as const,
      input: projectsInput,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = projectsInput.safeParse(input);
        if (!parsed.success) {
          return noteFailure('global', 'studio.templates', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const limit = parsed.data.limit ?? 20;
        try {
          const rows = deps.db
            .prepare(
              "SELECT id, name, meta, updated_at FROM resources WHERE is_dir = 0 AND meta LIKE '%\"kind\":\"gemtpl\"%' ORDER BY updated_at DESC LIMIT ?",
            )
            .all(limit) as { id: string; name: string; meta: string | null; updated_at: string }[];
          noteSuccess('global');
          return {
            kind: 'ok',
            value: {
              templates: rows.map((row) => ({
                resourceId: row.id,
                name: row.name,
                formatVersion: metaNumber(row.meta, 'formatVersion'),
                updatedAt: row.updated_at,
              })),
            },
          };
        } catch (error) {
          return noteFailure('global', 'studio.templates', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.pave-preview',
      description:
        '排钻预览（只读、同参确定）：对上传图按排布参数跑 segment→layout，返回钻数/间距剔除数/图块元数据（颜色/位置/面积——自然语言选区域先看这里）与预览产物引用。'
        + '排布参数一等公民：strategy（hex-thin/hex-pitch/poisson/hybrid/cvt）、density（(0,1] 全局或逐块）、gapMm（≥0，0=相切）、seed（确定性）、relax。',
      authority: 'readonly' as const,
      input: PavePreviewInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = PavePreviewInputSchema.safeParse(input);
        const bucket = taskIdBucket(parsed.success ? parsed.data.taskId : undefined);
        if (!parsed.success) {
          return noteFailure(bucket, 'studio.pave-preview', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        if (p.taskId) requireAgentTask(p.taskId);
        try {
          const blobs = requireBlobs();
          const bytes = blobs.read(p.imageRef);
          if (bytes === null) throw new Error(`上传图不存在（blobRef=${p.imageRef.slice(0, 12)}…）`);
          const decoded = decodePng(bytes);
          const image = { width: decoded.width, height: decoded.height, data: decoded.rgba };
          const blocks = segment(image, {
            k: p.segmentK,
            seed: p.seed,
            gemDiameterPx: p.spec.diameterMm * p.pixelsPerMm,
          });
          if (blocks.length === 0) throw new Error('分块产出为空（图像内容不可分块）');
          const selected = p.region ? selectBlocks(blocks, p.region.ids) : blocks;
          const spec = {
            shapeId: p.spec.shapeId,
            sizeLabel: `${p.spec.diameterMm}mm`,
            diameterMm: p.spec.diameterMm,
            ...(p.spec.assetId !== undefined ? { assetId: p.spec.assetId } : {}),
          };
          const grid = gridFromSpec(spec as never, p.gapMm, p.pixelsPerMm);
          const result = layout(
            selected as never,
            p.strategy,
            { density: p.density, seed: p.seed, relax: p.relax } as never,
            grid as never,
          );
          const specFields = {
            shapeId: p.spec.shapeId,
            diameterMm: p.spec.diameterMm,
            ...(p.spec.rotationDeg !== undefined ? { rotationDeg: p.spec.rotationDeg } : {}),
            ...(p.spec.assetId !== undefined ? { assetId: p.spec.assetId } : {}),
          };
          const gems = result.gems.map((gem) => ({ ...gem, ...specFields }));
          mapColors(gems, selected as never, STARTER_PALETTE);
          const outcome: LayoutDocument = {
            kind: 'layout',
            version: 1,
            imageWidth: image.width,
            imageHeight: image.height,
            palette: STARTER_PALETTE as unknown as LayoutDocument['palette'],
            grid: grid as unknown as LayoutDocument['grid'],
            blocks: selected as unknown as LayoutDocument['blocks'],
            gems: gems as unknown as LayoutDocument['gems'],
            dropped: result.dropped ?? 0,
            shapeAssets: p.shapeAssets ?? {},
            pave: {
              strategy: p.strategy,
              density: p.density,
              seed: p.seed,
              relax: p.relax,
              spec: p.spec,
              pixelsPerMm: p.pixelsPerMm,
            },
          };
          const previewJson = Buffer.from(canonicalJson(outcome), 'utf8');
          const put = blobs.put(new Uint8Array(previewJson));
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              gemCount: gems.length,
              dropped: result.dropped ?? 0,
              warnings: result.warnings.length,
              blocks: blocksMeta(selected, gems),
              layoutBlobRef: put.hash,
              hint: '预览产物（layout 文档 JSON）可发布为真值资源后用 patch-propose 做区域修改',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'studio.pave-preview', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.export-dryrun',
      description:
        '导出预检（只读）：对真值文档跑 validate+exportGate，返回 verdict（ok=false 时逐条 violations）。'
        + '带 propose=true 时同时签发导出 proposal（用户批准后经 studio.export 执行）。',
      authority: 'readonly' as const,
      input: ExportDryrunInputSchema,
      async handler(input: unknown, principal: 'agent' | 'human-ui'): Promise<CapabilityCallResult> {
        const parsed = ExportDryrunInputSchema.safeParse(input);
        const bucket = taskIdBucket(parsed.success ? parsed.data.taskId : undefined);
        if (!parsed.success) {
          return noteFailure(bucket, 'studio.export-dryrun', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        if (p.taskId) requireAgentTask(p.taskId);
        try {
          const blobs = requireBlobs();
          const row = deps.db
            .prepare('SELECT owner_id FROM resources WHERE id = ?')
            .get(p.resourceId) as { owner_id: string } | undefined;
          if (!row) throw new Error(`资源不存在：${p.resourceId}`);
          const resource = loadLayoutDocument(deps.db, blobs, row.owner_id, p.resourceId);
          const warnings = validate(resource.doc.gems as never, resource.doc.grid as never, resource.doc.blocks as never);
          const verdict = exportGate(resource.doc.gems as never, {
            grid: resource.doc.grid as never,
            blocks: resource.doc.blocks as never,
            resolveShapeAsset: () => null,
          });
          let proposal: { proposalId: string; requestId: string; expiresAt: string } | undefined;
          if (p.propose) {
            if (!p.taskId) throw new Error('propose=true 需携带 taskId（审批帧归属）');
            if (principal !== 'agent') throw new Error('propose 模式仅 agent 主体（human-ui 导出面归服务端 job）');
            requireAgentTask(p.taskId, row.owner_id);
            const approvals = requireApprovals();
            const costSheet = Buffer.from(
              canonicalJson({ note: 'export proposal', resourceId: p.resourceId, gems: resource.doc.gems.length }),
              'utf8',
            );
            const sheetRef = blobs.put(new Uint8Array(costSheet)).hash;
            const issued = approvals.propose({
              taskId: p.taskId,
              userId: row.owner_id,
              tool: 'studio.export',
              resourceId: p.resourceId,
              baseRevision: resource.revision,
              payload: { kind: 'export', resourceId: p.resourceId, withPng: true },
              preview: { before: sheetRef, after: sheetRef },
              summary: `导出贴钻 ${resource.doc.gems.length} 钻（SVG/BOM/PNG 分享包）`,
            });
            proposal = { proposalId: issued.proposalId, requestId: issued.requestId, expiresAt: issued.expiresAt };
          }
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              verdict: { ok: verdict.ok, violations: verdict.violations },
              validateWarnings: warnings.length,
              ...(proposal ? { proposal, pending: '等待用户批准（approval-request 已入任务帧流）' } : {}),
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'studio.export-dryrun', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.bom',
      description: '物料清单（只读）：真值文档的 BOM CSV（规格×颜色聚合）与行数/总数、产物引用。',
      authority: 'readonly' as const,
      input: BomInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = BomInputSchema.safeParse(input);
        if (!parsed.success) {
          return noteFailure('global', 'studio.bom', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          const blobs = requireBlobs();
          const row = deps.db
            .prepare('SELECT owner_id FROM resources WHERE id = ?')
            .get(parsed.data.resourceId) as { owner_id: string } | undefined;
          if (!row) throw new Error(`资源不存在：${parsed.data.resourceId}`);
          const resource = loadLayoutDocument(deps.db, blobs, row.owner_id, parsed.data.resourceId);
          const csv = buildBom(resource.doc.gems as never, resource.doc.palette as never, resource.doc.grid as never);
          const put = blobs.put(new Uint8Array(Buffer.from(csv, 'utf8')));
          noteSuccess('global');
          return {
            kind: 'ok',
            value: {
              totalGems: resource.doc.gems.length,
              rows: csv.trimEnd().split('\n').length - 1,
              bomBlobRef: put.hash,
            },
          };
        } catch (error) {
          return noteFailure('global', 'studio.bom', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.patch-propose',
      description:
        '区域级修改草案（proposal——不动真值）：对真值文档的选定图块提出 setDensity/recolor/setSpec 变更，'
        + '返回 diff（before/after/预估钻数变化/dropped 如实呈现）与前后预览引用，并发起用户审批（approval-request 帧）。'
        + '批准后经 studio.patch-apply{taskId, proposalId} 落库。',
      authority: 'proposal' as const,
      input: PatchProposeInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = PatchProposeInputSchema.safeParse(input);
        const bucket = taskIdBucket(parsed.success ? parsed.data.taskId : undefined);
        if (!parsed.success) {
          return noteFailure(bucket, 'studio.patch-propose', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const blobs = requireBlobs();
          const approvals = requireApprovals();
          const row = deps.db
            .prepare('SELECT owner_id FROM resources WHERE id = ?')
            .get(p.resourceId) as { owner_id: string } | undefined;
          if (!row) throw new Error(`资源不存在：${p.resourceId}`);
          requireAgentTask(p.taskId, row.owner_id);
          const resource = loadLayoutDocument(deps.db, blobs, row.owner_id, p.resourceId);
          const { after, opRows } = applyPatchChanges(resource.doc, p.region, p.changes);
          const beforeBlob = blobs.put(new Uint8Array(Buffer.from(canonicalJson(resource.doc), 'utf8'))).hash;
          const afterBlob = blobs.put(new Uint8Array(Buffer.from(canonicalJson(after), 'utf8'))).hash;
          const estGemsDelta = after.gems.length - resource.doc.gems.length;
          const summary = `区域修改（${p.changes.length} op）：${opRows.map((r) => `${r.opKind}@${r.target}`).join('、')}——预估钻数 ${estGemsDelta >= 0 ? '+' : ''}${estGemsDelta}，dropped=${after.dropped}`;
          const issued = approvals.propose({
            taskId: p.taskId,
            userId: row.owner_id,
            tool: 'studio.patch-apply',
            resourceId: p.resourceId,
            baseRevision: resource.revision,
            payload: { kind: 'patch-apply', resourceId: p.resourceId, region: p.region, ops: p.changes },
            preview: { before: beforeBlob, after: afterBlob },
            summary,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              diff: {
                region: p.region,
                ops: opRows.map((r) => ({
                  op: r.opKind,
                  target: r.target,
                  before: JSON.parse(r.beforeJson),
                  after: JSON.parse(r.afterJson),
                })),
                preview: { beforeBlob, afterBlob },
                estGemsDelta,
                dropped: after.dropped,
              },
              pending: '等待用户批准（approval-request 已入任务帧流；未批准真值零变化）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'studio.patch-propose', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.patch-apply',
      description:
        '落库已批准的区域修改（approved-mutation）：只带 {taskId, proposalId}——服务端校验 grant（未消费/未过期/'
        + '摘要/归属匹配）与 revision CAS（批准期间资源被改必拒），单事务 claim+落库（本地恰好一次），记 patch_history 撤销组。',
      authority: 'approved-mutation' as const,
      input: MutationExecuteInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = MutationExecuteInputSchema.safeParse(input);
        const bucket = taskIdBucket(parsed.success ? parsed.data.taskId : undefined);
        if (!parsed.success) {
          return noteFailure(bucket, 'studio.patch-apply', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const blobs = requireBlobs();
          const approvals = requireApprovals();
          const task = requireAgentTask(p.taskId);
          // 本地恰好一次（§3.6 R3）：grant 消费+claim+真值落库+history+结算——单一事务。
          const apply = deps.db.transaction((): CapabilityCallResult => {
            const consume = approvals.consumeForExecution({
              proposalId: p.proposalId,
              taskId: p.taskId,
              userId: task.ownerId,
              tool: 'studio.patch-apply',
            });
            if (!consume.ok) {
              return failedOf(consume.reason, consume.message);
            }
            const op = consume.op;
            const payload = JSON.parse(op.payload_json as string) as {
              resourceId: string;
              region: { kind: 'blocks'; ids: string[] };
              ops: unknown[];
            };
            const resource = loadLayoutDocument(deps.db, blobs, op.user_id, payload.resourceId);
            const { after, opRows } = applyPatchChanges(resource.doc, payload.region, payload.ops as never);
            const undoGroup = op.proposal_id; // patch 组=proposalId（「一次撤销恢复整组」的组语义）
            const now = new Date().toISOString();
            for (const row of opRows) {
              deps.db
                .prepare(
                  `INSERT INTO patch_history (id, owner_id, resource_id, patch_group, proposal_id, op_kind, target, before_json, after_json, base_revision, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                )
                .run(
                  randomUUID(),
                  op.user_id,
                  payload.resourceId,
                  undoGroup,
                  op.proposal_id,
                  row.opKind,
                  row.target,
                  row.beforeJson,
                  row.afterJson,
                  resource.revision,
                  now,
                );
            }
            const { revision } = rewriteLayoutDocument(deps.db, blobs, payload.resourceId, after);
            deps.db
              .prepare("UPDATE approved_ops SET state = 'succeeded', updated_at = ? WHERE proposal_id = ? AND state = 'claimed'")
              .run(now, op.proposal_id);
            return {
              kind: 'ok',
              value: {
                applied: opRows.length,
                revision,
                gems: after.gems.length,
                dropped: after.dropped,
                patchGroup: undoGroup,
                note: '单 op 已落库（claim+落库同事务=恰好一次）；撤销=studio.undo{family:"patch", resourceId}（整组逆序回退）',
              },
            };
          });
          const outcome = apply();
          if (outcome.kind === 'ok') noteSuccess(bucket);
          return outcome; // 必拒路径（授权语义）不记熔断连击——直接呈现
        } catch (error) {
          return noteFailure(bucket, 'studio.patch-apply', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.generate',
      description:
        '图像生成（approved-mutation 双模）：带 {taskId, prompt, ...} = 发起 proposal（审批通过前不外呼）；'
        + '带 {taskId, proposalId} = 执行已批准的生成（provider 幂等键语义：支持幂等键的重试收敛同一远端结果；'
        + '不支持的 provider 崩溃后置 unknown，重试经 session.retry 用户确认——可能再次计费）。',
      authority: 'approved-mutation' as const,
      input: z.union([GenerateProposeInputSchema, MutationExecuteInputSchema]),
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const propose = GenerateProposeInputSchema.safeParse(input);
        const execute = MutationExecuteInputSchema.safeParse(input);
        const bucket = taskIdBucket(propose.success ? propose.data.taskId : execute.success ? execute.data.taskId : undefined);
        if (!propose.success && !execute.success) {
          return noteFailure(
            bucket,
            'studio.generate',
            `参数不合法（双模：发起={taskId,prompt,...} 或 执行={taskId,proposalId}）：${[...propose.error.issues.slice(0, 2), ...execute.error.issues.slice(0, 2)].map((i) => i.message).join('; ')}`,
          );
        }
        try {
          const blobs = requireBlobs();
          const approvals = requireApprovals();
          if (propose.success) {
            const p = propose.data;
            const task = requireAgentTask(p.taskId);
            const costSheet = Buffer.from(
              canonicalJson({ note: 'generate proposal', prompt: p.prompt, size: p.size ?? null, imageRef: p.imageRef ?? null }),
              'utf8',
            );
            const sheetRef = blobs.put(new Uint8Array(costSheet)).hash;
            const issued = approvals.propose({
              taskId: p.taskId,
              userId: task.ownerId,
              tool: 'studio.generate',
              payload: {
                kind: 'generate',
                prompt: p.prompt,
                ...(p.size !== undefined ? { size: p.size } : {}),
                ...(p.imageRef !== undefined ? { imageRef: p.imageRef } : {}),
                ...(p.advanced !== undefined ? { advanced: p.advanced } : {}),
              },
              preview: { before: sheetRef, after: sheetRef },
              summary: `生成图像：${p.prompt.slice(0, 80)}${p.prompt.length > 80 ? '…' : ''}${p.imageRef ? '（含参考图）' : ''}`,
            });
            noteSuccess(bucket);
            return {
              kind: 'ok',
              value: {
                proposalId: issued.proposalId,
                requestId: issued.requestId,
                expiresAt: issued.expiresAt,
                pending: '等待用户批准（approval-request 已入任务帧流；批准后以 {taskId, proposalId} 调用执行）',
              },
            };
          }
          const p = execute.success ? execute.data : null;
          if (!p) throw new Error('generate 双模解析异常（不可达）');
          const task = requireAgentTask(p.taskId);
          const consume = approvals.consumeForExecution({
            proposalId: p.proposalId,
            taskId: p.taskId,
            userId: task.ownerId,
            tool: 'studio.generate',
          });
          if (!consume.ok) return failedOf(consume.reason, consume.message);
          if (consume.op.resource_id !== null) throw new Error('generate proposal 不应绑定资源（数据不一致）');
          const attempt = approvals.startExternalAttempt(p.proposalId);
          const payload = JSON.parse(consume.op.payload_json as string) as {
            prompt: string;
            size?: string;
            imageRef?: string;
            advanced?: unknown;
          };
          const executor = deps.generateExecutor ?? defaultGenerateExecutor(deps);
          try {
            const bytes = await executor(payload, {
              idemKey: attempt.idem_key,
              attemptId: attempt.attempt_id,
              proposalId: p.proposalId,
              attemptNo: attempt.attempt_no,
            });
            const put = blobs.put(bytes);
            approvals.settleExternal(p.proposalId, { kind: 'succeeded', resultRef: put.hash });
            deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: put.hash, name: 'generated.png' });
            noteSuccess(bucket);
            return {
              kind: 'ok',
              value: { blobRef: put.hash, attemptId: attempt.attempt_id, attemptNo: attempt.attempt_no, size: bytes.byteLength },
            };
          } catch (error) {
            if (error instanceof SimulatedCrashError) {
              // 崩溃语义：不结算——op/attempt 停留 running（重启后收敛 unknown）。
              return {
                kind: 'failed',
                code: 'UNAVAILABLE',
                message: `生成中断（未结算——状态将收敛 unknown，重试需用户经 session.retry 确认）：${error.message}`,
              };
            }
            approvals.settleExternal(p.proposalId, { kind: 'failed', message: error instanceof Error ? error.message : String(error) });
            throw error;
          }
        } catch (error) {
          return noteFailure(bucket, 'studio.generate', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.export',
      description:
        '执行已批准的导出（approved-mutation）：只带 {taskId, proposalId}——gate 复验 + SVG/BOM/PNG 分享包'
        + '（本地 bundle，恰好一次）+ /r/{public_id} 分享链接。proposal 经 studio.export-dryrun{propose:true} 签发。',
      authority: 'approved-mutation' as const,
      input: MutationExecuteInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = MutationExecuteInputSchema.safeParse(input);
        const bucket = taskIdBucket(parsed.success ? parsed.data.taskId : undefined);
        if (!parsed.success) {
          return noteFailure(bucket, 'studio.export', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const approvals = requireApprovals();
          const task = requireAgentTask(p.taskId);
          const consume = approvals.consumeForExecution({
            proposalId: p.proposalId,
            taskId: p.taskId,
            userId: task.ownerId,
            tool: 'studio.export',
          });
          if (!consume.ok) return failedOf(consume.reason, consume.message);
          const payload = JSON.parse(consume.op.payload_json as string) as { resourceId: string; withPng: boolean };
          // 本地恰好一次：执行→结算（崩溃窗口→unknown 诚实呈现；export 无外部副作用）。
          const { bundle } = runLayoutExport(deps, payload.resourceId, task.ownerId, p.taskId, payload.withPng);
          approvals.settleExternal(p.proposalId, { kind: 'succeeded', resultRef: bundle.resultId });
          for (const [name, hash] of Object.entries(bundle.blobRefs)) {
            deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: hash, name });
          }
          deps.jobs?.emitFor(p.taskId, 'transcript', { role: 'tool', text: `分享链接：/r/${bundle.publicId}` });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              resultId: bundle.resultId,
              publicId: bundle.publicId,
              bundle: bundle.blobRefs,
              note: '导出完成（撤销=studio.undo{family:"export", resultId}——分享包 revoke+bundle 释放）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'studio.export', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'studio.undo',
      description:
        '撤销补偿（§3.6.7 按族拆分——不承诺跨族「撤销整组」）：patch=patch_history 整组逆序回退（回退也记 history）；'
        + 'generate=未完成取消+产物清理（不可逆——远端结果不回滚）；export=分享包 revoke+bundle 释放。human-ui 直调。',
      authority: 'approved-mutation' as const,
      input: UndoInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = UndoInputSchema.safeParse(input);
        if (!parsed.success) {
          return noteFailure('undo', 'studio.undo', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const blobs = requireBlobs();
          const undoDeps = { db: deps.db, blobs, ...(deps.revokeResult ? { revokeResult: deps.revokeResult } : {}) };
          let outcome;
          if (p.family === 'patch') {
            if (!p.resourceId) throw new Error('patch 撤销需 resourceId');
            const row = deps.db
              .prepare('SELECT owner_id FROM resources WHERE id = ?')
              .get(p.resourceId) as { owner_id: string } | undefined;
            if (!row) throw new Error(`资源不存在：${p.resourceId}`);
            outcome = undoPatchGroup(undoDeps, {
              ownerId: row.owner_id,
              resourceId: p.resourceId,
              ...(p.group ? { group: p.group } : {}),
            });
          } else if (p.family === 'generate') {
            if (!p.proposalId) throw new Error('generate 撤销需 proposalId');
            outcome = undoGenerate(undoDeps, p.proposalId);
          } else {
            outcome = undoExport(undoDeps, {
              ...(p.proposalId ? { proposalId: p.proposalId } : {}),
              ...(p.resultId ? { resultId: p.resultId } : {}),
            });
          }
          noteSuccess('undo');
          return { kind: 'ok', value: outcome };
        } catch (error) {
          return noteFailure('undo', 'studio.undo', error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  // 授权桥（§3.6）：approved-mutation 对 agent 的 call 路径预检（W4.2 扩展——
  // 未装配 approvals 时保持 W4.1 一律 principal-forbidden 语义）。
  // generate 双模例外：{taskId, prompt} 无 proposalId=发起 proposal（proposal 面
  // 无副作用——不外呼不动真值，授权发生在执行模式）；其余一律走桥预检。
  return createCapabilityRegistry(definitions, {
    ...(deps.approvals
      ? {
          mutationAuth: {
            precheck: (name: string, input: unknown) => {
              if (name === 'studio.generate') {
                const typed = (input ?? {}) as { proposalId?: unknown; prompt?: unknown };
                if (typed.proposalId === undefined && typeof typed.prompt === 'string') return { ok: true };
              }
              return deps.approvals!.precheckMutation(name, input);
            },
          },
        }
      : {}),
  });
}

// ---------------------------------------------------------------- 局部 helpers

function failedOf(
  reason: string,
  message: string,
): CapabilityCallResult {
  const code =
    reason === 'stale-revision' ? ('STALE' as const) : reason === 'concurrent' ? ('CONFLICT' as const) : ('INVALID_OPERATION' as const);
  return { kind: 'failed', code, message };
}

function taskIdBucket(taskId: string | undefined): string {
  return taskId ?? 'global';
}

function kindOfMeta(meta: string | null): string {
  if (!meta) return 'unknown';
  try {
    const parsed = JSON.parse(meta) as { kind?: unknown };
    return typeof parsed.kind === 'string' ? parsed.kind : 'unknown';
  } catch {
    return 'unknown';
  }
}

function metaNumber(meta: string | null, key: string): number | undefined {
  if (!meta) return undefined;
  try {
    const parsed = JSON.parse(meta) as Record<string, unknown>;
    const value = parsed[key];
    return typeof value === 'number' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** 图块元数据（§3.4：agent 自然语言→区域的只读查询面）。 */
function blocksMeta(
  blocks: Array<{ id: string; label: string; colorRgb: [number, number, number]; areaPx: number; bbox: { x: number; y: number; w: number; h: number } }>,
  gems: Array<{ blockId: string }>,
): unknown[] {
  return blocks.map((block) => ({
    id: block.id,
    label: block.label,
    color: `#${block.colorRgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`,
    position: { x: block.bbox.x, y: block.bbox.y },
    areaPx: block.areaPx,
    gemCount: gems.filter((gem) => gem.blockId === block.id).length,
  }));
}

function selectBlocks<T extends { id: string }>(blocks: T[], ids: string[]): T[] {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`region 引用不存在的图块 ID：${unknown.join('、')}（可用：${blocks.map((b) => b.id).join('、')}）`);
  }
  return ids.map((id) => byId.get(id)!);
}

/** 真值文档导出执行（export 工具与未来复用面）：gate 复验 + 三产物 + 分享包发布。 */
function runLayoutExport(
  deps: StudioCapabilitiesDeps,
  resourceId: string,
  ownerId: string,
  taskId: string,
  withPng: boolean,
): { bundle: ReturnType<typeof createShareBundle>; publicId: string } {
  if (!deps.blobs) throw new Error('BlobStore 未装配（工具面不可用）');
  if (!deps.config) throw new Error('配置面未装配（分享包 TTL 不可解析）');
  const resource = loadLayoutDocument(deps.db, deps.blobs, ownerId, resourceId);
  const verdict = exportGate(resource.doc.gems as never, {
    grid: resource.doc.grid as never,
    blocks: resource.doc.blocks as never,
    resolveShapeAsset: () => null,
  });
  if (!verdict.ok) {
    throw new Error(
      `导出前置门未通过（${verdict.violations.length} 项违规）：\n${verdict.violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n')}`,
    );
  }
  const svg = buildSvg(
    resource.doc.gems as never,
    resource.doc.grid as never,
    {
      width: resource.doc.imageWidth,
      height: resource.doc.imageHeight,
      palette: resource.doc.palette as never,
      blocks: resource.doc.blocks as never,
    } as never,
  );
  const bom = buildBom(resource.doc.gems as never, resource.doc.palette as never, resource.doc.grid as never);
  const png = withPng
    ? renderGemsPng({
        gems: resource.doc.gems as never,
        palette: resource.doc.palette as never,
        grid: resource.doc.grid as never,
        width: resource.doc.imageWidth,
        height: resource.doc.imageHeight,
      } as never)
    : encodePng(1, 1, new Uint8Array(4));
  const bundle = createShareBundle(
    { config: deps.config, db: deps.db, blobs: deps.blobs },
    {
      taskId,
      ownerId,
      title: `贴钻 ${resource.doc.gems.length} 钻`,
      files: { svg: Buffer.from(svg, 'utf8'), bom: Buffer.from(bom, 'utf8'), png },
    },
  );
  return { bundle, publicId: bundle.publicId };
}

/** 生产 generate 执行器：dry-run 占位 / 真实 callImagesApi（对齐 jobs/generate.ts）。 */
function defaultGenerateExecutor(deps: StudioCapabilitiesDeps): GenerateExecutor {
  return async (payload) => {
    if (!deps.config) throw new Error('generate 执行器未装配配置（config 缺失）');
    const effective = resolveImgConfig(deps.db, deps.config);
    if (deps.config.imgDryRun) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return placeholderPng(payload.prompt);
    }
    const image = payload.imageRef
      ? (() => {
          const bytes = deps.blobs?.read(payload.imageRef);
          if (!bytes) throw new Error(`生成原图不存在（blobRef=${payload.imageRef.slice(0, 12)}…）`);
          return { filename: 'input.png', bytes: Buffer.from(bytes), mime: 'image/png' };
        })()
      : undefined;
    const result = await callImagesApi(
      effective,
      {
        prompt: payload.prompt,
        ...(payload.size ? { size: payload.size } : {}),
        ...(image ? { image } : {}),
        ...(payload.advanced ? { advanced: payload.advanced as Record<string, unknown> } : {}),
      },
      fetch,
      new AbortController().signal,
    );
    return result.image;
  };
}

/** dry-run 占位图（prompt 哈希确定色四钻小图——与 jobs/generate.ts 同式）。 */
function placeholderPng(prompt: string): Uint8Array {
  const hash = createHash('sha256').update(prompt).digest();
  const rgb: [number, number, number] = [hash[0]!, 64 + (hash[1]! % 128), 64 + (hash[2]! % 128)];
  const hex = `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const palette = [{ id: 'ph', name: '占位', hex }] as never;
  const gems = [
    { id: 'p1', x: 15, y: 15, colorId: 'ph', blockId: 'ph', shapeId: 'round', diameterMm: 3 },
    { id: 'p2', x: 48, y: 15, colorId: 'ph', blockId: 'ph', shapeId: 'square', diameterMm: 3, rotationDeg: 45 },
    { id: 'p3', x: 15, y: 48, colorId: 'ph', blockId: 'ph', shapeId: 'marquise', diameterMm: 3 },
    { id: 'p4', x: 48, y: 48, colorId: 'ph', blockId: 'ph', shapeId: 'heart', diameterMm: 3 },
  ] as never;
  return renderGemsPng({
    gems,
    palette,
    grid: { pitchMm: 3.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 8 },
    width: 64,
    height: 64,
  } as never);
}
