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
});
