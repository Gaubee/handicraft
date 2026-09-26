/**
 * workbench-pro 波 2a 契约冻结测试（add-workbench-pro design §1——Codex 二轮
 * CONDITIONAL-GO 放行条件的契约面固化）。覆盖：
 *   [1] 三写 RPC 入出参（layer.reorder/layer.delete/layer.mask.patch）：CAS 基线
 *       必填+版本返回三件套+strict 面（多余字段必拒）。
 *   [2] 笔迹界（radius/points/ops 上界与下界——越界必拒）。
 *   [3] mask 编辑状态机：五态枚举冻结+MaskEditStatus 结构（incomplete/error 面）。
 *   [4] 导出门：三阻断因子枚举+allowed 联动形状（纯结构——联动语义 daemon 测试固化）。
 *   [5] view-state：全量快照工件+revision 链+重复 nodeId 拒+CAS 基线可选语义。
 *   [6] task.detail 扩面：viewState/maskEdits/exportGate 三新字段往返+null/空降级。
 *   [7] 冻结常量：4096 行程上限+错误码枚举成员清单（增删=契约变更——显式断言）。
 */
import { describe, expect, it } from 'vitest';
import {
  BrushStrokeSchema,
  EXPORT_BLOCKER_SCHEMA,
  ExportGateSchema,
  LayerDeleteInputSchema,
  LayerDeleteOutputSchema,
  LayerMaskPatchInputSchema,
  LayerMaskPatchOutputSchema,
  LayerReorderInputSchema,
  LayerReorderOutputSchema,
  MASK_EDIT_STATE_SCHEMA,
  MaskEditStatusSchema,
  TREE_VERSION_CAUSE_SCHEMA,
  ViewStateSchema,
  ViewStateSetInputSchema,
  ViewStateSetOutputSchema,
  WORKBENCH_BRUSH_POINTS_MAX,
  WORKBENCH_BRUSH_RADIUS_MAX_PX,
  WORKBENCH_MASK_OPS_MAX,
  WORKBENCH_MASK_RUN_LIMIT,
  WORKBENCH_VIEW_STATE_ARTIFACT_NAME,
  WORKBENCH_WRITE_ERROR_CODE_SCHEMA,
  TaskDetailResponseSchema,
  TaskExportInputSchema,
  TaskExportOutputSchema,
} from './index.js';

const REF = 'a'.repeat(64);
const REF2 = 'b'.repeat(64);

function stroke(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { op: 'add', radiusPx: 4, points: [{ x: 10, y: 10 }, { x: 12, y: 12 }], ...overrides };
}

describe('三写 RPC 入出参（波 2a 冻结面）', () => {
  it('layer.reorder：CAS 基线+版本返回三件套往返；strict 多余字段拒', () => {
    const input = LayerReorderInputSchema.parse({
      taskId: 't1', nodeId: 'n-hat', newParentId: 'n-root', index: 0, expectedTreeBlobRef: REF,
    });
    expect(input.index).toBe(0);
    expect(LayerReorderInputSchema.safeParse({
      taskId: 't1', nodeId: 'n-hat', newParentId: 'n-root', index: 0, x: 1,
    }).success).toBe(false); // 缺 CAS 基线+多余字段
    expect(LayerReorderInputSchema.safeParse({
      taskId: 't1', nodeId: 'n-hat', newParentId: 'n-root', index: -1, expectedTreeBlobRef: REF,
    }).success).toBe(false);
    const out = LayerReorderOutputSchema.parse({
      treeBlobRef: REF, previewBlobRef: REF2, version: 4,
    });
    expect(out.version).toBe(4);
    expect(LayerReorderOutputSchema.safeParse({ treeBlobRef: REF, version: 1 }).success).toBe(false);
  });

  it('layer.delete：入参三字段+子树/指派/gems 出参往返', () => {
    const out = LayerDeleteOutputSchema.parse({
      treeBlobRef: REF,
      previewBlobRef: REF2,
      version: 5,
      removedNodeIds: ['n-person', 'n-hat'],
      removedAssignmentNodeIds: ['n-person'],
      gems: { blobRef: REF, count: 0 },
    });
    expect(out.removedNodeIds).toHaveLength(2);
    // 无 plan/空收敛降级面：gems=null
    const bare = LayerDeleteOutputSchema.parse({
      treeBlobRef: REF, previewBlobRef: REF2, version: 5,
      removedNodeIds: ['n-hat'], removedAssignmentNodeIds: [], gems: null,
    });
    expect(bare.gems).toBeNull();
    expect(LayerDeleteInputSchema.safeParse({ taskId: 't1', nodeId: 'n' }).success).toBe(false); // CAS 必填
    expect(LayerDeleteOutputSchema.safeParse({
      treeBlobRef: REF, previewBlobRef: REF2, version: 5,
      removedNodeIds: [], removedAssignmentNodeIds: [], gems: null, // 空子树非法（至少目标自身）
    }).success).toBe(false);
  });

  it('layer.mask.patch：recomputeStrategy 缺省 false+闭环出参（node 摘要/行程/状态机/gems）', () => {
    const input = LayerMaskPatchInputSchema.parse({
      taskId: 't1', nodeId: 'n-hat', ops: [stroke()], expectedTreeBlobRef: REF,
    });
    expect(input.recomputeStrategy).toBe(false);
    const out = LayerMaskPatchOutputSchema.parse({
      treeBlobRef: REF,
      previewBlobRef: REF2,
      version: 6,
      node: { bbox: { x: 30, y: 4, w: 20, h: 12 }, effectiveMm: 15.5 },
      maskRunCount: 320,
      incomplete: false,
      editState: 'ready',
      gems: { blobRef: REF2, count: 42 },
    });
    expect(out.editState).toBe('ready');
    expect(LayerMaskPatchOutputSchema.parse({
      ...out, gems: null, editState: 'error', incomplete: true,
    }).incomplete).toBe(true);
  });
});

describe('笔迹界（BrushStroke）', () => {
  it('op 两值；radius 正数≤128；points 1..512；ops 1..16', () => {
    expect(BrushStrokeSchema.safeParse(stroke({ op: 'remove' })).success).toBe(true);
    expect(BrushStrokeSchema.safeParse(stroke({ op: 'erase' })).success).toBe(false);
    expect(BrushStrokeSchema.safeParse(stroke({ radiusPx: 0 })).success).toBe(false);
    expect(BrushStrokeSchema.safeParse(stroke({ radiusPx: WORKBENCH_BRUSH_RADIUS_MAX_PX + 1 })).success).toBe(false);
    expect(BrushStrokeSchema.safeParse(stroke({ points: [] })).success).toBe(false);
    expect(BrushStrokeSchema.safeParse(stroke({
      points: Array.from({ length: WORKBENCH_BRUSH_POINTS_MAX + 1 }, (_, i) => ({ x: i, y: i })),
    })).success).toBe(false);
    expect(BrushStrokeSchema.safeParse(stroke({ points: [{ x: -1, y: 0 }] })).success).toBe(false);

    const ops = Array.from({ length: WORKBENCH_MASK_OPS_MAX }, () => stroke());
    expect(LayerMaskPatchInputSchema.safeParse({
      taskId: 't1', nodeId: 'n', ops, expectedTreeBlobRef: REF,
    }).success).toBe(true);
    expect(LayerMaskPatchInputSchema.safeParse({
      taskId: 't1', nodeId: 'n', ops: [...ops, stroke()], expectedTreeBlobRef: REF,
    }).success).toBe(false);
    expect(LayerMaskPatchInputSchema.safeParse({
      taskId: 't1', nodeId: 'n', ops: [], expectedTreeBlobRef: REF,
    }).success).toBe(false);
  });

  it('坐标为有限非负数（浮点笔迹合法——压感设备采样）', () => {
    expect(BrushStrokeSchema.safeParse(stroke({ points: [{ x: 10.5, y: 20.25 }] })).success).toBe(true);
    expect(BrushStrokeSchema.safeParse(stroke({ points: [{ x: Number.NaN, y: 0 }] })).success).toBe(false);
    expect(BrushStrokeSchema.safeParse(stroke({ points: [{ x: Number.POSITIVE_INFINITY, y: 0 }] })).success).toBe(false);
  });
});

describe('mask 编辑状态机（五态冻结）', () => {
  it('枚举恰五值；MaskEditStatus 全字段往返（incomplete/error 面）', () => {
    expect(MASK_EDIT_STATE_SCHEMA.options).toEqual(['accepted', 'recomputing', 'ready', 'stale', 'error']);
    expect(MASK_EDIT_STATE_SCHEMA.safeParse('done').success).toBe(false);
    const status = MaskEditStatusSchema.parse({
      nodeId: 'n-hat', state: 'stale', runCount: 5000, incomplete: true,
      baseVersion: 6, error: null, updatedAt: '2026-09-26T00:00:00.000Z',
    });
    expect(status.incomplete).toBe(true);
    expect(MaskEditStatusSchema.safeParse({
      nodeId: 'n-hat', state: 'ready', runCount: 10, baseVersion: 6,
      updatedAt: '2026-09-26T00:00:00.000Z', // 缺 error 字段
    }).success).toBe(false);
    expect(MaskEditStatusSchema.safeParse({
      nodeId: 'n-hat', state: 'ready', runCount: 10, incomplete: false, baseVersion: 0,
      error: null, updatedAt: '2026-09-26T00:00:00.000Z', // baseVersion 必正
    }).success).toBe(false);
  });
});

describe('导出门（exportGate）', () => {
  it('三阻断因子冻结；allowed/blockers 结构往返', () => {
    expect(EXPORT_BLOCKER_SCHEMA.options).toEqual(['mask-incomplete', 'mask-stale', 'mask-recompute-error']);
    expect(EXPORT_BLOCKER_SCHEMA.safeParse('mask-feather-missing').success).toBe(false);
    const open = ExportGateSchema.parse({ allowed: true, blockers: [] });
    expect(open.allowed).toBe(true);
    const blocked = ExportGateSchema.parse({
      allowed: false, blockers: ['mask-incomplete', 'mask-stale'],
    });
    expect(blocked.blockers).toHaveLength(2);
    expect(ExportGateSchema.safeParse({ allowed: false }).success).toBe(false); // blockers 必填
  });
});

describe('view-state（视图态所有权）', () => {
  it('全量快照+revision 链往返；重复 nodeId 必拒；帧名冻结', () => {
    expect(WORKBENCH_VIEW_STATE_ARTIFACT_NAME).toBe('workbench-view-state.json');
    const state = ViewStateSchema.parse({
      kind: 'workbench-view-state',
      formatVersion: 1,
      nodes: [
        { nodeId: 'n-hat', visible: false },
        { nodeId: 'n-person', locked: true, collapsed: true },
      ],
      revision: 2,
      previousBlobRef: REF,
      updatedAt: '2026-09-26T00:00:00.000Z',
    });
    expect(state.nodes[1]?.locked).toBe(true);
    expect(ViewStateSchema.safeParse({
      ...state, nodes: [{ nodeId: 'n-hat' }, { nodeId: 'n-hat' }],
    }).success).toBe(false);
    expect(ViewStateSchema.safeParse({
      ...state, nodes: [{ nodeId: 'n-hat', extra: 1 }],
    }).success).toBe(false);
  });

  it('view.state.set：全量快照入参+expectedRevision 可选+出参 revision', () => {
    expect(ViewStateSetInputSchema.safeParse({ taskId: 't1', nodes: [] }).success).toBe(true);
    expect(ViewStateSetInputSchema.safeParse({
      taskId: 't1', nodes: [], expectedRevision: 3,
    }).success).toBe(true);
    expect(ViewStateSetInputSchema.safeParse({
      taskId: 't1', nodes: [], expectedRevision: -1,
    }).success).toBe(false);
    const out = ViewStateSetOutputSchema.parse({ blobRef: REF, revision: 4 });
    expect(out.revision).toBe(4);
  });
});

describe('task.detail 扩面（viewState/maskEdits/exportGate）', () => {
  it('三新字段往返+null/空降级面', () => {
    const base = {
      task: { id: 't1', title: null, status: 'running' as const, createdAt: '2026-09-26T00:00:00.000Z' },
      session: null,
      baseImage: null,
      tree: null,
      assignments: [],
      gems: null,
      preview: null,
    };
    const full = TaskDetailResponseSchema.parse({
      ...base,
      viewState: {
        kind: 'workbench-view-state',
        formatVersion: 1,
        nodes: [{ nodeId: 'n-hat', locked: true }],
        revision: 1,
        previousBlobRef: null,
        updatedAt: '2026-09-26T00:00:00.000Z',
      },
      maskEdits: [{
        nodeId: 'n-hat', state: 'ready', runCount: 100, incomplete: false,
        baseVersion: 3, error: null, updatedAt: '2026-09-26T00:00:00.000Z',
      }],
      exportGate: { allowed: true, blockers: [] },
    });
    expect(full.viewState?.nodes[0]?.locked).toBe(true);
    expect(full.maskEdits).toHaveLength(1);

    const bare = TaskDetailResponseSchema.parse({
      ...base, viewState: null, maskEdits: [], exportGate: { allowed: true, blockers: [] },
    });
    expect(bare.viewState).toBeNull();
    // 三新字段必填（缺 exportGate 必拒——服务端恒算）
    expect(TaskDetailResponseSchema.safeParse(base).success).toBe(false);
  });
});

describe('task.export 导出接线（P0-1）', () => {
  it('入参 strict+出参 kind 字面量与摘要面往返', () => {
    expect(TaskExportInputSchema.safeParse({ taskId: 't1' }).success).toBe(true);
    expect(TaskExportInputSchema.safeParse({ taskId: 't1', extra: 1 }).success).toBe(false);
    const out = TaskExportOutputSchema.parse({
      filename: 'task-t1-strategy-gems.json',
      kind: 'strategy-gems',
      dataBase64: 'e30=',
      blobRef: REF,
      gemCount: 1888,
    });
    expect(out.kind).toBe('strategy-gems');
    expect(out.gemCount).toBe(1888);
    expect(TaskExportOutputSchema.safeParse({
      filename: 'f.json', kind: 'gemproj', dataBase64: 'e30=', blobRef: REF, gemCount: 1,
    }).success).toBe(false); // kind 字面量——非四族资源导出面
  });
});

describe('冻结常量与枚举清单（增删=契约变更）', () => {
  it('4096 行程上限+tree cause 六值+错误码八值', () => {
    expect(WORKBENCH_MASK_RUN_LIMIT).toBe(4096);
    expect(TREE_VERSION_CAUSE_SCHEMA.options).toEqual([
      'segment-one', 'rename', 'reorder', 'delete', 'mask-patch', 'revert',
    ]);
    expect(WORKBENCH_WRITE_ERROR_CODE_SCHEMA.options).toEqual([
      'cas-mismatch', 'node-locked', 'root-protected', 'cycle', 'parent-invalid',
      'mask-invalid', 'view-state-invalid', 'export-blocked',
    ]);
  });
});
