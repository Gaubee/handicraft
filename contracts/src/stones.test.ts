/**
 * 装饰钻库契约单测（add-stone-library tasks S0.1——design §1.3/§2/§4/§5/§8/§9）。
 * 覆盖：schema round-trip + 坏输入 typed error + parseSku 行段漂移实证（钰航
 * J51→2mm 而 J76→12mm——§2 三行段表）+ SS 换算镜像对 engine grid.ts SS_TABLE
 * 字面量锁死（抄录基准，同 paving.test.ts 纪律：本包不 import 引擎）。
 */
import { describe, expect, it } from 'vitest';
import {
  CardCatalogDraftSchema,
  CloudCatalogEntrySchema,
  SS_DIAMETER_TABLE,
  StoneFileSchema,
  StoneGridCellSchema,
  StonePickSchema,
  SubstituteQuerySchema,
  SupplierSkuProfileSchema,
  nearestSs,
  parseSku,
  ssSizeMm,
} from './stones.js';

const blobRef = 'a'.repeat(64);
const iso = '2026-09-24T00:00:00.000Z';

// ---------------------------------------------------------------- §2 钰航档案 fixture

/** design §2 行段表实证（三行段；行 77/79 样卡缺席=band 内容忍）。 */
const yuhang = SupplierSkuProfileSchema.parse({
  supplier: 'yuhang',
  displayName: '钰航',
  bands: [
    { rows: [51, 75], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
    { rows: [76, 78], sizeMmByPrefix: { J: 12, A: 14, B: 16, C: 18, E: 20, F: 22, G: 25 } },
    { rows: [80, 89], sizeMmByPrefix: { J: 2, A: 3, B: 4, C: 5, E: 6, F: 8, G: 10 } },
  ],
  styleKey: 'row',
});

describe('parseSku：行段漂移与显式拒绝（design §2 实证）', () => {
  it("'J51'→2mm（页 1 行段）", () => {
    expect(parseSku(yuhang, 'J51')).toEqual({ ok: true, supplier: 'yuhang', row: 51, prefix: 'J', sizeMm: 2 });
  });
  it("'J76'→12mm（同一前缀跨行段漂移——band [76,78]: J=12）", () => {
    expect(parseSku(yuhang, 'J76')).toEqual({ ok: true, supplier: 'yuhang', row: 76, prefix: 'J', sizeMm: 12 });
  });
  it("'G78'→25mm（页 2 行段末档）", () => {
    expect(parseSku(yuhang, 'G78')).toEqual({ ok: true, supplier: 'yuhang', row: 78, prefix: 'G', sizeMm: 25 });
  });
  it("'J80'→2mm（页 2 下行段回卷）", () => {
    expect(parseSku(yuhang, 'J80')).toEqual({ ok: true, supplier: 'yuhang', row: 80, prefix: 'J', sizeMm: 2 });
  });
  it("'J77'→12mm（稀疏行容忍：行 77 样卡缺席但 band [76,78] 覆盖）", () => {
    expect(parseSku(yuhang, 'J77')).toEqual({ ok: true, supplier: 'yuhang', row: 77, prefix: 'J', sizeMm: 12 });
  });
  it('行段外拒绝：J90（>89 无 band）/ J50（<51 无 band）', () => {
    expect(parseSku(yuhang, 'J90')).toEqual({ ok: false, reason: 'row-out-of-band' });
    expect(parseSku(yuhang, 'J50')).toEqual({ ok: false, reason: 'row-out-of-band' });
  });
  it('未知前缀拒绝：X51 / j51（大小写敏感，不规范化猜测）', () => {
    expect(parseSku(yuhang, 'X51')).toEqual({ ok: false, reason: 'prefix-unknown' });
    expect(parseSku(yuhang, 'j51')).toEqual({ ok: false, reason: 'prefix-unknown' });
  });
  it('格式非法拒绝：空串/纯字母/纯数字/后缀数字在前/含分隔符/浮点', () => {
    for (const bad of ['', 'J', '51', '51J', 'J-51', 'J5.1', 'J 51', 'J051x']) {
      expect(parseSku(yuhang, bad)).toEqual({ ok: false, reason: 'malformed' });
    }
  });
});

describe('SupplierSkuProfile schema', () => {
  it('钰航三行段 round-trip', () => {
    expect(yuhang.bands).toHaveLength(3);
    expect(yuhang.bands[1]).toEqual({
      rows: [76, 78],
      sizeMmByPrefix: { J: 12, A: 14, B: 16, C: 18, E: 20, F: 22, G: 25 },
    });
  });
  it('坏档案拒绝：空 bands / 倒置行段 / 非正尺寸 / styleKey 变体', () => {
    expect(SupplierSkuProfileSchema.safeParse({ ...yuhang, bands: [] }).success).toBe(false);
    expect(
      SupplierSkuProfileSchema.safeParse({
        ...yuhang,
        bands: [{ rows: [75, 51], sizeMmByPrefix: { J: 2 } }],
      }).success,
    ).toBe(false);
    expect(
      SupplierSkuProfileSchema.safeParse({
        ...yuhang,
        bands: [{ rows: [51, 75], sizeMmByPrefix: { J: 0 } }],
      }).success,
    ).toBe(false);
    expect(SupplierSkuProfileSchema.safeParse({ ...yuhang, styleKey: 'column' }).success).toBe(false);
    expect(SupplierSkuProfileSchema.safeParse({ ...yuhang, extra: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------- §1.3 stone.json

const j51Stone = {
  kind: 'stone' as const,
  formatVersion: 1 as const,
  id: 'stn-0a1b2c3d',
  name: '象牙白 · 2mm',
  supplier: 'yuhang',
  sku: 'J51',
  skuParsed: { row: 51, prefix: 'J', sizeMm: 2 },
  sizeMm: 2,
  color: { name: '象牙白', rgb: [255, 255, 240] as [number, number, number], family: '白色系', finish: 'glossy' },
  texture: {
    file: '贴图.png',
    mime: 'image/png',
    width: 64,
    height: 64,
    alphaBounds: { x: 8, y: 8, w: 48, h: 48 },
  },
  shapeClass: 'round',
  gemshapeRef: 'gem-round-seed',
  views: ['斜视.jpg'],
  metadata: { sizeNote: undefined, batch: 'B-2026', nested: { a: 1 } },
  createdAt: iso,
  updatedAt: iso,
};

describe('StoneFileSchema（§1.3）', () => {
  it('全字段 round-trip（含 gemshapeRef/views/metadata 自由扩展）', () => {
    const parsed = StoneFileSchema.parse(j51Stone);
    expect(parsed.id).toBe('stn-0a1b2c3d');
    expect(parsed.skuParsed).toEqual({ row: 51, prefix: 'J', sizeMm: 2 });
    expect(parsed.metadata).toEqual({ batch: 'B-2026', nested: { a: 1 } });
  });
  it('sizeMm=null 通过（§8.1 规则 7：无物理尺寸声明显式 null，不猜测）', () => {
    const magic = { ...j51Stone, sizeMm: null, sku: 'MC-001', skuParsed: undefined, metadata: { sizeNote: '魔方钻色卡未声明尺寸' } };
    const parsed = StoneFileSchema.parse(magic);
    expect(parsed.sizeMm).toBeNull();
    expect(parsed.metadata['sizeNote']).toBe('魔方钻色卡未声明尺寸');
  });
  it('核心字段坏值拒绝：kind/formatVersion/未知字段(strict)/尺寸/rgb 越界/alphaBounds 空', () => {
    expect(StoneFileSchema.safeParse({ ...j51Stone, kind: 'gem' }).success).toBe(false);
    expect(StoneFileSchema.safeParse({ ...j51Stone, formatVersion: 2 }).success).toBe(false);
    expect(StoneFileSchema.safeParse({ ...j51Stone, extraField: true }).success).toBe(false);
    expect(StoneFileSchema.safeParse({ ...j51Stone, sizeMm: 0 }).success).toBe(false);
    expect(StoneFileSchema.safeParse({ ...j51Stone, sizeMm: -1 }).success).toBe(false);
    expect(
      StoneFileSchema.safeParse({ ...j51Stone, color: { ...j51Stone.color, rgb: [256, 0, 0] } }).success,
    ).toBe(false);
    expect(
      StoneFileSchema.safeParse({ ...j51Stone, color: { ...j51Stone.color, rgb: [10.5, 0, 0] } }).success,
    ).toBe(false);
    expect(
      StoneFileSchema.safeParse({ ...j51Stone, texture: { ...j51Stone.texture, alphaBounds: { x: 0, y: 0, w: 0, h: 0 } } })
        .success,
    ).toBe(false);
    expect(StoneFileSchema.safeParse({ ...j51Stone, texture: undefined }).success).toBe(false);
    expect(StoneFileSchema.safeParse({ ...j51Stone, texture: { ...j51Stone.texture, file: 'main.png' } }).success).toBe(
      false,
    );
  });
  it('可选项缺省形态通过：无 skuParsed/shapeClass/gemshapeRef/views', () => {
    const { skuParsed: _skuParsed, shapeClass: _s, gemshapeRef: _g, views: _v, ...minimal } = j51Stone;
    expect(StoneFileSchema.safeParse(minimal).success).toBe(true);
  });
});

// ---------------------------------------------------------------- §8 样卡草表

const draft = {
  schemaVersion: 1 as const,
  supplier: 'yuhang',
  sourceImage: {
    blobRef,
    pages: [
      { page: 1, widthPx: 2200, heightPx: 1700 },
      { page: 2, widthPx: 2200, heightPx: 1700 },
    ],
  },
  bands: yuhang.bands,
  styles: [
    {
      row: 51,
      suggestedName: '象牙白',
      suggestedFamily: '白色系',
      rgb: [255, 255, 240] as [number, number, number],
      confidence: 0.92,
      cells: [
        { sku: 'J51', page: 1, bboxPx: { x: 200, y: 300, w: 60, h: 60 } },
        { sku: 'A51', page: 1, bboxPx: { x: 330, y: 300, w: 70, h: 70 } },
      ],
    },
    {
      row: 76,
      suggestedName: '',
      suggestedFamily: '大径行',
      rgb: [205, 127, 50] as [number, number, number],
      confidence: 0.5,
      cells: [{ sku: 'J76', page: 2, bboxPx: { x: 240, y: 900, w: 112, h: 112 } }],
    },
  ],
};

describe('CardCatalogDraftSchema（§8）', () => {
  it('两页+两款式行 round-trip（含空 suggestedName=待人工命名与低置信项原样承载）', () => {
    const parsed = CardCatalogDraftSchema.parse(draft);
    expect(parsed.styles[1]).toMatchObject({ row: 76, suggestedName: '', confidence: 0.5 });
    expect(parsed.styles[0].cells).toHaveLength(2);
  });
  it('坏草表拒绝：schemaVersion/blobRef 形/空 pages/confidence 越界/空 cells/bbox 负坐标', () => {
    expect(CardCatalogDraftSchema.safeParse({ ...draft, schemaVersion: 2 }).success).toBe(false);
    expect(CardCatalogDraftSchema.safeParse({ ...draft, sourceImage: { ...draft.sourceImage, blobRef: 'zz' } }).success).toBe(false);
    expect(CardCatalogDraftSchema.safeParse({ ...draft, sourceImage: { ...draft.sourceImage, pages: [] } }).success).toBe(false);
    expect(CardCatalogDraftSchema.safeParse({ ...draft, styles: [{ ...draft.styles[0], confidence: 1.5 }] }).success).toBe(false);
    expect(CardCatalogDraftSchema.safeParse({ ...draft, styles: [{ ...draft.styles[0], cells: [] }] }).success).toBe(false);
    expect(
      CardCatalogDraftSchema.safeParse({
        ...draft,
        styles: [{ ...draft.styles[0], cells: [{ ...draft.styles[0].cells[0], bboxPx: { x: -1, y: 0, w: 10, h: 10 } }] }],
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- §4.2/§5/§9 投影

describe('StoneGridCellSchema（§4.2 轻投影——列表不载 stone.json 全文）', () => {
  const cell = {
    resourceId: 'res-uuid-1',
    sku: 'J51',
    supplier: 'yuhang',
    name: '象牙白 · 2mm',
    styleName: '象牙白',
    family: '白色系',
    sizeMm: 2,
    colorHex: '#FFFFF0',
    finish: 'glossy',
    textureUrl: '/api/stones/res-uuid-1/texture.png',
    trashed: false,
    updatedAt: iso,
  };
  it('round-trip + sizeMm null 承载（未声明尺寸单元显式投影）', () => {
    expect(StoneGridCellSchema.parse(cell).colorHex).toBe('#FFFFF0');
    expect(StoneGridCellSchema.parse({ ...cell, sizeMm: null }).sizeMm).toBeNull();
  });
  it('坏单元拒绝：小写 hex / 未知字段 / 缺 trashed', () => {
    expect(StoneGridCellSchema.safeParse({ ...cell, colorHex: '#fffff0' }).success).toBe(false);
    expect(StoneGridCellSchema.safeParse({ ...cell, extra: 1 }).success).toBe(false);
    expect(StoneGridCellSchema.safeParse({ ...cell, trashed: undefined }).success).toBe(false);
  });
});

describe('StonePickSchema（§5 选中产出——结构化引用，不内嵌贴图数据）', () => {
  it('round-trip（含可选 gemshapeRef 关联）与缺省形态', () => {
    const pick = StonePickSchema.parse({
      resourceId: 'res-uuid-1',
      sku: 'J51',
      supplier: 'yuhang',
      sizeMm: 2,
      colorHex: '#FFFFF0',
      gemshapeRef: 'gem-round-seed',
    });
    expect(pick.gemshapeRef).toBe('gem-round-seed');
    expect(StonePickSchema.parse({ ...pick, gemshapeRef: undefined }).gemshapeRef).toBeUndefined();
  });
  it('坏选中拒绝：sizeMm 0 / 非法 hex / 未知字段', () => {
    const base = { resourceId: 'r', sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#FFFFF0' };
    expect(StonePickSchema.safeParse({ ...base, sizeMm: 0 }).success).toBe(false);
    expect(StonePickSchema.safeParse({ ...base, colorHex: 'FFFFF0' }).success).toBe(false);
    expect(StonePickSchema.safeParse({ ...base, textureDataUrl: 'x' }).success).toBe(false);
  });
});

describe('SubstituteQuerySchema（§9 sku | colorRgb+sizeMm 二选一）', () => {
  it('形态 A：sku 单给 + 默认 maxDeltaE=10/sizeToleranceMm=0.5', () => {
    const q = SubstituteQuerySchema.parse({ sku: 'J51' });
    expect(q).toMatchObject({ sku: 'J51', maxDeltaE: 10, sizeToleranceMm: 0.5 });
    expect('colorRgb' in q).toBe(false);
  });
  it('形态 B：colorRgb+sizeMm + 显式容差/supplier 过滤', () => {
    const q = SubstituteQuerySchema.parse({
      colorRgb: [255, 255, 240],
      sizeMm: 2,
      maxDeltaE: 5,
      sizeToleranceMm: 0.2,
      supplier: 'yuhang',
    });
    expect(q).toMatchObject({ colorRgb: [255, 255, 240], sizeMm: 2, supplier: 'yuhang' });
    expect('sku' in q).toBe(false);
  });
  it('二选一违规全拒：双给 / 仅 colorRgb / 双缺 / sku+sizeMm 混给 / sizeMm null', () => {
    for (const bad of [
      { sku: 'J51', colorRgb: [255, 255, 240], sizeMm: 2 },
      { colorRgb: [255, 255, 240] },
      {},
      { sku: 'J51', sizeMm: 2 },
      { colorRgb: [255, 255, 240], sizeMm: null },
    ]) {
      expect(SubstituteQuerySchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('CloudCatalogEntrySchema（§9.2 SS 云数据参考条目）', () => {
  it('rgb 可缺（降级=仅尺寸建议+色名提示）+ round-trip', () => {
    const withRgb = CloudCatalogEntrySchema.parse({
      system: 'ss',
      label: 'SS10',
      diameterMm: 2.8,
      colorName: 'Crystal AB',
      rgb: [255, 255, 255],
    });
    expect(withRgb.rgb).toEqual([255, 255, 255]);
    const noRgb = CloudCatalogEntrySchema.parse({ system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: 'Crystal' });
    expect(noRgb.rgb).toBeUndefined();
  });
  it('坏条目拒绝：非 ss 体系 / 非 SS 标签 / 越界 rgb', () => {
    expect(CloudCatalogEntrySchema.safeParse({ system: 'pp', label: 'SS10', diameterMm: 2.8, colorName: 'x' }).success).toBe(false);
    expect(CloudCatalogEntrySchema.safeParse({ system: 'ss', label: '10', diameterMm: 2.8, colorName: 'x' }).success).toBe(false);
    expect(
      CloudCatalogEntrySchema.safeParse({ system: 'ss', label: 'SS10', diameterMm: 2.8, colorName: 'x', rgb: [0, 0, 256] })
        .success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------- §9.2 SS 换算镜像

describe('SS 直径表镜像（engine grid.ts SS_TABLE 数值同源锁死）', () => {
  it('十三档数值=引擎字面（抄录基准：grid.ts L23-37，人工核对 2026-09-24）', () => {
    // engine grid.ts: SS6:2.0 SS8:2.4 SS10:2.8 SS12:3.0 SS14:3.5 SS16:4.0 SS18:4.3
    // SS20:4.8 SS22:5.2 SS24:5.3（中置信补档）SS26:5.8 SS30:6.4 SS34:7.1
    expect(SS_DIAMETER_TABLE).toEqual({
      SS6: 2.0,
      SS8: 2.4,
      SS10: 2.8,
      SS12: 3.0,
      SS14: 3.5,
      SS16: 4.0,
      SS18: 4.3,
      SS20: 4.8,
      SS22: 5.2,
      SS24: 5.3,
      SS26: 5.8,
      SS30: 6.4,
      SS34: 7.1,
    });
  });
  it('查表与最近档：SS→mm 直查；mm→SS 平局取小档（确定性）', () => {
    expect(ssSizeMm('SS10')).toBe(2.8);
    expect(ssSizeMm('SS24')).toBe(5.3);
    expect(nearestSs(2.8)).toEqual({ key: 'SS10', sizeMm: 2.8, deltaMm: 0 });
    expect(nearestSs(2.9).key).toBe('SS10'); // |2.9-2.8|=0.1 平局 |3.0-2.9|=0.1 → 表序靠前（小档）
    expect(nearestSs(2.95).key).toBe('SS12');
    const far = nearestSs(12); // 表外大值仍确定性钳到末档
    expect(far.key).toBe('SS34');
    expect(far.deltaMm).toBeCloseTo(4.9, 10);
  });
});
