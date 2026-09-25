/**
 * 桥不可达降级=一键模式测试（add-subject-sam-pipeline tasks P2.5——对齐
 * add-backend-platform design §6.4 门哲学：桥/agent 面故障不殃及基础工作流）。
 * 覆盖：合成图（codec 画 3-4 色块）→树节点数=色域连通域数/每节点 mask 网格逐位
 * =kmeans 色标签（children 恰分割画布+节点内原色唯一）/确定性两跑树 hash 等/
 * fallback 触发（mock 桥 fail×2→降级成功+warning）/小连通域过滤/cm² 面积换算/
 * 下采样路径（>1024 边缩，mask 升回原网格）/typed error 全谱/产物树喂 P0.2
 * treeToBlocks（适配等价）。零常驻：纯函数+mock 传输（无定时器/无连接）。
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ObjectTreeSchema,
  decodeInlineMask,
  encodeInlineMask,
  type ObjectNode,
  type ObjectTree,
} from '@handicraft/contracts';
import {
  BRIDGE_FAILURE_THRESHOLD_DEFAULT,
  FALLBACK_ROOT_CATEGORY,
  FALLBACK_ROOT_ID,
  fallbackSegment,
  segmentWithFallback,
  type SegmentWithFallbackDeps,
  type SegmentWithFallbackInput,
} from '../src/kernel/vision/fallback-segment.js';
import { MockSamTransport, SamBridgeError } from '../src/kernel/vision/sam-bridge.js';
import { treeToBlocks } from '../src/kernel/vision/tree-to-blocks.js';
import { encodePng } from '../src/png/codec.js';

// ---------------------------------------------------------------- 合成图 fixture

type Rgb = [number, number, number];

interface BlockSpec {
  x: number;
  y: number;
  w: number;
  h: number;
  color: Rgb;
}

/** codec 画合成色块图（RGBA 平面→encodePng；纯色块无抗锯齿——kmeans 标签纯净）。 */
function pngOf(w: number, h: number, base: Rgb, blocks: BlockSpec[]): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = base[0];
    rgba[i * 4 + 1] = base[1];
    rgba[i * 4 + 2] = base[2];
    rgba[i * 4 + 3] = 255;
  }
  for (const b of blocks) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) {
        const p = (y * w + x) * 4;
        rgba[p] = b.color[0];
        rgba[p + 1] = b.color[1];
        rgba[p + 2] = b.color[2];
        rgba[p + 3] = 255;
      }
    }
  }
  return encodePng(w, h, rgba);
}

/** 固定时钟（createdAt 确定性）。 */
const FIXED_NOW = (): number => 1_750_000_000_000;

/** 步进假钟（warning 耗时断言用：每次调用 +100ms）。 */
function stepClock(): { now: () => number } {
  let t = 0;
  return { now: () => (t += 100) };
}

/** 必须成功的降级分割（fixture 自检面——失败即测试自身失效）。 */
function mustTree(bytes: Uint8Array, opts: Parameters<typeof fallbackSegment>[1]): ObjectTree {
  const res = fallbackSegment(bytes, { now: FIXED_NOW, ...opts });
  if (!res.ok) throw new Error(`fixture 分割失败：${JSON.stringify(res)}`);
  return res.tree;
}

/**
 * children 掩码归属图（W×H，每像素=覆盖它的子节点 id；恰一覆盖为分割完备性）。
 * root 不参与（画布全域；children 才是分块面）。
 */
function ownershipOf(tree: ObjectTree, w: number, h: number): (string | null)[] {
  const owner: (string | null)[] = new Array(w * h).fill(null);
  for (const node of tree.nodes) {
    if (node.id === FALLBACK_ROOT_ID) continue;
    const { w: mw, h: mh, bits } = inlineBitsOf(node);
    if (mw !== node.bbox.w || mh !== node.bbox.h) throw new Error(`mask≠bbox：${node.id}`);
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        if (bits[y * mw + x] !== 1) continue;
        const gx = node.bbox.x + x;
        const gy = node.bbox.y + y;
        owner[gy * w + gx] = node.id;
      }
    }
  }
  return owner;
}

/** 子节点集合（root 之外）。 */
function childrenOf(tree: ObjectTree): ObjectNode[] {
  return tree.nodes.filter((n) => n.id !== FALLBACK_ROOT_ID);
}

/** 节点 inline mask → bits（blob 态=fixture 违约，直接抛）。 */
function inlineBitsOf(node: ObjectNode): { w: number; h: number; bits: Uint8Array } {
  if (node.mask.kind !== 'inline') throw new Error(`fixture 节点 ${node.id} 应为 inline mask`);
  return decodeInlineMask(node.mask);
}

// ---------------------------------------------------------------- 色块分块

describe('fallbackSegment：合成色块图 → 颜色结构分块', () => {
  /** 100×100 / 10×10cm → ppm=1（px/mm）；四色四块（面积均 ≥0.5cm²=50px）。 */
  const W = 100;
  const H = 100;
  const canvasCm = { w: 10, h: 10 };
  const RED: Rgb = [200, 30, 30];
  const BLUE: Rgb = [30, 60, 200];
  const GREEN: Rgb = [30, 160, 60];
  const YELLOW: Rgb = [210, 200, 40];
  const fourColorPng = (): Uint8Array =>
    pngOf(W, H, RED, [
      { x: 50, y: 0, w: 50, h: 50, color: BLUE },
      { x: 0, y: 50, w: 50, h: 50, color: GREEN },
      { x: 50, y: 50, w: 50, h: 50, color: YELLOW },
    ]);

  it('四色四块 → 根+4 节点（树节点数=色域连通域数）；schema 有效；根=画布', () => {
    const tree = mustTree(fourColorPng(), { canvasCm });
    expect(tree.nodes).toHaveLength(5);
    expect(ObjectTreeSchema.parse(tree)).toEqual(tree); // 结构一致式自持
    const root = tree.nodes[0]!;
    expect(root).toMatchObject({
      id: FALLBACK_ROOT_ID,
      objectName: '画布',
      category: FALLBACK_ROOT_CATEGORY,
      parent: null,
      drillWorthy: false,
      origin: 'auto-color',
    });
    expect(root.bbox).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(root.children).toHaveLength(4);
    expect(tree.imagePx).toEqual({ width: W, height: H });
    expect(tree.canvasCm).toEqual(canvasCm);
  });

  it('子节点字段面：objectName=色<N>-<区域序>、category 缺省、origin=auto-color、mask inline、depth=1（经 treeToBlocks）', () => {
    const tree = mustTree(fourColorPng(), { canvasCm });
    const kids = childrenOf(tree);
    for (const n of kids) {
      expect(n.objectName).toMatch(/^色\d+-\d+$/);
      expect(n.category).toBe('color-region');
      expect(n.origin).toBe('auto-color');
      expect(n.parent).toBe(FALLBACK_ROOT_ID);
      expect(n.children).toEqual([]);
      expect(n.drillWorthy).toBe(true);
      expect(n.mask.kind).toBe('inline');
    }
    const blocks = treeToBlocks(tree, { readBlob: () => null }, { gemDiameterPx: 2 });
    expect(blocks.ok).toBe(true);
    if (!blocks.ok) return;
    expect(blocks.blocks.map((b) => b.origin.depth)).toEqual([1, 1, 1, 1]);
  });

  it('mask 网格逐位=kmeans 色标签：children 恰分割画布（逐像素恰一属）+节点内原色唯一', () => {
    const tree = mustTree(fourColorPng(), { canvasCm });
    const owner = ownershipOf(tree, W, H);
    for (let i = 0; i < W * H; i++) {
      expect(owner[i], `像素 ${i} 未被恰一子节点覆盖`).not.toBeNull();
    }
    // 节点内原色唯一（合成平色 → kmeans 标签纯净；按 fixture 结构重算期望色）
    const expected: Rgb[][] = [];
    for (let y = 0; y < H; y++) {
      const row: Rgb[] = [];
      for (let x = 0; x < W; x++) {
        row.push(y < 50 ? (x < 50 ? RED : BLUE) : x < 50 ? GREEN : YELLOW);
      }
      expected.push(row);
    }
    for (const n of childrenOf(tree)) {
      const { w: mw, h: mh, bits } = inlineBitsOf(n);
      const seen = new Set<number>();
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          if (bits[y * mw + x] !== 1) continue;
          const [r, g, b] = expected[n.bbox.y + y]![n.bbox.x + x]!;
          seen.add((r << 16) | (g << 8) | b);
        }
      }
      expect(seen.size, `节点 ${n.id} 内原色应唯一`).toBe(1);
    }
  });

  it('同色两断开区域 → 两个节点（4-连通拆分，区域序 1/2；bbox 各就各位）', () => {
    const png = pngOf(
      W,
      H,
      [240, 240, 240],
      [
        { x: 10, y: 10, w: 20, h: 20, color: RED },
        { x: 60, y: 60, w: 20, h: 20, color: RED },
      ],
    );
    const tree = mustTree(png, { canvasCm, k: 2 });
    const kids = childrenOf(tree);
    expect(kids).toHaveLength(3); // 白底（大连通域）+ 红块×2
    const reds = kids.filter((n) => n.bbox.w === 20 && n.bbox.h === 20);
    expect(reds).toHaveLength(2);
    const names = reds.map((n) => n.objectName);
    const m = names.map((s) => /^色(\d+)-(\d+)$/.exec(s)!);
    expect(m[0]![1]).toBe(m[1]![1]); // 同色号
    expect(new Set(m.map((g) => g[2]))).toEqual(new Set(['1', '2'])); // 区域序 1/2
    expect(reds.map((n) => n.bbox)).toEqual([
      { x: 10, y: 10, w: 20, h: 20 },
      { x: 60, y: 60, w: 20, h: 20 },
    ]);
  });

  it('k 缺省 8（空簇消亡）与显式 k=4 同分块结果（mask/bbox 集合等价）', () => {
    const png = fourColorPng();
    const a = mustTree(png, { canvasCm });
    const b = mustTree(png, { canvasCm, k: 4 });
    const project = (t: ObjectTree) =>
      childrenOf(t)
        .map((n) => ({ bbox: n.bbox, bits: Array.from(inlineBitsOf(n).bits) }))
        .sort((x, y) => JSON.stringify(x.bbox).localeCompare(JSON.stringify(y.bbox)));
    expect(project(a)).toEqual(project(b));
  });

  it('确定性：固定时钟两跑树 JSON sha256 相等（零随机源——farthest-first+固定 12 次 Lloyd）', () => {
    const png = fourColorPng();
    const a = mustTree(png, { canvasCm });
    const b = mustTree(png, { canvasCm });
    const hash = (t: ObjectTree): string =>
      createHash('sha256').update(JSON.stringify(t)).digest('hex');
    expect(hash(a)).toBe(hash(b));
  });
});

// ---------------------------------------------------------------- 面积门与换算

describe('fallbackSegment：小连通域过滤与 cm² 换算', () => {
  const W = 100;
  const H = 100;
  const canvasCm = { w: 10, h: 10 }; // ppm=1：1px=1mm²；0.5cm²=50px

  it('6×6=36px=0.36cm² <0.5 弃；20×20=400px=4cm² 留（白底同留）', () => {
    const png = pngOf(
      W,
      H,
      [240, 240, 240],
      [
        { x: 5, y: 5, w: 6, h: 6, color: [200, 30, 30] },
        { x: 60, y: 60, w: 20, h: 20, color: [30, 60, 200] },
      ],
    );
    const tree = mustTree(png, { canvasCm, k: 3 });
    const kids = childrenOf(tree);
    expect(kids).toHaveLength(2); // 白底+20×20；6×6 被弃
    expect(kids.map((n) => n.bbox)).toEqual(
      expect.arrayContaining([{ x: 60, y: 60, w: 20, h: 20 }]),
    );
    expect(kids.some((n) => n.bbox.x === 5 && n.bbox.y === 5)).toBe(false);
  });

  it('effectiveMm=√面积/ppm（ppm=1：20×20→20mm；根=√(100×100)/1=100mm）；平色块 labVariance=0', () => {
    const png = pngOf(W, H, [240, 240, 240], [
      { x: 10, y: 10, w: 20, h: 20, color: [200, 30, 30] },
    ]);
    const tree = mustTree(png, { canvasCm, k: 2 });
    const root = tree.nodes[0]!;
    expect(root.effectiveMm).toBe(100);
    const block = childrenOf(tree).find((n) => n.bbox.w === 20)!;
    expect(block.effectiveMm).toBe(20);
    expect(block.labVariance).toBe(0);
  });

  it('全区域小于阈值 → no-surviving-regions（typed error，阈值随行）', () => {
    const png = pngOf(W, H, [240, 240, 240], [{ x: 10, y: 10, w: 10, h: 10, color: [200, 30, 30] }]);
    const res = fallbackSegment(png, {
      canvasCm,
      minRegionCm2: 5000, // 5000cm²=5e5mm² → 全画布 1e4px 也不够
      now: FIXED_NOW,
    });
    expect(res).toMatchObject({ ok: false, reason: 'no-surviving-regions', k: 8 });
    if (res.ok || res.reason !== 'no-surviving-regions') return;
    expect(res.minAreaPx).toBeGreaterThan(W * H);
  });
});

// ---------------------------------------------------------------- 下采样路径

describe('fallbackSegment：>1024px 边缩（mask/bbox 升回原网格）', () => {
  const W = 2048;
  const H = 1024;
  const canvasCm = { w: 20, h: 10 }; // ppm=10.24；工作网格 1024×512 → workPpm=5.12

  const quadrantPng = (): Uint8Array =>
    pngOf(W, H, [200, 30, 30], [
      { x: 1024, y: 0, w: 1024, h: 512, color: [30, 60, 200] },
      { x: 0, y: 512, w: 1024, h: 512, color: [30, 160, 60] },
      { x: 1024, y: 512, w: 1024, h: 512, color: [210, 200, 40] },
    ]);

  it('四象限 → 根+4；children 恰分割原网格（2M 像素逐像素恰一属）', () => {
    const tree = mustTree(quadrantPng(), { canvasCm, k: 4 });
    expect(tree.nodes).toHaveLength(5);
    expect(tree.imagePx).toEqual({ width: W, height: H }); // 树锚原图（预览/持久化不变式）
    const owner = ownershipOf(tree, W, H);
    expect(owner.every((o) => o !== null)).toBe(true);
  });

  it('bbox=象限原坐标；effectiveMm 按 workPpm 换算（√131072/5.12≈70.71mm）', () => {
    const tree = mustTree(quadrantPng(), { canvasCm, k: 4 });
    const bboxes = childrenOf(tree)
      .map((n) => n.bbox)
      .sort((a, b) => a.x - b.x || a.y - b.y);
    expect(bboxes).toEqual([
      { x: 0, y: 0, w: 1024, h: 512 },
      { x: 0, y: 512, w: 1024, h: 512 },
      { x: 1024, y: 0, w: 1024, h: 512 },
      { x: 1024, y: 512, w: 1024, h: 512 },
    ]);
    for (const n of childrenOf(tree)) {
      expect(n.effectiveMm).toBe(70.71); // 工作网格口径：512×256px / 5.12px/mm
    }
  });
});

// ---------------------------------------------------------------- typed error 全谱

describe('fallbackSegment：typed error（不抛不猜）', () => {
  const canvasCm = { w: 10, h: 10 };

  it('纵横比>2% → aspect-mismatch（数值随行）', () => {
    const png = pngOf(100, 100, [0, 0, 0], []);
    const res = fallbackSegment(png, { canvasCm: { w: 10, h: 5 }, now: FIXED_NOW });
    expect(res).toEqual({ ok: false, reason: 'aspect-mismatch', aspectCm: 2, aspectPx: 1 });
  });

  it('非 PNG 字节 → decode-failed', () => {
    const res = fallbackSegment(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { canvasCm, now: FIXED_NOW });
    expect(res).toMatchObject({ ok: false, reason: 'decode-failed' });
  });

  it('k 非正整数 → RangeError（编程错误面）', () => {
    const png = pngOf(10, 10, [0, 0, 0], []);
    expect(() => fallbackSegment(png, { canvasCm, k: 0, now: FIXED_NOW })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- P0.2 适配等价

describe('产物树喂 treeToBlocks（P0.2 适配等价）', () => {
  it('四色树 → ok；块=4 叶区域（根 drillWorthy=false 不产）；blockId=nodeId；ppm=1', () => {
    const W = 100;
    const H = 100;
    const canvasCm = { w: 10, h: 10 };
    const png = pngOf(W, H, [200, 30, 30], [
      { x: 50, y: 0, w: 50, h: 50, color: [30, 60, 200] },
      { x: 0, y: 50, w: 50, h: 50, color: [30, 160, 60] },
      { x: 50, y: 50, w: 50, h: 50, color: [210, 200, 40] },
    ]);
    const tree = mustTree(png, { canvasCm });
    const res = treeToBlocks(tree, { readBlob: () => null }, { gemDiameterPx: 2 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pixelsPerMm).toBe(1);
    expect(res.blocks).toHaveLength(4);
    expect(res.blocks.map((b) => b.id).sort()).toEqual(childrenOf(tree).map((n) => n.id).sort());
    expect(res.blocks.every((b) => b.origin.nodeOrigin === 'auto-color')).toBe(true);
    expect(res.blocks.every((b) => b.areaPx > 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- 降级触发面

describe('segmentWithFallback：桥先行与降级触发', () => {
  const W = 40;
  const H = 40;
  const imagePx = { width: W, height: H };
  const canvasCm = { w: 4, h: 4 }; // ppm=1
  const png = pngOf(W, H, [30, 60, 200], [{ x: 10, y: 10, w: 20, h: 20, color: [200, 30, 30] }]);
  const noBlob = (): null => null;

  function makeInput(overrides: Partial<SegmentWithFallbackInput> = {}): SegmentWithFallbackInput {
    return {
      taskId: 'task-fb-1',
      imageBlobRef: 'b'.repeat(64),
      imageBytes: png,
      imagePx,
      canvasCm,
      ...overrides,
    };
  }

  function makeDeps(transport: MockSamTransport, now?: () => number): SegmentWithFallbackDeps {
    return { transport, readBlob: noBlob, ...(now !== undefined ? { now } : {}) };
  }

  /** 桥成功响应：20×20 主体块 @(10,10) inline mask（40×40 画布）。 */
  function segResponse(maskW = W, maskH = H, block = { x: 10, y: 10, w: 20, h: 20 }) {
    const bits = new Uint8Array(maskW * maskH);
    for (let y = block.y; y < block.y + block.h && y < maskH; y++) {
      for (let x = block.x; x < block.x + block.w && x < maskW; x++) {
        bits[y * maskW + x] = 1;
      }
    }
    return {
      kind: 'segment' as const,
      mask: encodeInlineMask(maskW, maskH, bits),
      score: 0.91,
      meta: { model: 'sam3-mlx@mock', durationMs: 46_000, iteration: 0 },
    };
  }

  it('桥成功：单发 segment 请求（宽泛提示 subject/iteration 0）→ 根+主体树（origin vlm+sam3），无 warning', async () => {
    const transport = new MockSamTransport();
    transport.respond(() => segResponse());
    const res = await segmentWithFallback(makeDeps(transport), makeInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fallback).toBe(false);
    expect(res.warning).toBeUndefined();
    expect(transport.requests).toHaveLength(1);
    expect(transport.requests[0]).toMatchObject({
      kind: 'segment',
      taskId: 'task-fb-1',
      prompt: { kind: 'text', text: 'subject' },
      iteration: 0,
      imagePx,
      canvasCm,
    });
    expect(res.tree.nodes).toHaveLength(2);
    const subject = res.tree.nodes.find((n) => n.id === 'sam-0')!;
    expect(subject).toMatchObject({
      objectName: '主体',
      category: 'subject',
      parent: FALLBACK_ROOT_ID,
      origin: 'vlm+sam3',
      drillWorthy: true,
      bbox: { x: 10, y: 10, w: 20, h: 20 },
      effectiveMm: 20, // √400 / ppm 1
    });
    expect(res.tree.nodes[0]!.children).toEqual(['sam-0']);
  });

  it('fail×2 → 降级成功+warning{reason bridge-unavailable, failures 2, 耗时, 桥错误摘要}；树 origin=auto-color', async () => {
    const transport = new MockSamTransport();
    transport
      .respond(() => Promise.reject(new Error('connection refused')))
      .respond(() => Promise.reject(new Error('ssh: connect timeout')));
    const clock = stepClock();
    const res = await segmentWithFallback(makeDeps(transport, clock.now), makeInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fallback).toBe(true);
    expect(res.warning).toMatchObject({
      reason: 'bridge-unavailable',
      failures: BRIDGE_FAILURE_THRESHOLD_DEFAULT,
      fallbackDurationMs: 200, // 步进钟：t0=100、createdAt 消一拍=200、完成=300 → 300-100
    });
    expect(res.warning!.bridgeError).toContain('ssh: connect timeout'); // 摘要=最后一次失败
    expect(transport.requests).toHaveLength(2);
    expect(res.tree.nodes.every((n) => n.origin === 'auto-color')).toBe(true);
    expect(res.tree.nodes.length).toBeGreaterThanOrEqual(2); // 根+至少一色域
  });

  it('fail×1 后成功 → 不降级（阈值 2 未达；两次尝试）', async () => {
    const transport = new MockSamTransport();
    transport
      .respond(() => Promise.reject(new Error('flaky')))
      .respond(() => segResponse());
    const res = await segmentWithFallback(makeDeps(transport), makeInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fallback).toBe(false);
    expect(transport.requests).toHaveLength(2);
  });

  it('取消传播：signal 已中止 → cancelled（零桥调用）；桥侧 cancelled 错误 → cancelled（不降级）', async () => {
    const pre = new MockSamTransport();
    const resPre = await segmentWithFallback(
      makeDeps(pre),
      makeInput({ signal: AbortSignal.abort() }),
    );
    expect(resPre).toEqual({ ok: false, reason: 'cancelled' });
    expect(pre.requests).toHaveLength(0);

    const mid = new MockSamTransport();
    mid.respond(() => Promise.reject(new SamBridgeError('已取消', 'cancelled')));
    const resMid = await segmentWithFallback(makeDeps(mid), makeInput());
    expect(resMid).toEqual({ ok: false, reason: 'cancelled' });
    expect(mid.requests).toHaveLength(1); // 取消即止——不再尝试、不降级
  });

  it('坏响应计入失败：kind 不匹配+mask 尺寸错 → 两败降级（§6.4：桥故障不阻断基础流）', async () => {
    const transport = new MockSamTransport();
    transport
      .respond(() => ({
        kind: 'analyze' as const,
        elements: [],
        meta: { model: 'sam3-mlx@mock', durationMs: 1, iteration: 0 },
      }))
      .respond(() => segResponse(4, 4, { x: 0, y: 0, w: 4, h: 4 })); // mask≠imagePx
    const res = await segmentWithFallback(makeDeps(transport), makeInput());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.fallback).toBe(true);
    expect(res.warning!.failures).toBe(2);
    expect(transport.requests).toHaveLength(2);
  });

  it('降级失败透传：fail×2 且全区域小于阈值 → no-surviving-regions', async () => {
    const transport = new MockSamTransport();
    transport
      .respond(() => Promise.reject(new Error('down')))
      .respond(() => Promise.reject(new Error('down')));
    const res = await segmentWithFallback(
      makeDeps(transport),
      makeInput({ minRegionCm2: 5000 }),
    );
    expect(res).toMatchObject({ ok: false, reason: 'no-surviving-regions' });
  });

  it('声明尺寸与解码不符 → image-dims-mismatch（锚点错位显式拒）', async () => {
    const transport = new MockSamTransport();
    const res = await segmentWithFallback(
      makeDeps(transport),
      makeInput({ imagePx: { width: 41, height: 40 } }),
    );
    expect(res).toEqual({
      ok: false,
      reason: 'image-dims-mismatch',
      declared: { width: 41, height: 40 },
      decoded: { width: 40, height: 40 },
    });
    expect(transport.requests).toHaveLength(0);
  });
});
