/**
 * workbench 契约测试（add-task-detail-layer-workbench tasks 1.1——design 核心契约
 * 冻结面的 schema 把守）。覆盖：
 *   [1] task.detail 全字段往返（task/session/baseImage/tree/assignments/gems/preview——
 *       在场+null 两态；tree.nodes 含 inline mask 的 ObjectNode 结构校验）。
 *   [2] strict 面：多余字段必拒（六个 schema 各抽代表）。
 *   [3] segmentOne/layer.split 入出参（hint 长度界/blobs 64hex/children=ObjectNode[]）。
 *   [4] layer.strategy.set（strategyKind 七值枚举/stoneIdx 上界/出参二段）。
 *   [5] tree 版本历史（cause 六值枚举——波 2a 扩 reorder/delete/mask-patch/版本行/null 电流）。
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
  SegmentPrecisionSchema,
  AgentImagePreviewSchema,
  TreeRefineOutputSchema,
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
    // workbench-pro 波 2a 扩面（viewState/maskEdits/exportGate——降级面：无视图态/无编辑留痕/门开）
    viewState: null,
    maskEdits: [],
    exportGate: { allowed: true, blockers: [] },
    // v3 钻候选面（空数组=owner 无可用钻的降级面）
    stoneCandidates: [
      { idx: 1, resourceId: 'r1', sku: 'A52', supplier: 'yuhang', sizeMm: 3, colorHex: '#C82828', family: '圆钻' },
    ],
    // 项目钻清单摘要（W0 0.4：会话项目在场——lint 占位 null）
    projectStones: { revision: 3, entryCount: 2, sourceSetName: '夏季主色', lint: null },
  };
}

describe('task.detail 契约', () => {
  it('全字段在场往返', () => {
    const parsed = TaskDetailResponseSchema.parse(detailResponse());
    expect(parsed.tree?.nodes[0]?.objectName).toBe('帽子');
    expect(parsed.assignments[0]?.strategyKind).toBe('texture-fill');
    expect(parsed.gems?.count).toBe(12);
    expect(parsed.projectStones).toEqual({ revision: 3, entryCount: 2, sourceSetName: '夏季主色', lint: null });
  });

  it('管线未跑齐的 null 降级面（tree/baseImage/gems/preview/session/projectStones 可空，assignments 空数组）', () => {
    const parsed = TaskDetailResponseSchema.parse({
      ...detailResponse(),
      session: null,
      baseImage: null,
      tree: null,
      assignments: [],
      gems: null,
      preview: null,
      projectStones: null,
    });
    expect(parsed.tree).toBeNull();
    expect(parsed.assignments).toEqual([]);
    expect(parsed.projectStones).toBeNull();
  });

  it('projectStones（W0 0.4）：无集合 sourceSetName=null；lint 占位仅收 null 或摘要四计数', () => {
    expect(TaskDetailResponseSchema.safeParse({
      ...detailResponse(),
      projectStones: { revision: 1, entryCount: 0, sourceSetName: null, lint: null },
    }).success).toBe(true);
    // lint 摘要形状冻结（W3 填充态——服务端 W0 恒 null，形状先锁）
    expect(TaskDetailResponseSchema.safeParse({
      ...detailResponse(),
      projectStones: {
        revision: 2,
        entryCount: 1,
        sourceSetName: '夏季主色',
        lint: { computedAt: '2026-09-29T00:00:00.000Z', manifestRevision: 2, counts: { unintroduced: 1, unresolvable: 0, introduced: 3, unused: 2 } },
      },
    }).success).toBe(true);
    // revision 非正整数/缺 lint 键/多余键——均拒
    expect(TaskDetailResponseSchema.safeParse({
      ...detailResponse(),
      projectStones: { revision: 0, entryCount: 0, sourceSetName: null, lint: null },
    }).success).toBe(false);
    expect(TaskDetailResponseSchema.safeParse({
      ...detailResponse(),
      projectStones: { revision: 1, entryCount: 0, sourceSetName: null },
    }).success).toBe(false);
    expect(TaskDetailResponseSchema.safeParse({
      ...detailResponse(),
      projectStones: { revision: 1, entryCount: 0, sourceSetName: null, lint: null, extra: 1 },
    }).success).toBe(false);
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
  });

  it('rename relation 重分类：合法枚举放行，白名单外/多余字段必拒', () => {
    // v6 复核 P1-1：B2 重分类升级动作的契约面——refinement↔semantic 显式互转。
    expect(LayerRenameInputSchema.safeParse({ taskId: 't', nodeId: 'n', objectName: '左手', relation: 'semantic' }).success).toBe(true);
    expect(LayerRenameInputSchema.safeParse({ taskId: 't', nodeId: 'n', objectName: '小丑·部分1', relation: 'refinement' }).success).toBe(true);
    expect(LayerRenameInputSchema.safeParse({ taskId: 't', nodeId: 'n', objectName: '帽子', relation: 'group' }).success).toBe(false);
    expect(LayerRenameInputSchema.safeParse({ taskId: 't', nodeId: 'n', objectName: '帽子', relation: 'semantic', reclassify: true }).success).toBe(false);
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

  it('出参 gems+preview 二段（lint 可缺省——W3 3.1 增投影；真身恒带）', () => {
    const parsed = LayerStrategySetOutputSchema.parse({
      gems: { blobRef: REF, count: 30 },
      preview: { blobRef: REF2 },
    });
    expect(parsed.gems.count).toBe(30);
    expect(parsed.lint).toBeUndefined();
    // lint 在场：summary+items 二段（null=无项目语义）。
    const withLint = LayerStrategySetOutputSchema.parse({
      gems: { blobRef: REF, count: 30 },
      preview: { blobRef: REF2 },
      lint: {
        summary: {
          computedAt: '2026-09-29T00:00:00.000Z',
          manifestRevision: 1,
          counts: { unintroduced: 1, unresolvable: 0, introduced: 2, unused: 3 },
        },
        items: [
          { category: 'unintroduced', stoneRef: 'stn-x', sku: 'J51', supplier: 'yuhang', nodeIds: ['n1'] },
        ],
      },
    });
    expect(withLint.lint?.summary.counts.unintroduced).toBe(1);
    expect(withLint.lint?.items[0]?.category).toBe('unintroduced');
    const nullLint = LayerStrategySetOutputSchema.parse({
      gems: { blobRef: REF, count: 0 },
      preview: { blobRef: REF2 },
      lint: null,
    });
    expect(nullLint.lint).toBeNull();
  });
});

describe('tree 版本历史契约', () => {
  it('版本行 cause 六值（波 2a 扩 reorder/delete/mask-patch）+ null 电流', () => {
    const parsed = TreeHistoryOutputSchema.parse({
      versions: [
        { version: 1, cause: 'segment-one', detail: '拆出「帽子」', treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:00:00.000Z' },
        { version: 2, cause: 'rename', detail: null, treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:01:00.000Z' },
        { version: 3, cause: 'reorder', detail: '「帽子」→「主体」第 0 位', treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:02:00.000Z' },
        { version: 4, cause: 'delete', detail: '删除「草地区域」子树', treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:03:00.000Z' },
        { version: 5, cause: 'mask-patch', detail: '笔刷编辑「帽子」（2 笔）', treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:04:00.000Z' },
        { version: 6, cause: 'revert', detail: '回退到 v1', treeBlobRef: REF, previewBlobRef: REF2, createdAt: '2026-09-26T00:05:00.000Z' },
      ],
      currentTreeBlobRef: REF,
      currentVersion: 6,
    });
    expect(parsed.versions.map((v) => v.cause)).toEqual([
      'segment-one', 'rename', 'reorder', 'delete', 'mask-patch', 'revert',
    ]);
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

describe('SegmentPrecision / AgentImagePreview（add-vision-pipeline-v2 D3/D5）', () => {
  it('SegmentPrecision：两字段可选+strict；maskMaxSide ≥32 整数、confThreshold 0..1 把守', () => {
    expect(SegmentPrecisionSchema.safeParse({}).success).toBe(true);
    expect(SegmentPrecisionSchema.safeParse({ maskMaxSide: 1536 }).success).toBe(true);
    expect(SegmentPrecisionSchema.safeParse({ maskMaxSide: 1536, confThreshold: 0.3 }).success).toBe(true);
    expect(SegmentPrecisionSchema.safeParse({ maskMaxSide: 16 }).success).toBe(false); // 服务端护栏下界
    expect(SegmentPrecisionSchema.safeParse({ maskMaxSide: 1.5 }).success).toBe(false); // 非整数
    expect(SegmentPrecisionSchema.safeParse({ confThreshold: 1.2 }).success).toBe(false);
    expect(SegmentPrecisionSchema.safeParse({ extra: 1 }).success).toBe(false); // strict
  });

  it('AgentImagePreview：全字段 strict 合法；blobRef 非 64hex/缺 dataBase64 必拒', () => {
    const ok = {
      kind: 'node-mask',
      nodeId: 'sam-node-0002',
      objectName: '右发',
      reason: 'mask-parent-iou',
      blobRef: REF,
      mime: 'image/png',
      maxSide: 512,
      dataBase64: 'aGVsbG8=',
    };
    expect(AgentImagePreviewSchema.safeParse(ok).success).toBe(true);
    expect(AgentImagePreviewSchema.safeParse({ ...ok, blobRef: 'xyz' }).success).toBe(false);
    expect(AgentImagePreviewSchema.safeParse({ ...ok, dataBase64: undefined }).success).toBe(false);
    expect(AgentImagePreviewSchema.safeParse({ ...ok, extra: 1 }).success).toBe(false);
  });

  it('SegmentOneOutput/TreeRefineOutput 的 agentImagePreviews 可选——缺席=旧形态兼容', () => {
    const legacy = {
      children: [node({ id: 'sam-node-0002', parent: 'sam-node-0001', objectName: 'hat', segmentPrompt: 'hat' })],
      treeBlobRef: REF,
      previewBlobRef: REF2,
      warnings: [],
    };
    expect(SegmentOneOutputSchema.safeParse(legacy).success).toBe(true); // 旧形态（无预览）
    expect(SegmentOneOutputSchema.safeParse({
      ...legacy,
      agentImagePreviews: [{
        kind: 'node-mask', nodeId: 'sam-node-0002', reason: 'mask-parent-iou',
        blobRef: REF, mime: 'image/png', maxSide: 512, dataBase64: 'aGVsbG8=',
      }],
    }).success).toBe(true);
    expect(TreeRefineOutputSchema.safeParse({
      treeBlobRef: REF,
      previewBlobRef: REF2,
      versions: [1],
      children: [],
      warnings: [],
    }).success).toBe(true);
    expect(TreeRefineOutputSchema.safeParse({
      treeBlobRef: REF,
      previewBlobRef: REF2,
      versions: [1],
      children: [],
      warnings: [],
      agentImagePreviews: [{ kind: 'tree-overlay', blobRef: REF, mime: 'image/png', maxSide: 512, dataBase64: 'aGVsbG8=' }],
    }).success).toBe(true);
  });
});

describe('layer.split 试跑契约（add-vision-pipeline-v2 T5/D6——dryRun/precision/layerName/trial 面）', () => {
  const base = { taskId: 't-1', nodeId: 'sam-node-0001', hint: '把帽子拆出来' };

  it('LayerSplitInput：三新字段全可选（旧形态零变化）+precision 单源把守+layerName 界', () => {
    expect(LayerSplitInputSchema.safeParse(base).success).toBe(true); // 旧形态
    expect(LayerSplitInputSchema.safeParse({ ...base, dryRun: true }).success).toBe(true);
    expect(LayerSplitInputSchema.safeParse({ ...base, precision: { maskMaxSide: 1536, confThreshold: 0.35 } }).success).toBe(true);
    expect(LayerSplitInputSchema.safeParse({ ...base, layerName: '右发' }).success).toBe(true);
    expect(LayerSplitInputSchema.safeParse({ ...base, precision: { maskMaxSide: 16 } }).success).toBe(false); // D3 护栏复用
    expect(LayerSplitInputSchema.safeParse({ ...base, layerName: '' }).success).toBe(false); // min(1)
    expect(LayerSplitInputSchema.safeParse({ ...base, layerName: 'x'.repeat(65) }).success).toBe(false);
    expect(LayerSplitInputSchema.safeParse({ ...base, dryRun: 'yes' }).success).toBe(false);
    expect(LayerSplitInputSchema.safeParse({ ...base, extra: 1 }).success).toBe(false); // strict
  });

  it('LayerSplitInput.trialTreeBlobRef（Codex R1 P1）：可选试跑基线树引用——blob 形把守，旧形态零变化', () => {
    expect(LayerSplitInputSchema.safeParse({ ...base, trialTreeBlobRef: REF }).success).toBe(true); // 确认携带试跑基线
    expect(LayerSplitInputSchema.safeParse({ ...base, dryRun: true, trialTreeBlobRef: REF }).success).toBe(true); // 试跑带=服务端忽略（schema 容忍）
    expect(LayerSplitInputSchema.safeParse({ ...base, trialTreeBlobRef: 'short' }).success).toBe(false); // 非 blob 形
    expect(LayerSplitInputSchema.safeParse({ ...base, trialTreeBlobRef: 42 }).success).toBe(false);
  });

  it('SegmentOneInput 同构三字段（内核面/RPC 面同源）', () => {
    const kernelBase = {
      taskId: 't-1',
      imageBlobRef: REF,
      treeBlobRef: REF2,
      nodeId: 'sam-node-0001',
      hint: 'hat',
    };
    expect(SegmentOneInputSchema.safeParse(kernelBase).success).toBe(true);
    expect(SegmentOneInputSchema.safeParse({ ...kernelBase, dryRun: true, precision: {}, layerName: '右发' }).success).toBe(true);
    expect(SegmentOneInputSchema.safeParse({ ...kernelBase, precision: { confThreshold: 2 } }).success).toBe(false);
  });

  it('SegmentOneOutput.trial：dryRun 面可选在场——缺席=旧落地形态兼容；trial 内 strict', () => {
    const legacy = {
      children: [node({ id: 'sam-node-0002', parent: 'sam-node-0001' })],
      treeBlobRef: REF,
      previewBlobRef: REF2,
      warnings: [],
    };
    expect(SegmentOneOutputSchema.safeParse(legacy).success).toBe(true); // 落地形态
    const trial = {
      ...legacy,
      trial: {
        preview: { kind: 'trial-mask-overlay', nodeId: 'sam-node-0001', blobRef: REF2, mime: 'image/png' as const, maxSide: 512, dataBase64: 'aGVsbG8=' },
        replayed: false,
      },
    };
    expect(SegmentOneOutputSchema.safeParse(trial).success).toBe(true); // 试跑形态
    expect(SegmentOneOutputSchema.safeParse({ ...trial, trial: { ...trial.trial, extra: 1 } }).success).toBe(false); // strict
    expect(SegmentOneOutputSchema.safeParse({ ...trial, trial: { preview: trial.trial.preview } }).success).toBe(false); // replayed 必填
  });
});
