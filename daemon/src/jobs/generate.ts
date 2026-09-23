/**
 * 生成 job（W2.2：图像 API 服务端代理——经 ComputeProvider 缝的 InlineProvider 调用）。
 * 原始需求 2026-09-23：.env IMG_* 键族消费（双层真源 settings 优先）；半配置=未配置
 * ——preCreate 显式拒绝并提示缺哪个键（spec 半配置拒绝场景）；IMG_DRY_RUN=1 时不真实
 * 外呼（固定占位帧+假结果 blob）；debug 记录结构对齐 rhinestone-studio lab 的
 * ImageTaskDebug 契约（endpoint/requestBody/responseStatus/.../durationMs——apiKey
 * 永不入 debug；记录落任务目录 debug.json + log 帧摘要）。
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { GenerateJobParamsSchema } from '@handicraft/contracts';
import { resolveImgConfig, missingImgKeys, isImgConfigured } from '../config.js';
import { InlineProvider } from '../compute/inline.js';
import type { ComputeSpec } from '../compute/provider.js';
import { callImagesApi, debugSummary, type ImageTaskDebug, deepReplaceSecret } from '../imgapi/client';
import { renderGemsPng } from '../png/render.js';
import type { Gem, Palette } from 'rhinestone-studio/engine';
import type { JobDefinition, JobRunnerContext } from './service.js';

/** 创建时门控（spec：半配置=未配置——任务创建显式拒绝，提示缺哪个键）。 */
export function generatePreCreate(params: unknown, deps: JobRunnerContext['deps']): void {
  GenerateJobParamsSchema.parse(params); // 形状先守门（Zod 错误=BAD_REQUEST）
  if (deps.config.imgDryRun) return; // dry-run 不需要任何 IMG_* 配置
  const effective = resolveImgConfig(deps.db, deps.config);
  if (!isImgConfigured(effective)) {
    const missing = missingImgKeys(effective);
    const detail =
      missing.length === 3
        ? 'IMG_BASE_URL/IMG_API_KEY/IMG_MODEL 均未配置'
        : `缺 ${missing.join('、')}`;
    throw new Error(
      `图像 API 未配置（${detail}）——半配置视为未配置；请配齐 .env 的 IMG_* 键族，或设 IMG_DRY_RUN=1 走 dry-run`,
    );
  }
}

/** dry-run 占位图：由 prompt 哈希确定色的四钻小图（真实 PNG 字节——内容寻址落 blob）。 */
function placeholderPng(prompt: string): Uint8Array {
  const hash = createHash('sha256').update(prompt).digest();
  const rgb: [number, number, number] = [hash[0]!, 64 + (hash[1]! % 128), 64 + (hash[2]! % 128)];
  const hex = `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const palette: Palette = [{ id: 'ph', name: '占位', hex }];
  const gems: Gem[] = [
    { id: 'p1', x: 15, y: 15, colorId: 'ph', blockId: 'ph', shapeId: 'round', diameterMm: 3 },
    { id: 'p2', x: 48, y: 15, colorId: 'ph', blockId: 'ph', shapeId: 'square', diameterMm: 3, rotationDeg: 45 },
    { id: 'p3', x: 15, y: 48, colorId: 'ph', blockId: 'ph', shapeId: 'marquise', diameterMm: 3 },
    { id: 'p4', x: 48, y: 48, colorId: 'ph', blockId: 'ph', shapeId: 'heart', diameterMm: 3 },
  ];
  return renderGemsPng({
    gems,
    palette,
    grid: { pitchMm: 3.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 8 },
    width: 64,
    height: 64,
  });
}

export const generateJob: JobDefinition = {
  preCreate: generatePreCreate,
  run: async (ctx) => {
    const params = GenerateJobParamsSchema.parse(ctx.params);
    const effective = resolveImgConfig(ctx.deps.db, ctx.deps.config);
    const dryRun = ctx.deps.config.imgDryRun;
    ctx.emit('progress', { text: dryRun ? '提交生成任务（dry-run）' : '提交生成任务', ratio: 0.1 });

    // ComputeProvider 缝：Inline 进程内直跑（幂等键=taskId；真实调用的完整 debug
    // 记录经闭包捕获——含 responseStatus/responseBodyText 等实测字段）。
    // P2-2：provider 内部信号 ∪ JobService 取消信号——cancel/stop 即中止外呼。
    let capturedDebug: ImageTaskDebug | null = null;
    const provider = new InlineProvider(ctx.deps.blobs, (spec, signal) =>
      executeGenerate(
        spec,
        effective,
        dryRun,
        AbortSignal.any([signal, ctx.signal]),
        (debug) => {
          capturedDebug = debug;
        },
      ),
    );
    const spec: ComputeSpec = {
      kind: 'generate-image',
      version: 1,
      prompt: params.prompt,
      ...(params.size ? { size: params.size } : {}),
      model: effective.model || 'dry-run',
      ...(params.imageRef
        ? { imageBase64: imageBase64Of(ctx, params.imageRef) }
        : {}),
      ...(params.advanced ? { advanced: params.advanced } : {}),
    };
    const ref = await provider.submit(spec, ctx.taskId);
    ctx.emit('progress', { text: '生成中', ratio: 0.4 });
    const blobRef = await provider.result(ref);

    // debug 记录：真实调用用实测记录（含响应面字段）；dry-run 构造同形记录。
    // 顺序修正（P1-5 测试门暴露）：必须在 provider.result 落定**之后**取闭包捕获——
    // submit 返回时执行器仍在飞行，先取恒得 fallback。
    const debugRecord: ImageTaskDebug =
      capturedDebug ??
      {
        endpoint: dryRun
          ? 'inline://dry-run/images/generations'
          : joinUrl(effective.baseUrl, params.imageRef ? '/images/edits' : '/images/generations'),
        requestBody: {
          model: spec.model,
          prompt: params.prompt,
          ...(params.size ? { size: params.size } : {}),
          ...(params.advanced ? { advanced: params.advanced } : {}),
          n: 1,
          dryRun,
        },
        durationMs: 0,
      };

    // P1-5 R6 终门：debugRecord（dry-run 构造/fallback 双路）不经 callImagesApi
    // 出口——落盘与入帧前统一过密钥终门（键+值整段替换；真实调用路径已在
    // callImagesApi 出口过门，此处幂等无害）。
    const safeDebug = deepReplaceSecret(debugRecord, effective.apiKey.trim()) as ImageTaskDebug;

    ctx.emit('progress', { text: '生成完成', ratio: 0.9 });
    ctx.emit('log', { text: `debug: ${debugSummary(safeDebug)}` });
    // debug.json 落任务目录（字段对齐 lab ImageTaskDebug；已脱敏形状）
    writeFileSync(path.join(ctx.taskDir, 'debug.json'), `${JSON.stringify(safeDebug, null, 2)}\n`);
    ctx.emit('artifact', { blobRef, name: 'generated.png' });
  },
};

/** executor：dry-run=占位图；真实=callImagesApi（完整 debug 记录经 onDebug 回传）。 */
async function executeGenerate(
  spec: ComputeSpec,
  settings: { baseUrl: string; apiKey: string; model: string },
  dryRun: boolean,
  signal: AbortSignal,
  onDebug: (debug: ImageTaskDebug) => void,
): Promise<Uint8Array> {
  if (spec.kind !== 'generate-image') throw new Error(`InlineProvider 不支持的 spec kind：${spec.kind}`);
  if (dryRun) {
    await new Promise((resolve) => setTimeout(resolve, 10)); // 轻微异步形态（接口行为一致性）
    if (signal.aborted) throw new Error('已取消');
    return placeholderPng(spec.prompt);
  }
  const result = await callImagesApi(
    settings,
    {
      prompt: spec.prompt,
      ...(spec.size ? { size: spec.size } : {}),
      ...(spec.imageBase64
        ? { image: { filename: 'input.png', bytes: Buffer.from(spec.imageBase64, 'base64'), mime: 'image/png' } }
        : {}),
      ...(spec.advanced ? { advanced: spec.advanced } : {}),
    },
    fetch,
    signal,
  );
  onDebug(result.debug);
  return result.image;
}

function imageBase64Of(ctx: JobRunnerContext, imageRef: string): string {
  const bytes = ctx.deps.blobs.read(imageRef);
  if (bytes === null) throw new Error(`生成原图不存在（blobRef=${imageRef.slice(0, 12)}…）`);
  return bytes.toString('base64');
}

function joinUrl(base: string, pathname: string): string {
  return `${base.trim().replace(/\/+$/, '')}${pathname}`;
}
