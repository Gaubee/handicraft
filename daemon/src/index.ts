/**
 * daemon 启动装配（design §1；zhumo index 模式）。W1.2 骨架；W2.1 起：BlobStore +
 * oRPC-over-WS（/ws/rpc）+ 任务编排 JobService（/ws/tasks/:id 帧流；runner 注册表
 * ——本波 sleep，generate/engine 随 W2.2/W2.3 注册）。W4 起再挂：MCP 环回 + dsh 内核。
 * 正交意图：
 *   [1] 服务组装与端口监听（dist 门禁前置——缺失即抛错退出）。
 *   [2] JWT 密钥解析（缺省生成临时密钥并告警）。
 *   [3] 启动引导：匿名账号自愈 + .env 管理员幂等 upsert。
 *   [4] SIGINT/SIGTERM 优雅退出（停服 + 关库）。
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { RPCHandler } from '@orpc/server/ws';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { ensureAdminUser, ensureAnonymousUser } from './auth.js';
import { DaemonHttp } from './http.js';
import { BlobStore } from './db/blobs.js';
import { router, type RpcContext } from './rpc.js';
import { JobService, type JobDefinition } from './jobs/service.js';
import { SessionService } from './sessions/service.js';
import { runSleepJob } from './jobs/sleep-job.js';
import { generateJob } from './jobs/generate.js';
import { engineJob } from './jobs/engine.js';
import { HandicraftKernel } from './kernel/index.js';
import { createStudioMcpServer } from './capability/mcp.js';
import { McpListener } from './mcp.js';

/** job runner 注册表（W2：sleep 演示 / generate 生成代理 / engine 排钻·校验·导出）。 */
function jobRunners(): Record<string, JobDefinition> {
  return { sleep: { run: runSleepJob }, generate: generateJob, engine: engineJob };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = openDatabase(config.dataRoot);
  const secret = resolveSecret(config);

  // 启动引导（幂等）：匿名账号自愈 + .env 管理员收敛。
  ensureAnonymousUser(db);
  const admin = ensureAdminUser(db, config);
  if (admin) {
    if (admin.user.role !== 'admin') {
      console.warn(
        `[boot] 警告：ADMIN_USERNAME=${config.adminUsername} 与既有非 admin 账户同名，未提权（换用户名或手工处理）`,
      );
    } else if (admin.created) {
      console.log(`[boot] 已从 .env 引导管理员：${config.adminUsername}`);
    } else if (admin.rotated) {
      console.log(`[boot] 管理员口令已按 .env 轮换：${config.adminUsername}`);
    }
  }

  const blobs = new BlobStore(config.dataRoot, db);
  const jobs = new JobService({ config, db, blobs }, jobRunners());
  const sessions = new SessionService({ config, db, blobs, jobs });
  // W3.2 §6.5 启动重放：任何阶段崩溃后重启，恢复至一致状态（无悬空引用/无孤儿文件）。
  sessions.recover();
  // W4.1 dsh 内核挂载链（shufa 模式）：内核装配 → MCP 独立 loopback listener
  // （真实 streamable-http handler——内核 dsh-mcp-client 行的连接目标，须先于
  // 内核 boot 监听）→ kernel boot（§6.4 四态：失败只降级 agent 面，daemon 不 crash）。
  const kernel = new HandicraftKernel({ config, db, jobs, sessions, blobs });
  let mcp: McpListener | null = null;
  if (config.mcpEnabled) {
    const mcpToken = randomBytes(32).toString('hex');
    const mcpHandler = createMcpHandler(() => createStudioMcpServer({ capabilities: kernel.capabilities }), {
      legacy: 'stateless',
      onerror: (error: unknown) => {
        console.error(`[mcp] handler error: ${error instanceof Error ? error.message : String(error)}`);
      },
    });
    mcp = new McpListener({
      port: config.mcpPort,
      host: config.mcpHost,
      kernelState: () => kernel.state,
      token: mcpToken,
      tokenFile: path.join(config.dataRoot, 'mcp-token'),
      handle: toNodeHandler(mcpHandler),
    });
    try {
      const mcpPort = await mcp.listen();
      console.log(`[boot] MCP 环回监听已启动：http://127.0.0.1:${mcpPort}/mcp（token=DATA_ROOT/mcp-token）`);
      await kernel.boot({ url: `http://127.0.0.1:${mcpPort}/mcp`, token: mcpToken });
    } catch (error) {
      // 非 loopback 绑定等配置错误：拒绝启动 MCP（主 HTTP 不受影响），显式告警；
      // 内核仍 boot（无 MCP 面——dsh-mcp-client 行不挂）。
      console.error(`[boot] MCP 监听启动失败（已禁用）：${error instanceof Error ? error.message : String(error)}`);
      await kernel.boot();
    }
  } else {
    await kernel.boot();
  }
  if (kernel.state !== 'ready') {
    console.warn(`[boot] dsh 内核降级（${kernel.state}）：${kernel.reason}`);
  } else {
    console.log(`[boot] dsh 内核就绪：${kernel.reason}`);
  }
  // W4.2 §3.6 R4 启动收敛：遗留 claimed/running 的 operation 与 attempt → unknown
  // （崩溃瞬间无法自行落库——呈现用户裁决；failed 仅由执行路径确定性错误写入）。
  const recoveredOps = kernel.approvals.recoverNonTerminal();
  if (recoveredOps.ops > 0 || recoveredOps.attempts > 0) {
    console.warn(
      `[boot] 授权面启动收敛：${recoveredOps.ops} 个 operation、${recoveredOps.attempts} 个 attempt 置 unknown（等待用户裁决重试）`,
    );
  }

  const rpcHandler = new RPCHandler<RpcContext>(router);
  const http_ = new DaemonHttp({ config, db, secret, rpcHandler, jobs, blobs, sessions, kernel });
  const port = await http_.listen(config.port, config.host);
  console.log(
    `[boot] 贴钻 daemon 已启动：http://${config.host}:${port}（DATA_ROOT=${config.dataRoot}，webui=${config.webuiDir}）`,
  );

  // 例行维护（小时级，unref 不阻退出）：TTL/revoke 回收 + tombstone 清理 + outbox 重试。
  const maintenance = setInterval(() => {
    try {
      sessions.maintenance();
    } catch (error) {
      console.error(`[boot] 例行维护异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }, 60 * 60 * 1000);
  maintenance.unref();

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[boot] 收到 ${signal}，正在优雅退出…`);
    void (async () => {
      jobs.stop(); // P2-2：中止全部在跑任务的外呼后再停服
      await kernel.stop().catch((error: unknown) => console.error(`[boot] 内核停机异常：${String(error)}`));
      if (mcp) await mcp.stop(1000).catch(() => undefined);
      clearInterval(maintenance);
      await http_.stop(1000).catch((error: unknown) => console.error(`[boot] 停机异常：${String(error)}`));
      db.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function resolveSecret(config: Pick<AppConfig, 'jwtSecret'>): string {
  if (config.jwtSecret) return config.jwtSecret;
  console.warn('[boot] 警告：JWT_SECRET 为空，本次运行使用临时随机密钥（重启后已签发凭证全部失效）');
  return randomBytes(32).toString('hex');
}

void main().catch((error: unknown) => {
  console.error('[boot] 启动失败：', error instanceof Error ? error.message : error);
  process.exit(1);
});
