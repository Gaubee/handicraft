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
 *   [6] sets 六端点（S7.4 工作台硬前置——人工直发写面，design §7.4：admin/human-ui
 *       直调非 agent 授权桥；owner 隔离 D-1——list 过滤/get·update·delete 归属校验
 *       （admin 豁免照 jobs requireOwnedTask）/create ownerId=当前用户；createFromBom
 *       =S7.6 接口位冻结 typed 拒 501）。
 *   [7] stones admin 写三端点（S3.3 占位升级）：trash/restore（S1 递归盖戳服务面
 *       直发）+ importRun（S2 runCardImport 人工直发——操作者即批准人，审计记
 *       owner=当前用户；与 agent 面 proposal 流并存，两者收敛同一 runCardImport）；
 *       owner 归属校验+admin 豁免照 sets；list 增 resourceIds 组合投影参（S7.5）。
 *   [8] tasks.artifact 工件字节读面（add-subject-sam-pipeline P3.2-channel）：帧流
 *       artifact 帧只带 {name,blobRef}，UI 无 blob 读通道——本端点按任务归属读回
 *       字节。合法引用集=该任务 artifact 帧（name/blobRef 命中）∪ 所属会话附件
 *       blob（session_blob_refs——原图叠加通道）；>8MiB typed 拒（artifact-too-large）。
 *   [9] 任务详情·排钻工作台（add-task-detail-layer-workbench 1.3——design D-1 人类
 *       主权面）：task.detail 组装读面 + layer.split/rename/strategy.set 与
 *       tree.history/revert 直调写面（登录态+owner 归属+操作者入 tree 版本史；
 *       不走 capability 授权桥——Agent 对话场景提案→批准铁律零触碰）。
 */
import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import {
  AssetsUploadInputSchema,
  CardCatalogDraftSchema,
  IdSchema,
  LayerDeleteInputSchema,
  LayerMaskPatchInputSchema,
  LayerReorderInputSchema,
  LayerRenameInputSchema,
  LayerSplitInputSchema,
  LayerStrategySetInputSchema,
  ProductionSetMemberSchema,
  ProductionSetOriginSchema,
  ResourcesExportInputSchema,
  ResourcesImportInputSchema,
  SceneAnalysisSchema,
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
  StrategyPlanSchema,
  type StrategyAssignment,
  TASK_ARTIFACT_MAX_BYTES,
  TaskArtifactInputSchema,
  TaskCancelInputSchema,
  TaskCreateInputSchema,
  TaskDetailInputSchema,
  TaskFramesInputSchema,
  TaskGetInputSchema,
  TaskResultInputSchema,
  TaskStopInputSchema,
  TreeHistoryInputSchema,
  TreeRevertInputSchema,
  ViewStateSetInputSchema,
  WORKBENCH_VIEW_STATE_ARTIFACT_NAME,
} from '@handicraft/contracts';
import type { SqliteDb } from './db/database.js';
import type { UserRow } from './db/store.js';
import { authenticate, isAllowAnonymous } from './auth.js';
import type { AppConfig } from './config.js';
import { isImgConfigured, isLlmConfigured } from './config.js';
import { DAEMON_VERSION } from './http.js';
import type { BlobStore } from './db/blobs.js';
import { getTaskById } from './db/jobs.js';
import { listSessionBlobRefs } from './db/sessions.js';
import type { JobService } from './jobs/service.js';
import type { SessionService } from './sessions/service.js';
import type { DshKernelFacade } from './kernel/index.js';
import type { ApprovalService } from './capability/authorization.js';
import { exportFormat, importFormat } from './formats.js';
import { StoneService, StoneServiceError } from './stones/service.js';
import {
  CardImportError,
  runCardImport,
  type CardImportReport,
} from './stones/importer.js';
import { SetService, SetServiceError, type SetPatch } from './stones/sets-service.js';
import { BOM_SOURCE_NOT_IMPLEMENTED } from './capability/sets.js';
import { queryStoneCells, READ_SCOPE_SHARED, RESOURCE_IDS_LIMIT, stonesTreeOf } from './stones/query.js';
import type { TaskWorkbench } from './kernel/workbench.js';
import {
  exportGateOf,
  loadViewState,
  maskEditStatusesOf,
  TaskWorkbenchError,
} from './kernel/workbench.js';
import {
  STRATEGY_GEMS_ARTIFACT_NAME,
  STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME,
  STRATEGY_PLAN_ARTIFACT_NAME,
  StrategyGemsDocSchema,
} from './kernel/strategies/design.js';
import { SCENE_ANALYSIS_ARTIFACT_NAME } from './kernel/vision/scene-analyze.js';
import {
  OBJECT_TREE_ARTIFACT_NAME,
  OBJECT_TREE_PREVIEW_ARTIFACT_NAME,
} from './kernel/vision/segment-one.js';
import { loadObjectTreeArtifact } from './kernel/vision/tree-persist.js';

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

/**
 * 打断当前轮（三通道 1.4，对齐 shufa b6cec8a tasksStop——打断≠终态取消）：中止
 * 生成、任务回 done（可续聊——同会话再 followup）；区别于 tasks.cancel（终态
 * cancelled 不可续聊，管理面）。内核装配即调 stopTask（live 已丢亦有行级收口）；
 * 未装配时无 agent 活动可打断，仅保留「已取消拒绝」面并返回现值。
 */
const tasksStop = requireActiveUser
  .input(TaskStopInputSchema)
  .handler(async ({ context, input }) => {
    const jobs = requireJobs(context);
    try {
      if (context.kernel) {
        context.kernel.stopTask(context.user as UserRow, input.taskId);
      } else {
        const row = jobs.requireOwnedTask(context.user as UserRow, input.taskId);
        if (row.status === 'cancelled') throw new Error('已取消的任务不可操作');
      }
      // [Codex W10 P0-1] 裸 TaskView（TaskStopOutputSchema=TaskViewSchema 冻结契约）——
      // jobs.get 的 {task} 包装在此剥除，前端 façade 按同一 schema 守门解析。
      return (await jobs.get(context.user as UserRow, input.taskId)).task;
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

// ---------------------------------------------------------------- tasks.artifact（工件字节读面——P3.2-channel）

/** 扩展名 → MIME（管线工件名约定：*.png/*.json/*.svg——emit 层单源名集）。 */
const ARTIFACT_MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  json: 'application/json',
  svg: 'image/svg+xml',
  txt: 'text/plain',
};

/** 附件 blob（无扩展名）魔数嗅探——原图叠加通道的输入图只可能是 PNG/JPEG。 */
function sniffedImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  return null;
}

function mimeOfArtifact(name: string, bytes: Uint8Array): string {
  const dot = name.lastIndexOf('.');
  if (dot >= 0) {
    const mime = ARTIFACT_MIME_BY_EXTENSION[name.slice(dot + 1).toLowerCase()];
    if (mime !== undefined) return mime;
  }
  return sniffedImageMime(bytes) ?? 'application/octet-stream';
}

/**
 * 工件字节读面（正交意图 [8]）：入参 {taskId, blobRef|name} → {name, mime, dataBase64}。
 * 归属（requireOwnedTask 形态）：任务行不存在 → NOT_FOUND；跨用户（非 admin）→
 * FORBIDDEN——B 读不到 A 的任务工件。引用合法集（防 blob 读 oracle——持自己 taskId
 * 读任意 hash 必拒）：该任务帧流 artifact 帧（name→最新同名帧的 blobRef；blobRef→
 * 须命中任一 artifact 帧）∪ 所属会话附件 blob（原图叠加通道）。尺寸护栏：blob 行
 * size > 8MiB → typed 拒（artifact-too-large——先查行后读字节，不先分配）。
 */
const tasksArtifact = requireAuth.input(TaskArtifactInputSchema).handler(({ context, input }) => {
  const blobs = context.blobs;
  if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  const jobs = requireJobs(context);
  try {
    const user = context.user as UserRow;
    const task = getTaskById(context.db, input.taskId);
    if (task === null) {
      throw new ORPCError('NOT_FOUND', { message: `任务不存在：${input.taskId}` });
    }
    if (task.owner_id !== user.id && user.role !== 'admin') {
      throw new ORPCError('FORBIDDEN', { message: '无权访问该任务工件（跨用户访问必拒——B 读不到 A 的任务工件）' });
    }

    // [1] artifact 帧解析：按名取最新同名帧 / 按 blobRef 找命中帧（逆序=最新优先）。
    const { frames } = jobs.frames(user, input.taskId, 0);
    let blobRef: string | null = null;
    let name: string | null = null;
    for (let i = frames.length - 1; i >= 0; i -= 1) {
      const frame = frames[i]!;
      if (frame.kind !== 'artifact') continue;
      const payload = frame.payload;
      if (input.name !== undefined) {
        if (payload.name === input.name && payload.blobRef !== undefined) {
          blobRef = payload.blobRef;
          name = payload.name;
          break;
        }
      } else if (input.blobRef !== undefined && payload.blobRef === input.blobRef) {
        blobRef = payload.blobRef;
        name = payload.name ?? null;
        break;
      }
    }

    // [2] 附件引用面（原图叠加通道）：artifact 帧未命中且按 blobRef 直取 → 会话
    //     附件集校验（session_blob_refs——owner 已验，附件属同会话即同 owner）。
    if (blobRef === null && input.blobRef !== undefined && task.session_id !== null) {
      const owned = listSessionBlobRefs(context.db, task.session_id).some(
        (row) => row.blob_hash === input.blobRef,
      );
      if (owned) blobRef = input.blobRef;
    }

    if (blobRef === null) {
      throw new ORPCError('NOT_FOUND', {
        message:
          input.name !== undefined
            ? `任务 ${input.taskId} 帧流内无名为「${input.name}」的 artifact 帧`
            : `blobRef 不属于任务 ${input.taskId} 的工件引用集（artifact 帧 ∪ 会话附件）`,
      });
    }

    // [3] 尺寸护栏（先查行 size 再读字节）+ 读回。
    const row = blobs.rowOf(blobRef);
    if (row === null) {
      throw new ORPCError('NOT_FOUND', { message: `工件 blob 不存在或已回收：${blobRef}` });
    }
    if (row.size > TASK_ARTIFACT_MAX_BYTES) {
      throw new ORPCError('BAD_REQUEST', {
        message: `工件超过 ${TASK_ARTIFACT_MAX_BYTES} 字节上限（实为 ${row.size}）——预览图/JSON 工件应远小于此`,
        data: { code: 'artifact-too-large', size: row.size, maxBytes: TASK_ARTIFACT_MAX_BYTES },
      });
    }
    const bytes = blobs.read(blobRef);
    if (bytes === null) {
      throw new ORPCError('NOT_FOUND', { message: `工件 blob 不可读（存储异常）：${blobRef}` });
    }

    const finalName = name ?? `attachment-${blobRef.slice(0, 12)}`;
    return {
      name: finalName,
      mime: mimeOfArtifact(finalName, bytes),
      dataBase64: Buffer.from(bytes).toString('base64'),
    };
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
      ...(input.mode ? { mode: input.mode } : {}),
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
  resourceIds: z
    .array(IdSchema)
    .min(1)
    .max(RESOURCE_IDS_LIMIT)
    .optional()
    .describe('组合成员投影过滤（design §7.5）：sets.get 成员 resourceId 集——非空时 list 限定该集'),
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

// ---------------------------------------------------------------- stones admin 写面（S3.3 占位升级）

/**
 * 装饰钻库人工直发写面（design §4.2 管理视图收尾）：软删/恢复走 S1 递归盖戳
 * 服务函数；importRun 走 S2 runCardImport。**不走 capability 授权桥**——人工直发
 * =操作者即批准人（照 sets 六端点 §7.4 裁定；agent/MCP 面 proposal 流并存，两者
 * 最终收敛到同一 service/importer）。owner 归属校验+admin 豁免照 sets（D-1：库
 * 内容共享读不变，写面按 resources.owner_id 审计——B 不得动 A 的原子）。
 */

const StonesTrashInputSchema = z.object({ resourceId: IdSchema });
const StonesRestoreInputSchema = z.object({ resourceId: IdSchema });

/** stones.importRun 入参（options 对齐 S2 CardImportOptions 冻结面；ownerId 服务端注入）。 */
const StonesImportRunInputSchema = z.object({
  draft: CardCatalogDraftSchema.describe('样卡草表（vision 产出 CardCatalogDraft——schema 不过=typed invalid-draft 拒）'),
  options: z.object({
    targetSupplier: z.string().min(1).describe('落库供应商（supplier×sku 唯一键的键半）'),
    supplierDisplayName: z.string().min(1).optional(),
    familyPolicy: z
      .object({
        overrides: z.record(z.string(), z.string()).optional().describe('suggestedFamily→目标色系（键级覆盖）'),
        fallbackFamily: z.string().min(1).optional(),
      })
      .optional(),
    qualityFlag: z.string().min(1).optional().describe('§8.1 规则 8 源质量旗透传'),
    extraMetadata: z.record(z.string(), z.unknown()).optional(),
    backgroundTolerance: z.number().int().min(0).max(255).optional(),
    featherPx: z.number().int().min(0).max(2).optional(),
  }),
  sourcePages: z
    .record(z.string().regex(/^\d+$/, '页号'), z.string().regex(/^[0-9a-f]{64}$/, 'blobRef（sha256）'))
    .optional()
    .describe('多页源图 blob 映射：页号→assets.upload 所得 blobRef（缺省回退 draft.sourceImage.blobRef 单页）'),
});

/** StoneService 装配（blobs 未装配 501——照 setsServiceOf 形态）。 */
function stonesServiceOf(context: RpcContext): StoneService {
  if (!context.blobs) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  }
  return new StoneService({ db: context.db, blobs: context.blobs });
}

/**
 * stone/set 服务错误 → BAD_REQUEST（typed code 走 data 保留——sku-conflict/
 * system-dir-protected/invalid-draft 等可编程判别；与 setOwnedError 同族）。
 */
function stoneOwnedError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  if (error instanceof StoneServiceError || error instanceof CardImportError) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${error instanceof StoneServiceError ? 'stone' : 'import'} 服务错误（${error.code}）：${error.message}`,
      data: { code: error.code },
    });
  }
  throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : String(error) });
}

const stonesTrash = requireActiveUser.input(StonesTrashInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedResource(context, input.resourceId, '钻原子');
    const result = stonesServiceOf(context).softDelete(input.resourceId);
    return {
      resourceId: input.resourceId,
      trashedRows: result.trashedRows,
      trashedStones: result.trashedStones,
      note: '软删=回收站语义（递归盖戳；引用解析四态 soft-deleted，restore 可恢复）',
    };
  } catch (error) {
    stoneOwnedError(error);
  }
});

const stonesRestore = requireActiveUser.input(StonesRestoreInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedResource(context, input.resourceId, '钻原子');
    const result = stonesServiceOf(context).restore(input.resourceId);
    return {
      resourceId: input.resourceId,
      restoredRows: result.restoredRows,
      restoredStones: result.restoredStones,
      note: '恢复=清子树戳+按祖先链重算投影（祖先仍盖戳的部分恢复级联语义保持）',
    };
  } catch (error) {
    stoneOwnedError(error);
  }
});

/**
 * 人工直发执行导入（design §8 执行步）：直调 S2 runCardImport——操作者即批准人
 * （与 agent 面 stone.import proposal 流并存，两者同一 importer，幂等语义共享：
 * supplier×sku 已存在即跳过，重跑收敛）。审计：options.ownerId=当前用户（新建
 * 原子归属）。返回 CardImportResult 六字段+report 全文（reportRef blob 留档的
 * 即时读回——管理视图直接渲染导入报告，archiveRef 仍是留档真源）。
 */
const stonesImportRun = requireActiveUser.input(StonesImportRunInputSchema).handler(({ context, input }) => {
  const blobs = context.blobs;
  if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  try {
    const pageImages = new Map<number, Uint8Array>();
    for (const [pageKey, blobRef] of Object.entries(input.sourcePages ?? {})) {
      const bytes = blobs.read(blobRef);
      if (bytes === null) {
        throw new ORPCError('BAD_REQUEST', {
          message: `sourcePages 页 ${pageKey} blob 不可读：${blobRef}（先经 assets.upload 入库）`,
        });
      }
      pageImages.set(Number.parseInt(pageKey, 10), bytes);
    }
    const result = runCardImport(
      { service: stonesServiceOf(context), blobs, db: context.db, pageImages },
      input.draft,
      { ...input.options, ownerId: (context.user as UserRow).id },
    );
    return { ...result, report: cardImportReportOf(blobs, result.reportRef) };
  } catch (error) {
    stoneOwnedError(error);
  }
});

/** 导入报告 blob 即时读回（刚写入即不可读=存储异常——INTERNAL_SERVER_ERROR 面）。 */
function cardImportReportOf(blobs: NonNullable<RpcContext['blobs']>, reportRef: string): CardImportReport {
  const bytes = blobs.read(reportRef);
  if (bytes === null) {
    throw new ORPCError('INTERNAL_SERVER_ERROR', { message: `导入报告 blob 不可读：${reportRef}` });
  }
  return JSON.parse(bytes.toString('utf8')) as CardImportReport;
}

// ---------------------------------------------------------------- sets（S7.4 工作台硬前置——人工直发面）

/**
 * 生产组合 RPC 六端点（design §7.4：人工直发走 admin/owner 写权限；AI 发起走
 * capability set.* 授权桥——§7.5。非 agent 授权桥面）。owner 隔离语义（评审 D-1：
 * 组合=私有生产工件，读写均按 owner）：list=owner 过滤（照 jobs.list）；get/update/
 * delete=owner 归属校验+admin 豁免（照 jobs requireOwnedTask）；create=ownerId=
 * 当前用户。错误面：SetServiceError → BAD_REQUEST+data.code（typed 码保留）。
 */

const SetsListInputSchema = z.object({
  name: z.string().min(1).optional().describe('名称子串筛选（如「卡通」）'),
  purpose: z.string().min(1).optional().describe('用途子串筛选'),
  originKind: z.enum(['manual-pick', 'bom-derived', 'clone']).optional().describe('来源筛选（§7.4 三来源）'),
  includeTrashed: z.boolean().default(false),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
});

const SetsGetInputSchema = z.object({ resourceId: IdSchema });

const SetsCreateInputSchema = z.object({
  name: z.string().min(1).describe('组合名（如「卡通人物套餐-A」）'),
  purpose: z.string().optional().describe('用途（如「小件卡通订单」）'),
  /** manual-pick 必给非空清单；clone 禁给（服务端浅拷贝母组合——双源必拒）。 */
  members: z.array(ProductionSetMemberSchema).optional(),
  origin: ProductionSetOriginSchema.describe('来源（§7.4）：manual-pick=人工挑拣 / clone={fromSetId} / bom-derived=冻结拒'),
});

const SetsUpdateInputSchema = z.object({
  resourceId: IdSchema,
  /** CAS 基线（工作台持有的当前 revision——漂移必拒，§1.6 同规）。 */
  baseRevision: z.number().int().min(1),
  patch: z
    .object({
      name: z.string().min(1).optional().describe('组合改名（目录行同事务改名）'),
      purpose: z.string().nullable().optional().describe('用途（null=清除）'),
      addMembers: z.array(ProductionSetMemberSchema).optional().describe('追加成员（stoneRef 重复必拒）'),
      removeMembers: z.array(z.string().min(1)).optional().describe('移除成员 stoneRef 清单（清空必拒——删组合走 sets.delete）'),
      updateMembers: z
        .array(
          z
            .object({
              stoneRef: z.string().min(1),
              quantity: z.number().int().positive().nullable().optional().describe('数量（null=清除）'),
              note: z.string().nullable().optional().describe('备注（null=清除）'),
            })
            .strict(),
        )
        .optional()
        .describe('成员数量/备注字段级更新（指向非成员必拒）'),
    })
    .strict(),
});

const SetsDeleteInputSchema = z.object({ resourceId: IdSchema });

/** S7.6 接口位冻结输入位（capability SetCreateFromBomInputSchema 同形）。 */
const SetsCreateFromBomInputSchema = z.object({
  taskId: z.string().min(1).describe('排钻任务 id'),
  sourceTaskId: z.string().min(1).describe('BOM 溯源任务 id（服务端聚合 stoneRef×数量）'),
});

/** SetService 装配（照 stonesGet 的 StoneService 就地构造形态；blobs 未装配 501）。 */
function setsServiceOf(context: RpcContext): SetService {
  if (!context.blobs) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  }
  const stones = new StoneService({ db: context.db, blobs: context.blobs });
  return new SetService({ db: context.db, blobs: context.blobs, stones });
}

/**
 * owner 归属校验（照 jobs requireOwnedTask：跨用户拒+admin 豁免——D-1 组合按
 * owner / stones 写面同规）：sets get·update·delete 与 stones trash·restore·importRun
 * 共用（importRun 只查目标原子存在性归属——新建原子 ownerId=当前用户）。
 */
function requireOwnedResource(context: RpcContext, resourceId: string, what: string): void {
  const row = context.db
    .prepare('SELECT owner_id FROM resources WHERE id = ?')
    .get(resourceId) as { owner_id: string } | undefined;
  if (row === undefined) {
    throw new ORPCError('BAD_REQUEST', { message: `资源不存在：${resourceId}` });
  }
  const user = context.user as UserRow;
  if (row.owner_id !== user.id && user.role !== 'admin') {
    throw new ORPCError('FORBIDDEN', {
      message: `资源不属于当前用户（跨用户${what}访问必拒——${what}写面按 owner 归属）`,
    });
  }
}

/** SetServiceError → BAD_REQUEST（typed code 走 data 保留——CAS/杂质字段可编程判别）。 */
function setOwnedError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  if (error instanceof SetServiceError) {
    throw new ORPCError('BAD_REQUEST', {
      message: `set 服务错误（${error.code}）：${error.message}`,
      data: { code: error.code },
    });
  }
  throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : String(error) });
}

const setsList = requireAuth.input(SetsListInputSchema).handler(({ context, input }) => {
  try {
    const rows = setsServiceOf(context).listSets({
      ownerId: (context.user as UserRow).id,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.originKind !== undefined ? { originKind: input.originKind } : {}),
      includeTrashed: input.includeTrashed,
    });
    const total = rows.length;
    return {
      sets: rows.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
      total,
      page: input.page,
      pageSize: input.pageSize,
    };
  } catch (error) {
    setOwnedError(error);
  }
});

const setsGet = requireAuth.input(SetsGetInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedResource(context, input.resourceId, '组合');
    const detail = setsServiceOf(context).getSet(input.resourceId);
    return {
      resourceId: detail.resourceId,
      setId: detail.setId,
      revision: detail.revision,
      path: detail.path,
      trashed: detail.trashed,
      set: detail.set,
      members: detail.members,
    };
  } catch (error) {
    setOwnedError(error);
  }
});

const setsCreate = requireActiveUser.input(SetsCreateInputSchema).handler(({ context, input }) => {
  try {
    return setsServiceOf(context).createSet({
      ownerId: (context.user as UserRow).id,
      name: input.name,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.members !== undefined ? { members: input.members } : {}),
      origin: input.origin,
    });
  } catch (error) {
    setOwnedError(error);
  }
});

const setsUpdate = requireActiveUser.input(SetsUpdateInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedResource(context, input.resourceId, '组合');
    const result = setsServiceOf(context).updateSet(input.resourceId, input.patch as SetPatch, {
      baseRevision: input.baseRevision,
    });
    return { resourceId: result.resourceId, revision: result.revision, path: result.path, memberCount: result.memberCount };
  } catch (error) {
    setOwnedError(error);
  }
});

const setsDelete = requireActiveUser.input(SetsDeleteInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedResource(context, input.resourceId, '组合');
    const result = setsServiceOf(context).softDeleteSet(input.resourceId);
    return { resourceId: input.resourceId, trashedRows: result.trashedRows, note: '软删=回收站语义（成员弱引用零变更——标准原子不受影响）' };
  } catch (error) {
    setOwnedError(error);
  }
});

/**
 * S7.6 接口位冻结（与 capability 面同码同因）：bom-derived 执行链依赖内核 P3
 * （排钻产物 StonePick.stoneRef 溯源）——落地前 RPC 位显式 typed 拒（501），不猜测。
 */
const setsCreateFromBom = requireActiveUser.input(SetsCreateFromBomInputSchema).handler(() => {
  throw new ORPCError('NOT_IMPLEMENTED', {
    message: `${BOM_SOURCE_NOT_IMPLEMENTED}：bom-derived 来源依赖内核排钻产物 stone 溯源（接口位冻结未实现）——当前用 manual-pick（人工挑拣）或 clone（复用既有组合）`,
    data: { code: BOM_SOURCE_NOT_IMPLEMENTED },
  });
});

// ---------------------------------------------------------------- 任务详情·排钻工作台（add-task-detail-layer-workbench 1.3）

/**
 * 人类主权面（design D-1）：task.detail 组装读面 + layer.split / layer.rename /
 * layer.strategy.set / tree.revert 直调写面（登录态+owner 归属校验+操作者入 tree
 * 版本史——不走 capability 授权桥；Agent 对话场景的提案→批准铁律零触碰）。
 * 数据组装真源=tasks 行 ∪ sessions 行 ∪ 帧流 artifact 帧（latest-by-name）∪ blobs
 * 读回——与 tasks.artifact 同一合法集口径（帧∪任务域工件，不越权读任意 hash）。
 */

/** 工作台装配（kernel 同源实例——桥/引擎委派与 capability 面共享；未装配 501）。 */
function workbenchOf(context: RpcContext): TaskWorkbench {
  const workbench = context.kernel?.workbench;
  if (!workbench) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: 'dsh 内核未装配（501）——工作台不可用' });
  }
  return workbench;
}

/** 任务行归属校验（tasksArtifact 同款：NOT_FOUND/FORBIDDEN——admin 豁免）。 */
function requireWorkbenchTask(context: RpcContext, taskId: string) {
  const task = getTaskById(context.db, taskId);
  if (task === null) {
    throw new ORPCError('NOT_FOUND', { message: `任务不存在：${taskId}` });
  }
  const user = context.user as UserRow;
  if (task.owner_id !== user.id && user.role !== 'admin') {
    throw new ORPCError('FORBIDDEN', { message: '无权访问该任务（跨用户工作台访问必拒）' });
  }
  return task;
}

/** 帧流最新同名 artifact 引用（逆序扫描——latest-by-name 即「当前」工件指针）。 */
function latestArtifactRefs(
  jobs: JobService,
  user: UserRow,
  taskId: string,
): Map<string, string> {
  const { frames } = jobs.frames(user, taskId, 0);
  const byName = new Map<string, string>();
  for (let i = frames.length - 1; i >= 0; i -= 1) {
    const frame = frames[i]!;
    if (frame.kind !== 'artifact') continue;
    const payload = frame.payload as { name?: unknown; blobRef?: unknown };
    if (
      typeof payload.name === 'string' &&
      typeof payload.blobRef === 'string' &&
      !byName.has(payload.name)
    ) {
      byName.set(payload.name, payload.blobRef);
    }
  }
  return byName;
}

/** 工件 JSON 读回（blob 缺失/JSON 损坏=typed 拒——不静默跳过数据腐蚀）。 */
function readArtifactJson(blobs: NonNullable<RpcContext['blobs']>, ref: string, what: string): unknown {
  const bytes = blobs.read(ref);
  if (bytes === null) {
    throw new ORPCError('NOT_FOUND', { message: `${what} 工件不可读（blobRef=${ref.slice(0, 12)}…）` });
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new ORPCError('BAD_REQUEST', {
      message: `${what} 工件不是合法 JSON（blobRef=${ref.slice(0, 12)}…）：${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/** TaskWorkbenchError → BAD_REQUEST（typed kind 走 data 保留——前端可编程判别；
 * cas-mismatch 附 currentTreeBlobRef——幂等重试判别锚）。 */
function workbenchOwnedError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  if (error instanceof TaskWorkbenchError) {
    throw new ORPCError('BAD_REQUEST', {
      message: `工作台错误（${error.kind}）：${error.message}`,
      data: {
        code: error.kind,
        ...(error.currentTreeBlobRef !== undefined ? { currentTreeBlobRef: error.currentTreeBlobRef } : {}),
      },
    });
  }
  throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : String(error) });
}

/**
 * task.detail 组装端点：task/session 行 + 六工件面（baseImage=scene-analysis、
 * tree=object-tree、assignments=strategy-plan、gems/preview=strategy-gems 三件）。
 * 管线未跑到该步的字段=null/[]（前端按在场渲染）；title 派生=会话标题→agent
 * 首条输入文本（60 字截断）→null。
 */
const taskDetail = requireAuth.input(TaskDetailInputSchema).handler(({ context, input }) => {
  const blobs = context.blobs;
  if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  const jobs = requireJobs(context);
  try {
    const user = context.user as UserRow;
    const task = requireWorkbenchTask(context, input.taskId);
    const artifacts = latestArtifactRefs(jobs, user, input.taskId);

    // —— session 行（job 任务无会话）
    let session: { id: string; title: string } | null = null;
    if (task.session_id !== null) {
      const row = context.db
        .prepare('SELECT id, title FROM sessions WHERE id = ?')
        .get(task.session_id) as { id: string; title: string } | undefined;
      if (row !== undefined) session = { id: row.id, title: row.title };
    }

    // —— title 派生（会话标题 → agent params.text 首行 60 字 → null）
    let title: string | null = null;
    if (session !== null && session.title.length > 0) title = session.title;
    if (title === null && task.params !== null) {
      try {
        const parsed = JSON.parse(task.params) as { text?: unknown };
        if (typeof parsed.text === 'string' && parsed.text.trim().length > 0) {
          title = parsed.text.trim().split('\n')[0]!.slice(0, 60);
        }
      } catch {
        // params 非 JSON（job 族等）——title 保持 null
      }
    }

    // —— baseImage（scene-analysis 工件锚：blobRef+像素尺寸+画布声明）
    let baseImage: {
      blobRef: string;
      widthPx: number;
      heightPx: number;
      canvasCm: { w: number; h: number };
    } | null = null;
    const sceneRef = artifacts.get(SCENE_ANALYSIS_ARTIFACT_NAME);
    if (sceneRef !== undefined) {
      const analysis = SceneAnalysisSchema.parse(readArtifactJson(blobs, sceneRef, 'scene-analysis'));
      baseImage = {
        blobRef: analysis.imageBlobRef,
        widthPx: analysis.imagePx.width,
        heightPx: analysis.imagePx.height,
        canvasCm: analysis.canvasCm,
      };
    }

    // —— tree（object-tree 工件——nodes 含 mask inline|blob 二态）
    let tree: { blobRef: string; nodes: ReturnType<typeof loadObjectTreeArtifact>['nodes'] } | null = null;
    const treeRef = artifacts.get(OBJECT_TREE_ARTIFACT_NAME);
    if (treeRef !== undefined) {
      const loaded = loadObjectTreeArtifact(blobs, treeRef);
      tree = { blobRef: treeRef, nodes: loaded.nodes };
    }

    // —— assignments（当前生效=最新 strategy-plan）
    let assignments: StrategyAssignment[] = [];
    const planRef = artifacts.get(STRATEGY_PLAN_ARTIFACT_NAME);
    if (planRef !== undefined) {
      const plan = StrategyPlanSchema.parse(readArtifactJson(blobs, planRef, 'strategy-plan'));
      assignments = plan.assignments;
    }

    // —— gems（strategy-gems 工件摘要）
    let gems: { blobRef: string; count: number; excludedRegions: number } | null = null;
    const gemsRef = artifacts.get(STRATEGY_GEMS_ARTIFACT_NAME);
    if (gemsRef !== undefined) {
      const doc = StrategyGemsDocSchema.parse(readArtifactJson(blobs, gemsRef, 'strategy-gems'));
      gems = { blobRef: gemsRef, count: doc.gems.length, excludedRegions: doc.excludedRegions.length };
    }

    // —— preview（钻点阵预览优先，树叠加预览兜底）
    const previewRef =
      artifacts.get(STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME) ?? artifacts.get(OBJECT_TREE_PREVIEW_ARTIFACT_NAME) ?? null;

    // —— viewState（workbench-pro 波 2a：显隐/折叠/锁定=task 级服务端工件——重载不丢）
    const viewState = loadViewState(blobs, artifacts.get(WORKBENCH_VIEW_STATE_ARTIFACT_NAME) ?? null);
    // —— maskEdits+exportGate（mask 编辑状态面+导出门——incomplete/stale/error 三阻断）
    const maskEdits = maskEditStatusesOf(context.db, input.taskId);
    const exportGate = exportGateOf(maskEdits);

    return {
      task: { id: task.id, title, status: task.status, createdAt: task.created_at },
      session,
      baseImage,
      tree,
      assignments,
      gems,
      preview: previewRef !== null ? { blobRef: previewRef } : null,
      viewState,
      maskEdits,
      exportGate,
    };
  } catch (error) {
    ownedError(error);
  }
});

/** 拆层前置：解析当前 baseImage（scene-analysis 锚）+树工件引用（缺=typed 拒+指引）。 */
function requireTreeContext(
  context: RpcContext,
  jobs: JobService,
  user: UserRow,
  taskId: string,
): { imageBlobRef: string; treeBlobRef: string } {
  const blobs = context.blobs;
  if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  const artifacts = latestArtifactRefs(jobs, user, taskId);
  const treeRef = artifacts.get(OBJECT_TREE_ARTIFACT_NAME);
  if (treeRef === undefined) {
    throw new ORPCError('BAD_REQUEST', {
      message: `任务 ${taskId} 尚无图层树（先经 agent 会话识图/抠图产出 object-tree 工件）`,
    });
  }
  const sceneRef = artifacts.get(SCENE_ANALYSIS_ARTIFACT_NAME);
  if (sceneRef === undefined) {
    throw new ORPCError('BAD_REQUEST', {
      message: `任务 ${taskId} 尚无识图工件（scene-analysis——原图锚缺失，无法细分）`,
    });
  }
  const analysis = SceneAnalysisSchema.parse(readArtifactJson(blobs, sceneRef, 'scene-analysis'));
  return { imageBlobRef: analysis.imageBlobRef, treeBlobRef: treeRef };
}

/** 人类拆层（登录态+owner；segmentOne 原子直调+owner 审计入版本史）。 */
const layerSplit = requireActiveUser
  .input(LayerSplitInputSchema)
  .handler(async ({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const jobs = requireJobs(context);
      requireWorkbenchTask(context, input.taskId);
      const { imageBlobRef, treeBlobRef } = requireTreeContext(context, jobs, user, input.taskId);
      return await workbenchOf(context).segmentOneSplit({
        taskId: input.taskId,
        actorId: user.id,
        imageBlobRef,
        treeBlobRef,
        nodeId: input.nodeId,
        hint: input.hint,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/** 图层改名（直接生效+版本入史）。 */
const layerRename = requireActiveUser
  .input(LayerRenameInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const jobs = requireJobs(context);
      requireWorkbenchTask(context, input.taskId);
      const { imageBlobRef, treeBlobRef } = requireTreeContext(context, jobs, user, input.taskId);
      return workbenchOf(context).renameNode({
        taskId: input.taskId,
        actorId: user.id,
        imageBlobRef,
        treeBlobRef,
        nodeId: input.nodeId,
        objectName: input.objectName,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/** 策略直改（D-1 直接生效：execute 真身重算+引擎校验门照走——跳过授权段）。 */
const layerStrategySet = requireActiveUser
  .input(LayerStrategySetInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const jobs = requireJobs(context);
      requireWorkbenchTask(context, input.taskId);
      const { treeBlobRef } = requireTreeContext(context, jobs, user, input.taskId);
      const planRef = latestArtifactRefs(jobs, user, input.taskId).get(STRATEGY_PLAN_ARTIFACT_NAME) ?? null;
      return workbenchOf(context).setNodeStrategy({
        taskId: input.taskId,
        treeBlobRef,
        planBlobRef: planRef,
        nodeId: input.nodeId,
        strategyKind: input.strategyKind,
        params: input.params,
        ...(input.stoneIdx !== undefined ? { stoneIdx: input.stoneIdx } : {}),
        ...(input.densityPerCm2 !== undefined ? { densityPerCm2: input.densityPerCm2 } : {}),
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/** 版本列表（versions=工作台快照链；currentTreeBlobRef=帧流最新树工件）。 */
const treeHistory = requireAuth.input(TreeHistoryInputSchema).handler(({ context, input }) => {
  const jobs = requireJobs(context);
  try {
    const user = context.user as UserRow;
    requireWorkbenchTask(context, input.taskId);
    const { versions, currentVersion } = workbenchOf(context).treeHistory(input.taskId);
    const currentTreeBlobRef = latestArtifactRefs(jobs, user, input.taskId).get(OBJECT_TREE_ARTIFACT_NAME) ?? null;
    return { versions, currentTreeBlobRef, currentVersion };
  } catch (error) {
    workbenchOwnedError(error);
  }
});

/** 回退（revert=快照帧回放；revert 自身入史）。 */
const treeRevert = requireActiveUser
  .input(TreeRevertInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      requireWorkbenchTask(context, input.taskId);
      return workbenchOf(context).treeRevert({
        taskId: input.taskId,
        actorId: user.id,
        version: input.version,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

// ---------------------------------------------------------------- workbench-pro 波 2a 三写+视图态（契约冻结面）

/**
 * 三写共用前置：电流树/plan/视图态三引用解析（帧流 latest-by-name——CAS 门与锁定
 * 门的输入）+owner 归属。requireTreeContext 已拒缺树任务（BAD_REQUEST+指引）。
 */
function requireWorkbenchWriteContext(
  context: RpcContext,
  user: UserRow,
  taskId: string,
): { imageBlobRef: string; currentTreeBlobRef: string; planBlobRef: string | null; currentViewStateBlobRef: string | null } {
  const jobs = requireJobs(context);
  requireWorkbenchTask(context, taskId);
  const { imageBlobRef, treeBlobRef } = requireTreeContext(context, jobs, user, taskId);
  const artifacts = latestArtifactRefs(jobs, user, taskId);
  return {
    imageBlobRef,
    currentTreeBlobRef: treeBlobRef,
    planBlobRef: artifacts.get(STRATEGY_PLAN_ARTIFACT_NAME) ?? null,
    currentViewStateBlobRef: artifacts.get(WORKBENCH_VIEW_STATE_ARTIFACT_NAME) ?? null,
  };
}

/** 树重排（父变更+序位；CAS 门+环路/根保护/锁定 typed 拒；cause='reorder' 入史）。 */
const layerReorder = requireActiveUser
  .input(LayerReorderInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const refs = requireWorkbenchWriteContext(context, user, input.taskId);
      return workbenchOf(context).layerReorder({
        taskId: input.taskId,
        actorId: user.id,
        imageBlobRef: refs.imageBlobRef,
        currentTreeBlobRef: refs.currentTreeBlobRef,
        currentViewStateBlobRef: refs.currentViewStateBlobRef,
        nodeId: input.nodeId,
        newParentId: input.newParentId,
        index: input.index,
        expectedTreeBlobRef: input.expectedTreeBlobRef,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/** 删子树（assignments 收敛+gems 重算+版本入史；根保护/锁定/CAS 拒）。 */
const layerDelete = requireActiveUser
  .input(LayerDeleteInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const refs = requireWorkbenchWriteContext(context, user, input.taskId);
      return workbenchOf(context).layerDelete({
        taskId: input.taskId,
        actorId: user.id,
        imageBlobRef: refs.imageBlobRef,
        currentTreeBlobRef: refs.currentTreeBlobRef,
        currentViewStateBlobRef: refs.currentViewStateBlobRef,
        planBlobRef: refs.planBlobRef,
        nodeId: input.nodeId,
        expectedTreeBlobRef: input.expectedTreeBlobRef,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/** 遮罩笔刷编辑（mask 重写+effectiveMm/tightBBox 重算+可选指派重算；状态机入痕）。 */
const layerMaskPatch = requireActiveUser
  .input(LayerMaskPatchInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const refs = requireWorkbenchWriteContext(context, user, input.taskId);
      return workbenchOf(context).layerMaskPatch({
        taskId: input.taskId,
        actorId: user.id,
        imageBlobRef: refs.imageBlobRef,
        currentTreeBlobRef: refs.currentTreeBlobRef,
        currentViewStateBlobRef: refs.currentViewStateBlobRef,
        planBlobRef: refs.planBlobRef,
        nodeId: input.nodeId,
        ops: input.ops,
        expectedTreeBlobRef: input.expectedTreeBlobRef,
        recomputeStrategy: input.recomputeStrategy,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/** 视图态全量快照写（显隐/折叠/锁定——task 级工件+revision 单调链；CAS 门）。 */
const viewStateSet = requireActiveUser
  .input(ViewStateSetInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const jobs = requireJobs(context);
      requireWorkbenchTask(context, input.taskId);
      const currentViewStateBlobRef =
        latestArtifactRefs(jobs, user, input.taskId).get(WORKBENCH_VIEW_STATE_ARTIFACT_NAME) ?? null;
      return workbenchOf(context).setViewState({
        taskId: input.taskId,
        actorId: user.id,
        currentViewStateBlobRef,
        nodes: input.nodes,
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      });
    } catch (error) {
      workbenchOwnedError(error);
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
    stop: tasksStop,
    frames: tasksFrames,
    artifact: tasksArtifact,
    result: taskResult,
  },
  stones: {
    tree: stonesTree,
    list: stonesList,
    get: stonesGet,
    trash: stonesTrash,
    restore: stonesRestore,
    importRun: stonesImportRun,
  },
  sets: {
    list: setsList,
    get: setsGet,
    create: setsCreate,
    update: setsUpdate,
    delete: setsDelete,
    createFromBom: setsCreateFromBom,
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
  task: {
    detail: taskDetail,
  },
  layer: {
    split: layerSplit,
    rename: layerRename,
    strategy: {
      set: layerStrategySet,
    },
    reorder: layerReorder,
    delete: layerDelete,
    mask: {
      patch: layerMaskPatch,
    },
  },
  tree: {
    history: treeHistory,
    revert: treeRevert,
  },
  view: {
    state: {
      set: viewStateSet,
    },
  },
};

export type AppRouter = typeof router;
