/**
 * dsh 内核挂载（design §1 kernel/ 行 + §2 Agent 行 + §6.4 降级隔离——W4.1；
 * 照 shufa-server kernel/boot.ts 移植——其上游=skill-creator-v2 kernel/
 * dsh-kernel.ts 最小可行形态；版本对齐 shufa 锁定的 0.1.6-alpha.1 线）。
 * 原始需求 2026-09-23：DSH_HOME=<DATA_ROOT>/dsh-home 注入；单 dsh-base
 * bundle + 官方 profile 机制；handicraft preset（persona+ask-user）；
 * dsh-mcp-client 行连 daemon 独立 loopback MCP listener；模型路由桥
 * （.env LLM_* → settings.yaml/.credentials.yaml——密钥只落 DATA_ROOT 内，
 * 0600，绝不入 git）。
 * 四态（§6.4——贴钻变体，shufa 两态 mounted/off 的超集）：
 *   off      DSH_ENABLED=0（显式关闭）
 *   missing  缺包/坏包（boot 错误链含 module-resolution 失败——独立进程+
 *            隔离模块解析器实测：DSH_MODULE_ROOT（测试缝）→ bareModuleBaseUrl
 *            指向临时根，裸包名全部从该根解析，临时根缺包/坏包=真实解析失败）
 *   error    boot throw（模块已载入后的组装/运行时异常）
 *   ready    正常
 * 正交意图：
 *   [1] bootHandicraftKernel：profile/cordis/preset 落盘 + boot + facts 采集。
 *   [2] 工具面收窄 patch（KERNEL_DISABLED_TOOL_ROWS disable 行）。
 *   [3] mountHandicraftKernel：四态判定（失败不阻塞 daemon——降级 reason 呈现，
 *       不自动重试；重启 daemon 是唯一恢复入口）。
 *   [4] 有界 dispose：fiber dispose + DSH_HOME/MCP/key env 还原。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  resolveProfileDir,
} from '@deepseek-ai/dsh-app-boot';
import type { Context } from '@deepseek-ai/cordis';
import { stringify as stringifyYaml } from 'yaml';
import {
  injectApiKeysEnv,
  syncModelRoutesCredentials,
  syncModelRoutesSettings,
  type ModelRoutesBundle,
} from './model-route.js';
import { KERNEL_DISABLED_TOOL_ROWS } from './tool-surface.js';
import { buildSystemPersona, defaultPersonaPath } from './prompts.js';
import { completeTransitiveMirror } from './profile-mirror.js';

/** 内核 boot facts（无 HTTP 面；供启动日志与诊断）。 */
export interface HandicraftKernelBootRecord {
  entries: Array<{ id: string; name: string }>;
  activationOrder: string[];
  /** 非活跃但未降级的插件（W4.1 R2 P1-3：optional FIBER_FAILED/PENDING 显式暴露——半死树可见不静默）。 */
  inactiveActivation: Array<{ id: string; state: string }>;
}

export interface HandicraftKernelHandle {
  ctx: Context;
  record: HandicraftKernelBootRecord;
  /** 全局工具表当前名字集合（deny-list 计算与诊断用）。 */
  globalToolNames(): string[];
  /** 有界停止：fiber dispose + env 还原。幂等由调用方保证。 */
  dispose(): Promise<void>;
}

export interface HandicraftKernelOptions {
  /** DATA_ROOT（DSH_HOME = <dataRoot>/dsh-home）。 */
  dataRoot: string;
  /** daemon 的独立 loopback MCP listener（内核组合 dsh-mcp-client 行连接——§6.4）。 */
  mcp?: { url: string; token: string };
  /** 模型路由束（空 routes = 未配置，内核以缺省路由运行）。 */
  modelRoutes: ModelRoutesBundle | null;
  /** persona 全文路径（缺省 kernel/persona.md）。 */
  personaPath?: string;
  /**
   * 隔离模块解析根（§6.4 态②测试缝——DSH_MODULE_ROOT）：设为非空时跳过
   * profile 镜像 heal，且 bare 包名全部从该根解析（bareModuleBaseUrl）——
   * 独立进程+隔离解析器实测缺包/坏包。生产为空。
   */
  moduleRoot?: string;
}

/** daemon 根（src/kernel/boot.ts → ../../package.json；tsx 源码态）。 */
const daemonRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export async function bootHandicraftKernel(options: HandicraftKernelOptions): Promise<HandicraftKernelHandle> {
  const home = path.join(options.dataRoot, 'dsh-home');
  mkdirSync(home, { recursive: true });
  const previousDshHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;

  const restoreMcpUrl = stashEnv('HANDICRAFT_MCP_URL', options.mcp?.url);
  const restoreMcpToken = stashEnv('HANDICRAFT_MCP_TOKEN', options.mcp?.token);
  const restoreKey =
    options.modelRoutes && options.modelRoutes.routes.length > 0
      ? injectApiKeysEnv(options.modelRoutes.routes)
      : () => {};

  // 官方 profile 机制：单 dsh-base bundle。
  const profileDir = resolveProfileDir('kernel', home);
  initProfile(profileDir, ['@deepseek-ai/dsh-base'], 'startup');

  // 工具面收窄 patch：disable 通用 fs/shell/web 行（模型可见工具只能来自 studio MCP）。
  const disableYaml = KERNEL_DISABLED_TOOL_ROWS.map((id) => `- id: ${id}\n  disabled: true\n`).join('');
  writeFileSync(path.join(profileDir, 'cordis.patch.yml'), disableYaml, 'utf8');

  // 模型路由桥（热面）：settings.yaml providers 全量 + 默认模型
  // + .credentials.yaml version-1 refs 全量密钥。
  if (options.modelRoutes && options.modelRoutes.routes.length > 0) {
    syncModelRoutesSettings(home, options.modelRoutes);
    syncModelRoutesCredentials(home, options.modelRoutes.routes);
  }

  // handicraft 产品 preset（$DSH_HOME/.agent-presets/handicraft/，官方
  // includeUserRoot 机制）：persona（系统段 + persona.md）+ ask-user 行，
  // 无任何通用工具行。
  const presetDir = path.join(home, '.agent-presets', 'handicraft');
  mkdirSync(presetDir, { recursive: true });
  writeFileSync(
    path.join(presetDir, 'preset.yml'),
    stringifyYaml({
      name: '贴钻工作室助手',
      description: '产品会话预设——studio.* 工具面 + ask-user，无通用 fs/shell 工具。',
      order: 1,
    }),
    'utf8',
  );
  writeFileSync(
    path.join(presetDir, 'agent.cordis.yml'),
    stringifyYaml([
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { text: buildSystemPersona(options.personaPath ?? defaultPersonaPath()) },
      },
      { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    ]),
    'utf8',
  );

  // entry rows：agent-presets roster + workspace + mcp-client（token 经 env 模板，
  // 不落盘明文——连 daemon 独立 loopback MCP listener，§6.4 监听隔离）。
  const configPath = path.join(profileDir, 'cordis.yml');
  const mcpRow = options.mcp
    ? [
        '- id: mcp-studio\n',
        "  name: '@deepseek-ai/dsh-mcp-client'\n",
        '  config:\n',
        '    serverName: studio\n',
        '    transport: streamable-http\n',
        '    url: !!js process.env.HANDICRAFT_MCP_URL\n',
        '    headers:\n',
        "      Authorization: !!js '`Bearer ${process.env.HANDICRAFT_MCP_TOKEN}`'\n",
      ].join('')
    : '';
  writeFileSync(
    configPath,
    [
      '- id: agent-presets\n',
      "  name: '@deepseek-ai/dsh-agent-presets'\n",
      '  config:\n',
      '    default: handicraft\n',
      '    includeShippedRoot: false\n',
      '- id: workspace\n',
      "  name: '@deepseek-ai/dsh-workspace'\n",
      mcpRow,
    ].join(''),
    'utf8',
  );

  // profile 装载 + 依赖镜像（pnpm 布局 heal 不完整的补全）。
  // 隔离解析缝（态②测试）：moduleRoot 非空时跳过镜像，bare 包名全部从
  // moduleRoot 解析（bareModuleBaseUrl）——独立解析路径，缺包/坏包真实失败。
  const installAnchor = path.join(daemonRoot, 'package.json');
  const bareModuleBaseUrl = options.moduleRoot
    ? `${pathToFileURL(options.moduleRoot).href}/` // 尾斜杠必带（URL 解析基准语义）
    : undefined;
  const profile = loadProfile('handicraft', 'kernel', installAnchor, home);
  if (!options.moduleRoot) {
    await healProfilesModuleFallback({ installAnchor, profile, home });
    completeTransitiveMirror(home);
  }

  // boot：appExit 不能 process.exit（宿主进程内嵌）；激活序经 loader/entry-init 采集。
  // dsh-base bundle 行经 profile 层 patches 注入（leaf cordis.yml 之下、overlay 之上）。
  const patches = [...profile.layers.flatMap((layer) => layer.patches), ...profile.patches];
  const constructed: Array<{ options: { id: string; name: string } }> = [];
  const prepare = (ctx: Context): void => {
    ctx.provide('appExit', (code?: number) => {
      throw new Error(`kernel profile requested app exit (${code ?? 0})`);
    });
    type EntryInitContext = Context & {
      on: (event: 'loader/entry-init', listener: (entry: { options: { id: string; name: string } }) => void) => () => void;
    };
    (ctx as EntryInitContext).on('loader/entry-init', (entry) => constructed.push(entry));
  };
  const ctx = await boot('handicraft', configPath, patches, prepare, bareModuleBaseUrl);

  // import 失败审计（§6.4 态②判据）+ 半死树显式暴露（W4.1 R2 P1-3）。
  // 上游 inactiveEntries（lib/index.js:2439-2471）区分三种非活跃形态：
  //   fiber===undefined（import 失败）/ FIBER_FAILED=3（激活失败，如 typert codec
  //   噪声）/ FIBER_PENDING=0（等待缺失服务）——optional 行上游只警告不抛。
  // 策略（实证 2026-09-24 健康探针：79 ACTIVE + 1 FAILED(typert-loader) + 0 其他）：
  //   [a] import 失败（任意非 disabled 行）→ 整树降级 missing——缺包/坏包必须降级
  //       （四态②判据，上游对 optional 只警告不可依赖）。
  //   [b] FIBER_FAILED/PENDING（optional 激活失败/等待）→ 不降级（上游语义；健康树
  //       实证含 1 个良性 FAILED），但记入 record.inactiveActivation + 警告日志——
  //       半死树不得不可见。required 集失败由上游 boot 自抛（→态③），此处不重复。
  type AuditEntry = {
    disabled?: unknown;
    fiber?: { state?: number } | undefined;
    options: { id: string; name: string };
  };
  const FIBER_ACTIVE = 2; // 上游常量（lib/index.js:2398-2400，随 0.1.6-alpha.1 锁定）
  const importFailures: string[] = [];
  const inactiveActivation: Array<{ id: string; state: string }> = [];
  for (const entry of (ctx as unknown as { loader: { entries(): Iterable<AuditEntry> } }).loader.entries()) {
    try {
      if (entry.disabled) continue;
    } catch {
      continue;
    }
    if (entry.fiber === undefined) {
      importFailures.push(`${entry.options.id} (${entry.options.name})`);
    } else if (entry.fiber.state !== FIBER_ACTIVE) {
      inactiveActivation.push({ id: entry.options.id, state: `fiber=${String(entry.fiber.state)}` });
    }
  }
  if (inactiveActivation.length > 0) {
    console.warn(
      `[kernel] ${inactiveActivation.length} 个非活跃插件（激活失败/等待服务——不阻断，见 boot record）：${inactiveActivation.map((item) => `${item.id}(${item.state})`).join('、')}`,
    );
  }
  if (importFailures.length > 0) {
    const auditError = new Error(
      `内核插件导入失败（缺包/坏包——${importFailures.length} 行）：${importFailures.slice(0, 5).join('、')}${importFailures.length > 5 ? '…' : ''}`,
    );
    type FiberContext = Context & { fiber?: { dispose: () => Promise<void> } };
    await (ctx as FiberContext).fiber?.dispose().catch(() => undefined);
    restoreEnv('DSH_HOME', previousDshHome);
    restoreMcpUrl();
    restoreMcpToken();
    restoreKey();
    (auditError as { kernelImportFailure?: boolean }).kernelImportFailure = true;
    throw auditError;
  }

  type LoaderContext = Context & {
    loader?: { entries: () => Iterable<{ id: string; options: { name: string } }> };
  };
  const record: HandicraftKernelBootRecord = {
    entries: [...((ctx as LoaderContext).loader?.entries() ?? [])].map((entry) => ({
      id: entry.id,
      name: entry.options.name,
    })),
    activationOrder: constructed.map((entry) => entry.options.name),
    inactiveActivation,
  };
  type ToolsContext = Context & { tools?: { schemas?: () => Array<{ name?: string }> } };
  const toolsRuntime = (ctx as ToolsContext).tools;
  const globalToolNames = (): string[] =>
    (toolsRuntime?.schemas?.() ?? [])
      .map((schema) => schema?.name)
      .filter((name): name is string => typeof name === 'string');

  return {
    ctx,
    record,
    globalToolNames,
    dispose: async () => {
      type FiberContext = Context & { fiber?: { dispose: () => Promise<void> } };
      await (ctx as FiberContext).fiber?.dispose();
      restoreEnv('DSH_HOME', previousDshHome);
      restoreMcpUrl();
      restoreMcpToken();
      restoreKey();
    },
  };
}

/** §6.4 四态。 */
export type HandicraftKernelState = 'off' | 'missing' | 'error' | 'ready';

/** 挂载结果（失败不抛——四态语义呈现给调用方）。 */
export interface HandicraftKernelMount {
  state: HandicraftKernelState;
  reason?: string;
  kernel?: HandicraftKernelHandle;
}

/**
 * 错误链 → module-resolution 失败判定（态② vs 态③的分类面）：错误或其
 * cause 链上任一节点带 ERR_MODULE_NOT_FOUND / Cannot find (module|package) /
 * 语法解析失败（SyntaxError——坏包入口的解析期形态）即归 missing。
 * AggregateError.errors 同样遍历（W4.1 R2 P2-1：上游 loader 的聚合错误形态）。
 */
export function isModuleResolutionFailure(error: unknown, depth = 0): boolean {
  if (!error || depth > 8) return false;
  if (typeof error !== 'object') return String(error).includes('Cannot find');
  const typed = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
    kernelImportFailure?: unknown;
    errors?: unknown;
  };
  if (typed.code === 'ERR_MODULE_NOT_FOUND' || typed.code === 'MODULE_NOT_FOUND') return true;
  if (typed.kernelImportFailure === true) return true; // boot 后 import 失败审计（§6.4 ②）
  if (typeof typed.message === 'string') {
    if (/Cannot find (module|package)/.test(typed.message)) return true;
    if (/failed to import/.test(typed.message)) return true; // loader 对 import 失败行的诊断字面
    if (/内核插件导入失败/.test(typed.message)) return true;
    if (error instanceof SyntaxError) return true;
  }
  if (isModuleResolutionFailure(typed.cause, depth + 1)) return true;
  if (Array.isArray(typed.errors)) {
    for (const inner of typed.errors) {
      if (isModuleResolutionFailure(inner, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * 四态挂载：off（显式关）→ 不 boot；missing/error → 降级呈现；ready → 句柄。
 * 失败不阻塞 daemon（§6.4——agent 面 501，基础工作流不受影响）。
 */
export async function mountHandicraftKernel(
  options: HandicraftKernelOptions & { enabled: boolean },
): Promise<HandicraftKernelMount> {
  if (!options.enabled) {
    return { state: 'off', reason: 'DSH 显式关闭（DSH_ENABLED=0）' };
  }
  try {
    return { state: 'ready', kernel: await bootHandicraftKernel(options) };
  } catch (error) {
    const reason = errorChainText(error);
    if (isModuleResolutionFailure(error)) {
      console.warn(`[kernel] dsh 内核缺包/坏包（态②，daemon 降级运行）：${reason}`);
      return { state: 'missing', reason: `缺包/坏包：${reason}` };
    }
    console.warn(`[kernel] dsh 内核挂载失败（态③，daemon 降级运行）：${reason}`);
    return { state: 'error', reason: `boot 异常：${reason}` };
  }
}

function errorChainText(error: unknown, depth = 0): string {
  const head = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (depth > 4 || !error || typeof error !== 'object') return head;
  const cause = (error as { cause?: unknown }).cause;
  if (!cause) return head;
  return `${head} <- ${errorChainText(cause, depth + 1)}`;
}

function stashEnv(key: string, value: string | undefined): () => void {
  const previous = process.env[key];
  if (value !== undefined) process.env[key] = value;
  return () => restoreEnv(key, previous);
}

function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) delete process.env[key];
  else process.env[key] = previous;
}
