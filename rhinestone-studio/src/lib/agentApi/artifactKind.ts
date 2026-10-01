/*
 * [w17-critic T5] 工件图片类判定（*.png 为主，常见位图后缀一并归入——同一「可看图」
 * 语义）。工件 chip/工件行据此分流：图片类点击开应用内 Lightbox（缩放/平移/切图），
 * 其余保持外链/纯文本行。
 */

/** 图片类工件判定（按工件名后缀——daemon 导出面 png 为主）。 */
export function isImageArtifactName(name: string): boolean {
  return /\.(png|jpe?g|webp|gif|avif)$/i.test(name)
}
