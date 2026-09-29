/**
 * 首条创建流回归（add-task-stones-manifest-export 1.1/1.3——arch-decisions A2/A5
 * 行为锁定）。fake 内核 harness（不 boot dsh——kernel.test.ts fakeKernelHarness 同
 * 模式）：HandicraftKernel 直构+注入 fake handle（agents.create/attachments.
 * saveImages 假实现），覆盖：
 *   [1] 携集合首条：展开快照（StonePick 物化+stoneRevision/stoneJsonBlobRef/
 *       textureBlobRef/shapeAssetBlobRef 冻结）+task 行与 rev1 manifest 同事务提交
 *       +params 审计（sourceSetId/imageIds）+manifest artifact 帧。
 *   [2] 冻结语义（A2）：集合展开后增删成员——项目 manifest 字节不变（blob_ref 与
 *       内容双冻结；set revision 已前进仍不影响）。
 *   [3] 跳过集合：rev1 空 entries（sourceSet=null）；第二个 followup 读到同一
 *       manifest（revision/blob_ref 不动）；非首个携 sourceSetId=typed 拒。
 *   [4] 无效成员 typed 拒（错误码+具体 stoneRef 清单）+零残留（无 task 行/无
 *       session_projects 行/无会话 blob 引用账本行）——解析不到/软删/缺 quantity
 *       （W0 契约 quantity 正整数——0 物化被阻断的冻结裁量）三态。
 *   [5] 重试放行（W0 裁量 3）：首条失败（零残留→会话仍无 agent task 行=首个判定
 *       不变）→重试携 sourceSetId 成功建 rev1 manifest。
 *   [6] 多图 imageId（A5）：首条两张附件→image-1/image-2 稳定分配+task 审计在场；
 *       后续轮次附件=讨论插图不分配。
 *   [7] set 栅栏：他人集合=set-forbidden；回收站集合=set-soft-deleted（typed）。
 */
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { SupplierSkuProfileSchema, type RgbTuple, type SupplierSkuProfile } from '@handicraft/contracts';
import { createServices, type TestServices } from './helpers.js';
import { encodePng } from '../src/png/codec.js';
import { recordBlobUpload } from '../src/db/blobs.js';
import { createUser } from '../src/db/store.js';
import { StoneService, type CreateStoneInput } from '../src/stones/service.js';
import { SetService } from '../src/stones/sets-service.js';
import { HandicraftKernel } from '../src/kernel/index.js';
import {
  ProjectManifestService,
  STONES_MANIFEST_ARTIFACT_NAME,
} from '../src/kernel/project-manifest.js';
import { ProjectExpandError } from '../src/kernel/project-expand.js';
import type { StonesManifest } from '@handicraft/contracts';

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

/** 圆主体贴图（sets-service.test.ts 同款——gate 主径 ≥64 过）。 */
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

/** followup 附件 PNG（魔数嗅探面——8x6 纯色即可）。 */
function attachmentPng(s: TestServices, ownerId: string): string {
  const bytes = textureBytes(72, 32);
  const hash = s.blobs.put(bytes).hash;
  recordBlobUpload(s.db, hash, ownerId);
  return hash;
}

/**
 * fake 内核 harness：Handle 注入（state=ready + agents/attachments 假服务）——
 * followup 全管线（校验/建行事务/manifest/审计/标注 prompt）真实执行，仅 agent
 * 会话启动面为假（attachments-chain.test.ts bridgeHarness 同模式）。
 */
function readyKernel(s: TestServices): HandicraftKernel {
  const prompts: unknown[] = [];
  const agent = {
    session: { id: '' },
    status: 'idle',
    followup(message: unknown): void {
      prompts.push(message);
    },
    steer(): void {},
    inject(): void {},
    cancel(): void {},
    whenIdle: () => Promise.resolve(),
    inbox: { nextTurn: [], nextStep: [], remove: () => false, replace: () => false, splice: () => [] },
  };
  const handle = {
    ctx: {
      on: () => () => undefined,
      agents: {
        create: async (options: { sessionId: string; setup?: (agentCtx: Context) => void }) => {
          agent.session.id = options.sessionId;
          options.setup?.({
            tools: { schemas: () => [{ name: 'bash' }], restrict: () => () => undefined },
          } as unknown as Context);
          return { agent, dispose: async () => undefined };
        },
      },
      attachments: {
        saveImages: async (inputs: ReadonlyArray<{ data: Uint8Array }>) =>
          inputs.map((input, index) => ({ attachmentId: `att-${index}`, width: 8, height: 6, bytes: input.data.byteLength })),
      },
    },
    record: { entries: [], activationOrder: [], inactiveActivation: [] },
    globalToolNames: () => [] as string[],
    dispose: async () => undefined,
  };
  const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
  const hack = kernel as unknown as { state: string; handle: unknown };
  hack.state = 'ready';
  hack.handle = handle;
  return kernel;
}

interface Fixture {
  s: TestServices;
  kernel: HandicraftKernel;
  stones: StoneService;
  sets: SetService;
  manifests: ProjectManifestService;
  ownerId: string;
}

async function setup(): Promise<Fixture> {
  const s = createServices(undefined, { imgDryRun: true });
  const stones = new StoneService({ db: s.db, blobs: s.blobs });
  const sets = new SetService({ db: s.db, blobs: s.blobs, stones });
  return {
    s,
    kernel: readyKernel(s),
    stones,
    sets,
    manifests: new ProjectManifestService({ config: s.config, db: s.db, blobs: s.blobs, jobs: s.jobs }),
    ownerId: s.anonymous.id,
  };
}

/** 会话内 task 行数/params（残留断言面）。 */
function taskRows(f: Fixture, sessionId: string): Array<{ id: string; status: string; params: string }> {
  return f.s.db
    .prepare('SELECT id, status, params FROM tasks WHERE session_id = ? ORDER BY created_at, rowid')
    .all(sessionId) as Array<{ id: string; status: string; params: string }>;
}

// ---------------------------------------------------------------- 1.1 展开快照+同事务

describe('W1 1.1 首条携集合：展开快照+task 行与 rev1 manifest 同事务', () => {
  it('物化 StonePick+冻结 revision/blobRef+审计+artifact 帧；空 shapeAsset=合理缺省', async () => {
    const f = await setup();
    try {
      const ivory = f.stones.createStone(stoneInput({ sku: 'J51' }, f.ownerId));
      const red = f.stones.createStone(stoneInput({ sku: 'J76', rgb: [255, 0, 0] }, f.ownerId));
      const created = f.sets.createSet({
        ownerId: f.ownerId,
        name: '夏季主色',
        members: [
          { stoneRef: ivory.resourceId, quantity: 120, note: '主石备料' },
          { stoneRef: red.resourceId, quantity: 30 },
        ],
        origin: { kind: 'manual-pick' },
      });
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '项目会话' });
      const { taskId } = await f.kernel.followup(f.s.anonymous, sessionId, {
        text: '开始排钻',
        sourceSetId: created.resourceId,
      });
      // task 行在场+审计（A1：params 只留审计输入——sourceSetId 在场；无附件=无 imageIds）。
      const rows = taskRows(f, sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe('running');
      expect(JSON.parse(rows[0]!.params)).toMatchObject({
        text: '开始排钻',
        sourceSetId: created.resourceId,
      });
      expect(JSON.parse(rows[0]!.params).imageIds).toBeUndefined();
      // rev1 manifest：sourceSet 溯源+物化 entries。
      const loaded = f.manifests.loadManifest(sessionId);
      expect(loaded.revision).toBe(1);
      const manifest = loaded.manifest as StonesManifest;
      expect(manifest.projectId).toBe(sessionId);
      expect(manifest.updatedByTaskId).toBe(taskId);
      expect(manifest.sourceSet).toEqual({
        resourceId: created.resourceId,
        setId: created.setId,
        setRevision: 1,
        name: '夏季主色',
      });
      expect(manifest.entries).toHaveLength(2);
      const [entryIvory, entryRed] = manifest.entries;
      expect(entryIvory).toMatchObject({
        stoneRef: ivory.resourceId,
        pick: { resourceId: ivory.resourceId, sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#F0F0E8' },
        stoneRevision: 1,
        quantity: 120,
        note: '主石备料',
        origin: 'set',
      });
      // blob 引用冻结=stone 域文件行 content_hash（引用账本锚）。
      const ivoryJsonHash = f.s.db
        .prepare("SELECT content_hash FROM resources WHERE parent_id = ? AND name = 'stone.json'")
        .get(ivory.resourceId) as { content_hash: string };
      const ivoryTextureHash = f.s.db
        .prepare("SELECT content_hash FROM resources WHERE parent_id = ? AND name = '贴图.png'")
        .get(ivory.resourceId) as { content_hash: string };
      expect(entryIvory?.stoneJsonBlobRef).toBe(ivoryJsonHash.content_hash);
      expect(entryIvory?.textureBlobRef).toBe(ivoryTextureHash.content_hash);
      expect(entryIvory?.shapeAssetBlobRef).toBeNull(); // 缺场合理缺省（无 .gemshape 全局面）
      expect(entryRed?.pick.colorHex).toBe('#FF0000');
      expect(entryRed?.note).toBeUndefined();
      // manifest artifact 帧（latest-by-name 审计面）。
      const frames = f.s.jobs.frames(f.s.anonymous, taskId, 0).frames;
      expect(
        frames.some(
          (frame) =>
            frame.kind === 'artifact' &&
            (frame.payload as { name?: string; blobRef?: string }).name === STONES_MANIFEST_ARTIFACT_NAME,
        ),
      ).toBe(true);
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 1.3 冻结语义

describe('W1 1.3 集合后续变更不影响项目字节（A2 复制语义）', () => {
  it('展开后 set 增删成员（revision 前进）→manifest 内容与 blob_ref 双不变', async () => {
    const f = await setup();
    try {
      const a = f.stones.createStone(stoneInput({ sku: 'J51' }, f.ownerId));
      const b = f.stones.createStone(stoneInput({ sku: 'J76', rgb: [255, 0, 0] }, f.ownerId));
      const c = f.stones.createStone(stoneInput({ sku: 'A55', rgb: [0, 0, 255] }, f.ownerId));
      const created = f.sets.createSet({
        ownerId: f.ownerId,
        name: '冻结组合',
        members: [
          { stoneRef: a.resourceId, quantity: 10 },
          { stoneRef: b.resourceId, quantity: 20 },
        ],
        origin: { kind: 'manual-pick' },
      });
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '冻结' });
      await f.kernel.followup(f.s.anonymous, sessionId, { text: '选集合', sourceSetId: created.resourceId });
      const before = f.manifests.loadManifest(sessionId);
      const beforeRow = f.s.db
        .prepare('SELECT revision, blob_ref FROM session_projects WHERE session_id = ?')
        .get(sessionId) as { revision: number; blob_ref: string };
      const beforeBytes = f.s.blobs.read(beforeRow.blob_ref)?.toString('utf8');
      // 集合漂移：移除一员+新增一员（revision 1→2）。
      f.sets.updateSet(
        created.resourceId,
        { removeMembers: [b.resourceId], addMembers: [{ stoneRef: c.resourceId, quantity: 99 }] },
        { baseRevision: 1 },
      );
      // 项目快照冻结：内容+blob_ref+revision 全不变。
      const after = f.manifests.loadManifest(sessionId);
      expect(after.revision).toBe(before.revision);
      expect(after.manifest).toEqual(before.manifest);
      const afterRow = f.s.db
        .prepare('SELECT revision, blob_ref FROM session_projects WHERE session_id = ?')
        .get(sessionId) as { revision: number; blob_ref: string };
      expect(afterRow.blob_ref).toBe(beforeRow.blob_ref);
      expect(f.s.blobs.read(afterRow.blob_ref)?.toString('utf8')).toBe(beforeBytes);
      expect(after.manifest?.entries.map((entry) => entry.stoneRef)).toEqual([a.resourceId, b.resourceId]);
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 1.3 跳过集合+共享 manifest

describe('W1 1.3 跳过集合=rev1 空 entries；后续 followup 读同一 manifest', () => {
  it('空 manifest 初版+第二 followup 零改写+非首个携 sourceSetId=typed 拒', async () => {
    const f = await setup();
    try {
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '跳过集合' });
      const first = await f.kernel.followup(f.s.anonymous, sessionId, { text: '先不选集合' });
      const loaded1 = f.manifests.loadManifest(sessionId);
      expect(loaded1.revision).toBe(1);
      expect(loaded1.manifest).toMatchObject({ sourceSet: null, entries: [], projectId: sessionId, updatedByTaskId: first.taskId });
      const row1 = f.s.db
        .prepare('SELECT revision, blob_ref FROM session_projects WHERE session_id = ?')
        .get(sessionId) as { revision: number; blob_ref: string };
      // 第二个常规 followup：读到同一 manifest（不重建/不覆盖）。
      const second = await f.kernel.followup(f.s.anonymous, sessionId, { text: '继续排' });
      expect(second.taskId).not.toBe(first.taskId);
      const loaded2 = f.manifests.loadManifest(sessionId);
      expect(loaded2.revision).toBe(1);
      expect(loaded2.manifest).toEqual(loaded1.manifest);
      const row2 = f.s.db
        .prepare('SELECT revision, blob_ref FROM session_projects WHERE session_id = ?')
        .get(sessionId) as { revision: number; blob_ref: string };
      expect(row2).toEqual(row1);
      // 非首个携 sourceSetId=typed 拒（追加钻走 MCP stones.add——A5）。
      const stone = f.stones.createStone(stoneInput({ sku: 'J51' }, f.ownerId));
      const created = f.sets.createSet({
        ownerId: f.ownerId,
        name: '迟到的集合',
        members: [{ stoneRef: stone.resourceId, quantity: 5 }],
        origin: { kind: 'manual-pick' },
      });
      await expect(
        f.kernel.followup(f.s.anonymous, sessionId, { text: '换集合', sourceSetId: created.resourceId }),
      ).rejects.toThrow(/sourceSetId 仅在会话首个常规 followup 有效/);
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });

  it('存量会话（W1 前首条已建 task 行、无 session_projects）→后续 followup 幂等补建空 manifest', async () => {
    const f = await setup();
    try {
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '存量会话' });
      // 模拟 W1 前的会话：已有 agent task 行（终态亦可）但无 session_projects 行。
      const legacy = f.s.db
        .prepare(
          "INSERT INTO tasks (id, owner_id, resource_id, session_id, type, status, params, result_id, created_at, updated_at) VALUES (?, ?, NULL, ?, 'agent', 'done', NULL, NULL, ?, ?)",
        )
        .run(`legacy-${Date.now()}`, f.ownerId, sessionId, new Date().toISOString(), new Date().toISOString());
      expect(legacy.changes).toBe(1);
      // 携 sourceSetId=非首个拒（gate 先行）；纯 followup=幂等补建 rev1 空 manifest。
      const next = await f.kernel.followup(f.s.anonymous, sessionId, { text: '继续老会话' });
      const loaded = f.manifests.loadManifest(sessionId);
      expect(loaded.revision).toBe(1);
      expect(loaded.manifest).toMatchObject({ sourceSet: null, entries: [], updatedByTaskId: next.taskId });
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 1.3 无效成员 typed 拒+零残留

describe('W1 1.3 无效成员 typed 拒（错误码+stoneRef 清单）+零残留', () => {
  it('解析不到/软删/缺 quantity 三态——无 task 行/无 manifest 行/无账本行', async () => {
    const f = await setup();
    try {
      const valid = f.stones.createStone(stoneInput({ sku: 'J51' }, f.ownerId));
      const softDeleted = f.stones.createStone(stoneInput({ sku: 'J76', rgb: [255, 0, 0] }, f.ownerId));
      f.stones.softDelete(softDeleted.resourceId);
      const noQuantity = f.stones.createStone(stoneInput({ sku: 'A55', rgb: [0, 0, 255] }, f.ownerId));
      const created = f.sets.createSet({
        ownerId: f.ownerId,
        name: '带伤组合',
        members: [
          { stoneRef: valid.resourceId, quantity: 10 },
          { stoneRef: 'no-such-stone-ref', quantity: 1 },
          { stoneRef: softDeleted.resourceId, quantity: 2 },
          { stoneRef: noQuantity.resourceId }, // quantity 缺省（W0 契约 0 物化阻断——冻结裁量）
        ],
        origin: { kind: 'manual-pick' },
      });
      const attachment = attachmentPng(f.s, f.ownerId); // 附件也进事务——回滚须零账本残留
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '拒' });
      const attempt = f.kernel.followup(f.s.anonymous, sessionId, {
        text: '选了坏集合',
        attachments: [attachment],
        sourceSetId: created.resourceId,
      });
      await expect(attempt).rejects.toThrow(ProjectExpandError);
      // typed 明细：kind+两条无效 stoneRef 清单（软删/解析不到——缺 quantity 已按
      // W1 契约裁定修正物化 0 合法展开，不再属无效态）。
      let caught: unknown;
      try {
        await attempt;
      } catch (error) {
        caught = error;
      }
      const typed = caught as ProjectExpandError;
      expect(typed.kind).toBe('invalid-members');
      expect(typed.message).toContain('no-such-stone-ref');
      expect(typed.message).toContain(softDeleted.resourceId);
      expect(typed.message).not.toContain(noQuantity.resourceId);
      const detail = typed.detail.members as Array<{ stoneRef: string; reason: string }>;
      expect(detail.map((item) => item.stoneRef)).toEqual(['no-such-stone-ref', softDeleted.resourceId]);
      expect(detail[1]?.reason).toContain('软删');
      // 零残留：无 task 行/无 session_projects 行/无会话 blob 引用（附件回滚）。
      expect(taskRows(f, sessionId)).toHaveLength(0);
      expect(f.s.db.prepare('SELECT 1 FROM session_projects WHERE session_id = ?').get(sessionId)).toBeUndefined();
      expect(f.s.db.prepare('SELECT 1 FROM session_blob_refs WHERE session_id = ?').get(sessionId)).toBeUndefined();
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 1.3 重试放行

describe('W1 1.3 失败首条重试放行（W0 裁量 3——首个判定不变+幂等建 manifest）', () => {
  it('首条无效成员拒（零残留）→修复集合→重试携 sourceSetId 成功建 rev1 manifest', async () => {
    const f = await setup();
    try {
      const a = f.stones.createStone(stoneInput({ sku: 'J51' }, f.ownerId));
      const broken = f.sets.createSet({
        ownerId: f.ownerId,
        name: '先坏后好',
        members: [
          { stoneRef: a.resourceId, quantity: 10 },
          { stoneRef: 'no-such-stone-ref', quantity: 1 },
        ],
        origin: { kind: 'manual-pick' },
      });
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '重试' });
      // 首条失败：typed 拒+零残留（会话仍无 agent task 行=首个判定不变）。
      await expect(
        f.kernel.followup(f.s.anonymous, sessionId, { text: '第一次', sourceSetId: broken.resourceId }),
      ).rejects.toThrow(/no-such-stone-ref/);
      expect(taskRows(f, sessionId)).toHaveLength(0);
      // 修复集合（移除坏成员——revision 前进）后重试：sourceSetId 仍放行（首个）。
      f.sets.updateSet(broken.resourceId, { removeMembers: ['no-such-stone-ref'] }, { baseRevision: 1 });
      const retried = await f.kernel.followup(f.s.anonymous, sessionId, {
        text: '重试',
        sourceSetId: broken.resourceId,
      });
      const loaded = f.manifests.loadManifest(sessionId);
      expect(loaded.revision).toBe(1);
      expect(loaded.manifest?.sourceSet).toMatchObject({ resourceId: broken.resourceId, setRevision: 2, name: '先坏后好' });
      expect(loaded.manifest?.entries).toHaveLength(1);
      expect(loaded.manifest?.entries[0]).toMatchObject({ stoneRef: a.resourceId, quantity: 10 });
      expect(loaded.manifest?.updatedByTaskId).toBe(retried.taskId);
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- 1.3 多图 imageId

describe('W1 1.3 多图 imageId 稳定分配（A5——仅首条进图集）', () => {
  it('首条两张附件→image-1/image-2 稳定+审计在场；后续附件=讨论插图不分配', async () => {
    const f = await setup();
    try {
      const hash1 = attachmentPng(f.s, f.ownerId);
      const hash2 = attachmentPng(f.s, f.ownerId);
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '多图' });
      const first = await f.kernel.followup(f.s.anonymous, sessionId, {
        text: '两张主图',
        attachments: [hash1, hash2],
      });
      // 首条：主图集按输入顺序稳定分配+审计在场（assignTaskImageIds 契约单源）。
      const firstParams = JSON.parse(taskRows(f, sessionId)[0]!.params) as {
        attachments?: string[];
        imageIds?: string[];
      };
      expect(firstParams.attachments).toEqual([hash1, hash2]);
      expect(firstParams.imageIds).toEqual(['image-1', 'image-2']);
      // 跳过集合的首条同样建 rev1 空 manifest（图集与集合选择正交）。
      expect(f.manifests.loadManifest(sessionId)).toMatchObject({ revision: 1 });
      // 第二条：附件=讨论插图——不分配 imageId。
      const hash3 = attachmentPng(f.s, f.ownerId);
      await f.kernel.followup(f.s.anonymous, sessionId, { text: '补一张参考图', attachments: [hash3] });
      const secondParams = JSON.parse(taskRows(f, sessionId)[1]!.params) as {
        attachments?: string[];
        imageIds?: string[];
      };
      expect(secondParams.attachments).toEqual([hash3]);
      expect(secondParams.imageIds).toBeUndefined();
      // manifest 不因第二条重建（同一项目清单——attachment 引用与 manifest 并存）。
      expect(f.manifests.loadManifest(sessionId).revision).toBe(1);
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });
});

// ---------------------------------------------------------------- set 栅栏

describe('W1 set 选择栅栏（owner 隔离/回收站——sets 现状语义）', () => {
  it('他人集合=set-forbidden；回收站集合=set-soft-deleted（均零残留）', async () => {
    const f = await setup();
    try {
      const stone = f.stones.createStone(stoneInput({ sku: 'J51' }, f.ownerId));
      const other = createUser(f.s.db, { username: 'set-owner-b', passwordHash: 'pw-set-owner-b', role: 'user' });
      const theirs = f.sets.createSet({
        ownerId: other.id,
        name: '别人的组合',
        members: [{ stoneRef: stone.resourceId, quantity: 3 }],
        origin: { kind: 'manual-pick' },
      });
      const trashed = f.sets.createSet({
        ownerId: f.ownerId,
        name: '回收站组合',
        members: [{ stoneRef: stone.resourceId, quantity: 3 }],
        origin: { kind: 'manual-pick' },
      });
      f.sets.softDeleteSet(trashed.resourceId);
      const { sessionId } = f.s.sessions.create(f.s.anonymous, { title: '栅栏' });
      await expect(
        f.kernel.followup(f.s.anonymous, sessionId, { text: '选他人集合', sourceSetId: theirs.resourceId }),
      ).rejects.toThrow(/不属于当前用户/);
      await expect(
        f.kernel.followup(f.s.anonymous, sessionId, { text: '选回收站集合', sourceSetId: trashed.resourceId }),
      ).rejects.toThrow(/回收站/);
      expect(taskRows(f, sessionId)).toHaveLength(0);
      expect(f.s.db.prepare('SELECT 1 FROM session_projects WHERE session_id = ?').get(sessionId)).toBeUndefined();
      await f.kernel.stop();
    } finally {
      f.s.dispose();
    }
  });
});
