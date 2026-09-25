/**
 * 自由代码族沙箱测试（add-subject-sam-pipeline P1.4——design §4.4/§8+tasks.md P1.4，
 * **评审重点面**）。覆盖（对 worker.cjs 头注逃逸面枚举清单逐条对齐）：
 *
 * [逃逸面负测试] E1 constructor 链（含 async/generator 变体）/E2 this 全局（strict=undefined）/
 * E3 eval+new Function/E4 动态 import()（含注释遮蔽形态——双层 screen）/E5 require 字面量/
 * E6 process 探测/E7 异常堆栈泄漏（name+message 出境，stack 永不出境）/E8 原型污染+
 * sandbox 篡改（null-proto+frozen strict 抛）/E9 循环 DoS（墙钟界 terminate）/E10 计时器
 * 面不可达/E11 函数+循环引用走私（结构化克隆拒+估算预拒）。
 *
 * [有界性三线] CPU 界=几何库调用计数（超限 soft-kill 携调用数）/墙钟界=主线程 race
 * terminate（真 worker 实测，短界 150-300ms）/内存界=结果数组长度上限（密度×面积×4）+
 * postMessage 体积上限+code 体积上限+OOM resourceLimits（worker-crash）。
 *
 * [输出校验链] Zod 逐颗（缺字段/未知键/非数值/shapeId 越枚举/非数组拒）→强制引擎校验门
 * （间距违例颗剔除+warning/掩膜外颗剔除+warning/全灭=gate-empty typed error）→
 * KernelGem 规格强制（id 序/blockId/colorId=''/diameterMm=ctx 推导/shapeId 白名单）。
 *
 * [确定性回放] 同 code+同 seed 两跑逐颗相等；异 seed 改果（rand 生效）；
 * rng 与宿主 mulberry32 逐位同源（同构对拍）；geo 白名单投影与 geometryHelpers
 * 逐位对拍（dist/maskCentroid/inMask/resampleOpen/resampleClosed/enforceMinSpacing/heartOutline）。
 *
 * [注册接线] applyStrategy('free-code') 同步桥全链（真 worker）；SandboxFailureError
 * typed 载荷；inline/工件引用二选一 Zod；工件通道 P3 fail-fast；node/block id 防御；
 * worker 零泄漏（activeWorkerCount+drain 收尾——防 vitest worker 泄漏拖慢套件）。
 *
 * 标度：10 px/mm（PPM=10）+ 钻径 30px（3mm）+ 默认密度 2.3/cm²（同 geometry 测试）。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ObjectNodeSchema, encodeInlineMask, type ObjectNode } from '@handicraft/contracts';
import type { TreeBBox, TreeBlock, TreeMask2D } from '../src/kernel/vision/tree-to-blocks.js';
import { geometryHelpers } from '../src/kernel/strategies/geometry.js';
import { mulberry32 } from '../src/kernel/strategies/rng.js';
import { applyStrategy, createStrategyContext, type StrategyApplyInput, type StrategyContext } from '../src/kernel/strategies/registry.js';
import {
  FreeCodeParamsSchema,
  SandboxFailureError,
  freeCodeStrategy,
} from '../src/kernel/strategies/sandbox/free-code.js';
import { validateGemPlacement } from '../src/kernel/strategies/sandbox/gate.js';
import {
  SANDBOX_MAX_CODE_BYTES,
  SANDBOX_MIN_GEM_CAP,
  activeWorkerCount,
  defaultMaxGems,
  drainSandboxWorkers,
  runSandboxArtifact,
  runUserCode,
  screenUserCode,
  type SandboxRunOptions,
  type SandboxWorkerPayload,
} from '../src/kernel/strategies/sandbox/run.js';

const PPM = 10;
const GEM_PX = 30;

// ---------------------------------------------------------------- fixtures（同 geometry 测试形态）

function synthBlock(id: string, w: number, h: number, bit: (x: number, y: number) => boolean, bboxX = 100, bboxY = 100): TreeBlock {
  const bits = new Uint8Array(w * h);
  let areaPx = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bit(x, y)) {
        bits[y * w + x] = 1;
        areaPx++;
      }
    }
  }
  return {
    id,
    label: `合成/${id}`,
    mask: { w, h, bits },
    colorRgb: [128, 128, 128],
    areaPx,
    bbox: { x: bboxX, y: bboxY, w, h },
    widthPx: { max: Math.min(w, h), mean: Math.min(w, h) / 2 },
    suggested: 'fill',
    origin: {
      originBlockId: null,
      parentNodeId: null,
      nodeCategory: 'structure',
      drillWorthy: true,
      nodeOrigin: 'vlm+sam3',
      effectiveMm: 10,
      labVariance: 1,
      depth: 0,
      isLeaf: true,
      colorSource: 'fallback',
    },
  };
}

const solid = (w: number, h: number, bx = 100, by = 100) => synthBlock('n-solid', w, h, () => true, bx, by);
const disk = (w: number, h: number, cx: number, cy: number, r: number) =>
  synthBlock('n-disk', w, h, (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);

function nodeOf(block: TreeBlock): ObjectNode {
  return ObjectNodeSchema.parse({
    id: block.id,
    objectName: '合成节点',
    category: 'structure',
    mask: encodeInlineMask(block.mask.w, block.mask.h, block.mask.bits),
    bbox: block.bbox,
    parent: null,
    children: [],
    effectiveMm: 10,
    labVariance: 1,
    drillWorthy: true,
    origin: 'vlm+sam3',
  });
}

const canvas = (w: number, h: number) => ({
  px: { width: w, height: h },
  cm: { w: w / (PPM * 10), h: h / (PPM * 10) },
  pixelsPerMm: PPM,
});

const ctx: StrategyContext = createStrategyContext({ gemDiameterPx: GEM_PX });

function inputOf(block: TreeBlock): StrategyApplyInput {
  return { node: nodeOf(block), block, params: {}, canvas: canvas(2000, 2000) };
}

/** 低层载荷（runUserCode 直连——逃逸面观察 seam）。 */
function payloadOfBlock(block: TreeBlock, seed = 0): SandboxWorkerPayload {
  return {
    mask: { w: block.mask.w, h: block.mask.h, bits: block.mask.bits },
    bbox: block.bbox,
    scale: { pixelsPerMm: PPM, canvasCm: { w: 200, h: 200 } },
    gem: { diameterMm: GEM_PX / PPM, diameterPx: GEM_PX, shapeIds: ['round', 'square', 'drop', 'heart', 'marquise', 'custom'] },
    seed,
  };
}

/** 短界缺省（防慢测试：墙钟 300ms/预算 5k——按需覆写）。 */
const SHORT: SandboxRunOptions = { wallMs: 300, maxHelperCalls: 5_000 };

/** 用户代码返回沙箱语义值的直连 helper（screen 由 runUserCode 前置——测试用合法语法）。 */
async function evalInSandbox(code: string, block: TreeBlock, opts = SHORT, seed = 0) {
  return runUserCode(`function layout(sandbox){ ${code} }`, payloadOfBlock(block, seed), opts);
}

// 螺旋正常路径代码（几何库+rand 全注入面——§8 自由代码 fixture「合法 Gem 过门」形态）
const SPIRAL_CODE = `
function layout(sandbox) {
  const geo = sandbox.geo;
  const c = geo.maskCentroid();
  const rMax = geo.maskMaxRadius(c);
  const s = Math.max(sandbox.gem.diameterPx, sandbox.scale.pixelsPerMm * 10 / Math.sqrt(2.3));
  const pts = [];
  const turns = 6;
  const thetaMax = 2 * Math.PI * turns;
  const R = s * turns;
  for (let t = 0; t <= thetaMax; t += 0.05) {
    pts.push({ x: c.x + R * (t / thetaMax) * Math.cos(t), y: c.y + R * (t / thetaMax) * Math.sin(t) });
  }
  const spaced = geo.enforceMinSpacing(geo.resampleOpen(pts, s, sandbox.rand() * s), sandbox.gem.diameterPx * 0.999);
  return spaced.filter((p) => geo.inMask(p.x, p.y)).map((p) => ({ x: p.x, y: p.y }));
}
`;

// ---------------------------------------------------------------- 语法 screen（E4/E5/E6 前置）

describe('P1.4 语法 screen（双层防线——宿主层单源）', () => {
  it('import()/require(/process/eval(/globalThis/Function( 字面量全拒（携 token 名）', () => {
    expect(screenUserCode('return import("node:fs")')).toBe('import()');
    expect(screenUserCode('const fs = require("fs")')).toBe('require');
    expect(screenUserCode('return process.env')).toBe('process');
    expect(screenUserCode('return eval("1+1")')).toBe('eval');
    expect(screenUserCode('return globalThis.Math')).toBe('globalThis');
    expect(screenUserCode('return Function("return 1")()')).toBe('Function');
    expect(screenUserCode('return WebAssembly.Module')).toBe('WebAssembly');
    expect(screenUserCode('return Atomics.wait')).toBe('Atomics');
    expect(screenUserCode('const s = "processing data"')).toBe(null); // \b 不匹配 processing
  });

  it('注释遮蔽形态拒（import 注释 ( ——import 是关键字无法别名/拼接）；纯注释词面放行', () => {
    expect(screenUserCode('return import /*x*/ ("node:fs")')).toBe('import()');
    expect(screenUserCode('return import\n("node:fs")')).toBe('import()');
    expect(screenUserCode('// require("fs")\nreturn 1')).toBe(null); // 注释惰性——剥除后无调用面（screen 只判活代码）
  });

  it('合法代码放行（螺旋/心形/随机布点——无禁词）', () => {
    expect(screenUserCode(SPIRAL_CODE)).toBe(null);
    expect(screenUserCode('function layout(s){ return s.geo.heartOutline(1,1,16).map(p=>({x:p.x,y:p.y})) }')).toBe(null);
  });

  it('runSandboxArtifact 集成：import( 代码 → forbidden-syntax typed error（不 spawn）', async () => {
    const r = await runSandboxArtifact('function layout(s){ return import("node:fs").then(()=>[]) }', inputOf(solid(600, 600)), ctx, SHORT);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.stage === 'forbidden-syntax') {
      expect(r.error.token).toBe('import()');
      expect(r.userMessage).toContain('sandbox 注入面');
    } else {
      expect.unreachable('forbidden-syntax 断言失败');
    }
  });

  it('低层 runUserCode 亦拒（worker 双层防线第二层——同规则单源）', async () => {
    const r = await evalInSandbox('return import("node:fs")', solid(300, 300));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe('forbidden-syntax');
  });
});

// ---------------------------------------------------------------- 逃逸面负测试（worker.cjs 头注清单逐条）

describe('P1.4 逃逸面（worker 隔离+硬化——逐条验证「拒或不可达」）', () => {
  it('E1 constructor 链：(function(){}).constructor("return process.version")() → broken 抛（runtime typed error）', async () => {
    const r = await evalInSandbox(`try { return [(function(){}).constructor("return 1+1")()]; } catch (e) { return ['ESCAPED_VIA:' + e.message]; }`, solid(300, 300));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(String(r.raw)).toContain('逃逸面封禁'); // broken 桩消息——链已断
      expect(r.raw).toEqual(['ESCAPED_VIA:sandbox: 逃逸面封禁（自由代码仅可使用 sandbox 注入面）']); // 未求值成功
    }
  });

  it('E1 async/generator constructor 变体同断', async () => {
    const r = await evalInSandbox(`
      const out = [];
      try { out.push(String(Object.getPrototypeOf(async function(){}).constructor)) } catch (e) { out.push('async-ctor:' + e.message) }
      try { out.push(typeof Object.getPrototypeOf(function*(){}).constructor('yield 1')) } catch (e) { out.push('gen-ctor:' + e.message) }
      return [out.join('|')];`, solid(300, 300));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const s = String(r.raw);
      expect(s).toContain('逃逸面封禁'); // async Function.prototype.constructor → broken
      expect(s).toContain('gen-ctor');
    }
  });

  it('E2 this 全局：strict 强制下 this=undefined（sloppy 全局不可达）', async () => {
    const r = await evalInSandbox(`const g = (function(){ return this; })(); return [{ direct: typeof (function(){return this})(), viaCall: typeof g }];`, solid(300, 300));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.raw).toEqual([{ direct: 'undefined', viaCall: 'undefined' }]);
  });

  it('E3 eval/Function 字面量 → screen 拒（全局绑定另有 broken 桩——词面是唯一入口）', async () => {
    // 词面入口（eval(/Function(）被双层 screen 拒；词面之外的字符串→代码残面=constructor 链（E1 已断）
    // 间接 eval（(0,eval)(…) 绕开 eval( 词面 screen）→ 运行时 broken 桩兜住（双层防线实证）
    const a = await evalInSandbox("try { return [String((0,eval)('1+1'))]; } catch (e) { return ['EVAL_BROKEN:' + e.message]; }", solid(300, 300));
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.raw).toEqual(['EVAL_BROKEN:sandbox: 逃逸面封禁（自由代码仅可使用 sandbox 注入面）']);
    // 词面 eval( → 双层 screen 拒（forbidden-syntax）
    const a2 = await evalInSandbox("try { return [String(eval('1+1'))]; } catch (e) { return ['EVAL_BROKEN:' + e.message]; }", solid(300, 300));
    expect(a2.ok).toBe(false);
    if (!a2.ok) expect(a2.error.stage).toBe('forbidden-syntax');
    // Function 词面 → screen 拒（globalThis.Function 的 broken 桩为第二层——词面是唯一入口，
    // constructor 链残面由 E1 断：fn.constructor('return 1') → 逃逸面封禁）
    const b = await evalInSandbox("try { return [String((function(){}).constructor('return 1'))]; } catch (e) { return ['FN_BROKEN:' + e.message]; }", solid(300, 300));
    expect(b.ok).toBe(true);
    if (b.ok) expect(String(b.raw)).toContain('逃逸面封禁');
  });

  it('E5/E6 深度：require/process 词面被 screen 拒（唯一入口），原型链残面亦断', async () => {
    // 词面引用（require(…)/process.…）唯一入口=screen 拒（见 screen 组双层测试）；
    // 词面之外的原型残面：sandbox 图 null-proto + 函数 constructor 链断
    const r = await evalInSandbox(`
      const out = [];
      try { out.push('proto=' + Object.getPrototypeOf(sandbox)) } catch (e) { out.push('proto-err') }
      try { out.push('mask-proto=' + Object.getPrototypeOf(sandbox.mask)) } catch (e) { out.push('mask-proto-err') }
      try { out.push('ctor=' + String(sandbox.geo.dist.constructor)) } catch (e) { out.push('ctor:' + e.message) }
      try { out.push('at-ctor=' + String(sandbox.mask.at.constructor)) } catch (e) { out.push('at-ctor:' + e.message) }
      return [out.join('|')];`, solid(300, 300));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const v = String(r.raw);
      expect(v).toContain('proto=null'); // sandbox null-prototype
      expect(v).toContain('mask-proto=null');
      expect(v.match(/ctor=/g)?.length).toBe(2); // 两处 .constructor 均为 broken 桩（非 'function Function')
      expect(v).toContain('function sandboxEscapeSurface');
    }
  });

  it('E7 异常堆栈泄漏：用户 Error 只出境 name+message，stack/worker 路径不出境', async () => {
    const r = await runSandboxArtifact('function layout(s){ throw new Error("boom-marker") }', inputOf(solid(300, 300)), ctx, SHORT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.stage).toBe('runtime');
      if (r.error.stage === 'runtime') {
        expect(r.error.name).toBe('Error');
        expect(r.error.message).toContain('boom-marker');
        expect(Object.keys(r.error).sort()).toEqual(['message', 'name', 'stage']); // 无 stack 键
        expect(r.userMessage).not.toMatch(/\.cjs|\.ts|node:internal/); // 无路径/内部帧
      }
    }
  });

  it('E8 原型污染：Object.prototype 冻结——strict 赋值抛；sandbox 冻结——篡改抛', async () => {
    const r = await evalInSandbox(`
      const out = [];
      try { Object.prototype.pwn = 'x'; out.push('polluted') } catch (e) { out.push('proto-frozen') }
      try { sandbox.mask.w = 0; out.push('mask-tampered') } catch (e) { out.push('mask-frozen') }
      return [out.join('|')];`, solid(300, 300));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(String(r.raw)).toContain('proto-frozen');
      expect(String(r.raw)).toContain('mask-frozen');
      expect(String(r.raw)).not.toContain('polluted');
      expect(String(r.raw)).not.toContain('tampered');
    }
  });

  it('E8 延伸：污染不跨 run 累积（每 run 新 worker——下一个 run 的 Object.prototype 干净）', async () => {
    const probe = await evalInSandbox(`try { Object.prototype.zzz = 1; } catch (e) {} return [({}).zzz];`, solid(300, 300));
    expect(probe.ok).toBe(true);
    if (probe.ok) expect(probe.raw).toEqual([undefined]); // 本 run 内即失败（frozen）
    const next = await evalInSandbox(`return [({}).zzz];`, solid(300, 300));
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.raw).toEqual([undefined]);
  });

  it('E10 计时器面：setTimeout/setInterval 为 broken 桩（无延时执行面）', async () => {
    const r = await evalInSandbox(`
      try { setTimeout(() => {}, 0); return ['timer-ok'] } catch (e) { return ['timer:' + e.message] }`, solid(300, 300));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.raw).toEqual(['timer:sandbox: 逃逸面封禁（自由代码仅可使用 sandbox 注入面）']);
  });

  it('E11 函数走私：返回值含函数 → output-unserializable（结构化克隆拒）', async () => {
    const r = await evalInSandbox(`return [{ x: 1, y: 1, fn: function(){} }];`, solid(300, 300));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe('output-unserializable');
  });

  it('E11 循环引用：估算预拒 output-unserializable（不进克隆）', async () => {
    const r = await evalInSandbox(`const a = { x: 1, y: 1 }; a.self = [a]; return [a];`, solid(300, 300));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe('output-unserializable');
  });
});

// ---------------------------------------------------------------- 有界性三线

describe('P1.4 有界性（CPU 计数/墙钟 terminate/内存三线）', () => {
  it('CPU 界：几何库调用计数超限 → soft-kill 携调用数（结果作废）', async () => {
    const r = await evalInSandbox(
      `let n = 0; for (let i = 0; i < 100; i++) { n += sandbox.geo.dist(i, 0, 0, 1); } return [{ x: 1, y: 1 }];`,
      solid(300, 300),
      { ...SHORT, maxHelperCalls: 10 },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.stage === 'helper-budget') {
      expect(r.error.calls).toBe(11); // 第 11 次越限即抛
      expect(r.error.max).toBe(10);
      expect(r.userMessage).toContain('11');
    } else {
      expect.unreachable('helper-budget 断言失败');
    }
  });

  it('墙钟界：while(true) 死循环 → 主线程 race 计时 terminate（真 worker 实测短界）', async () => {
    const t0 = Date.now();
    const r = await evalInSandbox(`while (true) { }`, solid(300, 300), { ...SHORT, wallMs: 150 });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.stage).toBe('cpu-timeout');
      if (r.error.stage === 'cpu-timeout') expect(r.error.wallMs).toBe(150);
    }
    expect(elapsed).toBeLessThan(5_000); // terminate 生效（探针基线 ~6ms + 调度裕量）
  });

  it('墙钟界：纯 JS 大循环不经几何库亦被墙钟兜住（迭代注入面无法计数的主防线）', async () => {
    const r = await evalInSandbox(`let x = 0; for (let i = 0; ; i++) { x = (x + i) | 0; } return [{ x: 1, y: 1 }];`, solid(300, 300), { ...SHORT, wallMs: 150 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe('cpu-timeout');
  });

  it('内存界：结果数组长度上限（Gem 数 > 密度×面积×4 拒）', async () => {
    const r = await runSandboxArtifact(
      `function layout(s){ const out = []; for (let i = 0; i < 5000; i++) out.push({ x: 1000 + i * 40, y: 1000 }); return out; }`,
      inputOf(solid(600, 600)),
      ctx,
      SHORT,
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.stage === 'output-oversize') {
      expect(r.error.count).toBe(5_000);
      // 600×600px@10ppm = 36cm² × 2.3 × 4 = 331 → 上限 331（>MIN_GEM_CAP 64）
      expect(r.error.max).toBe(defaultMaxGems(2.3, 600 * 600, PPM));
    } else {
      expect.unreachable('output-oversize 断言失败');
    }
  });

  it('内存界：单颗巨串 → postMessage 体积估算拒（schema 之前）', async () => {
    const r = await evalInSandbox(`return [{ x: 1, y: 1, note: 'z'.repeat(5 * 1024 * 1024) }];`, solid(300, 300), {
      ...SHORT,
      maxPayloadBytes: 64 * 1024,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe('output-oversize');
  });

  it('内存界：code 体积上限（spawn 前拒）', async () => {
    const r = await runSandboxArtifact(`function layout(s){ return [] } /*${'x'.repeat(SANDBOX_MAX_CODE_BYTES)}*/`, inputOf(solid(300, 300)), ctx, SHORT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.stage).toBe('code-oversize');
      if (r.error.stage === 'code-oversize') expect(r.error.max).toBe(SANDBOX_MAX_CODE_BYTES);
    }
  });

  it('内存界：分配 DoS → resourceLimits OOM → worker-crash（真 OOM 短界）', async () => {
    const r = await evalInSandbox(`const a = []; for (;;) a.push(new Array(10000).fill(1.1)); return [];`, solid(300, 300), {
      wallMs: 5_000,
      maxHelperCalls: 100,
      resourceLimits: { maxOldGenerationSizeMb: 48, maxYoungGenerationSizeMb: 8, codeRangeSizeMb: 8, stackSizeMb: 4 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(['worker-crash', 'cpu-timeout']).toContain(r.error.stage); // OOM 崩溃或墙钟先到——均有界
    }
  }, 15_000);

  it('maxGems 微小节点下限：SANDBOX_MIN_GEM_CAP 防退化（60×60px=3.6cm²×2.3×4=34→64）', () => {
    expect(defaultMaxGems(2.3, 60 * 60, PPM)).toBe(SANDBOX_MIN_GEM_CAP);
    expect(defaultMaxGems(2.3, 600 * 600, PPM)).toBe(332); // 331.2 → ceil 332
  });

  it('maxRetries 接口位：声明但本层不消费（负值拒——重试决策归调用方）', async () => {
    const okRun = await runSandboxArtifact(SPIRAL_CODE, inputOf(disk(1000, 1000, 500, 500, 500)), ctx, { wallMs: 2_000, maxRetries: 3 });
    expect(okRun.ok).toBe(true); // 携带即接受，不循环重试
    await expect(runSandboxArtifact('function layout(s){return []}', inputOf(solid(300, 300)), ctx, { ...SHORT, maxRetries: -1 })).rejects.toThrow(RangeError);
  });
});

// ---------------------------------------------------------------- 输出校验链

describe('P1.4 输出校验链（Zod → 强制引擎校验门）', () => {
  it('正常路径：螺旋代码（geo+rand 全注入面）→ 合法 Gem 过门', async () => {
    const block = disk(1000, 1000, 500, 500, 500);
    const r = await runSandboxArtifact(SPIRAL_CODE, inputOf(block), ctx, { wallMs: 2_000 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.gems.length).toBeGreaterThan(24);
    for (const [i, g] of r.gems.entries()) {
      expect(g.blockId).toBe(block.id);
      expect(g.colorId).toBe('');
      expect(g.shapeId).toBe('round');
      expect(g.diameterMm).toBeCloseTo(3, 6);
      expect(g.id).toBe(`${block.id}#${String(i + 1).padStart(4, '0')}`);
      // 掩膜内（独立规格复述——同 geometry 测试 inMaskSpec）
      const ix = Math.round(g.x) - block.bbox.x;
      const iy = Math.round(g.y) - block.bbox.y;
      expect(block.mask.bits[iy * block.mask.w + ix]).toBe(1);
    }
    // 两两间距 ≥ 钻径×0.999（引擎门 spacing 同构判据）
    for (let i = 0; i < r.gems.length; i++) {
      for (let j = i + 1; j < r.gems.length; j++) {
        expect(Math.hypot(r.gems[i]!.x - r.gems[j]!.x, r.gems[i]!.y - r.gems[j]!.y)).toBeGreaterThanOrEqual(GEM_PX * 0.999);
      }
    }
    expect(r.helperCalls).toBeGreaterThan(0);
  });

  it('间距违例颗剔除：两颗 1px 距 → 存 1 剔 1+spacing warning（keep-earlier）', async () => {
    const block = solid(600, 600);
    const r = await runSandboxArtifact(
      `function layout(s){ return [{ x: 400, y: 400 }, { x: 401, y: 400 }, { x: 600, y: 600 }]; }`,
      inputOf(block),
      ctx,
      SHORT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.gems.length).toBe(2);
    expect(r.gems.map((g) => [g.x, g.y])).toEqual([[400, 400], [600, 600]]); // keep-earlier
    expect(r.warnings.some((w) => w.kind === 'spacing' && w.detail.includes('1 颗'))).toBe(true);
  });

  it('掩膜外颗剔除：mask 外一点 → 剔除+mask warning', async () => {
    const block = disk(1000, 1000, 500, 500, 500); // bbox (100,100)-(1100,1100)，圆外角在 bbox 内但掩膜外
    const r = await runSandboxArtifact(
      `function layout(s){ return [{ x: 150, y: 150 }, { x: 600, y: 600 }]; }`, // (150,150) 全零区
      inputOf(block),
      ctx,
      SHORT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.gems.map((g) => [g.x, g.y])).toEqual([[600, 600]]);
    expect(r.warnings.some((w) => w.kind === 'mask' && w.detail.includes('1 颗'))).toBe(true);
  });

  it('全灭：所有颗违例 → gate-empty typed error（策略失败回 LLM）', async () => {
    const r = await runSandboxArtifact(`function layout(s){ return [{ x: 50, y: 50 }, { x: 50.5, y: 50 }]; }`, inputOf(solid(600, 600)), ctx, SHORT); // 两颗均在 bbox 外（掩膜外）
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.stage === 'gate-empty') {
      expect(r.error.culled).toBe(2);
      expect(r.userMessage).toContain('引擎校验门');
    } else {
      expect.unreachable('gate-empty 断言失败');
    }
  });

  it('空数组 → gate-empty（空产出=非法，不静默零 Gem）', async () => {
    const r = await runSandboxArtifact(`function layout(s){ return []; }`, inputOf(solid(300, 300)), ctx, SHORT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.stage).toBe('gate-empty');
  });

  it('schema 拒：非数组/缺字段/未知键/非数值/越枚举 shapeId（strict 白名单投影）', async () => {
    const cases: Array<[string, string]> = [
      ['function layout(s){ return [{ x: 400, y: 400 }, { x: 500 }]; }', 'y'],
      ['function layout(s){ return [{ x: 400, y: 400, diameterMm: 99 }]; }', 'diameterMm'],
      ['function layout(s){ return [{ x: "400", y: 400 }]; }', 'x'],
      ['function layout(s){ return [{ x: NaN, y: 400 }]; }', 'x'],
      ['function layout(s){ return [{ x: 400, y: 400, shapeId: "hexagon" }]; }', 'shapeId'],
      ['function layout(s){ return [{ x: 400, y: 400, rotationDeg: 720 }]; }', 'rotationDeg'],
    ];
    for (const [code, keyword] of cases) {
      const r = await runSandboxArtifact(code, inputOf(solid(600, 600)), ctx, SHORT);
      expect(r.ok, code).toBe(false);
      if (!r.ok) {
        expect(r.error.stage, code).toBe('schema');
        if (r.error.stage === 'schema') expect(r.error.issues.join('; '), code).toContain(keyword);
      }
    }
    // 非数组返回：worker 侧数组结构门先拒（output-unserializable——线协议体积界前哨）
    for (const code of ['function layout(s){ return 42; }', 'function layout(s){ return { a: 1 }; }', 'function layout(s){ return "gems"; }']) {
      const r = await runSandboxArtifact(code, inputOf(solid(600, 600)), ctx, SHORT);
      expect(r.ok, code).toBe(false);
      if (!r.ok) {
        expect(r.error.stage, code).toBe('output-unserializable');
        if (r.error.stage === 'output-unserializable') expect(r.error.message, code).toContain('数组');
      }
    }
  });

  it('编译错误 → compile；入口缺失 → entry-missing（缺省 entryPoint=layout）', async () => {
    const bad = await runSandboxArtifact('function layout(s{ return []; }', inputOf(solid(300, 300)), ctx, SHORT);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.stage).toBe('compile');

    const missing = await runSandboxArtifact('function notLayout(s){ return []; }', inputOf(solid(300, 300)), ctx, SHORT);
    expect(missing.ok).toBe(false);
    if (!missing.ok && missing.error.stage === 'entry-missing') {
      expect(missing.error.entryPoint).toBe('layout');
    } else {
      expect.unreachable('entry-missing 断言失败');
    }
    // 自定义入口名可配
    const custom = await runSandboxArtifact('function place(s){ return [{ x: 400, y: 400 }]; }', inputOf(solid(600, 600)), ctx, { ...SHORT, entryPoint: 'place' });
    expect(custom.ok).toBe(true);
  });

  it('shapeId 白名单：六枚举可选（缺省 round），非枚举拒（引擎 SHAPE_IDS 同构面）', async () => {
    const r = await runSandboxArtifact(
      `function layout(s){ return [{ x: 400, y: 400, shapeId: 'heart', rotationDeg: 45 }, { x: 600, y: 800, shapeId: 'square' }]; }`,
      inputOf(solid(600, 900)),
      ctx,
      SHORT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.gems.map((g) => g.shapeId).sort()).toEqual(['heart', 'square']);
    expect(r.gems[0]!.rotationDeg).toBe(45);
  });

  it('gate 校验器单源：validateGemPlacement keep-earlier 序确定（同输入同输出）', () => {
    const mask: TreeMask2D = { w: 10, h: 10, bits: new Uint8Array(100).fill(1) };
    const bbox: TreeBBox = { x: 0, y: 0, w: 10, h: 10 };
    const gems = [0, 1, 2].map((i) => ({
      id: `g${i}`,
      x: 5 + i * 0.1,
      y: 5,
      colorId: '',
      blockId: 'b',
      shapeId: 'round' as const,
      diameterMm: 3,
    }));
    const v1 = validateGemPlacement(gems, { mask, bbox, minPx: 1 });
    const v2 = validateGemPlacement(gems, { mask, bbox, minPx: 1 });
    expect(v1.kept.map((g) => g.id)).toEqual(['g0']); // g1 g2 距 g0 <1px
    expect(v1.culled.map((c) => c.id)).toEqual(['g1', 'g2']);
    expect(v1.culled.every((c) => c.kind === 'spacing')).toBe(true);
    expect(v2).toEqual(v1);
  });
});

// ---------------------------------------------------------------- 确定性回放 + 同源对拍

describe('P1.4 确定性回放（同 code+同 seed 同果——§4.4 审计/重跑前提）', () => {
  it('同 code+同 seed 两跑逐颗相等（含 warnings/helperCalls）', async () => {
    const block = disk(1000, 1000, 500, 500, 500);
    const input = inputOf(block);
    const r1 = await runSandboxArtifact(SPIRAL_CODE, input, ctx, { wallMs: 2_000, seed: 42 });
    const r2 = await runSandboxArtifact(SPIRAL_CODE, input, ctx, { wallMs: 2_000, seed: 42 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.gems).toEqual(r1.gems); // 逐颗（坐标浮点全等）
      expect(r2.warnings).toEqual(r1.warnings);
      expect(r2.helperCalls).toBe(r1.helperCalls);
    }
  });

  it('异 seed 改果（sandbox.rand 注入面生效——回放锚定 seed）', async () => {
    const block = disk(1000, 1000, 500, 500, 500);
    const input = inputOf(block);
    const r1 = await runSandboxArtifact(SPIRAL_CODE, input, ctx, { wallMs: 2_000, seed: 42 });
    const r2 = await runSandboxArtifact(SPIRAL_CODE, input, ctx, { wallMs: 2_000, seed: 7 });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.gems.map((g) => `${g.x},${g.y}`)).not.toEqual(r1.gems.map((g) => `${g.x},${g.y}`));
    }
  });

  it('rng 同源：sandbox.rand 与宿主 mulberry32 逐位同序列（ctx.rng 同构）', async () => {
    const r = await evalInSandbox(`return [sandbox.rand(), sandbox.rand(), sandbox.rand(), sandbox.rand(), sandbox.rand()];`, solid(300, 300), SHORT, 12345);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const host = mulberry32(12345);
      expect(r.raw).toEqual([...Array(5)].map(() => host()));
    }
  });

  it('geo 白名单投影与 geometryHelpers 逐位对拍（同构证明——mask 绑定面+通用面）', async () => {
    const block = solid(300, 200, 40, 60); // 非零锚点——bbox 换算入题
    const code = `
      const g = sandbox.geo;
      const c = g.maskCentroid();
      return [{
        centroid: c,
        rMax: g.maskMaxRadius(c),
        inT: g.inMask(c.x, c.y),
        inF: g.inMask(0, 0),
        d: g.dist(3, 4, 6, 8),
        ro: g.resampleOpen([{x:0,y:0},{x:10,y:0},{x:10,y:10}], 4, 1),
        rc: g.resampleClosed([{x:0,y:0},{x:4,y:0},{x:4,y:4},{x:0,y:4}], 2, 0.25),
        em: g.enforceMinSpacing([{x:0,y:0},{x:1,y:0},{x:5,y:0},{x:5.5,y:0}], 2),
        heart: g.heartOutline(0.8, 1.2, 16),
      }];`;
    const r = await evalInSandbox(code, block, SHORT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const got = (r.raw as Array<Record<string, unknown>>)[0]!;
    const h = geometryHelpers;
    const c = h.maskCentroid(block.mask, block.bbox);
    expect(got.centroid).toEqual(c);
    expect(got.rMax).toBe(h.maskMaxRadius(block.mask, block.bbox, c));
    expect(got.inT).toBe(h.inMask(block.mask, block.bbox, c.x, c.y));
    expect(got.inF).toBe(h.inMask(block.mask, block.bbox, 0, 0));
    expect(got.d).toBe(h.dist(3, 4, 6, 8));
    expect(got.ro).toEqual(h.resampleOpen([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], 4, 1));
    expect(got.rc).toEqual(h.resampleClosed([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 4 }, { x: 0, y: 4 }], 2, 0.25));
    expect(got.em).toEqual(h.enforceMinSpacing([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 5, y: 0 }, { x: 5.5, y: 0 }], 2));
    expect(got.heart).toEqual(h.heartOutline(0.8, 1.2, 16));
  });

  it('mask.at 注入面：全局坐标 1|0（inMask 同构语义）', async () => {
    const block = solid(100, 100, 200, 300);
    const r = await evalInSandbox(`return [sandbox.mask.at(250, 350), sandbox.mask.at(0, 0), sandbox.mask.w, sandbox.mask.h, sandbox.mask.bbox.x, sandbox.mask.bbox.y];`, block, SHORT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.raw).toEqual([1, 0, 100, 100, 200, 300]);
  });

  it('标度/钻规格注入面透传（pixelsPerMm/canvasCm/diameterMm/diameterPx）', async () => {
    const r = await evalInSandbox(`return [{ ppm: sandbox.scale.pixelsPerMm, cw: sandbox.scale.canvasCm.w, dmm: sandbox.gem.diameterMm, dpx: sandbox.gem.diameterPx, shapes: sandbox.gem.shapeIds.length }];`, solid(300, 300), SHORT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.raw).toEqual([{ ppm: PPM, cw: 200, dmm: 3, dpx: GEM_PX, shapes: 6 }]);
  });
});

// ---------------------------------------------------------------- 注册接线（同步桥+typed error）

describe('P1.4 注册接线（free-code 槽实现化——apply 同步桥）', () => {
  it('applyStrategy(free-code, inline source) → 同步全链产 Gem（Atomics 桥真 worker）', () => {
    const block = disk(1000, 1000, 500, 500, 500);
    const input = { node: nodeOf(block), block, params: { source: SPIRAL_CODE, entryPoint: 'layout', seed: 42 }, canvas: canvas(2000, 2000) };
    const result = applyStrategy('free-code', input, ctx);
    expect(result.gems.length).toBeGreaterThan(24);
    expect(result.warnings).toEqual([]);
    for (const g of result.gems) {
      expect(g.blockId).toBe(block.id);
      expect(g.colorId).toBe('');
      expect(g.diameterMm).toBeCloseTo(3, 6);
    }
    // 同步桥确定性：同参同果
    expect(applyStrategy('free-code', input, ctx)).toEqual(result);
  });

  it('freeCodeStrategy.apply 失败 → SandboxFailureError（failure 载荷+userMessage——P3 捕获面）', () => {
    const block = solid(600, 600);
    try {
      freeCodeStrategy.apply({ node: nodeOf(block), block, params: { source: 'function layout(s){ return [{ x: \'a\', y: 1 }]; }' }, canvas: canvas(2000, 2000) }, ctx);
      expect.unreachable('非法输出应失败');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxFailureError);
      const err = e as SandboxFailureError;
      expect(err.failure.stage).toBe('schema');
      expect(err.userMessage).toContain('Gem');
      expect(err.message).toContain('schema');
    }
  });

  it('墙钟界同步形态：死循环 apply → SandboxFailureError(cpu-timeout)（wallMs 参数短界）', () => {
    const block = solid(300, 300);
    const t0 = Date.now();
    try {
      freeCodeStrategy.apply(
        {
          node: nodeOf(block),
          block,
          params: { source: 'function layout(s){ while(true){} }', wallMs: 150 },
          canvas: canvas(2000, 2000),
        },
        createStrategyContext({ gemDiameterPx: GEM_PX }),
      );
      expect.unreachable('死循环应有界失败');
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxFailureError);
      expect((e as SandboxFailureError).failure.stage).toBe('cpu-timeout');
      expect(Date.now() - t0).toBeLessThan(2_000); // 150ms 界 + spawn/terminate 裕量
    }
  });

  it('params Zod：inline/工件二选一+entryPoint 标识符+seed 非负 int', () => {
    expect(FreeCodeParamsSchema.parse({ source: 'function layout(s){return []}' })).toEqual({
      source: 'function layout(s){return []}',
      entryPoint: 'layout',
      seed: 0,
    });
    expect(() => FreeCodeParamsSchema.parse({ source: 'x', codeArtifactRef: 'a'.repeat(64) })).toThrow(); // 二选一
    expect(() => FreeCodeParamsSchema.parse({})).toThrow(); // 两者皆缺
    expect(() => FreeCodeParamsSchema.parse({ codeArtifactRef: 'zz' })).toThrow(); // 非 64hex
    expect(() => FreeCodeParamsSchema.parse({ source: 'x', entryPoint: '1bad' })).toThrow();
    expect(() => FreeCodeParamsSchema.parse({ source: 'x', seed: -1 })).toThrow();
    expect(FreeCodeParamsSchema.parse({ source: 'x', wallMs: 150 })).toEqual({ source: 'x', entryPoint: 'layout', seed: 0, wallMs: 150 });
    expect(() => FreeCodeParamsSchema.parse({ source: 'x', wallMs: 0 })).toThrow();
    expect(() => FreeCodeParamsSchema.parse({ source: 'x', extra: 1 })).toThrow(); // strict
  });

  it('工件引用通道 → P3 fail-fast（不静默降级 inline）', () => {
    const block = solid(300, 300);
    expect(() =>
      freeCodeStrategy.apply(
        { node: nodeOf(block), block, params: { codeArtifactRef: 'a'.repeat(64) }, canvas: canvas(2000, 2000) },
        ctx,
      ),
    ).toThrow(/P3 接线/);
  });

  it('node/block id 不一致 → 显式抛（P0.2 同寻址空间契约——同族防御）', () => {
    const block = solid(300, 300);
    const node = { ...nodeOf(block), id: 'n-other' };
    expect(() =>
      freeCodeStrategy.apply({ node, block, params: { source: 'function layout(s){return [{x:400,y:400}]}' }, canvas: canvas(2000, 2000) }, ctx),
    ).toThrow(/不一致/);
  });
});

// ---------------------------------------------------------------- 零泄漏收尾（纪律：常驻进程回收）

afterAll(async () => {
  await drainSandboxWorkers();
  if (activeWorkerCount() !== 0) {
    throw new Error(`沙箱 worker 泄漏：${activeWorkerCount()} 个未回收（terminate 纪律破裂）`);
  }
});
