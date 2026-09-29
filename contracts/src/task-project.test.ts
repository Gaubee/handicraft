/**
 * 项目域契约测试（add-task-stones-manifest-export 0.1——W0 冻结面）：
 *   [1] StonesManifest：往返/复制语义边界（stoneRef≡pick.resourceId、origin=set
 *       溯源锚）/CAS 字段语义（revision 正整数——0 为无行内存约定不落盘）。
 *   [2] StoneLint：四分类值域+三源锚（manifestRevision/planRef/sourceTaskId/imageId）。
 *   [3] TaskLayout：渲染快照最小真值（gems 物料身份+custom 形资产闭合+块引用闭合）。
 *   [4] imageId 稳定分配规则（A5 裁定：仅首条常规 followup 分配——纯函数确定性）。
 *   [5] GEM_SHAPE_IDS 引擎镜像锁（contracts 不 import 引擎——字面量断言，
 *       paving.test.ts STRATEGY_IDS 同纪律；真源 engine spec.ts SHAPE_IDS）。
 */
import { describe, expect, it } from 'vitest';
import {
  GEM_SHAPE_IDS,
  StonesManifestSchema,
  StoneLintSchema,
  TaskImageIdSchema,
  TaskLayoutSchema,
  assignTaskImageIds,
  encodeInlineMask,
  taskLayoutArtifactName,
  type StonesManifest,
  type TaskLayout,
} from './index.js';

const REF = 'a'.repeat(64);
const REF2 = 'b'.repeat(64);

/** 未校验 manifest 草稿（负例改造后再整体 safeParse——工厂不做前置 parse）。 */
function manifestDraft(overrides: Partial<StonesManifest> = {}): StonesManifest {
  return {
    kind: 'stones-manifest',
    formatVersion: 1,
    projectId: 'sess-1',
    updatedByTaskId: 'task-1',
    revision: 1,
    updatedAt: '2026-09-29T00:00:00.000Z',
    sourceSet: { resourceId: 'res-1', setId: 'set-1', setRevision: 7, name: '夏季主色' },
    entries: [
      {
        stoneRef: 'stn-1',
        pick: { resourceId: 'stn-1', sku: 'J51', supplier: 'yuhang', sizeMm: 2, colorHex: '#AABBCC', gemshapeRef: 'gs-1' },
        stoneRevision: 4,
        stoneJsonBlobRef: REF,
        textureBlobRef: REF2,
        shapeAssetBlobRef: REF,
        quantity: 120,
        note: '备料参考',
        origin: 'set',
      },
      {
        stoneRef: 'stn-2',
        pick: { resourceId: 'stn-2', sku: 'J76', supplier: 'yuhang', sizeMm: 12, colorHex: '#FF0000' },
        stoneRevision: 1,
        stoneJsonBlobRef: REF2,
        textureBlobRef: REF,
        shapeAssetBlobRef: null,
        quantity: 30,
        origin: 'manual-add',
      },
    ],
    ...overrides,
  };
}

function manifest(overrides: Partial<StonesManifest> = {}): StonesManifest {
  return StonesManifestSchema.parse(manifestDraft(overrides));
}

describe('StonesManifestSchema（A1 复制/展开语义）', () => {
  it('全字段在场往返（集合展开+手工追加并存）', () => {
    const parsed = manifest();
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.origin).toBe('set');
    expect(parsed.entries[1]?.origin).toBe('manual-add');
    expect(parsed.sourceSet?.setRevision).toBe(7);
  });

  it('跳过集合：sourceSet=null + entries=[]（revision 仍 1 起——空项目合法）', () => {
    const parsed = manifest({ sourceSet: null, entries: [] });
    expect(parsed.entries).toEqual([]);
    expect(parsed.sourceSet).toBeNull();
  });

  it('CAS 字段语义：revision 正整数（0/负数/浮点/非整数均拒）', () => {
    expect(manifest({ revision: 2 }).revision).toBe(2);
    expect(StonesManifestSchema.safeParse(manifestDraft({ revision: 0 })).success).toBe(false);
    expect(StonesManifestSchema.safeParse(manifestDraft({ revision: -1 })).success).toBe(false);
    expect(StonesManifestSchema.safeParse(manifestDraft({ revision: 1.5 })).success).toBe(false);
  });

  it('kind/formatVersion 冻结（他值必拒）', () => {
    expect(StonesManifestSchema.safeParse(manifestDraft({ kind: 'stone-set' as never })).success).toBe(false);
    expect(StonesManifestSchema.safeParse(manifestDraft({ formatVersion: 2 as never })).success).toBe(false);
  });

  it('多余字段必拒（strict——含条目级）', () => {
    expect(StonesManifestSchema.safeParse({ ...manifest(), extra: 1 }).success).toBe(false);
    const withExtra = manifest();
    expect(StonesManifestSchema.safeParse({ ...withExtra, entries: [{ ...withExtra.entries[0]!, extra: 1 }, withExtra.entries[1]!] }).success).toBe(false);
  });

  it('stoneRef ≡ pick.resourceId（全局身份键与物化快照不一致必拒）', () => {
    const bad = manifest();
    bad.entries[0]!.stoneRef = 'stn-other';
    expect(StonesManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('stoneRef 重复条目必拒（首波单来源——A2 合并歧义不引入）', () => {
    const dup = manifest();
    dup.entries[1]!.stoneRef = dup.entries[0]!.stoneRef;
    dup.entries[1]!.pick = { ...dup.entries[1]!.pick, resourceId: dup.entries[0]!.stoneRef };
    expect(StonesManifestSchema.safeParse(dup).success).toBe(false);
  });

  it('origin=set 条目要求 sourceSet 非空（溯源锚闭合）', () => {
    expect(StonesManifestSchema.safeParse(manifestDraft({ sourceSet: null })).success).toBe(false);
    // 全 manual-add + 无集合：合法（纯手工项目）
    expect(
      StonesManifestSchema.safeParse(manifestDraft({ sourceSet: null, entries: [manifestDraft().entries[1]!] })).success,
    ).toBe(true);
  });

  it('quantity 非负整数（0=未设置备料参考——W1 裁定：与 sets 缺省对齐，缺 quantity 成员物化 0 而非拒任务；负数必拒）；blob 引用 sha256 形', () => {
    const zero = manifest();
    zero.entries[0]!.quantity = 0;
    expect(StonesManifestSchema.safeParse(zero).success).toBe(true);
    const neg = manifest();
    neg.entries[0]!.quantity = -1;
    expect(StonesManifestSchema.safeParse(neg).success).toBe(false);
    const badRef = manifest();
    badRef.entries[0]!.textureBlobRef = 'nothex';
    expect(StonesManifestSchema.safeParse(badRef).success).toBe(false);
  });
});

describe('StoneLintSchema（A3 四分类+锚）', () => {
  function lint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind: 'stones-lint',
      formatVersion: 1,
      manifestRevision: 3,
      planRef: REF,
      sourceTaskId: 'task-9',
      imageId: 'image-2',
      items: [
        { category: 'unintroduced', stoneRef: 'stn-5', sku: 'J52', supplier: 'yuhang', nodeIds: ['sam-node-0001', 'sam-node-0002'] },
        { category: 'unresolvable', stoneRef: 'stn-gone', nodeIds: [] },
        { category: 'introduced', stoneRef: 'stn-1', sku: 'J51', supplier: 'yuhang', nodeIds: ['sam-node-0003'] },
        { category: 'unused', stoneRef: 'stn-2', nodeIds: [] },
      ],
      computedAt: '2026-09-29T00:00:00.000Z',
      ...overrides,
    };
  }

  it('四分类全值域往返（条目明细 sku/supplier/nodeIds）', () => {
    const parsed = StoneLintSchema.parse(lint());
    expect(parsed.items.map((item) => item.category)).toEqual(['unintroduced', 'unresolvable', 'introduced', 'unused']);
  });

  it('分类白名单外必拒；锚字段缺失/畸形必拒', () => {
    expect(StoneLintSchema.safeParse(lint({ items: [{ category: 'warning', stoneRef: 's', nodeIds: [] }] })).success).toBe(false);
    expect(StoneLintSchema.safeParse(lint({ manifestRevision: 0 })).success).toBe(false);
    expect(StoneLintSchema.safeParse(lint({ planRef: 'zz' })).success).toBe(false);
    expect(StoneLintSchema.safeParse(lint({ imageId: 'image-0' })).success).toBe(false);
    expect(StoneLintSchema.safeParse({ ...lint(), unknownAnchor: 1 }).success).toBe(false);
  });
});

describe('TaskLayoutSchema（B2 渲染快照）', () => {
  /** 未校验 layout 草稿（负例改造后再整体 safeParse——同 manifestDraft 纪律）。 */
  function layoutDraft(overrides: Partial<TaskLayout> = {}): TaskLayout {
    return {
      kind: 'task-layout',
      formatVersion: 1,
      source: {
        projectId: 'sess-1',
        sourceTaskId: 'task-9',
        imageId: 'image-1',
        planRef: REF,
        treeRef: REF2,
        manifestRevision: 3,
      },
      imageWidth: 960,
      imageHeight: 720,
      canvasCm: { w: 20, h: 15 },
      grid: { pixelsPerMm: 4.8, gapMm: 0.4, baseSpec: { shapeId: 'round', diameterMm: 2.8 } },
      palette: { c1: { name: '象牙白', hex: '#FFFFF0' } },
      blocks: [
        { id: 'blk-1', bbox: { x: 0, y: 0, w: 960, h: 720 } },
        { id: 'blk-2', bbox: { x: 10, y: 10, w: 100, h: 100 }, mask: encodeInlineMask(2, 2, new Uint8Array([1, 0, 0, 1])) },
      ],
      gems: [
        { id: 'g1', x: 10, y: 10, blockId: 'blk-1', shapeId: 'round', diameterMm: 2.8, stoneRef: 'stn-1', sku: 'J51', supplier: 'yuhang', colorHex: '#AABBCC' },
        {
          id: 'g2', x: 20, y: 20, blockId: 'blk-2', shapeId: 'custom', diameterMm: 3.2, rotationDeg: 45, assetId: 'asset-9',
          stoneRef: 'stn-2', sku: 'J76', supplier: 'yuhang', colorHex: '#FF0000',
        },
      ],
      shapeAssets: { 'asset-9': REF2 },
      ...overrides,
    };
  }

  function layout(overrides: Partial<TaskLayout> = {}): TaskLayout {
    return TaskLayoutSchema.parse(layoutDraft(overrides));
  }

  it('全字段往返（物料身份+custom 形资产闭合）', () => {
    const parsed = layout();
    expect(parsed.gems[1]?.assetId).toBe('asset-9');
    expect(parsed.shapeAssets['asset-9']).toBe(REF2);
    expect(parsed.source.imageId).toBe('image-1');
  });

  it('工件文件名按 imageId（task-layout.<imageId>.json——多图不覆盖）', () => {
    expect(taskLayoutArtifactName('image-1')).toBe('task-layout.image-1.json');
    expect(taskLayoutArtifactName('image-12')).toBe('task-layout.image-12.json');
  });

  it('gem.blockId 必在 blocks（引用闭合）', () => {
    const bad = layoutDraft();
    bad.gems[0]!.blockId = 'blk-none';
    expect(TaskLayoutSchema.safeParse(bad).success).toBe(false);
  });

  it('custom 形必带 assetId 且 shapeAssets 有 blob（engine customAssetIdMissing 同构）', () => {
    const noAsset = layoutDraft();
    noAsset.gems[0]!.shapeId = 'custom';
    expect(TaskLayoutSchema.safeParse(noAsset).success).toBe(false);
    const noBlob = layoutDraft();
    noBlob.shapeAssets = {};
    expect(TaskLayoutSchema.safeParse(noBlob).success).toBe(false);
  });

  it('block/gem id 重复必拒；palette hex 小写必拒（大写口径冻结）', () => {
    const dupBlock = layoutDraft();
    dupBlock.blocks[1]!.id = 'blk-1';
    expect(TaskLayoutSchema.safeParse(dupBlock).success).toBe(false);
    const dupGem = layoutDraft();
    dupGem.gems[1]!.id = 'g1';
    expect(TaskLayoutSchema.safeParse(dupGem).success).toBe(false);
    const lower = layoutDraft();
    lower.palette = { c1: { name: '象牙白', hex: '#fffff0' } };
    expect(TaskLayoutSchema.safeParse(lower).success).toBe(false);
  });

  it('空 gems/空 blocks 合法（全排除图可表示）；grid 边界（gapMm=0 相切、pixelsPerMm 正数）', () => {
    expect(TaskLayoutSchema.safeParse(layoutDraft({ gems: [], blocks: [] })).success).toBe(true);
    expect(TaskLayoutSchema.safeParse(layoutDraft({ grid: { pixelsPerMm: 4.8, gapMm: 0, baseSpec: { shapeId: 'round', diameterMm: 2.8 } } })).success).toBe(true);
    expect(TaskLayoutSchema.safeParse(layoutDraft({ grid: { pixelsPerMm: 0, gapMm: 0.4, baseSpec: { shapeId: 'round', diameterMm: 2.8 } } })).success).toBe(false);
  });
});

describe('imageId 稳定分配（A5 裁定冻结）', () => {
  it('按附件输入顺序 1 基单调分配（首条常规 followup 主图集）', () => {
    expect(assignTaskImageIds(0)).toEqual([]);
    expect(assignTaskImageIds(3)).toEqual(['image-1', 'image-2', 'image-3']);
  });

  it('非法输入显式拒（负数/非整数——不猜测）', () => {
    expect(() => assignTaskImageIds(-1)).toThrow(RangeError);
    expect(() => assignTaskImageIds(1.5)).toThrow(RangeError);
  });

  it('线格式：前导零/0 起必拒（确定性键空间）', () => {
    expect(TaskImageIdSchema.safeParse('image-1').success).toBe(true);
    expect(TaskImageIdSchema.safeParse('image-10').success).toBe(true);
    expect(TaskImageIdSchema.safeParse('image-0').success).toBe(false);
    expect(TaskImageIdSchema.safeParse('image-01').success).toBe(false);
    expect(TaskImageIdSchema.safeParse('img-1').success).toBe(false);
  });
});

describe('GEM_SHAPE_IDS 引擎镜像锁', () => {
  it('六值字面量与 engine spec.ts SHAPE_IDS 逐字面一致（2026-09-29 抄录）', () => {
    expect(GEM_SHAPE_IDS).toEqual(['round', 'square', 'drop', 'heart', 'marquise', 'custom']);
  });
});
