/**
 * session.exports / session.images RPC 面测试（product-polish-w1 归档环——
 * 「我的材料」行展开导出三件套 + 会话图片虚拟目录的数据面）。
 * 覆盖：
 *   [1] session.exports：任务导出 result（bundle.json 含 source 审计）进清单
 *       （imageId/sourceTaskId/download 投影）；独立 layout 导出（无 source）缺席；
 *       重导出两组均在（前端取每图最新）；过期行缺席；归属校验（跨用户拒）；
 *       不存在会话 BAD_REQUEST。
 *   [2] session.images：主图集审计行（params attachments+imageIds）→ 按会话分组
 *       （blobRef/name/mime/宽高魔数探测）；纯文本会话无分组；cleared 会话缺席；
 *       本人域（他人会话不进清单）；blob 不可读=null 面不炸。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { encodePng } from '../src/png/codec.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createSessionRow } from '../src/db/sessions.js';
import { createShareBundle } from '../src/share.js';
import { createUser } from '../src/db/store.js';
import { clientFor, createServices, type TestServices } from './helpers.js';
import type { UserRow } from '../src/db/store.js';

type ArchiveClient = ReturnType<typeof clientFor> & {
  session: {
    exports(input: { sessionId: string }): Promise<{
      sessionId: string;
      exports: Array<{
        resultId: string;
        publicId: string;
        exportedByTaskId: string;
        imageId: string;
        sourceTaskId: string;
        createdAt: string;
        expiresAt: string | null;
        download: string;
      }>;
    }>;
    images(): Promise<{
      groups: Array<{
        sessionId: string;
        title: string;
        updatedAt: string;
        images: Array<{ blobRef: string; name: string; mime: string | null; width: number | null; height: number | null }>;
      }>;
    }>;
  };
};

function archiveClient(s: TestServices, user?: UserRow): ArchiveClient {
  const c = clientFor(s.context({ user: user ?? s.anonymous }));
  return c as ArchiveClient;
}

async function expectOrpcError(promise: Promise<unknown>, code: string, messageFragment?: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
    if (messageFragment) {
      expect((error as ORPCError<string, unknown>).message).toContain(messageFragment);
    }
    return;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 主图集审计 params（A5 冻结分配面——kernel/index.ts auditParams 同形）。 */
const imageSetParams = (refs: string[], imageIds: string[]): string =>
  JSON.stringify({ text: '按图排钻', attachments: refs, imageIds });

describe('session.exports（T1 导出三件套读面）', () => {
  it('任务导出 result 进清单（imageId/download 投影）；无 source 审计的独立导出缺席；重导出多行', async () => {
    const s = createServices();
    try {
      const client = archiveClient(s);
      const session = createSessionRow(s.db, { ownerId: s.anonymous.id, title: '雪人单' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId: session.id, status: 'done' });

      // [a] 任务导出（带 source 审计——task-export 面同款）。
      const exported = await createShareBundle(
        { config: s.config, db: s.db, blobs: s.blobs },
        {
          taskId: task.id,
          ownerId: s.anonymous.id,
          title: '任务导出 image-1',
          files: { svg: enc('<svg/>'), bom: enc('供应商,SKU\n'), png: enc('PNG') },
          source: { sourceTaskId: task.id, imageId: 'image-1', taskLayoutRef: 'sha2:layout', manifestRevision: 1 },
        },
      );
      // [b] 独立 layout 导出（无 source 审计——studio.export 面）。
      await createShareBundle(
        { config: s.config, db: s.db, blobs: s.blobs },
        {
          taskId: task.id,
          ownerId: s.anonymous.id,
          title: '独立导出',
          files: { svg: enc('<svg/>'), bom: enc('bom\n'), png: enc('PNG') },
        },
      );
      // [c] 同图重导出（后一组 created_at 更晚——两组均在清单，前端取每图最新）。
      const reExported = await createShareBundle(
        { config: s.config, db: s.db, blobs: s.blobs },
        {
          taskId: task.id,
          ownerId: s.anonymous.id,
          title: '任务导出 image-1（重）',
          files: { svg: enc('<svg v2/>'), bom: enc('bom2\n'), png: enc('PNG2') },
          source: { sourceTaskId: task.id, imageId: 'image-1', taskLayoutRef: 'sha2:layout2', manifestRevision: 2 },
        },
      );

      const out = await client.session.exports({ sessionId: session.id });
      expect(out.sessionId).toBe(session.id);
      // 独立导出缺席；两组任务导出按 created_at 降序。
      expect(out.exports).toHaveLength(2);
      expect(out.exports[0]!.resultId).toBe(reExported.resultId);
      expect(out.exports[1]!.resultId).toBe(exported.resultId);
      for (const row of out.exports) {
        expect(row.publicId).toBeTruthy();
        expect(row.imageId).toBe('image-1');
        expect(row.sourceTaskId).toBe(task.id);
        expect(row.exportedByTaskId).toBe(task.id);
        expect(row.download).toBe(`/r/${row.publicId}`);
      }
    } finally {
      s.dispose();
    }
  });

  it('过期行缺席（/r/ 下载面 404 同语义——清单不出现点不开的链接）', async () => {
    const s = createServices();
    try {
      const client = archiveClient(s);
      const session = createSessionRow(s.db, { ownerId: s.anonymous.id, title: '过期单' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId: session.id, status: 'done' });
      const bundle = await createShareBundle(
        { config: s.config, db: s.db, blobs: s.blobs },
        {
          taskId: task.id,
          ownerId: s.anonymous.id,
          title: '已过期导出',
          files: { svg: enc('<svg/>'), bom: enc('bom\n'), png: enc('PNG') },
          source: { sourceTaskId: task.id, imageId: 'image-1', taskLayoutRef: 'sha2:layout', manifestRevision: 1 },
        },
      );
      // 直改 expires_at 模拟 TTL 已过（未及物理清扫——读面须先行缺席）。
      s.db
        .prepare('UPDATE results SET expires_at = ? WHERE id = ?')
        .run('2000-01-01T00:00:00.000Z', bundle.resultId);
      const out = await client.session.exports({ sessionId: session.id });
      expect(out.exports).toHaveLength(0);
    } finally {
      s.dispose();
    }
  });

  it('归属校验：跨用户会话拒；不存在会话 BAD_REQUEST', async () => {
    const s = createServices();
    try {
      const other = archiveClient(s, {
        ...(s.anonymous as UserRow),
        id: 'user-other',
        username: 'other',
      } as UserRow);
      const session = createSessionRow(s.db, { ownerId: s.anonymous.id, title: '别人的单' });
      await expectOrpcError(other.session.exports({ sessionId: session.id }), 'BAD_REQUEST', '无权访问该会话');
      await expectOrpcError(other.session.exports({ sessionId: 'sess-none' }), 'BAD_REQUEST', '会话不存在');
    } finally {
      s.dispose();
    }
  });
});

describe('session.images（T2 会话图片虚拟目录读面）', () => {
  /** 96×96 测试 PNG（workbench-rpc.test 同款三色块）。 */
  function testPng(): Uint8Array {
    const w = 96;
    const h = 96;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const p = (y * w + x) * 4;
        const [r, g, b] = y >= 80 ? [230, 200, 40] : x < w / 2 ? [200, 40, 40] : [40, 60, 200];
        rgba[p] = r;
        rgba[p + 1] = g;
        rgba[p + 2] = b;
        rgba[p + 3] = 255;
      }
    }
    return new Uint8Array(encodePng(w, h, rgba));
  }

  it('主图集审计行→按会话分组（mime/宽高魔数探测）；纯文本会话与 cleared 会话缺席；本人域', async () => {
    const s = createServices();
    try {
      const client = archiveClient(s);
      // [a] 带主图集会话（两图）。
      const session = createSessionRow(s.db, { ownerId: s.anonymous.id, title: '雪人单' });
      const ref1 = s.blobs.put(testPng()).hash;
      const ref2 = s.blobs.put(testPng()).hash;
      createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId: session.id,
        paramsJson: imageSetParams([ref1, ref2], ['image-1', 'image-2']),
        status: 'done',
      });
      // [b] 纯文本会话（无图集审计）。
      createSessionRow(s.db, { ownerId: s.anonymous.id, title: '纯文本单' });
      // [c] cleared 会话（列表语义缺席）。
      const cleared = createSessionRow(s.db, { ownerId: s.anonymous.id, title: '已清理单' });
      s.db.prepare("UPDATE sessions SET status = 'cleared' WHERE id = ?").run(cleared.id);
      // [d] 他人的会话（本人域外——真实第二用户行，FK 合法）。
      const other = createUser(s.db, { username: 'rival-w1', passwordHash: 'x', role: 'user' });
      const foreign = createSessionRow(s.db, { ownerId: other.id, title: '别人的单' });
      createAgentTask(s.db, {
        ownerId: other.id,
        sessionId: foreign.id,
        paramsJson: imageSetParams([ref1], ['image-1']),
        status: 'done',
      });

      const out = await client.session.images();
      expect(out.groups).toHaveLength(1);
      const group = out.groups[0]!;
      expect(group.sessionId).toBe(session.id);
      expect(group.title).toBe('雪人单');
      expect(group.images).toHaveLength(2);
      expect(group.images[0]).toMatchObject({ blobRef: ref1, mime: 'image/png', width: 96, height: 96 });
      expect(group.images[1]).toMatchObject({ blobRef: ref2, mime: 'image/png', width: 96, height: 96 });
      expect(group.images[0]!.name).toMatch(/^attachment-.{12}\.png$/);
    } finally {
      s.dispose();
    }
  });

  it('图集 blob 不可读（人工清库模拟）→null 投影面不炸；清单仍返回分组', async () => {
    const s = createServices();
    try {
      const client = archiveClient(s);
      const session = createSessionRow(s.db, { ownerId: s.anonymous.id, title: '坏图单' });
      // blobs.put 后改写 hash 模拟不可读引用（audit 面无 FK 约束——真源腐蚀走 null 面）。
      createAgentTask(s.db, {
        ownerId: s.anonymous.id,
        sessionId: session.id,
        paramsJson: imageSetParams(['sha2:ghost'], ['image-1']),
        status: 'done',
      });
      const out = await client.session.images();
      expect(out.groups).toHaveLength(1);
      expect(out.groups[0]!.images[0]).toMatchObject({ blobRef: 'sha2:ghost', mime: null, width: null, height: null });
    } finally {
      s.dispose();
    }
  });
});
