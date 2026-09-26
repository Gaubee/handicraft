/**
 * 服务面任务端点 IO 契约测试（W2.1）：判别联合拒绝面 + 默认值 + 帧回放输出形状。
 */
import { describe, expect, it } from 'vitest';
import {
  AssetsUploadInputSchema,
  BootstrapOutputSchema,
  GenerateJobParamsSchema,
  PaveJobParamsSchema,
  TaskArtifactInputSchema,
  TaskArtifactOutputSchema,
  TaskCreateInputSchema,
  TaskFramesInputSchema,
  TaskStopInputSchema,
  TaskStopOutputSchema,
  TaskViewSchema,
  TASK_ARTIFACT_MAX_BYTES,
} from './tasks.js';

const PNG_REF = 'a'.repeat(64);

describe('tasks 端点 IO（W2.1）', () => {
  it('TaskCreateInput：三类 job 判别联合；非法 kind/params 拒绝', () => {
    const sleep = TaskCreateInputSchema.parse({
      kind: 'sleep',
      params: { frames: 3 },
    });
    expect(sleep).toMatchObject({ kind: 'sleep', params: { frames: 3, intervalMs: 25 } });

    const generate = TaskCreateInputSchema.parse({
      kind: 'generate',
      params: { prompt: '一颗红心', imageRef: PNG_REF },
    });
    expect(generate.kind).toBe('generate');

    const pave = TaskCreateInputSchema.parse({
      kind: 'engine',
      params: {
        op: 'pave',
        imageRef: PNG_REF,
        strategy: 'hex-pitch',
        gapMm: 0.4,
        spec: { shapeId: 'round', diameterMm: 3 },
      },
    });
    expect(pave.kind).toBe('engine');
    if (pave.kind === 'engine' && pave.params.op === 'pave') {
      // 引擎口径默认值（density 1 / seed 1 / relax 双 false / pixelsPerMm 8 / segmentK 8）
      expect(pave.params.density).toBe(1);
      expect(pave.params.seed).toBe(1);
      expect(pave.params.relax).toEqual({ boundary: false, repulsion: false });
      expect(pave.params.pixelsPerMm).toBe(8);
      expect(pave.params.segmentK).toBe(8);
    }

    expect(!TaskCreateInputSchema.safeParse({ kind: 'nope', params: {} }).success).toBe(true);
    expect(!TaskCreateInputSchema.safeParse({ kind: 'sleep', params: { frames: 0 } }).success).toBe(true);
    expect(
      !TaskCreateInputSchema.safeParse({
        kind: 'engine',
        params: { op: 'validate' }, // 缺 paveTaskId
      }).success,
    ).toBe(true);
  });

  it('PaveJobParams：排布参数契约直通（§3.4——非法值显式拒绝）', () => {
    const base = {
      op: 'pave' as const,
      imageRef: PNG_REF,
      gapMm: 0,
      spec: { shapeId: 'round' as const, diameterMm: 3 },
    };
    // 五策略含 cvt
    expect(PaveJobParamsSchema.parse({ ...base, strategy: 'cvt' }).strategy).toBe('cvt');
    // 负 gapMm / density 越界 / 未知策略 / custom 缺 assetId 均拒
    expect(!PaveJobParamsSchema.safeParse({ ...base, strategy: 'hex-pitch', gapMm: -1 }).success).toBe(true);
    expect(
      !PaveJobParamsSchema.safeParse({ ...base, strategy: 'hex-pitch', density: 1.5 }).success,
    ).toBe(true);
    expect(!PaveJobParamsSchema.safeParse({ ...base, strategy: 'grid' }).success).toBe(true);
    // SpecRef 的 assetId 是弱引用（W0.2 冻结口径）——custom 缺 assetId 在契约层不拒，
    // 由引擎/导出层 typed invalid（CustomAssetIdMissingError 语义）拦截（W2.3 测试门）。
    expect(
      PaveJobParamsSchema.safeParse({
        ...base,
        strategy: 'hex-pitch',
        spec: { shapeId: 'custom', diameterMm: 3 },
      }).success,
    ).toBe(true);
    // 空 region 拒绝
    expect(
      !PaveJobParamsSchema.safeParse({
        ...base,
        strategy: 'hex-pitch',
        region: { kind: 'blocks', ids: [] },
      }).success,
    ).toBe(true);
  });

  it('GenerateJobParams：prompt 必填；advanced 逃生舱；size 可选', () => {
    expect(!GenerateJobParamsSchema.safeParse({ prompt: '' }).success).toBe(true);
    const parsed = GenerateJobParamsSchema.parse({
      prompt: 'p',
      size: '1024x1024',
      advanced: { temperature: 0.7 },
    });
    expect(parsed.advanced).toEqual({ temperature: 0.7 });
  });

  it('BootstrapOutput：密钥值零出（脱敏面——apiKey 字样即拒）', () => {
    const boot = BootstrapOutputSchema.parse({
      version: '0.1.0',
      allowAnonymous: true,
      adminConfigured: false,
      imgConfigured: false,
      llmConfigured: false,
      imgDryRun: true,
    });
    expect(boot.imgDryRun).toBe(true);
    expect(!BootstrapOutputSchema.safeParse({ ...boot, apiKey: 'x' }).success).toBe(true);
  });

  it('AssetsUpload/TaskFrames/TaskView 形状：afterSeq 默认 0；多余键 strict 拒绝', () => {
    expect(TaskFramesInputSchema.parse({ taskId: 't1' }).afterSeq).toBe(0);
    expect(!AssetsUploadInputSchema.safeParse({ filename: 'a' }).success).toBe(true); // 缺 dataBase64
    const view = TaskViewSchema.parse({
      taskId: 't1',
      type: 'job',
      kind: 'sleep',
      status: 'done',
      createdAt: '2026-09-23T00:00:00Z',
      updatedAt: '2026-09-23T00:00:00Z',
    });
    expect(view.status).toBe('done');
    expect(!TaskViewSchema.safeParse({ ...view, extra: 1 }).success).toBe(true);
  });

  it('TaskArtifactInput：blobRef/name 二选一（XOR）；双给/全缺/非法 ref 拒绝', () => {
    expect(TaskArtifactInputSchema.parse({ taskId: 't1', blobRef: PNG_REF })).toEqual({
      taskId: 't1',
      blobRef: PNG_REF,
    });
    expect(TaskArtifactInputSchema.parse({ taskId: 't1', name: 'object-tree.json' })).toEqual({
      taskId: 't1',
      name: 'object-tree.json',
    });
    // 双给 / 全缺 / 非 hex64 blobRef / 空名
    expect(!TaskArtifactInputSchema.safeParse({ taskId: 't1', blobRef: PNG_REF, name: 'x' }).success).toBe(true);
    expect(!TaskArtifactInputSchema.safeParse({ taskId: 't1' }).success).toBe(true);
    expect(!TaskArtifactInputSchema.safeParse({ taskId: 't1', blobRef: 'zz' }).success).toBe(true);
    expect(!TaskArtifactInputSchema.safeParse({ taskId: 't1', name: '' }).success).toBe(true);
  });

  it('TaskArtifactOutput：三字段 strict；上限常量=8MiB（预览图/JSON 工件远小）', () => {
    const out = TaskArtifactOutputSchema.parse({
      name: 'strategy-gems-preview.png',
      mime: 'image/png',
      dataBase64: 'aGk=',
    });
    expect(out.mime).toBe('image/png');
    expect(!TaskArtifactOutputSchema.safeParse({ ...out, extra: 1 }).success).toBe(true);
    expect(!TaskArtifactOutputSchema.safeParse({ name: 'x', dataBase64: 'aGk=' }).success).toBe(true); // mime 必填
    expect(TASK_ARTIFACT_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it('tasks.stop IO（三通道 1.1）：taskId 必填；输出=任务视图（打断回 done 的载体）', () => {
    expect(TaskStopInputSchema.parse({ taskId: 't1' }).taskId).toBe('t1');
    // 贴钻命名对齐（taskId 非 shufa 的 id）；多余键 strict 拒绝。
    expect(!TaskStopInputSchema.safeParse({ id: 't1' }).success).toBe(true);
    expect(!TaskStopInputSchema.safeParse({ taskId: 't1', force: true }).success).toBe(true);
    const view = TaskStopOutputSchema.parse({
      taskId: 't1',
      type: 'agent',
      status: 'done',
      createdAt: '2026-09-26T00:00:00Z',
      updatedAt: '2026-09-26T00:00:01Z',
    });
    expect(view.status).toBe('done');
    expect(!TaskStopOutputSchema.safeParse({ ok: true }).success).toBe(true); // 非 {ok} 形（cancel 才是）
  });
});
