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
  it('agent 族 = {transcript|approval-request|approval-resolved|done|error}', () => {
    expect([...AGENT_FRAME_KINDS]).toEqual([
      'transcript',
      'approval-request',
      'approval-resolved',
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
