/**
 * dsh 内核 live 集成测试（design §6.4 态④——W4.1）：进程内 boot 真实 dsh-base
 * 内核（0.1.6-alpha.1 官方 app-boot 路径）+ **本地 mock openai-completions 网关**
 * （127.0.0.1 SSE——确定性替身，零真实外呼）→ followup 全链：task 行 → 帧
 * （transcript/done）→ task done；工具链路（mock 返回 tool_calls → MCP 环回
 * → studio.projects 真实执行 → 结果回模型）；deny-list（mock 调用 allowlist 外
 * 工具 → 工具错误结果帧）。
 * 网关形态=Owner 裁决协议（openai-completions——z.ai /api/paas/v4 同构）：
 * mock 与真实网关线协议一致，仅地址/key 替换。
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { Frame } from '@handicraft/contracts';
import { loadConfig } from '../src/config.js';
import { openDatabase, type SqliteDb } from '../src/db/database.js';
import { ensureAnonymousUser } from '../src/auth.js';
import { BlobStore, recordBlobUpload } from '../src/db/blobs.js';
import { encodePng } from '../src/png/codec.js';
import { JobService } from '../src/jobs/service.js';
import { SessionService } from '../src/sessions/service.js';
import { generateJob } from '../src/jobs/generate.js';
import { engineJob } from '../src/jobs/engine.js';
import { runSleepJob } from '../src/jobs/sleep-job.js';
import { HandicraftKernel } from '../src/kernel/index.js';
import { McpListener } from '../src/mcp.js';
import { createStudioMcpServer } from '../src/capability/mcp.js';

/** mock 网关脚本步：纯文本或工具调用（openai 线形态）；hang=写头与首 delta 后挂起不结束（打断/引导测试的运行中面）。 */
export interface MockStep {
  text?: string;
  toolCall?: { name: string; arguments: string };
  hang?: boolean;
}

/** 本地 openai-completions mock 网关（SSE 流——与 z.ai 线协议同构）。 */
function startMockGateway(script: (body: string) => MockStep): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'glm-5.3-flash' }] }));
      return;
    }
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const step = script(body);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (payload: unknown): void => {
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
      };
      if (step.hang === true) {
        // 挂起：写首 delta 后不结束——agent 轮保持 running（stop/steer 测试的可打断面）。
        if (step.text !== undefined && step.text !== '') {
          send({ choices: [{ delta: { content: step.text.slice(0, Math.ceil(step.text.length / 2)) } }] });
        }
        return;
      }
      if (step.text !== undefined && step.text !== '') {
        const mid = Math.ceil(step.text.length / 2);
        send({ choices: [{ delta: { content: step.text.slice(0, mid) } }] });
        send({ choices: [{ delta: { content: step.text.slice(mid) } }] });
      }
      if (step.toolCall !== undefined) {
        send({
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: `mock_${Date.now()}`, type: 'function', function: { name: step.toolCall.name, arguments: step.toolCall.arguments } },
                ],
              },
            },
          ],
        });
      }
      send({
        choices: [{ delta: {}, finish_reason: step.toolCall !== undefined ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      });
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 });
    });
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(200);
  }
  return false;
}

interface LiveEnv {
  root: string;
  config: ReturnType<typeof loadConfig>;
  db: SqliteDb;
  jobs: JobService;
  sessions: SessionService;
  anonymous: ReturnType<typeof ensureAnonymousUser>;
  kernel: HandicraftKernel;
  mcpPort: number;
  dispose(): Promise<void>;
}

/** 完整装配：mock 网关 + MCP listener + 真实内核（独立临时 DATA_ROOT）。 */
async function bootLiveEnv(script: (body: string) => MockStep): Promise<LiveEnv> {
  const root = mkdtempSync(path.join(tmpdir(), 'kernel-live-'));
  const config = loadConfig({
    envFile: path.join(root, 'app', '.env'),
    processEnv: {
      DATA_ROOT: path.join(root, 'data'),
      WEBUI_DIR: path.join(root, 'webui'),
      JWT_SECRET: 'live-test-secret',
      IMG_DRY_RUN: '1',
      LLM_PROVIDER: 'zai',
      LLM_API: 'openai-completions',
      LLM_MODEL: 'glm-5.3-flash',
      LLM_API_KEY: 'mock-gateway-key',
    },
  });
  const { server, port: gatewayPort } = await startMockGateway(script);
  (config.llm as { baseUrl: string }).baseUrl = `http://127.0.0.1:${gatewayPort}/v1`;
  const db = openDatabase(config.dataRoot);
  const anonymous = ensureAnonymousUser(db);
  const blobs = new BlobStore(config.dataRoot, db);
  const jobs = new JobService(
    { config, db, blobs },
    { sleep: { run: runSleepJob }, generate: generateJob, engine: engineJob },
  );
  const sessions = new SessionService({ config, db, blobs, jobs });
  const kernel = new HandicraftKernel({ config, db, jobs, sessions, blobs });
  const mcpHandler = createMcpHandler(() => createStudioMcpServer({ capabilities: kernel.capabilities }), {
    legacy: 'stateless',
  });
  const mcpToken = randomBytes(24).toString('hex');
  const mcp = new McpListener({
    port: 0,
    host: '127.0.0.1',
    kernelState: () => kernel.state,
    token: mcpToken,
    tokenFile: path.join(config.dataRoot, 'mcp-token'),
    handle: toNodeHandler(mcpHandler),
  });
  const mcpPort = await mcp.listen();
  await kernel.boot({ url: `http://127.0.0.1:${mcpPort}/mcp`, token: mcpToken });
  return {
    root,
    config,
    db,
    jobs,
    sessions,
    anonymous,
    kernel,
    mcpPort,
    dispose: async () => {
      await kernel.stop();
      await mcp.stop(500);
      // 挂起步留下的在途 SSE 连接显式摧毁（server.close 等待在途连接，不杀则收尾悬挂）。
      (server as Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function framesUntil(env: LiveEnv, taskId: string, timeoutMs: number): Promise<Frame[]> {
  let frames: Frame[] = [];
  const ok = await waitUntil(() => {
    frames = env.jobs.frames(env.anonymous, taskId, 0).frames;
    return frames.some((f) => f.kind === 'done' || f.kind === 'error');
  }, timeoutMs);
  if (!ok) throw new Error(`帧流等待终态超时（已收 ${frames.length} 帧）`);
  return frames;
}

function transcriptPayloads(frames: Frame[]): Array<{ role: string; text: string }> {
  return frames
    .filter((f) => f.kind === 'transcript')
    .map((f) => (f as unknown as { payload: { role: string; text: string } }).payload);
}

describe('dsh 内核 live（真实 boot + mock 网关——§6.4 态④）', () => {
  it('boot：真实 dsh-base 内核挂载（openai-completions 路由）', { timeout: 120000 }, async () => {
    const env = await bootLiveEnv(() => ({ text: 'ok' }));
    try {
      expect(env.kernel.state).toBe('ready');
      expect(env.kernel.reason).toContain('openai-completions');
      expect(env.kernel.reason).toContain('glm-5.3-flash');
    } finally {
      await env.dispose();
    }
  });

  it('followup 全链：task 行 → transcript(user/assistant) → done → task done（回放同构）', { timeout: 180000 }, async () => {
    const env = await bootLiveEnv(() => ({ text: '你好，我是贴钻助手（mock 网关确定性回复）。' }));
    try {
      const { sessionId } = env.sessions.create(env.anonymous, { title: 'live 全链' });
      const { taskId } = await env.kernel.followup(env.anonymous, sessionId, { text: '帮我排个钻' });
      const frames = await framesUntil(env, taskId, 60000);
      const kinds = frames.map((f) => f.kind);
      // W1 首条创建流（add-task-stones-manifest-export 1.1）：初版 manifest（rev1 空
      // entries——跳过集合）先于 agent 会话提交，artifact 帧领先 transcript（帧序=
      // 提交时序的审计面）。
      expect(kinds[0]).toBe('artifact');
      expect((frames[0] as unknown as { payload: { name: string } }).payload.name).toBe('stones-manifest.json');
      expect(kinds[1]).toBe('transcript');
      const payloads = transcriptPayloads(frames);
      expect(payloads[0]?.role).toBe('user');
      expect(payloads[0]?.text).toContain('帮我排个钻');
      const assistant = payloads.find((p) => p.role === 'assistant');
      expect(assistant).toBeDefined();
      expect(assistant?.text).toContain('mock 网关确定性回复');
      expect(kinds[kinds.length - 1]).toBe('done');
      const settled = await waitUntil(
        () =>
          (env.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string })
            .status === 'done',
        15000,
      );
      expect(settled).toBe(true);
      const row = env.db.prepare('SELECT type, session_id FROM tasks WHERE id = ?').get(taskId) as {
        type: string;
        session_id: string;
      };
      expect(row.type).toBe('agent');
      expect(row.session_id).toBe(sessionId);
      const replay = env.sessions.replay(env.anonymous, { sessionId, taskId, afterSeq: 0 });
      expect(replay.frames.length).toBe(frames.length);
    } finally {
      await env.dispose();
    }
  });

  it('工具链路：mock 发起 mcp__studio__projects 调用 → MCP 环回 → 真实 DB 读 → 结果回模型', { timeout: 180000 }, async () => {
    let calls = 0;
    // P1-1 后 studio.projects 要求 taskId（调用者身份=任务行 owner）——从 followup
    // 注入的提示帧提取当前 taskId（与真实模型行为同构：读提示中的任务绑定）。
    const env = await bootLiveEnv((body) => {
      calls += 1;
      if (calls === 1) {
        const taskId = /taskId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(body)?.[1] ?? '';
        return { toolCall: { name: 'mcp__studio__projects', arguments: JSON.stringify({ limit: 5, taskId }) } };
      }
      return { text: '已列出工程。' };
    });
    try {
      env.db
        .prepare(
          "INSERT INTO resources (id, owner_id, parent_id, name, is_dir, content_hash, size, meta, revision, created_at, updated_at) VALUES ('r1', ?, NULL, '我的钻画.gemproj', 0, 'h1', 42, ?, 1, ?, ?)",
        )
        .run(
          env.anonymous.id,
          JSON.stringify({ kind: 'gemproj' }),
          new Date().toISOString(),
          new Date().toISOString(),
        );
      // MCP 工具注册是 boot 后异步完成——等 mcp__studio__* 就位再 followup
      // （生产时序天然满足：用户 followup 远晚于 boot；此处显式同步）。
      const mcpReady = await waitUntil(
        () => env.kernel.debugToolNames().some((name) => name.startsWith('mcp__studio__')),
        20000,
      );
      expect(mcpReady, 'MCP 工具未在时限内注册进内核').toBe(true);
      const { sessionId } = env.sessions.create(env.anonymous, { title: '工具面' });
      const { taskId } = await env.kernel.followup(env.anonymous, sessionId, { text: '列一下我的工程' });
      const frames = await framesUntil(env, taskId, 60000);
      const toolText = transcriptPayloads(frames)
        .filter((p) => p.role === 'tool')
        .map((p) => p.text)
        .join('\n');
      expect(toolText).toContain('mcp__studio__projects');
      expect(toolText).toContain('我的钻画.gemproj'); // 真实 DB 行经 MCP 环回回读
      expect(frames[frames.length - 1]?.kind).toBe('done');
    } finally {
      await env.dispose();
    }
  });

  it('附件链（split-admin-portal 2.2/2.3）：owner 校验+账本增量+物料桥图像块+帧元数据+clear 释放+伪图拒', { timeout: 240000 }, async () => {
    const env = await bootLiveEnv(() => ({ text: '收到附件。' }));
    try {
      const blobs = new BlobStore(env.config.dataRoot, env.db);
      // 真图字节（PNG——魔数+可解码；物料桥 saveImages 全解码验证）。
      const rgba = new Uint8Array(8 * 6 * 4);
      for (let i = 0; i < rgba.length; i++) rgba[i] = 40 + (i % 180);
      const pngBytes = encodePng(8, 6, rgba);
      const hash = blobs.put(pngBytes).hash;
      recordBlobUpload(env.db, hash, env.anonymous.id); // 上传归属账本（2.2 owner 面）
      const before = (env.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(hash) as { ref_count: number }).ref_count;
      const { sessionId } = env.sessions.create(env.anonymous, { title: '附件' });
      const { taskId } = await env.kernel.followup(env.anonymous, sessionId, { text: '看下附件', attachments: [hash] });
      await framesUntil(env, taskId, 90000);
      const after = (env.db.prepare('SELECT ref_count FROM blobs WHERE hash = ?').get(hash) as { ref_count: number }).ref_count;
      expect(after).toBe(before + 1);
      expect(env.db.prepare('SELECT 1 FROM session_blob_refs WHERE session_id = ? AND blob_hash = ?').get(sessionId, hash)).toBeDefined();
      const frames = env.jobs.frames(env.anonymous, taskId, 0).frames;
      const userFrame = frames.find(
        (f) => f.kind === 'transcript' && (f as unknown as { payload: { role: string } }).payload.role === 'user',
      ) as unknown as { payload: { text: string; attachments?: Array<{ name: string; mime: string; width: number; height: number; blobRef: string }> } };
      // 物料桥（2.3）+W5 P0-1 锚注裁定：首条 prompt 投影 imageId→blobRef 映射
      //（agent 侧附件引用经 saveImages 重编码 ≠ daemon blobRef——不投影则工具传错
      // ref；blobRef 是内容寻址引用非路径）；帧面带附件元数据（dsh 解码真相尺寸）。
      expect(userFrame.payload.text).toContain('看下附件');
      expect(userFrame.payload.text).toContain(`image-1=${hash}`);
      expect(userFrame.payload.text).toContain('studio.task.images.list');
      expect(userFrame.payload.attachments?.length).toBe(1);
      expect(userFrame.payload.attachments?.[0]?.blobRef).toBe(hash);
      expect(userFrame.payload.attachments?.[0]?.mime).toBe('image/png');
      expect(userFrame.payload.attachments?.[0]?.width).toBe(8);
      expect(userFrame.payload.attachments?.[0]?.height).toBe(6);
      // dsh-home 附件存储落位（attachment-local 内容寻址目录被创建——saveImages 真实执行）。
      expect(existsSync(path.join(env.config.dataRoot, 'dsh-home', 'attachments'))).toBe(true);
      // 伪图（魔数嗅探失败）与不存在的附件显式拒（不静默）。
      const fakeHash = blobs.put(new TextEncoder().encode('not-an-image')).hash;
      recordBlobUpload(env.db, fakeHash, env.anonymous.id);
      await expect(env.kernel.followup(env.anonymous, sessionId, { text: 'x', attachments: [fakeHash] })).rejects.toThrow(
        /不是受支持的图片/,
      );
      await expect(env.kernel.followup(env.anonymous, sessionId, { text: 'x', attachments: ['deadbeef'.repeat(8)] })).rejects.toThrow(
        /不存在或不可引用|不属于当前用户/,
      );
      // clear 释放引用（跨介质清理既有链路——W3 状态机不被内核层破坏）。
      env.sessions.clear(env.anonymous, sessionId);
      const final = env.db.prepare('SELECT ref_count, status FROM blobs WHERE hash = ?').get(hash) as { ref_count: number; status: string };
      expect(final.ref_count).toBeLessThan(after);
    } finally {
      await env.dispose();
    }
  });

  it('deny-list：mock 调用 allowlist 外的 bash 工具 → 模型收到拒绝结果（任务不失控）', { timeout: 180000 }, async () => {
    let calls = 0;
    const env = await bootLiveEnv(() => {
      calls += 1;
      return calls === 1
        ? { toolCall: { name: 'bash', arguments: '{"command":"ls"}' } }
        : { text: '好的，不再尝试。' };
    });
    try {
      const { sessionId } = env.sessions.create(env.anonymous, { title: '收窄' });
      const { taskId } = await env.kernel.followup(env.anonymous, sessionId, { text: '跑个命令' });
      const frames = await framesUntil(env, taskId, 60000);
      const toolText = transcriptPayloads(frames)
        .filter((p) => p.role === 'tool')
        .map((p) => p.text)
        .join('\n');
      expect(toolText).toMatch(/bash/);
      expect(toolText).toMatch(/工具执行错误|not found|TOOL_NOT_FOUND|不在|拒绝/);
      expect(frames[frames.length - 1]?.kind).toBe('done');
    } finally {
      await env.dispose();
    }
  });

  it('stop 打断（三通道 1.4）：挂起轮 cancel+keepInbox → done 帧收口+任务回 done+同会话续聊正常', { timeout: 180000 }, async () => {
    let calls = 0;
    const env = await bootLiveEnv(() => {
      calls += 1;
      return calls === 1 ? { text: '第一轮先挂着……', hang: true } : { text: '续聊完成回复。' };
    });
    try {
      const { sessionId } = env.sessions.create(env.anonymous, { title: '打断 live' });
      const { taskId } = await env.kernel.followup(env.anonymous, sessionId, { text: '开始长任务' });
      // 开轮成功：user transcript 帧已落下、轮挂起（无终态帧）。
      const opened = await waitUntil(
        () => env.jobs.frames(env.anonymous, taskId, 0).frames.some((f) => f.kind === 'transcript'),
        30000,
      );
      expect(opened).toBe(true);
      expect(env.jobs.frames(env.anonymous, taskId, 0).frames.some((f) => f.kind === 'done' || f.kind === 'error')).toBe(false);
      // 打断：同步回 done（终态帧收口），挂起的在途 LLM 连接被 abort。
      env.kernel.stopTask(env.anonymous, taskId);
      expect((env.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('done');
      const frames = env.jobs.frames(env.anonymous, taskId, 0).frames;
      expect(frames[frames.length - 1]?.kind).toBe('done');
      // 打断后可续聊（贴钻语义）：同会话再 followup 开新任务——第二轮网关正常回复，全链完成。
      const second = await env.kernel.followup(env.anonymous, sessionId, { text: '续聊：再排一次' });
      expect(second.taskId).not.toBe(taskId);
      const frames2 = await framesUntil(env, second.taskId, 60000);
      expect(frames2[frames2.length - 1]?.kind).toBe('done');
      expect(transcriptPayloads(frames2).some((p) => p.role === 'assistant' && p.text.includes('续聊完成回复'))).toBe(true);
      // 打断轮不复活：原任务行保持 done。
      await sleep(500);
      expect((env.db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string }).status).toBe('done');
    } finally {
      await env.dispose();
    }
  });

  it('steer 分流（三通道 1.3）：运行中任务的引导进同一任务（不新开行）', { timeout: 180000 }, async () => {
    let calls = 0;
    const env = await bootLiveEnv((body: string) => {
      calls += 1;
      return calls === 1
        ? { text: '正在排……', hang: true }
        : { text: body.includes('往红色偏一点') ? '收到引导：改红色。' : '普通回复。' };
    });
    try {
      const { sessionId } = env.sessions.create(env.anonymous, { title: '引导 live' });
      const first = await env.kernel.followup(env.anonymous, sessionId, { text: '开始排钻' });
      const opened = await waitUntil(
        () => env.jobs.frames(env.anonymous, first.taskId, 0).frames.some((f) => f.kind === 'transcript'),
        30000,
      );
      expect(opened).toBe(true);
      // 引导：投递进运行中任务的内核会话（next-step 边界）——不新开任务行。
      const steered = await env.kernel.followup(env.anonymous, sessionId, { text: '往红色偏一点', mode: 'steer' });
      expect(steered.taskId).toBe(first.taskId);
      const count = (
        env.db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE session_id = ?').get(sessionId) as { n: number }
      ).n;
      expect(count).toBe(1);
      // 引导通道拒附件（裸文本改口——附件属新任务面）。
      const hash = new BlobStore(env.root, env.db).put(new TextEncoder().encode('a')).hash;
      await expect(
        env.kernel.followup(env.anonymous, sessionId, { text: '带图引导', mode: 'steer', attachments: [hash] }),
      ).rejects.toThrow(/引导通道.*不支持附件/);
      // 收口：stop 打断挂起轮（挂起连接释放，测试可退出）。
      env.kernel.stopTask(env.anonymous, first.taskId);
      expect((env.db.prepare('SELECT status FROM tasks WHERE id = ?').get(first.taskId) as { status: string }).status).toBe('done');
    } finally {
      await env.dispose();
    }
  });

  // ------------------------------------------------ title 命名插件接线（session-title + first-prompt-llm）
  // 判别：主对话请求带 tools（agent 工具面）；title 辅助请求无 tools 且
  // max_tokens=64（dsh-session-title-llm 经 ctx.llm.stream 走会话同款路由）。
  const isTitleRequest = (body: string): boolean => !body.includes('tools');

  function sessionTitleRow(env: LiveEnv, sessionId: string): { title: string; title_owner: string | null } {
    return env.db.prepare('SELECT title, title_owner FROM sessions WHERE id = ?').get(sessionId) as {
      title: string;
      title_owner: string | null;
    };
  }

  it('title·fallback：首条消息截断标题落库（中文 bounds 覆盖生效）+ 标注剥离；title 请求失败保留 fallback', { timeout: 240000 }, async () => {
    // 首条消息 40+ 字中文（无空格=单 word）：bounds 覆盖（96 bytes≈32 字）下 fallback
    // 截到 32 字；dsh-base 缺省（40 bytes≈13 字）则只到 13 字——长度断言同时是
    // boot patch 覆盖的实证。title 请求返回空输出 → provider 失败保留 fallback。
    const longText = '帮我排一幅玫瑰花束的钻石贴画要红金配色边缘一圈金色小钻花蕊部分用大一点的圆钻整体尺寸大约三十厘米乘四十厘米左右';
    const env = await bootLiveEnv((body) => (isTitleRequest(body) ? {} : { text: '好的，开始排布。' }));
    try {
      const { sessionId } = env.sessions.create(env.anonymous, { title: '' });
      const { taskId } = await env.kernel.followup(env.anonymous, sessionId, { text: longText });
      await framesUntil(env, taskId, 60000);
      const titled = await waitUntil(() => sessionTitleRow(env, sessionId).title !== '', 15000);
      expect(titled).toBe(true);
      const row = sessionTitleRow(env, sessionId);
      expect(row.title_owner).toBe(taskId);
      expect(row.title).not.toContain('[任务绑定'); // 标注剥离
      expect(row.title).not.toContain('taskId'); // 剥离后无残留
      expect(longText.startsWith(row.title)).toBe(true); // 首条消息前缀
      expect(row.title.length).toBeGreaterThan(13); // dsh-base 缺省 40 bytes 之外的实证
      expect(row.title.length).toBeLessThanOrEqual(32); // 96 bytes≈32 个中文字
    } finally {
      await env.dispose();
    }
  });

  it('title·provider LLM + rename pin：fallback→LLM 标题升级落库；rename 后自动 title 不覆盖；title 不进主对话请求载荷', { timeout: 240000 }, async () => {
    const titleText = '粉钻玫瑰图案';
    const mainBodies: string[] = [];
    const titleBodies: string[] = [];
    let titleRequests = 0;
    let mainCalls = 0;
    const env = await bootLiveEnv((body) => {
      if (isTitleRequest(body)) {
        titleRequests += 1;
        titleBodies.push(body);
        return { text: titleText };
      }
      mainCalls += 1;
      mainBodies.push(body);
      if (mainCalls === 1) {
        // 首主请求发起 tool 循环——第二主请求必然发生在 title 生成之后（title 请求
        // 与主请求并行、本地 mock 即返），其载荷是「title 不进模型输入」的冒烟面。
        const taskId = /taskId=([0-9a-f-]{36})/.exec(body)?.[1] ?? '';
        return { toolCall: { name: 'mcp__studio__projects', arguments: JSON.stringify({ limit: 5, taskId }) } };
      }
      return { text: '已列出工程，开始排布。' };
    });
    try {
      const { sessionId } = env.sessions.create(env.anonymous, { title: '' });
      const { taskId } = await env.kernel.followup(env.anonymous, sessionId, { text: '列一下我的工程然后排一朵玫瑰' });
      await framesUntil(env, taskId, 90000);
      // provider LLM title：异步请求经会话同款路由到 mock——fallback 被升级覆盖。
      const titled = await waitUntil(() => sessionTitleRow(env, sessionId).title === titleText, 20000);
      expect(titled).toBe(true);
      expect(titleRequests).toBeGreaterThan(0); // provider 真实跑过（first-prompt-llm）
      // maxOutputTokens patch 实证（2026-10-03 缺陷 B）：dsh-base 缺省 64 对推理模型
      // 全烧 thinking 零正文（56/56 会话 fallback 回归根因）——boot patch 覆盖 2048。
      for (const body of titleBodies) {
        expect(body).toContain('"max_tokens":2048');
      }
      expect(sessionTitleRow(env, sessionId).title_owner).toBe(taskId);
      // title 不进模型输入（插件承诺冒烟）：全部主对话请求载荷不含生成出的 title。
      for (const body of mainBodies) expect(body).not.toContain(titleText);
      expect(mainBodies.length).toBeGreaterThanOrEqual(2); // tool 循环二主请求在场（断言面成立）
      // 用户 rename：pin——后续轮次（新 task=新 dsh 会话）的自动 title 不覆盖。
      env.sessions.rename(env.anonymous, sessionId, '我的定稿会话');
      const second = await env.kernel.followup(env.anonymous, sessionId, { text: '第二轮换蓝色' });
      await framesUntil(env, second.taskId, 60000);
      await sleep(1000); // 第二轮 title 事件（若有）到达窗口
      expect(sessionTitleRow(env, sessionId)).toEqual({ title: '我的定稿会话', title_owner: 'user' });
    } finally {
      await env.dispose();
    }
  });
});
