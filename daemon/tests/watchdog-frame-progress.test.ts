/**
 * 看门狗帧窗口分类纯函数单测（add-segment-checkpoint-resume tasks 5.4 / T3.2——
 * R1-P2-5 可测性：watchdogFrameProgress 原为 HandicraftKernel 私有方法且 daemon 无
 * watchdog 测试先例，本变更导出为纯函数）。覆盖：
 *   [1] progress 帧（段循环适配器 emitFor 的机器验证进展）→ progress=true+activity=true。
 *   [2] 既有分类分支不回归：artifact/approval-request=真进展；approval-resolved
 *       approved=true 真进展、rejected 仅活动；transcript assistant=仅活动、tool
 *       非错误后缀=真进展、tool 错误后缀=仅活动；user 输入=零计数；空窗口=零计数。
 * 零 IO 零常驻进程（纯函数直调）。
 */
import { describe, expect, it } from 'vitest';
import type { Frame } from '@handicraft/contracts';
import { watchdogFrameProgress } from '../src/kernel/index.js';

// seq 单调分配器（Frame.seq 为 task 内单调正整数——纯函数不消费语义，仅需类型合法）
let seq = 0;
const nextSeq = (): number => {
  seq += 1;
  return seq;
};

const progressFrame = (text = '语义抠图 · 累计 1 段（本片回放 0 + 实跑 1）· 待细分 2'): Frame => ({
  seq: nextSeq(),
  ts: 1_000,
  kind: 'progress',
  payload: { text },
});

const artifactFrame = (): Frame => ({
  seq: nextSeq(),
  ts: 1_000,
  kind: 'artifact',
  payload: { blobRef: 'a'.repeat(64), name: 'object-tree.json' },
});

const approvalRequestFrame = (): Frame => ({
  seq: nextSeq(),
  ts: 1_000,
  kind: 'approval-request',
  payload: {
    requestId: 'r1',
    tool: 'studio.stones.add',
    proposalId: 'p1',
    preview: { before: 'b'.repeat(64), after: 'c'.repeat(64) },
    summary: 's',
    expiresAt: '2026-10-02T00:00:00.000Z',
  },
});

const approvalResolvedFrame = (approved: boolean): Frame => ({
  seq: nextSeq(),
  ts: 1_000,
  kind: 'approval-resolved',
  payload: { requestId: 'r1', approved, resolvedAt: '2026-10-02T00:00:00.000Z' },
});

const transcriptFrame = (role: 'user' | 'assistant' | 'tool', text: string): Frame => ({
  seq: nextSeq(),
  ts: 1_000,
  kind: 'transcript',
  payload: { role, text },
});

describe('watchdogFrameProgress 纯函数（add-segment-checkpoint-resume T3.2）', () => {
  it('progress 帧 → 真进展+活动（段循环适配器=agent 任务首个 progress emitter）', () => {
    expect(watchdogFrameProgress([progressFrame()])).toEqual({ progress: true, activity: true });
    // 混窗：progress 与失败活动并存——progress 仍真（真进展集合加一元，不因失败抵消）
    expect(
      watchdogFrameProgress([transcriptFrame('tool', 'x（工具执行错误）'), progressFrame()]),
    ).toEqual({ progress: true, activity: true });
  });

  it('artifact/approval-request=真进展（既有语义不回归）', () => {
    expect(watchdogFrameProgress([artifactFrame()])).toEqual({ progress: true, activity: true });
    expect(watchdogFrameProgress([approvalRequestFrame()])).toEqual({ progress: true, activity: true });
  });

  it('approval-resolved：approved=true 真进展；rejected 仅活动', () => {
    expect(watchdogFrameProgress([approvalResolvedFrame(true)])).toEqual({ progress: true, activity: true });
    expect(watchdogFrameProgress([approvalResolvedFrame(false)])).toEqual({ progress: false, activity: true });
  });

  it('transcript：assistant 仅活动；tool 非错误后缀=真进展、错误后缀=仅活动；user 零计数', () => {
    expect(watchdogFrameProgress([transcriptFrame('assistant', '思考中')])).toEqual({
      progress: false,
      activity: true,
    });
    expect(watchdogFrameProgress([transcriptFrame('tool', '{"ok":1}')])).toEqual({
      progress: true,
      activity: true,
    });
    expect(watchdogFrameProgress([transcriptFrame('tool', 'boom（工具执行错误）')])).toEqual({
      progress: false,
      activity: true,
    });
    expect(watchdogFrameProgress([transcriptFrame('user', '用户改口')])).toEqual({
      progress: false,
      activity: false,
    });
  });

  it('空窗口=零计数（静默挂起面——首窗即杀的输入判定）', () => {
    expect(watchdogFrameProgress([])).toEqual({ progress: false, activity: false });
  });
});
