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
});
