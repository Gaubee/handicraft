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
import { RPCHandler } from '@orpc/server/ws';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { ensureAdminUser, ensureAnonymousUser } from './auth.js';
import { DaemonHttp } from './http.js';
import { BlobStore } from './db/blobs.js';
import { router, type RpcContext } from './rpc.js';
import { JobService, type JobDefinition } from './jobs/service.js';
import { runSleepJob } from './jobs/sleep-job.js';
import { generateJob } from './jobs/generate.js';
import { engineJob } from './jobs/engine.js';

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
  const rpcHandler = new RPCHandler<RpcContext>(router);
  const http_ = new DaemonHttp({ config, db, secret, rpcHandler, jobs, blobs });
  const port = await http_.listen(config.port, config.host);
  console.log(
    `[boot] 贴钻 daemon 已启动：http://${config.host}:${port}（DATA_ROOT=${config.dataRoot}，webui=${config.webuiDir}）`,
  );

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[boot] 收到 ${signal}，正在优雅退出…`);
    void (async () => {
      jobs.stop(); // P2-2：中止全部在跑任务的外呼后再停服
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
