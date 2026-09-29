/**
 * 项目钻 lint 单源（add-task-stones-manifest-export 3.1/3.2——arch-decisions A3
 * 「三处运行、一个规则单源」的计算面与工件面）。
 * 原始需求 2026-09-29（Owner 裁决：项目可用全部钻但未引入者使用时触发 lint 警告——
 * 与项目配置关联检查）。三源：
 *   manifest（session-project 指针所指 stones-manifest.json 的 entries[*].stoneRef）
 *   × strategy-plan（assignments[*].stones[*].resourceId——strategy-gems 不含物料
 *   身份，不能从 gems 猜）× stone_index 现状（存在/未软删/物料 blob 在场）。
 * 四分类（A3 冻结）：unintroduced=库内存在但不在 manifest（warning——经
 * studio.task.stones.add 可消除）；unresolvable=不在库/软删/物料损坏（hard——不能
 * 靠添加 manifest 消除；导出阻断裁决归 W4 exportGate 侧，本面只分类不裁决——
 * 政策/安全分离）；introduced=已在 manifest；unused=已引入但当前计划未用（info）。
 * 冻结裁量（W3 落地，多图数据源）：
 *   - strategy-plan 工件现状按 task latest-by-name（'strategy-plan.json' 单工件名），
 *     尚未按 imageId 命名——本波 lint 数据源=「该 task 的 plan（单图现状）」；imageId
 *     参数透传锚定（写入 lint 工件四锚之一），多图 plan 分图归 W3 完整接线/W4
 *     task-layout，届时仅本文件读面换源，分类规则不动。
 *   - 缺省 imageId='image-1'（首条主图集图 1——contracts assignTaskImageIds 同构）。
 * 正交意图：
 *   [1] lintAssignments：核心四分类（纯读——manifest×assignments×stone_index）。
 *   [2] lintTaskStoneRefs：单源函数本体（读 task 最新 plan→计算→四锚组装——
 *       stones.list/add 与后续导出接线共用）。
 *   [3] stones-lint.json 工件面：putStoneLintArtifact（latest-by-name+帧；来源漂移
 *       由读面 lintSummaryForTaskDetail 发现并重算——A3「不能展示旧的已消除」）。
 */
import path from 'node:path';
import {
  StrategyPlanSchema,
  StoneLintSchema,
  type StoneLint,
  type StoneLintItem,
  type StoneLintResult,
  type StoneLintSummary,
  type StrategyAssignment,
  type TaskImageId,
} from '@handicraft/contracts';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { getSessionProject } from '../db/sessions.js';
import { putTaskArtifact } from '../jobs/service.js';
import { FrameStore } from '../jobs/frame-store.js';
import { readStonesManifestBlob, type ManifestJobsLike } from './project-manifest.js';
import { StoneService } from '../stones/service.js';

/** lint artifact 帧名（latest-by-name 读面/任务详情展示的锚）。 */
export const STONES_LINT_ARTIFACT_NAME = 'stones-lint.json';

/**
 * 缺省 imageId（单图现状冻结——见文件头冻结裁量；多图 plan 分图归 W4）。
 * 类型经 TaskImageId 语义锚定（'image-1' 字面量合法性由 contracts pattern 保证）。
 */
export const DEFAULT_LINT_IMAGE_ID: TaskImageId = 'image-1';

/** lint 计算核（工件形态与响应投影的共同基——锚组装归外层面）。 */
export interface StoneLintComputation {
  /** 计算时的 session-project manifest revision（锚 1/3）。 */
  manifestRevision: number;
  items: StoneLintItem[];
  counts: { unintroduced: number; unresolvable: number; introduced: number; unused: number };
  computedAt: string;
}

export interface ProjectLintDeps {
  db: SqliteDb;
  blobs: BlobStore;
}

/** 计算时间戳（ISO——本文件单点，测试可注入用例内覆写）。 */
function nowIso(): string {
  return new Date().toISOString();
}

/**
 * [1] 核心四分类（A3）：manifest 条目 × plan 指派钻 × stone_index 现状。
 * 判定序（A3 字面）：stoneRef 在 manifest → introduced（项目持有物化快照——库内
 * 后续软删不破坏项目，见 A1 引用账本）；不在 manifest → stone_index 现存未软删
 * → unintroduced（warning）；否则 → unresolvable（hard）。manifest 条目未被任何
 * 指派引用 → unused（info）。
 * 返回 null=会话尚无 session-project 行（无项目语义——调用方按 lint 缺席呈现，
 * 不是错误）。manifest blob 损坏=typed 拒（readStonesManifestBlob 同纪律——真源
 * 腐蚀不静默降级）。
 */
export function lintAssignments(
  deps: ProjectLintDeps,
  input: { sessionId: string; assignments: StrategyAssignment[] },
): StoneLintComputation | null {
  const row = getSessionProject(deps.db, input.sessionId);
  if (row === null) return null;
  const manifest = readStonesManifestBlob(deps.blobs, row.blob_ref);

  // plan 引用面：stoneRef → 命中节点（指派序——确定性）。
  const nodeIdsByRef = new Map<string, string[]>();
  for (const assignment of input.assignments) {
    for (const stone of assignment.stones) {
      const hits = nodeIdsByRef.get(stone.resourceId) ?? [];
      if (!hits.includes(assignment.nodeId)) hits.push(assignment.nodeId);
      nodeIdsByRef.set(stone.resourceId, hits);
    }
  }
  const manifestRefs = new Set(manifest.entries.map((entry) => entry.stoneRef));
  const stones = new StoneService({ db: deps.db, blobs: deps.blobs });

  const items: StoneLintItem[] = [];
  const counts = { unintroduced: 0, unresolvable: 0, introduced: 0, unused: 0 };
  // [plan 引用面] 先判 manifest 再查库（判定序见头注）。
  for (const [stoneRef, nodeIds] of nodeIdsByRef) {
    if (manifestRefs.has(stoneRef)) {
      const entry = manifest.entries.find((e) => e.stoneRef === stoneRef)!;
      items.push({
        category: 'introduced',
        stoneRef,
        sku: entry.pick.sku,
        supplier: entry.pick.supplier,
        nodeIds,
      });
      counts.introduced += 1;
      continue;
    }
    const resolution = stones.resolveStoneRef(stoneRef);
    if (resolution.state === 'resolved' && resolution.stone !== undefined) {
      items.push({
        category: 'unintroduced',
        stoneRef,
        sku: resolution.stone.sku,
        supplier: resolution.stone.supplier,
        nodeIds,
      });
      counts.unintroduced += 1;
    } else {
      items.push({ category: 'unresolvable', stoneRef, nodeIds });
      counts.unresolvable += 1;
    }
  }
  // [manifest 面] 未被计划引用的已引入条目（info——manifest 条目序）。
  for (const entry of manifest.entries) {
    if (nodeIdsByRef.has(entry.stoneRef)) continue;
    items.push({
      category: 'unused',
      stoneRef: entry.stoneRef,
      sku: entry.pick.sku,
      supplier: entry.pick.supplier,
      nodeIds: [],
    });
    counts.unused += 1;
  }
  return { manifestRevision: row.revision, items, counts, computedAt: nowIso() };
}

/** 计算核 → 响应内嵌投影（summary+明细——A3 三处接线共用形态）。 */
export function stoneLintResultOf(computation: StoneLintComputation): StoneLintResult {
  return {
    summary: stoneLintSummaryOf(computation),
    items: computation.items,
  };
}

/** 计算核 → 摘要（task.detail.projectStones.lint 投影——W0 冻结形状）。 */
export function stoneLintSummaryOf(computation: StoneLintComputation): StoneLintSummary {
  return {
    computedAt: computation.computedAt,
    manifestRevision: computation.manifestRevision,
    counts: { ...computation.counts },
  };
}

/** 计算核 → 工件契约体（四锚全——planRef 必填：草案 plan 无工件引用时不产工件形态）。 */
export function stoneLintArtifactOf(
  computation: StoneLintComputation,
  anchors: { sourceTaskId: string; imageId?: TaskImageId; planRef: string },
): StoneLint {
  return StoneLintSchema.parse({
    kind: 'stones-lint',
    formatVersion: 1,
    manifestRevision: computation.manifestRevision,
    planRef: anchors.planRef,
    sourceTaskId: anchors.sourceTaskId,
    imageId: anchors.imageId ?? DEFAULT_LINT_IMAGE_ID,
    items: computation.items,
    computedAt: computation.computedAt,
  });
}

/** 帧流 latest-by-name 工件引用（逆序扫描——读面共用；rpc latestArtifactRefs 同构）。 */
export function latestTaskArtifactRefs(config: AppConfig, taskId: string): Map<string, string> {
  const frames = new FrameStore(path.join(config.dataRoot, 'tasks', taskId, 'frames.jsonl')).readAfter(0);
  const byName = new Map<string, string>();
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'artifact') continue;
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
 * [2] 单源函数本体（A3 命名面）：读 sourceTaskId 最新 strategy-plan 工件
 * （单图现状 latest-by-name——文件头冻结裁量）→ 四分类 → 四锚组装。
 * 返回 null=无 session-project 行**或**该 task 尚无 plan 工件（lint 无数据源）。
 * plan 工件损坏=typed 拒（真源腐蚀不静默降级——与 rpc 读面同纪律）。
 */
export function lintTaskStoneRefs(
  deps: ProjectLintDeps & { config: AppConfig },
  input: { sessionId: string; sourceTaskId: string; imageId?: TaskImageId },
): { lint: StoneLint; result: StoneLintResult } | null {
  const planRef = latestTaskArtifactRefs(deps.config, input.sourceTaskId).get('strategy-plan.json');
  if (planRef === undefined) return null;
  const bytes = deps.blobs.read(planRef);
  if (bytes === null) {
    throw new Error(`strategy-plan 工件不可读（blobRef=${planRef.slice(0, 12)}…）`);
  }
  let parsed: ReturnType<typeof StrategyPlanSchema.safeParse>;
  try {
    parsed = StrategyPlanSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new Error(
      `strategy-plan 工件不是合法 JSON（blobRef=${planRef.slice(0, 12)}…）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed.success) {
    throw new Error(
      `strategy-plan 工件不符契约（blobRef=${planRef.slice(0, 12)}…）：${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  const computation = lintAssignments(deps, { sessionId: input.sessionId, assignments: parsed.data.assignments });
  if (computation === null) return null;
  return {
    lint: stoneLintArtifactOf(computation, {
      sourceTaskId: input.sourceTaskId,
      ...(input.imageId !== undefined ? { imageId: input.imageId } : {}),
      planRef,
    }),
    result: stoneLintResultOf(computation),
  };
}

/**
 * [3] stones-lint.json 工件写入+帧（latest-by-name）。派生工件纪律（A1「帧失败≠
 * 写失败」同源）：putTaskArtifact 被 fence 拒/帧 append 失败**不放大为调用失败**——
 * 返回 frameEmitted=false 交下一次 lint 计算点收敛（任务详情读面发现漂移即重算，
 * 不依赖工件在场）。
 */
export function putStoneLintArtifact(
  deps: ProjectLintDeps & { jobs?: ManifestJobsLike },
  input: { taskId: string; lint: StoneLint },
): { blobRef: string | null; frameEmitted: boolean } {
  let blobRef: string | null = null;
  try {
    blobRef = putTaskArtifact(
      { db: deps.db, blobs: deps.blobs },
      input.taskId,
      Buffer.from(JSON.stringify(input.lint, null, 1), 'utf8'),
    ).hash;
  } catch {
    return { blobRef: null, frameEmitted: false };
  }
  const frameEmitted = deps.jobs?.emitFor(input.taskId, 'artifact', {
    name: STONES_LINT_ARTIFACT_NAME,
    blobRef,
  }) ?? false;
  return { blobRef, frameEmitted };
}

/**
 * 任务详情读面（A3 风险节「读面发现任一来源漂移就重算，不能展示旧的已消除」）：
 * 工件新鲜（manifestRevision+planRef 双锚未漂移）→ 工件 summary 直读；漂移/缺席/
 * 工件损坏 → 以当前 assignments 现算（派生工件损坏=重算，不放大）。无 plan
 * （assignments 空）或无 manifest 行 → null（lint 无语义）。读面只算不落工件——
 * 工件刷新归写面 lint 计算点（strategy.design 执行/layer.strategy.set/stones.add）。
 */
export function lintSummaryForTaskDetail(
  deps: ProjectLintDeps,
  input: {
    sessionId: string;
    latestPlanRef: string | null;
    latestLintRef: string | null;
    assignments: StrategyAssignment[];
  },
): StoneLintSummary | null {
  if (input.assignments.length === 0) return null;
  const row = getSessionProject(deps.db, input.sessionId);
  if (row === null) return null;
  if (input.latestLintRef !== null) {
    const bytes = deps.blobs.read(input.latestLintRef);
    if (bytes !== null) {
      try {
        const doc = StoneLintSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (doc.manifestRevision === row.revision && doc.planRef === input.latestPlanRef) {
          const counts = { unintroduced: 0, unresolvable: 0, introduced: 0, unused: 0 };
          for (const item of doc.items) counts[item.category] += 1;
          return { computedAt: doc.computedAt, manifestRevision: doc.manifestRevision, counts };
        }
      } catch {
        // 派生工件损坏/不符契约 → 现算（不放大——真源是 manifest×plan×stone_index）。
      }
    }
  }
  const computation = lintAssignments(deps, { sessionId: input.sessionId, assignments: input.assignments });
  return computation === null ? null : stoneLintSummaryOf(computation);
}
