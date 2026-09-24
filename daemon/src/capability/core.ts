/**
 * 能力定义层（照 shufa-server capability/core.ts 移植——其上游=
 * skill-creator-v2 capability/core.ts；W4.1 贴钻适配 + W4.2 授权桥 call 路径扩展）。
 * 原始需求 2026-09-23（design §2/§3）：name + Zod schema + authority + handler，
 * 把 studio 工具面暴露为 agent 能力（MCP 投影消费）。
 * 正交意图：
 *   [1] CapabilityDefinition / registry 构造（重名 fail fast、闭合结果 union）。
 *   [2] registry 分发：未注册 → unsupported-capability；approved-mutation 对
 *       agent 主体走 §3.6 授权桥（W4.2）：mutationAuth 预检（只读——proposalId→
 *       grant 存在性/绑定/过期判定）通过才进 handler；handler 内的同事务消费
 *       （consumeForExecution）是权威判定。未装配授权桥时保持 W4.1 语义
 *       （一律 principal-forbidden——测试/降级面）；异常兜底为 UNAVAILABLE failed。
 */
import type { ZodType } from 'zod';

/** 能力权威等级（§3 三分类）：readonly agent 直调；proposal 走审批；approved-mutation 需授权桥。 */
export type CapabilityAuthority = 'readonly' | 'proposal' | 'approved-mutation';

export type CapabilityPrincipal = 'agent' | 'human-ui';

export type CapabilityCallResult =
  | { kind: 'ok'; value: unknown }
  | { kind: 'denied'; reason: 'unsupported-capability' | 'principal-forbidden'; requestedOperation: string }
  | {
      kind: 'failed';
      code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_OPERATION' | 'UNAVAILABLE' | 'STALE';
      message: string;
    };

/** 能力定义。handler 返回闭合结果；抛出的异常由 registry 兜底。 */
export interface CapabilityDefinition {
  /** 能力名（命名空间.动词，如 `studio.projects`；全局唯一）。 */
  readonly name: string;
  readonly description: string;
  readonly authority: CapabilityAuthority;
  readonly input: ZodType;
  readonly output?: ZodType;
  readonly handler: (input: unknown, principal: CapabilityPrincipal) => CapabilityCallResult | Promise<CapabilityCallResult>;
}

export interface CapabilityDescriptor {
  name: string;
  description: string;
  authority: CapabilityAuthority;
}

/**
 * §3.6 授权桥预检（approved-mutation 对 agent 主体的 call 路径快面——只读不消费）：
 * 真实消费（grant 消费即焚+claim+CAS）在工具 handler 的执行事务内单点完成。
 */
export interface MutationAuthorization {
  precheck(name: string, input: unknown): { ok: boolean; reason?: string; message?: string };
}

export interface CapabilityRegistry {
  call(name: string, input: unknown, principal: CapabilityPrincipal): Promise<CapabilityCallResult>;
  definitionOf(name: string): CapabilityDefinition | null;
  describe(): CapabilityDescriptor[];
  names(): readonly string[];
}

function denied(reason: 'unsupported-capability' | 'principal-forbidden', operation: string): CapabilityCallResult {
  return { kind: 'denied', reason, requestedOperation: operation };
}

function failed(code: 'NOT_FOUND' | 'CONFLICT' | 'INVALID_OPERATION' | 'UNAVAILABLE' | 'STALE', message: string): CapabilityCallResult {
  return { kind: 'failed', code, message };
}

/**
 * 构造能力 registry；重名注册视为编程错误（fail fast）。
 * mutationAuth（W4.2）：approved-mutation 对 agent 的放行预检桥——未装配时维持
 * W4.1 一律拒绝语义（授权语义零降级：没有桥就没有放行路径）。
 */
export function createCapabilityRegistry(
  definitions: readonly CapabilityDefinition[],
  options?: { mutationAuth?: MutationAuthorization },
): CapabilityRegistry {
  const byName = new Map<string, CapabilityDefinition>();
  for (const definition of definitions) {
    if (byName.has(definition.name)) {
      throw new Error(`duplicate capability registration: ${definition.name}`);
    }
    byName.set(definition.name, definition);
  }
  return {
    async call(name, input, principal) {
      const definition = byName.get(name);
      if (!definition) return denied('unsupported-capability', name);
      if (definition.authority === 'approved-mutation' && principal === 'agent') {
        const bridge = options?.mutationAuth;
        if (!bridge) return denied('principal-forbidden', name);
        const verdict = bridge.precheck(name, input);
        if (!verdict.ok) {
          // 无授权直调（无 proposalId/无 grant）=主体级拒绝（principal-forbidden——
          // 与 W4.1 语义同形）；其余必拒路径（过期/重放/漂移/并发/绑定不符）携带
          // agent 可读原因的 failed 闭合结果。
          if (verdict.reason === 'no-proposal' || verdict.reason === 'grant-missing' || verdict.reason === undefined) {
            return denied('principal-forbidden', name);
          }
          const code =
            verdict.reason === 'stale-revision'
              ? ('STALE' as const)
              : verdict.reason === 'concurrent'
                ? ('CONFLICT' as const)
                : ('INVALID_OPERATION' as const);
          return failed(code, `${name} 必拒（${verdict.reason}）：${verdict.message ?? ''}`);
        }
      }
      try {
        return await definition.handler(input, principal);
      } catch (error) {
        return failed('UNAVAILABLE', error instanceof Error ? error.message : String(error));
      }
    },
    definitionOf: (name) => byName.get(name) ?? null,
    describe: () =>
      [...byName.values()].map(({ name, description, authority }) => ({ name, description, authority })),
    names: () => [...byName.keys()],
  };
}
