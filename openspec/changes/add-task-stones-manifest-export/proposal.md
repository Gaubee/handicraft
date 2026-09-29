# 提案：项目钻清单+lint 警告 与 任务导出 MCP 化（Owner 决策 2026-09-29）

## Why

Owner 对两挂账的裁决（原话见 design §0）：
1. **钻清单语义**（替代此前误框的「授权死锁」）：任务开始时选图（多张）+选素材集合——**复制/展开关系非引用**；可在集合基础上补充任务可用钻，但只能添加系统已有钻（新增钻型=管理员权限）；MCP 支持中途添加；项目可用全部钻但未引入者使用时触发 **lint 警告**（与项目配置关联检查）；模型须与用户讨论，确定后调 MCP 引入（项目配置更新）。
2. **导出 MCP 化**：工具化实现导出（SVG/PNG/BOM）；工具形态（单/多工具/多参数）授权 ZCode 与 Codex 讨论裁定——已裁定（arch-decisions.md B1）。

配套已落地：followup 看门狗 300s→30min（b05172b）。

## What Changes（六波，Codex 裁定 arch-decisions.md §2 采纳）

- **W0 契约与读模型**：StonesManifestSchema/StoneLintSchema/TaskLayoutSchema 三契约+session-project 状态行（sessionId 唯一+revision CAS+manifest blob 引用）+imageId 稳定分配+task.detail manifest/lint 摘要投影。
- **W1 首条创建**：首条常规 followup 增 `sourceSetId?`（仅首个常规 followup 接受）+Composer 集合选择器（首波单选+可跳过=空 manifest）；服务端展开快照（StonePick 物化+setRevision/stoneRevision/blobRef 冻结）；无效成员 typed 拒；后续 task 共享同 session manifest。
- **W2 MCP 中途追加**：`studio.task.stones.list`（readonly）/`studio.task.stones.add`（双模授权+manifest revision CAS+库内校验+服务端回填快照）；add 后重算 lint 工件。
- **W3 配置链闭合**：lint 单源函数挂三处（strategy.design proposal+执行/layer.strategy.set 成功结果内嵌/导出前重算）；unintroduced=warning（不阻断）、库外/软删/损坏=hard error；stones-lint.json 工件持久化+任务详情展示。
- **W4 导出工具**：`studio.task.export` 双模（proposal 跑 lint+validate+exportGate 返回摘要+approval；execute 消费 grant 恒产该 imageId 三件套 SVG+PNG+BOM）；task-layout.<imageId>.json 渲染快照（gems 带 stoneRef/sku/supplier 物料身份）；daemon 适配层复用 engine buildSvg+daemon PNG renderer（engine 零改动）；任务 BOM 按 stoneRef 聚合（含备料参考列）；产物=artifact 帧三条+result bundle（/r/ 分享）+task.exports.list 多图历史读面。
- **W5 Owner 浏览器走查**：多图+集合选择→识图策略→lint 警告→讨论→MCP 引入→警告消除→每图三件套导出下载，全链真走。

## Impact

- contracts：三新 schema+session followup 扩展。
- daemon：session-project 域（状态/CAS/引用/清理）、manifest service、lint 单源+三处接线、MCP 两工具+export 工具、task-layout 生成器、导出适配器、exports 历史。
- studio：Composer 集合选择器、任务详情 manifest/lint 展示、结果下载面。
- 不动：engine/（buildSvg/renderGemsPng 只读复用）、全局 stones 库写面（恒 admin）、既有 task.export JSON 能力（保留）、studio.export 独立 layout 面（保留）。

## Owner 语义的已采纳偏差（arch-decisions.md §3 全文）

首波单集合／未引入=warning 不阻断导出／quantity=备料参考非约束／导出双模审批保留／PNG=透明底钻位渲染（非精修 WYSIWYG 合成图）／项目锚 session 按图分组产出／任务 BOM 含 supplier+SKU（超 engine 规格×色口径）／SVG 颜色分组非对象图层——八项详见归档，Owner 随时可纠正。
