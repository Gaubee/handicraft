/**
 * workbench 契约测试（add-task-detail-layer-workbench tasks 1.1——design 核心契约
 * 冻结面的 schema 把守）。覆盖：
 *   [1] task.detail 全字段往返（task/session/baseImage/tree/assignments/gems/preview——
 *       在场+null 两态；tree.nodes 含 inline mask 的 ObjectNode 结构校验）。
 *   [2] strict 面：多余字段必拒（六个 schema 各抽代表）。
 *   [3] segmentOne/layer.split 入出参（hint 长度界/blobs 64hex/children=ObjectNode[]）。
 *   [4] layer.strategy.set（strategyKind 七值枚举/stoneIdx 上界/出参二段）。
 *   [5] tree 版本历史（cause 三值枚举/版本行/null 电流）。
 *   [6] mask 二态贯通：ObjectNode inline 态过 + blob 态过（tree.nodes 不发明新格式）。
 */
import { describe, expect, it } from 'vitest';
import {
  encodeInlineMask,
  ObjectNodeSchema,
  StrategyAssignmentSchema,
  TaskDetailResponseSchema,
  LayerSplitInputSchema,
  LayerStrategySetInputSchema,
  LayerStrategySetOutputSchema,
  LayerRenameInputSchema,
  SegmentOneInputSchema,
  SegmentOneOutputSchema,
  TreeHistoryOutputSchema,
  TreeRevertInputSchema,
  WorkbenchWarningSchema,
  type ObjectNode,
  type TaskDetailResponse,
} from './index.js';

const REF = 'a'.repeat(64);
const REF2 = 'b'.repeat(64);

/** 最小合法节点（inline mask 2×2——ObjectNodeSchema 全字段）。 */
function node(overrides: Partial<ObjectNode> = {}): ObjectNode {
  return ObjectNodeSchema.parse({
    id: 'sam-node-0001',
    objectName: '帽子',
    category: 'hat',
    mask: encodeInlineMask(2, 2, new Uint8Array([1, 1, 1, 1])),
    bbox: { x: 0, y: 0, w: 2, h: 2 },
    parent: null,
    children: [],
    effectiveMm: 2,
    labVariance: 0,
    drillWorthy: true,
    origin: 'vlm+sam3',
    ...overrides,
  });
}

function detailResponse(): TaskDetailResponse {
  return {
    task: { id: 't1', title: '小丑贴钻', status: 'running', createdAt: '2026-09-26T00:00:00.000Z' },
    session: { id: 's1', title: '会话标题' },
    baseImage: { blobRef: REF, widthPx: 96, heightPx: 96, canvasCm: { w: 10, h: 10 } },
    tree: { blobRef: REF2, nodes: [node()] },
    assignments: [
      StrategyAssignmentSchema.parse({
        nodeId: 'sam-node-0001',
        strategyKind: 'texture-fill',
        params: { mode: 'scatter' },
        stones: [{ resourceId: 'r1', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828' }],
        rationale: '工作台直改',
      }),
    ],
    gems: { blobRef: REF, count: 12, excludedRegions: 1 },
    preview: { blobRef: REF2 },
  };
}

describe('task.detail 契约', () => {
  it('全字段在场往返', () => {
    const parsed = TaskDetailResponseSchema.parse(detailResponse());
    expect(parsed.tree?.nodes[0]?.objectName).toBe('帽子');
    expect(parsed.assignments[0]?.strategyKind).toBe('texture-fill');
    expect(parsed.gems?.count).toBe(12);
  });

  it('管线未跑齐的 null 降级面（tree/baseImage/gems/preview/session 可空，assignments 空数组）', () => {
    const parsed = TaskDetailResponseSchema.parse({
      ...detailResponse(),
      session: null,
      baseImage: null,
      tree: null,
      assignments: [],
      gems: null,
      preview: null,
    });
    expect(parsed.tree).toBeNull();
    expect(parsed.assignments).toEqual([]);
  });

  it('多余字段必拒（strict）', () => {
    expect(TaskDetailResponseSchema.safeParse({ ...detailResponse(), extra: 1 }).success).toBe(false);
  });
});

describe('strict 面（六 schema 代表）', () => {
  it('入参/出参多余字段均拒', () => {
    expect(LayerSplitInputSchema.safeParse({ taskId: 't', nodeId: 'n', hint: 'hat', x: 1 }).success).toBe(false);
    expect(SegmentOneInputSchema.safeParse({
      taskId: 't', imageBlobRef: REF, treeBlobRef: REF2, nodeId: 'n', hint: 'hat', x: 1,
    }).success).toBe(false);
    expect(LayerStrategySetInputSchema.safeParse({
      taskId: 't', nodeId: 'n', strategyKind: 'exclusion', params: {}, x: 1,
    }).success).toBe(false);
    expect(LayerRenameInputSchema.safeParse({ taskId: 't', nodeId: 'n', objectName: '帽子', x: 1 }).success).toBe(false);
    expect(TreeRevertInputSchema.safeParse({ taskId: 't', version: 1, x: 1 }).success).toBe(false);
    expect(SegmentOneOutputSchema.safeParse({
      children: [], treeBlobRef: REF, previewBlobRef: REF2, warnings: [], x: 1,
    }).success).toBe(false);
  });
});

describe('segmentOne / layer.split 契约', () => {
  it('入参 hint 空串/超长必拒，blobRef 非 64hex 必拒', () => {
    expect(LayerSplitInputSchema.safeParse({ taskId: 't', nodeId: 'n', hint: '' }).success).toBe(false);
    expect(LayerSplitInputSchema.safeParse({ taskId: 't', nodeId: 'n', hint: 'x'.repeat(501) }).success).toBe(false);
    expect(SegmentOneInputSchema.safeParse({
      taskId: 't', imageBlobRef: 'nothex', treeBlobRef: REF2, nodeId: 'n', hint: 'hat',
    }).success).toBe(false);
  });

  it('出参 children 含合法 ObjectNode（inline mask）+ warnings 结构', () => {
    const parsed = SegmentOneOutputSchema.parse({
      children: [node({ id: 'sam-node-0002', parent: 'sam-node-0001', objectName: 'hat' })],
      treeBlobRef: REF,
      previewBlobRef: REF2,
      warnings: [{ reason: 'score-missing', detail: '桥 segment 未回 score' }],
    });
    expect(parsed.children[0]?.mask.kind).toBe('inline');
    expect(WorkbenchWarningSchema.parse({ reason: 'r', detail: 'd' }).reason).toBe('r');
  });

  it('blob 态 mask 的节点同样入树（二态贯通——不发明新格式）', () => {
    const parsed = SegmentOneOutputSchema.parse({
      children: [node({ mask: { kind: 'blob', w: 2, h: 2, blobRef: REF } })],
      treeBlobRef: REF,
      previewBlobRef: REF2,
      warnings: [],
    });
    expect(parsed.children[0]?.mask.kind).toBe('blob');
  });
});

describe('layer.strategy.set 契约', () => {
  it('strategyKind 七值枚举外必拒；stoneIdx 越界必拒', () => {
    expect(LayerStrategySetInputSchema.safeParse({
      taskId: 't', nodeId: 'n', strategyKind: 'texture-fill', params: {}, stoneIdx: [1],
    }).success).toBe(true);
    expect(LayerStrategySetInputSchema.safeParse({
      taskId: 't', nodeId: 'n', strategyKind: 'magic', params: {},
    }).success).toBe(false);
    expect(LayerStrategySetInputSchema.safeParse({
      taskId: 't', nodeId: 'n', strategyKind: 'exclusion', params: {}, stoneIdx: [0],
    }).success).toBe(false);
    expect(LayerStrategySetInputSchema.safeParse({
      taskId: 't', nodeId: 'n', strategyKind: 'exclusion', params: {}, stoneIdx: [201],
    }).success).toBe(false);
  });

  it('出参 gems+preview 二段', () => {
    const parsed = LayerStrategySetOutputSchema.parse({
      gems: { blobRef: REF, count: 30 },
      preview: { blobRef: REF2 },
    });
    expect(parsed.gems.count).toBe(30);
  });
});

describe('tree 版本历史契约', () => {
  it('版本行 cause 三值 + null 电流', () => {
    const parsed = TreeHistoryOutputSchema.parse({
      versions: [
        { version: 1, cause: 'segment-one', detail: '拆出「帽子」', treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:00:00.000Z' },
        { version: 2, cause: 'rename', detail: null, treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:01:00.000Z' },
        { version: 3, cause: 'revert', detail: '回退到 v1', treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:02:00.000Z' },
      ],
      currentTreeBlobRef: REF,
      currentVersion: 3,
    });
    expect(parsed.versions.map((v) => v.cause)).toEqual(['segment-one', 'rename', 'revert']);
    expect(TreeHistoryOutputSchema.parse({ versions: [], currentTreeBlobRef: null, currentVersion: null }).versions).toEqual([]);
  });

  it('版本行非法 cause 必拒', () => {
    expect(TreeHistoryOutputSchema.safeParse({
      versions: [{ version: 1, cause: 'agent-loop', detail: null, treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:00:00.000Z' }],
      currentTreeBlobRef: null,
      currentVersion: null,
    }).success).toBe(false);
  });
});
