/**
 * set.* MCP 工具面测试（add-stone-library design §7.5/§7.4——S7.3 + S7.6 位；
 * W4.2 授权桥用例族复用——照 capability-stones.test.ts 同构）。覆盖：
 *   [1] 无授权直调写工具必拒（principal-forbidden——库内零变更）。
 *   [2] create 全链：propose（成员清单 diff+限定名预览+approval-request 帧）→
 *       answer → execute（目录/set.json 落库）→ grant 重放必拒；批准前库内零变更。
 *   [3] update 全链：成员增删/数量的 diff 预览 → 落库 revision 前进；CAS 漂移
 *       必拒（STALE）；空 diff 不发起。
 *   [4] delete 全链：目标+clone 引用面预览 → 软删（list 默认过滤/get trashed）。
 *   [5] S7.6 接口位：bom-derived origin=typed 'bom-source-not-implemented' 拒
 *       （零 proposal 落库）。
 *   [6] clone 全链：propose 预览母组合成员浅拷贝 → 执行建 clone（CAS 绑母组合）。
 *   [7] readonly 面：list 名称/用途/来源筛选+分页；get 成员五态+限定名。
 *   [8] 跨用户：B 的任务读不到 A 的组合（owner 隔离——评审 D-1）。
 *   [9] kernel 组合注册回归：studio 10 + stones 8 + set 5 = 23 工具全注册
 *       （composeRegistries 与 kernel/index.ts 同装配）+ mcpToolName 投影名。
 * 零常驻进程。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SupplierSkuProfileSchema, type SupplierSkuProfile } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { composeRegistries, createStoneCapabilities } from '../src/capability/stones.js';
import {
  BOM_SOURCE_NOT_IMPLEMENTED,
  createSetCapabilities,
  SetCreateFromBomInputSchema,
} from '../src/capability/sets.js';
import { createStudioCapabilities, type GenerateExecutor } from '../src/capability/studio.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { StoneService } from '../src/stones/service.js';
import { SetService } from '../src/stones/sets-service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createUser } from '../src/db/store.js';
import { createServices, type TestServices } from './helpers.js';

const active: TestServices[] = [];

const YUHANG: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [
    { rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
    { rows: [76, 78], sizeMmByPrefix: { J: 12, A: 14, B: 16, C: 18, E: 20, F: 22, G: 25 } },
  ],
  styleKey: 'row',
});

const FACTORY_B: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'factoryB',
  displayName: '乙厂',
  bands: [{ rows: [1, 99], sizeMmByPrefix: { J: 2, A: 3 } }],
  styleKey: 'row',
});

function textureBytes(): Uint8Array {
  const size = 128;
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  const r = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - c;
      const dy = y - c;
      if (dx * dx + dy * dy <= r * r) {
        const p = (y * size + x) * 4;
        rgba[p] = 240;
        rgba[p + 1] = 240;
        rgba[p + 2] = 232;
        rgba[p + 3] = 255;
      }
    }
  }
  return new Uint8Array(encodePng(size, size, rgba));
}

interface SetFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createSetCapabilities>;
  stones: StoneService;
  sets: SetService;
  sessionId: string;
  taskId: string;
  frames(): Array<Record<string, unknown>>;
  dispose(): void;
}

function setup(): SetFixture {
  const s = createServices(undefined, { imgDryRun: true });
  active.push(s);
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createSetCapabilities({ db: s.db, blobs: s.blobs, jobs: s.jobs, approvals: auth });
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  const sets = new SetService({ db: s.db, blobs: s.blobs, stones });
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'set 工具面测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  return {
    s,
    auth,
    registry,
    stones,
    sets,
    sessionId,
    taskId: task.id,
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
    dispose: () => {
      const idx = active.indexOf(s);
      if (idx >= 0) active.splice(idx, 1);
      s.dispose();
    },
  };
}
afterEach(() => {
  for (const s of active.splice(0)) s.dispose();
});

async function okOf(result: unknown): Promise<Record<string, unknown>> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: Record<string, unknown> }).value;
}

/** 经 StoneService 直建标准原子（成员引用目标——工具面不依赖 stone.* 工具链）。 */
function createStone(
  f: SetFixture,
  overrides: { sku?: string; supplierProfile?: SupplierSkuProfile } = {},
): ReturnType<StoneService['createStone']> {
  return f.stones.createStone({
    ownerId: f.s.anonymous.id,
    supplierProfile: overrides.supplierProfile ?? YUHANG,
    draft: {
      name: '象牙白 · 2mm',
      sku: overrides.sku ?? 'J51',
      sizeMm: 2,
      color: { name: '象牙白', rgb: [240, 240, 232], family: '白色系', finish: 'glossy' },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: textureBytes(),
  });
}

interface CreateSetOverrides {
  name?: string;
  purpose?: string;
  origin?: Record<string, unknown>;
}

function setCreateProposeArgs(f: SetFixture, stoneRefs: string[], overrides: CreateSetOverrides = {}): Record<string, unknown> {
  const origin = overrides.origin ?? { kind: 'manual-pick' };
  return {
    taskId: f.taskId,
    name: overrides.name ?? '卡通人物套餐-A',
    ...(overrides.purpose !== undefined ? { purpose: overrides.purpose } : {}),
    // clone 来源禁带 stones（服务端从母组合浅拷贝——双源必拒）。
    ...((origin as { kind: string }).kind === 'clone' ? {} : { stones: stoneRefs.map((stoneRef, i) => ({ stoneRef, quantity: i + 1 })) }),
    origin,
  };
}

/** 经工具全链建组合（propose→approve→execute）——返回执行产物。 */
async function createSetViaTool(f: SetFixture, stoneRefs: string[], overrides: CreateSetOverrides = {}): Promise<Record<string, unknown>> {
  const proposed = await okOf(await f.registry.call('set.create', setCreateProposeArgs(f, stoneRefs, overrides), 'agent'));
  f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
  return okOf(await f.registry.call('set.create', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
}

function proposalCount(f: SetFixture): number {
  return (f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops').get() as { n: number }).n;
}

// ---------------------------------------------------------------- [1] 授权面

describe('S7.3 授权面（零新授权语义——照 S4 双模）', () => {
  it('无授权直调写工具必拒（执行面无 proposal/无 grant=principal-forbidden——库内零变更）', async () => {
    const f = setup();
    const stone = createStone(f);
    // 执行模式直调（proposalId 不存在）→ no-proposal → principal-forbidden。
    for (const [tool, input] of [
      ['set.create', { taskId: f.taskId, proposalId: randomUUID() }],
      ['set.update', { taskId: f.taskId, proposalId: randomUUID() }],
      ['set.delete', { taskId: f.taskId, proposalId: randomUUID() }],
    ] as const) {
      const denied = await f.registry.call(tool, input, 'agent');
      expect(denied).toMatchObject({ kind: 'denied', reason: 'principal-forbidden', requestedOperation: tool });
    }
    // 已发起但未批准（无 grant）的执行直调 → grant-missing → principal-forbidden。
    const proposed = await okOf(await f.registry.call('set.create', setCreateProposeArgs(f, [stone.resourceId]), 'agent'));
    const unapproved = await f.registry.call('set.create', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent');
    expect(unapproved).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
    // 零执行零变更（propose 只落 approved_ops 行——组合库零变更）。
    expect(f.sets.listSets({ ownerId: f.s.anonymous.id })).toHaveLength(0);
  });

  it('未装配授权桥的 registry：写工具一律 principal-forbidden', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    active.push(s);
    const registry = createSetCapabilities({ db: s.db, blobs: s.blobs });
    const denied = await registry.call('set.create', { taskId: 't', name: 'X', origin: { kind: 'manual-pick' }, stones: [{ stoneRef: 'r' }] }, 'agent');
    expect(denied).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
  });

  it('执行模式带 propose 字段=互斥必拒', async () => {
    const f = setup();
    const stone = createStone(f);
    const proposed = await okOf(await f.registry.call('set.create', setCreateProposeArgs(f, [stone.resourceId]), 'agent'));
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const mixed = await f.registry.call(
      'set.create',
      { taskId: f.taskId, proposalId: proposed['proposalId'], name: '混入' },
      'agent',
    );
    expect(mixed).toMatchObject({ kind: 'failed' });
  });
});

// ---------------------------------------------------------------- [2] create 全链

describe('S7.3 set.create 全链（propose→approve→execute）', () => {
  it('propose：成员清单 diff 预览（限定名+解析态）+approval-request 帧；批准前库内零变更', async () => {
    const f = setup();
    const stone = createStone(f);
    const proposed = await okOf(await f.registry.call('set.create', setCreateProposeArgs(f, [stone.resourceId], { purpose: '小件卡通订单' }), 'agent'));
    expect(proposed['proposalId']).toBeTruthy();
    expect(proposed['expiresAt']).toBeTruthy();
    const preview = proposed['preview'] as Record<string, unknown>;
    expect(preview['name']).toBe('卡通人物套餐-A');
    const members = preview['members'] as Array<Record<string, unknown>>;
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ stoneRef: stone.resourceId, state: 'resolved', qualifiedSku: 'yuhang/J51', quantity: 1 });
    // approval-request 帧已入任务帧流（payload 嵌套 tool/proposalId——S4 同形）。
    const request = f.frames().find((frame) => frame['kind'] === 'approval-request') as Record<string, unknown>;
    expect(request).toBeTruthy();
    const requestPayload = request['payload'] as Record<string, unknown>;
    expect(requestPayload).toMatchObject({ tool: 'set.create', proposalId: proposed['proposalId'] });
    // 批准前库内零变更。
    expect(f.sets.listSets({ ownerId: f.s.anonymous.id })).toHaveLength(0);
  });

  it('execute：目录/set.json 落库+op succeeded；grant 重放必拒（重放零新增）', async () => {
    const f = setup();
    const stone = createStone(f);
    const proposalId = (await okOf(await f.registry.call('set.create', setCreateProposeArgs(f, [stone.resourceId]), 'agent')))['proposalId'] as string;
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: (f.auth.opOf(proposalId) as { request_id: string }).request_id, approved: true });
    const executed = await okOf(await f.registry.call('set.create', { taskId: f.taskId, proposalId }, 'agent'));
    expect(executed).toMatchObject({ revision: 1, memberCount: 1 });
    const resourceId = executed['resourceId'] as string;
    expect(f.sets.getSet(resourceId).set.stones).toEqual([{ stoneRef: stone.resourceId, quantity: 1 }]);
    expect((f.auth.opOf(proposalId) as { state: string }).state).toBe('succeeded');
    // 重放必拒。
    const replay = await f.registry.call('set.create', { taskId: f.taskId, proposalId }, 'agent');
    expect(replay).toMatchObject({ kind: 'failed' });
    expect((replay as { message: string }).message).toContain('已消费');
    expect(f.sets.listSets({ ownerId: f.s.anonymous.id })).toHaveLength(1);
  });

  it('answer(false)：op failed → execute 必拒（principal-forbidden——库内零变更）', async () => {
    const f = setup();
    const stone = createStone(f);
    const proposed = await okOf(await f.registry.call('set.create', setCreateProposeArgs(f, [stone.resourceId]), 'agent'));
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: false });
    const refused = await f.registry.call('set.create', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent');
    expect(refused).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
    expect((f.auth.opOf(proposed['proposalId'] as string) as { state: string }).state).toBe('failed');
    expect(f.sets.listSets({ ownerId: f.s.anonymous.id })).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- [3] update 全链

describe('S7.3 set.update 全链（diff 预览+CAS）', () => {
  it('propose diff（成员增删/数量+fieldChanges）→ execute 落库 revision 前进', async () => {
    const f = setup();
    const a = createStone(f, { sku: 'J51' });
    const b = createStone(f, { sku: 'A51' });
    const c = createStone(f, { sku: 'B51' });
    const created = await createSetViaTool(f, [a.resourceId, b.resourceId]);
    const resourceId = created['resourceId'] as string;
    const proposed = await okOf(
      await f.registry.call(
        'set.update',
        {
          taskId: f.taskId,
          resourceId,
          patch: {
            name: '改名后的组合',
            removeMembers: [b.resourceId],
            addMembers: [{ stoneRef: c.resourceId, quantity: 5 }],
            updateMembers: [{ stoneRef: a.resourceId, quantity: 9 }],
          },
        },
        'agent',
      ),
    );
    const diff = proposed['diff'] as Record<string, unknown>;
    expect(diff['baseRevision']).toBe(1);
    expect((diff['addedMembers'] as unknown[]).map((m) => (m as { stoneRef: string }).stoneRef)).toEqual([c.resourceId]);
    expect((diff['removedMembers'] as unknown[]).map((m) => (m as { stoneRef: string }).stoneRef)).toEqual([b.resourceId]);
    expect((diff['updatedMembers'] as unknown[])).toHaveLength(1);
    expect(diff['fieldChanges']).toEqual(['name']); // name 变更（purpose 未给）
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const executed = await okOf(await f.registry.call('set.update', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
    expect(executed).toMatchObject({ revision: 2, memberCount: 2 });
    const got = f.sets.getSet(resourceId);
    expect(got.set.name).toBe('改名后的组合');
    expect(got.set.stones).toEqual([
      { stoneRef: a.resourceId, quantity: 9 },
      { stoneRef: c.resourceId, quantity: 5 },
    ]);
  });

  it('CAS 漂移必拒：批准期间组合被改 → execute STALE', async () => {
    const f = setup();
    const a = createStone(f);
    const created = await createSetViaTool(f, [a.resourceId]);
    const resourceId = created['resourceId'] as string;
    const proposed = await okOf(
      await f.registry.call('set.update', { taskId: f.taskId, resourceId, patch: { name: '新名' } }, 'agent'),
    );
    // 批准期间直接经 service 改组合（revision 前进）。
    f.sets.updateSet(resourceId, { purpose: '插队变更' }, { baseRevision: 1 });
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const stale = await f.registry.call('set.update', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent');
    expect(stale).toMatchObject({ kind: 'failed', code: 'STALE' });
    expect(f.sets.getSet(resourceId).set.name).toBe('卡通人物套餐-A'); // 过时覆盖未生效
  });

  it('空 diff 不发起（无字段变化——零 proposal 落库）', async () => {
    const f = setup();
    const a = createStone(f);
    const created = await createSetViaTool(f, [a.resourceId]);
    const empty = await f.registry.call(
      'set.update',
      { taskId: f.taskId, resourceId: created['resourceId'] as string, patch: { name: '卡通人物套餐-A' } },
      'agent',
    );
    expect(empty).toMatchObject({ kind: 'failed' });
    expect((empty as { message: string }).message).toContain('空 diff');
  });
});

// ---------------------------------------------------------------- [4] delete 全链

describe('S7.3 set.delete 全链（软删+引用面预览）', () => {
  it('propose 目标+clone 引用面 → execute 软删；list 默认过滤；重复删幂等拒绝', async () => {
    const f = setup();
    const a = createStone(f);
    const mother = await createSetViaTool(f, [a.resourceId], { name: '母组合' });
    await createSetViaTool(f, [], { name: '复用副本', origin: { kind: 'clone', fromSetId: mother['resourceId'] } });
    const proposed = await okOf(await f.registry.call('set.delete', { taskId: f.taskId, resourceId: mother['resourceId'] as string }, 'agent'));
    const target = proposed['target'] as Record<string, unknown>;
    expect(target['name']).toBe('母组合');
    expect(target['memberCount']).toBe(1);
    expect((proposed['references'] as Array<Record<string, unknown>>).map((r) => r['name'])).toEqual(['复用副本']);
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const executed = await okOf(await f.registry.call('set.delete', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
    expect(executed['trashedRows']).toBe(2);
    expect(f.sets.listSets({ ownerId: f.s.anonymous.id }).map((s) => s.name)).toEqual(['复用副本']); // 默认过滤
    expect(f.sets.getSet(mother['resourceId'] as string).trashed).toBe(true);
    // 重复删=幂等拒绝。
    const repeat = await f.registry.call('set.delete', { taskId: f.taskId, resourceId: mother['resourceId'] as string }, 'agent');
    expect(repeat).toMatchObject({ kind: 'failed' });
    expect((repeat as { message: string }).message).toContain('回收站');
  });
});

// ---------------------------------------------------------------- [5] S7.6 接口位

describe('S7.6 接口位冻结（bom-derived——依赖内核 change，不实现）', () => {
  it('set.create bom-derived origin=typed 拒（零 proposal 落库）', async () => {
    const f = setup();
    const stone = createStone(f);
    const refused = await f.registry.call(
      'set.create',
      setCreateProposeArgs(f, [stone.resourceId], { origin: { kind: 'bom-derived', sourceTaskId: 'task-1' } }),
      'agent',
    );
    expect(refused).toMatchObject({ kind: 'failed', code: 'INVALID_OPERATION' });
    expect((refused as { message: string }).message).toContain(BOM_SOURCE_NOT_IMPLEMENTED);
    expect(proposalCount(f)).toBe(0);
  });

  it('SetCreateFromBomInputSchema 接口位在册（taskId+sourceTaskId strict）', () => {
    expect(SetCreateFromBomInputSchema.safeParse({ taskId: 't', sourceTaskId: 'task-9' }).success).toBe(true);
    expect(SetCreateFromBomInputSchema.safeParse({ taskId: 't' }).success).toBe(false);
    expect(SetCreateFromBomInputSchema.safeParse({ taskId: 't', sourceTaskId: 's', extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- [6] clone 全链

describe('S7.3 set.create clone 全链（§7.4 来源③）', () => {
  it('propose 预览母组合成员浅拷贝 → 执行建 clone（CAS 绑母组合）', async () => {
    const f = setup();
    const a = createStone(f, { sku: 'J51' });
    const b = createStone(f, { sku: 'A51' });
    const mother = await createSetViaTool(f, [a.resourceId, b.resourceId], { name: '母组合' });
    const proposed = await okOf(
      await f.registry.call(
        'set.create',
        { taskId: f.taskId, name: '复用副本', origin: { kind: 'clone', fromSetId: mother['resourceId'] } },
        'agent',
      ),
    );
    const preview = proposed['preview'] as Record<string, unknown>;
    const members = preview['members'] as Array<Record<string, unknown>>;
    expect(members.map((m) => [m['stoneRef'], m['qualifiedSku']])).toEqual([
      [a.resourceId, 'yuhang/J51'],
      [b.resourceId, 'yuhang/A51'],
    ]);
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const executed = await okOf(await f.registry.call('set.create', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
    const got = f.sets.getSet(executed['resourceId'] as string);
    expect(got.set.origin).toEqual({ kind: 'clone', fromSetId: mother['resourceId'] });
    expect(got.set.stones).toEqual([
      { stoneRef: a.resourceId, quantity: 1 },
      { stoneRef: b.resourceId, quantity: 2 },
    ]);
  });

  it('clone CAS：批准期间母组合被改 → execute STALE（浅拷贝忠实于预览）', async () => {
    const f = setup();
    const a = createStone(f);
    const b = createStone(f, { sku: 'A51' });
    const mother = await createSetViaTool(f, [a.resourceId], { name: '母组合' });
    const proposed = await okOf(
      await f.registry.call(
        'set.create',
        { taskId: f.taskId, name: '漂移副本', origin: { kind: 'clone', fromSetId: mother['resourceId'] } },
        'agent',
      ),
    );
    f.sets.updateSet(mother['resourceId'] as string, { addMembers: [{ stoneRef: b.resourceId }] }, { baseRevision: 1 });
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const stale = await f.registry.call('set.create', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent');
    expect(stale).toMatchObject({ kind: 'failed', code: 'STALE' });
    expect(f.sets.listSets({ ownerId: f.s.anonymous.id }).map((s) => s.name)).toEqual(['母组合']); // 零克隆落库
  });
});

// ---------------------------------------------------------------- [7] readonly 面

describe('S7.3 readonly 面（set.list/set.get）', () => {
  it('list 名称/用途/来源筛选+分页；get 成员五态+限定名（跨标准同 SKU 可区分）', async () => {
    const f = setup();
    const yuhangJ51 = createStone(f, { sku: 'J51' });
    const factoryBJ51 = createStone(f, { sku: 'J51', supplierProfile: FACTORY_B });
    const softDeleted = createStone(f, { sku: 'B51' });
    const created = await createSetViaTool(f, [yuhangJ51.resourceId, factoryBJ51.resourceId, softDeleted.resourceId, randomUUID()], {
      purpose: '小件卡通订单',
    });
    f.stones.softDelete(softDeleted.resourceId); // 成员原子软删（组合零感知——显式态）
    // list 筛选。
    const listed = await okOf(await f.registry.call('set.list', { taskId: f.taskId }, 'agent'));
    expect(listed['total']).toBe(1);
    const byName = await okOf(await f.registry.call('set.list', { taskId: f.taskId, name: '不存在' }, 'agent'));
    expect(byName['total']).toBe(0);
    const byPurpose = await okOf(await f.registry.call('set.list', { taskId: f.taskId, purpose: '订单' }, 'agent'));
    expect(byPurpose['total']).toBe(1);
    const byOrigin = await okOf(await f.registry.call('set.list', { taskId: f.taskId, originKind: 'clone' }, 'agent'));
    expect(byOrigin['total']).toBe(0);
    const paged = await okOf(await f.registry.call('set.list', { taskId: f.taskId, page: 2, pageSize: 1 }, 'agent'));
    expect(paged['sets']).toEqual([]);
    // get：成员五态中的 resolved/soft-deleted/not-found + 限定名跨标准区分。
    const got = await okOf(await f.registry.call('set.get', { taskId: f.taskId, resourceId: created['resourceId'] as string }, 'agent'));
    const members = got['members'] as Array<Record<string, unknown>>;
    expect(members.map((m) => [m['state'], m['qualifiedSku']])).toEqual([
      ['resolved', 'yuhang/J51'],
      ['resolved', 'factoryB/J51'],
      ['soft-deleted', 'yuhang/B51'],
      ['not-found', undefined],
    ]);
    expect(members[0]).toMatchObject({ textureUrl: `/api/stones/${yuhangJ51.resourceId}/texture.png`, standardId: 'yuhang' });
  });

  it('get：组合不存在/跨用户必拒', async () => {
    const f = setup();
    const missing = await f.registry.call('set.get', { taskId: f.taskId, resourceId: randomUUID() }, 'agent');
    expect(missing).toMatchObject({ kind: 'failed' });
    const userB = createUser(f.s.db, { username: `set-b-${randomUUID().slice(0, 8)}`, passwordHash: 'x', role: 'user' });
    const { sessionId: sessionB } = f.s.sessions.create(userB, { title: 'B 会话' });
    const taskB = createAgentTask(f.s.db, { ownerId: userB.id, sessionId: sessionB, status: 'running' });
    const a = createStone(f);
    const created = await createSetViaTool(f, [a.resourceId]);
    const cross = await f.registry.call('set.get', { taskId: taskB.id, resourceId: created['resourceId'] as string }, 'agent');
    expect(cross).toMatchObject({ kind: 'failed' });
    expect((cross as { message: string }).message).toContain('跨用户');
    // B 的清单为空（owner 隔离——评审 D-1）。
    const listB = await okOf(await f.registry.call('set.list', { taskId: taskB.id }, 'agent'));
    expect(listB['total']).toBe(0);
  });
});

// ---------------------------------------------------------------- [9] kernel 组合注册回归

describe('S7.3 kernel 组合注册回归（studio 10 + stones 8 + set 5 = 23 工具）', () => {
  const okExecutor: GenerateExecutor = async () => new Uint8Array([1, 2, 3, 4]);

  function composedFixture(): { capabilities: ReturnType<typeof composeRegistries>; s: TestServices } {
    const s = createServices(undefined, { imgDryRun: true });
    active.push(s);
    const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
    // 与 kernel/index.ts 同装配：studio + stones + set 三 registry 组合。
    const capabilities = composeRegistries([
      createStudioCapabilities({
        db: s.db,
        blobs: s.blobs,
        jobs: s.jobs,
        approvals: auth,
        config: s.config,
        generateExecutor: okExecutor,
        revokeResult: (resultId) => s.sessions.revokeResult(resultId),
      }),
      createStoneCapabilities({ db: s.db, blobs: s.blobs, jobs: s.jobs, approvals: auth }),
      createSetCapabilities({ db: s.db, blobs: s.blobs, jobs: s.jobs, approvals: auth }),
    ]);
    return { capabilities, s };
  }

  it('compose 后 23 工具全注册（studio 10 + stones 8 + set 5）+重名防线+MCP 投影名', () => {
    const { capabilities, s } = composedFixture();
    try {
      const names = [...capabilities.names()].sort();
      expect(names).toHaveLength(23);
      // set 五工具全在册。
      for (const name of ['set.list', 'set.get', 'set.create', 'set.update', 'set.delete']) {
        expect(names).toContain(name);
      }
      // 既有面零回归（studio 十工具抽样+stones 八工具全列）。
      for (const name of ['stones.list', 'stones.search', 'stones.get', 'stones.substitutes', 'stone.create', 'stone.update', 'stone.delete', 'stone.import']) {
        expect(names).toContain(name);
      }
      expect(names.filter((n) => n.startsWith('studio.'))).toHaveLength(10);
      // MCP 投影名（tools/list 注册面）。
      expect(mcpToolName('set.list')).toBe('set_list');
      expect(mcpToolName('set.get')).toBe('set_get');
      expect(mcpToolName('set.create')).toBe('set_create');
      expect(mcpToolName('set.update')).toBe('set_update');
      expect(mcpToolName('set.delete')).toBe('set_delete');
      // 重名 fail fast（组合层重复注册=编程错误）。
      expect(() => composeRegistries([capabilities, createSetCapabilities({ db: s.db, blobs: s.blobs })])).toThrow(
        /duplicate capability registration/,
      );
      // authority 投影：readonly 2 + approved-mutation 3。
      const setTools = capabilities.describe().filter((d) => d.name.startsWith('set.'));
      expect(setTools.filter((d) => d.authority === 'readonly').map((d) => d.name).sort()).toEqual(['set.get', 'set.list']);
      expect(setTools.filter((d) => d.authority === 'approved-mutation').map((d) => d.name).sort()).toEqual([
        'set.create',
        'set.delete',
        'set.update',
      ]);
    } finally {
      const idx = active.indexOf(s);
      if (idx >= 0) active.splice(idx, 1);
      s.dispose();
    }
  });

  it('compose 后 readonly set.list 真调一条（跨 registry 路由）', async () => {
    const { capabilities, s } = composedFixture();
    try {
      const { sessionId } = s.sessions.create(s.anonymous, { title: 'compose 真调' });
      const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
      const result = await capabilities.call('set.list', { taskId: task.id }, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      expect((result as { value: { total: number } }).value.total).toBe(0);
    } finally {
      const idx = active.indexOf(s);
      if (idx >= 0) active.splice(idx, 1);
      s.dispose();
    }
  });
});
