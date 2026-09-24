/**
 * stones/stone.* MCP 工具面测试（add-stone-library design §6/§9——S4.1-S4.4；
 * W4.2 授权桥用例族改造复用）。覆盖：
 *   [1] 无授权直调写工具必拒（principal-forbidden / 双模参数面拒绝——库内零变更）。
 *   [2] create 全链：propose（六 gate 预检+新原子全量预览+approval-request 帧）→
 *       answer → execute（四步落库+op succeeded+result_ref）→ grant 重放必拒；
 *       批准前库内零变更。
 *   [3] update 全链：字段级 diff（baseRevision+前后值）→ 落库 revision 前进；
 *       revision 漂移必拒（STALE）。
 *   [4] delete 全链：目标原子+引用面预览 → 软删（投影 trashed=1、list 默认过滤、
 *       get soft-deleted 态、重复删幂等拒绝）。
 *   [5] import 全链：结构级预览（N 新原子/色系分组/低置信清单）→ 执行（reportRef 入
 *       result_ref）→ **幂等重跑收敛**（同 draft 第二轮全 skip、零新建、总数不变）；
 *       批准前库内零变更。
 *   [6] readonly 面：list 过滤/分页/groupBy/nearColor 排序；search 组合条件；
 *       substitutes 确定性排序（ΔE 升序 tie 用 supplier×sku 稳定序+容差过滤）；
 *       get 引用四态标注。
 *   [7] 跨用户：B 的任务读不到 A 的原子（owner 绑定实证）；跨用户 get 必拒。
 *   [8] MCP 投影冒烟（S4.4）：compose 后 18 工具、八工具名称投影、schema-faithful
 *       直传（tools/list inputSchema）、readonly 真调一条（tools/call stones_list）。
 * 测试纪律：S2 导入器经 CardImportRunner 注入缝替身（表面行为验证归 S4；导入器
 * 本体链路归 stones-import.test.ts）——零常驻进程（listener 显式 stop）。
 */
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CardCatalogDraftSchema,
  SupplierSkuProfileSchema,
  type CardCatalogDraft,
  type RgbTuple,
  type SupplierSkuProfile,
} from '@handicraft/contracts';
import { encodePng } from '../src/png/codec.js';
import { ApprovalService } from '../src/capability/authorization.js';
import { composeRegistries, createStoneCapabilities, type CardImportRunner } from '../src/capability/stones.js';
import { createStudioCapabilities, type GenerateExecutor } from '../src/capability/studio.js';
import { mcpToolName, createStudioMcpServer } from '../src/capability/mcp.js';
import { StoneService } from '../src/stones/service.js';
import { createAgentTask } from '../src/db/jobs.js';
import { createUser } from '../src/db/store.js';
import { McpListener, buildProcessToken } from '../src/mcp.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createServices, type TestServices } from './helpers.js';

// ---------------------------------------------------------------- fixtures

/** 钰航档案（三行段实证——行段漂移 J51→2 / J76→12）。 */
const YUHANG: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [
    { rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
    { rows: [76, 78], sizeMmByPrefix: { J: 12, A: 14, B: 16, C: 18, E: 20, F: 22, G: 25 } },
    { rows: [80, 89], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
  ],
  styleKey: 'row',
});

const FACTORY_B: SupplierSkuProfile = SupplierSkuProfileSchema.parse({
  supplier: 'factoryB',
  displayName: '乙厂',
  bands: [{ rows: [1, 99], sizeMmByPrefix: { J: 2, A: 3 } }],
  styleKey: 'row',
});

/** 128×128 画布 96px 圆主体（alphaBounds {16,16,96,96}——gates 实测可过）。 */
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

interface StoneFixture {
  s: TestServices;
  auth: ApprovalService;
  registry: ReturnType<typeof createStoneCapabilities>;
  sessionId: string;
  taskId: string;
  textureRef: string;
  frames(): Array<Record<string, unknown>>;
  dispose(): void;
}

function setup(runner?: CardImportRunner): StoneFixture {
  const s = createServices(undefined, { imgDryRun: true });
  const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
  const registry = createStoneCapabilities({
    db: s.db,
    blobs: s.blobs,
    jobs: s.jobs,
    approvals: auth,
    ...(runner !== undefined ? { cardImportRunner: runner } : {}),
  });
  const { sessionId } = s.sessions.create(s.anonymous, { title: 'stones 工具面测试' });
  const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
  const textureRef = s.blobs.put(textureBytes()).hash;
  return {
    s,
    auth,
    registry,
    sessionId,
    taskId: task.id,
    textureRef,
    frames: () => s.jobs.frames(s.anonymous, task.id, 0).frames,
    dispose: () => s.dispose(),
  };
}

async function okOf(result: unknown): Promise<Record<string, unknown>> {
  expect(result).toMatchObject({ kind: 'ok' });
  return (result as { value: Record<string, unknown> }).value;
}

interface DraftOverrides {
  sku?: string;
  name?: string;
  colorName?: string;
  rgb?: RgbTuple;
  family?: string;
  sizeMm?: number | null;
  supplierProfile?: SupplierSkuProfile;
}

function createProposeArgs(f: StoneFixture, overrides: DraftOverrides = {}): Record<string, unknown> {
  const colorName = overrides.colorName ?? '象牙白';
  return {
    taskId: f.taskId,
    supplierProfile: overrides.supplierProfile ?? YUHANG,
    draft: {
      name: overrides.name ?? `${colorName} · ${overrides.sizeMm ?? 2}mm`,
      sku: overrides.sku ?? 'J51',
      sizeMm: overrides.sizeMm === undefined ? 2 : overrides.sizeMm,
      color: {
        name: colorName,
        rgb: overrides.rgb ?? [240, 240, 232],
        family: overrides.family ?? '白色系',
        finish: 'glossy',
      },
    },
    texture: { blobRef: f.textureRef, declaredWidth: 128, declaredHeight: 128 },
  };
}

/** 经工具全链建一颗原子（propose→approve→execute）——返回执行产物。 */
async function createStoneViaTool(f: StoneFixture, overrides: DraftOverrides = {}): Promise<Record<string, unknown>> {
  const proposed = await okOf(await f.registry.call('stone.create', createProposeArgs(f, overrides), 'agent'));
  f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
  return okOf(await f.registry.call('stone.create', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
}

function stoneCount(f: StoneFixture): number {
  return (f.s.db.prepare('SELECT COUNT(*) AS n FROM stone_index').get() as { n: number }).n;
}

/** 样卡草表（三行：51 象牙白双格 / 52 珍珠白 / 53 低置信红——低置信清单断言面）。 */
function sampleDraft(): CardCatalogDraft {
  return CardCatalogDraftSchema.parse({
    schemaVersion: 1,
    supplier: 'yuhang',
    sourceImage: {
      blobRef: 'a'.repeat(64),
      pages: [{ page: 1, widthPx: 512, heightPx: 512 }],
    },
    bands: YUHANG.bands,
    styles: [
      {
        row: 51,
        suggestedName: '象牙白',
        suggestedFamily: '白色系',
        rgb: [240, 240, 232],
        confidence: 0.95,
        cells: [
          { sku: 'J51', page: 1, bboxPx: { x: 0, y: 0, w: 96, h: 96 } },
          { sku: 'A51', page: 1, bboxPx: { x: 96, y: 0, w: 96, h: 96 } },
        ],
      },
      {
        row: 52,
        suggestedName: '珍珠白',
        suggestedFamily: '白色系',
        rgb: [250, 247, 240],
        confidence: 0.9,
        cells: [{ sku: 'J52', page: 1, bboxPx: { x: 0, y: 96, w: 96, h: 96 } }],
      },
      {
        row: 53,
        suggestedName: '',
        suggestedFamily: '红色系',
        rgb: [200, 16, 46],
        confidence: 0.5,
        cells: [{ sku: 'J53', page: 1, bboxPx: { x: 96, y: 96, w: 96, h: 96 } }],
      },
    ],
  });
}

/**
 * S2 导入器替身（CardImportRunner 冻结签名）：幂等语义=supplier×sku 已存在全
 * skip；新建经 StoneService.createStone（真值链路）；报告=结果 JSON blob。
 */
function stubImportRunner(): CardImportRunner {
  return (deps, draft, options) => {
    const created: string[] = [];
    const skipped: Array<{ sku: string; reason: string }> = [];
    const failed: Array<{ sku: string; reason: string }> = [];
    const lowConfidence: Array<{ sku: string; row: number }> = [];
    for (const style of draft.styles) {
      for (const cell of style.cells) {
        try {
          const exists = deps.db.prepare('SELECT 1 AS hit FROM stone_index WHERE supplier = ? AND sku = ?').get(options.targetSupplier, cell.sku);
          if (exists !== undefined) {
            skipped.push({ sku: cell.sku, reason: 'supplier-sku-exists：幂等跳过' });
            continue;
          }
          const appliedName = style.suggestedName.length > 0 ? style.suggestedName : `待命名-${style.row}`;
          const result = deps.service.createStone({
            ownerId: options.ownerId,
            supplierProfile: {
              supplier: options.targetSupplier,
              displayName: draft.supplier,
              bands: draft.bands,
              styleKey: 'row',
            },
            draft: {
              name: `${appliedName} · ${cell.sku}`,
              sku: cell.sku,
              sizeMm: null,
              color: {
                name: appliedName,
                rgb: style.rgb,
                family: style.suggestedFamily || '未分组',
                finish: 'unspecified',
              },
              texture: { declaredWidth: 128, declaredHeight: 128 },
            },
            textureBytes: textureBytes(),
          });
          created.push(result.resourceId);
          if (style.confidence < 0.7 || style.suggestedName.length === 0) {
            lowConfidence.push({ sku: cell.sku, row: style.row });
          }
        } catch (error) {
          failed.push({ sku: cell.sku, reason: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    const reportRef = deps.blobs
      .put(new Uint8Array(Buffer.from(JSON.stringify({ created, skipped, failed, lowConfidence }), 'utf8')))
      .hash;
    return { created, skipped, failed, pendingDowngrades: [], lowConfidence, reportRef };
  };
}

const active: StoneFixture[] = [];
function open(runner?: CardImportRunner): StoneFixture {
  const f = setup(runner);
  active.push(f);
  return f;
}
afterEach(() => {
  for (const f of active.splice(0)) f.dispose();
});

// ---------------------------------------------------------------- [1] 无授权直调必拒

describe('S4.2 无授权直调写工具必拒（库内零变更）', () => {
  it('四写工具带不存在 proposalId 执行 → principal-forbidden；零字段裸调 → 参数面拒绝；库内零变更', async () => {
    const f = open();
    const tools = ['stone.create', 'stone.update', 'stone.delete', 'stone.import'];
    for (const tool of tools) {
      const deniedResult = await f.registry.call(tool, { taskId: f.taskId, proposalId: randomUUID() }, 'agent');
      expect(deniedResult).toMatchObject({ kind: 'denied', reason: 'principal-forbidden', requestedOperation: tool });
    }
    for (const tool of tools) {
      const bare = await f.registry.call(tool, { taskId: f.taskId }, 'agent');
      expect(bare).toMatchObject({ kind: 'failed' });
    }
    expect(stoneCount(f)).toBe(0);
  });

  it('human-ui 主体执行无 grant 同样必拒（consume 面——不是只挡 agent 预检）', async () => {
    const f = open();
    const result = await f.registry.call('stone.create', { taskId: f.taskId, proposalId: randomUUID() }, 'human-ui');
    expect(result).toMatchObject({ kind: 'failed' });
    expect(stoneCount(f)).toBe(0);
  });
});

// ---------------------------------------------------------------- [2] create 全链

describe('S4.2 create 全链：propose→批准→执行→库内变更', () => {
  it('propose 产出六 gate 实测预览+approval-request 帧；批准前库内零变更', async () => {
    const f = open();
    const proposed = await okOf(await f.registry.call('stone.create', createProposeArgs(f), 'agent'));
    expect(proposed['proposalId']).toMatch(/^[0-9a-f-]{36}$/);
    const preview = proposed['preview'] as { newAtom: Record<string, unknown>; previewBlobs: { before: string; after: string } };
    // 六 gate 实测真值入库预览（128×128 实测 + alphaBounds）。
    expect(preview.newAtom['texture']).toMatchObject({ width: 128, height: 128, alphaBounds: { x: 16, y: 16, w: 96, h: 96 } });
    expect(preview.newAtom['skuParsed']).toMatchObject({ row: 51, prefix: 'J', sizeMm: 2 });
    expect(f.s.blobs.read(preview.previewBlobs.after)).not.toBeNull();
    // 帧：approval-request 携带 tool/preview/summary（payload 嵌套——帧协议形状）。
    const request = f.frames().find((frame) => frame['kind'] === 'approval-request') as Record<string, unknown>;
    const requestPayload = request['payload'] as Record<string, unknown>;
    expect(requestPayload).toMatchObject({ tool: 'stone.create', proposalId: proposed['proposalId'] });
    expect(requestPayload['preview']).toMatchObject({ before: preview.previewBlobs.before, after: preview.previewBlobs.after });
    // 批准前库内零变更。
    expect(stoneCount(f)).toBe(0);
  });

  it('answer 批准 → execute 四步落库 → 投影/详情/op 终态全链', async () => {
    const f = open();
    const created = await createStoneViaTool(f);
    const resourceId = created['resourceId'] as string;
    expect(created['revision']).toBe(1);
    expect(created['path']).toBe('/stones/standards/yuhang/白色系/51-象牙白/J51');
    expect(stoneCount(f)).toBe(1);
    // op 终态：succeeded + result_ref=resourceId。
    const op = f.s.db.prepare('SELECT state, result_ref FROM approved_ops ORDER BY created_at DESC LIMIT 1').get() as { state: string; result_ref: string };
    expect(op).toMatchObject({ state: 'succeeded', result_ref: resourceId });
    // readonly 面立即可见。
    const list = await okOf(await f.registry.call('stones.list', { taskId: f.taskId }, 'agent'));
    const cells = list['cells'] as Array<Record<string, unknown>>;
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ sku: 'J51', supplier: 'yuhang', family: '白色系', sizeMm: 2, textureUrl: `/api/stones/${resourceId}/texture.png` });
  });

  it('同 grant 重放必拒（执行后二次 execute → grant-consumed）', async () => {
    const f = open();
    const proposed = await okOf(await f.registry.call('stone.create', createProposeArgs(f), 'agent'));
    const proposalId = proposed['proposalId'] as string;
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    await f.registry.call('stone.create', { taskId: f.taskId, proposalId }, 'agent');
    const replay = await f.registry.call('stone.create', { taskId: f.taskId, proposalId }, 'agent');
    expect(replay).toMatchObject({ kind: 'failed' });
    expect((replay as { message: string }).message).toContain('已消费');
    expect(stoneCount(f)).toBe(1); // 重放零新增
  });

  it('拒绝路径：answer(false) → op failed → execute 必拒；坏贴图 gate 预检拒绝不发起', async () => {
    const f = open();
    // gate 1：声明宽高与解码实测不符 → propose 即拒（六 gate 预检面）。
    const bad = await f.registry.call(
      'stone.create',
      { ...createProposeArgs(f), texture: { blobRef: f.textureRef, declaredWidth: 64, declaredHeight: 64 } },
      'agent',
    );
    expect(bad).toMatchObject({ kind: 'failed' });
    expect((bad as { message: string }).message).toContain('不符');
    const proposed = await okOf(await f.registry.call('stone.create', createProposeArgs(f), 'agent'));
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: false });
    const rejected = await f.registry.call('stone.create', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent');
    expect(rejected).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
    expect(stoneCount(f)).toBe(0);
  });
});

// ---------------------------------------------------------------- [3] update 全链

describe('S4.2 update 全链：字段 diff → revision CAS', () => {
  it('diff 预览=baseRevision+前后值 → 执行 revision 前进+投影跟随（色系重指）', async () => {
    const f = open();
    const created = await createStoneViaTool(f);
    const resourceId = created['resourceId'] as string;
    const proposed = await okOf(
      await f.registry.call(
        'stone.update',
        { taskId: f.taskId, resourceId, patch: { name: '象牙白改', color: { family: '暖白色系' } } },
        'agent',
      ),
    );
    const diff = proposed['diff'] as { baseRevision: number; fields: Array<{ field: string; before: unknown; after: unknown }> };
    expect(diff.baseRevision).toBe(1);
    const fields = Object.fromEntries(diff.fields.map((d) => [d.field, d]));
    expect(fields['name']).toMatchObject({ before: '象牙白 · 2mm', after: '象牙白改' });
    expect(fields['color.family']).toMatchObject({ before: '白色系', after: '暖白色系' });
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const updated = await okOf(await f.registry.call('stone.update', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
    expect(updated['revision']).toBe(2);
    expect(updated['path']).toContain('暖白色系');
    const row = f.s.db.prepare('SELECT family FROM stone_index WHERE resource_id = ?').get(resourceId) as { family: string };
    expect(row.family).toBe('暖白色系');
  });

  it('revision 漂移必拒：批准后 base 与当前不符 → STALE，库内不覆盖', async () => {
    const f = open();
    const created = await createStoneViaTool(f);
    const resourceId = created['resourceId'] as string;
    const proposed = await okOf(
      await f.registry.call('stone.update', { taskId: f.taskId, resourceId, patch: { name: '过时提案' } }, 'agent'),
    );
    // 批准窗口内第三方直改真值（revision 1→2——漂移源）。
    new StoneService({ db: f.s.db, blobs: f.s.blobs }).updateStone(resourceId, { name: '第三方已改' }, { baseRevision: 1 });
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const stale = await f.registry.call('stone.update', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent');
    expect(stale).toMatchObject({ kind: 'failed', code: 'STALE' });
    expect((stale as { message: string }).message).toContain('漂移');
    const detail = await okOf(await f.registry.call('stones.get', { taskId: f.taskId, resourceId }, 'agent'));
    expect((detail['stone'] as { name: string }).name).toBe('第三方已改'); // 过时提案未覆盖
  });

  it('空 patch（无字段变化）→ 拒绝发起空 proposal', async () => {
    const f = open();
    const created = await createStoneViaTool(f);
    const empty = await f.registry.call('stone.update', { taskId: f.taskId, resourceId: created['resourceId'] as string, patch: {} }, 'agent');
    expect(empty).toMatchObject({ kind: 'failed' });
  });
});

// ---------------------------------------------------------------- [4] delete 全链

describe('S4.2 delete 全链：软删+引用面预览', () => {
  it('预览含目标原子+引用面（空集显式）→ 执行软删 → 投影 trashed/list 过滤/get 四态', async () => {
    const f = open();
    const created = await createStoneViaTool(f);
    const resourceId = created['resourceId'] as string;
    const proposed = await okOf(await f.registry.call('stone.delete', { taskId: f.taskId, resourceId }, 'agent'));
    expect(proposed['target']).toMatchObject({ resourceId, supplier: 'yuhang', sku: 'J51' });
    expect(proposed['references']).toEqual([]);
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const deleted = await okOf(await f.registry.call('stone.delete', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
    expect(deleted['trashedStones']).toBe(1);
    const row = f.s.db.prepare('SELECT trashed FROM stone_index WHERE resource_id = ?').get(resourceId) as { trashed: number };
    expect(row.trashed).toBe(1);
    const listed = await okOf(await f.registry.call('stones.list', { taskId: f.taskId }, 'agent'));
    expect(listed['total']).toBe(0);
    const trashedList = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, includeTrashed: true }, 'agent'));
    expect(trashedList['total']).toBe(1);
    const got = await okOf(await f.registry.call('stones.get', { taskId: f.taskId, resourceId }, 'agent'));
    expect(got['state']).toBe('soft-deleted'); // 四态标注
    // 回收站内重复删=幂等拒绝。
    const again = await f.registry.call('stone.delete', { taskId: f.taskId, resourceId }, 'agent');
    expect(again).toMatchObject({ kind: 'failed' });
  });
});

// ---------------------------------------------------------------- [5] import 全链+幂等

describe('S4.3 import 全链：单 proposal 整批+幂等重跑收敛', () => {
  it('预览=N 新原子/色系分组/低置信清单；批准前库内零变更；执行报告入 result_ref', async () => {
    const f = open(stubImportRunner());
    const draftRef = f.s.blobs.put(new Uint8Array(Buffer.from(JSON.stringify(sampleDraft()), 'utf8'))).hash;
    const proposed = await okOf(await f.registry.call('stone.import', { taskId: f.taskId, draftRef }, 'agent'));
    const preview = proposed['preview'] as Record<string, unknown>;
    expect(preview['newCount']).toBe(4);
    expect(preview['newSkus']).toEqual(['J51', 'A51', 'J52', 'J53']);
    expect(preview['families']).toEqual(['白色系', '红色系']);
    const low = preview['lowConfidence'] as Array<{ row: number }>;
    expect(low).toEqual([{ row: 53, suggestedName: '', confidence: 0.5 }]);
    expect(stoneCount(f)).toBe(0); // 批准前库内零变更
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: proposed['requestId'] as string, approved: true });
    const done = await okOf(await f.registry.call('stone.import', { taskId: f.taskId, proposalId: proposed['proposalId'] as string }, 'agent'));
    expect(done['created']).toBe(4);
    const reportRef = done['reportRef'] as string;
    expect(f.s.blobs.read(reportRef)).not.toBeNull();
    const op = f.s.db.prepare('SELECT state, result_ref FROM approved_ops ORDER BY created_at DESC LIMIT 1').get() as { state: string; result_ref: string };
    expect(op).toMatchObject({ state: 'succeeded', result_ref: reportRef });
    expect(stoneCount(f)).toBe(4);
  });

  it('幂等重跑收敛：同 draft 第二轮 proposal 预览全 skip → 执行零新建、总数不变', async () => {
    const f = open(stubImportRunner());
    const draftRef = f.s.blobs.put(new Uint8Array(Buffer.from(JSON.stringify(sampleDraft()), 'utf8'))).hash;
    // 第一轮。
    const first = await okOf(await f.registry.call('stone.import', { taskId: f.taskId, draftRef }, 'agent'));
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: first['requestId'] as string, approved: true });
    await f.registry.call('stone.import', { taskId: f.taskId, proposalId: first['proposalId'] as string }, 'agent');
    expect(stoneCount(f)).toBe(4);
    // 第二轮（同 draft 重放——新 proposal）。
    const second = await okOf(await f.registry.call('stone.import', { taskId: f.taskId, draftRef }, 'agent'));
    const preview = second['preview'] as Record<string, unknown>;
    expect(preview['newCount']).toBe(0);
    expect(preview['skipped']).toHaveLength(4);
    f.auth.answer(f.s.anonymous, { sessionId: f.sessionId, requestId: second['requestId'] as string, approved: true });
    const rerun = await okOf(await f.registry.call('stone.import', { taskId: f.taskId, proposalId: second['proposalId'] as string }, 'agent'));
    expect(rerun['created']).toBe(0);
    expect(stoneCount(f)).toBe(4); // 收敛：零新建
  });
});

// ---------------------------------------------------------------- [6] readonly 查询面

describe('S4.1 readonly 面：list/search/get/substitutes', () => {
  async function seeded(): Promise<StoneFixture> {
    const f = open();
    await createStoneViaTool(f, { sku: 'J51', colorName: '象牙白', rgb: [240, 240, 232], family: '白色系' });
    await createStoneViaTool(f, { sku: 'A51', colorName: '象牙白', rgb: [240, 240, 232], family: '白色系', sizeMm: 3 });
    await createStoneViaTool(f, { sku: 'B51', colorName: '象牙白', rgb: [240, 240, 232], family: '白色系', sizeMm: 4 });
    await createStoneViaTool(f, { sku: 'J52', colorName: '珍珠白', rgb: [250, 247, 240], family: '白色系' });
    await createStoneViaTool(f, { sku: 'J60', colorName: '正红', rgb: [200, 16, 46], family: '红色系' });
    return f;
  }

  it('list：filter（family/sizeMm/styleRow/sku/supplier）+ 分页 + groupBy', async () => {
    const f = await seeded();
    const family = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, family: '白色系' }, 'agent'));
    expect(family['total']).toBe(4);
    const size = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, sizeMm: 2 }, 'agent'));
    expect(size['total']).toBe(3); // J51 + J52 + J60（J60 默认 2mm——seed fixture 事实）
    const style = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, styleRow: 51 }, 'agent'));
    expect(style['total']).toBe(3);
    const sku = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, sku: 'J60' }, 'agent'));
    expect((sku['cells'] as Array<{ sku: string }>)[0]).toMatchObject({ sku: 'J60' });
    const foreign = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, supplier: 'factoryB' }, 'agent'));
    expect(foreign['total']).toBe(0);
    // 分页。
    const paged = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, page: 2, pageSize: 2 }, 'agent'));
    expect(paged['total']).toBe(5);
    expect(paged['page']).toBe(2);
    expect(paged['cells']).toHaveLength(2);
    // groupBy：family / sizeMm。
    const byFamily = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, groupBy: 'family' }, 'agent'));
    expect(byFamily['groupKeys']).toEqual(['白色系', '红色系']);
    const bySize = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, groupBy: 'sizeMm' }, 'agent'));
    expect(bySize['groupKeys']).toEqual(['2', '3', '4']);
  });

  it('list nearColor：ΔE 升序（象牙白目标→同色三颗在前、正红殿后）', async () => {
    const f = await seeded();
    const listed = await okOf(await f.registry.call('stones.list', { taskId: f.taskId, nearColor: [240, 240, 232] }, 'agent'));
    const hexes = (listed['cells'] as Array<{ colorHex: string }>).map((c) => c.colorHex);
    expect(hexes[0]).toBe('#F0F0E8'); // ΔE=0（同色组——sku 稳定序 A51/B51/J51）
    expect(hexes[3]).toBe('#FAF7F0'); // 珍珠白（近色）
    expect(hexes[4]).toBe('#C8102E'); // 正红（最远）
    const firstThree = (listed['cells'] as Array<{ sku: string }>).slice(0, 3).map((c) => c.sku);
    expect(firstThree).toEqual(['A51', 'B51', 'J51']); // ΔE 平局 → sku 升序
  });

  it('search：关键字 + 尺寸邻近 + 组合；无条件显式拒绝', async () => {
    const f = await seeded();
    const byQ = await okOf(await f.registry.call('stones.search', { taskId: f.taskId, q: 'j5' }, 'agent'));
    expect(byQ['total']).toBe(2); // J51/J52（大小写不敏感）
    const bySize = await okOf(await f.registry.call('stones.search', { taskId: f.taskId, sizeMm: 2, sizeToleranceMm: 0 }, 'agent'));
    expect(bySize['total']).toBe(3); // J51/J52/J60 同径 2mm
    const combined = await okOf(
      await f.registry.call('stones.search', { taskId: f.taskId, q: 'J', sizeMm: 2, sizeToleranceMm: 1 }, 'agent'),
    );
    expect((combined['cells'] as Array<{ sku: string }>).map((c) => c.sku)).toEqual(['J51', 'J52', 'J60']);
    const none = await f.registry.call('stones.search', { taskId: f.taskId }, 'agent');
    expect(none).toMatchObject({ kind: 'failed' });
  });

  it('substitutes：ΔE 升序+尺寸容差过滤+平局 sku 稳定序+基准排除；maxDeltaE/sizeToleranceMm 可参', async () => {
    const f = await seeded();
    // by sku：J51（象牙白 2mm）基准；tolerance 2.5 → A51/B51/J52 候选。
    const subs = await okOf(
      await f.registry.call(
        'stones.substitutes',
        { taskId: f.taskId, query: { sku: 'J51', sizeToleranceMm: 2.5 } },
        'agent',
      ),
    );
    const results = subs['results'] as Array<{ sku: string; deltaE: number; sizeDiffMm: number }>;
    expect(results.map((r) => r.sku)).toEqual(['A51', 'B51', 'J52']); // ΔE 0 平局→sku；珍珠白 ΔE>0 殿后
    expect(results[0]).toMatchObject({ deltaE: 0, sizeDiffMm: 1 });
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.deltaE).toBeGreaterThanOrEqual(results[i - 1]!.deltaE); // ΔE 升序
    }
    expect(results.some((r) => r.sku === 'J51')).toBe(false); // 基准自身排除
    // 紧 maxDeltaE=1：珍珠白被滤。
    const tight = await okOf(
      await f.registry.call('stones.substitutes', { taskId: f.taskId, query: { sku: 'J51', maxDeltaE: 1, sizeToleranceMm: 2.5 } }, 'agent'),
    );
    expect((tight['results'] as Array<{ sku: string }>).map((r) => r.sku)).toEqual(['A51', 'B51']);
    // by colorRgb+sizeMm（默认容差 0.5）：同径象牙白/珍珠白命中、异径同色被尺寸滤。
    const byColor = await okOf(
      await f.registry.call('stones.substitutes', { taskId: f.taskId, query: { colorRgb: [240, 240, 232], sizeMm: 2 } }, 'agent'),
    );
    expect((byColor['results'] as Array<{ sku: string }>).map((r) => r.sku)).toEqual(['J51', 'J52']);
    // 缺基准 SKU：显式失败。
    const missing = await f.registry.call('stones.substitutes', { taskId: f.taskId, query: { sku: 'Z99' } }, 'agent');
    expect(missing).toMatchObject({ kind: 'failed' });
  });

  it('get 引用四态标注：resolved / soft-deleted / blob-missing / wrong-kind', async () => {
    const f = open();
    const created = await createStoneViaTool(f);
    const resourceId = created['resourceId'] as string;
    const resolved = await okOf(await f.registry.call('stones.get', { taskId: f.taskId, resourceId }, 'agent'));
    expect(resolved['state']).toBe('resolved');
    expect(resolved['stone']).toMatchObject({ kind: 'stone', sku: 'J51' });
    expect(resolved['texture']).toMatchObject({ textureUrl: `/api/stones/${resourceId}/texture.png` });
    // blob-missing：stone.json 内容 hash 指向不可读 blob。
    const jsonRow = f.s.db
      .prepare('SELECT id, content_hash FROM resources WHERE parent_id = ? AND name = ? AND is_dir = 0')
      .get(resourceId, 'stone.json') as { id: string; content_hash: string };
    f.s.db.prepare('UPDATE resources SET content_hash = ? WHERE id = ?').run('f'.repeat(64), jsonRow.id);
    const blobMissing = await okOf(await f.registry.call('stones.get', { taskId: f.taskId, resourceId }, 'agent'));
    expect(blobMissing['state']).toBe('blob-missing');
    // wrong-kind：系统根目录（非钻原子目录）。
    const rootId = (f.s.db.prepare("SELECT id FROM resources WHERE meta LIKE '%\"role\":\"stones-root\"%'").get() as { id: string }).id;
    const wrongKind = await okOf(await f.registry.call('stones.get', { taskId: f.taskId, resourceId: rootId }, 'agent'));
    expect(wrongKind['state']).toBe('wrong-kind');
    // soft-deleted：恢复内容 hash 后软删（回收站详情态）。
    f.s.db.prepare('UPDATE resources SET content_hash = ? WHERE id = ?').run(jsonRow.content_hash, jsonRow.id);
    new StoneService({ db: f.s.db, blobs: f.s.blobs }).softDelete(resourceId);
    const softDeleted = await okOf(await f.registry.call('stones.get', { taskId: f.taskId, resourceId }, 'agent'));
    expect(softDeleted['state']).toBe('soft-deleted');
  });
});

// ---------------------------------------------------------------- [7] 跨用户隔离

describe('S4 owner 绑定：跨用户读写必拒（P1-1 实证）', () => {
  it('B 任务读不到 A 的原子（list/get/substitutes）；B 自建互不可见', async () => {
    const f = open();
    const created = await createStoneViaTool(f);
    const resourceId = created['resourceId'] as string;
    // 用户 B 的会话+任务。
    const userB = createUser(f.s.db, { username: 'stone-b', passwordHash: 'x', role: 'user' });
    const { sessionId: sessionB } = f.s.sessions.create(userB, { title: 'B 会话' });
    const taskB = createAgentTask(f.s.db, { ownerId: userB.id, sessionId: sessionB, status: 'running' });
    const bList = await okOf(await f.registry.call('stones.list', { taskId: taskB.id }, 'agent'));
    expect(bList['total']).toBe(0); // A 的原子对 B 不可见
    const bGet = await f.registry.call('stones.get', { taskId: taskB.id, resourceId }, 'agent');
    expect(bGet).toMatchObject({ kind: 'failed' });
    expect((bGet as { message: string }).message).toContain('跨用户');
    // owner 过滤：B 库内无该基准（显式未找到，不回退到 A 的原子）。
    const bSubs = await f.registry.call('stones.substitutes', { taskId: taskB.id, query: { sku: 'J51' } }, 'agent');
    expect(bSubs).toMatchObject({ kind: 'failed' });
    expect((bSubs as { message: string }).message).toContain('未找到');
    const bPropose = await f.registry.call(
      'stone.create',
      {
        taskId: taskB.id,
        supplierProfile: FACTORY_B,
        draft: {
          name: '乙厂白 · 2mm',
          sku: 'J1',
          sizeMm: 2,
          color: { name: '乙厂白', rgb: [240, 240, 232], family: '白色系', finish: 'glossy' },
        },
        texture: { blobRef: f.textureRef, declaredWidth: 128, declaredHeight: 128 },
      },
      'agent',
    );
    expect(bPropose).toMatchObject({ kind: 'ok' }); // B 自建走自己的任务
    const bProposed = await okOf(bPropose);
    f.auth.answer(userB, { sessionId: sessionB, requestId: bProposed['requestId'] as string, approved: true });
    await f.registry.call('stone.create', { taskId: taskB.id, proposalId: bProposed['proposalId'] as string }, 'agent');
    const bListAfter = await okOf(await f.registry.call('stones.list', { taskId: taskB.id }, 'agent'));
    expect(bListAfter['total']).toBe(1);
    const aList = await okOf(await f.registry.call('stones.list', { taskId: f.taskId }, 'agent'));
    expect(aList['total']).toBe(1); // A 仍只见自己的
  });
});

// ---------------------------------------------------------------- [8] MCP 投影冒烟

describe('S4.4 MCP 投影冒烟：八工具名称投影+schema-faithful+readonly 真调', () => {
  const okExecutor: GenerateExecutor = async () => new Uint8Array([1, 2, 3, 4]);

  function composedFixture(): { capabilities: ReturnType<typeof composeRegistries>; s: TestServices } {
    const s = createServices(undefined, { imgDryRun: true });
    const auth = new ApprovalService({ db: s.db, jobs: s.jobs });
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
    ]);
    return { capabilities, s };
  }

  it('registry 面：compose 后 18 工具（studio 10 + stone 8）、重名防线、mcpToolName 投影', () => {
    const { capabilities, s } = composedFixture();
    try {
      const names = [...capabilities.names()].sort();
      expect(names).toHaveLength(18);
      for (const name of ['stones.list', 'stones.search', 'stones.get', 'stones.substitutes', 'stone.create', 'stone.update', 'stone.delete', 'stone.import']) {
        expect(names).toContain(name);
      }
      expect(mcpToolName('stones.list')).toBe('stones_list');
      expect(mcpToolName('stones.substitutes')).toBe('stones_substitutes');
      expect(mcpToolName('stone.create')).toBe('stone_create');
      expect(mcpToolName('stone.import')).toBe('stone_import');
      expect(() =>
        composeRegistries([capabilities, createStoneCapabilities({ db: s.db, blobs: s.blobs })]),
      ).toThrow(/duplicate capability registration/);
    } finally {
      s.dispose();
    }
  });

  it('MCP listener 真往返：initialize→tools/list（八工具+schema 直传）→tools/call stones_list（readonly 真调）', async () => {
    const { capabilities, s } = composedFixture();
    const { sessionId } = s.sessions.create(s.anonymous, { title: 'mcp 冒烟' });
    const task = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' });
    const token = buildProcessToken();
    const handler = createMcpHandler(() => createStudioMcpServer({ capabilities }), { legacy: 'stateless' });
    const listener = new McpListener({
      port: 0,
      host: '127.0.0.1',
      kernelState: () => 'ready',
      token,
      handle: toNodeHandler(handler),
    });
    try {
      const port = await listener.listen();
      const base = `http://127.0.0.1:${port}/mcp`;
      let sessionIdHeader: string | undefined;
      const post = async (body: unknown): Promise<{ status: number; contentType: string; text: string }> => {
        const res = await fetch(base, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
            accept: 'application/json, text/event-stream',
            ...(sessionIdHeader !== undefined ? { 'mcp-session-id': sessionIdHeader } : {}),
          },
          body: JSON.stringify(body),
        });
        const header = res.headers.get('mcp-session-id');
        if (header !== null) sessionIdHeader = header;
        return { status: res.status, contentType: res.headers.get('content-type') ?? '', text: await res.text() };
      };
      const parseBody = (raw: { contentType: string; text: string }): unknown => {
        if (raw.contentType.includes('text/event-stream')) {
          const dataLines = raw.text.split('\n').filter((line) => line.startsWith('data:'));
          expect(dataLines.length).toBeGreaterThan(0);
          return JSON.parse((dataLines[dataLines.length - 1] as string).slice(5).trim());
        }
        return JSON.parse(raw.text);
      };
      // initialize。
      const init = await post({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      });
      expect(init.status).toBe(200);
      const initBody = parseBody(init) as { result?: { serverInfo?: { name?: string } } };
      expect(initBody.result?.serverInfo?.name).toBe('studio');
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
      // tools/list：八工具投影 + schema-faithful。
      const listRaw = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(listRaw.status).toBe(200);
      const toolsBody = parseBody(listRaw) as { result: { tools: Array<{ name: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
      const projected = toolsBody.result.tools.map((tool) => tool.name);
      for (const name of ['stones_list', 'stones_search', 'stones_get', 'stones_substitutes', 'stone_create', 'stone_update', 'stone_delete', 'stone_import']) {
        expect(projected).toContain(name); // dsh 全名投影=mcp__studio__<name>
      }
      const stonesList = toolsBody.result.tools.find((tool) => tool.name === 'stones_list');
      expect(Object.keys(stonesList?.inputSchema?.properties ?? {})).toEqual(
        expect.arrayContaining(['taskId', 'supplier', 'family', 'sizeMm', 'styleRow', 'sku', 'q', 'nearColor', 'groupBy', 'page', 'pageSize', 'includeTrashed']),
      );
      const stoneCreate = toolsBody.result.tools.find((tool) => tool.name === 'stone_create');
      expect(Object.keys(stoneCreate?.inputSchema?.properties ?? {})).toEqual(
        expect.arrayContaining(['taskId', 'proposalId', 'supplierProfile', 'draft', 'texture']),
      );
      // readonly 真调一条（list）。
      const callRaw = await post({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'stones_list', arguments: { taskId: task.id } },
      });
      expect(callRaw.status).toBe(200);
      const callBody = parseBody(callRaw) as { result: { content: Array<{ text: string }>; isError?: boolean } };
      expect(callBody.result.isError).toBeFalsy();
      const payload = JSON.parse(callBody.result.content[0]!.text) as { kind: string; value: { cells: unknown[] } };
      expect(payload.kind).toBe('ok');
      expect(Array.isArray(payload.value.cells)).toBe(true);
    } finally {
      await listener.stop(500);
      s.dispose();
    }
  });
});
