/*
 * Orthogonal intents (max 1):
 * 1. [2026-09-18 N1] 画布取景纯函数：contain 适配（scale = min(cw/iw, ch/ih) × 0.9）+ 居中平移。
 *    BlockCanvas fitView 的唯一计算源；jsdom 无法真渲染，取景正确性靠本模块单测兜底
 *    （方形/宽图/高图 × 容器组合，断言居中且 ≥90% 可见）。
 */

/** 适配留白系数：图占容器至多该比例（0.9 → 四周各留 5%，取景不贴边） */
export const FIT_SCALE_FACTOR = 0.9

export interface FitView {
  scale: number
  x: number
  y: number
}

/**
 * contain 取景：图像等比缩放后居中放置在容器内。
 * 退化输入（非有限值或任一维度 ≤ 0）返回单位视图，由调用方的容器尺寸兜底逻辑接管。
 */
export function computeFit(containerW: number, containerH: number, imageW: number, imageH: number): FitView {
  if (![containerW, containerH, imageW, imageH].every((v) => Number.isFinite(v) && v > 0)) {
    return { scale: 1, x: 0, y: 0 }
  }
  const scale = Math.min(containerW / imageW, containerH / imageH) * FIT_SCALE_FACTOR
  return {
    scale,
    x: (containerW - imageW * scale) / 2,
    y: (containerH - imageH * scale) / 2,
  }
}
