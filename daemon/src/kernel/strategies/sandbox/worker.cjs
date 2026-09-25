'use strict';
// =====================================================================================
// 自由代码族 worker 沙箱本体（add-subject-sam-pipeline P1.4——design §4.4 + tasks.md P1.4）。
//
// 形态：CommonJS 字符串 worker（宿主 run.ts 经 readFileSync 读入后 new Worker(src,{eval:true})）
// ——eval worker 为 CJS 经典脚本（探针实证 2026-09-25：顶层 await 不可用/require 为模块参数
// 且 globalThis.require 存在）。**本文件是可信代码**：require 仅此处发生；用户代码永不接触
// 模块作用域（经 new Function('sandbox', code) 执行，作用域=全局+sandbox 形参）。
//
// --------------------------- 逃逸面枚举清单 + 防御对应表（评审重点） ---------------------------
// 探针基线（Node v24.21.0，未硬化实测）：new Function 作用域内 require/process/globalThis
// 均可达、动态 import("node:util") 成功、constructor 链 (function(){}).constructor('return
// process.version')() 成功——以下逐条防御（tests/strategies-sandbox.test.ts 逐条对齐验证）：
//
//  [E1] constructor 链逃逸（fn.constructor('return process')()）——防御：硬化期对
//       Function/Object/Array/Map/Set/RegExp/Error/Promise/Date/AsyncFunction/
//       GeneratorFunction/AsyncGeneratorFunction 全部 prototype 的 constructor 槽
//       defineProperty 覆写为 broken 桩（writable:false, configurable:false——不可恢复），
//       随后 freeze 各 prototype。可信侧执行器在硬化前捕获真实 Function/AsyncFunction。
//  [E2] this 全局（sloppy 函数 this=globalThis）——防御：用户代码强制 "use strict"
//       （前置指令）+ fn.call(undefined)，strict this=undefined（探针实证）。
//  [E3] eval / new Function（字符串→代码）——防御：globalThis.eval 与 globalThis.Function
//       覆写为 broken 桩；constructor 链已断（E1）。screenUserCode 同步拒字面量。
//  [E4] 动态 import("node:fs")（探针实证硬化后仍可达——V8 宿主解析，不可遮蔽）——
//       防御：**语法级 screen（唯一防线）**：源码剥离注释后匹配 /\bimport\s*\(/
//       即拒（import 是关键字，无法别名/拼接——字符串构造 import( 需先有字符串→代码
//       通道，而 E1/E3 已断）。host 与 worker 双层同 screen（低层 runUserCode 亦受护）。
//  [E5] require 字面量（worker 的 globalThis.require 存在，探针实证）——防御：screen 拒
//       + globalThis.require 覆写 broken 桩（双层）。
//  [E6] process 探测（env/exit）——防御：screen 拒 + globalThis.process 覆写 broken 桩。
//  [E7] 异常堆栈泄漏（worker 内部路径/帧）——防御：Error.prepareStackTrace/
//       captureStackTrace 删除；用户异常仅回传 {name, message}（截断），stack 永不出境。
//  [E8] 原型污染（Object.prototype 注入/ sandbox 篡改）——防御：sandbox 对象图全
//       null-prototype + Object.freeze（strict 赋值抛 TypeError）；硬化期 freeze 各
//       prototype（跨 run 不可累积污染；worker 每 run 重建，进程域亦隔离）。
//  [E9] 循环/分配 DoS——防御：三线有界（run.ts）：墙钟界=主线程 race 计时超时
//       worker.terminate()（探针实证：Atomics.wait 阻塞态 terminate 6.4ms）；
//       CPU 界=几何库调用计数器（本文件 budgeted 包装，超限抛携调用数）；内存界=
//       resourceLimits（maxOldGenerationSizeMb）+ 结果数组长度上限 + postMessage
//       体积估算上限（本文件 estimatePayload）。
//  [E10] 计时器/网络面（setTimeout/setInterval/fetch/WebSocket/WebAssembly）——防御：
//       globalThis 覆写 broken 桩（无计时器=无延时执行面；网络在 worker_threads 无绑定，
//       fetch 覆写为双保险）。
//  [E11] 函数/循环引用走私出 worker——防御：postMessage 结构化克隆天然拒函数
//       （探针实证 DOMException）；循环引用由 estimatePayload 预拒（output-unserializable）。
//
// 残余风险（诚实声明）：JS 无 realm 隔离无法宣称绝对不可逃逸；本沙箱的威胁模型是
// LLM 生成代码（有界重试回 LLM 改写），纵深防御=worker 进程域隔离+硬化+语法 screen+
// 墙钟 terminate+输出校验链（Zod+引擎校验门）——即使逃逸产出非法 Gem 亦在门外被拒。
//
// 协议（MessageChannel：宿主 port1 ↔ worker workerData.port；完成信号=SharedArrayBuffer）：
//   宿主→worker：{ kind:'run', runId, code, entryPoint, seed, mask:{w,h,bits}, bbox,
//                  scale:{pixelsPerMm,canvasCm}, gem:{diameterMm,diameterPx,shapeIds},
//                  limits:{maxHelperCalls,maxGems,maxPayloadBytes,maxCodeBytes} }
//                  （bits.buffer 随 transferList 转移）
//   worker→宿主：{ kind:'done', runId, ok:true, raw, helperCalls }
//              | { kind:'done', runId, ok:false, stage, ...stage 载荷 }
//   完成信号：Atomics.store(i32,0,1)+notify（宿主同步模式 Atomics.wait 后
//   receiveMessageOnPort 收割——探针实证 29.9ms 往返）。
// =====================================================================================

const wt = require('node:worker_threads');

// ---------------------------------------------------------------- 语法 screen 规则（单源：宿主 run.ts 经 createRequire 共享——双层防线）

const SCREEN_PATTERNS = [
  ['import()', /\bimport\s*\(/],
  ['require', /\brequire\s*\(/],
  ['process', /\bprocess\b/],
  ['globalThis', /\bglobalThis\b/],
  ['eval', /\beval\s*\(/],
  ['Function', /\bFunction\s*\(/],
  ['WebAssembly', /\bWebAssembly\b/],
  ['SharedArrayBuffer', /\bSharedArrayBuffer\b/],
  ['Atomics', /\bAtomics\b/],
  ['fetch', /\bfetch\s*\(/],
  ['WebSocket', /\bWebSocket\b/],
];

// 主线程 require（run.ts createRequire）时 workerData=null——导出 screen 规则；
// eval worker 运行态走 main()。**禁用顶层 return**：Node 24 eval worker 经类型剥离
// 包装求值，顶层 return=SyntaxError（"Illegal return statement"——首轮实测实证）。
if (wt.workerData === null || wt.workerData === undefined) {
  module.exports = { SCREEN_PATTERNS };
} else {
  main(wt.workerData.port, new Int32Array(wt.workerData.sab));
}

// ---------------------------------------------------------------- 可信执行器捕获（硬化前——硬化会遮蔽 Atomics/Function 等全局绑定）

const RealFunction = Function;
const RealAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const RealAtomics = Atomics;

// ---------------------------------------------------------------- 确定性 RNG（rng.ts mulberry32 同构）

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- 几何库白名单投影（geometry.ts 同构语义）
// 投影差异（有意）：mask 系方法绑定当前块（sandbox.geo.maskCentroid() 免传 mask/bbox）；
// 通用方法签名与 GeometryHelpers 一致。等价性由 tests 对拍把守（同输入逐位相等）。
// 预算计数规则：**每次白名单 API 调用即一个预算单元**（投影间互调同样计数——如
// heartOutline 内部再入 resampleClosed 计两次；纯内部私有函数 polylineLen/pointAtLen
// 非白名单入口不计数）。

function makeGeometry(bundle) {
  const calls = { n: 0 };
  const max = bundle.limits.maxHelperCalls;
  const budget = () => {
    if (++calls.n > max) {
      const e = new Error('SANDBOX_HELPER_BUDGET_EXCEEDED:' + calls.n + ':' + max + ':' + bundle.runId);
      e.sandboxStage = 'helper-budget';
      return e;
    }
    return null;
  };

  function dist(ax, ay, bx, by) {
    const e = budget(); if (e) throw e;
    return Math.hypot(bx - ax, by - ay);
  }
  function maskCentroid() {
    const e = budget(); if (e) throw e;
    const { mask, bbox } = bundle;
    let sx = 0, sy = 0, n = 0;
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (mask.bits[y * mask.w + x] !== 1) continue;
        sx += bbox.x + x; sy += bbox.y + y; n++;
      }
    }
    if (n === 0) throw new RangeError('maskCentroid：全零掩膜（上游契约破裂）');
    return { x: sx / n, y: sy / n };
  }
  function maskMaxRadius(c) {
    const e = budget(); if (e) throw e;
    const { mask, bbox } = bundle;
    let rMax = 0;
    for (let y = 0; y < mask.h; y++) {
      for (let x = 0; x < mask.w; x++) {
        if (mask.bits[y * mask.w + x] !== 1) continue;
        const r = Math.hypot(bbox.x + x - c.x, bbox.y + y - c.y);
        if (r > rMax) rMax = r;
      }
    }
    return rMax;
  }
  function inMask(x, y) {
    const e = budget(); if (e) throw e;
    const { mask, bbox } = bundle;
    const ix = Math.round(x) - bbox.x;
    const iy = Math.round(y) - bbox.y;
    if (ix < 0 || iy < 0 || ix >= mask.w || iy >= mask.h) return false;
    return mask.bits[iy * mask.w + ix] === 1;
  }
  function resampleOpen(pts, spacing, phase) {
    const e = budget(); if (e) throw e;
    if (!(spacing > 0) || pts.length < 2) return pts.length <= 1 ? pts.slice() : [pts[0]];
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y));
    const total = cum[cum.length - 1];
    const out = [];
    let seg = 0;
    for (let t = phase; t <= total; t += spacing) {
      while (seg < cum.length - 2 && cum[seg + 1] < t) seg++;
      const a = pts[seg];
      const b = pts[seg + 1] === undefined ? a : pts[seg + 1];
      const len = cum[seg + 1] - cum[seg];
      const f = len > 0 ? (t - cum[seg]) / len : 0;
      out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    }
    return out;
  }
  function resampleClosed(pts, spacing, phase) {
    const e = budget(); if (e) throw e;
    if (pts.length < 3) return pts.slice();
    const closed = pts.concat([pts[0]]);
    const total = polylineLen(closed);
    const n = Math.max(3, Math.floor(total / spacing));
    const out = [];
    for (let j = 0; j < n; j++) {
      const t = ((j / n + phase) % 1) * total;
      out.push(pointAtLen(closed, t));
    }
    return out;
  }
  function enforceMinSpacing(pts, minPx) {
    const e = budget(); if (e) throw e;
    const kept = [];
    outer: for (const p of pts) {
      for (const q of kept) {
        if (Math.hypot(p.x - q.x, p.y - q.y) < minPx) continue outer;
      }
      kept.push(p);
    }
    return kept;
  }
  function heartOutline(dent, aspect, n) {
    const e = budget(); if (e) throw e;
    const raw = [];
    for (let i = 0; i < 720; i++) {
      const t = (i / 720) * 2 * Math.PI;
      const x = 16 * Math.sin(t) ** 3;
      let y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      const lobe = 12;
      const bump = Math.max(0, Math.cos(t)) ** 2;
      y = y + (1 - dent) * bump * (lobe - y);
      raw.push({ x, y });
    }
    const cy = (12 + -17) / 2;
    const scale = 2 / 29;
    const natural = raw.map((p) => ({ x: p.x * scale * aspect, y: (p.y - cy) * scale }));
    return resampleClosed(natural, polylineLen(natural.concat([natural[0]])) / n, 0);
  }
  function polylineLen(pts) { // 内部依赖（不计数——非白名单入口）
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i - 1].x - pts[i].x, pts[i - 1].y - pts[i].y);
    return len;
  }
  function pointAtLen(pts, t) {
    let acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const seg = Math.hypot(b.x - a.x, b.y - a.y);
      if (acc + seg >= t && seg > 0) {
        const f = (t - acc) / seg;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
      acc += seg;
    }
    return { x: pts[pts.length - 1].x, y: pts[pts.length - 1].y };
  }

  return {
    calls,
    api: nullProtoFrozen({
      dist, maskCentroid, maskMaxRadius, inMask, resampleOpen, resampleClosed, enforceMinSpacing, heartOutline,
    }),
  };
}

// ---------------------------------------------------------------- null-prototype 冻结工具

function nullProtoFrozen(obj) {
  Object.setPrototypeOf(obj, null);
  return Object.freeze(obj);
}

// ---------------------------------------------------------------- screenCode（SCREEN_PATTERNS 见文件头）

/** 剥离块/行注释后再匹配（注释遮蔽形态 import-comment-( 的防御）——fail-closed：字符串内的误剥只增拒绝不增放行。 */
function screenCode(code) {
  const stripped = String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  for (const [token, re] of SCREEN_PATTERNS) {
    if (re.test(stripped)) return token;
  }
  return null;
}

// ---------------------------------------------------------------- 全局硬化（逃逸面 E1/E3/E5/E6/E7/E8/E10）

function hardenGlobals() {
  const broken = function sandboxEscapeSurface() {
    throw new Error('sandbox: 逃逸面封禁（自由代码仅可使用 sandbox 注入面）');
  };
  // [E1] 原型 constructor 链（含 async/generator 变体——探针实证均经 Function.prototype.constructor）
  const protos = [
    Function.prototype,
    Object.prototype,
    Array.prototype,
    Map.prototype, Set.prototype, RegExp.prototype, Error.prototype, Promise.prototype, Date.prototype,
    Object.getPrototypeOf(async function () {}),
    Object.getPrototypeOf(function* () {}),
    Object.getPrototypeOf(async function* () {}),
  ];
  for (const p of protos) {
    try {
      Object.defineProperty(p, 'constructor', { value: broken, writable: false, configurable: false });
      Object.freeze(p);
    } catch (_e) { /* 已不可配置（重复硬化）——幂等 */ }
  }
  // [E3][E5][E6][E10] 全局绑定遮蔽
  const shadows = {
    Function: broken, eval: broken, require: broken, process: broken,
    WebAssembly: broken, fetch: broken, WebSocket: broken, SharedArrayBuffer: broken, Atomics: broken,
    setTimeout: broken, setInterval: broken, setImmediate: broken, clearTimeout: broken, clearInterval: broken,
  };
  for (const [k, v] of Object.entries(shadows)) {
    try { Object.defineProperty(globalThis, k, { value: v, writable: false, configurable: false }); } catch (_e) { /* 幂等 */ }
  }
  // [E7] 堆栈泄漏面
  try { delete Error.prepareStackTrace; } catch (_e) { /* noop */ }
  try { delete Error.captureStackTrace; } catch (_e) { /* noop */ }
  return broken;
}

// ---------------------------------------------------------------- 输出体积估算（内存界第三线——E9）

function estimatePayload(v, budget, depth, seen) {
  if (v === null || v === undefined) return 8;
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return 8;
  if (t === 'string') return 2 * v.length + 8;
  if (t === 'function' || t === 'symbol' || t === 'bigint') return Infinity; // 结构化克隆拒/风险面
  if (depth > 64) return Infinity;
  if (seen.has(v)) return Infinity; // 循环引用
  seen.add(v);
  let total = 16;
  if (Array.isArray(v)) {
    for (const item of v) {
      total += estimatePayload(item, budget, depth + 1, seen);
      if (total > budget) return total;
    }
    return total;
  }
  if (t === 'object') {
    for (const k of Object.keys(v)) total += 2 * k.length + 8 + estimatePayload(v[k], budget, depth + 1, seen);
    return total;
  }
  return Infinity;
}

// ---------------------------------------------------------------- 异常清洗（E7——name+message 截断，stack 永不出境）

function sanitizeError(e, runId) {
  if (e !== null && typeof e === 'object' && typeof e.sandboxStage === 'string') {
    // 可信侧标记的预算异常（runId 防 spoof——用户不可见）
    const m = /^SANDBOX_HELPER_BUDGET_EXCEEDED:(\d+):(\d+):(.+)$/.exec(String(e.message));
    if (m !== null && m[3] === String(runId)) {
      return { stage: 'helper-budget', calls: Number(m[1]), max: Number(m[2]) };
    }
  }
  const name = e !== null && typeof e === 'object' && typeof e.name === 'string' ? e.name.slice(0, 64) : 'Error';
  let message = '';
  if (e !== null && typeof e === 'object' && typeof e.message === 'string') message = e.message;
  else if (typeof e === 'string') message = e;
  else message = String(message); // 非 Error 抛出物——只留类名信息
  message = message.slice(0, 2000).replaceAll('\n', ' ');
  return { stage: 'runtime', name, message };
}

// ---------------------------------------------------------------- run 主体

function main(port, i32) {
port.on('message', (msg) => {
  if (msg === null || typeof msg !== 'object' || msg.kind !== 'run') return;
  const runId = msg.runId;
  const finish = (payload) => {
    try { port.postMessage(Object.assign({ kind: 'done', runId }, payload)); } catch (_e) { /* 宿主已放弃 */ }
    RealAtomics.store(i32, 0, 1);
    RealAtomics.notify(i32, 0);
  };
  (async () => {
    // [E4][E5][E6] 双层 screen（低层调用面亦受护）+ 代码体积界
    if (typeof msg.code !== 'string' || msg.code.length === 0) {
      return finish({ ok: false, stage: 'compile', message: 'code 必须为非空字符串' });
    }
    if (msg.code.length > msg.limits.maxCodeBytes) {
      return finish({ ok: false, stage: 'code-oversize', bytes: msg.code.length, max: msg.limits.maxCodeBytes });
    }
    const banned = screenCode(msg.code);
    if (banned !== null) {
      return finish({ ok: false, stage: 'forbidden-syntax', token: banned });
    }
    if (typeof msg.entryPoint !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(msg.entryPoint)) {
      return finish({ ok: false, stage: 'compile', message: 'entryPoint 必须为合法标识符' });
    }

    // sandbox 对象图（null-prototype + freeze——E8）
    const geo = makeGeometry(msg);
    const maskView = nullProtoFrozen({
      w: msg.mask.w,
      h: msg.mask.h,
      bbox: nullProtoFrozen({ x: msg.bbox.x, y: msg.bbox.y, w: msg.bbox.w, h: msg.bbox.h }),
      at: function (x, y) { // 画布全局坐标 → 1|0（像素中心取整——inMask 同构语义）
        const ix = Math.round(x) - msg.bbox.x;
        const iy = Math.round(y) - msg.bbox.y;
        if (ix < 0 || iy < 0 || ix >= msg.mask.w || iy >= msg.mask.h) return 0;
        return msg.mask.bits[iy * msg.mask.w + ix] === 1 ? 1 : 0;
      },
    });
    const rand = mulberry32(msg.seed);
    const sandbox = nullProtoFrozen({
      mask: maskView,
      scale: nullProtoFrozen({
        pixelsPerMm: msg.scale.pixelsPerMm,
        canvasCm: nullProtoFrozen({ w: msg.scale.canvasCm.w, h: msg.scale.canvasCm.h }),
      }),
      gem: nullProtoFrozen({
        diameterMm: msg.gem.diameterMm,
        diameterPx: msg.gem.diameterPx,
        shapeIds: nullProtoFrozen(msg.gem.shapeIds.slice()),
      }),
      geo: geo.api,
      rand,
    });

    // 硬化（可信捕获已完成于模块加载期）→ 编译 → 执行
    hardenGlobals();
    let entryFn;
    try {
      // [E2] 强制 strict（this=undefined）+ 换行隔离尾注释；包装函数返回**入口引用本身**
      // （可信侧判型——入口缺失可判别为 entry-missing 而非静默 undefined）
      const fn = new RealAsyncFunction(
        'sandbox',
        '"use strict";\n' + msg.code + '\n;return (typeof ' + msg.entryPoint + ' === "function") ? ' + msg.entryPoint + ' : undefined;',
      );
      entryFn = await fn(sandbox); // 定义态调用：用户顶层语句可用 sandbox（this=undefined——strict）
    } catch (e) {
      return finish({ ok: false, stage: 'compile', message: String(typeof e.message === 'string' ? e.message : e).slice(0, 2000) });
    }
    if (typeof entryFn !== 'function') {
      return finish({ ok: false, stage: 'entry-missing', entryPoint: msg.entryPoint });
    }
    let raw;
    try {
      raw = await entryFn(sandbox);
    } catch (e) {
      return finish({ ok: false, ...sanitizeError(e, runId) });
    }
    // [E9] 内存界：结果数组长度上限（Gem 数 > 密度×面积×4 拒——上限由宿主按输入推导）
    if (!Array.isArray(raw)) {
      return finish({ ok: false, stage: 'output-unserializable', message: '返回值必须是数组（Gem[]）' });
    }
    if (raw.length > msg.limits.maxGems) {
      return finish({ ok: false, stage: 'output-oversize', count: raw.length, max: msg.limits.maxGems });
    }
    const est = estimatePayload(raw, msg.limits.maxPayloadBytes, 0, new Set());
    if (!Number.isFinite(est)) {
      return finish({ ok: false, stage: 'output-unserializable', message: '返回值含函数/循环引用/过深嵌套（不可结构化克隆）' });
    }
    if (est > msg.limits.maxPayloadBytes) {
      return finish({ ok: false, stage: 'output-oversize', count: raw.length, bytes: est, max: msg.limits.maxPayloadBytes });
    }
    return finish({ ok: true, raw, helperCalls: geo.calls.n });
  })().catch((e) => finish({ ok: false, stage: 'worker-crash', message: String(e && e.message ? e.message : e).slice(0, 2000) }));
});
}
