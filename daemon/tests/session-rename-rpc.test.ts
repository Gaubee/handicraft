/**
 * [真链复验 P1-G，2026-10-01] session.rename RPC 测试（复验被迫直写 SQLite 改
 * 标题的收口——最小端点：requireOwnedSession 本人域）。
 * 覆盖：改名落库+列表回读+输出过契约 Zod；trim 空标题/超长标题契约拒；跨用户
 * 必拒；cleared 墓碑拒；会话不存在拒。
 */
import { describe, expect, it } from 'vitest';
import { SessionRenameOutputSchema } from '@handicraft/contracts';
import { createUser } from '../src/db/store.js';
import { updateSessionStatus } from '../src/db/sessions.js';
import { clientFor, createServices } from './helpers.js';

type RenameClient = ReturnType<typeof clientFor> & {
  session: {
    create(input: { title?: string }): Promise<{ sessionId: string; createdAt: string }>;
    list(input?: { limit?: number }): Promise<{ sessions: Array<{ id: string; title: string }> }>;
    rename(input: { sessionId: string; title: string }): Promise<{ ok: boolean; title: string }>;
  };
};

function renameClient(context: Parameters<typeof clientFor>[0]): RenameClient {
  return clientFor(context) as RenameClient;
}

describe('session.rename RPC（P1-G）', () => {
  it('改名落库+列表回读+输出过契约；空标题/超长标题契约拒', async () => {
    const s = createServices();
    try {
      const client = renameClient(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await client.session.create({ title: '原标题' });
      const renamed = await client.session.rename({ sessionId, title: '  小丑贴钻·终版  ' });
      expect(SessionRenameOutputSchema.safeParse(renamed).success).toBe(true);
      expect(renamed.ok).toBe(true);
      expect(renamed.title).toBe('小丑贴钻·终版'); // 契约层 trim 回显。
      const listed = await client.session.list({ limit: 10 });
      expect(listed.sessions.find((x) => x.id === sessionId)?.title).toBe('小丑贴钻·终版');
      // 行为面：trim 后空串/超长标题在契约层拒（strict schema）。
      await expect(client.session.rename({ sessionId, title: '   ' })).rejects.toThrow();
      await expect(client.session.rename({ sessionId, title: 'x'.repeat(201) })).rejects.toThrow();
    } finally {
      s.dispose();
    }
  });

  it('跨用户必拒；cleared 墓碑拒；会话不存在拒', async () => {
    const s = createServices();
    try {
      const owner = renameClient(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await owner.session.create({ title: '本人会话' });
      const stranger = createUser(s.db, { username: 'stranger-rename', passwordHash: 'pw-hash-x', role: 'user' });
      const strangerClient = renameClient(s.context({ token: await s.tokenFor(stranger) }));
      await expect(strangerClient.session.rename({ sessionId, title: '越权改名' })).rejects.toThrow('无权');
      // owner 正常路径不受越权尝试影响。
      await expect(owner.session.rename({ sessionId, title: '本人改名' })).resolves.toMatchObject({ ok: true });
      // cleared 墓碑拒。
      await owner.session.clear({ sessionId: sessionId } as never).catch(() => undefined);
      updateSessionStatus(s.db, sessionId, { status: 'cleared', clearedAt: new Date().toISOString() });
      await expect(owner.session.rename({ sessionId, title: '墓碑改名' })).rejects.toThrow('已清理');
      await expect(owner.session.rename({ sessionId: 'no-such-session', title: 'x' })).rejects.toThrow('会话不存在');
    } finally {
      s.dispose();
    }
  });
});
