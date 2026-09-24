/**
 * 生产组合 MCP 工具面（add-stone-library design §7.5/§7.4——S7.3 + S7.6 接口位）。
 * 原始需求 2026-09-24（tasks.md S7.3）：五工具 = readonly（set.list/set.get）+
 * approved-mutation（set.create/update/delete——授权桥双模）。
 * 授权语义：**零新授权语义**——完整复用 W4.2 authorization.ts（proposal+preview
 * diff 预览→人工批准→grant→consumeForExecution→revision CAS/TTL），双模接法照
 * S4 stones 面（带参=发起 proposal；带 proposalId=执行）。
 * 共享读语义（评审 D-1 裁定，与 stones readonly 面同实现纪律）：组合=
 * 生产工件——用户/工作台私有的生产组合，与「标准库=供应链共享真源」不同类，
 * 故**读写均按 owner 隔离**（set 是私有生产清单而非公共参考数据；共享组合
 * 走显式导出/导入面，不在本工具族）。
 * 正交意图：
 *   [1] readonly 查询面：list（名称/用途/来源筛选+分页）/get（成员读时解析
 *       五态+限定名——§7.1 不变量的工具面呈现）。
 *   [2] 写工具授权桥双模：propose（成员清单 diff+来源溯源）→answer→execute
 *       （consume→service 落库→settleExternal 同一 SQLite 事务，照 S4 本地壳）。
 *   [3] S7.6 接口位冻结：set.createFromBom({sourceTaskId}) 只留输入 schema +
 *       typed error 常量（bom-source-not-implemented）——执行链依赖内核 change
 *       （排钻产物 StonePick.stoneRef 溯源），落地前 set.create 的 bom-derived
 *       origin 显式拒（不注册第六工具——位冻结非功能冻结）。
 */
import { z } from 'zod';
import {
  ProductionSetMemberSchema,
  ProductionSetOriginSchema,
  type ProductionSetOrigin,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import type { JobService } from '../jobs/service.js';
import { StoneService } from '../stones/service.js';
import {
  SetService,
  SetServiceError,
  applyMemberOps,
  type SetMemberResolution,
  type SetPatch,
} from '../stones/sets-service.js';
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

// ---------------------------------------------------------------- S7.6 接口位冻结

/**
 * `set.createFromBom({sourceTaskId})` 输入位（冻结——内核 P3 排钻产物带 stone
 * 溯源落地后启用为第六工具）。落地前的显式拒=下方 typed error 常量；bom-derived
 * origin 经 set.create 发起时同码拒绝（proposal 不落库）。
 */
export const SetCreateFromBomInputSchema = z
  .object({
    taskId: z.string().min(1),
    /** 排钻任务 id（服务端从任务 BOM 聚合 stoneRef×数量 生成成员清单）。 */
    sourceTaskId: z.string().min(1),
  })
  .strict();
export type SetCreateFromBomInput = z.infer<typeof SetCreateFromBomInputSchema>;

/** S7.6 typed error 码（MCP 失败面与 service 层同源字面）。 */
export const BOM_SOURCE_NOT_IMPLEMENTED = 'bom-source-not-implemented';

// ---------------------------------------------------------------- 依赖

export interface SetCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（approval-request/transcript——任务域工具必需）。 */
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
  .describe('当前 agent 任务 id（owner 绑定与审计链的上下文——组合按任务归属用户隔离）');
const SetResourceIdField = z.string().min(1).describe('组合目录行 id（resourceId=引用键/CAS 点）');
const ProposalIdField = z.string().min(1).describe('已批准 proposal id（执行模式——grant 服务端内部关联）');

const SetListInputSchema = z.object({
  taskId: TaskIdField,
  name: z.string().min(1).optional().describe('名称子串筛选（如「卡通」）'),
  purpose: z.string().min(1).optional().describe('用途子串筛选'),
  originKind: z.enum(['manual-pick', 'bom-derived', 'clone']).optional().describe('来源筛选（§7.4 三来源）'),
  includeTrashed: z.boolean().default(false),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

const SetGetInputSchema = z.object({ taskId: TaskIdField, resourceId: SetResourceIdField });

const SetCreateProposeSchema = z.object({
  name: z.string().min(1).describe('组合名（如「卡通人物套餐-A」）'),
  purpose: z.string().optional().describe('用途（如「小件卡通订单」）'),
  stones: z
    .array(ProductionSetMemberSchema)
    .optional()
    .describe(
      '成员清单（manual-pick 必给——stoneRef=标准原子 resourceId 弱引用，缺数=按设计用量另计）；'
        + 'clone 来源禁给（服务端从母组合浅拷贝）',
    ),
  origin: ProductionSetOriginSchema.describe(
    '来源（§7.4）：manual-pick=人工挑拣 / clone={fromSetId} 复用 / bom-derived=接口位冻结（当前必拒）',
  ),
});

const SetMemberUpdateSchema = z
  .object({
    stoneRef: z.string().min(1),
    quantity: z.number().int().positive().nullable().optional().describe('数量（null=清除——按设计用量另计）'),
    note: z.string().nullable().optional().describe('备注（null=清除）'),
  })
  .strict();

const SetUpdateProposeSchema = z.object({
  resourceId: SetResourceIdField,
  patch: z
    .object({
      name: z.string().min(1).optional().describe('组合改名（目录行同事务改名）'),
      purpose: z.string().nullable().optional().describe('用途（null=清除）'),
      addMembers: z.array(ProductionSetMemberSchema).optional().describe('追加成员（stoneRef 重复必拒）'),
      removeMembers: z.array(z.string().min(1)).optional().describe('移除成员 stoneRef 清单（清空必拒——删组合走 set.delete）'),
      updateMembers: z.array(SetMemberUpdateSchema).optional().describe('成员数量/备注字段级更新（指向非成员必拒）'),
    })
    .strict(),
});

/** 双模外层 schema（照 S4：外层全可选，propose 齐备性 handler 内二次校验）。 */
const SetCreateInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  name: SetCreateProposeSchema.shape.name.optional(),
  purpose: SetCreateProposeSchema.shape.purpose.optional(),
  stones: SetCreateProposeSchema.shape.stones.optional(),
  origin: SetCreateProposeSchema.shape.origin.optional(),
});

const SetUpdateInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  resourceId: SetResourceIdField.optional(),
  patch: SetUpdateProposeSchema.shape.patch.optional(),
});

const SetDeleteInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: ProposalIdField.optional(),
  resourceId: SetResourceIdField.optional(),
});

// ---------------------------------------------------------------- 工具面构造

export function createSetCapabilities(deps: SetCapabilitiesDeps): CapabilityRegistry {
  const stones = new StoneService({ db: deps.db, blobs: deps.blobs });
  const sets = new SetService({ db: deps.db, blobs: deps.blobs, stones });
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

  /** resourceId → owner 交叉校验（D-1：组合读写均按 owner 隔离——跨用户必拒）。 */
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

  /** 双模判定（type guard）：proposalId 在场=执行模式。 */
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

  /** 本地恰好一次执行壳（照 S4 executeApprovedLocal）：consume→落库→settle 同一事务。 */
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

  /** set.* 服务层 typed error → MCP 失败面（码位映射保持 agent 可读）。 */
  function failedOfServiceError(error: SetServiceError): CapabilityCallResult {
    const code =
      error.code === 'revision-conflict'
        ? ('STALE' as const)
        : error.code === 'not-found'
          ? ('NOT_FOUND' as const)
          : error.code === 'duplicate-member' || error.code === 'owner-mismatch'
            ? ('CONFLICT' as const)
            : ('INVALID_OPERATION' as const);
    return { kind: 'failed', code, message: `set 服务错误（${error.code}）：${error.message}` };
  }

  /** 成员解析预览（getSet 同源投影——限定名+五态显式呈现给人工批准面）。 */
  function memberPreviews(members: ReadonlyArray<{ stoneRef: string; quantity?: number; note?: string }>): Array<
    Pick<SetMemberResolution, 'stoneRef' | 'state' | 'quantity' | 'note' | 'standardId' | 'qualifiedSku'>
  > {
    return sets.resolveMembers(members).map((member) => ({
      stoneRef: member.stoneRef,
      state: member.state,
      ...(member.quantity !== undefined ? { quantity: member.quantity } : {}),
      ...(member.note !== undefined ? { note: member.note } : {}),
      ...(member.standardId !== undefined ? { standardId: member.standardId } : {}),
      ...(member.qualifiedSku !== undefined ? { qualifiedSku: member.qualifiedSku } : {}),
    }));
  }

  /** 组合引用面：clone origin.fromSetId 指向本组合的在册组合（delete 预览）。 */
  function cloneReferencesOf(resourceId: string, ownerId: string): Array<{ resourceId: string; name: string }> {
    return sets
      .listSets({ ownerId })
      .filter((summary) => summary.origin.kind === 'clone' && summary.origin.fromSetId === resourceId)
      .map((summary) => ({ resourceId: summary.resourceId, name: summary.name }));
  }

  // -------------------------------------------------------------- 五工具定义

  const definitions: CapabilityDefinition[] = [
    {
      name: 'set.list',
      description:
        '生产组合浏览（只读，design §7.5）：按 名称/用途/来源（manual-pick|bom-derived|clone）筛选 + 分页。'
          + '组合=owner 私有生产工件（评审 D-1：读写均按任务归属用户隔离——与标准库共享读不同类）。',
      authority: 'readonly' as const,
      input: SetListInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SetListInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, 'set.list', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const task = agentTaskOf(p.taskId);
          const rows = sets.listSets({
            ownerId: task.ownerId,
            ...(p.name !== undefined ? { name: p.name } : {}),
            ...(p.purpose !== undefined ? { purpose: p.purpose } : {}),
            ...(p.originKind !== undefined ? { originKind: p.originKind } : {}),
            includeTrashed: p.includeTrashed,
          });
          const total = rows.length;
          const pageRows = rows.slice((p.page - 1) * p.pageSize, p.page * p.pageSize);
          noteSuccess(bucket);
          return { kind: 'ok', value: { sets: pageRows, total, page: p.page, pageSize: p.pageSize } };
        } catch (error) {
          return noteFailure(bucket, 'set.list', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'set.get',
      description:
        '组合详情（只读）：set.json 全文 + revision + 路径 + 成员读时解析五态'
        + '（resolved/soft-deleted/blob-missing/wrong-kind/not-found——缺失成员显式呈现不剔除）'
        + '+ 限定名 standardId/qualifiedSku（`<标准ID>/<SKU>` 解析投影，编号冲突区分）。'
        + '标准库更新自动跟随（引用集弱引用——组合零同步机制）。软删态可读（回收站详情）。',
      authority: 'readonly' as const,
      input: SetGetInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SetGetInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, 'set.get', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          ownedResourceOf(p.taskId, p.resourceId); // owner 交叉校验（跨用户必拒）
          const detail = sets.getSet(p.resourceId);
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              resourceId: p.resourceId,
              setId: detail.setId,
              revision: detail.revision,
              path: detail.path,
              trashed: detail.trashed,
              set: detail.set,
              members: detail.members,
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'set.get', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'set.create',
      description:
        '建生产组合（approved-mutation 双模）：带 name/purpose/origin[/stones] = 发起 proposal（成员清单'
        + 'diff+来源溯源预览——成员解析态与限定名一并呈现；clone 预览母组合成员浅拷贝）；带 proposalId = '
        + '执行（grant 消费+目录/set.json 同事务落库）。bom-derived 来源=接口位冻结（S7.6：依赖内核排钻'
        + '溯源，当前 typed 拒——用 manual-pick 或 clone）。',
      authority: 'approved-mutation' as const,
      input: SetCreateInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SetCreateInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            'set.create',
            `参数不合法（双模：发起={taskId,name,origin[,stones][,purpose]} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.name !== undefined || p.purpose !== undefined || p.stones !== undefined || p.origin !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            const outcome = executeApprovedLocal('set.create', p, ({ payload, op }) => {
              const origin = payload['origin'] as ProductionSetOrigin;
              const stones = payload['stones'] as Array<{ stoneRef: string; quantity?: number; note?: string }> | undefined;
              const result = sets.createSet({
                ownerId: op.user_id,
                name: payload['name'] as string,
                ...(payload['purpose'] !== undefined ? { purpose: payload['purpose'] as string } : {}),
                ...(stones !== undefined ? { members: stones } : {}),
                origin,
              });
              return {
                value: {
                  resourceId: result.resourceId,
                  setId: result.setId,
                  revision: result.revision,
                  path: result.path,
                  memberCount: result.memberCount,
                },
                resultRef: result.resourceId,
              };
            });
            if (outcome.kind === 'ok') noteSuccess(bucket);
            return outcome;
          }
          // ---- propose 模式：来源分派 + 成员清单 diff 预览（批准前库内零变更）。
          const proposeParsed = SetCreateProposeSchema.safeParse(p);
          if (!proposeParsed.success) {
            throw new Error(
              `发起模式需 {taskId, name, origin, [stones]}（manual-pick 须带 stones——不猜测）：${proposeParsed.error.issues.map((i) => i.message).join('; ')}`,
            );
          }
          const propose = proposeParsed.data;
          // S7.6 接口位冻结：bom-derived 显式 typed 拒（proposal 不落库——
          // set.createFromBom({sourceTaskId}) 位待内核 P3 落地后启用）。
          if (propose.origin.kind === 'bom-derived') {
            return {
              kind: 'failed',
              code: 'INVALID_OPERATION',
              message: `${BOM_SOURCE_NOT_IMPLEMENTED}：bom-derived 来源依赖内核排钻产物 stone 溯源（接口位冻结未实现）——当前用 manual-pick（人工挑拣）或 clone（复用既有组合）发起`,
            };
          }
          const task = agentTaskOf(p.taskId);
          let memberPreview: Array<{ stoneRef: string; quantity?: number; note?: string }>;
          let casBinding: { resourceId: string; baseRevision: number } | undefined;
          if (propose.origin.kind === 'clone') {
            if (propose.origin.fromSetId === undefined) {
              throw new Error('clone 来源须带 origin.fromSetId（母组合 resourceId）');
            }
            if (propose.stones !== undefined) {
              throw new Error('clone 来源成员由服务端从母组合浅拷贝——不可同时显式给 stones（双源必拒）');
            }
            ownedResourceOf(p.taskId, propose.origin.fromSetId); // owner 交叉校验（跨用户 clone 必拒）
            const mother = sets.getSet(propose.origin.fromSetId);
            if (mother.trashed) throw new Error('母组合在回收站内（先恢复再 clone）');
            memberPreview = mother.set.stones.map((member) => ({ ...member }));
            // CAS 绑定母组合：批准期间母组合被改=grant 漂移必拒（浅拷贝忠实于预览）。
            casBinding = { resourceId: mother.resourceId, baseRevision: mother.revision };
          } else {
            if (propose.stones === undefined || propose.stones.length === 0) {
              throw new Error('manual-pick 来源须给非空 stones 成员清单（stones min 1——空组合无生产语义）');
            }
            memberPreview = propose.stones.map((member) => ({ ...member }));
          }
          const resolvedPreview = memberPreviews(memberPreview);
          const originSummary =
            propose.origin.kind === 'clone' ? `clone（母组合 ${propose.origin.fromSetId}）` : 'manual-pick（人工挑拣）';
          const before = previewBlob({ note: 'set-create', exists: false, owner: task.ownerId });
          const after = previewBlob({
            note: 'set-create',
            name: propose.name,
            ...(propose.purpose !== undefined ? { purpose: propose.purpose } : {}),
            origin: propose.origin,
            members: resolvedPreview,
          });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: task.ownerId,
            tool: 'set.create',
            ...(casBinding !== undefined ? { resourceId: casBinding.resourceId, baseRevision: casBinding.baseRevision } : {}),
            payload: {
              kind: 'set-create',
              name: propose.name,
              ...(propose.purpose !== undefined ? { purpose: propose.purpose } : {}),
              ...(propose.origin.kind === 'manual-pick' ? { stones: propose.stones } : {}),
              origin: propose.origin,
            },
            preview: { before, after },
            summary: `新建生产组合「${propose.name}」：${originSummary}，成员 ${resolvedPreview.length} 项（解析态：resolved ${resolvedPreview.filter((m) => m.state === 'resolved').length}/缺失 ${resolvedPreview.filter((m) => m.state !== 'resolved').length}）`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              preview: {
                name: propose.name,
                ...(propose.purpose !== undefined ? { purpose: propose.purpose } : {}),
                origin: propose.origin,
                members: resolvedPreview,
                note: '成员=弱引用清单（标准库更新自动跟随）；缺失成员显式态标注——批准即以此清单落库',
                previewBlobs: { before, after },
              },
              pending: '等待用户批准（approval-request 已入任务帧流；批准前库内零变化）',
            },
          };
        } catch (error) {
          if (error instanceof SetServiceError) {
            const outcome = failedOfServiceError(error);
            noteSuccess(bucket); // typed 业务拒=调用面语义正确（非连击失败）
            return outcome;
          }
          return noteFailure(bucket, 'set.create', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'set.update',
      description:
        '更新生产组合（approved-mutation 双模）：带 resourceId/patch = 发起 proposal（成员增删/数量/备注/'
        + '改名/用途的 diff 预览——baseRevision+前后清单；同 stoneRef 撤销重加=重置条目）；带 proposalId = '
        + '执行（revision CAS 漂移必拒；改名=目录行同事务改名）。',
      authority: 'approved-mutation' as const,
      input: SetUpdateInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SetUpdateInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            'set.update',
            `参数不合法（双模：发起={taskId,resourceId,patch} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.resourceId !== undefined || p.patch !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
            }
            const outcome = executeApprovedLocal('set.update', p, ({ payload, op }) => {
              const resourceId = payload['resourceId'] as string;
              const patch = payload['patch'] as SetPatch;
              const result = sets.updateSet(resourceId, patch, { baseRevision: op.base_revision ?? 0 });
              return {
                value: { resourceId, revision: result.revision, path: result.path, memberCount: result.memberCount },
                resultRef: resourceId,
              };
            });
            if (outcome.kind === 'ok') noteSuccess(bucket);
            return outcome;
          }
          // ---- propose 模式：成员清单 diff（baseRevision+前后清单）。
          const proposeParsed = SetUpdateProposeSchema.safeParse(p);
          if (!proposeParsed.success) {
            throw new Error(
              `发起模式需 {taskId, resourceId, patch}（缺一不可——不猜测）：${proposeParsed.error.issues.map((i) => i.message).join('; ')}`,
            );
          }
          const propose = proposeParsed.data;
          const owned = ownedResourceOf(p.taskId, propose.resourceId);
          const current = sets.getSet(propose.resourceId);
          if (current.trashed) throw new Error('目标组合在回收站内（先恢复再更新——回收站内不改真值）');
          const nextMembers = applyMemberOps(current.set.stones, propose.patch); // 与执行共用纯函数——diff 即执行真身
          const added = nextMembers.filter(
            (member) => !current.set.stones.some((existing) => existing.stoneRef === member.stoneRef),
          );
          const removed = current.set.stones.filter(
            (member) => !nextMembers.some((existing) => existing.stoneRef === member.stoneRef),
          );
          const updated = nextMembers.filter((member) => {
            const before = current.set.stones.find((existing) => existing.stoneRef === member.stoneRef);
            return before !== undefined && JSON.stringify(before) !== JSON.stringify(member);
          });
          const fieldChanges: string[] = [];
          if (propose.patch.name !== undefined && propose.patch.name !== current.set.name) fieldChanges.push('name');
          if (propose.patch.purpose !== undefined) fieldChanges.push('purpose');
          if (added.length + removed.length + updated.length === 0 && fieldChanges.length === 0) {
            throw new Error('patch 为空 diff（无成员/字段变化——不发起空 proposal）');
          }
          const before = previewBlob({
            note: 'set-update',
            resourceId: propose.resourceId,
            baseRevision: current.revision,
            members: current.set.stones,
            ...(current.set.purpose !== undefined ? { purpose: current.set.purpose } : {}),
          });
          const after = previewBlob({
            note: 'set-update',
            resourceId: propose.resourceId,
            baseRevision: current.revision,
            name: propose.patch.name ?? current.set.name,
            members: memberPreviews(nextMembers),
            ...(propose.patch.purpose !== undefined
              ? propose.patch.purpose === null
                ? { purposeCleared: true }
                : { purpose: propose.patch.purpose }
              : current.set.purpose !== undefined
                ? { purpose: current.set.purpose }
                : {}),
          });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: owned.taskOwnerId,
            tool: 'set.update',
            resourceId: propose.resourceId,
            baseRevision: current.revision,
            payload: { kind: 'set-update', resourceId: propose.resourceId, patch: propose.patch },
            preview: { before, after },
            summary: `更新组合「${current.set.name}」：+${added.length}/-${removed.length}/~${updated.length} 成员${fieldChanges.length > 0 ? `、字段 ${fieldChanges.join('、')}` : ''}（base v${current.revision}）`,
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              proposalId: issued.proposalId,
              requestId: issued.requestId,
              expiresAt: issued.expiresAt,
              diff: {
                baseRevision: current.revision,
                addedMembers: memberPreviews(added),
                removedMembers: removed,
                updatedMembers: updated,
                ...(fieldChanges.length > 0 ? { fieldChanges } : {}),
                previewBlobs: { before, after },
              },
              pending: '等待用户批准（批准期间组合被改=revision CAS 必拒）',
            },
          };
        } catch (error) {
          if (error instanceof SetServiceError) {
            const outcome = failedOfServiceError(error);
            noteSuccess(bucket);
            return outcome;
          }
          return noteFailure(bucket, 'set.update', error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: 'set.delete',
      description:
        '软删生产组合（approved-mutation 双模——回收站语义）：带 resourceId = 发起 proposal（目标组合+'
        + '成员解析态+clone 引用面预览——谁在 clone 它）；带 proposalId = 执行（递归盖戳，revision CAS 防漂移）。',
      authority: 'approved-mutation' as const,
      input: SetDeleteInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SetDeleteInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            'set.delete',
            `参数不合法（双模：发起={taskId,resourceId} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          if (isExecuteMode(p)) {
            if (p.resourceId !== undefined) {
              throw new Error('执行模式只带 {taskId, proposalId}（resourceId 与 proposalId 互斥）');
            }
            const outcome = executeApprovedLocal('set.delete', p, ({ payload }) => {
              const resourceId = payload['resourceId'] as string;
              const result = sets.softDeleteSet(resourceId);
              return {
                value: { resourceId, trashedRows: result.trashedRows, note: '软删=回收站语义（组合成员引用零变更——标准原子不受影响）' },
                resultRef: resourceId,
              };
            });
            if (outcome.kind === 'ok') noteSuccess(bucket);
            return outcome;
          }
          if (p.resourceId === undefined) throw new Error('发起模式需 {taskId, resourceId}（缺一不可——不猜测）');
          const owned = ownedResourceOf(p.taskId, p.resourceId);
          const current = sets.getSet(p.resourceId);
          if (current.trashed) throw new Error('目标组合已在回收站内（幂等拒绝——不重复盖戳）');
          const references = cloneReferencesOf(p.resourceId, owned.ownerId);
          const target = {
            resourceId: p.resourceId,
            setId: current.setId,
            name: current.set.name,
            ...(current.set.purpose !== undefined ? { purpose: current.set.purpose } : {}),
            origin: current.set.origin,
            memberCount: current.members.length,
            path: current.path,
            revision: current.revision,
            memberStates: current.members.map((member) => ({ stoneRef: member.stoneRef, state: member.state })),
          };
          const before = previewBlob({ note: 'set-delete', target, references });
          const after = previewBlob({ note: 'set-delete', target: { ...target, trashed: true }, references });
          const issued = requireApprovals().propose({
            taskId: p.taskId,
            userId: owned.taskOwnerId,
            tool: 'set.delete',
            resourceId: p.resourceId,
            baseRevision: current.revision,
            payload: { kind: 'set-delete', resourceId: p.resourceId },
            preview: { before, after },
            summary: `软删组合「${current.set.name}」（${current.path}；成员 ${current.members.length} 项；clone 引用面 ${references.length} 项——成员仅弱引用，标准原子不受影响）`,
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
              pending: '等待用户批准（软删=回收站语义；成员是弱引用清单，标准钻原子零变更）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, 'set.delete', error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  // 授权桥（§3.6）：双模例外照 S4——无 proposalId=propose 面；带 proposalId 走
  // precheckMutation。未装配=一律 principal-forbidden。
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
