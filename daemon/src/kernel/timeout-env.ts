/**
 * env 可调超时解析（W5 走查 P1-4 收口，2026-09-28——FOLLOWUP_TIMEOUT_MS 先例的
 * 统一面）：daemon 侧各调用超时界统一「env 键名=常量名、缺省放大、惰性读 env」
 * （模块加载期脚本在 import 后才置 env，模块级 const 固化会丢覆盖）。有效值须为
 * ≥1000ms 的有限数（毫秒）；非数字/越界回缺省。
 */

/** env 覆盖读取：process.env[envKey] 为 ≥1000 的有限数则取整采用，否则回缺省。 */
export function envTimeoutMs(envKey: string, defaultMs: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isFinite(raw) && raw >= 1000 ? Math.round(raw) : defaultMs;
}
