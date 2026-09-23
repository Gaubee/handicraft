/**
 * 服务面任务端点 IO（design §2 长任务行 + §1 jobs/——W2.1 冻结首批最小集）。
 * 原始需求 2026-09-23：tasks.create/get/list/cancel/frames（type=job 族；agent 族
 * 会话端点归 §3.5/W3-W4）+ bootstrap 迁入 RPC + 资产上传（生成/排钻的输入面）。
 * 正交意图：
 *   [1] bootstrap 读面（密钥脱敏——仅存在性布尔，值零出契约）。
 *   [2] job 三类参数：sleep（帧流语义演示）/ generate（图像 API 代理）/ engine
 *       （排钻·校验·导出——paving 契约参数直通，region/blocks 语义同 §3.4）。
 *   [3] 任务视图与帧回放（frames 输出与 session.replay 同形——afterSeq 游标以
 *       task 为域，复用 Frame 线格式）。
 */
import { z } from 'zod';
import {
  BlobRefSchema,
  IdSchema,
  IsoDateTimeSchema,
  TaskKindSchema,
  TaskStatusSchema,
} from './common.js';
import { FrameSchema } from './frame.js';
import { ResultBundleSchema } from './session.js';
import {
  DensitySpecSchema,
  GapMmSchema,
  RegionSchema,
  RelaxSchema,
  SeedSchema,
  SpecRefSchema,
  StrategyIdSchema,
} from './paving.js';

// ---------------------------------------------------------------- bootstrap

/** bootstrap 读面（HTTP /api/bootstrap 同源语义；密钥仅存在性，design §2）。 */
export const BootstrapOutputSchema = z
  .object({
    version: z.string().min(1),
    allowAnonymous: z.boolean(),
    adminConfigured: z.boolean(),
    /** 半配置=未配置（必需键不齐视为整体未配置——任务创建时显式拒绝）。 */
    imgConfigured: z.boolean(),
    llmConfigured: z.boolean(),
    /** IMG_DRY_RUN=1（E2E 与测试全程 dry-run，不真实外呼）。 */
    imgDryRun: z.boolean(),
  })
  .strict();
export type BootstrapOutput = z.infer<typeof BootstrapOutputSchema>;

// ---------------------------------------------------------------- 上传（输入面）

/** 资产上传：base64 字节 → 内容寻址 blobRef（生成/排钻任务的输入）。 */
export const AssetsUploadInputSchema = z
  .object({
    filename: z.string().min(1),
    dataBase64: z.string().min(1),
  })
  .strict();
export const AssetsUploadOutputSchema = z
  .object({
    blobRef: BlobRefSchema,
    filename: z.string().min(1),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type AssetsUploadInput = z.infer<typeof AssetsUploadInputSchema>;
export type AssetsUploadOutput = z.infer<typeof AssetsUploadOutputSchema>;

// ---------------------------------------------------------------- job 参数

export const JobKindSchema = z.enum(['sleep', 'generate', 'engine']);
export type JobKind = z.infer<typeof JobKindSchema>;

/** sleep 演示 job：固定 N 帧 progress 后 done（帧流语义测试面）。 */
export const SleepJobParamsSchema = z
  .object({
    frames: z.number().int().min(1).max(1000),
    intervalMs: z.number().int().min(0).max(10_000).default(25),
  })
  .strict();
export type SleepJobParams = z.infer<typeof SleepJobParamsSchema>;

/** 生成 job 参数（imageRef 有=edits 语义，无=generations 语义——OpenAI 兼容面）。 */
export const GenerateJobParamsSchema = z
  .object({
    prompt: z.string().min(1),
    /** 如 '1024x1024'；空串不发送 */
    size: z.string().optional(),
    /** edits 模式原图（内容寻址） */
    imageRef: BlobRefSchema.optional(),
    /** Advanced JSON 逃生舱（原样合并进请求体；敏感键在 debug 面打码） */
    advanced: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type GenerateJobParams = z.infer<typeof GenerateJobParamsSchema>;

/** 排钻 job：上传图 → segment → layout（§3.4 排布参数一等输入直通引擎）。 */
export const PaveJobParamsSchema = z
  .object({
    op: z.literal('pave'),
    imageRef: BlobRefSchema,
    strategy: StrategyIdSchema,
    density: DensitySpecSchema.default(1),
    gapMm: GapMmSchema,
    seed: SeedSchema.default(1),
    relax: RelaxSchema.default({ boundary: false, repulsion: false }),
    /** 区域收敛 blocks ID（缺省=全部块；§3.4 首版 single variant） */
    region: RegionSchema.optional(),
    /** 钻规格（shapeId/diameterMm 唯一物理依据；custom 必带 assetId） */
    spec: SpecRefSchema,
    /** 像素/毫米（grid 派生入参；缺省 8） */
    pixelsPerMm: z.number().positive().default(8),
    /** 量化色数 k（segment 参数；6..10） */
    segmentK: z.number().int().min(6).max(10).default(8),
  })
  .strict();
export type PaveJobParams = z.infer<typeof PaveJobParamsSchema>;

/** 校验 job：对既有排钻任务的产物跑 validate + exportGate（ok=false=任务失败+violations）。 */
export const ValidateJobParamsSchema = z
  .object({
    op: z.literal('validate'),
    paveTaskId: IdSchema,
  })
  .strict();

/** 导出 job：SVG/BOM（+PNG）三产物 → results 行 + public_id 分享包。 */
export const ExportJobParamsSchema = z
  .object({
    op: z.literal('export'),
    paveTaskId: IdSchema,
    /** 服务端 PNG（软光栅）；缺省 true */
    withPng: z.boolean().default(true),
  })
  .strict();

export const EngineJobParamsSchema = z.discriminatedUnion('op', [
  PaveJobParamsSchema,
  ValidateJobParamsSchema,
  ExportJobParamsSchema,
]);
export type EngineJobParams = z.infer<typeof EngineJobParamsSchema>;

export const TaskCreateInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sleep'), params: SleepJobParamsSchema }).strict(),
  z.object({ kind: z.literal('generate'), params: GenerateJobParamsSchema }).strict(),
  z.object({ kind: z.literal('engine'), params: EngineJobParamsSchema }).strict(),
]);
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

// ---------------------------------------------------------------- 任务视图

/** 任务结果视图（export job 产物；found 显式双态同 session 面语义）。 */
export const TaskResultViewSchema = z
  .object({
    resultId: IdSchema,
    publicId: z.string().min(1).optional(),
    bundle: ResultBundleSchema,
  })
  .strict();
export type TaskResultView = z.infer<typeof TaskResultViewSchema>;

export const TaskViewSchema = z
  .object({
    taskId: IdSchema,
    type: TaskKindSchema,
    /** job 族的 job 类别（agent 任务无此字段） */
    kind: JobKindSchema.optional(),
    status: TaskStatusSchema,
    /** 失败原因（status=failed 时呈现） */
    error: z.string().optional(),
    result: TaskResultViewSchema.optional(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type TaskView = z.infer<typeof TaskViewSchema>;

/** 任务创建即返回完整视图（taskId 等全字段——与 get 同形）。 */
export const TaskCreateOutputSchema = TaskViewSchema;
export type TaskCreateOutput = TaskView;

export const TaskGetInputSchema = z.object({ taskId: IdSchema }).strict();
export const TaskGetOutputSchema = z.object({ task: TaskViewSchema }).strict();
export type TaskGetInput = z.infer<typeof TaskGetInputSchema>;
export type TaskGetOutput = z.infer<typeof TaskGetOutputSchema>;

export const TaskListOutputSchema = z.object({ tasks: z.array(TaskViewSchema) }).strict();
export type TaskListOutput = z.infer<typeof TaskListOutputSchema>;

export const TaskCancelInputSchema = z.object({ taskId: IdSchema }).strict();
export const TaskCancelOutputSchema = z.object({ ok: z.boolean() }).strict();
export type TaskCancelInput = z.infer<typeof TaskCancelInputSchema>;
export type TaskCancelOutput = z.infer<typeof TaskCancelOutputSchema>;

/** 帧回放（游标以 task 为域；与 session.replay 同形）。 */
export const TaskFramesInputSchema = z
  .object({
    taskId: IdSchema,
    /** 0=全量 */
    afterSeq: z.number().int().nonnegative().default(0),
  })
  .strict();
export const TaskFramesOutputSchema = z
  .object({
    frames: z.array(FrameSchema),
    /** 窗口后游标（无帧时=afterSeq 原值） */
    nextSeq: z.number().int().nonnegative(),
  })
  .strict();
export type TaskFramesInput = z.infer<typeof TaskFramesInputSchema>;
export type TaskFramesOutput = z.infer<typeof TaskFramesOutputSchema>;
