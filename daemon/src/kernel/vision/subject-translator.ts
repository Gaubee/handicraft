/**
 * 主体名英译器（SAM 英文优先提示——Owner 定调 2026-10-03：SAM 对中文支持不好；
 * 最终图层命名 objectName 仍由 Agent 自定（中文 OK），但送进 SAM 的文本 prompt
 * 必须英文为主——中文只允许出现在语义内容本身，如「“你好”两个字」的引号字面）。
 *
 * 职责：segment-loop 后续轮 subject 无英文 hint 时，把中文 objectName 翻译成英文
 * 视觉对象名词短语（供 broadSemanticPrompt 英文分支作主语）。三协议线面复用
 * kernel/llm-route（scene.analyze 通道 B 同源——settings 真源优先+.env 迁移回退）；
 * buildTextLlmWireRequest 三协议均 temperature 0（确定性纪律的请求侧）。
 *
 * 确定性纪律（同 objectName 必须同译文）与账本取舍（briefed 语义，2026-10-04）：
 * - 实例级 Map 缓存（key=objectName.trim()）：executor 生命周期=daemon 进程生命周期
 *   ⇒ 同任务（含 add-segment-checkpoint-resume 切片续跑——同进程重入 runSegmentLoop）
 *   译文稳定 ⇒ segment-ledger reqHash（含 prompt）跨片一致 ⇒ 回放命中保持；
 * - 跨进程（daemon 重启后同任务续跑/跨任务同图同清单回放）：temperature 0+同模型
 *   使译文大概率一致但不保证——译文漂移 ⇒ reqHash 不匹配 ⇒ 账本回放 miss=多一次
 *   实桥运行，结果正确只是多花一次调用，可接受（不为此把译文落盘入指纹——那会把
 *   翻译面耦合进账本格式，破坏面大于收益）；
 * - 失败不缓存（路由不可达/超时/译文非法）：下一轮自愈重试——软失败面在循环层
 *   warning{subject-translate-failed} 留痕（降级可观测），本层零日志噪声。
 *
 * 纯度：LLM 调用经 deps 注入（fetchImpl/timeoutMs 测试面）；无 IO 直连、无常驻
 * 进程；任何失败=返回 null（不抛——软失败语义由调用方消费）。
 */
import type { LlmConfig } from '../../config.js';
import type { SqliteDb } from '../../db/database.js';
import {
  buildTextLlmWireRequest,
  extractLlmContentText,
  resolveLlmRoute,
  type LlmWireRequest,
  type ResolvedLlmRoute,
} from '../llm-route.js';
import { envTimeoutMs } from '../timeout-env.js';

// ---------------------------------------------------------------- 冻结常量

/** 翻译调用超时 env 键（ms——小文本调用，缺省远小于桥/视觉通道界）。 */
export const SUBJECT_TRANSLATE_TIMEOUT_MS_ENV = 'SUBJECT_TRANSLATE_TIMEOUT_MS';

/** 翻译调用超时缺省（ms）：15s——一行名词短语的小请求；路由死=每轮每名至多挂 15s。 */
export const SUBJECT_TRANSLATE_TIMEOUT_MS_DEFAULT = 15_000;

/**
 * 翻译请求 max_tokens：按**思考模型**口径预算（2026-10-04 live 实证：GLM-5.3-Flash
 * anthropic-messages 首块=thinking，64 预算全被思考吃尽——stop_reason=max_tokens、
 * text 块从未出现，英译恒 null 降级）。译文本身 ≤8 词，但思考前置消耗不可见；
 * 4096 与 scene.analyze(8192)/strategy.design(16384) 同代预算档，输出侧仍受
 * SUBJECT_TRANSLATE_OUTPUT_MAX_CHARS 整形上界约束，不放大译文面。
 */
export const SUBJECT_TRANSLATE_MAX_TOKENS = 4096;

/** 译文长度上界（字符）：超界=非法译文拒收（防 prompt 注入式长文）。 */
export const SUBJECT_TRANSLATE_OUTPUT_MAX_CHARS = 200;

/** env 覆盖读取（envTimeoutMs 严格解析——≥1000 的有限数才采用，否则回缺省）。 */
export function subjectTranslatorTimeoutMs(): number {
  return envTimeoutMs(SUBJECT_TRANSLATE_TIMEOUT_MS_ENV, SUBJECT_TRANSLATE_TIMEOUT_MS_DEFAULT);
}

// ---------------------------------------------------------------- 指令与译文整形（纯函数）

/**
 * 翻译指令（送 LLM 的完整 prompt）。规则面：
 * - 输出一行英文名词短语（SAM text prompt 主语）；
 * - **文字内容字面保留**（Owner 定调的例外通道）：主体名指画面中的文字/字符本身时，
 *   译文必须原样保留引号内字面（英文指令+原字面，如 the Chinese text “你好”）——
 *   中文只允许出现在语义内容本身；
 * - 已英文名原样返回。
 * 纯函数：确定性（同输入同输出）。
 */
export function subjectTranslateInstruction(objectName: string): string {
  return [
    '你在为 SAM 图像分割模型准备英文文本提示（SAM 对中文支持不好，提示必须英文为主）。',
    '把输入的主体名翻译成等价的英文视觉对象名词短语。规则：',
    '1. 只输出一行英文名词短语（不超过 8 个词）；不要解释、不要把整个输出包进引号、不要以句号结尾。',
    '2. 贴钻画布语境：主体名是画面中的视觉对象或其部件（人物/发型/服饰/景物/纹理区域等），译文用对应的英文视觉对象名词短语。',
    '3. 文字内容字面保留：主体名若指画面中出现的文字/字符本身（如 “你好”两个字、“福”字），译文必须原样保留引号内的字面内容，例如 the Chinese text “你好”、the characters “福”。除该字面内容外，译文其余部分必须是英文。',
    '4. 主体名若已是英文，原样返回（仅去多余空白）。',
    '',
    `主体名：${objectName}`,
  ].join('\n');
}

/**
 * 主体名中的成对引号字面提取（「」『』“”与 ASCII ""）——文字内容语义的确定性
 * 识别面（LLM 指令规则 3 的机器校验侧：译文必须包含全部字面，否则判非法译文）。
 */
export function quotedLiteralsOf(objectName: string): string[] {
  const patterns = [/「([^」]+)」/g, /『([^』]+)』/g, /“([^”]+)”/g, /"([^"]+)"/g];
  const out: string[] = [];
  for (const pattern of patterns) {
    for (const match of objectName.matchAll(pattern)) out.push(match[1]!);
  }
  return out;
}

/**
 * 译文整形（纯函数）：首非空行→剥整句包裹引号→非空/含 ASCII 字母（英文为主纪律
 * ——纯中文回显=坏译文）/长度上界。null=非法译文（调用面按软失败降级）。
 */
export function sanitizeSubjectTranslation(raw: string): string | null {
  const firstLine = raw
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  let out = firstLine;
  for (const [open, close] of [
    ['"', '"'],
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
  ] as const) {
    if (out.length >= 2 && out.startsWith(open) && out.endsWith(close)) {
      out = out.slice(1, -1).trim();
      break;
    }
  }
  if (out.length === 0 || out.length > SUBJECT_TRANSLATE_OUTPUT_MAX_CHARS) return null;
  if (!/[a-z]/i.test(out)) return null; // 英文为主：无 ASCII 字母=译文未成立
  return out;
}

// ---------------------------------------------------------------- 英译器本体

export interface SubjectTranslatorDeps {
  db: SqliteDb;
  llm: LlmConfig;
  /** fetch 注入面（测试——缺省全局 fetch）。 */
  fetchImpl?: typeof fetch;
  /** 超时直注（测试——缺省 env SUBJECT_TRANSLATE_TIMEOUT_MS / 15s）。 */
  timeoutMs?: number;
}

/** 英译面签名（segment-loop SegmentLoopDeps.translateSubject 消费）：null=软失败。 */
export type SubjectTranslator = (objectName: string) => Promise<string | null>;

/**
 * 英译器工厂：实例级 Map 缓存（确定性纪律——见模块头注的账本取舍）。任何失败
 * （路由未配置/配置错误/HTTP 坏/超时/译文非法/字面丢失）=null 不抛——降级语义
 * 归循环层（中文 prompt+warning，不阻塞循环）；失败不缓存（下轮自愈重试）。
 */
export function createSubjectTranslator(deps: SubjectTranslatorDeps): SubjectTranslator {
  const cache = new Map<string, string>();
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? subjectTranslatorTimeoutMs();
  return async (objectName) => {
    const key = objectName.trim();
    if (key.length === 0) return null;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    // —— 路由解析（settings 真源优先+.env 迁移回退——resolveLlmRoute 单源；文本
    //    通道用路由缺省 model，不碰 visionModel）。配置错误（坏协议等）=软失败。
    let route: ResolvedLlmRoute | null;
    try {
      route = resolveLlmRoute(deps.db, deps.llm, 'subject.translate');
    } catch {
      return null;
    }
    if (route === null) return null;
    let wire: LlmWireRequest;
    try {
      wire = buildTextLlmWireRequest(route, route.model, subjectTranslateInstruction(key), SUBJECT_TRANSLATE_MAX_TOKENS);
    } catch {
      return null; // 协议构造失败（未知 api 值）=配置错误面
    }
    // —— 三协议外呼（temperature 0 由 buildTextLlmWireRequest 保证——确定性请求侧）
    let content: string | null = null;
    try {
      const response = await doFetch(wire.url, {
        method: 'POST',
        headers: wire.headers,
        body: wire.body,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error', // 网关直连；跨域重定向=配置漂移面（scene.analyze 同款纪律）
      });
      if (!response.ok) return null;
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return null;
      }
      content = extractLlmContentText(route.api, body);
    } catch {
      return null; // 网络面/超时——软失败
    }
    const sanitized = sanitizeSubjectTranslation(content ?? '');
    if (sanitized === null) return null;
    // 字面保留机器校验（指令规则 3 的确定性对侧）：主体名中的引号字面必须原样
    // 出现在译文里——丢字面=非法译文（降级中文 prompt 本身含原字面，安全）。
    if (quotedLiteralsOf(key).some((literal) => !sanitized.includes(literal))) return null;
    cache.set(key, sanitized);
    return sanitized;
  };
}
