# add-backend-platform Codex Review R2

- 评审基线：`700a6bc`；目标：`ec55400`（当前 HEAD）。实际评审 `git diff 700a6bc..ec55400 -- openspec/changes/add-backend-platform/`，并对照当前引擎类型和 zhumo 源码抽查关键契约。
- 结论：**NEEDS-WORK，6.7/10**。相对 R1 **+1.3**：八项旧问题均有针对性文档修订，平台、格式和测试分类明显收敛；但多项只冻结了方向，契约仍与真实引擎/运行边界不合，短会话的跨 SQLite/文件系统原子性也不可按当前文字兑现。另发现 MCP 网络隔离及测试零改动两项新问题。
- 验证：`openspec validate add-backend-platform --strict` 通过；`git diff --check 700a6bc..ec55400 -- openspec/changes/add-backend-platform/` 通过。该 change 仍是设计/任务文档，未运行应用测试；结构校验不等于实现契约闭合。
- 工作区中另有两项未跟踪媒体文件，与本评审无关，未触碰。

## R1 八项逐项复核

| R1 项 | 状态 | R2 结论与证据 |
|---|---|---|
| P1-1 平台/首发分发 | **已闭** | proposal、design、spec、tasks 均统一 darwin-arm64；Windows/Linux/Docker 延后；spec 加入 dist 缺失/损坏显式失败，tasks 加 stale/missing 门禁。验收应覆盖“损坏”而非只测目录不存在。 |
| P1-2 Agent 会话契约/W3-W4 | **部分闭合** | design §3.5 已列 create/list/followup/answer/cancel/replay/result、Frame 两族及 W0 前置，proposal/tasks 也明确 mock 不算 MVP、W4.4 才是联调门。未闭处见下方 B1：一个 session 可有多个 task，但 replay 的会话级单游标没有定义如何覆盖每个 task 的 seq；`session.result` 也未标明选择哪个 task 的结果。 |
| P1-3 批准授权桥/撤销组 | **部分闭合** | §3.6 已冻结 task、opDigest、user、过期、nonce 的一次性 grant 及拒绝/重放测试，并列出 patch_history。未闭处见 B2：详细签发/消费流程只覆盖 patch-propose/patch-apply，但 spec 将授权桥要求扩展到所有 approved-mutation（含 generate/export）；approve 后 agent 如何取得 nonce 未定义；等待批准期间目标已变化时也缺少 revision/CAS 前置条件。 |
| P1-4 排布参数 | **未闭** | §3.4 给出四参数、region ID、fixture，但声称镜像引擎现行类型不成立：`rhinestone-studio/src/lib/engine/types.ts:132-133` 的策略含 `cvt`，design §3.4:60 未列；`LayoutOptionsSchema` 的 density 是 `0..1` 或按块 Record（`:192-200`），design §3.4:58 却定义 `0..100` percent；引擎 `GridSpec.gapMm` 可为 `>=0`（`:182-188`），设计另定义 `minSpacingMm > 0`，但没有转换到 gap 的单一规则、首版范围/默认值。`layers` 是 Studio 层概念，也不是 engine layout 的输入 ID。详见 B3。 |
| P1-5 Agent 故障降级隔离 | **部分闭合** | design §6.4 明确动态加载、基础作业独立及仅 agent 端点 501；spec 覆盖 off/缺包/挂载失败。tasks W4.1 声称捕获 module-resolution 失败，但其三态 E2E 实际只列 DSH off、boot throw、正常态，未覆盖缺包/坏包；不能据此验收“缺包可降级”。见 B4。 |
| P1-6 Node PNG | **部分闭合** | §6.3 已选择纯 TS 软光栅 + Node zlib，排除浏览器全局和原生依赖，并要求 Node fixture。实现语义仍未冻结：文字只写“钻点圆填充”，当前 `Gem` 支持 builtin 非圆形及 `custom`/assetId（`engine/spec.ts:26-52`），现有 PNG 路径还消费 shape、sprite、reference 等数据。未说明服务端 PNG 是仅圆钻首版还是必须保真现有格式/资源；若静默画成圆点则与支持格式的产物预期不一致。见 B5。 |
| P1-7 短会话生命周期 | **部分闭合** | §6.5/spec 已定义 clear、留存矩阵、分享 TTL、共享 blob、失败重试和并发测试，方向完整。未闭处见 B6：SQLite 事务不能回滚已 unlink 的帧/blob 文件；而当前规范要求同一事务删 DB 行、文件和解引用，宣称失败整体回滚。`session.clear` 也未列入 §3.5/W0.1 会话 API。需改成可恢复的跨介质协议。 |
| P1-8 格式演进/语义无损 | **已闭** | spec 明确当前版本内语义无损、非字节相等、旧版本可显式拒读且不得静默丢字段；proposal/design/tasks 对齐。 |

zhumo 映射表的七表（省略 wizard_steps）、管理员 `.env ADMIN_*` 建号流程、MCP 进程周期 token、异步 ComputeProvider 与 W3 测试分类四条修订均已落文档；异步接口另留失败/取消/版本化细节，属后续 P2 收口，不构成本轮主要阻塞。

## 阻塞问题

### B1 会话/任务关系与游标、结果选择未闭合（P1）

design §3.5:71、84 定义 session 1—N agent task，且 `afterSeq` 按 task 单调；但 `session.replay {sessionId, afterSeq}` 没有 `taskId`，不同 task 的 seq 不能用单一游标无歧义回放。`session.result {sessionId}` 同样未定义多次 followup 后返回最新、全部还是指定 task 的结果。当前 W4.4 序列测试只覆盖单一演示路径，无法证明该 API 一致。

**可验证修复：**选择并冻结一种模型：例如 replay 改为 `{sessionId, taskId, afterSeq}`，session 总览另给 task 列表/游标；result 改为按 taskId 查询或明确 latest 的排序/失败语义。W0.1 schema 测试构造一个 session 两个 task、各自 seq 从 1 开始，验证续传无重帧/漏帧、结果选择确定。

### B2 授权 grant 的适用范围和消费路径不足（P1）

spec:51 将 grant 要求施加于 approved-mutation 全体，design §3 工具清单还包含 `studio.generate`、`studio.export`；但 §3.6:92-96 只描述 patch proposal/apply 与 patch_history。`session.answer → grant` 后，`approval-resolved` payload 只有 requestId/approved/grantedAt（§3.5:80-81），既未定义 nonce 如何安全交给后续 MCP 工具调用，也未定义调用主体/任务如何关联。digest 绑定操作内容，但不绑定资源 revision；批准等待期间目标被改动时可能按过时 before 值覆盖新状态。

**可验证修复：**明确哪些工具属于批准变更，并对 generate/export 各定义批准对象与幂等边界；补充服务端内部 grant 到待执行 MCP 调用的传递/消费协议（避免把 bearer nonce 发到普通帧/UI）；将 resourceId、base revision 或 before-state 纳入批准，并在 apply 时 CAS，不匹配则拒绝且要求重新预览/批准。测试覆盖批准后目标被其他写入改变、跨 task/user 使用凭据、重复请求及每种 mutation 的恰好一次语义。

### B3 四参数契约与引擎真源不一致（P1）

design §3.4:53 声称以当前引擎类型为唯一真源，实际策略列表遗漏 `cvt`；density 百分数与引擎 `0..1`/按 block Record 的结构不同；`gap` 与 `minSpacingMm` 语义不同（引擎 gap 是物理边缘间隙，中心距还加钻径）；`layers` 选择器不能直接作为 `layout(blocks, strategy, opts, grid)` 的输入。当前 fixture 只断言密度单调、间距失败，未覆盖 schema 到 engine 的映射。

**可验证修复：**由真实导出 schema 逐字段镜像，策略直接使用 `StrategyIdSchema`；density 统一为引擎 schema 的 `(0,1]` 并明确全局/逐块覆盖，gap 统一 `gapMm >= 0` 及允许范围/默认；region 首版收敛为 blocks ID，或另定义 layer→blocks 的解析和“rest”语义。另须冻结间距失败语义：当前 `layout()` 会经 `enforceMinDistanceCounted` 确定性剔除冲突钻并返回 `dropped`，并非必然让 job 失败；若产品要求硬失败，adapter 必须把冲突/剔除转成失败。W0.2 增加契约转换 fixture，断言输入经 adapter 后与直接 engine 调用等价，且 ID 不存在、空 region、负 gap 均显式拒绝。

### B4 声明支持“缺包降级”但没有对应门禁（P1）

spec:51、62-63 和 design §6.4:134 将缺包/模块加载失败列为支持状态；tasks W4.1:31 的 E2E 三态却是 DSH off、boot throw、正常 Agent，没有 module-resolution failure。动态 import 的 catch 测试无法由 boot throw 替代，因为静态/模块解析失败发生在不同加载路径。

**可验证修复：**增加独立进程或隔离模块解析器的缺包测试（确保启动成功、基础上传→生成 dry-run→排钻→导出→分享通过，且 agent/session/MCP 返回 501）；另覆盖坏包导入异常。或者删去 spec 对缺包降级的 MUST，并冻结安装期依赖边界。

### B5 PNG 保真边界未定义（P1）

design §6.3:128 的“钻点圆填充”没有说明 builtin 异形、custom `.gemshape`、形资产解析失败和 bundle 资源闭包如何处理；四族格式又允许保存 shape/asset 引用（spec:33）。因此当前文字既可能被实现为只画圆，也没有定义何时拒绝导出或降级。

**可验证修复：**冻结 V1 PNG 支持形状清单及缺失资产策略；如果承诺支持现有格式中的形状，就给 rasterizer 输入显式解析后的 shape path/asset bytes，真实 Node fixture 至少包含圆、builtin 非圆和 custom shape，并对像素/透明背景/旋转/资产缺失错误断言。若首版仅支持圆钻，spec/分享 bundle 必须显式拒绝或标注未支持格式，不可静默替代。

### B6 clear 的原子性跨越数据库与文件系统不可兑现（P1）

spec:44 写“原子事务”内删除会话/任务、帧 jsonl、解引用 blob，并要求失败整体回滚；design §6.5:150-152 重复该承诺。但 SQLite 不能与文件 unlink 共用事务：先删文件再 DB 失败无法回滚；先提交 DB 再删文件失败会遗留孤儿。分享资源并发读与 TTL 清理也需要同一套引用/回收协议。另 `session.clear` 未出现在 design §3.5:69-75 的冻结端点或 tasks W0.1 清单。

**可验证修复：**定义数据库事务内 tombstone/outbox 或清理状态机：事务标记 session clearing、撤销私有引用并保留可恢复日志；提交后幂等 unlink；完成后标记 cleared；启动时重放未完成清理。分享资源使用独立 result→blob 引用行和每个 result 的 TTL/revoke，不能只用 blob 级 shared 标记承载多个分享的不同生命周期。加入 clear API 到 W0.1，并测试进程在每个阶段崩溃/重启、并发下载和共享 blob 多引用。

### B7 MCP loopback-only 与 HOST 可开局域网冲突（P1，新问题）

spec:8 允许 `HOST` 开局域网；spec:51/design §2 MCP 同时只承诺 loopback-only，但两者都描述为 daemon HTTP 服务上的 MCP 端点，未规定独立 listener 或按远端地址拒绝。只绑定 daemon 到 `0.0.0.0` 时，`/mcp` 也会跟着暴露到 LAN，违背明确安全边界。

**可验证修复：**将 MCP 放到独立 loopback listener，或在路由层验证 socket peer 为 loopback（覆盖 IPv4/IPv6、代理头伪造、IPv4-mapped IPv6）；集成测试令主 HTTP 可 LAN 访问而 MCP 从非 loopback 连接必拒。不可只以随机 bearer token 代替 loopback-only 声明。

### B8 新测试分类与“既有测试零改动”互相矛盾（P2，新问题）

design §6 护栏:121 称 `rhinestone-studio` 既有测试零改动；§6.6:161 和 tasks W3.3:27 又要求显式更新 `app.globalImport.test.ts` 为双模式断言。产品代码不一定要改，但现有测试至少必须修改，当前文字会让实现者无法判断护栏是否禁止该必要修改。

**可验证修复：**把护栏改成“既有 engine 与旧工作台实现零改动；测试可按 §6.6 分类新增/更新”，并让任务中的允许修改清单与之对应。

## 质量评价

| 维度 | 分数 | 评价 |
|---|---:|---|
| R1 问题响应度 | 8.0/10 | 八项都有明确落点，P1-1/P1-8 闭合；会话、降级、PNG、清理仍有可验收缺口。 |
| 四件套一致性 | 6.5/10 | 平台和格式已对齐；W0/API 清单遗漏 clear，engine 类型真源声明与具体字段冲突，测试零改动与 W3.3 对撞。 |
| 契约可实现性 | 6.0/10 | Agent 主旅程有结构化 endpoint 与替身集成门；多 task replay、grant 消费、区域映射和跨介质清理仍需裁决。 |
| 安全/生命周期 | 6.0/10 | 一次性 grant 与降级隔离方向正确；MCP loopback 没有和 LAN 监听形成可验证边界，clear 原子性超出 SQLite 能力。 |
| zhumo 映射准确性 | 8.0/10 | 七表、管理员流程、进程周期 token、异步 provider 已修正；本仓 engine/API 事实仍需按真实 schema 收敛。 |

**综合 6.7/10，NEEDS-WORK。**相对 R1 的 +1.3 来自平台/格式矛盾关闭，以及会话、授权、安全隔离、短会话等从概念补到了明确契约与测试意图；扣分集中在部分契约看似冻结但与真实输入面不匹配，及跨数据库/文件系统“原子回滚”的不可实现表述。建议先闭 B1–B7，再进入 W1-W5 实施；B8 同轮修正文案即可。严格 OpenSpec 校验通过，但不改变该结论。
