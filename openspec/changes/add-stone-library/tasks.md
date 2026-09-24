# Tasks: 装饰钻库

> 决策源：Owner 补充定调三 + design.md。阶段 S0→S1→S2/S3/S4/S6 并行、S5/S7 随后；每波实现走 remix 评审闭环。与内核 change（add-subject-sam-pipeline）的依赖关系逐条标注——本 change 不反向依赖内核（P0-P2 可并行推进）。

## S0 契约冻结（先行，零实现依赖）

- [ ] S0.1 contracts `stones.ts`：StoneFile/SkuParsed/SupplierSkuProfile/CardCatalogDraft/StoneGridCell/StonePick/SubstituteQuery/CloudCatalogEntry Zod schema + `parseSku` 纯函数（bands 三行段+稀疏行容忍——design §1.3/§2/§7）——双端单测（round-trip+坏输入 typed error+parseSku 'J51'→2mm / 'J76'→12mm 行段漂移实证用例）
- [ ] S0.2 contracts：ΔE CIE76 纯函数（labFromRgb/deltaE——engine `color.ts` 同源算法复制）+ **双端一致测试**（与 engine color.ts 同值断言，锁死不漂移）
- [ ] S0.3 adapter 契约冻结（design §9 三签名：specOfStone/paletteColorOfStone/resolveStoneTexture）+ 纯函数实现与单测（含 gemshapeRef 两分支）——**接口交付，内核消费归 P 任务**（依赖标注：add-subject-sam-pipeline P3.1 策略设计器「钻规格表」消费本条契约=硬前置）

## S1 daemon stone 服务（资产面）

- [ ] S1.1 SQLite 迁移 v5：stone_index 投影表（design §1.5）+ 迁移测试；**投影可重建验证**（resources+blob 全量重建=逐行等价）
- [ ] S1.2 `daemon/src/stones/service.ts` 深模块：系统根/供应商目录幂等 seed（meta.role）+ 原子目录四步同事务建（目录+stone.json+贴图+blob）+ 字段 patch（revision CAS）+ 同父唯一名 ` (2)` + path 派生——纯数据面单测
- [ ] S1.3 贴图六条 gate（design §1.4：实测宽高/上限/alpha bounds 非空/fit 比例/分辨率下限/typed error）——逐条坏输入用例
- [ ] S1.4 软删/硬删/引用保护：trashedAt 递归软删+blob ref_count GC+引用 missing 四态（resolved/soft-deleted/blob-missing/wrong-kind）——四态测试照 gemcatalog 面 7 先例
- [ ] S1.5 stone_index 同事务维护：create/update/重指/软删/恢复五路径写后即查一致性测试

## S2 样卡导入器（AI 帮人录入）

- [ ] S2.1 CardCatalogDraft 校验入口+钰航 fixture（card-text.txt 三行段实证数据落 fixture）
- [ ] S2.2 切格+去背景首版：bboxPx 切图→白底阈值 alpha+≤2px 羽化→gate 校验→贴图.png；失败 cell 报告（design §7）
- [ ] S2.3 批量建原子：按草表 styles→款式行目录→SKU 原子树（design §1.2 目录布局）；幂等重跑（supplier×sku 跳过）；部分失败=成功保留+失败清单
- [ ] S2.4 低置信项处理：confidence<0.7/空名→`待命名-<row>` 兜底+proposal 预览显式列出
- [ ] S2.5 导入报告：网格前后对照+逐行 成功/跳过/失败（人看图双轨留存）

## S3 后台资源管理器（admin 面）

- [ ] S3.1 RPC 端点：stones.tree/list/get（design §4.1 filter/groupBy/分页协议）——service 单真源，MCP 复用
- [ ] S3.2 HTTP 贴图端点 `GET /api/stones/{id}/texture.png`（+views/{name}）：auth 作用域+ETag=hash+containment——沿 /r/{id}/files 发送面纪律
- [ ] S3.3 rhinestone-studio「装饰钻库」管理视图（开发者/管理员旗标）：树导航+样卡式网格（StoneGridCell 协议）+详情 RightSheet+回收站+导入向导入口（消费 S2 链）
- [ ] S3.4 E2E：导入→网格可见→筛选（色系/尺寸/供应商/关键字）→详情→软删/恢复

## S4 MCP 工具面（capability + 授权桥）

- [ ] S4.1 `capability/stones.ts` 八工具注册（design §6 表：list/search/get/substitutes=readonly；create/update/delete/import=approved-mutation）——readonly 面单测（owner/审计链沿 requireAgentTask 形态）
- [ ] S4.2 写工具接授权桥：proposal diff 预览（preview_json：N 新原子/分组/低置信项）→人工批准→grant→执行（op_digest+baseRevision CAS+TTL 全沿 authorization.ts 既有机制，零新授权语义）——无授权直调必拒/漂移必拒/重放必拒测试（W4.2 测试面复用）
- [ ] S4.3 import proposal 批量语义：单 proposal 整批+result_ref 报告+幂等重跑收敛
- [ ] S4.4 MCP 投影冒烟：mcp__studio__stone_* 八工具 schema-faithful 直传+readonly 真调

## S5 前台钻表选择器（依赖 S3.1 协议）

- [ ] S5.1 选择器组件：按色排板（family→款式行→尺寸变体）/按尺寸排板（sizeMm→色阵）/搜索（SKU/色名/十六进制）——StonePick 产出契约（design §5）
- [ ] S5.2 ΔE 邻近推荐：nearColor 参数+服务端排序返回；贴图渲染（textureUrl→resolveStoneTexture 消费；预览底色非纯白）
- [ ] S5.3 组件测试+视觉走查（vision 子代理判读，黑图防线前置）——**依赖标注：add-subject-sam-pipeline P3.2 策略层参数面板消费本组件**

## S6 缺钻替代查询

- [ ] S6.1 `stone.substitutes`：库内 ΔE+尺寸容差过滤+加权排序（默认 maxDeltaE=10/sizeToleranceMm=0.5 可参）——确定性排序测试
- [ ] S6.2 SS 云数据参考位：CloudCatalogEntry 消费接口（sizeMm↔SS 直径换算+缺 rgb 降级提示；输出标注「云数据参考，非库存承诺」）——云数据建设不在本 change

## S7 收尾

- [ ] S7.1 全链 E2E 冒烟（design §10：样卡 fixture→草表→import→网格→选择器→substitutes）
- [ ] S7.2 全量绿门（contracts+daemon+rhinestone-studio 三包）+偏离清单回报；spec delta 同步（openspec sync-specs）

## 依赖关系总表（与 add-subject-sam-pipeline）

| 本 change | 内核消费点 | 性质 |
|---|---|---|
| S0.1/S0.3 schema+adapter 契约 | P3.1 策略设计器「钻规格表」输入 | 硬前置（内核开工前 S0 须冻结） |
| S5 选择器组件 | P3.2 策略层参数面板 | 组件供给（P3.2 可先 mock 协议开发） |
| S6.2 云数据 schema 位 | 补充定调二「通用钻表」任务 | 接口预留（数据建设另立） |
| （反向） | 本 change 任何阶段 | **不依赖内核**（P0-P2 并行不阻塞） |

## 验收门

- 钰航样卡 fixture 全链导入：7 尺寸×有效行 SKU 原子落树（含 76/78 行 12-25mm band 漂移），网格/选择器/substitutes 可用
- 引擎零改动收据（git diff engine 零行）；本地 IDB 素材库零改动（stone 单一真源=daemon）
- AI 录入闭环：MCP 无授权写必拒；import proposal→批准→落库→报告全链留痕
- 三包绿门基线不变
