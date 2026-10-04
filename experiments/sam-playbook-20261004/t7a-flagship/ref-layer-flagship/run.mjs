// 参考图层旗舰重跑（2026-10-05）：首跑真实 image-edit 自动生成路径。
// 链路：JPEG 直传（入线归一）→ S2 photographic → 本地 gpt-image-2.5 生成参考图层
//（Owner 配置：http://127.0.0.1:20002/openai-image/v1 免密钥）→ IoU 门 → 面向参考
// 图层分件 → 策略排钻 → 原图导出。冻结指令与 iter-1..6/T7a 一字不改。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'
import fs from 'node:fs'

const base = 'http://127.0.0.1:8317'
const jpg = fs.readFileSync('/Users/kzf/Pictures/贴钻/微信图片_20260921172653_27_485.jpg') // 原版微信 JPG 274101B（run1 死链同字节）
if (jpg.length !== 274101) throw new Error(`input size drift: ${jpg.length}`)

const FROZEN =
  '请对这张三天使圣诞图做全量分件并贴钻导出。硬性要求：1. 三位天使都要完整成层（头/发/袍/翅分开或合理分组，右天使头部不能缺失）2. 背景六颗大星星逐颗成层（不是整片）3. 花篮完整 4. 头发用流线贴法 5. 完成后导出分享包。遇到分件困难时先查知识库『SAM 提示词策略』组。'
const text = FROZEN + '\n画布尺寸：20×20 cm\n用钻：智能选钻——由你按画面自动挑选最合适的钻（颜色/尺寸/形状/密度）'

const token = (await (await fetch(base + '/api/auth/anonymous', { method: 'POST' })).json()).token
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))

const up = await client.assets.upload({ filename: '三天使圣诞图.jpg', dataBase64: jpg.toString('base64') })
console.log('UPLOAD:', JSON.stringify(up))
const created = await client.session.create({})
const sessionId = created.session?.sessionId ?? created.sessionId ?? created.id
const fu = await client.session.followup({ sessionId, text, attachments: [up.blobRef], autoApprove: true })
console.log('SESSION:', sessionId, 'TASK:', JSON.stringify(fu))

fs.writeFileSync(
  '/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/create-result.json',
  JSON.stringify({ createdAt: new Date().toISOString(), daemonHead: '159d72c+keyless-relax+import(uncommitted)', sessionId, taskId: fu.taskId, upload: up, firstMessage: text, autoApprove: true }, null, 2)
)
ws.close(); process.exit(0)
