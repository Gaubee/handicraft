/**
 * daemon 启动装配（design §1；zhumo index 模式，W1.2 骨架版）。
 * 原始需求 2026-09-23：.env → SQLite → 匿名/管理员引导 → HTTP 监听 → 优雅退出。
 * W2 起再挂：oRPC-WS / 任务帧流 / 静态分享页；W4 起再挂：MCP 环回 + dsh 内核。
 * 正交意图：
 *   [1] 服务组装与端口监听（dist 门禁前置——缺失即抛错退出）。
 *   [2] JWT 密钥解析（缺省生成临时密钥并告警）。
 *   [3] 启动引导：匿名账号自愈 + .env 管理员幂等 upsert。
 *   [4] SIGINT/SIGTERM 优雅退出（停服 + 关库）。
 */
import { randomBytes } from 'node:crypto';
import { loadConfig, type AppConfig } from './config.js';
import { openDatabase } from './db/database.js';
import { ensureAdminUser, ensureAnonymousUser } from './auth.js';
import { DaemonHttp } from './http.js';

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

  const http_ = new DaemonHttp({ config, db, secret });
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
