/**
 * 授权/operation/attempt 行存取面（design §3.6——W4.2 授权桥的 DB 层）。
 * 原始需求 2026-09-23（tasks.md W4.2）：proposal 持久化（approved_ops 行）/
 * grant 签发与消费（消费即焚）/ attempt 账本（幂等键唯一约束）/ patch_history
 * 撤销组。查询语句集中于此；状态机事务语义在 capability/authorization.ts 编排。
 * 正交意图：
 *   [1] approved_ops：proposal+operation 同行（proposalId=唯一幂等键；v4 追加列
 *       承载 payload/CAS 基线/preview/summary/request_id/result_ref）。
 *   [2] grants：一次性授权（签发于 session.answer；消费于 approved-mutation 执行
 *       入口——同事务标记 consumed）。
 *   [3] attempts：外部尝试账本（attemptId 主键；proposalId+attemptNo 唯一；
 *       retryRequestId 唯一——跨归属复用必拒；active partial unique=v2）。
 */
import type { ApprovedOpState, AttemptState, RgbTuple, StrategyPlan, SupplierSkuProfile } from '@handicraft/contracts';
import type { SqliteDb } from './database.js';
import { newId, nowIso } from './store.js';
import type { CreateStoneInput, StonePatch } from '../stones/service.js';
import type { CardImportOptions } from '../stones/importer.js';
import type { CreateSetInput, SetPatch } from '../stones/sets-service.js';

/**
 * proposal 持久化载荷（approved_ops.payload_json 的解析形态——族判别）。
 * stone.* 族（add-stone-library S4）：贴图以 blobRef+声明宽高承载（字节不入
 * payload——内容寻址引用，执行时读 blob 再过六 gate）；import options=S2
 * CardImportOptions 冻结面直传（targetSupplier/ownerId 必填）。
 * set.* 族（add-stone-library S7.3）：成员=弱引用清单（stoneRef+quantity+note
 * 直传——无字节面）；update patch 与 service SetPatch 同形。S7.6 接口位：
 * bom-derived 来源冻结为 typed 拒——set-create-bom 族**不设**（内核 P3 落地
 * 后再扩，位在 capability/sets.ts SetCreateFromBomInputSchema）。
 * strategy-design 族（add-subject-sam-pipeline P3.1）：plan=contracts StrategyPlan
 * 全文直传（free-code source 随 params 内联——最大 256KB 量级；工件引用走
 * codeArtifactRef 内容寻址）；stoneFilter.activeSetId 在场时 proposal 绑定组合
 * resourceId+baseRevision（CAS 面）。
 */
export type ProposalPayload =
  | { kind: 'patch-apply'; resourceId: string; region: { kind: 'blocks'; ids: string[] }; ops: unknown[] }
  | { kind: 'generate'; prompt: string; size?: string; imageRef?: string; advanced?: unknown }
  | { kind: 'export'; resourceId: string; withPng: boolean }
  | { kind: 'undo'; family: 'patch' | 'generate' | 'export'; target: string }
  | {
      kind: 'stone-create';
      supplierProfile: SupplierSkuProfile;
      draft: Omit<CreateStoneInput['draft'], 'texture'>;
      texture: { blobRef: string; declaredWidth: number; declaredHeight: number };
    }
  | {
      kind: 'stone-update';
      resourceId: string;
      patch: Omit<StonePatch, 'texture'>;
      texture?: { blobRef: string; declaredWidth: number; declaredHeight: number };
    }
  | { kind: 'stone-delete'; resourceId: string }
  | { kind: 'stone-import'; draftRef: string; options: CardImportOptions }
  | {
      /**
       * 内置标准钻物化族（add-builtin-standard-stones，2026-10-02）：SS 云数据条目
       * 逐条携带贴图 blob 引用——propose 期按 rgb 确定性生成落 blob（审批卡可见），
       * 执行期幂等复用（缺席时确定性再生成对 hash）；supplier 服务端固定字面量
       * 「内置标准（SS 云数据参考）」，非调用方可选。
       */
      kind: 'stone-create-builtin';
      supplier: string;
      entries: Array<{
        label: string;
        colorName: string;
        rgb: RgbTuple;
        sku: string;
        sizeMm: number;
        textureBlobRef: string;
      }>;
    }
  | {
      kind: 'set-create';
      name: string;
      purpose?: string;
      /** manual-pick 成员清单（clone 来源缺席——执行时服务端从母组合浅拷贝）。 */
      stones?: CreateSetInput['members'];
      origin: CreateSetInput['origin'];
    }
  | { kind: 'set-update'; resourceId: string; patch: SetPatch }
  | { kind: 'set-delete'; resourceId: string }
  | {
      /** strategy-design 族（add-subject-sam-pipeline P3.1 / design §5）：S6 LLM 策略指派 proposal。 */
      kind: 'strategy-design';
      /** object-tree 工件 blobRef（plan 溯源锚——plan.objectTreeRef 同值）。 */
      treeArtifactRef: string;
      /** 批准即执行真身（逐节点 applyStrategy+引擎校验门——执行面 executeStrategyPlan）。 */
      plan: StrategyPlan;
      styleId?: string;
      styleHint?: string;
      instruction?: string;
      /** 候选过滤快照（activeSetId 在场时 CAS 绑定组合 revision——批准期间成员漂移必拒）。 */
      stoneFilter?: { supplier?: string; family?: string; activeSetId?: string };
    }
  | {
      /**
       * task-stones-add 族（add-task-stones-manifest-export W2 2.1——arch-decisions A4）：
       * 项目钻追加 proposal。stoneRefs=完整请求清单（去重保序——执行期对电流
       * manifest 重新分账 added/alreadyPresent；物料快照由服务端执行期重物化回填）；
       * expectedRevision=manifest CAS 基线（writeManifestTx 权威判定，批准期间他写
       * 必拒 STALE）；sessionId=会话锚（执行期与任务行复核）。
       * P2-2（2026-09-28 Codex 复核）：stoneSnapshots=propose 时点的物料版本快照
       * （stoneRevision+源 blobRef）——execute 期对将写入的新增 ref 逐款比对当前库
       * revision，漂移=typed STALE（grant 代表的预览与实际写入不一致必拒，提示用户
       * 重新查看预览批准）。缺席=存量载荷（无版本绑定——兼容面，新提案恒携带）。
       */
      kind: 'task-stones-add';
      sessionId: string;
      stoneRefs: string[];
      expectedRevision: number;
      stoneSnapshots?: Array<{
        stoneRef: string;
        stoneRevision: number;
        stoneJsonBlobRef: string;
        textureBlobRef: string;
      }>;
    }
  | {
      /**
       * task-export 族（add-task-stones-manifest-export W4 4.2——arch-decisions B1）：
       * 任务导出 proposal。**proposalId 绑定 task/source/imageId/layout/manifest
       * revision**（B1 风险节裁定）：taskLayoutRef=定版渲染快照（内容寻址不可变——
       * 批准后策略重跑不漂移，执行期按 ref 读回）；manifestRevision=审计锚（清单只增
       * 不减——漂移不阻断，执行期 lint 现算）；sessionId=执行期与任务行复核锚。
       */
      kind: 'task-export';
      sessionId: string;
      sourceTaskId: string;
      imageId: string;
      taskLayoutRef: string;
      manifestRevision: number;
      /**
       * sourceTaskId 解析来源（P0 会话域缺省锚——2026-10-01 审计面）：explicit=调用方
       * 显式；current-task=缺省解析落当前任务（同轮）；session-latest=缺省解析命中会话
       * 内更早轮次（多轮延续）。可选=存量 proposal 兼容。
       */
      sourceResolution?: 'explicit' | 'current-task' | 'session-latest';
    }
  | {
      /**
       * reference-regenerate 族（add-flat-aux-segmentation T6——D6 工作台「重新生成
       * 参考图层」，2026-10-04）：外部计费调用（image-edit 外呼）走 approved-mutation
       * 双模。anchor=scene-analysis imageBlobRef（生成输入锚——执行期 force 重跑，
       * 不回放批准期快照：强制语义=以当前锚点重生成）。
       */
      kind: 'reference-regenerate';
      anchor: string;
    };

export interface ApprovedOpRow {
  proposal_id: string;
  task_id: string;
  user_id: string;
  tool: string;
  op_digest: string;
  resource_id: string | null;
  state: ApprovedOpState;
  created_at: string;
  updated_at: string;
  request_id: string | null;
  payload_json: string | null;
  base_revision: number | null;
  expires_at: string | null;
  preview_json: string | null;
  summary: string | null;
  result_ref: string | null;
}

export interface GrantRow {
  id: string;
  proposal_id: string;
  task_id: string;
  /**
   * 项目域锚（W6 6.2——Owner 裁决 2026-09-30 批准挂项目域）：签发任务所属会话。
   * v13 起在列（存量行迁移回填 tasks.session_id）；NULL=签发任务行已不存在的
   * 孤儿（清理级联面）——消费端按跨项目必拒。
   */
  session_id: string | null;
  op_digest: string;
  user_id: string;
  resource_id: string;
  base_revision: number;
  expires_at: string;
  consumed: number;
  created_at: string;
  /**
   * [product-polish-w1 T2] 自动签发审计标记（v14 列；0/1）：1=该 grant 由会话自动
   * 批准开关放行（propose 中央单点签发），非用户逐次点击批准——事后可追溯哪些
   * 批准是自动批的。与 approval-resolved 帧 autoApproved 同源。
   */
  auto_approved: number;
}

export interface AttemptRow {
  attempt_id: string;
  proposal_id: string;
  attempt_no: number;
  idem_key: string;
  retry_request_id: string;
  state: AttemptState;
  created_at: string;
  updated_at: string;
}

export interface PatchHistoryRow {
  id: string;
  owner_id: string;
  resource_id: string;
  patch_group: string;
  proposal_id: string;
  op_kind: 'setDensity' | 'recolor' | 'setSpec';
  target: string;
  before_json: string;
  after_json: string;
  base_revision: number;
  created_at: string;
}

// ---------------------------------------------------------------- approved_ops

export interface InsertApprovedOpInput {
  proposalId: string;
  taskId: string;
  userId: string;
  tool: string;
  opDigest: string;
  resourceId: string | null;
  requestId: string;
  payloadJson: string;
  baseRevision: number | null;
  expiresAt: string;
  previewJson: string | null;
  summary: string;
}

export function insertApprovedOp(db: SqliteDb, input: InsertApprovedOpInput): ApprovedOpRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO approved_ops
       (proposal_id, task_id, user_id, tool, op_digest, resource_id, state, created_at, updated_at,
        request_id, payload_json, base_revision, expires_at, preview_json, summary, result_ref)
     VALUES (?, ?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.proposalId,
    input.taskId,
    input.userId,
    input.tool,
    input.opDigest,
    input.resourceId,
    now,
    now,
    input.requestId,
    input.payloadJson,
    input.baseRevision,
    input.expiresAt,
    input.previewJson,
    input.summary,
  );
  return getApprovedOp(db, input.proposalId) as ApprovedOpRow;
}

export function getApprovedOp(db: SqliteDb, proposalId: string): ApprovedOpRow | null {
  const row = db.prepare('SELECT * FROM approved_ops WHERE proposal_id = ?').get(proposalId);
  return (row as ApprovedOpRow | undefined) ?? null;
}

export function getApprovedOpByRequest(db: SqliteDb, requestId: string): ApprovedOpRow | null {
  const row = db.prepare('SELECT * FROM approved_ops WHERE request_id = ?').get(requestId);
  return (row as ApprovedOpRow | undefined) ?? null;
}

/** 原子 claim：state='approved' → target（并发双 claim 只有一个成功）。 */
export function claimApprovedOp(
  db: SqliteDb,
  proposalId: string,
  target: ApprovedOpState,
): boolean {
  const result = db
    .prepare('UPDATE approved_ops SET state = ?, updated_at = ? WHERE proposal_id = ? AND state = ?')
    .run(target, nowIso(), proposalId, 'approved');
  return result.changes > 0;
}

/** 终态/中间态置位（claimed→running→terminal；只允许从 from 转到 to——CAS 语义）。 */
export function transitionApprovedOp(
  db: SqliteDb,
  proposalId: string,
  from: ApprovedOpState,
  to: ApprovedOpState,
  extra?: { resultRef?: string },
): boolean {
  const result = db
    .prepare(
      'UPDATE approved_ops SET state = ?, updated_at = ?, result_ref = COALESCE(?, result_ref) WHERE proposal_id = ? AND state = ?',
    )
    .run(to, nowIso(), extra?.resultRef ?? null, proposalId, from);
  return result.changes > 0;
}

export function listNonTerminalApprovedOps(db: SqliteDb): ApprovedOpRow[] {
  return db
    .prepare("SELECT * FROM approved_ops WHERE state IN ('claimed', 'running')")
    .all() as ApprovedOpRow[];
}

/**
 * [grant-consumed 死锁恢复通道，2026-10-01] 会话域 proposal 清单（项目域锚——
 * agent 侧只读诊断面 studio.task.proposals.list 的数据真源；跨会话行不经此面）。
 */
export function listApprovedOpsOfSession(db: SqliteDb, sessionId: string): ApprovedOpRow[] {
  return db
    .prepare(
      `SELECT o.* FROM approved_ops o JOIN tasks t ON t.id = o.task_id
       WHERE t.session_id = ? ORDER BY o.created_at, o.rowid`,
    )
    .all(sessionId) as ApprovedOpRow[];
}

// ---------------------------------------------------------------- grants

export function insertGrant(
  db: SqliteDb,
  input: {
    proposalId: string;
    taskId: string;
    /** 项目域锚（W6 6.2）：签发任务所属会话——消费端项目匹配的判定键。 */
    sessionId: string | null;
    opDigest: string;
    userId: string;
    resourceId: string;
    baseRevision: number;
    expiresAt: string;
    /** [product-polish-w1 T2] 自动签发标记（审计——开关放行 vs 用户点击）。 */
    autoApproved?: boolean;
  },
): GrantRow {
  const row: GrantRow = {
    id: newId(),
    proposal_id: input.proposalId,
    task_id: input.taskId,
    session_id: input.sessionId,
    op_digest: input.opDigest,
    user_id: input.userId,
    resource_id: input.resourceId,
    base_revision: input.baseRevision,
    expires_at: input.expiresAt,
    consumed: 0,
    created_at: nowIso(),
    auto_approved: input.autoApproved === true ? 1 : 0,
  };
  db.prepare(
    `INSERT INTO grants (id, proposal_id, task_id, session_id, op_digest, user_id, resource_id, base_revision, expires_at, consumed, created_at, auto_approved)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.proposal_id,
    row.task_id,
    row.session_id,
    row.op_digest,
    row.user_id,
    row.resource_id,
    row.base_revision,
    row.expires_at,
    row.consumed,
    row.created_at,
    row.auto_approved,
  );
  return row;
}

export function findUnconsumedGrant(db: SqliteDb, proposalId: string): GrantRow | null {
  const row = db
    .prepare('SELECT * FROM grants WHERE proposal_id = ? AND consumed = 0 ORDER BY created_at DESC LIMIT 1')
    .get(proposalId);
  return (row as GrantRow | undefined) ?? null;
}

export function findAnyGrant(db: SqliteDb, proposalId: string): GrantRow | null {
  const row = db.prepare('SELECT * FROM grants WHERE proposal_id = ? LIMIT 1').get(proposalId);
  return (row as GrantRow | undefined) ?? null;
}

/**
 * [grant-consumed 死锁恢复通道，2026-10-01] proposal 全量 grant 行（含已消费/
 * superseded——agent 侧诊断面要区分「未消费可执行」vs「已被消费」，findUnconsumed/
 * findAny 两点面不够投影）。
 */
export function listGrantsOfProposal(db: SqliteDb, proposalId: string): GrantRow[] {
  return db
    .prepare('SELECT * FROM grants WHERE proposal_id = ? ORDER BY created_at')
    .all(proposalId) as GrantRow[];
}

export function markGrantConsumed(db: SqliteDb, grantId: string): void {
  db.prepare('UPDATE grants SET consumed = 1 WHERE id = ?').run(grantId);
}

/**
 * [W6 6.2] 同键旧 grant 覆盖（新提案批准时）：同会话+同 user+同 tool+同 opDigest
 * 的未消费 grant 置 consumed——「新提案覆盖同键旧 grant」（一键一活：重新 preview+
 * approve 后旧批准立即失效，不留双活竞态窗口）。同 digest=同载荷内容重提案；不同
 * 载荷（不同 digest）是不同操作，互不覆盖。返回失效行数（审计面）。
 */
export function supersedeSessionGrants(
  db: SqliteDb,
  input: { sessionId: string; userId: string; tool: string; opDigest: string },
): number {
  const result = db
    .prepare(
      `UPDATE grants SET consumed = 1
        WHERE session_id = ? AND user_id = ? AND consumed = 0
          AND op_digest = ?
          AND proposal_id IN (SELECT proposal_id FROM approved_ops WHERE tool = ?)`,
    )
    .run(input.sessionId, input.userId, input.opDigest, input.tool);
  return result.changes;
}

/**
 * [W6 6.2] 项目清理级联：会话 clear（markClearing 事务①）时未消费 grant 全部置
 * consumed——批准随项目亡（清理后的会话不再持有可用授权；跨项目消费本就必拒，
 * 此处是显式失效面——行保留作审计）。
 */
export function consumeSessionGrants(db: SqliteDb, sessionId: string): number {
  const result = db
    .prepare('UPDATE grants SET consumed = 1 WHERE session_id = ? AND consumed = 0')
    .run(sessionId);
  return result.changes;
}

/**
 * [W6 6.2] grant 签发任务行（过期锚定用）：返回 status/updated_at；缺席=null
 * （任务行已被 clear 事务②删除——孤儿 grant，消费面按过期拒）。
 */
export function grantIssuingTask(
  db: SqliteDb,
  taskId: string,
): { status: string; updated_at: string } | null {
  const row = db
    .prepare('SELECT status, updated_at FROM tasks WHERE id = ?')
    .get(taskId) as { status: string; updated_at: string } | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------- attempts

export function insertAttempt(
  db: SqliteDb,
  input: {
    attemptId: string;
    proposalId: string;
    attemptNo: number;
    idemKey: string;
    retryRequestId: string;
    state: AttemptState;
  },
): AttemptRow {
  const now = nowIso();
  db.prepare(
    `INSERT INTO attempts (attempt_id, proposal_id, attempt_no, idem_key, retry_request_id, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.attemptId,
    input.proposalId,
    input.attemptNo,
    input.idemKey,
    input.retryRequestId,
    input.state,
    now,
    now,
  );
  return getAttempt(db, input.attemptId) as AttemptRow;
}

export function getAttempt(db: SqliteDb, attemptId: string): AttemptRow | null {
  const row = db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId);
  return (row as AttemptRow | undefined) ?? null;
}

export function getAttemptByRetryRequest(db: SqliteDb, retryRequestId: string): AttemptRow | null {
  const row = db.prepare('SELECT * FROM attempts WHERE retry_request_id = ?').get(retryRequestId);
  return (row as AttemptRow | undefined) ?? null;
}

export function listAttemptsOfProposal(db: SqliteDb, proposalId: string): AttemptRow[] {
  return db
    .prepare('SELECT * FROM attempts WHERE proposal_id = ? ORDER BY attempt_no')
    .all(proposalId) as AttemptRow[];
}

export function maxAttemptNo(db: SqliteDb, proposalId: string): number {
  const row = db
    .prepare('SELECT MAX(attempt_no) AS n FROM attempts WHERE proposal_id = ?')
    .get(proposalId) as { n: number | null };
  return row.n ?? 0;
}

export function findActiveAttempt(db: SqliteDb, proposalId: string): AttemptRow | null {
  const row = db
    .prepare("SELECT * FROM attempts WHERE proposal_id = ? AND state IN ('claimed', 'running') LIMIT 1")
    .get(proposalId);
  return (row as AttemptRow | undefined) ?? null;
}

export function transitionAttempt(
  db: SqliteDb,
  attemptId: string,
  from: AttemptState,
  to: AttemptState,
): boolean {
  const result = db
    .prepare('UPDATE attempts SET state = ?, updated_at = ? WHERE attempt_id = ? AND state = ?')
    .run(to, nowIso(), attemptId, from);
  return result.changes > 0;
}

export function listNonTerminalAttempts(db: SqliteDb): AttemptRow[] {
  return db
    .prepare("SELECT * FROM attempts WHERE state IN ('claimed', 'running')")
    .all() as AttemptRow[];
}

// ---------------------------------------------------------------- patch_history

export interface InsertPatchHistoryInput {
  ownerId: string;
  resourceId: string;
  patchGroup: string;
  proposalId: string;
  opKind: PatchHistoryRow['op_kind'];
  target: string;
  beforeJson: string;
  afterJson: string;
  baseRevision: number;
}

export function insertPatchHistory(db: SqliteDb, input: InsertPatchHistoryInput): void {
  db.prepare(
    `INSERT INTO patch_history (id, owner_id, resource_id, patch_group, proposal_id, op_kind, target, before_json, after_json, base_revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    input.ownerId,
    input.resourceId,
    input.patchGroup,
    input.proposalId,
    input.opKind,
    input.target,
    input.beforeJson,
    input.afterJson,
    input.baseRevision,
    nowIso(),
  );
}

export function listPatchHistoryOfGroup(db: SqliteDb, patchGroup: string): PatchHistoryRow[] {
  return db
    .prepare('SELECT * FROM patch_history WHERE patch_group = ? ORDER BY rowid')
    .all(patchGroup) as PatchHistoryRow[];
}

export function listPatchGroupsOfResource(db: SqliteDb, resourceId: string): string[] {
  return (
    db
      .prepare('SELECT DISTINCT patch_group FROM patch_history WHERE resource_id = ? ORDER BY rowid DESC')
      .all(resourceId) as { patch_group: string }[]
  ).map((row) => row.patch_group);
}
