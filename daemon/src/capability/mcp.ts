/**
 * capability → MCP 工具投影（照 shufa-server capability/mcp.ts 移植——其上游=
 * skill-creator-v2 mcp/skill-creator-mcp.ts 最小面；W4.1 贴钻适配）。
 * 原始需求 2026-09-23：内核 dsh-mcp-client 行经 streamable-http 连 daemon 独立
 * loopback MCP listener；capability 名投影为 MCP 工具名（名字字符集限制）。
 * 正交意图：
 *   [1] registry → McpServer：能力全注册（W4.1 面=readonly；proposal 面 W4.2），
 *       schema-faithful（Zod raw shape 直传）。
 *   [2] 闭合结果 → MCP content 投影（denied/failed = isError）。
 *   [3] agent 多模态预览提升（add-vision-pipeline-v2 D5）：结果 value 携带约定字段
 *       AGENT_IMAGE_PREVIEWS_FIELD（agentImagePreviews——contracts 单源键名）时，
 *       每条 {mime, dataBase64} 提升为 MCP image content block（dsh 工具面图像载荷
 *       ——LLM 真看图）；dataBase64 从 JSON 文本面剥离（blobRef/maxSide 等元数据保留）
 *       防同一载荷 token 双计。纯约定面：capability 值不过 schema（unknown），
 *       约定字段缺席=纯文本（既有全部工具零变化）。
 */
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { AGENT_IMAGE_PREVIEWS_FIELD, type AgentImagePreview } from '@handicraft/contracts';
import type { CapabilityRegistry } from './core.js';

/**
 * MCP 工具名：dsh-mcp-client 以 `mcp__<server>__<tool>` 投影；server 名=studio
 * 与能力命名空间重复时去重——`studio.projects` → `projects`（全名
 * mcp__studio__projects）；其余命名空间维持 `.` → `_`。
 */
export function mcpToolName(capabilityName: string): string {
  const dot = capabilityName.indexOf('.');
  if (dot > 0 && capabilityName.slice(0, dot) === 'studio') {
    return capabilityName.slice(dot + 1).replace(/\./g, '_');
  }
  return capabilityName.replace(/\./g, '_');
}

/**
 * capability 调用主体：MCP 面的调用者是模型。
 * W4.2 R1 P1-1：MCP listener 为无用户会话的环回面，调用者**身份不经 principal 携带**
 * （principal 恒 'agent'=授权等级判定面）——行动者身份经工具参数内的 taskId 贯穿：
 * 只读/提案/变更工具的 Zod schema 要求 taskId，服务端以任务行 owner_id 作资源查询
 * 的 owner 过滤/交叉校验（studio.ts requireAgentTask/requireOwnedResource）。模型侧
 * taskId 由 kernel followup 提示注入绑定，MCP 投影 schema-faithful 直传同一要求。
 */
const MCP_PRINCIPAL = 'agent' as const;

/** MCP image content block（SDK ContentBlock 的窄面——data/mimeType 字面量直构）。 */
interface McpImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

/**
 * 闭合结果 → {文本面结果（ok value 内 dataBase64 剥离）, 多模态图集}：约定字段
 * 非数组/条目非法=忽略该条（预览是增益面，绝不为它 fail 工具结果）；非 ok/无约定
 * 字段=原样透传（既有全部工具的文本面零变化）。
 */
function liftAgentImagePreviews(result: unknown): {
  textResult: unknown;
  images: McpImageContent[];
} {
  if (
    typeof result !== 'object' || result === null
    || (result as { kind?: unknown }).kind !== 'ok'
  ) {
    return { textResult: result, images: [] };
  }
  const value = (result as { value?: unknown }).value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { textResult: result, images: [] };
  }
  const record = value as Record<string, unknown>;
  const previews = record[AGENT_IMAGE_PREVIEWS_FIELD];
  if (!Array.isArray(previews) || previews.length === 0) {
    return { textResult: result, images: [] };
  }
  const images: McpImageContent[] = [];
  const kept: Array<Record<string, unknown>> = [];
  for (const entry of previews) {
    if (
      entry === null || typeof entry !== 'object'
      || typeof (entry as { dataBase64?: unknown }).dataBase64 !== 'string'
      || (entry as { dataBase64: string }).dataBase64.length === 0
      || typeof (entry as { mime?: unknown }).mime !== 'string'
    ) {
      continue; // 非法条目忽略（预览缺席不影响结果语义）
    }
    const { dataBase64, mime, ...meta } = entry as AgentImagePreview;
    images.push({ type: 'image', data: dataBase64, mimeType: mime });
    kept.push(meta); // blobRef/maxSide/kind/nodeId/reason 等元数据留在文本面
  }
  if (images.length === 0) return { textResult: result, images: [] };
  const strippedValue = { ...record, [AGENT_IMAGE_PREVIEWS_FIELD]: kept };
  return { textResult: { ...(result as Record<string, unknown>), value: strippedValue }, images };
}

/**
 * 闭合结果 → MCP content 投影（denied/failed = isError；ok value 携带约定字段
 * agentImagePreviews 时提升 image content——模块导出面：投影语义单测消费 +
 * 装配面复用）。纯函数。
 */
export function toToolResult(result: unknown): {
  content: Array<{ type: 'text'; text: string } | McpImageContent>;
  isError?: boolean;
} {
  const isError =
    typeof result === 'object' &&
    result !== null &&
    'kind' in result &&
    (result as { kind: string }).kind !== 'ok';
  const { textResult, images } = liftAgentImagePreviews(result);
  return {
    content: [{ type: 'text', text: safeJson(textResult) }, ...images],
    ...(isError ? { isError: true } : {}),
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** 构造 studio MCP server（loopback listener 每请求新建；stateless）。 */
export function createStudioMcpServer(deps: { capabilities: CapabilityRegistry }): McpServer {
  const server = new McpServer({ name: 'studio', version: '0.1.0' }, { capabilities: { tools: {} } });
  for (const descriptor of deps.capabilities.describe()) {
    const definition = deps.capabilities.definitionOf(descriptor.name);
    const shape =
      definition && typeof (definition.input as { shape?: object }).shape === 'object'
        ? (definition.input as z.ZodObject).shape
        : null;
    const toolName = mcpToolName(descriptor.name);
    if (shape) {
      server.registerTool(
        toolName,
        { description: descriptor.description, inputSchema: z.object(shape) },
        async (args) => toToolResult(await deps.capabilities.call(descriptor.name, args, MCP_PRINCIPAL)),
      );
    } else {
      server.registerTool(toolName, { description: descriptor.description }, async () =>
        toToolResult(await deps.capabilities.call(descriptor.name, undefined, MCP_PRINCIPAL)),
      );
    }
  }
  return server;
}
