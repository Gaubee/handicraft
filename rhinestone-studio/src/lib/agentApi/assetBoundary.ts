/*
 * agent 域资源 URL 边界（fixt-session-heart 越域打点修复，2026-10-02）。
 *
 * 背景：mock 演示模式的引用（fixture blobRef/stoneRef、`demo-` 前缀本地图）一律
 * 为虚拟 id——daemon 不存在对应字节。但 assetRawUrl/stoneTextureUrl 按同源 origin
 * 拼 URL，当 SPA 由 daemon 托管（8317）时这些 URL 会**真打到服务端**——「stone
 * 不存在」404 即 fixture 虚拟 stoneRef 越域打点的结果。
 *
 * 边界规则（单源）：
 *   - rpc 模式：照旧 daemon 同源真字节面（assetRawUrl——token/w 参数原样）。
 *   - mock 模式：本地占位 dataUrl（贴图=hex 色卡圆点；产物图=灰底演示标注）——
 *     零网络请求，绝不拼 daemon URL。
 * 依赖方向：本模块 → store（模式读面）/attachments（rpc 拼装）——无反向边，
 * 组件层（TaskDetailPanel/Lightbox/Timeline/UserBubble/NewTaskComposer）统一消费。
 */
import { getAgentMode } from './store.svelte.js'
import { assetRawUrl } from './attachments.js'

/** 当前是否 mock 演示模式（agent 域资源边界判定的单源谓词）。 */
export function isAgentMockMode(): boolean {
  return getAgentMode() !== 'rpc'
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

/**
 * 钻贴图色卡占位（mock 模式）：fixture palette 携真实色值——hex 圆点即可表达
 * 钻色；非法/缺席 hex 回退中性灰。零网络。
 */
export function mockStoneSwatchUrl(hex: string): string {
  const fill = /^#[0-9a-fA-F]{3,8}$/.test(hex.trim()) ? hex.trim() : '#a1a1aa'
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><circle cx="24" cy="24" r="17" fill="${fill}"/></svg>`,
  )
}

/** 产物图占位（mock 模式）：灰底+「演示数据」标注——虚拟引用不假装可寻址。 */
export function mockAssetPlaceholderUrl(label: string): string {
  const text = label === '' ? '演示数据' : `演示数据 · ${label}`
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="100%" height="100%" fill="#f4f4f5"/><text x="50%" y="50%" font-family="sans-serif" font-size="22" fill="#a1a1aa" text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`,
  )
}

/**
 * agent 域产物图 URL 单源：rpc=daemon raw（token/w 同源原样）；mock=本地占位
 * dataUrl（零网络——mock 引用为虚拟 id，拼 daemon URL 必 404）。
 */
export function agentAssetUrl(blobRef: string, width?: number): string {
  if (isAgentMockMode()) return mockAssetPlaceholderUrl('')
  return assetRawUrl(blobRef, width)
}
