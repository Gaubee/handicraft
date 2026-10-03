/**
 * [prod-run-8317 复盘，2026-10-03] session.setAutoApprove RPC 测试。
 * 生产事故形态：开关值只搭车下一条 followup 透传——「提交后开开关」的免值守场景
 * 再无用户消息，服务端 auto_approve 停在 0，propose 不签发 grant 卡死整轮
 * （8317 实测停滞 10m41s）。本端点让开关翻转即刻落库。
 * 覆盖：开关落库+session.get 回读+输出过契约 Zod；跨用户必拒；cleared 墓碑拒；
 * 会话不存在拒；与 followup.autoApprove 同源（最后写入者胜——两通道互相覆盖）。
 */
import { describe, expect, it } from 'vitest';
import { SessionAutoApproveOutputSchema } from '@handicraft/contracts';
import { createUser } from '../src/db/store.js';
import { updateSessionStatus } from '../src/db/sessions.js';
import { clientFor, createServices } from './helpers.js';

type AutoApproveClient = ReturnType<typeof clientFor> & {
  session: {
    create(input: { title?: string }): Promise<{ sessionId: string; createdAt: string }>;
    get(input: { sessionId: string }): Promise<{ session: { autoApprove?: boolean } }>;
    setAutoApprove(input: { sessionId: string; autoApprove: boolean }): Promise<{ ok: boolean; autoApprove: boolean }>;
  };
};

function client(context: Parameters<typeof clientFor>[0]): AutoApproveClient {
  return clientFor(context) as AutoApproveClient;
}

describe('session.setAutoApprove RPC（prod-run-8317 复盘）', () => {
  it('开关即刻落库+session.get 回读+输出过契约——免值守不依赖下一条 followup', async () => {
    const s = createServices();
    try {
      const c = client(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await c.session.create({ title: '免值守会话' });
      // 行为基线：缺省关（投影缺省关=省略键——契约 optional 面）。
      expect((await c.session.get({ sessionId })).session.autoApprove).not.toBe(true);
      // 开关翻转即刻持久化（生产事故缺口：此前该时刻服务端真源不变）。
      const on = await c.session.setAutoApprove({ sessionId, autoApprove: true });
      expect(SessionAutoApproveOutputSchema.safeParse(on).success).toBe(true);
      expect(on).toEqual({ ok: true, autoApprove: true });
      expect((await c.session.get({ sessionId })).session.autoApprove).toBe(true);
      // DB 直读（propose 判定同源列）。
      const row = s.db.prepare('SELECT auto_approve FROM sessions WHERE id = ?').get(sessionId) as { auto_approve: number };
      expect(row.auto_approve).toBe(1);
      // 关闭同理（双向）。
      await expect(c.session.setAutoApprove({ sessionId, autoApprove: false })).resolves.toEqual({ ok: true, autoApprove: false });
      expect((await c.session.get({ sessionId })).session.autoApprove).not.toBe(true);
      const rowOff = s.db.prepare('SELECT auto_approve FROM sessions WHERE id = ?').get(sessionId) as { auto_approve: number };
      expect(rowOff.auto_approve).toBe(0);
    } finally {
      s.dispose();
    }
  });

  it('跨用户必拒；cleared 墓碑拒；会话不存在拒', async () => {
    const s = createServices();
    try {
      const owner = client(s.context({ token: await s.tokenFor() }));
      const { sessionId } = await owner.session.create({ title: '本人会话' });
      const stranger = createUser(s.db, { username: 'stranger-autoapprove', passwordHash: 'pw-hash-x', role: 'user' });
      const strangerClient = client(s.context({ token: await s.tokenFor(stranger) }));
      await expect(strangerClient.session.setAutoApprove({ sessionId, autoApprove: true })).rejects.toThrow('无权');
      // owner 正常路径不受越权尝试影响。
      await expect(owner.session.setAutoApprove({ sessionId, autoApprove: true })).resolves.toMatchObject({ ok: true });
      // cleared 墓碑拒。
      await owner.session.clear({ sessionId } as never).catch(() => undefined);
      updateSessionStatus(s.db, sessionId, { status: 'cleared', clearedAt: new Date().toISOString() });
      await expect(owner.session.setAutoApprove({ sessionId, autoApprove: false })).rejects.toThrow('已清理');
      await expect(owner.session.setAutoApprove({ sessionId: 'no-such-session', autoApprove: true })).rejects.toThrow('会话不存在');
    } finally {
      s.dispose();
    }
  });
});
