/**
 * ComputeProvider 接口缝（design §5——异步签名，轻抽象不做重）。
 * 原始需求 2026-09-23（W2.2 建 compute/ 接口+Inline 实现；W5.3 版本化收口）：
 * submit 携幂等键（同键重放返回同 JobRef）；spec 序列化格式即接口契约（kind+version
 * 版本化——未来租赁 API 适配器实现同一接口即接入）；本 change 不实现任何远程适配器。
 * 凭据不入 spec（提交面参数与部署面凭据解耦——适配器自持配置注入）。
 */
import type { BlobRef } from '@handicraft/contracts';

/** 计算任务句柄（provider 域内唯一——Inline 为进程内 id）。 */
export interface ComputeJobRef {
  provider: string;
  id: string;
}

export type ComputeJobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface ComputeJobStatus {
  state: ComputeJobState;
  /** failed 时的原因（可呈现） */
  error?: string;
}

/**
 * 版本化 spec 判别联合。generate-image v1：OpenAI 兼容 Images API 请求参数快照
 * （imageBase64 缺席=generations；出席=edits）。
 */
export type ComputeSpec =
  | {
      kind: 'generate-image';
      version: 1;
      prompt: string;
      size?: string;
      model: string;
      /** edits 模式原图（base64——提交面参数，凭据不在此） */
      imageBase64?: string;
      advanced?: Record<string, unknown>;
    };

export interface ComputeProvider {
  readonly name: string;
  /** 幂等：同 idempotencyKey 重放返回同 JobRef。 */
  submit(spec: ComputeSpec, idempotencyKey: string): Promise<ComputeJobRef>;
  status(ref: ComputeJobRef): Promise<ComputeJobStatus>;
  /** 完成后的产物（内容寻址 blobRef=sha256）；未完成/失败抛错。 */
  result(ref: ComputeJobRef): Promise<BlobRef>;
  cancel(ref: ComputeJobRef): Promise<void>;
}

export class ComputeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComputeError';
  }
}
