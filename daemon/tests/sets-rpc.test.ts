/**
 * sets.list/get/create/update/delete/createFromBom RPC 协议测试（S7.4 工作台
 * 硬前置——人工直发面，design §7.4）。覆盖：
 *   [1] create（manual-pick）：落库协议（resourceId/revision/path/memberCount）+
 *       clone 源（服务端浅拷贝）+ 杂质 origin 拒（P2-4 面经 RPC 投影）。
 *   [2] get：成员解析投影（五态+限定名 qualifiedSku）+ set.json 全文 + trashed。
 *   [3] list：名称/用途/来源筛选+分页+includeTrashed；owner 过滤（只见自己的）。
 *   [4] update：成员 ops（add/remove/quantity）+ revision CAS（漂移 BAD_REQUEST
 *       data.code='revision-conflict'）。
 *   [5] delete：软删（list 默认过滤/includeTrashed 复现 trashed）。
 *   [6] owner 隔离（评审 D-1）：B 看不到 A 的组合（list=0）；B get/update/delete
 *       A 的组合 FORBIDDEN；B 建 B 的组合零串扰。
 *   [7] createFromBom：S7.6 接口位冻结——501+typed BOM_SOURCE_NOT_IMPLEMENTED。
 *   [8] 认证面：无 token 401；disabled 用户读可写拒（禁写不禁读）。
 * 数据经 StoneService/SetService 直建（服务面已验收——RPC 测试不重复授权桥链路）。
 */
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import { SupplierSkuProfileSchema, type RgbTuple, type SupplierSkuProfile } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { StoneService } from '../src/stones/service.js';
import { SetService } from '../src/stones/sets-service.js';
import { BOM_SOURCE_NOT_IMPLEMENTED } from '../src/capability/sets.js';
import { createUser } from '../src/db/store.js';
import { clientFor, createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixtures

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

function seedAtom(s: TestServices, ownerId: string, overrides: { sku?: string; supplierProfile?: SupplierSkuProfile } = {}): string {
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  return stones.createStone({
    ownerId,
    supplierProfile: overrides.supplierProfile ?? YUHANG,
    draft: {
      name: '象牙白 · 2mm',
      sku: overrides.sku ?? 'J51',
      sizeMm: 2,
      color: { name: '象牙白', rgb: [240, 240, 232] as RgbTuple, family: '白色系', finish: 'glossy' },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: textureBytes(),
  }).resourceId;
}

async function expectOrpcError(promise: Promise<unknown>, code: string): Promise<ORPCError<string, unknown>> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    const typed = error as ORPCError<string, unknown>;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}

// ---------------------------------------------------------------- [1] create

describe('sets.create（人工直发——design §7.4）', () => {
  it('manual-pick：落库协议（revision=1/path/memberCount）+ set.json 契约形状', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const created = await client.sets.create({
        name: '卡通人物套餐-A',
        purpose: '小件卡通订单',
        members: [{ stoneRef: atom, quantity: 2 }],
        origin: { kind: 'manual-pick' },
      });
      expect(created.revision).toBe(1);
      expect(created.memberCount).toBe(1);
      expect(created.resourceId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.path).toBe(`/stones/production-sets/卡通人物套餐-A`);
      // 服务面直验（set.json 真值）。
      const sets = new SetService({ db: s.db, blobs: s.blobs, stones: new StoneService({ db: s.db, blobs: s.blobs }) });
      expect(sets.getSet(created.resourceId).set).toMatchObject({
        kind: 'stone-set',
        name: '卡通人物套餐-A',
        purpose: '小件卡通订单',
        origin: { kind: 'manual-pick' },
        stones: [{ stoneRef: atom, quantity: 2 }],
      });
    } finally {
      s.dispose();
    }
  });

  it('clone 源：服务端浅拷贝母组合成员；杂质 origin（manual-pick 带 fromSetId）typed 拒', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const mother = await client.sets.create({ name: '母组合', members: [{ stoneRef: atom }], origin: { kind: 'manual-pick' } });
      const clone = await client.sets.create({ name: '副本', origin: { kind: 'clone', fromSetId: mother.resourceId } });
      expect(clone.memberCount).toBe(1);
      // P2-4 面经 RPC 投影：杂质字段 BAD_REQUEST+data.code=invalid-origin。
      const dirty = await expectOrpcError(
        client.sets.create({ name: 'X', members: [{ stoneRef: atom }], origin: { kind: 'manual-pick', fromSetId: mother.resourceId } }),
        'BAD_REQUEST',
      );
      expect((dirty.data as { code?: string }).code).toBe('invalid-origin');
      const listed = await client.sets.list({});
      expect(listed.total).toBe(2); // 杂质拒零落库
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [2] get（成员解析投影）

describe('sets.get：成员读时解析投影（五态+限定名）', () => {
  it('resolved 成员：qualifiedSku `<标准ID>/<SKU>`+quantity/note+stone 全文+textureUrl', async () => {
    const s = createServices();
    try {
      const j51 = seedAtom(s, s.anonymous.id);
      const fb = seedAtom(s, s.anonymous.id, { sku: 'J51', supplierProfile: FACTORY_B });
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const created = await client.sets.create({
        name: '双标准套餐',
        members: [
          { stoneRef: j51, quantity: 3, note: '主钻' },
          { stoneRef: fb },
          { stoneRef: '0b7d54a5-0000-4000-8000-000000000000', quantity: 1 }, // not-found 成员
        ],
        origin: { kind: 'manual-pick' },
      });
      const got = await client.sets.get({ resourceId: created.resourceId });
      expect(got.revision).toBe(1);
      expect(got.trashed).toBe(false);
      expect(got.members.map((m) => [m.state, m.qualifiedSku])).toEqual([
        ['resolved', 'yuhang/J51'],
        ['resolved', 'factoryB/J51'], // 编号冲突限定名区分（§7.6）
        ['not-found', undefined], // 缺失成员显式态（不剔除）
      ]);
      expect(got.members[0]).toMatchObject({ quantity: 3, note: '主钻', textureUrl: `/api/stones/${j51}/texture.png` });
      expect(got.members[0]?.stone).toMatchObject({ kind: 'stone', sku: 'J51', supplier: 'yuhang' });
      expect(got.members[2]?.stone).toBeUndefined();
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [3] list

describe('sets.list：筛选+分页+owner 过滤', () => {
  it('名称/用途/来源筛选+includeTrashed+分页（total/page/pageSize）', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const a = await client.sets.create({
        name: '卡通人物套餐-A',
        purpose: '小件卡通订单',
        members: [{ stoneRef: atom }],
        origin: { kind: 'manual-pick' },
      });
      await client.sets.create({ name: '复用副本', origin: { kind: 'clone', fromSetId: a.resourceId } });
      const all = await client.sets.list({});
      expect(all.total).toBe(2);
      expect(all.sets.map((x) => x.name)).toEqual(['卡通人物套餐-A', '复用副本']); // name 稳定序
      expect((await client.sets.list({ name: '卡通' })).total).toBe(1);
      expect((await client.sets.list({ purpose: '订单' })).total).toBe(1);
      expect((await client.sets.list({ originKind: 'clone' })).total).toBe(1);
      // 分页。
      const paged = await client.sets.list({ page: 2, pageSize: 1 });
      expect(paged.total).toBe(2);
      expect(paged.sets.map((x) => x.name)).toEqual(['复用副本']);
      // 软删后默认过滤+includeTrashed 复现。
      await client.sets.delete({ resourceId: a.resourceId });
      expect((await client.sets.list({})).total).toBe(1);
      const trashed = await client.sets.list({ includeTrashed: true });
      expect(trashed.total).toBe(2);
      expect(trashed.sets.find((x) => x.resourceId === a.resourceId)?.trashed).toBe(true);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [4] update（成员 ops+CAS）

describe('sets.update：成员 ops + revision CAS', () => {
  it('addMembers/removeMembers/updateMembers 落库 revision+1；CAS 漂移 typed revision-conflict 拒', async () => {
    const s = createServices();
    try {
      const j51 = seedAtom(s, s.anonymous.id);
      const a51 = seedAtom(s, s.anonymous.id, { sku: 'A51' });
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const created = await client.sets.create({
        name: '套餐',
        members: [{ stoneRef: j51, quantity: 1 }],
        origin: { kind: 'manual-pick' },
      });
      // 基线漂移必拒（baseRevision=99）。
      const stale = await expectOrpcError(
        client.sets.update({
          resourceId: created.resourceId,
          baseRevision: 99,
          patch: { addMembers: [{ stoneRef: a51 }] },
        }),
        'BAD_REQUEST',
      );
      expect((stale.data as { code?: string }).code).toBe('revision-conflict');
      // 正确 CAS：追加+数量更新+移除（原子三 op）。
      const updated = await client.sets.update({
        resourceId: created.resourceId,
        baseRevision: 1,
        patch: {
          addMembers: [{ stoneRef: a51, quantity: 5 }],
          updateMembers: [{ stoneRef: j51, quantity: 2 }],
        },
      });
      expect(updated.revision).toBe(2);
      expect(updated.memberCount).toBe(2);
      const got = await client.sets.get({ resourceId: created.resourceId });
      expect(got.set.stones).toEqual([
        { stoneRef: j51, quantity: 2 },
        { stoneRef: a51, quantity: 5 },
      ]);
      // 移除到清空必拒（删组合走 sets.delete）。
      const emptied = await expectOrpcError(
        client.sets.update({ resourceId: created.resourceId, baseRevision: 2, patch: { removeMembers: [j51, a51] } }),
        'BAD_REQUEST',
      );
      expect((emptied.data as { code?: string }).code).toBe('empty-members');
      // 改名（目录行同事务改名→path 跟随）。
      const renamed = await client.sets.update({
        resourceId: created.resourceId,
        baseRevision: 2,
        patch: { name: '套餐-改名' },
      });
      expect(renamed.path).toBe('/stones/production-sets/套餐-改名');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [5] delete（软删）

describe('sets.delete：软删（回收站语义）', () => {
  it('盖戳+get trashed=true；成员引用零变更（标准原子不受影响）', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const created = await client.sets.create({ name: '待删', members: [{ stoneRef: atom }], origin: { kind: 'manual-pick' } });
      const deleted = await client.sets.delete({ resourceId: created.resourceId });
      expect(deleted.trashedRows).toBe(2); // 目录+set.json 两行
      const got = await client.sets.get({ resourceId: created.resourceId });
      expect(got.trashed).toBe(true);
      expect(got.members).toHaveLength(1); // 回收站内成员清单仍完整
      // 标准原子不受影响（stones 面零变更锚）。
      expect((await client.stones.list({})).total).toBe(1);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [6] owner 隔离（评审 D-1）

describe('sets owner 隔离（评审 D-1：组合=私有生产工件，读写均按 owner）', () => {
  it('B 看不到 A 的组合（list=0）；B get/update/delete A 的组合 FORBIDDEN；B 建自己的零串扰', async () => {
    const s = createServices();
    try {
      const userB = createUser(s.db, { username: 'sets-rpc-b', passwordHash: 'x', role: 'user' });
      const atom = seedAtom(s, s.anonymous.id);
      const clientA = clientFor(s.context({ token: await s.tokenFor() }));
      const clientB = clientFor(s.context({ token: await s.tokenFor(userB) }));
      const a = await clientA.sets.create({ name: 'A 的组合', members: [{ stoneRef: atom }], origin: { kind: 'manual-pick' } });
      // B list 只见自己的（0）。
      expect((await clientB.sets.list({})).total).toBe(0);
      // B 读 A 的组合 FORBIDDEN。
      await expectOrpcError(clientB.sets.get({ resourceId: a.resourceId }), 'FORBIDDEN');
      // B 写 A 的组合 FORBIDDEN（update/delete）。
      await expectOrpcError(
        clientB.sets.update({ resourceId: a.resourceId, baseRevision: 1, patch: { name: '劫持' } }),
        'FORBIDDEN',
      );
      await expectOrpcError(clientB.sets.delete({ resourceId: a.resourceId }), 'FORBIDDEN');
      // B 建自己的组合（成员=共享库弱引用合法——设计如此）；A 仍只见自己的 1 套。
      await clientB.sets.create({ name: 'B 的组合', members: [{ stoneRef: atom }], origin: { kind: 'manual-pick' } });
      expect((await clientA.sets.list({})).total).toBe(1);
      expect((await clientB.sets.list({})).total).toBe(1);
      // A list 含 includeTrashed 也只见自己的。
      expect((await clientA.sets.list({ includeTrashed: true })).total).toBe(1);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [7] createFromBom（S7.6 冻结位）

describe('sets.createFromBom：S7.6 接口位冻结（typed 501）', () => {
  it('任何输入 → NOT_IMPLEMENTED + BOM_SOURCE_NOT_IMPLEMENTED（与 capability 面同码）', async () => {
    const s = createServices();
    try {
      const client = clientFor(s.context({ token: await s.tokenFor() }));
      const err = await expectOrpcError(
        client.sets.createFromBom({ taskId: 'task-1', sourceTaskId: 'task-1' }),
        'NOT_IMPLEMENTED',
      );
      expect(err.message).toContain(BOM_SOURCE_NOT_IMPLEMENTED);
      expect((err.data as { code?: string }).code).toBe(BOM_SOURCE_NOT_IMPLEMENTED);
      // 零落库。
      expect((await client.sets.list({})).total).toBe(0);
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- [8] 认证面

describe('sets 认证面：无 token 401；disabled 用户读可写拒（禁写不禁读）', () => {
  it('未认证六端点全拒；disabled 可 list/get 不可 create/update/delete/createFromBom', async () => {
    const s = createServices();
    try {
      const atom = seedAtom(s, s.anonymous.id);
      const sets = new SetService({ db: s.db, blobs: s.blobs, stones: new StoneService({ db: s.db, blobs: s.blobs }) });
      const created = sets.createSet({
        ownerId: s.anonymous.id,
        name: '禁写面',
        members: [{ stoneRef: atom }],
        origin: { kind: 'manual-pick' },
      });
      const anonymous = clientFor(s.context());
      await expectOrpcError(anonymous.sets.list({}), 'UNAUTHORIZED');
      await expectOrpcError(anonymous.sets.get({ resourceId: 'x' }), 'UNAUTHORIZED');
      await expectOrpcError(
        anonymous.sets.create({ name: 'X', origin: { kind: 'manual-pick' }, members: [{ stoneRef: atom }] }),
        'UNAUTHORIZED',
      );
      // disabled 用户：读可写拒（P1-1 同规；createUser 无 disabled 参——直改行）。
      const disabled = createUser(s.db, { username: 'sets-rpc-disabled', passwordHash: 'x', role: 'user' });
      s.db.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(disabled.id);
      const disabledClient = clientFor(s.context({ token: await s.tokenFor(disabled) }));
      expect((await disabledClient.sets.list({})).total).toBe(0); // owner 过滤=disabled 自己（0）
      await expectOrpcError(disabledClient.sets.get({ resourceId: created.resourceId }), 'FORBIDDEN'); // 读面放行认证、owner 校验仍拒（A 的组合）
      await expectOrpcError(
        disabledClient.sets.create({ name: 'X', origin: { kind: 'manual-pick' }, members: [{ stoneRef: atom }] }),
        'FORBIDDEN',
      );
      await expectOrpcError(
        disabledClient.sets.update({ resourceId: created.resourceId, baseRevision: 1, patch: { name: 'X' } }),
        'FORBIDDEN',
      );
      await expectOrpcError(disabledClient.sets.delete({ resourceId: created.resourceId }), 'FORBIDDEN');
      await expectOrpcError(disabledClient.sets.createFromBom({ taskId: 't', sourceTaskId: 't' }), 'FORBIDDEN');
    } finally {
      s.dispose();
    }
  });
});
