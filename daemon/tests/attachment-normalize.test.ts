/**
 * 会话入线 PNG 归一测试（P1 修复 2026-10-04——t7a-flagship run1「JPEG 直传 S0 死链」）。
 * 覆盖：
 *   [1] 归一矩阵：PNG 直传零变化（同 ref 零写入）/ JPEG→PNG（EXIF 方向归一）/
 *        WebP→PNG / 非本人 ref 透传（治理面拒语义保留）/ 伪图透传 / 坏 JPEG
 *        typed 拒 / 幂等（同字节同 PNG ref）/ 数量超限整组透传。
 *   [2] run1 复现链（上传→S2 分析→S1 锚点）：原版 JPEG 直传 → normalize →
 *        SceneAnalyzer（通道 B mock 网关）→ style=photographic 正常产出 +
 *        intakeResample 工作画布锚点（intake-image PNG 可解码）——修复前该链在
 *        decodePng 处 image-decode-failed 死链（对照用例：原 JPEG ref 直调仍拒，
 *        防御性断言存活）。
 * 形态沿仓内先例：createServices（scene-analyze.test.ts 同款）+ 本地
 * openai-completions mock 网关；JPEG/WebP fixture 用 sharp 现制（真实可解码字节）。
 */
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { hasBlobUpload, recordBlobUpload } from '../src/db/blobs.js';
import { sniffImageMime } from '../src/image-sniff.js';
import { decodePng, encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import {
  FOLLOWUP_ATTACHMENTS_MAX_COUNT,
} from '../src/kernel/attachments.js';
import {
  normalizeAttachmentsToPng,
  transcodeToPngBytes,
} from '../src/kernel/attachment-normalize.js';
import { SceneAnalyzer, SceneAnalyzeError } from '../src/kernel/vision/scene-analyze.js';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixture

/** 渐变 RGBA fixture（内容确定性——同参同字节）。 */
function gradientRgba(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      rgba[p] = (x * 255) / Math.max(1, w - 1);
      rgba[p + 1] = (y * 255) / Math.max(1, h - 1);
      rgba[p + 2] = 180;
      rgba[p + 3] = 255;
    }
  }
  return rgba;
}

function pngFixture(w = 24, h = 16): Uint8Array {
  return encodePng(w, h, gradientRgba(w, h));
}

/** 真实可解码 JPEG（sharp 现制；quality 拉低保字节差异于 PNG；orientation 注 EXIF 方向）。 */
async function jpegFixture(w = 24, h = 16, orientation?: number): Promise<Uint8Array> {
  let pipe = sharp(Buffer.from(pngFixture(w, h))).jpeg({ quality: 80 });
  if (orientation !== undefined) {
    pipe = pipe.withMetadata({ orientation });
  }
  return new Uint8Array(await pipe.toBuffer());
}

/** 真实可解码 WebP。 */
async function webpFixture(w = 20, h = 12): Promise<Uint8Array> {
  return new Uint8Array(
    await sharp(Buffer.from(pngFixture(w, h)), { limitInputPixels: 64 * 1024 * 1024 })
      .webp({ quality: 80 })
      .toBuffer(),
  );
}

/** JPEG 魔数 + 垃圾尾（伪图——嗅探过、解码必败）。 */
const CORRUPT_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xde, 0xad, 0xbe, 0xef]);

// ---------------------------------------------------------------- [1] 归一矩阵

describe('normalizeAttachmentsToPng（会话入线 PNG 归一单源）', () => {
  it('PNG 直传零变化：同 ref 透传、零新 blob、零归属行', async () => {
    const s = createServices();
    try {
      const ref = s.blobs.put(pngFixture()).hash;
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [ref]);
      expect(out).toEqual([ref]);
    } finally {
      s.dispose();
    }
  });

  it('JPEG → PNG：新 ref 替换、blob 可 PNG 解码同尺寸、归属行入账、原 ref 保留', async () => {
    const s = createServices();
    try {
      const original = s.blobs.put(await jpegFixture(32, 20)).hash;
      recordBlobUpload(s.db, original, s.anonymous.id); // =assets.upload 归属入账（run1 同构）
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [original]);
      expect(out).toHaveLength(1);
      expect(out[0]).not.toBe(original);
      // 新 blob：PNG 魔数+可解码+尺寸保持
      const bytes = s.blobs.read(out[0]!)!;
      expect(sniffImageMime(bytes)).toBe('image/png');
      const decoded = decodePng(bytes);
      expect(decoded.width).toBe(32);
      expect(decoded.height).toBe(20);
      // 归属入账（=assets.upload 幂等语义——后续 owner 校验/治理面可过）
      expect(hasBlobUpload(s.db, out[0]!, s.anonymous.id)).toBe(true);
      // 原 JPEG ref 原样在场（raw 预览/用户上传域不受影响）
      expect(s.blobs.read(original)).not.toBeNull();
    } finally {
      s.dispose();
    }
  });

  it('JPEG EXIF 方向归一：orientation=6（顺时针 90°）→ 输出物理方向已旋转（宽高互换）', async () => {
    const s = createServices();
    try {
      // 32×20 横图 + orientation 6 → 显示方向应为 20×32 竖图（UI canvas 转码路同语义）
      const jpegRef = s.blobs.put(await jpegFixture(32, 20, 6)).hash;
      recordBlobUpload(s.db, jpegRef, s.anonymous.id);
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [
        jpegRef,
      ]);
      const decoded = decodePng(s.blobs.read(out[0]!)!);
      expect(decoded.width).toBe(20);
      expect(decoded.height).toBe(32);
    } finally {
      s.dispose();
    }
  });

  it('WebP → PNG：白名单内非 PNG 同归一', async () => {
    const s = createServices();
    try {
      const webpRef = s.blobs.put(await webpFixture(20, 12)).hash;
      recordBlobUpload(s.db, webpRef, s.anonymous.id);
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [
        webpRef,
      ]);
      expect(sniffImageMime(s.blobs.read(out[0]!)!)).toBe('image/png');
      expect(decodePng(s.blobs.read(out[0]!)!)).toMatchObject({ width: 20, height: 12 });
    } finally {
      s.dispose();
    }
  });

  it('混合组逐位对应：[png, jpeg] → [原 ref, 新 ref]（长度恒等——A5 imageId 顺序语义不变）', async () => {
    const s = createServices();
    try {
      const pngRef = s.blobs.put(pngFixture()).hash;
      const jpegRef = s.blobs.put(await jpegFixture()).hash;
      recordBlobUpload(s.db, pngRef, s.anonymous.id);
      recordBlobUpload(s.db, jpegRef, s.anonymous.id);
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [pngRef, jpegRef]);
      expect(out).toHaveLength(2);
      expect(out[0]).toBe(pngRef);
      expect(out[1]).not.toBe(jpegRef);
      expect(sniffImageMime(s.blobs.read(out[1]!)!)).toBe('image/png');
    } finally {
      s.dispose();
    }
  });

  it('非本人 ref 透传（治理面以既有 owner 拒语义处理——归一面零重复拒收）', async () => {
    const s = createServices();
    try {
      const strangerRef = s.blobs.put(await jpegFixture()).hash;
      // s.anonymous 未持有归属行——userOwnsBlobRef=false → 原样透传
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [strangerRef]);
      expect(out).toEqual([strangerRef]);
    } finally {
      s.dispose();
    }
  });

  it('伪图（魔数白名单外）透传：归一面不做第二套嗅探拒收', async () => {
    const s = createServices();
    try {
      const ref = s.blobs.put(new TextEncoder().encode('not an image at all')).hash;
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [ref]);
      expect(out).toEqual([ref]);
    } finally {
      s.dispose();
    }
  });

  it('坏 JPEG（魔数过、解码败）typed 拒：早期显式拒（不入会话后死链）', async () => {
    await expect(transcodeToPngBytes(CORRUPT_JPEG)).rejects.toThrow(/附件转码失败/);
  });

  it('幂等：同 JPEG 两次归一 → 同一 PNG ref（内容寻址零膨胀）', async () => {
    const s = createServices();
    try {
      const jpeg = await jpegFixture(28, 18);
      const ref = s.blobs.put(jpeg).hash;
      const first = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [ref]);
      const second = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [ref]);
      expect(second).toEqual(first);
    } finally {
      s.dispose();
    }
  });

  it('数量超限整组透传（治理面既有文案拒——归一面不预支转码工作）', async () => {
    const s = createServices();
    try {
      const refs = Array.from(
        { length: FOLLOWUP_ATTACHMENTS_MAX_COUNT + 1 },
        (_, i) => s.blobs.put(pngFixture(8 + i, 6)).hash,
      );
      const out = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, refs);
      expect(out).toEqual(refs);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] run1 复现链

/** mock 网关（scene-analyze.test.ts 同款线协议——openai-completions JSON 体）。 */
function startMockGateway(text: string): Promise<{ server: Server; port: number; requests: string[]; stop(): Promise<void> }> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
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

/** run1 同构分析载荷：style=photographic + 两元素（D1 风格检测面）。 */
const RUN1_ELEMENTS_JSON = JSON.stringify({
  style: 'photographic',
  elements: [
    {
      name: '天使',
      category: 'object',
      boxPx: { x: 4, y: 4, w: 90, h: 90 },
      hint: 'angel statue',
      suggestDrillWorthy: true,
      confidence: 0.9,
      elementId: 'el-0001',
      parentElementId: null,
    },
    {
      name: '夜空背景',
      category: 'background',
      boxPx: { x: 0, y: 0, w: 98, h: 98 },
      hint: 'night sky',
      suggestDrillWorthy: false,
      confidence: 0.85,
      elementId: 'el-0002',
      parentElementId: null,
    },
  ],
});

describe('run1 复现：原版 JPEG 直传 → 入线归一 → S2 分析 → S1 锚点（P1 死链修复）', () => {
  it('JPEG 上传字节走全链：normalize → scene.analyze style 正常产出 + 工作画布 PNG 锚点', async () => {
    const s: TestServices = createServices();
    const gw = await startMockGateway(RUN1_ELEMENTS_JSON);
    try {
      // —— 上传面（=run1：assets.upload 原样收 JPEG 字节+归属入账，无归一）
      const uploadedRef = s.blobs.put(await jpegFixture(64, 48)).hash;
      recordBlobUpload(s.db, uploadedRef, s.anonymous.id);
      // —— 会话入线归一（修复点：followup 单漏斗）
      const [anchorRef] = await normalizeAttachmentsToPng({ db: s.db, blobs: s.blobs }, s.anonymous.id, [uploadedRef]);
      expect(anchorRef).toBeDefined();
      expect(anchorRef).not.toBe(uploadedRef);
      // —— S2：scene.analyze（通道 B mock 网关；canvasCm 20×15cm → 规范网格 500×375）
      s.config.llm.provider = 'zai';
      s.config.llm.baseUrl = `http://127.0.0.1:${gw.port}/v1`;
      s.config.llm.apiKey = 'mock-gateway-key';
      s.config.llm.model = 'glm-5.3-flash';
      s.config.llm.visionModel = 'glm-4.6v';
      const { sessionId } = s.sessions.create(s.anonymous, { title: 'run1 复现' });
      const taskId = createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId,
        paramsJson: JSON.stringify({ attachments: [anchorRef] }),
      }).id;
      const analyzer = new SceneAnalyzer(
        { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot, llm: s.config.llm },
        { live: true },
      );
      const outcome = await analyzer.analyze({
        taskId,
        imageBlobRef: anchorRef!,
        imagePx: { width: 64, height: 48 },
        canvasCm: { w: 20, h: 15 },
      });
      // style 判定正常产出（run1 的实验目的——修复前在此前死链）
      expect(outcome.analysis.style).toBe('photographic');
      expect(outcome.analysis.elements).toHaveLength(2);
      expect(outcome.channel).toBe('llm-route');
      // S1 锚点：工作画布规范网格（与上传格式无关）+ intake-image PNG 可解码
      expect(outcome.intakeResample).toMatchObject({
        applied: true,
        imagePx: { width: 500, height: 375 },
        fromImageBlobRef: anchorRef,
      });
      const anchorBytes = s.blobs.read(outcome.intakeResample.imageBlobRef)!;
      expect(sniffImageMime(anchorBytes)).toBe('image/png');
      expect(decodePng(anchorBytes)).toMatchObject({ width: 500, height: 375 });
      // 线面：归一后 PNG 字节进 data URL（修复前 JPEG 字节+png 声明的错配面不存在了）
      const sent = JSON.parse(gw.requests[0]!) as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
      };
      const imagePart = sent.messages[0]!.content.find((part) => part.type === 'image_url');
      expect(imagePart?.image_url?.url).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
    } finally {
      await gw.stop();
      s.dispose();
    }
  });

  it('防御断言存活：原 JPEG ref 直调 scene.analyze 仍 image-decode-failed（绕过入线的直传不放行）', async () => {
    const s: TestServices = createServices();
    try {
      const uploadedRef = s.blobs.put(await jpegFixture(16, 12)).hash;
      const { sessionId } = s.sessions.create(s.anonymous, { title: '防御断言' });
      const taskId = createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId,
        paramsJson: JSON.stringify({}),
      }).id;
      const analyzer = new SceneAnalyzer(
        { db: s.db, blobs: s.blobs, dataRoot: s.config.dataRoot, llm: s.config.llm },
        { live: true },
      );
      const error = (await analyzer
        .analyze({
          taskId,
          imageBlobRef: uploadedRef,
          imagePx: { width: 16, height: 12 },
          canvasCm: { w: 20, h: 15 },
        })
        .catch((e: unknown) => e)) as SceneAnalyzeError;
      expect(error).toBeInstanceOf(SceneAnalyzeError);
      expect(error.kind).toBe('image-decode-failed');
      expect(error.message).toContain('管线仅支持 PNG');
    } finally {
      s.dispose();
    }
  });
});
