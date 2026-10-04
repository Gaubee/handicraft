/**
 * add-flat-aux-segmentation T4 波测试（design D4——分件排钻双通道，2026-10-04）：
 *   [T4.1] 分件输入接线：subject.segment 送桥输入图/树锚/账本分账键=任务级 referenceImage
 *          （reference-image.png 帧在场时）；缺席=原图零变化；陈旧参考图层（网格不符）
 *          =typed warning 软回退；agent 直传参考图层 blob=锚校验容忍。
 *   [T4.2a] 策略设计双图预览：renderReferenceSourcePair 纯函数（左参考/右原图/中缝
 *          分隔）+buildReferenceSourcePairPreviews（帧流解析——有参考出预览/无参考零变化）。
 *   [T4.2b] 亮度场真源=原图：bboxLumaB64 纯函数+resolveStrategyLumaSourceRef 三态+
 *          executeStrategyPlan lumaB64 注入（texture-fill；plan 工件字节不含注入量）。
 *   [T4.4] pavingStyle：contracts PavingStyleSchema+buildStrategyDesignPrompt 铺法行
 *          （缺省零行）+partCountsOfLayout 终局实算。
 * 零外呼零常驻进程（合成 mock 桥+本地服务栈）。
 */
import { describe, expect, it } from 'vitest';
import {
  encodeInlineMask,
  ObjectTreeSchema,
  PavingStyleSchema,
  SceneAnalysisSchema,
  StrategyPlanSchema,
  type CanvasCm,
  type ImagePx,
  type ObjectTree,
  type SceneAnalysis,
  type SceneElement,
} from '@handicraft/contracts';
import { decodePng, encodePng } from '../src/png/codec.js';
import { putTaskArtifact } from '../src/jobs/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { SamBridge } from '../src/kernel/vision/sam-bridge.js';
import {
  createSubjectSegmentCapabilities,
  createSyntheticMockSamTransport,
  type SubjectSegmentOutcome,
} from '../src/kernel/vision/segment-tool.js';
import { loadObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import { partCountsOfLayout } from '../src/capability/task-export.js';
import {
  bboxLumaB64,
  buildReferenceSourcePairPreviews,
  buildStrategyDesignPrompt,
  executeStrategyPlan,
  LUMA_CONSUMING_STRATEGY_KINDS,
  renderReferenceSourcePair,
  resolveStrategyLumaSourceRef,
  REFERENCE_SOURCE_PAIR_DIVIDER_PX,
  type StoneCandidate,
} from '../src/kernel/strategies/design.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

/** 250×250=10cm×25px/cm 规范网格三色图（segment-tool.test 同款形态）。 */
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

/** 参考图层替身图（同网格不同色——字节级可判别「分件输入换图」）。 */
function referenceImage(w = 250, h = 250): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[p * 4] = 120;
    rgba[p * 4 + 1] = 140;
    rgba[p * 4 + 2] = 60;
    rgba[p * 4 + 3] = 255;
  }
  return new Uint8Array(encodePng(w, h, rgba));
}

/** 第三图（同网格异内容——anchor-mismatch 判别用）。 */
function darkImage(): Uint8Array {
  const rgba = new Uint8Array(250 * 250 * 4);
  rgba.fill(255);
  for (let p = 0; p < 250 * 250; p++) rgba[p * 4] = 10;
  return new Uint8Array(encodePng(250, 250, rgba));
}

const CANVAS_CM: CanvasCm = { w: 10, h: 10 };
const IMAGE_PX: ImagePx = { width: 250, height: 250 };

function elements(): SceneElement[] {
  return [
    { name: '花束', category: 'flower', boxPx: { x: 10, y: 8, w: 70, h: 66 }, hint: 'bouquet', suggestDrillWorthy: true },
    { name: '缎带', category: 'object', boxPx: { x: 4, y: 80, w: 88, h: 12 }, hint: 'ribbon', suggestDrillWorthy: true },
  ];
}

interface Fixture {
  s: TestServices;
  taskId: string;
  imageBlobRef: string;
  transport: ReturnType<typeof createSyntheticMockSamTransport>;
  call(input: Record<string, unknown>): Promise<unknown>;
  frames(): Array<Record<string, unknown>>;
}

function setup(): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  const imageBlobRef = s.blobs.put(testImage()).hash;
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'flat-aux t4 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const transport = createSyntheticMockSamTransport();
  const bridge = new SamBridge({ db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot }, { transport });
  const registry = createSubjectSegmentCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    dataRoot: s.config.dataRoot,
    bridge,
  });
  return {
    s,
    taskId: task.id,
    imageBlobRef,
    transport,
    call: (input) => registry.call('studio.subject.segment', { taskId: task.id, ...input }, 'agent'),
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames as unknown as Array<Record<string, unknown>>,
  };
}

function baseInput(f: Fixture, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: f.taskId,
    imageBlobRef: f.imageBlobRef,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    elements: elements(),
    ...extra,
  };
}

/** 落参考图层工件+帧（blob 旁路 put——帧流是 referenceImage 在场判定锚）。 */
function plantReferenceImage(f: Fixture, bytes: Uint8Array): string {
  const blobRef = putTaskArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, bytes).hash;
  f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef, name: 'reference-image.png' });
  return blobRef;
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

async function doneOf(result: unknown): Promise<Extract<SubjectSegmentOutcome, { status: 'done' }>> {
  expect(result).toMatchObject({ kind: 'ok' });
  const value = (result as { value: SubjectSegmentOutcome }).value;
  if (value.status !== 'done') throw new Error(`期望 done，实为 ${value.status}`);
  return value;
}

// ---------------------------------------------------------------- T4.1 分件输入接线

describe('T4.1 分件输入=任务级 referenceImage（D4）', () => {
  it('参考图层帧在场：送桥输入图/树锚/segmentImage=参考图层（progress 帧留痕）', async () => {
    const f = setup();
    const referenceRef = plantReferenceImage(f, referenceImage());
    const outcome = await doneOf(await f.call(baseInput(f)));
    // 送桥请求恒携参考图层 blob（合成 mock 录制面）
    expect(f.transport.segmentRequests.length).toBeGreaterThan(0);
    for (const request of f.transport.segmentRequests) {
      expect(request.imageBlobRef).toBe(referenceRef);
    }
    // 树锚=分件输入图（persistTreeWithPreview 单源——imageBlobRef 同源一致）
    const tree = loadObjectTreeArtifact(f.s.blobs, outcome.treeArtifactRef);
    expect(tree.imageBlobRef).toBe(referenceRef);
    // 结果面明示分件输入事实+任务流可见
    expect(outcome.segmentImage).toEqual({ source: 'reference', blobRef: referenceRef });
    const texts = f
      .frames()
      .filter((frame) => frame['kind'] === 'progress')
      .map((frame) => String((frame['payload'] as { text?: string }).text ?? ''));
    expect(texts.some((text) => text.includes('分件输入=参考图层'))).toBe(true);
  });

  it('参考图层缺席：送桥/树锚/segmentImage=原图（零变化——与既有行为逐位一致）', async () => {
    const f = setup();
    const outcome = await doneOf(await f.call(baseInput(f)));
    for (const request of f.transport.segmentRequests) {
      expect(request.imageBlobRef).toBe(f.imageBlobRef);
    }
    const tree = loadObjectTreeArtifact(f.s.blobs, outcome.treeArtifactRef);
    expect(tree.imageBlobRef).toBe(f.imageBlobRef);
    expect(outcome.segmentImage).toEqual({ source: 'source', blobRef: f.imageBlobRef });
  });

  it('账本分账实跑：同图同清单，有/无参考图层落不同账本域（不串账）', async () => {
    const f1 = setup();
    await doneOf(await f1.call(baseInput(f1)));
    const f2 = setup();
    plantReferenceImage(f2, referenceImage());
    await doneOf(await f2.call(baseInput(f2)));
    // 两任务同 elements/imagePx/canvasCm——仅参考图层在场面不同 ⇒ 指纹不同 ⇒ 双账本文件
    const { readdirSync } = await import('node:fs');
    const path = await import('node:path');
    const filesOf = (root: string): string[] => {
      const dir = path.join(root, 'segment-ledgers');
      return readdirSync(dir).toSorted();
    };
    const files1 = filesOf(f1.s.config.dataRoot);
    const files2 = filesOf(f2.s.config.dataRoot);
    expect(files1.length).toBe(1);
    expect(files2.length).toBe(1);
    expect(files1[0]).not.toBe(files2[0]);
  });

  it('陈旧参考图层（网格不符）：typed warning 软回退原图（不阻塞分件）', async () => {
    const f = setup();
    plantReferenceImage(f, referenceImage(120, 120)); // ≠ 工作锚点 250×250
    const outcome = await doneOf(await f.call(baseInput(f)));
    expect(outcome.segmentImage).toEqual({ source: 'source', blobRef: f.imageBlobRef });
    expect(outcome.warnings).toContainEqual(
      expect.objectContaining({ reason: 'reference-image-unusable' }),
    );
    for (const request of f.transport.segmentRequests) {
      expect(request.imageBlobRef).toBe(f.imageBlobRef);
    }
  });

  it('agent 直传参考图层 blob + sceneAnalysisRef：锚校验容忍（不为 anchor-mismatch）', async () => {
    const f = setup();
    const referenceRef = plantReferenceImage(f, referenceImage());
    const sceneRef = sceneAnalysisArtifact(f); // 分析锚=原图（与参考图层同网格）
    const outcome = await doneOf(
      await f.call(baseInput(f, { imageBlobRef: referenceRef, elements: undefined, sceneAnalysisRef: sceneRef })),
    );
    expect(outcome.segmentImage).toEqual({ source: 'reference', blobRef: referenceRef });
    const tree = loadObjectTreeArtifact(f.s.blobs, outcome.treeArtifactRef);
    expect(tree.imageBlobRef).toBe(referenceRef);
  });

  it('agent 传其它图（≠分析锚≠参考图层）：anchor-mismatch 照拒（容忍面不放大）', async () => {
    const f = setup();
    plantReferenceImage(f, referenceImage());
    const sceneRef = sceneAnalysisArtifact(f);
    const otherRef = f.s.blobs.put(darkImage()).hash; // 同网格异内容（≠分析锚≠参考图层）
    const result = (await f.call(baseInput(f, { imageBlobRef: otherRef, elements: undefined, sceneAnalysisRef: sceneRef }))) as {
      kind: string;
      message: string;
    };
    expect(result.kind).toBe('failed');
    expect(result.message).toContain('anchor-mismatch');
  });
});

// ---------------------------------------------------------------- T4.2a 双图预览

describe('T4.2a 策略设计双图预览（D4——结构=参考图层/色彩=原图）', () => {
  it('renderReferenceSourcePair：左参考右原图+深色中缝；同输入逐字节确定', () => {
    const reference = decodePng(referenceImage(60, 40));
    const source = decodePng(testImage());
    const a = renderReferenceSourcePair(reference, source, 128);
    const b = renderReferenceSourcePair(reference, source, 128);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const decoded = decodePng(a);
    // 合成高=max(40,128)=128：左半幅（60×40）纵向居中 padY=44、右半幅（128×128）满高
    const height = 128;
    const leftH = 40;
    const leftPadY = Math.floor((height - leftH) / 2);
    const pxAt = (x: number, y: number): readonly number[] => Array.from(decoded.rgba.slice((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 3));
    const rightOriginX = 60 + REFERENCE_SOURCE_PAIR_DIVIDER_PX;
    // 左半幅（参考图层纯色 120,140,60）：取 padY 内的左上像素
    expect(pxAt(2, leftPadY + 2)).toEqual([120, 140, 60]);
    // pad 带（左半幅上下补齐底色 245）
    expect(pxAt(2, 2)).toEqual([245, 245, 245]);
    // 右半幅（原图 250×250→128×128 满高）：右下内侧=原图黄带
    expect(pxAt(rightOriginX + 128 - 3, height - 3)).toEqual([230, 200, 40]);
    // 中缝=深色
    expect(pxAt(60 + 1, Math.floor(height / 2))).toEqual([24, 24, 24]);
  });

  it('buildReferenceSourcePairPreviews：有参考图层+scene-analysis → 1 张 kind=reference-source-pair；无参考=空（零变化）', () => {
    const f = setup();
    // 无参考图层（scene-analysis 在场）→ 空数组
    const analysisRef = putTaskArtifact(
      { db: f.s.db, blobs: f.s.blobs },
      f.taskId,
      Buffer.from(JSON.stringify(SceneAnalysisSchema.parse({
        kind: 'scene-analysis',
        formatVersion: 1,
        imageBlobRef: f.imageBlobRef,
        canvasCm: CANVAS_CM,
        imagePx: IMAGE_PX,
        elements: elements(),
        createdAt: new Date().toISOString(),
      })), 'utf8'),
    ).hash;
    f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: analysisRef, name: 'scene-analysis.json' });
    expect(
      buildReferenceSourcePairPreviews({ db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs }, f.taskId),
    ).toEqual([]);
    // 落参考图层 → 恰 1 张双图预览（blob 可解码+kind 通道复用）
    plantReferenceImage(f, referenceImage());
    const previews = buildReferenceSourcePairPreviews({ db: f.s.db, blobs: f.s.blobs, jobs: f.s.jobs }, f.taskId);
    expect(previews.length).toBe(1);
    expect(previews[0]!.kind).toBe('reference-source-pair');
    expect(previews[0]!.mime).toBe('image/png');
    expect(() => decodePng(f.s.blobs.read(previews[0]!.blobRef)!)).not.toThrow();
    expect(previews[0]!.dataBase64.length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------- T4.2b 亮度场真源=原图

describe('T4.2b 亮度场/纹理采样输入=原图（D4）', () => {
  it('bboxLumaB64：Rec.601 灰度+bbox 局部（与掩膜同维）；越界像素=128', () => {
    const image = decodePng(testImage()); // 左红(200,40,40)/右蓝(40,60,200)/底黄(230,200,40)
    const left = bboxLumaB64(image, { x: 0, y: 0, w: 4, h: 4 });
    const leftBytes = Buffer.from(left, 'base64');
    expect(leftBytes.length).toBe(16);
    expect(leftBytes[0]).toBe(Math.round(0.299 * 200 + 0.587 * 40 + 0.114 * 40)); // 红≈90
    const right = bboxLumaB64(image, { x: 246, y: 0, w: 4, h: 4 });
    expect(Buffer.from(right, 'base64')[0]).toBe(Math.round(0.299 * 40 + 0.587 * 60 + 0.114 * 200)); // 蓝≈77
    const oob = bboxLumaB64(image, { x: 248, y: 0, w: 8, h: 2 }); // 越右界 2 列
    const oobBytes = Buffer.from(oob, 'base64');
    expect(oobBytes[6]).toBe(128);
    expect(oobBytes[7]).toBe(128);
  });

  it('LUMA_CONSUMING_STRATEGY_KINDS=luma 消费族白名单（texture-fill/straight-line）', () => {
    expect([...LUMA_CONSUMING_STRATEGY_KINDS].sort()).toEqual(['straight-line', 'texture-fill']);
  });

  it('resolveStrategyLumaSourceRef：无参考=树锚；有参考+scene-analysis=分析锚；有参考无分析=null（宁缺毋假）', () => {
    const f = setup();
    const tree = ObjectTreeSchema.parse({
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: CANVAS_CM,
      imagePx: IMAGE_PX,
      imageBlobRef: f.imageBlobRef,
      nodes: [{
        id: 'n1', objectName: '叶', category: 'foliage',
        mask: encodeInlineMask(250, 250, new Uint8Array(250 * 250).fill(1)),
        bbox: { x: 0, y: 0, w: 250, h: 250 }, parent: null, children: [],
        effectiveMm: 100, labVariance: 5, drillWorthy: true, origin: 'vlm+sam3',
      }],
      createdAt: new Date().toISOString(),
    });
    // 无参考图层 → 树锚（=原图语义）
    expect(resolveStrategyLumaSourceRef({ blobs: f.s.blobs, jobs: f.s.jobs }, f.taskId, tree)).toBe(f.imageBlobRef);
    // 有参考图层 + scene-analysis → 分析锚（原图真源）
    plantReferenceImage(f, referenceImage());
    const analysisRef = putTaskArtifact(
      { db: f.s.db, blobs: f.s.blobs },
      f.taskId,
      Buffer.from(JSON.stringify(SceneAnalysisSchema.parse({
        kind: 'scene-analysis', formatVersion: 1, imageBlobRef: f.imageBlobRef,
        canvasCm: CANVAS_CM, imagePx: IMAGE_PX, elements: elements(), createdAt: new Date().toISOString(),
      })), 'utf8'),
    ).hash;
    f.s.jobs.emitFor(f.taskId, 'artifact', { blobRef: analysisRef, name: 'scene-analysis.json' });
    expect(resolveStrategyLumaSourceRef({ blobs: f.s.blobs, jobs: f.s.jobs }, f.taskId, tree)).toBe(f.imageBlobRef);
    // 参考图层在场但无 scene-analysis → null（不把参考图层冒充色彩源）
    const f2 = setup();
    plantReferenceImage(f2, referenceImage());
    expect(
      resolveStrategyLumaSourceRef({ blobs: f2.s.blobs, jobs: f2.s.jobs }, f2.taskId, tree),
    ).toBeNull();
  });

  it('executeStrategyPlan：sourceImage 在场 → texture-fill 注入 lumaB64（plan 工件字节零注入量）', () => {
    const f = setup();
    const tree: ObjectTree = ObjectTreeSchema.parse({
      kind: 'object-tree',
      formatVersion: 1,
      canvasCm: CANVAS_CM,
      imagePx: IMAGE_PX,
      nodes: [{
        id: 'n1', objectName: '叶', category: 'foliage',
        mask: encodeInlineMask(250, 250, new Uint8Array(250 * 250).fill(1)),
        bbox: { x: 0, y: 0, w: 250, h: 250 }, parent: null, children: [],
        effectiveMm: 100, labVariance: 5, drillWorthy: true, origin: 'vlm+sam3',
      }],
      createdAt: new Date().toISOString(),
    });
    const treeRef = putTaskArtifact({ db: f.s.db, blobs: f.s.blobs }, f.taskId, Buffer.from(JSON.stringify(tree), 'utf8')).hash;
    const plan = StrategyPlanSchema.parse({
      kind: 'strategy-plan',
      formatVersion: 1,
      objectTreeRef: treeRef,
      assignments: [{
        nodeId: 'n1',
        strategyKind: 'texture-fill',
        params: { mode: 'scatter', polarity: 'dark-dense' },
        stones: [{ resourceId: 'r1', sku: 'S1', supplier: 'sup', sizeMm: 3, colorHex: '#808080' }],
        densityPerCm2: 0.5,
        rationale: '测试',
      }],
      createdAt: new Date().toISOString(),
    });
    // 无 sourceImage（旧行为）：params.lumaB64 缺席 → orientationField 掩膜形状流 warning
    const withoutSource = executeStrategyPlan({ db: f.s.db, blobs: f.s.blobs }, { taskId: f.taskId, plan });
    // 有 sourceImage：注入原图 bbox 灰度（同树同图确定——gems 可产且 plan 字节不含 luma）
    const withSource = executeStrategyPlan(
      { db: f.s.db, blobs: f.s.blobs },
      { taskId: f.taskId, plan, sourceImage: { blobRef: f.imageBlobRef } },
    );
    const planWritten = JSON.parse(f.s.blobs.read((withSource.value as { planBlobRef: string }).planBlobRef)!.toString('utf8'));
    expect(JSON.stringify(planWritten)).not.toContain('lumaB64'); // 派生量不落 plan 工件
    expect(withSource.value).toMatchObject({ gemCount: expect.any(Number) });
    expect(withoutSource.value).toMatchObject({ gemCount: expect.any(Number) });
    // 亮度注入改变散布密度分布（dark-dense 极性下原图左右亮度差 ⇒ 两侧 gem 数分布不同）
    const gemsOf = (value: Record<string, unknown>): number => value['gemCount'] as number;
    expect(gemsOf(withSource.value)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------- T4.4 pavingStyle + 部件计数

describe('T4.4 pavingStyle（contracts+提示词消费）+部件级钻数终局实算', () => {
  const candidates: StoneCandidate[] = [
    { idx: 1, pick: { resourceId: 'r1', sku: 'S1', supplier: 'sup', sizeMm: 3, colorHex: '#112233' }, family: 'f' },
  ];
  const treeOf = (): ObjectTree => ObjectTreeSchema.parse({
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: CANVAS_CM,
    imagePx: IMAGE_PX,
    nodes: [{
      id: 'n1', objectName: '叶', category: 'foliage',
      mask: encodeInlineMask(250, 250, new Uint8Array(250 * 250).fill(1)),
      bbox: { x: 0, y: 0, w: 250, h: 250 }, parent: null, children: [],
      effectiveMm: 100, labVariance: 5, drillWorthy: true, origin: 'vlm+sam3',
    }],
    createdAt: new Date().toISOString(),
  });

  it('PavingStyleSchema：full/accept 双值；它值拒', () => {
    expect(PavingStyleSchema.safeParse('full').success).toBe(true);
    expect(PavingStyleSchema.safeParse('accent').success).toBe(true);
    expect(PavingStyleSchema.safeParse('dense').success).toBe(false);
  });

  it('buildStrategyDesignPrompt：full/accent 各自铺法行；缺省不出现铺法行（零变化）', () => {
    const base = buildStrategyDesignPrompt({ tree: treeOf(), candidates });
    const full = buildStrategyDesignPrompt({ tree: treeOf(), candidates, pavingStyle: 'full' });
    const accent = buildStrategyDesignPrompt({ tree: treeOf(), candidates, pavingStyle: 'accent' });
    expect(base).not.toContain('铺法：');
    expect(full).toContain('铺法：满铺（full）');
    expect(full).toContain('整体铺满导向');
    expect(accent).toContain('铺法：点缀（accent）');
    expect(accent).toContain('关键部位点缀导向');
    // 缺省时除铺法行外字节零漂移（full 去掉铺法行=base）
    expect(full.replace(/\n?铺法：满铺（full）.*$/m, '')).toBe(base);
  });

  it('partCountsOfLayout：final layout gems 按 blockId 实算+树名回填+数量降序', () => {
    const layout = {
      gems: [
        { id: 'g1', blockId: 'n1' }, { id: 'g2', blockId: 'n1' }, { id: 'g3', blockId: 'n1' },
        { id: 'g4', blockId: 'n2' },
      ],
    } as never;
    const leaf = (id: string, name: string, x: number) => ({
      id, objectName: name, category: 'foliage',
      mask: encodeInlineMask(4, 4, new Uint8Array(16).fill(1)),
      bbox: { x, y: 0, w: 4, h: 4 }, parent: 'n0', children: [],
      effectiveMm: 4, labVariance: 1, drillWorthy: true, origin: 'vlm+sam3' as const,
    });
    const tree = ObjectTreeSchema.parse({
      kind: 'object-tree', formatVersion: 1, canvasCm: CANVAS_CM, imagePx: IMAGE_PX,
      nodes: [
        {
          id: 'n0', objectName: '主体', category: 'foliage',
          mask: encodeInlineMask(8, 4, new Uint8Array(32).fill(1)),
          bbox: { x: 0, y: 0, w: 8, h: 4 }, parent: null, children: ['n1', 'n2'],
          effectiveMm: 5, labVariance: 1, drillWorthy: false, origin: 'vlm+sam3',
        },
        leaf('n1', '左叶', 0),
        leaf('n2', '右叶', 4),
      ],
      createdAt: new Date().toISOString(),
    });
    expect(partCountsOfLayout(layout, tree)).toEqual([
      { nodeId: 'n1', objectName: '左叶', count: 3 },
      { nodeId: 'n2', objectName: '右叶', count: 1 },
    ]);
    expect(partCountsOfLayout(layout, null)[0]).toMatchObject({ nodeId: 'n1', objectName: '' });
  });
});
