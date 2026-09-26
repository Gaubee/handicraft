# workbench-pro 能力增量（add-workbench-pro）

## ADDED Requirements

### Requirement: 工作台写操作通用保证（CAS/幂等/权限/版本审计）

layer.reorder / layer.delete / layer.mask.patch 三写 RPC SHALL 满足同一冻结面：入参必带 expectedTreeBlobRef（调用方本地树工件基线），漂移必 typed 拒（cas-mismatch——错误面携带电流树引用）；成功响应必含新 treeBlobRef+previewBlobRef+version；操作者经登录态+task owner 归属校验后 SHALL 入 tree 版本史（cause 六值枚举）；cancelled/cleared 任务拒写（fence）。

#### Scenario: CAS 漂移必拒（幂等重试安全）

- **when** expectedTreeBlobRef ≠ 帧流最新 object-tree 工件 → typed 拒 cas-mismatch+错误面携带 currentTreeBlobRef
- **when** 同基线重试发生在成功之后 → 必被 CAS 拒（无重复副作用）；currentTreeBlobRef=自己上次响应的 treeBlobRef ⇒ 客户端判「已生效」放弃重试
- **when** 响应成功 → treeBlobRef/previewBlobRef/version 三件套在场+tree_versions 入史（cause=reorder/delete/mask-patch）

### Requirement: 图层结构写操作（重排/删除）

系统 SHALL 支持图层重排（父变更+序位）与子树删除：重排环路必拒（新父在目标子树内含自身）、根/画布节点不可重排不可删（root-protected）；删除 SHALL 移除子树节点全集+父收口，被删节点上的指派 SHALL 随产块节点集收敛移除且存量 plan 存在时重算 gems；重排不增删节点故指派/gems 零触碰。

#### Scenario: 重排语义

- **when** 移动节点到新父指定序位 → 树重写+预览重渲染+版本入史（cause=reorder）
- **when** 新父=目标自身或其后代 → typed 拒 cycle
- **when** 目标为根/画布节点 → typed 拒 root-protected

#### Scenario: 删除收敛

- **when** 删除带指派的子树 → removedNodeIds 全集返回+被删指派收敛（removedAssignmentNodeIds）+gems 重算
- **when** 删除根/画布节点 → typed 拒 root-protected（单根树结构锚）

### Requirement: 遮罩笔刷编辑与编辑状态机

系统 SHALL 支持最小遮罩编辑（笔刷 add/remove 圆盘沿折线扫掠——画布像素坐标，bbox 外无效不跨界改兄弟层）：编辑后 mask 如实重写+tightBBox/effectiveMm 重算+版本入史（cause=mask-patch）；可选触发受影响指派重算（编辑后重算闭环）。mask 编辑状态机 SHALL 冻结五态：accepted → recomputing → ready / stale / error（重算未完成期间树被推进=stale；重算失败=error 且不回滚已入史 mask——可重试）。

#### Scenario: 编辑闭环

- **when** 笔刷提交 → mask/bbox/effectiveMm 重算落盘+版本入史+编辑留痕（runCount/状态机态）
- **when** 笔迹涂空全节点 → typed 拒 mask-invalid（节点必须保有非空掩码——整层移除走删除）
- **when** recomputeStrategy=true 且有存量 plan → gems 重算返回；重算失败 → editState=error+门阻断（mask 不回滚）

### Requirement: 导出门（exportGate）

task.detail SHALL 组装导出门（mask 编辑状态面的纯函数）：mask incomplete（RLE 行程数超 4096 上限——如实落盘不截断）或编辑 stale/error 态时 allowed=false+blockers 如实携带；导出 RPC SHALL 在门阻时 typed 拒（export-blocked）。门只增不减——无客户端豁免口。

#### Scenario: 阻断与放行

- **when** 任一节点编辑留痕 incomplete（行程>4096）→ blockers 含 mask-incomplete+导出拒
- **when** 任一节点编辑留痕 stale/error → 对应 blocker+导出拒
- **when** 编辑留痕全 ready 且限内 → allowed=true

### Requirement: 视图态服务端所有权与锁定语义

图层显隐/折叠/锁定 SHALL 为 task 级服务端工件（JSON blob+revision 单调链+内容寻址回溯——重载/换端不丢；并发写 CAS：expectedRevision 漂移必拒）；锁定节点 SHALL 冻结其结构+遮罩面（mask.patch/reorder 必拒、删除该节点或含它的子树必拒——node-locked；移动其祖先携带锁定节点放行）。

#### Scenario: 持久化与并发

- **when** 工作台刷新/换端重开 → 显隐/折叠/锁定状态从服务端工件读回（不丢）
- **when** 双开工作台并发写视图态 → expectedRevision 漂移方被 typed 拒（不静默覆盖）

#### Scenario: 锁定语义

- **when** 锁定节点的 mask.patch/reorder/delete（本体或含它的子树）→ typed 拒 node-locked
- **when** 移动锁定节点的祖先（子树完整搬运）→ 放行（不编辑锁定节点本体）

### Requirement: undo 四域状态机

undo 栈 SHALL 按操作域分四域独立游标：tree-structure（拆层/改名/重排/删除/回退）/ tree-view（视图态）/ mask-edit（笔刷编辑）/ strategy-param（策略直改）。Ctrl+Z SHALL 路由到当前焦点域回退；本域栈空提示而不自动跨域；mask-edit 域回退 SHALL 只替换该节点 mask 面（前驱快照）不动结构/策略域；tree.revert 只服务 tree-structure 域且 UI 预览如实列出一并回退的他域操作。

#### Scenario: 交错操作域独立回退

- **when** 序列为「笔刷编辑→改密度→重排」后在 mask 编辑上下文按 Ctrl+Z → 仅回退笔刷编辑（新父位与新密度均保留）
- **when** 在图层树上下文按 Ctrl+Z → tree.revert 整树回退+预览提示将一并回退的遮罩中间态

### Requirement: 性能门三层 receipt（波 2d 验收）

性能验收 SHALL 按三层门执行并产出 JSON receipt（场景×层×指标 P50/P95/max+样本数+环境指纹+逐条 pass/fail）：首帧门（冷/热缓存各档 gems 上限）、交互帧门（平移/缩放/图层树滚动/mask overlay 叠加 P95）、后台解码门（mask 解码/坏数据降级不阻塞交互）；内存门按浏览器 tab 级 RSS 口径。超门=回炉不降门（数值调整须 Owner 批准）。

#### Scenario: receipt 可复跑验收

- **when** 2d 脚本对三档素材冷/热各跑一遍 → receipt 逐条判定入库（含环境指纹）
- **when** 任一指标超门 → 该批次回炉（禁止降门放行）

### Requirement: P1 降级面显式化

羽化（二值 mask 保持——alpha/距离场留契约接口位）、多选/批量图层操作、父层显隐传递（子层渲染继承但不写子层视图态）SHALL 作为 P1 延期显式记录，不进入 P0 验收面；blob mask 前端全链（拉取/缓存/加载态/坏数据态/编辑回写）属波 2b 实现范围。

#### Scenario: P0 范围守卫

- **when** P0 验收 → 羽化/多选批量/父层显隐传递不在通过条件内（缺席不判失败）
- **when** blob mask 编辑回写 → 走 2a 冻结契约（两态 Mask2DRef+layer.mask.patch），无新遮罩格式
