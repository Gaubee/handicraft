/**
 * split-admin-portal 波 1 daemon 集成测试（tasks 1.1-1.3 验收门）。
 * createRouterClient 直调（不穿 WS——rpc.test.ts 同模式），真 sqlite+真 handler。
 * 覆盖：
 *   [1] auth.login/refresh/me 全链（口令校验/禁用拒发/禁用拒刷新/me 按 DB 复核）。
 *   [2] 权限矩阵：匿名/普通/admin × admin.*+models 收权面+imageProcessing——
 *       全拒（UNAUTHORIZED/FORBIDDEN）与 admin 放行；models.available 保持活动用户读。
 *   [3] 账号管理三禁（__anonymous__ 改密/禁用/改角色拒；不能禁用/降级自己）+
 *       禁用收紧语义（禁用后读/刷新/新登录全拒，恢复即复通）。
 *   [4] admin.settingsGet/settingsUpdate（allowAnonymous 白名单键生效+siteName 新键）。
 *   [5] userDelete 级联清理（0.2 贴钻表域清单：会话/任务/资源/blob 引用账本/
 *       授权域/outbox/users 行+磁盘任务与 bundle 目录；共享 blob 计数不误伤）。
 *   [6] bootstrap adminConfigured=DB 实存 admin 行投影（1.3）。
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { ANONYMOUS_USERNAME } from '@handicraft/contracts';
import { hashPassword } from '../src/auth.js';
import { createUser, nowIso, type UserRow } from '../src/db/store.js';
import { addSessionBlobRef, createSessionRow, enqueueOutbox } from '../src/db/sessions.js';
import { createAgentTask, createResult } from '../src/db/jobs.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

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

/** 建号（直插行——login 链测试走真实 RPC 面）。 */
function makeUser(s: TestServices, username: string, role: 'admin' | 'user', password = 'pw-1'): UserRow {
  return createUser(s.db, { username, passwordHash: hashPassword(password), role });
}

/** 建号并返回其 RPC 客户端（token 经 signJwt——helpers 同源）。 */
async function clientOf(s: TestServices, user: UserRow) {
  return clientFor(s.context({ token: await s.tokenFor(user) }));
}

describe('auth.login/refresh/me 全链（1.1）', () => {
  it('login：口令校验（错口令/未知用户 UNAUTHORIZED；__anonymous__ FORBIDDEN）；正确→TokenOutput 形状', async () => {
    const s = createServices();
    try {
      makeUser(s, 'boss', 'admin', 'secret-pw');
      const client = clientFor(s.context());
      await expectOrpcError(client.auth.login({ username: 'boss', password: 'wrong' }), 'UNAUTHORIZED');
      await expectOrpcError(client.auth.login({ username: 'ghost', password: 'x' }), 'UNAUTHORIZED');
      await expectOrpcError(client.auth.login({ username: ANONYMOUS_USERNAME, password: 'x' }), 'FORBIDDEN');

      const out = await client.auth.login({ username: 'boss', password: 'secret-pw' });
      expect(out.user).toEqual({ username: 'boss', role: 'admin' });
      expect(out.token.split('.')).toHaveLength(3);
      expect(out.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      s.dispose();
    }
  });

  it('me：无 token UNAUTHORIZED；带 token → {username, role}（camelCase 契约冻结面）', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      await expectOrpcError(clientFor(s.context()).auth.me(), 'UNAUTHORIZED');
      const me = await (await clientOf(s, boss)).auth.me();
      expect(me).toEqual({ username: 'boss', role: 'admin' });
    } finally {
      s.dispose();
    }
  });

  it('refresh：入参 token / 连接 token 双形态换新；垃圾凭证 UNAUTHORIZED', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const client = clientFor(s.context());
      const first = await client.auth.login({ username: 'boss', password: 'pw-1' });
      // 入参 token 形态（未带连接 token 的裸客户端）
      const second = await client.auth.refresh({ token: first.token });
      expect(second.user).toEqual({ username: 'boss', role: 'admin' });
      // 同秒签发的 JWT 字节级相同——有效性以「刷新产物可再认证」断言，不做字节不等比较
      expect(
        (await clientFor(s.context({ token: second.token })).auth.me()).username,
      ).toBe('boss');
      // 连接 token 形态（无参调用）
      const connClient = clientFor(s.context({ token: first.token }));
      const third = await connClient.auth.refresh();
      expect(third.user.username).toBe('boss');
      await expectOrpcError(client.auth.refresh({ token: 'garbage' }), 'UNAUTHORIZED');
      await expectOrpcError(clientFor(s.context()).auth.refresh(), 'UNAUTHORIZED');
      void boss;
    } finally {
      s.dispose();
    }
  });

  it('禁用语义（0.2 收紧）：禁用后新登录拒发、旧 token 刷新拒、me/tasks 读拒；恢复即复通', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const worker = makeUser(s, 'worker', 'user');
      const adminClient = await clientOf(s, boss);
      const workerToken = await s.tokenFor(worker);
      const workerClient = clientFor(s.context({ token: workerToken }));
      expect((await workerClient.tasks.list()).tasks).toEqual([]);

      // admin 禁用 worker（RPC 面）
      const updated = await adminClient.admin.userUpdate({ username: 'worker', disabled: true });
      expect(updated.disabled).toBe(true);

      await expectOrpcError(
        clientFor(s.context()).auth.login({ username: 'worker', password: 'pw-1' }),
        'FORBIDDEN',
      );
      await expectOrpcError(clientFor(s.context()).auth.refresh({ token: workerToken }), 'FORBIDDEN');
      await expectOrpcError(workerClient.auth.me(), 'FORBIDDEN');
      await expectOrpcError(workerClient.tasks.list(), 'FORBIDDEN'); // 读面同拒（禁用即拒）

      // 恢复：同一旧 token 复通（守卫按 DB 当前态复核，不信快照）
      await adminClient.admin.userUpdate({ username: 'worker', disabled: false });
      expect((await workerClient.tasks.list()).tasks).toEqual([]);
    } finally {
      s.dispose();
    }
  });
});

describe('权限矩阵：匿名/普通/admin × 管理端点（1.7 门）', () => {
  it('admin.*/models 收权面/imageProcessing：无 token UNAUTHORIZED；匿名与普通用户 FORBIDDEN', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const worker = makeUser(s, 'worker', 'user');
      const anon = clientFor(s.context({ token: await s.tokenFor() }));
      const user = await clientOf(s, worker);
      const bare = clientFor(s.context());

      // 无输入读面
      for (const client of [bare]) {
        await expectOrpcError(client.admin.userList(), 'UNAUTHORIZED');
        await expectOrpcError(client.admin.settingsGet(), 'UNAUTHORIZED');
        await expectOrpcError(client.models.get(), 'UNAUTHORIZED');
        await expectOrpcError(client.models.catalog(), 'UNAUTHORIZED');
        await expectOrpcError(client.imageProcessing.get(), 'UNAUTHORIZED');
      }
      // 匿名/普通 × 管理面（读+写+模型/图像设置——1.3 收权五端点同守卫 requireAdmin）
      for (const client of [anon, user]) {
        await expectOrpcError(client.admin.userList(), 'FORBIDDEN');
        await expectOrpcError(client.admin.settingsGet(), 'FORBIDDEN');
        await expectOrpcError(
          client.admin.userCreate({ username: 'sneak', password: 'p', role: 'user' }),
          'FORBIDDEN',
        );
        await expectOrpcError(client.admin.userUpdate({ username: 'boss', disabled: true }), 'FORBIDDEN');
        await expectOrpcError(client.admin.userDelete({ username: 'worker' }), 'FORBIDDEN');
        await expectOrpcError(client.admin.settingsUpdate({ allowAnonymous: true }), 'FORBIDDEN');
        await expectOrpcError(client.models.get(), 'FORBIDDEN');
        await expectOrpcError(client.models.catalog(), 'FORBIDDEN');
        await expectOrpcError(client.models.save({ routes: [], default: null }), 'FORBIDDEN');
        await expectOrpcError(client.imageProcessing.get(), 'FORBIDDEN');
        await expectOrpcError(client.imageProcessing.save({ preset: 'fast' }), 'FORBIDDEN');
      }
      void boss;
    } finally {
      s.dispose();
    }
  });

  it('admin 放行：userList/settingsGet/models.get/catalog/imageProcessing 可用；available 保持活动用户读', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const worker = makeUser(s, 'worker', 'user');
      const admin = await clientOf(s, boss);

      const { users } = await admin.admin.userList();
      expect(users.map((u) => u.username)).toContain('boss');
      // __anonymous__ 不入列表（视图 role 两值——匿名开合走 settings 面）
      expect(users.some((u) => u.username === ANONYMOUS_USERNAME)).toBe(false);

      const settings = await admin.admin.settingsGet();
      expect(settings.allowAnonymous).toBe(false); // 0.1 缺省关（无 env 无 settings 键）
      expect(typeof settings.siteName).toBe('string');

      expect((await admin.models.get()).routes).toEqual([]);
      expect((await admin.models.catalog()).presets.length).toBeGreaterThan(0);
      expect((await admin.imageProcessing.get()).source).toBe('default');

      // models.available：普通用户/匿名（活动）可读——「保持 requireActiveUser 只读」
      const workerClient = await clientOf(s, worker);
      const anonClient = clientFor(s.context({ token: await s.tokenFor() }));
      expect(Array.isArray((await workerClient.models.available()).models)).toBe(true);
      expect(Array.isArray((await anonClient.models.available()).models)).toBe(true);
    } finally {
      s.dispose();
    }
  });
});

describe('账号管理：三禁 + 建号 + 禁用收紧（1.2）', () => {
  it('userCreate：建号往返；重名 CONFLICT；__anonymous__ 保留名 CONFLICT', async () => {
    const s = createServices();
    try {
      const admin = await clientOf(s, makeUser(s, 'boss', 'admin'));
      const created = await admin.admin.userCreate({
        username: 'worker',
        password: 'w-pw',
        role: 'user',
      });
      expect(created).toMatchObject({ username: 'worker', role: 'user', disabled: false });
      expect(typeof created.createdAt).toBe('string');
      await expectOrpcError(
        admin.admin.userCreate({ username: 'worker', password: 'x', role: 'user' }),
        'CONFLICT',
      );
      await expectOrpcError(
        admin.admin.userCreate({ username: ANONYMOUS_USERNAME, password: 'x', role: 'user' }),
        'CONFLICT',
      );
      // 新号可登录（真实 login 面）
      const login = await clientFor(s.context()).auth.login({ username: 'worker', password: 'w-pw' });
      expect(login.user.role).toBe('user');
    } finally {
      s.dispose();
    }
  });

  it('__anonymous__ 三禁：改密/禁用/改角色各typed 拒（CONFLICT）', async () => {
    const s = createServices();
    try {
      const admin = await clientOf(s, makeUser(s, 'boss', 'admin'));
      await expectOrpcError(
        admin.admin.userUpdate({ username: ANONYMOUS_USERNAME, password: 'x' }),
        'CONFLICT',
      );
      await expectOrpcError(
        admin.admin.userUpdate({ username: ANONYMOUS_USERNAME, disabled: true }),
        'CONFLICT',
      );
      await expectOrpcError(
        admin.admin.userUpdate({ username: ANONYMOUS_USERNAME, role: 'user' }),
        'CONFLICT',
      );
    } finally {
      s.dispose();
    }
  });

  it('不能禁用/降级自己；可禁用/降级其他 admin；改密即时生效', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const admin = await clientOf(s, boss);
      await expectOrpcError(admin.admin.userUpdate({ username: 'boss', disabled: true }), 'CONFLICT');
      await expectOrpcError(admin.admin.userUpdate({ username: 'boss', role: 'user' }), 'CONFLICT');

      const other = makeUser(s, 'boss2', 'admin', 'pw-2');
      const demoted = await admin.admin.userUpdate({ username: 'boss2', role: 'user' });
      expect(demoted.role).toBe('user');
      const disabled = await admin.admin.userUpdate({ username: 'boss2', disabled: true });
      expect(disabled.disabled).toBe(true);

      // 改密即时生效：旧口令拒、新口令通
      await admin.admin.userUpdate({ username: 'boss2', password: 'pw-3', disabled: false });
      const bare = clientFor(s.context());
      await expectOrpcError(bare.auth.login({ username: 'boss2', password: 'pw-2' }), 'UNAUTHORIZED');
      expect((await bare.auth.login({ username: 'boss2', password: 'pw-3' })).user.username).toBe('boss2');
      void other;
    } finally {
      s.dispose();
    }
  });

  it('userUpdate 未知用户 NOT_FOUND；空载荷 orpc input 层 typed 拒（BAD_REQUEST）', async () => {
    const s = createServices();
    try {
      const admin = await clientOf(s, makeUser(s, 'boss', 'admin'));
      await expectOrpcError(admin.admin.userUpdate({ username: 'ghost', disabled: true }), 'NOT_FOUND');
      await expectOrpcError(
        admin.admin.userUpdate({ username: 'boss' } as never),
        'BAD_REQUEST',
      );
    } finally {
      s.dispose();
    }
  });
});

describe('admin.settingsGet/settingsUpdate（1.2 白名单键）', () => {
  it('allowAnonymous 写 settings 既有键并投影 bootstrap；siteName 新键落库；空 siteName typed 拒', async () => {
    const s = createServices();
    try {
      const admin = await clientOf(s, makeUser(s, 'boss', 'admin'));
      const bare = clientFor(s.context());

      expect((await bare.bootstrap()).allowAnonymous).toBe(false); // 0.1 缺省关
      const opened = await admin.admin.settingsUpdate({ allowAnonymous: true });
      expect(opened).toEqual({ allowAnonymous: true, siteName: '' });
      expect((await bare.bootstrap()).allowAnonymous).toBe(true);
      expect(s.db.prepare("SELECT value FROM settings WHERE key = 'allow_anonymous'").get()).toEqual({
        value: '1',
      });

      const named = await admin.admin.settingsUpdate({ siteName: '贴钻工作台' });
      expect(named.siteName).toBe('贴钻工作台');
      expect(s.db.prepare("SELECT value FROM settings WHERE key = 'site_name'").get()).toEqual({
        value: '贴钻工作台',
      });

      const reread = await admin.admin.settingsGet();
      expect(reread).toEqual({ allowAnonymous: true, siteName: '贴钻工作台' });

      await expectOrpcError(admin.admin.settingsUpdate({ siteName: '' }), 'BAD_REQUEST');
      // 关回（0.1 双层真源——settings 键显式 '0' 压过 env 缺省）
      const closed = await admin.admin.settingsUpdate({ allowAnonymous: false });
      expect(closed.allowAnonymous).toBe(false);
      expect((await bare.bootstrap()).allowAnonymous).toBe(false);
    } finally {
      s.dispose();
    }
  });
});

describe('admin.userDelete 级联清理（0.2 域清单 + 1.2）', () => {
  it('全域清理：会话/任务/资源/blob 账本/授权域/outbox/users 行+磁盘目录；共享 blob 计数不误伤', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const admin = await clientOf(s, boss);
      const victim = makeUser(s, 'victim', 'user');
      const keeper = makeUser(s, 'keeper', 'user');

      // —— victim 数据域（直插行——rpc 面各域已有专项测试，此处验证级联覆盖面）
      const blobOnly = s.blobs.put(Buffer.from('victim-only-blob')); // 仅 victim 引用
      const blobShared = s.blobs.put(Buffer.from('shared-blob')); // victim 引用①（result 账本）
      s.blobs.put(Buffer.from('shared-blob')); // victim 引用②（resources.content_hash）
      s.blobs.put(Buffer.from('shared-blob')); // keeper 侧引用（不随删除释放）→ ref_count=3

      const session = createSessionRow(s.db, { ownerId: victim.id, title: 'v-s' });
      addSessionBlobRef(s.db, session.id, blobOnly.hash);
      const task = createAgentTask(s.db, {
        ownerId: victim.id,
        sessionId: session.id,
        paramsJson: JSON.stringify({ text: 'hi' }),
      });
      s.db.prepare(
        "INSERT INTO tree_versions (task_id, version, tree_blob_ref, preview_blob_ref, cause, detail, actor_id, created_at) VALUES (?, 1, ?, ?, 'journey', NULL, ?, ?)",
      ).run(task.id, blobOnly.hash, blobOnly.hash, victim.id, nowIso());
      s.db.prepare(
        "INSERT INTO mask_edit_states (task_id, node_id, state, run_count, base_version, error, updated_at) VALUES (?, 'n1', 'ready', 0, 1, NULL, ?)",
      ).run(task.id, nowIso());

      const bundleDir = path.join(s.config.dataRoot, 'results', 'pub-victim');
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(path.join(bundleDir, 'bundle.json'), '{}');
      const result = createResult(s.db, {
        taskId: task.id,
        ownerId: victim.id,
        title: 'v-r',
        bundlePath: bundleDir,
        publicId: 'pub-victim',
      });
      s.db.prepare('INSERT INTO result_blob_refs (result_id, blob_hash, created_at) VALUES (?, ?, ?)').run(
        result.id,
        blobShared.hash,
        nowIso(),
      );

      const victimResource = s.db
        .prepare(
          "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES (?, ?, NULL, 'v.json', 0, ?, 3, NULL, 1, ?, ?)",
        )
        .run(`res-victim-${task.id.slice(0, 8)}`, victim.id, blobShared.hash, nowIso(), nowIso());
      void victimResource;
      const victimResourceId = (
        s.db.prepare('SELECT id FROM resources WHERE owner_id = ?').get(victim.id) as { id: string }
      ).id;
      s.db.prepare(
        "INSERT INTO stone_index (resource_id, owner_id, supplier, sku, style_row, style_name, family, size_mm, color_hex, finish, trashed, updated_at) VALUES (?, ?, 'SUP', 'SKU-V', 1, 'V', '透明', 2.0, '#FFFFFF', NULL, 0, ?)",
      ).run(victimResourceId, victim.id, nowIso());

      s.db.prepare(
        "INSERT INTO approved_ops (proposal_id, task_id, user_id, tool, op_digest, resource_id, state, created_at, updated_at) VALUES ('prop-v', ?, ?, 'setDensity', 'digest', ?, 'succeeded', ?, ?)",
      ).run(task.id, victim.id, victimResourceId, nowIso(), nowIso());
      s.db.prepare(
        "INSERT INTO attempts (attempt_id, proposal_id, attempt_no, idem_key, retry_request_id, state, created_at, updated_at) VALUES ('att-v', 'prop-v', 1, 'idem', 'rr-v', 'succeeded', ?, ?)",
      ).run(nowIso(), nowIso());
      s.db.prepare(
        "INSERT INTO grants (id, proposal_id, task_id, op_digest, user_id, resource_id, base_revision, expires_at, consumed, created_at) VALUES ('gr-v', 'prop-v', ?, 'digest', ?, ?, 1, ?, 0, ?)",
      ).run(task.id, victim.id, victimResourceId, nowIso(), nowIso());
      s.db.prepare(
        "INSERT INTO patch_history (id, owner_id, resource_id, patch_group, proposal_id, op_kind, target, before_json, after_json, base_revision, created_at) VALUES ('ph-v', ?, ?, 'g1', 'prop-v', 'setDensity', 't', '{}', '{}', 1, ?)",
      ).run(victim.id, victimResourceId, nowIso());
      enqueueOutbox(s.db, [{ kind: 'dir', path: path.join(s.config.dataRoot, 'tasks', task.id), session_id: session.id }]);

      // victim 任务目录（磁盘）
      const taskDir = path.join(s.config.dataRoot, 'tasks', task.id);
      mkdirSync(taskDir, { recursive: true });
      expect(existsSync(taskDir)).toBe(true);
      expect(existsSync(bundleDir)).toBe(true);

      // —— 删除前拒面：__anonymous__ / 自己 / 未知
      await expectOrpcError(admin.admin.userDelete({ username: ANONYMOUS_USERNAME }), 'CONFLICT');
      await expectOrpcError(admin.admin.userDelete({ username: 'boss' }), 'CONFLICT');
      await expectOrpcError(admin.admin.userDelete({ username: 'ghost' }), 'NOT_FOUND');

      // —— 级联删除
      const out = await admin.admin.userDelete({ username: 'victim' });
      expect(out.ok).toBe(true);

      // users 行 + 各域行清零
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM users WHERE username = ?').get('victim')).toEqual({ n: 0 });
      const count = (sql: string, ...params: unknown[]): number =>
        (s.db.prepare(sql).get(...params) as { n: number }).n;
      expect(count('SELECT COUNT(*) AS n FROM tasks WHERE owner_id = ?', victim.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM results WHERE owner_id = ?', victim.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM resources WHERE owner_id = ?', victim.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ?', victim.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM tree_versions WHERE task_id = ?', task.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM mask_edit_states WHERE task_id = ?', task.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM approved_ops WHERE user_id = ?', victim.id)).toBe(0);
      expect(count("SELECT COUNT(*) AS n FROM attempts WHERE proposal_id = 'prop-v'")).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM grants WHERE user_id = ?', victim.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM patch_history WHERE owner_id = ?', victim.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM stone_index WHERE resource_id = ?', victimResourceId)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM session_blob_refs WHERE session_id = ?', session.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM result_blob_refs WHERE result_id = ?', result.id)).toBe(0);
      expect(count('SELECT COUNT(*) AS n FROM cleanup_outbox WHERE session_id = ?', session.id)).toBe(0);

      // 磁盘目录整删
      expect(existsSync(taskDir)).toBe(false);
      expect(existsSync(bundleDir)).toBe(false);

      // blob 计数：victim 独占→归零置 deleting；共享→计数递减且保持 active
      // （rowOf 只投影 active 行——deleting 态直接查 blobs 表）
      const blobRow = (hash: string) =>
        s.db.prepare('SELECT status, ref_count FROM blobs WHERE hash = ?').get(hash) as {
          status: string;
          ref_count: number;
        };
      expect(blobRow(blobOnly.hash)).toEqual({ status: 'deleting', ref_count: 0 });
      expect(blobRow(blobShared.hash)).toEqual({ status: 'active', ref_count: 1 }); // keeper 侧引用仍在
      expect(s.blobs.read(blobShared.hash)).not.toBeNull();

      // keeper 不受影响
      const keeperClient = await clientOf(s, keeper);
      expect((await keeperClient.tasks.list()).tasks).toEqual([]);
      void boss;
    } finally {
      s.dispose();
    }
  });
});

describe('bootstrap adminConfigured（1.3——DB 实存 admin 行投影）', () => {
  it('无 admin 行 false；建 admin 行后 true（.env ADMIN_* 空也真——「有 admin 用户即可登录后台」）', async () => {
    const s = createServices();
    try {
      const bare = clientFor(s.context());
      expect((await bare.bootstrap()).adminConfigured).toBe(false);
      makeUser(s, 'boss', 'admin');
      expect((await bare.bootstrap()).adminConfigured).toBe(true);
      expect(s.config.adminUsername).toBe(''); // .env 侧确未配置——投影真源是 DB 行
    } finally {
      s.dispose();
    }
  });
});
