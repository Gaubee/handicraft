/**
 * [真链复验 P1-A，2026-10-01] daemon 外呼 fetch 全局 dispatcher（传输层 300s 超时顶修复）。
 * 原始需求：MCP/内层 LLM 调用实测在 ~301-304s 被杀（6 例）——Node 内建 fetch
 * （bundled undici）缺省 headersTimeout/bodyTimeout=300s，LLM 长调用（非流式
 * 单体响应等待期）与 MCP 环回工具调用（streamable-http 请求挂起至工具完成——
 * SAM 段循环 4-14min）被传输层截杀，顶穿 MCP_TOOL_CALL_TIMEOUT_MS=1200s 工具界
 * →超时错误回 agent 重试烧尽 1800s 兜底。
 * 修：进程级全局 dispatcher（undici Agent，挂注册符号 undici.globalDispatcher.1
 * ——Node 24 内建 fetch 的既定接线，2026-10-01 本机实证）统一抬高 headers/body 界。
 * 覆盖面（进程内全部 global fetch 外呼——装配点=daemon 入口 main() 首段）：
 *   [a] dsh 内核 dsh-mcp-client → MCP SDK StreamableHTTPClientTransport（环回工具调用）；
 *   [b] dsh 内核 dsh-llm-pi-ai → pi-ai 三协议 transport（LLM provider 外呼）；
 *   [c] daemon 自有 scene.analyze / strategy.design / test-route-connection
 *       （fetchImpl 缺省 globalThis.fetch 的调用点）。
 * 版本约束：npm undici 主版本须与 Node bundled 同 major——undici@8 Agent 对
 * Node 24 bundled v7.29 fetch 报 UND_ERR_INVALID_ARG（实证），故锁 undici@7.x。
 */
import { Agent } from 'undici';
import { envTimeoutMs } from './kernel/timeout-env.js';
import { MCP_TOOL_CALL_TIMEOUT_MS_DEFAULT, mcpToolCallTimeoutMs } from './kernel/boot.js';

/** env 覆盖键（毫秒；≥1000 的有限数才生效——envTimeoutMs 严格解析）。 */
export const LLM_FETCH_TIMEOUT_MS_ENV = 'LLM_FETCH_TIMEOUT_MS';

/** 缺省 1200s——与 MCP 工具界缺省同步（单一常量源：MCP_TOOL_CALL_TIMEOUT_MS_DEFAULT）。 */
export const LLM_FETCH_TIMEOUT_MS_DEFAULT = MCP_TOOL_CALL_TIMEOUT_MS_DEFAULT;

/**
 * 有效 fetch 传输界（headersTimeout/bodyTimeout 毫秒）：
 * 缺省=跟随 MCP 工具界（1200s 单源）；env LLM_FETCH_TIMEOUT_MS（≥1000 有限数）
 * 只能在此基础上调整，且**恒不低于工具界**——max 钳制保证 MCP_TOOL_CALL_TIMEOUT_MS
 * 调高后传输层仍永不低于工具层（否则传输界先杀的病灶静默复发）。
 */
export function llmFetchTimeoutMs(): number {
  const toolMs = mcpToolCallTimeoutMs();
  return Math.max(envTimeoutMs(LLM_FETCH_TIMEOUT_MS_ENV, toolMs), toolMs);
}

/**
 * Node 内建 fetch 读全局 dispatcher 的注册符号（跨 undici 实例的既定协议）。
 * 导出面供测试/诊断（装配断言与还原）。
 */
export const GLOBAL_FETCH_DISPATCHER_SYMBOL = Symbol.for('undici.globalDispatcher.1');

/** 当前全局 dispatcher（未装配=undefined）。 */
export function currentGlobalFetchDispatcher(): unknown {
  return (globalThis as { [key: symbol]: unknown })[GLOBAL_FETCH_DISPATCHER_SYMBOL];
}

/** 本模块装配的 Agent（重装时关闭旧实例——进程内自持，不触碰外来 dispatcher）。 */
let installedAgent: Agent | null = null;

/**
 * 装配全局 fetch dispatcher（幂等——重复调用按当下 env 重算并替换旧 Agent）。
 * 返回生效配置（毫秒）供启动日志与测试断言。
 */
export function installGlobalFetchDispatcher(): { timeoutMs: number } {
  const timeoutMs = llmFetchTimeoutMs();
  const agent = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  (globalThis as { [key: symbol]: unknown })[GLOBAL_FETCH_DISPATCHER_SYMBOL] = agent;
  const previous = installedAgent;
  installedAgent = agent;
  if (previous !== null) previous.close().catch(() => undefined);
  return { timeoutMs };
}
