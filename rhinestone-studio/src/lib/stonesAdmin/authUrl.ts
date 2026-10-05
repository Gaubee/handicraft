/**
 * 贴图 URL 认证拼接——textureUrl 为同源相对路径（/api/stones/{id}/texture.png），
 * <img src> 不走 Authorization 头，须以 ?token= 查询参数携带（S3.2 双通道的 img 通道）。
 * token 单点收敛（2026-10-05 Owner 实弹修复）：daemonToken.currentStoredToken()
 * 登录键→匿名键兜底——此前只读登录键，匿名会话裸 URL 全 401（选钻 Dialog 全色块
 * 实证 226/226；chips 走 gemSummary 同单点恒正常）。无 token 原样返回（401 由组件
 * 缺失态兜底）。
 */
import { currentStoredToken } from '../daemonToken.js'

export function withAuthToken(url: string | undefined | null): string {
  if (!url) return ''
  try {
    const token = currentStoredToken()
    if (!token) return url
    return url.includes('?') ? `${url}&token=${encodeURIComponent(token)}` : `${url}?token=${encodeURIComponent(token)}`
  } catch {
    return url
  }
}
