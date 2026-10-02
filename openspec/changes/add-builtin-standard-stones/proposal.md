# 提案：内置标准钻（空钻库自举通路——走查发现的自动路径阻断修复）

## Why

断点续跑 E2E 走查（2026-10-02，`主仓 experiments/segment-e2e-20260902/walkthrough/walkthrough-report.md`）实证：**空钻库实例的全自动路径结构性必死**——agent 在 stone.create 步骤熔断（两次复现，管线前后段各一）：

- 工具面 `CreateInputSchema.texture` 可选（stones.ts:307）但 propose 模式经 `StoneCreateProposeSchema` 二次校验必填（:246→:1059），且贴图须「先经上传面入库」——**agent 无贴图上传工具**，契约上不可满足；
- 服务层 gate 6「缺贴图=显式态不静默降级」（service.ts:254）是刻意设计（真实钻=拍照贴图），不可一刀切转可选；
- `stone.import` 是样卡批量导入（草表 blob+源图页直供）——同样依赖上传面，非 agent 自足。

8317 生产实例不受影响（Owner 手工导入的库），但**任何新实例/新用户的第一个任务必然死在此处**。

**修法（对齐 Owner 既有裁决）**：内置标准钻——`SS_CLOUD_CATALOG`（53 条 SS 云数据参考，Owner 裁决「云数据参考非库存承诺」）作为参考源，agent 经 **approved-mutation 审批**发起物化：服务端按条目 rgb **确定性生成贴图 PNG**（标准圆钻渲染），supplier 固定「内置标准」显式标识非 Owner 库存；**入库必经用户批准卡**——没有任何未批准的库变更，云数据裁决语义保持。

## What Changes

1. **贴图生成器** `src/stones/builtin-texture.ts`：`generateBuiltinTexturePng(rgb)`——确定性纯函数（抗锯齿圆盘+高光点+边缘暗部，尺寸 128×128），过贴图 gates（declared 与解码实测对账、alpha 非空等——生成器两端同源必对齐）。
2. **新能力 `stone.create.builtin`**（approved-mutation 双模，mirror stone.create 先例）：
   - propose：入参 `taskId` + 可选筛选（ssLabels/colors 缺省全量 53 条）→ 预览清单（sku=`SS{档}-{色名}`、sizeMm=SS_DIAMETER_TABLE、生成贴图缩略预览引用）+ 既有 supplier×sku 幂等查重（已存在全 skip 的空批=显式拒提示）；
   - execute：批准后循环物化（同 grant 消费事务语义沿 stone.import 批量先例）；supplier 固定字面量「内置标准（SS 云数据参考）」。
3. **知识库种子指引**：空钻库行为指引（「库空时先 stone.create.builtin 物化内置标准钻（须用户批准）」）；`stone.create` 工具描述补一句「无贴图上传面时勿重试本工具——改走 stone.create.builtin」（治走查实证的同错熔断循环）。
4. **E2E 脚本**：start-e2e-8320.sh 已补 MCP_PORT=8319（走查发现的 8318 端口冲突——8317 生产占用 MCP 缺省口）。

## Impact

- daemon：src/stones/builtin-texture.ts（新）+src/capability/stones.ts（新能力+描述）+知识种子文案；contracts 零改（CloudCatalogEntry/SS_DIAMETER_TABLE 既有）。
- 不动：贴图六 gate 语义、stone.create/import 既有面、库存真源边界（内置钻 supplier 显式区分）。
- 复验：8320 重走导出腿（断点账本回放加速——语义抠图段零重跑）。
