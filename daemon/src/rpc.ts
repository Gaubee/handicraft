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
 *   [5] stones 读面三端点（S3.1——tree/list/get：SQL 索引查询+四态解析；共享读
 *       readScope 标注，评审 D-1；写面归 capability 授权桥，不在本路由）。
 */
import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import {
  AssetsUploadInputSchema,
  IdSchema,
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
import type { DshKernelFacade } from './kernel/index.js';
import type { ApprovalService } from './capability/authorization.js';
import { exportFormat, importFormat } from './formats.js';
import { StoneService } from './stones/service.js';
import { queryStoneCells, READ_SCOPE_SHARED, stonesTreeOf } from './stones/query.js';

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
  /** W4.1 dsh 内核（未装配/降级时 session.followup 501——§6.4 四态）。 */
  kernel?: DshKernelFacade;
  /** W4.2 授权桥（未装配时 session.answer/retry 501）。 */
  approvals?: ApprovalService;
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
    // W3 评审 P1-3 勘定：上传是**无会话归属**的原始字节获取（不写 session_blob_refs
    // 账本）——不存在可 CAS 的会话状态，也结构性不可能复活 cleared 会话的引用。
    // W4 followup 附件面必须改走 acquireSessionBlobRef（session CAS 同事务）。
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
 * W4.1 实装：dsh 内核接管（§6.5 并发栅栏语义保持——clearing 生效后原子拒绝，
 * 与内核状态判定同入口）。内核未装配或降级（off/missing/error——§6.4 四态的
 * 前三态）→ 501（基础工作流不受影响）；ready → 真实管线（task 行+帧流）。
 */
const sessionFollowup = requireActiveUser.input(SessionFollowupInputSchema).handler(async ({ context, input }) => {
  const sessions = requireSessions(context);
  try {
    sessions.assertSessionWritable(context.user as UserRow, input.sessionId);
  } catch (error) {
    ownedError(error);
  }
  const kernel = context.kernel;
  if (!kernel) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: 'dsh 内核未装配（501）' });
  }
  if (kernel.state !== 'ready') {
    throw new ORPCError('NOT_IMPLEMENTED', {
      message: `dsh 内核降级（state=${kernel.state}）：${kernel.reason}——agent 面 501，基础工作流不受影响（design §6.4）`,
    });
  }
  try {
    return await kernel.followup(context.user as UserRow, input.sessionId, {
      text: input.text,
      ...(input.attachments ? { attachments: input.attachments } : {}),
    });
  } catch (error) {
    ownedError(error);
  }
});

/**
 * W4.2 实装：审批应答（§3.6 授权桥）——栅栏先行（clearing 原子拒），owner 归属
 * 校验在 ApprovalService.answer 内（session owner + request 归属该 session）。
 * approved=true 签发 grant（服务端内部关联——grantId/nonce 零出帧/载荷）；
 * false → proposal 终态 failed。双路径发 approval-resolved 帧。
 */
const sessionAnswer = requireActiveUser.input(SessionAnswerInputSchema).handler(({ context, input }) => {
  const sessions = requireSessions(context);
  try {
    sessions.assertSessionWritable(context.user as UserRow, input.sessionId);
  } catch (error) {
    ownedError(error);
  }
  if (!context.approvals) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: '授权桥未装配（501）' });
  }
  try {
    return context.approvals.answer(context.user as UserRow, {
      sessionId: input.sessionId,
      requestId: input.requestId,
      approved: input.approved,
    });
  } catch (error) {
    ownedError(error);
  }
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

/** W4.2 实装：owner 重试确认（§3.6 R5/R6 attempt 账本——幂等键语义见 authorization.retry）。 */
const sessionRetry = requireActiveUser.input(SessionRetryInputSchema).handler(({ context, input }) => {
  if (!context.approvals) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: '授权桥未装配（501）' });
  }
  try {
    return context.approvals.retry(context.user as UserRow, {
      sessionId: input.sessionId,
      proposalId: input.proposalId,
      costConfirmed: input.costConfirmed,
      retryRequestId: input.retryRequestId,
    });
  } catch (error) {
    ownedError(error);
  }
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

// ---------------------------------------------------------------- stones（S3.1——共享读真源查询面）

/**
 * 装饰钻库读面（design §4.1；评审 D-1 共享读裁定）：全部认证用户见同一库内容
 * （供应链真源）——每响应带 readScope:'shared-library'；requireAuth 即足（disabled
 * 用户沿「禁写不禁读」可读）。list/tree 走 stones/query.ts SQL 索引查询（真源查询
 * 面——不复用 S4 listIndexRows JS 过滤，评审 P2-4）；get 复用 StoneService 四态解析。
 */
const StonesTreeInputSchema = z.object({
  rootId: IdSchema.optional().describe('子树根（缺省=standards 根）'),
  includeTrashed: z.boolean().default(false),
});

const StonesListInputSchema = z.object({
  supplier: z.string().min(1).optional(),
  family: z.string().min(1).optional(),
  sizeMm: z.number().positive().optional(),
  styleRow: z.number().int().optional(),
  sku: z.string().min(1).optional(),
  q: z.string().min(1).optional().describe('关键字（SKU/供应商/色系/款式名/十六进制子串）'),
  groupBy: z.enum(['family', 'sizeMm', 'style']).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
  includeTrashed: z.boolean().default(false),
});

const StonesGetInputSchema = z.object({ resourceId: IdSchema });

const stonesTree = requireAuth.input(StonesTreeInputSchema).handler(({ context, input }) => {
  try {
    return { ...stonesTreeOf(context.db, input), readScope: READ_SCOPE_SHARED };
  } catch (error) {
    ownedError(error);
  }
});

const stonesList = requireAuth.input(StonesListInputSchema).handler(({ context, input }) => {
  try {
    return { ...queryStoneCells(context.db, input), readScope: READ_SCOPE_SHARED };
  } catch (error) {
    ownedError(error);
  }
});

const stonesGet = requireAuth.input(StonesGetInputSchema).handler(({ context, input }) => {
  if (!context.blobs) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  }
  try {
    const stones = new StoneService({ db: context.db, blobs: context.blobs });
    const resolution = stones.resolveStoneRef(input.resourceId);
    if (resolution.state !== 'resolved' && resolution.state !== 'soft-deleted') {
      return { resourceId: input.resourceId, state: resolution.state, readScope: READ_SCOPE_SHARED };
    }
    try {
      const detail = stones.getStone(input.resourceId);
      return {
        resourceId: input.resourceId,
        state: resolution.state,
        revision: detail.revision,
        path: detail.path,
        trashed: detail.trashed,
        stone: detail.stone,
        texture: {
          blobRef: detail.texture.blobRef,
          width: detail.texture.width,
          height: detail.texture.height,
          textureUrl: `/api/stones/${input.resourceId}/texture.png`,
        },
        readScope: READ_SCOPE_SHARED,
      };
    } catch {
      // resolve 与 get 竞态窗口（blob 在两步之间消失）——以解析态为准呈现。
      return { resourceId: input.resourceId, state: resolution.state, readScope: READ_SCOPE_SHARED };
    }
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
  stones: {
    tree: stonesTree,
    list: stonesList,
    get: stonesGet,
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
