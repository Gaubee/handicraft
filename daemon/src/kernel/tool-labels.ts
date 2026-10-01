/**
 * activity 帧的人话投影单源（意图 [4]——「任务详情=整个任务会话的投影」Owner
 * 需求 2026-10-02）：工具名→中文 label 映射 + 入参/产出摘要的通用提炼。
 * 映射口径与前端 rhinestone-studio/src/lib/agentApi/toolNames.ts 的
 * TOOL_DISPLAY_NAMES 对齐（同表拷贝——daemon 不能依赖前端包；两侧新增工具时
 * 同步维护，映射外原名保留）。
 * 纯函数模块（零 daemon 依赖）——单测直调；AOP 落帧单点在 kernel/sessions.ts
 * 的 tool/call+tool/result 事件投影（全部 LLM 可调用工具经 dsh firehose 汇聚，
 * 一次切面全覆盖——studio、stones、set 三族与 ask_user/todo 内建 alike）。
 * 摘要红线：键白名单挑选（密钥/授权/会话内部 id 永不入摘要）+ 绝对路径折叠为
 * basename + 分值/总值双截断（契约 ActivityPayloadSchema max 强制）。
 */

/** 常用工具中文名（键=能力规范名；与前端 toolNames.ts 同表对齐 + 内建工具两条）。 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  // 场景/抠图/策略管线（add-subject-sam-pipeline 主线）
  'studio.scene.analyze': '识图分析',
  'studio.subject.segment': '抠图分件',
  'studio.strategy.design': '策略设计',
  // 图层树
  'studio.tree.inspect': '图层树检视',
  'studio.tree.refine': '图层细化',
  'studio.tree.rename': '图层重命名',
  'studio.tree.reparent': '图层归属调整',
  'studio.tree.merge': '图层合并',
  // 任务域（工件/用钻/图集/提案）
  'studio.task.export': '导出任务工件',
  'studio.task.exports.list': '查看导出清单',
  'studio.task.images.list': '查看主图集',
  'studio.task.proposals.list': '查看提案记录',
  'studio.task.stones.add': '追加用钻',
  'studio.task.stones.list': '查看用钻清单',
  // 生成/导出/BOM
  'studio.generate': '生成图片',
  'studio.export': '导出',
  'studio.export-dryrun': '导出试算',
  'studio.bom': '用钻清单',
  'studio.pave-preview': '排钻预览',
  // 修改提案/撤销
  'studio.patch-propose': '修改提案',
  'studio.patch-apply': '应用修改',
  'studio.undo': '撤销',
  // 项目/模板/知识库
  'studio.projects': '查看项目',
  'studio.templates': '查看模板',
  'studio.kb_get': '知识库读取',
  'studio.kb_list': '知识库检索',
  // 钻库/组合（stones.* / set.*）
  'stones.list': '钻库检索',
  'stones.search': '钻库搜索',
  'stones.get': '钻款详情',
  'stones.substitutes': '替换钻推荐',
  'stones.add': '新增钻款',
  'set.list': '组合列表',
  'set.get': '组合详情',
  'set.create': '新建组合',
  'set.update': '保存组合',
  'set.delete': '删除组合',
  // dsh 内建（KERNEL_AGENT_TOOL_ALLOWLIST——前端表未覆盖，daemon 侧补齐）
  ask_user_question: '询问用户',
  todo_write: '更新待办',
};

/** 去 MCP 传输前缀（`mcp__<server>__<tool>` → `<tool>`；非该形态原样返回）。 */
function stripMcpPrefix(name: string): string {
  const match = /^mcp__[a-zA-Z0-9_-]+__(.+)$/.exec(name);
  return match?.[1] ?? name;
}

/**
 * 规范名解析：dsh-mcp-client 投影名（`.`→`_` + studio 命名空间去重）反解回
 * 映射表键。候选序（确定性）：裸名（原生下划线工具）→ 补 studio. 前缀（kb_list
 * 类）→ 下划线还原圆点（subject_segment 类）→ 补 studio. 前缀的还原形；命中
 * 映射表即返回该规范名，全不中返回裸名（不猜译）。
 */
export function canonicalToolName(rawName: string): string {
  const stripped = stripMcpPrefix(rawName);
  const candidates = [
    stripped,
    `studio.${stripped}`,
    stripped.replace(/_/g, '.'),
    `studio.${stripped.replace(/_/g, '.')}`,
  ];
  for (const candidate of candidates) {
    if (TOOL_LABELS[candidate] !== undefined) return candidate;
  }
  return stripped;
}

/** 工具名 → 中文短句（未映射保裸名——宁可英文也不误译）。 */
export function toolLabel(canonicalName: string): string {
  return TOOL_LABELS[canonicalName] ?? canonicalName;
}

// ---------------------------------------------------------------- 摘要提炼（通用——不逐工具定制）

/** 绝不进摘要的键（密钥/授权凭据/会话内部 id——投影冻结面同族红线）。 */
const SUMMARY_KEY_DENYLIST = /^(taskid|sessionid|ownerid|grantid|nonce|apikey|api_key|key|token|secret|password|credential)s?$/i;
/** name 类字段（label 拼亮点与摘要共用）。 */
const NAME_LIKE_KEYS = /^(name|label|title|note|summary|text|prompt|question|filename|displayname)$/i;
/** id/枚举类字段。 */
const ID_LIKE_KEYS = /^(id|kind|op|mode|family|strategy|shapeid|shape|style|size|format|region|subject|layer|direction|scope)$/i;
/** 计数类字段。 */
const COUNT_LIKE_KEYS = /^(count|total|n|number|quantity)$/i;

const INPUT_PAIR_VALUE_MAX = 48;
const INPUT_SUMMARY_MAX = 200;
const ERROR_BRIEF_MAX = 300;
const LABEL_HIGHLIGHT_MAX = 24;
/** blobRef 形状（sha256 hex64——与契约 BlobRefSchema 同源判据）。 */
const BLOB_REF_PATTERN = /^[0-9a-f]{64}$/;

/** 绝对路径折叠为 basename（Unix/Windows 均覆盖；URL 不动——scheme 开头非分隔符）。 */
function redactAbsolutePaths(value: string): string {
  return value.replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'，,）)）]{1,}/g, (matched) => {
    const base = matched.split(/[\\/]/).filter(Boolean).pop();
    return base !== undefined && base.length > 0 ? base : matched;
  });
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** 标量字段值投影（string 截断+脱敏；number/boolean 原样；其余 null）。 */
function scalarSummaryValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string' && value.length > 0) return truncate(redactAbsolutePaths(value), INPUT_PAIR_VALUE_MAX);
  return null;
}

interface SummaryPick {
  nameLike: Array<[string, string]>;
  idLike: Array<[string, string]>;
  countLike: Array<[string, string]>;
}

/** 对象浅层键值分桶（白名单三类；denylist 一律排除）。 */
function pickSummaryFields(source: Record<string, unknown>): SummaryPick {
  const pick: SummaryPick = { nameLike: [], idLike: [], countLike: [] };
  for (const [key, value] of Object.entries(source)) {
    if (SUMMARY_KEY_DENYLIST.test(key)) continue;
    const rendered = scalarSummaryValue(value);
    if (rendered === null) continue;
    if (NAME_LIKE_KEYS.test(key)) pick.nameLike.push([key, rendered]);
    else if (ID_LIKE_KEYS.test(key)) pick.idLike.push([key, rendered]);
    else if (COUNT_LIKE_KEYS.test(key)) pick.countLike.push([key, rendered]);
  }
  return pick;
}

function pairsText(pairs: Array<[string, string]>): string {
  return pairs.map(([key, value]) => `${key}=${value}`).join('，');
}

/** 入参 JSON 字符串 → inputSummary（≤200；无白名单字段=undefined——省略）。 */
export function summarizeToolInput(argsJson: string): string | undefined {
  const parsed = parseJsonObject(argsJson);
  if (parsed === null) return undefined;
  const pick = pickSummaryFields(parsed);
  const pairs = [...pick.nameLike, ...pick.countLike, ...pick.idLike.slice(0, 2)];
  if (pairs.length === 0) return undefined;
  return truncate(pairsText(pairs), INPUT_SUMMARY_MAX);
}

/** label 参数亮点：首个 name 类短字符串，无则回退 id/枚举类（「策略设计 · 密铺」形）。 */
function labelHighlight(argsJson: string): string | undefined {
  const parsed = parseJsonObject(argsJson);
  if (parsed === null) return undefined;
  const pick = pickSummaryFields(parsed);
  for (const [, value] of [...pick.nameLike, ...pick.idLike]) {
    if (value.length <= LABEL_HIGHLIGHT_MAX && /^[\p{Script=Han}\p{L}\p{N} _-]+$/u.test(value)) return value;
  }
  return undefined;
}

/** activity label：中文映射 + 参数亮点（有则 `映射 · 亮点`）。 */
export function activityLabelFor(rawName: string, argsJson: string): string {
  const canonical = canonicalToolName(rawName);
  const base = toolLabel(canonical);
  const highlight = labelHighlight(argsJson);
  return highlight !== undefined && highlight !== base ? `${base} · ${highlight}` : base;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  if (text.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 产出探测结果（ok 面：blobRef + summary；error 面：errorBrief）。 */
export interface ToolResultSummary {
  outputBlobRef?: string;
  outputSummary?: string;
  errorBrief?: string;
}

/**
 * 工具结果文本（MCP 面=CapabilityCallResult 的 JSON 序列化）→ 产出投影：
 *   - outputBlobRef：按优先级探测——imageBlobRef 键 > preview.after > bundle.png
 *     > 其余 blobRef 键 > preview.before
 *     （有界深度 4 的文档序首个合法 hex64；无则省略）；
 *   - outputSummary：根/value 对象的 name+count 类字段（`检出`类叙事不做逐工具
 *     定制——`note=导出完成，count=342` 形已可读）；非 JSON 文本=脱敏截断；
 *   - errorBrief：failed 的 message / denied 的 reason（+code）；非 JSON=原文截断。
 */
export function summarizeToolResult(resultText: string, isError: boolean): ToolResultSummary {
  const parsed = parseJsonObject(resultText);
  if (parsed === null) {
    const flat = redactAbsolutePaths(resultText.trim());
    if (flat.length === 0) return {};
    return isError
      ? { errorBrief: truncate(flat, ERROR_BRIEF_MAX) }
      : { outputSummary: truncate(flat, INPUT_SUMMARY_MAX) };
  }
  if (isError) {
    const brief =
      typeof parsed.message === 'string' && parsed.message.length > 0
        ? typeof parsed.code === 'string' && parsed.code.length > 0
          ? `${parsed.message}（${parsed.code}）`
          : parsed.message
        : typeof parsed.reason === 'string'
          ? `调用被拒（${parsed.reason}${typeof parsed.requestedOperation === 'string' ? `：${parsed.requestedOperation}` : ''}）`
          : undefined;
    return brief !== undefined ? { errorBrief: truncate(redactAbsolutePaths(brief), ERROR_BRIEF_MAX) } : {};
  }
  const outputBlobRef = probeOutputBlobRef(parsed);
  const value = isRecord(parsed.value) ? parsed.value : parsed;
  const pick = pickSummaryFields(value);
  const pairs = [...pick.countLike, ...pick.nameLike];
  const outputSummary = pairs.length > 0 ? truncate(pairsText(pairs), INPUT_SUMMARY_MAX) : undefined;
  return {
    ...(outputBlobRef !== undefined ? { outputBlobRef } : {}),
    ...(outputSummary !== undefined ? { outputSummary } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * blobRef 探测（优先级分桶，深度 ≤4）：imageBlobRef 键 > preview.after >
 * bundle.png > 其余 blobRef 键 > preview.before（before 最后——after 才是
 * 「产出后」的可视面）。文档序仅作桶内序。
 * 桶序依据（w20 走查 major-1，2026-10-02）：键语义即内容种类的最佳信号——
 * imageBlobRef 显式为图片（scene.analyze 的 intakeResample.imageBlobRef=归一
 * 底图 png）；preview.after/bundle.png 为既有可视面约定；其余 blobRef 键
 * （artifactBlobRef 等）内容种类未知——scene.analyze 的 artifactBlobRef 实为
 * scene-analysis.json（非图片，升 top 桶会让缩略图 src 指向 JSON），降后。
 */
function probeOutputBlobRef(root: Record<string, unknown>): string | undefined {
  const buckets: [string[], string[], string[], string[], string[]] = [[], [], [], [], []];
  const walk = (node: Record<string, unknown>, depth: number, parentKey: string): void => {
    if (depth > 4) return;
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'string' && BLOB_REF_PATTERN.test(value)) {
        if (/imageblobref$/i.test(key)) buckets[0].push(value);
        else if (key === 'after' && parentKey === 'preview') buckets[1].push(value);
        else if (key === 'png' && parentKey === 'bundle') buckets[2].push(value);
        else if (/blobref$/i.test(key)) buckets[3].push(value);
        else if (key === 'before' && parentKey === 'preview') buckets[4].push(value);
      } else if (isRecord(value)) {
        walk(value, depth + 1, key);
      }
    }
  };
  walk(root, 0, '');
  return buckets[0][0] ?? buckets[1][0] ?? buckets[2][0] ?? buckets[3][0] ?? buckets[4][0];
}
