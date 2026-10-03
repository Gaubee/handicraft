/**
 * Agent 树组装工具面 `studio.tree.*` 五件（realize-scene-understanding T2 /
 * design §2——Owner 2026-09-28 架构定调：MCP 提供 treeView，Agent 灵活组装/迭代
 * 而非硬编码程序生成；SAM3=工具函数；用户口头反馈=合并/拆细指令）。
 *
 * 工具面（复用 workbench 内核 CAS 写路径——每次树写=版本链入史）：
 *   - studio.tree.inspect：读当前树（结构+mask 引用+effectiveMm/labVariance 判据
 *     数据+origin+relation）——Agent 自评停止条件（判据四条）的观测面。
 *   - studio.tree.merge：合并节点（子→父吸收：mask 并集+bbox 并集+children 移交）。
 *   - studio.tree.refine：对指定节点再拆（限定该节点 mask 区域内调 SAM 多提示→
 *     子节点生成，origin/relation=refinement；add-sam-playbook T2.5 步进化——steps
 *     每步 hint/box/excludeBox/instances 透传 segmentOne，旧 hints=纯文本步清单）。
 *   - studio.tree.reparent：重组归属（移动子树——layer.reorder 内核）。
 *   - studio.tree.rename：重命名/drillWorthy 标注/显式 relation 重分类（B2 三态：
 *     refinement↔semantic 互转；根/组 typed 拒）。
 *
 * authority 语义（core.ts 只对 approved-mutation 走授权桥）：inspect=readonly；
 * 四写工具=proposal 标注的**直效写**（Owner Agent 循环定调：口头反馈即审批面、
 * 版本链即撤销面——与 approved-mutation 的策略/资源变更授权桥是两类面）。
 *
 * CAS/电流树解析：帧流 latest-by-name（rpc.ts latestArtifactRefs 同语义——FrameStore
 * jsonl 读回）；expectedTreeBlobRef 漂移必拒 cas-mismatch（携 currentTreeBlobRef
 * 幂等重试锚）。原图引用：入参显式给，缺省经帧流最新 scene-analysis.json 的
 * imageBlobRef 真源回填（S0 锚不猜测）。
 */
import {
  FrameSchema,
  LayerReorderInputSchema,
  LayerRenameInputSchema,
  SceneAnalysisSchema,
  TreeInspectInputSchema,
  TreeMergeInputSchema,
  TreeRefineInputSchema,
  type Frame,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { FrameStore } from '../jobs/frame-store.js';
import type { JobService } from '../jobs/service.js';
import type { TaskWorkbench } from '../kernel/workbench.js';
import { RUNAWAY_LIMIT } from './studio.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from './core.js';

/** 工具面名（MCP 投影 mcp__studio__tree_<verb>——studio. 前缀过 deny 名单）。 */
export const TREE_INSPECT_TOOL_NAME = 'studio.tree.inspect';
export const TREE_MERGE_TOOL_NAME = 'studio.tree.merge';
export const TREE_REFINE_TOOL_NAME = 'studio.tree.refine';
export const TREE_REPARENT_TOOL_NAME = 'studio.tree.reparent';
export const TREE_RENAME_TOOL_NAME = 'studio.tree.rename';

/** 帧流工件帧名（电流树/原图/plan 解析键——rpc.ts 同名同约定）。 */
const OBJECT_TREE_ARTIFACT_NAME = 'object-tree.json';
const SCENE_ANALYSIS_ARTIFACT_NAME = 'scene-analysis.json';
const STRATEGY_PLAN_ARTIFACT_NAME = 'strategy-plan.json';

export interface TreeCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（artifact 帧登记+frames.jsonl 电流树解析）。 */
  jobs: Pick<JobService, 'emitFor' | 'framesFileOf'>;
  /** 排钻工作台（kernel 共享实例——CAS 写路径与版本入史的真身）。 */
  workbench: TaskWorkbench;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

/** 帧流最新同名 artifact 引用（逆序扫描——rpc.ts latestArtifactRefs 同语义）。 */
function latestArtifactRefs(deps: TreeCapabilitiesDeps, taskId: string): Map<string, string> {
  const frames: Frame[] = new FrameStore(deps.jobs.framesFileOf(taskId)).readAfter(0);
  const byName = new Map<string, string>();
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (FrameSchema.safeParse(frame).success !== true || frame.kind !== 'artifact') continue;
    const payload = frame.payload as { name?: unknown; blobRef?: unknown };
    if (
      typeof payload.name === 'string' &&
      typeof payload.blobRef === 'string' &&
      !byName.has(payload.name)
    ) {
      byName.set(payload.name, payload.blobRef);
    }
  }
  return byName;
}

/**
 * 任务工件登记集（全帧流 artifact 帧的 blobRef——含历史版本树/预览/plan/gems 全部
 * 登记面）。v6 复核 P1-2（安全面）：内容寻址 hash 本身推不出任务归属——显式
 * blob 引用必须命中当前任务的帧流登记，跨任务引用 typed 拒（artifact-task-
 * mismatch——防任务 B 借任务 A 的树 blob 读树）。
 */
function ownedArtifactRefs(deps: TreeCapabilitiesDeps, taskId: string): Set<string> {
  const frames: Frame[] = new FrameStore(deps.jobs.framesFileOf(taskId)).readAfter(0);
  const refs = new Set<string>();
  for (const frame of frames) {
    if (FrameSchema.safeParse(frame).success !== true || frame.kind !== 'artifact') continue;
    const payload = frame.payload as { blobRef?: unknown };
    if (typeof payload.blobRef === 'string') refs.add(payload.blobRef);
  }
  return refs;
}

/** 任务原图引用（scene-analysis.json 锚点真源——不猜测）。 */
function taskImageBlobRef(deps: TreeCapabilitiesDeps, taskId: string): string | null {
  const sceneRef = latestArtifactRefs(deps, taskId).get(SCENE_ANALYSIS_ARTIFACT_NAME);
  if (sceneRef === undefined) return null;
  const bytes = deps.blobs.read(sceneRef);
  if (bytes === null) return null;
  const parsed = SceneAnalysisSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  return parsed.success ? parsed.data.imageBlobRef : null;
}

/**
 * 上游工件未就绪（树/锚点工件尚未产出——产树或分析仍在进行）的 typed 判别。
 * [真链走查 P1-4，2026-10-01] 轮询 inspect 等「未就绪」是**合法等待**不是故障：
 * 该类响应不计入熔断连击（noteNotReady——区分「业务未就绪」vs「真故障」），
 * 曾按普通失败连击 5 次即熔断杀 turn（树还在生成却把等待当故障收口）。
 */
class ArtifactPendingError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ArtifactPendingError';
  }
}

/** 失败面+成功清零（RUNAWAY 熔断照 studio.ts 先例——同 bucket 同错连击 5 次收口）。 */
function noteFailureFn(deps: TreeCapabilitiesDeps) {
  const streaks = new Map<string, { key: string; count: number }>();
  const noteFailure = (bucket: string, step: string, detail: string): CapabilityCallResult => {
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
  };
  /**
   * 未就绪面（P1-4）：不计数、不熔断、不清零既有真故障连击（只有成功才清零）——
   * 返回可重试语义（UNAVAILABLE）+ 等待指引，agent 的下一轮轮询不会被熔断误杀。
   */
  const noteNotReady = (bucket: string, step: string, detail: string): CapabilityCallResult => ({
    kind: 'failed',
    code: 'UNAVAILABLE',
    message: `${step} 未就绪：${detail.slice(0, 400)}——上游工件仍在产出中，属合法等待不是故障；请稍后再试（勿密集轮询），或先完成产树/分析步骤。`,
  });
  const noteSuccess = (bucket: string): void => {
    streaks.delete(bucket);
  };
  return { noteFailure, noteNotReady, noteSuccess };
}

/**
 * tree 能力集（kernel 工具面注册）。任务行校验/owner 绑定照 vision/scene-analyze
 * 先例（requireAgentTask——MCP 面身份经 taskId 贯穿）。
 */
export function createTreeCapabilities(deps: TreeCapabilitiesDeps): CapabilityRegistry {
  const { noteFailure, noteNotReady, noteSuccess } = noteFailureFn(deps);

  function requireAgentTask(taskId: string): { ownerId: string } {
    const task = deps.db
      .prepare('SELECT id, owner_id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; owner_id: string; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
    return { ownerId: task.owner_id };
  }

  function bucketOf(input: unknown): string {
    const taskId = (input as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : 'global';
  }

  /**
   * 电流树引用（帧流 latest object-tree.json——CAS 门与 inspect 缺省的共源）。
   * 缺席=ArtifactPendingError（产树仍在进行——P1-4 未就绪类，不进熔断连击）。
   */
  function currentTreeRef(taskId: string): string {
    const ref = latestArtifactRefs(deps, taskId).get(OBJECT_TREE_ARTIFACT_NAME);
    if (ref === undefined) {
      throw new ArtifactPendingError(`任务 ${taskId} 尚无 object-tree 工件（先经 subject.segment 产树——帧流无 ${OBJECT_TREE_ARTIFACT_NAME}）`);
    }
    return ref;
  }

  /**
   * 原图锚点要求（merge/refine/reparent/rename 共用）：scene-analysis 锚缺席=
   * ArtifactPendingError（识图/分析仍在产出——未就绪类，不进熔断连击）。
   */
  function requireImageAnchor(taskId: string, purpose: string): string {
    const imageBlobRef = taskImageBlobRef(deps, taskId);
    if (imageBlobRef === null) {
      throw new ArtifactPendingError(`任务 ${taskId} 暂无可解析原图（scene-analysis 锚点尚未产出——${purpose} 需要原图，待分析完成后重试）`);
    }
    return imageBlobRef;
  }

  /** 异常分流（P1-4）：未就绪=noteNotReady（不计数）；其余=noteFailure（连击熔断面）。 */
  function noteThrown(bucket: string, step: string, error: unknown): CapabilityCallResult {
    return error instanceof ArtifactPendingError
      ? noteNotReady(bucket, step, error.message)
      : noteFailure(bucket, step, error instanceof Error ? error.message : String(error));
  }

  const definitions: CapabilityDefinition[] = [
    {
      name: TREE_INSPECT_TOOL_NAME,
      description:
        '读当前图层树（Agent 组装/迭代 treeView 的观测面）：节点结构（parent/children）'
        + '+mask 引用+停止判据数据（effectiveMm 有效尺寸 mm/labVariance 色方差）+origin'
        + '+relation（semantic 语义部位|refinement 细分区域）。'
        + `判据提示（design §0 四条）：1) effectiveMm≈钻径量级（~5mm×5mm）即停拆；`
        + '2) labVariance 低（大范围同色）即停拆；3) refine 零新实例=SAM 自认不可拆；'
        + '4) 迭代硬顶。用户口头反馈驱动 merge（「面部当整体」）/refine（「帽子拆细」）。'
        + '输入 {taskId[,treeBlobRef]}（缺省=帧流电流树）。出参 {nodes[],currentVersion}。',
      authority: 'readonly' as const,
      input: TreeInspectInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const bucket = bucketOf(input);
        const parsed = TreeInspectInputSchema.safeParse(input);
        if (!parsed.success) {
          return noteFailure(bucket, TREE_INSPECT_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          requireAgentTask(parsed.data.taskId);
          const treeBlobRef = parsed.data.treeBlobRef ?? currentTreeRef(parsed.data.taskId);
          // 归属门（v6 复核 P1-2）：显式引用必须命中当前任务的帧流工件登记——
          // 内容寻址 hash 推不出归属，跨任务 blob 引用 typed 拒（零树内容泄露）。
          if (parsed.data.treeBlobRef !== undefined && !ownedArtifactRefs(deps, parsed.data.taskId).has(parsed.data.treeBlobRef)) {
            const failure = noteFailure(
              bucket,
              TREE_INSPECT_TOOL_NAME,
              `treeBlobRef=${parsed.data.treeBlobRef.slice(0, 12)}… 不属于任务 ${parsed.data.taskId} 的工件登记（artifact-task-mismatch——跨任务树引用必拒；缺省调用走帧流电流树）`,
            );
            return failure.kind === 'failed'
              ? { kind: 'failed' as const, code: 'INVALID_OPERATION' as const, message: failure.message }
              : failure;
          }
          const outcome = deps.workbench.treeInspect({ taskId: parsed.data.taskId, treeBlobRef });
          noteSuccess(bucket);
          return { kind: 'ok', value: outcome };
        } catch (error) {
          // P1-4：轮询「树还在生成」=合法等待（ArtifactPendingError 不进熔断连击）。
          return noteThrown(bucket, TREE_INSPECT_TOOL_NAME, error);
        }
      },
    },
    {
      name: TREE_MERGE_TOOL_NAME,
      description:
        '合并图层（子→父吸收——用户「面部当整体」类指令）：sourceNodeIds 的 mask 并集'
        + '+bbox 并集并入 targetNodeId，children 移交 target、sources 出树；判据数据重算'
        + '（effectiveMm/labVariance）。存量 plan 指派自动收敛（被吸收节点指派移除；target'
        + ' 变组后组不产钻——v5）。CAS：expectedTreeBlobRef=你现持的 treeBlobRef，漂移'
        + '必拒（先 inspect 刷新）。每次写=版本入史（可 tree.revert 回退）。',
      authority: 'proposal' as const,
      input: TreeMergeInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const bucket = bucketOf(input);
        const parsed = TreeMergeInputSchema.safeParse(input);
        if (!parsed.success) {
          return noteFailure(bucket, TREE_MERGE_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          const task = requireAgentTask(parsed.data.taskId);
          const artifacts = latestArtifactRefs(deps, parsed.data.taskId);
          const imageBlobRef = requireImageAnchor(parsed.data.taskId, 'merge 的 labVariance 重测');
          const outcome = deps.workbench.treeMerge({
            taskId: parsed.data.taskId,
            actorId: task.ownerId,
            imageBlobRef,
            currentTreeBlobRef: currentTreeRef(parsed.data.taskId),
            planBlobRef: artifacts.get(STRATEGY_PLAN_ARTIFACT_NAME) ?? null,
            expectedTreeBlobRef: parsed.data.expectedTreeBlobRef,
            targetNodeId: parsed.data.targetNodeId,
            sourceNodeIds: parsed.data.sourceNodeIds,
          });
          noteSuccess(bucket);
          return { kind: 'ok', value: outcome };
        } catch (error) {
          return noteThrown(bucket, TREE_MERGE_TOOL_NAME, error);
        }
      },
    },
    {
      name: TREE_REFINE_TOOL_NAME,
      description:
        '再拆分图层（用户「帽子拆细点/不同条纹不同效果」类指令）：限定 nodeId 的 mask '
        + '区域内逐步细分（steps=步进清单 1..8 步，每步 {hint 文本提示?, box 正框?, '
        + 'excludeBox 排除区?, instances 实例枚举?}——hint 与 box 至少一项；与旧参数 '
        + 'hints=纯文本步清单互斥恰一存在，如 ["top stripes","hat brim"]）——子节点 '
        + 'origin/relation=refinement（临时细分节点：确认为语义部位后经 tree.rename '
        + '+ tree.reparent 升 semantic；无独立语义的区域保持 refinement 叶子直接贴钻——父组'
        + '不产钻、兄弟不重叠）。停止判据：effectiveMm≈钻径量级/labVariance 低/SAM 零新'
        + '实例即停。CAS：expectedTreeBlobRef=你现持的 treeBlobRef。每步=版本入史。'
        + '**步内参数策略（浓缩——遇阻先 kb_get 知识库「SAM 提示词策略」组）**：hint=短'
        + '名词短语最稳（单数光杆名词/名词+≤2 视觉属性，如 "hat"/"golden hair"）；**禁数词**'
        + '（「六颗星星」类量化提示会合并实例——逐个成层该步带 instances=all，计数在掩膜层'
        + '做）；**禁否定词**（「不要背景」无效——排除区域走该步 excludeBox）；box=本步聚焦'
        + '正框覆写（缺省=目标节点外接框；无 hint=纯框选兜底，不赌语义命中——语义词穷尽时'
        + '用，子层名缺省「框选区域」）；**excludeBox=泄漏修法：对泄漏节点（warnings 见 '
        + 'mask-parent-iou 掩膜盖满父层/mask-suspicious-aspect 细长条带贯穿）重拆时用 '
        + 'excludeBox 框住泄漏区——框内像素从结果掩膜中扣除（确定性像素减法）**；'
        + 'instances=all=同款多实例逐个成层（单次 ≤24 超限截断明示）；零检出→换更具体的'
        + '英文措辞/泛称回退（cherub→angel→person）+变体轮询，勿原词重发。',
      authority: 'proposal' as const,
      input: TreeRefineInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const bucket = bucketOf(input);
        const parsed = TreeRefineInputSchema.safeParse(input);
        if (!parsed.success) {
          return noteFailure(bucket, TREE_REFINE_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          const task = requireAgentTask(parsed.data.taskId);
          const imageBlobRef = requireImageAnchor(parsed.data.taskId, 'refine 的掩码交集');
          const outcome = await deps.workbench.treeRefine({
            taskId: parsed.data.taskId,
            actorId: task.ownerId,
            imageBlobRef,
            currentTreeBlobRef: currentTreeRef(parsed.data.taskId),
            expectedTreeBlobRef: parsed.data.expectedTreeBlobRef,
            nodeId: parsed.data.nodeId,
            ...(parsed.data.hints !== undefined ? { hints: parsed.data.hints } : {}),
            ...(parsed.data.steps !== undefined ? { steps: parsed.data.steps } : {}),
          });
          noteSuccess(bucket);
          return { kind: 'ok', value: outcome };
        } catch (error) {
          return noteThrown(bucket, TREE_REFINE_TOOL_NAME, error);
        }
      },
    },
    {
      name: TREE_REPARENT_TOOL_NAME,
      description:
        '重组归属（移动子树——「左手归小丑」类指令）：nodeId 整子树挂到 newParentId 的'
        + 'index 位。环路/根保护 typed 拒。产块节点集不变⇒既有指派零触碰。CAS：'
        + 'expectedTreeBlobRef=你现持的 treeBlobRef，漂移必拒。每次写=版本入史。',
      authority: 'proposal' as const,
      input: LayerReorderInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const bucket = bucketOf(input);
        const parsed = LayerReorderInputSchema.safeParse(input);
        if (!parsed.success) {
          return noteFailure(bucket, TREE_REPARENT_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          const task = requireAgentTask(parsed.data.taskId);
          const imageRef = requireImageAnchor(parsed.data.taskId, '树重落双轨');
          const outcome = deps.workbench.layerReorder({
            taskId: parsed.data.taskId,
            actorId: task.ownerId,
            imageBlobRef: imageRef,
            currentTreeBlobRef: currentTreeRef(parsed.data.taskId),
            currentViewStateBlobRef: null, // Agent 写窗不消费人类视图态锁（口头反馈即审批面）
            nodeId: parsed.data.nodeId,
            newParentId: parsed.data.newParentId,
            index: parsed.data.index,
            expectedTreeBlobRef: parsed.data.expectedTreeBlobRef,
          });
          noteSuccess(bucket);
          return { kind: 'ok', value: outcome };
        } catch (error) {
          return noteThrown(bucket, TREE_REPARENT_TOOL_NAME, error);
        }
      },
    },
    {
      name: TREE_RENAME_TOOL_NAME,
      description:
        '重命名/drillWorthy 标注/显式重分类（B2 三态语义收口）：objectName 新名（中文语义名）'
        + '+可选 drillWorthy+可选 relation=semantic|refinement（refinement 临时节点经 VLM '
        + '重入确认为语义部位后改名升 semantic——「小丑·部分1」→「左手」产钻面升级；'
        + 'semantic 误标可降回 refinement。根/画布与组节点 typed 拒）。CAS：'
        + 'expectedTreeBlobRef=你现持的 treeBlobRef。每次写=版本入史。',
      authority: 'proposal' as const,
      input: LayerRenameInputSchema.extend({
        expectedTreeBlobRef: LayerReorderInputSchema.shape.expectedTreeBlobRef,
      }),
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const bucket = bucketOf(input);
        const schema = LayerRenameInputSchema.extend({
          expectedTreeBlobRef: LayerReorderInputSchema.shape.expectedTreeBlobRef,
        });
        const parsed = schema.safeParse(input);
        if (!parsed.success) {
          return noteFailure(bucket, TREE_RENAME_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          const task = requireAgentTask(parsed.data.taskId);
          const currentTreeRefNow = currentTreeRef(parsed.data.taskId);
          if (parsed.data.expectedTreeBlobRef !== currentTreeRefNow) {
            throw new Error(
              `tree.rename CAS 漂移必拒：expectedTreeBlobRef=${parsed.data.expectedTreeBlobRef.slice(0, 12)}… ≠ 电流树 ${currentTreeRefNow.slice(0, 12)}…（树已被推进——刷新后重放意图）`,
            );
          }
          const imageRef = requireImageAnchor(parsed.data.taskId, '树重落双轨');
          const outcome = deps.workbench.renameNode({
            taskId: parsed.data.taskId,
            actorId: task.ownerId,
            imageBlobRef: imageRef,
            treeBlobRef: currentTreeRefNow,
            nodeId: parsed.data.nodeId,
            objectName: parsed.data.objectName,
            ...(parsed.data.drillWorthy !== undefined ? { drillWorthy: parsed.data.drillWorthy } : {}),
            ...(parsed.data.relation !== undefined ? { relation: parsed.data.relation } : {}),
          });
          noteSuccess(bucket);
          return { kind: 'ok', value: outcome };
        } catch (error) {
          return noteThrown(bucket, TREE_RENAME_TOOL_NAME, error);
        }
      },
    },
  ];

  // 权威标注语义见文件头注：inspect=readonly；四写=proposal 标注的直效写（Owner
  // Agent 循环定调——口头反馈即审批面，版本链即撤销面；非 approved-mutation 面）。
  return createCapabilityRegistry(definitions);
}
