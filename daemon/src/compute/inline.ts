/**
 * InlineProvider（design §5：本机进程内直跑=图像 API 调用/dry-run 占位——接口行为与
 * 未来远程适配器一致）。幂等键=taskId（同任务重放收敛同 JobRef）；cancel 经
 * AbortController 协作取消。产物经 BlobStore 落盘回传内容寻址 blobRef。
 */
import type { BlobRef } from '@handicraft/contracts';
import type { BlobStore } from '../db/blobs.js';
import { ComputeError, type ComputeJobRef, type ComputeJobStatus, type ComputeProvider, type ComputeSpec } from './provider.js';

/** spec 执行器（进程内直跑面：真实外呼或 dry-run 占位由装配方注入）。 */
export type InlineExecutor = (spec: ComputeSpec, signal: AbortSignal) => Promise<Uint8Array>;

interface InlineJob {
  ref: ComputeJobRef;
  status: ComputeJobStatus;
  blobRef?: BlobRef;
  controller: AbortController;
  promise: Promise<void>;
}

export class InlineProvider implements ComputeProvider {
  readonly name = 'inline';
  private readonly jobs = new Map<string, InlineJob>();
  private readonly byIdem = new Map<string, string>();
  private seq = 0;

  constructor(
    private readonly blobs: BlobStore,
    private readonly execute: InlineExecutor,
  ) {}

  async submit(spec: ComputeSpec, idempotencyKey: string): Promise<ComputeJobRef> {
    const existing = this.byIdem.get(idempotencyKey);
    if (existing) {
      const job = this.jobs.get(existing);
      if (job) return job.ref; // 幂等：同键重放返回同 JobRef
    }
    const id = `inline-${++this.seq}-${Date.now().toString(36)}`;
    const ref: ComputeJobRef = { provider: this.name, id };
    const controller = new AbortController();
    const job: InlineJob = {
      ref,
      status: { state: 'running' },
      controller,
      promise: Promise.resolve(),
    };
    this.jobs.set(id, job);
    this.byIdem.set(idempotencyKey, id);
    job.promise = this.execute(spec, controller.signal)
      .then((bytes) => {
        const put = this.blobs.put(bytes);
        job.blobRef = put.hash;
        job.status = { state: 'succeeded' };
      })
      .catch((error: unknown) => {
        job.status =
          controller.signal.aborted
            ? { state: 'cancelled' }
            : { state: 'failed', error: error instanceof Error ? error.message : String(error) };
      });
    return ref;
  }

  async status(ref: ComputeJobRef): Promise<ComputeJobStatus> {
    const job = this.jobOf(ref);
    return { ...job.status };
  }

  async result(ref: ComputeJobRef): Promise<BlobRef> {
    const job = this.jobOf(ref);
    await job.promise;
    if (job.status.state === 'succeeded' && job.blobRef) return job.blobRef;
    if (job.status.state === 'cancelled') throw new ComputeError('计算任务已取消');
    throw new ComputeError(`计算任务未成功（${job.status.state}${job.status.error ? `：${job.status.error}` : ''}）`);
  }

  async cancel(ref: ComputeJobRef): Promise<void> {
    const job = this.jobOf(ref);
    job.controller.abort();
    if (job.status.state === 'queued' || job.status.state === 'running') {
      job.status = { state: 'cancelled' };
    }
  }

  private jobOf(ref: ComputeJobRef): InlineJob {
    const job = this.jobs.get(ref.id);
    if (!job) throw new ComputeError(`未知计算任务：${ref.provider}/${ref.id}`);
    return job;
  }
}
