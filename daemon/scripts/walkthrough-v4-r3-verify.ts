/**
 * r3 走查 C：daemon 侧落库断言（真写路径——非 mock 面）：目标任务最新 strategy-plan
 * 工件的 n-hat 指派=geometry/shape=star/密度 2.0（紧凑态 strategyDefaultsOf 判别值
 * 序列化落库）；最新 strategy-gems 工件 planRef 已推进（≠种子代——execute 真身重算）
 * 且点阵数量达预期下界。
 * v4 修复轮三 H4（Codex 三轮 P2「verifier 版本/数量断言可跳过」）收紧：
 *   - taskId+seedPlanRef 为**必填**参数（此前 seedPlanRef 缺省使 C5 自动通过、脚本
 *     选「最新 done task」而非目标 task——可运行不足以证明与本次走查任务关联）；
 *   - C6 由 count>0 改为预期下界断言（缺省 68——对齐 tasks 声明数字，可显式覆写）。
 * 运行：nub daemon/scripts/walkthrough-v4-r3-verify.ts <taskId> <seedPlanRef> [gemsMinCount]
 * （taskId/seedPlanRef 配合 walkthrough-v4-r3-seed.ts 的输出）。
 */
import { loadConfig } from '../src/config.js'
import { openDatabase } from '../src/db/database.js'
import { ensureAnonymousUser } from '../src/auth.js'
import { BlobStore } from '../src/db/blobs.js'
import { JobService } from '../src/jobs/service.js'

const ROOT = '/tmp/workbench-v4-r3/app'
const [taskIdArg, seedPlanRefArg, gemsMinCountArg] = process.argv.slice(2)
if (taskIdArg === undefined || seedPlanRefArg === undefined) {
  console.error('用法：nub daemon/scripts/walkthrough-v4-r3-verify.ts <taskId> <seedPlanRef> [gemsMinCount]')
  console.error('  taskId=走查目标任务（walkthrough-v4-r3-seed.ts 输出）；seedPlanRef=种子代 plan 工件 ref（C5 推进断言锚）；')
  console.error('  gemsMinCount=C6 点阵数量下界（缺省 68——对齐 tasks 声明）')
  process.exit(2)
}
const GEMS_MIN_COUNT = gemsMinCountArg === undefined ? 68 : Number(gemsMinCountArg)
if (!Number.isFinite(GEMS_MIN_COUNT) || GEMS_MIN_COUNT <= 0) {
  console.error(`gemsMinCount 非法：${gemsMinCountArg}（须为正数）`)
  process.exit(2)
}
const config = loadConfig({ envFile: `${ROOT}/.env`, processEnv: { DATA_ROOT: `${ROOT}/data` } })
const db = openDatabase(config.dataRoot)
const user = ensureAnonymousUser(db)
const blobs = new BlobStore(config.dataRoot, db)
const jobs = new JobService({ config, db, blobs }, {})
const task = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskIdArg) as { id: string; status: string } | undefined
if (task === undefined) {
  console.error(`FAIL 目标任务不存在：${taskIdArg}（强制目标 task——不再取「最新 done」）`)
  process.exit(1)
}
const taskId = task.id
const { frames } = jobs.frames(user, taskId, 0)
const byName = new Map<string, { blobRef: string; seq: number }>()
for (const frame of frames) {
  if (frame.kind !== 'artifact') continue
  const payload = frame.payload as { name?: string; blobRef?: string }
  if (typeof payload.name === 'string' && typeof payload.blobRef === 'string') byName.set(payload.name, { blobRef: payload.blobRef, seq: frame.seq })
}
/** 目标任务全部 strategy-plan.json 帧引用集（种子代校验锚——C5a：seedPlanRef 须真实在场，防「任意不同 ref」骗过 ≠ 断言）。 */
const planRefsInHistory = new Set(
  frames
    .filter((frame) => frame.kind === 'artifact' && (frame.payload as { name?: string }).name === 'strategy-plan.json')
    .map((frame) => (frame.payload as { blobRef?: string }).blobRef ?? ''),
)
const readJson = (ref: string) => JSON.parse(new TextDecoder().decode(blobs.read(ref)))
const plan = readJson(byName.get('strategy-plan.json')!.blobRef)
const gems = readJson(byName.get('strategy-gems.json')!.blobRef)
const hat = plan.assignments.find((a: { nodeId: string }) => a.nodeId === 'n-hat')
const SEED_PLAN_REF = seedPlanRefArg
const checks: Array<[string, boolean, string]> = [
  ['C0 目标任务在场且 done（强制 task——不走「最新 done」旁路）', task.status === 'done', `task=${taskId} status=${task.status}`],
  ['C1 n-hat 指派落库：strategyKind=geometry', hat.strategyKind === 'geometry', JSON.stringify(hat).slice(0, 160)],
  ['C2 n-hat params 判别值落库：shape=star（紧凑态 strategyDefaultsOf 序列化）', hat.params?.shape === 'star', JSON.stringify(hat.params)],
  ['C3 n-hat 密度落库：2.0', hat.densityPerCm2 === 2, String(hat.densityPerCm2)],
  ['C4 n-hat 钻继承种子指派（无 stoneIdx——plan 继承面）', Array.isArray(hat.stones) && hat.stones.length === 2, `stones=${hat.stones?.length}`],
  ['C5a seedPlanRef 真实在场：目标任务 plan 帧历史含该引用（非「任意不同 ref」旁路）', planRefsInHistory.has(SEED_PLAN_REF), `history=${planRefsInHistory.size} refs`],
  ['C5b gems 工件版本推进：planRef ≠ 种子代（seedPlanRef 必填——无缺省自动通过）', gems.planRef !== SEED_PLAN_REF, `${gems.planRef.slice(0, 12)}… vs seed ${SEED_PLAN_REF.slice(0, 12)}…`],
  ['C6 gems 引擎真身产点阵：count ≥ 预期下界（对齐声明数字——非 >0 宽松面）', Array.isArray(gems.gems) && gems.gems.length >= GEMS_MIN_COUNT, `count=${gems.gems?.length} ≥ ${GEMS_MIN_COUNT}`],
]
let failed = 0
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}——${detail}`)
  if (!ok) failed += 1
}
console.log('R3_C_DONE', JSON.stringify({ failed, taskId, seedPlanRef: SEED_PLAN_REF, gemsMinCount: GEMS_MIN_COUNT }))
process.exit(failed === 0 ? 0 : 1)
