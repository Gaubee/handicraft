/**
 * 知识库全链集成测试（split-admin-portal 3.1/3.3 验收门——zhumo test/kb.test.ts
 * 复刻适配）。createRouterClient 直调（不穿 WS——admin-portal-rpc.test.ts 同模式）。
 * 覆盖：
 *   [1] KbStore：贴钻种子幂等、CRUD、改名、非法名拒绝、修订流、快照/恢复
 *       （git 存在时；缺 git 的设备上历史用例自动跳过且读写不炸）+ git 缺席
 *       降级路径（PATH 探测失败 → available=false，读写照常）。
 *   [2] capability：studio.kb_list/kb_get 只读面（agent 主体）+ MCP 投影工具名
 *       （mcpToolName studio.* 去前缀）+ 与既有 registry 组合（compose 重名防线）。
 *   [3] rpc：admin.kb.* 读写历史恢复全链 + 权限矩阵（无 token/匿名/普通用户拒；
 *       actor=admin:<username> 入 commit author）+ 无注入实例时 dataRoot 兜底。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import { KbStore } from '../src/kb/store.js';
import { KB_SEED } from '../src/kb/seed.js';
import { createKnowledgeCapabilities } from '../src/capability/knowledge.js';
import { createCapabilityRegistry } from '../src/capability/core.js';
import { composeRegistries } from '../src/capability/stones.js';
import { mcpToolName, createStudioMcpServer } from '../src/capability/mcp.js';
import { clientFor, createServices, type TestServices } from './helpers.js';
import type { UserRow } from '../src/db/store.js';
import { hashPassword } from '../src/auth.js';
import { createUser } from '../src/db/store.js';

let root: string;
let store: KbStore;
const hasGit = spawnSync('git', ['--version']).status === 0;

function makeUser(s: TestServices, username: string, role: 'admin' | 'user', password = 'pw-1'): UserRow {
  return createUser(s.db, { username, passwordHash: hashPassword(password), role });
}

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

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'handicraft-kb-'));
  store = new KbStore(path.join(root, 'knowledge'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- [1] KbStore

describe('KbStore：贴钻种子与 CRUD', () => {
  it('种子：空库落盘一次（五组领域内容），手工改过永不被覆盖', async () => {
    const seeded = await store.ensureSeeded();
    expect(seeded).toBe(true);
    const groups = store.listAll();
    expect(groups.map((g) => g.name).sort()).toEqual([...KB_SEED.map((g) => g.name)].sort());
    // 贴钻领域内容抽查：SS 尺码表 / ΔE 三档 / 可读兜底下限 3 / finish 清单
    expect(store.getEntry('钻径与规格', 'SS 尺码表（SS6–SS34）')?.value).toContain('SS6=2.0');
    expect(store.getEntry('钻径与规格', 'SS 尺码表（SS6–SS34）')?.value).toContain('SS34=7.1');
    expect(store.getEntry('密度与单位', 'baseDensityPerCm2 公式')?.value).toContain('2 / (√3 · pitchCm²)');
    expect(store.getEntry('色系与编码', 'ΔE76 色容差三档（3、10、25）')?.value).toContain('10–25');
    expect(store.getEntry('工艺规则', '可读兜底下限 3 颗（声明密度优先）')?.value).toContain('3.6cm²');
    expect(store.getEntry('材质与finish', '常见 finish 清单')?.value).toContain('glossy');
    // 来源标注（模型生成常识不自动成标准）
    for (const group of store.listIndex()) {
      expect(group.note).toContain('来源：整理初版，待领域负责人校订');
    }
    // 手工改一条后再 ensureSeeded：不被覆盖
    await store.upsertEntry({ group: '钻径与规格', key: 'SS 尺码表（SS6–SS34）', value: '手工修改' }, 'admin:test');
    expect(await store.ensureSeeded()).toBe(false);
    expect(store.getEntry('钻径与规格', 'SS 尺码表（SS6–SS34）')?.value).toBe('手工修改');
  });

  it('条目 CRUD + 非法名拒绝', async () => {
    await store.upsertGroup({ name: '测试组', note: '测试用' }, 'admin:test');
    await store.upsertEntry({ group: '测试组', key: '要领一', value: '内容一' }, 'admin:test');
    expect(store.getEntry('测试组', '要领一')?.value).toBe('内容一');
    await store.upsertEntry({ group: '测试组', key: '要领一', value: '内容二' }, 'admin:test');
    expect(store.getEntry('测试组', '要领一')?.value).toBe('内容二');
    await store.upsertEntry({ group: '测试组', key: '要领一', value: '内容二', newKey: '要领一改' }, 'admin:test');
    expect(store.getEntry('测试组', '要领一')).toBeNull();
    expect(store.getEntry('测试组', '要领一改')?.value).toBe('内容二');
    await expect(store.upsertEntry({ group: '../逃逸', key: 'x', value: 'v' }, 'admin:test')).rejects.toThrow();
    await expect(store.upsertEntry({ group: '测试组', key: '../index', value: 'v' }, 'admin:test')).rejects.toThrow();
    await expect(store.upsertEntry({ group: '不存在', key: 'x', value: 'v' }, 'admin:test')).rejects.toThrow(/分组不存在/);
    await store.deleteEntry('测试组', '要领一改', 'admin:test');
    expect(store.getEntry('测试组', '要领一改')).toBeNull();
  });

  it('分组改名与删除', async () => {
    await store.upsertGroup({ name: '测试组', newName: '测试组二' }, 'admin:test');
    expect(store.listIndex().map((g) => g.name)).toContain('测试组二');
    await store.deleteGroup('测试组二', 'admin:test');
    expect(store.listIndex().map((g) => g.name)).not.toContain('测试组二');
  });

  it('修订历史与恢复（git 存在时）：actor/summary 入 log；恢复=新 commit + 旧树物化', async () => {
    const revs = await store.revisions();
    if (!hasGit) {
      expect(revs.available).toBe(false);
      return;
    }
    expect(revs.available).toBe(true);
    expect(revs.revisions.length).toBeGreaterThanOrEqual(3);
    // 种子提交 actor=system；admin 写入 actor=admin:test
    expect(revs.revisions.some((r) => r.actor === 'system' && r.summary.includes('种子'))).toBe(true);
    expect(revs.revisions.some((r) => r.actor === 'admin:test')).toBe(true);
    // 修订详情：变更文件清单（中文路径）+ 全量快照
    const newest = revs.revisions[0]!;
    const detail = await store.revisionDetail(newest.id);
    expect(detail.revision.id).toBe(newest.id);
    expect(detail.changes.length).toBeGreaterThan(0);
    expect(detail.snapshot.length).toBeGreaterThan(0);
    // 恢复到最老的种子修订：SS 尺码表回到种子内容；历史追加不减少
    const seed = revs.revisions[revs.revisions.length - 1]!;
    const before = revs.revisions.length;
    await store.restore(seed.id, 'admin:test');
    expect(store.getEntry('钻径与规格', 'SS 尺码表（SS6–SS34）')?.value).not.toBe('手工修改');
    const after = await store.revisions();
    expect(after.revisions.length).toBe(before + 1);
  });

  it('git 缺席降级：探测失败 → available=false，读写照常', async () => {
    const degradedRoot = mkdtempSync(path.join(tmpdir(), 'handicraft-kb-nogit-'));
    const degraded = new KbStore(path.join(degradedRoot, 'knowledge'));
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    try {
      expect(degraded.gitAvailable()).toBe(false);
      await degraded.upsertGroup({ name: '降级组', note: '' }, 'admin:test');
      await degraded.upsertEntry({ group: '降级组', key: '条目', value: '降级下仍可读写' }, 'admin:test');
      expect(degraded.getEntry('降级组', '条目')?.value).toBe('降级下仍可读写');
      const revs = await degraded.revisions();
      expect(revs.available).toBe(false);
      expect(revs.revisions).toEqual([]);
      await expect(degraded.restore('deadbeef', 'admin:test')).rejects.toThrow(/git 不可用/);
    } finally {
      process.env.PATH = savedPath;
      rmSync(degradedRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------- [2] capability（MCP 只读面）

describe('capability：studio.kb_list/kb_get（readonly，agent 主体）', () => {
  it('kb_list 目录扫描（不含 value）+ kb_get 单条全文 + 不存在 NOT_FOUND', async () => {
    const registry = createCapabilityRegistry(createKnowledgeCapabilities(store));
    const listed = await registry.call('studio.kb_list', {}, 'agent');
    expect(listed.kind).toBe('ok');
    const groups = (listed as { value: { groups: Array<{ name: string; keys: string[] }> } }).value.groups;
    expect(groups.some((g) => g.name === '钻径与规格')).toBe(true);
    for (const g of groups) {
      expect(Object.keys(g).sort()).toEqual(['keys', 'name', 'note']);
    }
    const got = await registry.call('studio.kb_get', { group: '密度与单位', key: 'densityPerCm2 绝对语义' }, 'agent');
    expect(got.kind).toBe('ok');
    expect((got as { value: { value: string } }).value.value).toContain('绝对颗数密度');
    const missing = await registry.call('studio.kb_get', { group: '密度与单位', key: '不存在' }, 'agent');
    expect(missing).toEqual({
      kind: 'failed',
      code: 'NOT_FOUND',
      message: expect.stringContaining('知识条目不存在'),
    });
    const bad = await registry.call('studio.kb_get', { group: '' }, 'agent');
    expect(bad.kind).toBe('failed');
  });

  it('MCP 投影：studio.* 去前缀工具名 + 投影进既有面（与 kernel 工具组合不重名）', async () => {
    expect(mcpToolName('studio.kb_list')).toBe('kb_list');
    expect(mcpToolName('studio.kb_get')).toBe('kb_get');
    // 与既有 registry 组合（index.ts 装配同构）：describe 合并 + kb 工具可调
    const existing = createCapabilityRegistry([
      { name: 'studio.projects', description: '占位', authority: 'readonly', input: z.object({}), handler: () => ({ kind: 'ok', value: {} }) },
    ]);
    const composed = composeRegistries([existing, createCapabilityRegistry(createKnowledgeCapabilities(store))]);
    const names = composed.names();
    expect(names).toContain('studio.projects');
    expect(names).toContain('studio.kb_list');
    expect(names).toContain('studio.kb_get');
    const viaComposed = await composed.call('studio.kb_get', { group: '色系与编码', key: 'ΔE76 色容差三档（3、10、25）' }, 'agent');
    expect(viaComposed.kind).toBe('ok');
    // MCP server 构造（投影面真身——注册不炸即工具面就绪）
    expect(() => createStudioMcpServer({ capabilities: composed })).not.toThrow();
    // 重名 fail fast（compose 防线）
    expect(() =>
      composeRegistries([
        createCapabilityRegistry(createKnowledgeCapabilities(store)),
        createCapabilityRegistry(createKnowledgeCapabilities(store)),
      ]),
    ).toThrow(/duplicate capability registration/);
  });
});

// ---------------------------------------------------------------- [3] rpc（admin.kb.* 全链）

describe('rpc：admin.kb.* 读写历史恢复全链 + 权限矩阵', () => {
  it('admin 全链：saveGroup→saveEntry→revisions（actor=admin:boss）→revisionGet→restore', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const kb = new KbStore(path.join(s.root, 'knowledge-rpc'));
      const adminClient = clientFor(s.context({ kb, token: await s.tokenFor(boss) }));

      // 种子 + 建组 + 写条目
      await kb.ensureSeeded();
      await adminClient.admin.kb.saveGroup({ name: 'RPC 组', note: '经后台写入' });
      const out = await adminClient.admin.kb.saveEntry({ group: 'RPC 组', key: 'rpc 条目', value: '经 RPC 写入' });
      expect(out.groups.find((g) => g.name === 'RPC 组')?.entries).toEqual([
        { key: 'rpc 条目', value: '经 RPC 写入' },
      ]);

      // 历史面：最新修订=本次写条目，author=admin:boss
      const revs = await adminClient.admin.kb.revisions();
      if (hasGit) {
        expect(revs.available).toBe(true);
        expect(revs.revisions[0]!.summary).toContain('rpc 条目');
        expect(revs.revisions[0]!.actor).toBe('admin:boss');
        // 详情 + 恢复到种子版（RPC 组消失=旧树物化；恢复后再 list 回种子态）
        const detail = await adminClient.admin.kb.revisionGet({ id: revs.revisions[revs.revisions.length - 1]!.id });
        expect(detail.snapshot.some((g) => g.name === '钻径与规格')).toBe(true);
        const restored = await adminClient.admin.kb.restore({ id: detail.revision.id });
        expect(restored.ok).toBe(true);
        const after = await adminClient.admin.kb.list();
        expect(after.groups.some((g) => g.name === 'RPC 组')).toBe(false);
        expect(after.groups.some((g) => g.name === '色系与编码')).toBe(true);
      }

      // 删除条目/分组：返回全量投影即时回填
      await adminClient.admin.kb.saveGroup({ name: 'RPC 组' });
      await adminClient.admin.kb.saveEntry({ group: 'RPC 组', key: 'tmp', value: 'v' });
      const afterDelete = await adminClient.admin.kb.deleteEntry({ group: 'RPC 组', key: 'tmp' });
      expect(afterDelete.groups.find((g) => g.name === 'RPC 组')?.entries).toEqual([]);
      const afterGroupDelete = await adminClient.admin.kb.deleteGroup({ name: 'RPC 组' });
      expect(afterGroupDelete.groups.some((g) => g.name === 'RPC 组')).toBe(false);

      // 业务错误 → BAD_REQUEST（分组不存在）
      await expectOrpcError(
        adminClient.admin.kb.saveEntry({ group: '不存在', key: 'k', value: 'v' }),
        'BAD_REQUEST',
      );
    } finally {
      s.dispose();
    }
  });

  it('权限矩阵：无 token UNAUTHORIZED；匿名/普通用户 FORBIDDEN（读面+写面）；MCP 只读面不受影响', async () => {
    const s = createServices();
    try {
      makeUser(s, 'boss', 'admin');
      const worker = makeUser(s, 'worker', 'user');
      const kb = new KbStore(path.join(s.root, 'knowledge-perm'));
      await kb.ensureSeeded();

      const bare = clientFor(s.context({ kb }));
      const anon = clientFor(s.context({ kb, token: await s.tokenFor() }));
      const userClient = clientFor(s.context({ kb, token: await s.tokenFor(worker) }));
      await expectOrpcError(bare.admin.kb.list(), 'UNAUTHORIZED');
      await expectOrpcError(anon.admin.kb.list(), 'FORBIDDEN');
      await expectOrpcError(userClient.admin.kb.list(), 'FORBIDDEN');
      await expectOrpcError(
        userClient.admin.kb.saveEntry({ group: '钻径与规格', key: '越权', value: 'v' }),
        'FORBIDDEN',
      );
      await expectOrpcError(userClient.admin.kb.restore({ id: 'a1b2c3d' }), 'FORBIDDEN');
      // MCP 只读面与 admin 收权面正交：capability 对 agent 主体照常放行
      const registry = createCapabilityRegistry(createKnowledgeCapabilities(kb));
      const listed = await registry.call('studio.kb_list', {}, 'agent');
      expect(listed.kind).toBe('ok');
    } finally {
      s.dispose();
    }
  });

  it('无注入实例兜底：context.kb 缺席时按 DATA_ROOT/knowledge 共享实例读写', async () => {
    const s = createServices();
    try {
      const boss = makeUser(s, 'boss', 'admin');
      const adminClient = clientFor(s.context({ token: await s.tokenFor(boss) }));
      // 无 context.kb → sharedFor(config.dataRoot/knowledge) 兜底（boot 装配同源）
      const first = await adminClient.admin.kb.list();
      expect(first.groups).toEqual([]);
      await adminClient.admin.kb.saveGroup({ name: '兜底组', note: '' });
      const second = await adminClient.admin.kb.list();
      expect(second.groups.map((g) => g.name)).toEqual(['兜底组']);
      // 共享实例：同 dataRoot 二次调用同库
      const again = clientFor(s.context({ token: await s.tokenFor(boss) }));
      expect((await again.admin.kb.list()).groups.map((g) => g.name)).toEqual(['兜底组']);
    } finally {
      s.dispose();
    }
  });
});
