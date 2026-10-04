/**
 * add-flat-aux-segmentation T6 波测试（design D6——工作台参考图层操作面，2026-10-04）：
 *   [T6.1] referenceImageStateOf 帧流三态纯函数（latest-wins：生成帧/禁用标记帧/
 *          重申生成帧/裸标记防御面）。
 *   [T6.2] task.reference.disable/enable RPC（直写面）：三态校验（absent/already/
 *          not-disabled typed 拒）+task.detail 扩展投影（disabled/referenceBlobRef/
 *          consistency）。
 *   [T6.3] task.reference.regenerate RPC（approved-mutation 双模——stones.add A 修法
 *          形态）：未配置 typed 拒带指引/手动两态（approval-request 帧→未批执行拒→
 *          批准后执行 generated）/autoApprove 会话立即执行指令/幂等清（既有帧不拦
 *          强制外呼）/执行后 op 终态收敛+重放拒。
 *   [T6.4] 禁用后分件回退集成：disable → subject.segment 送桥输入回退原图；enable
 *          → 恢复用参考图层（latestReferenceImageBlobRef 单源三态的端到端证明）。
 * 零真实外呼（globalThis.fetch/合成 SAM 桥替身）；零常驻进程（每用例 dispose）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SceneAnalysisSchema, type CanvasCm, type ImagePx, type SceneElement } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { saveModelsConfig } from '../src/models-store.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { SamBridge } from '../src/kernel/vision/sam-bridge.js';
import {
  createSubjectSegmentCapabilities,
  createSyntheticMockSamTransport,
  type SubjectSegmentOutcome,
} from '../src/kernel/vision/segment-tool.js';
import {
  disableReferenceImage,
  enableReferenceImage,
  generateReferenceImage,
  latestReferenceImageBlobRef,
  referenceImageStateOf,
} from '../src/kernel/vision/reference-image.js';
import { SCENE_ANALYSIS_ARTIFACT_NAME } from '../src/kernel/vision/scene-analyze.js';
import { createServices, clientFor, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const CANVAS_CM: CanvasCm = { w: 10, h: 10 };
const IMAGE_PX: ImagePx = { width: 250, height: 250 };

/** 250×250 三色测试图（flat-aux-t4 同款形态——S0 归一面形状）。 */
function testImage(): Uint8Array {
  const w = 250;
  const h = 250;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const [r, g, b] = y >= h - 42 ? [230, 200, 40] : x < w / 2 ? [200, 40, 40] : [40, 60, 200];
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
    }
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

/** 参考图层替身（同网格异色——blobRef/送桥请求可判别）。 */
function referenceImagePng(): Uint8Array {
  const rgba = new Uint8Array(250 * 250 * 4);
  for (let p = 0; p < 250 * 250; p++) {
    rgba[p * 4] = 120;
    rgba[p * 4 + 1] = 140;
    rgba[p * 4 + 2] = 60;
    rgba[p * 4 + 3] = 255;
  }
  return new Uint8Array(encodePng(250, 250, rgba));
}

const ELEMENTS: SceneElement[] = [
  { name: '花束', category: 'flower', boxPx: { x: 10, y: 8, w: 70, h: 66 }, hint: 'bouquet', suggestDrillWorthy: true },
];

/** image-edit fetch 替身（记录调用+回显请求原图——双图全同 IoU=1 必过门）。 */
function echoImageEditFetch(): { fetchImpl: typeof globalThis.fetch; calls: () => number } {
  const calls = { count: 0 };
  const fetchImpl = (async (_url: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
    calls.count += 1;
    const form = init?.body as FormData;
    const image = form.get('image') as Blob;
    const buffer = await image.arrayBuffer();
    return new Response(
      JSON.stringify({ data: [{ b64_json: Buffer.from(buffer).toString('base64') }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls: () => calls.count };
}

interface T6Fixture {
  s: TestServices;
  client: ReturnType<typeof clientFor>;
  approvals: ApprovalService;
  sessionId: string;
  taskId: string;
  imageRef: string;
}

/** RPC fixture：services+approvals+登录 client；可选落 scene-analysis 锚（baseImage/生成锚）。 */
async function setupRpc(withScene = true, withImageEditRoute = true): Promise<T6Fixture> {
  const s = createServices(undefined, { imgDryRun: true });
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'flat-aux t6 测试' });
  const taskId = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' }).id;
  const imageRef = s.blobs.put(testImage()).hash;
  if (withImageEditRoute) {
    saveModelsConfig(s.db, {
      routes: [
        {
          provider: 'zai-prod',
          api: 'openai-completions',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKey: 'sk-analyze',
          models: [{ id: 'glm-4.6v' }],
        },
        {
          provider: 'imgedit-prod',
          api: 'openai-image-edit',
          baseURL: 'http://127.0.0.1:9/imgedit',
          apiKey: 'sk-image-edit-test',
          models: [{ id: 'gpt-image-edit-x' }],
        },
      ],
      default: { provider: 'zai-prod', model: 'glm-4.6v' },
    });
  }
  if (withScene) {
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
  }
  const approvals = new ApprovalService({ db: s.db, jobs: s.jobs });
  const client = clientFor(s.context({ approvals, token: await s.tokenFor() }));
  return { s, client, approvals, sessionId, taskId, imageRef };
}

/** 落参考图层工件+帧+report 工件（detail 投影/禁用面 fixture）。 */
function plantReference(f: T6Fixture, options: { withReport?: boolean } = {}): string {
  const blobRef = putTaskArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, referenceImagePng()).hash;
  f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef, name: 'reference-image.png' });
  if (options.withReport === true) {
    const report = {
      kind: 'reference-image-report',
      formatVersion: 1,
      decision: 'generated',
      provider: 'imgedit-prod',
      model: 'gpt-image-edit-x',
      durationMs: 1234,
      generatedAt: '2026-10-04T08:00:00.000Z',
      sourceImageBlobRef: f.imageRef,
      consistency: {
        iou: 0.97,
        sourceCoverage: 0.5,
        referenceCoverage: 0.5,
        threshold: 0.85,
        pass: true,
        referenceResized: null,
        suggestion: 'ok',
      },
    };
    const reportRef = putTaskArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, Buffer.from(JSON.stringify(report), 'utf8')).hash;
    f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: reportRef, name: 'reference-image-report.json' });
  }
  return blobRef;
}

/** globalThis.fetch 替身（regenerate RPC 执行走 global fetch——RPC 面无注入点）。 */
let fetchRestore: (() => void) | null = null;
function stubGlobalFetch(impl: typeof globalThis.fetch): void {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  fetchRestore = () => {
    globalThis.fetch = prev;
    fetchRestore = null;
  };
}
afterEach(() => {
  fetchRestore?.();
});

// ---------------------------------------------------------------- [T6.1] 帧流三态纯函数

describe('T6.1 referenceImageStateOf（帧流 latest-wins 三态）', () => {
  const art = (name: string, blobRef: string): { kind: string; payload: { name: string; blobRef: string } } => ({
    kind: 'artifact',
    payload: { name, blobRef },
  });

  it('空帧流=absent；仅生成帧=active（latest-by-name 语义不变）', () => {
    expect(referenceImageStateOf([])).toEqual({ status: 'absent', blobRef: null });
    expect(referenceImageStateOf([art('reference-image.png', 'a'.repeat(64))])).toEqual({
      status: 'active',
      blobRef: 'a'.repeat(64),
    });
  });

  it('禁用标记压过生成帧=disabled（disabledBlobRef=被压过的工件——UI 在档锚）', () => {
    const state = referenceImageStateOf([
      art('reference-image.png', 'a'.repeat(64)),
      art('reference-image-report.json', 'b'.repeat(64)), // 无关键（扫过跳过）
      art('reference-image-disabled.json', 'c'.repeat(64)),
    ]);
    expect(state).toEqual({ status: 'disabled', blobRef: null, disabledBlobRef: 'a'.repeat(64) });
  });

  it('标记后重申/再生生成帧=再激活（enable 与强制重新生成同语义）', () => {
    const state = referenceImageStateOf([
      art('reference-image.png', 'a'.repeat(64)),
      art('reference-image-disabled.json', 'c'.repeat(64)),
      art('reference-image.png', 'd'.repeat(64)),
    ]);
    expect(state).toEqual({ status: 'active', blobRef: 'd'.repeat(64) });
  });

  it('裸标记（生成帧缺席）=disabled 防御面（disabledBlobRef=null）', () => {
    expect(referenceImageStateOf([art('reference-image-disabled.json', 'c'.repeat(64))])).toEqual({
      status: 'disabled',
      blobRef: null,
      disabledBlobRef: null,
    });
  });
});

// ---------------------------------------------------------------- [T6.2] disable/enable RPC + task.detail 投影

describe('T6.2 task.reference.disable/enable + task.detail 扩展投影', () => {
  it('absent 拒（无层可禁用/启用——typed code 带指引）', async () => {
    const f = await setupRpc();
    await expect(f.client.task.reference.disable({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      data: { code: 'reference-absent' },
    });
    await expect(f.client.task.reference.enable({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      data: { code: 'reference-absent' },
    });
    f.s.dispose();
  });

  it('在场→task.detail 三面投影（generated/referenceBlobRef/consistency 数字）', async () => {
    const f = await setupRpc();
    const ref = plantReference(f, { withReport: true });
    const detail = await f.client.task.detail({ taskId: f.taskId });
    expect(detail.referenceImage).toMatchObject({
      blobRef: ref,
      generated: true,
      referenceBlobRef: ref,
    });
    expect(detail.referenceImage?.consistency).toMatchObject({
      iou: 0.97,
      threshold: 0.85,
      pass: true,
      generatedAt: '2026-10-04T08:00:00.000Z',
      model: 'gpt-image-edit-x',
    });
    f.s.dispose();
  });

  it('disable→分件真源回退原图（blobRef=source）+referenceBlobRef 仍指工件+帧留痕；再 disable 拒；enable 复活', async () => {
    const f = await setupRpc();
    const ref = plantReference(f, { withReport: true });
    const disabled = await f.client.task.reference.disable({ taskId: f.taskId });
    expect(disabled).toMatchObject({ ok: true, blobRef: ref });
    // task.detail：禁用态——分件引用回退原图+显式 disabled+工件仍在档
    const after = await f.client.task.detail({ taskId: f.taskId });
    expect(after.referenceImage).toMatchObject({
      blobRef: f.imageRef,
      generated: true,
      disabled: true,
      referenceBlobRef: ref,
    });
    // 帧留痕（log 帧人读文本——版本史/活动时间线消费面）
    const logs = f.s
      .jobs.frames(f.s.anonymous, f.taskId, 0)
      .frames.filter((frame) => frame.kind === 'log')
      .map((frame) => String((frame.payload as { text?: string }).text ?? ''));
    expect(logs.some((text) => text.includes('[参考图层] 已禁用'))).toBe(true);
    // 幂等态 typed 拒
    await expect(f.client.task.reference.disable({ taskId: f.taskId })).rejects.toMatchObject({
      data: { code: 'reference-already-disabled' },
    });
    // enable：重申生成帧——active 复活
    const enabled = await f.client.task.reference.enable({ taskId: f.taskId });
    expect(enabled).toMatchObject({ ok: true, blobRef: ref });
    const revived = await f.client.task.detail({ taskId: f.taskId });
    expect(revived.referenceImage).toMatchObject({ blobRef: ref, generated: true, referenceBlobRef: ref });
    expect(revived.referenceImage?.disabled).toBeUndefined();
    // active 态 enable=幂等拒
    await expect(f.client.task.reference.enable({ taskId: f.taskId })).rejects.toMatchObject({
      data: { code: 'reference-not-disabled' },
    });
    f.s.dispose();
  });

  it('生成面幂等与禁用标记正交：非 force 生成有帧时零外呼（标记不撤销已生成事实）', async () => {
    const f = await setupRpc();
    plantReference(f);
    const { fetchImpl, calls } = echoImageEditFetch();
    const outcome = await generateReferenceImage(
      { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs },
      { taskId: f.taskId, sourceImage: { blobRef: f.imageRef } },
      { fetchImpl },
    );
    expect(outcome).toMatchObject({ kind: 'skipped' });
    expect(calls()).toBe(0);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [T6.3] regenerate 授权双模

describe('T6.3 task.reference.regenerate（approved-mutation 双模）', () => {
  it('未配置 image-edit 路由=typed 拒带指引（不签空提案——帧流零 approval-request）', async () => {
    const f = await setupRpc(true, false);
    await expect(f.client.task.reference.regenerate({ taskId: f.taskId })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      data: { code: 'reference-unconfigured' },
    });
    const frames = f.s.jobs.frames(f.s.anonymous, f.taskId, 0).frames;
    expect(frames.some((frame) => frame.kind === 'approval-request')).toBe(false);
    f.s.dispose();
  });

  it('手动会话两态：propose（等待批准文案+approval-request 帧）→未批执行拒→批准→执行 generated（op succeeded+重放拒）', async () => {
    const f = await setupRpc();
    const proposed = await f.client.task.reference.regenerate({ taskId: f.taskId });
    expect(proposed).toMatchObject({ mode: 'proposed' });
    if (proposed.mode !== 'proposed') throw new Error('unreachable');
    expect(proposed.autoApproved).toBeUndefined();
    expect(proposed.pending).toContain('等待用户批准');
    // approval-request 帧入任务流（会话审批卡消费面）+summary 携外部计费语义
    const request = f.s
      .jobs.frames(f.s.anonymous, f.taskId, 0)
      .frames.find((frame) => frame.kind === 'approval-request');
    expect(request).toBeDefined();
    expect((request!.payload as { tool: string }).tool).toBe('task.reference.regenerate');
    expect((request!.payload as { summary: string }).summary).toContain('image-edit');
    // 未批执行=grant-missing typed 拒（无授权直调必拒）
    await expect(
      f.client.task.reference.regenerate({ taskId: f.taskId, proposalId: proposed.proposalId }),
    ).rejects.toMatchObject({ data: { code: 'grant-missing' } });
    // 批准（session.answer 同一签发链）→ 执行（global fetch 替身回显原图=IoU 1 过门）
    const echo = echoImageEditFetch();
    stubGlobalFetch(echo.fetchImpl);
    await f.approvals.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed.requestId, approved: true });
    const executed = await f.client.task.reference.regenerate({ taskId: f.taskId, proposalId: proposed.proposalId });
    expect(executed).toMatchObject({ mode: 'executed', outcome: 'generated' });
    if (executed.mode !== 'executed') throw new Error('unreachable');
    expect(echo.calls()).toBe(1);
    expect(executed.blobRef).toBeDefined();
    expect(executed.consistency?.pass).toBe(true);
    // 新工件帧在流+task.detail 生效+已执行态重放必拒（op 终态 succeeded→op-not-approved）
    const detail = await f.client.task.detail({ taskId: f.taskId });
    expect(detail.referenceImage).toMatchObject({ generated: true, blobRef: executed.blobRef });
    await expect(
      f.client.task.reference.regenerate({ taskId: f.taskId, proposalId: proposed.proposalId }),
    ).rejects.toMatchObject({ data: { code: 'op-not-approved' } });
    f.s.dispose();
  });

  it('autoApprove 会话：propose 即返立即执行指令（approvalFaceOf A 修法形态）+直连执行零等待', async () => {
    const f = await setupRpc();
    f.s.db.prepare('UPDATE sessions SET auto_approve = 1 WHERE id = ?').run(f.sessionId);
    const proposed = await f.client.task.reference.regenerate({ taskId: f.taskId });
    expect(proposed).toMatchObject({ mode: 'proposed', autoApproved: true });
    if (proposed.mode !== 'proposed') throw new Error('unreachable');
    expect(proposed.pending).toContain('立即');
    const echo = echoImageEditFetch();
    stubGlobalFetch(echo.fetchImpl);
    const executed = await f.client.task.reference.regenerate({ taskId: f.taskId, proposalId: proposed.proposalId });
    expect(executed).toMatchObject({ mode: 'executed', outcome: 'generated' });
    expect(echo.calls()).toBe(1);
    f.s.dispose();
  });

  it('幂等清：既有生成帧在场，force 执行仍外呼重跑（新帧压旧——latest-wins）', async () => {
    const f = await setupRpc();
    const oldRef = plantReference(f);
    f.s.db.prepare('UPDATE sessions SET auto_approve = 1 WHERE id = ?').run(f.sessionId);
    const proposed = await f.client.task.reference.regenerate({ taskId: f.taskId });
    const echo = echoImageEditFetch();
    stubGlobalFetch(echo.fetchImpl);
    const executed = await f.client.task.reference.regenerate({
      taskId: f.taskId,
      proposalId: proposed.mode === 'proposed' ? proposed.proposalId : '',
    });
    expect(executed).toMatchObject({ mode: 'executed', outcome: 'generated' });
    expect(echo.calls()).toBe(1); // 既有帧没拦外呼（对照 T2 幂等零外呼语义）
    if (executed.mode !== 'executed') throw new Error('unreachable');
    expect(executed.blobRef).not.toBe(oldRef); // 新工件（回显原图字节 ≠ 旧替身图）
    const detail = await f.client.task.detail({ taskId: f.taskId });
    expect(detail.referenceImage?.blobRef).toBe(executed.blobRef);
    f.s.dispose();
  });
});

// ---------------------------------------------------------------- [T6.4] 禁用后分件回退集成

describe('T6.4 禁用→subject.segment 分件输入回退原图（端到端）', () => {
  it('disable 后分件送桥=原图；enable 后恢复=参考图层（latestReferenceImageBlobRef 三态单源）', async () => {
    const f = await setupRpc();
    const transport = createSyntheticMockSamTransport();
    const bridge = new SamBridge({ db: f.s.db, blobs: f.s.blobs, dataRoot: f.s.config.dataRoot }, { transport });
    const registry = createSubjectSegmentCapabilities({ db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs, bridge });
    const call = (input: Record<string, unknown>) =>
      registry.call('studio.subject.segment', input, 'agent') as Promise<{
        kind: string;
        value: Extract<SubjectSegmentOutcome, { status: 'done' }>;
      }>;
    const ref = plantReference(f);
    const base = {
      taskId: f.taskId,
      imageBlobRef: f.imageRef,
      canvasCm: CANVAS_CM,
      imagePx: IMAGE_PX,
      elements: ELEMENTS,
    };
    // 生效中：分件输入=参考图层（送桥+segmentImage 溯源）
    const withRef = await call(base);
    expect(withRef.value.status).toBe('done');
    expect(withRef.value.segmentImage).toEqual({ source: 'reference', blobRef: ref });
    expect(transport.segmentRequests.every((request) => request.imageBlobRef === ref)).toBe(true);
    // 禁用：分件输入回退原图（RPC 面——与生产接线同一路径）
    await f.client.task.reference.disable({ taskId: f.taskId });
    const afterDisable = await call(base);
    expect(afterDisable.value.segmentImage).toEqual({ source: 'source', blobRef: f.imageRef });
    expect(transport.segmentRequests.slice(-1)[0]?.imageBlobRef).toBe(f.imageRef);
    // 启用：恢复参考图层
    await f.client.task.reference.enable({ taskId: f.taskId });
    const afterEnable = await call(base);
    expect(afterEnable.value.segmentImage).toEqual({ source: 'reference', blobRef: ref });
    f.s.dispose();
  });

  it('直调面（非 RPC）：disable/enable 与 latestReferenceImageBlobRef 联动（segment-tool 消费的单源）', async () => {
    const f = await setupRpc();
    const deps = { db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs };
    expect(() => disableReferenceImage(deps, { taskId: f.taskId })).toThrow(/尚无生成的参考图层/);
    const ref = plantReference(f);
    expect(latestReferenceImageBlobRef(f.s.jobs, f.taskId)).toBe(ref);
    expect(disableReferenceImage(deps, { taskId: f.taskId }).blobRef).toBe(ref);
    expect(latestReferenceImageBlobRef(f.s.jobs, f.taskId)).toBeNull();
    expect(enableReferenceImage(deps, { taskId: f.taskId }).blobRef).toBe(ref);
    expect(latestReferenceImageBlobRef(f.s.jobs, f.taskId)).toBe(ref);
    f.s.dispose();
  });
});
