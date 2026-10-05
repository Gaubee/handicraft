// 终局收口：直接在失败任务 160df9a7（v37 参考图层树所在）上续做策略+导出。
// 依据：writer-fence 只拒 cancelled/删行/会话非活跃——failed 任务可写；跨任务树引用
// 才是栅栏面（artifact-task-mismatch），本指令绕开跨任务问题（原地续做）。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'
import fs from 'node:fs'

const base = 'http://127.0.0.1:8317'
const prev = JSON.parse(fs.readFileSync('/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/create-result.json', 'utf8'))
const sessionId = prev.sessionId
const TARGET = '160df9a7-59ad-4cd7-9f21-7fa432ae81f8'
const text = `终局收口（换路线——不再新任务重建）：直接在旧任务 ${TARGET} 上续做。该任务就是你最早那次跑批：参考图层（IoU 0.912 过门）+分件树 v37（锚参考图层，37 版精修）都在它的工件域，且服务端围栏只拒 cancelled 任务——failed 可写，跨任务引用栅栏（artifact-task-mismatch）因此不再相关。请：
1. tree_inspect(taskId="${TARGET}") 确认 v37 树在场；
2. strategy_design(taskId="${TARGET}")（用钻沿袭你刚在 daf94d33 验证过的「三天使圣诞·智能选钻盘」34 款方案；策略 LLM 超时已是 600s）；
3. 执行指派→排钻；
4. task.export(taskId="${TARGET}") 导出分享包，回 /r/ 链接。
不要重建分件、不要动参考图层。`

const token = (await (await fetch(base + '/api/auth/anonymous', { method: 'POST' })).json()).token
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))
const fu = await client.session.followup({ sessionId, text, autoApprove: true })
console.log('FINISH TASK:', JSON.stringify(fu))
fs.appendFileSync('/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/resume-result.json', JSON.stringify({ at: new Date().toISOString(), taskId: fu.taskId, kind: 'finish-on-160df9a7' }, null, 2))
ws.close(); process.exit(0)
