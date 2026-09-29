# 贴钻 backend 项目上下文

本文件只记录项目局部事实与设计边界。跨 Agent 通用规则以 `~/.agents/AGENTS.md` 为唯一全局来源。

## 2026-09-29 项目钻清单与任务导出设计裁定

Owner 原始意图：任务开始时选多张图片与一个素材集合；集合对项目是复制/展开，项目可追加系统库内的钻；未引入的库内钻用于图层配置时触发 lint 警告，确认后通过 MCP 引入；导出也要工具化。完整裁定见 `/tmp/codex-stones-lint-export.md`。以下均为**待实现设计**，不是当前运行行为。

```text
session(project) -- stones-manifest revision/blobRef
    |                  |
    +-- followup task --+-- strategy-plan / stone lint (per imageId)
                         +-- task-layout (per imageId)
                              -> SVG + PNG + BOM result bundle
```

- 当前每次常规 `session.followup` 都创建新 task。因此项目钻清单以 session 为项目锚点；内容为版本化 `stones-manifest.json` blob，权威指针和 CAS revision 放 session-project 状态行，task artifact 帧用于回放和通知。一个 session 只对应一个项目是本轮设计解释；若产品允许一个 session 内多个项目，需显式 projectId。
- 生产集合 `set.json` 的成员仍是 `stoneRef` 弱引用；项目在首条任务消息中展开一次，复制 `StonePick`、备料参考 `quantity/note` 和原子 revision/stone JSON/贴图/形资产的内容引用并持有项目侧 blob 引用，集合后续变更不自动传入项目。全局库仍是可选钻范围，manifest 只标记项目已引入的钻。
- lint 以策略计划 `assignments[].stones[].resourceId` 与项目 manifest 比较：库内但未引入为 warning；库外/失效为 hard error。规则在策略提案、图层配置、导出复验中同源运行；tool-result 立即返回，任务工件持久化当前诊断。
- Agent 修改项目 manifest 必须用库内 `stoneRef`、owner/session 校验、proposal/grant、revision CAS；工具描述中的“先讨论”不是权限边界。
- 当前 `task.export` 只出按叶子口径过滤的 strategy-gems JSON；现有 `studio.export` 只导出独立 `LayoutDocument`。新任务导出需按 imageId 的 `task-layout` 真值快照，复用 engine `buildSvg` 与 daemon PNG renderer，并在 daemon 按 stoneRef/SKU 生成任务 BOM；现有 engine `buildBom` 仅按规格×颜色汇总，不能代替物料 BOM。每次导出目标图片的三件套，现有两种导出入口不改读域。
- engine SVG 当前只按颜色 `<g>` 分组，不代表工作台对象图层。若需对象层可编辑 SVG，须单独冻结契约；任务导出还要明确叶子口径与隐藏层是否参与，本轮建议与精修导出保持“隐藏不导出”。
- 普通 Studio 的 `exportSink` 和精修 `documentService/pngRender` 读浏览器 store/IDB/canvas；daemon PNG renderer 是透明底钻位光栅。新任务三件套首波按 daemon 生产口径，不等同于精修 WYSIWYG 合成 PNG。
- `task.result` 可投影运行中 task 最近一次导出的 bundle；`session.result` 只选最近已完成 agent task 的结果。多图结果需另有按 imageId 的持久历史/下载索引，不能把单值 `tasks.result_id` 当多图清单。

源码锚点：`contracts/src/sets.ts`、`contracts/src/stones.ts`、`contracts/src/kernel.ts`、`contracts/src/session.ts`、`daemon/src/kernel/index.ts`、`daemon/src/kernel/strategies/design.ts`、`daemon/src/capability/studio.ts`、`daemon/src/rpc.ts`、`rhinestone-studio/src/lib/engine/export.ts`。
