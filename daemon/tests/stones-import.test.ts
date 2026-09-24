/**
 * 样卡导入器单测（add-stone-library design §8/§8.1——S2.1~S2.5）。
 * 覆盖面：
 *   [1] S2.1 校验入口：schema typed 拒 + bbox 合理性（重叠/越界/页未声明/源图页缺失）。
 *   [2] S2.2 切格+去背景：钰航合成 fixture 全链（28 cell；band 漂移 J51→2/J76→12；
 *       alphaBounds≈直径；采样色=填充色；blob 单页回退）。
 *   [3] S2.3 批量+幂等：重跑全跳过收敛；部分失败=成功保留+失败清单（不整批回滚）。
 *   [4] S2.4 低置信：conf<0.7/空名 → `待命名-<row>` 兜底 + 清单。
 *   [5] §8.1 规则 3/6/7/8：跨格同字节降级 / 变体确定性命名+源重复 / 尺寸缺声明
 *       不猜测 / ΔE 交叉验证+质量旗透传。
 *   [6] 供应商/色系策略：targetSupplier 覆盖 + familyPolicy 映射。
 */
import { describe, expect, it, afterEach } from 'vitest';
import type { CardCatalogDraft, RgbTuple } from '@handicraft/contracts';
import {
  CardImportError,
  runCardImport,
  type CardImportReport,
  type CardImportResult,
} from '../src/stones/importer.js';
import { StoneService } from '../src/stones/service.js';
import { createServices, type TestServices } from './helpers.js';
import {
  buildDraft,
  buildStandardYuhangFixture,
  diamPx,
  drawCardPage,
  type DraftCellSpec,
  type DraftStyleSpec,
} from './stones-import-fixture.js';

const active: TestServices[] = [];
function setup(): { svc: TestServices; stones: StoneService; ownerId: string } {
  const svc = createServices();
  active.push(svc);
  return { svc, stones: new StoneService({ db: svc.db, blobs: svc.blobs }), ownerId: svc.anonymous.id };
}
afterEach(() => {
  for (const s of active.splice(0)) s.dispose();
});

const IVORY: RgbTuple = [240, 240, 232];

function run(
  svc: TestServices,
  draft: CardCatalogDraft,
  pageImages: ReadonlyMap<number, Uint8Array> | undefined,
  ownerId: string,
  options: Partial<Parameters<typeof runCardImport>[2]> = {},
): CardImportResult {
  return runCardImport(
    { service: new StoneService({ db: svc.db, blobs: svc.blobs }), blobs: svc.blobs, db: svc.db, pageImages },
    draft,
    { targetSupplier: 'yuhang', ownerId, ...options },
  );
}

function reportOf(svc: TestServices, result: CardImportResult): CardImportReport {
  const bytes = svc.blobs.read(result.reportRef);
  expect(bytes).not.toBeNull();
  return JSON.parse(bytes!.toString('utf8')) as CardImportReport;
}

function stoneCount(svc: TestServices): number {
  return (svc.db.prepare('SELECT COUNT(*) AS n FROM stone_index').get() as { n: number }).n;
}

// ---------------------------------------------------------------- S2.1 校验入口

describe('S2.1 校验入口', () => {
  it('schema 不过 → typed invalid-draft（ZodError 包装）；空 targetSupplier → invalid-options', () => {
    const { svc, ownerId } = setup();
    const bad = { schemaVersion: 2 } as unknown as CardCatalogDraft;
    try {
      run(svc, bad, new Map(), ownerId);
      expect.unreachable('schemaVersion=2 应拒');
    } catch (error) {
      expect(error).toBeInstanceOf(CardImportError);
      expect((error as CardImportError).code).toBe('invalid-draft');
    }
    const { draft, pageImages } = buildStandardYuhangFixture();
    try {
      run(svc, draft, pageImages, ownerId, { targetSupplier: '  ' });
      expect.unreachable('空 targetSupplier 应拒');
    } catch (error) {
      expect(error).toBeInstanceOf(CardImportError);
      expect((error as CardImportError).code).toBe('invalid-options');
    }
    expect(stoneCount(svc)).toBe(0);
  });

  it('bbox 合理性：同页重叠/越界/页未声明/源图页缺失 → 涉事格逐个失败，其余照常入库', () => {
    const { svc, ownerId } = setup();
    const good: DraftCellSpec = { sku: 'J57', cx: 100, cy: 120, diameter: 80, rgb: IVORY };
    const overlapA: DraftCellSpec = { sku: 'A57', cx: 260, cy: 120, diameter: 80, rgb: IVORY };
    const overlapB: DraftCellSpec = { sku: 'B57', cx: 310, cy: 120, diameter: 80, rgb: [96, 168, 160] };
    const outOfPage: DraftCellSpec = { sku: 'E57', cx: 600, cy: 120, diameter: 80, rgb: IVORY, bbox: { x: 690, y: 20, w: 92, h: 92 } };
    const onPage2Missing: DraftStyleSpec = { row: 58, page: 2, suggestedName: '页二色', suggestedFamily: '白色系', rgb: IVORY, confidence: 0.9, cells: [{ sku: 'J58', cx: 100, cy: 120, diameter: 80, rgb: IVORY }] };
    const styles: DraftStyleSpec[] = [
      {
        row: 57,
        page: 1,
        suggestedName: '测试白',
        suggestedFamily: '白色系',
        rgb: IVORY,
        confidence: 0.9,
        cells: [good, overlapA, overlapB, outOfPage],
      },
      onPage2Missing,
    ];
    const draft = buildDraft(styles);
    // 页未声明：把 J57 的 page 改成未声明的 99（schema 仍合法——结构检查面）
    draft.styles[0]!.cells[0] = { ...draft.styles[0]!.cells[0]!, page: 99 };
    const declared = draft.sourceImage.pages.find((p) => p.page === 1)!;
    const page1 = drawCardPage(
      declared.widthPx,
      declared.heightPx,
      styles[0]!.cells.map((c) => ({ cx: c.cx, cy: c.cy, diameter: c.diameter, rgb: c.rgb })),
    );
    const result = run(svc, draft, new Map([[1, page1]]), ownerId);

    expect(result.created).toHaveLength(0); // J57 被 page=99 改写 → 页未声明
    const reasons = Object.fromEntries(result.failed.map((f) => [f.sku, f.reason]));
    expect(result.failed).toHaveLength(5);
    expect(reasons['A57']).toMatch(/bbox-overlap/);
    expect(reasons['B57']).toMatch(/bbox-overlap/);
    expect(reasons['E57']).toMatch(/bbox-out-of-page/);
    expect(reasons['J57']).toMatch(/page-not-declared/);
    expect(reasons['J58']).toMatch(/source-page-unreadable：源图字节缺失/);
    expect(stoneCount(svc)).toBe(0);
    const report = reportOf(svc, result);
    expect(report.summary).toMatchObject({ created: 0, failed: 5, rows: 2 });
  });
});

// ---------------------------------------------------------------- S2.2 切格+去背景

describe('S2.2 切格+去背景（钰航合成 fixture 全链）', () => {
  it('28 cell 全建：band 漂移直值 + 目录树 + alphaBounds≈直径 + 采样色真值 + 报告留档', () => {
    const { svc, stones, ownerId } = setup();
    const { draft, pageImages } = buildStandardYuhangFixture();
    const result = run(svc, draft, pageImages, ownerId);

    expect(result.created).toHaveLength(28);
    expect(result.failed).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.pendingDowngrades).toHaveLength(0);
    expect(result.reportRef).toMatch(/^[0-9a-f]{64}$/);

    // band 漂移（§2 行段表）：J51→2 / G51→10 / J76→12 / G76→25
    const bySku = new Map(stones.listIndexRows().map((r) => [r.sku, r]));
    expect(bySku.get('J51')).toMatchObject({ size_mm: 2, style_row: 51, family: '白色系', style_name: '象牙白', supplier: 'yuhang' });
    expect(bySku.get('G51')!.size_mm).toBe(10);
    expect(bySku.get('J76')).toMatchObject({ size_mm: 12, family: '大径行', style_name: '古铜金' });
    expect(bySku.get('G76')!.size_mm).toBe(25);
    // 空色系兜底（行 53 suggestedFamily=''）
    expect(bySku.get('J53')).toMatchObject({ family: '未分组', style_name: '待命名-53' });

    // 目录树（design §1.2）+ 采样色真值（rgb 取 cell 取样）+ alphaBounds 实测≈直径
    const j51 = stones.getStone(bySku.get('J51')!.resource_id);
    expect(j51.path).toBe('/stones/standards/yuhang/白色系/51-象牙白/J51');
    expect(j51.stone.color.rgb).toEqual(IVORY);
    expect(j51.stone.metadata.sampledRgb).toEqual(IVORY);
    expect(j51.stone.metadata.deltaE).toBe(0);
    const j51Major = Math.max(j51.stone.texture.alphaBounds.w, j51.stone.texture.alphaBounds.h);
    expect(j51Major).toBeGreaterThanOrEqual(diamPx(2) - 2);
    expect(j51Major).toBeLessThanOrEqual(diamPx(2) + 6);
    const g76 = stones.getStone(bySku.get('G76')!.resource_id);
    const g76Major = Math.max(g76.stone.texture.alphaBounds.w, g76.stone.texture.alphaBounds.h);
    expect(g76Major).toBeGreaterThanOrEqual(diamPx(25) - 2);
    expect(g76Major).toBeLessThanOrEqual(diamPx(25) + 8);

    // 报告（S2.5 网格前后对照：每 cell 贴图 ok + 采样 RGB vs draft rgb 的 ΔE）
    const report = reportOf(svc, result);
    expect(report.kind).toBe('card-import-report');
    expect(report.summary).toMatchObject({ created: 28, failed: 0, rows: 4, needsReviewRows: 0 });
    const row51 = report.rows.find((r) => r.row === 51)!;
    expect(row51.cells).toHaveLength(7);
    for (const cell of row51.cells) {
      expect(cell.status).toBe('created');
      expect(cell.textureStatus).toBe('ok');
      expect(cell.sampledRgb).toEqual(IVORY);
      expect(cell.draftRgb).toEqual(IVORY);
      expect(cell.deltaE).toBe(0);
      expect(cell.resourceId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(report.rows.find((r) => r.row === 76)!.medianDeltaE).toBe(0);
  });

  it('单页草表 blob 回退：pageImages 缺省 → blobs.read(blobRef) 取源图', () => {
    const { svc, ownerId } = setup();
    const style: DraftStyleSpec = {
      row: 51,
      page: 1,
      suggestedName: '象牙白',
      suggestedFamily: '白色系',
      rgb: IVORY,
      confidence: 0.95,
      cells: [{ sku: 'J51', cx: 100, cy: 120, diameter: 80, rgb: IVORY }],
    };
    const pageBytes = drawCardPage(200, 240, [{ cx: 100, cy: 120, diameter: 80, rgb: IVORY }]);
    const put = svc.blobs.put(pageBytes);
    const draft = buildDraft([style], { blobRef: put.hash, pages: [{ page: 1, widthPx: 200, heightPx: 240 }] });
    const result = run(svc, draft, undefined, ownerId);
    expect(result.created).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- S2.3 批量+幂等

describe('S2.3 批量建原子与幂等重跑', () => {
  it('幂等重跑：二跑 28 全跳过、零新建——重跑收敛（supplier×sku 存在即跳过）', () => {
    const { svc, ownerId } = setup();
    const { draft, pageImages } = buildStandardYuhangFixture();
    const first = run(svc, draft, pageImages, ownerId);
    expect(first.created).toHaveLength(28);
    const second = run(svc, draft, pageImages, ownerId);
    expect(second.created).toHaveLength(0);
    expect(second.skipped).toHaveLength(28);
    expect(second.skipped[0]!.reason).toMatch(/supplier×sku 已存在（幂等跳过/);
    expect(second.failed).toHaveLength(0);
    expect(stoneCount(svc)).toBe(28);
    const report = reportOf(svc, second);
    expect(report.summary).toMatchObject({ created: 0, skipped: 28 });
  });

  it('部分失败=成功保留+失败清单（不整批回滚）：gate 低分辨率/空主体 与好格共存', () => {
    const { svc, ownerId } = setup();
    const styles: DraftStyleSpec[] = [
      {
        row: 57,
        page: 1,
        suggestedName: '测试白',
        suggestedFamily: '白色系',
        rgb: IVORY,
        confidence: 0.9,
        cells: [
          { sku: 'J57', cx: 100, cy: 120, diameter: 80, rgb: IVORY },
          { sku: 'A57', cx: 260, cy: 120, diameter: 20, rgb: IVORY }, // 20px<64 → gate resolution-too-low
          { sku: 'C57', cx: 420, cy: 120, diameter: 80, rgb: IVORY }, // 画布留白（不绘制）→ 空主体
        ],
      },
    ];
    const draft = buildDraft(styles);
    const declared = draft.sourceImage.pages.find((p) => p.page === 1)!;
    const page1 = drawCardPage(declared.widthPx, declared.heightPx, [
      { cx: 100, cy: 120, diameter: 80, rgb: IVORY },
      { cx: 260, cy: 120, diameter: 20, rgb: IVORY },
      // C57 区域刻意不绘制——白底切格空主体
    ]);
    const result = run(svc, draft, new Map([[1, page1]]), ownerId);
    expect(result.created).toHaveLength(1);
    const reasons = Object.fromEntries(result.failed.map((f) => [f.sku, f.reason]));
    expect(reasons['A57']).toMatch(/texture-gate\/resolution-too-low/);
    expect(reasons['C57']).toMatch(/background-removal-empty/);
    expect(stoneCount(svc)).toBe(1); // 成功行保留（无整批回滚）
  });
});

// ---------------------------------------------------------------- S2.4 低置信

describe('S2.4 低置信项兜底', () => {
  it('confidence<0.7 且空名 → `待命名-<row>` 兜底 + 清单显式 + metadata 旗', () => {
    const { svc, stones, ownerId } = setup();
    const { draft, pageImages } = buildStandardYuhangFixture();
    const result = run(svc, draft, pageImages, ownerId);

    expect(result.lowConfidence).toHaveLength(7);
    expect(result.lowConfidence[0]).toEqual({ sku: 'J53', row: 53 });
    const j53Row = stones.listIndexRows().find((r) => r.sku === 'J53')!;
    expect(j53Row.style_name).toBe('待命名-53');
    const j53 = stones.getStone(j53Row.resource_id);
    expect(j53.path).toBe('/stones/standards/yuhang/未分组/53-待命名-53/J53');
    expect(j53.stone.name).toBe('待命名-53 · 2mm');
    expect(j53.stone.metadata.lowConfidence).toBe(true);
    expect(j53.stone.metadata.confidence).toBe(0.5);
    const report = reportOf(svc, result);
    expect(report.summary.lowConfidence).toBe(7);
    expect(report.rows.find((r) => r.row === 53)!.appliedName).toBe('待命名-53');
  });
});

// ---------------------------------------------------------------- §8.1 硬验收

describe('§8.1 规则 3：跨格同字节检测', () => {
  it('同 hash 贴图出现于 ≥2 个不同 cell → 全部 card-render-pending，不静默入库', () => {
    const { svc, ownerId } = setup();
    // 两个不同 SKU 的格画同字节内容（同尺寸同色方块=字形/模板污染形态）
    const styles: DraftStyleSpec[] = [
      {
        row: 55,
        page: 1,
        suggestedName: '测试色',
        suggestedFamily: '白色系',
        rgb: [40, 40, 40],
        confidence: 0.9,
        cells: [
          { sku: 'J55', cx: 80, cy: 100, diameter: 80, rgb: [40, 40, 40], shape: 'square' },
          { sku: 'A55', cx: 280, cy: 100, diameter: 80, rgb: [40, 40, 40], shape: 'square' },
        ],
      },
    ];
    const draft = buildDraft(styles);
    const declared = draft.sourceImage.pages[0]!;
    const page1 = drawCardPage(declared.widthPx, declared.heightPx, [
      { cx: 80, cy: 100, diameter: 80, rgb: [40, 40, 40], shape: 'square' },
      { cx: 280, cy: 100, diameter: 80, rgb: [40, 40, 40], shape: 'square' },
    ]);
    const result = run(svc, draft, new Map([[1, page1]]), ownerId);

    expect(result.pendingDowngrades).toHaveLength(2);
    expect(result.pendingDowngrades[0]!.reason).toMatch(/card-render-pending：跨格同字节（§8\.1 规则 3/);
    expect(result.created).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
    expect(stoneCount(svc)).toBe(0); // 不入库
    const report = reportOf(svc, result);
    const cells = report.rows[0]!.cells;
    expect(cells.every((c) => c.status === 'pending' && c.textureStatus === 'card-render-pending')).toBe(true);
    expect(cells[0]!.textureHash).toBe(cells[1]!.textureHash); // 同字节实证
    // 修复后重跑入库（幂等衔接）：换掉其中一格内容
    const fixed = drawCardPage(declared.widthPx, declared.heightPx, [
      { cx: 80, cy: 100, diameter: 80, rgb: [40, 40, 40], shape: 'square' },
      { cx: 280, cy: 100, diameter: 80, rgb: [120, 120, 120], shape: 'square' },
    ]);
    const rerun = run(svc, draft, new Map([[1, fixed]]), ownerId);
    expect(rerun.created).toHaveLength(2);
    expect(rerun.pendingDowngrades).toHaveLength(0);
  });
});

describe('§8.1 规则 6：变体 SKU 确定性命名', () => {
  it('同码同字节=源重复跳过记报告（首格保位，禁止后写覆盖先写）', () => {
    const { svc, ownerId } = setup();
    const styles: DraftStyleSpec[] = [
      {
        row: 55,
        page: 1,
        suggestedName: '测试色',
        suggestedFamily: '白色系',
        rgb: [96, 168, 160],
        confidence: 0.9,
        cells: [
          { sku: 'C55', cx: 120, cy: 100, diameter: 80, rgb: [96, 168, 160] },
          { sku: 'C55', cx: 320, cy: 100, diameter: 80, rgb: [96, 168, 160] }, // 同码同字节
        ],
      },
    ];
    const draft = buildDraft(styles);
    const declared = draft.sourceImage.pages[0]!;
    const page1 = drawCardPage(declared.widthPx, declared.heightPx, [
      { cx: 120, cy: 100, diameter: 80, rgb: [96, 168, 160] },
      { cx: 320, cy: 100, diameter: 80, rgb: [96, 168, 160] },
    ]);
    const result = run(svc, draft, new Map([[1, page1]]), ownerId);
    expect(result.created).toHaveLength(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ sku: 'C55' });
    expect(result.skipped[0]!.reason).toMatch(/source-duplicate：同码同字节源重复（§8\.1 规则 6）/);
    expect(stoneCount(svc)).toBe(1);
  });

  it('同码异字节变体：裸码保 code、其余 code-WxH；无尺寸 #n；originalSku 溯源', () => {
    const { svc, stones, ownerId } = setup();
    const styles: DraftStyleSpec[] = [
      {
        row: 51,
        page: 1,
        suggestedName: '象牙白',
        suggestedFamily: '白色系',
        rgb: IVORY,
        confidence: 0.9,
        cells: [
          { sku: 'J51', cx: 100, cy: 120, diameter: 80, rgb: IVORY },
          { sku: 'J51', cx: 300, cy: 120, diameter: 80, rgb: [200, 60, 60] }, // 同码异字节 → J51-2x2
        ],
      },
      {
        row: 9,
        page: 1,
        suggestedName: '魔方灰',
        suggestedFamily: '魔方',
        rgb: [128, 128, 128],
        confidence: 0.9,
        cells: [
          { sku: 'X9', cx: 500, cy: 120, diameter: 80, rgb: [128, 128, 128] },
          { sku: 'X9', cx: 700, cy: 120, diameter: 80, rgb: [0, 128, 128] }, // → X9#2（无尺寸）
        ],
      },
    ];
    const draft = buildDraft(styles);
    const declared = draft.sourceImage.pages[0]!;
    const page1 = drawCardPage(declared.widthPx, declared.heightPx, styles.flatMap((s) =>
      s.cells.map((c) => ({ cx: c.cx, cy: c.cy, diameter: c.diameter, rgb: c.rgb })),
    ));
    const result = run(svc, draft, new Map([[1, page1]]), ownerId);

    expect(result.created).toHaveLength(4);
    const skus = stones.listIndexRows().map((r) => r.sku).sort();
    expect(skus).toEqual(['J51', 'J51-2x2', 'X9', 'X9#2']);
    const variant = stones.listIndexRows().find((r) => r.sku === 'J51-2x2')!;
    const variantStone = stones.getStone(variant.resource_id);
    expect(variantStone.stone.metadata.originalSku).toBe('J51');
    expect(variantStone.stone.skuParsed).toEqual({ row: 51, prefix: 'J', sizeMm: 2 }); // 物化快照取原始码解析
    expect(stones.getStone(stones.listIndexRows().find((r) => r.sku === 'X9#2')!.resource_id).stone.metadata.originalSku).toBe('X9');
  });
});

describe('§8.1 规则 7：尺寸缺声明不猜测', () => {
  it('行段外 SKU → sizeMm=null + metadata.sizeNote（显式原因）+ 索引 size_mm null', () => {
    const { svc, stones, ownerId } = setup();
    const styles: DraftStyleSpec[] = [
      {
        row: 9,
        page: 1,
        suggestedName: '魔方灰',
        suggestedFamily: '魔方',
        rgb: [128, 128, 128],
        confidence: 0.9,
        cells: [{ sku: 'X9', cx: 100, cy: 120, diameter: 80, rgb: [128, 128, 128] }],
      },
    ];
    const draft = buildDraft(styles);
    const declared = draft.sourceImage.pages[0]!;
    const page1 = drawCardPage(declared.widthPx, declared.heightPx, [{ cx: 100, cy: 120, diameter: 80, rgb: [128, 128, 128] }]);
    const result = run(svc, draft, new Map([[1, page1]]), ownerId);

    expect(result.created).toHaveLength(1);
    const row = stones.listIndexRows()[0]!;
    expect(row.size_mm).toBeNull();
    expect(row.style_row).toBeNull(); // 无 skuParsed 快照
    const got = stones.getStone(row.resource_id);
    expect(got.stone.sizeMm).toBeNull();
    expect(got.stone.skuParsed).toBeUndefined();
    expect(got.stone.name).toBe('魔方灰 · 尺寸未声明');
    expect(got.stone.metadata.sizeNote).toMatch(/X9 尺寸未声明（row-out-of-band）——§8\.1 规则 7 不猜测/);
  });
});

describe('§8.1 规则 8：质量旗 + RGB 交叉验证', () => {
  it('行中位 ΔE>10（CIE76 量纲）→ needsReview 人工复核 + 逐 cell ΔE；qualityFlag 透传', () => {
    const { svc, stones, ownerId } = setup();
    const drawn: RgbTuple = [30, 60, 200]; // 实际画的是蓝
    const draftClaim: RgbTuple = [220, 30, 40]; // 草表声明红——对账偏差
    const styles: DraftStyleSpec[] = [
      {
        row: 61,
        page: 1,
        suggestedName: '宝石蓝',
        suggestedFamily: '蓝色系',
        rgb: draftClaim,
        confidence: 0.9,
        cells: [
          { sku: 'J61', cx: 100, cy: 120, diameter: diamPx(2), rgb: drawn },
          { sku: 'A61', cx: 260, cy: 120, diameter: diamPx(3), rgb: drawn },
          { sku: 'B61', cx: 460, cy: 120, diameter: diamPx(4), rgb: drawn },
        ],
      },
    ];
    const draft = buildDraft(styles);
    const declared = draft.sourceImage.pages[0]!;
    const page1 = drawCardPage(declared.widthPx, declared.heightPx, styles[0]!.cells.map((c) => ({ cx: c.cx, cy: c.cy, diameter: c.diameter, rgb: c.rgb })));
    const result = run(
      svc,
      draft,
      new Map([[1, page1]]),
      ownerId,
      { qualityFlag: 'source-lineart-unfilled' },
    );

    expect(result.created).toHaveLength(3);
    const row61 = stones.listIndexRows().find((r) => r.sku === 'J61')!;
    const stone = stones.getStone(row61.resource_id).stone;
    // 入库色=采样真值（蓝），草表声明色存 draftRgb 供对账
    expect(stone.color.rgb).toEqual(drawn);
    expect(stone.metadata.draftRgb).toEqual(draftClaim);
    expect(stone.metadata.deltaE as number).toBeGreaterThan(10);
    expect(stone.metadata.medianDeltaE as number).toBeGreaterThan(10);
    expect(stone.metadata.needsReview).toBe('median-delta-e');
    expect(stone.metadata.qualityFlag).toBe('source-lineart-unfilled');
    const report = reportOf(svc, result);
    expect(report.rows[0]!.needsReview).toBe(true);
    expect(report.summary.needsReviewRows).toBe(1);
    for (const cell of report.rows[0]!.cells) {
      expect(cell.deltaE).toBeGreaterThan(10);
      expect(cell.sampledRgb).toEqual(drawn);
      expect(cell.draftRgb).toEqual(draftClaim);
    }
  });
});

// ---------------------------------------------------------------- 供应商/色系策略

describe('供应商与色系策略', () => {
  it('targetSupplier 覆盖（供应商目录+唯一键）+ familyPolicy 色系映射', () => {
    const { svc, stones, ownerId } = setup();
    const styles: DraftStyleSpec[] = [
      {
        row: 61,
        page: 1,
        suggestedName: '测试白',
        suggestedFamily: '白色系',
        rgb: IVORY,
        confidence: 0.9,
        cells: [
          { sku: 'J61', cx: 100, cy: 120, diameter: 80, rgb: IVORY },
          { sku: 'A61', cx: 260, cy: 120, diameter: 100, rgb: IVORY },
        ],
      },
    ];
    const draft = buildDraft(styles, { supplier: 'yuhang' });
    const declared = draft.sourceImage.pages[0]!;
    const page1 = drawCardPage(declared.widthPx, declared.heightPx, styles[0]!.cells.map((c) => ({ cx: c.cx, cy: c.cy, diameter: c.diameter, rgb: c.rgb })));
    const result = run(svc, draft, new Map([[1, page1]]), ownerId, {
      targetSupplier: 'factory-yh',
      familyPolicy: { overrides: { 白色系: '暖白色系' } },
    });

    expect(result.created).toHaveLength(2);
    const rows = stones.listIndexRows();
    expect(rows.every((r) => r.supplier === 'factory-yh')).toBe(true);
    expect(rows.every((r) => r.family === '暖白色系')).toBe(true);
    expect(stones.getStone(rows.find((r) => r.sku === 'J61')!.resource_id).path).toBe(
      '/stones/standards/factory-yh/暖白色系/61-测试白/J61',
    );
  });
});
