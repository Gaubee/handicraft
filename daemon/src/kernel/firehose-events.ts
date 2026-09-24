/**
 * firehose `session/event` 载荷的入口 schema 家族（照 shufa-server kernel/
 * firehose-events.ts 的家族裁剪——按贴钻契约 §3.5 agent 帧族的消费面收窄）。
 * 原始需求 2026-09-23（W4.1）：event.data 是内核来的外部输入，必须 unknown →
 * safeParse；畸形整事件丢弃 + 有界诊断，不产帧不消耗 seq。
 * 裁剪说明：贴钻契约帧族无 delta/todo/title 帧（transcript/approval/done/
 * error 五类）——assistant/chunk 等事件不被消费，schema 家族只留五个消费事件。
 */
import { z } from 'zod';

/** 消息 source 消费面：kind（user/model/tool 判别）。 */
const MessageSourceSchema = z.object({ kind: z.string().optional() }).passthrough();

/** 消息 content 块最小消费面：type 判别串 + text（存在即必须 string）。 */
const MessageBlockSchema = z
  .object({ type: z.string().min(1), text: z.string().optional() })
  .passthrough();

/** 消息外壳：source + content 块数组（content 必在且非空——空消息按畸形丢弃）。 */
const MessageShapeSchema = z
  .object({ source: MessageSourceSchema.optional(), content: z.array(MessageBlockSchema).min(1) })
  .passthrough();

/**
 * {message: M} 信封解包：M 为对象则取 M，否则 data 即 message（user/message
 * 实测是后者，assistant/message 实测是前者；等价于 `data.message ?? data`）。
 */
function messageEnvelopeOf(raw: unknown): unknown {
  if (typeof raw === 'object' && raw !== null && 'message' in raw) {
    const wrapped = (raw as { message: unknown }).message;
    if (typeof wrapped === 'object' && wrapped !== null) return wrapped;
  }
  return raw;
}

export const MessageEventSchema = z.preprocess(messageEnvelopeOf, MessageShapeSchema);

/** turn/end：reason.kind/error 消费面。 */
export const TurnEndEventSchema = z
  .object({ reason: z.object({ kind: z.string().optional(), error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional() }).passthrough().optional() })
  .passthrough();

/** tool/call：callId/name 非空 + arguments 原始 JSON 字符串（契约必填）。 */
export const ToolCallEventSchema = z
  .object({ callId: z.string().min(1), name: z.string().min(1), arguments: z.string() })
  .passthrough();

/**
 * tool/result：source.kind='tool' + callId 必填；content 为单个 tool-result 块
 * （块内 content 数组的 text part 消费面；isError 标注错误位）。
 */
export const ToolResultEventSchema = z.object({
  message: z
    .object({
      source: z.object({ kind: z.literal('tool'), callId: z.string().min(1) }).passthrough(),
      content: z.tuple([
        z
          .object({
            type: z.literal('tool-result'),
            isError: z.boolean().optional(),
            content: z.array(z.object({ type: z.string().min(1), text: z.string().optional() }).passthrough()),
          })
          .passthrough(),
      ]),
    })
    .passthrough(),
});

/** turn/start：消费面不读字段，非对象载荷按畸形丢弃。 */
export const ObjectPayloadEventSchema = z.record(z.string(), z.unknown());

/** 诊断日志整行硬上限（绝不打印全 payload）。 */
const DROPPED_EVENT_LOG_MAX = 200;

export function logDroppedEvent(sessionId: string, type: string, data: unknown): void {
  let detail: string;
  try {
    const serialized = JSON.stringify(data);
    detail = serialized === undefined ? String(data) : serialized;
  } catch {
    detail = String(data);
  }
  let line = `[kernel-sessions] dropped malformed ${type} event for ${sessionId}: ${detail}`;
  if (line.length > DROPPED_EVENT_LOG_MAX) line = `${line.slice(0, DROPPED_EVENT_LOG_MAX - 1)}…`;
  console.warn(line);
}
