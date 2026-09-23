/**
 * FrameStore 单测（design §2 长任务行：jsonl 持久化 + afterSeq 回放）。
 * 覆盖：追加与读回、afterSeq 游标过滤、损坏行丢弃、job/agent 两族 kind 均可持久化
 * （Frame 线格式单源——contracts FrameSchema）、lastSeq 游标初始化。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameSchema, type Frame } from '@handicraft/contracts';
import { FrameStore } from './frame-store.js';

function tmpFile(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'frame-store-'));
  return path.join(dir, name);
}

function frame(seq: number, kind: Frame['kind'], payload: unknown): Frame {
  return FrameSchema.parse({ seq, ts: Date.now(), kind, payload });
}

describe('FrameStore（jsonl 持久化 + afterSeq 回放）', () => {
  it('追加→全量读回；afterSeq 游标过滤；lastSeq 初始化', () => {
    const file = tmpFile('frames.jsonl');
    const store = new FrameStore(file);
    store.append(frame(1, 'progress', { ratio: 0.5 }));
    store.append(frame(2, 'log', { text: 'hello' }));
    store.append(frame(3, 'done', {}));

    const all = store.readAfter(0);
    expect(all.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(all[0]!.kind).toBe('progress');
    expect(all[1]!.payload).toEqual({ text: 'hello' });

    const after1 = store.readAfter(1);
    expect(after1.map((f) => f.seq)).toEqual([2, 3]);
    const after3 = store.readAfter(3);
    expect(after3).toEqual([]);
    expect(store.lastSeq()).toBe(3);
  });

  it('损坏行丢弃（JSON 破损 + 载荷不合法），合法行照常回放', () => {
    const file = tmpFile('frames.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        JSON.stringify({ seq: 1, ts: 1, kind: 'progress', payload: { ratio: 0.1 } }),
        '{broken json',
        JSON.stringify({ seq: 2, ts: 2, kind: 'progress', payload: { ratio: 'not-a-number' } }),
        JSON.stringify({ seq: 3, ts: 3, kind: 'done', payload: {} }),
        '',
      ].join('\n'),
    );
    const store = new FrameStore(file);
    const frames = store.readAfter(0);
    expect(frames.map((f) => f.seq)).toEqual([1, 3]);
  });

  it('文件缺失：readAfter 空数组、lastSeq=0', () => {
    const store = new FrameStore(tmpFile('missing.jsonl'));
    expect(store.readAfter(0)).toEqual([]);
    expect(store.lastSeq()).toBe(0);
  });

  it('job 与 agent 两族 kind 均可落盘往返（共用传输——design §2）', () => {
    const file = tmpFile('frames.jsonl');
    const store = new FrameStore(file);
    store.append(frame(1, 'progress', { ratio: 0.2 }));
    store.append(frame(2, 'transcript', { role: 'assistant', text: '排钻中' }));
    store.append(frame(3, 'approval-request', {
      requestId: 'req-1',
      tool: 'studio.patch-apply',
      proposalId: 'prop-1',
      preview: { before: 'a'.repeat(64), after: 'b'.repeat(64) },
      summary: '加密该区域',
      expiresAt: new Date().toISOString(),
    }));
    store.append(frame(4, 'error', { message: '失败' }));
    const frames = store.readAfter(0);
    expect(frames.map((f) => f.kind)).toEqual([
      'progress',
      'transcript',
      'approval-request',
      'error',
    ]);
  });
});
