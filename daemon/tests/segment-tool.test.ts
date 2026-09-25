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
import { createAgentTask } from '../src/db/jobs.js';
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

async function okOf(result: unknown): Promise<SubjectSegmentOutcome> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: SubjectSegmentOutcome }).value;
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
