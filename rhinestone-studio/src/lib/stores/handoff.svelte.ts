/**
 * 「送转化」入口 store：实验室 → 转化工作台的单向交接。
 * image 为数据 URL（跨视图/引擎解码均可用），name 为建议文件名。
 * [2026-09-18 R3] reference 增量：实验室参考原图随交接带过来（dataUrl），
 * 工作台「叠原图」预览零二次上传。
 */

export interface HandoffReference {
	dataUrl: string
	name: string
}

export interface HandoffPayload {
	image: string
	name: string
	reference?: HandoffReference
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
