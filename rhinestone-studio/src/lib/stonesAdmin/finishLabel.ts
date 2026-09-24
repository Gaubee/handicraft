/*
 * finish 展示标签（add-stone-library S7.7 走查修复 2026-09-24）。
 * 原始需求：daemon 导入对草表缺质感字段落 finish='unspecified'（importer
 * DEFAULT_FINISH——不猜测 'glossy'，人审可改），该裸值曾在 UI 直接露出英文。
 * 展示层统一映射：
 *   ''/纯空白 → null（未填写——调用方隐藏该段）
 *   'unspecified' → 「未声明」（§8.1 规则 7——不猜测，显式声明缺失）
 *   其它 → 原值透传（glossy/matte 等人审值）
 */

export function finishLabel(finish: string): string | null {
  const trimmed = finish.trim()
  if (trimmed === '') return null
  if (trimmed === 'unspecified') return '未声明'
  return trimmed
}
