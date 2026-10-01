/**
 * activity 帧 AOP 测试（意图 [4]——任务详情=任务会话的投影，2026-10-02）：
 *   [1] tool-labels 纯函数：规范名反解（mcp 投影名→映射表键候选序）/label 亮点
 *       拼接/入参摘要白名单+脱敏/产出探测（blobRef 优先级+errorBrief）。
 *   [2] AOP 集成（fake 内核——kernel.test.ts 同款 harness 形）：tool/call+
 *       tool/result 事件 → activity running/终态配对帧落 frames.jsonl（jsonl 字节
 *       与 jobs.frames 读回双断言）+ transcript 帧并存不互替 + settle 在途回收
 *       cancelled + errorBrief 配对。
 * 测试纪律：fake 内核零 boot dsh、零外呼。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import type { ActivityPayload, Frame } from '@handicraft/contracts';
import { createServices, type TestServices } from './helpers.js';
import { createTaskSessions } from '../src/kernel/sessions.js';
import {
  activityLabelFor,
  canonicalToolName,
  summarizeToolInput,
  summarizeToolResult,
} from '../src/kernel/tool-labels.js';

const hash = 'a'.repeat(64);
const otherHash = 'b'.repeat(64);

// ---------------------------------------------------------------- tool-labels 纯函数

describe('tool-labels：规范名反解与 label', () => {
  it('mcp 投影名 → 映射表键（候选序确定性；未映射保裸名）', () => {
    expect(canonicalToolName('mcp__studio__subject_segment')).toBe('studio.subject.segment');
    expect(canonicalToolName('mcp__studio__studio.scene.analyze')).toBe('studio.scene.analyze'); // 圆点保留形态（前端注释实测形）
    expect(canonicalToolName('mcp__studio__kb_list')).toBe('studio.kb_list'); // 原生下划线（补前缀候选）
    expect(canonicalToolName('mcp__studio__stones_list')).toBe('stones.list'); // 非 studio 族（还原圆点候选）
    expect(canonicalToolName('ask_user_question')).toBe('ask_user_question'); // 内建裸名直中
    expect(canonicalToolName('mcp__studio__whatever_new')).toBe('whatever_new'); // 未映射不猜译
  });
  it('label = 中文映射 + name 类亮点（`映射 · 亮点`）；无亮点裸映射', () => {
    expect(activityLabelFor('mcp__studio__subject_segment', '{"name":"左手"}')).toBe('抠图分件 · 左手');
    expect(activityLabelFor('mcp__studio__export', '{}')).toBe('导出');
    expect(activityLabelFor('ask_user_question', '{"question":"选哪张"}')).toBe('询问用户 · 选哪张');
  });
});

describe('tool-labels：入参摘要（白名单+脱敏）', () => {
  it('name/count/id 类入摘要；taskId/apiKey 等密钥与内部 id 永不入', () => {
    expect(summarizeToolInput('{"name":"左手","count":3,"taskId":"t-9","apiKey":"sk-secret"}')).toBe(
      'name=左手，count=3',
    );
    expect(summarizeToolInput('{"strategy":"hex-pitch","gapMm":0.4}')).toBe('strategy=hex-pitch');
  });
  it('绝对路径折叠 basename；长文本分值截断；非 JSON/空对象=省略', () => {
    expect(summarizeToolInput('{"prompt":"看这张 /Users/kzf/Pictures/秘密图.png 设计"}')).toBe(
      'prompt=看这张 秘密图.png 设计',
    );
    const long = 'x'.repeat(300);
    expect((summarizeToolInput(`{"prompt":"${long}"}`) ?? '').length).toBeLessThanOrEqual(200);
    expect(summarizeToolInput('not json')).toBeUndefined();
    expect(summarizeToolInput('{}')).toBeUndefined();
    expect(summarizeToolInput('')).toBeUndefined();
  });
});

describe('tool-labels：产出与错误提炼', () => {
  it('ok：value.blobRef 探测 + count/note 摘要；preview.after/bundle.png 降级序', () => {
    const probed = summarizeToolResult(
      JSON.stringify({ kind: 'ok', value: { blobRef: hash, count: 342, note: '检出完成' } }),
      false,
    );
    expect(probed.outputBlobRef).toBe(hash);
    expect(probed.outputSummary).toBe('count=342，note=检出完成');
    const preview = summarizeToolResult(
      JSON.stringify({ kind: 'ok', value: { preview: { before: otherHash, after: hash } } }),
      false,
    );
    expect(preview.outputBlobRef).toBe(hash); // after 优先于 before（文档序）
    const bundle = summarizeToolResult(
      JSON.stringify({ kind: 'ok', value: { bundle: { svg: otherHash, png: hash, bom: otherHash } } }),
      false,
    );
    expect(bundle.outputBlobRef).toBe(hash);
    const none = summarizeToolResult(JSON.stringify({ kind: 'ok', value: { ok: true } }), false);
    expect(none.outputBlobRef).toBeUndefined();
  });
  it('探测桶序（w20 走查 major-1）：imageBlobRef > preview.after > 其余 blobRef 键；scene.analyze 真形不走 JSON 工件', () => {
    // scene.analyze 真形：artifactBlobRef=scene-analysis.json（非图片——旧桶序置顶
    // 使缩略图 src 指向 JSON→415 裂图）；intakeResample.imageBlobRef=归一底图 png。
    const sceneAnalyze = summarizeToolResult(
      JSON.stringify({
        kind: 'ok',
        value: {
          channel: 'llm-route',
          artifactBlobRef: otherHash,
          intakeResample: { applied: true, imageBlobRef: hash, fromImageBlobRef: 'c'.repeat(64) },
          meta: { model: 'vl', durationMs: 1200 },
          analysis: { kind: 'scene-analysis' },
        },
      }),
      false,
    );
    expect(sceneAnalyze.outputBlobRef).toBe(hash);
    // 通用 blobRef 键降序后：preview.after 反超（既有可视面约定 > 内容种类未知键）。
    const previewBeatsGeneric = summarizeToolResult(
      JSON.stringify({ kind: 'ok', value: { blobRef: otherHash, preview: { before: 'c'.repeat(64), after: hash } } }),
      false,
    );
    expect(previewBeatsGeneric.outputBlobRef).toBe(hash);
    // imageBlobRef 仍居首（键语义=显式图片）。
    const imageFirst = summarizeToolResult(
      JSON.stringify({ kind: 'ok', value: { preview: { after: otherHash }, imageBlobRef: hash } }),
      false,
    );
    expect(imageFirst.outputBlobRef).toBe(hash);
    // 仅通用键在场时仍探测（不因降序而丢失——兜底可读面）。
    const genericOnly = summarizeToolResult(JSON.stringify({ kind: 'ok', value: { someBlobRef: hash } }), false);
    expect(genericOnly.outputBlobRef).toBe(hash);
  });
  it('error：failed 的 message（+code）与 denied 的 reason；非 JSON 原文截断', () => {
    expect(
      summarizeToolResult(JSON.stringify({ kind: 'failed', code: 'UNAVAILABLE', message: 'boom' }), true).errorBrief,
    ).toBe('boom（UNAVAILABLE）');
    expect(
      summarizeToolResult(
        JSON.stringify({ kind: 'denied', reason: 'principal-forbidden', requestedOperation: 'studio.export' }),
        true,
      ).errorBrief,
    ).toContain('principal-forbidden');
    const brief = summarizeToolResult('Error: raw failure text', true).errorBrief ?? '';
    expect(brief).toContain('raw failure text');
    expect(brief.length).toBeLessThanOrEqual(300);
  });
});

// ---------------------------------------------------------------- AOP 集成（fake 内核）

/** fake 内核 harness（kernel.test.ts 同款形——firehose listener 直驱）。 */
function fakeKernelHarness(s: TestServices): {
  sessions: ReturnType<typeof createTaskSessions>;
  fire(event: { type: string; data: unknown }): void;
} {
  let listener: ((session: { id: string }, event: { type: string; data: unknown }) => void) | null = null;
  let lastMessage: unknown = null;
  const agent = {
    session: { id: '' },
    status: 'idle',
    followup: (message: unknown): void => {
      lastMessage = message;
    },
    steer: (): void => undefined,
    inject: (): void => undefined,
    cancel: (): void => undefined,
    whenIdle: () => Promise.resolve(),
    inbox: { nextTurn: [], nextStep: [], remove: () => false, replace: () => false, splice: () => [] },
  };
  const ctx = {
    on: (event: string, cb: (session: { id: string }, event2: { type: string; data: unknown }) => void) => {
      if (event === 'session/event') listener = cb;
      return () => undefined;
    },
    agents: {
      create: async (options: { sessionId: string; setup?: (agentCtx: Context) => void }) => {
        agent.session.id = options.sessionId;
        options.setup?.({ tools: { schemas: () => [], restrict: () => () => undefined } } as unknown as Context);
        return { agent, dispose: async () => undefined };
      },
    },
  } as unknown as Context;
  const fakeHandle = { ctx, record: { entries: [], activationOrder: [], inactiveActivation: [] }, globalToolNames: () => [], dispose: async () => undefined };
  const sessions = createTaskSessions({
    kernel: () => fakeHandle,
    jobs: s.jobs,
    db: s.db,
    modelSelection: () => ({ provider: 'zai', model: 'glm-5.3-flash' }),
  });
  sessions.attach(fakeHandle);
  return {
    sessions,
    fire: (event) => listener?.(agent.session, event),
  };
}

function seedAgentTask(s: TestServices, sessionId: string): string {
  s.db
    .prepare(
      'INSERT INTO tasks (id, owner_id, resource_id, session_id, type, status, params, result_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)',
    )
    .run(
      `t-${Math.random().toString(16).slice(2, 10)}`,
      s.anonymous.id,
      sessionId,
      'agent',
      'running',
      new Date().toISOString(),
      new Date().toISOString(),
    );
  return (s.db.prepare('SELECT id FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1').get(sessionId) as { id: string }).id;
}

/** 读回 task 帧流中的 activity 载荷（按序）。 */
function activitiesOf(frames: Frame[]): ActivityPayload[] {
  return frames.filter((f) => f.kind === 'activity').map((f) => (f as { payload: ActivityPayload }).payload);
}

describe('activity AOP：tool 事件 → 配对帧（frames.jsonl 落盘）', () => {
  it('running→ok 配对完整：label/摘要/产出探测 + transcript 并存不互替', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '配对' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '抠左手' });
      h.fire({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '抠左手' }] } });
      h.fire({
        type: 'tool/call',
        data: { callId: 'c1', name: 'mcp__studio__subject_segment', arguments: '{"name":"左手","taskId":"t-9"}' },
      });
      h.fire({
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId: 'c1' },
            content: [{ type: 'tool-result', content: [{ type: 'text', text: JSON.stringify({ kind: 'ok', value: { blobRef: hash, count: 342 } }) }] }],
          },
        },
      });
      h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } });

      const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
      const acts = activitiesOf(frames);
      expect(acts).toHaveLength(2);
      const [running, done] = acts as [ActivityPayload, ActivityPayload];
      expect(running.status).toBe('running');
      expect(running.tool).toBe('studio.subject.segment');
      expect(running.label).toBe('抠图分件 · 左手');
      expect(running.inputSummary).toBe('name=左手');
      expect(running.durationMs).toBeUndefined();
      expect(done.status).toBe('ok');
      expect(done.activityId).toBe(running.activityId); // 同 callId 配对
      expect(done.durationMs).toBeGreaterThanOrEqual(0);
      expect(done.outputBlobRef).toBe(hash);
      expect(done.outputSummary).toBe('count=342');
      // transcript 帧并存（模型视角转录不因 activity 替代而消失）。
      const transcripts = frames.filter((f) => f.kind === 'transcript') as unknown as Array<{ payload: { role: string; text: string } }>;
      expect(transcripts.filter((t) => t.payload.role === 'tool')).toHaveLength(2);
      expect(transcripts.find((t) => t.payload.role === 'tool')?.payload.text).toContain('mcp__studio__subject_segment');
      expect(frames[frames.length - 1]?.kind).toBe('done');
      // jsonl 字节级：activity 帧真实落盘（回放面=同一文件）。
      const jsonl = path.join(s.config.dataRoot, 'tasks', taskId, 'frames.jsonl');
      expect(existsSync(jsonl)).toBe(true);
      expect(readFileSync(jsonl, 'utf8')).toContain('"kind":"activity"');
    } finally {
      s.dispose();
    }
  });

  it('running→error 配对：errorBrief=failed message（+code）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '失败配对' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: 'x' });
      h.fire({ type: 'tool/call', data: { callId: 'c9', name: 'mcp__studio__generate', arguments: '{}' } });
      h.fire({
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId: 'c9' },
            content: [
              {
                type: 'tool-result',
                isError: true,
                content: [{ type: 'text', text: JSON.stringify({ kind: 'failed', code: 'UNAVAILABLE', message: '网关超时' }) }],
              },
            ],
          },
        },
      });
      h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      const acts = activitiesOf(s.jobs.frames(s.anonymous, taskId, 0).frames);
      expect(acts).toHaveLength(2);
      expect(acts[1]?.status).toBe('error');
      expect(acts[1]?.errorBrief).toBe('网关超时（UNAVAILABLE）');
      expect(acts[1]?.durationMs).toBeGreaterThanOrEqual(0);
    } finally {
      s.dispose();
    }
  });

  it('settle 在途回收：turn 终止时未返回的调用补 cancelled 终态帧（先于任务终态帧）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '取消' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '长工具' });
      h.fire({ type: 'tool/call', data: { callId: 'c-long', name: 'mcp__studio__strategy_design', arguments: '{"style":"密铺"}' } });
      h.fire({ type: 'turn/end', data: { reason: { kind: 'aborted' } } });
      const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
      const acts = activitiesOf(frames);
      expect(acts).toHaveLength(2);
      expect(acts[0]?.status).toBe('running');
      expect(acts[0]?.label).toBe('策略设计 · 密铺');
      expect(acts[1]?.status).toBe('cancelled');
      expect(acts[1]?.activityId).toBe(acts[0]?.activityId);
      // 帧序：cancelled 帧先于任务终态 error 帧（时间线配对不悬空）。
      const cancelledIndex = frames.findIndex((f) => f.kind === 'activity' && (f as { payload: ActivityPayload }).payload.status === 'cancelled');
      const errorIndex = frames.findIndex((f) => f.kind === 'error');
      expect(cancelledIndex).toBeGreaterThanOrEqual(0);
      expect(errorIndex).toBeGreaterThan(cancelledIndex);
    } finally {
      s.dispose();
    }
  });

  it('未配对的迟到 tool/result 不产 activity 帧（无 running 先行=无悬空终态）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '迟到' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: 'y' });
      h.fire({
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId: 'ghost' },
            content: [{ type: 'tool-result', content: [{ type: 'text', text: '{"kind":"ok"}' }] }],
          },
        },
      });
      h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
      expect(activitiesOf(frames)).toHaveLength(0); // 无 running 先行——只落 transcript
      expect(frames.some((f) => f.kind === 'transcript' && (f as { payload: { role: string } }).payload.role === 'tool')).toBe(true);
    } finally {
      s.dispose();
    }
  });
});
