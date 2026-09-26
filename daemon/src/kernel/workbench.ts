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
 */
import { z } from 'zod';
import {
  DEFAULT_DENSITY_PER_CM2,
  KernelStrategyKindSchema,
  LayerRenameInputSchema,
  LayerStrategySetInputSchema,
  LayerSplitInputSchema,
  StrategyPlanSchema,
  TreeHistoryOutputSchema,
  TreeRevertInputSchema,
  type KernelStrategyKind,
  type LayerRenameInput,
  type LayerRenameOutput,
  type LayerSplitInput,
  type LayerStrategySetInput,
  type LayerStrategySetOutput,
  type ObjectTree,
  type SegmentOneOutput,
  type StonePick,
  type StrategyAssignment,
  type StrategyPlan,
  type TreeHistoryOutput,
  type TreeRevertInput,
  type TreeRevertOutput,
  type TreeVersion,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import type { JobService } from '../jobs/service.js';
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
import {
  OBJECT_TREE_ARTIFACT_NAME,
  OBJECT_TREE_PREVIEW_ARTIFACT_NAME,
  segmentOne,
  SegmentOneError,
} from './vision/segment-one.js';
import { loadObjectTreeArtifact, persistTreeWithPreview } from './vision/tree-persist.js';

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
  | 'no-instance';

/** 工作台统一 typed error（沿 kernel typed error 先例——kind 判别失败面）。 */
export class TaskWorkbenchError extends Error {
  readonly kind: TaskWorkbenchErrorKind;

  constructor(message: string, kind: TaskWorkbenchErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TaskWorkbenchError';
    this.kind = kind;
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
  cause: 'segment-one' | 'rename' | 'revert';
  detail: string | null;
  actor_id: string;
  created_at: string;
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

  // ------------------------------------------------------- internals

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
