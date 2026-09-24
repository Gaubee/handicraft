/**
 * studio 能力集（design §3 工具清单的 W4.1 投影；RUNAWAY 熔断语义照
 * shufa-server capability/analysis.ts 的 noteFailure/RUNAWAY_LIMIT 移植）。
 * 原始需求 2026-09-23：W4.1 实装 {studio.projects}（只读——resources 表摘要）；
 * proposal/approved-mutation 全工具面归 W4.2（本文件预留扩展位）。
 * 熔断（design §2 RUNAWAY_LIMIT=5）：同一任务同一工具**连续相同失败**计数
 * 达上限 → onRunaway 回调（取消会话+任务 failed——实证背景：glm-4.7 路径
 * 错误时循环重试 150+ 次/25 分钟烧 token）。计数键=工具+失败摘要；成功即清零。
 */
import { z } from 'zod';
import type { SqliteDb } from '../db/database.js';
import { createCapabilityRegistry, type CapabilityCallResult, type CapabilityRegistry } from './core.js';

/** 同一任务同一工具连续相同失败次数上限（超过即熔断）。 */
export const RUNAWAY_LIMIT = 5;

export interface StudioCapabilitiesDeps {
  db: SqliteDb;
  /**
   * 熔断回调（W4.1 接线：cancel 会话 + 任务 failed；shufa abortRunaway 同义）。
   * taskId 在 W4.1 会话投影内由调用侧闭包绑定（能力层只见 taskDir 归属键——
   * 本波工具面无任务目录，熔断键退化为「会话无 taskDir」全局桶，W4.2 工具
   * 面带任务上下文后按任务分桶）。
   */
  onRunaway?: (bucket: string, detail: string) => void;
}

/** 失败连击账本（bucket+key → count）。 */
interface FailureStreak {
  key: string;
  count: number;
}

export function createStudioCapabilities(deps: StudioCapabilitiesDeps): CapabilityRegistry {
  const streaks = new Map<string, FailureStreak>();

  /** 失败记账 + 熔断判定（照 shufa analysis.ts noteFailure 语义）。 */
  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return {
        kind: 'failed',
        code: 'INVALID_OPERATION',
        message: `熔断：${reason}。请停止重试，向用户报告失败原因。`,
      };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  /** 成功清零（连续语义：成功打断连击）。 */
  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  const projectsInput = z.object({ limit: z.number().int().min(1).max(100).optional() });

  return createCapabilityRegistry([
    {
      name: 'studio.projects',
      description:
        '列出当前用户保存的贴钻工程/文档资源（id、名称、格式、大小、更新时间）。只读；用于确定后续排钻/编辑操作针对的资源。',
      authority: 'readonly',
      input: projectsInput,
      async handler(input) {
        const parsed = projectsInput.safeParse(input);
        if (!parsed.success) {
          return noteFailure('global', 'studio.projects', `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        const limit = parsed.data.limit ?? 20;
        try {
          const rows = deps.db
            .prepare(
              'SELECT id, name, meta, size, updated_at FROM resources WHERE is_dir = 0 ORDER BY updated_at DESC LIMIT ?',
            )
            .all(limit) as { id: string; name: string; meta: string | null; size: number; updated_at: string }[];
          noteSuccess('global');
          return {
            kind: 'ok',
            value: {
              projects: rows.map((row) => ({
                id: row.id,
                name: row.name,
                kind: kindOfMeta(row.meta),
                size: row.size,
                updatedAt: row.updated_at,
              })),
            },
          };
        } catch (error) {
          return noteFailure('global', 'studio.projects', error instanceof Error ? error.message : String(error));
        }
      },
    },
    // W4.2 扩展位（§3 工具清单）：readonly 增 studio.templates/pave-preview/
    // export-dryrun/bom；proposal 增 studio.patch-propose；approved-mutation 增
    // studio.patch-apply/generate/export（授权桥 §3.6 接管 agent 主体放行判定）。
  ]);
}

/** meta JSON 的 kind 字段（导入面记录的格式族；缺省 unknown）。 */
function kindOfMeta(meta: string | null): string {
  if (!meta) return 'unknown';
  try {
    const parsed = JSON.parse(meta) as { kind?: unknown };
    return typeof parsed.kind === 'string' ? parsed.kind : 'unknown';
  } catch {
    return 'unknown';
  }
}
