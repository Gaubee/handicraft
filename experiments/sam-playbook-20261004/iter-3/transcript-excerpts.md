# iter-3 关键决策段策展摘录

> 会话 `f01cc675-f166-41b3-a020-09e1a28afab9` · 任务 `2f1d5e15-4f1c-45c2-bde0-1c0751c40e04` · 2026-10-04T02:04:59Z→03:44:15Z（99.3 min）· 自然终态 done。
> 摘录自 raw-assistant-transcripts.md / raw-tool-timeline.md，按取证靶子组织。

## 一、④⑤ 授权链闭环（本轮生死线）——全链证据

### stones.add：propose → autoApproved=true → 立即执行 → grant consumed=1

- #447 智能选钻定案（12 款全圆钻、珍珠系基调）：「用户已预授权自动选钻，直接发起引入提案（manifest revision=1 为 CAS 基线）」
- #450 approval-request `studio.task.stones.add` proposal `926408bf`（12 款：B67/PW-4/PW-3/Q081/225/14-422/DT-37/PC-08-3/PC-08-4/A52/DT-07/J51）
- #451 approval-resolved **autoApproved=true**（02:38:53Z）
- **#453 propose 返回面（b9c2025 修复直接实证）**：
  ```json
  "autoApproved": true,
  "pending": "会话自动批准已生效——立即以 {taskId, proposalId} 调用执行（勿等待用户）"
  ```
  （对比 iter-2 同位置：`"pending": "等待用户批准（approval-request 已入任务帧流）——先与用户讨论确认…"`，无 autoApproved 字段、grant 作废）
- #454 agent 叙述：「**autoApproved=true——立即执行落库**」
- #456 execute 调用（同 proposalId+taskId）→ #458「项目钻清单追加完成：新增 12 款、已在清单 0 款（manifest revision=2）」
- DB：grant `7e14d3c7`（proposal 926408bf）**auto_approved=1, consumed=1**

### set.create：同款闭环

- #469 approval-request `set.create` proposal `11ef5354`（生产组合「三天使圣诞·贴钻12款」manual-pick 12 成员）
- #470 approval-resolved autoApproved=true → #472-476 执行成功（resourceId `4c8e3aee`）→ DB grant `ea814121` **consumed=1**

### strategy.design：8 次瞬态失败 → v1 提案主动弃置 → v2 提案执行

- #482-#527：GLM-5.3-Flash 供应商侧故障 8 连（timeout×5 + bad-json×2 + 无 text content×1）——压缩指令→英文紧凑→反冗思前缀逐步收敛
- #497 纪律动作：「连续 4 次失败。按纪律先查提案状态（确认没有半签署的 proposal 挂着），再决定重试」→ #499 task_proposals_list →「无半签署提案」
- #530-531 v1 提案 `07bac1ca` 签发（autoApproved=true）
- **#534 质量否决（本轮新行为）**：「提案已签发，但**发现关键遗漏**：指派表 33 条里没有 sam-node-0001（夜空背景）——lint 也显示 B67『unused』。夜空不铺 = 成品大洞。**不执行这份提案（令其过期）**，修正指令重发」→ DB grant `00cb3184` consumed=0（有意弃置，非断链）
- #539 规则学习：「引擎报错揭示：sam-node-0001 是层级节点（有子节点），父组不产钻——夜空根本不能直接指派」→ 细化出「夜空底色」叶子节点 0045（v58 合并四角天空块）
- #588-589 v2 提案 `e7b86c94` 签发（33 节点全覆盖、lint 全绿）→ #591 返回面 `autoApproved:true + 立即执行` → **#592「autoApproved=true——立即执行落档」** → #594 执行 → #601 落档成功（planBlobRef 77f57c8f…）→ DB grant `b2905e59` **consumed=1**
- #602 执行结果：「🎉 策略执行落档成功：**1232 颗钻**、task-layout.image-1.json 已生成、诊断零错误。头发三层 hex-thin 流线（77/28/26 颗）、双袍各 168 颗、浆果 239 颗、六星 Q081 星形几何、夜空 88 颗打底；84 颗跨节点重叠钻按 keep-earlier 自动剔除」

### task.export：闭环收口

- #605 approval-request `studio.task.export` proposal `14dc8450`（1232 钻/12 款/BOM 12 行/五产物/5 条警告不阻断）
- #606 approval-resolved autoApproved=true → **#608 返回面 `autoApproved:true + 立即执行`** → #609「autoApproved=true——立即执行导出」→ #611 执行 → results 行落库
- DB：grant `387b0f6c` **consumed=1**；results：**publicId `pUdHPBkGQjhk`**、resultId `54476f5d`、title「任务导出 image-1（1232 钻）」、bundle 7 文件（layout.svg 4.96MB / render.png 3.5MB / numbered.png 913KB / holes.png 148KB / bom.csv / bundle.json / source.img）、07 天有效期

## 二、调用前父掩膜覆盖检查（KB 新规则，演进形态）

- #186 域假设建立（星）：「四个框仍零检出——结合 KB『no-instance 连续出现=域问题不是措辞问题』：**这五个星位在首轮循环中已被挖孔**……天空掩膜在这些位置是空洞，refine 域内无像素可用。按 KB 处置：**换域**——提升到画布根节点（掩膜全覆盖）」→ 画布域 4/4 命中（#199）
- #244 假设迁移（左翼上羽）：「『angel wing』在左天使掩膜内零检出——上翼弧区**在父掩膜外**（首轮循环挖孔后遗症，同星况）。换域到画布层」——一探即换，无措辞轮询
- #297 同款（右翼）：「右翼在父掩膜内同样零检出（右翼区在首轮循环中被挖孔——同左翼上羽）。画布层兜底」
- **#372 最干净的单探针+掩膜推理（小天使手）**：「**父域无手部像素（手在父掩膜外）——画布层兜底**」——#367 在父域 0004 的 box 探针返回零新增后，按实际掩膜像素（非 bbox）判域并切换，画布域一击成层（8.5mm 实体）
- #559 「0001 的掩膜在角部/边缘大面积是洞（原始天空分割本身就是残缺的）——**不再纠缠该域**。画布层纯 box 抠四块开阔天空」
- 形态判定：iter-2 是「多轮失败后诊断」（星星五连败后才引 KB）；iter-3 是「**一探针 + 挖孔域模型前置**」——域假设一旦建立即在新目标上预测性应用。未观察到独立的「先 tree_inspect 父掩膜再发 refine」前置调用（全程 inspect 仅 2 次：#133 初树 CAS 基线、#392 终树校验）

## 三、precision 落参（iter-2 遗留 P1 的首次正例）

- #173 「改纯 box 框选兜底 + **实际携带 `precision:{confThreshold:0.3}` 降阈值重试**其余四颗（请求参数已实质变更，非同参重发）」
- #264 翅膀攻坚顶点：「按 KB『时间允许时升精度重试』：同一提示词**实际变更精度参数（maskMaxSide 1024→1536 + confThreshold 0.2）**做最后一次尝试」
- wire 实证：97 请求全 ok；confThreshold 分布 **0.4×72 / 0.3×24 / 0.2×1**；maskMaxSide 显式携带 1 次（1536）。非默认 precision 携带 25 次（25.8%）——iter-1/iter-2 均为 0
- 叙事-参数一致：每次宣称携带均能在 wire 回执对上（iter-1 的假宣称 pathology 未复发）

## 四、名实一致（KB 新规则应用）

- 终树 39 节点全部层名↔segmentPrompt 语义一致：部位层用部位级提示（脸←cherub face、袍←white beaded robe、翅←white feathered wing）；整体层用整体名（左侧天使/右侧天使/中间小天使←angel … as a whole）。**无「袍身」式部位名+整体掩膜错配层**（iter-2 病灶）
- #199 「把四个『框选区域』改为语义名并标注可钻」——box 抠取层落位后立即语义化命名（亮星·左上/左缘/右上/右下）
- #271/#322 归组后「规范命名」；#583 v58 将 deep blue night sky 更名「夜空底色」
- 边界案例（如实披露非错配）：0045「夜空底色」为碎片合并层（fill 5.7%），agent 在终报披露「原始天空分割掩膜残缺，已合并四角/边缘开阔区」

## 五、变体轮询纪律与止损

- #158 五颗星一次调用五种措辞（bright/glowing/bright four-pointed/shining/star）——**异目标措辞差异化**，非同目标轮询
- #271 左上翼：「SAM 对该区域的上限就是羽缘勾线，**停止在此措辞上消耗（已 3 次变体）**。接受现状……最后如实披露」——显式引用 2-3 次上限并止步
- #322 右翼：「多措辞+精度组合均 <1.2% 填充——停止消耗，接受『实体下羽尖 + 羽缘线』组合方案」
- 同参数重发：无（strategy.design 的同参重试均为 timeout 后的失败重试，且 #173 携带 precision 时明示「非同参重发」）

## 六、开局知识前装（对比 iter-1 分件后才查 KB）

- #9 kb_list → #18/22/26/30 SAM 组四条（措辞规律/计数与实例枚举/部位拆分与层级/失败信号对照表）+ #34/38 选钻两条（SS 尺码表/baseDensityPerCm2）——**全部先于 scene_analyze 与任何分件调用**
- #46 复述要点：「六星=画布层 `star` 单数+instances=all 逐实例；三天使=先 `angel` 整体拿 3 实例再部位拆分；数词禁用；失败信号对照表」

## 七、终报（#624 全文开头）

「✅ 全流程完成——三天使圣诞图分件+贴钻+导出。分享包：`/r/pUdHPBkGQjhk`（resultId `54476f5d`，五产物：四层 SVG / 效果图 PNG / BOM / 挖孔模板 holes.png / 编号工作图 numbered.png）……硬性要求逐项核对：1. 三天使完整成层 ✓（左 6 层/右 7 层/小 4 层，首轮泄漏层 IoU=1.000 已移除）2. 六星逐颗 ✓（六独立层，Q081 星形几何）3. 花篮完整 ✓（8 层）4. 头发流线 ✓（三发层 hex-thin，77/28/26 颗）……如实披露（4 处）：羽缘层低密度点缀 / 小天使手层 0 钻落位（掩膜约 1cm²，间距约束无可放位置）/ 夜空底色碎片合并层 / 导出 5 条孤立钻组+SVG base64>2MB 降级。过程中 scene_analyze 与 strategy_design 各遇 GLM-5.3-Flash 供应商侧故障（只思考不产出/超时共 10+ 次），均按失败信号对照表换措辞/换域/压缩指令收敛，未影响最终产线完成。」
