/**
 * VLM 全图语义分析工具 `scene.analyze`（add-subject-sam-pipeline P2.3 / design §1 S2）。
 * 原始需求 2026-09-24（Owner 定调：视觉大模型先把图是什么、里面有什么元素分析出来，
 * 然后才用 SAM3 迭代抠图——VLM 先行识图是管线主驱动；产物留存可审查）。
 * 双通道决策树（design S2 行：VLM 经既有 LLM 路由，macmini 桥候选）：
 *   通道 A（桥 analyze）：装配了 SAM 桥且桥支持 VLM 分析时优先走桥（并发 1 队列+
 *     留存归桥面）；桥返回 unsupported（SamBridgeError kind='unimplemented'——
 *     SshSamTransport 占位/P2.1 macmini 侧未上报 VLM 能力时的语义）→ 显式降通道 B
 *     （console.warn + 结果面 demotedFrom——不留静默）；桥的其他 operational 失败
 *     （timeout/transport/invalid-response/fence/queue-full…）不降级、typed 上抛
 *     （可用性降级归 P2.5 一键模式职责）。
 *   通道 B（LLM 路由）：经 daemon 既有 LLM 配置（model-route resolveSingleRoute，
 *     openai-completions 冻结协议）调视觉模型——图 base64 进消息 content 的
 *     image_url（data URL）；响应 → JSON 抽取（fenced/裸 JSON 容错）→ elements
 *     schema 校验（拒 → typed error 携原文摘要）→ 锚点由 daemon 真源回填组装
 *     SceneAnalysis（P0.1 冻结 schema）。
 * 真连开关：env SAM_ANALYZE_LIVE=1 才真实外呼（缺省 mock 语义=通道 B typed 拒
 * 'live-disabled'）——真连冒烟归 P2.6，本波只留通道+开关。LLM key 只走 env→config
 * （model-route 纪律），不入库不入留存。
 * 正交意图：
 *   [1] 输入校验与锚点完整性：taskId/imageBlobRef/canvasCm/imagePx/instruction +
 *       原图存在性+PNG 解码+尺寸与 imagePx 一致（bbox 锚点错位必拒——tree-persist
 *       同款纪律）+W1 入线降采样（物理密度超目标→锚点图重建：面积降采 PNG 落任务
 *       工件域 intake-image.png+imagePx/imageBlobRef 同源更新——两通道与下游全链
 *       天然在新坐标系，不在中途二次缩放）。
 *   [2] 双通道编排：桥优先→unsupported 显式降级→LLM 路由；产物=SceneAnalysis JSON
 *       工件（putTaskArtifact——fence 同事务）+ artifact 帧登记（jobs.emitFor——
 *       P3.3-fix：tasks.artifact 合法集=帧∪附件，UI provider 经帧流取工件）+
 *       交换留存（scene-analyze-logs——「输出留存可审查」；不含 apiKey、不含图 base64）。
 *   [3] 通道 B 线面：openai-completions chat/completions（stream:false、
 *       temperature 0、max_tokens 有界、超时界、redirect 拒跨域）+ 响应 JSON
 *       抽取容错 + typed error 分类（route 未配置/live 关/HTTP 坏/坏 JSON/schema 拒）。
 *   [4] 工具面注册：studio.scene.analyze（readonly 直调——MCP 投影
 *       mcp__studio__scene_analyze，过 tool-surface deny 名单；RUNAWAY 熔断照
 *       studio.ts 先例）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  CanvasCmSchema,
  ImagePxSchema,
  SceneAnalysisSchema,
  SceneElementSchema,
  type CanvasCm,
  type ImagePx,
  type SceneAnalysis,
  type SceneElement,
} from '@handicraft/contracts';
import type { LlmConfig } from '../../config.js';
import type { BlobStore } from '../../db/blobs.js';
import type { SqliteDb } from '../../db/database.js';
import type { JobService } from '../../jobs/service.js';
import { putTaskArtifact } from '../../jobs/service.js';
import { decodePng, encodePng } from '../../png/codec.js';
import {
  createCapabilityRegistry,
  type CapabilityCallResult,
  type CapabilityRegistry,
} from '../../capability/core.js';
import { RUNAWAY_LIMIT } from '../../capability/studio.js';
import { ArtifactFenceError } from '../../writer-fence.js';
import {
  planIntakeResample,
  resolveIntakeResampleConfig,
  resampleRgbaArea,
  type IntakeResampleConfig,
} from './intake-resample.js';
import { resolveSingleRoute, type StudioModelRoute } from '../model-route.js';
import { loadDefault, loadKeys, loadRoutes, modelsSettingsInitialized } from '../../models-store.js';
import { makeAnalyzeRequest, SamBridgeError, type SamBridge } from './sam-bridge.js';

/** 真连开关 env 键（=1 才真实外呼；缺省 mock——通道 B typed 拒 live-disabled）。 */
export const SAM_ANALYZE_LIVE_ENV = 'SAM_ANALYZE_LIVE';

/** 通道 B LLM 调用超时界（对齐 SAM_REQUEST_TIMEOUT_MS 的 120s 量级）。 */
export const SCENE_ANALYZE_LLM_TIMEOUT_MS = 120_000;

/** 通道 B max_tokens 有界（元素清单 JSON 实测量级 ~3k；8k 上界防失控）。 */
export const SCENE_ANALYZE_LLM_MAX_TOKENS = 8192;

/** 交换留存根目录名（DATA_ROOT 下——与 sam-logs 同纪律的 S2 留存面）。 */
export const SCENE_ANALYZE_LOGS_DIRNAME = 'scene-analyze-logs';

/** 工具面名（MCP 投影 mcp__studio__scene_analyze——studio. 前缀过 deny 名单）。 */
export const SCENE_ANALYZE_TOOL_NAME = 'studio.scene.analyze';

/** scene-analysis 工件帧名（tasks.artifact 合法集=帧∪附件——P3.3-fix UI 前置）。 */
export const SCENE_ANALYSIS_ARTIFACT_NAME = 'scene-analysis.json';

/**
 * W1 入线降采样锚点图工件帧名（降采实际发生时才落档+登记——审计面：管线实际
 * 看到的图；透传路径零噪声）。
 */
export const INTAKE_IMAGE_ARTIFACT_NAME = 'intake-image.png';

/** 通道 A 缺省分析指令（用户 instruction 缺席时的桥 VLM 指令文本）。 */
export const DEFAULT_ANALYZE_INSTRUCTION =
  '分析整图：列出全部视觉元素（主体及其部件，中文命名），并标注每个元素是否值得贴钻（大面积黑背景/强灯光类=不值得）。';

// ---------------------------------------------------------------- 输入 schema

const TaskIdField = z
  .string()
  .min(1)
  .describe('当前 agent 任务 id（followup 注入提示中的 taskId——工件归属与 fence 的上下文）');

const BlobRefField = z.string().regex(/^[0-9a-f]{64}$/).describe('归一底图 blobRef（S0 产物）');

/** 工具输入（也是 analyzeScene 核心 API 入口 schema——taskId 必给：工件+fence 需要）。 */
export const SceneAnalyzeToolInputSchema = z
  .object({
    taskId: TaskIdField,
    imageBlobRef: BlobRefField,
    canvasCm: CanvasCmSchema.describe('画布物理尺寸声明（cm——S1 一等输入，随工件留存）'),
    imagePx: ImagePxSchema.describe('归一底图像素尺寸（boxPx 锚点坐标系）'),
    instruction: z.string().min(1).optional().describe('补充分析指令（缺席=缺省全图元素清单指令）'),
  })
  .strict();
export type SceneAnalyzeInput = z.infer<typeof SceneAnalyzeToolInputSchema>;

// ---------------------------------------------------------------- typed error

export type SceneAnalyzeErrorKind =
  | 'invalid-input'
  | 'image-missing'
  | 'image-decode-failed'
  | 'bridge-failed'
  | 'llm-route-unconfigured'
  | 'live-disabled'
  | 'llm-call-failed'
  | 'llm-bad-json'
  | 'llm-invalid-elements'
  | 'fence'
  | 'internal';

/** scene.analyze 统一 typed error（沿 SamBridgeError/ImageApiError kind 先例）。 */
export class SceneAnalyzeError extends Error {
  readonly kind: SceneAnalyzeErrorKind;

  constructor(message: string, kind: SceneAnalyzeErrorKind, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SceneAnalyzeError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------- 结果面

/**
 * W1 入线降采样结果面（outcome 携带——调用方/Agent 必须以本面的 imageBlobRef/
 * imagePx 为后续锚点；applied=false 时=入参原值透传）。
 */
export interface SceneAnalyzeIntake {
  applied: boolean;
  /** 降采后实际锚点图（applied=false 时=入参原值）。 */
  imageBlobRef: string;
  imagePx: ImagePx;
  /** applied 时的入参原锚点（审计：from→to 可追溯）。 */
  fromImageBlobRef?: string;
  fromImagePx?: ImagePx;
  /** applied 时=触发原因（density-cap=物理密度超目标；edge-fallback=无物理尺寸兜底）。 */
  reason?: 'density-cap' | 'edge-fallback';
  /** 入线密度 px/cm（canvasCm 在场时；透传时前后相等）。 */
  ppcmBefore?: number;
  ppcmAfter?: number;
}

/** 交换留存落点（scene-analyze-logs 下本次调用落盘文件——绝对路径）。 */
export interface SceneAnalyzeRetention {
  dir: string;
  exchangeJson: string;
}

export interface SceneAnalyzeOutcome {
  /** P0.1 冻结工件（elements+锚点——channel B 时锚点由 daemon 真源回填）。 */
  analysis: SceneAnalysis;
  /** 实际承载通道（桥 analyze / LLM 路由）。 */
  channel: 'bridge' | 'llm-route';
  /** 桥 unsupported 显式降级记录（不留静默——结果面可见的降通道事实）。 */
  demotedFrom?: 'bridge-unsupported';
  /** scene-analysis.json 工件 blobRef（putTaskArtifact——内容寻址）。 */
  artifactBlobRef: string;
  /** W1 入线降采样结果（后续锚点真源——analysis 同源）。 */
  intakeResample: SceneAnalyzeIntake;
  meta: { model: string; durationMs: number };
  retention: SceneAnalyzeRetention;
}

// ---------------------------------------------------------------- 依赖与选项

export interface SceneAnalyzerDeps {
  db: SqliteDb;
  blobs: BlobStore;
  /** DATA_ROOT（scene-analyze-logs 留存根）。 */
  dataRoot: string;
  /** 既有 LLM 配置（env 真源——key 绝不入库）。 */
  llm: LlmConfig;
  /** SAM 桥（缺省不装配=直走通道 B；P2.4/P2.6 接线共享实例）。 */
  bridge?: Pick<SamBridge, 'run'>;
  /** 帧提交单点（scene-analysis 工件帧登记——subject.segment emitArtifacts 先例；缺席=不登记帧，仅落工件）。 */
  jobs?: Pick<JobService, 'emitFor'>;
}

export interface SceneAnalyzerOptions {
  /** 真连开关（缺省 env SAM_ANALYZE_LIVE==='1'；测试注入 true+本地 mock 网关）。 */
  live?: boolean;
  /** fetch 替身（测试注入本地 mock 网关；缺省 globalThis.fetch——live 才会触达）。 */
  fetchImpl?: typeof globalThis.fetch;
  /** 视觉模型名（缺省 config.llm.visionModel → 路由 model 兜底）。 */
  visionModel?: string;
  /** LLM 调用超时界（ms）——测试短界注入。 */
  timeoutMs?: number;
  /** W1 入线降采配置直注（优先——测试注入定值；在场时 provider 不被调用）。 */
  intakeConfig?: IntakeResampleConfig;
  /**
   * W1 入线降采配置 provider（add-image-processing-settings design §5.1——调用时
   * 解析面）：每次 analyze() 取值一次，改设置对下一次调用立即生效（不重启实例）；
   * kernel 装配注入 imageProcessingEffective(db) 投影。解析顺序=直注 intakeConfig →
   * provider → env（resolveIntakeResampleConfig——双双缺席的缺省面）。
   */
  intakeConfigProvider?: () => IntakeResampleConfig;
}

// ---------------------------------------------------------------- JSON 抽取容错

/** LLM 输出 → JSON 文本（fenced ```json / ``` 剥壳；前后缀噪声取首 { 到尾 }）。 */
export function extractJsonText(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenceMatch !== null) return fenceMatch[1]!.trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

/** openai-completions 响应体 → 文本 content（string 直取；parts 数组拼 text 段）。 */
function extractOpenaiContentText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'text'
          ? (part as { text?: unknown }).text
          : undefined,
      )
      .filter((piece): piece is string => typeof piece === 'string');
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

/** anthropic-messages 响应体 → 文本（content[] 的 text 块拼接）。 */
function extractAnthropicContentText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const content = (body as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((block) =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text'
        ? (block as { text?: unknown }).text
        : undefined,
    )
    .filter((piece): piece is string => typeof piece === 'string');
  return parts.length > 0 ? parts.join('\n') : null;
}

/** openai-responses 响应体 → 文本（output_text 直取，否则 output[].content[].output_text 拼接）。 */
function extractResponsesContentText(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const direct = (body as { output_text?: unknown }).output_text;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const output = (body as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  const parts: string[] = [];
  for (const item of output) {
    if (typeof item !== 'object' || item === null) continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'output_text' &&
        typeof (block as { text?: unknown }).text === 'string'
      ) {
        parts.push((block as { text: string }).text);
      }
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/** 三协议响应体 → 文本 content（协议适配面——split-admin-portal 2.5）。 */
export function extractLlmContentText(api: string, body: unknown): string | null {
  switch (api) {
    case 'anthropic-messages':
      return extractAnthropicContentText(body);
    case 'openai-responses':
      return extractResponsesContentText(body);
    default:
      return extractOpenaiContentText(body);
  }
}

// ---------------------------------------------------------------- 通道 B 路由真源（split-admin-portal 2.5）

/** 视觉路由解析结果（settings 真源优先；env 仅迁移引导回退）。 */
export interface VisionLlmRoute extends StudioModelRoute {
  /** 路由来源（settings=后台多路由真源；env=.env LLM_* 迁移引导回退）。 */
  source: 'settings' | 'env';
}

/**
 * 通道 B 路由真源统一（split-admin-portal 2.5——Codex 暗坑收口）：后台模型路由
 * （settings 表 models_*，loadRoutes 含 .env 迁移收编物化——zhumo 方案块 A 同源）
 * 优先；settings 从未初始化且 .env LLM_* 完整时回退旧单路由链（明确 warning——
 * 迁移引导语义）。已初始化的空路由集=「未配置」真源意图，.env 不复活（v6 P1-3）。
 * 坏协议配置（.env LLM_API 非法值）=配置错误，resolveSingleRoute 原样上抛。
 */
export function resolveVisionLlmRoute(db: SqliteDb, llm: LlmConfig): VisionLlmRoute | null {
  const routes = loadRoutes(db, llm);
  const keys = loadKeys(db);
  const keyed = routes.filter((route) => Boolean(keys[route.provider]));
  if (keyed.length > 0) {
    const def = loadDefault(db, routes);
    const host = keyed.find((route) => route.provider === def?.provider) ?? keyed[0]!;
    const model =
      def !== null && host.models.some((entry) => entry.id === def.model)
        ? def.model
        : host.models[0]?.id ?? '';
    return {
      provider: host.provider,
      api: host.api,
      baseURL: host.baseURL,
      apiKey: keys[host.provider]!,
      model,
      contextWindow: host.models.find((entry) => entry.id === model)?.contextWindow ?? 131072,
      source: 'settings',
    };
  }
  if (modelsSettingsInitialized(db)) return null; // 已初始化（含显式清空）——env 不复活
  const legacy = resolveSingleRoute(llm);
  if (legacy !== null) {
    console.warn(
      '[scene.analyze] settings 无可用模型路由——回退 .env LLM_* 单路由（迁移引导；后台保存模型配置后以 settings 为真源）',
    );
    return { ...legacy, source: 'env' };
  }
  return null;
}

// ---------------------------------------------------------------- 通道 B 三协议线面（split-admin-portal 2.5）

/** 视觉调用线请求（协议适配产物——url/headers/body 一次成型，fetch 只管发送）。 */
export interface VisionLlmWireRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * 三协议视觉请求构造（openai-completions / anthropic-messages / openai-responses
 * ——与后台 models 三协议值域及 test-route-connection 探测矩阵一致）。图字节走
 * base64（openai 系 data URL；anthropic source 块）。未知协议抛错（配置错误面）。
 */
export function buildVisionLlmWireRequest(
  route: Pick<StudioModelRoute, 'baseURL' | 'apiKey' | 'api'>,
  model: string,
  promptText: string,
  image: { base64: string; mime: 'image/png' | 'image/jpeg' | 'image/webp' },
  maxTokens: number,
): VisionLlmWireRequest {
  const base = route.baseURL.trim().replace(/\/+$/, '');
  const dataUrl = `data:${image.mime};base64,${image.base64}`;
  switch (route.api) {
    case 'anthropic-messages':
      return {
        url: `${base}/v1/messages`,
        headers: {
          'content-type': 'application/json',
          'x-api-key': route.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                { type: 'image', source: { type: 'base64', media_type: image.mime, data: image.base64 } },
              ],
            },
          ],
        }),
      };
    case 'openai-responses':
      return {
        url: `${base}/responses`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({
          model,
          input: [
            {
              role: 'user',
              content: [
                { type: 'input_text', text: promptText },
                { type: 'input_image', image_url: dataUrl },
              ],
            },
          ],
          temperature: 0,
          max_output_tokens: maxTokens,
        }),
      };
    case 'openai-completions':
      return {
        url: `${base}/chat/completions`,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${route.apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: promptText },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            },
          ],
          temperature: 0,
          max_tokens: maxTokens,
          stream: false,
        }),
      };
    default:
      throw new Error(`不支持的视觉路由协议：${route.api}（openai-completions / anthropic-messages / openai-responses）`);
  }
}

/** 原文摘要（typed error 携带——截断防日志爆炸）。 */
function excerpt(text: string, max = 300): string {
  return text.length <= max ? text : `${text.slice(0, max)}…（共 ${text.length} 字符）`;
}

/** 桥错误 → 是否 unsupported（kind='unimplemented' 直判+cause 链穿透——桥把传输失败包成 transport，原 kind 在 cause 里）。 */
function isBridgeUnsupported(error: unknown): boolean {
  let current: unknown = error;
  while (current instanceof SamBridgeError) {
    if (current.kind === 'unimplemented') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ---------------------------------------------------------------- 通道 B 提示词

/**
 * 通道 B 用户消息文本（openai-completions content[0].text）——v2 Scene Graph 层级
 * 语义（realize-scene-understanding T1 / Codex B1：parent 必须是显式、稳定的语义
 * 引用，不从名称或 bbox 包含关系事后猜测）。
 */
export function buildLlmPrompt(input: { imagePx: ImagePx; instruction?: string }): string {
  return [
    '你是贴钻产线的全图语义分析器（管线 S2——Scene Graph 层级语义）。分析这张图片，列出全部视觉元素及其语义层级归属，只输出一个 JSON 对象（禁止 JSON 以外的文字）：',
    '{"elements":[{"elementId":"el-1","parentElementId":null,"relation":"semantic","name":"中文名","category":"object","boxPx":{"x":0,"y":0,"w":1,"h":1},"hint":"english prompt","suggestDrillWorthy":true,"confidence":0.9}]}',
    '字段约束：',
    '- elementId：稳定元素 id（本清单内唯一；建议 el-1/el-2 递增——parentElementId 的寻址键）。',
    '- parentElementId：语义父元素的 elementId；独立前景对象/顶层主体填 null。归属按视觉语义判断（如「左手」→「小丑」），不确定归属的独立对象挂顶层，不要按名称或包围盒包含关系猜测。',
    '- relation：挂靠关系——semantic=语义解剖部位（手/脸/上衣）；refinement=某主体的细分区域（条纹/色块等无独立语义的可拆分区）。',
    '- name：中文语义名（路灯/草地/人物/房子/马车…）。',
    '- category：英文类别词（structure/foliage/face/light/background/object 等——与 ObjectNode.category 同词表）。',
    `- boxPx：元素像素包围盒（左上原点；x,y≥0；w,h≥1；不得超出图像边界 ${input.imagePx.width}×${input.imagePx.height}）。`,
    '- hint：英文语义提示词，供 SAM3 语义抠图（如 person/hat/street lamp/tree）。',
    '- suggestDrillWorthy：该元素是否值得贴钻（大面积黑背景/强灯光=false；用户后续可改）。',
    '- confidence：0 到 1。',
    input.instruction !== undefined ? `补充指令：${input.instruction}` : '缺省指令：覆盖图中全部可辨识的主体与部件（含层级归属——主体→部位）。',
  ].join('\n');
}

// ---------------------------------------------------------------- 分析器本体

/**
 * scene.analyze 执行器（无后台任务——每请求 fetch 有超时界，零常驻定时器/连接）。
 * 落定保证：全路径 typed reject（SceneAnalyzeError）或 SceneAnalyzeOutcome resolve。
 */
export class SceneAnalyzer {
  private readonly live: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly visionModel: string | undefined;
  private readonly timeoutMs: number;
  /** 直注配置（优先——在场时 provider/env 均不参与）。 */
  private readonly intakeConfig: IntakeResampleConfig | undefined;
  /** 调用时解析面（add-image-processing-settings §5.1——每次 analyze 取值，不缓存）。 */
  private readonly intakeConfigProvider: (() => IntakeResampleConfig) | undefined;
  private seq = 0;

  constructor(
    private readonly deps: SceneAnalyzerDeps,
    options: SceneAnalyzerOptions = {},
  ) {
    this.live = options.live ?? process.env[SAM_ANALYZE_LIVE_ENV] === '1';
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.visionModel = options.visionModel;
    this.timeoutMs = options.timeoutMs ?? SCENE_ANALYZE_LLM_TIMEOUT_MS;
    // 构造期不固化（add-image-processing-settings §5.1：改设置立即生效——analyze 时解析）
    this.intakeConfig = options.intakeConfig;
    this.intakeConfigProvider = options.intakeConfigProvider;
  }

  /** 双通道编排入口（工具面/直接调用共用——失败面全部 typed）。 */
  async analyze(rawInput: unknown): Promise<SceneAnalyzeOutcome> {
    const parsed = SceneAnalyzeToolInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new SceneAnalyzeError(
        `scene.analyze 输入不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
        'invalid-input',
        { cause: parsed.error },
      );
    }
    const input = parsed.data;
    const startedAt = Date.now();
    let channel: 'bridge' | 'llm-route' = this.deps.bridge !== undefined ? 'bridge' : 'llm-route';
    let demotedFrom: 'bridge-unsupported' | undefined;

    // —— 锚点完整性前置（两通道共用：bbox 坐标系错位必拒，不送模型）
    const imageBytes = this.deps.blobs.read(input.imageBlobRef);
    if (imageBytes === null) {
      throw new SceneAnalyzeError(
        `原图 blob 不存在（blobRef=${input.imageBlobRef.slice(0, 12)}…）`,
        'image-missing',
      );
    }
    let decoded: { width: number; height: number; rgba: Uint8Array };
    try {
      decoded = decodePng(imageBytes);
    } catch (error) {
      throw new SceneAnalyzeError(
        `原图解码失败（仅支持 PNG——S0 归一面）：${error instanceof Error ? error.message : String(error)}`,
        'image-decode-failed',
        { cause: error },
      );
    }
    if (decoded.width !== input.imagePx.width || decoded.height !== input.imagePx.height) {
      throw new SceneAnalyzeError(
        `imagePx 与原图尺寸不符（${input.imagePx.width}×${input.imagePx.height} ≠ 实际 ${decoded.width}×${decoded.height}）——boxPx 锚点错位，拒绝分析`,
        'image-decode-failed',
      );
    }

    // —— W1 入线降采样（物理密度超目标→锚点图重建；effective 三元组=后续唯一真源）
    const intake = this.applyIntakeResample(input, decoded, imageBytes);

    try {
      let outcome: SceneAnalyzeOutcome;
      if (this.deps.bridge !== undefined) {
        try {
          outcome = await this.analyzeViaBridge(
            this.deps.bridge,
            intake.effective,
            startedAt,
            intake.intake,
          );
        } catch (error) {
          if (!(error instanceof SamBridgeError) || !isBridgeUnsupported(error)) {
            // 桥 operational 失败（timeout/transport/invalid-response/fence/queue-full…）
            // ——不静默降级，typed 上抛（可用性降级归 P2.5 管线层职责）。
            if (error instanceof SceneAnalyzeError) throw error;
            throw new SceneAnalyzeError(
              `桥通道 analyze 失败：${error instanceof Error ? error.message : String(error)}`,
              'bridge-failed',
              { cause: error },
            );
          }
          channel = 'llm-route';
          demotedFrom = 'bridge-unsupported';
          console.warn(
            '[scene.analyze] SAM 桥不支持 VLM analyze（unimplemented）——显式降通道 B（LLM 路由）',
          );
          outcome = await this.analyzeViaLlmRoute(
            intake.effective,
            startedAt,
            demotedFrom,
            intake.imageBytes,
            intake.intake,
          );
        }
      } else {
        outcome = await this.analyzeViaLlmRoute(
          intake.effective,
          startedAt,
          undefined,
          intake.imageBytes,
          intake.intake,
        );
      }
      return outcome;
    } catch (error) {
      const typed =
        error instanceof SceneAnalyzeError
          ? error
          : new SceneAnalyzeError(
              `scene.analyze 内部错误：${error instanceof Error ? error.message : String(error)}`,
              'internal',
              { cause: error },
            );
      // 失败也留存（LLM 原文/错误面可审查——sam-bridge 同纪律）；留存失败不掩盖原错误。
      try {
        this.writeRetention({
          startedAt,
          channel,
          outcome: `error:${typed.kind}`,
          ...(demotedFrom !== undefined ? { demotedFrom } : {}),
          request: input,
          intake: intake.intake,
          error: `${typed.name}[${typed.kind}]: ${typed.message}`,
        });
      } catch (retentionError) {
        console.warn('[scene.analyze] 失败留存写入异常（不掩盖原错误）', retentionError);
      }
      throw typed;
    }
  }

  /**
   * W1 入线降采样（纯本地确定性——无模型参与）：plan → 面积降采 → PNG 落任务工件域
   * （putTaskArtifact fence 同事务）+ intake-image.png 帧登记。透传时零写入零帧。
   * 返回 effective 三元组：后续两通道/工件/留存共用（入线一次，全链同源）。
   */
  private applyIntakeResample(
    input: SceneAnalyzeInput,
    decoded: { width: number; height: number; rgba: Uint8Array },
    imageBytes: Uint8Array,
  ): { effective: SceneAnalyzeInput; imageBytes: Uint8Array; intake: SceneAnalyzeIntake } {
    // 调用时解析（每次 analyze 一次）：直注 → provider → env 缺省——改设置立即生效不重启。
    const intakeConfig =
      this.intakeConfig ?? this.intakeConfigProvider?.() ?? resolveIntakeResampleConfig();
    const plan = planIntakeResample(
      { width: decoded.width, height: decoded.height, canvasCm: input.canvasCm },
      intakeConfig,
    );
    if (!plan.resampled) {
      const { ppcmBefore, ppcmAfter } = plan;
      return {
        effective: input,
        imageBytes,
        intake: {
          applied: false,
          imageBlobRef: input.imageBlobRef,
          imagePx: input.imagePx,
          ...(ppcmBefore !== null && ppcmAfter !== null ? { ppcmBefore, ppcmAfter } : {}),
        },
      };
    }
    const rgba = resampleRgbaArea(decoded.rgba, decoded.width, decoded.height, plan.width, plan.height);
    const png = encodePng(plan.width, plan.height, rgba);
    let blobRef: string;
    try {
      blobRef = putTaskArtifact(this.deps, input.taskId, png).hash;
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new SceneAnalyzeError(
          `入线降采样图写入被 fence 拒绝（任务 ${input.taskId} 已不可写）：${error.message}`,
          'fence',
          { cause: error },
        );
      }
      throw error;
    }
    this.deps.jobs?.emitFor(input.taskId, 'artifact', {
      blobRef,
      name: INTAKE_IMAGE_ARTIFACT_NAME,
    });
    const imagePx = { width: plan.width, height: plan.height };
    const reason: 'density-cap' | 'edge-fallback' =
      plan.reason === 'edge-fallback' ? 'edge-fallback' : 'density-cap';
    const { ppcmBefore, ppcmAfter } = plan;
    return {
      effective: { ...input, imageBlobRef: blobRef, imagePx },
      imageBytes: png,
      intake: {
        applied: true,
        imageBlobRef: blobRef,
        imagePx,
        fromImageBlobRef: input.imageBlobRef,
        fromImagePx: input.imagePx,
        reason,
        ...(ppcmBefore !== null && ppcmAfter !== null ? { ppcmBefore, ppcmAfter } : {}),
      },
    };
  }

  /** 通道 A：桥 analyze（请求构造/队列/超时/留存归 sam-bridge；本层只组装工件）。 */
  private async analyzeViaBridge(
    bridge: Pick<SamBridge, 'run'>,
    input: SceneAnalyzeInput,
    startedAt: number,
    intake: SceneAnalyzeIntake,
  ): Promise<SceneAnalyzeOutcome> {
    // 桥 typed error（含 unsupported 的 cause 链）原样穿透——判定/包装在 analyze 编排层。
    const result = await bridge.run(
      makeAnalyzeRequest({
        taskId: input.taskId,
        imageBlobRef: input.imageBlobRef,
        imagePx: input.imagePx,
        canvasCm: input.canvasCm,
        prompt: { kind: 'text', text: input.instruction ?? DEFAULT_ANALYZE_INSTRUCTION },
      }),
    );
    if (result.kind !== 'analyze') {
      throw new SceneAnalyzeError(
        `桥响应 kind 不匹配（期望 analyze，实为 ${result.kind}）`,
        'bridge-failed',
      );
    }
    const durationMs = Date.now() - startedAt;
    const analysis = this.assembleAnalysis(input, result.elements, true);
    const artifactBlobRef = this.persistArtifact(input.taskId, analysis);
    const retention = this.writeRetention({
      startedAt,
      channel: 'bridge',
      outcome: 'ok',
      request: input,
      intake,
      model: result.meta.model,
      artifactBlobRef,
      bridgeExchangeJson: result.retention.exchangeJson,
    });
    return {
      analysis,
      channel: 'bridge',
      artifactBlobRef,
      intakeResample: intake,
      meta: { model: result.meta.model, durationMs },
      retention,
    };
  }

  /** 通道 B：LLM 路由（三协议视觉调用→JSON 抽取→schema 校验→组装）。 */
  private async analyzeViaLlmRoute(
    input: SceneAnalyzeInput,
    startedAt: number,
    demotedFrom: 'bridge-unsupported' | undefined,
    imageBytes: Uint8Array,
    intake: SceneAnalyzeIntake,
  ): Promise<SceneAnalyzeOutcome> {
    // —— 路由解析（split-admin-portal 2.5 统一：后台多路由真源 settings 优先，
    //    .env LLM_* 迁移引导回退——与内核 agent 会话同真源；坏协议配置=配置错误
    //    typed 呈现；未配置 typed 拒）。
    let route: VisionLlmRoute | null;
    try {
      route = resolveVisionLlmRoute(this.deps.db, this.deps.llm);
    } catch (error) {
      throw new SceneAnalyzeError(
        `LLM 路由配置错误：${error instanceof Error ? error.message : String(error)}`,
        'llm-route-unconfigured',
        { cause: error },
      );
    }
    if (route === null) {
      throw new SceneAnalyzeError(
        'LLM 路由未配置（LLM_API_KEY 缺失且后台模型路由无可用项）——视觉模型不可用（VLM 全图分析需要已配置的模型路由）',
        'llm-route-unconfigured',
      );
    }
    const explicitModel = (this.visionModel ?? this.deps.llm.visionModel).trim();
    const resolvedModel = explicitModel !== '' ? explicitModel : route.model;
    if (!this.live) {
      throw new SceneAnalyzeError(
        `scene.analyze 真连未开启（env ${SAM_ANALYZE_LIVE_ENV}=1 才真实外呼；缺省 mock 语义——真连冒烟归 P2.6）`,
        'live-disabled',
      );
    }

    let wire: VisionLlmWireRequest;
    try {
      wire = buildVisionLlmWireRequest(
        route,
        resolvedModel,
        buildLlmPrompt(input),
        { base64: Buffer.from(imageBytes).toString('base64'), mime: 'image/png' },
        SCENE_ANALYZE_LLM_MAX_TOKENS,
      );
    } catch (error) {
      throw new SceneAnalyzeError(
        `视觉路由协议构造失败：${error instanceof Error ? error.message : String(error)}`,
        'llm-route-unconfigured',
        { cause: error },
      );
    }
    let contentText: string | null = null;
    try {
      const response = await this.fetchImpl(wire.url, {
        method: 'POST',
        headers: wire.headers,
        body: wire.body,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error', // 网关直连 https；跨域重定向=配置漂移面（imgapi 同款纪律）
      });
      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        throw new SceneAnalyzeError(
          `视觉模型 HTTP ${response.status}：${excerpt(bodyText, 200)}`,
          'llm-call-failed',
        );
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new SceneAnalyzeError('视觉模型响应不是 JSON 体', 'llm-call-failed');
      }
      contentText = extractLlmContentText(route.api, body);
      if (contentText === null) {
        throw new SceneAnalyzeError(
          `视觉模型响应无文本 content（原文摘要：${excerpt(JSON.stringify(body), 200)}）`,
          'llm-bad-json',
        );
      }
    } catch (error) {
      if (error instanceof SceneAnalyzeError) throw error;
      throw new SceneAnalyzeError(
        `视觉模型调用失败：${error instanceof Error ? error.message : String(error)}`,
        'llm-call-failed',
        { cause: error },
      );
    }

    // —— JSON 抽取（fenced/裸 JSON 容错）+ elements schema 校验（拒→原文摘要）
    let payload: unknown;
    try {
      payload = JSON.parse(extractJsonText(contentText));
    } catch (error) {
      throw new SceneAnalyzeError(
        `视觉模型输出无法解析为 JSON（原文摘要：${excerpt(contentText)}）`,
        'llm-bad-json',
        { cause: error },
      );
    }
    const elementsRaw =
      typeof payload === 'object' && payload !== null && 'elements' in payload
        ? (payload as { elements?: unknown }).elements
        : undefined;
    const elementsCheck = z.array(SceneElementSchema).min(1).safeParse(elementsRaw);
    if (!elementsCheck.success) {
      throw new SceneAnalyzeError(
        `视觉模型 elements 校验失败：${elementsCheck.error.issues.map((i) => i.message).join('; ')}（原文摘要：${excerpt(contentText)}）`,
        'llm-invalid-elements',
        { cause: elementsCheck.error },
      );
    }

    const durationMs = Date.now() - startedAt;
    const analysis = this.assembleAnalysis(input, elementsCheck.data, false);
    const artifactBlobRef = this.persistArtifact(input.taskId, analysis);
    const retention = this.writeRetention({
      startedAt,
      channel: 'llm-route',
      outcome: 'ok',
      ...(demotedFrom !== undefined ? { demotedFrom } : {}),
      request: input,
      intake,
      model: resolvedModel,
      responseText: contentText,
      artifactBlobRef,
    });
    return {
      analysis,
      channel: 'llm-route',
      ...(demotedFrom !== undefined ? { demotedFrom } : {}),
      artifactBlobRef,
      intakeResample: intake,
      meta: { model: resolvedModel, durationMs },
      retention,
    };
  }

  /**
   * 锚点回填组装（elements 之外的锚点字段一律 daemon 真源——模型只产元素清单）。
   * v2 关系格式（realize-scene-understanding T1）：formatVersion=2；桥通道（通道 A）
   * 的 elements 不带关系字段——daemon 派稳定 elementId（el-NNNN 递增）+
   * parentElementId=null（全顶层=显式平铺，不按名称猜 anatomy）；LLM 通道的 v2
   * 关系经 SceneAnalysisSchema superRefine 校验（坏关系 parse 拒）。
   */
  private assembleAnalysis(
    input: SceneAnalyzeInput,
    elements: SceneElement[],
    normalizeIds: boolean,
  ): SceneAnalysis {
    const normalized: SceneElement[] = normalizeIds
      ? elements.map((element, i) => ({
          ...element,
          elementId: `el-${String(i + 1).padStart(4, '0')}`,
          parentElementId: null,
        }))
      : elements;
    return SceneAnalysisSchema.parse({
      kind: 'scene-analysis',
      formatVersion: 2,
      imageBlobRef: input.imageBlobRef,
      canvasCm: input.canvasCm,
      imagePx: input.imagePx,
      elements: normalized,
      createdAt: new Date().toISOString(),
    });
  }

  /** SceneAnalysis JSON → 任务产物 blob（putTaskArtifact——fence 同事务）+ artifact 帧登记。 */
  private persistArtifact(taskId: string, analysis: SceneAnalysis): string {
    const json = Buffer.from(JSON.stringify(analysis, null, 1), 'utf8');
    let hash: string;
    try {
      hash = putTaskArtifact(this.deps, taskId, json).hash;
    } catch (error) {
      if (error instanceof ArtifactFenceError) {
        throw new SceneAnalyzeError(
          `scene-analysis 工件写入被 fence 拒绝（任务 ${taskId} 已不可写）：${error.message}`,
          'fence',
          { cause: error },
        );
      }
      throw error;
    }
    // artifact 帧登记（P3.2-channel 合法引用集=帧流 artifact 帧——subject.segment 先例；
    // 工件落档成功后 emit，两通道（桥/LLM 路由）共用本单点）。
    this.deps.jobs?.emitFor(taskId, 'artifact', { blobRef: hash, name: SCENE_ANALYSIS_ARTIFACT_NAME });
    return hash;
  }

  /** 交换留存：scene-analyze-logs/{date}/{taskId}/{seq}-{channel}-{startedAtMs}.json。 */
  private writeRetention(input: {
    startedAt: number;
    channel: 'bridge' | 'llm-route';
    outcome: string;
    demotedFrom?: 'bridge-unsupported';
    request: SceneAnalyzeInput;
    intake?: SceneAnalyzeIntake;
    model?: string;
    responseText?: string;
    artifactBlobRef?: string;
    bridgeExchangeJson?: string;
    error?: string;
  }): SceneAnalyzeRetention {
    const seq = ++this.seq;
    const date = new Date(input.startedAt).toISOString().slice(0, 10);
    const dir = path.join(this.deps.dataRoot, SCENE_ANALYZE_LOGS_DIRNAME, date, input.request.taskId);
    mkdirSync(dir, { recursive: true });
    const exchangeJson = path.join(
      dir,
      `${String(seq).padStart(4, '0')}-${input.channel}-${input.startedAt}.json`,
    );
    writeFileSync(
      exchangeJson,
      JSON.stringify(
        {
          seq,
          outcome: input.outcome,
          startedAt: new Date(input.startedAt).toISOString(),
          durationMs: Date.now() - input.startedAt,
          channel: input.channel,
          ...(input.demotedFrom !== undefined ? { demotedFrom: input.demotedFrom } : {}),
          // 留存纪律：不含 apiKey、不含图 base64（blobRef+尺寸可溯源）。
          request: {
            taskId: input.request.taskId,
            imageBlobRef: input.request.imageBlobRef,
            imagePx: input.request.imagePx,
            canvasCm: input.request.canvasCm,
            ...(input.request.instruction !== undefined
              ? { instruction: input.request.instruction }
              : {}),
          },
          // W1 入线降采样审计面（applied=false 透传也记录——决策可追溯）。
          ...(input.intake !== undefined ? { intakeResample: input.intake } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
          ...(input.responseText !== undefined ? { responseText: input.responseText } : {}),
          ...(input.artifactBlobRef !== undefined
            ? { artifactBlobRef: input.artifactBlobRef }
            : {}),
          ...(input.bridgeExchangeJson !== undefined
            ? { bridgeExchangeJson: input.bridgeExchangeJson }
            : {}),
          ...(input.error !== undefined ? { error: input.error } : {}),
        },
        null,
        1,
      ),
    );
    return { dir, exchangeJson };
  }
}

// ---------------------------------------------------------------- 工具面注册

export interface VisionCapabilitiesDeps {
  db: SqliteDb;
  blobs: BlobStore;
  dataRoot: string;
  llm: LlmConfig;
  /** SAM 桥（缺省不装配——通道 B；P2.4/P2.6 接线共享实例）。 */
  bridge?: Pick<SamBridge, 'run'>;
  /** 帧提交单点（scene-analysis 工件帧登记——kernel 接线注入）。 */
  jobs?: Pick<JobService, 'emitFor'>;
  /** 熔断回调（RUNAWAY_LIMIT 同 studio 面——按 taskId 分桶）。 */
  onRunaway?: (bucket: string, detail: string) => void;
  /** 分析器选项注入面（测试：live/fetchImpl/visionModel/timeoutMs）。 */
  analyzerOptions?: SceneAnalyzerOptions;
}

/**
 * vision 能力集（kernel 工具面注册——readonly 直调；MCP 投影
 * mcp__studio__scene_analyze 过 tool-surface deny 名单）。熔断/任务行校验照
 * capability/studio.ts 先例（RUNAWAY_LIMIT=5 同错连击；requireAgentTask 归属绑定）。
 */
export function createVisionCapabilities(deps: VisionCapabilitiesDeps): CapabilityRegistry {
  const analyzer = new SceneAnalyzer(
    { db: deps.db, blobs: deps.blobs, dataRoot: deps.dataRoot, llm: deps.llm, ...(deps.jobs !== undefined ? { jobs: deps.jobs } : {}) },
    deps.analyzerOptions,
  );
  const streaks = new Map<string, { key: string; count: number }>();

  function noteFailure(bucket: string, step: string, detail: string): CapabilityCallResult {
    const key = `${step}:${detail.slice(0, 200)}`;
    const streak = streaks.get(bucket);
    const count = streak?.key === key ? streak.count + 1 : 1;
    streaks.set(bucket, { key, count });
    if (count >= RUNAWAY_LIMIT) {
      const reason = `${step} 连续 ${count} 次相同失败（最后错误：${detail.slice(0, 120)}）`;
      deps.onRunaway?.(bucket, reason);
      return {
        kind: 'failed',
        code: 'INVALID_OPERATION',
        message: `熔断：${reason}。请停止重试，向用户报告失败原因。`,
      };
    }
    return { kind: 'failed', code: 'UNAVAILABLE', message: `${step} 失败：${detail.slice(0, 400)}` };
  }

  function noteSuccess(bucket: string): void {
    streaks.delete(bucket);
  }

  /** 任务行校验（studio.ts requireAgentTask 同款——MCP 面身份经 taskId 贯穿）。 */
  function requireAgentTask(taskId: string): void {
    const task = deps.db
      .prepare('SELECT id, type FROM tasks WHERE id = ?')
      .get(taskId) as { id: string; type: string } | undefined;
    if (!task) throw new Error(`任务不存在：${taskId}`);
    if (task.type !== 'agent') throw new Error(`任务不是 agent 会话任务：${taskId}`);
  }

  const definitions = [
    {
      name: SCENE_ANALYZE_TOOL_NAME,
      description:
        'VLM 全图语义分析（管线 S2——Scene Graph 层级语义 v2）：对归一底图做视觉大模型识图，返回 SceneAnalysis 工件'
        + '（elements[]{elementId 稳定 id,parentElementId 语义父（顶层 null）,relation semantic|refinement,'
        + 'name 中文名,category,boxPx 像素包围盒,hint 英文 SAM 提示,suggestDrillWorthy,confidence}+锚点）。'
        + '只读直调；产物 scene-analysis.json 入任务工件域（formatVersion=2 显式关系——树构建按 parentElementId '
        + '挂层级）。双通道：SAM 桥支持时优先桥（daemon 派 elementId 全顶层），否则走 LLM 路由（视觉模型）。'
        + '入线降采样（W1）：图物理密度（px/cm）超目标（缺省 25px/cm，PPCM_TARGET 10..50 可配；PPCM_RESAMPLE=0 关）'
        + '时锚点图面积降采重建——结果面 intakeResample 携实际锚点（imageBlobRef/imagePx），后续 subject.segment/'
        + 'workbench 一律以本产物锚点为准（入线一次，全链同源）。'
        + '后续 subject.segment 首轮提示取自本产物 elements（按拓扑序父先子后）。',
      authority: 'readonly' as const,
      input: SceneAnalyzeToolInputSchema,
      async handler(input: unknown): Promise<CapabilityCallResult> {
        const parsed = SceneAnalyzeToolInputSchema.safeParse(input);
        const bucket =
          typeof (input as { taskId?: unknown } | null | undefined)?.taskId === 'string' &&
          ((input as { taskId?: unknown }).taskId as string).length > 0
            ? ((input as { taskId: string }).taskId)
            : 'global';
        if (!parsed.success) {
          return noteFailure(
            bucket,
            SCENE_ANALYZE_TOOL_NAME,
            `参数不合法：${parsed.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
        try {
          requireAgentTask(parsed.data.taskId);
          const outcome = await analyzer.analyze(parsed.data);
          noteSuccess(bucket);
          return {
            kind: 'ok',
            value: {
              channel: outcome.channel,
              ...(outcome.demotedFrom !== undefined ? { demotedFrom: outcome.demotedFrom } : {}),
              artifactBlobRef: outcome.artifactBlobRef,
              intakeResample: outcome.intakeResample,
              meta: outcome.meta,
              analysis: outcome.analysis,
            },
          };
        } catch (error) {
          const detail =
            error instanceof SceneAnalyzeError
              ? `${error.kind}：${error.message}`
              : error instanceof Error
                ? error.message
                : String(error);
          return noteFailure(bucket, SCENE_ANALYZE_TOOL_NAME, detail);
        }
      },
    },
  ];

  return createCapabilityRegistry(definitions);
}
