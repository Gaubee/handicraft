/**
 * 识图升级会话标题（title 第三自动源，2026-10-02）：
 * Owner 质疑「title 插件没接收初始图片——模板化提示词只会产出模板化 title」——
 * dsh-session-title eligible 只取 text 块，图片语义 0 参与。裁定（Owner 口径）：
 * 图片语义在管线里本来就会被提取成结构化文字（scene.analyze 产物的中文主体名），
 * 用管线自己的识图产物命名——在 daemon 侧加「识图升级 title」源。
 * 正交意图：
 *   [1] title 素材提取：SceneAnalysis elements → 主体名（顶层 parentElementId
 *       null/缺席；滤 background 类与 suggestDrillWorthy=false——黑背景/强灯光
 *       不是主体；面积降序排主体显著性，并列取数组序——确定性）。
 *   [2] title 合成（人话+简短）：主体名优先；多主体取前 2 以「 · 」并列；主体名
 *       已足够短（≤8 字）不加区域数，否则附「（N 区域）」（N=元素总数，含部位
 *       ——与走查实证的 object-tree「小丑（12 区域）」量级同源）；≤40 字守
 *       boot patch maxTitleBytes=120≈40 中文字上限口径。
 *   [3] 守门落库：复用 db/sessions.applyKernelSessionTitle 单点（source kind=
 *       'vision'——非 'user' 自动源，同 fallback→provider 升级链：仅 title_owner
 *       NULL 或本 task 时写；user rename 永不覆盖）。识图跑几十秒=天然后发升级。
 *   [4] 不进模型输入：title 只落库不回流对话（同 title 插件承诺——本模块零
 *       prompt 触点）。
 */
import type { SceneAnalysis, SceneElement } from '@handicraft/contracts';
import type { SqliteDb } from '../../db/database.js';
import { applyKernelSessionTitle } from '../../db/sessions.js';

/** 识图升级源 kind（title_owner 守门面——非 'user' 即自动源，同 fallback/provider 门）。 */
export const SCENE_TITLE_SOURCE_KIND = 'vision';

/** 标题字符上限（boot patch maxTitleBytes=120 bytes≈40 个中文字——中文口径）。 */
export const SCENE_TITLE_MAX_CHARS = 40;

/** 「主体名已足够短」阈值：拼接主体名 ≤ 此字数不加区域数（人话+简短优先）。 */
const SCENE_TITLE_SHORT_CHARS = 8;

/** 多主体并列分隔符。 */
const SUBJECT_SEPARATOR = ' · ';

/** 主体元素（顶层 ∩ 非 background ∩ 值得贴），按包围盒面积降序（并列取数组序）。 */
function rankedSubjectElements(analysis: SceneAnalysis): SceneElement[] {
  const areaOf = (element: SceneElement): number => element.boxPx.w * element.boxPx.h;
  return analysis.elements
    .map((element, index) => ({ element, index }))
    .filter(
      ({ element }) =>
        (element.parentElementId === null || element.parentElementId === undefined) &&
        element.category !== 'background' &&
        element.suggestDrillWorthy !== false,
    )
    .sort((a, b) => areaOf(b.element) - areaOf(a.element) || a.index - b.index)
    .map(({ element }) => element);
}

/**
 * SceneAnalysis → 会话标题素材合成（纯函数）。返回 undefined=无主体素材（全
 * background/不值得贴——不升级，留既有 title 接手）。
 */
export function sceneTitleFromAnalysis(analysis: SceneAnalysis): string | undefined {
  const names: string[] = [];
  for (const element of rankedSubjectElements(analysis)) {
    const name = element.name.trim();
    if (name.length > 0 && !names.includes(name)) names.push(name);
    if (names.length === 2) break;
  }
  if (names.length === 0) return undefined;
  const base = names.join(SUBJECT_SEPARATOR);
  // 区域数（N=元素总数含部位）只在主体名不够短时附加——足够短的名不加（口径：
  // 「小丑」优于「小丑（12 区域）」；长名并列时区域数补区分度）。
  const titled =
    base.length <= SCENE_TITLE_SHORT_CHARS ? base : `${base}（${analysis.elements.length} 区域）`;
  return titled.length > SCENE_TITLE_MAX_CHARS ? titled.slice(0, SCENE_TITLE_MAX_CHARS) : titled;
}

/**
 * 识图升级 title 落库（scene-analysis 工件落库点唯一调用面）：素材缺席/守门拒
 * （user pin/异 task 持有）静默跳过。异常上抛由调用方 best-effort 兜住——title
 * 是元数据，绝不影响 analyze 主链。
 */
export function applySceneAnalysisTitle(db: SqliteDb, taskId: string, analysis: SceneAnalysis): void {
  const title = sceneTitleFromAnalysis(analysis);
  if (title === undefined) return;
  applyKernelSessionTitle(db, taskId, title, SCENE_TITLE_SOURCE_KIND);
}
