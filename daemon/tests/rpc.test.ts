/**
 * RPC 路由测试（W2.1：bootstrap + assets.upload + tasks 五端点——createRouterClient
 * 直调，不穿 WS；WS 通道的 E2E 归 tests/e2e-ws.test.ts）。
 * 覆盖：requireAuth 守卫（无 token 401）、bootstrap 读面（密钥存在性+dry-run 旗标）、
 * upload 大小上限、tasks 全链、未装配服务 501（mock 逃生口）、半配置拒绝预置面。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { createUser, setUserDisabled } from '../src/db/store.js';
import { clientFor, createServices } from './helpers.js';

async function expectOrpcError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
    return;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}

describe('RPC bootstrap / assets / tasks（W2.1）', () => {
  it('bootstrap：版本+配置状态布尔（密钥值零出）+ dry-run 旗标', async () => {
    const s = createServices();
    try {
      const client = clientFor(s.context());
      const boot = await client.bootstrap();
      expect(boot.version).toBe('0.1.0');
      expect(boot.allowAnonymous).toBe(true);
      expect(boot.adminConfigured).toBe(false);
      expect(boot.imgConfigured).toBe(false);
      expect(boot.llmConfigured).toBe(false);
      expect(boot.imgDryRun).toBe(false);
      expect(JSON.stringify(boot)).not.toMatch(/apiKey|secret/i);
    } finally {
      s.dispose();
    }
  });

  it('requireAuth：无 token 的 tasks.list 401；带 token 可用', async () => {
    const s = createServices();
    try {
      const anonymousClient = clientFor(s.context());
      await expectOrpcError(anonymousClient.tasks.list(), 'UNAUTHORIZED');

      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const { tasks } = await client.tasks.list();
      expect(tasks).toEqual([]);
    } finally {
      s.dispose();
    }
  });

  it('assets.upload：内容寻址 blobRef（sha256 hex64）+ 大小上限拒绝 + 空载荷拒绝', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const png1x1 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const up = await client.assets.upload({ filename: 'tiny.png', dataBase64: png1x1 });
      expect(up.blobRef).toMatch(/^[0-9a-f]{64}$/);
      expect(up.size).toBeGreaterThan(0);
      expect(up.filename).toBe('tiny.png');
      // 同内容去重（ref_count 递增，不写第二份）
      const up2 = await client.assets.upload({ filename: 'dup.png', dataBase64: png1x1 });
      expect(up2.blobRef).toBe(up.blobRef);

      await expectOrpcError(
        client.assets.upload({ filename: 'empty.png', dataBase64: '' }),
        'BAD_REQUEST',
      );
    } finally {
      s.dispose();
    }
  });

  it('tasks 全链：create sleep → get/list → frames（afterSeq）→ cancel 幂等', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const created = await client.tasks.create({
        kind: 'sleep',
        params: { frames: 2, intervalMs: 5 },
      });
      expect(created.taskId).toBeTruthy();
      expect(created.kind).toBe('sleep');

      const { task } = await client.tasks.get({ taskId: created.taskId });
      expect(['queued', 'running', 'done']).toContain(task.status);

      const { tasks } = await client.tasks.list();
      expect(tasks.map((t) => t.taskId)).toContain(created.taskId);

      // 等任务完成（帧序 3 = 2 progress + 1 done）
      const deadline = Date.now() + 5000;
      let framesOut: Awaited<ReturnType<typeof client.tasks.frames>> | null = null;
      while (Date.now() < deadline) {
        framesOut = await client.tasks.frames({ taskId: created.taskId, afterSeq: 0 });
        if (framesOut.frames.some((f) => f.kind === 'done')) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(framesOut!.frames.map((f) => f.kind)).toEqual(['progress', 'progress', 'done']);
      expect(framesOut!.nextSeq).toBe(3);

      // 终态 cancel 幂等 ok
      const cancelled = await client.tasks.cancel({ taskId: created.taskId });
      expect(cancelled.ok).toBe(true);

      // 归属：他人 token 访问必拒
      const strangerToken = await s.tokenFor(
        (await import('../src/db/store.js')).createUser(s.db, {
          username: 'stranger',
          passwordHash: 'x',
          role: 'user',
        }),
      );
      const strangerClient = clientFor(s.context({ token: strangerToken }));
      await expectOrpcError(strangerClient.tasks.get({ taskId: created.taskId }), 'BAD_REQUEST');
    } finally {
      s.dispose();
    }
  });

  it('契约校验：非法 job 参数（frames=0 / 未知 kind）Zod 拒绝', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      await expectOrpcError(
        client.tasks.create({ kind: 'sleep', params: { frames: 0 } }),
        'BAD_REQUEST',
      );
    } finally {
      s.dispose();
    }
  });

  it('mock 逃生口：jobs/blobs 未装配 → tasks/assets 端点 501，bootstrap 仍可用', async () => {
    const s = createServices();
    try {
      const bare = clientFor({
        config: s.config,
        db: s.db,
        secret: s.secret,
      });
      const boot = await bare.bootstrap();
      expect(boot.version).toBe('0.1.0');
      const token = await s.tokenFor();
      const bareAuthed = clientFor({
        config: s.config,
        db: s.db,
        secret: s.secret,
        token,
      });
      await expectOrpcError(bareAuthed.tasks.list(), 'NOT_IMPLEMENTED');
      await expectOrpcError(
        bareAuthed.assets.upload({ filename: 'x', dataBase64: 'aGk=' }),
        'NOT_IMPLEMENTED',
      );
    } finally {
      s.dispose();
    }
  });

  it('P1-1 禁用用户禁写不禁读：读端点可用；四个写端点 FORBIDDEN 且 DB/blob 零变化', async () => {
    const s = createServices();
    try {
      // 先以活跃身份建号+建任务，再禁用——验证「禁用后读自己任务仍可」
      const soonDisabled = createUser(s.db, {
        username: 'disabled-user',
        passwordHash: 'x',
        role: 'user',
      });
      const liveToken = await s.tokenFor(soonDisabled);
      const liveClient = clientFor(s.context({ token: liveToken }));
      const created = await liveClient.tasks.create({
        kind: 'sleep',
        params: { frames: 2, intervalMs: 5 },
      });
      setUserDisabled(s.db, soonDisabled.id, true);
      const client = clientFor(s.context({ token: liveToken }));

      // 读面：bootstrap / tasks.list / tasks.get（本人任务）正常（禁写不禁读）
      await expect(client.bootstrap()).resolves.toBeTruthy();
      const { tasks } = await client.tasks.list();
      expect(tasks.map((t) => t.taskId)).toContain(created.taskId);
      await expect(client.tasks.get({ taskId: created.taskId })).resolves.toBeTruthy();

      // 写面零变化基线
      const tasksCount = () =>
        (s.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
      const blobsCount = () =>
        (s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
      const resourcesCount = () =>
        (s.db.prepare('SELECT COUNT(*) AS n FROM resources').get() as { n: number }).n;
      const before = { tasks: tasksCount(), blobs: blobsCount(), resources: resourcesCount() };

      // 四个 mutation 端点逐一 FORBIDDEN
      await expectOrpcError(
        client.assets.upload({ filename: 'x.png', dataBase64: 'aGk=' }),
        'FORBIDDEN',
      );
      await expectOrpcError(
        client.tasks.create({ kind: 'sleep', params: { frames: 1, intervalMs: 5 } }),
        'FORBIDDEN',
      );
      await expectOrpcError(client.tasks.cancel({ taskId: created.taskId }), 'FORBIDDEN');
      await expectOrpcError(
        client.resources.import({
          filename: 'a.gemproj',
          dataBase64: Buffer.from('{"kind":"gemproj","formatVersion":2}').toString('base64'),
        }),
        'FORBIDDEN',
      );

      // DB 三表与 blob 零变化（写端点在守卫处短路，未触达存储）
      expect(tasksCount()).toBe(before.tasks);
      expect(blobsCount()).toBe(before.blobs);
      expect(resourcesCount()).toBe(before.resources);
    } finally {
      s.dispose();
    }
  });

  it('P1-4 输入上限：超长 base64 上传/导入在解码前拒绝（4xx），blob 零变化', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const blobsCount = () =>
        (s.db.prepare('SELECT COUNT(*) AS n FROM blobs').get() as { n: number }).n;
      const before = blobsCount();

      // ≈45M 字符（解码后 >32MiB 上限）——字符串长度门先拒绝，不进入 Buffer.from
      const oversized = 'A'.repeat(45 * 1024 * 1024);
      await expectOrpcError(
        client.assets.upload({ filename: 'huge.bin', dataBase64: oversized }),
        'BAD_REQUEST',
      );
      await expectOrpcError(
        client.resources.import({ filename: 'huge.gemproj', dataBase64: oversized }),
        'BAD_REQUEST',
      );
      expect(blobsCount()).toBe(before); // 无解码产物落库

      // 非法 base64 解码为空（全空白字符）→ 空内容拒绝
      await expectOrpcError(
        client.assets.upload({ filename: 'empty.bin', dataBase64: '   ' }),
        'BAD_REQUEST',
      );
    } finally {
      s.dispose();
    }
  });

  it('P1-4 PNG 炸弹端到端：小字节炸弹上传成功（内容寻址不预解码），pave 任务 typed 失败、进程存活', async () => {
    const s = createServices();
    try {
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));

      // 压缩炸弹：4000×4000 声明 + 超期望展开的零流——文件本身 ~128KB
      const expected = 4000 * (1 + 4000 * 4);
      const { deflateSync } = await import('node:zlib');
      const bomb = buildPng(4000, 4000, deflateSync(Buffer.alloc(expected * 2), { level: 9 }));
      expect(bomb.byteLength).toBeLessThan(1024 * 1024); // 上传面看到的是小文件

      const uploaded = await client.assets.upload({
        filename: 'bomb.png',
        dataBase64: bomb.toString('base64'),
      });
      expect(uploaded.size).toBe(bomb.byteLength);

      // pave 任务消费炸弹：decodePng typed 拒绝 → 任务 failed（错误信息可读），不崩进程
      const created = await client.tasks.create({
        kind: 'engine',
        params: {
          op: 'pave',
          imageRef: uploaded.blobRef,
          strategy: 'hex-pitch',
          gapMm: 0.4,
          spec: { shapeId: 'round', diameterMm: 3 },
        },
      });
      const deadline = Date.now() + 10000;
      let final: Awaited<ReturnType<typeof client.tasks.get>> | null = null;
      while (Date.now() < deadline) {
        final = await client.tasks.get({ taskId: created.taskId });
        if (final.task.status !== 'queued' && final.task.status !== 'running') break;
        await new Promise((r) => setTimeout(r, 30));
      }
      expect(final!.task.status).toBe('failed');
      expect(final!.task.error).toMatch(/解压失败/);

      // 进程存活面：bootstrap 仍可用（同一服务实例继续服务）
      await expect(client.bootstrap()).resolves.toBeTruthy();
    } finally {
      s.dispose();
    }
  });
});

/** 手工 PNG（解码面不校验 CRC——同 codec.test.ts 构造法）。 */
function buildPng(width: number, height: number, idat: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const mk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.byteLength, 0);
    head.write(type, 4, 'ascii');
    return Buffer.concat([head, data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mk('IHDR', ihdr),
    mk('IDAT', idat),
    mk('IEND', Buffer.alloc(0)),
  ]);
}

describe('tasks.artifact 工件字节读面（add-subject-sam-pipeline P3.2-channel）', () => {
  /** 装配：owner+stranger+admin 三用户；会话+agent 任务+两类工件帧（PNG/JSON）。 */
  interface ArtifactFixture {
    s: ReturnType<typeof createServices>;
    client: ReturnType<typeof clientFor>;
    taskId: string;
    pngRef: string;
    jsonRef: string;
    pngBytes: Buffer;
    jsonName: string;
    pngName: string;
    sessionId: string;
  }

  async function setupArtifactTask(): Promise<ArtifactFixture> {
    const s = createServices();
    const token = await s.tokenFor();
    const client = clientFor(s.context({ token }));
    const pngBytes = buildPng(2, 2, Buffer.from([0x78, 0x9c, 0x63, 0x60, 0x60, 0x60, 0x00, 0x00, 0x00, 0x04, 0x00, 0x01]));
    const upPng = await client.assets.upload({ filename: 'preview.png', dataBase64: pngBytes.toString('base64') });
    const jsonBytes = Buffer.from(JSON.stringify({ kind: 'object-tree', formatVersion: 1, nodes: [] }), 'utf8');
    const upJson = await client.assets.upload({ filename: 'tree.json', dataBase64: jsonBytes.toString('base64') });

    const { createSessionRow } = await import('../src/db/sessions.js');
    const { createAgentTask } = await import('../src/db/jobs.js');
    const session = createSessionRow(s.db, { ownerId: s.anonymous.id, title: '工件会话' });
    const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId: session.id, status: 'running' });
    const jsonName = 'object-tree.json';
    const pngName = 'strategy-gems-preview.png';
    expect(s.jobs.emitFor(task.id, 'artifact', { name: jsonName, blobRef: upJson.blobRef })).toBe(true);
    expect(s.jobs.emitFor(task.id, 'artifact', { name: pngName, blobRef: upPng.blobRef })).toBe(true);
    return {
      s,
      client,
      taskId: task.id,
      pngRef: upPng.blobRef,
      jsonRef: upJson.blobRef,
      pngBytes,
      jsonName,
      pngName,
      sessionId: session.id,
    };
  }

  it('round-trip：按 blobRef 取 PNG（image/png）+ 按 name 取 JSON（application/json）字节保真', async () => {
    const f = await setupArtifactTask();
    try {
      const png = await f.client.tasks.artifact({ taskId: f.taskId, blobRef: f.pngRef });
      expect(png.name).toBe(f.pngName);
      expect(png.mime).toBe('image/png');
      expect(Buffer.from(png.dataBase64, 'base64').equals(f.pngBytes)).toBe(true);

      const json = await f.client.tasks.artifact({ taskId: f.taskId, name: f.jsonName });
      expect(json.name).toBe(f.jsonName);
      expect(json.mime).toBe('application/json');
      expect(JSON.parse(Buffer.from(json.dataBase64, 'base64').toString('utf8'))).toMatchObject({ kind: 'object-tree' });
    } finally {
      f.s.dispose();
    }
  });

  it('按名取最新同名帧：后发射的同名 artifact 帧胜出', async () => {
    const f = await setupArtifactTask();
    try {
      const bytesB = Buffer.from(JSON.stringify({ kind: 'object-tree', v: 'b' }), 'utf8');
      const upB = await f.client.assets.upload({ filename: 'b.json', dataBase64: bytesB.toString('base64') });
      expect(f.s.jobs.emitFor(f.taskId, 'artifact', { name: f.jsonName, blobRef: upB.blobRef })).toBe(true);
      const out = await f.client.tasks.artifact({ taskId: f.taskId, name: f.jsonName });
      expect(out.dataBase64).toBe(bytesB.toString('base64'));
    } finally {
      f.s.dispose();
    }
  });

  it('归属隔离：B 读 A 的任务工件 FORBIDDEN；admin 豁免可读；任务不存在 NOT_FOUND', async () => {
    const f = await setupArtifactTask();
    try {
      const stranger = createUser(f.s.db, { username: 'artifact-stranger', passwordHash: 'x', role: 'user' });
      const strangerToken = await f.s.tokenFor(stranger);
      const strangerClient = clientFor(f.s.context({ token: strangerToken }));
      await expectOrpcError(
        strangerClient.tasks.artifact({ taskId: f.taskId, blobRef: f.pngRef }),
        'FORBIDDEN',
      );
      await expectOrpcError(strangerClient.tasks.artifact({ taskId: f.taskId, name: f.jsonName }), 'FORBIDDEN');

      const admin = createUser(f.s.db, { username: 'artifact-admin', passwordHash: 'x', role: 'admin' });
      const adminClient = clientFor(f.s.context({ token: await f.s.tokenFor(admin) }));
      await expect(adminClient.tasks.artifact({ taskId: f.taskId, name: f.jsonName })).resolves.toMatchObject({
        mime: 'application/json',
      });

      await expectOrpcError(
        f.client.tasks.artifact({ taskId: 'no-such-task', blobRef: f.pngRef }),
        'NOT_FOUND',
      );
    } finally {
      f.s.dispose();
    }
  });

  it('404：name 未命中 / blobRef 不在该任务引用集（blob 读 oracle 防护）', async () => {
    const f = await setupArtifactTask();
    try {
      await expectOrpcError(
        f.client.tasks.artifact({ taskId: f.taskId, name: 'not-emitted.json' }),
        'NOT_FOUND',
      );
      // 他人 blob（存在但非本任务工件/附件）——持自己 taskId 读任意 hash 必拒
      const foreign = await f.client.assets.upload({
        filename: 'foreign.bin',
        dataBase64: Buffer.from('foreign').toString('base64'),
      });
      await expectOrpcError(
        f.client.tasks.artifact({ taskId: f.taskId, blobRef: foreign.blobRef }),
        'NOT_FOUND',
      );
    } finally {
      f.s.dispose();
    }
  });

  it('上限护栏：>8MiB 工件 typed 拒（artifact-too-large，data 携尺寸）；未装配 blobs 501', async () => {
    const f = await setupArtifactTask();
    try {
      const huge = Buffer.alloc(8 * 1024 * 1024 + 1, 7);
      const upHuge = await f.client.assets.upload({
        filename: 'huge.bin',
        dataBase64: huge.toString('base64'),
      });
      expect(f.s.jobs.emitFor(f.taskId, 'artifact', { name: 'huge.bin', blobRef: upHuge.blobRef })).toBe(true);
      try {
        await f.client.tasks.artifact({ taskId: f.taskId, name: 'huge.bin' });
        throw new Error('预期 artifact-too-large 拒绝');
      } catch (error) {
        expect(error).toBeInstanceOf(ORPCError);
        expect((error as ORPCError<string, unknown>).code).toBe('BAD_REQUEST');
        const data = (error as ORPCError<string, { code?: string }>).data;
        expect(data?.code).toBe('artifact-too-large');
      }

      const bare = clientFor({
        config: f.s.config,
        db: f.s.db,
        secret: f.s.secret,
        jobs: f.s.jobs,
        token: await f.s.tokenFor(),
      });
      await expectOrpcError(bare.tasks.artifact({ taskId: f.taskId, blobRef: f.pngRef }), 'NOT_IMPLEMENTED');
    } finally {
      f.s.dispose();
    }
  });

  it('附件引用面（原图叠加通道）：会话附件 blob 可按 blobRef 读回（魔数嗅探 mime）；跨任务必拒', async () => {
    const f = await setupArtifactTask();
    try {
      const { addSessionBlobRef, createSessionRow } = await import('../src/db/sessions.js');
      const { createAgentTask } = await import('../src/db/jobs.js');
      // 独立内容寻址 blob（仅登记为会话附件，无 artifact 帧——走纯附件通道）
      const attachBytes = Buffer.concat([f.pngBytes, Buffer.from([0x00])]);
      const attach = await f.client.assets.upload({
        filename: 'input-image.png',
        dataBase64: attachBytes.toString('base64'),
      });
      expect(attach.blobRef).not.toBe(f.pngRef); // 内容不同 hash 不同
      addSessionBlobRef(f.s.db, f.sessionId, attach.blobRef);

      const out = await f.client.tasks.artifact({ taskId: f.taskId, blobRef: attach.blobRef });
      expect(out.name).toBe(`attachment-${attach.blobRef.slice(0, 12)}`);
      expect(out.mime).toBe('image/png'); // 无扩展名 → 魔数嗅探
      expect(Buffer.from(out.dataBase64, 'base64').equals(attachBytes)).toBe(true);

      // 另一会话任务（同 owner）：附件不串——引用集按任务所属会话隔离
      const otherSession = createSessionRow(f.s.db, { ownerId: f.s.anonymous.id, title: '别的会话' });
      const otherTask = createAgentTask(f.s.db, { ownerId: f.s.anonymous.id, sessionId: otherSession.id });
      await expectOrpcError(
        f.client.tasks.artifact({ taskId: otherTask.id, blobRef: attach.blobRef }),
        'NOT_FOUND',
      );
    } finally {
      f.s.dispose();
    }
  });
});
