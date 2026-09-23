/**
 * sleep 演示 job（design §2 长任务行——W2.1 帧流语义测试面）。
 * 固定 N 帧 progress（0→1 单调）后正常返回（service 补 done 帧）；帧间检查取消位。
 */
import { SleepJobParamsSchema } from '@handicraft/contracts';
import type { JobRunner } from './service.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const runSleepJob: JobRunner = async (ctx) => {
  const parsed = SleepJobParamsSchema.safeParse(ctx.params);
  if (!parsed.success) throw new Error(`sleep job 参数不合法：${JSON.stringify(parsed.error.issues)}`);
  const { frames: total, intervalMs } = parsed.data;
  for (let i = 1; i <= total; i++) {
    if (ctx.isCancelled()) return;
    ctx.emit('progress', { text: `进度 ${i}/${total}`, ratio: i / total });
    if (i < total) await sleep(intervalMs);
  }
};
