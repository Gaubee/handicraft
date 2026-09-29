/**
 * 图片会话链集成测试（split-admin-portal 2.2/2.3/2.4）：
 *   [2.2] acquireSessionAttachments 治理矩阵：owner 校验（上传账本 ∪ 本人会话引用）、
 *        会话 CAS（clearing/cleared 拒）、伪图嗅探拒、数量/字节门、清空防重放
 *        （跨用户旧 ref 必拒；deleting 行不复活）。
 *   [2.3] 物料桥（fake 内核——不 boot dsh）：createTaskSession images →
 *        ctx.attachments.saveImages → dsh 原生 image 内容块（按序）+ 首条
 *        user/message 帧携带附件元数据（name/mime/width/height/blobRef）；
 *        纯图空文本也产帧；attachments 服务缺席显式拒。
 *   [2.4] /api/assets/{ref}/raw：归属矩阵（本人✓/他人✗/未归属✗/未认证 401）+
 *        魔数嗅探（png/jpeg/webp Content-Type；伪图 415）+ w 预留参数忽略 +
 *        ETag 304/HEAD + 非 hex 形状走未知 API 404。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { ensureAnonymousUser, setAllowAnonymous, signJwt } from '../src/auth.js';
import { BlobStore, recordBlobUpload } from '../src/db/blobs.js';
import { createUser, type UserRow } from '../src/db/store.js';
import { JobService } from '../src/jobs/service.js';
import { SessionService } from '../src/sessions/service.js';
import { runSleepJob } from '../src/jobs/sleep-job.js';
import { generateJob } from '../src/jobs/generate.js';
import { engineJob } from '../src/jobs/engine.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createTaskSessions } from '../src/kernel/sessions.js';
import {
  acquireSessionAttachments,
  FOLLOWUP_ATTACHMENTS_MAX_COUNT,
  type AttachmentMaterial,
} from '../src/kernel/attachments.js';
import { DaemonHttp } from '../src/http.js';
import { encodePng } from '../src/png/codec.js';

function pngBytes(w = 8, h = 6): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = 40 + (i % 180);
  return encodePng(w, h, rgba);
}

/** JPEG/WebP 最小魔数字节（嗅探面只看魔数——解码校验归 dsh saveImages）。 */
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP_MAGIC = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
]);

/** 测试装配：临时根 + 两用户（A=anonymous、B=user）+ 服务族。 */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'handicraft-attach-'));
  const config = loadConfig({
    envFile: path.join(root, '.env'),
    processEnv: {
      DATA_ROOT: path.join(root, 'data'),
      WEBUI_DIR: path.join(root, 'webui'),
      JWT_SECRET: 'attachments-chain-test',
    },
  });
  const db = openDatabase(config.dataRoot);
  const anonymous = ensureAnonymousUser(db);
  setAllowAnonymous(db, true); // 匿名动线 fixture（2.7 生产前设）
  const other = createUser(db, {
    username: 'worker-b',
    passwordHash: `scrypt$${'00'.repeat(16)}$${'00'.repeat(32)}`,
    role: 'user',
  });
  const blobs = new BlobStore(config.dataRoot, db);
  const jobs = new JobService(
    { config, db, blobs },
    { sleep: { run: runSleepJob }, generate: generateJob, engine: engineJob },
  );
  const sessions = new SessionService({ config, db, blobs, jobs });
  return {
    root,
    config,
    db,
    blobs,
    jobs,
    sessions,
    a: anonymous,
    b: other,
    dispose(): void {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

type Fixture = ReturnType<typeof setup>;

// ---------------------------------------------------------------- 2.2 治理矩阵

describe('2.2 acquireSessionAttachments（owner 校验+CAS+嗅探+防重放）', () => {
  it('本人上传 → 引用取得：ref_count+1+账本行+物料（mime/name/data）', () => {
    const s = setup();
    try {
      const bytes = pngBytes();
      const hash = s.blobs.put(bytes).hash;
      recordBlobUpload(s.db, hash, s.a.id);
      const before = (s.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(hash) as { ref_count: number }).ref_count;
      const { sessionId } = s.sessions.create(s.a, { title: '附件' });
      const materials = acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionId, [hash]);
      expect(materials.length).toBe(1);
      expect(materials[0]?.mediaType).toBe('image/png');
      expect(materials[0]?.blobRef).toBe(hash);
      expect(materials[0]?.name).toBe(`attachment-${hash.slice(0, 12)}.png`);
      expect(materials[0]?.data.byteLength).toBe(bytes.byteLength);
      const after = (s.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(hash) as { ref_count: number }).ref_count;
      expect(after).toBe(before + 1);
      expect(
        s.db.prepare('SELECT 1 FROM session_blob_refs WHERE session_id = ? AND blob_hash = ?').get(sessionId, hash),
      ).toBeDefined();
    } finally {
      s.dispose();
    }
  });

  it('owner 矩阵：他人上传✗ / 无归属（put 未上传登记）✗ / 本人会话已引用✓', () => {
    const s = setup();
    try {
      const aHash = s.blobs.put(pngBytes()).hash;
      recordBlobUpload(s.db, aHash, s.a.id);
      const orphanHash = s.blobs.put(pngBytes(4, 4)).hash; // put 过但无任何归属记录
      const sessionA1 = s.sessions.create(s.a, { title: 'A1' }).sessionId;
      const sessionB = s.sessions.create(s.b, { title: 'B' }).sessionId;
      // 他人上传：B 携 A 的 ref → 拒。
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.b, sessionB, [aHash])).toThrow(
        /不属于当前用户/,
      );
      // 无归属：本人 put 未登记上传也未经会话引用 → 拒（owner 面无证据）。
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionA1, [orphanHash])).toThrow(
        /不属于当前用户/,
      );
      // 本人会话引用构成归属：A 在会话1 引用后，另一会话再引用同 ref → 放行。
      acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionA1, [aHash]);
      const sessionA2 = s.sessions.create(s.a, { title: 'A2' }).sessionId;
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionA2, [aHash])).not.toThrow();
    } finally {
      s.dispose();
    }
  });

  it('会话 CAS：clearing/cleared 原子拒；不存在会话拒', () => {
    const s = setup();
    try {
      const hash = s.blobs.put(pngBytes()).hash;
      recordBlobUpload(s.db, hash, s.a.id);
      const { sessionId } = s.sessions.create(s.a, { title: 'CAS' });
      acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionId, [hash]);
      s.sessions.clear(s.a, sessionId);
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionId, [hash])).toThrow(
        /正在清理或已清理/,
      );
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, 'no-such-session', [hash])).toThrow(
        /会话不存在/,
      );
    } finally {
      s.dispose();
    }
  });

  it('伪图拒（魔数嗅探）+ 未知 blob 拒 + 数量门', () => {
    const s = setup();
    try {
      const fakeHash = s.blobs.put(new TextEncoder().encode('definitely-not-an-image')).hash;
      recordBlobUpload(s.db, fakeHash, s.a.id);
      const { sessionId } = s.sessions.create(s.a, { title: '伪图' });
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionId, [fakeHash])).toThrow(
        /不是受支持的图片/,
      );
      expect(() =>
        acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionId, ['ab'.repeat(32)]),
      ).toThrow(/不存在或不可引用|不属于当前用户/);
      const hashes = Array.from({ length: FOLLOWUP_ATTACHMENTS_MAX_COUNT + 1 }, (_, i) => {
        const h = s.blobs.put(pngBytes(2 + i, 2)).hash;
        recordBlobUpload(s.db, h, s.a.id);
        return h;
      });
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionId, hashes)).toThrow(
        /附件数量超上限/,
      );
    } finally {
      s.dispose();
    }
  });

  it('清空防重放：A 上传+会话1引用 → clear → B 携旧 ref 必拒；A 自有上传可复用；deleting 行不复活', () => {
    const s = setup();
    try {
      const hash = s.blobs.put(pngBytes()).hash;
      recordBlobUpload(s.db, hash, s.a.id);
      const session1 = s.sessions.create(s.a, { title: '会话1' }).sessionId;
      acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, session1, [hash]);
      s.sessions.clear(s.a, session1);
      // B 携带旧 ref（清空释放后账本行已删——B 的 owner 面无任何证据）→ 拒。
      const sessionB = s.sessions.create(s.b, { title: 'B 重放' }).sessionId;
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.b, sessionB, [hash])).toThrow(
        /不属于当前用户/,
      );
      // A 的上传归属仍在——新会话可复用（自有上传的合法复用，非重放）。
      const session2 = s.sessions.create(s.a, { title: '会话2' }).sessionId;
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, session2, [hash])).not.toThrow();
      // 全部引用归零（upload 1 + 会话2 1）→ deleting 行 → 再引用显式拒（不复活）。
      s.blobs.releaseRef(hash);
      s.blobs.releaseRef(hash);
      expect((s.db.prepare('SELECT status FROM blobs WHERE hash = ?').get(hash) as { status: string }).status).toBe('deleting');
      const session3 = s.sessions.create(s.a, { title: '会话3' }).sessionId;
      expect(() => acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, session3, [hash])).toThrow(
        /不存在或不可引用/,
      );
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 2.3 物料桥（fake 内核）

interface FakeAgent {
  session: { id: string };
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel(cause: unknown, options?: unknown): void;
  whenIdle(): Promise<void>;
  inbox: { nextTurn: unknown[]; nextStep: unknown[] };
}

interface FakeSavedImage {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

function bridgeHarness(s: Fixture, options?: { withAttachments?: boolean }) {
  const withAttachments = options?.withAttachments ?? true;
  let listener: ((session: { id: string }, event: { type: string; data: unknown }) => void) | null = null;
  let lastMessage: unknown = null;
  const savedBatches: Array<Array<{ data: Uint8Array; mediaType: string; name?: string }>> = [];
  const savedRefs: FakeSavedImage[] = [];
  const agent: FakeAgent = {
    session: { id: '' },
    followup(message) {
      lastMessage = message;
      agent.inbox.nextTurn.push(message);
    },
    steer(message) {
      agent.inbox.nextStep.push(message);
    },
    cancel() {},
    whenIdle: () => Promise.resolve(),
    inbox: { nextTurn: [], nextStep: [] },
  };
  const attachments = {
    saveImages: async (inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string; name?: string }>) => {
      savedBatches.push([...inputs]);
      return inputs.map((input, index) => ({
        attachmentId: `att-${savedBatches.length}-${index}`,
        mediaType: input.mediaType,
        bytes: input.data.byteLength,
        width: 8 + index,
        height: 6 + index,
        ...(input.name !== undefined ? { name: input.name } : {}),
      }));
    },
  };
  const ctx = {
    on: (event: string, cb: (session: { id: string }, event2: { type: string; data: unknown }) => void) => {
      if (event === 'session/event') listener = cb;
      return () => undefined;
    },
    agents: {
      create: async (createOptions: { sessionId: string; setup?: (agentCtx: Context) => void }) => {
        agent.session.id = createOptions.sessionId;
        createOptions.setup?.({ tools: { schemas: () => [{ name: 'bash' }], restrict: () => () => undefined } } as unknown as Context);
        return { agent, dispose: async () => undefined };
      },
    },
    ...(withAttachments ? { attachments } : {}),
  } as unknown as Context;
  const fakeHandle = { ctx, record: { entries: [], activationOrder: [], inactiveActivation: [] }, globalToolNames: () => [], dispose: async () => undefined };
  const taskSessions = createTaskSessions({
    kernel: () => fakeHandle,
    jobs: s.jobs,
    db: s.db,
    modelSelection: () => ({ provider: 'zai', model: 'glm-5.3-flash' }),
  });
  taskSessions.attach(fakeHandle);
  return {
    taskSessions,
    agent,
    savedBatches: savedBatches as readonly (readonly { data: Uint8Array; mediaType: string; name?: string }[])[],
    savedRefs,
    fire: (event: { type: string; data: unknown }) => listener?.(agent.session, event),
    lastMessage: () => lastMessage as { content: Array<{ type: string; text?: string; attachment?: FakeSavedImage }> },
  };
}

describe('2.3 物料桥（BlobStore 字节 → dsh 原生图像内容块）', () => {
  function materialsOf(s: Fixture, bytesList: Uint8Array[]): { materials: AttachmentMaterial[]; hashes: string[] } {
    const hashes = bytesList.map((bytes) => s.blobs.put(bytes).hash);
    for (const hash of hashes) recordBlobUpload(s.db, hash, s.a.id);
    const { sessionId } = s.sessions.create(s.a, { title: '物料桥' });
    const materials = acquireSessionAttachments({ db: s.db, blobs: s.blobs }, s.a, sessionId, hashes);
    return { materials, hashes };
  }

  it('多附件=多图像块按序：saveImages 收字节 → 消息 content=[text, image…]（attachment 引用同序）', async () => {
    const s = setup();
    try {
      const { materials } = materialsOf(s, [pngBytes(), JPEG_MAGIC, WEBP_MAGIC]);
      const h = bridgeHarness(s);
      const taskId = createAgentTask(s.db, {
        ownerId: s.a.id,
        sessionId: s.sessions.create(s.a, { title: '桥' }).sessionId,
        paramsJson: '{}',
      }).id;
      await h.taskSessions.createTaskSession(taskId, {
        cwd: s.config.dataRoot,
        prompt: '看这两三张图',
        images: materials,
      });
      // saveImages 收到与物料同序的字节（含合成名）。
      expect(h.savedBatches.length).toBe(1);
      const batch = h.savedBatches[0]!;
      expect(batch.map((item) => item.mediaType)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
      expect(batch[0]?.name).toBe(materials[0]?.name);
      // 消息形态：首块 text，随后 image 块（attachment=saveImages 返回的持久引用）。
      const message = h.lastMessage();
      expect(message.content[0]?.type).toBe('text');
      expect(message.content[0]?.text).toContain('看这两三张图');
      const imageBlocks = message.content.filter((block) => block.type === 'image');
      expect(imageBlocks.length).toBe(3);
      expect(imageBlocks.map((block) => block.attachment?.mediaType)).toEqual(['image/png', 'image/jpeg', 'image/webp']);
      expect(imageBlocks.map((block) => block.attachment?.width)).toEqual([8, 9, 10]);
    } finally {
      s.dispose();
    }
  });

  it('首条 user/message 帧：附件元数据（name/mime/width/height=dsh 解码真相，blobRef=我方引用）；消费即清（后续用户消息不复挂）', async () => {
    const s = setup();
    try {
      const { materials, hashes } = materialsOf(s, [pngBytes(12, 10)]);
      const h = bridgeHarness(s);
      const sessionId = s.sessions.create(s.a, { title: '帧元数据' }).sessionId;
      const taskId = createAgentTask(s.db, { ownerId: s.a.id, sessionId, paramsJson: '{}' }).id;
      await h.taskSessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '看图', images: materials });
      h.fire({
        type: 'user/message',
        data: {
          role: 'user',
          source: { kind: 'user' },
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', attachment: { attachmentId: 'att-1-0' } },
          ],
        },
      });
      // 第二条用户消息（steer 形态——source user）：不得复挂附件元数据。
      h.fire({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '改口' }] } });
      const frames = s.jobs.frames(s.a, taskId, 0).frames;
      const userFrames = frames.filter(
        (f) => f.kind === 'transcript' && (f as unknown as { payload: { role: string } }).payload.role === 'user',
      ) as unknown as Array<{ payload: { text: string; attachments?: Array<{ name: string; mime: string; width: number; height: number; blobRef: string }> } }>;
      expect(userFrames.length).toBe(2);
      expect(userFrames[0]?.payload.attachments?.length).toBe(1);
      const meta = userFrames[0]?.payload.attachments?.[0];
      expect(meta?.blobRef).toBe(hashes[0]);
      expect(meta?.mime).toBe('image/png');
      expect(meta?.width).toBe(8); // fake saveImages 首件 width=8（dsh 解码真相位）
      expect(meta?.height).toBe(6);
      expect(meta?.name).toBe(materials[0]?.name);
      expect(userFrames[1]?.payload.attachments).toBeUndefined();
      expect(userFrames[1]?.payload.text).toBe('改口');
    } finally {
      s.dispose();
    }
  });

  it('纯图消息（空文本）：帧仍产出（text 空串+attachments）；旧语义「空文本丢弃」只适用无附件消息', async () => {
    const s = setup();
    try {
      const { materials } = materialsOf(s, [pngBytes()]);
      const h = bridgeHarness(s);
      const sessionId = s.sessions.create(s.a, { title: '纯图' }).sessionId;
      const taskId = createAgentTask(s.db, { ownerId: s.a.id, sessionId, paramsJson: '{}' }).id;
      await h.taskSessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '', images: materials });
      h.fire({
        type: 'user/message',
        data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'att-1-0' } }] },
      });
      const frames = s.jobs.frames(s.a, taskId, 0).frames;
      const userFrame = frames.find(
        (f) => f.kind === 'transcript' && (f as unknown as { payload: { role: string } }).payload.role === 'user',
      ) as unknown as { payload: { text: string; attachments?: unknown[] } };
      expect(userFrame).toBeDefined();
      expect(userFrame.payload.text).toBe('');
      expect(userFrame.payload.attachments?.length).toBe(1);
      // 无附件的空文本用户消息仍丢弃（旧面不变）。
      h.fire({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '' }] } });
      const after = s.jobs.frames(s.a, taskId, 0).frames;
      expect(after.length).toBe(frames.length);
    } finally {
      s.dispose();
    }
  });

  it('attachments 服务缺席：显式拒（不静默降级为纯文本）', async () => {
    const s = setup();
    try {
      const { materials } = materialsOf(s, [pngBytes()]);
      const h = bridgeHarness(s, { withAttachments: false });
      const sessionId = s.sessions.create(s.a, { title: '无服务' }).sessionId;
      const taskId = createAgentTask(s.db, { ownerId: s.a.id, sessionId, paramsJson: '{}' }).id;
      await expect(
        h.taskSessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '看图', images: materials }),
      ).rejects.toThrow(/attachments 服务不可用/);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 2.4 raw 预览面（真 DaemonHttp）

interface RawSandbox {
  base: string;
  db: ReturnType<typeof openDatabase>;
  blobs: BlobStore;
  a: UserRow;
  b: UserRow;
  tokenA: string;
  tokenB: string;
  dispose(): Promise<void>;
}

async function rawSandbox(): Promise<RawSandbox> {
  const root = mkdtempSync(path.join(tmpdir(), 'handicraft-assets-raw-'));
  const webuiDir = path.join(root, 'dist');
  mkdirSync(webuiDir, { recursive: true });
  writeFileSync(path.join(webuiDir, 'index.html'), '<!doctype html><title>spa</title>');
  const config = loadConfig({
    envFile: path.join(root, '.env'),
    processEnv: {
      DATA_ROOT: path.join(root, 'data'),
      WEBUI_DIR: webuiDir,
      JWT_SECRET: 'assets-raw-test',
    },
  });
  const db = openDatabase(config.dataRoot);
  const a = ensureAnonymousUser(db);
  setAllowAnonymous(db, true);
  const b = createUser(db, {
    username: 'reader-b',
    passwordHash: `scrypt$${'00'.repeat(16)}$${'00'.repeat(32)}`,
    role: 'user',
  });
  const blobs = new BlobStore(config.dataRoot, db);
  const http = new DaemonHttp({ config, db, secret: 'assets-raw-test', blobs });
  const port = await http.listen(0, '127.0.0.1');
  const [tokenA, tokenB] = await Promise.all([
    signJwt('assets-raw-test', { sub: a.id, role: a.role }),
    signJwt('assets-raw-test', { sub: b.id, role: b.role }),
  ]).then((pairs) => [pairs[0]!.token, pairs[1]!.token]);
  return {
    base: `http://127.0.0.1:${port}`,
    db,
    blobs,
    a,
    b,
    tokenA,
    tokenB,
    dispose: async () => {
      await http.stop(200);
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe('2.4 /api/assets/{ref}/raw（归属矩阵+嗅探+预留 w）', () => {
  it('归属矩阵：本人上传✓（200+字节等值+ETag）；他人✗（404 不泄露存在性）；未归属✗；未认证 401', async () => {
    const s = await rawSandbox();
    try {
      const bytes = pngBytes(20, 14);
      const hash = s.blobs.put(bytes).hash;
      recordBlobUpload(s.db, hash, s.a.id);
      const url = `${s.base}/api/assets/${hash}/raw`;
      // 未认证 401。
      expect((await fetch(url)).status).toBe(401);
      // 本人：?token= 与 Bearer 双通道。
      const viaQuery = await fetch(`${url}?token=${encodeURIComponent(s.tokenA)}`);
      expect(viaQuery.status).toBe(200);
      expect(viaQuery.headers.get('content-type')).toBe('image/png');
      expect(viaQuery.headers.get('etag')).toBe(`"${hash}"`);
      expect(Buffer.from(await viaQuery.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
      const viaBearer = await fetch(url, { headers: { authorization: `Bearer ${s.tokenA}` } });
      expect(viaBearer.status).toBe(200);
      // 他人（B）：404（不区分不存在/无权）。
      expect((await fetch(`${url}?token=${encodeURIComponent(s.tokenB)}`)).status).toBe(404);
      // 未归属（put 但无上传记录/会话引用）：本人也 404。
      const orphan = s.blobs.put(pngBytes(3, 3)).hash;
      expect((await fetch(`${s.base}/api/assets/${orphan}/raw?token=${encodeURIComponent(s.tokenA)}`)).status).toBe(404);
      // 未知 hash（不存在行）：404。
      expect((await fetch(`${s.base}/api/assets/${'ab'.repeat(32)}/raw?token=${encodeURIComponent(s.tokenA)}`)).status).toBe(404);
    } finally {
      await s.dispose();
    }
  });

  it('会话引用构成归属：本人会话引用后可取（即便非上传者）；嗅探 Content-Type png/jpeg/webp；伪图 415', async () => {
    const s = await rawSandbox();
    try {
      const pngHash = s.blobs.put(pngBytes()).hash;
      const jpegHash = s.blobs.put(JPEG_MAGIC).hash;
      const webpHash = s.blobs.put(WEBP_MAGIC).hash;
      const fakeHash = s.blobs.put(new TextEncoder().encode('plain-text-fake')).hash;
      // B 上传全部四件；A 无上传——A 在会话引用 png 后取得归属（引用面）。
      for (const hash of [pngHash, jpegHash, webpHash, fakeHash]) recordBlobUpload(s.db, hash, s.b.id);
      const sessionId = (
        s.db
          .prepare(
            'INSERT INTO sessions (id, owner_id, title, status, created_at, updated_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
          )
          .get(
            `sess-${Date.now()}`,
            s.a.id,
            '',
            'active',
            new Date().toISOString(),
            new Date().toISOString(),
            null,
          ) as { id: string }
      ).id;
      s.db
        .prepare('INSERT INTO session_blob_refs (session_id, blob_hash, created_at) VALUES (?, ?, ?)')
        .run(sessionId, pngHash, new Date().toISOString());
      expect(
        (await fetch(`${s.base}/api/assets/${pngHash}/raw?token=${encodeURIComponent(s.tokenA)}`)).status,
      ).toBe(200);
      // B（上传者）三种真图 Content-Type 正确。
      for (const [hash, mime] of [
        [pngHash, 'image/png'],
        [jpegHash, 'image/jpeg'],
        [webpHash, 'image/webp'],
      ] as const) {
        const res = await fetch(`${s.base}/api/assets/${hash}/raw?token=${encodeURIComponent(s.tokenB)}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(mime);
      }
      // 伪图（上传者本人）：415。
      expect((await fetch(`${s.base}/api/assets/${fakeHash}/raw?token=${encodeURIComponent(s.tokenB)}`)).status).toBe(415);
    } finally {
      await s.dispose();
    }
  });

  it('w 预留参数接受即忽略（返回原图字节）；If-None-Match 304；HEAD；非 hex 形状走未知 API 404', async () => {
    const s = await rawSandbox();
    try {
      const bytes = pngBytes(30, 20);
      const hash = s.blobs.put(bytes).hash;
      recordBlobUpload(s.db, hash, s.a.id);
      const url = `${s.base}/api/assets/${hash}/raw`;
      const withW = await fetch(`${url}?w=64&token=${encodeURIComponent(s.tokenA)}`);
      expect(withW.status).toBe(200);
      expect(Buffer.from(await withW.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true); // 原图字节（第一版不缩放）
      const etag = withW.headers.get('etag');
      expect(await fetch(`${url}?token=${encodeURIComponent(s.tokenA)}`, { headers: { 'if-none-match': etag ?? '' } })).toHaveProperty(
        'status',
        304,
      );
      const head = await fetch(`${url}?token=${encodeURIComponent(s.tokenA)}`, { method: 'HEAD' });
      expect(head.status).toBe(200);
      expect(await head.arrayBuffer()).toEqual(new ArrayBuffer(0));
      // 非 64-hex 形状不进 raw 面（未知 API 404——regex 固化形状）。
      expect((await fetch(`${s.base}/api/assets/not-a-hash/raw?token=${encodeURIComponent(s.tokenA)}`)).status).toBe(404);
      expect((await fetch(`${s.base}/api/assets/${'AB'.repeat(32)}/raw?token=${encodeURIComponent(s.tokenA)}`)).status).toBe(404);
    } finally {
      await s.dispose();
    }
  });
});
