/**
 * oRPC-over-WebSocket 路由表（design §2 RPC 行：@orpc/server + 同源 /ws/rpc?token=
 * ——zhumo rpc 模式）。W2.1 首批最小集：bootstrap（HTTP 面迁入）+ assets.upload +
 * tasks.create/get/list/cancel/frames（type=job 接线 tasks 表）。
 * 原始需求 2026-09-23（W2.1）。mock 逃生口=服务注入面：jobs/blobs 未装配时对应端点
 * 501（zhumo context 可选服务模式——测试可注入替身，前端 W3 mock fixture 并行开发）。
 * 正交意图：
 *   [1] context 与守卫中间件（requireAuth——token 经 WS upgrade ?token= 进入 context；
 *       requireActiveUser——写面绑定 disabled 用户，禁写不禁读）。
 *   [2] bootstrap 读面（密钥仅存在性布尔 + dry-run 旗标；值零出）。
 *   [3] assets.upload（内容寻址输入面——生成/排钻任务的图字节入口）。
 *   [4] tasks 五端点（归属校验 admin 豁免；业务 Error 投影 BAD_REQUEST）。
 */
import { ORPCError, os } from '@orpc/server';
import {
  AssetsUploadInputSchema,
  ResourcesExportInputSchema,
  ResourcesImportInputSchema,
  TaskCancelInputSchema,
  TaskCreateInputSchema,
  TaskFramesInputSchema,
  TaskGetInputSchema,
} from '@handicraft/contracts';
import type { SqliteDb } from './db/database.js';
import type { UserRow } from './db/store.js';
import { authenticate, isAllowAnonymous } from './auth.js';
import type { AppConfig } from './config.js';
import { isImgConfigured, isLlmConfigured } from './config.js';
import { DAEMON_VERSION } from './http.js';
import type { BlobStore } from './db/blobs.js';
import type { JobService } from './jobs/service.js';
import { exportFormat, importFormat } from './formats.js';

/** 每个 WS 连接（或测试调用）注入的初始 context。 */
export interface RpcContext {
  config: AppConfig;
  db: SqliteDb;
  /** JWT 签名密钥（启动装配解析后的最终值）。 */
  secret: string;
  /** 连接上携带的 JWT（upgrade ?token=）。 */
  token?: string;
  /** requireAuth 之后注入。 */
  user?: UserRow;
  /** W2 任务编排服务（未装配时 tasks 端点 501——mock 逃生口）。 */
  jobs?: JobService;
  /** 内容寻址存储（未装配时 assets.upload 501）。 */
  blobs?: BlobStore;
}

const base = os.$context<RpcContext>();

const requireAuth = base.use(async ({ context, next }) => {
  const user = context.user ?? (await authenticate(context.secret, context.db, context.token));
  if (!user) throw new ORPCError('UNAUTHORIZED', { message: '需要登录' });
  return next({ context: { ...context, user } });
});

/**
 * 写面守卫（spec §匿名账户「禁写不禁读」）：disabled 用户 token 仍可认证读，
 * 但所有 mutation 端点在此拒绝（P1-1）。绑定面：assets.upload / tasks.create /
 * tasks.cancel / resources.import（resources.export 与 tasks 读面不受限）。
 * 自包含认证（oRPC builder 无 concat 组合面——auth 逻辑在此重述两行，语义同 requireAuth）。
 */
const requireActiveUser = base.use(async ({ context, next }) => {
  const user = context.user ?? (await authenticate(context.secret, context.db, context.token));
  if (!user) throw new ORPCError('UNAUTHORIZED', { message: '需要登录' });
  if (user.disabled !== 0) {
    throw new ORPCError('FORBIDDEN', { message: '账户已禁用（禁写不禁读）' });
  }
  return next({ context: { ...context, user } });
});

function requireJobs(context: RpcContext): JobService {
  if (!context.jobs) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: '任务编排未装配（501）' });
  }
  return context.jobs;
}

/** 业务错误（任务不存在/无权访问等 Error）投影 BAD_REQUEST；ORPCError 原样透传。 */
function ownedError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  throw new ORPCError('BAD_REQUEST', {
    message: error instanceof Error ? error.message : String(error),
  });
}

// ---------------------------------------------------------------- bootstrap

const bootstrap = base.handler(({ context }) => {
  const { config, db } = context;
  return {
    version: DAEMON_VERSION,
    allowAnonymous: isAllowAnonymous(db, config.allowAnonymous),
    adminConfigured: config.adminUsername !== '' && config.adminPassword !== '',
    imgConfigured: isImgConfigured(config.img),
    llmConfigured: isLlmConfigured(config.llm),
    imgDryRun: config.imgDryRun,
  };
});

// ---------------------------------------------------------------- assets

const ASSETS_MAX_BYTES = 32 * 1024 * 1024;

const assetsUpload = requireActiveUser
  .input(AssetsUploadInputSchema)
  .handler(({ context, input }) => {
  const blobs = context.blobs;
  if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  const data = Buffer.from(input.dataBase64, 'base64');
  if (data.byteLength === 0) throw new ORPCError('BAD_REQUEST', { message: '上传内容为空' });
  if (data.byteLength > ASSETS_MAX_BYTES) {
    throw new ORPCError('BAD_REQUEST', { message: `上传超过 ${ASSETS_MAX_BYTES} 字节上限` });
  }
  const put = blobs.put(data);
  return { blobRef: put.hash, filename: input.filename, size: put.size };
});

// ---------------------------------------------------------------- tasks

const tasksCreate = requireActiveUser
  .input(TaskCreateInputSchema)
  .handler(async ({ context, input }) => {
    try {
      return await requireJobs(context).create(context.user as UserRow, input);
    } catch (error) {
      ownedError(error);
    }
  });

const tasksGet = requireAuth.input(TaskGetInputSchema).handler(async ({ context, input }) => {
  try {
    return await requireJobs(context).get(context.user as UserRow, input.taskId);
  } catch (error) {
    ownedError(error);
  }
});

const tasksList = requireAuth.handler(({ context }) => {
  return requireJobs(context).list(context.user);
});

const tasksCancel = requireActiveUser
  .input(TaskCancelInputSchema)
  .handler(({ context, input }) => {
    try {
      return requireJobs(context).cancel(context.user, input.taskId);
    } catch (error) {
      ownedError(error);
    }
  });

const tasksFrames = requireAuth
  .input(TaskFramesInputSchema)
  .handler(({ context, input }) => {
    try {
      return requireJobs(context).frames(context.user as UserRow, input.taskId, input.afterSeq);
    } catch (error) {
      ownedError(error);
    }
  });

// ---------------------------------------------------------------- resources（四族格式往返）

const resourcesImport = requireActiveUser
  .input(ResourcesImportInputSchema)
  .handler(({ context, input }) => {
    const blobs = context.blobs;
    if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
    const data = Buffer.from(input.dataBase64, 'base64');
    if (data.byteLength === 0) throw new ORPCError('BAD_REQUEST', { message: '导入内容为空' });
    try {
      return importFormat(context.db, blobs, (context.user as UserRow).id, input.filename, data);
    } catch (error) {
      ownedError(error);
    }
  });

const resourcesExport = requireAuth
  .input(ResourcesExportInputSchema)
  .handler(({ context, input }) => {
    const blobs = context.blobs;
    if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
    try {
      const out = exportFormat(context.db, blobs, (context.user as UserRow).id, input.resourceId);
      return {
        filename: out.filename,
        kind: out.kind,
        dataBase64: Buffer.from(out.bytes).toString('base64'),
      };
    } catch (error) {
      ownedError(error);
    }
  });

// ---------------------------------------------------------------- 路由表

export const router = {
  bootstrap,
  assets: {
    upload: assetsUpload,
  },
  resources: {
    import: resourcesImport,
    export: resourcesExport,
  },
  tasks: {
    create: tasksCreate,
    get: tasksGet,
    list: tasksList,
    cancel: tasksCancel,
    frames: tasksFrames,
  },
};

export type AppRouter = typeof router;
