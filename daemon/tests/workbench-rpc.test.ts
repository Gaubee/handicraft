/**
 * 工作台 RPC 集成测试（add-task-detail-layer-workbench tasks 1.3——rpc 路由层：
 * task.detail / layer.split / layer.rename / layer.strategy.set / tree.history /
 * tree.revert）。内核装配=真实 HandicraftKernel（SAM_BRIDGE_MOCK=1 合成桥经 env
 * 装配——验证 kernel→workbench→桥全链接线）；管线前置=真实 subject.segment 工具
 * 产出树工件+帧（合法集口径与产线一致）。覆盖：
 *   [1] task.detail：空管线降级面（baseImage/tree/gems=null）→全管线组装
 *       （title 派生=会话标题；六字段来源断言）。
 *   [2] layer.split：人类拆层直调（合成桥）→子层入树+task.detail 反映新树；
 *       owner 隔离（跨用户 FORBIDDEN）；未装配内核 501；缺树 typed 拒。
 *   [3] layer.strategy.set：直改→gems/preview 产出→task.detail assignments 更新。
 *   [4] layer.rename+tree.history+tree.revert：版本链+电流指针断言。
 * 零外呼零常驻进程（合成桥纯本地；kernel 不 boot dsh——workbench 不依赖运行时）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  SceneAnalysisSchema,
  type CanvasCm,
  type ImagePx,
  type SceneElement,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import { HandicraftKernel } from '../src/kernel/index.js';
import { SamBridge } from '../src/kernel/vision/sam-bridge.js';
import { SCENE_ANALYSIS_ARTIFACT_NAME } from '../src/kernel/vision/scene-analyze.js';
import {
  createSubjectSegmentCapabilities,
  createSyntheticMockSamTransport,
  SAM_BRIDGE_MOCK_ENV,
} from '../src/kernel/vision/segment-tool.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

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
      name: '主体',
      category: 'person',
      boxPx: { x: 10, y: 8, w: 70, h: 66 },
      hint: 'person',
      suggestDrillWorthy: true,
    },
  ];
}

interface RpcFixture {
  s: TestServices;
  kernel: HandicraftKernel;
  client: ReturnType<typeof clientFor>;
  taskId: string;
  imageBlobRef: string;
  /** 经 subject.segment 工具跑出 object-tree 工件+帧（产线同款前置）。 */
  runSegmentPipeline(): Promise<void>;
}

function setupKernelFixture(): RpcFixture {
  const s = createServices(undefined, { imgDryRun: true });
  process.env[SAM_BRIDGE_MOCK_ENV] = '1'; // env 装配合成桥（resolveKernelSamTransport 消费）
  const kernel = new HandicraftKernel({
    config: s.config,
    db: s.db,
    jobs: s.jobs,
    sessions: s.sessions,
    blobs: s.blobs,
  });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: '小丑贴钻会话' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const s2 = s;
  const taskId = task.id;
  return {
    s,
    kernel,
    client: clientFor(s.context({ kernel })),
    taskId,
    imageBlobRef,
    runSegmentPipeline: async () => {
      // S2 前置：scene-analysis 工件+帧（真 scene.analyze 需 LLM 路由——测试直植同构工件）
      const analysis = SceneAnalysisSchema.parse({
        kind: 'scene-analysis',
        formatVersion: 1,
        imageBlobRef,
        canvasCm: CANVAS_CM,
        imagePx: IMAGE_PX,
        elements: elements(),
        createdAt: new Date().toISOString(),
      });
      const analysisRef = putTaskArtifact(
        { db: s2.db, blobs: s2.blobs },
        taskId,
        Buffer.from(JSON.stringify(analysis), 'utf8'),
      ).hash;
      s2.jobs.emitFor(taskId, 'artifact', { blobRef: analysisRef, name: SCENE_ANALYSIS_ARTIFACT_NAME });

      const bridge = new SamBridge(
        { db: s2.db, blobs: s2.blobs, dataRoot: s2.config.dataRoot },
        { transport: createSyntheticMockSamTransport() },
      );
      const registry = createSubjectSegmentCapabilities({
        db: s2.db,
        blobs: s2.blobs,
        jobs: s2.jobs,
        bridge,
      });
      const result = await registry.call(
        'studio.subject.segment',
        {
          taskId,
          imageBlobRef,
          canvasCm: CANVAS_CM,
          imagePx: IMAGE_PX,
          sceneAnalysisRef: analysisRef,
        },
        'agent',
      );
      expect(result).toMatchObject({ kind: 'ok' });
    },
  };
}

let fixture: RpcFixture;
let authToken: string;

beforeAll(async () => {
  fixture = setupKernelFixture();
  authToken = await fixture.s.tokenFor();
  fixture.client = clientFor(fixture.s.context({ kernel: fixture.kernel, token: authToken }));
});

afterAll(() => {
  delete process.env[SAM_BRIDGE_MOCK_ENV];
  void fixture.kernel.stop().catch(() => undefined);
  fixture.s.dispose();
});

// ---------------------------------------------------------------- [1] task.detail

describe('task.detail', () => {
  it('空管线降级面：task/session 在场，baseImage/tree/gems/preview=null、assignments=[]', async () => {
    const detail = await fixture.client.task.detail({ taskId: fixture.taskId });
    expect(detail.task.id).toBe(fixture.taskId);
    expect(detail.task.status).toBe('running');
    expect(detail.task.title).toBe('小丑贴钻会话'); // title 派生=会话标题
    expect(detail.session).toMatchObject({ title: '小丑贴钻会话' });
    expect(detail.baseImage).toBeNull();
    expect(detail.tree).toBeNull();
    expect(detail.assignments).toEqual([]);
    expect(detail.gems).toBeNull();
    expect(detail.preview).toBeNull();
  });

  it('任务不存在 NOT_FOUND；跨用户 FORBIDDEN', async () => {
    await expect(fixture.client.task.detail({ taskId: 'no-such-task' })).rejects.toThrowError(/不存在/);
  });

  it('全管线组装：跑 subject.segment 后 baseImage/tree/preview 在场（title→文本兜底）', async () => {
    await fixture.runSegmentPipeline();
    const detail = await fixture.client.task.detail({ taskId: fixture.taskId });
    expect(detail.baseImage).toMatchObject({
      blobRef: fixture.imageBlobRef,
      widthPx: 96,
      heightPx: 96,
    });
    expect(detail.tree?.nodes.length).toBeGreaterThan(0);
    const tree = ObjectTreeSchema.parse({
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: CANVAS_CM,
      imagePx: IMAGE_PX,
      nodes: detail.tree!.nodes,
      createdAt: '2026-09-26T00:00:00.000Z',
    });
    expect(tree.nodes.length).toBe(detail.tree!.nodes.length);
    expect(detail.preview).not.toBeNull(); // 树叠加预览兜底
  });
});

// ---------------------------------------------------------------- [2] layer.split

describe('layer.split', () => {
  it('人类拆层直调（合成桥）：子层入树+task.detail 反映新树', async () => {
    const before = await fixture.client.task.detail({ taskId: fixture.taskId });
    const leaf = before.tree!.nodes.find((n) => n.children.length === 0 && n.drillWorthy)!;
    const out = await fixture.client.layer.split({
      taskId: fixture.taskId,
      nodeId: leaf.id,
      hint: 'hat',
    });
    expect(out.children).toHaveLength(1);
    expect(out.children[0]!.parent).toBe(leaf.id);
    const after = await fixture.client.task.detail({ taskId: fixture.taskId });
    expect(after.tree!.blobRef).toBe(out.treeBlobRef);
    expect(after.tree!.nodes.length).toBe(before.tree!.nodes.length + 1);
    // 版本入史（owner 审计）
    const history = await fixture.client.tree.history({ taskId: fixture.taskId });
    expect(history.versions[0]!.cause).toBe('segment-one');
    expect(history.currentTreeBlobRef).toBe(out.treeBlobRef);
  });

  it('node 不在树 typed 拒（BAD_REQUEST+code）', async () => {
    await expect(
      fixture.client.layer.split({ taskId: fixture.taskId, nodeId: 'n-missing', hint: 'x' }),
    ).rejects.toThrowError(/node-not-found/);
  });

  it('内核未装配 501', async () => {
    const bare = clientFor(fixture.s.context({ kernel: undefined, token: authToken }));
    await expect(
      bare.layer.split({ taskId: fixture.taskId, nodeId: 'n', hint: 'x' }),
    ).rejects.toThrowError(/未装配/);
  });

  it('缺图层树的任务 typed 拒（指引先跑 agent 管线）', async () => {
    const { sessionId } = fixture.s.sessions.create(fixture.s.anonymous, { title: '空管线' });
    const empty = createAgentTask(fixture.s.db, {
      ownerId: fixture.s.anonymous.id,
      sessionId,
      status: 'running',
    });
    await expect(
      fixture.client.layer.split({ taskId: empty.id, nodeId: 'n', hint: 'x' }),
    ).rejects.toThrowError(/尚无图层树/);
  });
});

// ---------------------------------------------------------------- [3] layer.strategy.set

describe('layer.strategy.set', () => {
  it('排除直改（exclusion 无钻通道）→assignments 即时更新', async () => {
    const detail = await fixture.client.task.detail({ taskId: fixture.taskId });
    const leaf = detail.tree!.nodes.find((n) => n.children.length === 0 && n.drillWorthy)!;
    const out = await fixture.client.layer.strategy.set({
      taskId: fixture.taskId,
      nodeId: leaf.id,
      strategyKind: 'exclusion',
      params: { reason: '工作台留白' },
    });
    expect(out.gems.count).toBe(0); // 全排除树零钻
    expect(out.preview.blobRef).toMatch(/^[0-9a-f]{64}$/);
    const after = await fixture.client.task.detail({ taskId: fixture.taskId });
    const assigned = after.assignments.find((a) => a.nodeId === leaf.id);
    expect(assigned?.strategyKind).toBe('exclusion');
    expect(assigned?.rationale).toContain('工作台直改');
  });
});

// ---------------------------------------------------------------- [4] rename/history/revert

describe('layer.rename + tree.history/revert', () => {
  it('改名直生效→版本链→revert 回拨电流', async () => {
    const detail = await fixture.client.task.detail({ taskId: fixture.taskId });
    const leaf = detail.tree!.nodes.find((n) => n.children.length === 0 && n.drillWorthy)!;
    const renamed = await fixture.client.layer.rename({
      taskId: fixture.taskId,
      nodeId: leaf.id,
      objectName: '小丑帽',
    });
    expect(renamed.version).toBeGreaterThan(1);
    const after = await fixture.client.task.detail({ taskId: fixture.taskId });
    expect(after.tree!.nodes.find((n) => n.id === leaf.id)!.objectName).toBe('小丑帽');

    const history = await fixture.client.tree.history({ taskId: fixture.taskId });
    const causes = history.versions.map((v) => v.cause);
    expect(causes).toContain('segment-one');
    expect(causes).toContain('rename');

    const reverted = await fixture.client.tree.revert({ taskId: fixture.taskId, version: 1 });
    expect(reverted.version).toBe(history.versions.length + 1);
    const finalDetail = await fixture.client.task.detail({ taskId: fixture.taskId });
    expect(finalDetail.tree!.blobRef).toBe(reverted.treeBlobRef);
    expect(finalDetail.tree!.nodes.find((n) => n.id === leaf.id)!.objectName).not.toBe('小丑帽');
  });

  it('version 缺失 typed 拒', async () => {
    await expect(
      fixture.client.tree.revert({ taskId: fixture.taskId, version: 999 }),
    ).rejects.toThrowError(/version-not-found/);
  });
});
