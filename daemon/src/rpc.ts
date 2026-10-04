/**
 * oRPC-over-WebSocket 路由表（design §2 RPC 行：@orpc/server + 同源 /ws/rpc?token=
 * ——zhumo rpc 模式）。W2.1 首批最小集：bootstrap（HTTP 面迁入）+ assets.upload +
 * tasks.create/get/list/cancel/frames（type=job 接线 tasks 表）。
 * 原始需求 2026-09-23（W2.1）。mock 逃生口=服务注入面：jobs/blobs 未装配时对应端点
 * 501（zhumo context 可选服务模式——测试可注入替身，前端 W3 mock fixture 并行开发）。
 * 正交意图：
 *   [1] context 与守卫中间件（requireAuth——token 经 WS upgrade ?token= 进入 context；
 *       禁用即拒（0.2 收紧）；requireActiveUser=requireAuth 同语义写面挂载点；
 *       requireAdmin——管理 RPC 服务端授权门，1.1）。
 *   [2] bootstrap 读面（密钥仅存在性布尔 + dry-run 旗标；值零出）。
 *   [3] assets.upload（内容寻址输入面——生成/排钻任务的图字节入口）。
 *   [4] tasks 五端点（归属校验 admin 豁免；业务 Error 投影 BAD_REQUEST）。
 *   [5] stones 读面三端点（S3.1——tree/list/get：SQL 索引查询+四态解析；共享读
 *       readScope 标注，评审 D-1；写面归 capability 授权桥，不在本路由）。
 *   [6] sets 六端点（S7.4 工作台硬前置——人工直发写面，design §7.4：admin/human-ui
 *       直调非 agent 授权桥；owner 隔离 D-1——list 过滤/get·update·delete 归属校验
 *       （admin 豁免照 jobs requireOwnedTask）/create ownerId=当前用户；createFromBom
 *       =S7.6 接口位冻结 typed 拒 501；split-admin-portal 4.2：list 增 owner 入参
 *       ——admin 显式查任意用户/缺省全量，普通用户恒自己）。
 *   [7] stones admin 写三端点（S3.3 占位升级；split-admin-portal 4.1 收权）：
 *       trash/restore（S1 递归盖戳服务面直发）+ importRun（S2 runCardImport 人工
 *       直发——操作者即批准人，审计记 owner=当前用户；与 agent 面 proposal 流并存，
 *       两者收敛同一 runCardImport）；写面挂 requireAdmin（装饰钻库=供应链共享真源
 *       ，写面归后台管理面——普通/匿名直调必拒，读面 tree/list/get 保持 requireAuth
 *       共享读）；owner 归属校验留作纵深防御（admin 已豁免恒通）；list 增
 *       resourceIds 组合投影参（S7.5）。
 *   [8] tasks.artifact 工件字节读面（add-subject-sam-pipeline P3.2-channel）：帧流
 *       artifact 帧只带 {name,blobRef}，UI 无 blob 读通道——本端点按任务归属读回
 *       字节。合法引用集=该任务 artifact 帧（name/blobRef 命中）∪ 所属会话附件
 *       blob（session_blob_refs——原图叠加通道）；>8MiB typed 拒（artifact-too-large）。
 *   [9] 任务详情·排钻工作台（add-task-detail-layer-workbench 1.3——design D-1 人类
 *       主权面）：task.detail 组装读面 + layer.split/rename/strategy.set 与
 *       tree.history/revert 直调写面（登录态+owner 归属+操作者入 tree 版本史；
 *       不走 capability 授权桥——Agent 对话场景提案→批准铁律零触碰）。
 *   [10] auth/admin 后台面（split-admin-portal 0.2/1.1/1.2，2026-09-29）：auth.
 *       login/refresh/me（禁用即拒——读写/刷新/新登录全阻，按 DB 当前态复核）+
 *       admin.userList/userCreate/userUpdate/userDelete（__anonymous__ 三禁/不自
 *       禁自降/硬删除级联清理）+ admin.settingsGet/settingsUpdate（白名单两键）；
 *       models 五端点+imageProcessing 两端点收权 requireAdmin（1.3——available
 *       保持活动用户只读）；bootstrap adminConfigured 改 DB 实存 admin 行投影。
 *   [11] 知识库（split-admin-portal 3.3）：admin.kb 八端点（list/saveGroup/
 *       deleteGroup/saveEntry/deleteEntry/revisions/revisionGet/restore）全挂
 *       requireAdmin，actor=admin:<用户名>（KbStore Markdown+git——每次写一
 *       commit）；agent 只读面在 capability studio.kb_list/kb_get。
 *   [12] 素材库（split-admin-portal 4.3——资源后台化）：assetsLib 九端点
 *       （tree/uploadImage/move/rename/softDelete/restore/purgeEmptyTrash/
 *       migrateBatch/migrateVerify）——owner 隔离虚拟文件系统（asset_library 表
 *       +blobs 内容寻址）；读面 requireAuth 本人域（admin 显式 owner 全见）、
 *       写面 requireActiveUser+归属校验（admin 豁免）；IDB 迁移=确定性 id 幂等
 *       上行+清单 hash 核验（核验通过前不删浏览器原数据——Codex 红线）。
 *       附带收权/过滤（4.1/4.2）：stones trash/restore/importRun 收 requireAdmin；
 *       sets.list 增 owner 入参（admin 任意/普通用户恒自己）。
 */
import { ORPCError, os } from '@orpc/server';
import { z } from 'zod';
import { rmSync } from 'node:fs';
import {
  AdminSettingsUpdateInputSchema,
  AdminUserCreateInputSchema,
  AdminUserDeleteInputSchema,
  AdminUserUpdateInputSchema,
  ANONYMOUS_USERNAME,
  ASSETS_LIB_MIGRATE_BATCH_LIMIT,
  AssetsLibMigrateBatchInputSchema,
  AssetsLibMigrateVerifyInputSchema,
  AssetsLibMoveInputSchema,
  AssetsLibPurgeEmptyTrashInputSchema,
  AssetsLibRenameInputSchema,
  AssetsLibRestoreInputSchema,
  AssetsLibSoftDeleteInputSchema,
  AssetsLibTreeInputSchema,
  AssetsLibUploadImageInputSchema,
  AssetsUploadInputSchema,
  CardCatalogDraftSchema,
  IdSchema,
  LoginInputSchema,
  RefreshInputSchema,
  SETTING_SITE_NAME,
  type AdminSettingsOutput,
  type AdminUserView,
  type AssetsLibNode,
  type MeOutput,
  type TokenOutput,
  type UserInfo,
  ImageProcessingSaveInputSchema,
  KbEntryDeleteInputSchema,
  KbEntrySaveInputSchema,
  KbGroupDeleteInputSchema,
  KbGroupSaveInputSchema,
  KbRestoreInputSchema,
  KbRevisionGetInputSchema,
  LayerDeleteInputSchema,
  LayerMaskPatchInputSchema,
  LayerReorderInputSchema,
  LayerRenameInputSchema,
  LayerSplitInputSchema,
  LayerStrategySetInputSchema,
  MaskEditDiscardInputSchema,
  MaskEditRetryInputSchema,
  ModelCatalogOutputSchema,
  ModelsAvailableOutputSchema,
  ModelsConfigOutputSchema,
  ModelsSaveInputSchema,
  ModelsTestInputSchema,
  ModelsTestOutputSchema,
  type ModelCatalogOutput,
  type ModelsAvailableOutput,
  type ModelsConfigOutput,
  type ModelsTestOutput,
  type ImageProcessingGetOutput,
  ProductionSetMemberSchema,
  ProductionSetOriginSchema,
  ResourcesExportInputSchema,
  ResourcesImportInputSchema,
  SceneAnalysisSchema,
  SessionAnswerInputSchema,
  SessionCancelInputSchema,
  SessionClearInputSchema,
  SessionCreateInputSchema,
  SessionAutoApproveInputSchema,
  SessionFollowupInputSchema,
  SessionGetInputSchema,
  SessionListInputSchema,
  SessionRenameInputSchema,
  SessionReplayInputSchema,
  SessionRetryInputSchema,
  SessionResultInputSchema,
  StrategyPlanSchema,
  type StrategyAssignment,
  type StoneCandidateRow,
  TASK_ARTIFACT_MAX_BYTES,
  TaskArtifactInputSchema,
  TaskCancelInputSchema,
  TaskCreateInputSchema,
  TaskDetailInputSchema,
  TaskExportInputSchema,
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
import {
  createUser,
  deleteUserRow,
  getSetting,
  getUserByUsername,
  hasAdminUser,
  listUsers,
  putSetting,
  updateUserCredentials,
  type UserRow,
} from './db/store.js';
import {
  authenticate,
  hashPassword,
  isAllowAnonymous,
  setAllowAnonymous,
  signJwt,
  verifyPassword,
} from './auth.js';
import type { AppConfig } from './config.js';
import { isImgConfigured, isLlmConfigured } from './config.js';
import { DAEMON_VERSION } from './http.js';
import type { BlobStore } from './db/blobs.js';
import { hashOfContent, hasBlobUpload, recordBlobUpload } from './db/blobs.js';
import { getTaskById } from './db/jobs.js';
import { listSessionBlobRefs, requireOwnedSession } from './db/sessions.js';
import { sessionImageSet } from './capability/task-images.js';
import { extensionOfMime, probeImageSize, sniffImageMime } from './image-sniff.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
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

  projectStonePalette,
} from './kernel/strategies/design.js';
import { SCENE_ANALYSIS_ARTIFACT_NAME } from './kernel/vision/scene-analyze.js';
import {
  OBJECT_TREE_ARTIFACT_NAME,
  OBJECT_TREE_PREVIEW_ARTIFACT_NAME,
} from './kernel/vision/segment-one.js';
import { loadObjectTreeArtifact } from './kernel/vision/tree-persist.js';
import { effectiveGems } from './kernel/effective-gems.js';
import { projectStonesSummaryOf } from './kernel/project-manifest.js';
import {
  lintSummaryForTaskDetail,
  STONES_LINT_ARTIFACT_NAME,
} from './kernel/project-lint.js';
import type { TaskDetailProjectStones } from '@handicraft/contracts';
import {
  buildRoutesBundle,
  loadKeys,
  loadModelsConfig,
  modelsRouteInfo,
  saveModelsConfig,
} from './models-store.js';
import { imageProcessingEffective, loadImageProcessing, saveImageProcessing } from './image-processing-store.js';
import { modelCatalog, refreshModelsDevCache } from './models-catalog.js';
import { testRouteConnection } from './test-route-connection.js';
import { syncModelRoutesBridge } from './kernel/model-route.js';
import { KbStore } from './kb/store.js';
import { AssetsLibraryError, AssetsLibraryService, type AssetLibraryRow } from './assets-library/service.js';

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
  /** 知识库存储（未注入时按 config.dataRoot/knowledge 共享实例兜底——split-admin-portal 3.3）。 */
  kb?: KbStore;
}

const base = os.$context<RpcContext>();

/**
 * 认证守卫（split-admin-portal 0.2 禁用语义收紧，2026-09-29 Codex 裁定）：禁用=
 * 阻断后续读写（取代旧「禁写不禁读」）——每次 RPC 按 DB 当前 disabled 复核
 * （authenticate 每次查行，不信 JWT 快照）；匿名角色不受影响（disabled 恒 0，
 * 其开关走 allow_anonymous 设置面）。
 */
const requireAuth = base.use(async ({ context, next }) => {
  const user =
    context.user ?? (await authenticate(context.secret, context.db, context.token, context.config.allowAnonymous));
  if (!user) throw new ORPCError('UNAUTHORIZED', { message: '需要登录' });
  if (user.disabled !== 0) {
    throw new ORPCError('FORBIDDEN', { message: '账号已被禁用（禁用即拒——读写与刷新全阻）' });
  }
  return next({ context: { ...context, user } });
});

/**
 * 管理守卫（split-admin-portal 1.1——zhumo rpc.ts:181-186 同构）：requireAuth
 * 之后按 DB 行 role 复核 admin。客户端路由守卫不替代授权——全部管理 RPC 必挂本守卫。
 */
const requireAdmin = requireAuth.use(async ({ context, next }) => {
  if (context.user?.role !== 'admin') {
    throw new ORPCError('FORBIDDEN', { message: '需要管理员权限' });
  }
  return next();
});

/**
 * 写面守卫（0.2 收紧后与 requireAuth 同语义：认证+非禁用；保留独立挂载点以维持
 * 写面语义标注——禁用即拒，读写面统一收口）。绑定面：assets.upload / tasks.create /
 * tasks.cancel / resources.import / session 写族 / stones·sets 写面 / layer·tree 写面。
 */
const requireActiveUser = requireAuth;

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
    // split-admin-portal 1.3：有 admin 用户行即可登录后台（提示位从 .env ADMIN_*
    // 配置态改为 DB 实存态——bootstrap 引导登录页的最小改投影）。
    adminConfigured: hasAdminUser(db),
    imgConfigured: isImgConfigured(config.img),
    llmConfigured: isLlmConfigured(config.llm),
    imgDryRun: config.imgDryRun,
    /** 生效模型路由（zhumo 方案移植块 A——settings/env 来源透明度投影；null=未配置）。 */
    modelRoute: modelsRouteInfo(db, config.llm),
  };
});

// ---------------------------------------------------------------- auth / admin（split-admin-portal 1.1/1.2——zhumo 管理模型适配）

/** 脱敏用户视图（contracts UserInfo——username 即键，id/口令零出）。 */
function toUserInfo(user: UserRow): UserInfo {
  return { username: user.username, role: user.role };
}

/** 签发面单点：JWT {sub, role} → TokenOutput（camelCase expiresAt——契约冻结）。 */
async function issueToken(secret: string, user: UserRow): Promise<TokenOutput> {
  const { token, expiresAt } = await signJwt(secret, { sub: user.id, role: user.role });
  return { token, expiresAt, user: toUserInfo(user) };
}

/** 后台用户行视图（role 两值——调用方须先排除/拒绝 __anonymous__）。 */
function toAdminUserView(user: UserRow): AdminUserView {
  return {
    username: user.username,
    role: user.role === 'admin' ? 'admin' : 'user',
    disabled: user.disabled === 1,
    createdAt: user.created_at,
  };
}

const authLogin = base.input(LoginInputSchema).handler(async ({ context, input }) => {
  if (input.username === ANONYMOUS_USERNAME) {
    throw new ORPCError('FORBIDDEN', { message: '内置匿名账号不可直接登录' });
  }
  const user = getUserByUsername(context.db, input.username);
  if (!user || !verifyPassword(input.password, user.password_hash)) {
    throw new ORPCError('UNAUTHORIZED', { message: '用户名或密码错误' });
  }
  // 0.2 禁用语义收紧：禁用拒新登录（不发 token——后续读写/刷新由守卫按 DB 全阻）。
  if (user.disabled !== 0) {
    throw new ORPCError('FORBIDDEN', { message: '账号已被禁用，无法登录' });
  }
  return issueToken(context.secret, user);
});

/** token 换新（按 DB 当前状态复核——禁用/删号拒，不信签发时快照）。 */
const authRefresh = base
  .input(RefreshInputSchema)
  .handler(async ({ context, input }) => {
    const token = input?.token ?? context.token;
    const user = await authenticate(context.secret, context.db, token, context.config.allowAnonymous);
    if (!user) throw new ORPCError('UNAUTHORIZED', { message: '凭证无效或已过期' });
    if (user.disabled !== 0) {
      throw new ORPCError('FORBIDDEN', { message: '账号已被禁用，无法刷新凭证' });
    }
    return issueToken(context.secret, user);
  });

/** 当前 token 用户信息（requireAuth 已含禁用即拒——禁用用户 me 不可达）。 */
const authMe = requireAuth.handler(({ context }): MeOutput => toUserInfo(context.user as UserRow));

const adminUserList = requireAdmin.handler(({ context }) => {
  // __anonymous__ 不入列表（AdminUserView role 两值无法表达；匿名开合走 settings 面）。
  const users = listUsers(context.db)
    .filter((row) => row.role !== 'anonymous')
    .map(toAdminUserView);
  return { users };
});

const adminUserCreate = requireAdmin
  .input(AdminUserCreateInputSchema)
  .handler(({ context, input }) => {
    if (input.username === ANONYMOUS_USERNAME) {
      throw new ORPCError('CONFLICT', {
        message: '保留用户名不可用于建号（__anonymous__ 由匿名开关管理）',
      });
    }
    if (getUserByUsername(context.db, input.username)) {
      throw new ORPCError('CONFLICT', { message: `用户名已存在：${input.username}` });
    }
    const user = createUser(context.db, {
      username: input.username,
      passwordHash: hashPassword(input.password),
      role: input.role,
    });
    return toAdminUserView(user);
  });

/**
 * 更新（键=username）：__anonymous__ 三禁（改密/禁用/改角色——契约 schema 已保证
 * 至少一字段，三禁逐字段全拒）；不能禁用或降级当前登录的管理员自己（防自锁）。
 */
const adminUserUpdate = requireAdmin
  .input(AdminUserUpdateInputSchema)
  .handler(({ context, input }) => {
    const target = getUserByUsername(context.db, input.username);
    if (!target) throw new ORPCError('NOT_FOUND', { message: `用户不存在：${input.username}` });
    if (target.username === ANONYMOUS_USERNAME) {
      if (input.password !== undefined) {
        throw new ORPCError('CONFLICT', { message: '内置匿名账号不可改密' });
      }
      if (input.disabled !== undefined) {
        throw new ORPCError('CONFLICT', {
          message: '内置匿名账号不可禁用（匿名访问开关走 allowAnonymous 设置）',
        });
      }
      if (input.role !== undefined) {
        throw new ORPCError('CONFLICT', { message: '内置匿名账号不可改角色' });
      }
    }
    const demotesSelf =
      target.id === context.user?.id &&
      (input.disabled === true || (input.role !== undefined && input.role !== 'admin'));
    if (demotesSelf) {
      throw new ORPCError('CONFLICT', { message: '不能禁用或降级当前登录的管理员自己' });
    }
    updateUserCredentials(context.db, target.id, {
      ...(input.password !== undefined ? { passwordHash: hashPassword(input.password) } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.disabled !== undefined ? { disabled: input.disabled } : {}),
    });
    const updated = getUserByUsername(context.db, target.username);
    if (!updated) {
      throw new ORPCError('INTERNAL_SERVER_ERROR', { message: '更新后用户行缺失（存储异常）' });
    }
    return toAdminUserView(updated);
  });

/**
 * 硬删除=级联清理（split-admin-portal 0.2 域清单——贴钻表结构梳理，zhumo
 * adminUserDelete 同款语义适配）：tasks↔results 循环外键先解空（含跨归属引用）
 * → 任务域衍生（tree_versions/mask_edit_states）→ 授权域（attempts→approved_ops/
 * grants/patch_history）→ 引用账本（session_blob_refs/result_blob_refs）→ outbox
 * （该用户会话/分享包待删条目——文件由本端点直接移除；blob 归零行物理回收由
 * recover/maintenance 的 deletingRowsOutboxEntries 补单收敛）→ 行主域（stone_index
 * 投影→tasks→results→resources→sessions）→ users 行。事务外：blob 引用计数逐事件
 * 递减（releaseRef——resources/session/results/asset_library/blob_uploads 五域清单，
 * P1-1：上传归属账本逐行释放、与素材域独立守恒）+ 磁盘任务目录/result bundle 目录
 * 整删（贴钻无 per-user 目录——DATA_ROOT/tasks/<id> 与 results/<publicId> 即用户数据
 * 落点）。__anonymous__ 与当前登录管理员自己不可删。
 */
const adminUserDelete = requireAdmin
  .input(AdminUserDeleteInputSchema)
  .handler(({ context, input }) => {
    const blobs = context.blobs;
    if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
    const target = getUserByUsername(context.db, input.username);
    if (!target) throw new ORPCError('NOT_FOUND', { message: `用户不存在：${input.username}` });
    if (target.username === ANONYMOUS_USERNAME) {
      throw new ORPCError('CONFLICT', { message: '内置匿名账号不可删除' });
    }
    if (target.id === context.user?.id) {
      throw new ORPCError('CONFLICT', { message: '不能删除当前登录的管理员自己' });
    }
    const db = context.db;
    // —— 磁盘目标先收集（行删后不可再查）
    const taskIds = db.prepare('SELECT id FROM tasks WHERE owner_id = ?').all(target.id) as {
      id: string;
    }[];
    const bundlePaths = db
      .prepare('SELECT bundle_path FROM results WHERE owner_id = ?')
      .all(target.id) as { bundle_path: string }[];
    // —— blob 引用释放清单（一行=一次引用事件，逐行释放才计得准——zhumo 同款）
    const resourceHashes = db
      .prepare('SELECT content_hash AS hash FROM resources WHERE owner_id = ? AND content_hash IS NOT NULL')
      .all(target.id) as { hash: string }[];
    const sessionRefHashes = db
      .prepare(
        'SELECT blob_hash AS hash FROM session_blob_refs WHERE session_id IN (SELECT id FROM sessions WHERE owner_id = ?)',
      )
      .all(target.id) as { hash: string }[];
    const resultRefHashes = db
      .prepare(
        'SELECT blob_hash AS hash FROM result_blob_refs WHERE result_id IN (SELECT id FROM results WHERE owner_id = ?)',
      )
      .all(target.id) as { hash: string }[];
    // split-admin-portal 4.3：素材库域引用（asset_library 图片行——逐行对冲 put 计数）。
    const assetHashes = db
      .prepare('SELECT blob_hash AS hash FROM asset_library WHERE owner_id = ? AND blob_hash IS NOT NULL')
      .all(target.id) as { hash: string }[];
    // P1-1（2026-09-29 复核）：上传归属域引用（blob_uploads 归属行——一行=一引用，
    // 与 assets.upload 幂等入账一一对应；与素材域各自释放、独立计数守恒）。
    const uploadHashes = db
      .prepare('SELECT blob_hash AS hash FROM blob_uploads WHERE user_id = ?')
      .all(target.id) as { hash: string }[];

    const purge = db.transaction(() => {
      // 1) 循环外键解空（含跨归属引用——results.task_id→tasks / tasks.result_id→results）
      db.prepare(
        'UPDATE tasks SET result_id = NULL WHERE owner_id = ? OR result_id IN (SELECT id FROM results WHERE owner_id = ?)',
      ).run(target.id, target.id);
      db.prepare(
        'UPDATE results SET task_id = NULL WHERE owner_id = ? OR task_id IN (SELECT id FROM tasks WHERE owner_id = ?)',
      ).run(target.id, target.id);
      // 2) 任务域衍生（无 FK——按 task_id 逻辑归属）
      db.prepare(
        'DELETE FROM tree_versions WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)',
      ).run(target.id);
      db.prepare(
        'DELETE FROM mask_edit_states WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)',
      ).run(target.id);
      // 3) 授权域（attempts 按 proposal 逻辑归属先于 approved_ops）
      db.prepare(
        'DELETE FROM attempts WHERE proposal_id IN (SELECT proposal_id FROM approved_ops WHERE user_id = ?)',
      ).run(target.id);
      db.prepare('DELETE FROM approved_ops WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM grants WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM patch_history WHERE owner_id = ?').run(target.id);
      // 4) 引用账本 + outbox（先于所属 sessions/results 行）
      db.prepare(
        'DELETE FROM session_blob_refs WHERE session_id IN (SELECT id FROM sessions WHERE owner_id = ?)',
      ).run(target.id);
      db.prepare(
        'DELETE FROM result_blob_refs WHERE result_id IN (SELECT id FROM results WHERE owner_id = ?)',
      ).run(target.id);
      db.prepare(
        'DELETE FROM cleanup_outbox WHERE session_id IN (SELECT id FROM sessions WHERE owner_id = ?)',
      ).run(target.id);
      db.prepare(
        'DELETE FROM cleanup_outbox WHERE result_id IN (SELECT id FROM results WHERE owner_id = ?)',
      ).run(target.id);
      // 5) 行主域（FK 引用方向反序）：stone_index 投影 → tasks → results → resources → sessions → users
      db.prepare(
        'DELETE FROM stone_index WHERE resource_id IN (SELECT id FROM resources WHERE owner_id = ?)',
      ).run(target.id);
      db.prepare('DELETE FROM tasks WHERE owner_id = ?').run(target.id);
      db.prepare('DELETE FROM results WHERE owner_id = ?').run(target.id);
      db.prepare('DELETE FROM resources WHERE owner_id = ?').run(target.id);
      // split-admin-portal 4.3：素材库域行+该用户上传归属账本（asset_library→
      // blob_uploads——素材行随用户清理，归属账本同清防孤儿行）。
      db.prepare('DELETE FROM asset_library WHERE owner_id = ?').run(target.id);
      db.prepare('DELETE FROM blob_uploads WHERE user_id = ?').run(target.id);
      db.prepare('DELETE FROM sessions WHERE owner_id = ?').run(target.id);
      deleteUserRow(db, target.id);
    });
    purge();
    // —— 事务外收尾：blob 引用计数递减（归零置 deleting——物理文件由维护例程回收）
    for (const row of [
      ...resourceHashes,
      ...sessionRefHashes,
      ...resultRefHashes,
      ...assetHashes,
      ...uploadHashes,
    ]) {
      blobs.releaseRef(row.hash);
    }
    // —— 磁盘：任务目录 + result bundle 目录
    for (const task of taskIds) {
      rmSync(path.join(context.config.dataRoot, 'tasks', task.id), { recursive: true, force: true });
    }
    for (const result of bundlePaths) {
      rmSync(result.bundle_path, { recursive: true, force: true });
    }
    return { ok: true as const };
  });

/**
 * 设置读面（白名单两键）：allowAnonymous=双层真源生效值（settings 键优先，
 * .env 兜底——0.1 起缺省关）；siteName=settings 新键（未设置时省略字段——波 5
 * P1-1：空串出门会让读面守门（min(1) 语义）拒整包，新实例后台整体不可用）。
 */
const adminSettingsGet = requireAdmin.handler(({ context }): AdminSettingsOutput => {
  return {
    allowAnonymous: isAllowAnonymous(context.db, context.config.allowAnonymous),
    ...siteNameSetting(context.db),
  };
});

/** 设置写面（白名单两键——allow_anonymous 既有键 '1'/'0' + site_name 新键）。 */
const adminSettingsUpdate = requireAdmin
  .input(AdminSettingsUpdateInputSchema)
  .handler(({ context, input }): AdminSettingsOutput => {
    if (input.allowAnonymous !== undefined) {
      setAllowAnonymous(context.db, input.allowAnonymous);
    }
    if (input.siteName !== undefined) {
      putSetting(context.db, SETTING_SITE_NAME, input.siteName);
    }
    return {
      allowAnonymous: isAllowAnonymous(context.db, context.config.allowAnonymous),
      ...siteNameSetting(context.db),
    };
  });

/** siteName 出面投影（未设置/空串=字段缺席——与 AdminSettingsOutputSchema 可选语义对齐）。 */
function siteNameSetting(db: SqliteDb): { siteName?: string } {
  const value = getSetting(db, SETTING_SITE_NAME);
  return value !== null && value.length > 0 ? { siteName: value } : {};
}

// ---------------------------------------------------------------- 知识库（split-admin-portal 3.3——zhumo adminKb* 复刻）

/**
 * 知识库八端点（design §4）：list/saveGroup/deleteGroup/saveEntry/deleteEntry/
 * revisions/revisionGet/restore——全部 requireAdmin，写操作 actor=admin:<用户名>
 * （KbStore 每次 git commit 记 author）。业务错误（分组/条目不存在等）→
 * BAD_REQUEST（ORPCError 透传）；agent 只读面在 capability（studio.kb_list/kb_get）。
 */
function kbOf(context: RpcContext): KbStore {
  // 测试可注入实例；生产经 sharedFor 记忆化——boot 种子与 RPC 写共享单互斥链。
  return context.kb ?? KbStore.sharedFor(path.join(context.config.dataRoot, 'knowledge'));
}

/** 业务错误 → BAD_REQUEST；ORPCError 透传。 */
function kbException(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  throw new ORPCError('BAD_REQUEST', {
    message: error instanceof Error ? error.message : String(error),
  });
}

const adminKbList = requireAdmin.handler(({ context }) => {
  return { groups: kbOf(context).listAll() };
});

const adminKbSaveGroup = requireAdmin
  .input(KbGroupSaveInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await kbOf(context).upsertGroup(input, `admin:${context.user?.username ?? '?'}`);
      return { groups: kbOf(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbDeleteGroup = requireAdmin
  .input(KbGroupDeleteInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await kbOf(context).deleteGroup(input.name, `admin:${context.user?.username ?? '?'}`);
      return { groups: kbOf(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbSaveEntry = requireAdmin
  .input(KbEntrySaveInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await kbOf(context).upsertEntry(input, `admin:${context.user?.username ?? '?'}`);
      return { groups: kbOf(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbDeleteEntry = requireAdmin
  .input(KbEntryDeleteInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await kbOf(context).deleteEntry(input.group, input.key, `admin:${context.user?.username ?? '?'}`);
      return { groups: kbOf(context).listAll() };
    } catch (error) {
      kbException(error);
    }
  });

const adminKbRevisions = requireAdmin.handler(async ({ context }) => {
  return kbOf(context).revisions();
});

const adminKbRevisionGet = requireAdmin
  .input(KbRevisionGetInputSchema)
  .handler(async ({ context, input }) => {
    try {
      return await kbOf(context).revisionDetail(input.id);
    } catch (error) {
      kbException(error);
    }
  });

const adminKbRestore = requireAdmin
  .input(KbRestoreInputSchema)
  .handler(async ({ context, input }) => {
    try {
      await kbOf(context).restore(input.id, `admin:${context.user?.username ?? '?'}`);
      return { ok: true as const };
    } catch (error) {
      kbException(error);
    }
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
    const userId = (context.user as UserRow).id;
    // P1-1 幂等上传（2026-09-29 复核裁定——「(hash,user) 唯一行=该用户对该内容恰好
    // 一个引用」）：归属行在场→跳过 put（归属行隐含 blob active——首计已入账），
    // 同用户重复上传=零计数变化；不在场→put+插归属行（单线程同步无插队窗口）。
    // W3 评审 P1-3 勘定仍适用：上传是**无会话归属**的原始字节获取（不写
    // session_blob_refs 账本）——结构性不可能复活 cleared 会话的引用；W4 followup
    // 附件面走 acquireSessionBlobRef（session CAS 同事务）。
    const hash = hashOfContent(data);
    if (hasBlobUpload(context.db, hash, userId)) {
      return { blobRef: hash, filename: input.filename, size: data.byteLength };
    }
    const put = blobs.put(data);
    // split-admin-portal 2.2：上传归属账本（blob_uploads——followup 附件 owner 校验
    // 与 raw 预览面归属校验的共用真源；内容寻址去重下重复上传幂等）。
    recordBlobUpload(context.db, put.hash, userId);
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

    // [2.5] 电流树掩膜引用面（rework-layer-ps-panel 2026-09-28——缩略图白图根因修复）：
    //     真识图树的 mask 多为 blob 态（tree-persist >4096 字节转 blob），掩膜 blob 既
    //     不在 artifact 帧流也不是会话附件——图层行缩略/画布抠图合成按 blobRef 直取时
    //     读回**电流树工件**（帧流 latest object-tree.json）校验掩膜引用归属：任务已验
    //     owner，树内掩膜随树同域不越权。树缺席/损坏/无命中=不放大读面（走默认拒）。
    if (blobRef === null && input.blobRef !== undefined) {
      const treeRef = latestArtifactRefs(jobs, user, input.taskId).get(OBJECT_TREE_ARTIFACT_NAME);
      if (treeRef !== undefined) {
        try {
          const tree = loadObjectTreeArtifact(blobs, treeRef);
          if (tree.nodes.some((node) => node.mask.kind === 'blob' && node.mask.blobRef === input.blobRef)) {
            blobRef = input.blobRef;
          }
        } catch {
          // 树工件缺 blob/损坏——掩膜面不命中（维持严格引用集语义）
        }
      }
    }

    if (blobRef === null) {
      throw new ORPCError('NOT_FOUND', {
        message:
          input.name !== undefined
            ? `任务 ${input.taskId} 帧流内无名为「${input.name}」的 artifact 帧`
            : `blobRef 不属于任务 ${input.taskId} 的工件引用集（artifact 帧 ∪ 会话附件 ∪ 电流树掩膜）`,
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
    return requireSessions(context).create(context.user as UserRow, {
      title: input.title,
      ...(input.titlePinned !== undefined ? { titlePinned: input.titlePinned } : {}),
    });
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
      ...(input.sourceSetId !== undefined ? { sourceSetId: input.sourceSetId } : {}),
      // [product-polish-w1 T2] 自动批准开关透传（契约字段→kernel 域——与 sourceSetId
      // 同式的最小中继；持久化与单点生效都在 kernel/authorization）。
      ...(input.autoApprove !== undefined ? { autoApprove: input.autoApprove } : {}),
      // [product-polish-w2] 任务级模型/强度覆盖透传（最小中继——校验/锁定在 kernel
      // followup 前置段）。
      ...(input.model !== undefined ? { model: input.model } : {}),
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

/**
 * [真链复验 P1-G，2026-10-01] 会话改名（owner 本人域——service.rename 内
 * requireOwnedSession；clearing/cleared 拒）。回显改后标题（客户端就地更新）。
 */
const sessionRename = requireActiveUser.input(SessionRenameInputSchema).handler(({ context, input }) => {
  try {
    return requireSessions(context).rename(context.user as UserRow, input.sessionId, input.title);
  } catch (error) {
    ownedError(error);
  }
});

/**
 * [prod-run-8317 复盘，2026-10-03] 自动批准开关即时落库（owner 本人域——service
 * .setAutoApprove 内 requireOwnedSession；clearing/cleared 拒）。回显生效值。
 */
const sessionSetAutoApprove = requireActiveUser
  .input(SessionAutoApproveInputSchema)
  .handler(({ context, input }) => {
    try {
      return requireSessions(context).setAutoApprove(
        context.user as UserRow,
        input.sessionId,
        input.autoApprove,
      );
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

// ---------------------------------------------------------------- session 归档读面（product-polish-w1 归档环）

/**
 * 「我的材料 → 我的任务」行展开的导出三件套读面（product-polish-w1 T1——故事：
 * 「导出产物…都在我的材料里…随时回看」+N3 任务历史回放）。既有 MCP 读面
 * studio.task.exports.list（capability/task-export.ts B3.5）以 taskId 入参服务 agent，
 * 未在 RPC 面暴露——本端点=同查询的会话锚本人域版本（tasks.result 单列只留最后
 * 一组 bundle，per-image 历史只有本面可见）。返回行含 imageId/sourceTaskId/
 * publicId/download（/r/{publicId}/files/{kind} 下载面同源），前端按 imageId 取
 * 每图最新一组呈现。
 */
const SessionExportsInputSchema = z.object({ sessionId: IdSchema }).strict();
const SESSION_EXPORTS_LIMIT = 50; // 与 capability exports.list 的 MAX_EXPORT_HISTORY 同界

interface SessionExportView {
  resultId: string;
  publicId: string;
  exportedByTaskId: string;
  imageId: string;
  sourceTaskId: string;
  createdAt: string;
  expiresAt: string | null;
  download: string;
}

const sessionExports = requireAuth.input(SessionExportsInputSchema).handler(({ context, input }) => {
  try {
    const user = context.user as UserRow;
    const session = requireOwnedSession(context.db, user, input.sessionId);
    const rows = context.db
      .prepare(
        `SELECT r.id, r.public_id, r.task_id, r.bundle_path, r.created_at, r.expires_at
         FROM results r JOIN tasks t ON r.task_id = t.id
         WHERE t.session_id = ? AND r.owner_id = ? AND r.revoked_at IS NULL
         ORDER BY r.created_at DESC LIMIT ?`,
      )
      .all(session.id, user.id, SESSION_EXPORTS_LIMIT) as Array<{
      id: string;
      public_id: string;
      task_id: string;
      bundle_path: string;
      created_at: string;
      expires_at: string | null;
    }>;
    const exports: SessionExportView[] = [];
    for (const row of rows) {
      // 与 capability exports.list 同款 manifest 审计面过滤：非任务导出 result
      // （studio.export 独立 layout 面）无 source 审计字段——跳过；bundle 目录缺失/
      // 损坏=不可下载面，不进清单。
      let manifest: { source?: { sourceTaskId: string; imageId: string } };
      try {
        manifest = JSON.parse(readFileSync(path.join(row.bundle_path, 'bundle.json'), 'utf8'));
      } catch {
        continue;
      }
      if (manifest.source === undefined) continue;
      // 过期未清扫行同样缺席（isResultShareable 同语义——/r/ 下载面 404，清单不
      // 出现点不开的链接；撤销行已被 SQL 过滤）。
      if (row.expires_at !== null && row.expires_at <= new Date().toISOString()) continue;
      exports.push({
        resultId: row.id,
        publicId: row.public_id,
        exportedByTaskId: row.task_id,
        imageId: manifest.source.imageId,
        sourceTaskId: manifest.source.sourceTaskId,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        download: `/r/${row.public_id}`,
      });
    }
    return { sessionId: session.id, exports };
  } catch (error) {
    ownedError(error);
  }
});

/**
 * 「我的材料 → 我的文件 → 会话图片」虚拟目录读面（product-polish-w1 T2——故事：
 * 「上传的图…都在我的材料里」）。数据真源=会话主图集审计（tasks.params 的
 * attachments+imageIds——capability/task-images.ts sessionImageSet 同源，A5 冻结
 * 分配面）：不搬数据进 asset_library，本人域投影按会话分组；每图附魔数嗅探与
 * 尺寸声明（task-images.list 同款）。缩略走既有 /api/assets/{ref}/raw 面
 * （userOwnsBlobRef 归属校验含本人会话引用——无需新授权）。非主图集的会话
 * （纯文本/讨论插图）无分组；cleared 会话缺席。
 */
const SESSION_IMAGES_SESSIONS_LIMIT = 30; // 最近会话上界（虚拟目录回看面有界）

const sessionImages = requireAuth.handler(({ context }) => {
  const user = context.user as UserRow;
  const sessions = context.db
    .prepare(
      `SELECT id, title, updated_at FROM sessions
       WHERE owner_id = ? AND status != 'cleared' ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(user.id, SESSION_IMAGES_SESSIONS_LIMIT) as Array<{ id: string; title: string; updated_at: string }>;
  const groups: Array<{
    sessionId: string;
    title: string;
    updatedAt: string;
    images: Array<{ blobRef: string; name: string; mime: string | null; width: number | null; height: number | null }>;
  }> = [];
  for (const session of sessions) {
    const imageSet = sessionImageSet(context.db, session.id);
    if (imageSet === null) continue;
    const images = imageSet.attachments.map((blobRef) => {
      const bytes = context.blobs?.read(blobRef) ?? null;
      if (bytes === null) {
        return { blobRef, name: `attachment-${blobRef.slice(0, 12)}.bin`, mime: null, width: null, height: null };
      }
      const mime = sniffImageMime(bytes);
      const size = mime === null ? null : probeImageSize(bytes, mime);
      return {
        blobRef,
        name: `attachment-${blobRef.slice(0, 12)}.${mime === null ? 'bin' : extensionOfMime(mime)}`,
        mime,
        width: size?.width ?? null,
        height: size?.height ?? null,
      };
    });
    groups.push({ sessionId: session.id, title: session.title, updatedAt: session.updated_at, images });
  }
  return { groups };
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
 * 装饰钻库人工直发写面（design §4.2 管理视图收尾；split-admin-portal 4.1 收权
 * requireAdmin——资源后台化裁定）：软删/恢复走 S1 递归盖戳服务函数；importRun 走
 * S2 runCardImport。**不走 capability 授权桥**——人工直发=操作者即批准人（照 sets
 * 六端点 §7.4 裁定；agent/MCP 面 proposal 流并存，两者最终收敛到同一 service/
 * importer）。requireAdmin 后 requireOwnedResource 的 admin 豁免恒通——保留调用作
 * 纵深防御（写面语义标注不丢）；读面 tree/list/get 保持 requireAuth 共享读。
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

const stonesTrash = requireAdmin.input(StonesTrashInputSchema).handler(({ context, input }) => {
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

const stonesRestore = requireAdmin.input(StonesRestoreInputSchema).handler(({ context, input }) => {
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
const stonesImportRun = requireAdmin.input(StonesImportRunInputSchema).handler(({ context, input }) => {
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
  owner: z
    .string()
    .min(1)
    .optional()
    .describe('按归属者过滤（username——split-admin-portal 4.2：admin 可显式查任意用户；普通用户仅自己，传他人 FORBIDDEN；缺省=admin 全量/普通用户=自己。与 scope 互斥）'),
  scope: z
    .enum(['owner', 'market'])
    .optional()
    .describe('归属域（product-polish-w1 T1/T3，与 owner 互斥）：owner=当前用户本人组合（admin 同样收窄——「我的组合」组）；market=管理员所建市场组合（「材料市场组合」组——普通用户只读快照，引用/编辑先经 sets.copyFromMarket 复制为本人副本）'),
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

/** 市场组合复制入参（product-polish-w1 T1——源 owner=admin 白名单门在服务层）。 */
const SetsCopyFromMarketInputSchema = z.object({
  resourceId: IdSchema.describe('源市场组合目录行 resourceId（owner=admin——非管理员源 typed owner-mismatch 拒）'),
  name: z.string().min(1).optional().describe('副本名（缺省=源名；同父冲突自动 ` (2)`）'),
});

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
    // owner 过滤解析（split-admin-portal 4.2——后台组合/套装库管理面）：admin 显式
    // 传 owner=按该 username 过滤（未知用户 NOT_FOUND）；普通用户恒=自己（显式传
    // 他人 FORBIDDEN——D-1 owner 隔离不放松）；admin 缺省=全量（后台管理面语义）。
    // scope（product-polish-w1 T1/T3）与 owner 互斥：owner=恒本人（admin 同样收窄
    // ——「我的组合」组）；market=管理员所建组合（ownerIds 投影——普通用户可见
    // 的只读市场面，引用先 copyFromMarket）。
    const user = context.user as UserRow;
    let ownerId: string | undefined;
    let ownerIds: string[] | undefined;
    if (input.scope !== undefined) {
      if (input.owner !== undefined) {
        throw new ORPCError('BAD_REQUEST', { message: 'scope 与 owner 互斥（归属域二选一——scope=owner/market，owner=username）' });
      }
      if (input.scope === 'owner') {
        ownerId = user.id;
      } else {
        ownerIds = (
          context.db.prepare("SELECT id FROM users WHERE role = 'admin' AND disabled = 0").all() as Array<{
            id: string;
          }>
        ).map((row) => row.id);
      }
    } else if (input.owner !== undefined) {
      const target = getUserByUsername(context.db, input.owner);
      if (target === null) {
        throw new ORPCError('NOT_FOUND', { message: `用户不存在：${input.owner}` });
      }
      if (user.role !== 'admin' && target.id !== user.id) {
        throw new ORPCError('FORBIDDEN', { message: '组合归属隔离：仅可查看自己的组合（admin 可查任意归属）' });
      }
      ownerId = target.id;
    } else if (user.role !== 'admin') {
      ownerId = user.id;
    }
    const rows = setsServiceOf(context).listSets({
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(ownerIds !== undefined ? { ownerIds } : {}),
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

/**
 * 组合读门（product-polish-w1 T3/T4）：owner/admin 照旧；**admin 所建市场组合对
 * 任何认证用户开放只读**（材料市场=全工坊共享的只读快照——详情预览/成员清单可
 * 见；引用与编辑仍须先 sets.copyFromMarket 复制为本人副本）。写面（update/delete）
 * 不放宽——仍走 requireOwnedResource。
 */
function requireReadableSet(context: RpcContext, resourceId: string): void {
  const row = context.db
    .prepare('SELECT owner_id FROM resources WHERE id = ?')
    .get(resourceId) as { owner_id: string } | undefined;
  if (row === undefined) {
    throw new ORPCError('BAD_REQUEST', { message: `资源不存在：${resourceId}` });
  }
  const user = context.user as UserRow;
  if (row.owner_id === user.id || user.role === 'admin') return;
  const ownerRole = context.db
    .prepare('SELECT role FROM users WHERE id = ?')
    .get(row.owner_id) as { role: string } | undefined;
  if (ownerRole?.role === 'admin') return; // 市场组合（admin 所建）——只读快照开放
  throw new ORPCError('FORBIDDEN', {
    message: '资源不属于当前用户（跨用户组合访问必拒——组合读写按 owner 归属）',
  });
}

const setsGet = requireAuth.input(SetsGetInputSchema).handler(({ context, input }) => {
  try {
    requireReadableSet(context, input.resourceId);
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

/**
 * 市场组合→我的材料（product-polish-w1 T1）：「管理员发布生产组合→用户拿去用」
 * 的复制语义。白名单门在服务层（源 owner=admin——users.role 真值查询），副本
 * ownerId=当前认证用户、origin={kind:'clone', fromSetId} 溯源、成员快照复制。
 * 与 setsCreate 的 clone 分支正交：那是同 owner 复用，本端点是跨 owner 白名单。
 */
const setsCopyFromMarket = requireActiveUser.input(SetsCopyFromMarketInputSchema).handler(({ context, input }) => {
  try {
    return setsServiceOf(context).copyMarketSet({
      sourceResourceId: input.resourceId,
      ownerId: (context.user as UserRow).id,
      ...(input.name !== undefined ? { name: input.name } : {}),
    });
  } catch (error) {
    setOwnedError(error);
  }
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

    // —— tree（object-tree 工件——nodes 含 mask inline|blob 二态；canvasCm/imagePx=
    //    工作画布真源锚点投影 [Bug B 修复]——UI px↔mm 换算以树锚推导，不混 baseImage）
    let tree: {
      blobRef: string;
      canvasCm: { w: number; h: number };
      imagePx: { width: number; height: number };
      nodes: ReturnType<typeof loadObjectTreeArtifact>['nodes'];
    } | null = null;
    const treeRef = artifacts.get(OBJECT_TREE_ARTIFACT_NAME);
    if (treeRef !== undefined) {
      const loaded = loadObjectTreeArtifact(blobs, treeRef);
      tree = {
        blobRef: treeRef,
        canvasCm: loaded.canvasCm,
        imagePx: loaded.imagePx,
        nodes: loaded.nodes,
      };
    }

    // —— assignments（当前生效=最新 strategy-plan）
    let assignments: StrategyAssignment[] = [];
    const planRef = artifacts.get(STRATEGY_PLAN_ARTIFACT_NAME);
    if (planRef !== undefined) {
      const plan = StrategyPlanSchema.parse(readArtifactJson(blobs, planRef, 'strategy-plan'));
      assignments = plan.assignments;
    }

    // —— gems（strategy-gems 工件摘要——v5 修复轮 R1：count 走叶子口径与 task.export/
    //    前端三面同源 effectiveGems；树缺席=无法过滤，回落原始颗数（读面不炸——
    //    导出面 task.export 树缺席为 typed 拒，两面口径差异仅存在于树缺席的病态任务））
    let gems: { blobRef: string; count: number; excludedRegions: number } | null = null;
    const gemsRef = artifacts.get(STRATEGY_GEMS_ARTIFACT_NAME);
    if (gemsRef !== undefined) {
      const doc = StrategyGemsDocSchema.parse(readArtifactJson(blobs, gemsRef, 'strategy-gems'));
      const count =
        tree !== null ? effectiveGems({ nodes: tree.nodes }, doc.gems).length : doc.gems.length;
      gems = { blobRef: gemsRef, count, excludedRegions: doc.excludedRegions.length };
    }

    // —— preview（钻点阵预览优先，树叠加预览兜底）
    const previewRef =
      artifacts.get(STRATEGY_GEMS_PREVIEW_ARTIFACT_NAME) ?? artifacts.get(OBJECT_TREE_PREVIEW_ARTIFACT_NAME) ?? null;

    // —— viewState（workbench-pro 波 2a：显隐/折叠/锁定=task 级服务端工件——重载不丢）
    const viewState = loadViewState(blobs, artifacts.get(WORKBENCH_VIEW_STATE_ARTIFACT_NAME) ?? null);
    // —— maskEdits+exportGate（mask 编辑状态面+导出门——incomplete/stale/error 三阻断）
    const maskEdits = maskEditStatusesOf(context.db, input.taskId);
    const exportGate = exportGateOf(maskEdits);
    // —— stoneCandidates（v3 钻选择器数据面：owner 共享库稳定序投影。
    //    2026-10-04 修复：改用 projectStonePalette（UI 面无 LLM prompt 界——此前误用
    //    projectStoneCandidates，钻库>200 时 stone-filter-oversize 抛错被 catch 置空，
    //    色板恒「候选表为空」＝Owner 报障「无法选择钻」）。空库/失败=空数组降级不阻塞读面）
    let stoneCandidates: StoneCandidateRow[] = [];
    try {
      stoneCandidates = projectStonePalette({ db: context.db, blobs }).map((candidate) => ({
        idx: candidate.idx,
        resourceId: candidate.pick.resourceId,
        sku: candidate.pick.sku,
        supplier: candidate.pick.supplier,
        sizeMm: candidate.pick.sizeMm,
        colorHex: candidate.pick.colorHex,
        family: candidate.family,
      }));
    } catch {
      stoneCandidates = []; // 投影失败（读面不阻塞——UI 引导入库）
    }

    // —— projectStones（add-task-stones-manifest-export 0.4/3.1：session-project
    //    manifest 摘要——revision/entryCount/sourceSetName；lint=W3 点亮（W0 占位
    //    null 结束）：stones-lint.json 工件新鲜（manifestRevision+planRef 双锚未
    //    漂移）直读工件 summary，漂移/缺席以当前 assignments 现算（读面发现漂移
    //    重算语义——不展示旧的「已消除」）。job 任务无会话/会话尚无项目行=null；
    //    manifest blob 损坏=typed 拒（不静默降级）。
    let projectStones: TaskDetailProjectStones | null = null;
    if (task.session_id !== null) {
      const summary = projectStonesSummaryOf({ db: context.db, blobs }, task.session_id);
      projectStones =
        summary === null
          ? null
          : {
              ...summary,
              lint: lintSummaryForTaskDetail(
                { db: context.db, blobs },
                {
                  sessionId: task.session_id,
                  latestPlanRef: artifacts.get(STRATEGY_PLAN_ARTIFACT_NAME) ?? null,
                  latestLintRef: artifacts.get(STONES_LINT_ARTIFACT_NAME) ?? null,
                  assignments,
                },
              ),
            };
    }

    // —— segmentDefaults（Owner 走查 2026-10-04：抠图 Dialog 参数区空态展示服务端
    //    当前生效值）：imageProcessingEffective 只读投影（settings→env→default 单源
    //    解析——与 SAM 每请求调谐 samRequestTuner 同源，改设置对下一次 task.detail
    //    立即生效）。admin 读面 requireAdmin 不适用匿名会话 owner——搭 owner 域内
    //    既有响应零新端点。maskMaxSide null=原尺寸。
    const imageEffective = imageProcessingEffective(context.db, process.env);

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
      stoneCandidates,
      projectStones,
      segmentDefaults: {
        maskMaxSide: imageEffective.samMaskMaxSide,
        confThreshold: imageEffective.samConfThreshold,
      },
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

/** 人类拆层（登录态+owner；segmentOne 原子直调+owner 审计入版本史；T5 试跑 dryRun
 *  不落树不入史——precision/layerName 透传；Codex R1 P1 trialTreeBlobRef=确认基线树
 *  守卫（≠电流树 typed 拒 trial-stale-tree——客户端树视图过期竞态）。
 *  add-sam-playbook T2 透传：instances（逐实例成层）/excludeBox（排除区像素减法）/
 *  box+hint 可选（纯框选抠图）——Dialog 三模式（排除区拖画/纯框/实例枚举）。 */
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
        ...(input.hint !== undefined ? { hint: input.hint } : {}),
        ...(input.box !== undefined ? { box: input.box } : {}),
        ...(input.excludeBox !== undefined ? { excludeBox: input.excludeBox } : {}),
        ...(input.instances !== undefined ? { instances: input.instances } : {}),
        ...(input.precision !== undefined ? { precision: input.precision } : {}),
        ...(input.dryRun !== undefined ? { dryRun: input.dryRun } : {}),
        ...(input.layerName !== undefined ? { layerName: input.layerName } : {}),
        ...(input.trialTreeBlobRef !== undefined ? { trialTreeBlobRef: input.trialTreeBlobRef } : {}),
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

/**
 * 版本列表（versions=工作台快照链+journey 基线播种；currentTreeBlobRef=帧流最新树工件）。
 * v3 Owner 整改：journey 产树不入链 ⇒ 历史恒空——seed 面（电流树/预览引用+读取者）
 * 由内核对「链未覆盖的电流树」播种 cause='journey' 基线行（历史只增不删）。
 */
const treeHistory = requireAuth.input(TreeHistoryInputSchema).handler(({ context, input }) => {
  const jobs = requireJobs(context);
  try {
    const user = context.user as UserRow;
    requireWorkbenchTask(context, input.taskId);
    const artifacts = latestArtifactRefs(jobs, user, input.taskId);
    const { versions, currentVersion } = workbenchOf(context).treeHistory(input.taskId, {
      currentTreeBlobRef: artifacts.get(OBJECT_TREE_ARTIFACT_NAME) ?? null,
      currentPreviewBlobRef: artifacts.get(OBJECT_TREE_PREVIEW_ARTIFACT_NAME) ?? null,
      actorId: user.id,
    });
    const currentTreeBlobRef = artifacts.get(OBJECT_TREE_ARTIFACT_NAME) ?? null;
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

// ---------------------------------------------------------------- workbench-pro 波 2a 三写+视图态+导出（契约冻结面）

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

/** 视图态全量快照写（显隐/折叠/锁定——task 级工件+revision 单调链；CAS 门+节点归属门 P0-2）。 */
const viewStateSet = requireActiveUser
  .input(ViewStateSetInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const jobs = requireJobs(context);
      requireWorkbenchTask(context, input.taskId);
      const artifacts = latestArtifactRefs(jobs, user, input.taskId);
      return workbenchOf(context).setViewState({
        taskId: input.taskId,
        actorId: user.id,
        currentViewStateBlobRef: artifacts.get(WORKBENCH_VIEW_STATE_ARTIFACT_NAME) ?? null,
        currentTreeBlobRef: artifacts.get(OBJECT_TREE_ARTIFACT_NAME) ?? null,
        nodes: input.nodes,
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
        ...(input.previewMode !== undefined ? { previewMode: input.previewMode } : {}),
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/**
 * 任务导出（workbench-pro P0-1——导出门的真实安全边界）：服务端以 mask_edit_states
 * 为真源**重算**门（exportGateOf——不信任客户端缓存的 task.detail.exportGate 读面），
 * allowed=false 时 typed 拒 export-blocked+完整 blockers；放行时导出内容=帧流最新
 * strategy-gems.json 工件**按当前 object-tree.json 叶子口径过滤后**的排钻设计文档
 * （v5 修复轮 R1——Codex P1「界面 699、下载 858」闭合：v4 存量工件的父层旧钻不进
 * 导出字节；过滤与 task.detail gems 面/前端渲染三面同源 effectiveGems）。输出形状沿
 * resources.export 的 filename/kind/dataBase64 形态（workbench-pro.test [7] RPC 级
 * 四态固化）+blobRef/gemCount 摘要（blobRef 恒与返回字节内容寻址一致：无剔除=原工件
 * ref；有剔除=过滤后新字节的 sha256 ref）。
 */
const taskExport = requireAuth
  .input(TaskExportInputSchema)
  .handler(({ context, input }) => {
    const blobs = context.blobs;
    if (!blobs) throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
    const jobs = requireJobs(context);
    try {
      const user = context.user as UserRow;
      requireWorkbenchTask(context, input.taskId);
      // —— 门重算（安全边界单点：门阻时导出内容完全不触达）
      const gate = exportGateOf(maskEditStatusesOf(context.db, input.taskId));
      if (!gate.allowed) {
        throw new ORPCError('BAD_REQUEST', {
          message: `导出被门阻（${gate.blockers.join(', ')}）——先在排钻工作台解决遮罩编辑告警后重试`,
          data: { code: 'export-blocked', blockers: gate.blockers },
        });
      }
      // —— 导出内容（帧流最新 strategy-gems——缺产物=NOT_FOUND 指引）
      const artifacts = latestArtifactRefs(jobs, user, input.taskId);
      const gemsRef = artifacts.get(STRATEGY_GEMS_ARTIFACT_NAME);
      if (gemsRef === undefined) {
        throw new ORPCError('NOT_FOUND', {
          message: `任务 ${input.taskId} 尚无排钻设计产物（strategy-gems——先完成指派计算再导出）`,
        });
      }
      // —— v5 叶子过滤前置：当前 object-tree 缺席=无法判定叶子集，typed 拒（不静默
      //    导出可能含父层旧钻的原始字节——export-blocked 同族明确错误面）
      const treeRef = artifacts.get(OBJECT_TREE_ARTIFACT_NAME);
      if (treeRef === undefined) {
        throw new ORPCError('BAD_REQUEST', {
          message: `任务 ${input.taskId} 尚无图层树（object-tree——v5 叶子口径导出的过滤前提缺失，拒绝回放未过滤工件）`,
          data: { code: 'tree-missing' },
        });
      }
      const row = blobs.rowOf(gemsRef);
      if (row === null) {
        throw new ORPCError('NOT_FOUND', { message: `排钻设计工件不可读或已回收：${gemsRef}` });
      }
      if (row.size > TASK_ARTIFACT_MAX_BYTES) {
        throw new ORPCError('BAD_REQUEST', {
          message: `工件超过 ${TASK_ARTIFACT_MAX_BYTES} 字节上限（实为 ${row.size}）`,
          data: { code: 'artifact-too-large', size: row.size, maxBytes: TASK_ARTIFACT_MAX_BYTES },
        });
      }
      const doc = StrategyGemsDocSchema.parse(readArtifactJson(blobs, gemsRef, 'strategy-gems'));
      const tree = loadObjectTreeArtifact(blobs, treeRef);
      const filtered = effectiveGems(tree, doc.gems);
      // 无剔除=恒等回放（原字节/原 ref——与最新工件内容寻址一致）
      if (filtered.length === doc.gems.length) {
        const bytes = blobs.read(gemsRef)!; // rowOf 已证在场（readAfter 同步块内无回收窗口）
        return {
          filename: `task-${input.taskId}-strategy-gems.json`,
          kind: 'strategy-gems' as const,
          dataBase64: Buffer.from(bytes).toString('base64'),
          blobRef: gemsRef,
          gemCount: doc.gems.length,
        };
      }
      // 有剔除=生成过滤后新文档（warnings 追加 degraded 明示剔除颗数——不静默改写）
      // 并以内容寻址 put 落盘（blobRef=新字节 sha256，与返回字节恒一致）
      const exported: typeof doc = StrategyGemsDocSchema.parse({
        ...doc,
        gems: filtered,
        warnings: [
          ...doc.warnings,
          {
            kind: 'degraded',
            detail: `v5 叶子口径过滤：剔除 ${doc.gems.length - filtered.length} 颗父层（组）旧钻——组恒不产钻（与画布/徽标/顶栏读数同口径）`,
          },
        ],
      });
      const bytes = Buffer.from(JSON.stringify(exported), 'utf8');
      const blobRef = blobs.put(bytes).hash;
      return {
        filename: `task-${input.taskId}-strategy-gems.json`,
        kind: 'strategy-gems' as const,
        dataBase64: bytes.toString('base64'),
        blobRef,
        gemCount: filtered.length,
      };
    } catch (error) {
      ownedError(error);
    }
  });

// ---------------------------------------------------------------- workbench-pro 恢复链（maskEdit.retry/discard——终评 P0-1）

/**
 * stale/error 重放重算（2d 收尾轮——Codex 终评 P0-1 闭合）：内核
 * retryMaskEditRecompute 真身（CAS=expectedBaseVersion；零行竞态不执行重算副作用）。
 * 电流树/plan 由帧流解析（与三写 RPC 同源）；plan 缺席 typed 拒 plan-missing。
 */
const maskEditRetry = requireActiveUser
  .input(MaskEditRetryInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      const refs = requireWorkbenchWriteContext(context, user, input.taskId);
      return workbenchOf(context).retryMaskEditRecompute({
        taskId: input.taskId,
        nodeId: input.nodeId,
        imageBlobRef: refs.imageBlobRef,
        currentTreeBlobRef: refs.currentTreeBlobRef,
        planBlobRef: refs.planBlobRef,
        expectedBaseVersion: input.expectedBaseVersion,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

/**
 * 确认放弃编辑留痕（终评 P0-1）：删阻断留痕行（stale/error/incomplete——mask 已落盘
 * 如实不回滚，仅清告警/门阻断面）；CAS 拒面同 retry；行已不在=幂等成功。
 */
const maskEditDiscard = requireActiveUser
  .input(MaskEditDiscardInputSchema)
  .handler(({ context, input }) => {
    try {
      const user = context.user as UserRow;
      requireWorkbenchTask(context, input.taskId);
      return workbenchOf(context).discardMaskEdit({
        taskId: input.taskId,
        nodeId: input.nodeId,
        expectedBaseVersion: input.expectedBaseVersion,
      });
    } catch (error) {
      workbenchOwnedError(error);
    }
  });

// ---------------------------------------------------------------- models（zhumo 方案移植块 A——多路由真源面）

/**
 * 模型服务六端点（split-admin-portal 1.3 收权 admin——后台设置分区承载）：get/
 * save/catalog/catalogRefresh/test 五端点 requireAdmin（普通/匿名直调必拒）；
 * available 保持活动用户只读（前台对话模型 chip 数据源）。
 *   get/save   多路由配置读写（密钥空=保留，输出面恒 hasKey）
 *   catalog    预设目录（zcode 策展恒在 + models.dev 缓存追加）
 *   catalogRefresh  models.dev 在线刷新（网络失败中文报错不伤旧缓存）
 *   test       连接测试（apiKey 直传优先，缺省从已存密钥注入）
 *   available  可用模型清单（对话模型 chip 数据源——requireAuth 读面）
 */
const modelsGet = requireAdmin.handler(({ context }): ModelsConfigOutput => {
  return loadModelsConfig(context.db, context.config.llm);
});

/**
 * 多路由配置写面：apiKey 空/缺省=保留旧值；保存后桥接面即时全量重写
 * （settings.yaml/.credentials.yaml 行热加载——新内核会话即生效，无需重启）。
 * v6 复核 P1-4：空 bundle 也重写（providers 清空+模型域旧密钥 refs 清除）——
 * 删除路由即清理，任何桥接文件不留无主 provider/key。
 */
const modelsSave = requireAdmin
  .input(ModelsSaveInputSchema)
  .handler(({ context, input }) => {
    try {
      saveModelsConfig(context.db, input);
    } catch (error) {
      ownedError(error);
    }
    // 桥接面即时全量重写（zhumo adminModelsSave 语义 + 空集清理收口——dsh-home 行热加载）。
    const bundle = buildRoutesBundle(context.db, context.config.llm);
    syncModelRoutesBridge(path.join(context.config.dataRoot, 'dsh-home'), bundle);
    // daemon 侧 routeCache 跟随（波 5 P1-3：缓存仅 boot 解析会让存续内核的新会话
    // agentOptions 钉死旧路由——「保存后对新会话生效」失真；内核侧桥接文件由 dsh
    // chokidar 热加载，此处只需失效重解析）。
    context.kernel?.invalidateRouteCache();
    return loadModelsConfig(context.db, context.config.llm);
  });

/** 预设目录（zcode 策展恒在 + models.dev 缓存追加——公开面，无敏感值）。 */
const modelsCatalog = requireAdmin.handler(({ context }): ModelCatalogOutput => {
  return modelCatalog(context.db);
});

/** models.dev 在线刷新：成功返回合并目录；网络失败中文报错且不伤策展/旧缓存。 */
const modelsCatalogRefresh = requireAdmin.handler(async ({ context }) => {
  try {
    await refreshModelsDevCache(context.db);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ORPCError('BAD_REQUEST', {
      message: `models.dev 预设刷新失败：${detail}（可稍后重试，内置预设不受影响）`,
    });
  }
  return modelCatalog(context.db);
});

/** 连接测试：apiKey 直传优先，缺省从已存密钥注入（provider 键）。 */
const modelsTest = requireAdmin
  .input(ModelsTestInputSchema)
  .handler(async ({ context, input }): Promise<ModelsTestOutput> => {
    const apiKey =
      input.apiKey && input.apiKey.length > 0
        ? input.apiKey
        : loadKeys(context.db)[input.provider ?? ''] ?? '';
    const output = await testRouteConnection({ ...input, apiKey });
    // 波 5 P3-1：外呼失败落 daemon 日志一行（detail 已脱敏——testRouteConnection
    // 的 key 字面量替换+截断语义；不落密钥）。UI 面已有失败摘要，此行供 daemon 侧排查。
    if (!output.ok) {
      console.warn(
        `[models] 连接测试失败（${input.provider ?? input.baseURL} / ${input.modelId}）：${output.detail}`,
      );
    }
    return output;
  });

/** 可用模型清单（登录用户；对话 composer 模型 chip 的活动模型选择面）。 */
const modelsAvailable = requireAuth.handler(({ context }): ModelsAvailableOutput => {
  const config = loadModelsConfig(context.db, context.config.llm);
  return {
    models: config.routes.flatMap((route) =>
      route.models.map((model) => ({
        provider: route.provider,
        model: model.id,
        name: model.name ?? model.id,
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.inputTypes !== undefined ? { inputTypes: model.inputTypes } : {}),
        ...(model.efforts !== undefined && model.efforts.length > 0 ? { efforts: model.efforts } : {}),
        ...(route.iconUrl !== undefined ? { iconUrl: route.iconUrl } : {}),
      })),
    ),
    default: config.default,
  };
});

// ---------------------------------------------------------------- imageProcessing（add-image-processing-settings 1.3）

/**
 * 图像处理设置两端点（design §4——models 端点同构；split-admin-portal 1.3 收权
 * requireAdmin——后台设置分区承载，普通/匿名直调必拒）：
 *   get   读面（生效值+来源 settings|env|default——解析单源在 image-processing-store）
 *   save  写面（reset=true 删键回 env/default 跟随；非 custom 档服务端按冻结映射
 *         生成 values 快照——入参 values 忽略；custom 缺 values/越界 typed 拒——
 *         越界在 orpc input schema 层、缺 values 在 store 层，均投影 BAD_REQUEST）
 * 纯 daemon 内消费（无 credentials/settings.yaml 桥接联动——与 models 不同）；生效
 * 路径为调用时解析（scene.analyze intake provider + SAM 每请求调谐，kernel 装配），
 * 保存即对 daemon 存续会话的下一次请求生效，无需重启。
 */
const imageProcessingGet = requireAdmin.handler(({ context }): ImageProcessingGetOutput => {
  return loadImageProcessing(context.db, process.env);
});

const imageProcessingSave = requireAdmin
  .input(ImageProcessingSaveInputSchema)
  .handler(({ context, input }) => {
    try {
      return saveImageProcessing(context.db, input);
    } catch (error) {
      ownedError(error);
    }
  });

// ---------------------------------------------------------------- assetsLib（split-admin-portal 4.3——素材库服务化）

/**
 * 素材库九端点（design §5 素材库行；asset_library 表+blobs 内容寻址）：
 *   tree/migrateVerify=requireAuth 读面（本人域；admin 显式 owner 全见——传他人
 *   FORBIDDEN 与 sets.list 4.2 同规）；uploadImage/move/rename/softDelete/restore/
 *   purgeEmptyTrash/migrateBatch=requireActiveUser 写面+归属校验（admin 豁免）。
 * 错误面：AssetsLibraryError → BAD_REQUEST+data.code（typed 码保留——
 * ancestor-still-deleted/orphan-parent 等可编程判别）。
 */

/** 素材库服务装配（blobs 未装配 501——照 setsServiceOf 形态）。 */
function assetsLibraryOf(context: RpcContext): AssetsLibraryService {
  if (!context.blobs) {
    throw new ORPCError('NOT_IMPLEMENTED', { message: 'BlobStore 未装配（501）' });
  }
  return new AssetsLibraryService({ db: context.db, blobs: context.blobs });
}

/** 素材节点归属校验（requireOwnedResource 同族：跨用户拒+admin 豁免）。 */
function requireOwnedAssetNode(context: RpcContext, id: string, what: string): AssetLibraryRow {
  const row = context.db.prepare('SELECT * FROM asset_library WHERE id = ?').get(id) as
    | AssetLibraryRow
    | undefined;
  if (row === undefined) {
    throw new ORPCError('BAD_REQUEST', { message: `素材不存在：${id}` });
  }
  const user = context.user as UserRow;
  if (row.owner_id !== user.id && user.role !== 'admin') {
    throw new ORPCError('FORBIDDEN', { message: `素材不属于当前用户（跨用户${what}必拒——素材按 owner 归属）` });
  }
  return row;
}

/** 行视图折算（owner=username——契约 camelCase 投影；username 空为 FK 异常兜底）。 */
function assetNodeOf(row: AssetLibraryRow, ownerUsername: string): AssetsLibNode {
  return {
    id: row.id,
    owner: ownerUsername,
    parentId: row.parent_id,
    name: row.name,
    isDir: row.is_dir === 1,
    mime: row.mime,
    width: row.width,
    height: row.height,
    blobHash: row.blob_hash,
    bytes: row.bytes,
    softDeleted: row.soft_deleted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assetLibOwnedError(error: unknown): never {
  if (error instanceof ORPCError) throw error;
  if (error instanceof AssetsLibraryError) {
    throw new ORPCError('BAD_REQUEST', {
      message: `素材库错误（${error.code}）：${error.message}`,
      data: { code: error.code },
    });
  }
  throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : String(error) });
}

/** users.id → username（节点输出面折算用；FK 保证在场——缺席回空串不炸读面）。 */
function usernameOfId(db: RpcContext['db'], id: string): string {
  const row = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined;
  return row?.username ?? '';
}

/** 树 owner 解析（admin 显式查他人/缺省全量；普通用户恒自己——与 sets.list 4.2 同规）。 */
function resolveAssetsTreeOwner(
  context: RpcContext,
  owner: string | undefined,
): { ownerId: string | undefined; ownerUsername: string } {
  const user = context.user as UserRow;
  if (owner === undefined) {
    // admin 缺省=全量（后台集中管理面）；普通用户=自己。
    return user.role === 'admin'
      ? { ownerId: undefined, ownerUsername: user.username }
      : { ownerId: user.id, ownerUsername: user.username };
  }
  const target = getUserByUsername(context.db, owner);
  if (target === null) {
    throw new ORPCError('NOT_FOUND', { message: `用户不存在：${owner}` });
  }
  if (user.role !== 'admin' && target.id !== user.id) {
    throw new ORPCError('FORBIDDEN', { message: '素材归属隔离：仅可查看自己的素材树（admin 可查任意归属）' });
  }
  return { ownerId: target.id, ownerUsername: target.username };
}

const assetsLibTree = requireAuth.input(AssetsLibTreeInputSchema).handler(({ context, input }) => {
  try {
    const { ownerId, ownerUsername } = resolveAssetsTreeOwner(context, input.owner);
    const rows = assetsLibraryOf(context).listNodes(ownerId, input.includeTrashed);
    // 全量/admin 代管视图下 owner 逐行折算（usernameOfId——小用户量直查可承受）。
    const nodes = rows.map((row) =>
      ownerId === undefined
        ? assetNodeOf(row, usernameOfId(context.db, row.owner_id))
        : assetNodeOf(row, ownerUsername),
    );
    return { nodes };
  } catch (error) {
    assetLibOwnedError(error);
  }
});

const assetsLibUploadImage = requireActiveUser
  .input(AssetsLibUploadImageInputSchema)
  .handler(({ context, input }) => {
    const user = context.user as UserRow;
    const data = decodeBoundedBase64(input.dataBase64, '素材');
    try {
      const row = assetsLibraryOf(context).uploadImage(
        user.id,
        input.parentId,
        input.name,
        data,
        input.width,
        input.height,
      );
      return assetNodeOf(row, user.username);
    } catch (error) {
      assetLibOwnedError(error);
    }
  });

const assetsLibMove = requireActiveUser.input(AssetsLibMoveInputSchema).handler(({ context, input }) => {
  try {
    const row = requireOwnedAssetNode(context, input.id, '移动');
    // moveNode 的父目录校验按节点归属域（admin 代管时不跨 owner 树挪挂）。
    const moved = assetsLibraryOf(context).moveNode(input.id, input.newParentId, row.owner_id);
    return assetNodeOf(moved, usernameOfId(context.db, moved.owner_id));
  } catch (error) {
    assetLibOwnedError(error);
  }
});

const assetsLibRename = requireActiveUser.input(AssetsLibRenameInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedAssetNode(context, input.id, '重命名');
    const renamed = assetsLibraryOf(context).renameNode(input.id, input.name);
    return assetNodeOf(renamed, usernameOfId(context.db, renamed.owner_id));
  } catch (error) {
    assetLibOwnedError(error);
  }
});

const assetsLibSoftDelete = requireActiveUser.input(AssetsLibSoftDeleteInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedAssetNode(context, input.id, '软删');
    return assetsLibraryOf(context).softDelete(input.id);
  } catch (error) {
    assetLibOwnedError(error);
  }
});

const assetsLibRestore = requireActiveUser.input(AssetsLibRestoreInputSchema).handler(({ context, input }) => {
  try {
    requireOwnedAssetNode(context, input.id, '恢复');
    return assetsLibraryOf(context).restore(input.id);
  } catch (error) {
    assetLibOwnedError(error);
  }
});

const assetsLibPurgeEmptyTrash = requireActiveUser
  .input(AssetsLibPurgeEmptyTrashInputSchema)
  .handler(({ context }) => {
    // 首版域=调用者本人回收站（admin 代清他人域挂后续波——契约注释同款标注）。
    return assetsLibraryOf(context).purgeTrash((context.user as UserRow).id);
  });

const assetsLibMigrateBatch = requireActiveUser
  .input(AssetsLibMigrateBatchInputSchema)
  .handler(({ context, input }) => {
    const user = context.user as UserRow;
    // 批字节界（单件 decodeBoundedBase64 已界 32MiB；总界防 64 件极限载荷撑爆 WS 帧）。
    let totalBytes = 0;
    for (const item of input.items) {
      if (!item.isDir) totalBytes += Math.ceil((item.dataBase64.length * 3) / 4);
    }
    if (totalBytes > ASSETS_LIB_MIGRATE_BATCH_LIMIT * 1024 * 1024) {
      throw new ORPCError('BAD_REQUEST', {
        message: `单批总字节超过 ${ASSETS_LIB_MIGRATE_BATCH_LIMIT}MiB（实为约 ${Math.ceil(totalBytes / (1024 * 1024))}MiB）——请减小分批`,
        data: { code: 'batch-too-large' },
      });
    }
    try {
      return { results: assetsLibraryOf(context).migrateBatch(user.id, input.items) };
    } catch (error) {
      assetLibOwnedError(error);
    }
  });

const assetsLibMigrateVerify = requireAuth.input(AssetsLibMigrateVerifyInputSchema).handler(({ context, input }) => {
  try {
    return assetsLibraryOf(context).verifyManifest((context.user as UserRow).id, input);
  } catch (error) {
    assetLibOwnedError(error);
  }
});

// ---------------------------------------------------------------- 路由表

export const router = {
  bootstrap,
  auth: {
    login: authLogin,
    refresh: authRefresh,
    me: authMe,
  },
  admin: {
    userList: adminUserList,
    userCreate: adminUserCreate,
    userUpdate: adminUserUpdate,
    userDelete: adminUserDelete,
    settingsGet: adminSettingsGet,
    settingsUpdate: adminSettingsUpdate,
    kb: {
      list: adminKbList,
      saveGroup: adminKbSaveGroup,
      deleteGroup: adminKbDeleteGroup,
      saveEntry: adminKbSaveEntry,
      deleteEntry: adminKbDeleteEntry,
      revisions: adminKbRevisions,
      revisionGet: adminKbRevisionGet,
      restore: adminKbRestore,
    },
  },
  assets: {
    upload: assetsUpload,
  },
  assetsLib: {
    tree: assetsLibTree,
    uploadImage: assetsLibUploadImage,
    move: assetsLibMove,
    rename: assetsLibRename,
    softDelete: assetsLibSoftDelete,
    restore: assetsLibRestore,
    purgeEmptyTrash: assetsLibPurgeEmptyTrash,
    migrateBatch: assetsLibMigrateBatch,
    migrateVerify: assetsLibMigrateVerify,
  },
  models: {
    get: modelsGet,
    save: modelsSave,
    catalog: modelsCatalog,
    catalogRefresh: modelsCatalogRefresh,
    test: modelsTest,
    available: modelsAvailable,
  },
  imageProcessing: {
    get: imageProcessingGet,
    save: imageProcessingSave,
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
    copyFromMarket: setsCopyFromMarket,
  },
  session: {
    create: sessionCreate,
    list: sessionList,
    get: sessionGet,
    followup: sessionFollowup,
    answer: sessionAnswer,
    cancel: sessionCancel,
    rename: sessionRename,
    setAutoApprove: sessionSetAutoApprove,
    clear: sessionClear,
    retry: sessionRetry,
    replay: sessionReplay,
    result: sessionResult,
    exports: sessionExports,
    images: sessionImages,
  },
  task: {
    detail: taskDetail,
    export: taskExport,
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
  maskEdit: {
    retry: maskEditRetry,
    discard: maskEditDiscard,
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
