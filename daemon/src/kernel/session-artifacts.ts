/**
 * 会话域工件锚解析（P0 任务域碎片化修复——2026-10-01 真链终点首验，会话 55bc9e13）。
 * 根因：一次 followup=一个新 agent task（kernel/index followup 管线换绑新 taskId），
 * 策略/树/layout 工件按「执行时任务域」fence 落档（DATA_ROOT/tasks/<taskId>/frames.jsonl
 * 的 artifact 帧）；下一轮 inspect/export 以新 taskId 按任务域 latest-by-name 读不到
 * 上轮工件→「资源不存在」——通路在（显式 sourceTaskId 即通，走查员实证），缺的是
 * **缺省锚定**。
 *
 * 语义（会话域「最近成功工件」锚）：
 *   - 域=「同 sessionId ∩ 同 ownerId」的全部任务（查询谓词即围栏——跨会话/跨用户
 *     零泄漏；与 task-export requireSourceTask「同 owner 同 session」同一裁定的
 *     解析面对偶）。
 *   - 「最近一次成功落档」=跨任务比较 artifact 帧 ts（epoch ms，emitFrame 单点
 *     赋值）；同任务内同名取最后一帧（latest-by-name 既有语义——project-lint
 *     latestTaskArtifactRefs 同构）；ts 相等时新任务胜（任务迭代序 created_at DESC,
 *     rowid DESC + 严格大于比较）——确定性，不依赖扫描顺序巧合。
 *   - 帧在场=成功落档（putTaskArtifact 先 blob 后帧——帧成功即工件可回放）；
 *     已取消轮此前成功落档的工件仍可解析（「成功落档」只看帧，不追任务终态；
 *     消费侧三门[lint/mask/engine]照常复验）。
 *   - 任务迭代不早退：任务创建序 ≠ 帧时间序（长轮跨轮存活时旧任务可后落帧），
 *     全量扫描以 ts 定胜（会话任务数=轮数级别，每任务一次 jsonl 读，非热路径）。
 *
 * 消费纪律：**显式 sourceTaskId 在场时调用方走精确锚（行为不变）**——本解析器
 * 只在缺省时消费（精确锚优先；导出/巡检类工具多轮会话默认延续上轮成果=用户
 * 「接着改」心智）。
 */
import path from 'node:path';
import type { AppConfig } from '../config.js';
import type { SqliteDb } from '../db/database.js';
import { FrameStore } from '../jobs/frame-store.js';

/** 会话域工件锚（taskId=工件落档任务域；ts=artifact 帧 epoch ms——「最近」比较键）。 */
export interface SessionArtifactAnchor {
  taskId: string;
  blobRef: string;
  ts: number;
}

/**
 * 会话内最近一次成功落档的同名工件锚（P0 缺省锚定）。
 * 返回 null=该会话（同 owner）任何任务都未曾落档此工件。
 * 帧文件缺席/损坏行=FrameStore readAfter 既有语义（空读/丢损行）——不放大。
 */
export function latestSessionArtifactAnchor(
  deps: { db: SqliteDb; config: Pick<AppConfig, 'dataRoot'> },
  input: { sessionId: string; ownerId: string; name: string },
): SessionArtifactAnchor | null {
  const rows = deps.db
    .prepare(
      'SELECT id FROM tasks WHERE session_id = ? AND owner_id = ? ORDER BY created_at DESC, rowid DESC',
    )
    .all(input.sessionId, input.ownerId) as Array<{ id: string }>;
  let best: SessionArtifactAnchor | null = null;
  for (const row of rows) {
    // 同任务内同名最新帧（逆序首命中——latest-by-name 同语义）。
    const frames = new FrameStore(
      path.join(deps.config.dataRoot, 'tasks', row.id, 'frames.jsonl'),
    ).readAfter(0);
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i]!;
      if (frame.kind !== 'artifact') continue;
      const payload = frame.payload as { name?: unknown; blobRef?: unknown };
      if (payload.name === input.name && typeof payload.blobRef === 'string') {
        // 严格大于：ts 并列时保留新任务（迭代序已 created_at DESC——确定性）。
        if (best === null || frame.ts > best.ts) {
          best = { taskId: row.id, blobRef: payload.blobRef, ts: frame.ts };
        }
        break;
      }
    }
  }
  return best;
}
