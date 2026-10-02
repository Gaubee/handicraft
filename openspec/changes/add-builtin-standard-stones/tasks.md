# Tasks

- [x] 1.1 `src/stones/builtin-texture.ts`：generateBuiltinTexturePng(rgb) 确定性渲染（抗锯齿圆盘+高光+边缘暗部，128×128）；单测（同 rgb 同字节、alpha 非空、过 gates 对账）。
- [x] 1.2 `stone.create.builtin` 能力（propose 筛选+查重预览 / execute 批量物化沿 stone.import 事务先例）；supplier 字面量「内置标准（SS 云数据参考）」；工具描述（含 stone.create 重试指引句）。
- [x] 1.3 知识库种子：空钻库行为指引（先 builtin 物化再走管线）。
- [x] 1.4 测试：空库 propose→execute 全链（53 条入档+幂等重跑全 skip+预览/执行一致性）；筛选子集；supplier×sku 查重拒。
- [x] 1.5 绿门：daemon tsc+stones 族测试聚焦全绿。
- [x] 2.1 复验（MainAgent）：8320 重走导出腿至五产物（账本回放加速）+walkthrough-report 增补。
