/**
 * SAM 每请求调谐测试（add-image-processing-settings tasks 1.5 / design §5.2-§5.3）：
 *   [1] tuneSegmentRequest 合并语义：请求显式值优先（直注优先同 scene.analyze
 *       intakeConfig）/tuner 补齐缺省字段/tuner 缺席原样返回/生效值 maskMaxSide=
 *       null→字段不发。
 *   [2] 合成 mock 桥（SAM_BRIDGE_MOCK）录制面：segmentRequests 记录送达请求的
 *       调谐字段（透传断言）。
 *   [3] 设置驱动（kernel 装配同款闭包）：SubjectSegmentExecutor 全链两次 run 之间
 *       改 image_processing 设置 → 下一次请求 wire 参数变（tuner 每次调用解析——
 *       design §5.3「生效即时不重启」验收口径）。
 * 真链 wire 面（SshSamTransport.wireParamsOf 条件透传/undefined 不发）归
 * ssh-sam-transport.test.ts（假体 ssh 回显通道）。零外呼零常驻进程。
 */
import { describe, expect, it } from 'vitest';
import type { SceneElement } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import {
  applySegmentPrecision,
  makeSegmentRequest,
  tuneSegmentRequest,
  SamBridge,
  type SamSegmentRequest,
} from '../src/kernel/vision/sam-bridge.js';
import { createSyntheticMockSamTransport, SubjectSegmentExecutor, type SubjectSegmentOutcome } from '../src/kernel/vision/segment-tool.js';
import { imageProcessingEffective, saveImageProcessing } from '../src/image-processing-store.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]); // 传输不解码——任意字节即可

function segReq(overrides: { confThreshold?: number; maskMaxSide?: number } = {}): SamSegmentRequest {
  return makeSegmentRequest({
    taskId: 'f'.repeat(16),
    imageBlobRef: 'a'.repeat(64),
    imagePx: { width: 8, height: 8 },
    canvasCm: { w: 8, h: 8 },
    prompt: { kind: 'text', text: 'person' },
    iteration: 0,
    ...overrides,
  });
}

/** 96×96 三色图（左红/右蓝/底部黄带——Lab 方差有真实信号，循环可收敛）。 */
function testImage(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const [r, g, b] = y >= 80 ? [230, 200, 40] : x < w / 2 ? [200, 40, 40] : [40, 60, 200];
      rgba[p] = r;
      rgba[p + 1] = g;
      rgba[p + 2] = b;
      rgba[p + 3] = 255;
    }
  }
  return encodePng(w, h, rgba);
}

function elements(): SceneElement[] {
  return [
    {
      name: '花束',
      category: 'flower',
      boxPx: { x: 10, y: 8, w: 70, h: 66 },
      hint: 'bouquet',
      suggestDrillWorthy: true,
    },
  ];
}

interface ExecutorFixture {
  s: TestServices;
  taskId: string;
  imageBlobRef: string;
  executor: SubjectSegmentExecutor;
  transport: ReturnType<typeof createSyntheticMockSamTransport>;
}

/** done 收窄（SubjectSegmentOutcome 判别联合——add-segment-checkpoint-resume）。 */
async function doneOf(p: Promise<SubjectSegmentOutcome>): Promise<Extract<SubjectSegmentOutcome, { status: 'done' }>> {
  const outcome = await p;
  if (outcome.status !== 'done') throw new Error(`期望 done，实为 ${outcome.status}`);
  return outcome;
}

/** kernel 装配同款：tuner 闭包读 imageProcessingEffective（每次调用解析）。 */
function setupExecutor(): ExecutorFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'sam-tuning 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const transport = createSyntheticMockSamTransport();
  const bridge = new SamBridge(
    { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot },
    { transport },
  );
  const samRequestTuner = () => {
    const v = imageProcessingEffective(s.db, {});
    return { confThreshold: v.samConfThreshold, maskMaxSide: v.samMaskMaxSide ?? undefined };
  };
  const executor = new SubjectSegmentExecutor({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    bridge,
    samRequestTuner,
  });
  return { s, taskId: task.id, imageBlobRef, executor, transport };
}

// ---------------------------------------------------------------- [1] 合并语义

describe('tuneSegmentRequest（每请求调谐合并语义）', () => {
  it('tuner 补齐缺省字段：conf/maskMaxSide 均注入', () => {
    const tuned = tuneSegmentRequest(segReq(), () => ({ confThreshold: 0.5, maskMaxSide: 1024 }));
    expect(tuned.confThreshold).toBe(0.5);
    expect(tuned.maskMaxSide).toBe(1024);
  });

  it('请求显式值优先：直注 conf/maskMaxSide 不被 tuner 覆盖', () => {
    const tuned = tuneSegmentRequest(
      segReq({ confThreshold: 0.2, maskMaxSide: 512 }),
      () => ({ confThreshold: 0.5, maskMaxSide: 1024 }),
    );
    expect(tuned.confThreshold).toBe(0.2);
    expect(tuned.maskMaxSide).toBe(512);
  });

  it('生效值 maskMaxSide=null → tuner 不补该字段（=不发=服务端原尺寸缺省）', () => {
    const tuned = tuneSegmentRequest(segReq(), () => ({ confThreshold: 0.4, maskMaxSide: undefined }));
    expect(tuned.confThreshold).toBe(0.4);
    expect(tuned.maskMaxSide).toBeUndefined();
    expect('maskMaxSide' in tuned).toBe(false);
  });

  it('tuner 缺席原样返回（同引用零分配）；每次调用解析（不缓存）', () => {
    const request = segReq();
    expect(tuneSegmentRequest(request)).toBe(request);
    let current = 0.5;
    const tuner = () => ({ confThreshold: current });
    expect(tuneSegmentRequest(segReq(), tuner).confThreshold).toBe(0.5);
    current = 0.3; // 设置改动 → 下一次调用取新值
    expect(tuneSegmentRequest(segReq(), tuner).confThreshold).toBe(0.3);
  });

  it('请求越界调谐值仍被 schema 把守（makeSegmentRequest 直构拒）', () => {
    expect(() => segReq({ confThreshold: 1.5 })).toThrow();
    expect(() => segReq({ maskMaxSide: 31 })).toThrow();
  });
});

// ---------------------------------------------------------------- [2] mock 录制面

describe('SAM_BRIDGE_MOCK 合成桥录制（透传断言面）', () => {
  it('segmentRequests 记录送达请求的调谐字段；analyze 不入录制', async () => {
    const transport = createSyntheticMockSamTransport();
    const tuned = tuneSegmentRequest(segReq(), () => ({ confThreshold: 0.5, maskMaxSide: 1024 }));
    const response = await transport.send({ request: tuned, imageBytes: PNG_BYTES });
    expect(response.kind).toBe('segment');
    expect(transport.segmentRequests).toHaveLength(1);
    expect(transport.segmentRequests[0]).toMatchObject({ confThreshold: 0.5, maskMaxSide: 1024 });
    // 未调谐请求：字段缺位（undefined 不发）
    await transport.send({ request: segReq(), imageBytes: PNG_BYTES });
    expect(transport.segmentRequests[1]).not.toHaveProperty('maskMaxSide');
    expect(transport.segmentRequests[1]).not.toHaveProperty('confThreshold');
  });
});

// ---------------------------------------------------------------- [3] 设置驱动全链

describe('设置驱动（kernel 装配同款闭包——改设置对下一次请求生效）', () => {
  it(
    'executor 两次 run 之间保存设置 → 桥收到的 conf/maskMaxSide 变化',
    { timeout: 30_000 },
    async () => {
      const f = setupExecutor();
      try {
        const input = {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: { w: 10, h: 10 },
          imagePx: { width: 96, height: 96 },
          elements: elements(),
        };
        // 缺省=性能档（conf 0.40/原尺寸 null→maskMaxSide 不发）
        // （done 收窄——SubjectSegmentOutcome 判别联合，add-segment-checkpoint-resume）
        const first = await doneOf(f.executor.run(input));
        expect(first.channel).toBe('bridge');
        expect(f.transport.segmentRequests.length).toBeGreaterThan(0);
        for (const request of f.transport.segmentRequests) {
          expect(request.confThreshold).toBeCloseTo(0.4);
          expect('maskMaxSide' in request).toBe(false);
        }
        // 保存快速档（conf 0.50/掩码 1024）→ 下一次 run 的全部桥请求用新值
        saveImageProcessing(f.s.db, { preset: 'fast' }, {});
        const afterFast = f.transport.segmentRequests.length;
        const second = await doneOf(f.executor.run(input));
        expect(second.channel).toBe('bridge');
        const fastRequests = f.transport.segmentRequests.slice(afterFast);
        expect(fastRequests.length).toBeGreaterThan(0);
        for (const request of fastRequests) {
          expect(request.confThreshold).toBeCloseTo(0.5);
          expect(request.maskMaxSide).toBe(1024);
        }
        // 保存自定义（conf 0.30/原尺寸 null）→ conf 变、maskMaxSide 字段不发
        const afterCustom = f.transport.segmentRequests.length;
        saveImageProcessing(
          f.s.db,
          { preset: 'custom', values: { ppcmTarget: 20, resampleEnabled: true, samConfThreshold: 0.3, samMaskMaxSide: null } },
          {},
        );
        const third = await doneOf(f.executor.run(input));
        expect(third.channel).toBe('bridge');
        const customRequests = f.transport.segmentRequests.slice(afterCustom);
        expect(customRequests.length).toBeGreaterThan(0);
        for (const request of customRequests) {
          expect(request.confThreshold).toBeCloseTo(0.3);
          expect('maskMaxSide' in request).toBe(false);
        }
      } finally {
        f.s.dispose();
      }
    },
  );
});

// ---------------------------------------------------------------- T3 precision 参数化（add-vision-pipeline-v2 D3）

describe('applySegmentPrecision（精度覆写——显式 precision 压 tuner/请求既有值）', () => {
  it('precision 全字段覆写（压 tuner 与请求显式值）；部分字段只覆写过字段；未传原样', () => {
    const tuned = tuneSegmentRequest(segReq({ confThreshold: 0.3 }), () => ({ confThreshold: 0.4, maskMaxSide: 1024 }));
    expect(tuned.confThreshold).toBe(0.3); // 请求显式 > tuner（既有语义）
    expect(tuned.maskMaxSide).toBe(1024);
    // precision 全覆写：两字段均压过
    const both = applySegmentPrecision(tuned, { maskMaxSide: 1536, confThreshold: 0.2 });
    expect(both.confThreshold).toBe(0.2);
    expect(both.maskMaxSide).toBe(1536);
    // 部分覆写：只 maskMaxSide，confThreshold 保持 tuned 值
    const partial = applySegmentPrecision(tuned, { maskMaxSide: 2048 });
    expect(partial.confThreshold).toBe(0.3);
    expect(partial.maskMaxSide).toBe(2048);
    // 未传 precision：原样引用
    expect(applySegmentPrecision(tuned, undefined)).toBe(tuned);
  });

  it('reqHash 含 precision：不同精度=不同请求哈希（账本命中键天然分账）', async () => {
    const { segmentRequestHash } = await import('../src/kernel/vision/segment-ledger.js');
    const tuned = tuneSegmentRequest(segReq(), () => ({ confThreshold: 0.4, maskMaxSide: 1024 }));
    const hi = applySegmentPrecision(tuned, { maskMaxSide: 1536 });
    const hiAgain = applySegmentPrecision(tuned, { maskMaxSide: 1536 });
    expect(segmentRequestHash(hi)).not.toBe(segmentRequestHash(tuned)); // 不同精度不串账
    expect(segmentRequestHash(hi)).toBe(segmentRequestHash(hiAgain)); // 同精度确定性
  });
});

describe('T3 precision 透传与缺省回落（executor 全链——合成 mock 桥录制面）', () => {
  it('透传：precision.maskMaxSide 覆写 tuner 值直达桥请求；confThreshold 未覆写=回落配置', async () => {
    const f = setupExecutor();
    try {
      const outcome = await doneOf(f.executor.run({
        taskId: f.taskId,
        imageBlobRef: f.imageBlobRef,
        canvasCm: { w: 10, h: 10 },
        imagePx: { width: 96, height: 96 },
        elements: elements(),
        maxIterations: 1,
        precision: { maskMaxSide: 1536 },
      }));
      expect(outcome.status).toBe('done');
      expect(f.transport.segmentRequests.length).toBeGreaterThan(0);
      for (const req of f.transport.segmentRequests) {
        expect(req.maskMaxSide).toBe(1536); // 显式 precision 压配置
        expect(req.confThreshold).toBe(0.4); // 未覆写=balanced 预设回落
      }
    } finally {
      f.s.dispose();
    }
  });

  it('缺省回落：不传 precision=图像处理配置生效（balanced：confThreshold 0.4、maskMaxSide null→不发）', async () => {
    const f = setupExecutor();
    try {
      await doneOf(f.executor.run({
        taskId: f.taskId,
        imageBlobRef: f.imageBlobRef,
        canvasCm: { w: 10, h: 10 },
        imagePx: { width: 96, height: 96 },
        elements: elements(),
        maxIterations: 1,
      }));
      for (const req of f.transport.segmentRequests) {
        expect(req.confThreshold).toBe(0.4);
        expect(req.maskMaxSide).toBeUndefined();
      }
    } finally {
      f.s.dispose();
    }
  });

  it('账本不串账：同精度续跑回放命中（零桥调用）；换精度=全量 miss 重跑', async () => {
    // 三执行器共享 dataRoot（账本文件持久）——run1 银行段，run2 同精度回放，
    // run3 换精度 reqHash 全 miss → 重新实跑（不同精度=不同请求，D3 账本语义）。
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const imageBlobRef = s.blobs.put(testImage()).hash;
      const { sessionId } = s.sessions.create(s.anonymous, { title: 'precision-ledger' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      const makeExecutor = () => {
        const transport = createSyntheticMockSamTransport();
        const bridge = new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport });
        const samRequestTuner = () => {
          const v = imageProcessingEffective(s.db, {});
          return { confThreshold: v.samConfThreshold, maskMaxSide: v.samMaskMaxSide ?? undefined };
        };
        return {
          transport,
          executor: new SubjectSegmentExecutor({
            db: s.db, blobs: s.blobs, jobs: s.jobs, dataRoot: s.config.dataRoot, bridge, samRequestTuner,
          }),
        };
      };
      const input = (precision?: { maskMaxSide?: number }) => ({
        taskId: task.id,
        imageBlobRef,
        canvasCm: { w: 10, h: 10 },
        imagePx: { width: 96, height: 96 },
        elements: elements(),
        maxIterations: 1,
        ...(precision !== undefined ? { precision } : {}),
      });
      const run1 = makeExecutor();
      const first = await doneOf(run1.executor.run(input()));
      expect(first.replayedSegments).toBe(0);
      expect(run1.transport.segmentRequests.length).toBeGreaterThan(0);
      const banked = first.replayedSegments + run1.transport.segmentRequests.length;
      // 同精度重跑：账本全命中——零桥调用+回放计数=银行段数
      const run2 = makeExecutor();
      const replay = await doneOf(run2.executor.run(input()));
      expect(replay.replayedSegments).toBeGreaterThan(0);
      expect(run2.transport.segmentRequests).toHaveLength(0);
      expect(replay.replayedSegments + replay.meta.durationMs >= 0).toBe(true); // shape sanity
      // 换精度：reqHash 变 → 全 miss 重新实跑（不串账）
      const run3 = makeExecutor();
      const hi = await doneOf(run3.executor.run(input({ maskMaxSide: 2048 })));
      expect(hi.replayedSegments).toBe(0);
      expect(run3.transport.segmentRequests.length).toBe(banked - first.replayedSegments);
      for (const req of run3.transport.segmentRequests) expect(req.maskMaxSide).toBe(2048);
    } finally {
      s.dispose();
    }
  });
});
