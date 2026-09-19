/*
 * Orthogonal intents (max 1):
 * 1. [2026-09-20 C-3.3 rename-and-expert-workbench] 六方格位吸附（现行 GridSpec 临时格，
 *    design §3.4）：rowAngleDeg 恒 0 → 行水平、奇数行偏移 pitch/2、行距 pitch×√3/2。
 *    最近格位点 = 吸附目标（笔刷落点/格位高亮共用）。W0 后随「当前 spec 的 pitch」
 *    重算（依赖轨 5.5），本函数只做纯几何。
 */

export interface SnapPoint {
  x: number
  y: number
}

/**
 * 最近六方格位点。lattice：偶数行 x = col×pitch，奇数行 x = pitch/2 + col×pitch；
 * 行距 pitch×√3/2。候选窗取最近三行 × 每行最近三列（最近点必在窗内——格距上界证明同
 * 空间索引 3×3 邻域论证）。
 */
export function hexSnapPoint(x: number, y: number, pitchPx: number): SnapPoint {
  if (!(pitchPx > 0)) return { x, y }
  const rowH = pitchPx * Math.sqrt(3) / 2
  const half = pitchPx / 2
  const rowMid = Math.round(y / rowH)

  let best: SnapPoint = { x, y }
  let bestD = Number.POSITIVE_INFINITY
  for (let row = rowMid - 1; row <= rowMid + 1; row++) {
    const rowY = row * rowH
    const offset = row % 2 === 0 ? 0 : half // 负行取余：-1 % 2 === -1 → 奇行偏移（对称格）
    const colMid = Math.round((x - offset) / pitchPx)
    for (let col = colMid - 1; col <= colMid + 1; col++) {
      const px = offset + col * pitchPx
      const d = (px - x) * (px - x) + (rowY - y) * (rowY - y)
      if (d < bestD) {
        bestD = d
        best = { x: px, y: rowY }
      }
    }
  }
  return best
}
