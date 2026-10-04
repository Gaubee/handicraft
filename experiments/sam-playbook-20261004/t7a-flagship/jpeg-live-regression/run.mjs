// 补证①（codex-final-r1 需修清单）：HEAD 159d72c 真实 JPEG 直传 live 回归。
// run1（ba20c68 修复前）同字节直传 → scene_analyze/subject_segment/pave-preview 三面
// image-decode-failed 死链；本跑验证 followup 单漏斗归一后全链只引用归一 PNG ref。
// 指令刻意轻量（只识图即止）——验证目标是入线归一与 S0 解码面，不是分件质量。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'
import fs from 'node:fs'

const base = 'http://127.0.0.1:8317'
const jpg = fs.readFileSync('/Users/kzf/Pictures/贴钻/微信图片_20260921172653_27_485.jpg') // 274101B 原版微信 JPG（run1 同字节）
if (jpg.length !== 274101) throw new Error(`input size drift: ${jpg.length}`)

const text =
  '这是一次图片入线归一的回归验证。请只做两件事：1. 对附件图执行一次识图分析（scene_analyze），简述风格判定与画面内容要点；2. 随即报告完成并停止——不要分件、不要排钻、不要导出、不要其他操作。\n画布尺寸：20×20 cm'

const token = (await (await fetch(base + '/api/auth/anonymous', { method: 'POST' })).json()).token
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))

const up = await client.assets.upload({ filename: '三天使圣诞图.jpg', dataBase64: jpg.toString('base64') })
console.log('UPLOAD:', JSON.stringify(up))
const created = await client.session.create({})
const sessionId = created.session?.sessionId ?? created.sessionId ?? created.id
if (!sessionId) throw new Error('no sessionId: ' + JSON.stringify(created))
const fu = await client.session.followup({ sessionId, text, attachments: [up.blobRef], autoApprove: true })
console.log('CREATE:', sessionId)
console.log('FOLLOWUP:', JSON.stringify(fu).slice(0, 600))

fs.writeFileSync(
  '/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/jpeg-live-regression/create-result.json',
  JSON.stringify({ createdAt: new Date().toISOString(), daemonHead: '159d72c', sessionId, upload: up, followup: fu, firstMessage: text, autoApprove: true }, null, 2)
)
ws.close(); process.exit(0)
