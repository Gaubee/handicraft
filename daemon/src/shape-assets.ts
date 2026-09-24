/**
 * .gemshape 资产解析（W4.2 R1 P1-4 收口——单一真源）。
 * 语义范本=W2 交付的 jobs/engine.ts 解析链（gate/SVG/BOM/PNG 四处同源），本轮抽出
 * 共享模块：studio 工具面（export-dryrun / studio.export）与 engine job 复用同一
 * 解析器——LayoutDocument.shapeAssets 含有效 assetId 时，Agent 导出路径的 custom 形
 * 可达（不再恒 missing-asset），且与 job 导出三产物同源（design §6.3：禁静默替代，
 * 缺资产=显式拒绝）。
 * 解析语义（与 jobs/engine 原实现逐字一致）：
 *   - assetBytesOf：shapeAssets 映射 assetId→blobRef；缺映射或 blob 不可读=null
 *     （gate 6 判据：节点不存在）。
 *   - parseGemshapeAsset：.gemshape JSON（kind 判别；vectorPath 矢量优先，
 *     texture.image 贴图次之——两者皆缺=不可渲染）。
 *   - resolveShapeAssetStateOf：exportGate 面（'resolved'|'wrong-kind'|null）。
 *   - shapeResolverOf：buildSvg/buildBom 面（GemshapeRenderData|undefined）。
 *   - assetResolverOf：renderGemsPng 面（未解析=null——渲染面抛 PngAssetUnresolvedError）。
 */
import type { BlobRef } from '@handicraft/contracts';
import type { Gem, GemshapeRenderData, ShapeAssetRefState } from 'rhinestone-studio/engine';
import type { BlobStore } from './db/blobs.js';
import type { ShapeAssetSource } from './share.js';

/** .gemshape 资产字节（shapeAssets 映射缺席/blob 不可读=null——节点不存在）。 */
export function assetBytesOf(
  blobs: BlobStore,
  shapeAssets: Record<string, BlobRef>,
  assetId: string,
): Uint8Array | null {
  const ref = shapeAssets[assetId];
  if (ref === undefined) return null;
  return blobs.read(ref);
}

export function parseGemshapeAsset(bytes: Uint8Array): ShapeAssetSource | null {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
    if (parsed['kind'] !== 'gemshape') return null;
    const texture = parsed['texture'] as Record<string, unknown> | undefined;
    return {
      vectorPath: typeof parsed['vectorPath'] === 'string' ? (parsed['vectorPath'] as string) : undefined,
      image:
        texture && typeof texture['dataUrl'] === 'string'
          ? {
              mime: typeof texture['mime'] === 'string' ? (texture['mime'] as string) : 'image/png',
              dataUrl: texture['dataUrl'] as string,
              width: Number(texture['width'] ?? 0),
              height: Number(texture['height'] ?? 0),
            }
          : undefined,
    };
  } catch {
    return null;
  }
}

/** exportGate resolveShapeAsset（解析态三值：resolved / wrong-kind / null=节点不存在）。 */
export function resolveShapeAssetStateOf(
  blobs: BlobStore,
  shapeAssets: Record<string, BlobRef>,
  assetId: string,
): ShapeAssetRefState {
  const bytes = assetBytesOf(blobs, shapeAssets, assetId);
  if (bytes === null) return null;
  const asset = parseGemshapeAsset(bytes);
  if (asset === null) return 'wrong-kind';
  if (asset.vectorPath === undefined && asset.image === undefined) return 'wrong-kind';
  return 'resolved';
}

/** buildSvg/buildBom resolveShape（矢量优先；未解析=undefined→占位/missing 标记）。 */
export function shapeResolverOf(
  blobs: BlobStore,
  shapeAssets: Record<string, BlobRef>,
): (gem: Gem) => GemshapeRenderData | undefined {
  return (gem) => {
    if (gem.assetId === undefined) return undefined;
    const bytes = assetBytesOf(blobs, shapeAssets, gem.assetId);
    if (bytes === null) return undefined;
    const asset = parseGemshapeAsset(bytes);
    if (!asset || (asset.vectorPath === undefined && asset.image === undefined)) return undefined;
    return {
      ...(asset.vectorPath !== undefined ? { vectorPath: asset.vectorPath } : {}),
      ...(asset.image !== undefined
        ? { image: { dataUrl: asset.image.dataUrl, width: asset.image.width, height: asset.image.height } }
        : {}),
    };
  };
}

/** PNG render resolveAsset（与门校验同源；未解析=null→渲染面 PngAssetUnresolvedError）。 */
export function assetResolverOf(
  blobs: BlobStore,
  shapeAssets: Record<string, BlobRef>,
): (assetId: string) => ShapeAssetSource | null {
  return (assetId) => {
    const bytes = assetBytesOf(blobs, shapeAssets, assetId);
    if (bytes === null) return null;
    return parseGemshapeAsset(bytes);
  };
}
