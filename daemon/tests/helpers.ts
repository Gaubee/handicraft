/**
 * 测试装配（zhumo helpers 模式）：tmp DATA_ROOT + 隔离服务构造 + oRPC 路由客户端。
 * 正交意图：
 *   [1] createServices：临时数据根 + 数据库 + BlobStore + JobService（runner 可注入）。
 *   [2] clientFor：oRPC 路由客户端（createRouterClient——不穿 WS，直接以 context 调用；
 *       业务错误抛 ORPCError）。token 注入模拟已登录连接。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRouterClient } from '@orpc/server';
import { loadConfig, type AppConfig } from '../src/config.js';
import { openDatabase, type SqliteDb } from '../src/db/database.js';
import { BlobStore } from '../src/db/blobs.js';
import { ensureAnonymousUser, signJwt } from '../src/auth.js';
import { router, type RpcContext } from '../src/rpc.js';
import { JobService, type JobDefinition, type JobServiceDeps } from '../src/jobs/service.js';
import { SessionService } from '../src/sessions/service.js';
import { runSleepJob } from '../src/jobs/sleep-job.js';
import { generateJob } from '../src/jobs/generate.js';
import { engineJob } from '../src/jobs/engine.js';
import type { UserRow } from '../src/db/store.js';

export const TEST_SECRET = 'handicraft-w2-test-secret';

export interface TestServices {
  root: string;
  config: AppConfig;
  db: SqliteDb;
  secret: string;
  blobs: BlobStore;
  jobs: JobService;
  sessions: SessionService;
  anonymous: UserRow;
  /** JobService 依赖对象（可变引用——测试可注入 frameStoreOf 等替身面）。 */
  jobsDeps(): JobServiceDeps;
  /** 以该服务为基础派生连接 context（可附加 token/user）。 */
  context(extra?: Partial<RpcContext>): RpcContext;
  /** 匿名用户签名 token（模拟已登录 WS 连接）。 */
  tokenFor(user?: UserRow): Promise<string>;
  dispose(): void;
}

export function createServices(
  extraRunners?: Record<string, JobDefinition>,
  options?: { imgDryRun?: boolean; root?: string },
): TestServices {
  const root = options?.root ?? mkdtempSync(path.join(tmpdir(), 'handicraft-w2-'));
  const config = loadConfig({
    envFile: path.join(root, 'app', '.env'),
    processEnv: {
      DATA_ROOT: path.join(root, 'app', 'data'),
      WEBUI_DIR: path.join(root, 'webui', 'dist'),
      JWT_SECRET: TEST_SECRET,
      ...(options?.imgDryRun ? { IMG_DRY_RUN: '1' } : {}),
    },
  });
  const db = openDatabase(config.dataRoot);
  const anonymous = ensureAnonymousUser(db);
  const blobs = new BlobStore(config.dataRoot, db);
  const jobsDeps: JobServiceDeps = { config, db, blobs };
  const jobs = new JobService(jobsDeps, {
    sleep: { run: runSleepJob },
    generate: generateJob,
    engine: engineJob,
    ...extraRunners,
  });
  const sessions = new SessionService({ config, db, blobs, jobs });
  return {
    root,
    config,
    db,
    secret: TEST_SECRET,
    blobs,
    jobs,
    sessions,
    anonymous,
    jobsDeps: () => jobsDeps,
    context: (extra) => ({
      config,
      db,
      secret: TEST_SECRET,
      jobs,
      blobs,
      sessions,
      ...extra,
    }),
    tokenFor: async (user) => {
      const target = user ?? anonymous;
      const { token } = await signJwt(TEST_SECRET, { sub: target.id, role: target.role });
      return token;
    },
    dispose: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 路由级客户端：调用形状 router.tasks.create(...)；业务错误抛 ORPCError。 */
export function clientFor(context: RpcContext) {
  return createRouterClient(router, { context });
}
