/**
 * 内核单元测试（W4.1——移植架构的进程内面）：
 *   [1] 四态的 ①off/③error（配置错误路径）+ 未 boot 拒绝 + 基础服务面不受影响
 *       （②态=独立进程 E2E；④态全链=tests/kernel-live.test.ts）。
 *   [2] sessions 投影（fake 内核——不 boot dsh）：session/event → 契约帧 →
 *       emitFor 单点 → task 终态；畸形事件丢弃。
 *   [3] capability 三件套语义 + RUNAWAY_LIMIT=5 同错连击熔断。
 *   [4] tool-surface deny-list 计算；model-route 桥（settings.yaml/.credentials.yaml
 *       落盘形态+密钥不进 settings）；prompts persona 装配。
 * 测试纪律：全程 fake/mock——任何测试不真实外呼模型。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ORPCError } from '@orpc/server';
import type { Context } from '@deepseek-ai/cordis';
import { createServices, clientFor, type TestServices } from './helpers.js';
import { createAgentTask } from '../src/db/jobs.js';
import { HandicraftKernel, type DshKernelFacade } from '../src/kernel/index.js';
import {
  isModuleResolutionFailure,
  mountHandicraftKernel,
  type HandicraftKernelBootRecord,
} from '../src/kernel/boot.js';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { BlobStore } from '../src/db/blobs.js';
import { JobService } from '../src/jobs/service.js';
import { SessionService } from '../src/sessions/service.js';
import { createTaskSessions } from '../src/kernel/sessions.js';
import {
  KERNEL_AGENT_TOOL_ALLOWLIST,
  KERNEL_DISABLED_TOOL_ROWS,
  productToolDenyList,
} from '../src/kernel/tool-surface.js';
import {
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  apiKeyEnvFor,
  resolveSingleRoute,
  singleRouteBundle,
  syncModelRoutesSettings,
  syncModelRoutesCredentials,
  type StudioModelRoute,
} from '../src/kernel/model-route.js';
import { buildSystemPersona } from '../src/kernel/prompts.js';
import { createCapabilityRegistry, type CapabilityDefinition } from '../src/capability/core.js';
import { createStudioCapabilities, RUNAWAY_LIMIT } from '../src/capability/studio.js';
import { mcpToolName } from '../src/capability/mcp.js';
import { z } from 'zod';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

// ---------------------------------------------------------------- 四态（进程内面）

describe('内核四态：①off/③error（进程内可测面）', () => {
  it('态①off：DSH_ENABLED=0 → followup 501，基础服务面照常', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      s.config.dshEnabled = false;
      const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
      await kernel.boot();
      expect(kernel.state).toBe('off');
      expect(kernel.reason).toContain('DSH_ENABLED=0');
      const client = clientFor(s.context({ token: await s.tokenFor(), kernel: kernel as DshKernelFacade }));
      const { sessionId } = await (
        client as unknown as { session: { create(input: { title?: string }): Promise<{ sessionId: string }> } }
      ).session.create({ title: 'off 态' });
      await expectOrpcError(
        (client as unknown as { session: { followup(input: { sessionId: string; text: string }): Promise<never> } }).session.followup({ sessionId, text: '你好' }),
        'NOT_IMPLEMENTED',
        'off',
      );
      // 基础工作流切片：上传 + 生成 dry-run 照常。
      const uploaded = await (
        client as unknown as { assets: { upload(input: { filename: string; dataBase64: string }): Promise<{ blobRef: string; size: number }> } }
      ).assets.upload({ filename: 'a.png', dataBase64: Buffer.from('fake-png').toString('base64') });
      expect(uploaded.blobRef).toMatch(/^[0-9a-f]{64}$/);
      const gen = await (
        client as unknown as { tasks: { create(input: { kind: string; params: unknown }): Promise<{ taskId: string }> } }
      ).tasks.create({ kind: 'generate', params: { prompt: 'off 态', size: '512x512' } });
      const done = await waitUntil(
        async () =>
          (await (client as unknown as { tasks: { get(input: { taskId: string }): Promise<{ task: { status: string } }> } }).tasks.get({ taskId: gen.taskId })).task.status === 'done',
        15000,
      );
      expect(done).toBe(true);
      await kernel.stop();
    } finally {
      s.dispose();
    }
  });

  it('态③error（配置错误路径）：LLM_API 非 openai-completions → boot 拒绝降级；upload 照常', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      s.config.llm = { ...s.config.llm, api: 'anthropic-messages', apiKey: 'k' };
      const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
      await kernel.boot();
      expect(kernel.state).toBe('error');
      expect(kernel.reason).toContain('openai-completions');
      const client = clientFor(s.context({ token: await s.tokenFor(), kernel: kernel as DshKernelFacade }));
      const { sessionId } = await (
        client as unknown as { session: { create(input: { title?: string }): Promise<{ sessionId: string }> } }
      ).session.create({ title: 'error 态' });
      await expectOrpcError(
        (client as unknown as { session: { followup(input: { sessionId: string; text: string }): Promise<never> } }).session.followup({ sessionId, text: '你好' }),
        'NOT_IMPLEMENTED',
        'error',
      );
      const uploaded = await (
        client as unknown as { assets: { upload(input: { filename: string; dataBase64: string }): Promise<{ blobRef: string; size: number }> } }
      ).assets.upload({ filename: 'b.png', dataBase64: Buffer.from('more').toString('base64') });
      expect(uploaded.size).toBeGreaterThan(0);
      await kernel.stop();
    } finally {
      s.dispose();
    }
  });

  it('未 boot/停机后：followup 编程错误拒绝（rpc 已拦 501——facade 直调防护）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    const kernel = new HandicraftKernel({ config: s.config, db: s.db, jobs: s.jobs, sessions: s.sessions, blobs: s.blobs });
    await expect(kernel.followup(s.anonymous, 'any', { text: 'x' })).rejects.toThrow(/未就绪/);
    await kernel.boot(); // 真实 boot（无 LLM key → 缺省路由 ready）
    expect(kernel.state).toBe('ready');
    await kernel.stop();
    await expect(kernel.followup(s.anonymous, 'any', { text: 'x' })).rejects.toThrow(/未就绪/);
    s.dispose();
  });

  it('isModuleResolutionFailure：错误链分类（②态判定面）', () => {
    const moduleNotFound = Object.assign(new Error("Cannot find package '@deepseek-ai/dsh-base'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    expect(isModuleResolutionFailure(moduleNotFound)).toBe(true);
    const wrapped = new Error('plugin tree failed to load', { cause: moduleNotFound });
    expect(isModuleResolutionFailure(wrapped)).toBe(true);
    expect(isModuleResolutionFailure(new SyntaxError('Unexpected token (1:1)'))).toBe(true);
    expect(isModuleResolutionFailure(new Error('some runtime mount error'))).toBe(false);
    expect(isModuleResolutionFailure(undefined)).toBe(false);
  });

  it('isModuleResolutionFailure：AggregateError.errors 遍历（W4.1 R2 P2-1——上游 loader 聚合形态）', () => {
    const moduleNotFound = Object.assign(new Error("Cannot find package '@deepseek-ai/dsh-session'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    // 聚合错误：成员之一是 module-resolution 失败 → 整体归 missing（非 cause 形态）。
    const aggregate = new AggregateError(
      [new Error('unrelated codec failure'), moduleNotFound],
      'boot loader aggregated failures',
    );
    expect(isModuleResolutionFailure(aggregate)).toBe(true);
    // 纯无关成员的聚合 → 不归 missing。
    expect(
      isModuleResolutionFailure(new AggregateError([new Error('a'), new Error('b')], 'other')),
    ).toBe(false);
  });

  it('boot 审计策略（W4.1 R2 P1-3）：optional FIBER_FAILED/PENDING 不降级但进 record.inactiveActivation；import 失败仍降级', async () => {
    // 经 mountHandicraftKernel 的真实 boot 走通健康树（live 级最小装配）：
    // 健康探针实证分布 = ACTIVE + 1 个良性 FAILED(typert-loader) + 0 import 失败。
    // 本测断言策略面：ready 不被 FAILED/PENDING 破坏，且非活跃行显式暴露（可观测、不静默）。
    const root = mkdtempSync(path.join(tmpdir(), 'kernel-audit-'));
    try {
      const config = loadConfig({
        envFile: path.join(root, 'app', '.env'),
        processEnv: {
          DATA_ROOT: path.join(root, 'data'),
          WEBUI_DIR: path.join(root, 'webui'),
          JWT_SECRET: 'audit-test-secret',
          IMG_DRY_RUN: '1',
          LLM_PROVIDER: 'zai',
          LLM_API: 'openai-completions',
          LLM_MODEL: 'glm-5.3-flash',
          LLM_API_KEY: 'audit-test-key',
          LLM_BASE_URL: 'http://127.0.0.1:9/v1',
        },
      });
      const db = openDatabase(config.dataRoot);
      const blobs = new BlobStore(config.dataRoot, db);
      const jobs = new JobService({ config, db, blobs }, {});
      const sessions = new SessionService({ config, db, blobs, jobs });
      const kernel = new HandicraftKernel({ config, db, jobs, sessions, blobs });
      await kernel.boot({ url: 'http://127.0.0.1:9/mcp', token: 'audit' });
      expect(kernel.state).toBe('ready'); // 良性 FAILED/PENDING 不降级
      const record = (kernel as unknown as { handle?: { record?: HandicraftKernelBootRecord } }).handle?.record;
      expect(record).toBeDefined();
      // 非活跃面可观测：每行带 fiber 态标注（不静默）；全部为非 ACTIVE 态标注。
      for (const item of record!.inactiveActivation) {
        expect(item.state).toMatch(/^fiber=(?!2)/);
      }
      // 健康树实证（0.1.6-alpha.1）：恰好 1 个非活跃（typert-loader 良性 codec 噪声）。
      // 版本线升级后该计数可能归零——断言宽松为「0 import 失败」（降级判据恒不触发）。
      expect(record!.inactiveActivation.length).toBeLessThanOrEqual(2);
      await kernel.stop();
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mountHandicraftKernel：off 短路（不触碰 dsh）', async () => {
    const mounted = await mountHandicraftKernel({
      dataRoot: '/nonexistent',
      modelRoutes: null,
      enabled: false,
    });
    expect(mounted.state).toBe('off');
    expect(mounted.kernel).toBeUndefined();
  });
});

// ---------------------------------------------------------------- sessions 投影（fake 内核）

describe('sessions 投影（fake 内核——不 boot dsh）', () => {
  /** fake inbox 消息（内核 UserMessage 形状最小同构：id/source/content——与 dsh-llm createUserMessage 实测形状一致）。 */
  interface FakeMessage {
    id: string;
    source: { kind: string };
    content: Array<{ type: string; text?: string }>;
  }

  interface FakeAgent {
    session: { id: string };
    status: string;
    followup(message: unknown): void;
    steer(message: unknown): void;
    inject(message: unknown): void;
    cancel(cause: unknown, options?: unknown): void;
    whenIdle(): Promise<void>;
    inbox: {
      nextTurn: FakeMessage[];
      nextStep: FakeMessage[];
      remove(messageId: string): boolean;
      replace(messageId: string, newMessage: unknown): boolean;
      splice(
        target: 'next-turn' | 'next-step',
        start: number,
        deleteCount: number,
        inserted: unknown[],
      ): unknown[];
    };
  }

  function fakeKernelHarness(s: TestServices): {
    sessions: ReturnType<typeof createTaskSessions>;
    fire(event: { type: string; data: unknown }): void;
    lastPrompt(): unknown;
    steered(): unknown[];
    cancelCalls(): Array<{ cause: unknown; options: unknown }>;
    agent: FakeAgent;
  } {
    let listener: ((session: { id: string }, event: { type: string; data: unknown }) => void) | null = null;
    let lastMessage: unknown = null;
    const steeredMessages: unknown[] = [];
    const cancels: Array<{ cause: unknown; options: unknown }> = [];
    /** 内存 inbox（dsh-agent Inbox 同构——nextTurn 逐轮 / nextStep step 边界挂起）。 */
    const inbox: FakeAgent['inbox'] = {
      nextTurn: [],
      nextStep: [],
      remove(messageId: string): boolean {
        for (const bucket of [inbox.nextTurn, inbox.nextStep]) {
          const idx = bucket.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            bucket.splice(idx, 1);
            return true;
          }
        }
        return false;
      },
      replace(messageId: string, newMessage: unknown): boolean {
        for (const bucket of [inbox.nextTurn, inbox.nextStep]) {
          const idx = bucket.findIndex((m) => m.id === messageId);
          if (idx >= 0) {
            bucket[idx] = newMessage as FakeMessage;
            return true;
          }
        }
        return false;
      },
      splice(target, start, deleteCount, inserted) {
        const bucket = target === 'next-turn' ? inbox.nextTurn : inbox.nextStep;
        return bucket.splice(start, deleteCount, ...(inserted as FakeMessage[]));
      },
    };
    const agent: FakeAgent = {
      session: { id: '' },
      status: 'idle',
      followup(message) {
        lastMessage = message;
        inbox.nextTurn.push(message as FakeMessage);
      },
      steer(message) {
        steeredMessages.push(message);
        inbox.nextStep.push(message as FakeMessage);
      },
      inject(message) {
        inbox.nextStep.push(message as FakeMessage);
      },
      cancel(cause, options) {
        cancels.push({ cause, options });
      },
      whenIdle: () => Promise.resolve(),
      inbox,
    };
    const ctx = {
      on: (event: string, cb: (session: { id: string }, event2: { type: string; data: unknown }) => void) => {
        if (event === 'session/event') listener = cb;
        return () => undefined;
      },
      agents: {
        create: async (options: { sessionId: string; setup?: (agentCtx: Context) => void }) => {
          agent.session.id = options.sessionId;
          options.setup?.({ tools: { schemas: () => [{ name: 'bash' }], restrict: () => () => undefined } } as unknown as Context);
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
      lastPrompt: () => lastMessage,
      steered: () => steeredMessages,
      cancelCalls: () => cancels,
      agent,
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
    const row = s.db
      .prepare('SELECT id FROM tasks WHERE session_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(sessionId) as { id: string };
    return row.id;
  }

  it('投影链：user/assistant/tool 事件 → transcript 帧 → turn/end completed → done+task done', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '投影' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '你好' });
      expect(JSON.stringify(h.lastPrompt())).toContain('你好');
      h.fire({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] } });
      h.fire({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '回复正文' }] } } });
      h.fire({ type: 'tool/call', data: { callId: 'c1', name: 'mcp__studio__projects', arguments: '{}' } });
      h.fire({
        type: 'tool/result',
        data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: '[]' }] }] } },
      });
      h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
      const payloads = frames.filter((f) => f.kind === 'transcript') as unknown as Array<{ payload: { role: string; text: string } }>;
      expect(payloads.map((p) => p.payload.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
      expect(payloads[2]?.payload.text).toContain('mcp__studio__projects');
      expect(frames[frames.length - 1]?.kind).toBe('done');
      const status = (s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
      expect(status).toBe('done');
    } finally {
      s.dispose();
    }
  });

  it('turn/end failed（带 error 链）→ error 帧 + task failed；畸形事件丢弃不产帧', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '失败' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: 'x' });
      const before = s.jobs.frames(s.anonymous, taskId, 0).frames.length;
      h.fire({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [] } }); // 空消息=畸形丢弃
      h.fire({ type: 'tool/call', data: { callId: '', name: 'x', arguments: '' } }); // callId 空=畸形
      h.fire({ type: 'turn/end', data: { reason: { kind: 'failed', error: { message: '网关 404', code: 'PROVIDER_HTTP' } } } });
      const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
      expect(frames.length).toBe(before + 1); // 只有终态 error 帧新增
      expect(frames[frames.length - 1]?.kind).toBe('error');
      expect((frames[frames.length - 1] as unknown as { payload: { message: string } }).payload.message).toContain('网关 404（PROVIDER_HTTP）');
      const status = (s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status;
      expect(status).toBe('failed');
    } finally {
      s.dispose();
    }
  });

  // ------------------------------------------------ 三通道（add-agent-three-channel 1.2，对齐 shufa b6cec8a）

  it('steer：live 投递 agent.steer（消息构造与首 prompt 同构）；不在册抛错', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '引导' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '首条' });
      h.sessions.steer(taskId, '往红色偏一点');
      const steered = h.steered();
      expect(steered).toHaveLength(1);
      // 同构断言：createUserMessage 形状（source.kind=user + content text 块 + id）。
      const message = steered[0] as { source: { kind: string }; content: Array<{ type: string; text: string }>; id: string };
      expect(message.source.kind).toBe('user');
      expect(message.content).toEqual([{ type: 'text', text: '往红色偏一点' }]);
      expect(typeof message.id).toBe('string');
      // steer 落 next-step 桶（step 边界挂起——与排队 next-turn 分桶）。
      expect(h.agent.inbox.nextStep).toHaveLength(1);
      // 不在册（未知会话）抛错——调用方走新任务路径。
      expect(() => h.sessions.steer('nope', 'x')).toThrow(/agent session not found/);
    } finally {
      s.dispose();
    }
  });

  it('inbox 面：view 读两桶 / remove / replace（文本重建新身份）/ splice（暂离+按文本放回）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '队列' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '排队第一条' });
      h.sessions.steer(taskId, '引导挂起项');
      // view：两桶（nextTurn=首 prompt 排队；nextStep=引导挂起）。
      const view = h.sessions.inboxView(taskId);
      expect(view.nextTurn.map((e) => e.text)).toEqual(['排队第一条']);
      expect(view.nextStep.map((e) => e.text)).toEqual(['引导挂起项']);
      expect(typeof view.nextTurn[0]?.messageId).toBe('string');
      // replace：原位改写（新消息身份——dsh replace 语义）。
      const replaced = h.sessions.inboxReplace(taskId, view.nextTurn[0]!.messageId, '改写后的排队消息');
      expect(replaced).toBe(true);
      expect(h.sessions.inboxView(taskId).nextTurn.map((e) => e.text)).toEqual(['改写后的排队消息']);
      // remove：删除挂起项；不在队列幂等 false。
      expect(h.sessions.inboxRemove(taskId, view.nextStep[0]!.messageId)).toBe(true);
      expect(h.sessions.inboxRemove(taskId, view.nextStep[0]!.messageId)).toBe(false);
      expect(h.sessions.inboxView(taskId).nextStep).toHaveLength(0);
      // splice：暂离（队尾段取出）→ 返回视图；按文本放回（重建消息）。
      const detached = h.sessions.inboxSplice(taskId, 'next-turn', 0, 1, []);
      expect(detached.map((e) => e.text)).toEqual(['改写后的排队消息']);
      expect(h.sessions.inboxView(taskId).nextTurn).toHaveLength(0);
      const back = h.sessions.inboxSplice(taskId, 'next-turn', 0, 0, ['改写后的排队消息']);
      expect(back).toHaveLength(0); // 无删除
      expect(h.sessions.inboxView(taskId).nextTurn.map((e) => e.text)).toEqual(['改写后的排队消息']);
      // 不在册：inbox 面抛错（重启后未开对话，队列本就空）。
      expect(() => h.sessions.inboxView('nope')).toThrow(/agent session not found/);
    } finally {
      s.dispose();
    }
  });

  it('stopByTask：cancel{user}+keepInbox → done 帧收口+行 done+live 摘除（迟到事件丢弃）+同会话可续聊；不在册 false', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '打断' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: '长任务' });
      h.fire({ type: 'user/message', data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '长任务' }] } });
      const stopped = h.sessions.stopByTask(taskId);
      expect(stopped).toBe(true);
      // cancel 语义：cause={kind:'user'}（AgentCancelCause 对象形）+ keepInbox:true。
      expect(h.cancelCalls()).toEqual([{ cause: { kind: 'user' }, options: { keepInbox: true } }]);
      // 收口：done 终态帧 + 行 done。
      const frames = s.jobs.frames(s.anonymous, taskId, 0).frames;
      expect(frames[frames.length - 1]?.kind).toBe('done');
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('done');
      // live 已摘除：被打断轮的迟到事件（含 turn/end）不再产帧/改状态。
      h.fire({ type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '迟到回复' }] } } });
      h.fire({ type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } });
      const after = s.jobs.frames(s.anonymous, taskId, 0).frames;
      expect(after).toHaveLength(frames.length);
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('done');
      // 打断后可续聊：同会话新任务正常开轮收口（贴钻续聊=新 task）。
      const taskId2 = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId2, { cwd: s.config.dataRoot, prompt: '续聊' });
      h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId2) as { status: string }).status).toBe('done');
      // 不在册（已收敛/重启窗口）→ false（调用方行级收口）。
      expect(h.sessions.stopByTask(taskId2)).toBe(false);
    } finally {
      s.dispose();
    }
  });

  it('终态不覆盖：cancelled 行的迟到 turn/end completed 不复活状态（打断≠取消两态固化前提）', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const h = fakeKernelHarness(s);
      const { sessionId } = s.sessions.create(s.anonymous, { title: '终态取消' });
      const taskId = seedAgentTask(s, sessionId);
      await h.sessions.createTaskSession(taskId, { cwd: s.config.dataRoot, prompt: 'x' });
      // 终态取消（tasks.cancel → jobs.cancel）：行 cancelled（live agent 未被中止——既有行为）。
      s.jobs.cancel(s.anonymous, taskId);
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('cancelled');
      // 内核自然落下的 turn/end completed：帧被 writer fence 丢弃，行不被复活成 done。
      const before = s.jobs.frames(s.anonymous, taskId, 0).frames.length;
      h.fire({ type: 'turn/end', data: { reason: { kind: 'completed' } } });
      expect(s.jobs.frames(s.anonymous, taskId, 0).frames).toHaveLength(before);
      expect((s.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('cancelled');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- capability 三件套 + 熔断

describe('capability 三件套（§3 authority 语义）', () => {
  const readonlyDef: CapabilityDefinition = {
    name: 'studio.projects',
    description: 'd',
    authority: 'readonly',
    input: z.object({}),
    handler: () => ({ kind: 'ok', value: { projects: [] } }),
  };
  const mutationDef: CapabilityDefinition = {
    name: 'studio.export',
    description: 'd',
    authority: 'approved-mutation',
    input: z.object({}),
    handler: () => ({ kind: 'ok', value: 1 }),
  };

  it('readonly 放行；approved-mutation 对 agent 一律 principal-forbidden（W4.2 授权桥接管）；未注册 unsupported', async () => {
    const registry = createCapabilityRegistry([readonlyDef, mutationDef]);
    expect((await registry.call('studio.projects', {}, 'agent')).kind).toBe('ok');
    const deniedMutation = await registry.call('studio.export', {}, 'agent');
    expect(deniedMutation).toMatchObject({ kind: 'denied', reason: 'principal-forbidden' });
    expect(await registry.call('studio.nope', {}, 'agent')).toMatchObject({ kind: 'denied', reason: 'unsupported-capability' });
    expect(() => createCapabilityRegistry([readonlyDef, { ...readonlyDef }])).toThrow(/duplicate/);
  });

  it('RUNAWAY_LIMIT=5 同错连击熔断：连续相同失败第 5 次触发 onRunaway + 熔断消息；成功清零', async () => {
    expect(RUNAWAY_LIMIT).toBe(5);
    const runaways: Array<[string, string]> = [];
    const s = createServices(undefined, { imgDryRun: true });
    try {
      const registry = createStudioCapabilities({
        db: s.db,
        onRunaway: (bucket, detail) => runaways.push([bucket, detail]),
      });
      // P1-1 后只读面要求 taskId（调用者身份=任务行 owner）——成功路径需真实任务行。
      const { sessionId } = s.sessions.create(s.anonymous, { title: '熔断' });
      const taskId = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' }).id;
      for (let i = 1; i <= 4; i += 1) {
        const result = await registry.call('studio.projects', { limit: 'bad', taskId }, 'agent'); // 参数非法→同错连击（按 taskId 分桶）
        expect(result.kind).toBe('failed');
      }
      expect(runaways).toHaveLength(0); // 未达上限
      const fifth = await registry.call('studio.projects', { limit: 'bad', taskId }, 'agent');
      expect(fifth).toMatchObject({ kind: 'failed' });
      expect((fifth as { message: string }).message).toContain('熔断');
      expect(runaways).toHaveLength(1);
      expect(runaways[0]?.[1]).toContain('studio.projects 连续 5 次相同失败');
      // 成功清零：合法调用后连击重置（同桶）。
      expect((await registry.call('studio.projects', { limit: 5, taskId }, 'agent')).kind).toBe('ok');
      for (let i = 0; i < 4; i += 1) await registry.call('studio.projects', { limit: 'bad', taskId }, 'agent');
      expect(runaways).toHaveLength(1); // 未再次触发（清零生效）
    } finally {
      s.dispose();
    }
  });

  it('studio.projects 真实 DB 读（resources 摘要投影）；mcpToolName 去重规则', async () => {
    const s = createServices(undefined, { imgDryRun: true });
    try {
      s.db
        .prepare(
          "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES ('r1', ?, NULL, '我的钻画.gemproj', 0, 'h1', 42, ?, 1, ?, ?)",
        )
        .run(s.anonymous.id, JSON.stringify({ kind: 'gemproj' }), new Date().toISOString(), new Date().toISOString());
      const registry = createStudioCapabilities({ db: s.db });
      const { sessionId } = s.sessions.create(s.anonymous, { title: '工程清单' });
      const taskId = createAgentTask(s.db, { ownerId: s.anonymous.id, sessionId, status: 'running' }).id;
      const result = await registry.call('studio.projects', { limit: 10, taskId }, 'agent');
      expect(result).toMatchObject({ kind: 'ok' });
      expect((result as { value: { projects: Array<{ name: string; kind: string }> } }).value.projects[0]).toMatchObject({
        name: '我的钻画.gemproj',
        kind: 'gemproj',
      });
      expect(mcpToolName('studio.projects')).toBe('projects');
      expect(mcpToolName('studio.patch-propose')).toBe('patch-propose');
      expect(mcpToolName('other.thing')).toBe('other_thing');
    } finally {
      s.dispose();
    }
  });
});

// ---------------------------------------------------------------- deny-list / 模型路由 / persona

describe('tool-surface deny-list（双层收窄的第一层计算面）', () => {
  it('disable 行清单非空；deny=allowlist 与 mcp__studio__* 之外全收窄', () => {
    expect(KERNEL_DISABLED_TOOL_ROWS.length).toBeGreaterThan(0);
    expect(KERNEL_AGENT_TOOL_ALLOWLIST).toContain('ask_user_question');
    const globals = ['bash', 'todo_write', 'ask_user_question', 'mcp__studio__projects', 'exit_plan_mode'];
    const deny = productToolDenyList(globals);
    expect(deny).toEqual(['bash', 'exit_plan_mode']);
  });
});

describe('model-route 桥（z.ai 缺省 + openai-completions 冻结）', () => {
  const emptyLlm = { provider: '', baseUrl: '', apiKey: '', model: '', api: '', visionModel: '' };

  it('无 key → null；有 key → z.ai 缺省路由；协议白名单外拒绝', () => {
    expect(resolveSingleRoute(emptyLlm)).toBeNull();
    const route = resolveSingleRoute({ ...emptyLlm, apiKey: 'sk-x' });
    expect(route).toMatchObject({
      provider: DEFAULT_LLM_PROVIDER,
      baseURL: DEFAULT_LLM_BASE_URL,
      model: DEFAULT_LLM_MODEL,
      api: 'openai-completions',
    });
    expect(() => resolveSingleRoute({ ...emptyLlm, apiKey: 'sk-x', api: 'anthropic-messages' })).toThrow(
      /openai-completions/,
    );
    expect(apiKeyEnvFor('zai')).toBe('ZAI_API_KEY');
    expect(apiKeyEnvFor('openai')).toBe('OPENAI_API_KEY');
  });

  it('settings.yaml/.credentials.yaml 落盘：providers+默认模型；密钥只进 credentials refs', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'model-route-'));
    try {
      const route = resolveSingleRoute({
        provider: 'zai',
        baseUrl: 'http://gw/v1',
        apiKey: 'sk-secret',
        model: 'glm-5.3-flash',
        api: '',
        visionModel: '',
      }) as StudioModelRoute;
      const bundle = singleRouteBundle(route);
      syncModelRoutesSettings(home, bundle);
      syncModelRoutesCredentials(home, bundle.routes);
      const settings = parseYaml(readFileSync(path.join(home, 'settings.yaml'), 'utf8')) as Record<string, unknown>;
      const providers = (settings['llm-pi-ai'] as { providers: Record<string, unknown> }).providers;
      expect(providers['zai']).toMatchObject({ api: 'openai-completions', baseURL: 'http://gw/v1', apiKeyEnv: 'ZAI_API_KEY' });
      expect(JSON.stringify(settings)).not.toContain('sk-secret'); // 密钥零入 settings
      expect((settings['agent-default-model'] as { provider: string }).provider).toBe('zai');
      const creds = parseYaml(readFileSync(path.join(home, '.credentials.yaml'), 'utf8')) as {
        version: number;
        refs: Record<string, string>;
      };
      expect(creds.version).toBe(1);
      expect(creds.refs['ZAI_API_KEY']).toBe('sk-secret');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('prompts persona（系统段装配）', () => {
  it('persona.md 全文注入 + 角色前缀；缺文件降级说明', () => {
    const personaPath = fileURLToPath(new URL('../src/kernel/persona.md', import.meta.url));
    expect(existsSync(personaPath)).toBe(true);
    const text = buildSystemPersona(personaPath);
    expect(text).toContain('贴钻助手');
    expect(text).toContain('排布策略五种');
    expect(buildSystemPersona('/nonexistent/persona.md')).toContain('缺失，降级说明');
  });
});

async function expectOrpcError(promise: Promise<unknown>, code: string, messageFragment?: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect((error as ORPCError<string, unknown>).code).toBe(code);
    if (messageFragment) {
      expect((error as ORPCError<string, unknown>).message).toContain(messageFragment);
    }
    return;
  }
  throw new Error(`预期抛出 ORPCError（${code}）`);
}
