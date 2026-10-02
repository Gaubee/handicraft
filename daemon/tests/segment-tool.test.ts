/**
 * subject.segment 工具面测试（add-subject-sam-pipeline P3.3 缺口先补）。
 * 覆盖：
 *   [1] 全链（合成 mock 桥=env 缺省面同款）：elements 注入 → P2.4 循环 →
 *       object-tree.json+object-tree-preview.png 双工件落 blob → artifact 帧登记
 *       （P3.2-channel 合法引用集）→ 出参 {treeArtifactRef, previewRef, warnings, nodes}。
 *   [2] sceneAnalysisRef 路：S2 工件读回+锚点校验（一致=过 / 漂移=anchor-mismatch /
 *       缺失=analysis-missing）。
 *   [3] 输入 XOR（sceneAnalysisRef/elements 二选一）与任务行/原图缺失误。
 *   [4] 桥在线但失败=typed 上抛不静默降级（loop-failed 携 bridge-failure 源）。
 *   [5] 桥未装配=降级面 P2.5 颜色结构分块（channel='fallback'+显式 warning+
 *       degraded 标记；S2 元素不参与）。
 *   [6] 注册面：工具名/MCP 投影/deny 名单存活；env 装配（resolveKernelSamTransport
 *       三态）。
 * 零外呼零常驻进程（全部本地 mock/合成）。
 */
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  SceneAnalysisSchema,
  type CanvasCm,
  type ImagePx,
  type SceneAnalysis,
  type SceneElement,
} from '@handicraft/contracts';
import { decodePng, encodePng } from '../src/png/codec.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { productToolDenyList } from '../src/kernel/tool-surface.js';
import { createAgentTask, updateTask } from '../src/db/jobs.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import { MockSamTransport, SamBridge, SamBridgeError, type SamTransport } from '../src/kernel/vision/sam-bridge.js';
import {
  createSubjectSegmentCapabilities,
  createSyntheticMockSamTransport,
  resolveKernelSamTransport,
  SUBJECT_SEGMENT_TOOL_NAME,
  SubjectSegmentError,
  type SubjectSegmentOutcome,
} from '../src/kernel/vision/segment-tool.js';
import { SceneAnalyzer } from '../src/kernel/vision/scene-analyze.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

/** 96×96 三色图（左红/右蓝/底部黄带——Lab 方差与降级分块均有真实信号）。 */
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

const CANVAS_CM: CanvasCm = { w: 10, h: 10 };
const IMAGE_PX: ImagePx = { width: 96, height: 96 };

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

interface Fixture {
  s: TestServices;
  taskId: string;
  imageBlobRef: string;
  registry: ReturnType<typeof createSubjectSegmentCapabilities>;
  frames(): Array<Record<string, unknown>>;
}

function setup(transport: SamTransport | undefined): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'segment-tool 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const bridge =
    transport === undefined
      ? undefined
      : new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport });
  const registry = createSubjectSegmentCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    // 断点账本根（add-segment-checkpoint-resume——kernel 装配同款，回归即覆盖账本路径）
    dataRoot: s.config.dataRoot,
    ...(bridge !== undefined ? { bridge } : {}),
  });
  return {
    s,
    taskId: task.id,
    imageBlobRef,
    registry,
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
  };
}

function sceneAnalysisArtifact(f: Fixture, overrides: Partial<SceneAnalysis> = {}): string {
  const analysis = SceneAnalysisSchema.parse({
    kind: 'scene-analysis',
    formatVersion: 1,
    imageBlobRef: f.imageBlobRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    elements: elements(),
    createdAt: new Date().toISOString(),
    ...overrides,
  });
  return putTaskArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, Buffer.from(JSON.stringify(analysis), 'utf8')).hash;
}

/** ok 收窄到 done 面（SubjectSegmentOutcome 判别联合——add-segment-checkpoint-resume）。 */
async function okOf(result: unknown): Promise<
  Extract<SubjectSegmentOutcome, { status: 'done' }>
> {
  expect(result).toMatchObject({ kind: 'ok' });
  const value = (result as { value: SubjectSegmentOutcome }).value;
  if (value.status !== 'done') throw new Error(`期望 done，实为 ${value.status}`);
  return value;
}

async function failedDetail(result: unknown): Promise<string> {
  expect(result).toMatchObject({ kind: 'failed' });
  return (result as { message: string }).message;
}

// ---------------------------------------------------------------- [1] 全链

describe('subject.segment 工具面', () => {
  it('全链（合成 mock 桥）：elements → 循环 → 双工件+artifact 帧+出参形状', { timeout: 30000 }, async () => {
    const f = setup(createSyntheticMockSamTransport());
    try {
      const outcome = await okOf(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          elements: elements(),
          maxIterations: 2,
          maxGemDiameterMm: 1,
        }, 'agent'),
      );
      expect(outcome.channel).toBe('bridge');
      expect(outcome.iterations).toBeLessThanOrEqual(3);
      expect(outcome.totalNodes).toBeGreaterThanOrEqual(3); // 画布根+两元素（+细分子）
      expect(outcome.nodes.length).toBeGreaterThan(0);
      expect(outcome.nodes.map((n) => n.objectName)).toContain('花束');
      // 树工件读回=schema 合法 ObjectTree（锚点回填+mask 两态）
      const treeJson = f.s.blobs.read(outcome.treeArtifactRef)!;
      const tree = ObjectTreeSchema.parse(JSON.parse(treeJson.toString('utf8')));
      expect(tree.imagePx).toEqual(IMAGE_PX);
      expect(tree.canvasCm).toEqual(CANVAS_CM);
      expect(tree.nodes.length).toBe(outcome.totalNodes);
      // 预览工件=可解码 PNG
      const preview = decodePng(f.s.blobs.read(outcome.previewRef)!);
      expect(preview.width).toBe(IMAGE_PX.width);
      expect(preview.height).toBe(IMAGE_PX.height);
      // artifact 帧登记（P3.2-channel 合法引用集——名字/blobRef 命中）
      const artifacts = f
        .frames()
        .filter((frame) => frame.kind === 'artifact')
        .map((frame) => (frame as unknown as { payload: { blobRef: string; name: string } }).payload);
      expect(artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ blobRef: outcome.treeArtifactRef, name: 'object-tree.json' }),
          expect.objectContaining({ blobRef: outcome.previewRef, name: 'object-tree-preview.png' }),
        ]),
      );
    } finally {
      f.s.dispose();
    }
  });

  // ---------------------------------------------------------------- [2] sceneAnalysisRef

  it('sceneAnalysisRef 路：S2 工件读回（锚点一致）驱动的同一全链', { timeout: 30000 }, async () => {
    const f = setup(createSyntheticMockSamTransport());
    try {
      const ref = sceneAnalysisArtifact(f);
      const outcome = await okOf(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          sceneAnalysisRef: ref,
          maxIterations: 1,
        }, 'agent'),
      );
      expect(outcome.channel).toBe('bridge');
      expect(outcome.totalNodes).toBeGreaterThanOrEqual(3);
      // 缺失工件=analysis-missing
      const missing = await failedDetail(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          sceneAnalysisRef: 'ab'.repeat(32),
        }, 'agent'),
      );
      expect(missing).toContain('analysis-missing');
      // 锚点漂移（canvasCm 不一致）=anchor-mismatch
      const drifted = sceneAnalysisArtifact(f, { canvasCm: { w: 12, h: 10 } });
      const mismatch = await failedDetail(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          sceneAnalysisRef: drifted,
        }, 'agent'),
      );
      expect(mismatch).toContain('anchor-mismatch');
    } finally {
      f.s.dispose();
    }
  });

  // ---------------------------------------------------------------- [3] 输入面

  it('XOR 校验/任务行/原图缺失的显式拒', { timeout: 30000 }, async () => {
    const f = setup(createSyntheticMockSamTransport());
    try {
      const both = await failedDetail(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          elements: elements(),
          sceneAnalysisRef: sceneAnalysisArtifact(f),
        }, 'agent'),
      );
      expect(both).toContain('二选一');
      const neither = await failedDetail(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
        }, 'agent'),
      );
      expect(neither).toContain('必须给其一');
      const badTask = await failedDetail(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: '0199f7f0-0000-7000-8000-000000000000',
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          elements: elements(),
        }, 'agent'),
      );
      expect(badTask).toContain('任务不存在');
      const badImage = await failedDetail(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: 'cd'.repeat(32),
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          elements: elements(),
        }, 'agent'),
      );
      expect(badImage).toContain('image-missing');
    } finally {
      f.s.dispose();
    }
  });

  // ---------------------------------------------------------------- [4] 桥失败 typed 上抛

  it('桥在线但传输失败=typed 上抛（loop-failed 携 bridge-failure 源，不静默降级）', { timeout: 30000 }, async () => {
    const failing: SamTransport = {
      async send() {
        throw new SamBridgeError('mock 传输故障', 'transport');
      },
    };
    const f = setup(failing);
    try {
      const detail = await failedDetail(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          elements: elements(),
          maxIterations: 2,
        }, 'agent'),
      );
      expect(detail).toContain('loop-failed');
      expect(detail).toContain('bridge-failure');
      // 不降级：无 artifact 帧（降级面才会产树）
      expect(f.frames().filter((frame) => frame.kind === 'artifact')).toHaveLength(0);
    } finally {
      f.s.dispose();
    }
  });

  // ---------------------------------------------------------------- [5] 降级面

  it('桥未装配=降级 P2.5 颜色结构分块（channel=fallback+显式 warning+degraded）', { timeout: 30000 }, async () => {
    const f = setup(undefined);
    try {
      const outcome = await okOf(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          elements: elements(),
        }, 'agent'),
      );
      expect(outcome.channel).toBe('fallback');
      expect(outcome.degraded).toBe('fallback-color');
      expect(outcome.warnings).toEqual([
        expect.objectContaining({ reason: 'bridge-unavailable', degraded: 'fallback-color' }),
      ]);
      const tree = ObjectTreeSchema.parse(JSON.parse(f.s.blobs.read(outcome.treeArtifactRef)!.toString('utf8')));
      expect(tree.nodes[0]?.category).toBe('canvas'); // 降级树根=画布结构性根
      expect(tree.nodes.length).toBeGreaterThanOrEqual(2); // 至少一个色区域
      // 降级面同样登记 artifact 帧
      expect(f.frames().filter((frame) => frame.kind === 'artifact').length).toBeGreaterThanOrEqual(2);
    } finally {
      f.s.dispose();
    }
  });

  // ---------------------------------------------------------------- [6] 注册与 env 装配

  it('注册面：MCP 投影名过 deny 名单；resolveKernelSamTransport 三态', () => {
    const f = setup(createSyntheticMockSamTransport());
    try {
      expect(f.registry.names()).toContain(SUBJECT_SEGMENT_TOOL_NAME);
      const mcpName = mcpToolName(SUBJECT_SEGMENT_TOOL_NAME);
      expect(mcpName).toBe('subject_segment'); // server 内名——dsh-mcp-client 投影 mcp__studio__subject_segment
      const agentVisible = `mcp__studio__${mcpName}`;
      expect(productToolDenyList([agentVisible, 'bash'])).toEqual(['bash']);
    } finally {
      f.s.dispose();
    }
    // env 装配三态：mock 门 > ssh 成对 > undefined
    expect(resolveKernelSamTransport({ SAM_BRIDGE_MOCK: '1', SAM_SSH_HOST: 'h' })).toBeDefined();
    expect(resolveKernelSamTransport({ SAM_SSH_HOST: 'macmini', SAM_SSH_REMOTE_COMMAND: 'py svc.py' })).toBeDefined();
    expect(resolveKernelSamTransport({ SAM_SSH_HOST: 'macmini' })).toBeUndefined();
    expect(resolveKernelSamTransport({})).toBeUndefined();
  });

  it('合成 mock 桥：analyze=unimplemented（scene.analyze 降级信号）+几何 box 掩码确定性', async () => {
    const transport = createSyntheticMockSamTransport();
    const w = 40;
    const h = 40;
    const seg = await transport.send({
      request: {
        kind: 'segment',
        taskId: 't',
        imageBlobRef: 'a'.repeat(64),
        imagePx: { width: w, height: h },
        canvasCm: { w: 10, h: 10 },
        prompt: { kind: 'geometric', points: [{ x: 20, y: 20, label: 'include' }], box: { x: 4, y: 6, w: 20, h: 12 } },
        iteration: 0,
      },
      imageBytes: new Uint8Array(4),
    });
    if (seg.kind !== 'segment' || seg.mask.kind !== 'inline') throw new Error('unreachable');
    expect(seg.mask).toMatchObject({ kind: 'inline', w, h, encoding: 'base64-01' });
    const bits = Buffer.from(seg.mask.data, 'base64');
    expect(bits.length).toBe(w * h);
    expect(bits[12 * w + 14]).toBe(1); // 椭圆中心（box {x:4,y:6,w:20,h:12} 中心=(14,12)）
    expect(bits[0]).toBe(0); // box 外
    await expect(
      transport.send({
        request: {
          kind: 'analyze',
          taskId: 't',
          imageBlobRef: 'a'.repeat(64),
          imagePx: { width: w, height: h },
          canvasCm: { w: 10, h: 10 },
          prompt: { kind: 'text', text: 'analyze' },
          iteration: 0,
        },
        imageBytes: new Uint8Array(4),
      }),
    ).rejects.toMatchObject({ kind: 'unimplemented' });
    // 同提示同掩码（确定性）
    const again = await transport.send({
      request: {
        kind: 'segment',
        taskId: 't',
        imageBlobRef: 'a'.repeat(64),
        imagePx: { width: w, height: h },
        canvasCm: { w: 10, h: 10 },
        prompt: { kind: 'text', text: 'flower as a whole' },
        iteration: 1,
      },
      imageBytes: new Uint8Array(4),
    });
    const repeat = await transport.send({
      request: {
        kind: 'segment',
        taskId: 't',
        imageBlobRef: 'a'.repeat(64),
        imagePx: { width: w, height: h },
        canvasCm: { w: 10, h: 10 },
        prompt: { kind: 'text', text: 'flower as a whole' },
        iteration: 2,
      },
      imageBytes: new Uint8Array(4),
    });
    expect((again as { mask: { kind: string; data: string } }).mask.data).toBe(
      (repeat as { mask: { kind: string; data: string } }).mask.data,
    );
  });

  it('MockSamTransport 注入缝同链可用（journey 冒烟同款形态）+executor typed error 直调面', { timeout: 30000 }, async () => {
    // 编程式 mock（冒烟注入缝形态）：box→椭圆 / text→零检出（逐请求编程——预装 64 发）
    const scripted = new MockSamTransport();
    const handler = (call: Parameters<MockSamTransport['send']>[0]) => {
      const { width, height } = call.request.imagePx;
      if (call.request.kind === 'analyze') {
        throw new SamBridgeError('mock 不支持 analyze', 'unimplemented');
      }
      const bits = new Uint8Array(width * height);
      if (call.request.prompt.kind === 'geometric' && call.request.prompt.box !== undefined) {
        const { box } = call.request.prompt;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const dx = (x - cx) / (box.w / 2);
            const dy = (y - cy) / (box.h / 2);
            if (dx * dx + dy * dy <= 1) bits[y * width + x] = 1;
          }
        }
      }
      return {
        kind: 'segment' as const,
        mask: { kind: 'inline' as const, w: width, h: height, encoding: 'base64-01' as const, data: Buffer.from(bits).toString('base64') },
        score: 0.8,
        meta: { model: 'sam3-mock@scripted', durationMs: 1, iteration: call.request.iteration },
      };
    };
    for (let i = 0; i < 64; i++) scripted.respond(handler);
    const f = setup(scripted);
    try {
      const outcome = await okOf(
        await f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, {
          taskId: f.taskId,
          imageBlobRef: f.imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          elements: elements(),
          maxIterations: 2,
          maxGemDiameterMm: 1,
        }, 'agent'),
      );
      expect(outcome.meta.model).toBe('sam3-mock@scripted');
      expect(outcome.totalNodes).toBeGreaterThanOrEqual(3);
    } finally {
      f.s.dispose();
    }
    // SubjectSegmentError 直调面（invalid-input——schema XOR）
    const { SubjectSegmentError: Err } = await import('../src/kernel/vision/segment-tool.js');
    expect(new Err('x', 'invalid-input').kind).toBe('invalid-input');
  });
});

// ---------------------------------------------------------------- [7] W2 全链一致性（W1 入线降采样 → S2 工件 → S3 树锚点同源）

describe('subject.segment W2 全链（scene.analyze 入线降采样 → 树锚点同源）', () => {
  it('高密度图经 scene.analyze 降采 → S3 消费工件锚点 → 桥收降采图+tree.imagePx=降采尺寸', { timeout: 30000 }, async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      // 96×96 @ 2×2cm = 48px/cm → 目标 25 → 50×50（round(96×25/48)）
      const imageBlobRef = s.blobs.put(testImage()).hash;
      const { sessionId } = s.sessions.create(s.anonymous, { title: 'w2-chain' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      const canvasCm: CanvasCm = { w: 2, h: 2 };

      // S2：真 SceneAnalyzer（桥通道 A——analyze 响应元素在降采坐标系 50×50）
      const analyzeTransport = new MockSamTransport();
      let bridgeSawBytes: Uint8Array | null = null;
      analyzeTransport.respond((call) => {
        bridgeSawBytes = call.imageBytes;
        return {
          kind: 'analyze',
          elements: [
            {
              name: '花束',
              category: 'flower',
              boxPx: { x: 5, y: 4, w: 35, h: 33 },
              hint: 'bouquet',
              suggestDrillWorthy: true,
            },
          ],
          meta: { model: 'sam3-mock@w2', durationMs: 1, iteration: 0 },
        };
      });
      const analyzer = new SceneAnalyzer(
        {
          db: s.db,
          blobs: s.blobs,
          dataRoot: s.config.dataRoot,
          llm: s.config.llm,
          bridge: new SamBridge(
            { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot },
            { transport: analyzeTransport },
          ),
          jobs: s.jobs,
        },
        { live: true },
      );
      const s2 = await analyzer.analyze({
        taskId: task.id,
        imageBlobRef,
        imagePx: { width: 96, height: 96 },
        canvasCm,
      });

      // W1：降采触发+锚点重建
      expect(s2.intakeResample.applied).toBe(true);
      expect(s2.analysis.imagePx).toEqual({ width: 50, height: 50 });
      expect(s2.analysis.imageBlobRef).not.toBe(imageBlobRef);
      // W2：SAM 桥输入=锚点图（桥收到的是降采字节——50×50）
      expect(analyzeTransport.requests).toHaveLength(1);
      expect(bridgeSawBytes).not.toBeNull();
      const seen = decodePng(bridgeSawBytes!);
      expect({ width: seen.width, height: seen.height }).toEqual({ width: 50, height: 50 });

      // S3：subject.segment 以 S2 工件锚点+sceneAnalysisRef 驱动（Agent 真实消费面）
      const registry = createSubjectSegmentCapabilities({
        db: s.db,
        blobs: s.blobs,
        jobs: s.jobs,
        bridge: new SamBridge(
          { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot },
          { transport: createSyntheticMockSamTransport() },
        ),
      });
      const outcome = await okOf(
        await registry.call(
          SUBJECT_SEGMENT_TOOL_NAME,
          {
            taskId: task.id,
            imageBlobRef: s2.analysis.imageBlobRef,
            canvasCm,
            imagePx: s2.analysis.imagePx,
            sceneAnalysisRef: s2.artifactBlobRef,
            maxIterations: 1,
          },
          'agent',
        ),
      );
      // W2：树工件锚点=降采尺寸（mask/bbox/预览全链同坐标系）
      const tree = ObjectTreeSchema.parse(
        JSON.parse(s.blobs.read(outcome.treeArtifactRef)!.toString('utf8')),
      );
      expect(tree.imagePx).toEqual({ width: 50, height: 50 });
      expect(tree.canvasCm).toEqual(canvasCm);
      expect(outcome.totalNodes).toBeGreaterThanOrEqual(1);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [8] 真链走查 P1-1（2026-10-01）：取消传播+孤儿驱逐+终态检测

/**
 * 段循环超时孤儿三修回归（会话 1187ce52 小丑图实证：subject.segment 单调超 300s
 * 工具层死、daemon 侧循环孤儿占满 SAM 桥并发 1 队列、后续 8/8 queue-full 拒、turn
 * 1800s 兜底杀）。修复面：segment-tool 执行器（AbortSignal 贯穿+同任务同图驱逐+
 * tasks.status 终态逐桥边界复查）+ boot MCP 界 1200s（timeout-env.test.ts）。
 */
describe('subject.segment 真链走查 P1-1：取消传播+孤儿驱逐+终态检测', () => {
  /** 快速应答 handler（box→椭圆/组合 text→中央椭圆——同合成 mock 语义，score 0.8）。 */
  function fastHandler(call: Parameters<MockSamTransport['send']>[0]) {
    const { width, height } = call.request.imagePx;
    const bits = new Uint8Array(width * height);
    let cx = width / 2;
    let cy = height / 2;
    let rx = width * 0.2;
    let ry = height * 0.2;
    if (call.request.prompt.kind === 'geometric' && call.request.prompt.box !== undefined) {
      const { box } = call.request.prompt;
      cx = box.x + box.w / 2;
      cy = box.y + box.h / 2;
      rx = box.w / 2;
      ry = box.h / 2;
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dx = (x - cx) / Math.max(rx, 0.5);
        const dy = (y - cy) / Math.max(ry, 0.5);
        if (dx * dx + dy * dy <= 1) bits[y * width + x] = 1;
      }
    }
    return {
      kind: 'segment' as const,
      mask: { kind: 'inline' as const, w: width, h: height, encoding: 'base64-01' as const, data: Buffer.from(bits).toString('base64') },
      score: 0.8,
      meta: { model: 'sam3-mock@p11', durationMs: 1, iteration: call.request.iteration },
    };
  }

  /** 有界轮询等待谓词真（10ms 步进——桥请求上桥观测）。 */
  async function waitUntil(pred: () => boolean, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (pred()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect.unreachable('等待超时（谓词未满足）');
  }

  const baseInput = (f: Fixture) => ({
    taskId: f.taskId,
    imageBlobRef: f.imageBlobRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    elements: elements(),
    maxIterations: 2,
    maxGemDiameterMm: 1,
  });

  it('孤儿驱逐：同任务同图新调用进入 → 旧循环 typed loop-cancelled+桥信号传播（abortedCalls≥1）+新调用成功（桥槽位即时复用）', { timeout: 30000 }, async () => {
    const scripted = new MockSamTransport();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    // 请求 #1 阻塞（模拟 SAM 长请求——旧调用 A 卡在此处成孤儿）
    scripted.respond(async (call) => {
      await firstGate;
      return fastHandler(call);
    });
    for (let i = 0; i < 64; i++) scripted.respond(fastHandler);
    const f = setup(scripted);
    try {
      const input = baseInput(f);
      const callA = f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, input, 'agent');
      await waitUntil(() => scripted.requests.length >= 1); // A 的首请求已上桥
      const callB = f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, input, 'agent'); // B 进入=驱逐 A
      const detailA = await failedDetail(await callA);
      expect(detailA).toContain('loop-cancelled');
      expect(scripted.abortedCalls).toBeGreaterThanOrEqual(1); // 信号传播到桥面（在途请求丢弃）
      releaseFirst?.();
      const outcomeB = await okOf(await callB); // 槽位已释放——B 正常完成
      expect(outcomeB.channel).toBe('bridge');
      expect(outcomeB.totalNodes).toBeGreaterThanOrEqual(3);
    } finally {
      f.s.dispose();
    }
  });

  it('任务终态检测：桥响应后复查 tasks.status（failed=turn 兜底杀等价）→ loop-cancelled，不再发后续桥请求', { timeout: 30000 }, async () => {
    const scripted = new MockSamTransport();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    scripted.respond(async (call) => {
      await firstGate;
      return fastHandler(call);
    });
    for (let i = 0; i < 64; i++) scripted.respond(fastHandler);
    const f = setup(scripted);
    try {
      const pending = f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, baseInput(f), 'agent');
      await waitUntil(() => scripted.requests.length >= 1);
      updateTask(f.s.db, f.taskId, { status: 'failed' }); // 上层超时/兜底杀的 daemon 侧可观测面
      releaseFirst?.(); // 请求 #1 响应送达 → 适配器响应后复查 → 自取消
      const detail = await failedDetail(await pending);
      expect(detail).toContain('loop-cancelled');
      expect(detail).toContain('任务终态');
      expect(scripted.requests.length).toBe(1); // 孤儿寿命=1 桥请求界（无后续请求上桥）
    } finally {
      f.s.dispose();
    }
  });

  it('驱逐后重试（走查 8/8 queue-full 场景）：旧孤儿清场，新调用全链成功', { timeout: 30000 }, async () => {
    // 全阻塞 handler——A 永远卡在首个桥请求（工具层已超时放别的孤儿形态）
    const scripted = new MockSamTransport();
    scripted.respond(() => new Promise(() => undefined)); // 永不落定（信号中止由桥 race 承接）
    for (let i = 0; i < 64; i++) scripted.respond(fastHandler);
    const f = setup(scripted);
    try {
      const input = baseInput(f);
      const callA = f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, input, 'agent');
      await waitUntil(() => scripted.requests.length >= 1);
      const callB = f.registry.call(SUBJECT_SEGMENT_TOOL_NAME, input, 'agent');
      const detailA = await failedDetail(await callA);
      expect(detailA).toContain('loop-cancelled');
      const outcomeB = await okOf(await callB);
      expect(outcomeB.channel).toBe('bridge');
    } finally {
      f.s.dispose();
    }
  });
});
