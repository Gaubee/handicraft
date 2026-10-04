/**
 * 参考图层生成通道（add-flat-aux-segmentation design D2 / T2，2026-10-04）。
 * Owner 定调：photographic（贴钻实物照/照片）任务先经 image-edit 模型把原图扁平化
 * （去钻饰/渐变/光影，保轮廓）得「参考图层」——分件/SAM/掩膜真源（D3 四图引用之一）；
 * flat/未配置/生成失败/一致性门不过 → 全链回退原图（软失败四态语义，绝不阻塞 S2）。
 *
 * 三个正交面：
 *   [1] OWNER_FLATTEN_PROMPT：Owner 提示词逐字冻结（源=主仓
 *       experiments/sam-playbook-20261004/iter-5-flat-ab/owner-flatten-prompt.md
 *       代码块全文——3874 字节，sha256=d1a3371bb4efcec2d6be582a226645a80a804f8f
 *       424cb9487fa4c4322f8944af；测试逐字节对照锚定防漂移——改动常量=改 Owner 资产）。
 *   [2] generateReferenceImage：编排面（image-edit 路由解析→images/edits multipart
 *       外呼→b64 解码→一致性门→reference-image.png 工件+帧→report 工件留痕数字）。
 *       全路径软失败（outcome 形态，不抛）：unconfigured/failed/inconsistent 各回
 *       typed warning；幂等=reference-image.png artifact 帧在场不重生成。
 *   [3] referenceImageConsistency：几何一致性门纯函数（vision 审计法程序化移植：
 *       border-median 背景估计+diff 阈值→双剪影→IoU≥0.85；不过=参考图层弃用回退
 *       原图——工件保留供人审，数字落 reference-image-report.json 工件帧留痕）。
 * 纪律：LLM key 只走 settings 表 models_keys（models-store），不入日志不入留存；
 * 生成超时分钟级（env REFERENCE_IMAGE_TIMEOUT_MS 可调，缺省 180s）。
 */
import type { SqliteDb } from '../../db/database.js';
import type { BlobStore } from '../../db/blobs.js';
import type { JobService } from '../../jobs/service.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { resolveImageEditRoute } from '../../models-store.js';
import { decodePng, encodePng } from '../../png/codec.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import { resampleRgbaArea } from './intake-resample.js';
import { envTimeoutMs } from '../timeout-env.js';

/** 参考图层工件帧名（task.detail referenceImage 投影的在场判定锚——rpc.ts 单源引用）。 */
export const REFERENCE_IMAGE_ARTIFACT_NAME = 'reference-image.png';

/** 一致性门数字留痕工件帧名（生成成功即落——过/不过两态都记数字，D6 版本史审计面）。 */
export const REFERENCE_IMAGE_REPORT_ARTIFACT_NAME = 'reference-image-report.json';

/** 生成外呼超时 env 键（分钟级生成；≥1000ms 有效——timeout-env 同先例）。 */
export const REFERENCE_IMAGE_TIMEOUT_ENV = 'REFERENCE_IMAGE_TIMEOUT_MS';

/** 生成外呼超时缺省（180s——images/edits 扁平化实测分钟级）。 */
export const REFERENCE_IMAGE_TIMEOUT_DEFAULT_MS = 180_000;

/**
 * Owner 扁平化提示词（逐字冻结——2026-10-04 iter-5-flat-ab A/B 终裁的生成指令；
 * 触发语义见同文件「产品化语义」：原图→本提示词→参考图层，全层面抠图面向参考图层）。
 */
export const OWNER_FLATTEN_PROMPT = `Edit the input image with the following strict priority:

1. PRESERVE THE ORIGINAL SHAPES AND CONTOURS EXACTLY.

   * Do not redraw, reshape, deform, smooth, expand, shrink, or reinterpret any object.
   * Keep every object's original outer boundary, silhouette, edge position, proportion, and relative position unchanged.
   * Preserve small contour details, irregularities, corners, curves, notches, and protrusions.
   * The original geometry is the source of truth.

2. FLATTEN THE VISUAL APPEARANCE INSIDE THE ORIGINAL CONTOURS.

   * Remove complex gradients.
   * Remove realistic lighting and shadows.
   * Remove highlights, reflections, gloss, and photographic shading.
   * Reduce complex color variations into a small number of clean, flat color regions.
   * Replace painterly brushwork with simple, uniform flat fills.
   * Preserve the dominant base color of each region.

3. REMOVE DECORATIVE SURFACE DETAILS.

   * Remove jewelry, gemstones, rhinestones, beads, sequins, glitter, embroidery, decorative particles, and similar surface ornaments.
   * Remove small reflective or shiny objects that are attached to or placed on top of a larger object.
   * Treat these details as visual decoration rather than independent objects.
   * Merge them into the underlying surface color whenever they do not affect the object's outer contour.

   Examples:

   * Yellow hair with yellow gemstones → render as continuous flat yellow hair; remove the gemstones.
   * White clothing with white gemstones → render as continuous flat white clothing; remove the gemstones.
   * Red fabric with red sequins → render as continuous flat red fabric; remove the sequins.
   * Skin with small highlights or reflective spots → preserve the skin as a flat skin-color region.
   * A colored surface covered with small same-color decorative elements → merge them into the underlying color.

4. DISTINGUISH STRUCTURE FROM SURFACE DECORATION.

   * Preserve features that define the actual shape or silhouette of an object.
   * Remove details that merely decorate, texture, reflect, or embellish an existing surface.
   * Do not preserve a gemstone, highlight, reflection, or ornament as a separate region merely because it has a visible boundary.
   * If removing a detail would change the outer contour of the main object, preserve the contour but simplify the detail inside it.

5. COLOR SIMPLIFICATION.

   * For each major region, identify its underlying/base color.
   * Use that base color as the dominant fill.
   * Small variations caused by lighting, reflections, gemstones, jewelry, texture, or surface decoration should be absorbed into the underlying region.
   * Keep meaningful color boundaries between different actual objects.

6. STRICT GEOMETRY CONSTRAINT.
   The original image is the geometric source of truth.
   Treat the existing contours as fixed masks.
   Only simplify the appearance and internal visual information inside those masks.
   Never alter an object's silhouette or outer boundary.

7. NO CREATIVE REDESIGN.

   * Do not add objects.
   * Do not remove actual objects.
   * Do not change object positions.
   * Do not change proportions.
   * Do not change the camera angle or perspective.
   * Do not invent missing geometry.
   * Do not cartoonize or redesign the image.
   * Do not vectorize the image into a new interpretation.

Contour preservation has absolute priority over visual quality.
If flattening or removing a decorative detail would require changing the original contour, preserve the original contour and sacrifice the simplification.

The final image should look like a clean, flat-color version of the original image:
same silhouettes, same contours, same composition, same major color regions,
but with gradients, lighting, shadows, texture, jewelry, gemstones, reflections, and decorative surface details removed.
`;
// ---------------------------------------------------------------- typed warning 与结果面

/** 参考图层软失败 kind（typed warning——回流 agent/日志可编程判别，不阻塞主链）。 */
export type ReferenceImageWarningKind =
  | 'reference-image-unconfigured'
  | 'reference-image-failed'
  | 'reference-image-inconsistent';

export interface ReferenceImageWarning {
  kind: ReferenceImageWarningKind;
  message: string;
  /** inconsistent 时携带数字明细（IoU/覆盖率/建议）。 */
  consistency?: ReferenceImageConsistencyReport;
}

/** 几何一致性门报告（纯函数产出——数字即留痕面）。 */
export interface ReferenceImageConsistencyReport {
  /** 双剪影 IoU（0..1；双空剪影=1——同一背景图一致）。 */
  iou: number;
  /** 原图前景覆盖率（剪影像素/总像素）。 */
  sourceCoverage: number;
  /** 参考图层前景覆盖率（对齐后）。 */
  referenceCoverage: number;
  /** 通过阈值（缺省 0.85——design D2 冻结）。 */
  threshold: number;
  pass: boolean;
  /** 参考图层与原图尺寸不一致时的对齐事实（重采样到原图网格；null=同尺寸）。 */
  referenceResized: { width: number; height: number } | null;
  /** 不过时的处置建议（人可读）。 */
  suggestion: string;
}

/**
 * 生成编排结果（全路径闭合——调用方以 kind 分派，永不抛）：
 * - unconfigured：image-edit 路由缺席（typed warning，回退原图语义）
 * - skipped：reference-image.png 工件帧在场（幂等——不重生成零外呼）
 * - generated：生成+一致性门过（工件+帧就位，referenceImage 引用可消费）
 * - inconsistent：生成成功但门不过（工件落盘供人审、**不发 artifact 帧**——
 *   task.detail 等读面继续回退原图；数字在 report 帧+warning）
 * - failed：外呼/解码/工件写入失败（软失败，回退原图）
 */
export type ReferenceImageOutcome =
  | { kind: 'unconfigured'; warning: ReferenceImageWarning }
  | { kind: 'skipped'; reason: 'artifact-present'; blobRef: string }
  | { kind: 'generated'; blobRef: string; consistency: ReferenceImageConsistencyReport }
  | {
      kind: 'inconsistent';
      blobRef: string;
      consistency: ReferenceImageConsistencyReport;
      warning: ReferenceImageWarning;
    }
  | { kind: 'failed'; warning: ReferenceImageWarning };

// ---------------------------------------------------------------- [3] 一致性门（纯函数）

/** 剪影 diff 阈值（RGB 欧氏距离——背景为均匀色、前景主体与背景色差远超压缩噪声的
 * 先验量级；vision 审计法同款。可经 consistencyOptions 覆写做实验）。 */
export const REFERENCE_CONSISTENCY_DIFF_THRESHOLD = 30;

/** IoU 通过阈值（design D2 冻结：0.85——同款 mask-parent-iou 先验的量级带）。 */
export const REFERENCE_CONSISTENCY_IOU_THRESHOLD = 0.85;

/** 边框带宽（背景估计取样带）：min(w,h) 的 2%，下界 2px。 */
function borderBand(width: number, height: number): number {
  return Math.max(2, Math.round(Math.min(width, height) * 0.02));
}

/** border-median 背景色估计：四周边框带内像素逐通道中位数（主体贴边时容忍污染——
 * 贴钻任务主体居中的主流形态；与 diff 阈值联合构成剪影判据）。 */
function borderMedianBackground(rgba: Uint8Array, width: number, height: number): [number, number, number] {
  const band = Math.min(borderBand(width, height), Math.floor(width / 2), Math.floor(height / 2));
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const push = (x: number, y: number): void => {
    const p = (y * width + x) * 4;
    rs.push(rgba[p]!);
    gs.push(rgba[p + 1]!);
    bs.push(rgba[p + 2]!);
  };
  for (let y = 0; y < band; y++) {
    for (let x = 0; x < width; x++) {
      push(x, y);
      push(x, height - 1 - y);
    }
  }
  for (let x = 0; x < band; x++) {
    for (let y = band; y < height - band; y++) {
      push(x, y);
      push(width - 1 - x, y);
    }
  }
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return [median(rs), median(gs), median(bs)];
}

/** 剪影位图（0/1 per pixel）：像素与背景色欧氏距离 > diffThreshold = 前景。 */
function silhouette(
  rgba: Uint8Array,
  width: number,
  height: number,
  diffThreshold: number,
): Uint8Array {
  const [br, bg, bb] = borderMedianBackground(rgba, width, height);
  const bits = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    const dr = rgba[p]! - br;
    const dg = rgba[p + 1]! - bg;
    const db = rgba[p + 2]! - bb;
    if (Math.sqrt(dr * dr + dg * dg + db * db) > diffThreshold) bits[i] = 1;
  }
  return bits;
}

/**
 * 几何一致性门（design D2：参考图层与原图结构相似性校验——剪影 IoU）。
 * 步骤：参考图层尺寸≠原图时先面积重采样对齐（resampleRgbaArea 单源）→ 双图
 * border-median 背景估计+diff 阈值得双剪影 → IoU=∩/∪ ≥ threshold 过。
 * 双空剪影（纯背景图对纯背景图）= IoU 1（一致）；单空=0。
 */
export function referenceImageConsistency(
  source: { width: number; height: number; rgba: Uint8Array },
  reference: { width: number; height: number; rgba: Uint8Array },
  options?: { threshold?: number; diffThreshold?: number },
): ReferenceImageConsistencyReport {
  const threshold = options?.threshold ?? REFERENCE_CONSISTENCY_IOU_THRESHOLD;
  const diffThreshold = options?.diffThreshold ?? REFERENCE_CONSISTENCY_DIFF_THRESHOLD;
  const referenceResized =
    reference.width === source.width && reference.height === source.height
      ? null
      : { width: reference.width, height: reference.height };
  const alignedRgba =
    referenceResized === null
      ? reference.rgba
      : resampleRgbaArea(reference.rgba, reference.width, reference.height, source.width, source.height);
  const sourceBits = silhouette(source.rgba, source.width, source.height, diffThreshold);
  const referenceBits = silhouette(alignedRgba, source.width, source.height, diffThreshold);
  const total = source.width * source.height;
  let sourceCount = 0;
  let referenceCount = 0;
  let intersection = 0;
  for (let i = 0; i < total; i++) {
    const a = sourceBits[i]!;
    const b = referenceBits[i]!;
    if (a === 1) sourceCount++;
    if (b === 1) referenceCount++;
    if (a === 1 && b === 1) intersection++;
  }
  const union = sourceCount + referenceCount - intersection;
  const iou = union === 0 ? 1 : intersection / union;
  const sourceCoverage = sourceCount / total;
  const referenceCoverage = referenceCount / total;
  const pass = iou >= threshold;
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const suggestion = pass
    ? `剪影 IoU ${iou.toFixed(3)} ≥ ${threshold}——参考图层与原图轮廓一致，作为分件真源`
    : `剪影 IoU ${iou.toFixed(3)} < ${threshold}（原图前景 ${pct(sourceCoverage)} vs 参考图层 ${pct(referenceCoverage)}）——参考图层轮廓漂移，弃用回退原图（工件保留供人审）；建议检查 image-edit 模型/提示词后重新生成`;
  return {
    iou,
    sourceCoverage,
    referenceCoverage,
    threshold,
    pass,
    referenceResized,
    suggestion,
  };
}

// ---------------------------------------------------------------- [2] 生成编排

export interface ReferenceImageDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 帧提交单点（reference-image.png/report artifact 帧登记+幂等读回；缺席=不登记
   * 帧且跳过幂等检查——scene.analyze 先例同款可选面）。 */
  jobs?: Pick<JobService, 'emitFor' | 'framesAfter'>;
}

export interface ReferenceImageGenerateInput {
  taskId: string;
  /** 工作锚点图（intake 后规范网格——分件同坐标系；生成输入与一致性基准）。 */
  sourceImage: { blobRef: string };
}

export interface ReferenceImageOptions {
  /** fetch 替身（测试注入；缺省 globalThis.fetch）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 外呼超时（ms——缺省 env REFERENCE_IMAGE_TIMEOUT_MS→180s）。 */
  timeoutMs?: number;
  /** images/edits size 参数（缺省 'auto'——模型侧自选最接近输入的尺寸；一致性门
   * 与工件落盘都会对齐回原图网格，该值只影响服务端生成质量）。 */
  size?: string;
  /** 一致性门 IoU 阈值覆写（缺省 0.85——design D2 冻结值）。 */
  consistencyThreshold?: number;
}

/** 解码面（generateReferenceImage 内部+一致性门共用形状）。 */
interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

function decodeOrUndefined(bytes: Uint8Array): DecodedImage | undefined {
  try {
    return decodePng(bytes);
  } catch {
    return undefined;
  }
}

/** 帧流最新同名 artifact 引用（rpc.ts latestArtifactRefs 的 daemon 内等价读面——
 * 幂等判定：reference-image.png 帧在场=已生成不重做）。 */
function latestArtifactBlobRef(
  jobs: Pick<JobService, 'framesAfter'>,
  taskId: string,
  name: string,
): string | null {
  const frames = jobs.framesAfter(taskId, 0);
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'artifact') continue;
    const payload = frame.payload as { name?: unknown; blobRef?: unknown };
    if (payload.name === name && typeof payload.blobRef === 'string') return payload.blobRef;
  }
  return null;
}

/** excerpt：typed warning 携带的原文摘要（截断防日志爆炸——scene-analyze 同款）。 */
function excerpt(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字符）`;
}

function warn(deps: ReferenceImageDeps, taskId: string, warning: ReferenceImageWarning): void {
  console.warn(`[reference-image] ${warning.kind}：${warning.message}`);
  try {
    deps.jobs?.emitFor(taskId, 'log', { text: `[参考图层] ${warning.kind}：${warning.message}` });
  } catch (error) {
    console.warn('[reference-image] warning log 帧落盘失败（不掩盖生成结果）', error);
  }
}

/**
 * 参考图层生成编排（全路径软失败——outcome 闭合，永不抛）：
 * 幂等（工件帧在场）→ image-edit 路由解析（未配置=unconfigured）→ images/edits
 * multipart 外呼（Owner 提示词逐字）→ b64_json 解码 → 一致性门（对齐+IoU）→
 * 工件落盘（对齐到原图网格——分件坐标系自洽）→ 过门发 reference-image.png 帧；
 * 不过门工件保留（人审）但不发帧（读面继续回退原图）→ report 工件帧两态都落数字。
 */
export async function generateReferenceImage(
  deps: ReferenceImageDeps,
  input: ReferenceImageGenerateInput,
  options: ReferenceImageOptions = {},
): Promise<ReferenceImageOutcome> {
  const startedAt = Date.now();
  // —— 幂等：reference-image.png artifact 帧在场=已生成（重放/并发二次触发零外呼）。
  const existing =
    deps.jobs !== undefined ? latestArtifactBlobRef(deps.jobs, input.taskId, REFERENCE_IMAGE_ARTIFACT_NAME) : null;
  if (existing !== null) return { kind: 'skipped', reason: 'artifact-present', blobRef: existing };

  // —— 路由解析（settings 真源单源——models-store.resolveImageEditRoute）。
  const route = resolveImageEditRoute(deps.db);
  if (route === null) {
    const warning: ReferenceImageWarning = {
      kind: 'reference-image-unconfigured',
      message:
        'image-edit 路由未配置（后台模型设置需一条 api=openai-image-edit 且带密钥的路由）——参考图层生成跳过，分件回退原图',
    };
    warn(deps, input.taskId, warning);
    return { kind: 'unconfigured', warning };
  }

  // —— 源图读取+解码（工作锚点图；blob 缺失/坏图=软失败——S2 刚落档的图理论在场，
  //    走 failed 面保参考图层通道整体「增强不阻塞」语义）。
  const sourceBytes = deps.blobs.read(input.sourceImage.blobRef);
  if (sourceBytes === null) {
    const warning: ReferenceImageWarning = {
      kind: 'reference-image-failed',
      message: `源图 blob 不存在（blobRef=${input.sourceImage.blobRef.slice(0, 12)}…）`,
    };
    warn(deps, input.taskId, warning);
    return { kind: 'failed', warning };
  }
  const source = decodeOrUndefined(sourceBytes);
  if (source === undefined) {
    const warning: ReferenceImageWarning = {
      kind: 'reference-image-failed',
      message: '源图解码失败（仅支持 PNG——工作锚点图面）',
    };
    warn(deps, input.taskId, warning);
    return { kind: 'failed', warning };
  }

  // —— 外呼：POST {baseURL}/images/edits multipart（OpenAI images/edits 兼容形态）。
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? envTimeoutMs(REFERENCE_IMAGE_TIMEOUT_ENV, REFERENCE_IMAGE_TIMEOUT_DEFAULT_MS);
  const url = `${route.baseURL.trim().replace(/\/+$/, '')}/images/edits`;
  const form = new FormData();
  form.append('image', new Blob([sourceBytes], { type: 'image/png' }), 'image.png');
  form.append('prompt', OWNER_FLATTEN_PROMPT);
  form.append('model', route.model);
  form.append('size', options.size ?? 'auto');
  form.append('response_format', 'b64_json');

  let generatedBytes: Uint8Array;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${route.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error', // 网关直连 https；跨域重定向=配置漂移面（scene-analyze 同纪律）
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      const warning: ReferenceImageWarning = {
        kind: 'reference-image-failed',
        message: `image-edit HTTP ${response.status}：${excerpt(bodyText)}`,
      };
      warn(deps, input.taskId, warning);
      return { kind: 'failed', warning };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      const warning: ReferenceImageWarning = {
        kind: 'reference-image-failed',
        message: 'image-edit 响应不是 JSON 体',
      };
      warn(deps, input.taskId, warning);
      return { kind: 'failed', warning };
    }
    const data =
      typeof body === 'object' && body !== null && Array.isArray((body as { data?: unknown }).data)
        ? ((body as { data: unknown[] }).data[0] as { b64_json?: unknown } | undefined)
        : undefined;
    if (data === undefined || typeof data.b64_json !== 'string' || data.b64_json.length === 0) {
      const warning: ReferenceImageWarning = {
        kind: 'reference-image-failed',
        message: 'image-edit 响应无 data[0].b64_json（url 形态或空响应——请求 response_format=b64_json 未被网关遵守）',
      };
      warn(deps, input.taskId, warning);
      return { kind: 'failed', warning };
    }
    generatedBytes = new Uint8Array(Buffer.from(data.b64_json, 'base64'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warning: ReferenceImageWarning = {
      kind: 'reference-image-failed',
      message: `image-edit 调用失败：${excerpt(message)}（超时界 ${Math.round(timeoutMs / 1000)}s，env ${REFERENCE_IMAGE_TIMEOUT_ENV} 可调）`,
    };
    warn(deps, input.taskId, warning);
    return { kind: 'failed', warning };
  }
  const generated = decodeOrUndefined(generatedBytes);
  if (generated === undefined) {
    const warning: ReferenceImageWarning = {
      kind: 'reference-image-failed',
      message: 'image-edit 响应图不是可解码 PNG（b64 解码后 decodePng 拒）',
    };
    warn(deps, input.taskId, warning);
    return { kind: 'failed', warning };
  }

  // —— 一致性门（生成成功即自动跑；参考图先对齐原图网格再比对）。
  const consistency = referenceImageConsistency(source, generated, {
    ...(options.consistencyThreshold !== undefined ? { threshold: options.consistencyThreshold } : {}),
  });
  // 工件字节恒=原图网格（服务端 size≠原图时重采样对齐——分件/树锚坐标系自洽；
  // 同尺寸=原样字节零重编码损失由 encodePng 无损保证）。
  const artifactBytes =
    consistency.referenceResized === null
      ? generatedBytes
      : encodePng(
          source.width,
          source.height,
          resampleRgbaArea(generated.rgba, generated.width, generated.height, source.width, source.height),
        );

  // —— 工件落盘（fence 同事务——任务已不可写=软失败，不阻塞 S2 主产物）。
  let blobRef: string;
  let reportRef: string;
  const durationMs = Date.now() - startedAt;
  const report = {
    kind: 'reference-image-report',
    formatVersion: 1,
    decision: consistency.pass ? 'generated' : 'inconsistent',
    provider: route.provider,
    model: route.model,
    durationMs,
    generatedAt: new Date().toISOString(),
    ...(consistency.referenceResized !== null
      ? { generatedSize: consistency.referenceResized }
      : {}),
    sourceImageBlobRef: input.sourceImage.blobRef,
    consistency,
  };
  try {
    blobRef = putTaskArtifact(deps, input.taskId, artifactBytes).hash;
    reportRef = putTaskArtifact(deps, input.taskId, Buffer.from(JSON.stringify(report, null, 1), 'utf8')).hash;
  } catch (error) {
    const fence = error instanceof ArtifactFenceError;
    const warning: ReferenceImageWarning = {
      kind: 'reference-image-failed',
      message: fence
        ? `参考图层工件写入被 fence 拒绝（任务 ${input.taskId} 已不可写）：${error instanceof Error ? error.message : String(error)}`
        : `参考图层工件写入失败：${error instanceof Error ? error.message : String(error)}`,
    };
    warn(deps, input.taskId, warning);
    return { kind: 'failed', warning };
  }

  // —— report 工件帧（数字留痕——过/不过两态都发）+ 参考图层帧（仅过门——不过门
  //    读面（task.detail referenceImage）继续回退原图，工件 blob 保留供人审）。
  try {
    deps.jobs?.emitFor(input.taskId, 'artifact', { blobRef: reportRef, name: REFERENCE_IMAGE_REPORT_ARTIFACT_NAME });
    if (consistency.pass) {
      deps.jobs?.emitFor(input.taskId, 'artifact', { blobRef, name: REFERENCE_IMAGE_ARTIFACT_NAME });
    }
  } catch (error) {
    console.warn('[reference-image] artifact 帧落盘失败（工件 blob 已在——读面按帧缺席回退原图）', error);
  }

  if (consistency.pass) {
    return { kind: 'generated', blobRef, consistency };
  }
  const warning: ReferenceImageWarning = {
    kind: 'reference-image-inconsistent',
    message: `几何一致性门未过：${consistency.suggestion}`,
    consistency,
  };
  warn(deps, input.taskId, warning);
  return { kind: 'inconsistent', blobRef, consistency, warning };
}
