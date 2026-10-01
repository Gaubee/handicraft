/**
 * 帧模型单测（design §3.5）：两族 kind 值域 + approval 载荷逐字面 +
 * grant/nonce 注入必拒 + seq/ts 形状。
 */
import { describe, expect, it } from 'vitest';
import {
  AGENT_FRAME_KINDS,
  ApprovalRequestPayloadSchema,
  ApprovalResolvedPayloadSchema,
  FrameKindSchema,
  FrameSchema,
  JOB_FRAME_KINDS,
  replayWindow,
} from './frame.js';

const hash = 'a'.repeat(64);

describe('kind 两族值域', () => {
  it('job 族 = {progress|log|artifact|done|error}', () => {
    expect([...JOB_FRAME_KINDS]).toEqual(['progress', 'log', 'artifact', 'done', 'error']);
  });
  it('agent 族 = {transcript|approval-request|approval-resolved|activity|done|error}', () => {
    expect([...AGENT_FRAME_KINDS]).toEqual([
      'transcript',
      'approval-request',
      'approval-resolved',
      'activity',
      'done',
      'error',
    ]);
  });
  it('两族交集恰为 {done, error}；并集=FrameKind 完整值域', () => {
    const job = new Set<string>(JOB_FRAME_KINDS);
    const agent = new Set<string>(AGENT_FRAME_KINDS);
    const inter = [...job].filter((k) => agent.has(k));
    expect(inter.sort()).toEqual(['done', 'error']);
    const union = new Set([...job, ...agent]);
    expect([...union].sort()).toEqual([...FrameKindSchema.options].sort());
  });
});

describe('approval 载荷（逐字面冻结）', () => {
  it('approval-request：requestId/tool/proposalId/preview/summary/expiresAt 全字段可解析', () => {
    const parsed = ApprovalRequestPayloadSchema.parse({
      requestId: 'req-1',
      tool: 'studio.patch-apply',
      proposalId: 'prop-1',
      preview: { before: hash, after: hash.replace(/^a/, 'b') },
      summary: '把块 b1 密度 0.6→0.9',
      expiresAt: '2026-09-23T12:00:00.000Z',
    });
    expect(parsed.requestId).toBe('req-1');
    expect(parsed.preview.before).toBe(hash);
  });
  it('approval-request：缺任一冻结字段拒绝', () => {
    const full = {
      requestId: 'req-1',
      tool: 'studio.generate',
      proposalId: 'prop-1',
      preview: { before: hash, after: hash },
      summary: 's',
      expiresAt: '2026-09-23T12:00:00.000Z',
    };
    for (const key of Object.keys(full)) {
      const bad = { ...full } as Record<string, unknown>;
      delete bad[key];
      expect(ApprovalRequestPayloadSchema.safeParse(bad).success).toBe(false);
    }
  });
  it('approval-resolved：只有 {requestId, approved, resolvedAt}', () => {
    const parsed = ApprovalResolvedPayloadSchema.parse({
      requestId: 'req-1',
      approved: true,
      resolvedAt: '2026-09-23T12:00:01.000Z',
    });
    expect(parsed.approved).toBe(true);
  });
  it('grant/nonce 不出现在任何帧载荷（strict 注入即拒）', () => {
    expect(
      ApprovalResolvedPayloadSchema.safeParse({
        requestId: 'req-1',
        approved: true,
        resolvedAt: '2026-09-23T12:00:01.000Z',
        grantId: 'g-1',
      }).success,
    ).toBe(false);
    expect(
      ApprovalResolvedPayloadSchema.safeParse({
        requestId: 'req-1',
        approved: true,
        resolvedAt: '2026-09-23T12:00:01.000Z',
        nonce: 'n-1',
      }).success,
    ).toBe(false);
    expect(
      ApprovalRequestPayloadSchema.safeParse({
        requestId: 'req-1',
        tool: 't',
        proposalId: 'p',
        preview: { before: hash, after: hash },
        summary: 's',
        expiresAt: '2026-09-23T12:00:00.000Z',
        grant: 'anything',
      }).success,
    ).toBe(false);
  });
});

describe('Frame 形状', () => {
  it('seq 正整数从 1 起、ts epoch ms、kind×payload 判别联合', () => {
    const frame = FrameSchema.parse({
      seq: 1,
      ts: 1760000000000,
      kind: 'transcript',
      payload: { role: 'user', text: '把这块区域改密一点' },
    });
    expect(frame.kind).toBe('transcript');
    expect(FrameSchema.safeParse({ seq: 0, ts: 1, kind: 'done', payload: {} }).success).toBe(false);
    expect(FrameSchema.safeParse({ seq: 1.5, ts: 1, kind: 'done', payload: {} }).success).toBe(false);
  });
  it('done/error 载荷为空对象/错误消息（strict）', () => {
    expect(FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'done', payload: {} }).success).toBe(true);
    expect(FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'done', payload: { extra: 1 } }).success).toBe(false);
    expect(
      FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'error', payload: { message: 'boom' } }).success,
    ).toBe(true);
  });
});

describe('transcript 附件元数据（split-admin-portal 2.1——图片会话链回放面）', () => {
  const meta = { name: 'attachment-abc123', mime: 'image/png', width: 800, height: 600, blobRef: hash };
  it('user 帧携带 attachments（纯图消息 text 空串合法）', () => {
    const frame = FrameSchema.parse({
      seq: 1,
      ts: 1760000000000,
      kind: 'transcript',
      payload: { role: 'user', text: '', attachments: [meta] },
    });
    expect(frame.kind).toBe('transcript');
    if (frame.kind === 'transcript') {
      expect(frame.payload.attachments?.[0]?.blobRef).toBe(hash);
      expect(frame.payload.attachments?.[0]?.mime).toBe('image/png');
    }
    // 旧帧（无 attachments 键）解析不受影响——向后兼容回放。
    expect(
      FrameSchema.safeParse({ seq: 2, ts: 1, kind: 'transcript', payload: { role: 'assistant', text: '好' } })
        .success,
    ).toBe(true);
  });
  it('attachments strict：mime 白名单外/非正尺寸/畸形 blobRef/注入多余键拒绝', () => {
    expect(
      FrameSchema.safeParse({
        seq: 1,
        ts: 1,
        kind: 'transcript',
        payload: { role: 'user', text: '', attachments: [{ ...meta, mime: 'image/gif' }] },
      }).success,
    ).toBe(false);
    expect(
      FrameSchema.safeParse({
        seq: 1,
        ts: 1,
        kind: 'transcript',
        payload: { role: 'user', text: '', attachments: [{ ...meta, width: 0 }] },
      }).success,
    ).toBe(false);
    expect(
      FrameSchema.safeParse({
        seq: 1,
        ts: 1,
        kind: 'transcript',
        payload: { role: 'user', text: '', attachments: [{ ...meta, blobRef: 'nothex' }] },
      }).success,
    ).toBe(false);
    expect(
      FrameSchema.safeParse({
        seq: 1,
        ts: 1,
        kind: 'transcript',
        payload: { role: 'user', text: '', attachments: [{ ...meta, extra: 1 }] },
      }).success,
    ).toBe(false);
  });
});

describe('replayWindow（afterSeq 游标语义）', () => {
  const frames = [1, 2, 3, 4, 5].map((seq) => ({ seq }));
  it('afterSeq=0 → 全量；afterSeq=k → 严格大于 k 的帧（无重无漏）', () => {
    expect(replayWindow(frames, 0).map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(replayWindow(frames, 2).map((f) => f.seq)).toEqual([3, 4, 5]);
    expect(replayWindow(frames, 5)).toEqual([]);
    expect(replayWindow(frames, 99)).toEqual([]);
  });
});

describe('activity 载荷（意图 [4]——工具执行时间线投影）', () => {
  const running = {
    seq: 3,
    ts: 1760000000000,
    kind: 'activity',
    payload: {
      activityId: 'call-1',
      tool: 'studio.subject.segment',
      label: '抠图分件 · 左手',
      status: 'running',
      startedAt: 1760000000000,
      inputSummary: 'region=左手',
    },
  } as const;
  it('running→终态同 activityId 配对 roundtrip（ok 带 durationMs/output）', () => {
    const start = FrameSchema.parse(running);
    expect(start.kind).toBe('activity');
    if (start.kind === 'activity') {
      expect(start.payload.status).toBe('running');
      expect(start.payload.durationMs).toBeUndefined();
    }
    const done = FrameSchema.parse({
      seq: 4,
      ts: 1760000032100,
      kind: 'activity',
      payload: {
        activityId: 'call-1',
        tool: 'studio.subject.segment',
        label: '抠图分件 · 左手',
        status: 'ok',
        startedAt: 1760000000000,
        durationMs: 32100,
        inputSummary: 'region=左手',
        outputBlobRef: hash,
        outputSummary: '检出 342 颗 · 12 款',
      },
    });
    expect(done.kind).toBe('activity');
    if (done.kind === 'activity') {
      expect(done.payload.activityId).toBe(start.kind === 'activity' ? start.payload.activityId : '');
      expect(done.payload.durationMs).toBe(32100);
      expect(done.payload.outputBlobRef).toBe(hash);
    }
    // 回放窗口语义对新 kind 同样成立。
    const window = replayWindow([start, done], 0);
    expect(window.filter((f) => f.kind === 'activity')).toHaveLength(2);
  });
  it('error/cancelled 终态可解析（errorBrief ≤300）', () => {
    expect(
      FrameSchema.safeParse({
        seq: 1,
        ts: 1,
        kind: 'activity',
        payload: {
          activityId: 'c2',
          tool: 'studio.generate',
          label: '生成图片',
          status: 'error',
          startedAt: 1,
          durationMs: 5,
          errorBrief: 'x'.repeat(300),
        },
      }).success,
    ).toBe(true);
    expect(
      FrameSchema.safeParse({
        seq: 1,
        ts: 1,
        kind: 'activity',
        payload: {
          activityId: 'c3',
          tool: 'studio.export',
          label: '导出',
          status: 'cancelled',
          startedAt: 1,
          durationMs: 0,
        },
      }).success,
    ).toBe(true);
  });
  it('strict：注入多余键/超限摘要/畸形 blobRef/未知 status 拒绝', () => {
    const base = {
      activityId: 'c',
      tool: 't',
      label: 'l',
      status: 'ok',
      startedAt: 1,
      durationMs: 1,
    };
    expect(FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'activity', payload: { ...base, grantId: 'g' } }).success).toBe(false);
    expect(
      FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'activity', payload: { ...base, inputSummary: 'x'.repeat(201) } }).success,
    ).toBe(false);
    expect(
      FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'activity', payload: { ...base, errorBrief: 'x'.repeat(301) } }).success,
    ).toBe(false);
    expect(FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'activity', payload: { ...base, outputBlobRef: 'nothex' } }).success).toBe(false);
    expect(
      FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'activity', payload: { ...base, outputSummary: 'x'.repeat(201) } }).success,
    ).toBe(false);
    expect(FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'activity', payload: { ...base, status: 'pending' } }).success).toBe(false);
    expect(FrameSchema.safeParse({ seq: 1, ts: 1, kind: 'activity', payload: { ...base, startedAt: -1 } }).success).toBe(false);
  });
  it('旧帧兼容：既有 kind 帧解析不受 activity 分支影响（判别联合向前兼容）', () => {
    // 旧 jsonl 中典型帧样例逐 kind 解析——加分支零回归。
    for (const frame of [
      { seq: 1, ts: 1, kind: 'progress', payload: { text: 't', ratio: 0.5 } },
      { seq: 2, ts: 1, kind: 'log', payload: { text: 'l' } },
      { seq: 3, ts: 1, kind: 'artifact', payload: { blobRef: hash, name: 'layout.svg' } },
      { seq: 4, ts: 1, kind: 'transcript', payload: { role: 'tool', text: '调用工具 x（参数 {}）' } },
      { seq: 5, ts: 1, kind: 'done', payload: {} },
    ]) {
      expect(FrameSchema.safeParse(frame).success).toBe(true);
    }
  });
});
