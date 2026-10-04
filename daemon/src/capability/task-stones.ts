/**
 * 任务域项目钻 MCP 工具面（add-task-stones-manifest-export 2.1/2.2——arch-decisions
 * A4 裁定：任务域只读/变更两能力；集合（set.*）与全局库（stones.*、stone.*）保持分层）。
 * 原始需求 2026-09-29（Owner）：项目可在集合基础上补充任务可用钻，但**只能添加系统
 * 已有钻**（新增钻型=管理员权限）；模型须与用户讨论，确定后调 MCP 引入。
 * 授权语义（A4）：
 *   - studio.task.stones.list = readonly（agent 直调）；
 *   - studio.task.stones.add = approved-mutation 双模（照 stones.ts 先例：无
 *     proposalId=草案[返回将添加明细+approval request]；有=消费 grant 执行）。
 *   - 「先与用户讨论再添加」写入工具 description 与返回消息（提示层）——真正边界
 *     是服务端校验：逐 ref 查 stone_index（存在/未软删/物料 blob 在场——
 *     materializeStoneRef 物化单源）+ expectedRevision CAS（writeManifestTx 唯一
 *     写面）+ task owner（writeManifest fence）+ 授权桥 grant 消费。
 * 纪律（A4 风险节「只做提示词会被模型误调用；只做字符串格式检查会允许库外幻觉」）：
 *   - 服务端回填完整 StonePick/源 blob 快照——模型不能提交 sku/颜色作为真源；
 *   - expectedRevision stale=typed STALE（携 currentRevision 幂等重试锚）；
 *   - 成功后 revision+1+重算 stones-lint.json 工件（lintTaskStoneRefs 单源）+
 *     返回 {added/alreadyPresent/lint}——alreadyPresent 幂等（全在场=零写不进位）。
 * 正交意图：
 *   [1] list：manifest 摘要+lint summary+可追加候选（query 过滤 stone_index 共享库
 *       投影——排除已引入条目）。
 *   [2] add 双模：propose（库内校验+CAS 基线预检+将添加明细预览）→ execute
 *       （grant 消费+writeManifestTx CAS+执行期重物化+lint 工件重算）。
 */
import { z } from 'zod';
import type { StonesManifestEntry, StoneLintResult } from '@handicraft/contracts';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import type { JobService } from '../jobs/service.js';
import type { SessionProjectRow } from '../db/sessions.js';
import { getSessionProject } from '../db/sessions.js';
import {
  ProjectManifestError,
  ProjectManifestService,
  readStonesManifestBlob,
} from '../kernel/project-manifest.js';
import { lintTaskStoneRefs, putStoneLintArtifact } from '../kernel/project-lint.js';
import { latestSessionArtifactAnchor } from '../kernel/session-artifacts.js';
import { STRATEGY_PLAN_ARTIFACT_NAME } from '../kernel/strategies/design.js';
import { ProjectExpandError, materializeStoneRef } from '../kernel/project-expand.js';
import { StoneService } from '../stones/service.js';
import type { ApprovalService, ConsumeDenyReason } from './authorization.js';
import { approvalFaceOf } from './authorization.js';
import type { ApprovedOpRow } from '../db/approvals.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from './core.js';
import { RUNAWAY_LIMIT } from './studio.js';

export const TASK_STONES_LIST_TOOL_NAME = 'studio.task.stones.list';
export const TASK_STONES_ADD_TOOL_NAME = 'studio.task.stones.add';

/** 单次追加钻引用数上界（proposal payload 有界——批量入库归 admin 面）。 */
const MAX_ADD_REFS = 100;

/** 可追加候选返回上界（prompt 有界——全量浏览走 stones.list 共享库面）。 */
const MAX_CANDIDATES = 100;

export interface TaskStonesCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** FrameStore latest-by-name 读面（strategy-plan/stones-lint 定位——lint 单源函数消费）。 */
  config: AppConfig;
  /** 帧提交单点（approval-request/artifact/transcript——任务域工具必需）。 */
  jobs?: JobService;
  /** §3.6 授权桥（approved-mutation 面；缺省时按 core.ts 一律 principal-forbidden）。 */
  approvals?: ApprovalService;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

// ---------------------------------------------------------------- 输入 schema

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（owner 绑定与审计链的上下文——服务端以任务行解析所属会话/项目）');
const ProposalIdField = z.string().min(1).describe('已批准 proposal id（执行模式——grant 服务端内部关联）');
const ExpectedRevisionField = z
  .number()
  .int()
  .min(0)
  .describe('发起时读到的项目 manifest revision（CAS 基线——studio.task.stones.list 的 manifest.revision）');
const StoneRefsField = z
  .array(z.string().min(1))
  .min(1)
  .max(MAX_ADD_REFS)
  .describe('要纳入项目的钻 resourceId 列表（stoneRef——共享库引用键；只收身份，物料由服务端回填）');

const ListInputSchema = z.object({
  taskId: TaskIdField,
  query: z.string().min(1).optional().describe('可追加候选过滤（SKU/色名/色系/供应商/十六进制子串——stones.list q 同面）'),
  limit: z.number().int().min(1).max(MAX_CANDIDATES).default(20).describe('可追加候选返回上限（缺省 20）'),
});

/** 双模外层 schema（照 stones.ts 先例：外层全可选，propose 齐备性 handler 内二次校验）。 */
const AddInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  expectedRevision: ExpectedRevisionField.optional(),
  stoneRefs: StoneRefsField.optional(),
});

// ---------------------------------------------------------------- 工具面构造

export function createTaskStonesCapabilities(deps: TaskStonesCapabilitiesDeps): CapabilityRegistry {
  const stones = new StoneService({ db: deps.db, blobs: deps.blobs });
  const manifests = new ProjectManifestService({ config: deps.config, db: deps.db, blobs: deps.blobs, jobs: deps.jobs });
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

  /** 任务行校验（owner 绑定面——stones.ts agentTaskOf 同语义本地面）。 */
  function agentTaskOf(taskId: string): { ownerId: string; sessionId: string | null } {
    const task = deps.db
      .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
    return { ownerId: task.owner_id, sessionId: task.session_id };
  }

  /** 会话锚解析（A1：项目=一个 session——taskId 服务端解析 sessionId，模型不携带）。 */
  function sessionProjectOf(taskId: string): { sessionId: string; row: SessionProjectRow } {
    const task = agentTaskOf(taskId);
    if (task.sessionId === null) {
      throw new Error(`任务 ${taskId} 不属于任何会话——项目钻清单以会话为锚（A1），无项目语义`);
    }
    const row = getSessionProject(deps.db, task.sessionId);
    if (row === null) {
      throw new Error('会话尚无项目钻清单（首条常规消息创建项目后才能追加——先经 studio.task.stones.list 观察）');
    }
    return { sessionId: task.sessionId, row };
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

  /** 双模判定（type guard）：proposalId 在场=执行模式。 */
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

  /** ProjectManifestError → MCP 闭合结果（stale=STALE 携 currentRevision；余=INVALID_OPERATION）。 */
  function manifestFailureOf(error: ProjectManifestError): CapabilityCallResult {
    if (error.kind === 'stale') {
      return {
        kind: 'failed',
        code: 'STALE',
        message: `${error.message}——以 currentRevision=${error.currentRevision ?? '?'} 重新观察（studio.task.stones.list）并发起新提案`,
      };
    }
    return { kind: 'failed', code: 'INVALID_OPERATION', message: `项目清单写入被拒（${error.kind}）：${error.message}` };
  }

  /**
   * 追加执行核（execute 事务内消费——A4 唯一写面 writeManifestTx）：
   * 执行期重物化（proposal→执行间库内漂移=必拒不猜）；alreadyPresent 幂等
   * （全在场=零写不进位——revision 不前进）；有新增=revision+1。
   */
  function applyAdd(
    ownerId: string,
    input: { taskId: string; sessionId: string; stoneRefs: string[]; expectedRevision: number },
  ): { added: string[]; alreadyPresent: string[]; revision: number } {
    const { revision: currentRevision, manifest } = manifests.loadManifest(input.sessionId);
    const present = new Set(manifest?.entries.map((entry) => entry.stoneRef) ?? []);
    const orderedRefs = [...new Set(input.stoneRefs)];
    const alreadyPresent = orderedRefs.filter((ref) => present.has(ref));
    const toAdd = orderedRefs.filter((ref) => !present.has(ref));
    if (toAdd.length === 0) {
      // 幂等无变化：不写 manifest（revision 不前进）——grant 已消费，结果=已生效面
      // （revision 回报电流值——可能与提案基线不同：并发他写已把同款引入）。
      return { added: [], alreadyPresent, revision: currentRevision };
    }
    const result = manifests.writeManifestTx({ id: ownerId, role: 'user' }, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
      build: (current) => {
        if (current === null) {
          throw new ProjectManifestError('会话项目清单在执行期消失（数据不一致）', 'session-not-found');
        }
        // 服务端回填物化（A4：StonePick/源 blob 快照——模型不提交物料真源）；
        // manual-add 无备料输入——quantity 0=未设置备料参考（A2 偏差 3 同语义）。
        const newEntries: StonesManifestEntry[] = toAdd.map((stoneRef) => {
          const materialized = materializeStoneRef({ db: deps.db, blobs: deps.blobs }, stoneRef);
          return {
            stoneRef,
            pick: materialized.pick,
            stoneRevision: materialized.stoneRevision,
            stoneJsonBlobRef: materialized.stoneJsonBlobRef,
            textureBlobRef: materialized.textureBlobRef,
            // daemon 无 .gemshape 全局资产面（project-expand 冻结裁量——恒 null）。
            shapeAssetBlobRef: null,
            quantity: 0,
            origin: 'manual-add',
          };
        });
        return { sourceSet: current.sourceSet, entries: [...current.entries, ...newEntries] };
      },
    });
    return { added: toAdd, alreadyPresent, revision: result.manifest.revision };
  }

  /**
   * strategy-plan 源任务解析（P0 会话域缺省锚——2026-10-01）：lint 数据源按任务域
   * latest-by-name 读 plan，多轮会话换绑新 taskId 后当前任务域无 plan=lint 恒 null
   * ——回退解析本会话（同 owner）最近成功落档的 strategy-plan.json（当前任务自有
   * plan 时其帧 ts 天然最新，解析落回自身，行为零漂移）。无任何落档=fallback
   * 当前 taskId（lintTaskStoneRefs 既有 null 语义）。
   */
  function strategyPlanSourceTask(taskId: string, ownerId: string, sessionId: string): string {
    const anchor = latestSessionArtifactAnchor(
      { db: deps.db, config: deps.config },
      { sessionId, ownerId, name: STRATEGY_PLAN_ARTIFACT_NAME },
    );
    return anchor?.taskId ?? taskId;
  }

  /** lint 工件重算（add 后：对当前 plan 以新 manifest 重算——warning 消除即在此可见）。 */
  function recomputeLint(sessionId: string, ownerId: string, taskId: string): StoneLintResult | null {
    try {
      const linted = lintTaskStoneRefs(
        { db: deps.db, blobs: deps.blobs, config: deps.config },
        { sessionId, sourceTaskId: strategyPlanSourceTask(taskId, ownerId, sessionId) },
      );
      if (linted === null) return null;
      putStoneLintArtifact(
        { db: deps.db, blobs: deps.blobs, ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}) },
        { taskId, lint: linted.lint },
      );
      return linted.result;
    } catch {
      return null; // 派生面不放大（manifest 写已成功——A3 接线纪律）
    }
  }

  const definitions: CapabilityDefinition[] = [
    {
      name: TASK_STONES_LIST_TOOL_NAME,
      description:
        '项目钻清单观察（只读）：当前会话项目的 manifest（revision/溯源集合/已引入条目摘要）+ lint 摘要'
        + '（unintroduced=计划引用但未引入[warning]/unresolvable=库外或软删[hard]/introduced=已引入/unused=已引入未用）'
        + '+ 可追加候选（共享库现存钻——排除已引入，query 可按 SKU/色名/色系/供应商过滤）。'
        + '追加钻请先与用户讨论确认，再经 studio.task.stones.add 发起提案。',
      authority: 'readonly' as const,
      input: ListInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ListInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, TASK_STONES_LIST_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const { sessionId } = sessionProjectOf(p.taskId);
          const manifest = readStonesManifestBlob(deps.blobs, getSessionProject(deps.db, sessionId)!.blob_ref);
          // lint summary（lintTaskStoneRefs 单源）：数据源 plan=当前任务自有，缺省回退
          // 会话域最近成功落档（P0 会话域缺省锚——多轮会话延续上轮 plan）。尚无
          // plan=null（lint 无数据源）。
          const lint =
            lintTaskStoneRefs(
              { db: deps.db, blobs: deps.blobs, config: deps.config },
              { sessionId, sourceTaskId: strategyPlanSourceTask(p.taskId, agentTaskOf(p.taskId).ownerId, sessionId) },
            )?.result.summary ?? null;
          // 可追加候选：共享库现存未软删（共享读——评审 D-1 同 stones.list），排除
          // 已引入条目；query=SKU/色名/色系/供应商/十六进制子串（同面）。
          const introduced = new Set(manifest.entries.map((entry) => entry.stoneRef));
          const needle = p.query?.toLowerCase();
          const candidates = stones
            .listIndexRows()
            .filter((row) => {
              if (row.trashed === 1 || introduced.has(row.resource_id)) return false;
              if (needle === undefined) return true;
              return [row.sku, row.supplier, row.family, row.style_name ?? '', row.color_hex]
                .join('\u0000')
                .toLowerCase()
                .includes(needle);
            })
            .slice(0, p.limit)
            .map((row) => ({
              stoneRef: row.resource_id,
              sku: row.sku,
              supplier: row.supplier,
              sizeMm: row.size_mm,
              colorHex: row.color_hex,
            }));
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              projectId: sessionId,
              manifest: {
                revision: manifest.revision,
                sourceSet: manifest.sourceSet,
                entryCount: manifest.entries.length,
                entries: manifest.entries.map((entry) => ({
                  stoneRef: entry.stoneRef,
                  sku: entry.pick.sku,
                  supplier: entry.pick.supplier,
                  sizeMm: entry.pick.sizeMm,
                  colorHex: entry.pick.colorHex,
                  quantity: entry.quantity,
                  origin: entry.origin,
                  ...(entry.note !== undefined ? { note: entry.note } : {}),
                })),
              },
              lint,
              candidates,
              note: 'candidates=可追加候选（库内现存未引入）；追加前先与用户讨论确认（studio.task.stones.add 提案→批准→执行）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_STONES_LIST_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: TASK_STONES_ADD_TOOL_NAME,
      description:
        '项目钻追加（approved-mutation 双模）：带 expectedRevision+stoneRefs = 发起 proposal（服务端逐 ref 校验'
        + '库内存在未软删+回填 StonePick 物化快照——模型只给 stoneRef 身份；返回将添加明细与 approval request）；'
        + 'autoApprove 会话：发起返回 autoApproved=true+「立即执行」指令时立即以 {taskId, proposalId} 调用执行（勿等待用户）；'
        + '带 proposalId = 执行已批准的追加（grant 消费+manifest revision CAS——并发他写必拒 STALE；成功 revision+1'
        + '+重算 lint 工件，返回 added/alreadyPresent/lint）。**先与用户讨论确认要纳入项目的钻，再调用本工具**'
        + '（只能引入系统已有钻——新增钻型=管理员权限）。',
      authority: 'approved-mutation' as const,
      input: AddInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = AddInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            TASK_STONES_ADD_TOOL_NAME,
            `参数不合法（双模：发起={taskId,expectedRevision,stoneRefs} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.expectedRevision !== undefined || p.stoneRefs !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            const approvals = requireApprovals();
            const task = agentTaskOf(p.taskId);
            let outcome: CapabilityCallResult;
            try {
              // 本地恰好一次执行壳（照 stones.ts）：consume→writeManifestTx（嵌套
              // savepoint）→settle 同一事务——lint/帧/清单帧归事务外（帧失败≠写失败）。
              const tx = deps.db.transaction((): CapabilityCallResult => {
                const consume = approvals.consumeForExecution({
                  proposalId: p.proposalId,
                  taskId: p.taskId,
                  userId: task.ownerId,
                  tool: TASK_STONES_ADD_TOOL_NAME,
                });
                if (!consume.ok) return failedOf(consume.reason, consume.message);
                const payload = payloadOf(consume.op);
                const payloadSessionId = payload['sessionId'];
                const payloadRefs = payload['stoneRefs'];
                const payloadRevision = payload['expectedRevision'];
                if (
                  typeof payloadSessionId !== 'string' ||
                  !Array.isArray(payloadRefs) ||
                  payloadRefs.some((ref) => typeof ref !== 'string') ||
                  typeof payloadRevision !== 'number'
                ) {
                  throw new Error('proposal 载荷不完整（sessionId/stoneRefs/expectedRevision——数据不一致）');
                }
                if (task.sessionId !== payloadSessionId) {
                  throw new Error(
                    `proposal 载荷会话绑定漂移（${payloadSessionId} ≠ 任务会话 ${task.sessionId}）——重新发起提案`,
                  );
                }
                // P2-2（2026-09-28 复核）：批准的物料版本绑定——proposal 携带的
                // stoneSnapshots 与当前库逐款（将写入的新增 ref）比对 stoneRevision，
                // 漂移=typed STALE 并结算 op failed（grant 消费——该批准对应的预览
                // 已不存在，重试永不能成功，须重新提案重看预览）。alreadyPresent 面
                // （并发他写已引入）不写入不比对——幂等 no-op 语义不变。比对先于
                // applyAdd（漂移=零写入）。
                if (Array.isArray(payload['stoneSnapshots'])) {
                  const snapshots = payload['stoneSnapshots'] as Array<{
                    stoneRef: string;
                    stoneRevision: number;
                  }>;
                  const present = new Set(
                    (manifests.loadManifest(payloadSessionId).manifest?.entries ?? []).map((entry) => entry.stoneRef),
                  );
                  const drifted: string[] = [];
                  for (const snapshot of snapshots) {
                    if (present.has(snapshot.stoneRef)) continue;
                    let currentRevision: number | null = null;
                    try {
                      currentRevision = materializeStoneRef({ db: deps.db, blobs: deps.blobs }, snapshot.stoneRef).stoneRevision;
                    } catch {
                      // 库外/软删：不在此放行也不在此误报 STALE——交 applyAdd 既有
                      // stone-unresolvable typed 拒（存在性校验语义不变）。
                      continue;
                    }
                    if (currentRevision !== snapshot.stoneRevision) drifted.push(snapshot.stoneRef);
                  }
                  if (drifted.length > 0) {
                    approvals.settleExternal(consume.op.proposal_id, {
                      kind: 'failed',
                      message: `物料已变更（${drifted.length} 款批准后被编辑）——重新发起提案查看新预览`,
                    });
                    return {
                      kind: 'failed',
                      code: 'STALE',
                      message:
                        `物料已变更：${drifted.join('、')} 在提案批准期间被编辑（stoneRevision 漂移）`
                        + '——物料已变更，请重新查看预览批准（重新以 studio.task.stones.add 发起提案）',
                    };
                  }
                }
                const applied = applyAdd(task.ownerId, {
                  taskId: p.taskId,
                  sessionId: payloadSessionId,
                  stoneRefs: payloadRefs as string[],
                  expectedRevision: payloadRevision,
                });
                approvals.settleExternal(consume.op.proposal_id, { kind: 'succeeded' });
                return { kind: 'ok', value: applied as unknown as Record<string, unknown> };
              });
              outcome = tx();
            } catch (error) {
              if (error instanceof ProjectManifestError) return manifestFailureOf(error);
              throw error;
            }
            if (outcome.kind === 'ok') {
              noteSuccess(bucket);
              const applied = outcome.value as { added: string[]; alreadyPresent: string[]; revision: number };
              if (task.sessionId !== null) {
                // manifest artifact 帧（writeManifestTx 不发帧——事务外单点补发，A1 纪律）。
                const row = getSessionProject(deps.db, task.sessionId);
                if (row !== null) manifests.emitArtifactFrame(p.taskId, row.blob_ref);
              }
              // lint 工件重算（无 plan=lint null——manifest 已更新，下次计划面可见；
              // 数据源回退会话域最近 plan——P0 会话域缺省锚）。
              const lint = task.sessionId !== null ? recomputeLint(task.sessionId, task.ownerId, p.taskId) : null;
              deps.jobs?.emitFor(p.taskId, 'transcript', {
                role: 'tool',
                text:
                  `项目钻清单追加完成：新增 ${applied.added.length} 款、已在清单 ${applied.alreadyPresent.length} 款`
                  + `（manifest revision=${applied.revision}${lint !== null ? `；lint：未引入 ${lint.summary.counts.unintroduced}、不可解析 ${lint.summary.counts.unresolvable}` : ''}）`,
              });
              outcome.value = { ...applied, lint };
            }
            return outcome;
          }
          // ---- propose 模式：库内校验+CAS 基线预检+将添加明细（批准前库内零变更）。
          if (p.expectedRevision === undefined || p.stoneRefs === undefined) {
            throw new Error(
              '发起模式需 {taskId, expectedRevision, stoneRefs}（缺一不可——不猜测；expectedRevision 以 studio.task.stones.list 读到的 manifest.revision 为基线）',
            );
          }
          const task = agentTaskOf(p.taskId);
          const { sessionId, row } = sessionProjectOf(p.taskId);
          if (p.expectedRevision !== row.revision) {
            return {
              kind: 'failed',
              code: 'STALE',
              message: `manifest revision CAS 基线漂移：expected=${p.expectedRevision} current=${row.revision}（并发写入或过期观察）——以 currentRevision=${row.revision} 重新观察并发起`,
            };
          }
          const manifest = readStonesManifestBlob(deps.blobs, row.blob_ref);
          const present = new Set(manifest.entries.map((entry) => entry.stoneRef));
          const orderedRefs = [...new Set(p.stoneRefs)];
          const alreadyPresent = orderedRefs.filter((ref) => present.has(ref));
          const toAdd = orderedRefs.filter((ref) => !present.has(ref));
          if (toAdd.length === 0) {
            throw new Error(`全部 ${orderedRefs.length} 款钻已在项目清单中（alreadyPresent）——无需追加（幂等面不发起空 proposal）`);
          }
          // 服务端校验+物化预览（materializeStoneRef 单源——库外/软删/物料缺失 typed
          // 拒清单）；alreadyPresent 不参与校验（幂等面）。
          const invalid: Array<{ stoneRef: string; reason: string }> = [];
          const previews: Array<Record<string, unknown>> = [];
          for (const stoneRef of toAdd) {
            try {
              const materialized = materializeStoneRef({ db: deps.db, blobs: deps.blobs }, stoneRef);
              previews.push({
                stoneRef,
                sku: materialized.pick.sku,
                supplier: materialized.pick.supplier,
                sizeMm: materialized.pick.sizeMm,
                colorHex: materialized.pick.colorHex,
                stoneRevision: materialized.stoneRevision,
                // P2-2：源 blobRef 快照（审计锚——执行期以 stoneRevision 为主判据）。
                stoneJsonBlobRef: materialized.stoneJsonBlobRef,
                textureBlobRef: materialized.textureBlobRef,
              });
            } catch (error) {
              if (error instanceof ProjectExpandError && error.kind === 'stone-unresolvable') {
                invalid.push(error.detail as unknown as { stoneRef: string; reason: string });
                continue;
              }
              throw error;
            }
          }
          if (invalid.length > 0) {
            throw new Error(
              `stoneRefs 校验失败（${invalid.length} 款不可引入——只能添加系统已有钻，新增钻型=管理员权限）：${invalid
                .map((item) => `${item.stoneRef}（${item.reason}）`)
                .join('；')}`,
            );
          }
          const previewJson = (doc: unknown): string =>
            deps.blobs.put(new Uint8Array(Buffer.from(JSON.stringify(doc), 'utf8'))).hash;
          const before = previewJson({
            note: 'task-stones-add',
            revision: row.revision,
            entries: manifest.entries.map((entry) => ({ stoneRef: entry.stoneRef, sku: entry.pick.sku, supplier: entry.pick.supplier })),
          });
          const after = previewJson({ note: 'task-stones-add', revision: row.revision + 1, adding: previews });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: task.ownerId,
            tool: TASK_STONES_ADD_TOOL_NAME,
            payload: {
              kind: 'task-stones-add',
              sessionId,
              // 完整请求清单（已去重保持序）——执行期对电流 manifest 重新分账
              // toAdd/alreadyPresent（approve→execute 间的并发引入归幂等 no-op 面）。
              stoneRefs: orderedRefs,
              expectedRevision: row.revision,
              // P2-2（2026-09-28 复核）：物料版本快照（toAdd 款——执行期逐款比对
              // stoneRevision，批准期间被编辑=typed STALE 重看预览；alreadyPresent
              // 无写入面不绑定）。
              stoneSnapshots: previews.map((preview) => ({
                stoneRef: preview['stoneRef'] as string,
                stoneRevision: preview['stoneRevision'] as number,
                stoneJsonBlobRef: preview['stoneJsonBlobRef'] as string,
                textureBlobRef: preview['textureBlobRef'] as string,
              })),
            },
            preview: { before, after },
            summary:
              `项目钻清单追加：将引入 ${toAdd.length} 款（${previews.map((entry) => `${entry['supplier']}/${entry['sku']}`).join('、')}）`
              + `·基线 revision=${row.revision}${alreadyPresent.length > 0 ? `·已在清单 ${alreadyPresent.length} 款不重复引入` : ''}`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              preview: {
                currentRevision: row.revision,
                toAdd: previews,
                alreadyPresent,
                note: '服务端已按 stone_index 现状回填物料快照（模型不提交 sku/颜色真源）；执行期重新校验+重物化',
              },
              // iter-2 Codex 裁定修法 A（experiments/sam-playbook-20261004/iter-2/
              // codex-review.md §3/§4）：approvalFaceOf——autoApprove 会话透传
              // autoApproved=true+「立即执行」指令（propose 中央单点已签发 grant，
              // iter-2 DB 实证 auto_approved=1/consumed=0——无条件等待文案说谎致
              // agent 停摆、grant 作废）；手动路径 pending 文案原样（不扩权——
              // B=政策收紧属 Owner 决策，零触碰）。照 15d4c99 design/task-export 同款。
              ...approvalFaceOf(
                issued,
                '等待用户批准（approval-request 已入任务帧流）——先与用户讨论确认要纳入项目的钻；批准后以 {taskId, proposalId} 执行（并发他写=STALE 必拒，以新 revision 重发）',
              ),
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_STONES_ADD_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  // 授权桥（§3.6）：双模例外照 stones.ts——无 proposalId=propose 面（无副作用，授权
  // 发生在执行模式）；带 proposalId 走 precheckMutation。未装配=一律 principal-forbidden。
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
