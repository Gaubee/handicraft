// T7a run2（豁免重跑 1 次已用）：run1 上传原版 JPEG 字节实证 S0 PNG-only 死链
// （scene_analyze/subject_segment/pave-preview 三面 image-decode-failed，agent 6.3min
// 诚实终报终态 done 零分件——基础设施级故障，重跑条件成立）。
// run2 恢复历轮口径：sips 源 JPG→PNG（sha256 6267829d… 与 iter-1/2/3/4 逐字节一致）
// ——同图同字节同 KB 线；与 iter-4 唯一差异=daemon b9c2025→ba20c68（T1-T6）+KB f6f0f15→b35032e。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'
import fs from 'node:fs'

const base = 'http://127.0.0.1:8317'
const png = fs.readFileSync('/tmp/t7a-input.png')

// 冻结指令（一字不改，与 iter-1/2/3/4/6 相同）+ 表单参数行（buildNewTaskFirstMessage 同式）
const FROZEN =
  '请对这张三天使圣诞图做全量分件并贴钻导出。硬性要求：1. 三位天使都要完整成层（头/发/袍/翅分开或合理分组，右天使头部不能缺失）2. 背景六颗大星星逐颗成层（不是整片）3. 花篮完整 4. 头发用流线贴法 5. 完成后导出分享包。遇到分件困难时先查知识库『SAM 提示词策略』组。'
const text = FROZEN + '\n画布尺寸：20×20 cm\n用钻：智能选钻——由你按画面自动挑选最合适的钻（颜色/尺寸/形状/密度）'

const token = (await (await fetch(base + '/api/auth/anonymous', { method: 'POST' })).json()).token
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))

const up = await client.assets.upload({ filename: '三天使圣诞图.png', dataBase64: png.toString('base64') })
console.log('UPLOAD:', JSON.stringify(up))

const created = await client.session.create({})
console.log('CREATE:', JSON.stringify(created))
const sessionId = created.session?.sessionId ?? created.sessionId ?? created.id
if (!sessionId) throw new Error('no sessionId in create output: ' + JSON.stringify(created))

const fu = await client.session.followup({ sessionId, text, attachments: [up.blobRef], autoApprove: true })
console.log('FOLLOWUP:', JSON.stringify(fu))

fs.writeFileSync(
  '/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/create-result-run2.json',
  JSON.stringify({ createdAt: new Date().toISOString(), base, sessionId, taskId: fu.taskId, blobRef: up.blobRef, blobSize: up.size, firstMessage: text, autoApprove: true, upload: up, create: created, followup: fu }, null, 2)
)
ws.close(); process.exit(0)
