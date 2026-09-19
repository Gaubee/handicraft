/**
 * 案例合成参照图（[Owner 2026-09-19] 概念重构）：
 * 「原图→效果图 参照对」是对 /images/edits 的过度抽象——接口只认一张张图。
 * 新模型：案例侧产出**一张**合成参照图（canvas 拼接 + 布局模板标注「原图」「效果图」），
 * 参考图（目标图）单列其下；提示词按合成图的布局描述两半的含义。
 *
 * 正交意图：
 * 1. [2026-09-19 Layout] 布局判定纯函数 pickCaseLayout：两图任一宽高比 > 4/3（大横图）
 *    → 纵向堆叠（避免合成图过宽），否则横向并排（默认）。
 * 2. [2026-09-19 Compose] composeCaseComposite：canvas 绘制两图（contain 适配）+ 中缝分隔
 *    + 两半角标「原图」「效果图」；输出 PNG Blob。jsdom 无 2D 上下文 → 返回 null（调用方降级）。
 * 3. [2026-09-19 Purity] 判定与绘制分离：判定可测（jsdom），绘制走真机走查验证。
 */

export type CaseCompositeLayout = 'horizontal' | 'vertical'

/** 案例参照图的完整布局形态：拼接两态 + 单张直传（[Owner 2026-09-19] 上传方案②）。 */
export type CaseRefLayout = CaseCompositeLayout | 'single'

/** UI 展示用布局名（「案例图」角标下方的布局注记）。 */
export function caseLayoutLabel(layout: CaseRefLayout): string {
  if (layout === 'horizontal') return '横向拼接（左原图 · 右效果图）'
  if (layout === 'vertical') return '纵向拼接（上原图 · 下效果图）'
  return '单张效果图'
}

/** 宽高比阈值：任一图 w/h 超过此值 → 纵向（16:9 大横图横向拼接会得到超宽合成图） */
export const VERTICAL_LAYOUT_ASPECT_THRESHOLD = 4 / 3

export function pickCaseLayout(
  src: { width: number; height: number },
  res: { width: number; height: number },
): CaseCompositeLayout {
  const aspect = (d: { width: number; height: number }): number => (d.height > 0 ? d.width / d.height : 1)
  return Math.max(aspect(src), aspect(res)) > VERTICAL_LAYOUT_ASPECT_THRESHOLD ? 'vertical' : 'horizontal'
}

/** 合成图目标半幅尺寸（px）：以两图较大边为基准，限制在 1024 内（上传降采样口径一致） */
const HALF_BASE = 768
const LABEL_FONT = 'bold 26px system-ui, "PingFang SC", sans-serif'

export interface CompositeSourceImage {
  bitmap: CanvasImageSource
  width: number
  height: number
}

/**
 * 绘制合成参照图：横向 = 左原图/右效果图；纵向 = 上原图/下效果图。
 * 两半各自 contain 适配到半幅，中缝分隔线，左上角标文字「原图」「效果图」。
 * 返回 null 当环境无 2D 上下文（jsdom）。
 */
export function composeCaseComposite(
  src: CompositeSourceImage,
  res: CompositeSourceImage,
  layout: CaseCompositeLayout,
): HTMLCanvasElement | null {
  const scale = Math.min(1, HALF_BASE / Math.max(src.width, src.height), HALF_BASE / Math.max(res.width, res.height))
  const halfW = Math.max(64, Math.round(Math.max(src.width, res.width) * scale))
  const halfH = Math.max(64, Math.round(Math.max(src.height, res.height) * scale))
  const divider = 4
  const canvas = document.createElement('canvas')
  canvas.width = layout === 'horizontal' ? halfW * 2 + divider : halfW
  canvas.height = layout === 'horizontal' ? halfH : halfH * 2 + divider
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  const slot = (image: CompositeSourceImage, x: number, y: number, w: number, h: number): void => {
    const s = Math.min(w / image.width, h / image.height)
    const dw = image.width * s
    const dh = image.height * s
    ctx.drawImage(image.bitmap, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
  }
  const label = (text: string, x: number, y: number): void => {
    ctx.font = LABEL_FONT
    const padding = 8
    const metrics = ctx.measureText(text)
    const boxW = metrics.width + padding * 2
    const boxH = 26 + padding
    ctx.fillStyle = 'rgba(0,0,0,0.72)'
    ctx.fillRect(x, y, boxW, boxH)
    ctx.fillStyle = '#ffffff'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + padding, y + boxH / 2 + 1)
  }

  ctx.fillStyle = '#f5f5f4'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  if (layout === 'horizontal') {
    slot(src, 0, 0, halfW, halfH)
    slot(res, halfW + divider, 0, halfW, halfH)
    ctx.fillStyle = '#d6d3d1'
    ctx.fillRect(halfW, 0, divider, canvas.height)
    label('原图', 10, 10)
    label('效果图', halfW + divider + 10, 10)
  } else {
    slot(src, 0, 0, halfW, halfH)
    slot(res, 0, halfH + divider, halfW, halfH)
    ctx.fillStyle = '#d6d3d1'
    ctx.fillRect(0, halfH, canvas.width, divider)
    label('原图', 10, 10)
    label('效果图', 10, halfH + divider + 10)
  }
  return canvas
}

/** 合成 canvas → PNG Blob（绑定时物化为资产用） */
export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('canvas.toBlob 返回空'))), 'image/png')
  })
}

/** 图片文件/URL → 可绘制源（含尺寸）；jsdom Image onload 由调用方测试桩处理 */
export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`图片加载失败：${url}`))
    img.src = url
  })
}
