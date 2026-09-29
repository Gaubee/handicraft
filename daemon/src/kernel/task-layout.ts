/**
 * task-layout.<imageId>.json 生成器（add-task-stones-manifest-export 4.1——arch-decisions
 * B2 渲染快照的最小真值装配面）。
 * 原始需求 2026-09-29（Owner：导出工具化 SVG/PNG/BOM）。task-layout 是三件套的唯一
 * 输入（防多工具调用的版本漂移——B1「每次执行恒产该 imageId 三件套」），由策略执行
 * 的**同一真值链**生成（executeStrategyPlan 末端：plan+gems+tree+blocks+manifest 在手，
 * 以 planRef/treeRef/manifestRevision 绑定——design.ts 挂接，workbench 直改/重放同链）。
 *
 * 物料匹配规则（B2「不能猜」冻结——逐 gem stoneRef 的唯一确定路径）：
 *   1. gem.blockId → assignment（StrategyPlan superRefine 保证 nodeId 唯一指派）。
 *   2. assignment.stones 恰一款 → 该款即物料身份（单源无歧义）。
 *   3. 多款候选 → 以 gem.colorId ↔ pick.colorHex 唯一匹配（恰一款命中=取该款；
 *      零命中或多款命中=不可唯一匹配）。
 *   4. 内核策略产物 colorId 恒 ''（registry.ts 冻结——mapColors 是引擎既有阶段），
 *      故规则 3 在当前执行链上恒不可命中=多候选节点一律拒（诊断明示改单款指派；
 *      未来策略输出逐 gem 选色后本规则自动生效，不需改生成器）。
 *
 * 其余冻结裁量（W4 落地注释——与 arch-decisions §3 偏差呼应）：
 *   - 隐藏层语义（B2/W0 冻结「隐藏不导出」）：ObjectTree 契约**无 visible 字段**
 *     （contracts/src/kernel.ts ObjectNodeSchema——只有 UI 侧 view-state 工件携带
 *     显隐投影），故当前生成器=全可见全导出；树工件未来增 visible 面时在此收敛过滤。
 *   - custom 形：daemon 无 .gemshape 全局面（W1 project-expand 冻结裁量同源——
 *     manifest 条目 shapeAssetBlobRef 恒 null），生成器对 custom 形 gem **拒+诊断**
 *     （shapeAssets={}——内核策略产物 shapeId 恒 'round'，本守卫面向未来策略面）。
 *   - 色板键=stoneRef（物料身份单源）：SVG `<g>` 分组/PNG 回查/BOM 行三者同键，
 *     同色不同款不并组（engine 按色分组不保留供应商区别——B2「不同供应商不合并
 *     成一行」的对偶面）；色名=`供应商/SKU`，hex=pick.colorHex（design.ts colorOfGem
 *     同源——plan 携带的物料色，非块代表色）。
 *   - grid 单源：pixelsPerMm=tree.imagePx.width/(canvasCm.w×10)（design.ts 同式）；
 *     gapMm=调用方传入的 ENGINE_DELEGATION_GAP_MM（design.ts 冻结常量——渲染与引擎
 *     委派同 gap；经参数注入防模块环，design.ts 挂接点为唯一传值面）；
 *     baseSpec={shapeId:'round', diameterMm:referenceDiameterMm}（executeStrategyPlan
 *     推断基准径——口径冻结互不漂移）。
 *   - blocks=叶子口径（treeToBlocks 产物=产块节点=nodeProducesBlock 单源）：只落
 *     id+bbox，**mask 不进 layout**——导出门/边界需要时按 treeRef 引用重算（B2）。
 *   - imageId：单图现状='image-1'（project-lint DEFAULT_LINT_IMAGE_ID 同语义——W2/W3
 *     冻结延续）；多图=每图独立生成（策略按图跑即每图一次链，调用方传各自 imageId）。
 *
 * 失败语义（派生面纪律——A3 lint 接线同族）：生成拒/无项目行 **不放大为策略执行失败**
 * ——诊断随 execute 返回值呈现（agent 即时可见），导出面以「无 task-layout 工件」
 * typed 拒并复述成因。
 */
import {
  TaskLayoutSchema,
  taskLayoutArtifactName,
  type ObjectTree,
  type StrategyPlan,
  type TaskImageId,
  type TaskLayout,
  type TaskLayoutGem,
  type TaskLayoutPaletteColor,
} from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { getSessionProject } from '../db/sessions.js';
import { putTaskArtifact } from '../jobs/service.js';
import { ArtifactFenceError } from '../writer-fence.js';
import { DEFAULT_LINT_IMAGE_ID } from './project-lint.js';
import type { KernelGem } from './strategies/registry.js';
import type { TreeBlock } from './vision/tree-to-blocks.js';

/** 生成拒诊断（生成器拒=不产 layout 工件；诊断面=execute 返回值+导出拒绝文案）。 */
export interface TaskLayoutRefusal {
  diagnostics: string[];
}

/** 纯装配结果：ok=layout 契约体（已过 TaskLayoutSchema）；拒=诊断清单。 */
export type TaskLayoutAssembly =
  | { ok: true; layout: TaskLayout }
  | ({ ok: false } & TaskLayoutRefusal);

/** 纯装配输入（无 IO——同输入同输出，物料匹配矩阵可单测）。 */
export interface TaskLayoutAssemblyInput {
  projectId: string;
  sourceTaskId: string;
  imageId: TaskImageId;
  manifestRevision: number;
  /** 策略计划（assignments=物料身份唯一来源——B2 不从 gems 猜）。 */
  plan: StrategyPlan;
  planRef: string;
  treeRef: string;
  tree: ObjectTree;
  /** executeStrategyPlan 汇总后的 kept gems（叶子口径——父层旧钻已在执行链跳过）。 */
  gems: KernelGem[];
  /** treeToBlocks 产物（叶子产块集——blocks 面单一来源）。 */
  blocks: TreeBlock[];
  /** executeStrategyPlan 的基准径（grid.baseSpec 与之同源）。 */
  referenceDiameterMm: number;
  /** 渲染 gap（mm）——唯一传值面=design.ts 挂接点（ENGINE_DELEGATION_GAP_MM 单源）。 */
  gapMm: number;
}

/**
 * 单 gem 物料身份解析（匹配规则见文件头冻结注释）。
 * 返回 null=不可唯一匹配（diagnostic 由调用方组装）。
 */
function materialIdentityOf(
  gem: KernelGem,
  assignment: StrategyPlan['assignments'][number] | undefined,
): { stoneRef: string; sku: string; supplier: string; colorHex: string } | { ambiguous: string[] } | null {
  if (assignment === undefined) return null; // 无指派（执行链防御——blockId 均有指派）
  if (assignment.stones.length === 1) {
    const pick = assignment.stones[0]!;
    return { stoneRef: pick.resourceId, sku: pick.sku, supplier: pick.supplier, colorHex: pick.colorHex };
  }
  // 规则 3：colorId ↔ colorHex 唯一匹配（内核 colorId 恒 '' → 恒零命中=拒——文件头 4）。
  const hits = assignment.stones.filter((pick) => gem.colorId === pick.colorHex);
  if (hits.length === 1) {
    const pick = hits[0]!;
    return { stoneRef: pick.resourceId, sku: pick.sku, supplier: pick.supplier, colorHex: pick.colorHex };
  }
  return {
    ambiguous: assignment.stones.map((pick) => `${pick.supplier}/${pick.sku}(${pick.colorHex})`),
  };
}

/**
 * task-layout 纯装配（B2 最小真值）：物料身份匹配 → palette（键=stoneRef）→
 * blocks（id+bbox；mask 不进 layout）→ grid（画布推导单源）→ TaskLayoutSchema 终验。
 * 任一 gem 不可唯一匹配 / custom 形 / 无 material / 契约终验失败 = 拒（诊断清单）。
 */
export function assembleTaskLayout(input: TaskLayoutAssemblyInput): TaskLayoutAssembly {
  const diagnostics: string[] = [];
  const assignmentByNode = new Map(input.plan.assignments.map((a) => [a.nodeId, a] as const));

  const palette = new Map<string, TaskLayoutPaletteColor>();
  const layoutGems: TaskLayoutGem[] = [];
  for (const gem of input.gems) {
    if (gem.shapeId === 'custom') {
      // daemon 无 .gemshape 全局面（W1 project-expand 冻结裁量）——assetId 无从冻结
      // blobRef，拒（内核策略产物恒 'round'，本守卫面向未来策略输出面）。
      diagnostics.push(
        `gem ${gem.id}（节点 ${gem.blockId}）为 custom 形——daemon 无钻形资产全局面，task-layout 不收录 custom 形（改用标准五形指派）`,
      );
      continue;
    }
    const identity = materialIdentityOf(gem, assignmentByNode.get(gem.blockId));
    if (identity === null) {
      diagnostics.push(`gem ${gem.id}（节点 ${gem.blockId}）无对应策略指派——无法确定物料身份`);
      continue;
    }
    if ('ambiguous' in identity) {
      diagnostics.push(
        `节点 ${gem.blockId} 指派 ${assignmentByNode.get(gem.blockId)!.stones.length} 款候选钻`
          + `（${identity.ambiguous.join('、')}），gem ${gem.id} 的 colorId=${JSON.stringify(gem.colorId)} 无法唯一匹配`
          + '——B2 不能猜：改为每节点恰一款钻（或多色候选时策略输出逐 gem 选色）后重跑策略',
      );
      continue;
    }
    if (!palette.has(identity.stoneRef)) {
      palette.set(identity.stoneRef, {
        name: `${identity.supplier}/${identity.sku}`,
        hex: identity.colorHex,
      });
    }
    layoutGems.push({
      id: gem.id,
      x: gem.x,
      y: gem.y,
      blockId: gem.blockId,
      shapeId: gem.shapeId,
      diameterMm: gem.diameterMm,
      ...(gem.rotationDeg !== undefined ? { rotationDeg: gem.rotationDeg } : {}),
      ...(gem.assetId !== undefined ? { assetId: gem.assetId } : {}),
      stoneRef: identity.stoneRef,
      sku: identity.sku,
      supplier: identity.supplier,
      colorHex: identity.colorHex,
    });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const layout = TaskLayoutSchema.parse({
    kind: 'task-layout',
    formatVersion: 1,
    source: {
      projectId: input.projectId,
      sourceTaskId: input.sourceTaskId,
      imageId: input.imageId,
      planRef: input.planRef,
      treeRef: input.treeRef,
      manifestRevision: input.manifestRevision,
    },
    imageWidth: input.tree.imagePx.width,
    imageHeight: input.tree.imagePx.height,
    canvasCm: input.tree.canvasCm,
    grid: {
      pixelsPerMm: input.tree.imagePx.width / (input.tree.canvasCm.w * 10),
      gapMm: input.gapMm,
      baseSpec: { shapeId: 'round', diameterMm: input.referenceDiameterMm },
    },
    palette: Object.fromEntries([...palette.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    blocks: input.blocks.map((block) => ({ id: block.id, bbox: { ...block.bbox } })),
    gems: layoutGems,
    shapeAssets: {},
  });
  return { ok: true, layout };
}

/** 执行链挂接结果：blobRef=null=未产 layout（skip 原因/诊断见其余字段）。 */
export interface TaskLayoutWriteResult {
  blobRef: string | null;
  imageId: TaskImageId;
  /** 无 session-project 行（无项目语义）/任务无会话=skip 空清单；生成拒=拒诊断。 */
  diagnostics: string[];
}

/**
 * 执行链写入面（executeStrategyPlan 末端挂接）：任务行→sessionId→session-project
 * 状态行（manifestRevision 锚）；无行/无会话=skip（lint null 同语义）；装配+putTaskArtifact
 * （fence 同事务——与 plan/gems 同边界原子）。帧发射归调用方（与三工件同纪律：
 * 事务提交后 emit，回滚路径不产孤儿帧）。
 */
export function writeTaskLayoutForExecution(
  deps: { db: SqliteDb; blobs: BlobStore },
  input: {
    taskId: string;
    imageId?: TaskImageId;
    plan: StrategyPlan;
    planRef: string;
    tree: ObjectTree;
    gems: KernelGem[];
    blocks: TreeBlock[];
    referenceDiameterMm: number;
    /** design.ts 挂接点传入 ENGINE_DELEGATION_GAP_MM（gap 单源——见文件头裁量）。 */
    gapMm: number;
  },
): TaskLayoutWriteResult {
  const imageId = input.imageId ?? DEFAULT_LINT_IMAGE_ID;
  const task = deps.db
    .prepare('SELECT session_id FROM tasks WHERE id = ?')
    .get(input.taskId) as { session_id: string | null } | undefined;
  if (task === undefined || task.session_id === null) {
    return { blobRef: null, imageId, diagnostics: [] };
  }
  const project = getSessionProject(deps.db, task.session_id);
  if (project === null) {
    // 会话尚无项目行（W1 前存量会话/异常态）——layout 无 manifestRevision 锚可绑，skip。
    return { blobRef: null, imageId, diagnostics: [] };
  }
  const assembly = assembleTaskLayout({
    projectId: task.session_id,
    sourceTaskId: input.taskId,
    imageId,
    manifestRevision: project.revision,
    plan: input.plan,
    planRef: input.planRef,
    treeRef: input.plan.objectTreeRef,
    tree: input.tree,
    gems: input.gems,
    blocks: input.blocks,
    referenceDiameterMm: input.referenceDiameterMm,
    gapMm: input.gapMm,
  });
  if (!assembly.ok) {
    return { blobRef: null, imageId, diagnostics: assembly.diagnostics };
  }
  try {
    const blobRef = putTaskArtifact(
      deps,
      input.taskId,
      Buffer.from(JSON.stringify(assembly.layout, null, 1), 'utf8'),
    ).hash;
    return { blobRef, imageId, diagnostics: [] };
  } catch (error) {
    if (error instanceof ArtifactFenceError) throw error; // fence 拒=执行链同语义上抛
    // 派生面不放大（putTaskArtifact 非 fence 异常=病态，不阻断已成功的策略执行）。
    return {
      blobRef: null,
      imageId,
      diagnostics: [`task-layout 工件写入失败：${error instanceof Error ? error.message : String(error)}`],
    };
  }
}

/** 帧名单源（调用方 emit 用——contracts taskLayoutArtifactName 直通）。 */
export { taskLayoutArtifactName };
