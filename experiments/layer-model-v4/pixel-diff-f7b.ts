/**
 * F7b 背景层像素差断言（rework-layer-model v4 修复轮 5.7b——入库版 2026-09-28）。
 *
 * 用途：真浏览器走查「隐藏背景层」步骤的像素级验收——三区精确化断言：
 *   - 画布外（stage 底）：不随背景显隐变化（变化≈0）；
 *   - 画布内非层区：背景层像素消失 ⇒ 必变（≥95%，走查实证阈值 99%）；
 *   - 层实体区：抠图层（cutout）保留——实体色域在场（帽子红系/脸蛋肤系各≥15%）。
 *
 * 输入（argv 或缺省 /tmp/walk-v4-r2）：px-px-base-on-full.png / px-px-base-off-full.png
 * （CDP Page.captureScreenshot 全页帧——开/关背景两态）、pixel-geom.json（走查探针
 * 导出：{stage:{x,y,w,h}, world:{x,y,w,h}, boxes:[{id,x,y,w,h}]}）。PNG 解码复用
 * daemon/src/png/codec.js（同仓单源）。
 *
 * 运行（nub）：nub experiments/layer-model-v4/pixel-diff-f7b.ts [dir]
 * r2 走查实证记录：总差异 3.9%·画布外 0.0%·画布内非层 99.6%·帽子红 62.2%·脸肤
 * 78.5%——.agents/images/2026-09-27-layer-model-v4/（r2-* 截图；tasks.md 5.7b）。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decodePng } from '../../daemon/src/png/codec.js'

const dir = process.argv[2] ?? '/tmp/walk-v4-r2'
const geom = JSON.parse(readFileSync(resolve(dir, 'pixel-geom.json'), 'utf8')) as {
  stage: { x: number; y: number; w: number; h: number }
  world: { x: number; y: number; w: number; h: number }
  boxes: Array<{ id: string; x: number; y: number; w: number; h: number }>
}
const { stage, world } = geom
const onFull = decodePng(new Uint8Array(readFileSync(resolve(dir, 'px-base-on-full.png'))))
const offFull = decodePng(new Uint8Array(readFileSync(resolve(dir, 'px-base-off-full.png'))))

/** stage 区裁剪（走查帧 → 画布舞台坐标系）。 */
const crop = (img: { width: number; height: number; rgba: Uint8Array }) => {
  const w = stage.w
  const h = stage.h
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = ((y + stage.y) * img.width + (x + stage.x)) * 4
      const dst = (y * w + x) * 4
      out[dst] = img.rgba[src]!
      out[dst + 1] = img.rgba[src + 1]!
      out[dst + 2] = img.rgba[src + 2]!
      out[dst + 3] = img.rgba[src + 3]!
    }
  }
  return { width: w, height: h, rgba: out }
}
const on = crop(onFull)
const off = crop(offFull)
const inRect = (x: number, y: number, r: { x: number; y: number; w: number; h: number }): boolean =>
  x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h

let outsideTotal = 0
let outsideChanged = 0
let canvasNonLayerTotal = 0
let canvasNonLayerChanged = 0
let hatRedInOff = 0
let faceSkinInOff = 0
let hatBox: { x: number; y: number; w: number; h: number } | null = null
let faceBox: { x: number; y: number; w: number; h: number } | null = null
for (const b of geom.boxes) {
  if (b.id === 'n-hat') hatBox = b
  if (b.id === 'n-face') faceBox = b
}
for (let y = 0; y < on.height; y += 1) {
  for (let x = 0; x < on.width; x += 1) {
    const p = (y * on.width + x) * 4
    const changed =
      on.rgba[p] !== off.rgba[p] ||
      on.rgba[p + 1] !== off.rgba[p + 1] ||
      on.rgba[p + 2] !== off.rgba[p + 2] ||
      on.rgba[p + 3] !== off.rgba[p + 3]
    const inLayer = geom.boxes.some((b) => inRect(x, y, b))
    const inCanvas = inRect(x, y, world)
    if (!inCanvas) {
      outsideTotal += 1
      if (changed) outsideChanged += 1
    } else if (!inLayer) {
      canvasNonLayerTotal += 1
      if (changed) canvasNonLayerChanged += 1
    }
    // 抠图实体色域在场（off 帧）：帽子红系（R>170 G<140 B<120）/脸蛋肤系（R>230 G>200 B>160）
    if (off.rgba[p + 3] === 255 && off.rgba[p]! > 170 && off.rgba[p + 1]! < 140 && off.rgba[p + 2]! < 120 && hatBox !== null && inRect(x, y, hatBox)) hatRedInOff += 1
    if (off.rgba[p + 3] === 255 && off.rgba[p]! > 230 && off.rgba[p + 1]! > 200 && off.rgba[p + 2]! > 160 && faceBox !== null && inRect(x, y, faceBox)) faceSkinInOff += 1
  }
}
const hatRedRatio = hatBox !== null ? hatRedInOff / (hatBox.w * hatBox.h) : 0
const faceSkinRatio = faceBox !== null ? faceSkinInOff / (faceBox.w * faceBox.h) : 0
const outsideChangedRatio = outsideChanged / Math.max(1, outsideTotal)
const nonLayerChangedRatio = canvasNonLayerChanged / Math.max(1, canvasNonLayerTotal)
console.log(
  `画布外变化=${(outsideChangedRatio * 100).toFixed(1)}%（应≈0——stage 底不随背景变） ` +
    `画布内非层变化=${(nonLayerChangedRatio * 100).toFixed(1)}%（应≥95——背景层像素消失） ` +
    `抠图实体色域在场 off 帧：帽子红=${(hatRedRatio * 100).toFixed(1)}% 脸肤=${(faceSkinRatio * 100).toFixed(1)}%（各≥15）`,
)
if (outsideChangedRatio > 0.005) throw new Error('FAIL 画布外区域随背景显隐变化——舞台底被牵连')
if (nonLayerChangedRatio < 0.95) throw new Error('FAIL 画布内非层区域未全变——背景层像素未真正消失')
if (hatRedRatio < 0.15) throw new Error('FAIL 隐藏背景后帽子红系抠图实体缺席（cutout 未保留）')
if (faceSkinRatio < 0.15) throw new Error('FAIL 隐藏背景后脸蛋肤系抠图实体缺席（cutout 未保留）')
console.log('F7B_PIXEL_DIFF_PASS')
