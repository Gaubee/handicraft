/**
 * 迭代抠图循环单测（add-subject-sam-pipeline P2.4——循环状态机，全 mock 桥，零 IO）。
 * deps.segment/analyze/measureLabVariance/now 全注入脚本——纯状态机可测可回放。
 * 覆盖：三轮收敛（首轮 2 元素→次轮 1 裂子→三轮全停）/硬顶截断（迭代数+节点数，
 * 零请求前置封停）/停止判据各条触发（尺寸/色差/模型自认 no-new-instance+low-score）/
 * mask 交集防外溢（子越界列被位与裁掉）/vlmReentry=false 不调 analyze+true 接口位
 * 接线/单主体树根=主体/多主体根=画布结构性容器/首轮 box 几何提示+hint 文本降级/
 * 确定性（同脚本同请求序同产物）/手动 step 逐轮驱动/提示模板/硬顶公式/树可直喂
 * P0.2 tree-to-blocks。
 *
 * P2.4-hardening（vision 真连审查回流 2026-09-25）五项：
 * [1] 兄弟掩膜互斥（36% 重叠消解/drillWorthy 优先/完全吞没出树）；
 * [2] frontier 强制细分（非钻层大块不得 sealed，硬顶截断 warning 留痕）；
 * [3] 掩膜碎片清理（连通域面积过滤 max(200px, 0.05%×画幅)；90 碎片场景）；
 * [4] hint→category 固定映射（常见 hint→规范值+未知透传，消除 face/subject 随机性）；
 * [5] score 非空门禁（检出节点 score 缺失/null→warning；零检出照旧 no-instance）。
 *
 * fixture 标定：800×800px ↔ 8×8cm ⇒ pixelsPerMm=10（mm 断言=px/10——2026-09-25
 * hardening 起 fixture 由 80×80/PPM1 放大 ×10：碎片阈值 max(200, 0.05%×画幅)=320px
 * 在 80×80（=6400px 画幅）上会吞掉所有小目标，放大后与实拍 736×736（阈值 271px）
 * 同量级，既保 mm 断言数值不变又让碎片清理有真实语义）。零常驻进程：全同步 mock。
 */
import { describe, expect, it } from 'vitest';
import type { NodeBBox, ObjectNode, SceneElement } from '@handicraft/contracts';
import { decodeInlineMask } from '@handicraft/contracts';
import {
  HINT_CATEGORY_MAP,
  MASK_FRAGMENT_CANVAS_RATIO,
  SEGMENT_LOOP_FRONTIER_FORCE_FACTOR,
  SEGMENT_LOOP_LOW_SCORE,
  SEGMENT_LOOP_MAX_NODES_DEFAULT,
  SegmentLoopError,
  broadSemanticPrompt,
  categoryForHint,
  initSegmentLoop,
  isTerminalSegmentLoop,
  maskFragmentThresholdPx,
  maxIterationsForCanvas,
  redescribePrompt,
  runSegmentLoop,
  stepSegmentLoop,
  type AnalyzeBridgeOutcome,
  type SegmentBridgeOutcome,
  type SegmentLoopDeps,
} from '../src/kernel/vision/segment-loop.js';
import type { SamAnalyzeRequest, SamSegmentRequest } from '../src/kernel/vision/sam-bridge.js';
import { treeToBlocks } from '../src/kernel/vision/tree-to-blocks.js';

// ---------------------------------------------------------------- fixture

/** 800×800px ↔ 8×8cm ⇒ pixelsPerMm=10（px 值=mm×10——文件头标定注）。 */
const IMG = 800;
const GEOM = {
  taskId: 'task-seg',
  imageBlobRef: 'a'.repeat(64),
  imagePx: { width: IMG, height: IMG },
  canvasCm: { w: 8, h: 8 },
} as const;

/** 判据 1 阈值=K2.5×2mm=5mm=50px（ppm=10）；measure 高方差（22>10——色判据不触发）。 */
const BASE = { ...GEOM, maxGemDiameterMm: 2 } as const;
/** 强制细分阈值=3×2mm=6mm=60px（P2.4-hardening [2]——(5mm, 6mm] 为缓冲带）。 */
const FORCE_MM = 3 * 2;
const measureVaried = () => 22;
const FIXED_NOW = () => '2026-09-25T00:00:00.000Z';

function element(name: string, hint: string, box: NodeBBox, extra: Partial<SceneElement> = {}): SceneElement {
  return { name, boxPx: box, hint, suggestDrillWorthy: true, ...extra };
}

/** 全图 bits：box 内全 1（其余 0）。 */
function rect(W: number, H: number, box: NodeBBox): Uint8Array {
  const bits = new Uint8Array(W * H);
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) bits[y * W + x] = 1;
  }
  return bits;
}

/**
 * 脚本化矩形检出（缺省 score=0.9=良置信桥——[5] 门禁不触发；显式传参覆盖；
 * box=null 零检出不附 score）。
 */
function segOutcome(box: NodeBBox | null, score?: number): SegmentBridgeOutcome {
  if (box === null) {
    return { mask: { w: IMG, h: IMG, bits: new Uint8Array(IMG * IMG) }, ...(score !== undefined ? { score } : {}) };
  }
  return { mask: { w: IMG, h: IMG, bits: rect(IMG, IMG, box) }, score: score ?? 0.9 };
}

/** 多矩形检出（碎片清理场景：主块+碎斑自由拼装；不传 score=[5] 缺失面）。 */
function multiRectOutcome(rects: readonly NodeBBox[], score?: number): SegmentBridgeOutcome {
  const bits = new Uint8Array(IMG * IMG);
  for (const b of rects) {
    for (let y = b.y; y < b.y + b.h; y++) {
      for (let x = b.x; x < b.x + b.w; x++) bits[y * IMG + x] = 1;
    }
  }
  return { mask: { w: IMG, h: IMG, bits }, ...(score !== undefined ? { score } : {}) };
}

/** 节点 inline mask 解码 bits（循环产物恒 inline——非 inline 直接炸测试）。 */
function maskBitsOf(node: ObjectNode): Uint8Array {
  if (node.mask.kind !== 'inline') throw new Error(`测试辅助仅支持 inline mask（${node.id} 实为 ${node.mask.kind}）`);
  return decodeInlineMask(node.mask).bits;
}

/** 节点 maskPx（置位数）。 */
function maskPxOf(node: ObjectNode): number {
  let n = 0;
  for (const b of maskBitsOf(node)) n += b;
  return n;
}

/** 节点 mask 展开回全图 bits（兄弟互斥断言面）。 */
function canvasBitsOf(node: ObjectNode): Uint8Array {
  const bits = maskBitsOf(node);
  const w = node.bbox.w;
  const canvas = new Uint8Array(IMG * IMG);
  for (let y = 0; y < node.bbox.h; y++) {
    for (let x = 0; x < w; x++) {
      if (bits[y * w + x] === 1) canvas[(node.bbox.y + y) * IMG + node.bbox.x + x] = 1;
    }
  }
  return canvas;
}

/** 两节点全图掩膜交叠 px（互斥断言：期望 0）。 */
function overlapPxOf(a: ObjectNode, b: ObjectNode): number {
  const ca = canvasBitsOf(a);
  const cb = canvasBitsOf(b);
  let n = 0;
  for (let i = 0; i < ca.length; i++) {
    if (ca[i] === 1 && cb[i] === 1) n++;
  }
  return n;
}

/** 脚本化 segment mock（逐请求弹出——与 MockSamTransport 同语义，作用在 deps 窄面）。 */
class ScriptedSegment {
  readonly requests: SamSegmentRequest[] = [];
  private readonly script: Array<(req: SamSegmentRequest) => SegmentBridgeOutcome>;

  constructor(script: Array<(req: SamSegmentRequest) => SegmentBridgeOutcome>) {
    this.script = [...script];
  }

  readonly call = async (req: SamSegmentRequest): Promise<SegmentBridgeOutcome> => {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new Error(`segment 脚本耗尽（第 ${this.requests.length} 请求）`);
    return next(req);
  };
}

/** 脚本化 analyze mock（vlmReentry 接口位测试）。 */
class ScriptedAnalyze {
  readonly requests: SamAnalyzeRequest[] = [];
  private readonly script: Array<(req: SamAnalyzeRequest) => AnalyzeBridgeOutcome>;

  constructor(script: Array<(req: SamAnalyzeRequest) => AnalyzeBridgeOutcome>) {
    this.script = [...script];
  }

  readonly call = async (req: SamAnalyzeRequest): Promise<AnalyzeBridgeOutcome> => {
    this.requests.push(req);
    const next = this.script.shift();
    if (next === undefined) throw new Error(`analyze 脚本耗尽（第 ${this.requests.length} 请求）`);
    return next(req);
  };
}

function depsOf(
  segment: ScriptedSegment,
  extra: { analyze?: SegmentLoopDeps['analyze']; measure?: SegmentLoopDeps['measureLabVariance'] } = {},
): SegmentLoopDeps {
  return {
    segment: segment.call,
    ...(extra.analyze !== undefined ? { analyze: extra.analyze } : {}),
    measureLabVariance: extra.measure ?? measureVaried,
    now: FIXED_NOW,
  };
}

/** 三轮收敛脚本：A 路灯+B 草地（首轮各 300×300）→次轮 A 裂 50×50 子+B 空掩码→三轮 A 空掩码。 */
function convergenceFixture() {
  const elements = [
    element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 }),
    element('草地', 'grassland', { x: 400, y: 400, w: 300, h: 300 }),
  ];
  const script = new ScriptedSegment([
    () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
    () => segOutcome({ x: 400, y: 400, w: 300, h: 300 }),
    () => segOutcome({ x: 0, y: 0, w: 50, h: 50 }), // A 次轮子（5mm=阈值上——判据 1 封停）
    () => segOutcome(null), // B 次轮零交集→no-new-instance
    () => segOutcome(null), // A 三轮零交集→no-new-instance
  ]);
  return { elements, script };
}

// ---------------------------------------------------------------- 三轮收敛（主路径）

describe('三轮收敛（首轮 2 元素→次轮 1 裂子→三轮全停）', () => {
  it('树结构：画布根+2 元素+A 的 1 子；封停原因 size/model 各就位；请求序几何×2→语义×3', async () => {
    const { elements, script } = convergenceFixture();
    const result = await runSegmentLoop({ ...BASE, elements }, depsOf(script));

    expect(script.requests).toHaveLength(5);
    // 首轮=元素（P2.3 产物注入）：几何提示=box 中心 include 点+box
    expect(script.requests[0]!.prompt).toEqual({
      kind: 'geometric',
      points: [{ x: 150, y: 150, label: 'include' }],
      box: { x: 0, y: 0, w: 300, h: 300 },
    });
    expect(script.requests[1]!.prompt).toEqual({
      kind: 'geometric',
      points: [{ x: 550, y: 550, label: 'include' }],
      box: { x: 400, y: 400, w: 300, h: 300 },
    });
    // 后续轮=宽泛语义（英文 hint 优先——spike 实证）
    expect(script.requests[2]!.prompt).toEqual({
      kind: 'text',
      text: 'streetlight as a whole, including all its component parts',
    });
    expect(script.requests[3]!.prompt).toEqual({
      kind: 'text',
      text: 'grassland as a whole, including all its component parts',
    });
    expect(script.requests.map((r) => r.iteration)).toEqual([0, 0, 1, 1, 2]);

    // 树：画布结构性根+路灯(+部分1)+草地
    const names = result.tree.nodes.map((n) => n.objectName);
    expect(names).toEqual(['画布', '路灯', '路灯·部分1', '草地']);
    const byName = new Map(result.tree.nodes.map((n) => [n.objectName, n]));
    const canvas = byName.get('画布')!;
    const lamp = byName.get('路灯')!;
    const part = byName.get('路灯·部分1')!;
    const grass = byName.get('草地')!;
    expect(canvas.parent).toBe(null);
    expect(canvas.children).toEqual([lamp.id, grass.id]);
    expect(canvas.drillWorthy).toBe(false); // 结构性容器不产块（tree-to-blocks 语义）
    expect(canvas.category).toBe('canvas');
    expect(lamp.parent).toBe(canvas.id);
    expect(lamp.children).toEqual([part.id]);
    expect(part.parent).toBe(lamp.id);
    expect(part.objectName).toBe('路灯·部分1');
    expect(grass.parent).toBe(canvas.id);
    expect(grass.children).toEqual([]);

    // 节点字段：bbox=掩码紧外接；effectiveMm=box 换算（ppm=10）；depth 语义（首轮=1）
    expect(lamp.bbox).toEqual({ x: 0, y: 0, w: 300, h: 300 });
    expect(part.bbox).toEqual({ x: 0, y: 0, w: 50, h: 50 });
    expect(lamp.effectiveMm).toBe(30);
    expect(part.effectiveMm).toBe(5);
    expect(lamp.mask).toMatchObject({ kind: 'inline', w: 300, h: 300 });
    expect(part.drillWorthy).toBe(true); // 排除开关继承
    expect(lamp.origin).toBe('vlm+sam3');

    // 封停面：部分1=判据 1（size，出生即封）；草地/路灯=判据 3（model）；画布根不在封停面
    expect(result.sealedByNode[part.id]).toEqual(['size']);
    expect(result.sealedByNode[grass.id]).toEqual(['model']);
    expect(result.sealedByNode[lamp.id]).toEqual(['model']);
    expect(result.sealedByNode[canvas.id]).toBeUndefined();
    expect(result.iterations).toBe(3); // 轮 0/1/2
    expect(result.totalNodes).toBe(4);
    expect(result.tree.createdAt).toBe(FIXED_NOW());
    expect(result.warnings).toEqual([]); // 无重叠/无强制/有 score——加固面零警告
  });

  it('演化 meta：onStep 每轮一调（观察面），entries/sealed/树形摘要逐轮可审', async () => {
    const { elements, script } = convergenceFixture();
    const steps: number[] = [];
    const result = await runSegmentLoop(
      { ...BASE, elements, onStep: (meta) => steps.push(meta.iter) },
      depsOf(script),
    );
    expect(steps).toEqual([0, 1, 2]);
    expect(result.history).toHaveLength(3);
    // 轮 0：两元素建节点
    expect(result.history[0]!.entries.map((e) => e.outcome)).toEqual(['node-created', 'node-created']);
    // 轮 1：路灯裂子+草地零实例
    expect(result.history[1]!.entries.map((e) => [e.outcome, e.modelSignal])).toEqual([
      ['child-created', 'new-instances'],
      ['no-new-instance', 'no-new-instance'],
    ]);
    // 轮 2：路灯零实例收尾
    expect(result.history[2]!.entries.map((e) => e.outcome)).toEqual(['no-new-instance']);
    expect(result.history[2]!.frontierAfter).toBe(0);
    expect(result.history[1]!.nodesAfter).toBe(3); // 路灯/草地/部分1（画布根=finalize 增量）
    expect(result.history.every((m) => m.warnings)).toBe(true); // [hardening] 每步带警告面（空列在位）
  });

  it('状态机可回放：手动 step 逐轮驱动——frontier 演化/终态判定与 runSegmentLoop 一致', async () => {
    const { elements, script } = convergenceFixture();
    const deps = depsOf(script);
    const { state, ctx } = initSegmentLoop({ ...BASE, elements }, deps);
    expect(isTerminalSegmentLoop(state)).toBe(false); // 空树=元素轮待跑

    const s1 = await stepSegmentLoop(state, ctx);
    expect(s1.iter).toBe(1);
    expect(s1.frontier).toEqual(['sam-node-0001', 'sam-node-0002']); // 路灯/草地均未停
    expect(isTerminalSegmentLoop(s1)).toBe(false);

    const s2 = await stepSegmentLoop(s1, ctx);
    expect(s2.iter).toBe(2);
    expect(s2.nodes.map((n) => n.objectName)).toEqual(['路灯', '草地', '路灯·部分1']);
    expect(s2.frontier).toEqual(['sam-node-0001']); // 子出生即封（size）；草地 model 封
    expect(Object.keys(s2.sealed)).toEqual(['sam-node-0003', 'sam-node-0002']); // 封停序=处理序

    const s3 = await stepSegmentLoop(s2, ctx);
    expect(s3.frontier).toEqual([]);
    expect(isTerminalSegmentLoop(s3)).toBe(true);
    expect(await stepSegmentLoop(s3, ctx)).toEqual(s3); // 终态幂等

    // 回放=同脚本重跑（fresh fixture）与手动驱动殊途同归
    const replay = convergenceFixture();
    const replayed = await runSegmentLoop({ ...BASE, elements: replay.elements }, depsOf(replay.script));
    expect(replayed.tree.nodes.map((n) => n.objectName)).toEqual(['画布', '路灯', '路灯·部分1', '草地']);
  });
});

// ---------------------------------------------------------------- 根裁定

describe('根裁定（design §1 S5：多主体=画布根/单主体=该主体）', () => {
  it('单主体：根=该元素自身（无画布节点），后续子挂其下', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 100, y: 100, w: 400, h: 400 }),
      () => segOutcome({ x: 100, y: 100, w: 80, h: 80 }), // 子（8mm>5 不停）
      () => segOutcome(null), // 子轮零实例→子封；父仍活
      () => segOutcome(null), // 父零实例→全停
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('人物', 'person', { x: 100, y: 100, w: 400, h: 400 })] },
      depsOf(script),
    );
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['人物', '人物·部分1']);
    const root = result.tree.nodes[0]!;
    expect(root.parent).toBe(null);
    expect(root.children).toEqual([result.tree.nodes[1]!.id]);
    // 单主体深度偏移=0：主体自身细分问「组成部分」（虚拟画布层不占深度——多主体才占）
    expect(script.requests[1]!.prompt).toEqual({
      kind: 'text',
      text: 'person as a whole, including all its component parts',
    });
  });

  it('多主体：画布根=全画布 mask、effectiveMm=整幅换算、labVariance=整幅测量', async () => {
    const { elements, script } = convergenceFixture();
    const measured: string[] = [];
    const result = await runSegmentLoop(
      { ...BASE, elements },
      depsOf(script, {
        measure: (region) => {
          measured.push(`${region.bbox.w}x${region.bbox.h}`);
          return 22;
        },
      }),
    );
    const canvas = result.tree.nodes[0]!;
    expect(canvas.objectName).toBe('画布');
    expect(canvas.bbox).toEqual({ x: 0, y: 0, w: IMG, h: IMG });
    expect(canvas.effectiveMm).toBe(80); // √(800·800)/10
    expect(measured).toContain('800x800'); // 整幅测量入列（元素×2+子×1+画布=4 次）
    expect(measured).toHaveLength(4); // 无兄弟重叠→无消解重测
  });
});

// ---------------------------------------------------------------- 停止判据各条

describe('停止判据内嵌（P0.3 evaluateStopCriteria 逐条触发）', () => {
  it('判据 1 尺寸：元素 40×40px（4mm≤阈值 5mm）出生即封停，一轮即终态', async () => {
    const script = new ScriptedSegment([() => segOutcome({ x: 0, y: 0, w: 40, h: 40 })]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('小花', 'small flower', { x: 0, y: 0, w: 60, h: 60 })] },
      depsOf(script),
    );
    expect(result.iterations).toBe(1);
    expect(script.requests).toHaveLength(1); // 出生即封→无细分请求
    expect(result.sealedByNode['sam-node-0001']).toEqual(['size']);
    expect(result.tree.nodes).toHaveLength(1); // 单主体根=自身
  });

  it('判据 2 色差：measure 返回 ΔE=3（≤FAMILY 10，天空/草地类平色）出生即封停', async () => {
    const script = new ScriptedSegment([() => segOutcome({ x: 0, y: 0, w: 400, h: 400 })]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('天空', 'sky', { x: 0, y: 0, w: 400, h: 400 })] },
      depsOf(script, { measure: () => 3 }),
    );
    expect(result.sealedByNode['sam-node-0001']).toEqual(['color']);
    expect(result.iterations).toBe(1);
  });

  it('判据 3 模型自认 no-new-instance：细分零交集→父封停（主停止器——§9 实测口径）', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      () => segOutcome(null),
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('房子', 'house', { x: 0, y: 0, w: 300, h: 300 })] },
      depsOf(script),
    );
    expect(result.sealedByNode['sam-node-0001']).toEqual(['model']);
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['房子']); // 零子挂树
  });

  it(`判据 3 模型自认 low-score：score<${SEGMENT_LOOP_LOW_SCORE} 弱实例不入树+父封停`, async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      () => segOutcome({ x: 0, y: 0, w: 100, h: 100 }, 0.3), // 有效交集但弱实例
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('马车', 'carriage', { x: 0, y: 0, w: 300, h: 300 })] },
      depsOf(script),
    );
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['马车']); // 弱实例不入树（裁定 [c]）
    expect(result.sealedByNode['sam-node-0001']).toEqual(['model']);
    expect(result.history[1]!.entries[0]!.outcome).toBe('low-score');
    expect(result.warnings).toEqual([]); // score 在场（0.3）——[5] 不触发
  });

  it('边界：score=0.5 不算弱实例（< 闭合界）——正常建子', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      () => segOutcome({ x: 0, y: 0, w: 100, h: 100 }, SEGMENT_LOOP_LOW_SCORE),
      () => segOutcome(null),
      () => segOutcome(null),
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('马车', 'carriage', { x: 0, y: 0, w: 300, h: 300 })] },
      depsOf(script),
    );
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['马车', '马车·部分1']);
  });
});

// ---------------------------------------------------------------- 硬顶截断

describe('硬顶截断（design §2 判据 4）', () => {
  it('迭代硬顶：maxIterations=1——首轮后达顶，次轮前置全封停（零请求）', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      () => segOutcome({ x: 400, y: 400, w: 300, h: 300 }),
    ]);
    const result = await runSegmentLoop(
      { ...BASE, maxIterations: 1, elements: convergenceFixture().elements },
      depsOf(script),
    );
    expect(script.requests).toHaveLength(2); // 仅首轮两请求——次轮未送线
    expect(result.iterations).toBe(2); // 次轮步发生（封停步）但零请求
    expect(Object.values(result.sealedByNode)).toEqual([['hard-cap'], ['hard-cap']]);
    expect(result.history[1]!.entries).toEqual([]); // 零请求轮
    expect(result.history[1]!.sealed).toHaveLength(2);
    expect(result.warnings).toEqual([]); // 元素均 worthy——[2] 强制面不触发
  });

  it('节点数硬顶：maxNodes=2——第 2 元素出生即封，次轮前置封停余量', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      () => segOutcome({ x: 400, y: 400, w: 300, h: 300 }),
    ]);
    const result = await runSegmentLoop(
      { ...BASE, maxNodes: 2, elements: convergenceFixture().elements },
      depsOf(script),
    );
    expect(script.requests).toHaveLength(2);
    expect(result.sealedByNode['sam-node-0001']).toEqual(['hard-cap']); // 首元素（轮 1 前置封停）
    expect(result.sealedByNode['sam-node-0002']).toEqual(['hard-cap']); // 次元素出生即封
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['画布', '路灯', '草地']);
  });

  it('硬顶公式：maxIterationsForCanvas 面积标定（⌈cm²/100⌉+2）——8×8→3 / 20×30→8 / 40×50→22；缺省即用', async () => {
    expect(maxIterationsForCanvas({ w: 8, h: 8 })).toBe(3);
    expect(maxIterationsForCanvas({ w: 10, h: 10 })).toBe(3);
    expect(maxIterationsForCanvas({ w: 1, h: 1 })).toBe(3); // +2 保底（极小画布仍有完整三轮）
    expect(maxIterationsForCanvas({ w: 20, h: 30 })).toBe(8);
    expect(maxIterationsForCanvas({ w: 40, h: 50 })).toBe(22);
    expect(SEGMENT_LOOP_MAX_NODES_DEFAULT).toBe(256);
    // 缺省接线：8×8cm 画布三轮收敛场景恰好在缺省硬顶 3 内自然终态（无 hard-cap 原因）
    const { elements, script } = convergenceFixture();
    const result = await runSegmentLoop({ ...BASE, elements }, depsOf(script));
    expect(Object.values(result.sealedByNode).every((r) => !r.includes('hard-cap'))).toBe(true);
  });
});

// ---------------------------------------------------------------- mask 交集防外溢

describe('mask 交集防外溢（父∩子位与——§9 回流 3）', () => {
  it('子响应越出父域 5 列：位与裁掉——子 bbox 收紧到交集紧外接', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 200, h: 200 }), // 父（画布左上 200×200）
      () => segOutcome({ x: 100, y: 0, w: 150, h: 150 }), // 子响应 x∈[100,250)——越父右界 x=199 共 50 列
      () => segOutcome(null), // 子轮 2 零实例→子封
      () => segOutcome(null), // 父轮 2 零实例→父封
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('树叶', 'leaf', { x: 0, y: 0, w: 200, h: 200 })] },
      depsOf(script),
    );
    const child = result.tree.nodes[1]!;
    expect(child.objectName).toBe('树叶·部分1');
    expect(child.bbox).toEqual({ x: 100, y: 0, w: 100, h: 150 }); // w=100 非 150——越界列裁掉
    expect(child.effectiveMm).toBe(Math.sqrt(150)); // √(100·150)/10=√150（mm 不随 px 放大变）
    // 子 mask=bbox 局部同维（tree-to-blocks 直喂不变式）且全 1（实心交集）
    expect(child.mask).toMatchObject({ kind: 'inline', w: 100, h: 150 });
  });
});

// ---------------------------------------------------------------- vlmReentry 接口位

describe('vlmReentry 接口位（design §2——默认 false）', () => {
  it('默认 false：analyze 注入在位也永不调用（请求序零 analyze）', async () => {
    const { elements, script } = convergenceFixture();
    const analyze = new ScriptedAnalyze([
      () => { throw new Error('vlmReentry=false 不应调 analyze'); },
    ]);
    await runSegmentLoop({ ...BASE, elements }, depsOf(script, { analyze: analyze.call }));
    expect(analyze.requests).toHaveLength(0);
    expect(script.requests).toHaveLength(5);
  });

  it('true：走桥 analyze 重新描述——精化 hint 进细分提示（接口接线，VLM 真连归 P2.6）', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }), // A 首轮
      () => segOutcome({ x: 400, y: 400, w: 300, h: 300 }), // B 首轮
      () => segOutcome({ x: 0, y: 0, w: 60, h: 60 }), // A 轮 1 裂子（6mm>5 阈→子继续）
      () => segOutcome(null), // B 轮 1 零实例→封
      () => segOutcome(null), // A·部分1 轮 2 零实例→封
      () => segOutcome(null), // A 轮 2 零实例→封
    ]);
    const analyze = new ScriptedAnalyze([
      () => ({
        elements: [element('路灯灯头', 'streetlight lamp head', { x: 0, y: 0, w: 100, h: 100 })],
      }),
      () => ({ elements: [] }), // B：空清单=不精化（宽泛模板兜底）
      () => ({ elements: [] }), // A·部分1 轮 2
      () => ({ elements: [] }), // A 轮 2
    ]);
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 }),
          element('草地', 'grassland', { x: 400, y: 400, w: 300, h: 300 }),
        ],
        vlmReentry: true,
      },
      depsOf(script, { analyze: analyze.call }),
    );
    // analyze 请求：轮 1×2 节点+轮 2×2 节点=4；提示=重新描述模板
    expect(analyze.requests).toHaveLength(4);
    expect(analyze.requests[0]!.prompt).toEqual({ kind: 'text', text: redescribePrompt('路灯') });
    // A 轮 1 细分提示被精化 hint 替换
    expect(script.requests[2]!.prompt).toEqual({
      kind: 'text',
      text: 'streetlight lamp head as a whole, including all its component parts',
    });
    // B 空 analyze 清单→原 hint 兜底
    expect(script.requests[3]!.prompt).toEqual({
      kind: 'text',
      text: 'grassland as a whole, including all its component parts',
    });
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['画布', '路灯', '路灯·部分1', '草地']);
  });

  it('true 但未注入 analyze：init 即 typed 拒（接口位缺位不静默降级）', async () => {
    const script = new ScriptedSegment([() => segOutcome({ x: 0, y: 0, w: 300, h: 300 })]);
    const error = (await runSegmentLoop(
      { ...BASE, elements: [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })], vlmReentry: true },
      depsOf(script),
    ).catch((e: unknown) => e)) as SegmentLoopError;
    expect(error).toBeInstanceOf(SegmentLoopError);
    expect(error.kind).toBe('vlm-reentry-unavailable');
    expect(script.requests).toHaveLength(0); // 未上桥
  });
});

// ---------------------------------------------------------------- 首轮提示面

describe('首轮提示面（几何=box / 能力降级=hint 文本）', () => {
  it("elementPromptMode='hint'：首轮用元素英文 hint 文本提示（桥几何面不可用降级）", async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      () => segOutcome(null),
    ]);
    await runSegmentLoop(
      { ...BASE, elementPromptMode: 'hint', elements: [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })] },
      depsOf(script),
    );
    expect(script.requests[0]!.prompt).toEqual({ kind: 'text', text: 'streetlight' });
  });

  it('[hardening] 未知 hint 透传为 category；suggestDrillWorthy=false 透传（排除开关面）', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      () => segOutcome(null), // 轮 1（30mm 非钻层→[2] 强制细分继续）
      () => segOutcome(null), // 轮 2（轮 3=硬顶零请求）
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('黑背景', 'black background', { x: 0, y: 0, w: 300, h: 300 }, { suggestDrillWorthy: false, category: undefined })] },
      depsOf(script),
    );
    const node = result.tree.nodes[0]!;
    expect(node.category).toBe('black background'); // [4] 未知 hint 透传（不再随机兜底 'subject'）
    expect(node.drillWorthy).toBe(false);
  });
});

// ---------------------------------------------------------------- 失败面与坏输入

describe('失败面与坏输入（typed，不静默吞）', () => {
  async function capture(p: Promise<unknown>): Promise<SegmentLoopError> {
    return (await p.catch((e: unknown) => e)) as SegmentLoopError;
  }

  it('桥 segment 抛错：bridge-failure typed（cause 保留）——降级归 P2.5 裁量', async () => {
    const script = new ScriptedSegment([
      () => { throw new Error('ssh 连接中断'); },
    ]);
    const error = await capture(
      runSegmentLoop({ ...BASE, elements: [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })] }, depsOf(script)),
    );
    expect(error).toBeInstanceOf(SegmentLoopError);
    expect(error.kind).toBe('bridge-failure');
    expect((error.cause as Error).message).toBe('ssh 连接中断');
  });

  it('桥掩码维度≠画布：bad-mask typed（全图坐标锚点——不猜裁剪）', async () => {
    const script = new ScriptedSegment([
      () => ({ mask: { w: 4, h: 4, bits: new Uint8Array(16) } }),
    ]);
    const error = await capture(
      runSegmentLoop({ ...BASE, elements: [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })] }, depsOf(script)),
    );
    expect(error.kind).toBe('bad-mask');
    expect(error.message).toMatch(new RegExp(`≠ 画布 ${IMG}×${IMG}`));
  });

  it('桥掩码字节非法（值 2）：bad-mask typed', async () => {
    const bits = new Uint8Array(IMG * IMG).fill(2);
    const script = new ScriptedSegment([() => ({ mask: { w: IMG, h: IMG, bits } })]);
    const error = await capture(
      runSegmentLoop({ ...BASE, elements: [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })] }, depsOf(script)),
    );
    expect(error.kind).toBe('bad-mask');
  });

  it('全元素零实例：finalize typed no-instances（无树可产）', async () => {
    const script = new ScriptedSegment([() => segOutcome(null)]);
    const error = await capture(
      runSegmentLoop({ ...BASE, elements: [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })] }, depsOf(script)),
    );
    expect(error.kind).toBe('no-instances');
  });

  it('部分元素零实例：跳过不入树（meta no-instance），其余照常成树', async () => {
    const script = new ScriptedSegment([
      () => segOutcome(null), // 路灯零实例
      () => segOutcome({ x: 400, y: 400, w: 300, h: 300 }),
      () => segOutcome(null), // 草地细分零实例
    ]);
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 }),
          element('草地', 'grassland', { x: 400, y: 400, w: 300, h: 300 }),
        ],
      },
      depsOf(script),
    );
    expect(result.history[0]!.entries[0]!.outcome).toBe('no-instance');
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['画布', '草地']); // 单活元素→画布根（2 根收口）
    expect(result.tree.nodes[0]!.children).toEqual([result.tree.nodes[1]!.id]);
  });

  it('纵横比不符：aspect-mismatch typed（S1 显式拒透传）', async () => {
    const script = new ScriptedSegment([() => segOutcome({ x: 0, y: 0, w: 300, h: 300 })]);
    const error = await capture(
      runSegmentLoop(
        {
          ...BASE,
          canvasCm: { w: 4, h: 8 }, // 纵横比 0.5 vs px 1.0
          elements: [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })],
        },
        depsOf(script),
      ),
    );
    expect(error.kind).toBe('aspect-mismatch');
  });

  it('坏参数：元素空清单/非正 maxGemDiameterMm/非正 maxNodes → bad-option typed', async () => {
    const script = new ScriptedSegment([]);
    const elements = [element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 })];
    for (const over of [
      { elements: [] as SceneElement[] },
      { maxGemDiameterMm: 0 },
      { maxNodes: 0 },
      { maxIterations: -1 },
    ]) {
      const error = await capture(
        runSegmentLoop({ ...BASE, elements, ...over }, depsOf(script)),
      );
      expect(error).toBeInstanceOf(SegmentLoopError);
      expect(error.kind).toBe('bad-option');
      expect(script.requests).toHaveLength(0); // 参数门在桥前
    }
  });
});

// ---------------------------------------------------------------- 确定性

describe('确定性（同 seed 同请求序同产物——回放纪律）', () => {
  it('同脚本双跑：请求序逐字段相等+终树/封停表/演化 meta/警告面深比较相等', async () => {
    const run = () => {
      const { elements, script } = convergenceFixture();
      return runSegmentLoop({ ...BASE, elements }, depsOf(script)).then((result) => ({
        result,
        prompts: script.requests.map((r) => JSON.stringify(r)),
      }));
    };
    const a = await run();
    const b = await run();
    expect(a.prompts).toEqual(b.prompts);
    expect(a.result.tree).toEqual(b.result.tree); // createdAt=注入 now（固定）
    expect(a.result.sealedByNode).toEqual(b.result.sealedByNode);
    expect(a.result.history).toEqual(b.result.history);
    expect(a.result.warnings).toEqual(b.result.warnings); // [hardening] 警告面同入回放对拍
  });
});

// ---------------------------------------------------------------- 提示模板

describe('宽泛语义提示模板 broadSemanticPrompt（父名+「整体」泛化，入参节点名/层级）', () => {
  it('英文 hint 优先+深度分层措辞（spike 实证英文语义词最稳）', () => {
    expect(broadSemanticPrompt({ objectName: '路灯', depth: 1, hint: 'streetlight' })).toBe(
      'streetlight as a whole, including all its component parts',
    );
    expect(broadSemanticPrompt({ objectName: '路灯·灯头', depth: 2, hint: 'streetlight lamp head' })).toBe(
      'streetlight lamp head as a whole, including finer sub-parts and details',
    );
    expect(broadSemanticPrompt({ objectName: '柳树·枝条', depth: 3, hint: 'willow branch' })).toBe(
      'willow branch as a whole, including fine texture and structure',
    );
  });
  it('无 hint 中文兜底（后续轮子节点常态——无英文 hint）', () => {
    expect(broadSemanticPrompt({ objectName: '路灯·部分1', depth: 2 })).toBe('路灯·部分1整体，包括更细的部件与细节');
    expect(broadSemanticPrompt({ objectName: '草地', depth: 1 })).toBe('草地整体，包括全部组成部分');
    expect(broadSemanticPrompt({ objectName: '柳树·枝条', depth: 4 })).toBe('柳树·枝条整体，包括纹理与细微结构');
  });
  it('空白 hint 视为缺省+确定性（同输入同输出）', () => {
    expect(broadSemanticPrompt({ objectName: '草地', depth: 1, hint: '  ' })).toBe('草地整体，包括全部组成部分');
    expect(broadSemanticPrompt({ objectName: '草地', depth: 1, hint: '  ' })).toBe(broadSemanticPrompt({ objectName: '草地', depth: 1 }));
    expect(redescribePrompt('路灯')).toBe(redescribePrompt('路灯'));
  });
});

// ---------------------------------------------------------------- [hardening 1] 兄弟掩膜互斥

describe('P2.4-hardening [1] 兄弟掩膜互斥（所有权消解——审查回流 person∩hat=16,334px 占 hat 36.3%）', () => {
  it('36% 重叠（审查场景同构）：同 worthy 小 maskPx 胜出——胜者逐位不变、败者扣交集重算，终态两兄弟互斥', async () => {
    // hat (400,60,300,300)=90,000px；person (520,180,280,400)=112,000px（worthy）；
    // 交集=[520,700)×[180,360)=180×180=32,400px=36.0% of hat → 双 worthy→小者 hat 胜，person 失 32,400
    const script = new ScriptedSegment([
      () => segOutcome({ x: 400, y: 60, w: 300, h: 300 }), // 帽子
      () => segOutcome({ x: 520, y: 180, w: 280, h: 400 }), // 人物（worthy——隔离「小者胜」规则）
      () => segOutcome(null), // 帽子轮 1 零实例→model 封
      () => segOutcome(null), // 人物轮 1 零实例→model 封
    ]);
    const measured: string[] = [];
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('帽子', 'hat', { x: 400, y: 60, w: 300, h: 300 }),
          element('人物', 'person', { x: 520, y: 180, w: 280, h: 400 }),
        ],
      },
      depsOf(script, {
        measure: (region) => {
          measured.push(`${region.bbox.w}x${region.bbox.h}`);
          return 22;
        },
      }),
    );
    const byName = new Map(result.tree.nodes.map((n) => [n.objectName, n]));
    const hat = byName.get('帽子')!;
    const person = byName.get('人物')!;
    // 胜者不变：mask 逐位（bbox/maskPx/effectiveMm 全保持）
    expect(hat.bbox).toEqual({ x: 400, y: 60, w: 300, h: 300 });
    expect(maskPxOf(hat)).toBe(90_000);
    expect(hat.effectiveMm).toBe(30);
    // 败者扣交集：112,000−32,400=79,600；紧外接不变（残块触及原 bbox 各界）→effectiveMm 不变
    expect(maskPxOf(person)).toBe(112_000 - 32_400);
    expect(person.bbox).toEqual({ x: 520, y: 180, w: 280, h: 400 });
    expect(person.effectiveMm).toBeCloseTo(Math.sqrt(280 * 400) / 10, 10);
    // 消解后互斥：全图位与=0
    expect(overlapPxOf(hat, person)).toBe(0);
    // 败者被削→labVariance 重测（人物创建 1 次+消解重测 1 次）；胜者不重测
    expect(measured.filter((m) => m === '280x400')).toHaveLength(2);
    expect(measured.filter((m) => m === '300x300')).toHaveLength(1);
    expect(result.warnings).toEqual([]); // 双双存活——无吞没警告
    expect(result.iterations).toBe(2);
  });

  it('drillWorthy 优先于小 maskPx：worthy 大块胜——非钻层兄弟被削并重算 bbox', async () => {
    // A=人物 worthy 大 (100,100,400,400)=160,000；B=胸花 non-worthy 小 (300,300,250,200)=50,000
    // 交集=[300,500)×[300,500)=40,000px——按「小者胜」会削 A，按 worthy 优先削 B（规则隔离）
    const script = new ScriptedSegment([
      () => segOutcome({ x: 100, y: 100, w: 400, h: 400 }), // 人物（worthy）
      () => segOutcome({ x: 300, y: 300, w: 250, h: 200 }), // 胸花（non-worthy——败者）
      () => segOutcome(null), // 人物轮 1 零实例→model 封（worthy 正常判停）
      () => segOutcome(null), // 胸花轮 1（[2] 强制细分继续）
      () => segOutcome(null), // 胸花轮 2
    ]);
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('人物', 'person', { x: 100, y: 100, w: 400, h: 400 }),
          element('胸花', 'brooch', { x: 300, y: 300, w: 250, h: 200 }, { suggestDrillWorthy: false }),
        ],
      },
      depsOf(script),
    );
    const byName = new Map(result.tree.nodes.map((n) => [n.objectName, n]));
    const person = byName.get('人物')!;
    const brooch = byName.get('胸花')!;
    expect(maskPxOf(person)).toBe(160_000); // worthy 胜者逐位不变
    expect(person.bbox).toEqual({ x: 100, y: 100, w: 400, h: 400 });
    // 败者残块=[500,550)×[300,500) 条带=10,000px；紧外接收紧到条带
    expect(maskPxOf(brooch)).toBe(10_000);
    expect(brooch.bbox).toEqual({ x: 500, y: 300, w: 50, h: 200 });
    expect(brooch.effectiveMm).toBeCloseTo(Math.sqrt(50 * 200) / 10, 10); // √10000/10=10mm
    expect(overlapPxOf(person, brooch)).toBe(0);
    // 胸花 non-worthy 10mm>6mm→[2] 强制细分至硬顶（8×8cm 缺省 maxIter=3）→depth-cap 警告
    expect(result.warnings.map((w) => [w.nodeId, w.reason])).toEqual([[brooch.id, 'depth-cap-unresolved']]);
    expect(result.iterations).toBe(4); // 轮 0 建+消解；轮 1 人物封；轮 2 胸花续；轮 3 硬顶封
  });

  it('败者归零=完全吞没：移出树+warning{sibling-overlap-consumed}+树闭合无孤儿', async () => {
    // 人物 worthy 大块完全包住胸花（non-worthy）→胸花交集=自身全部→归零吞没
    const script = new ScriptedSegment([
      () => segOutcome({ x: 100, y: 100, w: 400, h: 400 }), // 人物
      () => segOutcome({ x: 200, y: 200, w: 100, h: 100 }), // 胸花（完全落于人物域内）
      () => segOutcome(null), // 人物轮 1 零实例→model 封
    ]);
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('人物', 'person', { x: 100, y: 100, w: 400, h: 400 }),
          element('胸花', 'brooch', { x: 200, y: 200, w: 100, h: 100 }, { suggestDrillWorthy: false }),
        ],
      },
      depsOf(script),
    );
    // 树：胸花移出（ObjectTreeSchema 终验含 parent/children 双向闭合——孤儿会直接炸）
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['画布', '人物']);
    const canvas = result.tree.nodes[0]!;
    const person = result.tree.nodes[1]!;
    expect(canvas.children).toEqual([person.id]); // 胸花不在 children（不悬空）
    expect(maskPxOf(person)).toBe(160_000); // 胜者不变
    // 警告留痕：吞没者出树、胜者可溯源
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!.nodeId).toBe('sam-node-0002'); // 胸花（创建序第 2）
    expect(result.warnings[0]!.reason).toBe('sibling-overlap-consumed');
    expect(result.warnings[0]!.iter).toBe(0);
    expect(result.warnings[0]!.detail).toContain('人物');
    // meta 审计：entries 保留两请求记录；步后树=1 节点（胸花出树——画布根=finalize 增量）、frontier 只剩人物
    expect(result.history[0]!.entries.map((e) => e.outcome)).toEqual(['node-created', 'node-created']);
    expect(result.history[0]!.nodesAfter).toBe(1);
    expect(result.history[0]!.frontierAfter).toBe(1);
    expect(result.sealedByNode['sam-node-0002']).toBeUndefined(); // 出封停面（人走茶凉，warning 是唯一痕迹）
    expect(result.iterations).toBe(2);
  });
});

// ---------------------------------------------------------------- [hardening 2] frontier 强制细分

describe('P2.4-hardening [2] frontier 强制细分（非 drillWorthy 大块不得 sealed——审查回流 person 35% 画幅无钻贴路径）', () => {
  it('非 worthy 大块（40mm>3×2mm）：判据 3 不再封停——逐轮再分至硬顶，截断时 warning{depth-cap-unresolved}', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 100, y: 100, w: 400, h: 400 }), // 轮 0 建节点（40mm）
      () => segOutcome(null), // 轮 1 零实例——判据 3 命中但被 [2] 顶住
      () => segOutcome(null), // 轮 2 同上
      () => segOutcome(null), // 轮 3 兜底（硬顶步零请求——脚本不耗尽）
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('人物', 'person', { x: 100, y: 100, w: 400, h: 400 }, { suggestDrillWorthy: false })] },
      depsOf(script),
    );
    // 轮 0 建+轮 1/2 各一请求（共 3——每轮都再分它）→轮 3 硬顶封停（零请求）
    expect(script.requests).toHaveLength(3);
    expect(result.iterations).toBe(4);
    expect(script.requests.slice(1).map((r) => r.prompt)).toEqual([
      { kind: 'text', text: 'person as a whole, including all its component parts' },
      { kind: 'text', text: 'person as a whole, including all its component parts' },
    ]);
    expect(result.sealedByNode['sam-node-0001']).toEqual(['hard-cap']);
    // 树里显式留痕：未解决大块警告（nodeId+轮次）
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]!).toMatchObject({
      nodeId: 'sam-node-0001',
      reason: 'depth-cap-unresolved',
      iter: 3,
    });
  });

  it('对照：worthy 大块照旧判据 3 封停（无警告）；非 worthy 小块（4mm≤判据 1 阈）照旧 size 封停（无警告）', async () => {
    // worthy 大块：轮 1 零实例→model 封
    const worthyScript = new ScriptedSegment([
      () => segOutcome({ x: 100, y: 100, w: 400, h: 400 }),
      () => segOutcome(null),
    ]);
    const worthy = await runSegmentLoop(
      { ...BASE, elements: [element('房子', 'house', { x: 100, y: 100, w: 400, h: 400 })] },
      depsOf(worthyScript),
    );
    expect(worthy.sealedByNode['sam-node-0001']).toEqual(['model']);
    expect(worthy.iterations).toBe(2);
    expect(worthy.warnings).toEqual([]);
    // 非 worthy 小块：出生即 size 封（一轮终态）
    const smallScript = new ScriptedSegment([() => segOutcome({ x: 100, y: 100, w: 40, h: 40 })]);
    const small = await runSegmentLoop(
      { ...BASE, elements: [element('背景板', 'backdrop', { x: 100, y: 100, w: 60, h: 60 }, { suggestDrillWorthy: false })] },
      depsOf(smallScript),
    );
    expect(small.sealedByNode['sam-node-0001']).toEqual(['size']);
    expect(small.iterations).toBe(1);
    expect(small.warnings).toEqual([]);
  });

  it(`边界带：非 worthy ${5.5}mm（>判据 1 阈 5mm 且 ≤${FORCE_MM}mm 强制阈）不强制——model 封停无警告`, async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 100, y: 100, w: 55, h: 55 }), // 5.5mm：判据 1 不停、[2] 不强制
      () => segOutcome(null), // 轮 1 零实例→model 封（正常路径）
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('小徽章', 'badge', { x: 100, y: 100, w: 55, h: 55 }, { suggestDrillWorthy: false })] },
      depsOf(script),
    );
    expect(result.sealedByNode['sam-node-0001']).toEqual(['model']);
    expect(result.iterations).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(SEGMENT_LOOP_FRONTIER_FORCE_FACTOR).toBe(3); // 阈值系数冻结面
  });
});

// ---------------------------------------------------------------- [hardening 3] 掩膜碎片清理

describe('P2.4-hardening [3] 掩膜碎片清理（连通域面积过滤——审查回流 person 掩膜约 90 碎片 ≤200px）', () => {
  it('阈值公式 max(200px, ⌈0.05%×画幅⌉)：800×800→320 / 200×200→200（下限）/ 1000×1000→500 / 736×736→271（实拍尺寸）', () => {
    expect(MASK_FRAGMENT_CANVAS_RATIO).toBe(0.0005);
    expect(maskFragmentThresholdPx({ width: 800, height: 800 })).toBe(320);
    expect(maskFragmentThresholdPx({ width: 200, height: 200 })).toBe(200); // 0.05%=20px<下限
    expect(maskFragmentThresholdPx({ width: 1000, height: 1000 })).toBe(500);
    expect(maskFragmentThresholdPx({ width: 736, height: 736 })).toBe(271);
  });

  it('主块+远处碎斑（10×10px）：碎斑剔除、节点 bbox 收紧到主块、maskPx=主块', async () => {
    const script = new ScriptedSegment([
      () => multiRectOutcome([{ x: 100, y: 100, w: 100, h: 100 }, { x: 600, y: 600, w: 10, h: 10 }], 0.9),
      () => segOutcome(null), // 轮 1 零实例→封
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('人物', 'person', { x: 100, y: 100, w: 100, h: 100 })] },
      depsOf(script),
    );
    const person = result.tree.nodes[0]!;
    expect(person.bbox).toEqual({ x: 100, y: 100, w: 100, h: 100 }); // 碎斑不在紧外接内
    expect(maskPxOf(person)).toBe(10_000); // 仅主块
    expect(result.warnings).toEqual([]);
  });

  it('person 类 90 碎片场景：主块 200×200 外 90 颗 2×2 碎斑全剔除（阈值 320px）', async () => {
    const specks: NodeBBox[] = [];
    for (let i = 0; i < 90; i++) {
      specks.push({ x: 500 + (i % 15) * 12, y: 500 + Math.floor(i / 15) * 12, w: 2, h: 2 });
    }
    const script = new ScriptedSegment([
      () => multiRectOutcome([{ x: 100, y: 100, w: 200, h: 200 }, ...specks], 0.9),
      () => segOutcome(null),
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('人物', 'person', { x: 100, y: 100, w: 200, h: 200 })] },
      depsOf(script),
    );
    const person = result.tree.nodes[0]!;
    expect(maskPxOf(person)).toBe(40_000); // 200×200 主块——90 碎斑（90×4px）零残留
    expect(person.bbox).toEqual({ x: 100, y: 100, w: 200, h: 200 });
  });

  it('全碎片响应（3 颗 10×10 斑）=零可用实例→no-instance 不入树，其余元素照常成树', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }), // 路灯有效
      () => multiRectOutcome([{ x: 500, y: 500, w: 10, h: 10 }, { x: 600, y: 500, w: 10, h: 10 }, { x: 700, y: 500, w: 10, h: 10 }], 0.9),
      () => segOutcome(null), // 路灯轮 1 封
    ]);
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 }),
          element('草地', 'grassland', { x: 400, y: 400, w: 300, h: 300 }),
        ],
      },
      depsOf(script),
    );
    expect(result.history[0]!.entries[1]!.outcome).toBe('no-instance'); // 全碎片=零可用实例
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['画布', '路灯']);
    expect(result.warnings).toEqual([]); // 不入树≠警告（零检出照旧 no-instance 语义）
  });
});

// ---------------------------------------------------------------- [hardening 4] hint→category 固定映射

describe('P2.4-hardening [4] hint→category 固定映射（消除 face/subject 随机性——run 实测 person→face/hat→subject）', () => {
  it('常见 hint 命中映射表（person/face/hat/tree/christmas tree/flower…）；大小写/空白归一', () => {
    expect(categoryForHint('person')).toBe('person');
    expect(categoryForHint('face')).toBe('face');
    expect(categoryForHint('hat')).toBe('hat');
    expect(categoryForHint('tree')).toBe('tree');
    expect(categoryForHint('christmas tree')).toBe('tree');
    expect(categoryForHint('flower')).toBe('flower');
    expect(categoryForHint('grassland')).toBe('grass');
    expect(categoryForHint('streetlight')).toBe('light');
    expect(categoryForHint('Person')).toBe('person'); // lowercase 归一
    expect(categoryForHint('  HAT  ')).toBe('hat'); // trim 归一
    // 映射表完备性抽查：审查场景三 hint（person/hat/christmas tree）全在表
    for (const key of ['person', 'face', 'hat', 'tree', 'flower']) {
      expect(HINT_CATEGORY_MAP[key]).toBeDefined();
    }
  });

  it('未知 hint 透传 hint 本身；空 hint 兜底 subject（旧行为保留）', () => {
    expect(categoryForHint('magic rune')).toBe('magic rune');
    expect(categoryForHint('圣诞花环')).toBe('圣诞花环'); // 中文 hint 原样透传
    expect(categoryForHint('')).toBe('subject');
    expect(categoryForHint('   ')).toBe('subject');
  });

  it('接线：无 category 走映射；VLM 显式 category 优先于映射；子节点继承消解后 category', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }), // 帽子（无 category→映射 'hat'）
      () => segOutcome({ x: 400, y: 400, w: 300, h: 300 }), // 路灯（显式 structure→优先于映射 light）
      () => segOutcome({ x: 0, y: 0, w: 60, h: 60 }), // 帽子轮 1 子（6mm>5 续）
      () => segOutcome(null), // 路灯轮 1 封
      () => segOutcome(null), // 帽子·部分1 轮 2 封
      () => segOutcome(null), // 帽子轮 2 封
    ]);
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('帽子', 'hat', { x: 0, y: 0, w: 300, h: 300 }), // 无 category
          element('路灯', 'streetlight', { x: 400, y: 400, w: 300, h: 300 }, { category: 'structure' }),
        ],
      },
      depsOf(script),
    );
    const byName = new Map(result.tree.nodes.map((n) => [n.objectName, n]));
    expect(byName.get('帽子')!.category).toBe('hat'); // 映射消解（不再是 'subject' 兜底）
    expect(byName.get('路灯')!.category).toBe('structure'); // 显式优先
    expect(byName.get('帽子·部分1')!.category).toBe('hat'); // 子继承
  });
});

// ---------------------------------------------------------------- [hardening 5] score 非空门禁

describe('P2.4-hardening [5] score 非空门禁（run1 bug-score-null 防回归）', () => {
  it('元素/子两路检出节点 score 缺失→warning{score-missing}（节点照建——默认置信）', async () => {
    // 元素路：首轮响应无 score
    const elemScript = new ScriptedSegment([
      () => multiRectOutcome([{ x: 0, y: 0, w: 300, h: 300 }]), // 无 score
      () => segOutcome(null),
    ]);
    const elem = await runSegmentLoop(
      { ...BASE, elements: [element('房子', 'house', { x: 0, y: 0, w: 300, h: 300 })] },
      depsOf(elemScript),
    );
    expect(elem.tree.nodes.map((n) => n.objectName)).toEqual(['房子']); // 节点照建
    expect(elem.warnings).toEqual([
      { nodeId: 'sam-node-0001', reason: 'score-missing', iter: 0, detail: expect.stringContaining('房子') },
    ]);
    // 子路：细分响应无 score
    const childScript = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }), // 父有 score
      () => multiRectOutcome([{ x: 0, y: 0, w: 100, h: 100 }]), // 子无 score
      () => segOutcome(null), // 子轮 2 封
      () => segOutcome(null), // 父轮 2 封
    ]);
    const child = await runSegmentLoop(
      { ...BASE, elements: [element('马车', 'carriage', { x: 0, y: 0, w: 300, h: 300 })] },
      depsOf(childScript),
    );
    expect(child.tree.nodes.map((n) => n.objectName)).toEqual(['马车', '马车·部分1']);
    expect(child.warnings).toEqual([
      { nodeId: 'sam-node-0002', reason: 'score-missing', iter: 1, detail: expect.any(String) },
    ]);
  });

  it('运行时 score:null（typeof 门）：不落 low-score 误杀——照建子节点+warning', async () => {
    const script = new ScriptedSegment([
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }),
      // P2.1 真身形状：score 可为 JSON null——旧代码 null<0.5 为真→误判弱实例
      () => ({ mask: { w: IMG, h: IMG, bits: rect(IMG, IMG, { x: 0, y: 0, w: 100, h: 100 }) }, score: null }) as unknown as SegmentBridgeOutcome,
      () => segOutcome(null),
      () => segOutcome(null),
    ]);
    const result = await runSegmentLoop(
      { ...BASE, elements: [element('马车', 'carriage', { x: 0, y: 0, w: 300, h: 300 })] },
      depsOf(script),
    );
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['马车', '马车·部分1']); // 未被 low-score 误杀
    expect(result.history[1]!.entries[0]!.outcome).toBe('child-created');
    expect(result.warnings.map((w) => [w.nodeId, w.reason])).toEqual([['sam-node-0002', 'score-missing']]);
  });

  it('零检出照旧 no-instance 不入树（无警告）；low-score 有 score 在场（无 score-missing 警告）', async () => {
    const script = new ScriptedSegment([
      () => segOutcome(null), // 元素零检出（无 score 也不警告——无节点可挂）
      () => segOutcome({ x: 0, y: 0, w: 300, h: 300 }), // 草地有效
      () => segOutcome({ x: 400, y: 400, w: 100, h: 100 }, 0.3), // 草地弱实例子（score 在场）
    ]);
    const result = await runSegmentLoop(
      {
        ...BASE,
        elements: [
          element('路灯', 'streetlight', { x: 0, y: 0, w: 300, h: 300 }),
          element('草地', 'grassland', { x: 400, y: 400, w: 300, h: 300 }),
        ],
      },
      depsOf(script),
    );
    expect(result.history[0]!.entries[0]!.outcome).toBe('no-instance');
    expect(result.tree.nodes.map((n) => n.objectName)).toEqual(['画布', '草地']);
    expect(result.warnings).toEqual([]);
  });
});

// ---------------------------------------------------------------- P0.2 直喂（树可喂 tree-to-blocks）

describe('产出树直喂 P0.2 tree-to-blocks（循环产出的树要能喂它）', () => {
  it('inline mask 免 blob 直读：块=非容器节点全列、blockId=节点 id、mask/bbox 同维', async () => {
    const { elements, script } = convergenceFixture();
    const result = await runSegmentLoop({ ...BASE, elements }, depsOf(script));
    const outcome = treeToBlocks(result.tree, { readBlob: () => null }, { gemDiameterPx: 2 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('tree-to-blocks 失败');
    expect(outcome.pixelsPerMm).toBe(10);
    // 画布根（drillWorthy=false 且有子）不产块；路灯/部分1/草地全产（叶必产+父可钻）
    expect(outcome.blocks.map((b) => b.id)).toEqual(
      result.tree.nodes.filter((n) => n.objectName !== '画布').map((n) => n.id),
    );
    const lampBlock = outcome.blocks.find((b) => b.label === '画布/路灯');
    expect(lampBlock?.origin.drillWorthy).toBe(true);
    expect(lampBlock?.origin.nodeCategory).toBe('light'); // [4] streetlight→light（映射消解后）
    const partBlock = outcome.blocks.find((b) => b.label === '画布/路灯/部分1');
    expect(partBlock?.origin.isLeaf).toBe(true);
    expect(partBlock?.origin.effectiveMm).toBe(5);
  });
});
