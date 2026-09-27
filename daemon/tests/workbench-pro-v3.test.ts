/**
 * workbench-pro v3 测试（Owner 走查整改三面）：
 *   [1] tree.history journey 基线播种：Agent 会话产树（persistTreeWithPreview+
 *       emitFor 帧发布——segment-tool 同款写路径）不入 tree_versions ⇒ 历史恒空
 *       （「事务历史不工作」根因）。treeHistory seed 面对「链未覆盖的电流树」播种
 *       cause='journey' 基线；链已覆盖不重复播种；工作台写后 journey 再推进=新基线。
 *   [2] view.state.set previewMode 写透（v3 预览三模式服务端化）：显式携带=写进
 *       工件；缺省=保留服务端现值；task.detail.viewState.previewMode 读回。
 *   [3] task.detail stoneCandidates（v3 钻选择器数据面）：owner 共享库稳定序投影
 *       （projectStoneCandidates 同源——idx 1 基）；无钻库存=空数组降级不阻塞。
 * 零外呼零常驻进程。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  encodeInlineMask,
  type CanvasCm,
  type ImagePx,
  type ObjectNode,
  type ObjectTree,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { openDatabase } from '../src/db/database.js';
import { BlobStore } from '../src/db/blobs.js';
import { HandicraftKernel, strategyEngineDelegate } from '../src/kernel/index.js';
import { StoneService } from '../src/stones/service.js';
import { persistTreeWithPreview } from '../src/kernel/vision/tree-persist.js';
import { TaskWorkbench } from '../src/kernel/workbench.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

function testImage(): Uint8Array {
  const w = 96;
  const h = 96;
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const p = (y * w + x) * 4;
      rgba[p] = 160;
      rgba[p + 1] = 160;
      rgba[p + 2] = 160;
      rgba[p + 3] = 255;
    }
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

const CANVAS_CM: CanvasCm = { w: 10, h: 10 };
const IMAGE_PX: ImagePx = { width: 96, height: 96 };

function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

function v3Tree(): ObjectTree {
  const hat: ObjectNode = {
    id: 'n-hat',
    objectName: '帽子',
    category: 'hat',
    mask: solidMask(30, 20),
    bbox: { x: 30, y: 4, w: 30, h: 20 },
    parent: 'n-body',
    children: [],
    effectiveMm: 24.5,
    labVariance: 8,
    drillWorthy: true,
    origin: 'vlm+sam3',
  };
  const body: ObjectNode = {
    id: 'n-body',
    objectName: '主体',
    category: 'person',
    mask: solidMask(70, 66),
    bbox: { x: 10, y: 8, w: 70, h: 66 },
    parent: 'n-root',
    children: [hat.id],
    effectiveMm: 68,
    labVariance: 20,
    drillWorthy: true,
    origin: 'vlm+sam3',
  };
  const root: ObjectNode = {
    id: 'n-root',
    objectName: '画布',
    category: 'canvas',
    mask: solidMask(96, 96),
    bbox: { x: 0, y: 0, w: 96, h: 96 },
    parent: null,
    children: [body.id],
    effectiveMm: 96,
    labVariance: 30,
    drillWorthy: false,
    origin: 'vlm+sam3',
  };
  return ObjectTreeSchema.parse({
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    nodes: [root, body, hat],
    createdAt: '2026-09-27T00:00:00.000Z',
  });
}

const YUHANG_PROFILE: Parameters<StoneService['createStone']>[0]['supplierProfile'] = {
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 78] as [number, number], sizeMmByPrefix: { J: 2, A: 3 } }],
  styleKey: 'row',
};

interface Fixture {
  s: TestServices;
  kernel: HandicraftKernel;
  client: ReturnType<typeof clientFor>;
  taskId: string;
  actorId: string;
  imageBlobRef: string;
  workbench: TaskWorkbench;
  /** journey 产树模拟（segment-tool 写路径同构：persist+帧发布，不入版本链）。 */
  journeyWriteTree(tree: ObjectTree): { treeBlobRef: string; previewBlobRef: string };
  latestTreeRef(): string | null;
  latestPreviewRef(): string | null;
  seedStone(sku: string, colorRgb: [number, number, number]): void;
}

function setup(): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const kernel = new HandicraftKernel({
    config: s.config,
    db: s.db,
    jobs: s.jobs,
    sessions: s.sessions,
    blobs: s.blobs,
  });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'v3 整改测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const workbench = new TaskWorkbench({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    engineLayout: strategyEngineDelegate,
  });
  const artifactRef = (name: string): string | null => {
    const frames = s.jobs.frames(s.anonymous, task.id, 0).frames;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const fr = frames[i]!;
      if (fr.kind !== 'artifact') continue;
      const payload = fr.payload as { name?: unknown; blobRef?: unknown };
      if (payload.name === name && typeof payload.blobRef === 'string') return payload.blobRef;
    }
    return null;
  };
  return {
    s,
    kernel,
    client: clientFor(s.context({ kernel })),
    taskId: task.id,
    actorId: s.anonymous.id,
    imageBlobRef,
    workbench,
    journeyWriteTree: (tree) => {
      const bundle = persistTreeWithPreview({ db: s.db, blobs: s.blobs }, task.id, imageBlobRef, tree);
      s.jobs.emitFor(task.id, 'artifact', { blobRef: bundle.treeBlobRef, name: 'object-tree.json' });
      s.jobs.emitFor(task.id, 'artifact', { blobRef: bundle.previewBlobRef, name: 'object-tree-preview.png' });
      return { treeBlobRef: bundle.treeBlobRef, previewBlobRef: bundle.previewBlobRef };
    },
    latestTreeRef: () => artifactRef('object-tree.json'),
    latestPreviewRef: () => artifactRef('object-tree-preview.png'),
    seedStone: (sku, colorRgb) => {
      const stones = new StoneService({ db: s.db, blobs: s.blobs });
      const rgba = new Uint8Array(128 * 128 * 4).fill(255);
      stones.createStone({
        ownerId: s.anonymous.id,
        supplierProfile: YUHANG_PROFILE,
        draft: {
          name: `${sku} 钻`,
          sku,
          sizeMm: 3,
          color: { name: '测试色', rgb: colorRgb, family: '测试系', finish: 'glossy' },
          texture: { declaredWidth: 128, declaredHeight: 128 },
        },
        textureBytes: new Uint8Array(encodePng(128, 128, rgba)),
      });
    },
  };
}

let f: Fixture;
let token: string;

beforeAll(async () => {
  f = setup();
  token = await f.s.tokenFor();
  f.client = clientFor(f.s.context({ kernel: f.kernel, token }));
});

afterAll(() => {
  void f.kernel.stop().catch(() => undefined);
  f.s.dispose();
});

// ---------------------------------------------------------------- [1] journey 基线播种

describe('tree.history journey 基线播种（事务历史根因修复）', () => {
  it('journey 任务空链 → 读取播种 v1 journey 基线；重复读取不重复播种', async () => {
    f.journeyWriteTree(v3Tree());
    // 根因复现：journey 写路径不落 tree_versions（链空——Owner 实测「不工作」面）
    const bare = f.workbench.treeHistory(f.taskId);
    expect(bare.versions).toEqual([]);

    // seed 面（RPC 同参）：链尾≠电流树 ⇒ 播种 journey 基线
    const seeded = f.workbench.treeHistory(f.taskId, {
      currentTreeBlobRef: f.latestTreeRef(),
      currentPreviewBlobRef: f.latestPreviewRef(),
      actorId: f.actorId,
    });
    expect(seeded.versions.length).toBe(1);
    expect(seeded.versions[0]).toMatchObject({ version: 1, cause: 'journey' });
    expect(seeded.currentVersion).toBe(1);

    // 幂等：链已覆盖电流树——再读不追加
    const again = f.workbench.treeHistory(f.taskId, {
      currentTreeBlobRef: f.latestTreeRef(),
      currentPreviewBlobRef: f.latestPreviewRef(),
      actorId: f.actorId,
    });
    expect(again.versions.length).toBe(1);
  });

  it('工作台 rename 入链 → journey 再推进 → 新基线行续链（链连续可回退）', async () => {
    const out = f.workbench.renameNode({
      taskId: f.taskId,
      actorId: f.actorId,
      imageBlobRef: f.imageBlobRef,
      treeBlobRef: f.latestTreeRef()!,
      nodeId: 'n-hat',
      objectName: '魔术帽',
    });
    expect(out.version).toBe(2); // journey 基线 v1 之后

    // journey 重跑推进树（agent 会话再识图）→ 读取时播种新基线 v3
    const advanced = v3Tree();
    advanced.nodes[1]!.objectName = '小丑';
    f.journeyWriteTree(advanced);
    const history = f.workbench.treeHistory(f.taskId, {
      currentTreeBlobRef: f.latestTreeRef(),
      currentPreviewBlobRef: f.latestPreviewRef(),
      actorId: f.actorId,
    });
    expect(history.versions.map((v) => v.cause)).toEqual(['journey', 'rename', 'journey']);
    expect(history.currentVersion).toBe(3);

    // 回退到 rename 版（v2）可行——journey 基线进入可回退快照链
    const reverted = f.workbench.treeRevert({ taskId: f.taskId, actorId: f.actorId, version: 2 });
    expect(reverted.version).toBe(4);
  });

  it('RPC 级：tree.history 端点携带 seed 面（journey 任务历史非空）', async () => {
    const out = await f.client.tree.history({ taskId: f.taskId });
    expect(out.versions.length).toBeGreaterThan(0);
    expect(out.versions.some((v) => v.cause === 'journey')).toBe(true);
    expect(out.currentTreeBlobRef).toBe(f.latestTreeRef());
  });

  it('并发播种事务化（Codex v3 复核 P1）：两连接同 seed——读尾-比较-插入同一事务后只插一行', () => {
    // 新任务+journey 产树（隔离上方 describe 的既有链状态；fixture 闭包绑原任务——内联写路径）
    const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: 'v3 并发播种' });
    const task2 = createAgentTask(f.s.db, { ownerId: f.actorId, sessionId, status: 'running' });
    const bundle = persistTreeWithPreview({ db: f.s.db, blobs: f.s.blobs }, task2.id, f.imageBlobRef, v3Tree());
    f.s.jobs.emitFor(task2.id, 'artifact', { blobRef: bundle.treeBlobRef, name: 'object-tree.json' });
    f.s.jobs.emitFor(task2.id, 'artifact', { blobRef: bundle.previewBlobRef, name: 'object-tree-preview.png' });

    // 第二连接（同 dataRoot——WAL 双开；两进程并发读取的交错面）
    const db2 = openDatabase(f.s.config.dataRoot);
    const blobs2 = new BlobStore(f.s.config.dataRoot, db2);
    const wb2 = new TaskWorkbench({ db: db2, blobs: blobs2, jobs: f.s.jobs });
    try {
      const seed = { currentTreeBlobRef: bundle.treeBlobRef, currentPreviewBlobRef: bundle.previewBlobRef, actorId: f.actorId };
      const a = f.workbench.treeHistory(task2.id, seed);
      const b = wb2.treeHistory(task2.id, seed);
      // 旧形态（读尾在事务外）：两连接都判「链未覆盖」各自 recordTreeVersion ⇒
      // 同 seed 双行（v1+v2 重复增长）；事务化后只插一行
      expect(a.versions).toHaveLength(1);
      expect(b.versions).toHaveLength(1);
      expect(a.versions[0]).toMatchObject({ version: 1, cause: 'journey' });
      expect(b.versions[0]).toMatchObject({ version: 1, cause: 'journey' });
    } finally {
      db2.close();
    }
  });

  it('preview 工件缺失：播种前双工件校验失败 → 跳过不炸读面（返回既有链，零行入史）', () => {
    const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: 'v3 preview 缺失' });
    const task3 = createAgentTask(f.s.db, { ownerId: f.actorId, sessionId, status: 'running' });
    const bundle = persistTreeWithPreview({ db: f.s.db, blobs: f.s.blobs }, task3.id, f.imageBlobRef, v3Tree());
    f.s.jobs.emitFor(task3.id, 'artifact', { blobRef: bundle.treeBlobRef, name: 'object-tree.json' });

    const out = f.workbench.treeHistory(task3.id, {
      currentTreeBlobRef: bundle.treeBlobRef,
      currentPreviewBlobRef: 'missing-preview-ref-0000',
      actorId: f.actorId,
    });
    // 读面不炸：空链原样返回；未播种任何行
    expect(out.versions).toEqual([]);
    const rows = f.s.db
      .prepare('SELECT COUNT(*) AS n FROM tree_versions WHERE task_id = ?')
      .get(task3.id) as { n: number };
    expect(rows.n).toBe(0);
  });
});

// ---------------------------------------------------------------- [2] previewMode 服务端化

describe('view.state.set previewMode 写透（预览三模式持久面）', () => {
  it('首写携带 holes → detail.viewState 读回；缺省重写保留现值', async () => {
    const set = await f.client.view.state.set({ taskId: f.taskId, nodes: [], previewMode: 'holes' });
    expect(set.revision).toBeGreaterThan(0);
    const detail = await f.client.task.detail({ taskId: f.taskId });
    expect(detail.viewState?.previewMode).toBe('holes');

    // 纯节点面写（缺省 previewMode）不冲刷模式
    const set2 = await f.client.view.state.set({
      taskId: f.taskId,
      nodes: [],
      expectedRevision: set.revision,
    });
    const detail2 = await f.client.task.detail({ taskId: f.taskId });
    expect(detail2.viewState?.previewMode).toBe('holes');
    expect(set2.revision).toBe(set.revision + 1);

    // 切换模式
    await f.client.view.state.set({ taskId: f.taskId, nodes: [], expectedRevision: set2.revision, previewMode: 'numbered' });
    const detail3 = await f.client.task.detail({ taskId: f.taskId });
    expect(detail3.viewState?.previewMode).toBe('numbered');
  });
});

// ---------------------------------------------------------------- [3] stoneCandidates

describe('task.detail stoneCandidates（钻选择器数据面）', () => {
  it('无钻库存=空数组降级（读面不阻塞）→ 入库后投影（idx 1 基稳定序）', async () => {
    const before = await f.client.task.detail({ taskId: f.taskId });
    expect(before.stoneCandidates).toEqual([]);

    f.seedStone('A52', [200, 40, 40]);
    f.seedStone('J106', [40, 200, 120]);
    const detail = await f.client.task.detail({ taskId: f.taskId });
    expect(detail.stoneCandidates.length).toBe(2);
    expect(detail.stoneCandidates[0]).toMatchObject({ idx: 1, sku: 'A52', sizeMm: 3, colorHex: '#C82828' });
    expect(detail.stoneCandidates[1]).toMatchObject({ idx: 2, sku: 'J106' });
    // idx 连续 1 基（layer.strategy.set stoneIdx 引用键）
    expect(detail.stoneCandidates.map((c) => c.idx)).toEqual([1, 2]);
  });
});
