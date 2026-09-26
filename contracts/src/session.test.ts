/**
 * Agent 会话契约单测（design §3.5/W0.1 任务门）：
 * 一个 session 两个 task 各自 seq 从 1 的回放语义；session.result 确定性选择
 * （最新 completedAt，平局 taskId 大者）；task.result 无结果显式 not_found；
 * attempts 账本 schema 与唯一约束表达；各端点 IO 形状。
 */
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_UNIQUE_KEYS,
  AttemptSchema,
  selectSessionResult,
  SessionCancelInputSchema,
  SessionFollowupInputSchema,
  SessionReplayOutputSchema,
  SessionRetryInputSchema,
  TaskResultOutputSchema,
  replayWindow,
} from './session.js';
import { FrameSchema } from './frame.js';

const hash = 'a'.repeat(64);
const hash2 = 'b'.repeat(64);

function mkFrame(seq: number, kind: 'transcript' | 'done', task: string) {
  return FrameSchema.parse({
    seq,
    ts: 1_000 + seq,
    kind,
    payload: kind === 'transcript' ? { role: 'user' as const, text: task } : {},
  });
}

describe('多 task 回放语义（session 1—N task，各 task seq 独立从 1）', () => {
  const taskA = [mkFrame(1, 'transcript', 'a'), mkFrame(2, 'done', 'a')];
  const taskB = [mkFrame(1, 'transcript', 'b'), mkFrame(2, 'transcript', 'b'), mkFrame(3, 'done', 'b')];

  it('两 task 各自 seq 从 1 起（task 域独立，非 session 级连续）', () => {
    expect(taskA[0].seq).toBe(1);
    expect(taskB[0].seq).toBe(1);
  });
  it('分别回放无重帧/漏帧（afterSeq 各 task 独立游标）', () => {
    // taskA 断线于 seq1 后重连
    const a2 = replayWindow(taskA, 1);
    expect(a2.map((f) => f.seq)).toEqual([2]);
    // taskB 全量与增量
    expect(replayWindow(taskB, 0).map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(replayWindow(taskB, 1).map((f) => f.seq)).toEqual([2, 3]);
    // 交错存储（同一 jsonl 读面按 task 分组）也不串台
    const mixed = [...taskA, ...taskB];
    expect(replayWindow(mixed, 0).filter((f) => f.kind === 'done')).toHaveLength(2);
  });
  it('replay 输出契约：frames[] + nextSeq（无帧时=afterSeq 原值）', () => {
    const out = SessionReplayOutputSchema.parse({ frames: replayWindow(taskB, 1), nextSeq: 3 });
    expect(out.frames).toHaveLength(2);
    expect(out.nextSeq).toBe(3);
    const empty = SessionReplayOutputSchema.parse({ frames: [], nextSeq: 3 });
    expect(empty.frames).toHaveLength(0);
  });
});

describe('session.result 确定性选择', () => {
  it('最新 completedAt 胜出', () => {
    const pick = selectSessionResult([
      { taskId: 't1', completedAt: '2026-09-23T10:00:00.000Z' },
      { taskId: 't2', completedAt: '2026-09-23T11:00:00.000Z' },
      { taskId: 't3', completedAt: '2026-09-23T09:00:00.000Z' },
    ]);
    expect(pick?.taskId).toBe('t2');
  });
  it('completedAt 平局 → taskId 大者（字典序，确定性）', () => {
    const at = '2026-09-23T11:00:00.000Z';
    expect(selectSessionResult([
      { taskId: 't-009', completedAt: at },
      { taskId: 't-010', completedAt: at },
    ])?.taskId).toBe('t-010');
    // 输入顺序无关（确定性=排列不变）
    expect(selectSessionResult([
      { taskId: 't-010', completedAt: at },
      { taskId: 't-009', completedAt: at },
    ])?.taskId).toBe('t-010');
  });
  it('空集 → null（无已完成 task 时由调用方给显式 not_found 形态）', () => {
    expect(selectSessionResult([])).toBeNull();
  });
});

describe('task.result 显式 not_found', () => {
  it('found 形态：resultId/publicId?/bundle', () => {
    const ok = TaskResultOutputSchema.parse({
      found: true,
      resultId: 'r1',
      bundle: { svg: hash, bom: hash, png: hash2 },
    });
    expect(ok.found).toBe(true);
  });
  it('not_found 形态：{found:false}——不回退到别的 task', () => {
    const miss = TaskResultOutputSchema.parse({ found: false });
    expect(miss.found).toBe(false);
    expect('bundle' in miss).toBe(false);
  });
  it('畸形 bundle（非 sha256 hex）拒绝', () => {
    expect(
      TaskResultOutputSchema.safeParse({
        found: true,
        resultId: 'r1',
        bundle: { svg: 'nothex', bom: hash, png: hash },
      }).success,
    ).toBe(false);
  });
});

describe('attempts 账本 schema（§3.6 R5/R6）', () => {
  const attempt = {
    attemptId: 'att-1',
    proposalId: 'prop-1',
    attemptNo: 1,
    idemKey: 'idem-1',
    retryRequestId: 'rr-1',
    state: 'claimed',
    createdAt: '2026-09-23T12:00:00.000Z',
    updatedAt: '2026-09-23T12:00:00.000Z',
  };
  it('全字段解析；state 值域 claimed/running/succeeded/failed/unknown', () => {
    expect(AttemptSchema.parse(attempt).attemptNo).toBe(1);
    for (const state of ['running', 'succeeded', 'failed', 'unknown']) {
      expect(AttemptSchema.safeParse({ ...attempt, state }).success).toBe(true);
    }
    expect(AttemptSchema.safeParse({ ...attempt, state: 'approved' }).success).toBe(false);
  });
  it('attemptNo 正整数（0 拒绝）', () => {
    expect(AttemptSchema.safeParse({ ...attempt, attemptNo: 0 }).success).toBe(false);
  });
  it('唯一约束表达：proposalId+attemptNo 与 retryRequestId（DDL 对齐声明）', () => {
    expect(ATTEMPT_UNIQUE_KEYS).toEqual([['proposalId', 'attemptNo'], ['retryRequestId']]);
  });
});

describe('端点 IO 形状', () => {
  it('session.cancel XOR：sessionId|taskId 二选一', () => {
    expect(SessionCancelInputSchema.safeParse({ sessionId: 's1' }).success).toBe(true);
    expect(SessionCancelInputSchema.safeParse({ taskId: 't1' }).success).toBe(true);
    expect(SessionCancelInputSchema.safeParse({}).success).toBe(false);
    expect(SessionCancelInputSchema.safeParse({ sessionId: 's1', taskId: 't1' }).success).toBe(false);
  });
  it('session.retry：四必填（含 retryRequestId 与 costConfirmed）', () => {
    const full = {
      sessionId: 's1',
      proposalId: 'p1',
      costConfirmed: true,
      retryRequestId: 'rr-1',
    };
    expect(SessionRetryInputSchema.parse(full).retryRequestId).toBe('rr-1');
    const bad = { ...full } as Record<string, unknown>;
    delete bad.retryRequestId;
    expect(SessionRetryInputSchema.safeParse(bad).success).toBe(false);
  });
  it('session.followup：text 必填非空；attachments 为 blobRef 数组', () => {
    expect(
      SessionFollowupInputSchema.safeParse({ sessionId: 's1', text: '', attachments: [hash] }).success,
    ).toBe(false);
    expect(
      SessionFollowupInputSchema.parse({ sessionId: 's1', text: '改密一点', attachments: [hash] })
        .attachments,
    ).toEqual([hash]);
  });
  it('session.followup mode（三通道 1.1）：followup|steer 二值，缺省 undefined=followup', () => {
    // 缺省不落字段（缺省 followup——服务端按 undefined 走常规发送）。
    expect(SessionFollowupInputSchema.parse({ sessionId: 's1', text: '你好' }).mode).toBeUndefined();
    expect(SessionFollowupInputSchema.parse({ sessionId: 's1', text: '你好', mode: 'followup' }).mode).toBe('followup');
    expect(SessionFollowupInputSchema.parse({ sessionId: 's1', text: '往红色偏一点', mode: 'steer' }).mode).toBe('steer');
    // 值域外拒绝（queue/inject 不在本端点——队列面板属后续波次）。
    expect(SessionFollowupInputSchema.safeParse({ sessionId: 's1', text: 'x', mode: 'queue' }).success).toBe(false);
    expect(SessionFollowupInputSchema.safeParse({ sessionId: 's1', text: 'x', mode: 'inject' }).success).toBe(false);
    // 既有面不破：mode 与 attachments 可同现（steer+附件由服务端拒绝——契约层只管形状）。
    expect(
      SessionFollowupInputSchema.safeParse({ sessionId: 's1', text: 'x', attachments: [hash], mode: 'followup' })
        .success,
    ).toBe(true);
  });
});
