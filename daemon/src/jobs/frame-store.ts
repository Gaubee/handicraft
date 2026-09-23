/**
 * 任务帧持久层（design §2 长任务行：jsonl 落盘 + afterSeq 游标重放——zhumo FrameStore 模式）。
 * 原始需求 2026-09-23（W2.1）：帧 write-through 到任务目录 frames.jsonl（每任务一文件，
 * DATA_ROOT/tasks/<taskId>/）；Frame 线格式复用 contracts FrameSchema（job/agent 两族同源）。
 * 正交意图：
 *   [1] append：单帧逐行追加（best-effort，失败只记日志不打断任务）。
 *   [2] readAfter：seq 升序回放 + afterSeq 游标过滤（FrameSchema safeParse 守门，
 *       损坏行丢弃）。
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FrameSchema, type Frame } from '@handicraft/contracts';

export class FrameStore {
  constructor(private readonly framesFile: string) {}

  append(frame: Frame): void {
    try {
      mkdirSync(path.dirname(this.framesFile), { recursive: true });
      appendFileSync(this.framesFile, `${JSON.stringify(frame)}\n`, { mode: 0o600 });
    } catch (error) {
      console.error(
        `[frame-store] append 失败（${this.framesFile}）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** 全量读取并按游标过滤（seq 升序；损坏行丢弃）。 */
  readAfter(afterSeq: number): Frame[] {
    let raw: string;
    try {
      raw = readFileSync(this.framesFile, 'utf8');
    } catch {
      return [];
    }
    const frames: Frame[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = FrameSchema.safeParse(JSON.parse(line) as unknown);
        if (parsed.success && parsed.data.seq > afterSeq) frames.push(parsed.data);
      } catch {
        // 损坏行丢弃。
      }
    }
    return frames;
  }

  /** 已持久化的最大帧序（无帧=0——重连/回放游标初始化面）。 */
  lastSeq(): number {
    let last = 0;
    for (const frame of this.readAfter(0)) {
      if (frame.seq > last) last = frame.seq;
    }
    return last;
  }
}
