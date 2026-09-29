# Tasks：项目钻清单+lint 与 任务导出 MCP 化

> 设计全文=arch-decisions.md（Codex 裁定 2026-09-29，源码级核实）；本 tasks 按其 W0-W5 波次组织。AGENTS.md/i18n.zh.md=Codex 依全局指令产出的边界与术语记录。

## W0 契约与读模型

- [x] 0.1 contracts：StonesManifestSchema（session 锚+revision+sourceSet 溯源+entries[StonePick 物化快照+stoneRevision/stoneJsonBlobRef/textureBlobRef/shapeAssetBlobRef+quantity+origin]）/StoneLintSchema（unintroduced|unresolvable|introduced|unused 分类+revision/planRef 锚）/TaskLayoutSchema（imageId 锚+grid/palette/gems[含 stoneRef/sku/supplier/colorHex]/shapeAssets）
- [x] 0.2 daemon：session-project 状态行迁移（sessionId 唯一+revision CAS+manifest blob 引用+清理释放）+manifest service（校验/CAS 事务/补帧恢复）
- [x] 0.3 followup 契约扩展：SessionFollowupInput 增 sourceSetId?（仅首个常规 followup；steer 拒）+多图 imageId 稳定分配
- [x] 0.4 task.detail 增 manifest 摘要（revision/entries 数/sourceSet）+lint 投影读面

## W1 首条创建

- [x] 1.1 daemon：集合展开快照（set+setRevision→逐 stoneRef 解析物化；无效/软删成员 typed 拒；首条 task 同事务提交初版 manifest；出错收口 failed 不留半成品）
- [x] 1.2 studio：Composer 集合选择器（新 session 首条消息时；单选+搜索+成员数/更新时间/stale 标记+跳过=空 manifest 文案；后续轮次显示清单摘要）
- [x] 1.3 回归：集合后续变更不影响项目字节；跳过=revision1 空 entries；下一 followup task 读到同一 manifest

## W2 MCP 中途追加

- [x] 2.1 daemon：studio.task.stones.list（manifest+lint 摘要+可选候选 query）/studio.task.stones.add（双模：proposalId 草案/grant 消费；expectedRevision CAS；库内校验+服务端回填 StonePick；成功后重算 lint 工件）
- [x] 2.2 工具描述+系统提示：先与用户讨论再添加（提示层非安全边界）
- [x] 2.3 回归：add 未引入→revision+1→lint warning 消失；并发同 revision 一成功一 STALE；库外 ref typed 拒

## W3 配置链闭合

- [x] 3.1 lint 单源函数 lintTaskStoneRefs（manifest×strategy-plan assignments×stone_index 三源）+三处接线（strategy.design proposal+执行/layer.strategy.set 成功结果/导出前）
- [x] 3.2 stones-lint.json 工件（每次计划/图层变更重算+revision/planRef 锚+来源漂移重算）+任务详情展示
- [x] 3.3 回归：strategy-gems 无 stoneRef 仍经 strategy-plan 正确 lint；exportGate 安全门与 lint 政策分离

## W4 导出工具

- [x] 4.1 daemon：task-layout.<imageId>.json 生成器（策略执行同真源链+planRef/treeRef/manifestRevision 绑定+隐藏层不导出裁定）
- [x] 4.2 daemon：studio.task.export 双模（proposal=lint+validate+exportGate+摘要+approval；execute=grant 消费+恒产三件套）+导出适配器（task-layout→engine buildSvg+renderGemsPng 复用+buildTaskBom 按 stoneRef 聚合含备料参考）+createShareBundle 发布
- [x] 4.3 产物面：artifact 帧三条（task-export.<imageId>.svg/png/bom）+result bundle（/r/ 分享+manifest 审计字段）+task.exports.list 多图历史读面
- [x] 4.4 回归：八条端到端验收（arch-decisions.md B4：多图独立三件套/SVG 钻数=gems 数/PNG 尺寸非空/BOM 按 stoneRef 分行合计=颗数/gate 阻断矩阵/重复 proposal 单 bundle/orphan 零残留）

## W5 Owner 浏览器走查

- [ ] 5.1 真实 daemon+MCP+浏览器全链：多图+集合选择→识图/树/策略→lint 警告→讨论→stones.add→消除→每图三件套导出下载
- [ ] 5.2 Codex 复核闭环+8317 换装交付

## W6（Owner 裁决 2026-09-30 收敛后形态）

- [x] 6.1 传多张自动拆会话：新会话首条消息携 N 图（+同文本+同集合选择）→studio 编排自动创建 N 个会话（每会话单图=image-1 语义天然成立）→toast 汇总+会话列表刷新；已有消息的会话多图不拆（讨论插图语义不变）；单图行为零变化；daemon 零改动（复用 createSession+followup 链）；「导出第二张图=拒」提示随单图化自然消亡
- [x] 6.2 批准记录挂项目域：grants 绑定从 task 升级为 project（session_projects 同域存储载体——Owner 裁决「项目级」）；同项目跨轮有效+单次消费+自动过期（轮次结束/超时）；项目清理时批准级联失效；跨项目（新会话）须重新批准；审批卡呈现归属项目
- [ ] 6.3 门：拆会话 N 会话各自载荷/单图不回归/已开谈不拆；grant 项目域消费/过期/级联/跨项目拒 全矩阵+Codex 复核+走查补验（测试矩阵+daemon/studio 全量+typecheck+svelte-check 已绿——2026-09-30；Codex 复核与 Owner 走查待续）
