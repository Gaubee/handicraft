/**
 * agent 多模态预览缩略图渲染（add-vision-pipeline-v2 D5——纯函数零 IO）。
 * 通道形态（design D5「工具结果面附预览 blobRef+多模态通道」）：
 *   [1] 节点掩膜特写：原图 bbox 区域裁剪+掩膜半透明红叠加（病态掩膜 warning 携带
 *       ——agent 真看图后自主决策重试/降级）；
 *   [2] 树叠加总览：object-tree-preview.png（人看轨产物）缩略化复刻给 agent。
 * 两者均最近邻降采样到 maxSide（成本上限——多模态 token 面），PNG 编码（codec
 * 单源）；落 blob（putTaskArtifact——fence 语义随 jobs/service 单点）。
 * 分层：渲染=纯函数（downscale/overlay/encode 零 IO）；物化=IO 面
 * （materializeNodeMaskPreviews——blob 写入，供 segment-tool/segment-one 共用）。
 * 纯度：无随机；decodePng/encodePng 为本地纯编解码。
 */
import { encodePng } from '../../png/codec.js';
import type { NodeBBox } from '@handicraft/contracts';
import type { AgentImagePreview } from '@handicraft/contracts';
import type { SqliteDb } from '../../db/database.js';
import type { BlobStore } from '../../db/blobs.js';
import { putTaskArtifact } from '../../jobs/service.js';
import type { MaskQualityReason } from './mask-quality.js';

// ---------------------------------------------------------------- 成本开关（env）

/**
 * 预览回流开关 env 键（add-vision-pipeline-v2 D5「token 成本开关」）：
 * ='0' 关闭（工具结果不带多模态载荷——质量门 warning 仍回文本面）；其余/缺席=开。
 * 缺省开：验收口径 7（agent 收到病态掩膜时能看见预览图并自主重试）要求回流在场；
 * 成本敏感部署显式置 0 关闭。
 */
export const SEGMENT_AGENT_MASK_PREVIEW_ENV = 'SEGMENT_AGENT_MASK_PREVIEW';

/** 缩略图长边上限 env 键（px；128..2048 界内整数才采用）。 */
export const SEGMENT_AGENT_MASK_PREVIEW_MAX_SIDE_ENV = 'SEGMENT_AGENT_MASK_PREVIEW_MAX_SIDE';

/** 缩略图长边上限缺省（px——多模态 token 成本面；512=细部可判读的成本档）。 */
export const SEGMENT_AGENT_MASK_PREVIEW_MAX_SIDE_DEFAULT = 512;

/** 单次调用节点特写张数上限（病态节点多时截断——防 N 图洪泛）。 */
export const SEGMENT_AGENT_MASK_PREVIEW_NODE_CAP = 4;

/** 开关读取（缺省开——见上；惰性读 env，测试可在 import 后置）。 */
export function segmentAgentPreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[SEGMENT_AGENT_MASK_PREVIEW_ENV] !== '0';
}

/** 长边上限读取（128..2048 界内整数才采用，否则缺省）。 */
export function segmentAgentPreviewMaxSide(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env[SEGMENT_AGENT_MASK_PREVIEW_MAX_SIDE_ENV]);
  return Number.isInteger(raw) && raw >= 128 && raw <= 2048 ? raw : SEGMENT_AGENT_MASK_PREVIEW_MAX_SIDE_DEFAULT;
}

// ---------------------------------------------------------------- 渲染（纯函数）

/**
 * 最近邻降采样（maxSide=长边上限；不放大——小于上限原样返回尺寸）。
 * 返回 {rgba, width, height}（新分配；输入不改）。
 */
export function downscaleRgbaNearest(
  image: { width: number; height: number; rgba: Uint8Array },
  maxSide: number,
): { width: number; height: number; rgba: Uint8Array } {
  const { width, height, rgba } = image;
  const longSide = Math.max(width, height);
  if (longSide <= maxSide) {
    return { width, height, rgba: new Uint8Array(rgba) };
  }
  const scale = maxSide / longSide;
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(height - 1, Math.floor((y * height) / outH));
    for (let x = 0; x < outW; x++) {
      const sx = Math.min(width - 1, Math.floor((x * width) / outW));
      const si = (sy * width + sx) * 4;
      const di = (y * outW + x) * 4;
      out[di] = rgba[si]!;
      out[di + 1] = rgba[si + 1]!;
      out[di + 2] = rgba[si + 2]!;
      out[di + 3] = rgba[si + 3]!;
    }
  }
  return { width: outW, height: outH, rgba: out };
}

/**
 * 节点掩膜特写缩略图：原图裁 bbox 区域 → 掩膜像素半透明红叠加（128/255——
 * 病态掩膜在原图语境可判读）→ 最近邻降采样 → PNG。
 * bits=画布级 0/1（与 imagePx 同维）；bbox 出界按钳位裁剪（防御——调用方构造保证界内）。
 */
export function renderNodeMaskPreview(input: {
  image: { width: number; height: number; rgba: Uint8Array };
  /** 画布级掩膜 bits（与 image 同维） */
  bits: Uint8Array;
  bbox: NodeBBox;
  maxSide: number;
}): Uint8Array {
  const { image, bits, bbox, maxSide } = input;
  const x0 = Math.max(0, Math.min(image.width - 1, bbox.x));
  const y0 = Math.max(0, Math.min(image.height - 1, bbox.y));
  const x1 = Math.max(x0 + 1, Math.min(image.width, bbox.x + bbox.w));
  const y1 = Math.max(y0 + 1, Math.min(image.height, bbox.y + bbox.h));
  const w = x1 - x0;
  const h = y1 - y0;
  const crop = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * image.width + (x0 + x)) * 4;
      const di = (y * w + x) * 4;
      if (bits[(y0 + y) * image.width + (x0 + x)] === 1) {
        // 掩膜叠加红（alpha 128 半透明——底图语义保留）
        crop[di] = 255;
        crop[di + 1] = 40;
        crop[di + 2] = 40;
        crop[di + 3] = 160;
      } else {
        crop[di] = image.rgba[si]!;
        crop[di + 1] = image.rgba[si + 1]!;
        crop[di + 2] = image.rgba[si + 2]!;
        crop[di + 3] = image.rgba[si + 3]!;
      }
    }
  }
  const small = downscaleRgbaNearest({ width: w, height: h, rgba: crop }, maxSide);
  return encodePng(small.width, small.height, small.rgba);
}

/** 总览缩略图（人看轨 preview PNG 的 agent 复刻——解码后仅降采样）。 */
export function renderOverlayPreviewThumbnail(
  image: { width: number; height: number; rgba: Uint8Array },
  maxSide: number,
): Uint8Array {
  const small = downscaleRgbaNearest(image, maxSide);
  return encodePng(small.width, small.height, small.rgba);
}

// ---------------------------------------------------------------- 物化（blob IO）

/** 节点特写物化输入（质量门命中节点——bits=画布级）。 */
export interface NodeMaskPreviewRequest {
  nodeId: string;
  objectName: string;
  reason: MaskQualityReason;
  bbox: NodeBBox;
  /** 画布级 0/1 bits（与 image 同维） */
  bits: Uint8Array;
}

/**
 * 节点特写批量物化（IO 面：渲染+putTaskArtifact 落任务域 blob——fence 同事务语义
 * 随 putTaskArtifact；超出 NODE_CAP 截断）：返回 AgentImagePreview[]（含 blobRef+
 * dataBase64 多模态载荷——MCP 投影按约定字段提升为 image content）。开关关闭=空
 * 数组（调用方缺席字段）。
 */
export function materializeNodeMaskPreviews(input: {
  db: SqliteDb;
  blobs: BlobStore;
  taskId: string;
  image: { width: number; height: number; rgba: Uint8Array };
  flagged: NodeMaskPreviewRequest[];
  maxSide: number;
}): AgentImagePreview[] {
  const out: AgentImagePreview[] = [];
  for (const flag of input.flagged.slice(0, SEGMENT_AGENT_MASK_PREVIEW_NODE_CAP)) {
    const png = renderNodeMaskPreview({ image: input.image, bits: flag.bits, bbox: flag.bbox, maxSide: input.maxSide });
    const blobRef = putTaskArtifact({ db: input.db, blobs: input.blobs }, input.taskId, png).hash;
    out.push({
      kind: 'node-mask',
      nodeId: flag.nodeId,
      objectName: flag.objectName,
      reason: flag.reason,
      blobRef,
      mime: 'image/png',
      maxSide: input.maxSide,
      dataBase64: Buffer.from(png).toString('base64'),
    });
  }
  return out;
}
