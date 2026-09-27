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

系统 SHALL 支持最小遮罩编辑（笔刷 add/remove 圆盘沿折线扫掠——画布像素坐标，bbox 外无效不跨界改兄弟层）：编辑后 mask 如实重写+tightBBox/effectiveMm 重算+版本入史（cause=mask-patch）；可选触发受影响指派重算（编辑后重算闭环）。mask 编辑状态机 SHALL 冻结五态：accepted → recomputing → ready / stale / error（重算未完成期间树被推进=stale；重算失败=error 且不回滚已入史 mask——可重试）。异步重算作业 SHALL 以编辑代次（base_version）为作业 token：同节点连续 patch/retry/discard 与旧作业完成交错时，旧代次作业的全部状态推进必落空（作废）——新编辑不被旧作业收敛或错配。

#### Scenario: 编辑闭环

- **when** 笔刷提交 → mask/bbox/effectiveMm 重算落盘+版本入史+编辑留痕（runCount/状态机态）
- **when** 笔迹涂空全节点 → typed 拒 mask-invalid（节点必须保有非空掩码——整层移除走删除）
- **when** 笔迹坐标超画布界/段长或单笔插值步数超限 → typed 拒 mask-invalid（资源上限——极值坐标不进扫掠循环；契约层另有坐标绝对上界 typed 拒 invalid-input）
- **when** recomputeStrategy=true 且有存量 plan → 响应先返 editState=accepted（gems=null——重算不阻塞调用方）；重算经后置作业收敛，终态（ready/error）与重算产物经 task.detail.maskEdits/帧流读取；前端 SHALL 等待终态（轮询 editState 或帧驱动）而非单次刷新；重算失败 → editState=error+门阻断（mask 不回滚）

#### Scenario: stale/error 恢复链（重放重算/确认放弃——终评收尾轮）

- **when** 编辑留痕 stale/error 且用户发起重算 → maskEdit.retry（携带现读留痕 baseVersion 为 CAS 基线）基于电流树+帧流最新 plan 同步重放 → 响应携带重放后的完整留痕行（终态 ready=门因子解除 / error=可再试）
- **when** retry 的 CAS 基线漂移（同节点新编辑已接管行）→ typed 拒 cas-mismatch；服务端条件 UPDATE 落空（SELECT/UPDATE 竞态缝被新 patch 覆盖）→ 重读行现值直接返回且**不执行重算副作用**（不基于过期基线树发布工件）
- **when** 用户确认放弃阻断留痕（stale/error/incomplete）→ maskEdit.discard 删行+导出门重估（mask 已落盘如实不回滚——用户显式接受现状）；限内 ready 留痕无阻断面 typed 拒；行已不在=幂等成功（discarded=false）

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

undo 栈 SHALL 按操作域分四域独立游标：tree-structure（拆层/改名/重排/删除/回退）/ tree-view（视图态）/ mask-edit（笔刷编辑）/ strategy-param（策略直改）。Ctrl+Z SHALL 路由到当前焦点域回退；本域栈空提示而不自动跨域；mask-edit 域回退 SHALL 不动结构/策略域（当前交付=未提交笔画的本地栈 undo/redo；**已提交 mask 的前驱快照精确逆/跨 revert 线性游标/多域 redo=后续 change 范围——Owner 排期，本 change 不声明**）；tree.revert 只服务 tree-structure 域且 UI 预览如实列出一并回退的他域操作。

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

### Requirement: 钻候选面与钻选择器（v3 Owner 整改）

task.detail SHALL 携带 stoneCandidates（owner 共享库稳定序投影：idx 1 基/resourceId/sku/supplier/sizeMm 可空/colorHex/family——与策略设计候选表同源）；无可用钻=空数组（UI 引导入库，不阻塞 detail）。layer.strategy.set 的 stoneIdx SHALL 引用该表 idx；未改动指派=服务端继承旧钻。UI SHALL 禁止空选应用（显式选集为空且非 exclusion 时禁用+提示——清空语义走策略移除，杜绝「已选 0 而真源保留旧钻」分叉）。

#### Scenario: 候选面与指派

- **when** 打开工作台 → 右侧检查器呈现完整候选色板（多选；指派 stones 反查 idx 高亮）
- **when** 应用空选 → 禁用+提示（真源不被隐性继承污染）

### Requirement: 预览三模式服务端化（v3 Owner 整改）

预览模式（rendered=钻渲染到孔/holes=只有孔洞/numbered=按图层分组编号）SHALL 服务端化入 view-state 工件（刷新/换端/daemon 重启保持）；旧工件无此键=向后兼容缺省 rendered。切换 SHALL 按意图代次捕获（请求体用捕获值；失败回滚仅当本请求仍是最新代次——连续切换最终意图不丢）；模式不进任何 undo 域（产品语义）。

#### Scenario: 三模式与持久化

- **when** 切换 numbered 后刷新页面 → 模式保持（服务端工件真源）
- **when** 连续 rendered→holes→numbered 且首笔失败 → 最终态=numbered（迟到失败不回滚最新意图）

### Requirement: 事务历史 journey 入链与回退刷新（v3 Owner 整改）

Agent 会话产树（识图/循环——工作台外写入）SHALL 经 tree.history 读面播种 cause='journey' 基线入版本链：读尾-比较-插入同事务（BEGIN IMMEDIATE 原子幂等）+tree/preview 双工件可读校验+播种失败不炸读面（工件/fence 面静默跳过，未预期异常记日志）。回退成功后前端树内容 SHALL 真刷新（结构写漂移标志封堵「ref 回拨==装载 ref」短路——本地已演进节点不被旧树保身份）。

#### Scenario: journey 基线与回退

- **when** journey 任务首次打开历史 dock → 基线自动入链（可回退；重复读不重复入史）
- **when** 重命名后回退到首版本 → 图层行名==目标版本快照名（非重命名后旧名）

### Requirement: 锁步发布门（v3 放行条件）

contracts/daemon/studio SHALL 作为同一不可拆分版本发布：本轮 stoneCandidates 必填+previewMode 键+strict schema 组合在版本混布时互相拒绝（旧 daemon↔新前端双向）。发布检查 SHALL 禁止新旧混合部署（滚动升级需先做能力协商——本 change 明确不做）。

#### Scenario: 版本一致性守卫

- **when** 部署 → 三包版本锁步校验（混布=发布门红）
