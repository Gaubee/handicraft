/**
 * WS 通道测试（W2.1：/ws/rpc oRPC-over-WebSocket + /ws/tasks/:id 帧流——真 DaemonHttp
 * + 随机端口，不 spawn 进程）。覆盖：RPCLink 客户端经 WS 调 bootstrap/tasks.*；
 * 帧流 WS 先回放后实时（断线重连带 after_seq 无缺失无重复）；无 token 401；服务未
 * 装配 /ws/tasks 501。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/websocket';
import { RPCHandler } from '@orpc/server/ws';
import { describe, expect, it } from 'vitest';
import type { Frame } from '@handicraft/contracts';
import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { ensureAnonymousUser, signJwt } from '../src/auth.js';
import { BlobStore } from '../src/db/blobs.js';
import type { UserRow } from '../src/db/store.js';
import { DaemonHttp } from '../src/http.js';
import { router, type RpcContext } from '../src/rpc.js';
import { JobService } from '../src/jobs/service.js';
import { runSleepJob } from '../src/jobs/sleep-job.js';

const TEST_SECRET = 'handicraft-ws-test-secret';
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface Sandbox {
  root: string;
  port: number;
  http: DaemonHttp;
  jobs: JobService;
  anonymous: UserRow;
  token: string;
  dispose(): Promise<void>;
}

async function makeSandbox(withJobs: boolean): Promise<Sandbox> {
  const root = mkdtempSync(path.join(tmpdir(), 'handicraft-ws-'));
  const webuiDir = path.join(root, 'dist');
  mkdirSync(webuiDir, { recursive: true });
  writeFileSync(path.join(webuiDir, 'index.html'), '<!doctype html><title>ws</title>');
  const config = loadConfig({
    envFile: path.join(root, '.env'),
    processEnv: {
      DATA_ROOT: path.join(root, 'data'),
      WEBUI_DIR: webuiDir,
      JWT_SECRET: TEST_SECRET,
    },
  });
  const db = openDatabase(config.dataRoot);
  const anonymous = ensureAnonymousUser(db);
  const blobs = new BlobStore(config.dataRoot, db);
  const jobs = new JobService({ config, db, blobs }, { sleep: { run: runSleepJob } });
  const rpcHandler = new RPCHandler<RpcContext>(router);
  const http = new DaemonHttp({
    config,
    db,
    secret: TEST_SECRET,
    rpcHandler,
    ...(withJobs ? { jobs, blobs } : {}),
  });
  const port = await http.listen(0, '127.0.0.1');
  const { token } = await signJwt(TEST_SECRET, { sub: anonymous.id, role: anonymous.role });
  return {
    root,
    port,
    http,
    jobs,
    anonymous,
    token,
    dispose: async () => {
      await http.stop(200);
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function rpcClient(sandbox: Sandbox) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${sandbox.port}/ws/rpc?token=${encodeURIComponent(sandbox.token)}`,
  );
  const link = new RPCLink({ websocket: ws as unknown as WebSocket });
  return createORPCClient(link) as {
    bootstrap(): Promise<{ version: string; imgDryRun: boolean }>;
    tasks: {
      create(input: { kind: string; params: unknown }): Promise<{ taskId: string }>;
      list(): Promise<{ tasks: unknown[] }>;
    };
  };
}

/** /ws/tasks/:id 原生客户端：收帧直到条件满足（不关连接——调用方决定）。 */
function collectFrames(
  sandbox: Sandbox,
  taskId: string,
  afterSeq: number,
  until: (frames: Frame[]) => boolean,
  timeoutMs: number,
): Promise<{ frames: Frame[]; ws: WebSocket }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${sandbox.port}/ws/tasks/${encodeURIComponent(taskId)}?after_seq=${afterSeq}&token=${encodeURIComponent(sandbox.token)}`,
    );
    const frames: Frame[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`帧流等待超时（已收 ${frames.length} 帧）`));
    }, timeoutMs);
    ws.on('message', (raw) => {
      try {
        frames.push(JSON.parse(String(raw)) as Frame);
        if (until(frames)) {
          clearTimeout(timer);
          // 快照：resolve 后在途消息仍可能推入 frames——以触发时刻窗口为游标防重叠
          resolve({ frames: [...frames], ws });
        }
      } catch {
        // 畸形帧丢弃
      }
    });
    ws.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** 升级握手返回的原始 HTTP 状态（非 101 场景——401/501 断言面）。 */
function upgradeStatus(sandbox: Sandbox, pathAndQuery: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${sandbox.port}${pathAndQuery}`);
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.close();
    });
    ws.on('open', () => {
      resolve(101);
      ws.close();
    });
    ws.on('error', (error) => reject(error));
  });
}

describe('WS 通道（/ws/rpc + /ws/tasks/:id）', () => {
  it('RPCLink over /ws/rpc：bootstrap + tasks.create/list 全链', { timeout: 15000 }, async () => {
    const sandbox = await makeSandbox(true);
    try {
      const client = rpcClient(sandbox);
      const boot = await client.bootstrap();
      expect(boot.version).toBe('0.1.0');
      expect(boot.imgDryRun).toBe(false);

      const created = await client.tasks.create({
        kind: 'sleep',
        params: { frames: 2, intervalMs: 5 },
      });
      expect(created.taskId).toBeTruthy();
      const { tasks } = await client.tasks.list();
      expect(tasks.length).toBe(1);
    } finally {
      await sandbox.dispose();
    }
  });

  it('/ws/tasks/:id：运行中连接=回放+实时；断开后重连带 after_seq 无缺失无重复', { timeout: 20000 }, async () => {
    const sandbox = await makeSandbox(true);
    try {
      const task = await sandbox.jobs.create(sandbox.anonymous, {
        kind: 'sleep',
        params: { frames: 25, intervalMs: 8 },
      });

      // 第一段：实时收帧至若干进度后断开
      const first = await collectFrames(
        sandbox,
        task.taskId,
        0,
        (frames) => frames.length >= 4,
        8000,
      );
      first.ws.close();
      const lastSeq = first.frames[first.frames.length - 1]!.seq;
      expect(lastSeq).toBeGreaterThan(0);

      // 断线窗口：任务继续推帧
      await sleep(80);

      // 重连：after_seq=lastSeq——先回放断线窗口内持久帧，再续收实时帧至 done
      const second = await collectFrames(
        sandbox,
        task.taskId,
        lastSeq,
        (frames) => frames.some((f) => f.kind === 'done'),
        8000,
      );
      second.ws.close();

      const merged = [...first.frames, ...second.frames];
      const seqs = merged.map((f) => f.seq);
      expect(seqs.length).toBe(new Set(seqs).size); // 无重复
      const sorted = [...seqs].sort((a, b) => a - b);
      expect(sorted).toEqual(Array.from({ length: sorted.length }, (_, i) => i + 1)); // 从 1 连续无缺失
      expect(merged.filter((f) => f.kind === 'done')).toHaveLength(1);
      // 第二段首帧紧跟 lastSeq（重放窗口起点正确）
      expect(second.frames[0]!.seq).toBe(lastSeq + 1);
    } finally {
      await sandbox.dispose();
    }
  });

  it('鉴权与装配面：/ws/tasks/:id 无 token=401；未装配 jobs=501；/ws/rpc 正常 101', { timeout: 15000 }, async () => {
    const bare = await makeSandbox(false);
    try {
      expect(await upgradeStatus(bare, '/ws/tasks/some-task')).toBe(501);
      expect(await upgradeStatus(bare, '/ws/unknown')).toBe(404);
    } finally {
      await bare.dispose();
    }
    const sandbox = await makeSandbox(true);
    try {
      const task = await sandbox.jobs.create(sandbox.anonymous, {
        kind: 'sleep',
        params: { frames: 1, intervalMs: 5 },
      });
      expect(await upgradeStatus(sandbox, `/ws/tasks/${task.taskId}`)).toBe(401);
      expect(await upgradeStatus(sandbox, '/ws/rpc')).toBe(101);
    } finally {
      await sandbox.dispose();
    }
  });

  it('P1-3 畸形 WS 路径：/ws/tasks/% 得 400（不抛 URIError），daemon 存活且正常流不受影响', { timeout: 15000 }, async () => {
    const sandbox = await makeSandbox(true);
    try {
      // 畸形百分号编码：升级被 400 拒绝（修复前此处同步抛 URIError 可终止进程）
      expect(await upgradeStatus(sandbox, '/ws/tasks/%')).toBe(400);
      expect(await upgradeStatus(sandbox, '/ws/tasks/%E4%BD')).toBe(400); // 截断的多字节序列
      // 变体：任务 id 段为纯点号/超长——IdSchema 校验面（非空字符串均合法，交由归属校验）
      // 探活：daemon 未被打穿
      const probe = await fetch(`http://127.0.0.1:${sandbox.port}/api/bootstrap`);
      expect(probe.ok).toBe(true);

      // 正常帧流在畸形请求后仍可用（同一 server 实例）
      const task = await sandbox.jobs.create(sandbox.anonymous, {
        kind: 'sleep',
        params: { frames: 2, intervalMs: 5 },
      });
      const collected = await collectFrames(
        sandbox,
        task.taskId,
        0,
        (frames) => frames.some((f) => f.kind === 'done'),
        8000,
      );
      collected.ws.close();
      expect(collected.frames.length).toBeGreaterThan(0);
    } finally {
      await sandbox.dispose();
    }
  });

  it('P2-3 after_seq 严格校验：-1/1junk/1.5/空 → 400；0 与正整数正常 101', { timeout: 15000 }, async () => {
    const sandbox = await makeSandbox(true);
    try {
      const task = await sandbox.jobs.create(sandbox.anonymous, {
        kind: 'sleep',
        params: { frames: 3, intervalMs: 5 },
      });
      const q = (afterSeq: string) =>
        `/ws/tasks/${encodeURIComponent(task.taskId)}?after_seq=${encodeURIComponent(afterSeq)}&token=${encodeURIComponent(sandbox.token)}`;
      // 非法：负数 / 尾随字符 / 浮点 / 显式空（缺省合法——不传即 0）
      expect(await upgradeStatus(sandbox, q('-1'))).toBe(400);
      expect(await upgradeStatus(sandbox, q('1junk'))).toBe(400);
      expect(await upgradeStatus(sandbox, q('1.5'))).toBe(400);
      expect(await upgradeStatus(sandbox, q('+1'))).toBe(400);
      expect(await upgradeStatus(sandbox, q(''))).toBe(400);
      // 合法：0 / 正整数 / 前导零（数值等价）——升级成功
      expect(await upgradeStatus(sandbox, q('0'))).toBe(101);
      expect(await upgradeStatus(sandbox, q('2'))).toBe(101);
      expect(await upgradeStatus(sandbox, q('02'))).toBe(101);
      // 缺省（不传 after_seq）= 0，合法
      expect(
        await upgradeStatus(sandbox, `/ws/tasks/${encodeURIComponent(task.taskId)}?token=${encodeURIComponent(sandbox.token)}`),
      ).toBe(101);
    } finally {
      await sandbox.dispose();
    }
  });
});
