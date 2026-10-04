// 断点续跑：strategy.design 网关超时熔断（9×300s）→ daemon 超时上调 600s 后续跑。
// 复用既有：参考图层（09ee4adc，IoU 0.912）+ 31 节点树（10 版精修）。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'
import fs from 'node:fs'

const base = 'http://127.0.0.1:8317'
const prev = JSON.parse(fs.readFileSync('/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/create-result.json', 'utf8'))
const sessionId = prev.sessionId
const text =
  '继续。你之前在策略设计步因文本模型网关超时连续失败而熔断——服务端已把策略 LLM 超时从 300s 上调到 600s。请：1. 复用已完成的分件树与参考图层（勿重做分件）；2. 重试策略设计（若仍超时，先做策略指派表瘦身再试）；3. 排钻+导出分享包收尾。'

const token = (await (await fetch(base + '/api/auth/anonymous', { method: 'POST' })).json()).token
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))
const fu = await client.session.followup({ sessionId, text, autoApprove: true })
console.log('RESUME TASK:', JSON.stringify(fu))
fs.writeFileSync('/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/resume-result.json', JSON.stringify({ at: new Date().toISOString(), sessionId, taskId: fu.taskId, text }, null, 2))
ws.close(); process.exit(0)
