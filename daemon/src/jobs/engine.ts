/**
 * 引擎 job（W2.3：排钻/校验/导出——design §6.3 + §3.4 排布参数一等输入直通）。
 * 原始需求 2026-09-23：pave=segment→layout（contracts paving 参数直通引擎 barrel，
 * region 收敛 blocks ID、未知 ID 显式拒绝）；validate=validate+exportGate
 * （ExportGateVerdict.ok===false → 任务失败并输出 violations）；export=SVG/BOM
 * 直调 engine barrel + 服务端 PNG 软光栅 → results 分享包（public_id）。
 * 引擎消费一律经 rhinestone-studio/engine 公共出口（零 src 改动）。
 */
import path from 'node:path';
import { EngineJobParamsSchema, PaveJobParamsSchema, type BlobRef } from '@handicraft/contracts';
import type { PaveJobParams } from '@handicraft/contracts';
import {
  exportGate,
  exportBom,
  exportSvg,
  gridFromSpec,
  layout,
  mapColors,
  segment,
  STARTER_PALETTE,
  validate,
  type Block,
  type Gem,
  type GridSpec,
  type LayoutOptions,
  type LayoutResult,
  type Palette,
  type StrategyId,
} from 'rhinestone-studio/engine';
import { decodePng, encodePng } from '../png/codec.js';
import { renderGemsPng } from '../png/render.js';
import { createShareBundle, type ShapeAssetSource } from '../share.js';
import type { JobDefinition, JobRunnerContext, JobServiceDeps } from './service.js';

/** pave 任务行 params 的持久产物面（后续 validate/export 经 paveTaskId 消费）。 */
interface PaveOutcome {
  layoutBlobRef: BlobRef;
  imageWidth: number;
  imageHeight: number;
  palette: Palette;
  grid: GridSpec;
  blocks: Block[];
  gems: Gem[];
  dropped: number;
  shapeAssets: Record<string, BlobRef>;
}

export const engineJob: JobDefinition = {
  run: async (ctx) => {
    const params = EngineJobParamsSchema.parse(ctx.params);
    if (params.op === 'pave') {
      await runPave(ctx, params);
    } else if (params.op === 'validate') {
      await runValidate(ctx, params.paveTaskId);
    } else {
      await runExport(ctx, params.paveTaskId, params.withPng);
    }
  },
};

// ---------------------------------------------------------------- pave adapter

/**
 * 契约排布参数 → 引擎 layout() 入参 adapter（design §3.4「引擎真源」的转换单点；
 * W0.2 adapter 等价 fixture 的被测面——tests/paving-adapter.test.ts 以真实引擎
 * layout() 断言等价性/density 单调/五策略名逐字相等）。
 * 派生关系：pitchMm = spec.diameterMm + gapMm（gridFromSpec 冻结语义）。
 */
export function paveArgsOf(params: PaveJobParams): {
  strategy: StrategyId;
  opts: LayoutOptions;
  grid: GridSpec;
} {
  const spec = {
    shapeId: params.spec.shapeId,
    sizeLabel: `${params.spec.diameterMm}mm`,
    diameterMm: params.spec.diameterMm,
    ...(params.spec.assetId !== undefined ? { assetId: params.spec.assetId } : {}),
  };
  return {
    strategy: params.strategy,
    opts: { density: params.density, seed: params.seed, relax: params.relax },
    grid: gridFromSpec(spec, params.gapMm, params.pixelsPerMm),
  };
}

// ---------------------------------------------------------------- pave

async function runPave(ctx: JobRunnerContext, params: PaveJobParams): Promise<void> {
  ctx.emit('progress', { text: '读取上传图', ratio: 0.1 });
  const bytes = ctx.deps.blobs.read(params.imageRef);
  if (bytes === null) throw new Error(`上传图不存在（blobRef=${params.imageRef.slice(0, 12)}…）`);
  const decoded = decodePng(bytes); // PNG 输入（jpeg/webp 无纯 TS 解码器——typed 拒绝）
  const image = { width: decoded.width, height: decoded.height, data: decoded.rgba };
  ctx.emit('progress', { text: `分块（${image.width}×${image.height}）`, ratio: 0.3 });

  const blocks = segment(image, {
    k: params.segmentK,
    seed: params.seed,
    gemDiameterPx: params.spec.diameterMm * params.pixelsPerMm,
  });
  if (blocks.length === 0) throw new Error('分块产出为空（图像内容不可分块）');

  // region 收敛 blocks ID（§3.4：空 region 由契约拒绝；未知 ID 显式拒绝不静默）
  const selected = params.region
    ? selectBlocks(blocks, params.region.ids)
    : blocks;

  const { strategy, opts, grid } = paveArgsOf(params);

  ctx.emit('progress', { text: `排钻（${strategy}）`, ratio: 0.6 });
  const result = layout(selected, strategy, opts, grid);
  // 规格物化戳：engine layout 产物恒 round+基准径（design「布局输入恒单 spec」）；
  // job 的 spec 参数在此后戳到逐钻（形状/直径/朝向/custom assetId——与 grid 派生口径一致）
  const specFields = {
    shapeId: params.spec.shapeId,
    diameterMm: params.spec.diameterMm,
    ...(params.spec.rotationDeg !== undefined ? { rotationDeg: params.spec.rotationDeg } : {}),
    ...(params.spec.assetId !== undefined ? { assetId: params.spec.assetId } : {}),
  };
  const gems = result.gems.map((gem) => ({ ...gem, ...specFields }));
  mapColors(gems, selected, STARTER_PALETTE);
  ctx.emit('log', {
    text: `排钻完成：${gems.length} 钻（${specFields.shapeId}），dropped=${result.dropped ?? 0}，warnings=${result.warnings.length}`,
  });

  // 产物持久化：layout.json（gems+blocks+palette+grid——export/validate 的输入真源）
  const outcome: PaveOutcome = {
    layoutBlobRef: '',
    imageWidth: image.width,
    imageHeight: image.height,
    palette: STARTER_PALETTE,
    grid,
    blocks: selected,
    gems,
    dropped: result.dropped ?? 0,
    shapeAssets: params.shapeAssets ?? {},
  };
  const layoutJson = Buffer.from(
    JSON.stringify({ ...outcome, layoutBlobRef: undefined }),
    'utf8',
  );
  const put = ctx.deps.blobs.put(layoutJson);
  outcome.layoutBlobRef = put.hash;
  persistOutcome(ctx, outcome);
  ctx.emit('artifact', { blobRef: put.hash, name: 'layout.json' });
  ctx.emit('progress', { text: '排钻完成', ratio: 1 });
}

function selectBlocks(blocks: Block[], ids: string[]): Block[] {
  const byId = new Map(blocks.map((block) => [block.id, block] as const));
  const unknown = ids.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new Error(`region 引用不存在的图块 ID：${unknown.join('、')}（可用：${blocks.map((b) => b.id).join('、')}）`);
  }
  return ids.map((id) => byId.get(id)!);
}

// ---------------------------------------------------------------- validate / export

async function runValidate(ctx: JobRunnerContext, paveTaskId: string): Promise<void> {
  const outcome = loadOutcome(ctx, paveTaskId);
  const verdict = gateOf(ctx, outcome);
  const verdictJson = Buffer.from(JSON.stringify(verdict, null, 2), 'utf8');
  const put = ctx.deps.blobs.put(verdictJson);
  ctx.emit('log', { text: `exportGate：ok=${verdict.ok}，violations=${verdict.violations.length}` });
  ctx.emit('artifact', { blobRef: put.hash, name: 'verdict.json' });
  if (!verdict.ok) {
    // spec：ExportGateVerdict.ok===false → 任务失败并输出 violations（不静默放行）
    throw new Error(`导出前置门未通过（${verdict.violations.length} 项违规）：\n${verdict.violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n')}`);
  }
}

async function runExport(ctx: JobRunnerContext, paveTaskId: string, withPng: boolean): Promise<void> {
  const outcome = loadOutcome(ctx, paveTaskId);
  const verdict = gateOf(ctx, outcome);
  if (!verdict.ok) {
    throw new Error(
      `导出前置门未通过，导出阻断（${verdict.violations.length} 项违规）：\n${verdict.violations.map((v) => `[${v.kind}] ${v.detail}`).join('\n')}`,
    );
  }
  const layoutResult: LayoutResult = { gems: outcome.gems, warnings: [], dropped: outcome.dropped };
  ctx.emit('progress', { text: '导出 SVG/BOM', ratio: 0.4 });
  const svgBlob = exportSvg(layoutResult, outcome.grid, {
    width: outcome.imageWidth,
    height: outcome.imageHeight,
    palette: outcome.palette,
    blocks: outcome.blocks,
    resolveShape: shapeResolverOf(ctx, outcome),
  });
  const bomBlob = exportBom(layoutResult, outcome.palette, outcome.grid, {
    resolveShape: shapeResolverOf(ctx, outcome),
  });
  const svg = new Uint8Array(await svgBlob.arrayBuffer());
  const bom = new Uint8Array(await bomBlob.arrayBuffer());

  let png: Uint8Array = new Uint8Array(0);
  if (withPng) {
    ctx.emit('progress', { text: '服务端 PNG 光栅', ratio: 0.7 });
    png = renderGemsPng({
      gems: outcome.gems,
      palette: outcome.palette,
      grid: outcome.grid,
      width: outcome.imageWidth,
      height: outcome.imageHeight,
      resolveAsset: assetResolverOf(ctx, outcome),
    });
  }

  ctx.emit('progress', { text: '生成分享包', ratio: 0.9 });
  const bundle = await createShareBundle(ctx.deps, {
    taskId: ctx.taskId,
    ownerId: ownerIdOf(ctx),
    title: `贴钻 ${outcome.gems.length} 钻`,
    files: { svg, bom, ...(withPng ? { png } : { png: placeholderBundlePng() }) },
  });
  // 三产物 blob 引用入帧（结果行已由 createShareBundle 回链 task.result_id）
  for (const [name, hash] of Object.entries(bundle.blobRefs)) {
    ctx.emit('artifact', { blobRef: hash, name });
  }
  ctx.emit('log', { text: `分享链接：/r/${bundle.publicId}` });
  ctx.emit('progress', { text: '导出完成', ratio: 1 });
}

// ---------------------------------------------------------------- 共用面

function gateOf(ctx: JobRunnerContext, outcome: PaveOutcome) {
  const warnings = validate(outcome.gems, outcome.grid, outcome.blocks);
  ctx.emit('log', { text: `validate：${warnings.length} 条 warning` });
  return exportGate(outcome.gems, {
    grid: outcome.grid,
    blocks: outcome.blocks,
    resolveShapeAsset: (assetId) => resolveShapeAssetState(ctx, outcome, assetId),
  });
}

/** .gemshape 资产解析（W2：shapeAssets 映射 assetId→blobRef——上传面注入）。 */
function assetBytesOf(ctx: JobRunnerContext, outcome: PaveOutcome, assetId: string): Uint8Array | null {
  const ref = outcome.shapeAssets[assetId];
  if (ref === undefined) return null;
  return ctx.deps.blobs.read(ref);
}

function parseGemshapeAsset(bytes: Uint8Array): ShapeAssetSource | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
    if (parsed['kind'] !== 'gemshape') return null;
    const texture = parsed['texture'] as Record<string, unknown> | undefined;
    return {
      vectorPath: typeof parsed['vectorPath'] === 'string' ? (parsed['vectorPath'] as string) : undefined,
      image:
        texture && typeof texture['dataUrl'] === 'string'
          ? {
              mime: typeof texture['mime'] === 'string' ? (texture['mime'] as string) : 'image/png',
              dataUrl: texture['dataUrl'] as string,
              width: Number(texture['width'] ?? 0),
              height: Number(texture['height'] ?? 0),
            }
          : undefined,
    };
  } catch {
    return null;
  }
}

function resolveShapeAssetState(
  ctx: JobRunnerContext,
  outcome: PaveOutcome,
  assetId: string,
): 'resolved' | 'blob-missing' | 'wrong-kind' | null {
  const bytes = assetBytesOf(ctx, outcome, assetId);
  if (bytes === null) return null; // 节点不存在（硬清后）——gate 6 判据
  const asset = parseGemshapeAsset(bytes);
  if (asset === null) return 'wrong-kind';
  if (asset.vectorPath === undefined && asset.image === undefined) return 'wrong-kind';
  return 'resolved';
}

/** export.ts ShapeResolver（矢量优先；未解析=undefined→占位/missing 标记）。 */
function shapeResolverOf(ctx: JobRunnerContext, outcome: PaveOutcome) {
  return (gem: Gem) => {
    if (gem.assetId === undefined) return undefined;
    const bytes = assetBytesOf(ctx, outcome, gem.assetId);
    if (bytes === null) return undefined;
    const asset = parseGemshapeAsset(bytes);
    if (!asset || (asset.vectorPath === undefined && asset.image === undefined)) return undefined;
    return {
      ...(asset.vectorPath !== undefined ? { vectorPath: asset.vectorPath } : {}),
      ...(asset.image !== undefined
        ? { image: { dataUrl: asset.image.dataUrl, width: asset.image.width, height: asset.image.height } }
        : {}),
    };
  };
}

/** PNG render resolveAsset（与门校验同源；未解析抛 PngAssetUnresolvedError 由渲染面）。 */
function assetResolverOf(ctx: JobRunnerContext, outcome: PaveOutcome) {
  return (assetId: string) => {
    const bytes = assetBytesOf(ctx, outcome, assetId);
    if (bytes === null) return null;
    return parseGemshapeAsset(bytes);
  };
}

// ---------------------------------------------------------------- 任务行持久化

function persistOutcome(ctx: JobRunnerContext, outcome: PaveOutcome): void {
  updateParamsOf(ctx, (meta) => {
    meta['pave'] = {
      layoutBlobRef: outcome.layoutBlobRef,
      imageWidth: outcome.imageWidth,
      imageHeight: outcome.imageHeight,
      palette: outcome.palette,
      grid: outcome.grid,
      blocks: outcome.blocks,
      gems: outcome.gems,
      dropped: outcome.dropped,
      shapeAssets: outcome.shapeAssets,
    };
  });
}

function updateParamsOf(ctx: JobRunnerContext, mutate: (meta: Record<string, unknown>) => void): void {
  const { db } = ctx.deps;
  const row = db.prepare('SELECT params FROM tasks WHERE id = ?').get(ctx.taskId) as
    | { params: string | null }
    | undefined;
  const meta = row?.params ? (JSON.parse(row.params) as Record<string, unknown>) : {};
  mutate(meta);
  db.prepare('UPDATE tasks SET params = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(meta),
    new Date().toISOString(),
    ctx.taskId,
  );
}

function loadOutcome(ctx: JobRunnerContext, paveTaskId: string): PaveOutcome {
  const { db } = ctx.deps;
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(paveTaskId) as
    | { owner_id: string; params: string | null; type: string }
    | undefined;
  if (!row) throw new Error(`排钻任务不存在：${paveTaskId}`);
  if (row.owner_id !== ownerIdOf(ctx)) throw new Error('无权引用他人排钻任务');
  if (row.type !== 'job') throw new Error(`引用的任务不是 job：${paveTaskId}`);
  const meta = row.params ? (JSON.parse(row.params) as Record<string, unknown>) : {};
  const pave = meta['pave'] as PaveOutcome | undefined;
  if (!pave || !pave.layoutBlobRef) {
    throw new Error(`任务 ${paveTaskId} 无排钻产物（先跑 op=pave）`);
  }
  return pave;
}

function ownerIdOf(ctx: JobRunnerContext): string {
  const row = ctx.deps.db.prepare('SELECT owner_id FROM tasks WHERE id = ?').get(ctx.taskId) as
    | { owner_id: string }
    | undefined;
  if (!row) throw new Error(`任务行缺失：${ctx.taskId}`);
  return row.owner_id;
}

/** bundle 三产物占位（withPng=false 时 png 位以 1×1 透明占位保持 manifest 三元组形状）。 */
function placeholderBundlePng(): Uint8Array {
  return encodePng(1, 1, new Uint8Array(4));
}
