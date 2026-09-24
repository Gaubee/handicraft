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
  SessionAnswerInputSchema,
  SessionCancelInputSchema,
  SessionClearInputSchema,
  SessionCreateInputSchema,
  SessionFollowupInputSchema,
  SessionGetInputSchema,
  SessionListInputSchema,
  SessionReplayInputSchema,
  SessionRetryInputSchema,
  SessionResultInputSchema,
  TaskCancelInputSchema,
  TaskCreateInputSchema,
  TaskFramesInputSchema,
  TaskGetInputSchema,
  TaskResultInputSchema,
} from '@handicraft/contracts';
import type { SqliteDb } from './db/database.js';
import type { UserRow } from './db/store.js';
import { authenticate, isAllowAnonymous } from './auth.js';
import type { AppConfig } from './config.js';
import { isImgConfigured, isLlmConfigured } from './config.js';
import { DAEMON_VERSION } from './http.js';
import type { BlobStore } from './db/blobs.js';
import type { JobService } from './jobs/service.js';
import type { SessionService } from './sessions/service.js';
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
  /** W3.2 Agent 会话服务（未装配时 session.* 501）。 */
  sessions?: SessionService;
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

function requireSessions(context: RpcContext): SessionService {
  if (!context.sessions) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: '会话服务未装配（501）' });
  }
  return context.sessions;
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
/**
 * 解码前置门（P1-4：防先分配后校验的匿名 DoS）：32MiB 字节的 base64 字符上限
 * = 4*ceil(32MiB/3)。字符串长度先拒绝，再进入 Buffer.from 解码——解码工作量
 * 以输入字符串长度为上界。
 */
const MAX_BASE64_CHARS = Math.ceil(ASSETS_MAX_BYTES / 3) * 4;

function decodeBoundedBase64(dataBase64: string, what: string): Buffer {
  if (dataBase64.length > MAX_BASE64_CHARS) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${what}超过 ${ASSETS_MAX_BYTES} 字节上限（base64 长度 ${dataBase64.length}）`,
    });
  }
  const data = Buffer.from(dataBase64, 'base64');
  if (data.byteLength === 0) throw new ORPCError('BAD_REQUEST', { message: `${what}内容为空` });
  if (data.byteLength > ASSETS_MAX_BYTES) {
    throw new ORPCError('BAD_REQUEST', { message: `${what}超过 ${ASSETS_MAX_BYTES} 字节上限` });
  }
  return data;
}

const assetsUpload = requireActiveUser
  .input(AssetsUploadInputSchema)
  .handler(({ context, input }) => {
    const blobs = context.blobs;
    if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
    const data = decodeBoundedBase64(input.dataBase64, '上传');
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
    const data = decodeBoundedBase64(input.dataBase64, '导入');
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

// ---------------------------------------------------------------- session（§3.5 契约——W3.2）

const sessionCreate = requireActiveUser.input(SessionCreateInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).create(context.user as UserRow, { title: input.title });
  } catch (error) {
    ownedError(error);
  }
});

const sessionList = requireAuth.input(SessionListInputSchema).handler(({ context, input }) => {
  return requireSessions(context).list(context.user as UserRow, input);
});

const sessionGet = requireAuth.input(SessionGetInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).get(context.user as UserRow, input.sessionId);
  } catch (error) {
    ownedError(error);
  }
});

/**
 * W4 接管占位（501）——但 §6.5 并发栅栏先行：clearing 生效后原子拒绝（服务面同一
 * 同步块读 status）。W4 实装时以同入口同语义复核。
 */
const sessionFollowup = requireActiveUser.input(SessionFollowupInputSchema).handler(({ context, input }) => {
  const sessions = requireSessions(context);
  try {
    sessions.assertSessionWritable(context.user as UserRow, input.sessionId);
  } catch (error) {
    ownedError(error);
  }
  throw new ORPCError('NOT_IMPLEMENTED', { message: 'session.followup 服务端实现归 W4（dsh 内核挂载）' });
});

/** 同 followup：栅栏先行 + 501 占位（W4 授权桥接管）。 */
const sessionAnswer = requireActiveUser.input(SessionAnswerInputSchema).handler(({ context, input }) => {
  const sessions = requireSessions(context);
  try {
    sessions.assertSessionWritable(context.user as UserRow, input.sessionId);
  } catch (error) {
    ownedError(error);
  }
  throw new ORPCError('NOT_IMPLEMENTED', { message: 'session.answer 服务端实现归 W4（审批授权桥）' });
});

const sessionCancel = requireActiveUser.input(SessionCancelInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).cancel(context.user as UserRow, input);
  } catch (error) {
    ownedError(error);
  }
});

const sessionClear = requireActiveUser.input(SessionClearInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).clear(context.user as UserRow, input.sessionId);
  } catch (error) {
    ownedError(error);
  }
});

/** W4.2 接管占位（attempt 账本——本波无外部 op，占位即可）。 */
const sessionRetry = requireActiveUser.input(SessionRetryInputSchema).handler(() => {
  throw new ORPCError('NOT_IMPLEMENTED', { message: 'session.retry 服务端实现归 W4.2（attempt 账本）' });
});

const sessionReplay = requireAuth.input(SessionReplayInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).replay(context.user as UserRow, {
      sessionId: input.sessionId,
      taskId: input.taskId,
      afterSeq: input.afterSeq,
    });
  } catch (error) {
    ownedError(error);
  }
});

const sessionResult = requireAuth.input(SessionResultInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).result(context.user as UserRow, input.sessionId);
  } catch (error) {
    ownedError(error);
  }
});

const taskResult = requireAuth.input(TaskResultInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).taskResult(context.user as UserRow, input.taskId);
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
    result: taskResult,
  },
  session: {
    create: sessionCreate,
    list: sessionList,
    get: sessionGet,
    followup: sessionFollowup,
    answer: sessionAnswer,
    cancel: sessionCancel,
    clear: sessionClear,
    retry: sessionRetry,
    replay: sessionReplay,
    result: sessionResult,
  },
};

export type AppRouter = typeof router;
