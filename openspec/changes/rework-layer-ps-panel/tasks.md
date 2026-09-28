# Tasks：PS 图层面板复刻+父层产钻语义（v5）

- [x] 1.1 产钻语义：producesBlockOf=叶子恒定+setStrategy 父层 typed 拒+旧指派读面降级+execute 跳过父层块
- [x] 1.2 demo/种子映射修正（父层不指派）+重跑真识别新数据（无嵌套排钻）——v5 走查数据根 experiments/journey-clown-rich-v5-20260928（699 颗=858-159，小丑无指派，producing=12 叶）
- [x] 1.3 缩略图白图修复（根因定案后）——根因=tasks.artifact 引用合法集不含电流树掩膜 blob（12/12 全拒实证）；修复=rpc [2.5] 掩膜引用面+回归测试
- [x] 2.1 PS 图层面板重写：顶部最上/眼睛/缩略/名称双击重命名/fx 徽标/组展开/底部操作条
- [x] 2.2 Inspector/紧凑态组无指派门（与 1.1 同语义）
- [ ] 3.1 全绿门+真浏览器走查（真数据）+vision 走查（PS 复刻度+缩略图）+Codex 复核（全绿门+真浏览器走查 18/18 PASS 已达；vision/Codex 归 MainAgent 波次）

## 修复轮（2026-09-28，Codex v5 复核 /tmp/codex-layer-ps-v5-review.md 闭合）

- [x] R1 导出面统一叶子口径（Codex P1）：contracts 新增 `nodeProducesBlock` 单源叶子谓词
      （design/tree-to-blocks/workbench/前端 isStaleGroupAssignment/渲染过滤/journey-smoke 六处内联
      判定收敛）+daemon kernel 新增 `effectiveGems(tree,gems)` 纯函数；task.detail gems.count 与
      task.export 共同消费——task.export 按当前 object-tree 叶子过滤生成新 JSON 字节（blobRef=新
      字节内容寻址 put 落盘+degraded warning 明示剔除颗数；无剔除=恒等回放原 ref），树缺席 typed
      拒 `tree-missing`（不静默导出原始）；mock taskExport/taskDetail 同构过滤。RPC 回归：v4 存量
      「组旧钻（n-person 4 颗）+叶子钻（n-hat 3 颗）」负样本——导出 JSON/颗数/UI 口径三面只含叶子
      +树缺席拒+mock 三面同构（workbench-pro.test [8]+studio v5 [E]）。
- [x] R2 capability 资源域边界（Codex P1-2，方案 1 轻路径）：contracts TaskExport 契约注释+
      layout-doc 头注声明两资源域（layout resource=W2 pave 真值域，零交叠、无跨域回退；task.export
      =v5 树语义唯一任务导出入口）+跨域正/负测试（同任务双域：BOM 读独立 layout 全量 5 颗不经树
      过滤/缺席资源必拒不回退任务工件/两域字节互不包含）。
- [x] R3 图例数字（vision 终审「红鼻子 71」）：排查结论=前端取数/渲染链自洽非 bug——名与颗数同
      row 对象绑定、渲染缓存输入含 gemsDoc/nodes 身份；数据铁证（v4/v5 全数据集红鼻子恒=21、
      左/右手恒=71、红鼻子恰为 11 行中位第 6 行）判定 71 为 NCC 对 10px「21」首数字 2→7 误读。
      防御回归：studio v5 [F] 以真机同形数据（21/71/71）冻结图例每行颗数==该层 gems 计数+名-数
      配对（data-node-id 键控行+末 span 颗数+fx 徽标/顶栏三面同源）。
- [x] R4 journey-smoke v4 判定残留（Codex P2）：producing 集改纯叶子（nodeProducesBlock 单源）+
      显式断言每条 assignment 都是叶子（非叶子指派清单入失败消息）。
- 绿门：contracts 172/172+typecheck ✓；daemon 868/868+typecheck ✓；studio 2508 passed+1 skipped、
  svelte-check 0/0、build ✓；git diff --check ✓。engine//canvaskit/undo 零改动；8317/5200 未触碰。

## 终态（2026-09-28）

- **Codex 双轮**：7.8 NEEDS-WORK（导出面 858/capability 边界）→修复轮（effectiveGems 单源+export 恒等/过滤/tree-missing 三态+跨域测试）→**8.6 CONDITIONAL-GO 放行 Owner 验收**（报告归档 codex-review.md）。
- vision 终审：三大目标兑现零阻塞（缩略 14/14/PS 单行节奏/组门三面）；图例「71」定案 NCC 误读——真环境 DOM 复核「6 红鼻子 21」正确。
- 绿门：contracts 172/daemon 868/studio 2508+typecheck×2+svelte-check 0/0+build。
- 生产发布前收口（Codex 条件）：过滤导出 blobRef 的 artifact 帧登记（若要求 ref 可经 tasks.artifact 回读则 P1）/双击事件竞争/living spec 同步。
- Owner 验收环境：8317=v5 数据（journey-clown-rich-v5-20260928——699 颗无父层钻）。
