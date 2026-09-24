/**
 * 撤销三族（design §3.6.7 R3——W4.2）：按族拆分补偿语义，不承诺跨族「撤销整组」。
 * 原始需求 2026-09-23（tasks.md W4.2）：
 *   [1] patch 族（可逆）：patch_history 整组逆序回退——回退也记 history（新组），
 *       真值 revision 单调前进（CAS 链不断）。
 *   [2] generate 族（不可逆）：补偿=cancel（未完成时 op/attempt 置 failed）
 *       +产物清理（结果 blob 释放引用——归零行置 deleting，物理回收走既有 outbox 链）。
 *   [3] export 族：补偿=revoke（分享包撤销 + bundle 引用释放——SessionService
 *       revokeResult 同一条回收链路）。
 */
import { randomUUID } from 'node:crypto';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs';
import {
  getApprovedOp,
  insertPatchHistory,
  listPatchHistoryOfGroup,
  listPatchGroupsOfResource,
} from '../db/approvals.js';
import {
  applyPatchChanges,
  loadLayoutDocument,
  rewriteLayoutDocument,
  type LayoutDocument,
  type PatchChange,
} from './layout-doc.js';

export interface UndoDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** export 族补偿入口（SessionService.revokeResult——markRevoked+sweep 同链路）。 */
  revokeResult?: (resultId: string) => void;
}

export interface UndoOutcome {
  family: 'patch' | 'generate' | 'export';
  detail: string;
}

/**
 * patch 族撤销：回退指定组（缺省=该资源最近一组）——整组逆序应用逆变换，
 * 回退记为新 history 组（proposal_id 标 undo 前缀）；真值 revision+1。
 */
export function undoPatchGroup(
  deps: UndoDeps,
  input: { ownerId: string; resourceId: string; group?: string },
): UndoOutcome {
  const group =
    input.group ?? listPatchGroupsOfResource(deps.db, input.resourceId)[0] ?? undefined;
  if (!group) throw new Error(`资源 ${input.resourceId} 无可撤销的 patch 组`);
  const rows = listPatchHistoryOfGroup(deps.db, group);
  if (rows.length === 0) throw new Error(`patch 组 ${group} 无历史行`);
  // W4.2 R1 P2-1：显式 group 与输入资源/归属用户绑定校验——组行不属于该资源或该
  // owner 即必拒（跨资源/跨 owner 的组不得把逆变换应用到当前资源；缺省组路径经
  // listPatchGroupsOfResource 天然资源域内，不触发此面）。
  for (const row of rows) {
    if (row.resource_id !== input.resourceId || row.owner_id !== input.ownerId) {
      throw new Error(
        `patch 组 ${group} 不属于资源 ${input.resourceId} 的归属域（组行归属 ${row.resource_id}）——跨资源/owner 组必拒`,
      );
    }
  }
  const resource = loadLayoutDocument(deps.db, deps.blobs, input.ownerId, input.resourceId);

  // 逆序构造逆变换（后写的先回退——整组逆序语义）。
  const inverse: PatchChange[] = [];
  const targets: string[] = [];
  for (const row of [...rows].reverse()) {
    const before = JSON.parse(row.before_json) as unknown;
    targets.push(row.target);
    switch (row.op_kind) {
      case 'setDensity':
        inverse.push({ op: 'setDensity', target: row.target, after: before as number });
        break;
      case 'recolor':
        if (typeof before !== 'string') throw new Error(`recolor 回退缺少原色板条目（组 ${group}）`);
        inverse.push({ op: 'recolor', target: row.target, after: before });
        break;
      case 'setSpec':
        if (before === null || typeof before !== 'object') {
          throw new Error(`setSpec 回退缺少原规格（组 ${group}）`);
        }
        inverse.push({
          op: 'setSpec',
          target: row.target,
          after: before as { shapeId: LayoutDocument['pave']['spec']['shapeId']; diameterMm: number; rotationDeg?: number; assetId?: string },
        });
        break;
    }
  }
  const { after, opRows } = applyPatchChanges(resource.doc, { kind: 'blocks', ids: [...new Set(targets)] }, inverse);

  const undoGroup = `undo-${randomUUID()}`;
  const tx = deps.db.transaction(() => {
    // 回退也记 history：before/after 与逆变换同形（原组的 after 成为回退的 before）。
    for (const row of opRows) {
      const original = rows.find((candidate) => candidate.target === row.target && candidate.op_kind === row.opKind);
      insertPatchHistory(deps.db, {
        ownerId: input.ownerId,
        resourceId: input.resourceId,
        patchGroup: undoGroup,
        proposalId: `undo:${original?.proposal_id ?? group}`,
        opKind: row.opKind,
        target: row.target,
        beforeJson: row.afterJson,
        afterJson: row.beforeJson,
        baseRevision: resource.revision,
      });
    }
    rewriteLayoutDocument(deps.db, deps.blobs, input.resourceId, after);
  });
  tx();
  return { family: 'patch', detail: `已整组逆序回退 patch 组 ${group}（${rows.length} op——回退记为新组 ${undoGroup}，真值 revision 前进）` };
}

/**
 * generate 族撤销：未完成（claimed/running）→ cancel（置 failed——本地取消语义）；
 * 已完成 → 产物清理（结果 blob 释放引用；归零行置 deleting，物理删除走 outbox 链）。
 */
export function undoGenerate(deps: UndoDeps, proposalId: string): UndoOutcome {
  const op = getApprovedOp(deps.db, proposalId);
  if (!op) throw new Error(`proposal 不存在：${proposalId}`);
  if (op.tool !== 'studio.generate') throw new Error(`proposal 不是 generate 族（tool=${op.tool}）`);
  const now = new Date().toISOString();
  const tx = deps.db.transaction(() => {
    let cancelled = false;
    if (op.state === 'claimed' || op.state === 'running') {
      deps.db
        .prepare('UPDATE approved_ops SET state = ?, updated_at = ? WHERE proposal_id = ?')
        .run('failed', now, proposalId);
      deps.db
        .prepare("UPDATE attempts SET state = 'failed', updated_at = ? WHERE proposal_id = ? AND state IN ('claimed', 'running')")
        .run(now, proposalId);
      cancelled = true;
    }
    if (op.result_ref) {
      deps.blobs.releaseRef(op.result_ref); // 产物清理——引用归零置 deleting（outbox 物理回收）
      deps.db
        .prepare('UPDATE approved_ops SET result_ref = NULL, updated_at = ? WHERE proposal_id = ?')
        .run(now, proposalId);
    }
    return { cancelled, hadArtifact: op.result_ref !== null };
  });
  const { cancelled, hadArtifact } = tx();
  return {
    family: 'generate',
    detail: `generate 补偿${cancelled ? '：未完成 op/attempt 已取消（failed）' : ''}${hadArtifact ? '；产物已清理（blob 引用释放）' : ''}——generate 不可逆，不承诺远端结果回滚`.replace('补偿：', cancelled || hadArtifact ? '补偿：' : '补偿（无在途/产物）'),
  };
}

/** export 族撤销：分享包 revoke + bundle 引用释放（SessionService 同一回收链路）。 */
export function undoExport(deps: UndoDeps, input: { proposalId?: string; resultId?: string }): UndoOutcome {
  const resultId =
    input.resultId ??
    (input.proposalId ? getApprovedOp(deps.db, input.proposalId)?.result_ref : undefined) ??
    null;
  if (!resultId) throw new Error('export 撤销缺 resultId（proposal 无已完成的导出结果）');
  if (!deps.revokeResult) throw new Error('撤销面未装配 revokeResult（SessionService 回收链路）');
  const row = deps.db.prepare('SELECT id FROM results WHERE id = ?').get(resultId) as { id: string } | undefined;
  if (!row) throw new Error(`结果行不存在：${resultId}`);
  deps.revokeResult(resultId);
  return { family: 'export', detail: `分享包已撤销（resultId=${resultId}）——bundle 引用释放，/r/ 分享面 404` };
}
