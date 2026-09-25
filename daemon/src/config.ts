/**
 * .env 配置加载与解析（design §2 密钥行：zhumo 模式——模板自建/0600/原位回写保序）。
 * 原始需求 2026-09-23（W1.2）：键族=JWT_SECRET、ADMIN_USERNAME、ADMIN_PASSWORD、
 * DATA_ROOT、IMG_BASE_URL、IMG_API_KEY、IMG_MODEL（图像 API）、LLM_*（Agent）、
 * ALLOW_ANONYMOUS（默认'1'）、HOST、PORT、WEBUI_DIR。
 * 正交意图：
 *   [1] dotenv 解析（注释/export 前缀/引号值；process.env 优先于 .env）。
 *   [2] 默认模板创建（.env 缺失时，0600）。
 *   [3] AppConfig 组装（DATA_ROOT 相对 .env 目录解析；缺省=仓库内 data/ 自包含数据根）。
 *   [4] .env 键值回写（保留注释与行序）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 协议键（可选）：openai-completions / anthropic-messages */
  api: string;
  /**
   * 视觉模型（可选——scene.analyze S2 VLM 识图用；add-subject-sam-pipeline P2.3）。
   * 留空=沿用 model；glm 视觉系候选见 .env 模板注释（P2.6 真连以网关 /v1/models 校准）。
   */
  visionModel: string;
}

export interface ImgApiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AppConfig {
  /** .env 绝对路径。 */
  envFile: string;
  /** 解析后的 .env 键值（不含 process.env 覆盖）。 */
  fileEnv: Record<string, string>;
  dataRoot: string;
  adminUsername: string;
  adminPassword: string;
  /** 为空表示未配置（运行期退化为临时随机密钥，见启动装配）。 */
  jwtSecret: string;
  /** 匿名开关（默认开——Owner 裁决默认单账户；显式 '0' 关）。 */
  allowAnonymous: boolean;
  host: string;
  port: number;
  /** 前端构建产物目录（缺失=启动明确报错+构建指引，见 http.ts）。 */
  webuiDir: string;
  img: ImgApiConfig;
  /** IMG_DRY_RUN=1：不真实外呼（固定占位帧+假结果 blob）——E2E 与测试全程 dry-run。 */
  imgDryRun: boolean;
  llm: LlmConfig;
  /**
   * dsh 内核开关（DSH_ENABLED=0 → §6.4 态①显式关闭；默认开）。LLM dry-run
   * 语义=无 LLM_API_KEY（内核缺省路由，请求期 MISSING_CREDENTIAL）或测试注入
   * mock 网关（127.0.0.1 openai-completions 同构替身）——无独立开关键。
   */
  dshEnabled: boolean;
  /** 隔离模块解析根（DSH_MODULE_ROOT——§6.4 态②测试缝；生产为空）。 */
  dshModuleRoot: string;
  /** MCP listener 开关（默认开；关闭=不起独立环回监听）。 */
  mcpEnabled: boolean;
  /** MCP 绑定主机（仅 loopback 值合法——非 loopback 启动期拒绝，§6.4）。 */
  mcpHost: string;
  /** MCP 专用端口（独立 listener，与主 HTTP 分离）。 */
  mcpPort: number;
  /** 分享包独立 TTL 天数（§6.5——默认 7 天，RESULT_TTL_DAYS 可调）。 */
  resultTtlDays: number;
}

export const DEFAULT_PORT = 8317;

/** MCP listener 缺省专用端口（§6.4 独立环回监听——与主 HTTP 8317 分离）。 */
export const DEFAULT_MCP_PORT = 8318;

/** 分享包默认 TTL（§6.5 留存矩阵：public_id 独立生命周期，默认 7 天）。 */
export const DEFAULT_RESULT_TTL_DAYS = 7;

export const DEFAULT_ENV_TEMPLATE = [
  '# 贴钻后端配置（design §2 密钥行——zhumo 模式）',
  '# 管理员：仅经本键族建号（启动幂等 upsert；轮换=改值重启；丢失=删行重建）',
  'ADMIN_USERNAME=',
  'ADMIN_PASSWORD=',
  '# JWT 签名密钥（空=本次运行临时随机，重启后凭证失效）',
  'JWT_SECRET=',
  '# 图像生成 API（服务端集中；半配置=未配置——必需键不齐时任务创建显式拒绝）',
  'IMG_BASE_URL=',
  'IMG_API_KEY=',
  'IMG_MODEL=',
  '# dry-run：不真实外呼（占位帧+假结果）——联调/测试用；设 1 开启',
  '#IMG_DRY_RUN=0',
  '# Agent LLM（zhumo 同款 LLM_* 族；Owner 裁决缺省 z.ai 网关/openai-completions/glm-5.3-flash）',
  'LLM_PROVIDER=',
  'LLM_BASE_URL=',
  'LLM_API_KEY=',
  'LLM_MODEL=',
  '#LLM_API=（协议键：openai-completions 冻结——z.ai 网关实证协议；无 key=零外呼）',
  '# 视觉模型（scene.analyze——S2 VLM 全图识图；glm 视觉系候选：glm-4.5v / glm-4.6v（含 -flash 变体）；留空=沿用 LLM_MODEL。P2.6 真连冒烟以网关 /v1/models 实测为准）',
  'LLM_VISION_MODEL=',
  '# dsh 内核（DSH_ENABLED=0 → agent 面降级 501，design §6.4 态①）',
  '#DSH_ENABLED=1',
  '#DSH_MODULE_ROOT=（隔离模块解析根——§6.4 态②测试缝，生产留空）',
  '# MCP 环回监听（独立端口；仅 loopback 绑定——HOST 开局域网不随行暴露，§6.4）',
  '#MCP_ENABLED=1',
  '#MCP_HOST=127.0.0.1',
  '#MCP_PORT=8318',
  '# 匿名访问（Owner 裁决默认单账户开箱即用；设 0 关闭）',
  'ALLOW_ANONYMOUS=1',
  '# 分享包独立 TTL 天数（/r/ 链接留存期，§6.5——默认 7）',
  '#RESULT_TTL_DAYS=7',
  '# 数据根（缺省=仓库 data/ 自包含；相对值按 .env 所在目录解析）',
  '#DATA_ROOT=',
  '# 前端构建产物目录（缺省=../rhinestone-studio/dist）',
  '#WEBUI_DIR=',
  '# 监听（默认 127.0.0.1:8317——HOST 开局域网时 MCP 不随行暴露，design §6.4）',
  '#HOST=127.0.0.1',
  '#PORT=8317',
  '',
].join('\n');

/** 单行 dotenv：支持注释、export 前缀、单/双引号值。 */
export function parseDotenvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const withoutExport = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
  const eq = withoutExport.indexOf('=');
  if (eq <= 0) return null;
  const key = withoutExport.slice(0, eq).trim();
  let value = withoutExport.slice(eq + 1).trim();
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
  }
  return [key, value];
}

export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseDotenvLine(line);
    if (parsed) result[parsed[0]] = parsed[1];
  }
  return result;
}

/** .env 缺失时写默认模板（目录不存在则一并创建；只读目录下静默容忍）。 */
export function ensureEnvTemplate(envFile: string): void {
  if (existsSync(envFile)) return;
  try {
    mkdirSync(path.dirname(envFile), { recursive: true });
    writeFileSync(envFile, DEFAULT_ENV_TEMPLATE, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // 无写权限（如打包只读环境）：按未配置态继续，启动装配会再告警。
  }
}

/** 回写键值：既有行原位替换，缺失键追加到文件尾，注释与行序保留。 */
export function saveEnvValues(envFile: string, updates: Record<string, string>): void {
  const raw = existsSync(envFile) ? readFileSync(envFile, 'utf8') : DEFAULT_ENV_TEMPLATE;
  const pending = { ...updates };
  const lines = raw.split(/\r?\n/).map((line) => {
    const parsed = parseDotenvLine(line);
    if (!parsed) return line;
    const [key] = parsed;
    if (!(key in pending)) return line;
    const value = pending[key];
    delete pending[key];
    return `${key}=${value}`;
  });
  for (const [key, value] of Object.entries(pending)) {
    if (!raw.endsWith('\n')) lines.push('');
    lines.push(`${key}=${value}`);
  }
  writeFileSync(envFile, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

export interface LoadConfigOptions {
  envFile?: string;
  /** 供测试注入的进程环境覆盖（默认读 process.env）。 */
  processEnv?: NodeJS.ProcessEnv;
}

/** 缺省数据根：daemon 包旁的 data/（自包含数据根——克隆即跑，darwin-arm64 首发裁决）。 */
export function defaultDataRoot(): string {
  return fileURLToPath(new URL('../../data', import.meta.url));
}

/** 缺省前端产物目录：兄弟包 rhinestone-studio/dist。 */
export function defaultWebuiDir(): string {
  return fileURLToPath(new URL('../../rhinestone-studio/dist', import.meta.url));
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const processEnv = options.processEnv ?? process.env;
  const envFile = path.resolve(
    options.envFile ?? processEnv.HANDICRAFT_ENV ?? path.join(process.cwd(), '.env'),
  );
  ensureEnvTemplate(envFile);
  const fileEnv = existsSync(envFile) ? parseDotenv(readFileSync(envFile, 'utf8')) : {};
  const pick = (key: string): string => processEnv[key] ?? fileEnv[key] ?? '';

  const host = pick('HOST') || '127.0.0.1';
  const port = Number.parseInt(pick('PORT') || String(DEFAULT_PORT), 10);
  const dataRoot = pick('DATA_ROOT')
    ? path.resolve(path.dirname(envFile), pick('DATA_ROOT'))
    : defaultDataRoot();
  const webuiDir = pick('WEBUI_DIR')
    ? path.resolve(path.dirname(envFile), pick('WEBUI_DIR'))
    : defaultWebuiDir();
  // 匿名默认开（Owner 裁决：默认单账户开箱即用——与 zhumo 安全默认相反，产品变体）。
  const allowAnonymous = pick('ALLOW_ANONYMOUS') !== '0';
  return {
    envFile,
    fileEnv,
    dataRoot,
    adminUsername: pick('ADMIN_USERNAME'),
    adminPassword: pick('ADMIN_PASSWORD'),
    jwtSecret: pick('JWT_SECRET'),
    allowAnonymous,
    host,
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    webuiDir,
    img: {
      baseUrl: pick('IMG_BASE_URL'),
      apiKey: pick('IMG_API_KEY'),
      model: pick('IMG_MODEL'),
    },
    imgDryRun: pick('IMG_DRY_RUN') === '1',
    dshEnabled: pick('DSH_ENABLED') !== '0',
    dshModuleRoot: pick('DSH_MODULE_ROOT'),
    mcpEnabled: pick('MCP_ENABLED') !== '0',
    mcpHost: pick('MCP_HOST') || '127.0.0.1',
    mcpPort: (() => {
      const raw = Number.parseInt(pick('MCP_PORT') || String(DEFAULT_MCP_PORT), 10);
      return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MCP_PORT;
    })(),
    resultTtlDays: (() => {
      const raw = Number.parseInt(pick('RESULT_TTL_DAYS') || String(DEFAULT_RESULT_TTL_DAYS), 10);
      return Number.isFinite(raw) && raw >= 1 ? raw : DEFAULT_RESULT_TTL_DAYS;
    })(),
    llm: {
      provider: pick('LLM_PROVIDER'),
      baseUrl: pick('LLM_BASE_URL'),
      apiKey: pick('LLM_API_KEY'),
      model: pick('LLM_MODEL'),
      api: pick('LLM_API'),
      visionModel: pick('LLM_VISION_MODEL'),
    },
  };
}

/** 图像 API 半配置判定（design §2：半配置=未配置——必需键不齐视为整体未配置）。 */
export function isImgConfigured(img: Pick<ImgApiConfig, 'baseUrl' | 'apiKey' | 'model'>): boolean {
  return img.baseUrl !== '' && img.apiKey !== '' && img.model !== '';
}

/** Agent LLM 半配置判定（同上语义）。 */
export function isLlmConfigured(llm: Pick<LlmConfig, 'provider' | 'baseUrl' | 'apiKey' | 'model'>): boolean {
  return llm.provider !== '' && llm.baseUrl !== '' && llm.apiKey !== '' && llm.model !== '';
}

/** 半配置诊断：缺哪个键（全配齐返回空数组——任务创建时显式拒绝并提示，design §2）。 */
export function missingImgKeys(img: Pick<ImgApiConfig, 'baseUrl' | 'apiKey' | 'model'>): string[] {
  const missing: string[] = [];
  if (img.baseUrl === '') missing.push('IMG_BASE_URL');
  if (img.apiKey === '') missing.push('IMG_API_KEY');
  if (img.model === '') missing.push('IMG_MODEL');
  // 形态校验仅在 key 非空时附加诊断（空 key 已由上面的 IMG_API_KEY 覆盖）
  if (img.apiKey !== '' && !isImgApiKeyShapeOk(img.apiKey)) {
    missing.push('IMG_API_KEY（形态非法：trim 后长度<8 或含 "*"——防替换标记重组类攻击，请更换合规密钥）');
  }
  return missing;
}

/**
 * 密钥形态校验（P1-5 R8 边界冻结）：含 '*' 的密钥可与替换标记（*** 等）发生
 * 部分重叠/子串重组（a* + aa* → a***… 含原文；密钥含全部候选标记时更甚），
 * 过短密钥同理——这类形态**配置侧直接拒绝**（半配置=未配置哲学），终门只对
 * 合规密钥承诺「原文零出现」。
 */
export function isImgApiKeyShapeOk(apiKey: string): boolean {
  const trimmed = apiKey.trim();
  return trimmed.length >= 8 && !trimmed.includes('*');
}

/**
 * 图像 API 双层真源解析（spec：settings 表优先、.env 兜底）。settings 键
 * img_base_url/img_api_key/img_model（小写）——写入面归 settings RPC（W3+）；
 * 本层只读合并：settings 有值（含空串显式清空）优先，否则 .env。
 */
export function resolveImgConfig(
  db: { prepare: (sql: string) => { get: (key: string) => unknown } },
  config: Pick<AppConfig, 'img'>,
): ImgApiConfig {
  const read = (key: string): string | null => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  };
  const pick = (settingKey: string, envValue: string): string =>
    read(settingKey) ?? envValue;
  return {
    baseUrl: pick('img_base_url', config.img.baseUrl),
    apiKey: pick('img_api_key', config.img.apiKey),
    model: pick('img_model', config.img.model),
  };
}

/** 密钥读面脱敏：存在性 + 尾 4 位（空值=null；短于等于 4 位=****）。 */
export function maskSecret(value: string): string | null {
  if (value === '') return null;
  if (value.length <= 4) return '****';
  return `****${value.slice(-4)}`;
}
