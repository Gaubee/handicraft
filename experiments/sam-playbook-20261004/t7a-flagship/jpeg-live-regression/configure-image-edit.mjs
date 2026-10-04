// 配置 image-edit 路由（Owner 2026-10-05 给的本地服务；settings 真源落地）。
// 合并保存：保留既有路由与 default，追加 keyless image-edit 路由（modelsSave 的
// apiKey 缺省=保留旧密钥语义对既有 anthropic 路由无扰动）。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'

const base = 'http://127.0.0.1:8317'
const ROUTE = {
  provider: 'local-image-edit',
  api: 'openai-image-edit',
  baseURL: 'http://127.0.0.1:20002/openai-image/v1',
  models: [{ id: 'gpt-image-2.5' }],
}

const ws0 = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc`)
await new Promise((res, rej) => { ws0.addEventListener('open', res, { once: true }); ws0.addEventListener('error', rej, { once: true }) })
const c0 = createORPCClient(new RPCLink({ websocket: ws0 }))
const login = await c0.auth.login({ username: 'admin', password: process.env.ADMIN_PW ?? 'admin8888' })
ws0.close()

const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(login.token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))

const before = await client.models.get({})
console.log('BEFORE:', JSON.stringify(before.routes.map((r) => ({ provider: r.provider, api: r.api, hasKey: r.hasKey }))), 'default=', JSON.stringify(before.default))

if (before.routes.some((r) => r.api === 'openai-image-edit')) {
  console.log('image-edit 路由已在——跳过保存')
} else {
  const routes = [
    ...before.routes.map((r) => ({ provider: r.provider, api: r.api, baseURL: r.baseURL, models: r.models })), // apiKey 缺省=保留旧密钥
    ROUTE,
  ]
  const after = await client.models.save({ routes, default: before.default })
  console.log('AFTER:', JSON.stringify(after.routes.map((r) => ({ provider: r.provider, api: r.api, hasKey: r.hasKey }))))
  console.log('image-edit 在场:', after.routes.some((r) => r.api === 'openai-image-edit'))
}
ws.close(); process.exit(0)
