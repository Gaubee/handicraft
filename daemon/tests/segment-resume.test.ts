/**
 * subject.segment 断点续跑集成测（add-segment-checkpoint-resume tasks 5.2/5.3/5.5
 * ——T1 回放适配器+T2 时间切片+T3.1 进度帧+T5 时钟注入的端到端验收）。
 * 覆盖：
 *   [1] 基线一次性跑完（时钟注入固定）：记桥请求列 R0、树 blob 字节 X、账本行数 n。
 *   [2] 切片链（sliceMs=0+零进展护栏=每片恰 1 段实跑）：反复 invoke 至 done →
 *       树 blob==X **逐字节**、桥实跑请求（序+内容）==R0（零重复重请求）、片数==n、
 *       checkpointed 面字段（banked 单调不减+message 续跑指令）。
 *   [3] 进程重启模拟：每次 invoke 用**新 executor 实例**（重载账本文件）续跑 → 同 [2]。
 *   [4] 跨 taskId 同 fp 再 invoke（R1-P0-1 回归网）：全部命中零新增桥请求直至 done
 *       （replayedSegments=段全量、liveSegments=0）。
 *   [5] vlmReentry=true（自注支持 analyze 的确定性 mock 桥——内置 mock analyze=
 *       unimplemented）：切片链+跨 taskId 回放——analyze 请求经账本去重（二次
 *       invoke 零新增 analyze 桥调用）、最终树与基线一致（时钟注入）。
 *   [6] checkpointed 返回 kind='ok' 且熔断计数清零（streaks 面：4 连败→checkpointed
 *       成功→同败不熔断）。
 *   [7] 进度帧：实跑段逐段一帧+回放收束每片一帧汇总（时间线可见）。
 * 确定性依据：segment-loop 头注「同 deps 脚本 ⇒ 同请求序同产物」+mock 桥确定性
 * （同提示同掩码）+时钟注入（树 createdAt 固定）——跨服务实例（独立 DATA_ROOT）
 * 树 blob 逐字节可比。零外呼零常驻进程。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CanvasCm, ImagePx, SceneElement } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import {
  createSubjectSegmentCapabilities,
  createSyntheticMockSamTransport,
  SUBJECT_SEGMENT_TOOL_NAME,
  SubjectSegmentExecutor,
  type SubjectSegmentCheckpointedOutcome,
  type SubjectSegmentDoneOutcome,
  type SubjectSegmentOutcome,
} from '../src/kernel/vision/segment-tool.js';
import {
  SamBridge,
  type SamBridgeRequest,
  type SamBridgeResponse,
  type SamTransport,
} from '../src/kernel/vision/sam-bridge.js';
import {
  SEGMENT_LEDGERS_DIRNAME,
  segmentLedgerFingerprint,
} from '../src/kernel/vision/segment-ledger.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const CANVAS_CM: CanvasCm = { w: 10, h: 10 };
const IMAGE_PX: ImagePx = { width: 96, height: 96 };
/** 树 createdAt/账本 ts 固定时钟——跨实例树 blob 逐字节可比的前提（T5）。 */
const FIXED_NOW = (): string => '2026-10-02T00:00:00.000Z';
/** 切片安全上限（防意外死循环挂测试——正常片数=账本行数 n，个位数量级）。 */
const SLICE_CAP = 200;

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
  return new Uint8Array(encodePng(w, h, rgba));
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
    {
      name: '缎带',
      category: 'object',
      boxPx: { x: 4, y: 80, w: 88, h: 12 },
      hint: 'ribbon',
      suggestDrillWorthy: true,
    },
  ];
}

function baseInput(taskId: string, imageBlobRef: string, vlmReentry = false) {
  return {
    taskId,
    imageBlobRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    elements: elements(),
    maxIterations: 3,
    maxGemDiameterMm: 1,
    ...(vlmReentry ? { vlmReentry: true } : {}),
  };
}

/**
 * 支持 analyze 的确定性 mock 传输（内置合成 mock analyze=unimplemented——vlmReentry
 * 测试需自注，经 SubjectSegmentDeps.bridge 注入面）：segment=几何 box→内切椭圆/
 * 组合 text→box 锚定椭圆/纯 text→提示哈希派生中央椭圆（同提示同掩码）；analyze=
 * 提示哈希派生的确定性元素清单（hint 非空——循环取首个非空 hint 精化）。全请求录制。
 */
function createAnalyzeCapableMockTransport(): SamTransport & { requests: SamBridgeRequest[] } {
  const requests: SamBridgeRequest[] = [];
  const ellipseMask = (w: number, h: number, cx: number, cy: number, rx: number, ry: number) => {
    const bits = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x - cx) / Math.max(rx, 0.5);
        const dy = (y - cy) / Math.max(ry, 0.5);
        if (dx * dx + dy * dy <= 1) bits[y * w + x] = 1;
      }
    }
    return { kind: 'inline' as const, w, h, encoding: 'base64-01' as const, data: Buffer.from(bits).toString('base64') };
  };
  return {
    requests,
    async send(call): Promise<SamBridgeResponse> {
      const request = call.request;
      requests.push(request);
      const { width, height } = request.imagePx;
      const meta = { model: 'sam3-mock@resume', durationMs: 1, iteration: request.iteration };
      if (request.kind === 'analyze') {
        // 提示哈希派生（确定性）：两条元素——hint 非空供循环精化 broadSemanticPrompt
        const digest = createHash('sha256').update(request.prompt.text ?? '', 'utf8').digest();
        const ox = 20 + (digest[0]! % 40);
        const oy = 20 + (digest[1]! % 40);
        return {
          kind: 'analyze',
          elements: [
            {
              name: '花瓣簇',
              category: 'flower',
              boxPx: { x: ox, y: oy, w: 30, h: 24 },
              hint: 'petal cluster detail',
              suggestDrillWorthy: true,
            },
            {
              name: '叶材',
              category: 'foliage',
              boxPx: { x: oy, y: ox, w: 24, h: 30 },
              hint: 'leaf stem detail',
              suggestDrillWorthy: true,
            },
          ],
          meta,
        };
      }
      if (request.prompt.kind === 'geometric') {
        const box = request.prompt.box;
        if (box !== undefined) {
          return {
            kind: 'segment',
            mask: ellipseMask(width, height, box.x + box.w / 2, box.y + box.h / 2, (box.w - 2) / 2, (box.h - 2) / 2),
            score: 0.85,
            meta,
          };
        }
        const first = request.prompt.points.find((point) => point.label === 'include') ?? request.prompt.points[0]!;
        const radius = Math.max(2, Math.min(width, height) * 0.05);
        return { kind: 'segment', mask: ellipseMask(width, height, first.x, first.y, radius, radius), score: 0.6, meta };
      }
      const digest = createHash('sha256').update(request.prompt.text ?? '', 'utf8').digest();
      const spread = 0.3 + (digest[0]! / 255) * 0.3;
      const radius = (Math.min(width, height) / 2) * spread;
      const box = request.prompt.box;
      const cx = box?.x !== undefined ? box.x + box.w / 2 : width / 2;
      const cy = box?.y !== undefined ? box.y + box.h / 2 : height / 2;
      return { kind: 'segment', mask: ellipseMask(width, height, cx, cy, radius, radius), score: 0.75, meta };
    },
  };
}

/**
 * 合成 mock 桥的全请求录制适配（内置面只录 segmentRequests——续跑断言需含 analyze
 * 的全量请求列；包装不改变行为，纯旁路录制）。
 */
function syntheticRecordingTransport(): SamTransport & { requests: SamBridgeRequest[] } {
  const inner = createSyntheticMockSamTransport();
  const requests: SamBridgeRequest[] = [];
  return {
    requests,
    async send(call) {
      requests.push(call.request);
      return inner.send(call);
    },
  };
}

interface ResumeFixture {
  s: TestServices;
  transport: SamTransport & { requests: SamBridgeRequest[] };
  bridge: SamBridge;
  imageBlobRef: string;
  newTask(): string;
  newExecutor(options?: { sliceMs?: number }): SubjectSegmentExecutor;
  frames(taskId: string): Array<Record<string, unknown>>;
}

/** 装配：services+录制型 mock 桥+任务行工厂+executor 工厂（新实例=重启模拟）。 */
function setupResume(transport: SamTransport & { requests: SamBridgeRequest[] }): ResumeFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'segment-resume 测试' });
  const bridge = new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport });
  return {
    s,
    transport,
    bridge,
    imageBlobRef,
    newTask: () =>
      createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId,
        status: 'running',
      }).id,
    newExecutor: (options) =>
      new SubjectSegmentExecutor({
        db: s.db,
        blobs: s.blobs,
        dataRoot: s.config.dataRoot,
        jobs: s.jobs,
        bridge,
        now: FIXED_NOW,
        // 本文件测账本/切片/回放动力学（非 intake 面）：直注关闭工作画布推导，
        // 96×96 fixture 透传——树/账本字节与改前完全一致（intake 行为归
        // segment-tool.test.ts [3b] 与 intake-resample.test.ts）。
        intakeConfig: { enabled: false, ppcmTarget: 25 },
        ...(options?.sliceMs !== undefined ? { sliceMs: options.sliceMs } : {}),
      }),
    frames: (taskId) => s.jobs.frames(s.anonymous, taskId, 0).frames,
  };
}

/** 请求列可断言投影（taskId 剔除——账本键投影语义下的等价面；其余逐字段）。 */
function requestSignature(request: SamBridgeRequest): string {
  return JSON.stringify({ ...request, taskId: undefined });
}

function requestSignatures(requests: SamBridgeRequest[]): string[] {
  return requests.map(requestSignature);
}

async function doneOf(p: Promise<SubjectSegmentOutcome>): Promise<SubjectSegmentDoneOutcome> {
  const outcome = await p;
  if (outcome.status !== 'done') throw new Error(`期望 done，实为 ${outcome.status}`);
  return outcome;
}

/** 反复 invoke 至 done（断言全部中间片为 checkpointed 且字段面合法）。 */
async function runSlicedToDone(
  f: ResumeFixture,
  input: ReturnType<typeof baseInput>,
  options: { freshExecutorEachSlice: boolean; vlm?: boolean },
): Promise<{ outcome: SubjectSegmentDoneOutcome; checkpointed: SubjectSegmentCheckpointedOutcome[] }> {
  const checkpointed: SubjectSegmentCheckpointedOutcome[] = [];
  let executor = f.newExecutor({ sliceMs: 0 });
  for (let i = 0; i < SLICE_CAP; i++) {
    const outcome = await executor.run(input);
    if (outcome.status === 'done') {
      return { outcome, checkpointed };
    }
    expect(outcome.status).toBe('checkpointed');
    // 零进展护栏+sliceMs=0 ⇒ 每片恰 1 次实跑桥调用（vlm 链该调用可能是 analyze——
    // liveSegments 记段不记 analyze，上界 1）
    if (options.vlm === true) expect(outcome.liveSegments).toBeLessThanOrEqual(1);
    else expect(outcome.liveSegments).toBe(1);
    expect(outcome.message).toContain('完全一致的入参');
    expect(outcome.ledgerFp).toMatch(/^[0-9a-f]{16}$/);
    checkpointed.push(outcome);
    if (checkpointed.length >= 2) {
      expect(outcome.bankedSegments).toBeGreaterThanOrEqual(checkpointed[checkpointed.length - 2]!.bankedSegments); // 单调不减
    }
    if (options.freshExecutorEachSlice) executor = f.newExecutor({ sliceMs: 0 }); // 重启模拟
  }
  throw new Error(`切片链 ${SLICE_CAP} 片未达 done——死循环面`);
}

// ---------------------------------------------------------------- [1]+[2] 基线+切片链

describe('subject.segment 断点续跑（T1/T2 端到端）', () => {
  it('基线一次性跑完：done+账本行数=桥请求数+时钟注入树 blob 可复现', { timeout: 30000 }, async () => {
    const f = setupResume(syntheticRecordingTransport());
    try {
      const taskId = f.newTask();
      const outcome = await doneOf(f.newExecutor().run(baseInput(taskId, f.imageBlobRef)));
      expect(outcome.channel).toBe('bridge');
      expect(outcome.replayedSegments).toBe(0);
      const n = f.transport.requests.length;
      expect(n).toBeGreaterThanOrEqual(2); // 首轮 2 元素起
      // 树 blob 字节可读回（基线 X——后续测试跨实例比对）
      expect(f.s.blobs.read(outcome.treeArtifactRef)!.byteLength).toBeGreaterThan(0);
      // 进度帧：实跑段逐段一帧（T3.1）
      const progressTexts = f
        .frames(taskId)
        .filter((frame) => frame.kind === 'progress')
        .map((frame) => (frame as unknown as { payload: { text: string } }).payload.text);
      expect(progressTexts.length).toBeGreaterThanOrEqual(n);
      expect(progressTexts[0]).toContain('累计 1 段');
    } finally {
      f.s.dispose();
    }
  });

  it('切片链（sliceMs=0）：反复 invoke 至 done → 树 blob 逐字节==基线、实跑请求==基线 R0、片数==n', { timeout: 60000 }, async () => {
    // 基线（独立 DATA_ROOT——确定性 mock+固定时钟使跨实例可比）
    const baselineF = setupResume(syntheticRecordingTransport());
    let baseline: { treeBytes: Uint8Array; requests: SamBridgeRequest[]; n: number };
    try {
      const outcome = await doneOf(baselineF.newExecutor().run(baseInput(baselineF.newTask(), baselineF.imageBlobRef)));
      baseline = {
        treeBytes: new Uint8Array(baselineF.s.blobs.read(outcome.treeArtifactRef)!),
        requests: [...baselineF.transport.requests],
        n: baselineF.transport.requests.length,
      };
      expect(baseline.n).toBeGreaterThanOrEqual(2);
    } finally {
      baselineF.s.dispose();
    }
    // 切片链（新 DATA_ROOT——空账本起步）
    const f = setupResume(syntheticRecordingTransport());
    try {
      const taskId = f.newTask();
      const { outcome, checkpointed } = await runSlicedToDone(f, baseInput(taskId, f.imageBlobRef), {
        freshExecutorEachSlice: false,
      });
      // 树 blob 逐字节一致（时钟注入——createdAt 固定；掩码回放=blob 读回同字节）
      expect(new Uint8Array(f.s.blobs.read(outcome.treeArtifactRef)!)).toEqual(baseline.treeBytes);
      // 桥实跑请求：序+内容全等（零重复重请求——回放不重发）
      expect(requestSignatures(f.transport.requests)).toEqual(requestSignatures(baseline.requests));
      // 片数==账本行数 n（每片恰银行 1 行；末片银行最后一行后循环终态 done）
      expect(checkpointed.length).toBe(baseline.n - 1);
      // done 面审计：末片回放 n-1 段+实跑 1 段
      expect(outcome.replayedSegments).toBe(baseline.n - 1);
      // 回放收束帧（每片一帧汇总——T3.1 防洪泛；前缀匹配排掉实跑段的「本片回放 r」字样）
      const summaries = f
        .frames(taskId)
        .filter((frame) => frame.kind === 'progress')
        .map((frame) => (frame as unknown as { payload: { text: string } }).payload.text)
        .filter((text) => text.startsWith('语义抠图 · 回放'));
      expect(summaries.length).toBe(baseline.n - 1); // 每片恰一帧（末片 done 无实跑不发）
    } finally {
      f.s.dispose();
    }
  });

  it('进程重启模拟（每次 invoke 新 executor=重载账本文件）续跑 → 同切片链断言', { timeout: 60000 }, async () => {
    const baselineF = setupResume(syntheticRecordingTransport());
    let baseline: { treeBytes: Uint8Array; requests: SamBridgeRequest[] };
    try {
      const outcome = await doneOf(baselineF.newExecutor().run(baseInput(baselineF.newTask(), baselineF.imageBlobRef)));
      baseline = {
        treeBytes: new Uint8Array(baselineF.s.blobs.read(outcome.treeArtifactRef)!),
        requests: [...baselineF.transport.requests],
      };
    } finally {
      baselineF.s.dispose();
    }
    const f = setupResume(syntheticRecordingTransport());
    try {
      const { outcome } = await runSlicedToDone(f, baseInput(f.newTask(), f.imageBlobRef), {
        freshExecutorEachSlice: true,
      });
      expect(new Uint8Array(f.s.blobs.read(outcome.treeArtifactRef)!)).toEqual(baseline.treeBytes);
      expect(requestSignatures(f.transport.requests)).toEqual(requestSignatures(baseline.requests));
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] 跨 taskId 回放（R1-P0-1）

describe('subject.segment 跨 taskId 续跑（T4/R1-P0-1 回归网）', () => {
  it('同 fp 换 taskId 再 invoke → 全部命中零新增桥请求直至 done', { timeout: 30000 }, async () => {
    const f = setupResume(syntheticRecordingTransport());
    try {
      const taskA = f.newTask();
      await doneOf(f.newExecutor().run(baseInput(taskA, f.imageBlobRef)));
      const requestsAfterFirst = f.transport.requests.length;
      // followup/steer 落新 task 形态：同图同清单、新 taskId
      const taskB = f.newTask();
      const outcome = await doneOf(f.newExecutor().run(baseInput(taskB, f.imageBlobRef)));
      expect(f.transport.requests.length).toBe(requestsAfterFirst); // 零新增桥请求
      expect(outcome.replayedSegments).toBe(requestsAfterFirst); // 段全量回放
      expect(outcome.channel).toBe('bridge');
      // 切片链中途跨 task 续跑：片 1（taskA）checkpointed → 片 2（taskB）续至 done
      const f2 = setupResume(syntheticRecordingTransport());
      try {
        const taskA2 = f2.newTask();
        let executor = f2.newExecutor({ sliceMs: 0 });
        const first = await executor.run(baseInput(taskA2, f2.imageBlobRef));
        if (first.status !== 'checkpointed') throw new Error(`期望 checkpointed，实为 ${first.status}`);
        const taskB2 = f2.newTask();
        executor = f2.newExecutor({ sliceMs: 0 });
        const second = await executor.run(baseInput(taskB2, f2.imageBlobRef));
        if (second.status !== 'checkpointed') throw new Error(`期望 checkpointed，实为 ${second.status}`);
        expect(second.replayedSegments).toBe(first.bankedSegments); // 跨任务条目级命中
        expect(second.bankedSegments).toBe(first.bankedSegments + 1);
      } finally {
        f2.s.dispose();
      }
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] vlmReentry 账本续跑（R1-P1-4）

describe('subject.segment vlmReentry 账本续跑（analyze 去重）', () => {
  it('自注 analyze mock 桥：切片链+跨 taskId 回放——analyze 经账本去重、树与基线一致', { timeout: 60000 }, async () => {
    // 基线（vlmReentry=true 一次性跑完）
    const baselineF = setupResume(createAnalyzeCapableMockTransport());
    let baseline: { treeBytes: Uint8Array; requests: SamBridgeRequest[]; analyzeCount: number };
    try {
      const outcome = await doneOf(baselineF.newExecutor().run(baseInput(baselineF.newTask(), baselineF.imageBlobRef, true)));
      baseline = {
        treeBytes: new Uint8Array(baselineF.s.blobs.read(outcome.treeArtifactRef)!),
        requests: [...baselineF.transport.requests],
        analyzeCount: baselineF.transport.requests.filter((request) => request.kind === 'analyze').length,
      };
      expect(baseline.analyzeCount).toBeGreaterThanOrEqual(1); // vlmReentry=true 真走了 analyze
    } finally {
      baselineF.s.dispose();
    }
    // 切片链（新 DATA_ROOT 空账本——analyze 与 segment 同入账本逐片银行）
    const f = setupResume(createAnalyzeCapableMockTransport());
    try {
      const taskA = f.newTask();
      const { outcome } = await runSlicedToDone(f, baseInput(taskA, f.imageBlobRef, true), {
        freshExecutorEachSlice: true,
        vlm: true,
      });
      expect(new Uint8Array(f.s.blobs.read(outcome.treeArtifactRef)!)).toEqual(baseline.treeBytes);
      expect(requestSignatures(f.transport.requests)).toEqual(requestSignatures(baseline.requests));
      expect(f.transport.requests.filter((request) => request.kind === 'analyze').length).toBe(baseline.analyzeCount);
      // 二次 invoke（跨 taskId）：零新增桥请求（含 analyze——账本去重验收）
      const requestsBefore = f.transport.requests.length;
      const taskB = f.newTask();
      const replay = await doneOf(f.newExecutor().run(baseInput(taskB, f.imageBlobRef, true)));
      expect(f.transport.requests.length).toBe(requestsBefore); // 零新增（segment+analyze 全回放）
      expect(replay.replayedSegments).toBe(f.transport.requests.filter((request) => request.kind === 'segment').length);
      expect(new Uint8Array(f.s.blobs.read(replay.treeArtifactRef)!)).toEqual(baseline.treeBytes);
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [6] checkpointed 熔断面（T2.5）

describe('subject.segment checkpointed 熔断计数清零（capability 面）', () => {
  it('4 连败 → checkpointed 成功（kind=ok）→ 同败不再熔断（计数已清）', { timeout: 30000 }, async () => {
    const f = setupResume(syntheticRecordingTransport());
    try {
      const registry = createSubjectSegmentCapabilities({
        db: f.s.db,
        blobs: f.s.blobs,
        jobs: f.s.jobs,
        bridge: f.bridge,
        dataRoot: f.s.config.dataRoot,
        now: FIXED_NOW,
        sliceMs: 0, // 每片 1 段——首个成功调用即 checkpointed
      });
      const taskId = f.newTask();
      const badInput = {
        taskId,
        imageBlobRef: f.imageBlobRef,
        canvasCm: CANVAS_CM,
        imagePx: IMAGE_PX,
        elements: elements(),
        sceneAnalysisRef: 'ab'.repeat(32), // XOR 违约——同文可重复触发 noteFailure
      };
      for (let i = 0; i < 4; i++) {
        const failed = (await registry.call(SUBJECT_SEGMENT_TOOL_NAME, badInput, 'agent')) as { kind: string; message: string };
        expect(failed.kind).toBe('failed');
        expect(failed.message).not.toContain('熔断');
      }
      // checkpointed=正常 resolve（kind:'ok'→noteSuccess 清连败）
      const sliced = await registry.call(SUBJECT_SEGMENT_TOOL_NAME, baseInput(taskId, f.imageBlobRef), 'agent');
      expect(sliced).toMatchObject({ kind: 'ok' });
      const value = (sliced as { value: SubjectSegmentOutcome }).value;
      expect(value.status).toBe('checkpointed');
      // 第 5 次同败：若计数未清=连续 5 次→熔断；已清=普通失败
      const fifth = (await registry.call(SUBJECT_SEGMENT_TOOL_NAME, badInput, 'agent')) as { kind: string; message: string };
      expect(fifth.kind).toBe('failed');
      expect(fifth.message).toContain('失败');
      expect(fifth.message).not.toContain('熔断');
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- T1.3 旧账本低分辨率条目回放自愈

describe('subject.segment 旧账本低分辨率条目自愈（add-vision-pipeline-v2 T1.3/D2）', () => {
  it('归一化前旧条目（低分辨率掩码 blob）：回放作废→该段真桥实跑一次→ledger-stale-mask warning+树逐字节==基线', { timeout: 30000 }, async () => {
    const f = setupResume(syntheticRecordingTransport());
    try {
      // 基线：正常跑完银行 n 段（桥 materialize 归一化后落 blob——恒 96×96）
      const baselineOutcome = await doneOf(f.newExecutor().run(baseInput(f.newTask(), f.imageBlobRef)));
      const n = f.transport.requests.length;
      expect(n).toBeGreaterThanOrEqual(2);
      const baselineTreeBytes = new Uint8Array(f.s.blobs.read(baselineOutcome.treeArtifactRef)!);

      // 破坏账本：首个 segment 行的 maskBlobRef 换成低分辨率 blob（48×48 全 0——
      // 模拟桥边界归一化（commit 80f973e）之前落的旧条目：当时服务端 maskMaxSide
      // 缩掩码直落库，blob 内容维度≠imagePx）
      const fp = segmentLedgerFingerprint({
        imageBlobRef: f.imageBlobRef,
        imagePx: IMAGE_PX,
        canvasCm: CANVAS_CM,
        elements: elements(),
      });
      const ledgerPath = path.join(f.s.config.dataRoot, SEGMENT_LEDGERS_DIRNAME, `${fp}.jsonl`);
      const lines = readFileSync(ledgerPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      const segIdx = lines.findIndex((l) => l.includes('"kind":"segment"'));
      expect(segIdx).toBeGreaterThan(0); // header（首行）之后必有 segment 行
      const row = JSON.parse(lines[segIdx]!) as { maskBlobRef: string };
      const lowResRef = f.s.blobs.put(new Uint8Array(48 * 48)).hash; // 2304 字节 ≠ 96×96
      lines[segIdx] = lines[segIdx]!.replace(row.maskBlobRef, lowResRef);
      writeFileSync(ledgerPath, `${lines.join('\n')}\n`, 'utf8');
      f.transport.requests.length = 0; // 录制重置——续跑只应实跑被破坏的 1 段

      // 同图同清单新任务（新 executor=重启重载账本）：破坏段回放读回维度不符 →
      // 条目作废自愈（drop+实跑一次）→ done
      const taskId2 = f.newTask();
      const outcome = await doneOf(f.newExecutor().run(baseInput(taskId2, f.imageBlobRef)));
      // 仅破坏段实跑一次；其余 n-1 段回放命中
      expect(f.transport.requests).toHaveLength(1);
      expect(outcome.replayedSegments).toBe(n - 1);
      // warning 留痕（T1.3：回放 miss 一次实跑可观测——结构面+progress 帧双轨）
      const stale = outcome.warnings.filter((w) => w.reason === 'ledger-stale-mask');
      expect(stale).toHaveLength(1);
      expect(stale[0]!.detail).toContain('2304'); // resolveMaskBits RangeError 细节透传
      const progressTexts = f
        .frames(taskId2)
        .filter((frame) => frame.kind === 'progress')
        .map((frame) => (frame as unknown as { payload: { text: string } }).payload.text);
      expect(progressTexts.some((t) => t.includes('断点账本条目作废重跑'))).toBe(true);
      // 重跑段产物=确定性 mock 同请求同掩码 → 树逐字节==基线（回放/实跑混合无痕）
      expect(new Uint8Array(f.s.blobs.read(outcome.treeArtifactRef)!)).toEqual(baselineTreeBytes);
    } finally {
      f.s.dispose();
    }
  });
});
