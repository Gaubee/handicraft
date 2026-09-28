/**
 * r3 走查 C：daemon 侧落库断言（真写路径——非 mock 面）：最新 strategy-plan 工件的
 * n-hat 指派=geometry/shape=star/密度 2.0（紧凑态 strategyDefaultsOf 判别值序列化落库）；
 * 最新 strategy-gems 工件 planRef 已推进（≠种子代——execute 真身重算）。
 * 运行：nub daemon/scripts/walkthrough-v4-r3-verify.ts [种子 planRef]（配合
 * walkthrough-v4-r3-seed.ts 的输出）。
 */
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import { ensureAnonymousUser } from '../src/auth.js'
import { BlobStore } from '../src/db/blobs.js'
import { JobService } from '../src/jobs/service.js'

const ROOT = '/tmp/workbench-v4-r3/app'
const config = loadConfig({ envFile: `${ROOT}/.env`, processEnv: { DATA_ROOT: `${ROOT}/data` } })
const db = openDatabase(config.dataRoot)
const user = ensureAnonymousUser(db)
const blobs = new BlobStore(config.dataRoot, db)
const jobs = new JobService({ config, db, blobs }, {})
const taskId = (db.prepare("SELECT id FROM tasks WHERE status='done' ORDER BY created_at DESC LIMIT 1").get() as { id: string }).id
const { frames } = jobs.frames(user, taskId, 0)
const byName = new Map<string, { blobRef: string; seq: number }>()
for (const frame of frames) {
  if (frame.kind !== 'artifact') continue
  const payload = frame.payload as { name?: string; blobRef?: string }
  if (typeof payload.name === 'string' && typeof payload.blobRef === 'string') byName.set(payload.name, { blobRef: payload.blobRef, seq: frame.seq })
}
const readJson = (ref: string) => JSON.parse(new TextDecoder().decode(blobs.read(ref)))
const plan = readJson(byName.get('strategy-plan.json')!.blobRef)
const gems = readJson(byName.get('strategy-gems.json')!.blobRef)
const hat = plan.assignments.find((a: { nodeId: string }) => a.nodeId === 'n-hat')
const SEED_PLAN_REF = process.argv[2] ?? ''
const checks: Array<[string, boolean, string]> = [
  ['C1 n-hat 指派落库：strategyKind=geometry', hat.strategyKind === 'geometry', JSON.stringify(hat).slice(0, 160)],
  ['C2 n-hat params 判别值落库：shape=star（紧凑态 strategyDefaultsOf 序列化）', hat.params?.shape === 'star', JSON.stringify(hat.params)],
  ['C3 n-hat 密度落库：2.0', hat.densityPerCm2 === 2, String(hat.densityPerCm2)],
  ['C4 n-hat 钻继承种子指派（无 stoneIdx——plan 继承面）', Array.isArray(hat.stones) && hat.stones.length === 2, `stones=${hat.stones?.length}`],
  ['C5 gems 工件版本推进：planRef ≠ 种子代', SEED_PLAN_REF === '' || gems.planRef !== SEED_PLAN_REF, `${gems.planRef.slice(0, 12)}… vs seed ${SEED_PLAN_REF.slice(0, 12)}…`],
  ['C6 gems 引擎真身产点阵：count>0', Array.isArray(gems.gems) && gems.gems.length > 0, `count=${gems.gems?.length}`],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}——${detail}`)
  if (!ok) failed += 1
}
console.log('R3_C_DONE', JSON.stringify({ failed }))
process.exit(failed === 0 ? 0 : 1)
