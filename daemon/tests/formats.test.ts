/**
 * 四族格式资源往返测试（design §6 护栏 MUST——W2.3）：.gemproj/.gemdoc/.gemtpl/.gemgen
 * 导入→server resource→导出，当前版本内语义无损（fixture 断言字段/资产引用/顺序/工程
 * 参数零丢失——深比较，不要求字节相等）；版本门（未来版本显式拒读；kind 不符拒绝；
 * 归属校验）。fixture 为四族 envelope 的最小真实形态（字段取自 persistence 层 schema
 * 的当前版本 v2/v3/v2/v2）。
 */
import { describe, expect, it } from 'vitest';
import { exportFormat, FormatError, importFormat, parseFormatEnvelope } from '../src/formats.js';
import { createUser } from '../src/db/store.js';
import { clientFor, createServices } from './helpers.js';

function doc(kind: string, formatVersion: number, extra: Record<string, unknown> = {}): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      kind,
      formatVersion,
      appVersion: '0.1.0',
      createdAt: 1758585600000,
      savedAt: 1758585600000,
      ...extra,
    }),
  );
}

/** 各族最小真实正文（字段名对齐 persistence 层 schema——顺序即声明序）。 */
function fixtures(): Record<string, Uint8Array> {
  return {
    'a.gemproj': doc('gemproj', 2, {
      name: '红心工程',
      source: { kind: 'embedded', dataUrl: 'data:image/png;base64,AAAA', mime: 'image/png', width: 96, height: 96, downscale: 1 },
      grid: { pitchMm: 3.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 8 },
      blocks: [{ id: 'blk-1', label: '红', colorRgb: [200, 16, 46], suggested: 'fill' }],
      strategy: 'hex-pitch',
      layers: [{ id: 'layer-1', name: 'L1', blockIds: ['blk-1'], visible: true, opacity: 1 }, { id: 'layer-rest', name: 'rest', blockIds: 'rest', visible: true, opacity: 1 }],
      physicalCanvas: { widthMm: 38.4, heightMm: 38.4, anchorSource: 'declared' },
    }),
    'b.gemdoc': doc('gemdoc', 3, {
      name: '设计师文档',
      grid: { pitchMm: 3.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 8 },
      palette: [{ id: 'red', name: '红', hex: '#C8102E' }],
      gems: [{ id: 'g00001', x: 10.5, y: 10.5, colorId: 'red', layerId: 'layer-1', blockId: 'blk-1', origin: 'layout', moved: false, shapeId: 'round', diameterMm: 3 }],
      layers: [{ id: 'layer-1', name: 'L1', visible: true, opacity: 1 }],
      underlay: { sources: [{ key: 'blocks', visible: true, opacity: 1 }] },
      referenceAssetId: null,
      paintingSnapshot: { width: 96, height: 96, data: '' },
    }),
    'c.gemtpl': doc('gemtpl', 2, {
      name: '红心模板',
      prompt: '生成一颗红心',
      variants: [{ id: 'v1', body: '红心，金色描边', enabled: true }],
      candidates: 4,
      gemSpecIds: ['round-ss10'],
      drillParams: { strategy: 'hex-pitch', gapMm: 0.4 },
    }),
    'd.gemgen': doc('gemgen', 2, {
      name: '红心生成稿',
      templateName: '红心模板',
      candidateIndex: 0,
      requestMode: 'generate',
      grid: { pitchMm: 3.4, gapMm: 0.4, rowAngleDeg: 0, pixelsPerMm: 8 },
      gemSpecs: [{ specKey: 'round-ss10', ordinal: 1, shapeId: 'round', sizeLabel: 'SS10', diameterMm: 3 }],
      provenance: { prompt: '红心' },
    }),
  };
}

describe('四族格式往返（W2.3 MUST）', () => {
  it('gemproj/gemdoc/gemtpl/gemgen：导入→resource→导出，语义无损（深比较零丢失）', () => {
    const s = createServices();
    try {
      for (const [filename, bytes] of Object.entries(fixtures())) {
        const imported = importFormat(s.db, s.blobs, s.anonymous.id, filename, bytes);
        expect(imported.kind).toBe(filename.slice(filename.lastIndexOf('.') + 1));
        expect(imported.revision).toBe(1);
        const exported = exportFormat(s.db, s.blobs, s.anonymous.id, imported.resourceId);
        expect(exported.filename).toBe(filename);
        // 语义无损：解析后深比较（字段/资产引用/顺序/工程参数零丢失）
        expect(JSON.parse(Buffer.from(exported.bytes).toString('utf8'))).toEqual(
          JSON.parse(Buffer.from(bytes).toString('utf8')),
        );
      }
    } finally {
      s.dispose();
    }
  });

  it('版本门：未来版本显式拒读（版本错误文案）；过旧版本无迁移链拒读', () => {
    expect(() => parseFormatEnvelope(doc('gemproj', 99), 'x.gemproj')).toThrow(FormatError);
    expect(() => parseFormatEnvelope(doc('gemproj', 99), 'x.gemproj')).toThrow('更新版本');
    expect(() => parseFormatEnvelope(doc('gemdoc', 1), 'x.gemdoc')).toThrow('版本过低');
    expect(() => parseFormatEnvelope(new Uint8Array([1, 2, 3]), 'x.gemproj')).toThrow(FormatError);
  });

  it('归属：他人资源导出必拒；非四族资源拒绝', async () => {
    const s = createServices();
    try {
      const [, bytes] = Object.entries(fixtures())[0]!;
      const imported = importFormat(s.db, s.blobs, s.anonymous.id, 'a.gemproj', bytes);
      const stranger = createUser(s.db, { username: 'stranger', passwordHash: 'x', role: 'user' });
      expect(() => exportFormat(s.db, s.blobs, stranger.id, imported.resourceId)).toThrow(FormatError);

      // RPC 面全链：import → export（base64 往返）
      const token = await s.tokenFor();
      const client = clientFor(s.context({ token }));
      const rpcImport = await client.resources.import({
        filename: 'a.gemproj',
        dataBase64: Buffer.from(bytes).toString('base64'),
      });
      expect(rpcImport.kind).toBe('gemproj');
      const rpcExport = await client.resources.export({ resourceId: rpcImport.resourceId });
      expect(rpcExport.kind).toBe('gemproj');
      expect(
        JSON.parse(Buffer.from(rpcExport.dataBase64, 'base64').toString('utf8')),
      ).toEqual(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } finally {
      s.dispose();
    }
  });

  it('P2-4 真实解析断言：四族导入后 server resource 关键字段非空且类型正确（DB 行 + envelope + 正文已知字段）', () => {
    const s = createServices();
    try {
      const expectations: Record<string, (doc: Record<string, unknown>) => void> = {
        'a.gemproj': (doc) => {
          expect(typeof doc['name']).toBe('string');
          // 资产引用（源图 embedded dataUrl）
          const source = doc['source'] as Record<string, unknown>;
          expect(source['kind']).toBe('embedded');
          expect(typeof source['dataUrl']).toBe('string');
          expect((source['dataUrl'] as string).length).toBeGreaterThan(0);
          expect(source['width']).toBe(96);
          expect(source['height']).toBe(96);
          // 工程参数（grid 派生入参）
          const grid = doc['grid'] as Record<string, unknown>;
          expect(typeof grid['pitchMm']).toBe('number');
          expect(typeof grid['gapMm']).toBe('number');
          expect(grid['rowAngleDeg']).toBe(0);
          // 资产引用列表长度（blocks/layers）
          expect((doc['blocks'] as unknown[]).length).toBeGreaterThanOrEqual(1);
          expect((doc['layers'] as unknown[]).length).toBeGreaterThanOrEqual(2);
          expect(typeof doc['strategy']).toBe('string');
        },
        'b.gemdoc': (doc) => {
          expect(typeof doc['name']).toBe('string');
          const palette = doc['palette'] as unknown[];
          expect(palette.length).toBeGreaterThanOrEqual(1);
          expect(typeof (palette[0] as Record<string, unknown>)['hex']).toBe('string');
          const gems = doc['gems'] as unknown[];
          expect(gems.length).toBeGreaterThanOrEqual(1);
          const gem = gems[0] as Record<string, unknown>;
          expect(typeof gem['x']).toBe('number');
          expect(typeof gem['colorId']).toBe('string');
          expect(gem['shapeId']).toBe('round');
          expect(typeof gem['diameterMm']).toBe('number');
          expect((doc['layers'] as unknown[]).length).toBeGreaterThanOrEqual(1);
          expect(typeof (doc['grid'] as Record<string, unknown>)['pitchMm']).toBe('number');
        },
        'c.gemtpl': (doc) => {
          expect(typeof doc['name']).toBe('string');
          expect(typeof doc['prompt']).toBe('string');
          const variants = doc['variants'] as unknown[];
          expect(variants.length).toBeGreaterThanOrEqual(1);
          expect(typeof (variants[0] as Record<string, unknown>)['body']).toBe('string');
          // 资产引用列表长度（钻规格引用）
          expect((doc['gemSpecIds'] as unknown[]).length).toBeGreaterThanOrEqual(1);
          const drill = doc['drillParams'] as Record<string, unknown>;
          expect(typeof drill['strategy']).toBe('string');
          expect(typeof drill['gapMm']).toBe('number');
        },
        'd.gemgen': (doc) => {
          expect(typeof doc['name']).toBe('string');
          const specs = doc['gemSpecs'] as unknown[];
          expect(specs.length).toBeGreaterThanOrEqual(1);
          const spec = specs[0] as Record<string, unknown>;
          expect(typeof spec['specKey']).toBe('string');
          expect(typeof spec['diameterMm']).toBe('number');
          expect(spec['shapeId']).toBe('round');
          expect(typeof (doc['grid'] as Record<string, unknown>)['pitchMm']).toBe('number');
          const provenance = doc['provenance'] as Record<string, unknown>;
          expect(typeof provenance['prompt']).toBe('string');
        },
      };

      for (const [filename, bytes] of Object.entries(fixtures())) {
        const kind = filename.slice(filename.lastIndexOf('.') + 1) as 'gemproj' | 'gemdoc' | 'gemtpl' | 'gemgen';
        const imported = importFormat(s.db, s.blobs, s.anonymous.id, filename, bytes);

        // DB 行关键字段：meta 投影（kind/版本/MIME）+ 内容寻址 + 归属 + 尺寸 + revision
        const row = s.db
          .prepare('SELECT * FROM resources WHERE id = ?')
          .get(imported.resourceId) as {
          owner_id: string;
          content_hash: string;
          size: number;
          meta: string;
          revision: number;
        };
        expect(row.owner_id).toBe(s.anonymous.id);
        expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/);
        expect(row.size).toBe(bytes.byteLength);
        expect(row.revision).toBe(1);
        const meta = JSON.parse(row.meta) as { kind: string; formatVersion: number; mime: string };
        expect(meta.kind).toBe(kind);
        expect(meta.formatVersion).toBe(imported.formatVersion);
        expect(meta.mime).toContain(kind);
        // blob 实体在库（内容寻址引用可解析）
        expect(s.blobs.read(row.content_hash)).not.toBeNull();

        // 导出字节解析（envelope 门 + 正文已知字段）
        const exported = exportFormat(s.db, s.blobs, s.anonymous.id, imported.resourceId);
        const envelope = parseFormatEnvelope(exported.bytes, filename);
        expect(envelope.kind).toBe(kind);
        expect(envelope.formatVersion).toBe(imported.formatVersion);
        expectations[filename]!(envelope.document);
      }
    } finally {
      s.dispose();
    }
  });

  it('P2-4 adversarial：对合法 fixture 的 kind/版本/扩展名篡改必拒（字节级变造后导入）', () => {
    const s = createServices();
    try {
      const [filename, bytes] = Object.entries(fixtures())[0]!;
      const original = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
      const rebytes = (mutated: Record<string, unknown>) =>
        new TextEncoder().encode(JSON.stringify(mutated));

      // 篡改 kind：未知值 / 族间互换（与扩展名不符）
      expect(() =>
        importFormat(s.db, s.blobs, s.anonymous.id, filename, rebytes({ ...original, kind: 'gemprojx' })),
      ).toThrow(FormatError);
      expect(() =>
        importFormat(s.db, s.blobs, s.anonymous.id, filename, rebytes({ ...original, kind: 'gemdoc' })),
      ).toThrow(FormatError);
      // 缺 kind
      const noKind = { ...original };
      delete noKind['kind'];
      expect(() => importFormat(s.db, s.blobs, s.anonymous.id, filename, rebytes(noKind))).toThrow(FormatError);

      // 篡改版本：未来版本（+1）/ 非整数 / 缺失
      const bumped = (original['formatVersion'] as number) + 1;
      expect(() =>
        importFormat(s.db, s.blobs, s.anonymous.id, filename, rebytes({ ...original, formatVersion: bumped })),
      ).toThrow(/更新版本/);
      expect(() =>
        importFormat(s.db, s.blobs, s.anonymous.id, filename, rebytes({ ...original, formatVersion: 1.5 })),
      ).toThrow(FormatError);
      const noVersion = { ...original };
      delete noVersion['formatVersion'];
      expect(() => importFormat(s.db, s.blobs, s.anonymous.id, filename, rebytes(noVersion))).toThrow(FormatError);

      // 全部拒绝后零残留（resources 零行）
      const count = (s.db.prepare('SELECT COUNT(*) AS n FROM resources').get() as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      s.dispose();
    }
  });
});
