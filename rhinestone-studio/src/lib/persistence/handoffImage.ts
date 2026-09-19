/**
 * handoff 图像消费单点（openspec add-project-files design §9.2 B2，切片 0.6）。
 *
 * getHandoffImageBlob(assetId) 是「跨模块消费图片字节」的统一出口：
 * - 图片节点直取物理 blob（零解码零重编码）；
 * - gemgen 档案节点经 parseGemgen 校验（节点类型 × 节点声明 mime × PROJECT_MIME.gemgen
 *   × 文件内 kind × formatVersion）后取内嵌图（dataUrl → 原始字节 Blob，零重编码）。
 *
 * typed error 三态分别可辨（B2 契约）：
 * - 缺失：HandoffImageMissingError（节点不存在 / 软删——回收站口径同 getAssetBlob 对
 *   trashedAt 返回 null / 物理记录丢失）；
 * - 版本超前：LabFileVersionError（parseGemgen 版本门，透传）；
 * - 损坏：LabFileFieldError / LabFileKindError（JSON 损坏、字段脏、dataUrl 坏、mime 交叉
 *   不符，透传）；另有节点类型不符：HandoffImageKindError（图片节点 / 非 gemgen 项目节点）。
 *
 * 落点裁决（0.6）：labFile 是纯序列化层（无 IDB，assetId→file 的库读取包装明确不在本层，
 * 见其文件头）；assetStore 是虚拟文件系统层（不 import parser——数据层不反向依赖格式层）。
 * 故本模块是组合两者的第三个薄 seam，属 persistence 层：studio.loadFromHandoff（本切片
 * 已接线）与下载 / 预览 / 画廊（各自切片接线）共用。
 */

import {
  getAsset,
  getAssetBlob,
  getProject,
  type AssetImage,
} from '$lib/persistence/assetStore'
import { getImageBlob } from '$lib/persistence/imageStore'
import { gemgenImageBlob, parseGemgen } from '$lib/persistence/labFile'
import type { AssetProject } from '$lib/persistence/projectTypes'

// ---------------------------------------------------------------------------
// typed error 家族（出口侧两态；版本超前/损坏由 labFile 家族透传）
// ---------------------------------------------------------------------------

/** handoff 图像消费错误基类（携带 assetId 供调用方定位/上报）。 */
export class HandoffImageError extends Error {
  constructor(
    message: string,
    public readonly assetId: string,
  ) {
    super(message)
    this.name = 'HandoffImageError'
  }
}

/** 缺失：节点不存在、已在回收站（软删口径同 getAssetBlob）或物理记录丢失。 */
export class HandoffImageMissingError extends HandoffImageError {
  constructor(assetId: string) {
    super('图像素材已缺失（不存在、已在回收站或物理记录丢失），无法消费。', assetId)
    this.name = 'HandoffImageMissingError'
  }
}

/** 节点类型不符：目标不是 gemgen 档案（图片节点 / 其他 kind 的项目节点）。 */
export class HandoffImageKindError extends HandoffImageError {
  constructor(
    assetId: string,
    /** 实际形态描述（如 '图片节点'、'gemproj 项目节点'）。 */
    public readonly found: string,
  ) {
    super(`目标不是 gemgen 生成档案（实际为 ${found}），无法取出内嵌图。`, assetId)
    this.name = 'HandoffImageKindError'
  }
}

// ---------------------------------------------------------------------------
// 节点解析（project/image 二分化；两者皆 null = 缺失或文件夹等不可消费节点）
// ---------------------------------------------------------------------------

async function resolveNode(
  assetId: string,
): Promise<{ project: AssetProject | null; image: AssetImage | null }> {
  const [project, image] = await Promise.all([
    getProject(assetId).catch(() => null),
    getAsset(assetId).catch(() => null),
  ])
  return { project, image }
}

/**
 * gemgen 专检核心（节点已读出）：缺失 / 软删（含软删图片，缺失口径）/ 非 gemgen 节点
 * typed 分流 → 物理记录读取 → TextDecoder 解码 → parseGemgen（mime 用**节点声明值**做
 * 交叉校验：与 PROJECT_MIME.gemgen 不符 = LabFileKindError）→ gemgenImageBlob（零重编码）。
 */
async function gemgenBlobFrom(
  assetId: string,
  project: AssetProject | null,
  image: AssetImage | null,
): Promise<Blob> {
  if (project === null) {
    // 软删图片与缺失同口径（getAssetBlob 对 trashedAt 返回 null 的消费语义延续）。
    if (image !== null && image.trashedAt === undefined) {
      throw new HandoffImageKindError(assetId, '图片节点')
    }
    throw new HandoffImageMissingError(assetId)
  }
  if (project.trashedAt !== undefined) throw new HandoffImageMissingError(assetId)
  if (project.projectKind !== 'gemgen') {
    throw new HandoffImageKindError(assetId, `${project.projectKind} 项目节点`)
  }
  const blob = await getImageBlob(project.blobKey).catch(() => null)
  if (blob === null) throw new HandoffImageMissingError(assetId)
  const text = new TextDecoder().decode(await blob.arrayBuffer())
  const file = parseGemgen(text, { mime: project.mime })
  return gemgenImageBlob(file)
}

/**
 * gemgen 档案内嵌图出口（送排钻 / 画廊 / 下载共用的档案专用口）：非 gemgen 节点与缺失
 * 分别给 HandoffImageKindError / HandoffImageMissingError；版本超前与损坏透传 labFile
 * 家族。零重编码：base64 解码为原始字节，Blob type 取档案 image.mime。
 */
export async function getGemgenImageBlob(assetId: string): Promise<Blob> {
  const { project, image } = await resolveNode(assetId)
  return gemgenBlobFrom(assetId, project, image)
}

/**
 * handoff 图像消费单点（design §9.2 B2）：图片节点走 getAssetBlob 直取（零处理）；
 * gemgen 档案走 getGemgenImageBlob 解内嵌图；其余（缺失/软删/非 gemgen 节点）均落
 * typed error。HandoffPayload 形状零变化——调用方只传 assetId，不新增临时裸图 id。
 */
export async function getHandoffImageBlob(assetId: string): Promise<Blob> {
  const { project, image } = await resolveNode(assetId)
  if (image !== null && image.trashedAt === undefined) {
    const blob = await getAssetBlob(assetId).catch(() => null)
    if (blob !== null) return blob
    throw new HandoffImageMissingError(assetId) // 物理记录丢失 / 外链无址
  }
  return gemgenBlobFrom(assetId, project, image)
}
