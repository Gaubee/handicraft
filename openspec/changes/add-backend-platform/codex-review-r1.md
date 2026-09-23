# add-backend-platform Codex Review R1

- 评审基线：`700a6bc` (`700a6bcaeee9f5b4b8c96277e91577bbda469db3`)，评审对象为该提交后的四件套。
- 结论：**NEEDS-WORK**，综合 **5.4/10**；当前没有 P0，但有多项 P1 契约缺口，不建议按现有文档直接分发 W1-W5。
- 范围：只读核对 proposal/design/tasks/spec 与 rhinestone-studio、zhumo 的真实实现。`openspec validate add-backend-platform --strict` 通过；它只证明文档结构有效，不证明接口闭合。未运行代码测试，本 change 尚未实现。

## P0/P1 阻塞

### P1-1 平台裁决在四件套内互相冲突

Owner 当前裁决是前期唯一支持 `darwin-arm64`，但 proposal 仍承诺 win/mac 私有化与 linux Docker（`proposal.md:13`），design W5 也写 win/mac + linux（`design.md:57`），spec 将三者写成 MUST 并要求在 win/mac 克隆即跑（`spec.md:6,9-10`）。只有 tasks 冻结了 darwin-arm64 首发、将 Windows/Linux 延后（`tasks.md:31-32`）。这不是验收边界，而是支持平台与交付成本发生冲突。

**可验证修复：**四件套统一为 darwin-arm64 首发；Windows/Linux 移到明确的后续 change/non-goal，不得继续留在本 change 的 MUST 或克隆即跑场景。门禁应在 darwin-arm64 CI/Owner 机器验证安装、SQLite native addon、daemon 启停和 SPA 分发。

### P1-2 pivot 后 W3/W4 的联调契约与依赖边界没有冻结

proposal 仍称 W4 可并行（`proposal.md:36`）；design 将 W3 定义为 Agent 会话主面、W4 定义为 DSH/capability 后端，并称二者联调才是 MVP（`design.md:55-56`），但同一设计又写 W1-W3 不依赖 agent 面（`design.md:72`）。W3.1 需要会话列表、帧流、审批应答和结果页；W4.3 才把 firehose 接到前端，W4.4 的 dry-run 只承诺建任务与失败收敛（`tasks.md:18,24-27`）。spec 也只规定 UI 形态、MCP capability 和宽泛的审批结果，没有冻结 UI 调用的 endpoint、任务/agent session 关系、ask_user 应答协议、帧 payload 或恢复/取消语义（`spec.md:33-38,46-51`）。因此 W3 若并行，只能靠未定义的 mock 接口；若顺序执行，proposal 的并行声明不成立。

**可验证修复：**先在 contracts 冻结 `create/list/followup/answer/cancel/replay/result` 的输入输出、session 与 task 的所有权/生命周期、approval-request/resolved 的 Zod 载荷和游标语义；明确 W3 可按该契约/mock 并行开发，但产品 MVP 验收必须等 W4 接线后执行。W4.4 增加确定性模型/工具替身，走完主面创建会话→收到帧→回答审批→结果链接→断线回放的集成用例。

### P1-3 capability 的批准变更在照抄的 zhumo 权限模型下不可调用

目标设计写“用户批准后 agent 可调”`approved-mutation`（`design.md:47-49`），spec 要求相同（`spec.md:34,38`）。但 zhumo 的真实 registry 对 `principal === 'agent'` 一律拒绝 `approved-mutation`（`/Users/kzf/Documents/书法/shufa-server/daemon/src/capability/core.ts:69-75`），MCP 桥始终以 `agent` 主体调用（`.../daemon/src/capability/mcp.ts:28-29,58-64`）。zhumo 的 ask_user/answer 是对话审批，不会自动改变 capability 主体或授权某个 patch；故“照抄三件套”不能推出“批准后 agent 能 apply”。

**可验证修复：**定义服务端可验证的授权桥接：批准对象绑定 task、proposal/op 内容摘要、用户身份和过期时间；MCP 仍以 agent 主体运行，只有带匹配的一次性授权凭据才能执行指定 mutation。测试直接 MCP 调用必拒、批准别的 op/过期/重放必拒、获批 op 恰好执行一次；另冻结“一次撤销恢复整组”的持久历史实现，否则从 spec 删除该承诺。

### P1-4 排布控制主线没有落成可实现的 capability 输入契约

design 把密度、间距、排布模式、区域列为 W2/W4 的一等参数（`design.md:70`），但工具清单中 `patch-propose` 只列密度/换色/规格，没有间距或模式的类型、范围、单位、默认值与优先级（`design.md:45-48`）。区域首版还悬在“图块/图层”，并把选区/路径另归未定 change（`design.md:48,77`）；spec 只给“帽子区域改密”的一句场景（`spec.md:36-38`）。所以“钻排列散”这一产品差异化主线不能由实现者按同一输入模型开工，Agent 也没有可验证的区域目标定义。

**可验证修复：**以当前引擎的 Zod 输入类型为真源，冻结 `density`、`gap/spacing`、strategy、region selector 的单位/边界/默认/非法值行为，以及 proposal diff 的字段。首版区域需明确是用户选中的 block/layer ID，而非暗示 Agent 已能从自然语言图像识别“帽子”；对 `studio.pave-preview` 与 `patch-propose/apply` 添加固定 fixture，断言同参预览、密度变化方向、间距硬约束和未批准时真值不变。

### P1-5 “挂载失败 501”没有隔离 Agent 与基础工作流

目标把基础生成/排钻/导出置于 Phase A/W2，再把 DSH 放到 W4（`proposal.md:18`、`tasks.md:11-14,24`），同时承诺 Agent 挂载失败不阻塞其余服务、相关端点返回 501（`design.md:72`、`spec.md:34`）。zhumo 的挂载异常确实被捕获并让 daemon 继续启动（`.../daemon/src/kernel/boot.ts:191-205`），但它的 TaskService 在没有 kernel 时拒绝创建 task（`.../daemon/src/tasks/service.ts:117-129`），RPC 又把 task service 未装配映射成 NOT_IMPLEMENTED（`.../daemon/src/rpc.ts:477-481`）。照抄这一边界会让贴钻的 W2 生成/引擎任务也可能随 Agent 一起不可用；此外 zhumo 的 dsh 包是 daemon 的必需依赖且在 kernel 模块顶层静态导入（`.../daemon/package.json:13-32`、`.../daemon/src/kernel/boot.ts:19-25`），缺包时甚至到不了 mount catch。npm 可得性本身不作为阻塞，但声称的降级面尚不完整。

**可验证修复：**将基础作业与 agent session 分成独立服务/端点/状态：仅 agent/session/MCP 返回 501，普通上传→图像生成→排钻→导出在 DSH off 或 boot throw 时仍可完成。若缺少/加载失败 dsh 也属于受支持降级，须把内核依赖改为懒加载并覆盖 module-resolution 失败；若不支持，明确安装期必需依赖和降级保证的边界。增加 DSH off、boot throw、正常 Agent 三种 E2E。

### P1-6 W2 承诺服务端 PNG 导出，但现有可复用引擎没有 Node PNG 能力

tasks 明确要求 daemon 进程内排钻/校验/SVG/BOM/PNG（`tasks.md:13`）。engine 公共 barrel 导出 SVG/BOM，但没有 PNG（`rhinestone-studio/src/lib/engine/index.ts:84-109`）；现有 PNG renderer 在 `rhinestone-studio/src/lib/designer/pngRender.ts:72-100` 使用 `document.createElement('canvas')`、`Image`、IndexedDB `assetStore` 与浏览器 sprite 状态，不是 daemon 可直接调用的纯 TS 引擎函数。`workspace` exports 能让 daemon 消费 engine，不会把浏览器 renderer 自动变成 Node renderer。

**可验证修复：**在 Node 可用的渲染实现与明确的资产输入/shape 解析依赖上做决策；或者将 PNG 明确留作浏览器端导出并调整“重活服务端化”的范围。要求从 Node 进程（无 `document`、IndexedDB、浏览器全局）导出真实 fixture，检查像素/尺寸和错误分支，不能用仅导入 barrel 的 smoke test 代替。

### P1-7 短会话清理与分享结果/blob 引用生命周期没有定义

tasks 要求“下载结果→清空会话”（`tasks.md:19`），Owner 裁决将短会话和可激进回收作为存储前提（`proposal.md:35`），但 spec 只定义 blob 引用归零回收和 `public_id` 分享包（`spec.md:27`），没有 clear/delete endpoint、清理触发点、任务帧 jsonl 的位置/TTL、分享包是否在清会话后保留或撤销、失败重试与并发下载的次序。zhumo 的真实实现只是 ref_count 归零时删 blob（`.../daemon/src/db/blobs.ts:82-100`），任务帧放在任务目录的 `frames.jsonl`（`.../daemon/src/tasks/service.ts:488-497`）；这不是短会话策略。

**可验证修复：**冻结 clear 的原子语义和留存矩阵（任务行、对话帧、上传/生成资源、下载 bundle、公开 result/public_id 哪些删/留及多久），规定撤销 result 时如何释放资源引用。做删除/失败恢复/共享 blob/分享链接并发访问测试；清理后可证明无悬空引用，保留的分享结果仍可下载。

### P1-8 “可破坏格式演进”与“无损往返”验收口径冲突

design 明确称四族格式可任意演进且“不做严格往返兼容测试”（`design.md:69`），而 spec MUST 要求 `.gemproj/.gemdoc/.gemtpl/.gemgen` 与 server resource 无损导入导出往返（`spec.md:27`）。Owner 取消的是跨版本兼容红线，并不等于本版本导入后丢字段也可接受；当前两份文档对本 change 的验收互斥。

**可验证修复：**明确“不承诺旧版本格式向后兼容”，同时把当前版本的语义无损往返保留为 MUST（不要求字节相等），并以四种格式 fixture 验证 server resource 转换不丢字段/资产引用/顺序/工程参数；若不做该测试，就应从 spec 删除无损往返 MUST 并说明当前支持边界。

## zhumo 映射表逐行核验

| `design.md §2` 映射面 | 源码核验 | 评审结论 |
|---|---|---|
| monorepo | zhumo 有三包 workspace（`shufa-server/pnpm-workspace.yaml:1-4`）；contracts 用 workspace source exports（`contracts/package.json:8-10`）。本仓 engine barrel 为 `src/lib/engine/index.ts`，内部只走相对模块和已声明的 `zod`、`d3-delaunay`、`ts-pattern` 运行依赖（`rhinestone-studio/package.json:14-18`）。 | **可行，需 smoke gate。**本仓当前 package/lock 都在 `rhinestone-studio/`，无 repo-root workspace；W1 应冻结 workspace glob、根 lockfile/脚本及 `rhinestone-studio` 包名，daemon 以 `workspace:*` 依赖其 `./engine` subpath。用 daemon 的 `tsx` 真正 import `rhinestone-studio/engine` 并调用 `layout`/`exportSvg`，验证打包运行，不只做 typecheck。引擎零搬家可成立；PNG 是上面的 P1。
| 运行 | zhumo 有 `tsx` 启动、127.0.0.1 默认 host、dist 静态托管和 SPA 回退。 | **模式成立、目标不一致。**只复制运行模式；首发平台按 P1-1 收敛为 darwin-arm64。webui dist 入库还需在克隆即跑门禁里验证 stale/missing dist 与重建流程。
| 账户 | zhumo 有匿名行、JWT、owner 校验、禁写不禁读、管理员账户/管理 RPC；其产品默认匿名值与本 change 的默认开关相反。 | **变体成立、路径缺口。**默认匿名开是已裁决的贴钻变体；spec 的“管理员账户创建后”与 design 的“admin 可后建”没有定义从匿名首启到管理员凭据的唯一流程（`.env ADMIN_*`、一次性 setup 或本地命令）。冻结一种流程与失去/轮换凭据语义，避免多账户预留只存在于 role enum。
| 密钥 | zhumo 确实实现 `.env` 缺失创建 0600、保留注释/行序的原位更新和 settings 读写（`daemon/src/config.ts:78-106`、`rpc.ts:390-406`）。 | **模式成立。**贴钻 IMG/LLM 键族变体合理；需保持设置写入口/读面密钥脱敏一致，并决定隐藏 BYOK 后配置只走 `.env` 还是还有管理设置页。
| DB | zhumo `schema.ts:19-92` 实际创建 users/settings/**wizard_steps**/blobs/resources/tasks/results 七张表；表头注释也列七张（`schema.ts:2-7`），并非映射表所写六张。本 change 去掉 wizard_steps 可作为产品变体。 | **部分成立。**应写“复用六个核心表模式，省略向导表”，不是称照抄 zhumo 六表。短会话清理/公开分享留存见 P1-7。
| RPC | zhumo 实际使用 `@orpc/client` + `RPCLink` + 同源 `/ws/rpc?token=`，Svelte API façade 将 contracts 映射到 UI 类型（`webui/src/lib/api.ts:476-486,586-599`）。 | **可行，不是 drop-in。**本仓已有 Svelte5，接合技术上成立；当前 App/实验室仍直接 `fetch` BYOK 服务、持有 localStorage/IndexedDB 状态，需明确新 Agent UI 的 API facade 和旧工作台保留路径，不应声称“只加客户端层”就已完成迁移。pivot 后不必迁移旧三工作台，但要阻止默认主面继续依赖本地模型密钥。
| 长任务 | zhumo `afterSeq`/JSONL/live 订阅实际围绕 agent task session 帧实现（`daemon/src/tasks/service.ts:460-479,488-497`）。 | **可复用存储/传输，不可直接泛化语义。**生成/排钻 job 的进度、取消、终态和 Agent transcript/approval 帧须在 contracts 区分；共用同一 `Frame` 不等于共用同一状态机。
| Agent | zhumo 将 DSH SDK 内嵌，确有 daemon 生命周期挂载和异常捕获（`PRODUCT_DESIGN.md:13-18`、`daemon/src/kernel/boot.ts:191-205`）。 | **有真实参照但 fallback 不可照抄。**挂载 catch 只证明 daemon 存活，不能证明 W2 作业可用；具体问题见 P1-5。
| 原子工具 | zhumo 有 Zod capability registry、authority 和 Python 子进程管线；贴钻改进程内 TS 直调是合理变体。 | **机制存在、审批语义不匹配。**TS 可直接调用纯引擎；approved-mutation 与 MCP 主体冲突见 P1-3，工具参数/排布主线未冻结见 P1-4。
| MCP | zhumo 有 loopback streamable HTTP/Bearer 端点（`daemon/src/index.ts:103-111`、`http.ts:269-280`）。 | **大体成立，名称需修正。**zhumo 在 daemon 启动时生成一次 token 并在每次请求复用，实际是进程周期 token，不是一次性请求 token；本 change 应写清轮换/泄露/loopback 安全边界。
| 静态托管 | zhumo 有 SPA index fallback、`/r/{public_id}`、Range 与路径 containment；本 change 对应同类 SPA/分享包服务。 | **可照模式实现。**贴钻需明确导出 bundle 的资源引用闭包与分享撤销语义（P1-7）。
| GPU | zhumo 无对应层，这是本 change 新增抽象。 | **不是照抄项。**当前 `ComputeProvider` 示意签名全同步（`design.md:62`），而远程 submit/status/result/cancel 都可能等待网络；若保留未来租赁 API 作为设计目标，应冻结异步、失败/取消与幂等语义，或删去“同一接口接入 GPU 池”的承诺。此项不阻塞首版 Inline，可作为 P2 收口。

## W3 旧 UI 与测试面

pivot 已正确把默认产品导航转向 Agent，并把旧三工作台限定为开发者旗标入口（`proposal.md:20-23`、`spec.md:46-51`）；这符合 Owner 定调。但“不维护旧 UI”不应被实现成默认跳过其算法与状态测试。

本仓 Vitest 仍按 `src/**/*.test.ts` 收集（`rhinestone-studio/vite.config.ts:17-20`），不受 `localStorage` 开关影响；已有 `app.globalImport.test.ts` 会 mount `App` 并断言 gemproj/gemdoc/gemtpl/gemgen 导入导航到旧工作台（`:2-8,11-19,296-338`），另有大量引擎、资产和旧工作台单测。因此 tasks 的“工作台测试随旗标默认隐藏调整加载面”（`tasks.md:20`）不是可执行的测试策略。

**建议冻结的测试分类：**

- 默认无 flag：必须验证进入 Agent 主面、三工作台导航隐藏、Agent API/会话状态正确。
- 显式启用开发者 flag：保留一条可访问性冒烟；旧工作台 UI-only 测试列出明确保留/退役清单，不因默认隐藏自动 skip。
- 引擎、持久化/格式、能力 Zod schema、patch/export gate 测试继续作为必跑门；用户选择“算法沉淀到 capability”后，新增能力调用测试覆盖被 Agent 消费的核心算法路径。
- 对 App 级格式导入测试，冻结新路由：旧文档是否在 flag 下打开、否则是否只可导入/存储/下载；不能留在“零改动或以后更新”的二选一。

## 逐维度评价

| 维度 | 评分 | 依据 |
|---|---:|---|
| 四件套内部一致性 | 4.5/10 | Agent pivot 已落到四份文档，但平台、格式兼容与 W3/W4 依赖仍反向冲突。 |
| 单一实现契约/可分发性 | 4.0/10 | session、approval、capability 参数、短会话清理与 PNG 后端能力均未闭合。 |
| zhumo 真源映射准确性 | 7.0/10 | workspace、oRPC-WS、`.env`、JSONL、MCP、静态托管大多有真源码；表数、审批、token 和 dsh 降级语义存在变形。 |
| 护栏与存储生命周期 | 4.5/10 | 密钥服务端化方向明确；数据回收与公开分享的共同生命周期未定义。 |
| W1-W5 依赖/并行性 | 4.5/10 | W1/W2 可独立推进；W3 UI 可 mock 并行，但 W3 Agent MVP 必须等 W4，当前无明确集成 gate。 |
| 产品差异化落地 | 6.0/10 | Agent 优先 pivot 清晰，密度/结构控制被点名；工具输入与区域语义还停在口号级。 |

**综合 5.4/10（NEEDS-WORK）**：方向和 zhumo 的多数基础设施选择有实源支撑；扣分集中在会改变实现边界的互斥裁决、Agent 主旅程缺少可共享协议、批准变更安全模型以及短会话数据保留。先修 P1-1 至 P1-8，再按冻结契约进入实施；严格 OpenSpec 校验通过不能替代这些决策。
