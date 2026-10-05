// Owner 报障修复执行：f92a04c5（终局交付任务）领养 v37 树 + 导入参考图层。
import { createORPCClient } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/index.mjs'
import { RPCLink } from '/Users/kzf/Pictures/贴钻-backend/rhinestone-studio/node_modules/@orpc/client/dist/adapters/websocket/index.mjs'
import fs from 'node:fs'

const base = 'http://127.0.0.1:8317'
const TARGET = 'f92a04c5-db39-4b87-8fd8-5bac5279e225'
const SOURCE = '160df9a7-59ad-4cd7-9f21-7fa432ae81f8'

// 匿名=共享单用户（54d35ef 模型）——会话/任务归属同户
const token = (await (await fetch(base + '/api/auth/anonymous', { method: 'POST' })).json()).token
const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws/rpc?token=${encodeURIComponent(token)}`)
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }) })
const client = createORPCClient(new RPCLink({ websocket: ws }))

// 1. 树领养（源=首任务 v37 参考图层树）
const adopt = await client.tree.adopt({ taskId: TARGET, fromTaskId: SOURCE })
console.log('ADOPT:', JSON.stringify(adopt))

// 2. 参考图层导入（源图=会话工件 09ee4adc——session_blob_refs 归属覆盖）
//    先经 assets.upload? 不需要——blob 已在库且本人会话已引用（userOwnsBlobRef ∪ session_blob_refs）
try {
  const imp = await client.task.reference.import({ taskId: TARGET, imageBlobRef: '09ee4adc36bc2a1fa16e39470c889dc0b51b40d3b752ffec03c8b2e036fadf32' })
  console.log('IMPORT:', JSON.stringify(imp))
} catch (e) {
  console.log('IMPORT FAILED:', e.code ?? '', String(e.message ?? e).slice(0, 300))
}

// 3. 验证读面
const detail = await client.task.detail({ taskId: TARGET })
const d = detail.kind === 'ok' ? detail.value : detail
console.log('detail.tree:', d.tree ? `${d.tree.nodes.length} nodes anchor=${String(d.tree.imageBlobRef).slice(0, 12)}` : 'null')
console.log('detail.referenceImage:', JSON.stringify(d.referenceImage)?.slice(0, 200))
fs.writeFileSync('/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/t7a-flagship/ref-layer-flagship/unblock-workbench-result.json', JSON.stringify({ at: new Date().toISOString(), adopt, detailTree: d.tree ? { nodes: d.tree.nodes.length, anchor: d.tree.imageBlobRef } : null, referenceImage: d.referenceImage ?? null }, null, 2))
ws.close(); process.exit(0)
