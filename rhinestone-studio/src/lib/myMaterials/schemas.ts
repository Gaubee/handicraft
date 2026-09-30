/*
 * 「我的材料」归档环读面守门 schema（product-polish-w1——T1 任务导出三件套 +
 * T2 会话图片虚拟目录）。contracts 未定义这两面的 IO（daemon rpc.ts 本地 schema
 * 先行）；本文件=前端守门面，全部组合自 @handicraft/contracts 冻结原语
 * （agentApi/rpc.ts 的 SetsListOutputSchema 先例同款——本文件不重复发明输出
 * 形状之外的字段语义）。
 *   - session.exports：会话导出历史行（imageId 分组真源——前端按 imageId 取每图
 *     最新一组呈现；download=/r/{publicId} 下载面锚）。
 *   - session.images：会话主图集按会话分组（blobRef 走 raw 缩略面；mime/宽高为
 *     魔数级声明，null=真源腐蚀的如实投影，不猜）。
 */

import { z } from 'zod'
import { IsoDateTimeSchema, TaskImageIdSchema } from '@handicraft/contracts'

// ---------------------------------------------------------------- session.exports（T1）

export const SessionExportRowSchema = z
  .object({
    resultId: z.string().min(1),
    publicId: z.string().min(1),
    exportedByTaskId: z.string().min(1),
    imageId: TaskImageIdSchema,
    sourceTaskId: z.string().min(1),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.nullable(),
    /** /r/{publicId} 分享下载面（files/{svg|png|bom} 由前端拼装）。 */
    download: z.string().min(1),
  })
  .strict()
export type SessionExportRow = z.infer<typeof SessionExportRowSchema>

export const SessionExportsOutputSchema = z
  .object({
    sessionId: z.string().min(1),
    exports: z.array(SessionExportRowSchema),
  })
  .strict()
export type SessionExportsOutput = z.infer<typeof SessionExportsOutputSchema>

// ---------------------------------------------------------------- session.images（T2）

export const SessionImageItemSchema = z
  .object({
    /** blobRef 用宽松 string 而非 BlobRefSchema：单行真源腐蚀（daemon null 投影面）
     * 不得拖垮整面守门——行内以 mime=null 如实呈现。 */
    blobRef: z.string().min(1),
    name: z.string(),
    mime: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
  })
  .strict()
export type SessionImageItem = z.infer<typeof SessionImageItemSchema>

export const SessionImagesGroupSchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string(),
    updatedAt: IsoDateTimeSchema,
    images: z.array(SessionImageItemSchema),
  })
  .strict()
export type SessionImagesGroup = z.infer<typeof SessionImagesGroupSchema>

export const SessionImagesOutputSchema = z
  .object({
    groups: z.array(SessionImagesGroupSchema),
  })
  .strict()
export type SessionImagesOutput = z.infer<typeof SessionImagesOutputSchema>
