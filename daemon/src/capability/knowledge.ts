/**
 * 知识库能力面（split-admin-portal design §4——zhumo capability/knowledge.ts
 * 复刻，**第一版只读**）。读：kb_list（组名+key 扫描面，图书馆书架模型）/
 * kb_get（单条内容）。写面（zhumo 的 proposal 级四工具）本波不注册——
 * agent 写挂 W4.2 授权桥后续波（design §4「第一版 Agent 只读」）。
 * 工具名 studio.* 命名空间（MCP 投影 mcpToolName 去前缀 → mcp__studio__kb_list）。
 */
import { z } from 'zod';
import type { CapabilityDefinition } from './core.js';
import type { KbStore } from '../kb/store.js';

const nameField = z.string().trim().min(1).max(64);
const keyField = z.string().trim().min(1).max(128);

export function createKnowledgeCapabilities(store: KbStore): CapabilityDefinition[] {
  return [
    {
      name: 'studio.kb_list',
      description:
        '知识库目录：返回全部分组名、分组说明与组内条目名（不含内容）——'
        + '先扫目录再按需 kb_get，好比看书架类别与书名。贴钻领域知识（钻径规格/密度'
        + '单位/色系编码/工艺规则/材质质感）排钻设计前建议先扫目录。',
      authority: 'readonly',
      input: z.object({}),
      handler: () => ({ kind: 'ok', value: { groups: store.listIndex() } }),
    },
    {
      name: 'studio.kb_get',
      description: '读取一条知识：分组名 + 条目名 → 内容全文。',
      authority: 'readonly',
      input: z.object({ group: nameField, key: keyField }),
      handler: (raw) => {
        const input = z.object({ group: z.string(), key: z.string() }).safeParse(raw);
        if (!input.success) return { kind: 'failed', code: 'INVALID_OPERATION', message: '参数不合法' };
        const entry = store.getEntry(input.data.group, input.data.key);
        if (!entry) {
          return {
            kind: 'failed',
            code: 'NOT_FOUND',
            message: `知识条目不存在：${input.data.group}/${input.data.key}（以 kb_list 返回为准）`,
          };
        }
        return { kind: 'ok', value: entry };
      },
    },
  ];
}
