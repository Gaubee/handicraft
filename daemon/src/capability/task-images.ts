/**
 * 任务域主图集 MCP 工具面（W5 走查 P0-1 收口，2026-09-28）。
 * 原始需求：物料桥哈希断裂——上传图片经 dsh saveImages（sharp 规范化）重编码后，
 * agent 会话内可见的附件引用（attachmentId=重编码后 sha）与 daemon blobRef（原始
 * 字节 sha）不同源；prompt 不再文本投影 blobRef 且无工具可查真值 → agent 调
 * scene.analyze/subject.segment 时传错 ref（image-missing 死锁）。本工具=双通道
 * 保底之二（通道一=首条 followup prompt 的 imageId→blobRef 锚注，kernel/index.ts）：
 * {taskId} → 主图集 [{imageId, blobRef, name, mime, width, height}]——blobRef 即
 * scene.analyze 的 imageBlobRef 入参（管线从 blob 读原始字节，无重编码问题）。
 * 数据真源：会话首条带图 followup 的 task 行 params 审计（attachments+imageIds
 * 按输入顺序同序——A5 冻结分配面）+ blob 字节（sniff mime+probeImageSize 尺寸）。
 * 正交意图：
 *   [1] list（readonly）：主图集映射投影（会话锚——taskId 服务端解析 session，
 *       模型不携带；后续轮次 task 查同一图集）。
 */
import { z } from 'zod';
import { assignTaskImageIds, type TaskImageId } from '@handicraft/contracts';
import type { SqliteDb } from '../db/database.js';
import type { BlobStore } from '../db/blobs.js';
import { extensionOfMime, probeImageSize, sniffImageMime } from '../image-sniff.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityDefinition,
  type CapabilityRegistry,
} from './core.js';
import { RUNAWAY_LIMIT } from './studio.js';

export const TASK_IMAGES_LIST_TOOL_NAME = 'studio.task.images.list';

// ---------------------------------------------------------------- 输入 schema

const ListInputSchema = z.object({
  taskId: z
    .string()
    .min(1)
    .describe('当前 agent 任务 id（服务端解析所属会话与主图集——任意轮次 task 同一图集）'),
});

// ---------------------------------------------------------------- 工具面构造

export interface TaskImagesCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
}

/** 主图集审计行（会话内 agent task 的 params 投影——扫描面）。 */
interface TaskAuditRow {
  id: string;
  params: string | null;
  isFirst: boolean;
}

/** params 审计 → attachments/imageIds（坏 JSON 按无图集处理——投影面不炸）。 */
function auditOf(row: TaskAuditRow): { attachments: string[]; imageIds: TaskImageId[] } | null {
  if (row.params === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.params);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { attachments?: unknown; imageIds?: unknown };
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.filter((ref): ref is string => typeof ref === 'string' && ref.length > 0)
    : [];
  // imageIds 审计在场（HEAD 起首条带图必写）优先；旧行（首条 task 无审计）按
  // assignTaskImageIds 契约单源按位重建——只有会话首个 agent task 才允许重建
  //（后续轮次附件=讨论插图不进图集，误重建会伪造图集）。
  if (Array.isArray(record.imageIds)) {
    const imageIds = record.imageIds.filter((id): id is TaskImageId => typeof id === 'string');
    if (imageIds.length === attachments.length && attachments.length > 0) {
      return { attachments, imageIds };
    }
    return null;
  }
  if (row.isFirst && attachments.length > 0) {
    return { attachments, imageIds: assignTaskImageIds(attachments.length) };
  }
  return null;
}

/**
 * 会话主图集定位（A5：仅首条常规 followup 分配）：按 created_at/rowid 序扫会话的
 * agent task 行，首个持有效图集审计的行即主图集源。null=会话无主图集。
 */
function sessionImageSet(
  db: SqliteDb,
  sessionId: string,
): { imageIds: TaskImageId[]; attachments: string[] } | null {
  const rows = db
    .prepare(
      "SELECT id, params FROM tasks WHERE session_id = ? AND type = 'agent' ORDER BY created_at, rowid",
    )
    .all(sessionId) as Array<{ id: string; params: string | null }>;
  for (let index = 0; index < rows.length; index += 1) {
    const audit = auditOf({ ...rows[index]!, isFirst: index === 0 });
    if (audit !== null) return { imageIds: audit.imageIds, attachments: audit.attachments };
  }
  return null;
}

export function createTaskImagesCapabilities(deps: TaskImagesCapabilitiesDeps): CapabilityRegistry {
  const streaks = new Map<string, { key: string; count: number }>();

  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return { kind: 'failed', code: 'INVALID_OPERATION', message: `熔断：${reason}。请停止重试，向用户报告失败原因。` };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  /** 任务行校验（owner 绑定面——task-stones agentTaskOf 同语义本地面）。 */
  function agentTaskSessionOf(taskId: string): string {
    const task = deps.db
      .prepare('SELECT id, session_id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; session_id: string | null; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
    if (task.session_id === null) throw new Error(`任务 ${taskId} 不属于任何会话——主图集以会话为锚`);
    return task.session_id;
  }

  function bucketOf(input: unknown): string {
    const taskId = (input as { taskId?: unknown } | null | undefined)?.taskId;
    return typeof taskId === 'string' && taskId.length > 0 ? taskId : 'global';
  }

  const definitions: CapabilityDefinition[] = [
    {
      name: TASK_IMAGES_LIST_TOOL_NAME,
      description:
        '主图集映射观察（只读）：会话首条带图消息的 imageId→blobRef 清单'
        + '[{imageId, blobRef, name, mime, width, height}]。scene.analyze/subject.segment 等'
        + '工具的 imageBlobRef 入参即这里的 blobRef（原始字节引用——与消息内附件引用不同源，'
        + '勿用附件 id）。任意轮次 task 查询返回同一图集；会话无主图集=空清单。',
      authority: 'readonly' as const,
      input: ListInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = ListInputSchema.safeParse(input);
        const bucket = bucketOf(input);
        if (!parsed.success) {
          return noteFailure(bucket, TASK_IMAGES_LIST_TOOL_NAME, `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        try {
          const sessionId = agentTaskSessionOf(parsed.data.taskId);
          const imageSet = sessionImageSet(deps.db, sessionId);
          if (imageSet === null) {
            noteSuccess(bucket);
            return {
              kind: 'ok',
              value: {
                images: [],
                note: '本会话无主图集（首条常规消息未携带图片）——后续轮次附件为讨论插图，不参与 scene.analyze 锚定',
              },
            };
          }
          const images = imageSet.attachments.map((blobRef, index) => {
            const imageId = imageSet.imageIds[index]!;
            const bytes = deps.blobs.read(blobRef);
            if (bytes === null) {
              return { imageId, blobRef, name: null, mime: null, width: null, height: null };
            }
            const mime = sniffImageMime(bytes);
            const size = mime === null ? null : probeImageSize(bytes, mime);
            return {
              imageId,
              blobRef,
              name: `attachment-${blobRef.slice(0, 12)}.${mime === null ? 'bin' : extensionOfMime(mime)}`,
              mime,
              width: size?.width ?? null,
              height: size?.height ?? null,
            };
          });
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              images,
              note: 'blobRef 即 scene.analyze/subject.segment 的 imageBlobRef 入参（原始字节）；宽高为魔数级探测声明',
            },
          };
        } catch (error) {
          return noteFailure(bucket, TASK_IMAGES_LIST_TOOL_NAME, error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];

  return createCapabilityRegistry(definitions);
}
