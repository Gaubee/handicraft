/**
 * add-flat-aux-segmentation T6.3 手动导入波测试（design D6——BYOK 路线，2026-10-05）：
 * task.reference.import RPC（直写面：登录+owner 归属校验，无外部计费不走授权桥）：
 *   - happy：scene 锚在场+同图导入（IoU=1）→ ok=true+帧流 reference-image.png/
 *     reference-image-report.json 到场+report provider=manual-import+task.detail
 *     referenceImage 投影 active（consistency.model='manual-import'）。
 *   - 门不过：错位方块图（确定性剪影漂移——blockPng 平移形态）→ BAD_REQUEST
 *     code=reference-import-inconsistent+message 携 IoU 数字+帧流无 reference-image.png。
 *   - 非 PNG：文本字节 → code=reference-import-not-png。
 *   - 非本人 blob：blob 在 store 但无上传归属行 → code=reference-import-not-owned。
 *   - 禁用后导入=再激活：既有生成帧+禁用标记 → 导入新图 → task.detail 回 active
 *     （latest-wins：导入帧压过禁用标记，与 regenerate 强制重跑同语义）。
 * 零外呼（import 面 BYOK 无 image-edit 路由依赖——路由未配置也可导入）；零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import { SceneAnalysisSchema, type CanvasCm, type ImagePx, type SceneElement } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { recordBlobUpload } from '../src/db/blobs.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { SCENE_ANALYSIS_ARTIFACT_NAME } from '../src/kernel/vision/scene-analyze.js';
import { createServices, clientFor, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const CANVAS_CM: CanvasCm = { w: 10, h: 10 };
const IMAGE_PX: ImagePx = { width: 250, height: 250 };

/**
 * 方块剪影图（reference-image.test.ts blockPng 同款形态，250×250 网格对齐 t6 画布）：
 * bg=10 均匀灰 + fg=200 方块——border-median 背景估计+diff 阈值下剪影=方块本身
 * （确定性判据：同图 IoU=1 必过；平移方块=可预计算的 IoU 漂移必拒）。
 */
function blockPng(box: { x: number; y: number; bw: number; bh: number }): Uint8Array {
  const w = 250;
  const h = 250;
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
  return new Uint8Array(encodePng(w, h, rgba));
}

/** 工作锚点图（scene-analysis 引用——一致性门对照物）：居中 126×126 方块。 */
function sourcePng(): Uint8Array {
  return blockPng({ x: 62, y: 62, bw: 126, bh: 126 });
}

/**
 * 错位导入图（门不过形态）：同尺寸方块左移 32px——
 * ∩=94×126、∪=2×126²−∩ → IoU=11844/19908≈0.595 < 0.85（确定性拒，message 携数字）。
 */
function shiftedPng(): Uint8Array {
  return blockPng({ x: 30, y: 62, bw: 126, bh: 126 });
}

const ELEMENTS: SceneElement[] = [
  { name: '花束', category: 'flower', boxPx: { x: 10, y: 8, w: 70, h: 66 }, hint: 'bouquet', suggestDrillWorthy: true },
];

interface T6ImportFixture {
  s: TestServices;
  client: ReturnType<typeof clientFor>;
  sessionId: string;
  taskId: string;
  imageRef: string;
}

/**
 * RPC fixture：services+登录 client+scene-analysis 锚（import 的锚基准——与 regenerate
 * 同源）。刻意**不配置 image-edit 路由**：import=BYOK 直写面，路由缺席不影响导入
 * （对照 regenerate 的 reference-unconfigured typed 拒——两路互补的产品语义）。
 */
async function setupRpc(): Promise<T6ImportFixture> {
  const s = createServices(undefined, { imgDryRun: true });
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'flat-aux t6-import 测试' });
  const taskId = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' }).id;
  const imageRef = s.blobs.put(sourcePng()).hash;
  const analysis = SceneAnalysisSchema.parse({
    kind: 'scene-analysis',
    formatVersion: 1,
    imageBlobRef: imageRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    elements: ELEMENTS,
    createdAt: new Date().toISOString(),
  });
  const analysisRef = putTaskArtifact({ db: s.db, blobs: s.blobs }, taskId, Buffer.from(JSON.stringify(analysis), 'utf8')).hash;
  s.jobs.emitFor(taskId, 'artifact', { blobRef: analysisRef, name: SCENE_ANALYSIS_ARTIFACT_NAME });
  const approvals = new ApprovalService({ db: s.db, jobs: s.jobs });
  const client = clientFor(s.context({ approvals, token: await s.tokenFor() }));
  return { s, client, sessionId, taskId, imageRef };
}

/**
 * 上传导入图（用户资产面）：blobs.put + 上传归属账本行（recordBlobUpload——
 * userOwnsBlobRef 的判定真源；userId 缺省=本人，null=不记录（非本人 blob 用例））。
 */
function uploadOwned(f: T6ImportFixture, bytes: Uint8Array, userId: string | null = f.s.anonymous.id): string {
  const ref = f.s.blobs.put(bytes).hash;
  if (userId !== null) recordBlobUpload(f.s.db, ref, userId);
  return ref;
}

/** 帧流 artifact 帧名清单（在场判定锚）。 */
function artifactNames(f: T6ImportFixture): string[] {
  return f.s
    .jobs.frames(f.s.anonymous, f.taskId, 0)
    .frames.filter((frame) => frame.kind === 'artifact')
    .map((frame) => (frame.payload as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');
}

/** 帧流指定 artifact 帧的最新 blobRef（读 report 工件字节用）。 */
function latestArtifactRef(f: T6ImportFixture, name: string): string | null {
  const frames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames;
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'artifact') continue;
    const payload = frame.payload as { name?: unknown; blobRef?: unknown };
    if (payload.name === name && typeof payload.blobRef === 'string') return payload.blobRef;
  }
  return null;
}

/** 落既有参考图层生成帧（禁用→再激活用例的 plant 形态——t6 plantReference 同款）。 */
function plantReference(f: T6ImportFixture): string {
  const blobRef = putTaskArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, blockPng({ x: 40, y: 40, bw: 170, bh: 170 })).hash;
  f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef, name: 'reference-image.png' });
  return blobRef;
}

// ---------------------------------------------------------------- [T6.3] task.reference.import

describe('T6.3 task.reference.import（BYOK 手动导入直写面）', () => {
  it('happy：同图导入（IoU=1）→ ok+双帧到场+report provider=manual-import+task.detail 投影 active', async () => {
    const f = await setupRpc();
    const importRef = uploadOwned(f, sourcePng());
    const out = await f.client.task.reference.import({ taskId: f.taskId, imageBlobRef: importRef });
    expect(out).toMatchObject({
      ok: true,
      blobRef: expect.any(String),
      importedAt: expect.any(String),
      consistency: { iou: 1, threshold: 0.85, pass: true, model: 'manual-import' },
    });
    // 帧流：工件双帧到场（生效帧+数字留痕帧）
    const names = artifactNames(f);
    expect(names).toContain('reference-image.png');
    expect(names).toContain('reference-image-report.json');
    // report 工件字节：provider=manual-import（版本史审计面——与生成路 provider 可判别）
    const reportRef = latestArtifactRef(f, 'reference-image-report.json');
    expect(reportRef).not.toBeNull();
    const report = JSON.parse((f.s.blobs.read(reportRef!) ?? Buffer.alloc(0)).toString('utf8')) as {
      provider?: string;
      decision?: string;
    };
    expect(report.provider).toBe('manual-import');
    expect(report.decision).toBe('generated');
    // task.detail：referenceImage 投影 active（分件真源=导入工件本体+一致性数字）
    const detail = await f.client.task.detail({ taskId: f.taskId });
    expect(detail.referenceImage).toMatchObject({
      blobRef: out.blobRef,
      generated: true,
      referenceBlobRef: out.blobRef,
    });
    expect(detail.referenceImage?.disabled).toBeUndefined();
    expect(detail.referenceImage?.consistency).toMatchObject({ iou: 1, pass: true, model: 'manual-import' });
    f.s.dispose();
  });

  it('门不过：错位图 → BAD_REQUEST code=reference-import-inconsistent+message 携 IoU 数字+帧流无 reference-image.png', async () => {
    const f = await setupRpc();
    const importRef = uploadOwned(f, shiftedPng());
    const failure = await f.client.task.reference.import({ taskId: f.taskId, imageBlobRef: importRef }).then(
      () => {
        throw new Error('错位图导入应被几何一致性门拒');
      },
      (error: { code?: unknown; data?: { code?: unknown }; message?: unknown }) => error,
    );
    expect(failure.code).toBe('BAD_REQUEST');
    expect(failure.data).toMatchObject({ code: 'reference-import-inconsistent' });
    // message 携数字（IoU≈0.595=11844/19908——suggestion 文本人读留痕）
    expect(String(failure.message)).toMatch(/IoU 0\.\d+/);
    expect(String(failure.message)).toContain('0.595');
    // 帧流无生效帧（不过门=工件不落任务域，读面继续回退原图）
    expect(artifactNames(f)).not.toContain('reference-image.png');
    f.s.dispose();
  });

  it('非 PNG：上传文本字节 → code=reference-import-not-png', async () => {
    const f = await setupRpc();
    const textRef = uploadOwned(f, new TextEncoder().encode('not a png — flat-aux t6-import'));
    await expect(f.client.task.reference.import({ taskId: f.taskId, imageBlobRef: textRef })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      data: { code: 'reference-import-not-png' },
    });
    f.s.dispose();
  });

  it('非本人 blob：无上传归属行 → code=reference-import-not-owned（字节可读也不放行）', async () => {
    const f = await setupRpc();
    const foreignRef = uploadOwned(f, sourcePng(), null);
    await expect(f.client.task.reference.import({ taskId: f.taskId, imageBlobRef: foreignRef })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      data: { code: 'reference-import-not-owned' },
    });
    f.s.dispose();
  });

  it('禁用后导入=再激活：禁用标记在场 → 导入新图 → task.detail 回 active（导入帧压过标记）', async () => {
    const f = await setupRpc();
    plantReference(f);
    await f.client.task.reference.disable({ taskId: f.taskId });
    const disabled = await f.client.task.detail({ taskId: f.taskId });
    expect(disabled.referenceImage).toMatchObject({ generated: true, disabled: true });
    // 导入新图（同图过门）——latest-wins：新 reference-image.png 帧压过禁用标记
    const importRef = uploadOwned(f, sourcePng());
    const out = await f.client.task.reference.import({ taskId: f.taskId, imageBlobRef: importRef });
    expect(out.ok).toBe(true);
    const detail = await f.client.task.detail({ taskId: f.taskId });
    expect(detail.referenceImage).toMatchObject({
      blobRef: out.blobRef,
      generated: true,
      referenceBlobRef: out.blobRef,
    });
    expect(detail.referenceImage?.disabled).toBeUndefined();
    f.s.dispose();
  });
});
