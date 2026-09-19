/**
 * 「送排钻」入口 store：实验室 → 排钻设计的单向交接。
 *
 * [add-asset-library 4.5 · handoff v2，Owner 裁决直接切换无兼容]
 * 生成图以素材资产 id 交接（生成时已自动入库）；参考原图随交接带 referenceAssetId
 * （叠原图零二次上传，R3 延续）。
 * [add-project-files 0.6 · design §9.2 B2] 排钻设计消费改经 getHandoffImageBlob 单点出口
 * （图片直取 / gemgen 解内嵌图；studio 旧 getAssetBlob 直连已收口）。HandoffPayload
 * 形状零变化（{assetId, name, referenceAssetId?}），调用方不新增临时裸图 id。
 */

export interface HandoffPayload {
  /** 生成结果素材节点 id（经 getHandoffImageBlob 单点解析，图片/gemgen 皆可；missing = 显式错误态+回退空态）。 */
  assetId: string
  /** 建议文件名（导出/展示用）。 */
  name: string
  /** 参考原图素材 id（可选）。 */
  referenceAssetId?: string
}

let payload = $state<HandoffPayload | null>(null)

export function getHandoff(): HandoffPayload | null {
  return payload
}

export function setHandoff(next: HandoffPayload): void {
  payload = next
}

export function clearHandoff(): void {
  payload = null
}
