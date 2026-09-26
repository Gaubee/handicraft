/**
 * strategy.design mock 单测（add-subject-sam-pipeline P3.1——纯本地 mock 面，零真实外呼）。
 * 形态沿仓内先例：LLM 网关=本地 openai-completions mock（scene-analyze.test.ts 同款
 * 线协议替身——127.0.0.1 loopback、stream:false JSON 体；与真实网关仅地址/key 不同，
 * 即「LLM 无 key 下的测试策略」）；授权桥用例族照 capability-sets.test.ts 同构。
 * 覆盖：prompt 模板（纯函数快照+策略族指引表完备性）/候选投影（supplier/family/
 * activeSetId 组合投影+不可用成员明示+CAS 绑定）/plan 装配校验（stoneIdx 幻觉拒/
 * params 逐项非法拒携节点+字段/nodeId 未知与层级节点拒/覆盖不完整拒/无尺寸拒/exclusion
 * 无钻通道/free-code 工件化）/designer propose 链（线面断言/fenced 容错/坏 JSON/HTTP 坏/
 * live 门/无 key）/工具面授权（无授权直调必拒/未装配桥/propose 指派表预览+帧/批准前
 * 零变更/批准→执行→三工件落档/gems 校验门（engine 委派注入缝——越界钻剔除）/
 * free-code 沙箱真执行/重放拒/activeSetId CAS 漂移拒/注册面+deny 名单存活）/
 * gems 叠加渲染（确定性+像素断言）。零常驻进程（mock 网关每用例 finally stop）。
 */
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CodeStrategyArtifactSchema,
  encodeInlineMask,
  SupplierSkuProfileSchema,
  type CodeStrategyArtifact,
  type ObjectTree,
  type SupplierSkuProfile,
} from '@handicraft/contracts';
import { encodePng, decodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { productToolDenyList } from '../src/kernel/tool-surface.js';
import { strategyEngineDelegate } from '../src/kernel/index.js';
import { createAgentTask } from '../src/db/jobs.js';
import { StoneService } from '../src/stones/service.js';
import { SetService } from '../src/stones/sets-service.js';
import { STRATEGY_KINDS } from '../src/kernel/strategies/registry.js';
import { persistObjectTreeArtifact } from '../src/kernel/vision/tree-persist.js';
import {
  assembleStrategyPlan,
  buildStrategyDesignPrompt,
  createStrategyDesignCapabilities,
  extractJsonText,
  projectStoneCandidates,
  renderGemsOverlay,
  STRATEGY_DESIGN_LIVE_ENV,
  STRATEGY_DESIGN_TOOL_NAME,
  STRATEGY_FAMILY_GUIDES,
  StrategyDesignError,
  StrategyDesigner,
  type EngineLayoutDelegate,
  type StoneCandidate,
} from '../src/kernel/strategies/design.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

const YUHANG: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [{ rows: [51, 78], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } }],
  styleKey: 'row',
});

function textureBytes(): Uint8Array {
  // 128×128 圆形主体（半径 48——alpha bounds 主径 96px 过 texture gate 下限 64）。
  const size = 128;
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= r * r) {
        const p = (y * size + x) * 4;
        rgba[p] = 200;
        rgba[p + 1] = 200;
        rgba[p + 2] = 200;
        rgba[p + 3] = 255;
      }
    }
  }
  return new Uint8Array(encodePng(size, size, rgba));
}

/** 实心矩形 mask（w*h 全 1——策略执行的几何基座）。 */
function solidMask(w: number, h: number) {
  return encodeInlineMask(w, h, new Uint8Array(w * h).fill(1));
}

/**
 * 测试树（canvasCm 10×8 / imagePx 100×80 → ppm=10）：
 * n0 柳树（中间节点 drillWorthy=false——层级节点，禁止指派）
 * ├─ n1 柳树·枝条（叶，60×80）
 * └─ n2 柳树·花朵（叶，40×60）
 */
function testTree(): ObjectTree {
  return {
    kind: 'object-tree',
    formatVersion: 1,
    canvasCm: { w: 10, h: 8 },
    imagePx: { width: 100, height: 80 },
    nodes: [
      {
        id: 'n0',
        objectName: '柳树',
        category: 'foliage',
        mask: solidMask(100, 80),
        bbox: { x: 0, y: 0, w: 100, h: 80 },
        parent: null,
        children: ['n1', 'n2'],
        effectiveMm: 80,
        labVariance: 22.5,
        drillWorthy: false,
        origin: 'vlm+sam3',
      },
      {
        id: 'n1',
        objectName: '柳树·枝条',
        category: 'foliage',
        mask: solidMask(60, 80),
        bbox: { x: 0, y: 0, w: 60, h: 80 },
        parent: 'n0',
        children: [],
        effectiveMm: 44.7,
        labVariance: 9.2,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
      {
        id: 'n2',
        objectName: '柳树·花朵',
        category: 'flower',
        mask: solidMask(40, 60),
        bbox: { x: 60, y: 20, w: 40, h: 60 },
        parent: 'n0',
        children: [],
        effectiveMm: 30.1,
        labVariance: 31.4,
        drillWorthy: true,
        origin: 'vlm+sam3',
      },
    ],
    createdAt: '2026-09-25T00:00:00.000Z',
  };
}

const FREE_CODE_SOURCE = [
  'function layout(sandbox) {',
  '  var d = sandbox.gem.diameterPx;',
  '  if (d <= 0) { throw new Error("bad diameter"); }',
  '  return [{x:10,y:10},{x:50,y:10},{x:10,y:70},{x:50,y:70},{x:30,y:40}];',
  '}',
].join('\n');

/** LLM 应答脚本（候选序=stone_index ORDER BY supplier,sku → A52=idx1 / J51=idx2）。 */
function assignmentsPayload(): Record<string, unknown> {
  return {
    assignments: [
      { nodeId: 'n1', strategyKind: 'soft-curve', params: {}, stoneIdx: [2], rationale: '枝条顺骨架柔和曲线' },
      {
        nodeId: 'n2',
        strategyKind: 'texture-fill',
        params: { mode: 'scatter', polarity: 'dark-dense' },
        stoneIdx: [1],
        densityPerCm2: 3,
        rationale: '花朵面状纹理打底',
      },
    ],
  };
}

/** mock 网关（scene-analyze.test.ts 同款——按脚本应答，记录请求体供断言）。 */
interface MockGateway {
  server: Server;
  port: number;
  requests: string[];
  stop(): Promise<void>;
}

function startMockGateway(
  script: () => { status?: number; body?: string; delayMs?: number } | { text: string },
): Promise<MockGateway> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      requests.push(body);
      const step = script();
      if ('text' in step) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: step.text } }] }));
        return;
      }
      if (step.delayMs !== undefined && step.delayMs > 0) {
        setTimeout(() => {
          response.writeHead(step.status ?? 500, { 'content-type': 'text/plain' });
          response.end(step.body ?? '');
        }, step.delayMs);
        return;
      }
      response.writeHead(step.status ?? 500, { 'content-type': 'text/plain' });
      response.end(step.body ?? '');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        server,
        port,
        requests,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

/** 建标准原子（sku 覆写——同 profile 多款）。 */
function createStone(
  s: TestServices,
  overrides: { sku?: string; sizeMm?: number | null; rgb?: [number, number, number]; family?: string },
): ReturnType<StoneService['createStone']> {
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  return stones.createStone({
    ownerId: s.anonymous.id,
    supplierProfile: YUHANG,
    draft: {
      name: `${overrides.sku ?? 'J51'} 钻`,
      sku: overrides.sku ?? 'J51',
      sizeMm: overrides.sizeMm === undefined ? 2 : overrides.sizeMm,
      color: {
        name: '测试色',
        rgb: overrides.rgb ?? [240, 240, 232],
        family: overrides.family ?? '白色系',
        finish: 'glossy',
      },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: textureBytes(),
  });
}

interface Fixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStrategyDesignCapabilities>;
  sessionId: string;
  taskId: string;
  treeArtifactRef: string;
  tree: ObjectTree;
  /** 候选（A52=idx1 3mm 红色系 / J51=idx2 2mm 白色系——stone_index 稳定序）。 */
  candidates: StoneCandidate[];
  j51: string;
  a52: string;
  frames(): Array<Record<string, unknown>>;
  dispose(): void;
}

function setup(engineLayout?: EngineLayoutDelegate, gatewayPort?: number): Fixture {
  const s = createServices(undefined, { imgDryRun: true });
  if (gatewayPort !== undefined) {
    s.config.llm.provider = 'zai';
    s.config.llm.baseUrl = `http://127.0.0.1:${gatewayPort}/v1`;
    s.config.llm.apiKey = 'mock-gateway-key';
    s.config.llm.model = 'glm-5.3-flash';
    s.config.llm.api = '';
  }
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createStrategyDesignCapabilities({
    db: s.db,
    blobs: s.blobs,
    dataRoot: s.config.dataRoot,
    llm: s.config.llm,
    approvals: auth,
    jobs: s.jobs,
    ...(engineLayout !== undefined ? { engineLayout } : {}),
    designerOptions: { live: true },
  });
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'strategy-design 测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const tree = testTree();
  const persisted = persistObjectTreeArtifact({ db: s.db, blobs: s.blobs }, task.id, tree);
  const a52 = createStone(s, { sku: 'A52', sizeMm: 3, rgb: [200, 40, 40], family: '红色系' }).resourceId;
  const j51 = createStone(s, { sku: 'J51', sizeMm: 2, rgb: [240, 240, 232], family: '白色系' }).resourceId;
  const candidates: StoneCandidate[] = [
    { idx: 1, pick: { resourceId: a52, sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }, family: '红色系' },
    { idx: 2, pick: { resourceId: j51, sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#F0F0E8' }, family: '白色系' },
  ];
  return {
    s,
    auth,
    registry,
    sessionId,
    taskId: task.id,
    treeArtifactRef: persisted.treeBlobRef,
    tree,
    candidates,
    j51,
    a52,
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
    dispose: () => s.dispose(),
  };
}

async function okOf(result: unknown): Promise<Record<string, unknown>> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: Record<string, unknown> }).value;
}

/** 工具全链 propose（默认应答脚本）。 */
async function proposeViaTool(f: Fixture, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return okOf(
    await f.registry.call(
      STRATEGY_DESIGN_TOOL_NAME,
      { taskId: f.taskId, treeArtifactRef: f.treeArtifactRef, ...overrides },
      'agent',
    ),
  );
}

async function capture(p: Promise<unknown>): Promise<StrategyDesignError> {
  const error = (await p.catch((e: unknown) => e)) as StrategyDesignError;
  expect(error).toBeInstanceOf(StrategyDesignError);
  return error;
}

/** 同步捕获 StrategyDesignError（纯函数校验链断言用）。 */
function captureSync(fn: () => unknown): StrategyDesignError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StrategyDesignError);
    return error as StrategyDesignError;
  }
  throw new Error('应抛 StrategyDesignError（未抛——校验链漏防）');
}

// ---------------------------------------------------------------- 纯函数面

describe('extractJsonText（scene-analyze 同构容错）', () => {
  it('裸/fenced/前后缀噪声三形态', () => {
    expect(extractJsonText('  {"a":1}  ')).toBe('{"a":1}');
    expect(extractJsonText('```json\n{"assignments":[]}\n```')).toBe('{"assignments":[]}');
    expect(extractJsonText('好的：\n{"assignments":[]}\n以上。')).toBe('{"assignments":[]}');
  });
});

describe('STRATEGY_FAMILY_GUIDES 完备性（registry 七值一一对应）', () => {
  it('键集 === STRATEGY_KINDS（新策略族入表纪律）', () => {
    expect([...new Set(Object.keys(STRATEGY_FAMILY_GUIDES))].sort()).toEqual([...STRATEGY_KINDS].sort());
    for (const kind of STRATEGY_KINDS) {
      expect(STRATEGY_FAMILY_GUIDES[kind].summary.length).toBeGreaterThan(4);
      expect(STRATEGY_FAMILY_GUIDES[kind].params.length).toBeGreaterThan(4);
    }
  });
});

describe('buildStrategyDesignPrompt（纯函数——上下文装配面）', () => {
  const tree = testTree();
  const candidates: StoneCandidate[] = [
    { idx: 1, pick: { resourceId: 'r-a52', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }, family: '红色系' },
    { idx: 2, pick: { resourceId: 'r-j51', sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#F0F0E8' }, family: '白色系' },
    { idx: 3, pick: { resourceId: 'r-x99', sku: 'X99', supplier: 'yuhang', sizeMm: null, colorHex: '#101010' }, family: '黑色系' },
  ];

  it('可贴/层级节点双清单+候选表（无尺寸标注）+策略族+风格/指令注入', () => {
    const prompt = buildStrategyDesignPrompt({
      tree,
      candidates,
      styleHint: '卡通暖色风',
      instruction: '把这棵柳树按枝条贴',
    });
    // 可贴节点：n1/n2（叶）在清单；n0（中间 drillWorthy=false）入层级清单。
    expect(prompt).toContain('- n1 柳树·枝条（父：柳树） [foliage]');
    expect(prompt).toContain('- n2 柳树·花朵（父：柳树） [flower]');
    expect(prompt).toContain('层级节点清单');
    expect(prompt).toContain('- n0 柳树 [foliage]');
    // 判据物理量随行走（design §2 数据面）。
    expect(prompt).toContain('有效尺寸 44.7mm');
    // 候选表：idx+限定名+尺寸（null 显式「无尺寸」）+色。
    expect(prompt).toContain('- 1 yuhang/A52 3mm #C82828 红色系');
    expect(prompt).toContain('- 3 yuhang/X99 无尺寸 #101010 黑色系');
    // 七策略族全列。
    for (const kind of STRATEGY_KINDS) {
      expect(prompt).toContain(`- ${kind}：${STRATEGY_FAMILY_GUIDES[kind].summary}`);
    }
    // 密度约束（P3.3-fix 偏差 2：引擎委派乘数=密度/2.3 须 ≤1——prompt 明示上限）。
    expect(prompt).toContain('密度建议范围 0.5-2.3 颗/cm²（2.3=满铺基线上限');
    // 风格与指令。
    expect(prompt).toContain('风格提示：卡通暖色风');
    expect(prompt).toContain('补充指令：把这棵柳树按枝条贴');
    expect(prompt).toContain('styleId 未给');
  });

  it('styleId 透传（词表空缺省——接口位冻结）', () => {
    const prompt = buildStrategyDesignPrompt({ tree, candidates, styleId: 'impressionism-v1' });
    expect(prompt).toContain('风格词表键 styleId=impressionism-v1（词表暂空——仅透传');
  });

  it('确定性：同上下文同文本（快照锚）', () => {
    const a = buildStrategyDesignPrompt({ tree, candidates });
    const b = buildStrategyDesignPrompt({ tree, candidates });
    expect(a).toBe(b);
    expect(a).toMatchSnapshot();
  });
});

// ---------------------------------------------------------------- 候选投影

describe('projectStoneCandidates（S1 投影+S7 组合投影）', () => {
  it('全量+supplier/family 过滤', () => {
    const f = setup();
    try {
      const all = projectStoneCandidates({ db: f.s.db, blobs: f.s.blobs }, { ownerId: f.s.anonymous.id });
      expect(all.candidates.map((c) => c.pick.sku)).toEqual(['A52', 'J51']);
      expect(all.casBinding).toBeUndefined();
      const red = projectStoneCandidates(
        { db: f.s.db, blobs: f.s.blobs },
        { ownerId: f.s.anonymous.id, filter: { family: '红色系' } },
      );
      expect(red.candidates.map((c) => c.pick.sku)).toEqual(['A52']);
      // 供应商无匹配=空候选 typed 拒（stone-filter-empty——不静默空 palette）。
      expect(captureSync(() =>
        projectStoneCandidates({ db: f.s.db, blobs: f.s.blobs }, { ownerId: f.s.anonymous.id, filter: { supplier: 'nope' } }),
      ).kind).toBe('stone-filter-empty');
    } finally {
      f.dispose();
    }
  });

  it('activeSetId 组合投影：成员过滤+不可用成员明示+CAS 绑定', () => {
    const f = setup();
    try {
      const sets = new SetService({ db: f.s.db, blobs: f.s.blobs, stones: new StoneService({ db: f.s.db, blobs: f.s.blobs }) });
      const created = sets.createSet({
        ownerId: f.s.anonymous.id,
        name: '柳树套餐',
        members: [{ stoneRef: f.j51 }, { stoneRef: 'deadbeef-not-in-library' }],
        origin: { kind: 'manual-pick' },
      });
      const projection = projectStoneCandidates(
        { db: f.s.db, blobs: f.s.blobs },
        { ownerId: f.s.anonymous.id, filter: { activeSetId: created.resourceId } },
      );
      expect(projection.candidates.map((c) => c.pick.sku)).toEqual(['J51']);
      expect(projection.unavailableSetMembers).toEqual(['deadbeef-not-in-library']);
      expect(projection.casBinding).toEqual({ resourceId: created.resourceId, baseRevision: created.revision });
    } finally {
      f.dispose();
    }
  });

  it('空候选=typed stone-filter-empty', () => {
    const f = setup();
    try {
      const error = captureSync(() =>
        projectStoneCandidates({ db: f.s.db, blobs: f.s.blobs }, { ownerId: f.s.anonymous.id, filter: { family: '不存在色系' } }),
      );
      expect(error.kind).toBe('stone-filter-empty');
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- plan 装配校验

describe('assembleStrategyPlan（校验链——typed error 携节点+字段）', () => {
  const tree = testTree();
  const candidates: StoneCandidate[] = [
    { idx: 1, pick: { resourceId: 'r-a52', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }, family: '红色系' },
    { idx: 2, pick: { resourceId: 'r-j51', sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#F0F0E8' }, family: '白色系' },
    { idx: 3, pick: { resourceId: 'r-x99', sku: 'X99', supplier: 'yuhang', sizeMm: null, colorHex: '#101010' }, family: '黑色系' },
  ];

  function assemble(payload: unknown, styleId?: string) {
    const f = setup();
    try {
      return assembleStrategyPlan({
        tree,
        treeArtifactRef: 'a'.repeat(64),
        llmPayload: payload,
        candidates,
        ...(styleId !== undefined ? { styleId } : {}),
        blobs: f.s.blobs,
      });
    } finally {
      f.dispose();
    }
  }

  it('ok：stoneIdx 回填 StonePick+密度缺省 2.3+styleId 透传', () => {
    const { plan } = assemble(assignmentsPayload(), 'impressionism-v1');
    expect(plan.kind).toBe('strategy-plan');
    expect(plan.objectTreeRef).toBe('a'.repeat(64));
    expect(plan.styleId).toBe('impressionism-v1');
    expect(plan.assignments).toHaveLength(2);
    const n1 = plan.assignments[0]!;
    expect(n1).toMatchObject({ nodeId: 'n1', strategyKind: 'soft-curve' });
    expect(n1.stones).toEqual([candidates[1]!.pick]);
    expect(n1.densityPerCm2).toBe(2.3); // Owner 基线缺省
    expect(plan.assignments[1]!.densityPerCm2).toBe(3);
  });

  it('params 非法拒（registry 逐项——typed 携节点+字段路径）', () => {
    const error = captureSync(() =>
      assemble({
        assignments: [
          { nodeId: 'n1', strategyKind: 'texture-fill', params: { mode: 'bogus' }, stoneIdx: [2], rationale: 'r' },
          { nodeId: 'n2', strategyKind: 'exclusion', params: {}, rationale: 'r' },
        ],
      }),
    );
    expect(error.kind).toBe('plan-params-invalid');
    expect(error.message).toContain('n1');
    expect(error.message).toContain('mode');
  });

  it('stoneIdx 幻觉拒 / 未知 nodeId 拒 / 层级节点拒 / 覆盖不完整拒 / 无尺寸拒', () => {
    expect(captureSync(() =>
      assemble({ assignments: [{ nodeId: 'n1', strategyKind: 'soft-curve', params: {}, stoneIdx: [9], rationale: 'r' }, { nodeId: 'n2', strategyKind: 'exclusion', params: {}, rationale: 'r' }] }),
    ).kind).toBe('plan-stone-invalid');
    expect(captureSync(() =>
      assemble({ assignments: [{ nodeId: 'ghost', strategyKind: 'exclusion', params: {}, rationale: 'r' }, { nodeId: 'n1', strategyKind: 'exclusion', params: {}, rationale: 'r' }, { nodeId: 'n2', strategyKind: 'exclusion', params: {}, rationale: 'r' }] }),
    ).kind).toBe('plan-node-unknown');
    expect(captureSync(() =>
      assemble({ assignments: [{ nodeId: 'n0', strategyKind: 'exclusion', params: {}, rationale: 'r' }, { nodeId: 'n1', strategyKind: 'exclusion', params: {}, rationale: 'r' }, { nodeId: 'n2', strategyKind: 'exclusion', params: {}, rationale: 'r' }] }),
    ).message).toContain('n0 是层级节点');
    expect(captureSync(() =>
      assemble({ assignments: [{ nodeId: 'n1', strategyKind: 'soft-curve', params: {}, stoneIdx: [2], rationale: 'r' }] }),
    ).kind).toBe('plan-coverage-incomplete');
    expect(captureSync(() =>
      assemble({ assignments: [{ nodeId: 'n1', strategyKind: 'soft-curve', params: {}, stoneIdx: [3], rationale: 'r' }, { nodeId: 'n2', strategyKind: 'exclusion', params: {}, rationale: 'r' }] }),
    ).kind).toBe('plan-stone-unsized');
  });

  it('exclusion 无 stoneIdx 合法（空数组=仅排除——schema 注释语义）', () => {
    const { plan } = assemble({
      assignments: [
        { nodeId: 'n1', strategyKind: 'soft-curve', params: {}, stoneIdx: [2], rationale: 'r' },
        { nodeId: 'n2', strategyKind: 'exclusion', params: { reason: '花朵留白' }, rationale: 'r' },
      ],
    });
    expect(plan.assignments[1]!.stones).toEqual([]);
  });

  it('free-code 工件化：codeArtifactRef 必携带+CodeStrategyArtifact 形状+declaredApiCalls 提取', () => {
    const f = setup();
    try {
      const { plan } = assembleStrategyPlan({
        tree,
        treeArtifactRef: 'a'.repeat(64),
        llmPayload: {
          assignments: [
            { nodeId: 'n1', strategyKind: 'free-code', params: { source: FREE_CODE_SOURCE, seed: 7 }, stoneIdx: [2], rationale: '自写排钻' },
            { nodeId: 'n2', strategyKind: 'exclusion', params: {}, rationale: 'r' },
          ],
        },
        candidates,
        blobs: f.s.blobs,
      });
      const assignment = plan.assignments[0]!;
      expect(assignment.codeArtifactRef).toMatch(/^[0-9a-f]{64}$/);
      const bytes = f.s.blobs.read(assignment.codeArtifactRef!);
      expect(bytes).not.toBeNull();
      const artifact = CodeStrategyArtifactSchema.parse(JSON.parse(bytes!.toString('utf8'))) as CodeStrategyArtifact;
      expect(artifact).toMatchObject({ kind: 'free-code-artifact', language: 'javascript', entryPoint: 'layout', seed: 7 });
      expect(artifact.declaredApiCalls).toEqual(['sandbox.gem']);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- designer propose 链

describe('StrategyDesigner（LLM 路由 mock 网关——无 key 测试策略）', () => {
  it('propose 全链：prompt 线面（纯文本+temperature 0）+plan+留存', async () => {
    const gw = await startMockGateway(() => ({ text: JSON.stringify(assignmentsPayload()) }));
    const f = setup(undefined, gw.port);
    try {
      const designer = new StrategyDesigner(
        { db: f.s.db, blobs: f.s.blobs, dataRoot: f.s.config.dataRoot, llm: f.s.config.llm },
        { live: true },
      );
      const outcome = await designer.design({
        taskId: f.taskId,
        treeArtifactRef: f.treeArtifactRef,
        styleHint: '卡通暖色风',
        instruction: '把这棵柳树按枝条贴',
      });
      expect(outcome.draft.plan.assignments).toHaveLength(2);
      expect(outcome.draft.meta.model).toBe('glm-5.3-flash');
      // 线面断言：单条 user 消息=纯文本 prompt（无视觉 content parts）+确定性温度。
      expect(gw.requests).toHaveLength(1);
      const sent = JSON.parse(gw.requests[0]!) as {
        model: string;
        temperature: number;
        stream: boolean;
        max_tokens: number;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(sent.model).toBe('glm-5.3-flash');
      expect(sent.temperature).toBe(0);
      expect(sent.stream).toBe(false);
      expect(sent.max_tokens).toBeLessThanOrEqual(16384);
      expect(typeof sent.messages[0]!.content).toBe('string');
      const prompt = sent.messages[0]!.content as string;
      // 上下文装配断言：树+候选+风格+指令进 prompt（真源在 daemon——LLM 只产指派）。
      expect(prompt).toContain('n1 柳树·枝条');
      expect(prompt).toContain('yuhang/A52');
      expect(prompt).toContain('卡通暖色风');
      expect(prompt).toContain('把这棵柳树按枝条贴');
      // 留存（无 apiKey；responseText 可审查）。
      const retained = JSON.parse(readFileSync(outcome.retention.exchangeJson, 'utf8')) as Record<string, unknown>;
      expect(retained['outcome']).toBe('ok');
      expect(JSON.stringify(retained)).not.toContain('mock-gateway-key');
    } finally {
      await gw.stop();
      f.dispose();
    }
  });

  it('fenced JSON 容错；坏 JSON/HTTP 坏 typed 拒（留存记录失败面）', async () => {
    const gw2 = await startMockGateway(() => ({ text: '```json\n' + JSON.stringify(assignmentsPayload()) + '\n```' }));
    const f2 = setup(undefined, gw2.port);
    try {
      const designer = new StrategyDesigner(
        { db: f2.s.db, blobs: f2.s.blobs, dataRoot: f2.s.config.dataRoot, llm: f2.s.config.llm },
        { live: true },
      );
      const outcome = await designer.design({ taskId: f2.taskId, treeArtifactRef: f2.treeArtifactRef });
      expect(outcome.draft.plan.assignments).toHaveLength(2);
    } finally {
      await gw2.stop();
      f2.dispose();
    }
    const gw3 = await startMockGateway(() => ({ text: '这不是 JSON' }));
    const f3 = setup(undefined, gw3.port);
    try {
      const designer = new StrategyDesigner(
        { db: f3.s.db, blobs: f3.s.blobs, dataRoot: f3.s.config.dataRoot, llm: f3.s.config.llm },
        { live: true },
      );
      const error = await capture(designer.design({ taskId: f3.taskId, treeArtifactRef: f3.treeArtifactRef }));
      expect(error.kind).toBe('llm-bad-json');
      // 失败留存（outcome=error:llm-bad-json——可审查面；不含 key）。
      const logsDir = path.join(f3.s.config.dataRoot, 'strategy-design-logs');
      const files = readdirSync(logsDir, { recursive: true }).map(String).filter((name) => name.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(1);
      const retained = JSON.parse(readFileSync(path.join(logsDir, files[0]!), 'utf8')) as Record<string, unknown>;
      expect(retained['outcome']).toBe('error:llm-bad-json');
      expect(JSON.stringify(retained)).not.toContain('mock-gateway-key');
    } finally {
      await gw3.stop();
      f3.dispose();
    }
    const gw4 = await startMockGateway(() => ({ status: 503, body: 'upstream down' }));
    const f4 = setup(undefined, gw4.port);
    try {
      const designer = new StrategyDesigner(
        { db: f4.s.db, blobs: f4.s.blobs, dataRoot: f4.s.config.dataRoot, llm: f4.s.config.llm },
        { live: true },
      );
      const error = await capture(designer.design({ taskId: f4.taskId, treeArtifactRef: f4.treeArtifactRef }));
      expect(error.kind).toBe('llm-call-failed');
      expect(error.message).toContain('503');
    } finally {
      await gw4.stop();
      f4.dispose();
    }
  });

  it('live 门（缺省 mock=live-disabled）与无 key（llm-route-unconfigured）', async () => {
    const gw = await startMockGateway(() => ({ text: JSON.stringify(assignmentsPayload()) }));
    const f = setup(undefined, gw.port);
    try {
      const designer = new StrategyDesigner({ db: f.s.db, blobs: f.s.blobs, dataRoot: f.s.config.dataRoot, llm: f.s.config.llm });
      const error = await capture(designer.design({ taskId: f.taskId, treeArtifactRef: f.treeArtifactRef }));
      expect(error.kind).toBe('live-disabled');
      expect(error.message).toContain(STRATEGY_DESIGN_LIVE_ENV);
      // 无 key：路由未配置先行（live 判定之前）。
      f.s.config.llm.apiKey = '';
      const noKey = new StrategyDesigner({ db: f.s.db, blobs: f.s.blobs, dataRoot: f.s.config.dataRoot, llm: f.s.config.llm }, { live: true });
      const error2 = await capture(noKey.design({ taskId: f.taskId, treeArtifactRef: f.treeArtifactRef }));
      expect(error2.kind).toBe('llm-route-unconfigured');
      expect(gw.requests).toHaveLength(0); // 零真实外呼
    } finally {
      await gw.stop();
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- 工具面授权（照 capability-sets 同构）

describe('strategy.design 授权面（双模——零新授权语义）', () => {
  it('无授权直调必拒（执行面无 proposal/无 grant=principal-forbidden）+未装配桥同拒', async () => {
    const f = setup();
    try {
      const denied = await f.registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: f.taskId, proposalId: 'nope' }, 'agent');
      expect(denied).toMatchObject({ kind: 'denied', reason: 'principal-forbidden', requestedOperation: STRATEGY_DESIGN_TOOL_NAME });
      const bare = createServices(undefined, { imgDryRun: true });
      try {
        const registry = createStrategyDesignCapabilities({
          db: bare.db,
          blobs: bare.blobs,
          dataRoot: bare.config.dataRoot,
          llm: bare.config.llm,
        });
        const denied2 = await registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: 't', treeArtifactRef: 'a'.repeat(64) }, 'agent');
        expect(denied2).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
      } finally {
        bare.dispose();
      }
    } finally {
      f.dispose();
    }
  });
});

describe('strategy.design 全链（propose→approve→execute）', () => {
  it('propose：指派表 diff 预览+approval-request 帧；批准前库内零变更', async () => {
    const gw = await startMockGateway(() => ({ text: JSON.stringify(assignmentsPayload()) }));
    const f = setup(undefined, gw.port);
    try {
      const proposed = await proposeViaTool(f, { styleHint: '卡通暖色风' });
      expect(proposed['proposalId']).toBeTruthy();
      expect(proposed['expiresAt']).toBeTruthy();
      const preview = proposed['preview'] as Record<string, unknown>;
      const table = preview['assignments'] as Array<Record<string, unknown>>;
      expect(table).toHaveLength(2);
      expect(table[0]).toMatchObject({ nodeId: 'n1', objectName: '柳树·枝条', strategyKind: 'soft-curve', densityPerCm2: 2.3 });
      expect((table[0]!['stones'] as Array<Record<string, unknown>>)[0]).toMatchObject({ sku: 'J51', sizeMm: 2 });
      expect(preview['candidateCount']).toBe(2);
      const request = f.frames().find((frame) => frame['kind'] === 'approval-request') as Record<string, unknown>;
      expect(request).toBeTruthy();
      const payload = request['payload'] as Record<string, unknown>;
      expect(payload).toMatchObject({ tool: STRATEGY_DESIGN_TOOL_NAME, proposalId: proposed['proposalId'] });
      // 批准前零变更：无 artifact 帧入流（三工件归执行）；proposal 行恰 1。
      expect(f.frames().some((frame) => frame['kind'] === 'artifact')).toBe(false);
      expect((f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n).toBe(1);
    } finally {
      await gw.stop();
      f.dispose();
    }
  });

  it('execute：逐节点执行+三工件落档+gems 全部掩膜内；grant 重放必拒', async () => {
    // n1 显式 engineStrategy（真引擎委派——kernel strategyEngineDelegate 集成位）+
    // n2 texture-fill（registry 原生执行面）——adapter 契约两通道同链覆盖。
    const payload = {
      assignments: [
        { nodeId: 'n1', strategyKind: 'straight-line', params: {}, stoneIdx: [2], engineStrategy: 'hex-pitch', rationale: '枝条显式引擎路由' },
        { nodeId: 'n2', strategyKind: 'texture-fill', params: { mode: 'scatter', polarity: 'dark-dense' }, stoneIdx: [1], densityPerCm2: 3, rationale: '花朵面状纹理打底' },
      ],
    };
    const gw = await startMockGateway(() => ({ text: JSON.stringify(payload) }));
    const f = setup(strategyEngineDelegate, gw.port);
    try {
      const proposed = await proposeViaTool(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
      const executed = await okOf(
        await f.registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] }, 'agent'),
      );
      const gemCount = executed['gemCount'] as number;
      expect(gemCount).toBeGreaterThan(0);
      const gemsBlobRef = executed['gemsBlobRef'] as string;
      const planBlobRef = executed['planBlobRef'] as string;
      const previewBlobRef = executed['previewBlobRef'] as string;
      // plan 工件 round-trip。
      const planDoc = JSON.parse(f.s.blobs.read(planBlobRef)!.toString('utf8'));
      expect(planDoc).toMatchObject({ kind: 'strategy-plan', objectTreeRef: f.treeArtifactRef });
      // gems 工件：planRef 溯源锚+全部钻掩膜内（程序化像素判定——不凭视觉）。
      const gemsDoc = JSON.parse(f.s.blobs.read(gemsBlobRef)!.toString('utf8'));
      expect(gemsDoc).toMatchObject({ kind: 'strategy-gems', planRef: planBlobRef });
      const nodeById = new Map(f.tree.nodes.map((node) => [node.id, node] as const));
      for (const gem of gemsDoc['gems'] as Array<{ blockId: string; x: number; y: number }>) {
        const node = nodeById.get(gem.blockId)!;
        expect(gem.x).toBeGreaterThanOrEqual(node.bbox.x);
        expect(gem.x).toBeLessThan(node.bbox.x + node.bbox.w);
        expect(gem.y).toBeGreaterThanOrEqual(node.bbox.y);
        expect(gem.y).toBeLessThan(node.bbox.y + node.bbox.h);
      }
      // 叠加预览 PNG：尺寸锚点+可解码。
      const png = f.s.blobs.read(previewBlobRef)!;
      const decoded = decodePng(png);
      expect(decoded.width).toBe(100);
      expect(decoded.height).toBe(80);
      // execute 三工件 artifact 帧登记（P3.3-fix：tasks.artifact 合法集=帧∪附件——
      // 名字/blobRef 命中，帧序=plan→gems→preview）。
      const artifactFrames = f
        .frames()
        .filter((frame) => frame['kind'] === 'artifact')
        .map((frame) => frame['payload'] as { blobRef: string; name: string });
      expect(artifactFrames).toEqual([
        { blobRef: planBlobRef, name: 'strategy-plan.json' },
        { blobRef: gemsBlobRef, name: 'strategy-gems.json' },
        { blobRef: previewBlobRef, name: 'strategy-gems-preview.png' },
      ]);
      // op 终态 succeeded+resultRef=gems 工件。
      const op = f.auth.opOf(proposed['proposalId'] as string) as { state: string; result_ref: string | null };
      expect(op.state).toBe('succeeded');
      expect(op.result_ref).toBe(gemsBlobRef);
      // 重放必拒（grant 已消费）。
      const replay = await f.registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] }, 'agent');
      expect(replay).toMatchObject({ kind: 'failed' });
      expect((replay as { message: string }).message).toContain('已消费');
    } finally {
      await gw.stop();
      f.dispose();
    }
  });

  it('gems 校验门：engine 委派注入缝的越界钻剔除（间距/掩膜——P1.4 gate 复用）', async () => {
    const payload = {
      assignments: [
        { nodeId: 'n1', strategyKind: 'exclusion', params: {}, rationale: 'r' },
        { nodeId: 'n2', strategyKind: 'straight-line', params: {}, stoneIdx: [1], engineStrategy: 'hex-pitch', rationale: '显式引擎路由' },
      ],
    };
    const gw = await startMockGateway(() => ({ text: JSON.stringify(payload) }));
    // 注入缝替身：一颗掩膜内 (70,40) + 一颗越界 (10,10)（n2 mask x∈[60,100)——gate 应剔除后者）。
    const engineLayout: EngineLayoutDelegate = () => ({
      gems: [
        { x: 70, y: 40, diameterMm: 3 },
        { x: 10, y: 10, diameterMm: 3 },
      ],
      dropped: 0,
    });
    const f = setup(engineLayout, gw.port);
    try {
      const proposed = await proposeViaTool(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
      const executed = await okOf(
        await f.registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] }, 'agent'),
      );
      expect(executed['gemCount']).toBe(1);
      const warnings = executed['warnings'] as Array<{ kind: string; detail: string }>;
      expect(warnings.some((w) => w.kind === 'mask' && w.detail.includes('n2'))).toBe(true);
      const summaries = executed['nodeSummaries'] as Array<Record<string, unknown>>;
      expect(summaries[1]!).toMatchObject({ nodeId: 'n2', gemCount: 1, culled: 1, engineDelegation: { strategy: 'hex-pitch', reason: 'explicit' } });
    } finally {
      await gw.stop();
      f.dispose();
    }
  });

  it('free-code 全链：沙箱真执行（同 seed 回放）+exclusion 未贴区注记', async () => {
    const payload = {
      assignments: [
        { nodeId: 'n1', strategyKind: 'free-code', params: { source: FREE_CODE_SOURCE, seed: 7 }, stoneIdx: [2], rationale: '自写排钻' },
        { nodeId: 'n2', strategyKind: 'exclusion', params: { reason: '花朵留白' }, rationale: 'r' },
      ],
    };
    const gw = await startMockGateway(() => ({ text: JSON.stringify(payload) }));
    const f = setup(undefined, gw.port);
    try {
      const proposed = await proposeViaTool(f);
      // free-code 指派携带 codeArtifactRef（contracts 契约——预览面可见）。
      const preview = proposed['preview'] as Record<string, unknown>;
      const table = preview['assignments'] as Array<Record<string, unknown>>;
      expect(table[0]!['codeArtifactRef']).toMatch(/^[0-9a-f]{64}$/);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
      const executed = await okOf(
        await f.registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] }, 'agent'),
      );
      expect(executed['gemCount']).toBe(5); // FREE_CODE_SOURCE 固定 5 颗（同 seed 确定性）
      const excluded = executed['excludedRegions'] as Array<Record<string, unknown>>;
      expect(excluded).toHaveLength(1);
      expect(excluded[0]).toMatchObject({ nodeId: 'n2', reason: '花朵留白' });
      // 同 seed 回放：重发同 payload → 同 gems（内容寻址 plan 不同因 createdAt，但 gems 集一致）。
      const replay = await proposeViaTool(f);
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: replay['requestId'] as string, approved: true });
      const executed2 = await okOf(
        await f.registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: f.taskId, proposalId: replay['proposalId'] }, 'agent'),
      );
      expect(executed2['gemCount']).toBe(5);
      const gems1 = JSON.parse(f.s.blobs.read(executed['gemsBlobRef'] as string)!.toString('utf8'))['gems'] as Array<{ x: number; y: number }>;
      const gems2 = JSON.parse(f.s.blobs.read(executed2['gemsBlobRef'] as string)!.toString('utf8'))['gems'] as Array<{ x: number; y: number }>;
      expect(gems2.map((g) => `${g.x},${g.y}`).sort()).toEqual(gems1.map((g) => `${g.x},${g.y}`).sort());
    } finally {
      await gw.stop();
      f.dispose();
    }
  });

  it('activeSetId：组合投影进 prompt（候选限定成员）+批准期间组合被改=CAS 漂移必拒', async () => {
    const gw = await startMockGateway(() => ({ text: JSON.stringify(assignmentsPayload()) }));
    const f = setup(undefined, gw.port);
    try {
      const setService = new SetService({ db: f.s.db, blobs: f.s.blobs, stones: new StoneService({ db: f.s.db, blobs: f.s.blobs }) });
      const created = setService.createSet({
        ownerId: f.s.anonymous.id,
        name: '柳树套餐',
        members: [{ stoneRef: f.a52 }, { stoneRef: f.j51 }],
        origin: { kind: 'manual-pick' },
      });
      const proposed = await proposeViaTool(f, { stoneFilter: { activeSetId: created.resourceId } });
      // prompt 候选=组成员（同款两 stone——全量投影一致；组合投影经 prompt 生效）。
      const sent = JSON.parse(gw.requests[0]!) as { messages: Array<{ content: string }> };
      expect(sent.messages[0]!.content).toContain('yuhang/A52');
      // CAS 绑定：批准期间组合被改（成员变更→revision 前进）→ 执行漂移必拒。
      f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
      setService.updateSet(created.resourceId, { name: '柳树套餐-改' }, { baseRevision: created.revision });
      const stale = await f.registry.call(STRATEGY_DESIGN_TOOL_NAME, { taskId: f.taskId, proposalId: proposed['proposalId'] }, 'agent');
      expect(stale).toMatchObject({ kind: 'failed', code: 'STALE' });
      expect((stale as { message: string }).message).toContain('版本漂移');
    } finally {
      await gw.stop();
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- 渲染纯函数

describe('renderGemsOverlay（P0.4 preview 同款纯像素纪律）', () => {
  it('确定性+底色/钻色/对比度环/节点框像素断言', () => {
    const input = {
      imagePx: { width: 20, height: 10 },
      nodes: [{ bbox: { x: 2, y: 2, w: 10, h: 6 }, drillWorthy: true }],
      gems: [
        // 直径 8px（radius 4）：外环对比度环色（radius≤4）+内芯渲染色（≤3）
        { x: 6, y: 5, diameterPx: 8, colorRgb: [255, 0, 0] as [number, number, number] },
      ],
    };
    const a = renderGemsOverlay(input);
    const b = renderGemsOverlay(input);
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
    const decoded = decodePng(a);
    expect(decoded.width).toBe(20);
    const px = (x: number, y: number): [number, number, number] => [
      decoded.rgba[(y * 20 + x) * 4]!,
      decoded.rgba[(y * 20 + x) * 4 + 1]!,
      decoded.rgba[(y * 20 + x) * 4 + 2]!,
    ];
    // 底色=浅灰（§10 回流 5：非纯白）；钻心=渲染色；外环=对比度环色；节点框=绿。
    expect(px(0, 0)).toEqual([235, 235, 235]);
    expect(px(6, 5)).toEqual([255, 0, 0]);
    // 环带：|dx|=4, dy=0（距心 4——radius 内、inner(3) 外）
    expect(px(10, 5)).toEqual([64, 64, 64]);
    expect(px(2, 4)).toEqual([0, 180, 0]);
  });

  it('回归（走查实证 2026-09-26）：白钻 #F0F0E8 在浅灰底上不可辨——对比度环保证钻可见（产物非平凡：唯一色>阈值）', () => {
    // 真环境走查产物：journey-clown-real-20260926 strategy-gems-preview.png 唯一色 4——
    // 1888 颗全数已画（#F0F0E8≈77951px）但与底色 [235,235,235] ΔRGB≤5 肉眼不可辨
    //（「渲染产物空」误判根因）。修复=每颗钻盘带深灰对比度环——任何石色均可见。
    const stone = [240, 240, 232] as [number, number, number]; // #F0F0E8
    const width = 736;
    const height = 736;
    const gems = Array.from({ length: 40 }, (_, i) => ({
      x: 50 + (i % 10) * 60,
      y: 50 + Math.floor(i / 10) * 60,
      diameterPx: 2 * 3.68, // 2mm 钻 × ppm 3.68（走查同尺寸）
      colorRgb: stone,
    }));
    // 节点框在场（走查同形态——修复前唯一色恰 4：底色+绿框+红框+隐形石色）
    const nodes = [
      { bbox: { x: 40, y: 40, w: 600, h: 240 }, drillWorthy: true },
      { bbox: { x: 40, y: 300, w: 600, h: 240 }, drillWorthy: false },
    ];
    const png = renderGemsOverlay({ imagePx: { width, height }, nodes, gems });
    const decoded = decodePng(png);
    // 唯一色 > 4（底色+环+石芯——环色入场打破「仅底色系」的空产物形态）
    const colors = new Set<string>();
    // 可见像素（与底色总 ΔRGB ≥ 120——环色 [64,64,64] vs [235,235,235] Δ=513）
    let visible = 0;
    for (let p = 0; p < width * height; p++) {
      const r = decoded.rgba[p * 4]!;
      const g = decoded.rgba[p * 4 + 1]!;
      const b = decoded.rgba[p * 4 + 2]!;
      colors.add(`${r},${g},${b}`);
      if (Math.abs(r - 235) + Math.abs(g - 235) + Math.abs(b - 235) >= 120) visible += 1;
    }
    expect(colors.size).toBeGreaterThan(4);
    // 每颗钻盘半径 ceil(3.68)=4 → 环像素可观：40 颗 × ≥30 可见像素/颗
    expect(visible).toBeGreaterThan(40 * 30);
    // 石芯色仍在场（渲染色语义保留——环是描边不是替换）
    expect(colors.has('240,240,232')).toBe(true);
  });

  it('NaN 坐标防御：非有限坐标钻被丢弃（不炸渲染、不污染像素面）', () => {
    const png = renderGemsOverlay({
      imagePx: { width: 8, height: 8 },
      nodes: [],
      gems: [
        { x: Number.NaN, y: 4, diameterPx: 4, colorRgb: [255, 0, 0] as [number, number, number] },
        { x: 4, y: Number.NaN, diameterPx: 4, colorRgb: [255, 0, 0] as [number, number, number] },
        { x: 4, y: 4, diameterPx: 4, colorRgb: [255, 0, 0] as [number, number, number] },
      ],
    });
    const decoded = decodePng(png);
    const px = (x: number, y: number): string =>
      `${decoded.rgba[(y * 8 + x) * 4]},${decoded.rgba[(y * 8 + x) * 4 + 1]},${decoded.rgba[(y * 8 + x) * 4 + 2]}`;
    expect(px(4, 4)).toBe('255,0,0'); // 有限坐标钻照常渲染
    expect(px(0, 0)).toBe('235,235,235'); // 底色未被 NaN 写污染
  });
});

// ---------------------------------------------------------------- 注册面

describe('注册面（MCP 投影+deny 名单存活）', () => {
  it('工具名投影 mcp__studio__strategy_design——productToolDenyList 不收窄', () => {
    expect(mcpToolName(STRATEGY_DESIGN_TOOL_NAME)).toBe('strategy_design');
    const denied = productToolDenyList(['bash', 'mcp__studio__strategy_design', 'ask_user_question']);
    expect(denied).toEqual(['bash']);
  });
});
