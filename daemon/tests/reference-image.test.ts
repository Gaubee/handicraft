/**
 * 参考图层生成通道单测（add-flat-aux-segmentation T2——design D2，2026-10-04）。
 * 覆盖四块：
 *   [1] OWNER_FLATTEN_PROMPT 逐字节锚定（防漂移——常量被改任何一字节即红；副本与
 *       常量两处独立落盘，diff 审查可见双改）。
 *   [2] referenceImageConsistency 一致性门纯函数（同图 IoU=1 过/错位图 fail 带数字
 *       明细/尺寸不同先对齐/双空剪影=1）。
 *   [3] generateReferenceImage 编排（unconfigured 零外呼/mock 生成成功 wire+工件+帧
 *       +report/HTTP 坏/坏 b64/幂等零外呼/门不过→工件保留帧缺席/尺寸对齐落盘）。
 *   [4] style 触发集成（photographic 生成/flat 不生成/无 style 不生成/未配置软回退
 *       S2 照常 ok——scene.analyze capability 编排点）。
 * 零真实外呼：image-edit fetch 全替身注入；零常驻（每用例 dispose）。
 */
import { describe, expect, it } from 'vitest';
import { encodePng, decodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { saveModelsConfig } from '../src/models-store.js';
import {
  generateReferenceImage,
  OWNER_FLATTEN_PROMPT,
  REFERENCE_IMAGE_ARTIFACT_NAME,
  REFERENCE_IMAGE_REPORT_ARTIFACT_NAME,
  referenceImageConsistency,
} from '../src/kernel/vision/reference-image.js';
import { createVisionCapabilities } from '../src/kernel/vision/scene-analyze.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture 图构造

/** 方块剪影图：bg 均匀背景+fg 均匀方块（确定性剪影——border-median+diff 的稳定判据）。 */
function blockPng(
  w: number,
  h: number,
  box: { x: number; y: number; bw: number; bh: number },
): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w;
    const y = Math.floor(i / w);
    const fg = x >= box.x && x < box.x + box.bw && y >= box.y && y < box.y + box.bh;
    const v = fg ? 200 : 10;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(w, h, rgba);
}

/** image-edit mock fetch：记录调用（url/init），按 handler 出 Response。 */
interface ImageEditFetchMock {
  fetchImpl: typeof globalThis.fetch;
  calls: Array<{ url: string; init: RequestInit }>;
}

function mockImageEditFetch(
  handler: (url: string, init: RequestInit) => Response | Promise<Response>,
): ImageEditFetchMock {
  const calls: ImageEditFetchMock['calls'] = [];
  const fetchImpl = ((url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    const initRecord = init ?? {};
    calls.push({ url: String(url), init: initRecord });
    return Promise.resolve(handler(String(url), initRecord));
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** b64_json 响应（OpenAI images/edits 兼容形态 data[0].b64_json）。 */
function b64Response(png: Uint8Array): Response {
  return jsonResponse({ data: [{ b64_json: Buffer.from(png).toString('base64') }] });
}

/** image FormData 回显替身（把请求里的原图原样返回 → 双图全同 IoU=1）。 */
async function echoImageResponse(init: RequestInit): Promise<Response> {
  const form = init.body as FormData;
  const image = form.get('image') as Blob;
  const buffer = await image.arrayBuffer();
  return jsonResponse({ data: [{ b64_json: Buffer.from(buffer).toString('base64') }] });
}

interface RefCtx {
  s: TestServices;
  taskId: string;
  sourceRef: string;
}

/** 生成编排 fixture：agent 任务+工作锚点图（64×64 方块剪影）。 */
function setupRef(): RefCtx {
  const s = createServices();
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'reference-image 测试' });
  const taskId = createAgentTask(s.db, {
    ownerId: s.anonymous.id,
    sessionId,
    paramsJson: JSON.stringify({ kind: 'reference-image-test' }),
  }).id;
  const sourceRef = s.blobs.put(blockPng(64, 64, { x: 16, y: 16, bw: 32, bh: 32 })).hash;
  return { s, taskId, sourceRef };
}

/** 配 image-edit 路由+对话路由（baseURL 指向假网关——外呼由 fetchImpl 替身拦截）。
 * 对话路由必须同配：saveModelsConfig 即 settings 初始化（models-store P1-3——.env
 * 回退永久阻断），scene.analyze 通道 B 的 resolveLlmRoute 需要 keyed 对话路由在场
 * （image-edit 路由被对话解析排除）。 */
function wireImageEditRoute(s: TestServices, baseURL = 'http://127.0.0.1:9/imgedit'): void {
  const chatBase = baseURL.replace(/\/imgedit$/, '');
  saveModelsConfig(s.db, {
    routes: [
      {
        provider: 'zai-prod',
        api: 'openai-completions',
        baseURL: `${chatBase}/v1`,
        apiKey: 'sk-analyze',
        models: [{ id: 'glm-4.6v' }],
      },
      {
        provider: 'imgedit-prod',
        api: 'openai-image-edit',
        baseURL,
        apiKey: 'sk-image-edit-test',
        models: [{ id: 'gpt-image-edit-x' }, { id: 'gpt-image-edit-y' }],
      },
    ],
    default: { provider: 'zai-prod', model: 'glm-4.6v' },
  });
}

/** 任务 artifact 帧名集合（帧流读面）。 */
function artifactFrameNames(ctx: RefCtx): Array<{ name: string; blobRef: string }> {
  return ctx.s.jobs
    .frames(ctx.s.anonymous, ctx.taskId, 0)
    .frames.filter((frame) => frame.kind === 'artifact')
    .map((frame) => frame.payload as { blobRef: string; name: string });
}

// ---------------------------------------------------------------- [1] Owner 提示词逐字锚定

/**
 * 副本（2026-10-04 冻结快照——源=主仓 experiments/sam-playbook-20261004/
 * iter-5-flat-ab/owner-flatten-prompt.md 代码块；3874 字节，
 * sha256=d1a3371bb4efcec2d6be582a226645a80a804f8f424cb9487fa4c4322f8944af）。
 * 本副本与常量两处独立落盘：任何一方被改（哪怕一个字节/一处空白）测试即红——
 * 修 Owner 提示词=Owner 资产变更，必须两处同改+更新本注释的 sha256。
 */
const OWNER_FLATTEN_PROMPT_ANCHOR = `Edit the input image with the following strict priority:

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

describe('OWNER_FLATTEN_PROMPT 逐字节锚定（防漂移）', () => {
  it('常量=冻结快照副本（逐字节 ===；行数/首尾行/关键句在场）', () => {
    expect(OWNER_FLATTEN_PROMPT).toBe(OWNER_FLATTEN_PROMPT_ANCHOR);
    expect(Buffer.byteLength(OWNER_FLATTEN_PROMPT, 'utf8')).toBe(3874);
    const lines = OWNER_FLATTEN_PROMPT.split('\n');
    expect(lines).toHaveLength(71); // 70 行文本+结尾换行的空尾段
    expect(lines[0]).toBe('Edit the input image with the following strict priority:');
    expect(lines[69]).toBe(
      'but with gradients, lighting, shadows, texture, jewelry, gemstones, reflections, and decorative surface details removed.',
    );
    // Owner 语义骨架（改写即漂移——逐段抽查）
    for (const phrase of [
      'PRESERVE THE ORIGINAL SHAPES AND CONTOURS EXACTLY.',
      'Remove jewelry, gemstones, rhinestones, beads, sequins, glitter, embroidery, decorative particles, and similar surface ornaments.',
      'Contour preservation has absolute priority over visual quality.',
      'same silhouettes, same contours, same composition, same major color regions,',
    ]) {
      expect(OWNER_FLATTEN_PROMPT).toContain(phrase);
    }
  });
});

// ---------------------------------------------------------------- [2] 一致性门纯函数

describe('referenceImageConsistency（border-median+diff 双剪影 IoU）', () => {
  const SOURCE = {
    width: 64,
    height: 64,
    rgba: decodePng(blockPng(64, 64, { x: 16, y: 16, bw: 32, bh: 32 })).rgba,
  };

  it('同图 → IoU=1.0 过（referenceResized=null；覆盖率=方块占比 25%）', () => {
    const report = referenceImageConsistency(SOURCE, SOURCE);
    expect(report.iou).toBe(1);
    expect(report.pass).toBe(true);
    expect(report.threshold).toBe(0.85);
    expect(report.referenceResized).toBeNull();
    expect(report.sourceCoverage).toBeCloseTo(0.25, 2);
    expect(report.referenceCoverage).toBeCloseTo(0.25, 2);
  });

  it('错位图 → fail 携数字明细（IoU≈0.391/双覆盖率/建议）', () => {
    const shifted = {
      width: 64,
      height: 64,
      rgba: decodePng(blockPng(64, 64, { x: 4, y: 4, bw: 32, bh: 32 })).rgba,
    };
    const report = referenceImageConsistency(SOURCE, shifted);
    // A=(16..48)² B=(4..36)²：∩=[16,36)²=20×20=400，∪=1024+1024−400=1648 → IoU≈0.243
    expect(report.iou).toBeCloseTo(400 / 1648, 2);
    expect(report.pass).toBe(false);
    expect(report.sourceCoverage).toBeCloseTo(0.25, 2);
    expect(report.referenceCoverage).toBeCloseTo(0.25, 2);
    expect(report.suggestion).toContain('0.243');
    expect(report.suggestion).toContain('回退原图');
  });

  it('尺寸不同 → 先对齐（resampleRgbaArea）再比对；整数倍缩放 IoU=1 过', () => {
    const doubled = {
      width: 128,
      height: 128,
      rgba: decodePng(blockPng(128, 128, { x: 32, y: 32, bw: 64, bh: 64 })).rgba,
    };
    const report = referenceImageConsistency(SOURCE, doubled);
    expect(report.referenceResized).toEqual({ width: 128, height: 128 });
    expect(report.iou).toBe(1); // 2:1 整数倍——方块边界精确对齐，剪影零漂移
    expect(report.pass).toBe(true);
  });

  it('双空剪影（纯背景对纯背景）= IoU 1（同一背景图一致）；单空=0 fail', () => {
    const empty = { width: 32, height: 32, rgba: decodePng(blockPng(32, 32, { x: 0, y: 0, bw: 0, bh: 0 })).rgba };
    expect(referenceImageConsistency(empty, empty).iou).toBe(1);
    const block = { width: 32, height: 32, rgba: decodePng(blockPng(32, 32, { x: 8, y: 8, bw: 16, bh: 16 })).rgba };
    const cross = referenceImageConsistency(empty, block);
    expect(cross.iou).toBe(0); // ∩=0、∪=方块 256 → 0
    expect(cross.pass).toBe(false);
  });
});

// ---------------------------------------------------------------- [3] 生成编排

describe('generateReferenceImage（软失败全路径+幂等）', () => {
  it('未配置 → unconfigured typed warning，零外呼', async () => {
    const ctx = setupRef();
    try {
      const mock = mockImageEditFetch(() => jsonResponse({}));
      const outcome = await generateReferenceImage(
        { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs },
        { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } },
        { fetchImpl: mock.fetchImpl },
      );
      expect(outcome).toMatchObject({ kind: 'unconfigured' });
      if (outcome.kind === 'unconfigured') {
        expect(outcome.warning.kind).toBe('reference-image-unconfigured');
        expect(outcome.warning.message).toContain('openai-image-edit');
      }
      expect(mock.calls).toHaveLength(0);
    } finally {
      ctx.s.dispose();
    }
  });

  it('生成成功（同图回显）→ generated：wire 形态+双工件帧+工件尺寸=原图网格', async () => {
    const ctx = setupRef();
    try {
      wireImageEditRoute(ctx.s);
      const mock = mockImageEditFetch((url, init) => {
        expect(url).toBe('http://127.0.0.1:9/imgedit/images/edits');
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-image-edit-test');
        return echoImageResponse(init);
      });
      const outcome = await generateReferenceImage(
        { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs },
        { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } },
        { fetchImpl: mock.fetchImpl },
      );
      expect(outcome.kind).toBe('generated');
      if (outcome.kind !== 'generated') return;
      expect(outcome.consistency.iou).toBe(1);
      expect(outcome.consistency.pass).toBe(true);

      // wire：multipart 字段（Owner 提示词逐字+model+size+response_format+image PNG）
      expect(mock.calls).toHaveLength(1);
      const form = mock.calls[0]!.init.body as FormData;
      expect(form.get('prompt')).toBe(OWNER_FLATTEN_PROMPT);
      expect(form.get('model')).toBe('gpt-image-edit-x'); // 首模型（无 default）
      expect(form.get('size')).toBe('auto');
      expect(form.get('response_format')).toBe('b64_json');
      const sentImage = await (form.get('image') as Blob).arrayBuffer();
      const sent = decodePng(new Uint8Array(sentImage));
      expect({ width: sent.width, height: sent.height }).toEqual({ width: 64, height: 64 });

      // 工件+帧：reference-image.png（分件真源）+reference-image-report.json（数字留痕）
      const frames = artifactFrameNames(ctx);
      expect(frames).toEqual(
        expect.arrayContaining([
          { blobRef: outcome.blobRef, name: REFERENCE_IMAGE_ARTIFACT_NAME },
          expect.objectContaining({ name: REFERENCE_IMAGE_REPORT_ARTIFACT_NAME }),
        ]),
      );
      const artifact = ctx.s.blobs.read(outcome.blobRef);
      expect(artifact).not.toBeNull();
      const decoded = decodePng(artifact!);
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 64, height: 64 });
      const reportFrame = frames.find((f) => f.name === REFERENCE_IMAGE_REPORT_ARTIFACT_NAME)!;
      const report = JSON.parse(ctx.s.blobs.read(reportFrame.blobRef)!.toString('utf8'));
      expect(report).toMatchObject({
        kind: 'reference-image-report',
        decision: 'generated',
        provider: 'imgedit-prod',
        model: 'gpt-image-edit-x',
      });
      expect(report['consistency']['iou']).toBe(1);
    } finally {
      ctx.s.dispose();
    }
  });

  it('幂等：reference-image.png 帧在场 → skipped 零外呼（不重生成）', async () => {
    const ctx = setupRef();
    try {
      wireImageEditRoute(ctx.s);
      const mock = mockImageEditFetch((_url, init) => echoImageResponse(init));
      const deps = { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs };
      const input = { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } };
      const first = await generateReferenceImage(deps, input, { fetchImpl: mock.fetchImpl });
      expect(first.kind).toBe('generated');
      const second = await generateReferenceImage(deps, input, { fetchImpl: mock.fetchImpl });
      expect(second).toMatchObject({ kind: 'skipped', reason: 'artifact-present' });
      if (second.kind === 'skipped') expect(second.blobRef).toBe((first as { blobRef: string }).blobRef);
      expect(mock.calls).toHaveLength(1); // 第二次零外呼
    } finally {
      ctx.s.dispose();
    }
  });

  it('HTTP 坏 → failed typed warning（软失败回退原图语义；零工件帧）', async () => {
    const ctx = setupRef();
    try {
      wireImageEditRoute(ctx.s);
      const mock = mockImageEditFetch(() => jsonResponse({ error: 'boom' }, 502));
      const outcome = await generateReferenceImage(
        { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs },
        { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } },
        { fetchImpl: mock.fetchImpl },
      );
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') {
        expect(outcome.warning.kind).toBe('reference-image-failed');
        expect(outcome.warning.message).toContain('502');
      }
      expect(artifactFrameNames(ctx)).toEqual([]);
    } finally {
      ctx.s.dispose();
    }
  });

  it('响应无 b64_json → failed（url 形态未遵守 response_format）', async () => {
    const ctx = setupRef();
    try {
      wireImageEditRoute(ctx.s);
      const mock = mockImageEditFetch(() => jsonResponse({ data: [{ url: 'https://cdn/x.png' }] }));
      const outcome = await generateReferenceImage(
        { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs },
        { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } },
        { fetchImpl: mock.fetchImpl },
      );
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') expect(outcome.warning.message).toContain('b64_json');
    } finally {
      ctx.s.dispose();
    }
  });

  it('响应 b64 非 PNG → failed', async () => {
    const ctx = setupRef();
    try {
      wireImageEditRoute(ctx.s);
      const mock = mockImageEditFetch(() =>
        jsonResponse({ data: [{ b64_json: Buffer.from('not-a-png').toString('base64') }] }),
      );
      const outcome = await generateReferenceImage(
        { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs },
        { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } },
        { fetchImpl: mock.fetchImpl },
      );
      expect(outcome.kind).toBe('failed');
      if (outcome.kind === 'failed') expect(outcome.warning.message).toContain('PNG');
    } finally {
      ctx.s.dispose();
    }
  });

  it('门不过（错位图）→ inconsistent：工件保留供人审+report 帧留数字，reference-image.png 帧缺席（读面回退原图）', async () => {
    const ctx = setupRef();
    try {
      wireImageEditRoute(ctx.s);
      const drifted = blockPng(64, 64, { x: 4, y: 4, bw: 32, bh: 32 });
      const mock = mockImageEditFetch(() => b64Response(drifted));
      const deps = { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs };
      const input = { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } };
      const outcome = await generateReferenceImage(deps, input, { fetchImpl: mock.fetchImpl });
      expect(outcome.kind).toBe('inconsistent');
      if (outcome.kind !== 'inconsistent') return;
      expect(outcome.warning.kind).toBe('reference-image-inconsistent');
      expect(outcome.warning.consistency?.iou).toBeCloseTo(400 / 1648, 2);
      expect(outcome.consistency.pass).toBe(false);
      // 工件 blob 在（人审）但 reference-image.png artifact 帧不在（读面继续回退原图）
      expect(ctx.s.blobs.read(outcome.blobRef)).not.toBeNull();
      const names = artifactFrameNames(ctx).map((f) => f.name);
      expect(names).not.toContain(REFERENCE_IMAGE_ARTIFACT_NAME);
      expect(names).toContain(REFERENCE_IMAGE_REPORT_ARTIFACT_NAME);
      // 无帧=幂等不生效——好结果重试可恢复（换 mock 证明二次外呼发生且成功落帧）
      const mock2 = mockImageEditFetch((_url, init) => echoImageResponse(init));
      const retry = await generateReferenceImage(deps, input, { fetchImpl: mock2.fetchImpl });
      expect(retry.kind).toBe('generated');
      expect(mock2.calls).toHaveLength(1);
      expect(artifactFrameNames(ctx).map((f) => f.name)).toContain(REFERENCE_IMAGE_ARTIFACT_NAME);
    } finally {
      ctx.s.dispose();
    }
  });

  it('服务端回非原图尺寸 → 落盘工件对齐原图网格（分件坐标系自洽；report 记生成尺寸）', async () => {
    const ctx = setupRef();
    try {
      wireImageEditRoute(ctx.s);
      const doubled = blockPng(128, 128, { x: 32, y: 32, bw: 64, bh: 64 }); // 2x 同结构
      const mock = mockImageEditFetch(() => b64Response(doubled));
      const outcome = await generateReferenceImage(
        { db: ctx.s.db, blobs: ctx.s.blobs, jobs: ctx.s.jobs },
        { taskId: ctx.taskId, sourceImage: { blobRef: ctx.sourceRef } },
        { fetchImpl: mock.fetchImpl },
      );
      expect(outcome.kind).toBe('generated');
      if (outcome.kind !== 'generated') return;
      expect(outcome.consistency.referenceResized).toEqual({ width: 128, height: 128 });
      const decoded = decodePng(ctx.s.blobs.read(outcome.blobRef)!);
      expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 64, height: 64 });
      const reportFrame = artifactFrameNames(ctx).find((f) => f.name === REFERENCE_IMAGE_REPORT_ARTIFACT_NAME)!;
      const report = JSON.parse(ctx.s.blobs.read(reportFrame.blobRef)!.toString('utf8'));
      expect(report['generatedSize']).toEqual({ width: 128, height: 128 });
    } finally {
      ctx.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] style 触发集成（scene.analyze 编排点）

/** scene.analyze 通道 B mock 响应载荷（openai-completions content JSON——style 可缺席）。 */
function analyzePayload(style?: string): string {
  const payload: Record<string, unknown> = {
    elements: [
      {
        name: '小丑',
        category: 'face',
        boxPx: { x: 10, y: 10, w: 40, h: 28 },
        hint: 'clown',
        suggestDrillWorthy: true,
        confidence: 0.9,
        elementId: 'el-0001',
        parentElementId: null,
      },
    ],
  };
  if (style !== undefined) payload['style'] = style;
  return JSON.stringify(payload);
}

/** 双端 mock fetch：/chat/completions 出分析响应（style 可控）；/images/edits 出参考图层响应。 */
function analyzeWithImageEdit(
  style: string | undefined,
  imageEdit: (init: RequestInit) => Response | Promise<Response>,
): ImageEditFetchMock {
  return mockImageEditFetch((url, init) => {
    if (url.endsWith('/chat/completions')) {
      return jsonResponse({
        choices: [{ message: { role: 'assistant', content: analyzePayload(style) } }],
      });
    }
    if (url.endsWith('/images/edits')) return imageEdit(init);
    return jsonResponse({ error: `unexpected ${url}` }, 404);
  });
}

function setupScene(): RefCtx {
  const s = createServices();
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'ref-trigger 测试' });
  const taskId = createAgentTask(s.db, {
    ownerId: s.anonymous.id,
    sessionId,
    paramsJson: JSON.stringify({ kind: 'ref-trigger-test' }),
  }).id;
  const sourceRef = s.blobs.put(blockPng(64, 48, { x: 16, y: 12, bw: 32, bh: 24 })).hash;
  return { s, taskId, sourceRef };
}

/** 集成装配+调用（analyzerOptions 与 referenceImageOptions 注入同一 fetchImpl）。 */
async function runSceneAnalyze(
  ctx: RefCtx,
  mock: ImageEditFetchMock,
): Promise<{ value: Record<string, unknown> }> {
  ctx.s.config.llm.provider = 'zai';
  ctx.s.config.llm.baseUrl = 'http://127.0.0.1:9/v1';
  ctx.s.config.llm.apiKey = 'sk-analyze';
  ctx.s.config.llm.model = 'glm-5.3-flash';
  ctx.s.config.llm.api = '';
  ctx.s.config.llm.visionModel = 'glm-4.6v';
  const registry = createVisionCapabilities({
    db: ctx.s.db,
    blobs: ctx.s.blobs,
    dataRoot: ctx.s.config.dataRoot,
    llm: ctx.s.config.llm,
    jobs: ctx.s.jobs,
    analyzerOptions: { live: true, fetchImpl: mock.fetchImpl },
    referenceImageOptions: { fetchImpl: mock.fetchImpl },
  });
  const result = await registry.call(
    'studio.scene.analyze',
    {
      taskId: ctx.taskId,
      imageBlobRef: ctx.sourceRef,
      imagePx: { width: 64, height: 48 },
      canvasCm: { w: 20, h: 15 },
    },
    'agent',
  );
  expect(result).toMatchObject({ kind: 'ok' });
  return { value: (result as { value: Record<string, unknown> }).value };
}

describe('style 触发集成（S2→S3 编排点——D1 判定驱动 D2 生成）', () => {
  it('photographic → 自动生成（生成输入=工作锚点图；结果面 referenceImage 摘要+帧就位）', async () => {
    const ctx = setupScene();
    try {
      wireImageEditRoute(ctx.s, 'http://127.0.0.1:9/v1'); // 与 LLM 同 mock 网关前缀
      const mock = analyzeWithImageEdit('photographic', echoImageResponse);
      const { value } = await runSceneAnalyze(ctx, mock);
      const referenceImage = value['referenceImage'] as { kind: string };
      expect(referenceImage?.kind).toBe('generated');
      // 生成输入=工作锚点图（intake 升采 64×48→500×375 后——images/edits 收到的 image）
      const editCall = mock.calls.find((call) => call.url.endsWith('/images/edits'))!;
      const sentPng = new Uint8Array(await ((editCall.init.body as FormData).get('image') as Blob).arrayBuffer());
      const sent = decodePng(sentPng);
      expect({ width: sent.width, height: sent.height }).toEqual({ width: 500, height: 375 });
      // 帧流：reference-image.png 工件帧就位（task.detail 投影 generated=true 的判定锚）
      const frames = artifactFrameNames(ctx).map((f) => f.name);
      expect(frames).toContain(REFERENCE_IMAGE_ARTIFACT_NAME);
      expect(frames).toContain(REFERENCE_IMAGE_REPORT_ARTIFACT_NAME);
    } finally {
      ctx.s.dispose();
    }
  });

  it('flat → 不生成（image-edit 零调用；结果面无 referenceImage 字段）', async () => {
    const ctx = setupScene();
    try {
      wireImageEditRoute(ctx.s, 'http://127.0.0.1:9/v1');
      const mock = analyzeWithImageEdit('flat', (_init) => jsonResponse({}));
      const { value } = await runSceneAnalyze(ctx, mock);
      expect(value['referenceImage']).toBeUndefined();
      expect(mock.calls.filter((call) => call.url.endsWith('/images/edits'))).toHaveLength(0);
    } finally {
      ctx.s.dispose();
    }
  });

  it('无 style 判定（mock 缺省）→ 不生成（判定失败缺省=原图流程不阻塞）', async () => {
    const ctx = setupScene();
    try {
      wireImageEditRoute(ctx.s, 'http://127.0.0.1:9/v1');
      const mock = analyzeWithImageEdit(undefined, (_init) => jsonResponse({}));
      const { value } = await runSceneAnalyze(ctx, mock);
      expect(value['referenceImage']).toBeUndefined();
      expect(mock.calls.filter((call) => call.url.endsWith('/images/edits'))).toHaveLength(0);
    } finally {
      ctx.s.dispose();
    }
  });

  it('photographic 但 image-edit 未配置 → unconfigured 软回退，S2 结果照常 ok', async () => {
    const ctx = setupScene();
    try {
      const mock = analyzeWithImageEdit('photographic', (_init) => jsonResponse({}));
      const { value } = await runSceneAnalyze(ctx, mock);
      const referenceImage = value['referenceImage'] as { kind: string };
      expect(referenceImage?.kind).toBe('unconfigured');
      expect((value['analysis'] as { elements: unknown[] }).elements).toHaveLength(1);
      expect(mock.calls.filter((call) => call.url.endsWith('/images/edits'))).toHaveLength(0);
    } finally {
      ctx.s.dispose();
    }
  });
});
