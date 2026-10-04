/**
 * 任务导出 MCP 工具面（add-task-stones-manifest-export 4.2/4.3——arch-decisions B1/B2/B3
 * 裁定的唯一实现位）。原始需求 2026-09-29（Owner：导出工具化 SVG/PNG/BOM）。
 *
 * 工具形态（B1 冻结）：**一个逻辑工具 studio.task.export，proposal/execute 双模**；
 * 不暴露 kind 分支——每次执行恒产该 imageId 导出矩阵（2026-10-02 扩展：四层 SVG+
 * render.png 效果图+BOM+黑点模板 holes.png+编号工作图 numbered.png 同一 task-layout
 * 快照，防多工具调用的版本漂移/重复审批/产物不对应）。多图任务按 imageId 连续调用，
 * 各自产一组产物矩阵。
 *
 * 导出管道（B2 冻结——engine 只读复用红线）：
 *   task-layout.<imageId>.json（唯一输入——planRef/treeRef/manifestRevision 三锚绑定）
 *     → lint 重算（unresolvable=hard 阻断；unintroduced=warning 不阻断——A3 政策/
 *       安全分离）+ workbench mask 门（mask-incomplete/stale/recompute-error）+
 *       engine validate（warnings 面）+ engine exportGate（spacing/mask/missing-asset
 *       安全门）——三门全部通过才产产物
 *     → buildSvg + renderGemsTexturePng（daemon 贴图合成效果图——2026-10-02 口径升级：
 *       render.png=效果图，用钻库真实贴图按位渲染；缺贴图款降级 colorHex 色点+
 *       warnings 明示。SVG=生产定位/BOM=备料口径不动）+ buildTaskBom
 *       （daemon 适配器按 stoneRef 聚合——engine buildBom 只有规格×色口径，不含
 *       supplier/SKU，不冒充项目备料 BOM）
 *     → createShareBundle（产物矩阵+/r/{publicId} 发布+manifest 审计字段）+ artifact
 *       帧五条（task-export.<imageId>.{svg,png,bom,holes.png,numbered.png}）。
 *
 * engine 复用选型（红线 1 落实）：**公共出口直接 import**——`rhinestone-studio/engine`
 * barrel（buildSvg/exportGate/validate/types），先例=capability/studio.ts:39、
 * png/render.ts:26、jobs/engine.ts:29（daemon 侧 engine 消费的既有唯一通道；
 * strategies 子树的「不 import 引擎」红线不覆盖 capability 层）。零抄录零改动。
 *
 * 授权（B1 偏差 4：导出会发布分享 result——保留 proposal/approval 双模）：propose=
 * {taskId, sourceTaskId?, imageId?, expectedManifestRevision?}（跑门+产物摘要+
 * approval request，proposalId 绑定 sessionId/sourceTaskId/imageId/taskLayoutRef/
 * manifestRevision——B1「proposalId 必须绑定 task、source task、imageId、owner、
 * layout/manifest revision」；P2-3：manifestRevision 取 layout.source.manifestRevision
 * 定版锚，非当前 projectRow.revision）；execute={taskId, proposalId}（grant 消费+按
 * 绑定 taskLayoutRef 定版快照产三件套——内容寻址 blob 不可变，批准后策略重跑不漂移）。
 * [P0 会话域缺省锚，2026-10-01] sourceTaskId **缺省**时不再锚当前 taskId（多轮会话
 * 每轮换绑新 task，上轮 task-layout 对不上=「资源不存在」终点不可达——真链首验
 * 实锤），改为解析**本会话最近一次成功落档**的 task-layout.<imageId>.json（会话+
 * owner 围栏内 ts 最新；当前 taskId 亦为会话成员，同轮导出零变化）——显式
 * sourceTaskId 在场=精确锚行为不变。解析来源（sourceResolution）入 proposal 载荷/
 * 审批 summary/结果——审计可追溯「这次导出用的是哪轮的布局」。
 * P2-3：三门中的 lint 按 layout.source.planRef 定版读回该 plan 计算（不读全 task
 * 最新 strategy-plan.json）；BOM 备料参考按 layout 锚与当前 manifest revision 比对——
 * 一致读当前快照，漂移=「清单已更新（rev X→Y）」审计行（不回放旧 manifest blob）。
 * P1-1（2026-09-28 复核）：多图任务对无 layout 的 imageId=typed 拒+「当前版本逐图排钻
 * 未贯通——每张图请单独会话」（per-image 贯通=W6 挂账）。
 *
 * 产物面（4.3——B3）：bundle（results/<publicId>+/r/ 分享+manifest.source 审计）+
 * artifact 帧三条 + MCP 返回 {resultId,publicId,bundle,source,warnings}（无 base64
 * 大文件）+ task.exports.list 多图历史读面（B3.5——tasks.result_id 单列被后一次导出
 * 覆盖后，前一组 result 行经本面按 imageId 重新定位）。
 *
 * 多图裁定（B1/A5）：单图可省 imageId（缺省 image-1）；多图必指定（会话首条主图集
 * imageIds 审计——tasks.params 冻结面，缺席=单图域）。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  TaskImageIdSchema,
  TaskLayoutSchema,
  taskLayoutArtifactName,
  type StoneLintResult,
  type StonesManifest,
  type TaskImageId,
  type TaskLayout,
} from '@handicraft/contracts';
import {
  exportGate,
  validate,
  type Block,
  type Gem,
  type GridSpec,
  type Palette,
} from 'rhinestone-studio/engine';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { getSessionProject } from '../db/sessions.js';
import type { JobService } from '../jobs/service.js';
import { renderGemsTexturePng, type RenderGemsTextureResult, type ResolveStoneTexture } from '../png/texture-render.js';
import { renderHoleTemplatePng } from '../png/hole-template.js';
import { renderNumberedSheetPng } from '../png/numbered-sheet.js';
import { buildLayeredSvg } from '../png/svg-layers.js';
import { createShareBundle } from '../share.js';
import { assetResolverOf, resolveShapeAssetStateOf } from '../shape-assets.js';
import { StoneService } from '../stones/service.js';
import { sessionImageSet } from './task-images.js';
import { sniffImageMime } from '../image-sniff.js';
import { exportGateOf, maskEditStatusesOf } from '../kernel/workbench.js';
import { latestTaskArtifactRefs, lintTaskStoneRefsByPlanRef } from '../kernel/project-lint.js';
import { latestSessionArtifactAnchor } from '../kernel/session-artifacts.js';
import { loadObjectTreeArtifact } from '../kernel/vision/tree-persist.js';
import { treeToBlocks } from '../kernel/vision/tree-to-blocks.js';
import type { ApprovalService, ConsumeDenyReason } from './authorization.js';
import { approvalFaceOf } from './authorization.js';
import type { ApprovedOpRow } from '../db/approvals.js';
import { createCapabilityRegistry, type CapabilityCallResult, type CapabilityDefinition, type CapabilityRegistry } from './core.js';
import { RUNAWAY_LIMIT } from './studio.js';

export const TASK_EXPORT_TOOL_NAME = 'studio.task.export';
export const TASK_EXPORTS_LIST_TOOL_NAME = 'studio.task.exports.list';

/**
 * 帧名（4.3 + 导出矩阵 2026-10-02——任务详情/下载面按 imageId 定位）：
 * 五产物=SVG（四层化）+PNG（效果图）+BOM+黑点模板+编号工作图。
 */
export function taskExportArtifactNames(imageId: TaskImageId): {
  svg: string;
  png: string;
  bom: string;
  holes: string;
  numbered: string;
} {
  return {
    svg: `task-export.${imageId}.svg`,
    png: `task-export.${imageId}.png`,
    bom: `task-export.${imageId}.bom`,
    holes: `task-export.${imageId}.holes.png`,
    numbered: `task-export.${imageId}.numbered.png`,
  };
}

/** 结果历史返回上界（B3.5 读面有界）。 */
const MAX_EXPORT_HISTORY = 50;

// ---------------------------------------------------------------- 输入 schema

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（行动者/审批归属——服务端以任务行解析所属会话/项目）');
const SourceTaskIdField = z
  .string()
  .min(1)
  .describe('排钻真值所属 task（strategy-plan/tree/task-layout 工件域）。显式=精确锚（须同 owner 同会话）；缺省=本会话最近一次成功落档的同名工件——多轮会话自动延续上轮排钻成果');
const ImageIdField = TaskImageIdSchema.describe('主图集 imageId（单图可省——缺省 image-1；多图任务必指定）');

/** 双模外层（照 task-stones 先例：外层全可选，propose 齐备性 handler 内二次校验）。 */
const ExportInputSchema = z.object({
  taskId: TaskIdField,
  proposalId: z.string().min(1).optional().describe('已批准 proposal id（执行模式——grant 服务端内部关联）'),
  sourceTaskId: SourceTaskIdField.optional(),
  imageId: ImageIdField.optional(),
  expectedManifestRevision: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('发起时读到的项目 manifest revision（可选 CAS 基线——漂移=STALE）'),
});

const ExportsListInputSchema = z.object({
  taskId: TaskIdField,
  imageId: ImageIdField.optional().describe('按 imageId 过滤（缺省=全部图）'),
  sourceTaskId: SourceTaskIdField.optional().describe('按排钻真值 task 过滤（缺省=全部）'),
});

// ---------------------------------------------------------------- 任务域 helpers

interface AgentTaskRef {
  ownerId: string;
  sessionId: string | null;
}

function agentTaskOf(db: SqliteDb, taskId: string): AgentTaskRef {
  const task = db
    .prepare('SELECT id, owner_id, session_id, type FROM tasks WHERE id = ?')
    .get(taskId) as { id: string; owner_id: string; session_id: string | null; type: string } | undefined;
  if (!task) throw new Error(`任务不存在：${taskId}`);
  if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
  return { ownerId: task.owner_id, sessionId: task.session_id };
}

/**
 * 会话主图集 imageId 集（A5 冻结分配的审计面——会话首个 agent task 的 tasks.params
 * imageIds；缺席（W1 前存量/纯文本会话）=空=单图域缺省 image-1）。
 */
function sessionImageIdsOf(db: SqliteDb, sessionId: string): TaskImageId[] {
  const row = db
    .prepare("SELECT params FROM tasks WHERE session_id = ? AND type = 'agent' ORDER BY created_at ASC, rowid ASC LIMIT 1")
    .get(sessionId) as { params: string | null } | undefined;
  if (row === undefined || row.params === null) return [];
  try {
    const parsed = JSON.parse(row.params) as { imageIds?: unknown };
    if (!Array.isArray(parsed.imageIds)) return [];
    return parsed.imageIds.filter((id): id is TaskImageId => typeof id === 'string' && TaskImageIdSchema.safeParse(id).success);
  } catch {
    return [];
  }
}

/** imageId 解析：显式给=用之；省略=单图域缺省 image-1，多图域 typed 拒（B1 裁定）。 */
function resolveImageId(db: SqliteDb, sessionId: string, imageId: TaskImageId | undefined): TaskImageId {
  if (imageId !== undefined) return imageId;
  const imageIds = sessionImageIdsOf(db, sessionId);
  if (imageIds.length > 1) {
    throw new Error(`多图任务必须指定 imageId（会话主图集：${imageIds.join('、')}——每图独立三件套，不拼接）`);
  }
  return 'image-1';
}

/** 排钻真值 task 解析（B1：与当前 task 同 owner、同 session——跨会话引用必拒）。 */
function requireSourceTask(db: SqliteDb, calling: AgentTaskRef, sourceTaskId: string): void {
  if (calling.sessionId === null) throw new Error(`任务 ${sourceTaskId} 的会话不存在（导出以会话项目为锚）`);
  const source = agentTaskOf(db, sourceTaskId);
  if (source.ownerId !== calling.ownerId) throw new Error('sourceTaskId 与当前任务归属不符（跨用户导出必拒）');
  if (source.sessionId !== calling.sessionId) throw new Error('sourceTaskId 与当前任务不在同一会话（跨会话导出必拒）');
}

/**
 * task-layout 工件读回（latest-by-name 帧 → blob → TaskLayoutSchema 终验）。
 * 缺席=null（调用方 typed 拒）；损坏/不符契约=typed 拒（真源腐蚀不静默降级）。
 */
export function readTaskLayoutArtifact(
  deps: { blobs: BlobStore; config: AppConfig },
  sourceTaskId: string,
  imageId: TaskImageId,
): { layout: TaskLayout; blobRef: string } | null {
  const blobRef = latestTaskArtifactRefs(deps.config, sourceTaskId).get(taskLayoutArtifactName(imageId));
  if (blobRef === undefined) return null;
  const bytes = deps.blobs.read(blobRef);
  if (bytes === null) throw new Error(`task-layout 工件不可读（blobRef=${blobRef.slice(0, 12)}…）`);
  let parsed: ReturnType<typeof TaskLayoutSchema.safeParse>;
  try {
    parsed = TaskLayoutSchema.safeParse(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    throw new Error(
      `task-layout 工件不是合法 JSON（blobRef=${blobRef.slice(0, 12)}…）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed.success) {
    throw new Error(
      `task-layout 工件不符契约（blobRef=${blobRef.slice(0, 12)}…）：${parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return { layout: parsed.data, blobRef };
}

/** 按 proposal 绑定 ref 定版读回（内容寻址 blob 不可变——批准后策略重跑不漂移）。 */
function readTaskLayoutByRef(blobs: BlobStore, blobRef: string): TaskLayout {
  const bytes = blobs.read(blobRef);
  if (bytes === null) throw new Error(`proposal 绑定的 task-layout 不可读（blobRef=${blobRef.slice(0, 12)}…）`);
  return TaskLayoutSchema.parse(JSON.parse(bytes.toString('utf8')));
}

// ---------------------------------------------------------------- 导出适配器（B2）

/** layout → engine Gem[]（colorId=stoneRef——与 palette 键/BOM 行同键，见生成器冻结裁量）。 */
function engineGemsOf(layout: TaskLayout): Gem[] {
  return layout.gems.map((gem) => ({
    id: gem.id,
    x: gem.x,
    y: gem.y,
    colorId: gem.stoneRef,
    blockId: gem.blockId,
    shapeId: gem.shapeId,
    diameterMm: gem.diameterMm,
    ...(gem.rotationDeg !== undefined ? { rotationDeg: gem.rotationDeg } : {}),
    ...(gem.assetId !== undefined ? { assetId: gem.assetId } : {}),
  }));
}

/** layout.grid → engine GridSpec（pitchMm=baseSpec.diameterMm+gapMm——gridFromSpec 同构）。 */
function engineGridOf(layout: TaskLayout): GridSpec {
  return {
    pitchMm: layout.grid.baseSpec.diameterMm + layout.grid.gapMm,
    gapMm: layout.grid.gapMm,
    rowAngleDeg: 0,
    pixelsPerMm: layout.grid.pixelsPerMm,
  };
}

/**
 * [Owner 2026-10-03「按打印行业标准做高清导出」] 位面产物导出 DPI（env
 * EXPORT_DPI，缺省 300=印刷标准；下限 72 防误配负值/零除——非法回落缺省不静默
 * 漂移到图像处理分辨率）。
 */
function exportDpiOfEnv(): number {
  const raw = Number(process.env['EXPORT_DPI'] ?? '');
  if (!Number.isFinite(raw) || raw < 72) return 300;
  // [Codex P1-1 2026-10-03] 资源预算：DPI 硬上限（超限夹取——渲染平面 ∝ DPI²，
  // 无界=OOM 面）；像素总量护栏在缩放点校验（见 buildExportMatrix）。
  return Math.min(raw, 1200);
}

/** [Codex P1-1] 位面产物像素总量护栏（单平面 RGBA≈4B/px——64M px≈256MB 平面内存
 * 上界；超限显式拒，不静默降质）。 */
const EXPORT_MAX_PIXELS = 64_000_000;

/** layout.palette → engine Palette（键序确定性）。 */
function enginePaletteOf(layout: TaskLayout): Palette {
  return Object.entries(layout.palette)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([id, color]) => ({ id, name: color.name, hex: color.hex }));
}

/**
 * 掩膜块重建（B2「mask 不进 layout——导出门需要时按引用」）：按 layout.source.treeRef
 * 定版读回树工件 + treeToBlocks（与策略执行同一真值链）→ 带 mask 的 engine Block[]
 * （validate/exportGate 的 mask 面消费）。树工件损坏=typed 拒。
 */
function rebuildMaskedBlocks(deps: { blobs: BlobStore }, layout: TaskLayout): Block[] {
  const tree = loadObjectTreeArtifact(deps.blobs, layout.source.treeRef);
  const result = treeToBlocks(
    tree,
    { readBlob: (ref) => deps.blobs.read(ref) },
    { gemDiameterPx: layout.grid.baseSpec.diameterMm * layout.grid.pixelsPerMm },
  );
  if (!result.ok) {
    throw new Error(`task-layout 绑定树的掩膜重建失败（${result.reason}——treeRef 与工件不一致）`);
  }
  return result.blocks as unknown as Block[];
}

/**
 * BOM 行分组（**行号单源**——2026-10-02 导出矩阵）：按 stoneRef×规格快照分组，
 * 排序=数量降序 → stoneRef 字典序 → 规格升序（buildTaskBom 同式首键——本函数为
 * 唯一真源，BOM CSV 行序与 numbered.png 孔内编号/SVG 编号层 data-bom-row 严格一致，
 * 对账严丝合缝）。
 */
export interface TaskBomRowGroup {
  /** BOM 行号（1 起——CSV 数据行序/孔内编号）。 */
  row: number;
  stoneRef: string;
  diameterMm: number;
  count: number;
  supplier: string;
  sku: string;
  name: string;
  hex: string;
}

export function taskBomRowGroupsOf(layout: TaskLayout): TaskBomRowGroup[] {
  interface Row {
    count: number;
    supplier: string;
    sku: string;
    diameterMm: number;
    name: string;
    hex: string;
  }
  const rowsByKey = new Map<string, Row>();
  for (const gem of layout.gems) {
    const key = `${gem.stoneRef}\u0000${gem.diameterMm}`;
    const existing = rowsByKey.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      continue;
    }
    const paletteEntry = layout.palette[gem.stoneRef];
    rowsByKey.set(key, {
      count: 1,
      supplier: gem.supplier,
      sku: gem.sku,
      diameterMm: gem.diameterMm,
      name: paletteEntry?.name ?? `${gem.supplier}/${gem.sku}`,
      hex: gem.colorHex,
    });
  }
  const sorted = [...rowsByKey.entries()].sort((a, b) => {
    const byCount = b[1].count - a[1].count;
    if (byCount !== 0) return byCount;
    const refA = a[0].split('\u0000')[0]!;
    const refB = b[0].split('\u0000')[0]!;
    if (refA !== refB) return refA < refB ? -1 : 1;
    return a[1].diameterMm - b[1].diameterMm;
  });
  return sorted.map(([key, row], index) => {
    const stoneRef = key.split('\u0000')[0]!;
    return { row: index + 1, stoneRef, ...row };
  });
}

/**
 * 任务 BOM（B2 冻结）：daemon 适配器按 **stoneRef（×规格快照）** 聚合实际使用量——
 * supplier/SKU/规格（gem diameterMm 快照）/色名/hex/数量 + 备料参考列（manifest
 * quantity 对照；未引入=空清单无参考）。同规格同色不同供应商不合并成一行（engine
 * buildBom 的规格×色口径不具备——不冒充项目备料 BOM，仅作几何交叉核对）。
 * 表头/合计行与 engine buildBom 同形（UTF-8 BOM + CRLF——Excel 中文友好）。
 * P2-5（2026-09-28 复核）：quantity=0（集合缺省/手工追加物化的「未设置备料参考」）
 * 输出「未设置」——正数量才输出数字（0 会被误读成备料量为零）。
 * P2-3：manifestRevisionDrift 在场（layout 锚≠当前 manifest revision）=备料参考列
 * 全列输出「清单已更新（rev X→Y）」审计行——**不回放旧 manifest blob**（会话引用
 * 账本未保活历史版本，回放读不到也不该读——冻结裁量：以审计行明示漂移）。
 * 行序（2026-10-02）=taskBomRowGroupsOf 单源（与 numbered.png 编号对账一致）。
 */
export function buildTaskBom(
  layout: TaskLayout,
  manifest: StonesManifest | null,
  manifestRevisionDrift?: { from: number; to: number } | null,
): string {
  const driftText =
    manifestRevisionDrift !== undefined && manifestRevisionDrift !== null
      ? `清单已更新（rev ${manifestRevisionDrift.from}→${manifestRevisionDrift.to}）`
      : null;
  const quantityByRef = new Map((manifest?.entries ?? []).map((entry) => [entry.stoneRef, entry.quantity] as const));
  const groups = taskBomRowGroupsOf(layout);
  const firstRowByRef = new Set<string>();
  const bomRows: Array<TaskBomRowGroup & { reference: string }> = [];
  for (const group of groups) {
    // 备料参考：漂移审计行优先（P2-3——layout 锚 revision ≠ 当前，不回放旧 blob）；
    // 同 stoneRef 多规格行只首行给值（避免重复计数）；未引入=「未引入」；
    // quantity=0=「未设置」（P2-5）；正数量才数字。
    const reference =
      driftText !== null
        ? driftText
        : quantityByRef.has(group.stoneRef)
          ? firstRowByRef.has(group.stoneRef)
            ? ''
            : quantityByRef.get(group.stoneRef) === 0
              ? '未设置'
              : String(quantityByRef.get(group.stoneRef))
          : '未引入';
    firstRowByRef.add(group.stoneRef);
    bomRows.push({ ...group, reference });
  }
  const out: string[] = ['供应商,SKU,规格,色名,hex,数量,备料参考'];
  for (const row of bomRows) {
    out.push(
      `${row.supplier},${row.sku},${row.diameterMm}mm,${row.name},${row.hex},${row.count},${row.reference}`,
    );
  }
  out.push(`合计,,,,,${layout.gems.length},`);
  return '\uFEFF' + out.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- 贴图渲染接线（2026-10-02）

/**
 * stoneRef → 钻库贴图字节源（效果图渲染的物料面）：resolveStoneRef 四态门
 * （resolved 才有贴图——pending/软删/wrong-kind/blob-missing=null）+
 * stoneSourceBlobRefsOf 内容寻址 + blob 可读性。null=渲染面降级色点+warnings
 * 明示（贴图缺失款——不静默）。alphaBounds 随行（主径/纵横比换算源）。
 */
export function stoneTextureResolverOf(stones: StoneService, blobs: BlobStore): ResolveStoneTexture {
  return (stoneRef) => {
    const resolution = stones.resolveStoneRef(stoneRef);
    if (resolution.state !== 'resolved' || resolution.stone === undefined) return null;
    const { textureBlobRef } = stones.stoneSourceBlobRefsOf(stoneRef);
    if (textureBlobRef === null) return null;
    const bytes = blobs.read(textureBlobRef);
    if (bytes === null) return null;
    return { blobRef: textureBlobRef, bytes, alphaBounds: resolution.stone.texture.alphaBounds };
  };
}

/** 渲染结果 → warnings（缺图/解码失败降级明示——两类分列，颗数与款号对账）。 */
function textureRenderWarningsOf(result: RenderGemsTextureResult): string[] {
  const warnings: string[] = [];
  if (result.missingStoneRefs.length > 0) {
    warnings.push(
      `render.png 效果图：${result.fallbackMissingCount} 颗用色点占位（贴图缺失款：${result.missingStoneRefs.join('、')}）——该款钻尚无可用贴图（pending/引用不可达），补齐贴图后重新导出即得照片级效果`,
    );
  }
  if (result.undecodableStoneRefs.length > 0) {
    warnings.push(
      `render.png 效果图：${result.fallbackUndecodableCount} 颗用色点占位（贴图解码失败款：${result.undecodableStoneRefs.join('、')}）——入库贴图字节损坏（隔行/截断/色型不支持），需重新入库该款贴图`,
    );
  }
  return warnings;
}

/**
 * propose 面降级预告（不渲染——只解析 stoneRef 引用态，颗数按 layout 快照预算）：
 * 审批前明示「批准后 render.png 会有多少颗是色点占位」，避免批准后才发现效果图降级。
 */
function textureFallbackPreviewOf(resolver: ResolveStoneTexture, layout: TaskLayout): string[] {
  const builtinGems = layout.gems.filter((gem) => gem.shapeId !== 'custom');
  const missingRefs = new Set<string>();
  for (const gem of builtinGems) {
    if (resolver(gem.stoneRef) === null) missingRefs.add(gem.stoneRef);
  }
  if (missingRefs.size === 0) return [];
  const count = builtinGems.filter((gem) => missingRefs.has(gem.stoneRef)).length;
  return [
    `render.png 效果图：${count} 颗将用色点占位（贴图缺失款：${[...missingRefs].sort().join('、')}）——该款钻尚无可用贴图，批准后 render.png 对应钻位为示意色点`,
  ];
}

// ---------------------------------------------------------------- 门面（三门 + lint）

/** 导出门结果（B4 阻断矩阵的单一表述）：blockers 空=放行。 */
interface ExportGateOutcome {
  ok: boolean;
  /** 硬阻断清单（mask 门 blockers + lint unresolvable + engine exportGate violations）。 */
  blockers: string[];
  /** 非阻断警告（lint unintroduced + engine validate warnings）。 */
  warnings: string[];
  lint: StoneLintResult | null;
}

/**
 * 三门重算（propose 与 execute 共用——studio.export「gate 复验」同纪律）：
 *   [1] workbench mask 门（exportGateOf——mask-incomplete/stale/recompute-error，
 *       B4.7 各自命中 hard blocker）；
 *   [2] lint 重算（A3 导出前重算：unresolvable=hard；unintroduced=warning 不阻断——
 *       偏差 2；manifest 只增不减，revision 漂移=审计面不阻断）；
 *   [3] engine exportGate（spacing/mask violation/missing-asset 安全门）+ validate
 *       （warnings 面——engine 校验经公共出口对照，非抄录）。
 */
function runExportGates(
  deps: { db: SqliteDb; blobs: BlobStore; config: AppConfig },
  input: { sessionId: string; sourceTaskId: string; layout: TaskLayout },
): ExportGateOutcome {
  const blockers: string[] = [];
  const warnings: string[] = [];
  // [1] mask 门（sourceTask 的 mask_edit_states 真源重算——rpc taskExport 同门）。
  const maskGate = exportGateOf(maskEditStatusesOf(deps.db, input.sourceTaskId));
  if (!maskGate.allowed) {
    blockers.push(`mask 门阻断（${maskGate.blockers.join(', ')}）——先在排钻工作台解决遮罩编辑告警`);
  }
  // [2] lint 重算（P2-3——2026-09-28 复核：**按 layout.source.planRef 定版读回**
  //   该 plan 计算，不读全 task 最新 strategy-plan.json——策略重跑后旧 layout 的
  //   门不漂移到新 plan 口径；unresolvable=hard；unintroduced=warning 不阻断——
  //   偏差 2；manifest 只增不减，revision 漂移=审计面不阻断）。null=无
  //   session-project 行（layout 在场 ⇒ 项目行必在——状态不一致拒）。
  let lint: StoneLintResult | null = null;
  const linted = lintTaskStoneRefsByPlanRef(
    deps,
    {
      sessionId: input.sessionId,
      sourceTaskId: input.sourceTaskId,
      imageId: input.layout.source.imageId,
      planRef: input.layout.source.planRef,
    },
  );
  if (linted === null) {
    blockers.push('lint 无数据源（会话无项目钻清单行——与 task-layout 在场矛盾，状态不一致）');
  } else {
    lint = linted.result;
    const unresolved = linted.result.items.filter((item) => item.category === 'unresolvable');
    for (const item of unresolved) {
      blockers.push(`lint 硬错：stoneRef ${item.stoneRef} 不可解析（库外/软删——不能靠添加清单消除）`);
    }
    for (const item of linted.result.items.filter((entry) => entry.category === 'unintroduced')) {
      warnings.push(
        `lint 警告：stoneRef ${item.stoneRef}（${item.supplier ?? '?'}/${item.sku ?? '?'}）未引入项目清单——先与用户确认，经 studio.task.stones.add 纳入（不阻断导出）`,
      );
    }
  }
  // [3] engine validate（warnings）+ exportGate（安全门——spacing/mask violation/missing-asset）。
  const gems = engineGemsOf(input.layout);
  const grid = engineGridOf(input.layout);
  const blocks = rebuildMaskedBlocks(deps, input.layout);
  for (const warning of validate(gems, grid, blocks)) {
    warnings.push(`engine validate：${warning.kind}——${warning.detail}`);
  }
  const verdict = exportGate(gems, {
    grid,
    blocks,
    resolveShapeAsset: (assetId: string) => resolveShapeAssetStateOf(deps.blobs, input.layout.shapeAssets, assetId),
  });
  if (!verdict.ok) {
    blockers.push(
      `exportGate 阻断（${verdict.violations.length} 项违规）：${verdict.violations
        .map((violation) => `[${violation.kind}] ${violation.detail}`)
        .join('；')}`,
    );
  }
  return { ok: blockers.length === 0, blockers, warnings, lint };
}

// ---------------------------------------------------------------- 工具面构造

export interface TaskExportCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  config: AppConfig;
  /** 帧提交单点（approval-request/artifact/transcript——任务域工具必需）。 */
  jobs?: JobService;
  /** §3.6 授权桥（approved-mutation 面；缺省=一律 principal-forbidden）。 */
  approvals?: ApprovalService;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

export function createTaskExportCapabilities(deps: TaskExportCapabilitiesDeps): CapabilityRegistry {
  const streaks = new Map<string, { key: string; count: number }>();
  // 效果图贴图解析器（StoneService 无状态只读面——project-lint 内联先例同款）。
  const stoneTextureResolver = stoneTextureResolverOf(
    new StoneService({ db: deps.db, blobs: deps.blobs }),
    deps.blobs,
  );

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

  function bucketOf(input: unknown): string {
    const taskId = (input as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : 'global';
  }

  function failedOf(reason: ConsumeDenyReason | string, message: string): CapabilityCallResult {
    const code =
      reason === 'stale-revision' ? ('STALE' as const) : reason === 'concurrent' ? ('CONFLICT' as const) : ('INVALID_OPERATION' as const);
    return { kind: 'failed', code, message };
  }

  function isExecuteMode<T extends { proposalId?: string }>(parsed: T): parsed is T & { proposalId: string } {
    return parsed.proposalId !== undefined;
  }

  /** 审批卡/结果的解析来源标签（P0 会话域缺省锚——人类可读审计面）。 */
  function sourceResolutionLabelOf(resolution: NonNullable<TaskExportPayload['sourceResolution']>): string {
    if (resolution === 'session-latest') return '会话延续·上轮排钻成果';
    if (resolution === 'current-task') return '本轮任务';
    return '显式锚';
  }

  function payloadOf(op: ApprovedOpRow): Record<string, unknown> {
    try {
      return JSON.parse(op.payload_json as string) as Record<string, unknown>;
    } catch {
      throw new Error(`proposal 载荷不可解析：${op.proposal_id}`);
    }
  }

  /** proposal 载荷结构（propose/execute 两端共用约束）。 */
  interface TaskExportPayload {
    kind: 'task-export';
    sessionId: string;
    sourceTaskId: string;
    imageId: TaskImageId;
    taskLayoutRef: string;
    manifestRevision: number;
    /**
     * sourceTaskId 解析来源（P0 会话域缺省锚——2026-10-01 审计面）：explicit=调用方
     * 显式指定；current-task=缺省解析落在当前 taskId（同轮导出）；session-latest=
     * 缺省解析命中会话内更早轮次的工件（多轮延续）。可选=存量 proposal 兼容。
     */
    sourceResolution?: 'explicit' | 'current-task' | 'session-latest';
  }

  function parsePayload(raw: Record<string, unknown>): TaskExportPayload {
    if (
      raw['kind'] !== 'task-export' ||
      typeof raw['sessionId'] !== 'string' ||
      typeof raw['sourceTaskId'] !== 'string' ||
      typeof raw['imageId'] !== 'string' ||
      typeof raw['taskLayoutRef'] !== 'string' ||
      typeof raw['manifestRevision'] !== 'number'
    ) {
      throw new Error('proposal 载荷不完整（kind/sessionId/sourceTaskId/imageId/taskLayoutRef/manifestRevision——数据不一致）');
    }
    const imageId = TaskImageIdSchema.safeParse(raw['imageId']);
    if (!imageId.success) throw new Error(`proposal 载荷 imageId 非法：${raw['imageId']}`);
    const sourceResolution =
      raw['sourceResolution'] === 'explicit' || raw['sourceResolution'] === 'current-task' || raw['sourceResolution'] === 'session-latest'
        ? raw['sourceResolution']
        : undefined;
    return {
      kind: 'task-export',
      sessionId: raw['sessionId'],
      sourceTaskId: raw['sourceTaskId'],
      imageId: imageId.data,
      taskLayoutRef: raw['taskLayoutRef'],
      manifestRevision: raw['manifestRevision'],
      ...(sourceResolution !== undefined ? { sourceResolution } : {}),
    };
  }

  /**
   * 会话输入图解析（SVG #source 原图层——A5 主图集审计真源，task-images 同源）：
   * imageId→blobRef→原始字节→dataUrl（png/jpeg）。不可达（无图集/blob 缺席/非
   * png-jpeg）=null→占位层（SVG 结构完整，原图参考 render.png/任务附件）。
   */
  function sourceImageOfSession(sessionId: string, imageId: TaskImageId): { mime: string; dataUrl: string } | null {
    const imageSet = sessionImageSet(deps.db, sessionId);
    if (imageSet === null) return null;
    const index = imageSet.imageIds.indexOf(imageId);
    if (index < 0) return null;
    const bytes = deps.blobs.read(imageSet.attachments[index]!);
    if (bytes === null) return null;
    const mime = sniffImageMime(bytes);
    if (mime !== 'image/png' && mime !== 'image/jpeg') return null;
    return { mime, dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}` };
  }

  /** 导出矩阵产物构造（纯函数面——同一 task-layout 快照产五产物；门已由调用方复验）。 */
  function buildExportMatrix(
    layout: TaskLayout,
    manifest: StonesManifest | null,
    manifestRevisionDrift: { from: number; to: number } | null,
    sourceImage: { mime: string; dataUrl: string } | null,
  ): {
    svg: string;
    png: Uint8Array;
    bom: string;
    holes: Uint8Array;
    numbered: Uint8Array;
    /** 贴图渲染降级 warnings（execute 结果面——缺图色点占位明示）。 */
    renderWarnings: string[];
    /** SVG 原图层形态（embedded/超限占位/不可达占位——结果面审计）。 */
    svgSourceLayer: 'embedded' | 'oversize-placeholder' | 'missing-placeholder';
  } {
    const gems = engineGemsOf(layout);
    const grid = engineGridOf(layout);
    const palette = enginePaletteOf(layout);
    // [Owner 2026-10-03「按打印行业标准做高清导出」] 位面产物打印分辨率：EXPORT_DPI
    //（缺省 300=印刷行业标准；env 可调）换算 px/mm，统一缩放 k 代入 gems/grid/宽高
    // ——坐标系纯物理口径（位置=网格像素、孔径=diameterMm×pixelsPerMm），同比缩放
    // 不改变布局语义；此前直接用 layout 画布像素=SAM 图像处理分辨率（400px 级），
    // 打印口径过低。SVG 矢量无量纲不动；numbered 图例/字号全相对量纲随画布同比。
    const exportDpi = exportDpiOfEnv();
    const pxPerMmPrint = exportDpi / 25.4;
    const printScale = pxPerMmPrint / layout.grid.pixelsPerMm;
    const printGems = printScale === 1 ? gems : gems.map((gem) => ({ ...gem, x: gem.x * printScale, y: gem.y * printScale }));
    const printGrid = { ...grid, pixelsPerMm: pxPerMmPrint };
    const printWidth = Math.round(layout.imageWidth * printScale);
    const printHeight = Math.round(layout.imageHeight * printScale);
    if (printWidth * printHeight > EXPORT_MAX_PIXELS) {
      throw new Error(
        `打印导出像素超限（${printWidth}×${printHeight} > ${EXPORT_MAX_PIXELS}——EXPORT_DPI=${exportDpi} 请调低）`,
      );
    }
    // 行号单源（BOM CSV 行序=numbered 编号=SVG data-bom-row——对账严丝合缝）。
    const bomRows = taskBomRowGroupsOf(layout).map((group) => ({
      row: group.row,
      stoneRef: group.stoneRef,
      name: group.name,
      hex: group.hex,
      count: group.count,
      diameterMm: group.diameterMm,
    }));
    // SVG=四层化（source/holes/numbers/gems——CorelDRAW 下游编辑友好）。
    const layered = buildLayeredSvg({
      gems,
      palette,
      grid,
      width: layout.imageWidth,
      height: layout.imageHeight,
      rows: bomRows,
      resolveStoneTexture: stoneTextureResolver,
      resolveAsset: assetResolverOf(deps.blobs, layout.shapeAssets),
      sourceImage,
    });
    // render.png=效果图（2026-10-02 口径）：钻库贴图按位合成（2× 超采样）；
    // 缺贴图款降级 colorHex 色点——renderWarnings 明示（不静默）。
    const rendered = renderGemsTexturePng({
      gems: printGems,
      palette,
      grid: printGrid,
      width: printWidth,
      height: printHeight,
      resolveStoneTexture: stoneTextureResolver,
      resolveAsset: assetResolverOf(deps.blobs, layout.shapeAssets),
    });
    // holes.png=黑点模板（挖孔形态——刻膜/定位；孔形按钻形，孔径 1:1）。
    const holes = renderHoleTemplatePng({
      gems: printGems,
      grid: printGrid,
      width: printWidth,
      height: printHeight,
      resolveAsset: assetResolverOf(deps.blobs, layout.shapeAssets),
    });
    // numbered.png=编号工作图（挖孔+编号+图例——数字油画打法，编号=BOM 行号）。
    // 图例格=钻库贴图缩略（走查 2026-10-02——与 render.png 同一 resolver；无贴图
    // 款回退色点）。
    const numbered = renderNumberedSheetPng({
      gems: printGems,
      palette,
      grid: printGrid,
      width: printWidth,
      height: printHeight,
      rows: bomRows,
      resolveAsset: assetResolverOf(deps.blobs, layout.shapeAssets),
      resolveStoneTexture: stoneTextureResolver,
    });
    const bom = buildTaskBom(layout, manifest, manifestRevisionDrift);
    return {
      svg: layered.svg,
      png: rendered.png,
      bom,
      holes: holes.png,
      numbered: numbered.png,
      renderWarnings: textureRenderWarningsOf(rendered),
      svgSourceLayer: layered.sourceLayer,
    };
  }

  /**
   * BOM 备料参考的 manifest 解析（P2-3——锚定 layout.source.manifestRevision）：
   * 当前 revision 与 layout 锚一致 → 读当前 manifest blob；不一致 → **不回放旧
   * manifest blob**（会话引用账本未保活历史版本——冻结裁量），返回漂移对交
   * buildTaskBom 输出「清单已更新（rev X→Y）」审计行。无项目行=manifest null
   * （备料列「未引入」——既有语义）。
   */
  function manifestForBomAnchor(
    sessionId: string,
    layout: TaskLayout,
  ): { manifest: StonesManifest | null; drift: { from: number; to: number } | null } {
    const row = getSessionProject(deps.db, sessionId);
    if (row === null) return { manifest: null, drift: null };
    if (row.revision === layout.source.manifestRevision) {
      const bytes = deps.blobs.read(row.blob_ref);
      if (bytes === null) throw new Error(`manifest blob 不可读（blobRef=${row.blob_ref.slice(0, 12)}…）`);
      return { manifest: JSON.parse(bytes.toString('utf8')) as StonesManifest, drift: null };
    }
    return { manifest: null, drift: { from: layout.source.manifestRevision, to: row.revision } };
  }

  const definitions: CapabilityDefinition[] = [
    {
      name: TASK_EXPORT_TOOL_NAME,
      description:
        '任务导出（approved-mutation 双模——B1：一个逻辑工具，恒产该图导出矩阵五产物：四层 SVG（原图/黑点/编号/贴图替换）'
        + '+效果图 PNG+BOM+黑点模板 holes.png（挖孔——刻膜/定位）+编号工作图 numbered.png（孔内编号=BOM 行号+图例））。'
        + '发起={taskId, sourceTaskId?, imageId?, expectedManifestRevision?}（sourceTaskId 缺省=本会话最近一次成功落档的'
        + '该图 task-layout——多轮会话自动延续上轮排钻成果；显式指定=精确锚，须同 owner 同会话。服务端重算 lint+几何校验+导出门，'
        + '返回产物摘要/警告与 approval request——unintroduced=警告不阻断，库外/软删/mask/spacing 违规=硬阻断）；'
        + 'autoApprove 会话：发起返回 autoApproved=true+「立即执行」指令时立即以 {taskId, proposalId} 调用执行（勿等待用户）；'
        + '执行={taskId, proposalId}（消费 grant，按 proposal 绑定的 task-layout 快照产导出矩阵分享 bundle+/r/ 链接+'
        + '任务帧五产物）。单图可省 imageId；**多图任务当前版本逐图排钻未贯通——每张图请单独会话**'
        + '（非 image-1 的 imageId=typed 拒；per-image 贯通=后续波）。'
        + '导出前若无 task-layout.<imageId>.json（策略未执行或生成被拒——多候选物料节点/自定义形），'
        + '先完成/修正策略执行（改为每节点恰一款钻）。',
      authority: 'approved-mutation' as const,
      input: ExportInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ExportInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(
            bucket,
            TASK_EXPORT_TOOL_NAME,
            `参数不合法（双模：发起={taskId[,sourceTaskId][,imageId][,expectedManifestRevision]} 或 执行={taskId,proposalId}）：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        const p = parsed.data;
        try {
          // ================================================================ propose 模式
          if (!isExecuteMode(p)) {
            if (p.sourceTaskId !== undefined && p.sourceTaskId === p.taskId) {
              throw new Error('sourceTaskId 与 taskId 相同时省略该参数（不需要显式自指）');
            }
            const task = agentTaskOf(deps.db, p.taskId);
            if (task.sessionId === null) {
              throw new Error(`任务 ${p.taskId} 不属于任何会话——导出以会话项目为锚（A1），无项目语义`);
            }
            const imageId = resolveImageId(deps.db, task.sessionId, p.imageId);
            const layoutName = taskLayoutArtifactName(imageId);
            // —— 源任务解析（P0 会话域缺省锚——2026-10-01）：
            //    显式 sourceTaskId=精确锚（requireSourceTask 同 owner 同会话校验——
            //    行为不变）；缺省=本会话（同 owner）最近一次成功落档的
            //    task-layout.<imageId>.json（latestSessionArtifactAnchor 单源）——
            //    多轮会话每轮换绑新 taskId，旧缺省「当前 taskId」对不上轮工件=
            //    「资源不存在」终点不可达；当前 taskId 亦为会话成员，同轮导出解析
            //    天然落回自身（ts 最新），行为零漂移。
            let sourceTaskId: string;
            let sourceResolution: TaskExportPayload['sourceResolution'];
            let found: { layout: TaskLayout; blobRef: string } | null;
            if (p.sourceTaskId !== undefined) {
              requireSourceTask(deps.db, task, p.sourceTaskId);
              sourceTaskId = p.sourceTaskId;
              sourceResolution = 'explicit';
              found = readTaskLayoutArtifact(deps, sourceTaskId, imageId);
              if (found === null) {
                // P1-1（多图未贯通——精确锚语境保持任务域文案）。
                if (sessionImageIdsOf(deps.db, task.sessionId).length > 1) {
                  throw new Error(
                    `任务 ${sourceTaskId} 尚无 ${layoutName} 渲染快照——当前版本逐图排钻未贯通`
                    + '（策略与 task-layout 生产链单图 image-1，每张图请单独会话；per-image 贯通=后续波）',
                  );
                }
                // P2-6：策略已执行但 layout 缺席=生成器曾拒（重跑策略前无物可批）。
                if (latestTaskArtifactRefs(deps.config, sourceTaskId).has('strategy-plan.json')) {
                  throw new Error(
                    `任务 ${sourceTaskId} 曾执行策略但无 ${layoutName} 渲染快照——生成器曾拒：`
                    + '该计划含多候选物料节点/自定义形——当前不支持导出，请改为每节点恰一款钻后重跑策略',
                  );
                }
                throw new Error(
                  `任务 ${sourceTaskId} 尚无 ${layoutName} 渲染快照——先完成策略执行`
                  + '（studio.strategy.design 执行/layer.strategy.set 直改即同链生成）',
                );
              }
            } else {
              const anchor = latestSessionArtifactAnchor(
                { db: deps.db, config: deps.config },
                { sessionId: task.sessionId, ownerId: task.ownerId, name: layoutName },
              );
              if (anchor === null) {
                // 会话域 typed 可读错误（缺省锚语境——不再指认单个任务）：三轮排除
                // 与显式锚同构（多图未贯通/策略曾执行但生成器拒/从未排钻）。
                if (sessionImageIdsOf(deps.db, task.sessionId).length > 1) {
                  throw new Error(
                    `本会话尚无 ${layoutName} 渲染快照——当前版本逐图排钻未贯通`
                    + '（策略与 task-layout 生产链单图 image-1，每张图请单独会话；per-image 贯通=后续波）',
                  );
                }
                if (
                  latestSessionArtifactAnchor(
                    { db: deps.db, config: deps.config },
                    { sessionId: task.sessionId, ownerId: task.ownerId, name: 'strategy-plan.json' },
                  ) !== null
                ) {
                  throw new Error(
                    `本会话曾执行策略但无 ${layoutName} 渲染快照——生成器曾拒：`
                    + '该计划含多候选物料节点/自定义形——当前不支持导出，请改为每节点恰一款钻后重跑策略',
                  );
                }
                throw new Error(
                  `本会话尚无可导出的布局（${layoutName}）——先完成一轮排钻`
                  + '（studio.strategy.design 执行/layer.strategy.set 直改即同链生成）',
                );
              }
              sourceTaskId = anchor.taskId;
              sourceResolution = anchor.taskId === p.taskId ? 'current-task' : 'session-latest';
              found = readTaskLayoutArtifact(deps, sourceTaskId, imageId);
              if (found === null) {
                // 防御不可达（锚在=帧在，latest-by-name 同帧扫描必同命中）——不静默。
                throw new Error(`会话锚定任务 ${sourceTaskId} 的 ${layoutName} 解析失败（帧/工件状态不一致）`);
              }
            }
            const layout = found.layout;
            if (layout.source.imageId !== imageId) {
              throw new Error(`task-layout 工件 imageId 锚不符（${layout.source.imageId} ≠ ${imageId}——帧名与内容不一致）`);
            }
            // —— 可选 manifest CAS 基线（B1「可带 expectedManifestRevision」——漂移=STALE）。
            const projectRow = getSessionProject(deps.db, task.sessionId);
            if (projectRow === null) {
              throw new Error('会话尚无项目钻清单（task-layout 在场则必有——状态不一致）');
            }
            if (p.expectedManifestRevision !== undefined && p.expectedManifestRevision !== projectRow.revision) {
              return {
                kind: 'failed',
                code: 'STALE',
                message: `manifest revision CAS 基线漂移：expected=${p.expectedManifestRevision} current=${projectRow.revision}——以 currentRevision=${projectRow.revision} 重新发起`,
              };
            }
            // —— 三门重算（阻断矩阵——B4.7）。
            const gates = runExportGates(deps, { sessionId: task.sessionId, sourceTaskId, layout });
            if (!gates.ok) {
              return {
                kind: 'failed',
                code: 'INVALID_OPERATION',
                message: `导出被门阻（${gates.blockers.length} 项）：\n${gates.blockers.join('\n')}`,
              };
            }
            // —— 产物摘要（B1：返回产物摘要+warning+approval request）。
            // P2-3：manifestRevision 锚=layout.source.manifestRevision（定版 layout 的
            // 清单锚——非当前 projectRow.revision；批准后清单演进不漂移 bundle 审计）。
            const anchorRevision = layout.source.manifestRevision;
            const bomSource = manifestForBomAnchor(task.sessionId, layout);
            const bom = buildTaskBom(layout, bomSource.manifest, bomSource.drift);
            const bomRowCount = bom.trimEnd().split('\r\n').length - 2; // 表头+合计 之外
            const materials = Object.entries(layout.palette)
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([stoneRef, color]) => ({ stoneRef, name: color.name, hex: color.hex }));
            const issued = requireApprovals().propose({
              taskId: p.taskId,
              userId: task.ownerId,
              tool: TASK_EXPORT_TOOL_NAME,
              payload: {
                kind: 'task-export',
                sessionId: task.sessionId,
                sourceTaskId,
                imageId,
                taskLayoutRef: found.blobRef,
                manifestRevision: anchorRevision,
                // P0 审计面：解析来源随 proposal 绑定（execute 结果回放同字段）。
                sourceResolution,
              },
              preview: { before: found.blobRef, after: found.blobRef },
              summary:
                `任务导出 ${imageId}：${layout.gems.length} 钻 / ${materials.length} 款物料 / BOM ${bomRowCount} 行`
                + `（导出矩阵五产物：四层 SVG+效果图 PNG+BOM+黑点模板 holes.png+编号工作图 numbered.png——源 task ${sourceTaskId.slice(0, 8)}…[${sourceResolutionLabelOf(sourceResolution)}]·manifest v${anchorRevision}）`
                + (gates.warnings.length > 0 ? `·${gates.warnings.length} 条警告（不阻断）` : ''),
            });
            noteSuccess(bucket);
            // 贴图降级预告（不渲染——引用态解析；批准前明示效果图将有色点占位）。
            const texturePreview = textureFallbackPreviewOf(stoneTextureResolver, layout);
            return {
              kind: 'ok',
              value: {
                proposalId: issued.proposalId,
                requestId: issued.requestId,
                expiresAt: issued.expiresAt,
                summary: {
                  imageId,
                  sourceTaskId,
                  sourceResolution,
                  gemCount: layout.gems.length,
                  materials,
                  bomRowCount,
                  image: { width: layout.imageWidth, height: layout.imageHeight },
                  anchors: { taskLayoutRef: found.blobRef, manifestRevision: anchorRevision },
                },
                lint: gates.lint,
                warnings: [
                  ...(bomSource.drift !== null
                    ? [
                        `manifest revision 漂移（layout 锚 v${bomSource.drift.from} → 当前 v${bomSource.drift.to}）`
                        + `——BOM 备料参考列输出「清单已更新（rev ${bomSource.drift.from}→${bomSource.drift.to}）」审计行（不回放旧 manifest，不阻断）`,
                      ]
                    : []),
                  ...texturePreview,
                  ...gates.warnings,
                ],
                // iter-1 Codex 审查修复①（免值守链末端）：approvalFaceOf——autoApprove
                // 会话透传 autoApproved=true+「立即执行」指令（studio/stones/sets 同款）；
                // 手动路径 pending 文案原样。
                ...approvalFaceOf(issued, '等待用户批准（approval-request 已入任务帧流）——批准后以 {taskId, proposalId} 执行'),
              },
            };
          }
          // ================================================================ execute 模式
          if (p.sourceTaskId !== undefined || p.imageId !== undefined || p.expectedManifestRevision !== undefined) {
            throw new Error('执行模式只带 {taskId, proposalId}（propose 字段与 proposalId 互斥）');
          }
          const approvals = requireApprovals();
          const task = agentTaskOf(deps.db, p.taskId);
          if (task.sessionId === null) throw new Error(`任务 ${p.taskId} 不属于任何会话（数据不一致）`);
          const consume = approvals.consumeForExecution({
            proposalId: p.proposalId,
            taskId: p.taskId,
            userId: task.ownerId,
            tool: TASK_EXPORT_TOOL_NAME,
          });
          if (!consume.ok) return failedOf(consume.reason, consume.message);
          const payload = parsePayload(payloadOf(consume.op));
          if (task.sessionId !== payload.sessionId) {
            throw new Error(
              `proposal 载荷会话绑定漂移（${payload.sessionId} ≠ 任务会话 ${task.sessionId}）——重新发起提案`,
            );
          }
          // —— 定版快照读回（proposal 绑定 taskLayoutRef——内容寻址不可变）+ 门复验。
          const layout = readTaskLayoutByRef(deps.blobs, payload.taskLayoutRef);
          const gates = runExportGates(deps, { sessionId: payload.sessionId, sourceTaskId: payload.sourceTaskId, layout });
          if (!gates.ok) {
            approvals.settleExternal(consume.op.proposal_id, {
              kind: 'failed',
              message: `导出门复验阻断：${gates.blockers.join('；')}`,
            });
            return {
              kind: 'failed',
              code: 'INVALID_OPERATION',
              message: `导出被门阻（批准期间状态漂移，${gates.blockers.length} 项）：\n${gates.blockers.join('\n')}`,
            };
          }
          const bomSource = manifestForBomAnchor(payload.sessionId, layout);
          // SVG #source 原图层输入图（A5 主图集审计真源——不可达=占位层）。
          const sourceImage = sourceImageOfSession(payload.sessionId, payload.imageId);
          const matrix = buildExportMatrix(layout, bomSource.manifest, bomSource.drift, sourceImage);
          // P2-3：漂移=审计行（BOM 备料列「清单已更新（rev X→Y）」——不回放旧
          // manifest blob；bundle source 审计字段仍=proposal 绑定的 layout 锚）。
          const manifestDrift =
            bomSource.drift !== null
              ? `manifest revision 漂移（layout 锚 v${bomSource.drift.from} → 当前 v${bomSource.drift.to}）`
                + `——BOM 备料参考列输出「清单已更新（rev ${bomSource.drift.from}→${bomSource.drift.to}）」审计行（不回放旧 manifest，不阻断）`
              : null;
          // —— bundle 发布（withinCommit=op 结算同事务——studio.export P1-3 恰好一次同款）。
          const bundle = createShareBundle(
            { config: deps.config, db: deps.db, blobs: deps.blobs },
            {
              taskId: p.taskId,
              ownerId: task.ownerId,
              title: `任务导出 ${payload.imageId}（${layout.gems.length} 钻）`,
              files: {
                svg: Buffer.from(matrix.svg, 'utf8'),
                bom: Buffer.from(matrix.bom, 'utf8'),
                png: matrix.png,
                holes: matrix.holes,
                numbered: matrix.numbered,
                // [2026-10-03 Owner 需求「混合原图下载」] 原图字节随 bundle 永久留存
                // （分享页混合预览数据源；dataUrl 剥头 base64 还原——与 sourceImageOfSession
                // 读到的原始字节逐字节同源）。
                ...(sourceImage !== null
                  ? { source: new Uint8Array(Buffer.from(sourceImage.dataUrl.split(',')[1] ?? '', 'base64')) }
                  : {}),
              },
              source: {
                sourceTaskId: payload.sourceTaskId,
                imageId: payload.imageId,
                taskLayoutRef: payload.taskLayoutRef,
                manifestRevision: payload.manifestRevision,
              },
              withinCommit: (committed) =>
                approvals.settleExternal(consume.op.proposal_id, { kind: 'succeeded', resultRef: committed.resultId }),
            },
          );
          // —— artifact 帧五条（任务详情/下载面按 imageId 定位；blobRef=bundle 五元组）。
          const names = taskExportArtifactNames(payload.imageId);
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.svg, name: names.svg });
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.png, name: names.png });
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.bom, name: names.bom });
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.holes, name: names.holes });
          deps.jobs?.emitFor(p.taskId, 'artifact', { blobRef: bundle.blobRefs.numbered, name: names.numbered });
          deps.jobs?.emitFor(p.taskId, 'transcript', {
            role: 'tool',
            text: `任务导出完成（${payload.imageId}）：分享链接 /r/${bundle.publicId}（导出矩阵五产物：四层 SVG+效果图 PNG+BOM+黑点模板+编号工作图）`,
          });
          // 贴图降级警示帧（效果图有色点占位——任务流可见，不静默）。
          if (matrix.renderWarnings.length > 0) {
            deps.jobs?.emitFor(p.taskId, 'transcript', {
              role: 'tool',
              text: matrix.renderWarnings.join('\n'),
            });
          }
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              resultId: bundle.resultId,
              publicId: bundle.publicId,
              bundle: bundle.blobRefs,
              source: {
                sourceTaskId: payload.sourceTaskId,
                imageId: payload.imageId,
                taskLayoutRef: payload.taskLayoutRef,
                manifestRevision: payload.manifestRevision,
                ...(payload.sourceResolution !== undefined
                  ? { sourceResolution: payload.sourceResolution }
                  : {}),
              },
              warnings: [
                ...(manifestDrift !== null ? [manifestDrift] : []),
                ...matrix.renderWarnings,
                ...(matrix.svgSourceLayer !== 'embedded'
                  ? [
                      matrix.svgSourceLayer === 'oversize-placeholder'
                        ? 'SVG 原图层降级占位：输入图 base64 超过 2MB 上限未内嵌（四层结构完整——对位参考 render.png 与任务原图附件）'
                        : 'SVG 原图层降级占位：会话主图集输入图不可达（四层结构完整——对位参考 render.png）',
                    ]
                  : []),
                ...gates.warnings,
              ],
              download: `/r/${bundle.publicId}`,
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_EXPORT_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: TASK_EXPORTS_LIST_TOOL_NAME,
      description:
        '任务导出历史（只读——B3.5）：按当前任务所属会话列出全部导出 result（每图导出矩阵 bundle——五产物'
        + ' SVG/PNG/BOM/holes/numbered），可按 imageId/sourceTaskId 过滤。tasks.result 只指向最后一组 bundle——本面是'
        + '多图历史与旧结果下载入口的持久索引（resultId/publicId/产物 blobRef/过期时间）。',
      authority: 'readonly' as const,
      input: ExportsListInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ExportsListInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, TASK_EXPORTS_LIST_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const p = parsed.data;
        try {
          const task = agentTaskOf(deps.db, p.taskId);
          if (task.sessionId === null) {
            throw new Error(`任务 ${p.taskId} 不属于任何会话——导出历史以会话项目为锚`);
          }
          // 会话域 result 行（owner 双重校验）→ bundle.json manifest 的 source 审计面过滤。
          const rows = deps.db
            .prepare(
              `SELECT r.id, r.public_id, r.task_id, r.bundle_path, r.created_at, r.expires_at
               FROM results r JOIN tasks t ON r.task_id = t.id
               WHERE t.session_id = ? AND r.owner_id = ? AND r.revoked_at IS NULL
               ORDER BY r.created_at DESC LIMIT ?`,
            )
            .all(task.sessionId, task.ownerId, MAX_EXPORT_HISTORY) as Array<{
            id: string;
            public_id: string;
            task_id: string;
            bundle_path: string;
            created_at: string;
            expires_at: string | null;
          }>;
          const exports: Array<Record<string, unknown>> = [];
          for (const row of rows) {
            // 非任务导出 result（studio.export 独立 layout 面）无 source 审计字段——跳过。
            let manifest: { blobRefs?: { svg: string; bom: string; png: string; holes?: string; numbered?: string }; source?: { sourceTaskId: string; imageId: string; taskLayoutRef: string; manifestRevision: number } };
            try {
              manifest = JSON.parse(readFileSync(path.join(row.bundle_path, 'bundle.json'), 'utf8'));
            } catch {
              continue; // bundle 目录缺失/损坏=不可下载面，不进历史清单
            }
            if (manifest.source === undefined) continue;
            const source = manifest.source;
            if (p.imageId !== undefined && source.imageId !== p.imageId) continue;
            if (p.sourceTaskId !== undefined && source.sourceTaskId !== p.sourceTaskId) continue;
            exports.push({
              resultId: row.id,
              publicId: row.public_id,
              exportedByTaskId: row.task_id,
              source,
              bundle: manifest.blobRefs ?? null,
              createdAt: row.created_at,
              expiresAt: row.expires_at,
              download: `/r/${row.public_id}`,
            });
          }
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              sessionId: task.sessionId,
              total: exports.length,
              exports,
              note: '每行=一次已执行导出（导出矩阵 bundle：SVG/PNG/BOM/黑点 holes/编号 numbered；/r/{publicId} 下载入口；过期/撤销后自动缺席——存量旧 bundle 可能只有三元组）',
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_EXPORTS_LIST_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  // 授权桥（§3.6）：双模例外照 task-stones——无 proposalId=propose 面（无副作用——
  // 门+摘要+approval request，授权发生在执行模式）；带 proposalId 走 precheckMutation。
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
