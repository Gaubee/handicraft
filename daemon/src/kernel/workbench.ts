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
 *       v5 语义（Owner 裁定 2026-09-28：组恒不产钻）：产块节点集=叶子集；对有
 *       children 的节点指派 typed 拒 node-not-leaf；父层旧指派随收敛移除（execute
 *       重算不产块——与子层钻无重叠叠排）。
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
  LayerSplitInputSchema,
  LayerStrategySetInputSchema,
  StrategyPlanSchema,
  TreeHistoryOutputSchema,
  TreeInspectNodeSchema,
  TreeMergeInputSchema,
  TreeRefineInputSchema,
  TreeRevertInputSchema,
  ViewStateSchema,
  ViewStateSetInputSchema,
  WORKBENCH_BRUSH_PAINT_BUDGET_PX,
  WORKBENCH_MASK_RUN_LIMIT,
  WORKBENCH_VIEW_STATE_ARTIFACT_NAME,
  brushWorkloadError,
  nodeProducesBlock,
  taskLayoutArtifactName,
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
  type NodeBBox,
  type ObjectNode,
  type ObjectTree,
  type SegmentOneOutput,
  type SegmentPrecision,
  type StonePick,
  type StrategyAssignment,
  type StrategyPlan,
  type TreeHistoryOutput,
  type TreeInspectOutput,
  type TreeMergeInput,
  type TreeMergeOutput,
  type TreeRefineInput,
  type TreeRefineOutput,
  type TreeRefineStep,
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
import { decodePng } from '../png/codec.js';
import {
  executeStrategyPlan,
  persistFreeCodeArtifact,
  projectStonePalette,
  STRATEGY_GEMS_ARTIFACT_NAME,
  STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME,
  STRATEGY_PLAN_ARTIFACT_NAME,
  StrategyDesignError,
  type EngineLayoutDelegate,
} from './strategies/design.js';
import {
  lintAssignments,
  putStoneLintArtifact,
  stoneLintArtifactOf,
  stoneLintResultOf,
} from './project-lint.js';
import { STRATEGY_REGISTRY } from './strategies/registry.js';
import type { SamBridge, SamRequestTuner } from './vision/sam-bridge.js';
import { cropBits, effectiveMmOf, tightBBox } from './vision/segment-loop.js';
import { labVarianceMeasurer } from './vision/segment-tool.js';
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
  | 'node-not-leaf'
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
  /**
   * 确认落地携带的试跑基线树引用 ≠ 服务端解析的当前树引用（Codex R1 P1——客户端
   * 树视图过期：试跑后 agent 在别处改过树）。typed 拒不落树；currentTreeBlobRef
   * 附电流引用（客户端刷新视图后重新试跑）。
   */
  | 'trial-stale-tree'
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
  /**
   * SAM 每请求调谐（add-image-processing-settings §5.2——kernel 装配注入，透传到
   * segmentOne 原子）：每次拆层桥请求前解析，改设置对下一次拆层立即生效。
   */
  samRequestTuner?: SamRequestTuner;
  /**
   * SAM 英文优先（Owner 定调 2026-10-03）：hint 无英文时英译送桥（segment-loop
   * 同款实例——kernel 装配单例注入，双消费面共享缓存）。
   */
  translateSubject?: (subject: string) => Promise<string | null>;
  /** 引擎 layout 委派真身（strategies 红线——kernel 接线层注入；缺席时 engineStrategy 委派节点 typed 拒）。 */
  engineLayout?: EngineLayoutDelegate;
  /**
   * DATA_ROOT（P2-4——2026-09-28 复核）：task-layout 生成链读任务 workbench-view-state.json
   * （latest-by-name 帧定位）做隐藏层过滤。缺席=不过滤（全可见——纯单测/旧装配面）。
   */
  dataRoot?: string;
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

  /**
   * 人类拆层（layer.split 真身）：segmentOne 原子直调+版本入史。
   * add-vision-pipeline-v2 T5/D6 增量：precision（D3 显式覆写）/dryRun（试跑——真跑
   * 分段+账本照记但**不落树不入史**，返回 trial 面预览载荷）/layerName（落地自定义
   * 名）。确认落地=同参再调 dryRun=false——断点账本命中掩膜直接回放，零二次桥调。
   * add-sam-playbook T2 透传（D1/D2/D3 暴露面）：instances（逐实例成层）/excludeBox
   * （排除区像素减法）/box+hint 可选（纯框选抠图）——LayerSplitInputSchema 同语义。
   */
  async segmentOneSplit(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    treeBlobRef: string;
    nodeId: string;
    hint?: string;
    box?: NodeBBox;
    excludeBox?: NodeBBox;
    instances?: 'best' | 'all';
    precision?: SegmentPrecision;
    dryRun?: boolean;
    layerName?: string;
    trialTreeBlobRef?: string;
  }): Promise<SegmentOneOutput> {
    const parsed = LayerSplitInputSchema.safeParse({
      taskId: input.taskId,
      nodeId: input.nodeId,
      ...(input.hint !== undefined ? { hint: input.hint } : {}),
      ...(input.box !== undefined ? { box: input.box } : {}),
      ...(input.excludeBox !== undefined ? { excludeBox: input.excludeBox } : {}),
      ...(input.instances !== undefined ? { instances: input.instances } : {}),
      ...(input.precision !== undefined ? { precision: input.precision } : {}),
      ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
      ...(input.layerName !== undefined ? { layerName: input.layerName } : {}),
      ...(input.trialTreeBlobRef !== undefined ? { trialTreeBlobRef: input.trialTreeBlobRef } : {}),
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `layer.split 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    // —— 试跑基线树守卫（Codex R1 P1）：确认落地（dryRun≠true）携带 trialTreeBlobRef 时
    //    与电流树引用比对——不一致=客户端树视图过期（试跑后树被别处修改），typed 拒不落树
    //    （预览所见≠将落地结果，用户主权面不允许）。试跑请求/不带字段的旧调用零变化。
    if (
      input.dryRun !== true &&
      input.trialTreeBlobRef !== undefined &&
      input.trialTreeBlobRef !== input.treeBlobRef
    ) {
      throw new TaskWorkbenchError(
        `试跑基线已过期：试跑时树 ${input.trialTreeBlobRef.slice(0, 12)}… ≠ 当前树 ${input.treeBlobRef.slice(0, 12)}…`
          + '（试跑后图层树被修改——刷新后重新试跑再确认）',
        'trial-stale-tree',
        { currentTreeBlobRef: input.treeBlobRef },
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
        {
          db: this.deps.db,
          blobs: this.deps.blobs,
          jobs: this.deps.jobs,
          bridge: this.deps.bridge,
          ...(this.deps.samRequestTuner !== undefined
            ? { samRequestTuner: this.deps.samRequestTuner }
            : {}),
          ...(this.deps.translateSubject !== undefined
            ? { translateSubject: this.deps.translateSubject }
            : {}),
          ...(this.deps.dataRoot !== undefined ? { dataRoot: this.deps.dataRoot } : {}),
        },
        {
          taskId: input.taskId,
          imageBlobRef: input.imageBlobRef,
          treeBlobRef: input.treeBlobRef,
          nodeId: input.nodeId,
          ...(input.hint !== undefined ? { hint: input.hint } : {}),
          ...(input.box !== undefined ? { box: input.box } : {}),
          ...(input.excludeBox !== undefined ? { excludeBox: input.excludeBox } : {}),
          ...(input.instances !== undefined ? { instances: input.instances } : {}),
          ...(input.precision !== undefined ? { precision: input.precision } : {}),
          ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
          ...(input.layerName !== undefined ? { layerName: input.layerName } : {}),
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
    if (input.dryRun === true) {
      return outcome; // 试跑不落树——不入版本史（树未变）
    }
    const label = outcome.children.length > 0 ? outcome.children[0]!.objectName : '零检出';
    this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'segment-one',
      detail: `拆「${label}」（${input.hint !== undefined && input.hint.trim() !== '' ? `提示：${input.hint.slice(0, 40)}` : '纯框选'}）`,
      treeBlobRef: outcome.treeBlobRef,
      previewBlobRef: outcome.previewBlobRef,
    });
    return outcome;
  }

  // ------------------------------------------------------- [2] 改名（直接生效）

  /**
   * 图层改名（layer.rename 真身）：树工件改写+重落双轨+版本入史。
   * realize-scene-understanding T2：drillWorthy 标注可选写透（Agent rename 工具
   * 消费——B2 重分类「改名挂 semantic」一步完成；缺省=不改）。
   * v6 复核 P1-1：可选 relation=显式重分类（refinement 临时节点经 VLM 重入确认后
   * 升 semantic——产钻面升级；semantic 误标可降回 refinement）。守卫：根/画布
   * （结构锚）与组节点（children 非空——组不产钻 v5 语义与 relation 正交）typed 拒。
   */
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
      ...(input.drillWorthy !== undefined ? { drillWorthy: input.drillWorthy } : {}),
      ...(input.relation !== undefined ? { relation: input.relation } : {}),
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
    const relationBefore = node.relation ?? null;
    if (input.relation !== undefined) {
      if (node.parent === null) {
        throw new TaskWorkbenchError(
          `根/画布节点 ${node.id}「${node.objectName}」不可重分类（单根树的结构锚——root-protected）`,
          'root-protected',
        );
      }
      if (node.children.length > 0) {
        throw new TaskWorkbenchError(
          `组节点「${node.objectName}」（${node.id}，${node.children.length} 子）不可重分类（组不产钻 v5 语义与 relation 正交——只叶子/细分节点可 refinement↔semantic 互转）`,
          'invalid-input',
        );
      }
    }
    node.objectName = input.objectName.trim();
    if (input.drillWorthy !== undefined) node.drillWorthy = input.drillWorthy;
    if (input.relation !== undefined) node.relation = input.relation;
    const bundle = this.persistTree(input.taskId, input.imageBlobRef, tree);
    this.emitTree(input.taskId, bundle.treeBlobRef, bundle.previewBlobRef);
    const relationNote =
      input.relation !== undefined && relationBefore !== input.relation
        ? ` · ${relationBefore ?? '未标注'}→${input.relation}`
        : '';
    const version = this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'rename',
      detail: `「${before}」→「${node.objectName}」（${node.id}）${relationNote}`,
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
    });
    return { treeBlobRef: bundle.treeBlobRef, previewBlobRef: bundle.previewBlobRef, version };
  }

  // ------------------------------------------------------- [3] 版本历史/回退

  /**
   * 版本列表（tree.history 真身——工作台写操作的快照链；升序）。
   * journey 基线播种（v3 Owner 整改根因修复）：Agent 会话产树（识图/循环/重跑经
   * segment-tool/segment-one 写帧）不入工作台版本链——journey 任务的历史面恒空
   * （「事务历史不工作」）。seed 携带帧流电流树/预览引用（RPC 面解析）：链尾
   * treeBlobRef ≠ 电流树 ⇒ 播种一行 cause='journey' 基线（seedJourneyBaseline——
   * 读尾-比较-插入同一写事务（Codex v3 复核：并发双读同 seed 只插一行）+播种前
   * tree+preview 双工件可读性校验；失败不炸读面——fence/工件损坏时跳过，仅返回
   * 既有链，未预期异常记日志不静默吞）。
   */
  treeHistory(
    taskId: string,
    seed?: { currentTreeBlobRef: string | null; currentPreviewBlobRef: string | null; actorId: string },
  ): { versions: TreeVersion[]; currentVersion: number | null } {
    if (seed !== undefined && seed.currentTreeBlobRef !== null && seed.currentPreviewBlobRef !== null) {
      try {
        // 播种前双工件可读性校验（同 revert——快照必须完整可回放才入链，不猜）
        this.loadTree(seed.currentTreeBlobRef);
        if (this.deps.blobs.read(seed.currentPreviewBlobRef) === null) {
          throw new TaskWorkbenchError(
            `journey 基线预览工件不可读（blobRef=${seed.currentPreviewBlobRef.slice(0, 12)}…）`,
            'tree-missing',
          );
        }
        this.seedJourneyBaseline({
          taskId,
          actorId: seed.actorId,
          treeBlobRef: seed.currentTreeBlobRef,
          previewBlobRef: seed.currentPreviewBlobRef,
        });
      } catch (error) {
        // 可预期失败（typed 工件/fence 面）跳过播种不炸读面；未预期异常记日志——
        // 旧形态 catch{} 吞一切会掩盖真实故障（Codex 复核）
        if (!(error instanceof TaskWorkbenchError)) {
          console.warn('[workbench] journey 基线播种未预期失败（历史面返回既有链）', error);
        }
      }
    }
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
    // 产块判定（v5 Owner 裁定：可贴钻节点恒=叶子——组/中间节点不论 drillWorthy
    // 恒拒；typed 拒 node-not-leaf，契约错误码枚举扩展）
    if (node.children.length > 0) {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId}「${node.objectName}」是组（有子图层——组不产钻，v5 语义）：拆分后只在子图层指派`,
        'node-not-leaf',
      );
    }

    // —— params 逐项校验（registry paramsSchema——合法性校验真源，与 strategy.design 同门）
    const kindCheck = KernelStrategyKindSchema.safeParse(in_.strategyKind);
    if (!kindCheck.success) {
      throw new TaskWorkbenchError(`strategyKind 不在八值枚举：${in_.strategyKind}`, 'params-invalid');
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
    const previousAssignment =
      input.planBlobRef !== null
        ? this.loadPlan(input.planBlobRef).assignments.find((a) => a.nodeId === in_.nodeId)
        : undefined;
    const inherited =
      stones.length === 0 && (in_.stoneIdx === undefined || in_.stoneIdx.length === 0) && previousAssignment !== undefined
        ? previousAssignment.stones
        : [];
    if (stones.length === 0 && inherited.length > 0) stones = inherited;
    const codeArtifactRef = kind === 'free-code' ? persistFreeCodeArtifact(this.deps.blobs, { params: in_.params }) : undefined;
    if (kind !== 'free-code' && stones.length === 0 && kind !== 'exclusion') {
      throw new TaskWorkbenchError(
        `节点 ${in_.nodeId} 的 ${kind} 指派缺少 stoneIdx（至少 1 款候选钻——exclusion 可省略；无既有指派可继承）`,
        'stone-invalid',
      );
    }
    // —— gapFill 透传保留（T2.5——先例=上方 stoneIdx 继承）：直改重建指派是白名单构造，
    //    不透传则用户微调一次密度 gapFill 无声消失。守卫：仅产钻策略（exclusion/
    //    free-code 组合 contracts superRefine 必拒）且补隙钻仍在最终 stones 集内
    //    （stoneIdx 显式重选不含补隙款=用户意图变更，随 stones 消失一并放弃）。
    const inheritedGapFill =
      previousAssignment?.gapFill !== undefined
      && kind !== 'exclusion'
      && kind !== 'free-code'
      && stones.some((pick) => pick.resourceId === previousAssignment.gapFill!.stoneRef)
        ? previousAssignment.gapFill
        : undefined;
    const replacement: StrategyAssignment = {
      nodeId: in_.nodeId,
      strategyKind: kind,
      params: in_.params,
      stones,
      densityPerCm2: in_.densityPerCm2 ?? DEFAULT_DENSITY_PER_CM2,
      ...(inheritedGapFill !== undefined ? { gapFill: inheritedGapFill } : {}),
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

    // —— 当前 plan 读回+指派替换（收敛到当前树产块节点集=叶子集——树漂移/父层旧
    //    指派处置见头注 [4]；v5：父层（组）旧指派随收敛移除=重算不再产块；判定
    //    单源=contracts nodeProducesBlock）
    const producingIds = new Set(tree.nodes.filter(nodeProducesBlock).map((n) => n.id));
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
        // dataRoot：task-layout 读 workbench-view-state.json（P2-4 隐藏层过滤）。
        { db: this.deps.db, blobs: this.deps.blobs, ...(this.deps.dataRoot !== undefined ? { dataRoot: this.deps.dataRoot } : {}) },
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
        taskLayoutBlobRef?: unknown;
        taskLayoutImageId?: unknown;
      };
      for (const [name, ref] of [
        [STRATEGY_PLAN_ARTIFACT_NAME, refs.planBlobRef],
        [STRATEGY_GEMS_ARTIFACT_NAME, refs.gemsBlobRef],
        [STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME, refs.previewBlobRef],
      ] as const) {
        if (typeof ref === 'string') this.deps.jobs.emitFor(input.taskId, 'artifact', { blobRef: ref, name });
      }
      // task-layout 帧（4.1——直改同真源链：装配成功时按 imageId 组名）。
      if (typeof refs.taskLayoutBlobRef === 'string' && typeof refs.taskLayoutImageId === 'string') {
        this.deps.jobs.emitFor(input.taskId, 'artifact', {
          blobRef: refs.taskLayoutBlobRef,
          name: taskLayoutArtifactName(refs.taskLayoutImageId),
        });
      }
      // —— lint 成功结果内嵌+stones-lint.json 工件（A3 接线③——add-task-stones-
      //    manifest-export W3 3.1：直改产新 plan 即重算；无 session-project 行
      //    （无项目语义）/计算异常=lint null——派生面不放大，直改不因 lint 失败。
      let lint: LayerStrategySetOutput['lint'] = null;
      if (task.sessionId !== null && typeof refs.planBlobRef === 'string') {
        try {
          const computation = lintAssignments(
            { db: this.deps.db, blobs: this.deps.blobs },
            { sessionId: task.sessionId, assignments: plan.assignments },
          );
          if (computation !== null) {
            putStoneLintArtifact(
              { db: this.deps.db, blobs: this.deps.blobs, jobs: this.deps.jobs },
              {
                taskId: input.taskId,
                lint: stoneLintArtifactOf(computation, {
                  sourceTaskId: input.taskId,
                  planRef: refs.planBlobRef,
                }),
              },
            );
            lint = stoneLintResultOf(computation);
          }
        } catch {
          lint = null;
        }
      }
      return {
        gems: { blobRef: String(refs.gemsBlobRef), count: Number(refs.gemCount ?? 0) },
        preview: { blobRef: String(refs.previewBlobRef) },
        lint,
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

    // —— 笔迹资源上限（Codex 2bfix/2c 合并复评建议二）：坐标 0..imagePx 界内+段长
    // 上限+单笔插值步数上限——三侧同源纯函数判定，超限 typed 拒 mask-invalid（极值
    // 坐标不再进入无界扫掠循环；涂写工作量预算在下方光栅循环内累计判定）。
    const workloadError = brushWorkloadError(in_.ops, tree.imagePx);
    if (workloadError !== null) {
      throw new TaskWorkbenchError(`笔迹工作量超限：${workloadError}`, 'mask-invalid');
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
    // 涂写工作量预算（Codex 复评建议二 [4]）：每次 stamp 在 mask 界内覆盖的像素数
    // 累计——超预算 typed 拒（大半径×长笔画的有界工作量面；预算常量与契约同源）。
    let paintedPx = 0;
    for (const stroke of in_.ops) {
      const value = stroke.op === 'add' ? 1 : 0;
      // 圆盘沿折线扫掠（契约语义——Codex 2b 复核 P1-2）：相邻采样点线段插值，
      // 步长≤半径/2——pointer 事件间距大于直径时不断笔；单点笔画退化为单圆盘。
      const r = stroke.radiusPx;
      const stepLen = Math.max(r / 2, 0.5);
      const stamp = (gx: number, gy: number): void => {
        const cx = gx - bbox.x;
        const cy = gy - bbox.y;
        const x0 = Math.max(0, Math.floor(cx - r));
        const x1 = Math.min(w - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r));
        const y1 = Math.min(h - 1, Math.ceil(cy + r));
        if (x1 < x0 || y1 < y0) return; // 圆盘完全在 mask 界外——零工作量
        paintedPx += (x1 - x0 + 1) * (y1 - y0 + 1);
        if (paintedPx > WORKBENCH_BRUSH_PAINT_BUDGET_PX) {
          throw new TaskWorkbenchError(
            `笔迹涂写工作量超预算 ${WORKBENCH_BRUSH_PAINT_BUDGET_PX}px（大半径×长笔画——分多次提交）`,
            'mask-invalid',
          );
        }
        const rr = r * r;
        for (let yy = y0; yy <= y1; yy++) {
          for (let xx = x0; xx <= x1; xx++) {
            const dx = xx + 0.5 - cx;
            const dy = yy + 0.5 - cy;
            if (dx * dx + dy * dy <= rr) bits[yy * w + xx] = value;
          }
        }
      };
      let prev: { x: number; y: number } | null = null;
      for (const p of stroke.points) {
        if (prev !== null) {
          const dist = Math.hypot(p.x - prev.x, p.y - prev.y);
          const steps = Math.max(1, Math.ceil(dist / stepLen));
          for (let k = 1; k <= steps; k++) {
            stamp(prev.x + ((p.x - prev.x) * k) / steps, prev.y + ((p.y - prev.y) * k) / steps);
          }
        } else {
          stamp(p.x, p.y);
        }
        prev = p;
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

    // —— 编辑状态机运行路径（Codex 2b 复核 P0-2 + 2d 复评阻塞项闭合）：重算面异步化
    // ——同步段只写 accepted（CAS 过门+光栅化+版本入史后响应即返，重算不阻塞调用方）；
    // 行的 base_version=本次落定版本（**作业代次 token**——同节点 A/B 连续 patch 时
    // B 的 upsert 覆盖行使 A 的在途作业带 vA 条件的全部 UPDATE 落空=作废，B 自己的
    // 作业执行——新编辑不被旧作业收敛/不错配）；微任务作业置 recomputing→
    // reexecutePlan→终态条件更新（recomputing→ready/error——竞态中树被推进为 stale
    // 时不覆盖）。无重算面（recomputeStrategy 缺省/false 或无 plan）同步直达 ready
    // （纯 mask 面——spec 同步闭环语义保持）。
    const asyncRecompute = in_.recomputeStrategy === true && input.planBlobRef !== null;
    const editState: MaskEditState = asyncRecompute ? 'accepted' : 'ready';
    const errorText: string | null = null;
    const gems: LayerMaskPatchOutput['gems'] = null; // 重算产物经帧流后置发布（作业完成即 task.detail 可读）
    this.deps.db
      .prepare(
        'INSERT INTO mask_edit_states (task_id, node_id, state, run_count, base_version, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) '
          + 'ON CONFLICT(task_id, node_id) DO UPDATE SET state = excluded.state, run_count = excluded.run_count, '
          + 'base_version = excluded.base_version, error = excluded.error, updated_at = excluded.updated_at',
      )
      .run(input.taskId, in_.nodeId, editState, runCount, version, errorText, new Date().toISOString());
    if (asyncRecompute) {
      this.enqueueMaskRecompute({
        taskId: input.taskId,
        nodeId: in_.nodeId,
        planBlobRef: input.planBlobRef!,
        treeBlobRef: bundle.treeBlobRef,
        baseVersion: version, // 作业代次 token（同节点后继 patch 覆盖行时本作业必作废）
      });
    }

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

  // ------------------------------------------------------- [3.5] mask 重算作业（状态机运行路径）

  /** 在途异步重算作业（flushMaskRecomputeJobs 等待面——测试钩子/优雅停机）。 */
  private maskRecomputeJobs: Array<Promise<void>> = [];

  /**
   * 异步重算作业（两级微任务——微任务边界=过渡态可观测点）：
   * 第一级置 recomputing（条件：行仍 accepted **且 base_version=本作业代次**——
   * Codex 2d 复评阻塞项 P0-2：同节点 A/B 连续 patch 共享 (task_id,node_id) 单行，
   * 无代次条件时 A 旧作业会把 B 的 accepted 行推进收敛、B 自己的作业反被跳过——
   * 新编辑被旧作业结果错配）；第二级执行前复核代次（行被覆盖/置 stale/删除即作废
   * ——不执行旧基线树上的重算副作用）+reexecutePlan+终态条件更新。
   * 响应在两级之前已返回（patch 同步段）。
   */
  private enqueueMaskRecompute(job: {
    taskId: string;
    nodeId: string;
    planBlobRef: string;
    treeBlobRef: string;
    /** 作业代次（=本 patch 落定的 tree 版本号——版本单调，天然代次 token）。 */
    baseVersion: number;
  }): void {
    const done = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        const advanced = this.deps.db
          .prepare(
            "UPDATE mask_edit_states SET state = 'recomputing', updated_at = ? WHERE task_id = ? AND node_id = ? AND state = 'accepted' AND base_version = ?",
          )
          .run(new Date().toISOString(), job.taskId, job.nodeId, job.baseVersion);
        if (advanced.changes === 0) {
          resolve(); // 行已非本代次 accepted（同节点新 patch 覆盖/树推进 stale/已删）——作业作废
          return;
        }
        queueMicrotask(() => {
          try {
            // 执行前代次复核：第一级与第二级之间同节点新 patch 落地（upsert 覆盖行）
            // 时不得在旧基线树上执行重算副作用（旧 plan×旧树的结果不得发布）。
            const row = this.deps.db
              .prepare('SELECT state, base_version FROM mask_edit_states WHERE task_id = ? AND node_id = ?')
              .get(job.taskId, job.nodeId) as { state: MaskEditState; base_version: number } | undefined;
            if (row === undefined || row.state !== 'recomputing' || row.base_version !== job.baseVersion) {
              resolve();
              return;
            }
            this.runMaskRecompute(job);
          } finally {
            resolve();
          }
        });
      });
    });
    this.maskRecomputeJobs.push(done);
  }

  /**
   * 重算执行体（同步）：基于作业基线树+plan 收敛重算，终态条件更新（仅
   * recomputing 态**且本作业代次**推进——树推进竞态置 stale/同节点新 patch 覆盖行后
   * 不覆盖）。异步路径无调用方可抛：一切重算失败（含 fence 等）如实落 error 态留痕
   * （可重试——retryMaskEditRecompute）。
   */
  private runMaskRecompute(job: {
    taskId: string;
    nodeId: string;
    planBlobRef: string;
    treeBlobRef: string;
    /** 作业代次 token（retry 路径=入口行现值；异步作业路径=patch 落定版本）。 */
    baseVersion: number;
  }): void {
    let errorText: string | null = null;
    try {
      const plan = this.loadPlan(job.planBlobRef);
      const tree = this.loadTree(job.treeBlobRef);
      // v5：产块节点集=叶子集（父层旧指派随收敛跳过——组不产钻；判定单源=
      // contracts nodeProducesBlock）
      const producingIds = new Set(
        tree.nodes.filter(nodeProducesBlock).map((n) => n.id),
      );
      const converged = plan.assignments.filter((a) => producingIds.has(a.nodeId));
      if (converged.length > 0) {
        this.reexecutePlan(job.taskId, plan, converged, job.treeBlobRef);
      }
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error);
    }
    this.deps.db
      .prepare(
        "UPDATE mask_edit_states SET state = ?, error = ?, updated_at = ? WHERE task_id = ? AND node_id = ? AND state = 'recomputing' AND base_version = ?",
      )
      .run(errorText === null ? 'ready' : 'error', errorText, new Date().toISOString(), job.taskId, job.nodeId, job.baseVersion);
  }

  /** 等待在途重算作业收敛（两级微任务链全部完成；排程中再入队者也一并等待）。 */
  async flushMaskRecomputeJobs(): Promise<void> {
    while (this.maskRecomputeJobs.length > 0) {
      const pending = this.maskRecomputeJobs.splice(0);
      await Promise.all(pending);
    }
  }

  /**
   * stale/error 清除·重放入口（spec「直到重放重算或确认放弃」——终评 P0-1 产品面）：
   * 基于电流树+正确 plan 同步重放收敛重算 → ready/error。行须为 stale/error（其余态
   * 语义拒——ready 无需重放、accepted/recomputing 在途作业自会收敛）。
   *
   * CAS/竞态（终评 P1-1）：入参 expectedBaseVersion=调用方现读的留痕 baseVersion，
   * 漂移必拒 cas-mismatch（行已被同节点新 patch 接管——旧留痕的重放不得错配新编辑）；
   * 条件 UPDATE（state+base_version 双条件）落空（changes≠1——SELECT 后行被覆盖）
   * 时**重读行现值直接返回，不执行 runMaskRecompute**（不基于过期基线树发布工件
   * ——零行 CAS 阻副作用）。planBlobRef=null（无存量 plan）typed 拒 plan-missing
   * （重算面缺席——重放无意义）。
   */
  retryMaskEditRecompute(input: {
    taskId: string;
    nodeId: string;
    imageBlobRef: string;
    currentTreeBlobRef: string;
    planBlobRef: string | null;
    /** CAS 基线（调用方现读的留痕 baseVersion——漂移必拒）。 */
    expectedBaseVersion: number;
  }): { edit: MaskEditStatus } {
    if (input.planBlobRef === null) {
      throw new TaskWorkbenchError(
        `节点 ${input.nodeId} 的重算重放需要存量 strategy-plan 工件（planBlobRef=null——重算面缺席）`,
        'plan-missing',
      );
    }
    const row = this.deps.db
      .prepare('SELECT state, base_version FROM mask_edit_states WHERE task_id = ? AND node_id = ?')
      .get(input.taskId, input.nodeId) as { state: MaskEditState; base_version: number } | undefined;
    if (row === undefined) {
      throw new TaskWorkbenchError(
        `节点 ${input.nodeId} 无编辑留痕（重算入口仅面向 stale/error 留痕）`,
        'node-not-found',
      );
    }
    if (row.base_version !== input.expectedBaseVersion) {
      throw new TaskWorkbenchError(
        `节点 ${input.nodeId} 编辑留痕 base_version 已漂移（期望 ${input.expectedBaseVersion}，电流 ${row.base_version}——同节点新编辑已接管，刷新后以新留痕重入）`,
        'cas-mismatch',
      );
    }
    if (row.state !== 'stale' && row.state !== 'error') {
      throw new TaskWorkbenchError(
        `节点 ${input.nodeId} 编辑留痕为 ${row.state}（重算重放仅面向 stale/error）`,
        'invalid-input',
      );
    }
    // 代次条件推进（P0-2）：retry 以行现 base_version 为 token——与在途异步作业/
    // 同节点新 patch 的交错中，行态被覆盖时本 UPDATE 落空（终态以其后读取为准）。
    const advanced = this.deps.db
      .prepare(
        "UPDATE mask_edit_states SET state = 'recomputing', error = NULL, updated_at = ? WHERE task_id = ? AND node_id = ? AND state IN ('stale', 'error') AND base_version = ?",
      )
      .run(new Date().toISOString(), input.taskId, input.nodeId, row.base_version);
    if (advanced.changes !== 1) {
      // 零行 CAS（终评 P1-1）：SELECT 与 UPDATE 之间行被同节点新 patch 覆盖（或再次
      // stale 化）——不得基于旧基线树执行重算副作用；重读行现值如实返回（调用方以
      // 行现值呈现，UI 刷新后按新留痕重入）。
      return { edit: this.maskEditStatusOf(input.taskId, input.nodeId) };
    }
    this.runMaskRecompute({
      taskId: input.taskId,
      nodeId: input.nodeId,
      planBlobRef: input.planBlobRef,
      treeBlobRef: input.currentTreeBlobRef,
      baseVersion: row.base_version,
    });
    return { edit: this.maskEditStatusOf(input.taskId, input.nodeId) };
  }

  /** 单节点编辑留痕现值（task 级面过滤——行缺席=node-not-found；调用方已证在场）。 */
  private maskEditStatusOf(taskId: string, nodeId: string): MaskEditStatus {
    const row = maskEditStatusesOf(this.deps.db, taskId).find((r) => r.nodeId === nodeId)
    if (row === undefined) {
      throw new TaskWorkbenchError(`节点 ${nodeId} 无编辑留痕（行已被删除）`, 'node-not-found');
    }
    return row;
  }

  /**
   * 放弃清除入口（终评 P0-1 产品面）：删编辑留痕行（mask 已落盘如实不回滚——仅清
   * 告警/门阻断面；用户显式接受当前 mask/gems 现状）。仅面向**阻断留痕**（stale/
   * error/incomplete——门阻三因子；限内 ready 留痕无阻断面可弃）。CAS：行现
   * baseVersion ≠ 期望必拒 cas-mismatch（不误弃新编辑留痕）；行已不在=幂等成功
   * （discarded=false）。
   */
  discardMaskEdit(input: { taskId: string; nodeId: string; expectedBaseVersion: number }): { discarded: boolean } {
    const row = this.deps.db
      .prepare('SELECT state, run_count, base_version FROM mask_edit_states WHERE task_id = ? AND node_id = ?')
      .get(input.taskId, input.nodeId) as
      | { state: MaskEditState; run_count: number; base_version: number }
      | undefined;
    if (row === undefined) return { discarded: false };
    if (row.base_version !== input.expectedBaseVersion) {
      throw new TaskWorkbenchError(
        `节点 ${input.nodeId} 编辑留痕 base_version 已漂移（期望 ${input.expectedBaseVersion}，电流 ${row.base_version}——同节点新编辑已接管，刷新后以新留痕重入）`,
        'cas-mismatch',
      );
    }
    const blocking = row.state === 'stale' || row.state === 'error' || row.run_count > WORKBENCH_MASK_RUN_LIMIT;
    if (!blocking) {
      throw new TaskWorkbenchError(
        `节点 ${input.nodeId} 编辑留痕为 ${row.state}（行程 ${row.run_count} 限内）——无阻断面可放弃（放弃仅面向 stale/error/incomplete 留痕）`,
        'invalid-input',
      );
    }
    const deleted = this.deps.db
      .prepare('DELETE FROM mask_edit_states WHERE task_id = ? AND node_id = ? AND base_version = ?')
      .run(input.taskId, input.nodeId, input.expectedBaseVersion);
    // 零行=SELECT 与 DELETE 间新 patch 已接管（行代次推进）——不误删新行，幂等返回
    // discarded:false（Codex 末轮 P1：响应不得谎称本次已删除）
    return { discarded: deleted.changes === 1 };
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
      ...(input.previewMode !== undefined ? { previewMode: input.previewMode } : {}),
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
      // previewMode：显式携带=写透；缺省=保留服务端现值（纯节点面写不冲刷模式）
      ...(in_.previewMode !== undefined || current?.previewMode !== undefined
        ? { previewMode: in_.previewMode ?? current?.previewMode }
        : {}),
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

  // ------------------------------------------------------- [9] Agent 树组装面（realize-scene-understanding T2）

  /**
   * 停止判据提示（design §0 四条——inspect 结果面随行，Agent 自评停止条件的常量面）。
   */
  private static readonly STOP_CRITERIA_HINT =
    '停止判据四条（拆分可停的判定面）：1) effectiveMm≈钻径量级（~5mm×5mm——钻 2-5mm）；'
    + '2) labVariance 色容差已低（大范围同色）；3) SAM 自认不可拆（refine 零新实例）；'
    + '4) 迭代硬顶。全部满足或用户口头确认即停止组装，转 studio.strategy.design。';

  /**
   * 树读面（studio.tree.inspect 真身——design §2）：树结构+mask 引用+停止判据数据
   * （effectiveMm/labVariance）+origin+relation。节点序=工件序（DFS 先序）。
   * treeBlobRef 解析（显式/帧流电流树）归调用方——本面只读给定树。
   */
  treeInspect(input: { taskId: string; treeBlobRef: string }): TreeInspectOutput {
    const tree = this.loadTree(input.treeBlobRef);
    const nodes: TreeInspectOutput['nodes'] = tree.nodes.map((node) => {
      const resolved = resolveMaskBits(this.deps.blobs, node.mask);
      const inspectNode = {
        id: node.id,
        objectName: node.objectName,
        category: node.category,
        parent: node.parent,
        children: node.children,
        relation: node.relation ?? null,
        origin: node.origin,
        effectiveMm: node.effectiveMm,
        labVariance: node.labVariance,
        drillWorthy: node.drillWorthy,
        bbox: node.bbox,
        mask:
          node.mask.kind === 'blob'
            ? { kind: 'blob' as const, blobRef: node.mask.blobRef }
            : { kind: 'inline' as const, w: resolved.w, h: resolved.h },
      };
      return TreeInspectNodeSchema.parse(inspectNode); // 结构自证（逐节点）
    });
    const currentVersion = this.deps.db
      .prepare('SELECT MAX(version) AS max FROM tree_versions WHERE task_id = ?')
      .get(input.taskId) as { max: number | null };
    return {
      treeBlobRef: input.treeBlobRef,
      nodes,
      currentVersion: currentVersion.max ?? null,
      stopCriteriaHint: TaskWorkbench.STOP_CRITERIA_HINT,
    };
  }

  /** 节点 mask → 全图 bits（merge 并集运算的展开面——维度≠bbox=工件不变式破坏）。 */
  private canvasBitsOfNode(node: ObjectNode, imagePx: { width: number; height: number }): Uint8Array {
    const resolved = resolveMaskBits(this.deps.blobs, node.mask);
    if (resolved.w !== node.bbox.w || resolved.h !== node.bbox.h) {
      throw new TaskWorkbenchError(
        `节点 mask 维度 ${resolved.w}×${resolved.h} ≠ bbox ${node.bbox.w}×${node.bbox.h}（${node.id}）——工件不变式破坏，不猜测修复`,
        'tree-invalid',
      );
    }
    const canvas = new Uint8Array(imagePx.width * imagePx.height);
    for (let y = 0; y < resolved.h; y++) {
      for (let x = 0; x < resolved.w; x++) {
        if (resolved.bits[y * resolved.w + x] === 1) {
          canvas[(node.bbox.y + y) * imagePx.width + (node.bbox.x + x)] = 1;
        }
      }
    }
    return canvas;
  }

  /**
   * 合并节点（studio.tree.merge 真身——design §2「子→父吸收」）：sources 的 mask
   * 并入 target（并集+tightBBox 重锚）、children 移交 target、sources 出树。判据
   * 数据重算（effectiveMm 外接矩形换算；labVariance 按原图并集区重测——掩码几何
   * 变更后旧值不再代表新区域）。指派收敛（layerDelete 同语义）：被吸收节点的旧
   * 指派移除；target 吸收 children 后变组=组不产钻（v5），target 旧指派一并收敛。
   */
  treeMerge(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    currentTreeBlobRef: string;
    /** 当前生效 plan 工件（null=无 plan——无指派可收敛）。 */
    planBlobRef: string | null;
  } & TreeMergeInput): TreeMergeOutput {
    const parsed = TreeMergeInputSchema.safeParse({
      taskId: input.taskId,
      expectedTreeBlobRef: input.expectedTreeBlobRef,
      targetNodeId: input.targetNodeId,
      sourceNodeIds: input.sourceNodeIds,
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `tree.merge 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const in_ = parsed.data;
    this.assertTreeCas('tree.merge', in_.expectedTreeBlobRef, input.currentTreeBlobRef);
    const tree = this.loadTree(input.currentTreeBlobRef);
    const byId = new Map(tree.nodes.map((n) => [n.id, n] as const));
    const target = byId.get(in_.targetNodeId);
    if (target === undefined) {
      throw new TaskWorkbenchError(`合并目标 ${in_.targetNodeId} 不在当前树（${tree.nodes.length} 节点）`, 'node-not-found');
    }
    if (new Set(in_.sourceNodeIds).size !== in_.sourceNodeIds.length) {
      throw new TaskWorkbenchError(`sourceNodeIds 重复（合并语义——每节点至多吸收一次）`, 'invalid-input');
    }
    if (in_.sourceNodeIds.includes(in_.targetNodeId)) {
      throw new TaskWorkbenchError(`合并目标 ${in_.targetNodeId} 不得同时是吸收源（target ∈ sourceNodeIds）`, 'invalid-input');
    }
    // 子树包含校验：target 在某 source 子树内=吸收方向倒置成环，必拒
    const subtreeOf = (rootId: string): Set<string> => {
      const out = new Set<string>([rootId]);
      const visit = (id: string): void => {
        for (const c of byId.get(id)?.children ?? []) {
          if (!out.has(c)) {
            out.add(c);
            visit(c);
          }
        }
      };
      visit(rootId);
      return out;
    };
    const sources: ObjectNode[] = [];
    for (const sourceId of in_.sourceNodeIds) {
      const source = byId.get(sourceId);
      if (source === undefined) {
        throw new TaskWorkbenchError(`吸收源 ${sourceId} 不在当前树（${tree.nodes.length} 节点）`, 'node-not-found');
      }
      if (source.parent === null) {
        throw new TaskWorkbenchError(
          `根/画布节点 ${sourceId}「${source.objectName}」不可被合并（单根树的结构锚——root-protected）`,
          'root-protected',
        );
      }
      if (subtreeOf(sourceId).has(in_.targetNodeId)) {
        throw new TaskWorkbenchError(
          `合并目标 ${in_.targetNodeId} 在吸收源 ${sourceId} 的子树内（吸收方向倒置成环必拒）`,
          'cycle',
        );
      }
      sources.push(source);
    }
    // 嵌套 source 拒（v6 复核 P2）：sourceNodeIds 同含祖先-后代对时吸收边界含糊
    //（外层吸收的 mask 并集已覆盖内层——最终吸收面不可判定），语义冻结为显式
    // typed 拒：Agent 需先拆解意图，按叶子粒度显式列出吸收源。
    for (const source of sources) {
      const subtree = subtreeOf(source.id);
      for (const other of sources) {
        if (other !== source && subtree.has(other.id)) {
          throw new TaskWorkbenchError(
            `sourceNodeIds 嵌套（${source.id}「${source.objectName}」的子树含 ${other.id}「${other.objectName}」——吸收边界含糊必拒；请按叶子粒度显式列出吸收源）`,
            'invalid-input',
          );
        }
      }
    }

    // —— mask 并集（全图坐标系）→ tightBBox 重锚 → 局部 bits
    const union = this.canvasBitsOfNode(target, tree.imagePx);
    for (const source of sources) {
      const sourceCanvas = this.canvasBitsOfNode(source, tree.imagePx);
      for (let i = 0; i < union.length; i++) union[i] = union[i]! | sourceCanvas[i]!;
    }
    const bbox = tightBBox(union, tree.imagePx.width, tree.imagePx.height);
    if (bbox === null) {
      throw new TaskWorkbenchError(`合并后掩码为空（${in_.targetNodeId}——不变式破坏）`, 'tree-invalid');
    }
    const localBits = cropBits(union, bbox, tree.imagePx.width);
    const ppm = derivePixelsPerMm({ canvasCm: tree.canvasCm, imagePx: tree.imagePx });
    if (!ppm.ok) {
      throw new TaskWorkbenchError(
        `树工件 canvasCm/imagePx 纵横比漂移（cm ${ppm.aspectCm} vs px ${ppm.aspectPx}）——尺寸声明漂移必拒`,
        'tree-invalid',
      );
    }
    // labVariance 按原图并集区重测（掩码几何变更后旧值不再代表新区域——真源重算不发明）
    const imageBytes = this.deps.blobs.read(input.imageBlobRef);
    if (imageBytes === null) {
      throw new TaskWorkbenchError(
        `原图 blob 不存在（blobRef=${input.imageBlobRef.slice(0, 12)}…）——labVariance 重测需要原图`,
        'task-missing',
      );
    }
    let decoded: { width: number; height: number; rgba: Uint8Array };
    try {
      decoded = decodePng(imageBytes);
    } catch (error) {
      throw new TaskWorkbenchError(
        `原图解码失败（仅支持 PNG——S0 归一面）：${error instanceof Error ? error.message : String(error)}`,
        'tree-invalid',
        { cause: error },
      );
    }
    if (decoded.width !== tree.imagePx.width || decoded.height !== tree.imagePx.height) {
      throw new TaskWorkbenchError(
        `原图尺寸 ${decoded.width}×${decoded.height} ≠ 树锚点 ${tree.imagePx.width}×${tree.imagePx.height}——bbox 锚点错位`,
        'tree-invalid',
      );
    }
    const labVariance = labVarianceMeasurer(decoded)({ bbox, bits: localBits });

    // —— 结构变换：children 移交+sources 出树
    for (const source of sources) {
      const sourceParent = byId.get(source.parent!);
      if (sourceParent !== undefined) {
        sourceParent.children = sourceParent.children.filter((id) => id !== source.id);
      }
      for (const childId of source.children) {
        const child = byId.get(childId);
        if (child !== undefined) {
          child.parent = target.id;
          target.children.push(childId);
        }
      }
      source.children = [];
    }
    const removedSet = new Set(sources.map((s) => s.id));
    tree.nodes = tree.nodes.filter((n) => !removedSet.has(n.id));
    target.mask = encodeInlineMask(bbox.w, bbox.h, localBits); // 持久化阈值转换由 persistTree 承担
    target.bbox = bbox;
    target.effectiveMm = effectiveMmOf(bbox, ppm.pixelsPerMm);
    target.labVariance = labVariance;

    // —— ② 新树落档（blob 不发布——内容寻址，失败零副作用）
    const bundle = this.persistTree(input.taskId, input.imageBlobRef, tree);

    // —— ③ 指派收敛·计算段（v5：target 吸收 children 变组=组不产钻，旧指派失效）
    const demotedNodeIds = target.children.length > 0 ? [target.id] : [];
    let gems: NonNullable<TreeMergeOutput['gems']> | undefined;
    let strategyFrames: Array<[name: string, ref: string]> = [];
    if (input.planBlobRef !== null) {
      const plan = this.loadPlan(input.planBlobRef);
      const convergedIds = new Set<string>([...removedSet, ...demotedNodeIds]);
      const remaining = plan.assignments.filter((a) => !convergedIds.has(a.nodeId));
      if (convergedIds.size > 0 && remaining.length > 0) {
        const computed = this.computeConvergedPlan(input.taskId, plan, remaining, bundle.treeBlobRef);
        gems = computed.gems;
        strategyFrames = computed.frames;
      }
      // remaining=空 → 空收敛：不落新 plan（StrategyPlan min(1) 边界——layerDelete 同裁定）
    }
    // —— ④ 版本入史
    const version = this.recordTreeVersion({
      taskId: input.taskId,
      actorId: input.actorId,
      cause: 'tree-merge',
      detail: `合并 ${sources.length} 节点入「${target.objectName}」（${sources.map((s) => s.objectName).join('、')}）`,
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
    });
    // —— ⑤ 发布段（树指针+（若有）plan/gems/preview 帧一次性收尾）
    this.emitTree(input.taskId, bundle.treeBlobRef, bundle.previewBlobRef);
    this.emitStrategyFrames(input.taskId, strategyFrames);
    return {
      treeBlobRef: bundle.treeBlobRef,
      previewBlobRef: bundle.previewBlobRef,
      version,
      removedNodeIds: [...removedSet],
      demotedNodeIds,
      ...(gems !== undefined ? { gems } : {}),
    };
  }

  /**
   * 再拆分（studio.tree.refine 真身——design §2「限定节点 mask 区域内调 SAM 多提示」）：
   * 逐步链式 segmentOne（每步=新树+版本入史 cause='tree-refine'；子节点
   * origin/relation=refinement——B2 临时细分节点，经 rename/reparent 重分类后升
   * semantic）。首步 CAS 过门；后续步在自身产出的树上链式推进（调用方独占写窗）。
   * add-sam-playbook T2.5 步进化：steps 模式每步独立构造 SegmentOneInput（hint/
   * box/excludeBox/instances 透传——修泄漏排除步/逐实例步/纯框步可混合；纯框步走
   * T2「框选区域」命名链、版本 detail 记 box[x,y,w,h] 语义串）；旧 hints 模式=
   * 逐步纯 hint 步（零变化）。版本链/CAS 语义照旧。
   */
  async treeRefine(input: {
    taskId: string;
    actorId: string;
    imageBlobRef: string;
    currentTreeBlobRef: string;
  } & TreeRefineInput): Promise<TreeRefineOutput> {
    const parsed = TreeRefineInputSchema.safeParse({
      taskId: input.taskId,
      expectedTreeBlobRef: input.expectedTreeBlobRef,
      nodeId: input.nodeId,
      ...(input.hints !== undefined ? { hints: input.hints } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
    });
    if (!parsed.success) {
      throw new TaskWorkbenchError(
        `tree.refine 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const in_ = parsed.data;
    if (this.deps.bridge === undefined) {
      throw new TaskWorkbenchError(
        'SAM 桥未装配（env SAM_SSH_HOST+SAM_SSH_REMOTE_COMMAND 或 SAM_BRIDGE_MOCK=1）——refine 不可用（无降级面：refine 语义=SAM 细分）',
        'bridge-unavailable',
      );
    }
    this.assertTreeCas('tree.refine', in_.expectedTreeBlobRef, input.currentTreeBlobRef);
    const baseTree = this.loadTree(input.currentTreeBlobRef);
    const target = baseTree.nodes.find((n) => n.id === in_.nodeId);
    if (target === undefined) {
      throw new TaskWorkbenchError(`再拆分目标 ${in_.nodeId} 不在当前树（${baseTree.nodes.length} 节点）`, 'node-not-found');
    }
    const versions: number[] = [];
    const children: ObjectNode[] = [];
    const warnings: TreeRefineOutput['warnings'] = [];
    /** agent 多模态预览聚合（add-vision-pipeline-v2 D5——链内 segmentOne 病态掩膜特写）。 */
    const agentImagePreviews: NonNullable<TreeRefineOutput['agentImagePreviews']> = [];
    let currentTreeBlobRef = input.currentTreeBlobRef;
    let previewBlobRef: string | null = null;
    // T2.5：steps 步进模式逐步透传；旧 hints 模式=逐步纯 hint 步（等价展开——零变化）。
    const steps: TreeRefineStep[] =
      in_.steps !== undefined ? in_.steps : in_.hints!.map((hint) => ({ hint }));
    for (const step of steps) {
      const hint = step.hint?.trim() ?? '';
      let outcome: SegmentOneOutput;
      try {
        outcome = await segmentOne(
          {
            db: this.deps.db,
            blobs: this.deps.blobs,
            jobs: this.deps.jobs,
            bridge: this.deps.bridge,
            ...(this.deps.samRequestTuner !== undefined
              ? { samRequestTuner: this.deps.samRequestTuner }
              : {}),
          },
          {
            taskId: input.taskId,
            imageBlobRef: input.imageBlobRef,
            treeBlobRef: currentTreeBlobRef,
            nodeId: in_.nodeId,
            ...(hint !== '' ? { hint } : {}),
            ...(step.box !== undefined ? { box: step.box } : {}),
            ...(step.excludeBox !== undefined ? { excludeBox: step.excludeBox } : {}),
            ...(step.instances !== undefined ? { instances: step.instances } : {}),
          },
        );
      } catch (error) {
        if (error instanceof SegmentOneError) {
          throw new TaskWorkbenchError(`refine 失败（${error.kind}）：${error.message}`, error.kind, { cause: error });
        }
        throw error;
      }
      const label = outcome.children.length > 0 ? outcome.children[0]!.objectName : '零检出';
      // 步标签（T2.5）：hint 步记提示原文；纯框步记 box[x,y,w,h] 语义串（segment-one
      // promptOrigin 同源——hints 模式 detail 逐字节不变）。
      const promptLabel =
        hint !== ''
          ? `提示：${hint.slice(0, 40)}`
          : `框选：box[${step.box!.x},${step.box!.y},${step.box!.w},${step.box!.h}]`;
      const version = this.recordTreeVersion({
        taskId: input.taskId,
        actorId: input.actorId,
        cause: 'tree-refine',
        detail: `refine「${target.objectName}」（${promptLabel}）→「${label}」`,
        treeBlobRef: outcome.treeBlobRef,
        previewBlobRef: outcome.previewBlobRef,
      });
      versions.push(version);
      children.push(...outcome.children);
      warnings.push(...outcome.warnings);
      agentImagePreviews.push(...(outcome.agentImagePreviews ?? []));
      currentTreeBlobRef = outcome.treeBlobRef;
      previewBlobRef = outcome.previewBlobRef;
    }
    if (previewBlobRef === null) {
      throw new TaskWorkbenchError('refine 未产生任何版本（hints/steps 空——schema 前置已拒，防御）', 'internal');
    }
    return {
      treeBlobRef: currentTreeBlobRef,
      previewBlobRef,
      versions,
      children,
      warnings,
      ...(agentImagePreviews.length > 0 ? { agentImagePreviews } : {}),
    };
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
        // dataRoot：task-layout 读 workbench-view-state.json（P2-4 隐藏层过滤）。
        { db: this.deps.db, blobs: this.deps.blobs, ...(this.deps.dataRoot !== undefined ? { dataRoot: this.deps.dataRoot } : {}) },
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
        taskLayoutBlobRef?: unknown;
        taskLayoutImageId?: unknown;
      };
      const frames: Array<[name: string, ref: string]> = [];
      for (const [name, ref] of [
        [STRATEGY_PLAN_ARTIFACT_NAME, refs.planBlobRef],
        [STRATEGY_GEMS_ARTIFACT_NAME, refs.gemsBlobRef],
        [STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME, refs.previewBlobRef],
      ] as const) {
        if (typeof ref === 'string') frames.push([name, ref]);
      }
      // task-layout 帧（4.1——直改/收敛重算同真源链：装配成功时按 imageId 组名）。
      if (typeof refs.taskLayoutBlobRef === 'string' && typeof refs.taskLayoutImageId === 'string') {
        frames.push([taskLayoutArtifactName(refs.taskLayoutImageId), refs.taskLayoutBlobRef]);
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

  private requireTask(taskId: string): { ownerId: string; sessionId: string | null } {
    const row = this.deps.db
      .prepare('SELECT id, owner_id, session_id FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string; session_id: string | null } | undefined;
    if (row === undefined) throw new TaskWorkbenchError(`任务不存在：${taskId}`, 'task-missing');
    return { ownerId: row.owner_id, sessionId: row.session_id };
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

  /** stoneIdx 回填（色板投影——与 task.detail/UI 色板同编号空间；幻觉 idx/无尺寸依据 typed 拒。
   * 2026-10-04 修复：改 projectStonePalette（此前误用 LLM 面投影——钻库>200 时
   * stone-filter-oversize 直拒，应用必败＝Owner 报障「无法选择钻」的第二断裂点）。 */
  private resolveStones(ownerId: string, stoneIdx: number[] | undefined, nodeId: string, kind: KernelStrategyKind): StonePick[] {
    if (stoneIdx === undefined || stoneIdx.length === 0) return [];
    const candidates = projectStonePalette({ db: this.deps.db, blobs: this.deps.blobs });
    const byIdx = new Map(candidates.map((c) => [c.idx, c.pick] as const));
    const stones: StonePick[] = [];
    for (const idx of stoneIdx) {
      const pick = byIdx.get(idx);
      if (pick === undefined) {
        throw new TaskWorkbenchError(
          `节点 ${nodeId} 的 stoneIdx=${idx} 不在候选表（1..${candidates.length}——共享库稳定序）`,
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

  /**
   * journey 基线播种（事务化——Codex v3 复核 P1：读尾-比较-插入同一 immediate 写
   * 事务；fence 同事务）。两个进程同 seed 并发读取时事务串行化后链尾比较幂等收口
   * ——只插一行（旧形态：SELECT 链尾在事务外，两连接都判「未覆盖」各自
   * recordTreeVersion ⇒ 同 seed 双行、版本数重复增长）。cause='journey' ≠
   * mask-patch ⇒ 在途编辑留痕同样置 stale（journey 推进也是树推进——漂移语义一致）。
   */
  private seedJourneyBaseline(input: {
    taskId: string;
    actorId: string;
    treeBlobRef: string;
    previewBlobRef: string;
  }): void {
    const commit = this.deps.db.transaction((): boolean => {
      assertTaskWritable(this.deps.db, input.taskId);
      const latest = this.deps.db
        .prepare('SELECT tree_blob_ref FROM tree_versions WHERE task_id = ? ORDER BY version DESC LIMIT 1')
        .get(input.taskId) as { tree_blob_ref: string } | undefined;
      if (latest !== undefined && latest.tree_blob_ref === input.treeBlobRef) return false; // 链已覆盖——幂等
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
          'journey',
          'Agent 会话产树（识图/循环推进——工作台外写入的树基线入链）',
          input.actorId,
          new Date().toISOString(),
        );
      this.deps.db
        .prepare(
          "UPDATE mask_edit_states SET state = 'stale', error = NULL, updated_at = ? WHERE task_id = ? AND state IN ('accepted', 'recomputing')",
        )
        .run(new Date().toISOString(), input.taskId);
      return true;
    });
    try {
      commit.immediate();
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new TaskWorkbenchError(`journey 基线入史被 fence 拒绝：${error.message}`, 'fence', { cause: error });
      }
      throw error;
    }
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
      // 树版本漂移检测（Codex 2b 复核 P0-2）：非 mask-patch cause 落新版本=树已被其他
      // 操作推进——重算在途（accepted/recomputing）的编辑基线漂移 → stale（spec 冻结
      // 语义：编辑结果对新树不再保证一致；mask-patch cause 不触发——笔刷编辑链内推进）。
      if (input.cause !== 'mask-patch') {
        this.deps.db
          .prepare(
            "UPDATE mask_edit_states SET state = 'stale', error = NULL, updated_at = ? WHERE task_id = ? AND state IN ('accepted', 'recomputing')",
          )
          .run(new Date().toISOString(), input.taskId);
      }
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
