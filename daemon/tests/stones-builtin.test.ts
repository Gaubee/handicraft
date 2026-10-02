/**
 * 内置标准钻全链测试（add-builtin-standard-stones tasks 1.1/1.4）。
 * 原始需求 2026-10-02（E2E 走查实证：空钻库自动路径在 stone.create 结构性必死
 * ——贴图必填但 agent 无上传面）。覆盖：
 *   [1] 贴图生成器（builtin-texture.ts）：确定性（同 rgb 同字节）、异 rgb 异字节、
 *       128×128 解码对账、圆内 alpha=255/圆外 alpha=0、六 gate 实测全过
 *       （alphaBounds {16,16,96,96}、主径 96≥64、纵横比 1:1、SS6 px/mm 达标）。
 *   [2] stone.create.builtin 空库全链（缺省全量 53）：propose（预览 sku/sizeMm/
 *       贴图 blobRef——审批卡可见贴图；approval-request 帧；批准前库内零变更）→
 *       批准 → execute（53 条入档+reportRef 入 result_ref+supplier/finish/sizeMm/
 *       colorHex 投影真值）→ 预览/执行一致性（planned skus ≡ 入档 skus；
 *       同 rgb 跨档共享 blobRef——内容寻址去重）。
 *   [3] 幂等重跑全 skip=显式拒：全量已物化后再次发起 → 拒且零 proposal 落库、
 *       库内总数不变。
 *   [4] 筛选子集：ssLabels/colorNames 交集、零命中显式拒、格式非法 schema 拒、
 *       子集链路真实落库；部分物化后全量发起=增量 41+skip 12（查重面）。
 *   [5] 双模互斥与指引：执行模式带 propose 字段必拒；stone.create 工具描述含
 *       「勿重试——改走 stone.create.builtin」指引句（治走查实证的熔断循环）。
 *   [6] 知识库种子：空钻库行为指引组在册（先 builtin 物化再走管线）。
 * 测试纪律：零常驻进程（纯 registry 面，不起 listener）；装配照 capability-stones。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { rgbToHex, type RgbTuple } from '@handicraft/contracts';
import { ApprovalService } from '../src/capability/authorization.js';
import { BUILTIN_SUPPLIER, BUILTIN_SUPPLIER_PROFILE, createStoneCapabilities } from '../src/capability/stones.js';
import { BUILTIN_TEXTURE_SIZE, generateBuiltinTexturePng } from '../src/stones/builtin-texture.js';
import { gateStoneTexture } from '../src/stones/gates.js';
import { decodePng } from '../src/png/codec.js';
import { SS_CLOUD_CATALOG_SS } from '../src/stones/cloud-catalog.js';
import { KB_SEED } from '../src/kb/seed.js';
import { setSessionAutoApprove } from '../src/db/sessions.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createServices, type TestServices } from './helpers.js';
import { StoneService } from '../src/stones/service.js';

interface BuiltinFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStoneCapabilities>;
  sessionId: string;
  taskId: string;
  frames(): Array<Record<string, unknown>>;
  dispose(): void;
}

function setup(): BuiltinFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createStoneCapabilities({ db: s.db, blobs: s.blobs, jobs: s.jobs, approvals: auth });
  const { sessionId } = s.sessions.create(s.anonymous, { title: '内置标准钻测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  return {
    s,
    auth,
    registry,
    sessionId,
    taskId: task.id,
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
    dispose: () => s.dispose(),
  };
}

async function okOf(result: unknown): Promise<Record<string, unknown>> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: Record<string, unknown> }).value;
}

/** propose→批准→execute 全链（返回执行产物 value）。 */
async function runBuiltin(f: BuiltinFixture, proposeArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const proposed = await okOf(await f.registry.call('stone.create.builtin', { taskId: f.taskId, ...proposeArgs }, 'agent'));
  f.auth.answer(f.s.anonymous, {
    sessionId: f.sessionId,
    requestId: proposed['requestId'] as string,
    approved: true,
  });
  return okOf(
    await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'),
  );
}

function stoneCount(f: BuiltinFixture): number {
  return (f.s.db.prepare('SELECT COUNT(*) AS n FROM stone_index').get() as { n: number }).n;
}

function builtinSkus(f: BuiltinFixture): string[] {
  return (
    f.s.db.prepare('SELECT sku FROM stone_index WHERE supplier = ? ORDER BY sku').all(BUILTIN_SUPPLIER) as Array<{
      sku: string;
    }>
  ).map((row) => row.sku);
}

const active: BuiltinFixture[] = [];
function open(): BuiltinFixture {
  const f = setup();
  active.push(f);
  return f;
}
afterEach(() => {
  for (const f of active.splice(0)) f.dispose();
});

// ---------------------------------------------------------------- [1] 贴图生成器

describe('builtin-texture 生成器：确定性+gate 对账', () => {
  it('同 rgb 同字节、异 rgb 异字节（确定性——幂等复用基石）', () => {
    const a1 = generateBuiltinTexturePng([153, 102, 204]);
    const a2 = generateBuiltinTexturePng([153, 102, 204]);
    expect(Buffer.compare(Buffer.from(a1), Buffer.from(a2))).toBe(0);
    const b = generateBuiltinTexturePng([247, 247, 252]);
    expect(Buffer.compare(Buffer.from(a1), Buffer.from(b))).not.toBe(0);
  });

  it('解码对账 128×128；圆心 alpha=255、四角 alpha=0（圆外全透明）', () => {
    const bytes = generateBuiltinTexturePng([153, 102, 204]);
    const decoded = decodePng(bytes);
    expect(decoded.width).toBe(BUILTIN_TEXTURE_SIZE);
    expect(decoded.height).toBe(BUILTIN_TEXTURE_SIZE);
    const alphaAt = (x: number, y: number): number => decoded.rgba[(y * decoded.width + x) * 4 + 3]!;
    expect(alphaAt(64, 64)).toBe(255); // 圆心全实
    expect(alphaAt(0, 0)).toBe(0);
    expect(alphaAt(127, 0)).toBe(0);
    expect(alphaAt(0, 127)).toBe(0);
    expect(alphaAt(127, 127)).toBe(0);
  });

  it('六 gate 实测全过：alphaBounds {16,16,96,96}、主径 96≥64、纵横比 1:1、SS6 px/mm 达标', () => {
    const samples: RgbTuple[] = [
      [153, 102, 204],
      [26, 26, 26],
      [247, 247, 252],
    ];
    for (const rgb of samples) {
      const bytes = generateBuiltinTexturePng(rgb);
      const gate = gateStoneTexture({
        bytes,
        declaredWidth: BUILTIN_TEXTURE_SIZE,
        declaredHeight: BUILTIN_TEXTURE_SIZE,
        shapeClass: 'round',
        sizeMm: 2.0, // SS6
      });
      expect(gate.width).toBe(128);
      expect(gate.height).toBe(128);
      expect(gate.alphaBounds).toEqual({ x: 16, y: 16, w: 96, h: 96 });
      expect(gate.subjectMajorPx).toBe(96);
      expect(gate.subjectAspect).toBe(1);
      expect(gate.meetsRecommendedPxPerMm).toBe(true); // 96/2.0=48 ≥ 32
    }
  });
});

// ---------------------------------------------------------------- [2] 空库全链（缺省全量 53）

describe('stone.create.builtin 空库全链：53 条入档+预览/执行一致性', () => {
  it('propose：newCount=53、逐条 sku/sizeMm/贴图 blobRef（审批卡可见）；批准前库内零变更', async () => {
    const f = open();
    const proposed = await okOf(await f.registry.call('stone.create.builtin', { taskId: f.taskId }, 'agent'));
    expect(proposed['proposalId']).toMatch(/^[0-9a-f-]{36}$/);
    const preview = proposed['preview'] as {
      supplier: string;
      newCount: number;
      entries: Array<{ sku: string; label: string; colorName: string; rgb: number[]; sizeMm: number; textureBlobRef: string; texture: { width: number; height: number; alphaBounds: { w: number; h: number } } }>;
      skipped: unknown[];
      unavailable: unknown[];
    };
    expect(preview.supplier).toBe(BUILTIN_SUPPLIER);
    expect(preview.newCount).toBe(53);
    expect(preview.entries).toHaveLength(53);
    expect(preview.skipped).toEqual([]);
    expect(preview.unavailable).toEqual([]);
    // 首条=SS6-紫晶（云表序）：sku 派生档位+色名、sizeMm=SS_DIAMETER_TABLE、六 gate 实测。
    const first = preview.entries[0]!;
    expect(first).toMatchObject({ sku: 'SS6-紫晶', label: 'SS6', colorName: '紫晶', rgb: [153, 102, 204], sizeMm: 2.0 });
    expect(first.texture).toMatchObject({ width: 128, height: 128, alphaBounds: { w: 96, h: 96 } });
    // 预览期已落 blob：字节与生成器直出一致（审批卡可见贴图）。
    const blobBytes = f.s.blobs.read(first.textureBlobRef);
    expect(blobBytes).not.toBeNull();
    expect(Buffer.compare(Buffer.from(blobBytes!), Buffer.from(generateBuiltinTexturePng([153, 102, 204])))).toBe(0);
    // 同 rgb 跨档共享 blobRef（内容寻址去重——SS6-紫晶 ≡ SS10-紫晶）。
    const ss10Crystal = preview.entries.find((e) => e.sku === 'SS10-紫晶')!;
    expect(ss10Crystal.textureBlobRef).toBe(first.textureBlobRef);
    // approval-request 帧携带 tool/preview。
    const request = f.frames().find((frame) => frame['kind'] === 'approval-request') as Record<string, unknown>;
    const requestPayload = request['payload'] as Record<string, unknown>;
    expect(requestPayload).toMatchObject({ tool: 'stone.create.builtin', proposalId: proposed['proposalId'] });
    // 批准前库内零变更。
    expect(stoneCount(f)).toBe(0);
  });

  it('execute：53 条入档、投影真值（supplier/sizeMm/colorHex/family/finish）、reportRef 入 result_ref', async () => {
    const f = open();
    const proposed = await okOf(await f.registry.call('stone.create.builtin', { taskId: f.taskId }, 'agent'));
    const preview = (proposed['preview'] as { entries: Array<{ sku: string; sizeMm: number; rgb: number[]; textureBlobRef: string }> }).entries;
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const done = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'),
    );
    expect(done['created']).toBe(53);
    expect(done['skipped']).toEqual([]);
    expect(done['failed']).toEqual([]);
    expect((done['createdResourceIds'] as string[]).length).toBe(53);
    expect(f.s.blobs.read(done['reportRef'] as string)).not.toBeNull();
    // op 终态：succeeded + result_ref=reportRef（沿 stone.import 先例）。
    const op = f.s.db.prepare('SELECT state, result_ref, tool FROM approved_ops ORDER BY created_at DESC LIMIT 1').get() as {
      state: string;
      result_ref: string;
      tool: string;
    };
    expect(op).toMatchObject({ state: 'succeeded', result_ref: done['reportRef'], tool: 'stone.create.builtin' });
    // 库内 53 条，supplier 全为内置字面量。
    expect(stoneCount(f)).toBe(53);
    expect(
      (f.s.db.prepare('SELECT COUNT(*) AS n FROM stone_index WHERE supplier = ?').get(BUILTIN_SUPPLIER) as { n: number }).n,
    ).toBe(53);
    // 预览/执行一致性：planned skus ≡ 入档 skus（排序对比）。
    expect(builtinSkus(f)).toEqual([...preview.map((e) => e.sku)].sort());
    // 投影真值逐面抽查（首档首色+末档）：sizeMm/colorHex/family(=colorName)/finish。
    const crystal = f.s.db
      .prepare('SELECT size_mm, color_hex, family, style_name, finish FROM stone_index WHERE supplier = ? AND sku = ?')
      .get(BUILTIN_SUPPLIER, 'SS6-紫晶') as { size_mm: number; color_hex: string; family: string; style_name: string; finish: string };
    expect(crystal).toMatchObject({ size_mm: 2.0, color_hex: rgbToHex([153, 102, 204]), family: '紫晶', style_name: '紫晶', finish: '标准亮面' });
    const ss34 = f.s.db
      .prepare('SELECT size_mm FROM stone_index WHERE supplier = ? AND sku = ?')
      .get(BUILTIN_SUPPLIER, 'SS34-白钻（透明）') as { size_mm: number };
    expect(ss34.size_mm).toBe(7.1);
    // 贴图幂等复用：入档贴图 blobRef 与预览一致（同 rgb 同字节同 hash）。
    const ss34Preview = preview.find((e) => e.sku === 'SS34-白钻（透明）')!;
    const got = await okOf(
      await f.registry.call('stones.get', { taskId: f.taskId, resourceId: (done['createdResourceIds'] as string[])[0] }, 'agent'),
    );
    expect(got['texture']).toMatchObject({ blobRef: preview[0]!.textureBlobRef, width: 128, height: 128 });
    expect(ss34Preview.textureBlobRef).toBeDefined();
  });
});

// ---------------------------------------------------------------- [3] 幂等重跑全 skip=显式拒

describe('stone.create.builtin 会话自动批准：中央单点覆盖面实证（免值守）', () => {
  it('auto_approve=1 → propose 即时自动签发（autoApproved 帧+grant auto_approved=1），零人工 answer 直接 execute 消费', async () => {
    const f = open();
    // 2026-10-03 Owner 质询回归网：走查曾误诊「开关不覆盖钻库物化面」——本用例
    // 钉死 stone 族 proposal 与策略/纳钻/导出同走 ApprovalService.propose 中央
    // 自动批准分支（authorization.ts——不逐工具放行）。
    setSessionAutoApprove(f.s.db, f.sessionId, true);
    const proposed = await okOf(await f.registry.call('stone.create.builtin', { taskId: f.taskId, ssLabels: ['SS6'] }, 'agent'));
    expect(proposed['autoApproved']).toBe(true);
    expect(proposed['pending']).toContain('立即以 {taskId, proposalId} 调用执行（勿等待用户）');
    const resolved = f.frames().find((frame) => frame['kind'] === 'approval-resolved') as Record<string, unknown>;
    expect((resolved['payload'] as Record<string, unknown>)['autoApproved']).toBe(true);
    const grantRow = f.s.db
      .prepare('SELECT auto_approved FROM grants WHERE proposal_id = ?')
      .get(proposed['proposalId'] as string) as { auto_approved: number };
    expect(grantRow.auto_approved).toBe(1);
    // 零人工 answer：execute 直接消费自动 grant（agent 轮内即时签发即时消费）。
    const done = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'),
    );
    expect(done['created']).toBe(12); // SS6 档 12 色
    expect(stoneCount(f)).toBe(12);
  });
});

describe('stone.create.builtin 幂等重跑：全 skip 显式拒（不发起空 proposal）', () => {
  it('全量物化后再次发起 → 显式拒、零 proposal 落库、库内总数不变', async () => {
    const f = open();
    await runBuiltin(f, {});
    expect(stoneCount(f)).toBe(53);
    const rerun = await f.registry.call('stone.create.builtin', { taskId: f.taskId }, 'agent');
    expect(rerun).toMatchObject({ kind: 'failed' });
    expect((rerun as { message: string }).message).toContain('已全部物化');
    expect((rerun as { message: string }).message).toContain('不发起空 proposal');
    const ops = (
      f.s.db.prepare('SELECT COUNT(*) AS n FROM approved_ops WHERE tool = ?').get('stone.create.builtin') as { n: number }
    ).n;
    expect(ops).toBe(1); // 零新 proposal——人工批准不再被浪费
    expect(stoneCount(f)).toBe(53);
  });

  it('同 grant 重放必拒（执行后二次 execute → 已消费）且库内零新增', async () => {
    const f = open();
    const proposed = await okOf(await f.registry.call('stone.create.builtin', { taskId: f.taskId }, 'agent'));
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const proposalId = proposed['proposalId'] as string;
    await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId }, 'agent');
    const replay = await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId }, 'agent');
    expect(replay).toMatchObject({ kind: 'failed' });
    expect((replay as { message: string }).message).toContain('已消费');
    expect(stoneCount(f)).toBe(53); // 重放零新增
  });
});

// ---------------------------------------------------------------- [4] 筛选子集+查重

describe('stone.create.builtin 筛选子集与 supplier×sku 查重', () => {
  it('ssLabels/colorNames 交集筛选：SS6 档 12 条；档×色交集 2 条；子集链路真实落库', async () => {
    const f = open();
    const ss6Only = await okOf(await f.registry.call('stone.create.builtin', { taskId: f.taskId, ssLabels: ['SS6'] }, 'agent'));
    expect((ss6Only['preview'] as { newCount: number }).newCount).toBe(12);
    const both = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, ssLabels: ['SS6', 'SS10'], colorNames: ['紫晶'] }, 'agent'),
    );
    const entries = (both['preview'] as { entries: Array<{ sku: string }> }).entries;
    expect(entries.map((e) => e.sku)).toEqual(['SS6-紫晶', 'SS10-紫晶']);
    // 子集链路：批准→执行→库内 2 条。
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: both['requestId'] as string, approved: true });
    const done = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId: both['proposalId'] as string }, 'agent'),
    );
    expect(done['created']).toBe(2);
    expect(builtinSkus(f)).toEqual(['SS10-紫晶', 'SS6-紫晶']);
  });

  it('筛选零命中显式拒（列可用档位/色名）；档位格式非法 schema 拒', async () => {
    const f = open();
    const zeroHit = await f.registry.call('stone.create.builtin', { taskId: f.taskId, colorNames: ['不存在色'] }, 'agent');
    expect(zeroHit).toMatchObject({ kind: 'failed' });
    expect((zeroHit as { message: string }).message).toContain('筛选零命中');
    expect((zeroHit as { message: string }).message).toContain('SS6/SS10/SS16/SS20/SS34');
    const badFormat = await f.registry.call('stone.create.builtin', { taskId: f.taskId, ssLabels: ['ss6'] }, 'agent');
    expect(badFormat).toMatchObject({ kind: 'failed' });
    expect((badFormat as { message: string }).message).toContain('参数不合法');
  });

  it('部分物化后全量发起=增量批（12 已存在 skip+41 新建）——查重预览与执行收敛', async () => {
    const f = open();
    await runBuiltin(f, { ssLabels: ['SS6'] }); // 先物化 SS6 12 条
    expect(stoneCount(f)).toBe(12);
    const incremental = await okOf(await f.registry.call('stone.create.builtin', { taskId: f.taskId }, 'agent'));
    const preview = incremental['preview'] as { newCount: number; skipped: Array<{ sku: string; reason: string }> };
    expect(preview.newCount).toBe(41);
    expect(preview.skipped).toHaveLength(12);
    expect(preview.skipped.every((s) => s.reason.includes('supplier-sku-exists'))).toBe(true);
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: incremental['requestId'] as string, approved: true });
    const done = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId: incremental['proposalId'] as string }, 'agent'),
    );
    expect(done['created']).toBe(41);
    expect(done['skipped']).toEqual([]); // payload 只含批准的 41 新建——执行期 skip 面见下条
    expect(stoneCount(f)).toBe(53); // 收敛
    // 云表全量入档对拍：sku 集 ≡ SS_CLOUD_CATALOG_SS 派生集。
    const expected = SS_CLOUD_CATALOG_SS.map((e) => `${e.label}-${e.colorName}`).sort();
    expect(builtinSkus(f)).toEqual(expected);
  });

  it('执行期幂等重查：批准窗口内被并发物化的条目 skip 不重复建（supplier×sku 唯一兜底）', async () => {
    const f = open();
    const proposed = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, ssLabels: ['SS6'], colorNames: ['紫晶', '正红'] }, 'agent'),
    );
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    // 批准窗口内第三方把 SS6-紫晶 先物化（并发面——模拟 approve→execute 间隙的竞态）。
    new StoneService({ db: f.s.db, blobs: f.s.blobs }).createStone({
      ownerId: f.s.anonymous.id,
      supplierProfile: BUILTIN_SUPPLIER_PROFILE,
      draft: {
        name: '紫晶',
        sku: 'SS6-紫晶',
        sizeMm: 2.0,
        color: { name: '紫晶', rgb: [153, 102, 204], family: '紫晶', finish: '标准亮面' },
        texture: { declaredWidth: BUILTIN_TEXTURE_SIZE, declaredHeight: BUILTIN_TEXTURE_SIZE },
      },
      textureBytes: generateBuiltinTexturePng([153, 102, 204]),
    });
    const done = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'),
    );
    expect(done['created']).toBe(1); // 只建了 SS6-正红
    expect(done['skipped']).toEqual([{ sku: 'SS6-紫晶', reason: expect.stringContaining('supplier-sku-exists') }]);
    expect(done['failed']).toEqual([]);
    expect(stoneCount(f)).toBe(2);
  });
});

// ---------------------------------------------------------------- [5] 双模互斥+工具指引

describe('stone.create.builtin 双模互斥与 stone.create 指引句', () => {
  it('执行模式带 propose 字段必拒（互斥——真实 proposal 上验，precheck 放行后 handler 拒）', async () => {
    const f = open();
    const proposed = await okOf(
      await f.registry.call('stone.create.builtin', { taskId: f.taskId, ssLabels: ['SS6'], colorNames: ['紫晶'] }, 'agent'),
    );
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const mixed = await f.registry.call(
      'stone.create.builtin',
      { taskId: f.taskId, proposalId: proposed['proposalId'], ssLabels: ['SS10'] },
      'agent',
    );
    expect(mixed).toMatchObject({ kind: 'failed' });
    expect((mixed as { message: string }).message).toContain('互斥');
    expect(stoneCount(f)).toBe(0); // 未执行——库内零变更
  });

  it('stone.create 描述含「勿重试——改走 stone.create.builtin」指引句（治熔断循环）', () => {
    const f = open();
    try {
      const definition = f.registry.definitionOf('stone.create');
      expect(definition).not.toBeNull();
      expect(definition!.description).toContain('勿重试本工具');
      expect(definition!.description).toContain('stone.create.builtin');
      const builtin = f.registry.definitionOf('stone.create.builtin');
      expect(builtin).not.toBeNull();
      expect(builtin!.authority).toBe('approved-mutation');
      expect(builtin!.description).toContain(BUILTIN_SUPPLIER);
    } finally {
      f.dispose();
    }
  });
});

// ---------------------------------------------------------------- [6] 知识库种子

describe('知识库种子：空钻库行为指引（先 builtin 物化再走管线）', () => {
  it('KB_SEED 含「钻库工作流」组，条目点名 stone.create.builtin 与勿重试指引', () => {
    const group = KB_SEED.find((g) => g.name === '钻库工作流');
    expect(group).toBeDefined();
    const entry = group!.entries.find((e) => e.key.includes('空钻库'));
    expect(entry).toBeDefined();
    expect(entry!.value).toContain('stone.create.builtin');
    expect(entry!.value).toContain('不要用 stone.create 硬建钻');
    expect(entry!.value).toContain('入库必经用户批准卡');
  });
});
