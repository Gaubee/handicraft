/**
 * 「送转化」入口 store：实验室 → 转化工作台的单向交接。
 *
 * [add-asset-library 4.5 · handoff v2，Owner 裁决直接切换无兼容]
 * 生成图以素材资产 id 交接（生成时已自动入库）；工作台消费经 assetStore 冻结出口
 * getAssetBlob 解析（B-1）；参考原图随交接带 referenceAssetId（叠原图零二次上传，R3 延续）。
 */

export interface HandoffPayload {
  /** 生成结果素材节点 id（经 getAssetBlob 解析；missing = 显式错误态+回退空态）。 */
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
