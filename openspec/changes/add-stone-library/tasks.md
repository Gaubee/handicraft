# Tasks: 装饰钻库

> 决策源：Owner 补充定调三 + design.md。阶段 S0→S1→S2/S3/S4/S6 并行、S5 随后；S7 组合层=第二优先级（标准层 S0-S6 之后）；每波实现走 remix 评审闭环。与内核 change（add-subject-sam-pipeline）的依赖关系逐条标注——本 change 不反向依赖内核（P0-P2 可并行推进）。

## S0 契约冻结（先行，零实现依赖）

- [x] S0.1 contracts `stones.ts`：StoneFile/SkuParsed/SupplierSkuProfile/CardCatalogDraft/StoneGridCell/StonePick/SubstituteQuery/CloudCatalogEntry Zod schema + `parseSku` 纯函数（bands 三行段+稀疏行容忍——design §1.3/§2/§8）——双端单测（round-trip+坏输入 typed error+parseSku 'J51'→2mm / 'J76'→12mm 行段漂移实证用例）
- [x] S0.2 contracts：ΔE CIE76 纯函数（labFromRgb/deltaE——engine `color.ts` 同源算法复制）+ **双端一致测试**（与 engine color.ts 同值断言，锁死不漂移）
- [x] S0.3 adapter 契约冻结（design §10 三签名：specOfStone/paletteColorOfStone/resolveStoneTexture）+ 纯函数实现与单测（含 gemshapeRef 两分支）——**接口交付，内核消费归 P 任务**（依赖标注：add-subject-sam-pipeline P3.1 策略设计器「钻规格表」消费本条契约=硬前置）

## S1 daemon stone 服务（资产面）

- [x] S1.1 SQLite 迁移 v5：stone_index 投影表（design §1.5）+ 迁移测试；**投影可重建验证**（resources+blob 全量重建=逐行等价）
- [x] S1.2 `daemon/src/stones/service.ts` 深模块：系统根/供应商目录幂等 seed（meta.role）+ 原子目录四步同事务建（目录+stone.json+贴图+blob）+ 字段 patch（revision CAS）+ 同父唯一名 ` (2)` + path 派生——纯数据面单测
- [x] S1.3 贴图六条 gate（design §1.4：实测宽高/上限/alpha bounds 非空/fit 比例/分辨率下限/typed error）——逐条坏输入用例
- [x] S1.4 软删/硬删/引用保护：trashedAt 递归软删+blob ref_count GC+引用 missing 四态（resolved/soft-deleted/blob-missing/wrong-kind）——四态测试照 gemcatalog 面 7 先例
- [x] S1.5 stone_index 同事务维护：create/update/重指/软删/恢复五路径写后即查一致性测试

## S2 样卡导入器（AI 帮人录入）

- [x] S2.1 CardCatalogDraft 校验入口+钰航 fixture（card-text.txt 三行段实证数据落 fixture）
- [x] S2.2 切格+去背景首版：bboxPx 切图→白底阈值 alpha+≤2px 羽化→gate 校验→贴图.png；失败 cell 报告（design §8）
- [x] S2.3 批量建原子：按草表 styles→款式行目录→SKU 原子树（design §1.2 目录布局）；幂等重跑（supplier×sku 跳过）；部分失败=成功保留+失败清单
- [x] S2.4 低置信项处理：confidence<0.7/空名→`待命名-<row>` 兜底+proposal 预览显式列出
- [x] S2.5 导入报告：网格前后对照+逐行 成功/跳过/失败（人看图双轨留存）

## S3 后台资源管理器（admin 面）

- [x] S3.1 RPC 端点：stones.tree/list/get（design §4.1 filter/groupBy/分页协议）——service 单真源，MCP 复用
- [x] S3.2 HTTP 贴图端点 `GET /api/stones/{id}/texture.png`（+views/{name}）：auth 作用域+ETag=hash+containment——沿 /r/{id}/files 发送面纪律
- [x] S3.3 rhinestone-studio「装饰钻库」管理视图（开发者/管理员旗标）：树导航+样卡式网格（StoneGridCell 协议）+详情 RightSheet+回收站+导入向导入口（消费 S2 链）
- [ ] S3.4 E2E：导入→网格可见→筛选（色系/尺寸/供应商/关键字）→详情→软删/恢复

## S4 MCP 工具面（capability + 授权桥）

- [x] S4.1 `capability/stones.ts` 八工具注册（design §6 表：list/search/get/substitutes=readonly；create/update/delete/import=approved-mutation）——readonly 面单测（owner/审计链沿 requireAgentTask 形态）
- [x] S4.2 写工具接授权桥：proposal diff 预览（preview_json：N 新原子/分组/低置信项）→人工批准→grant→执行（op_digest+baseRevision CAS+TTL 全沿 authorization.ts 既有机制，零新授权语义）——无授权直调必拒/漂移必拒/重放必拒测试（W4.2 测试面复用）
- [x] S4.3 import proposal 批量语义：单 proposal 整批+result_ref 报告+幂等重跑收敛
- [x] S4.4 MCP 投影冒烟：mcp__studio__stone_* 八工具 schema-faithful 直传+readonly 真调

## S5 前台钻表选择器（依赖 S3.1 协议）

- [ ] S5.1 选择器组件：按色排板（family→款式行→尺寸变体）/按尺寸排板（sizeMm→色阵）/搜索（SKU/色名/十六进制）——StonePick 产出契约（design §5）
- [ ] S5.2 ΔE 邻近推荐：nearColor 参数+服务端排序返回；贴图渲染（textureUrl→resolveStoneTexture 消费；预览底色非纯白）
- [ ] S5.3 组件测试+视觉走查（vision 子代理判读，黑图防线前置）——**依赖标注：add-subject-sam-pipeline P3.2 策略层参数面板消费本组件**

## S6 缺钻替代查询

- [x] S6.1 `stone.substitutes`：库内 ΔE+尺寸容差过滤+加权排序（默认 maxDeltaE=10/sizeToleranceMm=0.5 可参）——确定性排序测试
- [x] S6.2 SS 云数据参考位：CloudCatalogEntry 消费接口（sizeMm↔SS 直径换算+缺 rgb 降级提示；输出标注「云数据参考，非库存承诺」）——云数据建设不在本 change

## S7 生产组合层与仓储管理工作台（两步走第二步·第二优先级——标准层 S0-S6 之后）

> 决策源：Owner 补充定调四（两步走）+ 定调五（仓储管理工作台）。人机分工：组合定义的可视化管理主体是人（定调五「这一步 AI 很难去做到」）；AI 辅助面=MCP set.* 与 BOM 反推。

- [x] S7.1 contracts：ProductionSetFileSchema（design §7.1：引用集成员/origin 三来源/metadata）+ 限定名解析规则（`<标准ID>/<SKU>` 展示投影，服务端回填 standardId/qualifiedSku）——引用集不变量测试（标准更新跟随零同步/成员缺失显式态不自动剔除/clone 浅拷贝仍指标准原子/编号冲突两标准同 SKU 可区分）
- [x] S7.2 daemon set service：production-sets/ 根 seed（meta.role）+ set.json CRUD（revision CAS/软删同 §1.6 语义）+ 成员读时解析（missing 四态标注+限定名回填）——不建投影表（design §7.2）
- [x] S7.3 MCP `set.*` 五工具：list/get=readonly；create/update/delete=approved-mutation 走授权桥（权限分级同 stone.*，design §7.5）——写面授权测试复用 W4.2 用例族
- [x] S7.3a sets RPC 六端点（S7.4 工作台硬前置——design §7.4 人工直发写面）：`sets.list/get/create/update/delete`（owner 隔离 D-1+revision CAS+成员读时解析投影）+ `sets.createFromBom` 接口位 typed 冻结拒（501，S7.6 同码）——测试：协议/owner 隔离（B 看不到 A）/成员解析投影/CAS
- [ ] S7.4 **仓储管理工作台 UI**（第三产品工作台，与 Agent 主面/设计师工作台并列——design §7.6）：标准平铺区（多标准纵向分组流+段内筛选+虚拟滚动+StoneGridCell 复用）→点选/框选（marquee）→添加/删除到当前集合→集合侧栏（贴图墙+限定名+数量/备注编辑+汇总+缺失警示）→存为组合（manual-pick）/改既有组合（成员增删 CAS）
- [ ] S7.5 前台选择器组合投影接线：策略设计器调色板=「从仓储管理工作台定义的组合中选」（活跃组合+全标准兜底；design §5/§7.5）
- [x] S7.6 BOM 反推接口位（**依赖内核，执行链不在本 change**）：StonePick.resourceId 作 BOM 聚合溯源列预留（与 specKey×colorId 并列）+ `set.createFromBom({sourceTaskId})` proposal 位冻结——内核 P3 排钻产物带 stone 溯源落地后启用
- [ ] S7.7 工作台视觉走查（vision 子代理判读，黑图防线前置）：平铺/框选/侧栏交互原型供 Owner 拍板布局定稿（design §12-10 开放问题）

## S8 收尾

- [ ] S8.1 全链 E2E 冒烟（design §11：样卡 fixture→草表→import→网格→选择器→substitutes；组合链=工作台双标准同编号 fixture→框选/点选建组合→限定名区分→组合投影→标准贴图更新后组合跟随→缺失态呈现）
- [ ] S8.2 全量绿门（contracts+daemon+rhinestone-studio 三包）+偏离清单回报；spec delta 同步（openspec sync-specs）

## 依赖关系总表（与 add-subject-sam-pipeline）

| 本 change | 内核消费点 | 性质 |
|---|---|---|
| S0.1/S0.3 schema+adapter 契约 | P3.1 策略设计器「钻规格表」输入 | 硬前置（内核开工前 S0 须冻结） |
| S5 选择器组件 / S7.5 组合投影 | P3.2 策略层参数面板 | 组件供给（P3.2 可先 mock 协议开发） |
| S7.6 BOM 反推溯源列+createFromBom 位 | P3 排钻产物/导出 BOM 带 stone 溯源 | 接口位冻结先行；**执行链=内核硬依赖**（其未落地则来源②不可用，人工挑拣/clone 先行） |
| S6.2 云数据 schema 位 | 补充定调二「通用钻表」任务 | 接口预留（数据建设另立） |
| （反向） | 本 change 任何阶段 | **不依赖内核**（P0-P2 并行不阻塞；S7 仅 S7.6 接口位冻结不依赖内核实现） |

## 验收门

- 钰航样卡 fixture 全链导入：7 尺寸×有效行 SKU 原子落树（含 76/78 行 12-25mm band 漂移），网格/选择器/substitutes 可用
- **仓储管理工作台可用**：多标准平铺→框选/点选→建组合；双标准同编号（如 yuhang/J51 vs factoryB/J51）限定名可区分；组合引用集跟随（改标准贴图→组合视图自动更新，零同步机制）
- 引擎零改动收据（git diff engine 零行）；本地 IDB 素材库零改动（stone 单一真源=daemon）
- AI 录入闭环：MCP 无授权写必拒（stone.* 与 set.* 同规）；import proposal→批准→落库→报告全链留痕
- 三包绿门基线不变

## 评审 backlog（subagent-review-s2-s4.md P2 登记项——随后续波次顺带收编，本波不修）

- put-in-tx 回滚物理 blob 孤儿：事务中途崩溃窗口内 DB 行回滚而磁盘文件留存（报告 blob 可重建，低危）——归运维对账清扫面（启动物理-vs-DB 对账）。
- §8.1 规则 3 先于幂等检查的报告噪声：同字节组中已入库格 rerun 报 `pending` 而非 `skipped`（库内行不受影响，仅报告措辞误导）。
- 导入报告/预览 blob 无 GC 面：`blobs.put` 不挂 resources 行，引用只在 result_ref/调用方——量大会累积，与孤儿项一并归运维对账面。
- 执行模式 payload 反序列化无二次 schema 校验：digest 防篡改+propose 期已过 schema 兜底，风险低——可加 safeParse 防御纵深（create/update/delete/import 同理）。
- `previewCardImport` 漏判同页重叠：结构级可判却不判，newCount 可能高估（执行期才降级失败）——预览补重叠判定或 note 明示。
- studio.generate 双模外层 `z.union` 无 MCP inputSchema 投影：与 stones 面 ZodObject 手法对齐可带 schema——动 studio 既有面，归 S3 波次一起。
