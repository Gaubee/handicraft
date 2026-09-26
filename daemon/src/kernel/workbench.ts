/**
 * 排钻工作台服务（add-task-detail-layer-workbench tasks 1.3+1.4——人类主权面的
 * 后端编排层）。装配位置：kernel/index.ts（与 SAM 桥/引擎委派同源注入——见
 * DshKernelFacade.workbench）；RPC 面 layer.* / tree.* 直调本类。
 *
 * 决策依据（design D-1 裁定）：
 *   - 人类在工作台的图层结构操作与策略调整=**直接生效**（所见即所得）——不走
 *     capability 授权桥 proposal/consumeForExecution 段；审计由 tree_versions
 *     版本链（树操作）+工件流 diff（策略操作：每次直改产新 strategy-plan.json/
 *     strategy-gems.json/strategy-gems-preview.png 帧）承载，操作者经 actorId 入史。
 *   - Agent 对话场景保持提案→批准铁律不变（capability 面 zero 触碰）。
 *
 * 正交意图：
 *   [1] segmentOne 编排：vision/segment-one 原子直调+版本入史（拆层）。
 *   [2] renameNode：树工件改名→persistTreeWithPreview 重落+版本入史。
 *   [3] treeHistory/treeRevert：v6 tree_versions 快照链——revert=按版本号回放快照
 *       帧（内容寻址工件天然不可变，重发 artifact 帧即「当前树」指针回拨）+revert
 *       自身入史（历史只增不删；撤销重做首版=revert）。
 *   [4] setNodeStrategy（D-1 策略直接生效）：新指派经 registry paramsSchema 逐项
 *     校验+stoneIdx→StonePick 真源回填（候选表=stone_index 稳定序共享库投影——与
 *     strategy.design 无过滤缺省面同源）→替换进当前 plan→executeStrategyPlan 真身
 *     （逐节点 apply+引擎校验门照走；跳过授权段）→三工件+帧。
 *       树漂移处置：当前树的产块节点集是 plan 收敛面——旧 plan 中已不在当前树的
 *       指派不入新 plan（工件流 diff 可审计，不静默丢失语义）。
 *   [5] fence：一切写入沿 putTaskArtifact/emitFor/树版本插入的既有 fence 语义
 *     （cancelled/cleared 任务拒写——ArtifactFenceError 收敛为 typed 'fence'）。
 *   [6] workbench-pro 波 2a（契约冻结——design §1 + 附录 D-2/D-3）：layer.reorder /
 *     layer.delete / layer.mask.patch 三写方法（CAS 门+锁定门+typed 错误+版本入史；
 *     通用写语义见 contracts workbench-pro 段头注——CAS/幂等/权限/版本/fence 五联）。
 *   [7] view-state（视图态所有权）：显隐/折叠/锁定=task 级服务端工件
 *     workbench-view-state.json（revision 单调链+previousBlobRef 回溯——不入
 *     tree_versions；undo tree-view 域沿本链，D-3）。锁定语义：locked 节点
 *     reorder/mask.patch 必拒，delete 该节点或含它的子树必拒（node-locked）。
 *   [8] mask 编辑状态机持久面（mask_edit_states v7）+导出门纯函数（exportGateOf——
 *     task.detail 组装复用；incomplete=run_count 超 4096 / stale / error 三阻断）。
 */
import { z } from 'zod';
import {
  DEFAULT_DENSITY_PER_CM2,
  derivePixelsPerMm,
  encodeInlineMask,
  EXPORT_BLOCKER_SCHEMA,
  KernelStrategyKindSchema,
  LayerDeleteInputSchema,
  LayerMaskPatchInputSchema,
  LayerReorderInputSchema,
  LayerRenameInputSchema,
  LayerStrategySetInputSchema,
  LayerSplitInputSchema,
  StrategyPlanSchema,
  TreeHistoryOutputSchema,
  TreeRevertInputSchema,
  ViewStateSchema,
  ViewStateSetInputSchema,
  WORKBENCH_MASK_RUN_LIMIT,
  WORKBENCH_VIEW_STATE_ARTIFACT_NAME,
  type ExportBlocker,
  type ExportGate,
  type LayerDeleteInput,
  type LayerDeleteOutput,
  type LayerMaskPatchInput,
  type LayerMaskPatchOutput,
  type LayerReorderInput,
  type LayerReorderOutput,
  type KernelStrategyKind,
  type LayerRenameInput,
  type LayerRenameOutput,
  type LayerSplitInput,
  type LayerStrategySetInput,
  type LayerStrategySetOutput,
  type MaskEditState,
  type MaskEditStatus,
  type ObjectNode,
  type ObjectTree,
  type SegmentOneOutput,
  type StonePick,
  type StrategyAssignment,
  type StrategyPlan,
  type TreeHistoryOutput,
  type TreeRevertInput,
  type TreeRevertOutput,
  type TreeVersion,
  type ViewState,
  type ViewStateSetInput,
  type ViewStateSetOutput,
  type WorkbenchWriteErrorCode,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { putTaskArtifact, type JobService } from '../jobs/service.js';
import { ArtifactFenceError, assertTaskWritable } from '../writer-fence.js';
import {
  executeStrategyPlan,
  persistFreeCodeArtifact,
  projectStoneCandidates,
  STRATEGY_GEMS_ARTIFACT_NAME,
  STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME,
  STRATEGY_PLAN_ARTIFACT_NAME,
  StrategyDesignError,
  type EngineLayoutDelegate,
} from './strategies/design.js';
import { STRATEGY_REGISTRY } from './strategies/registry.js';
import type { SamBridge } from './vision/sam-bridge.js';
import { cropBits, effectiveMmOf, tightBBox } from './vision/segment-loop.js';
import {
  OBJECT_TREE_ARTIFACT_NAME,
  OBJECT_TREE_PREVIEW_ARTIFACT_NAME,
  segmentOne,
  SegmentOneError,
} from './vision/segment-one.js';
import { loadObjectTreeArtifact, persistTreeWithPreview, resolveMaskBits } from './vision/tree-persist.js';

// ---------------------------------------------------------------- typed error

export type TaskWorkbenchErrorKind =
  | 'invalid-input'
  | 'task-missing'
  | 'bridge-unavailable'
  | 'tree-missing'
  | 'tree-invalid'
  | 'node-not-found'
  | 'node-not-assignable'
  | 'plan-missing'
  | 'plan-invalid'
  | 'params-invalid'
  | 'stone-invalid'
  | 'stone-unsized'
  | 'version-not-found'
  | 'fence'
  | 'internal'
  /** segment-one 原子失败面透传（image-missing/image-decode-failed/anchor-mismatch/
   * bridge-failure/no-instance——kind 原样判别，拆层面呈现原语义）。 */
  | 'image-missing'
  | 'image-decode-failed'
  | 'anchor-mismatch'
  | 'bridge-failure'
  | 'no-instance'
  /** workbench-pro 波 2a 三写 RPC typed 错误码（contracts
   * WORKBENCH_WRITE_ERROR_CODE_SCHEMA 冻结面同源——八值）。 */
  | WorkbenchWriteErrorCode;

/** 工作台统一 typed error（沿 kernel typed error 先例——kind 判别失败面）。 */
export class TaskWorkbenchError extends Error {
  readonly kind: TaskWorkbenchErrorKind;

  /**
   * kind='cas-mismatch' 时的电流树工件引用（幂等重试判别锚：客户端比对自己上次
   * 响应的 treeBlobRef——相等=「已生效」放弃重试，不等=「他写」刷新后重放意图；
   * view-state 面为 null——CAS 语义以 revision 计）。RPC 面 data.currentTreeBlobRef。
   */
  readonly currentTreeBlobRef?: string;

  constructor(
    message: string,
    kind: TaskWorkbenchErrorKind,
    options?: { cause?: unknown; currentTreeBlobRef?: string },
  ) {
    super(message, options);
    this.name = 'TaskWorkbenchError';
    this.kind = kind;
    if (options?.currentTreeBlobRef !== undefined) this.currentTreeBlobRef = options.currentTreeBlobRef;
  }
}

export interface TaskWorkbenchDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（artifact 帧登记——latest-by-name 即「当前树/当前 gems」指针）。 */
  jobs: Pick<JobService, 'emitFor'>;
  /** SAM 桥（kernel 共享实例——segmentOne 拆层必经；缺席=拆层面 typed 拒）。 */
  bridge?: Pick<SamBridge, 'run'>;
  /** 引擎 layout 委派真身（strategies 红线——kernel 接线层注入；缺席时 engineStrategy 委派节点 typed 拒）。 */
  engineLayout?: EngineLayoutDelegate;
}

interface TreeVersionRow {
  task_id: string;
  version: number;
  tree_blob_ref: string;
  preview_blob_ref: string;
  cause: TreeVersion['cause'];
  detail: string | null;
  actor_id: string;
  created_at: string;
}

/** mask_edit_states 行（v7——contracts MaskEditStatusSchema 持久镜像）。 */
interface MaskEditStateRow {
  task_id: string;
  node_id: string;
  state: MaskEditState;
  run_count: number;
  base_version: number;
  error: string | null;
  updated_at: string;
}

// ------------------------------------------------------- mask 编辑面/导出门纯函数（rpc 组装复用）

/** 行 → 契约面（incomplete=run_count 超 4096 行程上限——判定单点）。 */
export function maskEditRowToStatus(row: MaskEditStateRow): MaskEditStatus {
  return {
    nodeId: row.node_id,
    state: row.state,
    runCount: row.run_count,
    incomplete: row.run_count > WORKBENCH_MASK_RUN_LIMIT,
    baseVersion: row.base_version,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

/** task 的 mask 编辑状态面（node_id 升序——确定性；无行=空数组）。 */
export function maskEditStatusesOf(db: SqliteDb, taskId: string): MaskEditStatus[] {
  const rows = db
    .prepare('SELECT * FROM mask_edit_states WHERE task_id = ? ORDER BY node_id ASC')
    .all(taskId) as MaskEditStateRow[];
  return rows.map(maskEditRowToStatus);
}

/**
 * 导出门（纯函数——task.detail.exportGate 组装单点）：incomplete → mask-incomplete；
 * state=stale → mask-stale；state=error → mask-recompute-error。blockers 去重并按
 * 契约枚举声明序（确定性）；allowed=blockers 空。门只增不减（D-2 裁定：4096
 * incomplete=禁止导出——无客户端豁免口）。
 */
export function exportGateOf(statuses: MaskEditStatus[]): ExportGate {
  const hit = new Set<ExportBlocker>();
  for (const s of statuses) {
    if (s.incomplete) hit.add('mask-incomplete');
    if (s.state === 'stale') hit.add('mask-stale');
    if (s.state === 'error') hit.add('mask-recompute-error');
  }
  const blockers = EXPORT_BLOCKER_SCHEMA.options.filter((b) => hit.has(b));
  return { allowed: blockers.length === 0, blockers };
}

/** 视图态工件读回（blobRef=null→null；缺 blob/损坏/不符契约=typed 拒——不静默）。 */
export function loadViewState(blobs: BlobStore, blobRef: string | null): ViewState | null {
  if (blobRef === null) return null;
  const bytes = blobs.read(blobRef);
  if (bytes === null) {
    throw new TaskWorkbenchError(`视图态工件不可读（blobRef=${blobRef.slice(0, 12)}…）`, 'view-state-invalid');
  }
  try {
    return ViewStateSchema.parse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new TaskWorkbenchError(
      `视图态工件不符契约：${error instanceof Error ? error.message : String(error)}`,
      'view-state-invalid',
      { cause: error },
    );
  }
}

/** 扁平字节串 RLE 行程数（极大同值段数；空串=0）——4096 上限的计数口径。 */
function countRuns(bits: Uint8Array): number {
  if (bits.length === 0) return 0;
  let runs = 1;
  for (let i = 1; i < bits.length; i++) {
    if (bits[i] !== bits[i - 1]) runs++;
  }
  return runs;
}

// ---------------------------------------------------------------- 服务本体

export class TaskWorkbench {
  constructor(private readonly deps: TaskWorkbenchDeps) {}

  // ------------------------------------------------------- [1] 拆层（segment-one 编排）

  /** 人类拆层（layer.split 真身）：segmentOne 原子直调+版本入史。 */
  async segmentOneSplit(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    treeBlobRef: string;
    nodeId: string;
    hint: string;
  }): Promise<SegmentOneOutput> {
    const parsed = LayerSplitInputSchema.safeParse({
      taskId: input.taskId,
      nodeId: input.nodeId,
      hint: input.hint,
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `layer.split 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    if (this.deps.bridge === undefined) {
      throw new TaskWorkbenchError(
        'SAM 桥未装配（env SAM_SSH_HOST+SAM_SSH_REMOTE_COMMAND 或 SAM_BRIDGE_MOCK=1）——拆层不可用（无降级面：人类「拆这一层」意图与一键颜色分块不符）',
        'bridge-unavailable',
      );
    }
    let outcome: SegmentOneOutput;
    try {
      outcome = await segmentOne(
        { db: this.deps.db, blobs: this.deps.blobs, jobs: this.deps.jobs, bridge: this.deps.bridge },
        {
          taskId: input.taskId,
          imageBlobRef: input.imageBlobRef,
          treeBlobRef: input.treeBlobRef,
          nodeId: input.nodeId,
          hint: input.hint,
        },
      );
    } catch (error) {
      if (error instanceof SegmentOneError) {
        throw new TaskWorkbenchError(`拆层失败（${error.kind}）：${error.message}`, error.kind, {
          cause: error,
        });
      }
      throw error;
    }
    const label = outcome.children.length > 0 ? outcome.children[0]!.objectName : '零检出';
    this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'segment-one',
      detail: `拆「${label}」（提示：${input.hint.slice(0, 40)}）`,
      treeBlobRef: outcome.treeBlobRef,
      previewBlobRef: outcome.previewBlobRef,
    });
    return outcome;
  }

  // ------------------------------------------------------- [2] 改名（直接生效）

  /** 图层改名（layer.rename 真身）：树工件改写+重落双轨+版本入史。 */
  renameNode(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    treeBlobRef: string;
  } & LayerRenameInput): LayerRenameOutput {
    const parsed = LayerRenameInputSchema.safeParse({
      taskId: input.taskId,
      nodeId: input.nodeId,
      objectName: input.objectName,
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `layer.rename 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const tree = this.loadTree(input.treeBlobRef);
    const node = tree.nodes.find((n) => n.id === input.nodeId);
    if (node === undefined) {
      throw new TaskWorkbenchError(
        `目标节点 ${input.nodeId} 不在当前树（${tree.nodes.length} 节点——树工件与 UI 视图漂移，刷新后重试）`,
        'node-not-found',
      );
    }
    const before = node.objectName;
    node.objectName = input.objectName.trim();
    const bundle = this.persistTree(input.taskId, input.imageBlobRef, tree);
    this.emitTree(input.taskId, bundle.treeBlobRef, bundle.previewBlobRef);
    const version = this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'rename',
      detail: `「${before}」→「${node.objectName}」（${node.id}）`,
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
    });
    return { treeBlobRef: bundle.treeBlobRef, previewBlobRef: bundle.previewBlobRef, version };
  }

  // ------------------------------------------------------- [3] 版本历史/回退

  /** 版本列表（tree.history 真身——工作台写操作的快照链；升序）。 */
  treeHistory(taskId: string): { versions: TreeVersion[]; currentVersion: number | null } {
    const rows = this.deps.db
      .prepare('SELECT * FROM tree_versions WHERE task_id = ? ORDER BY version ASC')
      .all(taskId) as TreeVersionRow[];
    const versions: TreeVersion[] = rows.map((row) => ({
      version: row.version,
      cause: row.cause,
      detail: row.detail,
      treeBlobRef: row.tree_blob_ref,
      previewBlobRef: row.preview_blob_ref,
      createdAt: row.created_at,
    }));
    TreeHistoryOutputSchema.parse({ versions, currentTreeBlobRef: null, currentVersion: null }); // 结构自证
    return { versions, currentVersion: versions.length > 0 ? versions[versions.length - 1]!.version : null };
  }

  /** 回退（tree.revert 真身）：按版本号回放快照帧（工件不可变——重发帧即指针回拨）+revert 入史。 */
  treeRevert(input: { taskId: string; actorId: string } & TreeRevertInput): TreeRevertOutput {
    const parsed = TreeRevertInputSchema.safeParse({ taskId: input.taskId, version: input.version });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `tree.revert 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const row = this.deps.db
      .prepare('SELECT * FROM tree_versions WHERE task_id = ? AND version = ?')
      .get(input.taskId, input.version) as TreeVersionRow | undefined;
    if (row === undefined) {
      throw new TaskWorkbenchError(
        `版本 v${input.version} 不在任务 ${input.taskId} 的历史（tree.history 查可用版本）`,
        'version-not-found',
      );
    }
    // 快照可读性校验（工件被回收=历史链断裂，显式拒不猜）
    this.loadTree(row.tree_blob_ref);
    if (this.deps.blobs.read(row.preview_blob_ref) === null) {
      throw new TaskWorkbenchError(
        `版本 v${input.version} 预览工件不可读（blobRef=${row.preview_blob_ref.slice(0, 12)}…）`,
        'tree-missing',
      );
    }
    this.emitTree(input.taskId, row.tree_blob_ref, row.preview_blob_ref);
    const version = this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'revert',
      detail: `回退到 v${input.version}（${row.detail ?? row.cause}）`,
      treeBlobRef: row.tree_blob_ref,
      previewBlobRef: row.preview_blob_ref,
    });
    return { treeBlobRef: row.tree_blob_ref, previewBlobRef: row.preview_blob_ref, version };
  }

  // ------------------------------------------------------- [4] 策略直改（D-1 直接生效）

  /**
   * 单节点策略直改（layer.strategy.set 真身）：新指派逐项校验→替换进当前 plan→
   * executeStrategyPlan 真身重算（全树确定性重放——未改节点 seed/params 同源产同
   * gems）→三工件+帧。首版无 plan 时=单指派 plan（其余节点待指派——task.detail
   * assignments 即时可见）。
   */
  setNodeStrategy(input: {
    taskId: string;
    treeBlobRef: string;
    /** 当前生效 plan 工件（null=首版直改——无既有 plan）。 */
    planBlobRef: string | null;
  } & LayerStrategySetInput): LayerStrategySetOutput {
    const parsed = LayerStrategySetInputSchema.safeParse({
      taskId: input.taskId,
      nodeId: input.nodeId,
      strategyKind: input.strategyKind,
      params: input.params,
      ...(input.stoneIdx !== undefined ? { stoneIdx: input.stoneIdx } : {}),
      ...(input.densityPerCm2 !== undefined ? { densityPerCm2: input.densityPerCm2 } : {}),
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `layer.strategy.set 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const in_ = parsed.data;
    const task = this.requireTask(input.taskId);
    const tree = this.loadTree(input.treeBlobRef);
    const node = tree.nodes.find((n) => n.id === in_.nodeId);
    if (node === undefined) {
      throw new TaskWorkbenchError(
        `目标节点 ${in_.nodeId} 不在当前树（${tree.nodes.length} 节点）`,
        'node-not-found',
      );
    }
    // 产块判定（tree-to-blocks producesBlock 同构：叶子必产；中间按 drillWorthy）
    if (node.children.length > 0 && !node.drillWorthy) {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId}「${node.objectName}」是层级节点（中间不产钻——禁止指派；对叶子或 drillWorthy 节点指派）`,
        'node-not-assignable',
      );
    }

    // —— params 逐项校验（registry paramsSchema——合法性校验真源，与 strategy.design 同门）
    const kindCheck = KernelStrategyKindSchema.safeParse(in_.strategyKind);
    if (!kindCheck.success) {
      throw new TaskWorkbenchError(`strategyKind 不在七值枚举：${in_.strategyKind}`, 'params-invalid');
    }
    const kind = kindCheck.data as KernelStrategyKind;
    const entry = STRATEGY_REGISTRY.get(kind);
    if (entry === undefined) {
      throw new TaskWorkbenchError(`策略 ${kind} 不在注册表`, 'params-invalid');
    }
    const paramsCheck = entry.paramsSchema.safeParse(in_.params);
    if (!paramsCheck.success) {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId} 的 ${kind} params 非法：${paramsCheck.error.issues.map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`,
        'params-invalid',
        { cause: paramsCheck.error },
      );
    }

    // —— stoneIdx → StonePick 真源回填（候选表=共享库稳定序投影——与 design 缺省面同源）。
    // stoneIdx 缺省（UI 只改参数/密度的常见路径）时继承该节点既有指派的钻——参数微调
    // 不强迫重选钻（真环境走查实证：前端不回传 stoneIdx → stone-invalid 挡死直改流）。
    let stones = this.resolveStones(task.ownerId, in_.stoneIdx, in_.nodeId, kind);
    const inherited =
      stones.length === 0 && (in_.stoneIdx === undefined || in_.stoneIdx.length === 0) && input.planBlobRef !== null
        ? this.loadPlan(input.planBlobRef).assignments.find((a) => a.nodeId === in_.nodeId)?.stones ?? []
        : [];
    if (stones.length === 0 && inherited.length > 0) stones = inherited;
    const codeArtifactRef = kind === 'free-code' ? persistFreeCodeArtifact(this.deps.blobs, { params: in_.params }) : undefined;
    if (kind !== 'free-code' && stones.length === 0 && kind !== 'exclusion') {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId} 的 ${kind} 指派缺少 stoneIdx（至少 1 款候选钻——exclusion 可省略；无既有指派可继承）`,
        'stone-invalid',
      );
    }
    const replacement: StrategyAssignment = {
      nodeId: in_.nodeId,
      strategyKind: kind,
      params: in_.params,
      stones,
      densityPerCm2: in_.densityPerCm2 ?? DEFAULT_DENSITY_PER_CM2,
      ...(codeArtifactRef !== undefined ? { codeArtifactRef } : {}),
      rationale: `工作台直改：${kind}（D-1 直接生效）`,
    };
    const assignmentCheck = StrategyPlanSchema.shape.assignments.element.safeParse(replacement);
    if (!assignmentCheck.success) {
      throw new TaskWorkbenchError(
        `新指派不符 StrategyAssignment 契约：${assignmentCheck.error.issues.map((i) => i.message).join('; ')}`,
        'plan-invalid',
        { cause: assignmentCheck.error },
      );
    }

    // —— 当前 plan 读回+指派替换（收敛到当前树产块节点集——树漂移处置见头注 [4]）
    const producingIds = new Set(tree.nodes.filter((n) => n.children.length === 0 || n.drillWorthy).map((n) => n.id));
    let previous: StrategyAssignment[] = [];
    let styleId: string | undefined;
    if (input.planBlobRef !== null) {
      const plan = this.loadPlan(input.planBlobRef);
      styleId = plan.styleId;
      previous = plan.assignments.filter((a) => a.nodeId !== in_.nodeId && producingIds.has(a.nodeId));
    }
    // 原位替换（有旧指派时保持表序——plan 工件 diff 最小化），首指派追加
    const assignments = [...previous, replacement];
    const plan: StrategyPlan = StrategyPlanSchema.parse({
      kind: 'strategy-plan',
      formatVersion: 1,
      objectTreeRef: input.treeBlobRef,
      ...(styleId !== undefined ? { styleId } : {}),
      assignments,
      createdAt: new Date().toISOString(),
    });

    // —— execute 真身（逐节点 apply+引擎校验门照走——跳过 proposal/consumeForExecution 段）
    try {
      const executed = executeStrategyPlan(
        { db: this.deps.db, blobs: this.deps.blobs },
        {
          taskId: input.taskId,
          plan,
          ...(this.deps.engineLayout !== undefined ? { engineLayout: this.deps.engineLayout } : {}),
        },
      );
      const refs = executed.value as {
        planBlobRef?: unknown;
        gemsBlobRef?: unknown;
        previewBlobRef?: unknown;
        gemCount?: unknown;
      };
      for (const [name, ref] of [
        [STRATEGY_PLAN_ARTIFACT_NAME, refs.planBlobRef],
        [STRATEGY_GEMS_ARTIFACT_NAME, refs.gemsBlobRef],
        [STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME, refs.previewBlobRef],
      ] as const) {
        if (typeof ref === 'string') this.deps.jobs.emitFor(input.taskId, 'artifact', { blobRef: ref, name });
      }
      return {
        gems: { blobRef: String(refs.gemsBlobRef), count: Number(refs.gemCount ?? 0) },
        preview: { blobRef: String(refs.previewBlobRef) },
      };
    } catch (error) {
      if (error instanceof StrategyDesignError) {
        throw new TaskWorkbenchError(`策略重算失败（${error.kind}）：${error.message}`, 'internal', { cause: error });
      }
      if (error instanceof ArtifactFenceError) {
        throw new TaskWorkbenchError(`策略产物写入被 fence 拒绝：${error.message}`, 'fence', { cause: error });
      }
      throw new TaskWorkbenchError(
        `策略重算失败：${error instanceof Error ? error.message : String(error)}`,
        'internal',
        { cause: error },
      );
    }
  }

  // ------------------------------------------------------- [5] workbench-pro 波 2a 三写（契约冻结面）

  /**
   * CAS 门（三写 RPC 共用）：expectedTreeBlobRef ≠ 电流树工件=cas-mismatch（携带
   * currentTreeBlobRef——幂等重试判别锚；与 segment-one anchor-mismatch「锚点漂移
   * 必拒」语义同源：不猜测、不合并）。
   */
  private assertTreeCas(what: string, expectedTreeBlobRef: string, currentTreeBlobRef: string): void {
    if (expectedTreeBlobRef === currentTreeBlobRef) return;
    throw new TaskWorkbenchError(
      `${what} CAS 漂移必拒：expectedTreeBlobRef=${expectedTreeBlobRef.slice(0, 12)}… ≠ 电流树 ${currentTreeBlobRef.slice(0, 12)}…` +
        '（树已被推进——若 expected=本端上次响应的 treeBlobRef 则改动已生效无需重试；否则刷新后重放意图）',
      'cas-mismatch',
      { currentTreeBlobRef },
    );
  }

  /** 锁定节点集（视图态工件读回——locked=true 的节点；无工件=空集）。 */
  private lockedNodeIds(currentViewStateBlobRef: string | null): Set<string> {
    const state = loadViewState(this.deps.blobs, currentViewStateBlobRef);
    if (state === null) return new Set();
    return new Set(state.nodes.filter((n) => n.locked === true).map((n) => n.nodeId));
  }

  /** 树重排（layer.reorder 真身）：父变更+序位；环路/根保护/锁定 typed 拒；产块节点集不变⇒指派零触碰。 */
  layerReorder(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    currentTreeBlobRef: string;
    currentViewStateBlobRef: string | null;
  } & LayerReorderInput): LayerReorderOutput {
    const parsed = LayerReorderInputSchema.safeParse({
      taskId: input.taskId,
      nodeId: input.nodeId,
      newParentId: input.newParentId,
      index: input.index,
      expectedTreeBlobRef: input.expectedTreeBlobRef,
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `layer.reorder 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const in_ = parsed.data;
    this.assertTreeCas('layer.reorder', in_.expectedTreeBlobRef, input.currentTreeBlobRef);
    const tree = this.loadTree(input.currentTreeBlobRef);
    const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
    const node = byId.get(in_.nodeId);
    if (node === undefined) {
      throw new TaskWorkbenchError(
        `移动目标 ${in_.nodeId} 不在当前树（${tree.nodes.length} 节点——树工件与 UI 视图漂移，刷新后重试）`,
        'node-not-found',
      );
    }
    if (node.parent === null) {
      throw new TaskWorkbenchError(
        `根/画布节点 ${in_.nodeId}「${node.objectName}」不可重排（单根树的结构锚——root-protected）`,
        'root-protected',
      );
    }
    const newParent = byId.get(in_.newParentId);
    if (newParent === undefined) {
      throw new TaskWorkbenchError(
        `新父 ${in_.newParentId} 不在当前树（${tree.nodes.length} 节点）`,
        'parent-invalid',
      );
    }
    // 环路：新父=自身或处在本节点子树内（沿 parent 链上溯命中即环）
    for (let cur: ObjectNode | undefined = newParent; cur !== undefined; cur = cur.parent === null ? undefined : byId.get(cur.parent)) {
      if (cur.id === in_.nodeId) {
        throw new TaskWorkbenchError(
          `新父 ${in_.newParentId} 在 ${in_.nodeId}「${node.objectName}」的子树内（含自身）——重排成环必拒`,
          'cycle',
        );
      }
    }
    if (this.lockedNodeIds(input.currentViewStateBlobRef).has(in_.nodeId)) {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId}「${node.objectName}」已被锁定（视图态 locked=true——结构+遮罩面冻结，先解锁再移动）`,
        'node-locked',
      );
    }
    const oldParent = byId.get(node.parent)!;
    oldParent.children = oldParent.children.filter((id) => id !== in_.nodeId);
    if (in_.index > newParent.children.length) {
      throw new TaskWorkbenchError(
        `插入位 index=${in_.index} 越界（newParent「${newParent.objectName}」移出后 children 长 ${newParent.children.length}——0 基插入语义）`,
        'invalid-input',
      );
    }
    newParent.children.splice(in_.index, 0, in_.nodeId);
    node.parent = in_.newParentId;

    const bundle = this.persistTree(input.taskId, input.imageBlobRef, tree);
    this.emitTree(input.taskId, bundle.treeBlobRef, bundle.previewBlobRef);
    const version = this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'reorder',
      detail: `「${node.objectName}」→「${newParent.objectName}」第 ${in_.index} 位`,
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
    });
    return { treeBlobRef: bundle.treeBlobRef, previewBlobRef: bundle.previewBlobRef, version };
  }

  /**
   * 删子树（layer.delete 真身）：子树全集出树+父收口；指派收敛（被删指派移除+存量
   * plan 重算——setStrategy 同语义；空收敛不落新 plan，D-2 附录）；锁定/根保护拒；
   * mask 编辑留痕随删清理。
   *
   * 提交协议（P0-3——Codex 2a 复核：删除跨存储步骤原子化）：**可失败步骤全部
   * 先行，帧发布一次性收尾**——
   *   ① 校验（CAS/树/根保护/锁定——纯读，天然先行）
   *   ② persistTree：新树+预览 blob 落档（内容寻址——不发布，失败零副作用）
   *   ③ 收敛重算·计算段（computeConvergedPlan——引擎+工件落档，帧收集不发布）
   *   ④ recordTreeVersion：版本入史（SQLite 事务+fence）
   *   ⑤ purgeMaskEditStates：编辑留痕清理
   *   ⑥ 发布段：emitTree（树+预览帧=「电流树」指针推进）+emitStrategyFrames
   * 不变量：**电流树指针推进 ⇒ 版本已在+状态已清**（「新树已生效、历史缺失」
   * 半状态不可达）；②-⑤ 任一步失败=零帧发布，CAS 基线未动可安全重试（重试对
   * 版本已入史未发布的窗口会追加一行同树快照版本——历史只增不删，收敛等价）。
   */
  layerDelete(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    currentTreeBlobRef: string;
    currentViewStateBlobRef: string | null;
    /** 当前生效 plan 工件（null=无 plan——无指派可收敛）。 */
    planBlobRef: string | null;
  } & LayerDeleteInput): LayerDeleteOutput {
    const parsed = LayerDeleteInputSchema.safeParse({
      taskId: input.taskId,
      nodeId: input.nodeId,
      expectedTreeBlobRef: input.expectedTreeBlobRef,
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `layer.delete 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const in_ = parsed.data;
    this.assertTreeCas('layer.delete', in_.expectedTreeBlobRef, input.currentTreeBlobRef);
    const tree = this.loadTree(input.currentTreeBlobRef);
    const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
    const node = byId.get(in_.nodeId);
    if (node === undefined) {
      throw new TaskWorkbenchError(
        `删除目标 ${in_.nodeId} 不在当前树（${tree.nodes.length} 节点——刷新后重试）`,
        'node-not-found',
      );
    }
    if (node.parent === null) {
      throw new TaskWorkbenchError(
        `根/画布节点 ${in_.nodeId}「${node.objectName}」不可删（单根树的结构锚——root-protected）`,
        'root-protected',
      );
    }
    // 子树全集（DFS 先序——removedNodeIds 契约序）
    const removed: string[] = [];
    const visit = (id: string): void => {
      const n = byId.get(id);
      if (n === undefined) return;
      removed.push(id);
      for (const c of n.children) visit(c);
    };
    visit(in_.nodeId);
    const removedSet = new Set(removed);
    // 锁定：目标或子树内任一锁定节点=拒（锁定=冻结其结构面）
    const lockedHit = removed.find((id) => this.lockedNodeIds(input.currentViewStateBlobRef).has(id));
    if (lockedHit !== undefined) {
      throw new TaskWorkbenchError(
        `子树内节点 ${lockedHit}「${byId.get(lockedHit)!.objectName}」已被锁定（锁定=结构面冻结——先解锁再删除）`,
        'node-locked',
      );
    }
    const parent = byId.get(node.parent)!;
    parent.children = parent.children.filter((id) => id !== in_.nodeId);
    tree.nodes = tree.nodes.filter((n) => !removedSet.has(n.id));

    // —— ② 新树落档（blob 不发布——内容寻址，失败零副作用）
    const bundle = this.persistTree(input.taskId, input.imageBlobRef, tree);

    // —— ③ 指派收敛·计算段（存量 plan 在场且确有被删指派时；帧收集不发布）
    let removedAssignmentNodeIds: string[] = [];
    let gems: LayerDeleteOutput['gems'] = null;
    let strategyFrames: Array<[name: string, ref: string]> = [];
    if (input.planBlobRef !== null) {
      const plan = this.loadPlan(input.planBlobRef);
      removedAssignmentNodeIds = plan.assignments.filter((a) => removedSet.has(a.nodeId)).map((a) => a.nodeId);
      const remaining = plan.assignments.filter((a) => !removedSet.has(a.nodeId));
      if (removedAssignmentNodeIds.length > 0 && remaining.length > 0) {
        const computed = this.computeConvergedPlan(input.taskId, plan, remaining, bundle.treeBlobRef);
        gems = computed.gems;
        strategyFrames = computed.frames;
      }
      // remaining=空 → 空收敛：不落新 plan（StrategyPlan min(1) 边界——工件事表示 2b 裁定，D-2 附录）
    }
    // —— ④ 版本入史（历史先行于发布——电流树推进 ⇒ 版本必已在）
    const version = this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'delete',
      detail: `删除「${node.objectName}」子树（${removed.length} 节点）`,
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
    });
    // —— ⑤ mask 编辑留痕随删清理（可失败步骤最后一步——此后仅剩帧发布）
    this.purgeMaskEditStates(input.taskId, removed);
    // —— ⑥ 发布段（一次性收尾：树指针+预览+（若有）plan/gems/preview 帧）
    this.emitTree(input.taskId, bundle.treeBlobRef, bundle.previewBlobRef);
    this.emitStrategyFrames(input.taskId, strategyFrames);
    return {
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
      version,
      removedNodeIds: removed,
      removedAssignmentNodeIds,
      gems,
    };
  }

  /**
   * 最小遮罩编辑闭环（layer.mask.patch 真身，P0 同步链）：笔迹光栅化（bbox 局部，
   * 画布坐标换算——bbox 外无效不跨界）→mask 重写+tightBBox/effectiveMm 重算→版本
   * 入史→（recomputeStrategy）受影响指派重算。空掩码拒；行程超限=incomplete 如实
   * 落盘+门阻断；重算失败不回滚 mask（状态机 error 态留痕——可重试）。
   */
  layerMaskPatch(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    currentTreeBlobRef: string;
    currentViewStateBlobRef: string | null;
    /** 当前生效 plan 工件（recomputeStrategy=true 时的重算输入；null=仅 mask 面）。 */
    planBlobRef: string | null;
  } & Omit<LayerMaskPatchInput, 'recomputeStrategy'> & { recomputeStrategy?: boolean }): LayerMaskPatchOutput {
    const parsed = LayerMaskPatchInputSchema.safeParse({
      taskId: input.taskId,
      nodeId: input.nodeId,
      ops: input.ops,
      expectedTreeBlobRef: input.expectedTreeBlobRef,
      ...(input.recomputeStrategy !== undefined ? { recomputeStrategy: input.recomputeStrategy } : {}),
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `layer.mask.patch 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const in_ = parsed.data;
    this.assertTreeCas('layer.mask.patch', in_.expectedTreeBlobRef, input.currentTreeBlobRef);
    const tree = this.loadTree(input.currentTreeBlobRef);
    const node = tree.nodes.find((n) => n.id === in_.nodeId);
    if (node === undefined) {
      throw new TaskWorkbenchError(
        `编辑目标 ${in_.nodeId} 不在当前树（${tree.nodes.length} 节点——刷新后重试）`,
        'node-not-found',
      );
    }
    if (this.lockedNodeIds(input.currentViewStateBlobRef).has(in_.nodeId)) {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId}「${node.objectName}」已被锁定（锁定=结构+遮罩面冻结，先解锁再编辑）`,
        'node-locked',
      );
    }

    // —— 笔迹光栅化（bbox 局部坐标——画布 px 换算；圆盘按像素中心判定，裁剪到 mask 界内）
    const resolved = resolveMaskBits(this.deps.blobs, node.mask);
    if (resolved.w !== node.bbox.w || resolved.h !== node.bbox.h) {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId} 的 mask 维度 ${resolved.w}×${resolved.h} ≠ bbox ${node.bbox.w}×${node.bbox.h}（工件不变式破坏——不猜测修复）`,
        'tree-invalid',
      );
    }
    const { w, h, bits } = resolved;
    const bbox = node.bbox;
    for (const stroke of in_.ops) {
      const value = stroke.op === 'add' ? 1 : 0;
      for (const p of stroke.points) {
        const cx = p.x - bbox.x;
        const cy = p.y - bbox.y;
        const r = stroke.radiusPx;
        const x0 = Math.max(0, Math.floor(cx - r));
        const x1 = Math.min(w - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r));
        const y1 = Math.min(h - 1, Math.ceil(cy + r));
        const rr = r * r;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const dx = xx + 0.5 - cx;
            const dy = yy + 0.5 - cy;
            if (dx * dx + dy * dy <= rr) bits[yy * w + xx] = value;
          }
        }
      }
    }
    let popcount = 0;
    for (const b of bits) popcount += b;
    if (popcount === 0) {
      throw new TaskWorkbenchError(
        `笔迹后节点 ${in_.nodeId}「${node.objectName}」掩码为空（remove 涂空全节点非法——节点必须保有非空掩码；整层移除请用 layer.delete）`,
        'mask-invalid',
      );
    }
    const local = tightBBox(bits, w, h)!; // popcount>0 ⇒ 非空
    const cropped = cropBits(bits, local, w);
    const newBBox = { x: bbox.x + local.x, y: bbox.y + local.y, w: local.w, h: local.h };
    const ppm = derivePixelsPerMm({ canvasCm: tree.canvasCm, imagePx: tree.imagePx });
    if (!ppm.ok) {
      throw new TaskWorkbenchError(
        `树工件 canvasCm/imagePx 纵横比漂移（cm ${ppm.aspectCm} vs px ${ppm.aspectPx}）——尺寸声明漂移必拒（anchor-mismatch 同源语义）`,
        'tree-invalid',
      );
    }
    node.mask = encodeInlineMask(local.w, local.h, cropped); // 持久化阈值转换由 persistTree 承担（>4096 字节转 blob 态）
    node.bbox = newBBox;
    node.effectiveMm = effectiveMmOf(newBBox, ppm.pixelsPerMm);
    const runCount = countRuns(cropped);

    const bundle = this.persistTree(input.taskId, input.imageBlobRef, tree);
    this.emitTree(input.taskId, bundle.treeBlobRef, bundle.previewBlobRef);
    const version = this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'mask-patch',
      detail: `笔刷编辑「${node.objectName}」（${in_.ops.length} 笔）`,
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
    });

    // —— 可选重算指派（失败不回滚 mask：版本已入史——状态机 error 态留痕+门阻断，可重试）
    let editState: MaskEditState = 'ready';
    let errorText: string | null = null;
    let gems: LayerMaskPatchOutput['gems'] = null;
    if (in_.recomputeStrategy && input.planBlobRef !== null) {
      const plan = this.loadPlan(input.planBlobRef);
      const producingIds = new Set(
        tree.nodes.filter((n) => n.children.length === 0 || n.drillWorthy).map((n) => n.id),
      );
      const converged = plan.assignments.filter((a) => producingIds.has(a.nodeId));
      if (converged.length > 0) {
        try {
          gems = this.reexecutePlan(input.taskId, plan, converged, bundle.treeBlobRef);
        } catch (error) {
          if (error instanceof TaskWorkbenchError && error.kind === 'internal') {
            editState = 'error';
            errorText = error.message;
          } else {
            throw error; // fence 等硬失败如实上抛
          }
        }
      }
    }
    this.deps.db
      .prepare(
        'INSERT INTO mask_edit_states (task_id, node_id, state, run_count, base_version, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(task_id, node_id) DO UPDATE SET state = excluded.state, run_count = excluded.run_count, '
          + 'base_version = excluded.base_version, error = excluded.error, updated_at = excluded.updated_at',
      )
      .run(input.taskId, in_.nodeId, editState, runCount, version, errorText, new Date().toISOString());

    return {
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
      version,
      node: { bbox: newBBox, effectiveMm: node.effectiveMm },
      maskRunCount: runCount,
      incomplete: runCount > WORKBENCH_MASK_RUN_LIMIT,
      editState,
      gems,
    };
  }

  // ------------------------------------------------------- [7] view-state（视图态所有权）

  /**
   * 视图态全量快照写（view.state.set 真身）：revision 单调链+previousBlobRef 回溯
   * （内容寻址）+artifact 帧——**不入 tree_versions**（undo tree-view 域沿本链，
   * D-3 裁定）。CAS 门：expectedRevision 在场必须等于既有 revision；缺省仅当无
   * 既有工件（并发双开工作台不静默覆盖）。节点归属门（P0-2）：全部 nodeId 必须在
   * 电流树内（currentTreeBlobRef=null=尚无树——仅空表可写）；未知/已删节点=
   * view-state-invalid（视图态是当前任务图层的覆盖——幽灵节点不持久化、不换端读回）。
   */
  setViewState(input: {
    taskId: string;
    actorId: string;
    /** 帧流最新视图态工件引用（null=尚无工件）。 */
    currentViewStateBlobRef: string | null;
    /** 电流树工件引用（节点归属校验真源——RPC 面由帧流解析；null=尚无树）。 */
    currentTreeBlobRef: string | null;
  } & ViewStateSetInput): ViewStateSetOutput {
    const parsed = ViewStateSetInputSchema.safeParse({
      taskId: input.taskId,
      nodes: input.nodes,
      ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `view.state.set 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const in_ = parsed.data;
    const seen = new Set<string>();
    for (const n of in_.nodes) {
      if (seen.has(n.nodeId)) {
        throw new TaskWorkbenchError(`视图态节点重复：${n.nodeId}（全量快照语义——每节点至多一行）`, 'view-state-invalid');
      }
      seen.add(n.nodeId);
    }
    // —— 节点归属门（P0-2）：视图态=当前任务图层的覆盖，全部 nodeId 以电流树为真源
    if (input.currentTreeBlobRef === null) {
      if (in_.nodes.length > 0) {
        throw new TaskWorkbenchError(
          '尚无图层树——视图态只接受空表（nodeId 无归属真源，先产 object-tree 工件）',
          'view-state-invalid',
        );
      }
    } else {
      const tree = this.loadTree(input.currentTreeBlobRef);
      const ids = new Set(tree.nodes.map((n) => n.id));
      const ghosts = in_.nodes.filter((n) => !ids.has(n.nodeId)).map((n) => n.nodeId);
      if (ghosts.length > 0) {
        throw new TaskWorkbenchError(
          `视图态含不在当前树的节点：${ghosts.slice(0, 5).join(', ')}${ghosts.length > 5 ? '…' : ''}` +
            `（${tree.nodes.length} 节点——树工件与 UI 视图漂移，刷新后重写快照）`,
          'view-state-invalid',
        );
      }
    }
    const current = loadViewState(this.deps.blobs, input.currentViewStateBlobRef);
    if (current !== null) {
      if (in_.expectedRevision === undefined || in_.expectedRevision !== current.revision) {
        throw new TaskWorkbenchError(
          `view.state.set CAS 漂移必拒：expectedRevision=${in_.expectedRevision ?? '(缺省)'} ≠ 电流 revision=${current.revision}` +
            '（有既有工件时必须携带等值 expectedRevision——并发双开不静默覆盖）',
          'cas-mismatch',
        );
      }
    } else if (in_.expectedRevision !== undefined && in_.expectedRevision !== 0) {
      throw new TaskWorkbenchError(
        `view.state.set CAS 漂移必拒：expectedRevision=${in_.expectedRevision} 但尚无工件（首写 revision=1——缺省或 0 均合法）`,
        'cas-mismatch',
      );
    }
    const next: ViewState = ViewStateSchema.parse({
      kind: 'workbench-view-state',
      formatVersion: 1,
      nodes: in_.nodes,
      revision: (current?.revision ?? 0) + 1,
      previousBlobRef: input.currentViewStateBlobRef,
      updatedAt: new Date().toISOString(),
    });
    let put: { hash: string };
    try {
      put = putTaskArtifact(
        { db: this.deps.db, blobs: this.deps.blobs },
        input.taskId,
        Buffer.from(JSON.stringify(next), 'utf8'),
      );
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new TaskWorkbenchError(`视图态工件写入被 fence 拒绝：${error.message}`, 'fence', { cause: error });
      }
      throw error;
    }
    this.deps.jobs.emitFor(input.taskId, 'artifact', {
      blobRef: put.hash,
      name: WORKBENCH_VIEW_STATE_ARTIFACT_NAME,
    });
    return { blobRef: put.hash, revision: next.revision };
  }

  /** task 的 mask 编辑状态面（task.detail.maskEdits 组装源——node_id 升序）。 */
  maskEditStatuses(taskId: string): MaskEditStatus[] {
    return maskEditStatusesOf(this.deps.db, taskId);
  }

  // ------------------------------------------------------- internals

  /**
   * 收敛指派重算·计算段（无发布——P0-3 原子性拆分）：新 plan 落档（objectTreeRef
   * 锚新树）→execute 真身（引擎校验门照走）→plan/gems/preview 三工件 blob 落档；
   * **帧发布收集为 frames 由调用方定序**（layerDelete=发布收尾段统一 emit；失败
   * 早于任何帧=无半状态）。StrategyDesignError→typed 'internal'（调用方按语义
   * 处置：mask.patch 收敛为状态机 error 态，delete 上抛）。
   */
  private computeConvergedPlan(
    taskId: string,
    basePlan: StrategyPlan,
    assignments: StrategyAssignment[],
    treeBlobRef: string,
  ): { gems: { blobRef: string; count: number }; frames: Array<[name: string, ref: string]> } {
    const plan: StrategyPlan = StrategyPlanSchema.parse({
      kind: 'strategy-plan',
      formatVersion: 1,
      objectTreeRef: treeBlobRef,
      ...(basePlan.styleId !== undefined ? { styleId: basePlan.styleId } : {}),
      assignments,
      createdAt: new Date().toISOString(),
    });
    try {
      const executed = executeStrategyPlan(
        { db: this.deps.db, blobs: this.deps.blobs },
        {
          taskId,
          plan,
          ...(this.deps.engineLayout !== undefined ? { engineLayout: this.deps.engineLayout } : {}),
        },
      );
      const refs = executed.value as {
        planBlobRef?: unknown;
        gemsBlobRef?: unknown;
        previewBlobRef?: unknown;
        gemCount?: unknown;
      };
      const frames: Array<[name: string, ref: string]> = [];
      for (const [name, ref] of [
        [STRATEGY_PLAN_ARTIFACT_NAME, refs.planBlobRef],
        [STRATEGY_GEMS_ARTIFACT_NAME, refs.gemsBlobRef],
        [STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME, refs.previewBlobRef],
      ] as const) {
        if (typeof ref === 'string') frames.push([name, ref]);
      }
      return { gems: { blobRef: String(refs.gemsBlobRef), count: Number(refs.gemCount ?? 0) }, frames };
    } catch (error) {
      if (error instanceof StrategyDesignError) {
        throw new TaskWorkbenchError(`策略重算失败（${error.kind}）：${error.message}`, 'internal', { cause: error });
      }
      if (error instanceof ArtifactFenceError) {
        throw new TaskWorkbenchError(`策略产物写入被 fence 拒绝：${error.message}`, 'fence', { cause: error });
      }
      throw new TaskWorkbenchError(
        `策略重算失败：${error instanceof Error ? error.message : String(error)}`,
        'internal',
        { cause: error },
      );
    }
  }

  /** 收敛重算·发布段（frames 逐帧 emit——blob 已落档，此步只推进帧流指针）。 */
  private emitStrategyFrames(taskId: string, frames: Array<[name: string, ref: string]>): void {
    for (const [name, ref] of frames) {
      this.deps.jobs.emitFor(taskId, 'artifact', { blobRef: ref, name });
    }
  }

  /**
   * 收敛指派重算共用段（setNodeStrategy 收敛语义同源——mask.patch 消费：mask 与
   * 版本已入史后重算，「失败不回滚」契约不变；计算+发布一体）。删除路径改走
   * computeConvergedPlan+延迟 emit（P0-3 发布序原子化）。
   */
  private reexecutePlan(
    taskId: string,
    basePlan: StrategyPlan,
    assignments: StrategyAssignment[],
    treeBlobRef: string,
  ): { blobRef: string; count: number } {
    const computed = this.computeConvergedPlan(taskId, basePlan, assignments, treeBlobRef);
    this.emitStrategyFrames(taskId, computed.frames);
    return computed.gems;
  }

  /** mask 编辑留痕随删清理（P0-3 独立可失败步骤——发布前收口；节点已不存在，阻断门不得残留幽灵行）。 */
  private purgeMaskEditStates(taskId: string, nodeIds: string[]): void {
    if (nodeIds.length === 0) return;
    this.deps.db
      .prepare('DELETE FROM mask_edit_states WHERE task_id = ? AND node_id IN ('
        + nodeIds.map(() => '?').join(', ') + ')')
      .run(taskId, ...nodeIds);
  }

  private requireTask(taskId: string): { ownerId: string } {
    const row = this.deps.db
      .prepare('SELECT id, owner_id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string } | undefined;
    if (row === undefined) throw new TaskWorkbenchError(`任务不存在：${taskId}`, 'task-missing');
    return { ownerId: row.owner_id };
  }

  private loadTree(treeBlobRef: string): ObjectTree {
    try {
      return loadObjectTreeArtifact(this.deps.blobs, treeBlobRef);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new TaskWorkbenchError(
          `object-tree 工件不符契约：${error.issues.slice(0, 3).map((i) => i.message).join('; ')}`,
          'tree-invalid',
          { cause: error },
        );
      }
      throw new TaskWorkbenchError(
        `object-tree 工件读回失败：${error instanceof Error ? error.message : String(error)}`,
        'tree-missing',
        { cause: error },
      );
    }
  }

  private loadPlan(planBlobRef: string): StrategyPlan {
    const bytes = this.deps.blobs.read(planBlobRef);
    if (bytes === null) {
      throw new TaskWorkbenchError(
        `strategy-plan 工件不存在（blobRef=${planBlobRef.slice(0, 12)}…）`,
        'plan-missing',
      );
    }
    try {
      return StrategyPlanSchema.parse(JSON.parse(bytes.toString('utf8')));
    } catch (error) {
      throw new TaskWorkbenchError(
        `strategy-plan 工件不符契约：${error instanceof Error ? error.message : String(error)}`,
        'plan-invalid',
        { cause: error },
      );
    }
  }

  /** stoneIdx 回填（候选表投影同 design 缺省面；幻觉 idx/无尺寸依据 typed 拒）。 */
  private resolveStones(ownerId: string, stoneIdx: number[] | undefined, nodeId: string, kind: KernelStrategyKind): StonePick[] {
    if (stoneIdx === undefined || stoneIdx.length === 0) return [];
    const projection = projectStoneCandidates(
      { db: this.deps.db, blobs: this.deps.blobs },
      { ownerId },
    );
    const byIdx = new Map(projection.candidates.map((c) => [c.idx, c.pick] as const));
    const stones: StonePick[] = [];
    for (const idx of stoneIdx) {
      const pick = byIdx.get(idx);
      if (pick === undefined) {
        throw new TaskWorkbenchError(
          `节点 ${nodeId} 的 stoneIdx=${idx} 不在候选表（1..${projection.candidates.length}——共享库稳定序）`,
          'stone-invalid',
        );
      }
      stones.push(pick);
    }
    if (kind !== 'exclusion' && !stones.some((s) => s.sizeMm !== null)) {
      throw new TaskWorkbenchError(
        `节点 ${nodeId} 的 ${kind} 指派缺少尺寸依据（至少 1 款 sizeMm 非空候选钻——未声明尺寸的钻不可排钻）`,
        'stone-unsized',
      );
    }
    return stones;
  }

  private persistTree(taskId: string, imageBlobRef: string, tree: ObjectTree): {
    treeBlobRef: string;
    previewBlobRef: string;
  } {
    try {
      return persistTreeWithPreview({ db: this.deps.db, blobs: this.deps.blobs }, taskId, imageBlobRef, tree);
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new TaskWorkbenchError(`object-tree 工件写入被 fence 拒绝：${error.message}`, 'fence', { cause: error });
      }
      throw new TaskWorkbenchError(
        `object-tree 工件落档失败：${error instanceof Error ? error.message : String(error)}`,
        'internal',
        { cause: error },
      );
    }
  }

  private emitTree(taskId: string, treeBlobRef: string, previewBlobRef: string): void {
    this.deps.jobs.emitFor(taskId, 'artifact', { blobRef: treeBlobRef, name: OBJECT_TREE_ARTIFACT_NAME });
    this.deps.jobs.emitFor(taskId, 'artifact', { blobRef: previewBlobRef, name: OBJECT_TREE_PREVIEW_ARTIFACT_NAME });
  }

  /** 版本入史（fence 前置同事务：cancelled/cleared 任务拒记——MAX(version)+1 递增）。 */
  private recordTreeVersion(input: {
    taskId: string;
    actorId: string;
    cause: TreeVersion['cause'];
    detail: string;
    treeBlobRef: string;
    previewBlobRef: string;
  }): number {
    const commit = this.deps.db.transaction((): number => {
      assertTaskWritable(this.deps.db, input.taskId); // fence 拒绝抛 ArtifactFenceError → 下方收敛
      const row = this.deps.db
        .prepare('SELECT MAX(version) AS max FROM tree_versions WHERE task_id = ?')
        .get(input.taskId) as { max: number | null };
      const version = (row.max ?? 0) + 1;
      this.deps.db
        .prepare(
          'INSERT INTO tree_versions (task_id, version, tree_blob_ref, preview_blob_ref, cause, detail, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          input.taskId,
          version,
          input.treeBlobRef,
          input.previewBlobRef,
          input.cause,
          input.detail,
          input.actorId,
          new Date().toISOString(),
        );
      return version;
    });
    try {
      return commit();
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new TaskWorkbenchError(`树版本入史被 fence 拒绝：${error.message}`, 'fence', { cause: error });
      }
      throw error;
    }
  }
}
