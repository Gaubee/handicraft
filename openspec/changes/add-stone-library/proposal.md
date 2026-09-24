# Proposal: 装饰钻库（Decorative Stone 独立管理体系）

## Why

**Owner 2026-09-24 补充定调三**（原话冻结于 `../add-subject-sam-pipeline/owner-directive-20260924.md`）：

> 这个水钻的管理，你需要独立地去设计一套管理体系，包括它的接口（当然，我希望最好仍然使用素材库的这种文件文件夹管理方案）。以及他到时候怎么在后台（后台的资源管理器要能够去展示）和前台去展示。进一步的，我希望这些接口能对接到 MCP，后续我们就可以让 AI 直接帮助人去做录入或者修改这些管理工作。

> 客户转发的是"Decorative Stone / 装饰钻"……和 Swarovski / Preciosa SS 水钻不是同一种标准体系。从样卡本身可以确定：1. 尺寸直接用毫米表示 2. J/A/B/C/E/F/G 是尺寸对应的型号前缀 3. 后面的数字是颜色/款式编号。本质是一个"尺寸 × 颜色的国产供应商 SKU 编码体系"。之前建的 SS+Shape+Cut+Color+Effect 模型可能太理想了，只能当成云数据。真正客观的数据其实就是颜色跟尺寸，专注于这两个，其他的当扩展元数据管理。一个可贴的原子={贴图（去掉背景只留主体部分）、尺寸、颜色、其它元数据}，字段自由扩展，没有定数据库，存 JSON 就好。

样卡事实（钰航，PDF 文本已提取：`experiments/stone-catalog-20260924/card-text.txt`，两页）：7 前缀=7 尺寸档，行号 51-89=颜色款式——**且前缀→mm 映射按行段漂移**（行 51-75/80-89：J2/A3/B4/C5/E6/F8/G10mm；行 76/78：J12/A14/B16/C18/E20/F22/G25mm；行 77/79 样卡缺席）——「尺寸 × 颜色 SKU」体系，编码档案必须可配且按行段分段。

现状缺口：装饰钻在平台内**零承载**——resources 表只认四族格式+gemshape（`daemon/src/formats.ts`），capability 十工具无任何钻库面（`daemon/src/capability/studio.ts`），前台无钻表选择器；既有 `add-gem-catalog-and-sizes` 的 SS 目录按 Owner 裁决**降级为云数据参考**（引擎 `.gemshape` 渲染形状定义不受影响——见 design §2.4 关系澄清）。

## What Changes

1. **stone 原子与文件夹方案**（沿用素材库虚拟文件系统模式）：每颗钻=一个「原子目录」——`stone.json`（Zod：核心字段冻结 + `metadata: Record<string,unknown>` 自由扩展）+ `贴图.png`（去背景留主体，alpha 规范复用 `.gemshape` 六条 gate 纪律）+ 可选 `views/` 多视图照片。落位 daemon `resources` 表（复用 W2 资产面：parent_id 树/owner/revision CAS/blobs sha256 内容寻址），目录树推荐 `stones/供应商/色系/款式行/SKU 原子`。
2. **SKU 编码解析器**：`SupplierSkuProfile`（前缀→mm 映射表**按行段 bands 可配**，钰航实证同前缀跨行段映射不同 mm）+ `parseSku` 纯函数；供应商档案存目录行 meta，stone.json 内物化直值（快照哲学，目录漂移不影响已入库钻）。
3. **后台资源管理器**：新 `stone_index` 投影表（SQLite 迁移 v5，筛选列，同事务维护可重建）+ 资源浏览 API（树/列表/筛选：色系/尺寸/供应商/关键字）+ 样卡式网格视图数据协议。
4. **前台展示**：钻表选择器（策略设计器/参数面板消费——按色排板/按尺寸排板/搜索/ΔE 邻近推荐）+ 透明底 PNG 渲染规范（auth 作用域贴图端点，引擎 resolveAsset 消费）。
5. **MCP 工具面**（capability 三分类，与 W4.2 授权桥一致）：`stone.list/search/get/substitutes`=readonly（agent 直调）；`stone.create/update/delete/import`=approved-mutation（AI 录入走 proposal→人工批准→授权桥——定调三「AI 帮人录入」直接落地）。样卡导入链：上传样卡图→vision 切格取色草表（`card-catalog-draft.json`，schema 本 change 冻结）→ `stone.import` 批量建原子（proposal diff 预览+幂等重跑）。
6. **缺钻替代查询**：`stone.substitutes`——库内 ΔE（CIE76，引擎 color.ts 同源）+ 尺寸容差规则；SS 通用钻表降级为云数据参考（跨体系换算接口位）。
7. **引擎接口（只定接口不做实现）**：`specOfStone`（sizeMm→diameterMm）/`paletteColorOfStone`（颜色→色板条目）/`resolveStoneTexture`（贴图→渲染源）三个 adapter 纯函数契约；实现消费归 `add-subject-sam-pipeline` P 任务。**引擎零改动红线沿用**。

## Impact

- **contracts**：新 `stones.ts`（StoneFile/SkuProfile/CardCatalogDraft/SubstituteQuery schema 族 + parseSku）——Zod 双端单测。
- **daemon**：SQLite 迁移 v5（`stone_index` 投影表）；新 `stones.ts` 服务（树/校验 gate/引用保护/GC）；`capability/stones.ts`（八工具）；http 贴图读取端点（auth 作用域）；样卡导入器（切格+去背景首版）。
- **rhinestone-studio**：后台「装饰钻库」资源管理视图（daemon API 消费）+ 前台钻表选择器组件；本地 IDB 素材库**不承载 stone**（单一真源=daemon，防双写漂移）。
- **引擎**：零改动（收据门沿用）；全部消费经 adapter 层。
- **依赖**：`add-subject-sam-pipeline` P3.1（策略设计器钻规格表）消费本 change S0 契约；P3.2（参数面板）消费 S5 选择器；本 change 不反向依赖内核 change（P0-P2 并行不阻塞）。

## 非目标

- 排布/贴钻策略本体（`add-subject-sam-pipeline` 所有）。
- SS 水钻云数据目录的建设与维护（云数据参考 schema 位冻结即可，数据建设另立）。
- 库存/采购/供应链管理（进 `metadata` 自由扩展，不做一等字段）。
- 去背景算法产品化（首版=样卡白底阈值 alpha + 羽化；复杂背景人工/后续工具）。
- 本地 IDB 素材库与 daemon stone 库的同步机制（不做，单一真源）。
