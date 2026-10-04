// 解卡续跑：给 agent 三选一数据（treeArtifactRef 首选 + sceneAnalysisRef/canvasCm 次选）。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'
import fs from 'node:fs'

const base = 'http://127.0.0.1:8317'
const prev = JSON.parse(fs.readFileSync('/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/create-result.json', 'utf8'))
const sessionId = prev.sessionId
const TREE_REF = 'cb323423feddb3e7a27a28171041c118c248a28670895f70304ccc3365bf260c'
const SCENE_REF = '17d3d090d103fb1c9e6729bd53cb250b1e7da8d73185682b44d0f46eed83bf20'
const text = `续跑解卡（选 1，数据如下；1 不通再走 2）：
1. treeArtifactRef（旧任务 160df9a7 终树 v37，tree_inspect currentVersion 同值）：${TREE_REF}
2. sceneAnalysisRef：${SCENE_REF}；画布尺寸：20×20 cm（首条消息表单行「画布尺寸：20×20 cm」，canvasCm {w:20,h:20}）。
拿到树即走 strategy_design → 执行 → 排钻 → 导出分享包 + /r/ 链接收尾。`

const token = (await (await fetch(base + '/api/auth/anonymous', { method: 'POST' })).json()).token
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))
const fu = await client.session.followup({ sessionId, text, autoApprove: true })
console.log('UNBLOCK TASK:', JSON.stringify(fu))
fs.appendFileSync('/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/resume-result.json', JSON.stringify({ at: new Date().toISOString(), taskId: fu.taskId, kind: 'unblock', text }, null, 2))
ws.close(); process.exit(0)
