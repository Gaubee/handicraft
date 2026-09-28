/**
 * SAM 桥 mock 单测（add-subject-sam-pipeline P2.2——纯本地 mock 面，零真连）。
 * 形态沿仓内先例：装配=createServices（tree-artifacts.test.ts）；fence 探针=
 * cancelled 任务行（sessions-clear R2 镜像）。覆盖：队列串行（两请求顺序）/120s 界
 * （短界注入）/取消三态（排队移出·执行中丢弃·落定后无操作）/队列满显式拒/留存
 * 目录落盘与命名/失败注入 typed/坏 mask 拒收/blob 形态 mask 等价/analyze round-trip/
 * fence 拒/SSH 占位恒拒/非法请求不入队。
 * P1（codex 复核 2026-09-28）：maskMaxSide 下采样掩码桥边界归一化——materialize
 * 收到维度≠请求 imagePx 的掩码最近邻还原到画布尺寸（同维零归一化透传；非正方形
 * 比例；overlay 组合；桥→segment loop 集成不再 bad-mask）。
 * 零常驻纪律：桥每请求 timer 在 execute finally 必清；samDelay 全部 signal 可中止或
 * 短时自然到期——测试退出无悬挂定时器/连接。
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeInlineMask } from '@handicraft/contracts';
import { createJobTask } from '../src/db/jobs.js';
import {
  MockSamTransport,
  SamBridge,
  SamBridgeError,
  makeAnalyzeRequest,
  makeSegmentRequest,
  samDelay,
  type SamBridgeRequest,
  type SamBridgeResponse,
  type SamSegmentResponse,
} from '../src/kernel/vision/sam-bridge.js';
import { runSegmentLoop } from '../src/kernel/vision/segment-loop.js';
import { resolveMaskBits } from '../src/kernel/vision/tree-persist.js';
import { decodePng, encodePng } from '../src/png/codec.js';
import { createServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

/** 确定性非平凡掩码（斜纹——非全 0/1，round-trip 有区分度；mod/lt 可变体防内容撞车）。 */
function stripedBits(w: number, h: number, mod = 7, lt = 3): Uint8Array {
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      bits[y * w + x] = (x + y) % mod < lt ? 1 : 0;
    }
  }
  return bits;
}

function popcount(bits: Uint8Array): number {
  let n = 0;
  for (const b of bits) n += b;
  return n;
}

/** 小图字节（overlay 形状用——桥不解码 overlay，仅需真实可读 PNG 供留存审查断言）。 */
function tinyPng(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    rgba[i * 4] = 30 + (i % 200);
    rgba[i * 4 + 1] = 60;
    rgba[i * 4 + 2] = 150;
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(w, h, rgba);
}

function segResponse(
  iteration: number,
  extra: { mask?: SamSegmentResponse['mask']; overlay?: SamSegmentResponse['overlay']; score?: number } = {},
): SamSegmentResponse {
  return {
    kind: 'segment',
    mask: extra.mask ?? encodeInlineMask(4, 4, stripedBits(4, 4)),
    ...(extra.score !== undefined ? { score: extra.score } : { score: 0.87 }),
    ...(extra.overlay !== undefined ? { overlay: extra.overlay } : {}),
    meta: { model: 'sam3-mlx@spike', durationMs: 4600, iteration },
  };
}

interface Ctx {
  s: ReturnType<typeof createServices>;
  taskId: string;
  imageRef: string;
  transport: MockSamTransport;
  bridge: SamBridge;
  blobCount(): number;
  today(): string;
}

function setup(options?: { bridge?: { timeoutMs?: number; maxWaiting?: number } }): Ctx {
  const s = createServices();
  const taskId = createJobTask(s.db, {
    ownerId: s.anonymous.id,
    paramsJson: JSON.stringify({ kind: 'sam-bridge-test', params: {} }),
  }).id;
  const imageRef = s.blobs.put(tinyPng(8, 8)).hash;
  const transport = new MockSamTransport();
  const bridge = new SamBridge(
    { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot },
    { transport, ...options?.bridge },
  );
  return {
    s,
    taskId,
    imageRef,
    transport,
    bridge,
    blobCount: () => (s.db.prepare('SELECT COUNT(*) AS c FROM blobs').get() as { c: number }).c,
    today: () => new Date().toISOString().slice(0, 10),
  };
}

function segReq(ctx: Ctx, iteration = 0): SamBridgeRequest {
  return makeSegmentRequest({
    taskId: ctx.taskId,
    imageBlobRef: ctx.imageRef,
    imagePx: { width: 80, height: 80 },
    canvasCm: { w: 8, h: 8 },
    prompt: { kind: 'text', text: 'person' },
    iteration,
  });
}

/** typed error 断言面：instance+kind+留存落点（可选）。 */
async function capture<T>(p: Promise<T>): Promise<{ error: SamBridgeError; retention: string | null }> {
  const error = (await p.catch((e: unknown) => e)) as SamBridgeError;
  expect(error).toBeInstanceOf(SamBridgeError);
  const retention = (error as SamBridgeError & { retention?: { exchangeJson: string } | null })
    .retention;
  return { error, retention: retention?.exchangeJson ?? null };
}

function readExchange(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------- tests

describe('SAM 桥（P2.2 mock 面）', () => {
  it('队列串行（并发 1）：两请求严格先后——第二请求在第一完成前不送达', async () => {
    const ctx = setup();
    try {
      const order: string[] = [];
      ctx.transport.respond(async (call) => {
        order.push(`start:${call.request.iteration}`);
        await samDelay(25, call.signal);
        order.push(`end:${call.request.iteration}`);
        return segResponse(call.request.iteration);
      });
      ctx.transport.respond(async (call) => {
        order.push(`start:${call.request.iteration}`);
        await samDelay(5, call.signal);
        order.push(`end:${call.request.iteration}`);
        return segResponse(call.request.iteration);
      });
      const [r0, r1] = await Promise.all([ctx.bridge.run(segReq(ctx, 0)), ctx.bridge.run(segReq(ctx, 1))]);
      expect(order).toEqual(['start:0', 'end:0', 'start:1', 'end:1']); // 严格串行
      expect(ctx.transport.requests.map((r) => r.iteration)).toEqual([0, 1]); // 送达序
      expect(r0.kind).toBe('segment');
      expect(r1.kind).toBe('segment');
      expect(ctx.bridge.snapshot()).toEqual({ running: false, waiting: 0 }); // 收敛
    } finally {
      ctx.s.dispose();
    }
  });

  it('120s 界（短界注入 25ms）：超时 typed 拒+占用释放续跑+留存 outcome=timeout', async () => {
    const ctx = setup({ bridge: { timeoutMs: 25 } });
    try {
      ctx.transport.respond(async (call) => {
        await samDelay(60_000, call.signal); // 正常路径永不返回（真连挂死面）
        return segResponse(call.request.iteration);
      });
      const startedAt = Date.now();
      const { error, retention } = await capture(ctx.bridge.run(segReq(ctx, 0)));
      expect(error.kind).toBe('timeout');
      expect(Date.now() - startedAt).toBeLessThan(5_000); // 界生效（不等满 60s）
      expect(retention).not.toBeNull();
      const rec = readExchange(retention!);
      expect(rec['outcome']).toBe('timeout');
      expect((rec['request'] as { kind: string }).kind).toBe('segment');
      // 界释放占用：后续请求照常完成（挂死不传染队列）
      ctx.transport.respond(() => segResponse(1));
      const r1 = await ctx.bridge.run(segReq(ctx, 1));
      expect(r1.kind).toBe('segment');
    } finally {
      ctx.s.dispose();
    }
  });

  it('取消三态①排队中：移出队列不送达（typed 拒），队首不受扰', async () => {
    const ctx = setup();
    try {
      ctx.transport.respond(async (call) => {
        await samDelay(50, call.signal);
        return segResponse(call.request.iteration);
      });
      const p0 = ctx.bridge.run(segReq(ctx, 0));
      expect(ctx.bridge.snapshot()).toEqual({ running: true, waiting: 0 });
      const controller = new AbortController();
      const p1 = ctx.bridge.run(segReq(ctx, 1), { signal: controller.signal });
      expect(ctx.bridge.snapshot()).toEqual({ running: true, waiting: 1 });
      controller.abort();
      const { error, retention } = await capture(p1);
      expect(error.kind).toBe('cancelled');
      expect(retention).toBeNull(); // 未执行——不入留存面
      const r0 = await p0; // 队首不受扰
      expect(r0.kind).toBe('segment');
      expect(ctx.transport.requests).toHaveLength(1); // 取消请求从未送达
      expect(ctx.bridge.snapshot()).toEqual({ running: false, waiting: 0 });
    } finally {
      ctx.s.dispose();
    }
  });

  it('取消三态②执行中：typed 拒+结果丢弃不落库（迟到响应零 blob）+留存 outcome=cancelled', async () => {
    const ctx = setup();
    try {
      ctx.transport.respond(async (call) => {
        await samDelay(90, call.signal); // 晚于取消——响应属「迟到」
        return segResponse(call.request.iteration);
      });
      const before = ctx.blobCount();
      const controller = new AbortController();
      const p = ctx.bridge.run(segReq(ctx, 0), { signal: controller.signal });
      await samDelay(15); // 进入执行段
      controller.abort();
      const { error, retention } = await capture(p);
      expect(error.kind).toBe('cancelled');
      expect(ctx.blobCount()).toBe(before); // 执行中取消——零落库
      await samDelay(150); // 迟到响应窗口过后
      expect(ctx.blobCount()).toBe(before); // 迟到结果被丢弃——仍零落库
      expect(ctx.transport.abortedCalls).toBe(1); // 取消已传播到传输层
      expect(retention).not.toBeNull();
      expect(readExchange(retention!)['outcome']).toBe('cancelled');
      expect(ctx.bridge.snapshot()).toEqual({ running: false, waiting: 0 }); // 占用已释放
    } finally {
      ctx.s.dispose();
    }
  });

  it('取消三态③落定后：abort 无操作（结果不变、无新增错误面）', async () => {
    const ctx = setup();
    try {
      ctx.transport.respond(() => segResponse(0));
      const controller = new AbortController();
      const r = await ctx.bridge.run(segReq(ctx, 0), { signal: controller.signal });
      expect(r.kind).toBe('segment');
      controller.abort(); // 已落定——no-op
      await samDelay(10);
      expect(r.kind).toBe('segment'); // 结果不变
      expect(ctx.transport.abortedCalls).toBe(0); // 无传播（早已完成）
      expect(ctx.bridge.snapshot()).toEqual({ running: false, waiting: 0 });
    } finally {
      ctx.s.dispose();
    }
  });

  it('队列满：等待容量超出显式拒（queue-full typed），排队中请求不受影响', async () => {
    const ctx = setup({ bridge: { maxWaiting: 1 } });
    try {
      ctx.transport.respond(async (call) => {
        await samDelay(40, call.signal);
        return segResponse(call.request.iteration);
      });
      ctx.transport.respond(() => segResponse(1));
      const p0 = ctx.bridge.run(segReq(ctx, 0)); // running
      const p1 = ctx.bridge.run(segReq(ctx, 1)); // waiting=1（容量满）
      const { error } = await capture(ctx.bridge.run(segReq(ctx, 2)));
      expect(error.kind).toBe('queue-full');
      expect(error.message).toMatch(/队列已满/);
      const [r0, r1] = await Promise.all([p0, p1]); // 在队请求照常完成
      expect(r0.kind).toBe('segment');
      expect(r1.kind).toBe('segment');
      expect(ctx.transport.requests).toHaveLength(2);
    } finally {
      ctx.s.dispose();
    }
  });

  it('产物回传+留存：mask/overlay 落 BlobStore 可读回；sam-logs/{date}/{taskId}/ 命名（req-resp JSON+mask.png+overlay 图）；blob 形态 mask 等价', async () => {
    const ctx = setup();
    try {
      // 掩码=画布同维（80×80=请求 imagePx——P1 归一化后同维路径原样透传，字节不变）
      const bits = stripedBits(80, 80);
      const overlayBytes = tinyPng(6, 4);
      ctx.transport.respond(() => ({
        kind: 'segment',
        mask: encodeInlineMask(80, 80, bits),
        score: 0.91,
        overlay: { mime: 'image/png' as const, dataBase64: Buffer.from(overlayBytes).toString('base64') },
        meta: { model: 'sam3-mlx@spike', durationMs: 1234, iteration: 2 },
      }));
      const r = await ctx.bridge.run(segReq(ctx, 2));
      if (r.kind !== 'segment') throw new Error('期望 segment 结果');
      // mask blob round-trip（w*h 0/1 字节逐位同构）
      expect(r.mask.kind).toBe('blob');
      expect(r.mask.w).toBe(80);
      expect(r.mask.h).toBe(80);
      expect(Buffer.from(ctx.s.blobs.read(r.mask.blobRef)!).equals(Buffer.from(bits))).toBe(true);
      expect(Buffer.from(ctx.s.blobs.read(r.overlay!.blobRef)!).equals(Buffer.from(overlayBytes))).toBe(true);
      // 留存目录命名：DATA_ROOT/sam-logs/{date}/{taskId}/
      expect(r.retention.dir).toBe(path.join(ctx.s.config.dataRoot, 'sam-logs', ctx.today(), ctx.taskId));
      const names = readdirSync(r.retention.dir);
      const stamp = path.basename(r.retention.exchangeJson).replace(/\.json$/, '');
      expect(names).toContain(`${stamp}.json`);
      expect(names).toContain(`${stamp}-mask.png`);
      expect(names).toContain(`${stamp}-overlay.png`);
      // exchange JSON：req-resp 双全+outcome+blobRefs
      const rec = readExchange(r.retention.exchangeJson);
      expect(rec['outcome']).toBe('ok');
      expect((rec['request'] as { prompt: { text: string } }).prompt.text).toBe('person');
      expect((rec['response'] as { kind: string }).kind).toBe('segment');
      expect(rec['blobRefs']).toEqual([r.mask.blobRef, r.overlay!.blobRef]);
      // mask.png 可解码：尺寸对+白像素数=bits 置位数（选中=白）
      const decoded = decodePng(readFileSync(r.retention.maskPng!));
      expect(decoded.width).toBe(80);
      expect(decoded.height).toBe(80);
      let whites = 0;
      for (let p = 0; p < decoded.rgba.length; p += 4) {
        if (decoded.rgba[p] === 255 && decoded.rgba[p + 1] === 255 && decoded.rgba[p + 2] === 255) whites++;
      }
      expect(whites).toBe(popcount(bits));
      // overlay 留存图字节=响应原文
      expect(readFileSync(r.retention.overlayImage!).equals(Buffer.from(overlayBytes))).toBe(true);
      // 两请求留存互不覆盖（stamp 含 seq+ms）
      ctx.transport.respond(() => segResponse(3));
      const r2 = await ctx.bridge.run(segReq(ctx, 3));
      expect(r2.retention.exchangeJson).not.toBe(r.retention.exchangeJson);
      // blob 形态 mask（inline/blob 二选一）：读回等价+内容寻址同 hash 去重（同维=零归一化）
      const bits2 = stripedBits(80, 80, 5, 2); // 不同图案——防与上文同内容撞车
      const preRef = ctx.s.blobs.put(bits2).hash;
      ctx.transport.respond(() =>
        segResponse(4, { mask: { kind: 'blob', w: 80, h: 80, blobRef: preRef } }),
      );
      const r3 = await ctx.bridge.run(segReq(ctx, 4));
      if (r3.kind !== 'segment') throw new Error('期望 segment 结果');
      expect(r3.mask.blobRef).toBe(preRef); // 同内容同 hash（内容寻址去重）
      expect(Buffer.from(ctx.s.blobs.read(r3.mask.blobRef)!).equals(Buffer.from(bits2))).toBe(true);
    } finally {
      ctx.s.dispose();
    }
  });

  it('analyze：元素清单 round-trip+无 mask 产物（留存无 maskPng）', async () => {
    const ctx = setup();
    try {
      ctx.transport.respond(() => ({
        kind: 'analyze',
        elements: [
          {
            name: '路灯',
            category: 'structure',
            boxPx: { x: 1, y: 1, w: 3, h: 3 },
            hint: 'streetlight',
            suggestDrillWorthy: true,
            confidence: 0.8,
          },
        ],
        meta: { model: 'glm-v@mock', durationMs: 900, iteration: 0 },
      }));
      const r = await ctx.bridge.run(
        makeAnalyzeRequest({
          taskId: ctx.taskId,
          imageBlobRef: ctx.imageRef,
          imagePx: { width: 80, height: 80 },
          canvasCm: { w: 8, h: 8 },
          prompt: { kind: 'text', text: '列出全部主体元素' },
        }),
      );
      if (r.kind !== 'analyze') throw new Error('期望 analyze 结果');
      expect(r.elements).toHaveLength(1);
      expect(r.elements[0]!.name).toBe('路灯');
      expect(r.elements[0]!.hint).toBe('streetlight');
      expect(r.retention.maskPng).toBeUndefined(); // 无 mask 产物
      const rec = readExchange(r.retention.exchangeJson);
      const elements = (rec['response'] as { elements: { hint: string }[] }).elements;
      expect(elements[0]!.hint).toBe('streetlight');
    } finally {
      ctx.s.dispose();
    }
  });

  it('失败注入：传输异常→transport typed（cause 保留）+留存 outcome=transport-error', async () => {
    const ctx = setup();
    try {
      ctx.transport.respond(async () => {
        throw new Error('ssh 连接中断');
      });
      const { error, retention } = await capture(ctx.bridge.run(segReq(ctx, 0)));
      expect(error.kind).toBe('transport');
      expect(error.message).toContain('ssh 连接中断');
      expect((error.cause as Error).message).toBe('ssh 连接中断');
      expect(retention).not.toBeNull();
      const rec = readExchange(retention!);
      expect(rec['outcome']).toBe('transport-error');
      expect(rec['error']).toMatch(/ssh 连接中断/);
    } finally {
      ctx.s.dispose();
    }
  });

  it('坏 mask 拒收：inline mask 长度不符→invalid-response typed+零 blob 写入+响应原文留存', async () => {
    const ctx = setup();
    try {
      const badMask = {
        kind: 'inline',
        w: 4,
        h: 4,
        encoding: 'base64-01',
        data: Buffer.from(new Uint8Array([0, 1, 0, 1, 0])).toString('base64'), // 5 字节 ≠ 16
      };
      ctx.transport.respond(() => segResponse(0, { mask: badMask as never }));
      const before = ctx.blobCount();
      const { error, retention } = await capture(ctx.bridge.run(segReq(ctx, 0)));
      expect(error.kind).toBe('invalid-response');
      expect(error.message).toMatch(/≠/); // 长度不符语义
      expect(ctx.blobCount()).toBe(before); // 拒收——零 blob 写入
      expect(retention).not.toBeNull();
      const rec = readExchange(retention!);
      expect(rec['outcome']).toBe('invalid-response');
      expect((rec['response'] as { mask: { w: number } }).mask.w).toBe(4); // 原文留存（审查）
    } finally {
      ctx.s.dispose();
    }
  });

  it('响应 kind 不匹配（segment 请求收 analyze 响应）→invalid-response 拒收', async () => {
    const ctx = setup();
    try {
      const wrong: SamBridgeResponse = {
        kind: 'analyze',
        elements: [],
        meta: { model: 'm', durationMs: 1, iteration: 0 },
      };
      ctx.transport.respond(() => wrong);
      const { error } = await capture(ctx.bridge.run(segReq(ctx, 0)));
      expect(error.kind).toBe('invalid-response');
      expect(error.message).toMatch(/kind 不匹配/);
    } finally {
      ctx.s.dispose();
    }
  });

  it('fence：cancelled 任务产物回传拒（fence typed+零任务域 blob）+留存 outcome=fence-rejected', async () => {
    const ctx = setup();
    try {
      ctx.s.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('cancelled', ctx.taskId);
      ctx.transport.respond(() => segResponse(0));
      const before = ctx.blobCount();
      const { error, retention } = await capture(ctx.bridge.run(segReq(ctx, 0)));
      expect(error.kind).toBe('fence');
      expect(ctx.blobCount()).toBe(before); // fence 拒——零任务域写入
      expect(retention).not.toBeNull();
      expect(readExchange(retention!)['outcome']).toBe('fence-rejected');
    } finally {
      ctx.s.dispose();
    }
  });

  // SSH 传输真实现（P2.6）的假体测试独立成 tests/ssh-sam-transport.test.ts
  // （注入 sshBinary 假脚本走同一 spawn 路径——真连冒烟归 daemon/scripts/sam-live-smoke.ts）。

  it('非法请求：ZodError 同步抛出且不入队', () => {
    const ctx = setup();
    try {
      expect(() =>
        ctx.bridge.run({ kind: 'segment' } as never, {}),
      ).toThrowError(/Invalid input/);
      expect(ctx.bridge.snapshot()).toEqual({ running: false, waiting: 0 });
      expect(ctx.transport.requests).toHaveLength(0);
    } finally {
      ctx.s.dispose();
    }
  });

  it('原图缺失：请求未送出（transport typed+零送达）', async () => {
    const ctx = setup();
    try {
      ctx.transport.respond(() => segResponse(0));
      const req = makeSegmentRequest({
        taskId: ctx.taskId,
        imageBlobRef: 'a'.repeat(64), // 形似 hash 但不存在
        imagePx: { width: 80, height: 80 },
        canvasCm: { w: 8, h: 8 },
        prompt: { kind: 'text', text: 'person' },
        iteration: 0,
      });
      const { error } = await capture(ctx.bridge.run(req));
      expect(error.kind).toBe('transport');
      expect(error.message).toMatch(/原图 blob 不存在/);
      expect(ctx.transport.requests).toHaveLength(0); // 未上传输线
    } finally {
      ctx.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- P1 掩码归一化

/** 期望值独立复算：中心对齐最近邻源坐标（PIL NEAREST 同族口径——块边界对齐）。 */
function expectedSrcIndex(d: number, src: number, dst: number): number {
  return Math.min(src - 1, Math.floor(((d + 0.5) * src) / dst));
}

describe('SAM 桥掩码归一化（P1——maskMaxSide 下采样掩码回画布尺寸）', () => {
  it('缩小掩码（1024×768 收 512×384，非正方形比例 4:3）：materialize 后=画布尺寸且内容块映射正确（抽样断言源像素对应）', async () => {
    const ctx = setup();
    try {
      const srcW = 512;
      const srcH = 384;
      const dstW = 1024;
      const dstH = 768;
      const src = stripedBits(srcW, srcH);
      ctx.transport.respond(() =>
        segResponse(0, {
          mask: {
            kind: 'inline',
            w: srcW,
            h: srcH,
            encoding: 'base64-01',
            data: Buffer.from(src).toString('base64'),
          },
        }),
      );
      const r = await ctx.bridge.run(
        makeSegmentRequest({
          taskId: ctx.taskId,
          imageBlobRef: ctx.imageRef,
          imagePx: { width: dstW, height: dstH },
          canvasCm: { w: 10, h: 7.5 }, // 纵横比与 imagePx 一致（4:3）
          prompt: { kind: 'text', text: 'person' },
          iteration: 0,
        }),
      );
      if (r.kind !== 'segment') throw new Error('期望 segment 结果');
      // 落库掩码=画布尺寸（消费端全画布不变式）
      expect(r.mask.kind).toBe('blob');
      expect(r.mask.w).toBe(dstW);
      expect(r.mask.h).toBe(dstH);
      const out = new Uint8Array(ctx.s.blobs.read(r.mask.blobRef)!);
      expect(out.length).toBe(dstW * dstH);
      // 抽样若干坐标（四角/中心/块边界两侧）：输出像素=中心对齐最近邻源像素
      const samples: Array<[number, number]> = [
        [0, 0],
        [dstW - 1, dstH - 1],
        [0, dstH - 1],
        [dstW - 1, 0],
        [511, 383],
        [Math.floor(dstW / 2), Math.floor(dstH / 2)],
        [255, 191],
        [256, 192], // 2× 放大块边界两侧
        [767, 575],
        [768, 576],
      ];
      for (const [x, y] of samples) {
        const sx = expectedSrcIndex(x, srcW, dstW);
        const sy = expectedSrcIndex(y, srcH, dstH);
        expect(out[y * dstW + x]).toBe(src[sy * srcW + sx]);
      }
      // 块边界语义（0.5 降采样→2× 放大）：输出像素成对映射同一源像素——首行/首列
      // 相邻对恒等（块常量，无插值灰度）；左上 2×2 输出块恒=src[0]
      const v = src[0]!;
      for (let y = 0; y < 2; y++) {
        for (let x = 0; x < 2; x++) {
          expect(out[y * dstW + x]).toBe(v);
        }
      }
      for (let x = 0; x < dstW - 1; x += 2) {
        expect(out[x]).toBe(out[x + 1]);
      }
      for (let y = 0; y < dstH - 1; y += 2) {
        expect(out[y * dstW]).toBe(out[(y + 1) * dstW]);
      }
      // 留存 mask.png=归一化后尺寸（审查面与落库一致）
      const decoded = decodePng(readFileSync(r.retention.maskPng!));
      expect(decoded.width).toBe(dstW);
      expect(decoded.height).toBe(dstH);
    } finally {
      ctx.s.dispose();
    }
  });

  it('source>target（掩码大于画布，2048×1536 → 1024×768）：降采样中心采样全像素正确（通用路径——线上 maskMaxSide 只缩不出现，非抽样断言）', async () => {
    const ctx = setup();
    try {
      const srcW = 2048;
      const srcH = 1536;
      const dstW = 1024;
      const dstH = 768;
      const src = stripedBits(srcW, srcH);
      ctx.transport.respond(() =>
        segResponse(0, {
          mask: {
            kind: 'inline',
            w: srcW,
            h: srcH,
            encoding: 'base64-01',
            data: Buffer.from(src).toString('base64'),
          },
        }),
      );
      const r = await ctx.bridge.run(
        makeSegmentRequest({
          taskId: ctx.taskId,
          imageBlobRef: ctx.imageRef,
          imagePx: { width: dstW, height: dstH },
          canvasCm: { w: 10, h: 7.5 }, // 纵横比与 imagePx 一致（4:3）
          prompt: { kind: 'text', text: 'person' },
          iteration: 0,
        }),
      );
      if (r.kind !== 'segment') throw new Error('期望 segment 结果');
      expect(r.mask.kind).toBe('blob');
      expect(r.mask.w).toBe(dstW);
      expect(r.mask.h).toBe(dstH);
      const out = new Uint8Array(ctx.s.blobs.read(r.mask.blobRef)!);
      expect(out.length).toBe(dstW * dstH);
      // 全像素面对比（非抽样）：每个输出像素=中心对齐最近邻源像素（降采样中心采样）
      let mismatches = 0;
      let first = -1;
      for (let y = 0; y < dstH; y++) {
        const sy = expectedSrcIndex(y, srcH, dstH) * srcW;
        const rowDst = y * dstW;
        for (let x = 0; x < dstW; x++) {
          if (out[rowDst + x] !== src[sy + expectedSrcIndex(x, srcW, dstW)]) {
            mismatches++;
            if (first < 0) first = rowDst + x;
          }
        }
      }
      expect(mismatches, `首个失配像素下标=${first}`).toBe(0);
      // 留存 mask.png=归一化后尺寸
      const decoded = decodePng(readFileSync(r.retention.maskPng!));
      expect(decoded.width).toBe(dstW);
      expect(decoded.height).toBe(dstH);
    } finally {
      ctx.s.dispose();
    }
  });

  it('blob 字节与留存 PNG 逐像素对拍+非整数比例（1000×700 → 300×210）：全像素最近邻正确且 renderMaskPng 产物与落库 bits 一致', async () => {
    const ctx = setup();
    try {
      const srcW = 1000;
      const srcH = 700;
      const dstW = 300;
      const dstH = 210; // 10:3 非整数比例（无整齐放大/缩小块）
      const src = stripedBits(srcW, srcH, 9, 4);
      ctx.transport.respond(() =>
        segResponse(0, {
          mask: {
            kind: 'inline',
            w: srcW,
            h: srcH,
            encoding: 'base64-01',
            data: Buffer.from(src).toString('base64'),
          },
        }),
      );
      const r = await ctx.bridge.run(
        makeSegmentRequest({
          taskId: ctx.taskId,
          imageBlobRef: ctx.imageRef,
          imagePx: { width: dstW, height: dstH },
          canvasCm: { w: 10, h: 7 },
          prompt: { kind: 'text', text: 'person' },
          iteration: 0,
        }),
      );
      if (r.kind !== 'segment') throw new Error('期望 segment 结果');
      expect(r.mask.w).toBe(dstW);
      expect(r.mask.h).toBe(dstH);
      const out = new Uint8Array(ctx.s.blobs.read(r.mask.blobRef)!);
      // 全像素最近邻映射正确
      let mapMismatches = 0;
      for (let y = 0; y < dstH; y++) {
        const sy = expectedSrcIndex(y, srcH, dstH) * srcW;
        const rowDst = y * dstW;
        for (let x = 0; x < dstW; x++) {
          if (out[rowDst + x] !== src[sy + expectedSrcIndex(x, srcW, dstW)]) mapMismatches++;
        }
      }
      expect(mapMismatches).toBe(0);
      // blob bits ↔ 解码 PNG 逐像素对拍（全像素面，非抽样）：bit=1⟺白、bit=0⟺黑、alpha 恒 255
      const decoded = decodePng(readFileSync(r.retention.maskPng!));
      expect(decoded.width).toBe(dstW);
      expect(decoded.height).toBe(dstH);
      expect(decoded.rgba.length).toBe(dstW * dstH * 4);
      let pngMismatches = 0;
      let firstPng = -1;
      for (let i = 0; i < dstW * dstH; i++) {
        const v = out[i] === 1 ? 255 : 0;
        const p = i * 4;
        if (decoded.rgba[p] !== v || decoded.rgba[p + 1] !== v || decoded.rgba[p + 2] !== v || decoded.rgba[p + 3] !== 255) {
          pngMismatches++;
          if (firstPng < 0) firstPng = i;
        }
      }
      expect(pngMismatches, `首个失配像素下标=${firstPng}`).toBe(0);
    } finally {
      ctx.s.dispose();
    }
  });

  it('cap 恰好等于边长（掩码=画布同维）：不触发放大——字节原样落库（内容寻址 hash 不变）', async () => {
    const ctx = setup();
    try {
      const dstW = 96;
      const dstH = 64; // 非正方形（3:2）
      const bits = stripedBits(dstW, dstH);
      const preRef = ctx.s.blobs.put(bits).hash; // 同内容先置——归一化为零操作时 hash 相同
      ctx.transport.respond(() =>
        segResponse(0, {
          mask: {
            kind: 'inline',
            w: dstW,
            h: dstH,
            encoding: 'base64-01',
            data: Buffer.from(bits).toString('base64'),
          },
        }),
      );
      const r = await ctx.bridge.run(
        makeSegmentRequest({
          taskId: ctx.taskId,
          imageBlobRef: ctx.imageRef,
          imagePx: { width: dstW, height: dstH },
          canvasCm: { w: 9, h: 6 },
          prompt: { kind: 'text', text: 'person' },
          iteration: 0,
        }),
      );
      if (r.kind !== 'segment') throw new Error('期望 segment 结果');
      expect(r.mask.w).toBe(dstW);
      expect(r.mask.h).toBe(dstH);
      expect(r.mask.blobRef).toBe(preRef); // 字节原样（无重采样漂移）
      expect(Buffer.from(ctx.s.blobs.read(r.mask.blobRef)!).equals(Buffer.from(bits))).toBe(true);
    } finally {
      ctx.s.dispose();
    }
  });

  it('overlay 组合：掩码归一化+overlay 字节原样落库（服务端按缩小掩码渲染的预览不重采样）', async () => {
    const ctx = setup();
    try {
      const srcW = 40;
      const srcH = 40;
      const dstW = 80;
      const dstH = 80;
      const src = stripedBits(srcW, srcH, 5, 2);
      const overlayBytes = tinyPng(6, 4);
      ctx.transport.respond(() => ({
        kind: 'segment',
        mask: {
          kind: 'inline',
          w: srcW,
          h: srcH,
          encoding: 'base64-01',
          data: Buffer.from(src).toString('base64'),
        },
        score: 0.88,
        overlay: { mime: 'image/png' as const, dataBase64: Buffer.from(overlayBytes).toString('base64') },
        meta: { model: 'sam3-mlx@spike', durationMs: 900, iteration: 1 },
      }));
      const r = await ctx.bridge.run(
        makeSegmentRequest({
          taskId: ctx.taskId,
          imageBlobRef: ctx.imageRef,
          imagePx: { width: dstW, height: dstH },
          canvasCm: { w: 8, h: 8 },
          prompt: { kind: 'text', text: 'person' },
          iteration: 1,
        }),
      );
      if (r.kind !== 'segment') throw new Error('期望 segment 结果');
      expect(r.mask.w).toBe(dstW); // 掩码已归一化
      expect(r.mask.h).toBe(dstH);
      const out = new Uint8Array(ctx.s.blobs.read(r.mask.blobRef)!);
      // 中心点抽样：源中心像素→输出中心像素（中心对齐最近邻）
      const cx = expectedSrcIndex(40, srcW, dstW);
      const cy = expectedSrcIndex(40, srcH, dstH);
      expect(out[40 * dstW + 40]).toBe(src[cy * srcW + cx]);
      expect(Buffer.from(ctx.s.blobs.read(r.overlay!.blobRef)!).equals(Buffer.from(overlayBytes))).toBe(true);
      const rec = readExchange(r.retention.exchangeJson);
      expect(rec['blobRefs']).toEqual([r.mask.blobRef, r.overlay!.blobRef]);
      expect(readFileSync(r.retention.overlayImage!).equals(Buffer.from(overlayBytes))).toBe(true);
    } finally {
      ctx.s.dispose();
    }
  });

  it('桥→segment loop 集成：缩小掩码进 loop 不再 bad-mask 且产树正常（segment-tool 同款接线）', async () => {
    const ctx = setup();
    try {
      // 画布 800×800 ↔ 8×8cm（ppm=10）；maskMaxSide=400 降采样掩码内 rect {0,0,150,150}
      // → 归一化回画布 {0,0,300,300}（0.5 中心对齐放大——块边界 x≤299）
      const side = 400;
      const rect = new Uint8Array(side * side);
      for (let y = 0; y < 150; y++) {
        for (let x = 0; x < 150; x++) rect[y * side + x] = 1;
      }
      const zero = new Uint8Array(side * side); // 次轮零检出（缩小同构）
      const inlineOf = (bits: Uint8Array) => ({
        kind: 'inline' as const,
        w: side,
        h: side,
        encoding: 'base64-01' as const,
        data: Buffer.from(bits).toString('base64'),
      });
      ctx.transport
        .respond(() => ({
          kind: 'segment' as const,
          mask: inlineOf(rect),
          score: 0.9,
          meta: { model: 'sam3-mlx@spike', durationMs: 1, iteration: 0 },
        }))
        .respond(() => ({
          kind: 'segment' as const,
          mask: inlineOf(zero),
          meta: { model: 'sam3-mlx@spike', durationMs: 1, iteration: 1 },
        }));
      const result = await runSegmentLoop(
        {
          taskId: ctx.taskId,
          imageBlobRef: ctx.imageRef,
          imagePx: { width: 800, height: 800 },
          canvasCm: { w: 8, h: 8 },
          elements: [
            {
              name: '路灯',
              boxPx: { x: 0, y: 0, w: 300, h: 300 },
              hint: 'streetlight',
              suggestDrillWorthy: true,
            },
          ],
          maxGemDiameterMm: 2, // ppm=10 ⇒ 判据 1 阈值 5mm=50px——300×300 不在出生封停面
        },
        {
          // segment-tool 同款桥承载面：bridge.run + resolveMaskBits → loop 消费
          segment: async (request) => {
            const run = await ctx.bridge.run(request);
            if (run.kind !== 'segment') throw new Error('期望 segment 结果');
            const bits = resolveMaskBits(ctx.s.blobs, run.mask);
            return {
              mask: { w: bits.w, h: bits.h, bits: bits.bits },
              ...(run.score !== undefined ? { score: run.score } : {}),
            };
          },
          measureLabVariance: () => 22,
          now: () => '2026-09-28T00:00:00.000Z',
        },
      );
      // 零 bad-mask：树正常产出（单主体根=主体；bbox=归一化后 300×300）
      expect(ctx.transport.requests).toHaveLength(2); // 轮 0 建点+轮 1 零实例封停
      expect(result.totalNodes).toBe(1);
      const root = result.tree.nodes[0]!;
      expect(root.objectName).toBe('路灯');
      expect(root.bbox).toEqual({ x: 0, y: 0, w: 300, h: 300 });
      expect(result.sealedByNode[root.id]).toEqual(['model']);
    } finally {
      ctx.s.dispose();
    }
  });
});
