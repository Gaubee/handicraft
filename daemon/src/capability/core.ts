/**
 * 能力定义层（照 shufa-server capability/core.ts 移植——其上游=
 * skill-creator-v2 capability/core.ts；W4.1 贴钻适配）。
 * 原始需求 2026-09-23（design §2/§3）：name + Zod schema + authority + handler，
 * 把 studio 工具面暴露为 agent 能力（MCP 投影消费）。
 * 正交意图：
 *   [1] CapabilityDefinition / registry 构造（重名 fail fast、闭合结果 union）。
 *   [2] registry 分发：未注册 → unsupported-capability；approved-mutation 对
 *       agent 主体一律 principal-forbidden（W4.2 授权桥接管——届时携带 §3.6
 *       grant 的服务端内部消费路径在此层扩展）；异常兜底为 UNAVAILABLE failed。
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

/** 构造能力 registry；重名注册视为编程错误（fail fast）。 */
export function createCapabilityRegistry(definitions: readonly CapabilityDefinition[]): CapabilityRegistry {
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
        return denied('principal-forbidden', name);
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
