/**
 * 0/1 掩码最近邻重采样（共享纯函数——add-vision-pipeline-v2 T1 / design D2「精度
 * 语义：请求侧降/结果侧升」的结果侧原语）。
 *
 * 语义源（Owner 定调 2026-10-03，design D2 原文口径）：「正确的抠图方式：检查分辨
 * 率，发现分辨率过大，降低分辨率，然后送给 SAM 开始抠图；返回结果，**将结果缩放
 * 成原图分辨率**，作为原图的 mask 抠出图层……最关键在于：返回结果缩放成原图分
 * 辨率——确保子图层尽量高清。」——`maskMaxSide`（精度/降采样）只作用于 SAM 请求
 * 侧（macmini 服务端把掩码 PIL NEAREST 缩到 cap 省带宽，见 sam-bridge/macmini/
 * sam3_service.py do_segment）；daemon 桥边界（sam-bridge materialize）把返回的
 * 请求分辨率掩码经本函数上采样回 tree.imagePx 后才落 blob/供消费（segment-loop
 * `ensureCanvasMask`/segment-one 全图锚点不变式；递归细分输入恒为原分辨率——
 * anchors.imagePx/imageBlobRef 全轮恒定，子层掩膜永不低于父层帧）。
 *
 * 历史注：本函数原为 sam-bridge.ts 私有实现（commit 80f973e——codex 复核
 * 2026-09-28 裁定「daemon 桥边界归一化」引入）；add-vision-pipeline-v2 T1 抽出为
 * vision 域共享纯函数（独立可测+消费点可复用），行为逐位不变。
 *
 * 采样口径与 PIL NEAREST 同族（中心对齐：dst 像素取
 * src[floor((d+0.5)×src/dst)]，越界钳 src-1）：字节面=Mask2D 同构逐像素 0/1
 * （非 packed bits/RGBA）——最近邻=块边界（等值区整块映射，不引入插值灰度），
 * 放大块边界与降采样网格对齐。维度已一致时原样返回（零拷贝——常规原尺寸掩码
 * 路径无额外成本）。纯 TS 无依赖、无 IO——同输入同输出。
 */

/**
 * 掩码最近邻重采样到目标尺寸（0/1 位平面；w*h 同构 Mask2D bits）。
 * 维度已一致时原样返回输入 bits 引用（零拷贝）。
 */
export function nearestResampleMaskBits(
  mask: { w: number; h: number; bits: Uint8Array },
  target: { width: number; height: number },
): Uint8Array {
  if (mask.w === target.width && mask.h === target.height) return mask.bits;
  const srcW = mask.w;
  const srcH = mask.h;
  const out = new Uint8Array(target.width * target.height);
  const colSrc = new Int32Array(target.width);
  for (let x = 0; x < target.width; x++) {
    colSrc[x] = Math.min(srcW - 1, Math.floor(((x + 0.5) * srcW) / target.width));
  }
  for (let y = 0; y < target.height; y++) {
    const rowSrc = Math.min(srcH - 1, Math.floor(((y + 0.5) * srcH) / target.height)) * srcW;
    const rowDst = y * target.width;
    for (let x = 0; x < target.width; x++) {
      out[rowDst + x] = mask.bits[rowSrc + colSrc[x]]!;
    }
  }
  return out;
}
