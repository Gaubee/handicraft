/**
 * 贴图 URL 认证拼接——textureUrl 为同源相对路径（/api/stones/{id}/texture.png），
 * <img src> 不走 Authorization 头，须以 ?token= 查询参数携带（S3.2 双通道的 img 通道）。
 * token 缓存键与 StonesAdminClient 一致（handicraft.daemon.token）；无 token 原样返回（401 由组件缺失态兜底）。
 */
export function withAuthToken(url: string | undefined | null): string {
  if (!url) return ''
  try {
    const token = globalThis.sessionStorage?.getItem('handicraft.daemon.token')
    if (!token) return url
    return url.includes('?') ? `${url}&token=${encodeURIComponent(token)}` : `${url}?token=${encodeURIComponent(token)}`
  } catch {
    return url
  }
}
