/**
 * sets service 单测（add-stone-library design §7.1/§7.2/§7.4——S7.2 + S7.6 位）。
 * 覆盖面：
 *   [1] production-sets/ 根 seed 幂等（meta.role='production-sets-root'——平级双根 §7.3）。
 *   [2] createSet manual-pick：目录+set.json 文件行（meta.kind='stone-set'）+blob
 *       同事务；getSet 读时解析 roundtrip（resolved 态+限定名+textureUrl）。
 *   [3] 引用集三不变量（§7.1 语义骨架）：
 *       ① 标准更新组合跟随零同步——改标准原子贴图后 set.get 呈现新实测贴图，
 *          set.json 零变更（content_hash/revision 双冻结断言）；
 *       ② 缺失成员显式态不剔除——soft-deleted/blob-missing/wrong-kind/not-found
 *          四态成员仍列在 members（存储清单零变更）；
 *       ③ clone 浅拷贝——成员条目复制、仍指标准原子（母组合后续变更不跟随，
 *          标准库更新双组合跟随）。
 *   [4] 限定名冲突（§7.6）：两标准同 SKU（yuhang/J51 vs factoryB/J51）并存可区分；
 *       soft-deleted/blob-missing 成员经 stone_index 投影行仍得限定名。
 *   [5] updateSet：成员增删/数量/备注清除/改名（目录行同事务改名）/CAS 漂移必拒/
 *       重复成员必拒/清空必拒/非成员显式拒。
 *   [6] 软删同 §1.6：盖戳+list 默认过滤+getSet 回收站详情；production-sets-root 禁删。
 *   [7] bom-derived=接口位冻结（S7.6）：typed 'bom-source-not-implemented' 拒、零落库。
 *   [8] listSets 过滤面（名称/用途/来源）+ owner 隔离（评审 D-1）。
 */
import { rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { SupplierSkuProfileSchema, type RgbTuple, type SupplierSkuProfile } from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { StoneService, type CreateStoneInput } from '../src/stones/service.js';
import { SetService, SetServiceError, applyMemberOps } from '../src/stones/sets-service.js';
import { createUser } from '../src/db/store.js';
import { createServices, type TestServices } from './helpers.js';

const active: TestServices[] = [];
interface Fixture {
  svc: TestServices;
  stones: StoneService;
  sets: SetService;
  ownerId: string;
}
function setup(): Fixture {
  const svc = createServices();
  active.push(svc);
  const stones = new StoneService({ db: svc.db, blobs: svc.blobs });
  return { svc, stones, sets: new SetService({ db: svc.db, blobs: svc.blobs, stones }), ownerId: svc.anonymous.id };
}
afterEach(() => {
  for (const s of active.splice(0)) s.dispose();
});

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

/** size 画布 r 半径圆主体（128/48 与 160/40 两形态——gate 主径 ≥64 均过）。 */
function textureBytes(size = 128, r = 48): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
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

function stoneInput(
  overrides: { sku?: string; supplierProfile?: SupplierSkuProfile; rgb?: RgbTuple } = {},
  ownerId: string,
): CreateStoneInput {
  return {
    ownerId,
    supplierProfile: overrides.supplierProfile ?? YUHANG,
    draft: {
      name: '象牙白 · 2mm',
      sku: overrides.sku ?? 'J51',
      sizeMm: 2,
      color: { name: '象牙白', rgb: overrides.rgb ?? [240, 240, 232], family: '白色系', finish: 'glossy' },
      texture: { declaredWidth: 128, declaredHeight: 128 },
    },
    textureBytes: textureBytes(),
  };
}

function expectSetError(fn: () => unknown, code: string): SetServiceError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SetServiceError);
    const typed = error as SetServiceError;
    expect(typed.code).toBe(code);
    return typed;
  }
  throw new Error(`期望 SetServiceError（code=${code}）但通过了`);
}

/** set.json 文件行 content_hash（不变量①的零变更断言面）。 */
function setJsonHash(svc: TestServices, setResourceId: string): string {
  const row = svc.db
    .prepare('SELECT content_hash FROM resources WHERE parent_id = ? AND name = ?')
    .get(setResourceId, 'set.json') as { content_hash: string };
  return row.content_hash;
}

// ---------------------------------------------------------------- S7.2 seed/CRUD

describe('S7.2 production-sets/ 根 seed（幂等）', () => {
  it('首访问建+meta.role 标记+平级双根落位；二次访问同 id（全局 role 语义同 S1）', () => {
    const { svc, sets, ownerId } = setup();
    const a = sets.ensureSetsRoot(ownerId);
    const row = svc.db
      .prepare('SELECT meta, parent_id, name FROM resources WHERE id = ?')
      .get(a) as { meta: string; parent_id: string; name: string };
    expect(JSON.parse(row.meta)).toEqual({ role: 'production-sets-root' });
    expect(row.name).toBe('production-sets');
    // 平级双根：父=stones 根（与 standards/ 同父——§7.3 裁决）。
    const stonesRoot = svc.db
      .prepare("SELECT id FROM resources WHERE is_dir = 1 AND meta LIKE '%\"role\":\"stones-root\"%'")
      .get() as { id: string };
    expect(row.parent_id).toBe(stonesRoot.id);
    expect(sets.ensureSetsRoot(ownerId)).toBe(a);
    const userB = createUser(svc.db, { username: `u-${randomUUID().slice(0, 8)}`, passwordHash: 'x', role: 'user' });
    expect(sets.ensureSetsRoot(userB.id)).toBe(a); // 全局唯一根（系统根语义）
  });
});

describe('S7.2 createSet/getSet（manual-pick roundtrip）', () => {
  it('目录+set.json 文件行（meta.kind=stone-set）+blob 同事务；成员读时解析 resolved+限定名+textureUrl', () => {
    const { svc, stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    const created = sets.createSet({
      ownerId,
      name: '卡通人物套餐-A',
      purpose: '小件卡通订单',
      members: [{ stoneRef: stone.resourceId, quantity: 2, note: '主石' }],
      origin: { kind: 'manual-pick' },
    });
    expect(created).toMatchObject({ revision: 1, memberCount: 1 });
    expect(created.setId).toMatch(/^set-/);
    // set.json 文件行 meta.kind='stone-set'（S4 referenceFaceOf 扫描的既定约定）。
    const fileRow = svc.db
      .prepare('SELECT meta, content_hash FROM resources WHERE parent_id = ? AND name = ?')
      .get(created.resourceId, 'set.json') as { meta: string; content_hash: string };
    expect(JSON.parse(fileRow.meta)).toEqual({ kind: 'stone-set' });
    expect(fileRow.content_hash).toBe(created.setJsonBlobRef);
    const got = sets.getSet(created.resourceId);
    expect(got.setId).toBe(created.setId);
    expect(got.revision).toBe(1);
    expect(got.trashed).toBe(false);
    expect(got.set.name).toBe('卡通人物套餐-A');
    expect(got.members).toHaveLength(1);
    expect(got.members[0]).toMatchObject({
      stoneRef: stone.resourceId,
      state: 'resolved',
      quantity: 2,
      note: '主石',
      standardId: 'yuhang',
      qualifiedSku: 'yuhang/J51',
      textureUrl: `/api/stones/${stone.resourceId}/texture.png`,
    });
    expect(got.members[0]?.stone).toMatchObject({ supplier: 'yuhang', sku: 'J51' });
  });

  it('成员重复 stoneRef 必拒（聚合形态——同钻多次入库=调 quantity）', () => {
    const { stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    expectSetError(
      () =>
        sets.createSet({
          ownerId,
          name: 'X',
          members: [
            { stoneRef: stone.resourceId, quantity: 1 },
            { stoneRef: stone.resourceId, quantity: 2 },
          ],
          origin: { kind: 'manual-pick' },
        }),
      'duplicate-member',
    );
  });

  it('空成员清单必拒；manual-pick 缺成员必拒', () => {
    const { sets, ownerId } = setup();
    expectSetError(() => sets.createSet({ ownerId, name: 'X', members: [], origin: { kind: 'manual-pick' } }), 'empty-members');
    expectSetError(() => sets.createSet({ ownerId, name: 'X', origin: { kind: 'manual-pick' } }), 'empty-members');
  });
});

// ---------------------------------------------------------------- 引用集三不变量（§7.1）

describe('引用集三不变量（§7.1——S7.1 服务面兑现）', () => {
  it('① 标准更新组合跟随零同步：贴图替换后 set.get 呈现新实测，set.json 零变更', () => {
    const { svc, stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    const created = sets.createSet({
      ownerId,
      name: '跟随测试',
      members: [{ stoneRef: stone.resourceId }],
      origin: { kind: 'manual-pick' },
    });
    const before = sets.getSet(created.resourceId);
    expect(before.members[0]?.stone?.texture).toMatchObject({ width: 128, height: 128 });
    const hashBefore = setJsonHash(svc, created.resourceId);
    // 标准原子贴图替换：128/48 → 160/40（新内容新 hash，resourceId 不变）。
    stones.updateStone(
      stone.resourceId,
      { texture: { bytes: textureBytes(160, 40), declaredWidth: 160, declaredHeight: 160 } },
      { baseRevision: 1 },
    );
    const after = sets.getSet(created.resourceId);
    // 跟随：成员解析呈现新贴图实测（160 画布 80px 主径）——零同步机制。
    expect(after.members[0]?.stone?.texture).toMatchObject({ width: 160, height: 160, alphaBounds: { x: 40, y: 40, w: 80, h: 80 } });
    expect(after.members[0]?.textureUrl).toBe(`/api/stones/${stone.resourceId}/texture.png`);
    // 零变更：set.json 内容与组合 revision 双冻结。
    expect(setJsonHash(svc, created.resourceId)).toBe(hashBefore);
    expect(after.revision).toBe(before.revision);
    expect(after.set.updatedAt).toBe(before.set.updatedAt);
  });

  it('② 缺失成员显式态不剔除（soft-deleted/blob-missing/wrong-kind/not-found 仍在列）', () => {
    const { svc, stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    const familyDir = svc.db
      .prepare("SELECT id FROM resources WHERE is_dir = 1 AND name = '白色系'")
      .get() as { id: string };
    const created = sets.createSet({
      ownerId,
      name: '缺失显式态',
      members: [
        { stoneRef: stone.resourceId },
        { stoneRef: familyDir.id }, // 非原子目录 → wrong-kind
        { stoneRef: randomUUID() }, // 行不存在 → not-found
      ],
      origin: { kind: 'manual-pick' },
    });
    let got = sets.getSet(created.resourceId);
    expect(got.members.map((m) => m.state)).toEqual(['resolved', 'wrong-kind', 'not-found']);
    expect(got.members[1]?.qualifiedSku).toBeUndefined(); // wrong-kind 无限定名投影
    expect(got.members[2]?.qualifiedSku).toBeUndefined();
    // 软删标准原子 → soft-deleted 态（仍在列，不剔除；限定名经 stone_index 投影行）。
    stones.softDelete(stone.resourceId);
    got = sets.getSet(created.resourceId);
    expect(got.members[0]).toMatchObject({ state: 'soft-deleted', qualifiedSku: 'yuhang/J51' });
    expect(got.set.stones).toHaveLength(3); // 存储清单零变更
    // 贴图实体亡 → blob-missing 态（恢复后删 blob 实体模拟）。
    stones.restore(stone.resourceId);
    rmSync(svc.blobs.pathFor(stones.getStone(stone.resourceId).texture.blobRef)!);
    got = sets.getSet(created.resourceId);
    expect(got.members[0]).toMatchObject({ state: 'blob-missing', qualifiedSku: 'yuhang/J51' });
    expect(got.set.stones).toHaveLength(3);
  });

  it('③ clone 浅拷贝：成员条目复制仍指标准原子；母组合后续变更不跟随、标准库更新双跟随', () => {
    const { stones, sets, ownerId } = setup();
    const stoneA = stones.createStone(stoneInput({ sku: 'J51' }, ownerId));
    const stoneB = stones.createStone(stoneInput({ sku: 'A51' }, ownerId));
    const mother = sets.createSet({
      ownerId,
      name: '母组合',
      members: [
        { stoneRef: stoneA.resourceId, quantity: 2, note: '主石' },
        { stoneRef: stoneB.resourceId },
      ],
      origin: { kind: 'manual-pick' },
    });
    const clone = sets.createSet({
      ownerId,
      name: '复用副本',
      origin: { kind: 'clone', fromSetId: mother.resourceId },
    });
    expect(clone.memberCount).toBe(2);
    const cloneGot = sets.getSet(clone.resourceId);
    expect(cloneGot.set.origin).toEqual({ kind: 'clone', fromSetId: mother.resourceId });
    expect(cloneGot.set.stones).toEqual([
      { stoneRef: stoneA.resourceId, quantity: 2, note: '主石' },
      { stoneRef: stoneB.resourceId },
    ]);
    expect(cloneGot.members.map((m) => [m.state, m.qualifiedSku])).toEqual([
      ['resolved', 'yuhang/J51'],
      ['resolved', 'yuhang/A51'],
    ]);
    // 母组合后续变更不跟随（拷贝即快照——组合间零联动）。
    sets.updateSet(mother.resourceId, { removeMembers: [stoneB.resourceId] }, { baseRevision: 1 });
    expect(sets.getSet(clone.resourceId).set.stones).toHaveLength(2);
    // 标准库更新双跟随（浅拷贝仍指标准原子——不是 stone 数据副本）。
    stones.updateStone(stoneA.resourceId, { sizeMm: 3 }, { baseRevision: 1 });
    for (const id of [mother.resourceId, clone.resourceId]) {
      expect(sets.getSet(id).members.find((m) => m.stoneRef === stoneA.resourceId)?.stone?.sizeMm).toBe(3);
    }
  });

  it('clone 校验族：缺 fromSetId/双源/母组合不存在/跨 owner/软删母组合', () => {
    const { svc, stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    const mother = sets.createSet({
      ownerId,
      name: '母',
      members: [{ stoneRef: stone.resourceId }],
      origin: { kind: 'manual-pick' },
    });
    expectSetError(() => sets.createSet({ ownerId, name: 'X', origin: { kind: 'clone' } }), 'invalid-origin');
    expectSetError(
      () =>
        sets.createSet({
          ownerId,
          name: 'X',
          members: [{ stoneRef: stone.resourceId }],
          origin: { kind: 'clone', fromSetId: mother.resourceId },
        }),
      'invalid-origin',
    );
    expectSetError(() => sets.createSet({ ownerId, name: 'X', origin: { kind: 'clone', fromSetId: randomUUID() } }), 'not-found');
    // 跨 owner clone 必拒（评审 D-1：组合读写均按 owner）。
    const userB = createUser(svc.db, { username: `set-b-${randomUUID().slice(0, 8)}`, passwordHash: 'x', role: 'user' });
    expectSetError(
      () => sets.createSet({ ownerId: userB.id, name: 'X', origin: { kind: 'clone', fromSetId: mother.resourceId } }),
      'owner-mismatch',
    );
    // 软删母组合 → clone 拒（回收站内不改真值同族语义）。
    sets.softDeleteSet(mother.resourceId);
    expectSetError(
      () => sets.createSet({ ownerId, name: 'X', origin: { kind: 'clone', fromSetId: mother.resourceId } }),
      'soft-deleted',
    );
  });
});

// ---------------------------------------------------------------- 限定名冲突（§7.6）

describe('限定名冲突（§7.6——两标准同 SKU 并存可区分）', () => {
  it('yuhang/J51 与 factoryB/J51 同组合并存、qualifiedSku 互异', () => {
    const { stones, sets, ownerId } = setup();
    const yuhangJ51 = stones.createStone(stoneInput({ sku: 'J51', supplierProfile: YUHANG }, ownerId));
    const factoryBJ51 = stones.createStone(
      stoneInput({ sku: 'J51', supplierProfile: FACTORY_B, rgb: [176, 141, 87] }, ownerId),
    );
    const created = sets.createSet({
      ownerId,
      name: '混合搭配',
      members: [
        { stoneRef: yuhangJ51.resourceId, quantity: 2 },
        { stoneRef: factoryBJ51.resourceId, quantity: 1 },
      ],
      origin: { kind: 'manual-pick' },
    });
    const got = sets.getSet(created.resourceId);
    expect(got.members.map((m) => [m.standardId, m.qualifiedSku])).toEqual([
      ['yuhang', 'yuhang/J51'],
      ['factoryB', 'factoryB/J51'],
    ]);
  });
});

// ---------------------------------------------------------------- updateSet

describe('S7.2 updateSet（成员增删/数量/改名+CAS）', () => {
  it('成员运算全链：追加/移除/数量更新/备注清除/改名（目录行同事务改名）', () => {
    const { stones, sets, ownerId } = setup();
    const a = stones.createStone(stoneInput({ sku: 'J51' }, ownerId));
    const b = stones.createStone(stoneInput({ sku: 'A51' }, ownerId));
    const c = stones.createStone(stoneInput({ sku: 'B51' }, ownerId));
    const created = sets.createSet({
      ownerId,
      name: '原名',
      purpose: '原用途',
      members: [
        { stoneRef: a.resourceId, quantity: 2, note: '主石' },
        { stoneRef: b.resourceId, quantity: 1 },
      ],
      origin: { kind: 'manual-pick' },
    });
    const updated = sets.updateSet(
      created.resourceId,
      {
        name: '新名',
        purpose: null,
        addMembers: [{ stoneRef: c.resourceId, quantity: 5 }],
        removeMembers: [b.resourceId],
        updateMembers: [{ stoneRef: a.resourceId, quantity: 3, note: null }],
      },
      { baseRevision: 1 },
    );
    expect(updated).toMatchObject({ revision: 2, memberCount: 2 });
    const got = sets.getSet(created.resourceId);
    expect(got.set.name).toBe('新名');
    expect(got.set.purpose).toBeUndefined();
    expect(got.set.stones).toEqual([
      { stoneRef: a.resourceId, quantity: 3 }, // note 清除、quantity 更新
      { stoneRef: c.resourceId, quantity: 5 },
    ]);
    expect(got.path.endsWith('/新名')).toBe(true); // 目录行改名（引用只认 resourceId）
  });

  it('CAS 漂移必拒；重复成员/清空/非成员显式拒', () => {
    const { stones, sets, ownerId } = setup();
    const a = stones.createStone(stoneInput({}, ownerId));
    const created = sets.createSet({
      ownerId,
      name: 'X',
      members: [{ stoneRef: a.resourceId }],
      origin: { kind: 'manual-pick' },
    });
    expectSetError(() => sets.updateSet(created.resourceId, { name: 'Y' }, { baseRevision: 99 }), 'revision-conflict');
    expectSetError(
      () => sets.updateSet(created.resourceId, { addMembers: [{ stoneRef: a.resourceId }] }, { baseRevision: 1 }),
      'duplicate-member',
    );
    expectSetError(
      () => sets.updateSet(created.resourceId, { removeMembers: [a.resourceId] }, { baseRevision: 1 }),
      'empty-members',
    );
    expectSetError(
      () => sets.updateSet(created.resourceId, { removeMembers: [randomUUID()] }, { baseRevision: 1 }),
      'not-found',
    );
    expectSetError(
      () => sets.updateSet(created.resourceId, { updateMembers: [{ stoneRef: randomUUID(), quantity: 2 }] }, { baseRevision: 1 }),
      'not-found',
    );
  });

  it('applyMemberOps 纯函数：移除+重加同 stoneRef=重置条目（合法路径）', () => {
    const next = applyMemberOps([{ stoneRef: 's1', quantity: 1, note: '旧' }], {
      removeMembers: ['s1'],
      addMembers: [{ stoneRef: 's1', quantity: 9 }],
    });
    expect(next).toEqual([{ stoneRef: 's1', quantity: 9 }]);
  });
});

// ---------------------------------------------------------------- 软删/列表/S7.6

describe('S7.2 软删+listSets+S7.6 接口位', () => {
  it('软删盖戳+list 默认过滤+getSet 回收站详情；根禁删；非组合目录拒', () => {
    const { stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    const created = sets.createSet({
      ownerId,
      name: '待删',
      members: [{ stoneRef: stone.resourceId }],
      origin: { kind: 'manual-pick' },
    });
    expect(sets.softDeleteSet(created.resourceId)).toEqual({ trashedRows: 2 }); // 目录+set.json 两行
    expect(sets.listSets({ ownerId })).toHaveLength(0);
    expect(sets.listSets({ ownerId, includeTrashed: true })).toHaveLength(1);
    expect(sets.getSet(created.resourceId).trashed).toBe(true);
    // 根禁删（§1.6 系统目录保护同族）。
    expectSetError(() => sets.softDeleteSet(sets.ensureSetsRoot(ownerId)), 'system-dir-protected');
    // 非组合目录（供应商目录）→ wrong-kind。
    expectSetError(() => sets.softDeleteSet(stones.ensureSupplier(ownerId, YUHANG)), 'wrong-kind');
  });

  it('listSets 过滤面（名称/用途/来源）+ owner 隔离（评审 D-1）', () => {
    const { svc, stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    const a = sets.createSet({
      ownerId,
      name: '卡通人物套餐-A',
      purpose: '小件卡通订单',
      members: [{ stoneRef: stone.resourceId }],
      origin: { kind: 'manual-pick' },
    });
    sets.createSet({ ownerId, name: '复用副本', origin: { kind: 'clone', fromSetId: a.resourceId } });
    expect(sets.listSets({ ownerId }).map((s) => s.name)).toEqual(['卡通人物套餐-A', '复用副本']); // name 稳定序
    expect(sets.listSets({ ownerId, name: '卡通' }).map((s) => s.name)).toEqual(['卡通人物套餐-A']);
    expect(sets.listSets({ ownerId, purpose: '订单' })).toHaveLength(1);
    expect(sets.listSets({ ownerId, originKind: 'clone' }).map((s) => s.name)).toEqual(['复用副本']);
    expect(sets.listSets({ ownerId, originKind: 'manual-pick' })).toHaveLength(1);
    // owner 隔离（评审 D-1：组合=私有生产工件，读写均按 owner）。
    const userB = createUser(svc.db, { username: `set-iso-${randomUUID().slice(0, 8)}`, passwordHash: 'x', role: 'user' });
    expect(sets.listSets({ ownerId: userB.id })).toHaveLength(0);
  });

  it('S7.6 接口位冻结：bom-derived 来源 typed 拒（零落库）', () => {
    const { svc, stones, sets, ownerId } = setup();
    const stone = stones.createStone(stoneInput({}, ownerId));
    const err = expectSetError(
      () =>
        sets.createSet({
          ownerId,
          name: 'BOM 反推',
          members: [{ stoneRef: stone.resourceId }],
          origin: { kind: 'bom-derived', sourceTaskId: 'task-1' },
        }),
      'bom-source-not-implemented',
    );
    expect(err.message).toContain('bom-derived');
    expect(
      (svc.db.prepare("SELECT COUNT(*) AS n FROM resources WHERE meta LIKE '%\"kind\":\"stone-set\"%'").get() as { n: number }).n,
    ).toBe(0);
  });
});
