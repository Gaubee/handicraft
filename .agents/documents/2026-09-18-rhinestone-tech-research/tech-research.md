# 局部贴钻智能排布工具：技术研究报告（v2）

日期：2026-09-18 | 状态：v2 定稿（v1 同日早稿已被本版取代：修正 gpt-image-2.5 事实核正，并入视觉子代理实证结论——实证导致架构重心从"密度场采样"迁移到"元素级掩码 + 六方网格 + 骨架化"）

在线验证截至 2026-09-18，关键主张均附来源；无法验证处逐条标注。

---

## 0. 执行摘要（一屏结论）

1. **空缺确认**：现有工具全部是"照片 → 全贴钻/拼豆格子"（MakeBead、StitchMate、PixelMade AI 等）或"矢量路径 → 钻位填充"（Silhouette Studio Rhinestone 工具、Hotfix Era、TRW）。**没有任何产品做"图片 → 哪里值得贴钻"的审美决策层**（多路英文搜索确认，含 2026 年新出现的 PixelMade AI 也是全贴钻方向）。差异化窗口真实存在。
2. **实证结论重塑架构**：3 组实拍样本显示真实作品的排布是"**元素级二元掩码 + 全域恒定密度（统一六方密排）**"，不是连续密度场。因此 weighted Voronoi stippling（Secord 2002）、capacity-constrained Voronoi、变径 Poisson disk 等"密度场采样"算法族**从主链路降级为可选风格模块**（仅 Decorative 自由散点场景保留）。主力几何变为：**全局六方定距网格 + 掩码采点 + 骨架化链排 + 最小特征过滤**——全部确定性算法，纯 TS 可实现，无 ML 依赖。
3. **AI 只做一件事：意图层**。"哪里贴"是低带宽决策（几十个区域 × 贴/不贴 × 类型标签），"钻放哪"是高带宽几何（数千坐标）。推荐 **SAM2 分区 + VLM 打标（结构化 JSON）** 为主链路；**gpt-image-2.5 直接生成"贴钻层 PNG"不可行**（颗粒粒径/位置/密度不可控、与原图不对齐），但可作为"意图涂色 mask 提议器"（已验证其 API 原生支持透明背景、mask、最多 16 张参考图，约 $0.04–0.10/张）——用法降级，不是路线废弃，需 1 天实验验证涂色服从性。
4. **MVP 两步走**：Phase 1 = 人工圈选 + 类型标签 → 一键排钻辅助器（位图版 Silhouette Rhinestone 面板，2–4 周，纯 TS）；Phase 2 = SAM2 + VLM / gpt-image 意图涂色做"一键初稿"，用户在 Phase 1 编辑器微调。不训练任何自有模型。
5. **避开三件事**：a) 全贴钻 pattern generator 红海；b) dithering 颜色还原（3–5mm 钻距不产生人眼混色，且实证样本调色板收敛 5–6 色无混色迹象）；c) 把生成模型的 PNG 当钻位数据源。

---

## 1. 样本实证（引用视觉子代理结论，3 组 "Christmas in" 城市系列对照样本）

### 1.1 实证要点

- **同一套分层混合公式**，而非单一范式：边框花环（Decorative，逐元素：浆果 1 钻、花瓣 1 钻 + 金花心）→ 城市名大字（Object 密排，副标题小字不贴）→ 英雄主体（Object 按部件填色，钻色跟随毛色/车身）→ 线性骨架：树枝/栏杆/尖塔/细管乐器（Outline：骨架化后 1–2 钻宽成链，宽度 > 3 钻径转填充）→ 光源高光（Highlight：只贴发光部不贴支撑结构）→ 氛围层（天空/雪/路面/远景/人物，**永不贴**）。
- **几何**：统一粒径圆钻、**六方密排（错行半距）**、行向水平全局一致、无大小混用、无 AB 钻。
- **密度全域恒定**（同间距，无渐变）——"密度感"来自贴/不贴的面元选择，而非钻距变化。
- **收边**：钻被形状边界直接裁断（无半钻），保留印刷描边作轮廓缓冲；细于 1 钻径的特征整段放弃。
- **白色高光斑在掩码中挖洞让位给印刷**；调色板收敛 5–6 色（红、金/琥珀、象牙白珍珠、橄榄绿、黑/炭）。
- 局限：跨样本存在少量规则例外（卷草纹一图贴一图不贴）；样本疑似 AI 生成 mockup 而非实物照片，材质细节不可判。

### 1.2 实证 → 架构的直接映射（本报告核心依据）

| 实证结论 | 架构决策 |
|---|---|
| 元素级二元掩码 + 优先级表 > 像素级密度场 | `DesignIntent = Region[]`（mask + 类型 + 贴/不贴 + 优先级），**主链路无连续密度场** |
| 密度恒定、统一间距 | 主排布 = 全局六方定距网格，密度场算法降级为 Decorative 可选模块 |
| 线性骨架 1–2 钻宽成链，宽 > 3 钻径转填充 | 需要骨架化（细化）算法 + 宽度检测分支 |
| 细于 1 钻径整段放弃、无半钻 | 最小特征过滤规则（形态学开运算 + 面积/宽度阈值） |
| 白色高光挖洞、印刷描边作缓冲 | 掩码后处理：高亮区挖洞 + 边界内缩 |
| 5–6 色收敛、区域填色 | 颜色映射 = 区域级取色 → 调色板收敛（k=5..8）→ Lab 最近邻，**无 dithering** |
| 大字贴小字不贴、按部件填色 | 需要元素类型学（RegionType enum）与 OCR 文字检测 |

---

## 2. 技术盘点

### 2.1 排点算法族：被实证结论降级为可选

这族算法解决"给定密度场 ρ(x,y)，生成点集使局部密度 ∝ ρ"。它曾是"图片→点画"的主流，但实证显示局部贴钻的密度是**常数**，密度感由面元选择表达——于是它们的角色从"主角"变为"特定风格的可选模块"：

| 算法 | 机制 | 在本项目中的新定位 |
|---|---|---|
| Weighted Voronoi Stippling（[Secord, NPAR 2002](https://www.cs.ubc.ca/labs/imager/tr/2002/secord2002b/secord.2002b.pdf)；可运行复现：[Observable Voronoi Stippling](https://observablehq.com/@mbostock/voronoi-stippling)、[jtompuri/weighted-voronoi-stippling](https://github.com/jtompuri/weighted-voronoi-stippling)） | Lloyd 迭代把点移向 Voronoi 胞元的密度加权质心 | **可选**。仅当未来想做"密度渐变"高阶风格（实证样本中不存在）时启用；TS 可用 `d3-delaunay` 实现 |
| Capacity-constrained Voronoi / OT blue noise（Balzer & Heck 2008；de Goes et al. SIGGRAPH 2012，未在线复核） | 容量约束均匀分配，蓝噪声质量更好 | 不做。收益边际，实现重 |
| Fast Poisson Disk Sampling（Bridson SIGGRAPH 2007，标准算法） | 最小距离拒绝采样 O(n)，天然满足"间距硬约束" | **保留为 Decorative 散点模块**（浆果丛、雪点等自由排布装饰），npm `poisson-disk-sampling` 现成，或 ~100 行 TS 自实现 |
| Floyd–Steinberg / ordered dithering | 误差扩散颜色量化 | **排除**。属全贴钻/拼豆范式（每格一钻重建整幅图才有意义）；3–5mm 钻距无混色效果，只会脏斑（详见 §3.2） |
| Structure-aware halftoning（Pang et al. SIGGRAPH 2008，未在线复核） | 沿结构线抖动 | 思想已被"骨架化链排"吸收，无需引入 |
| **六方网格采样（本方案主力）** | pitch 固定的 hex lattice，掩码内保留格位 | 解析、确定性、可逆（钻↔格位，天然支持编辑与撤销）、钻数可 O(1) 估算成本。数学：最近邻距 p，行距 p·√3/2，面密度 2/(√3·p²)，覆盖率上限 πd²/(2√3·p²) |

**六方网格关键数字**（SS10，d=2.8mm，p=3.2mm）：行距 2.77mm，密度 ≈ 11.3 颗/cm²，覆盖率 ≈ 70%，100cm² 掩码 ≈ 1130 颗——钻数与成本在排钻前即可解析估算。

**骨架化（Outline/linear 范式的关键算法）**：Zhang-Suen / Guo-Hall 细化。注意 **opencv.js 默认构建不含 ximgproc（thinning）**（[GitHub issue, 2025-08](https://github.com/opencv/opencv-js/issues) 已确认；自编译带 contrib 的 WASM 可行但成本高）。推荐：TS 自实现 Zhang-Suen（~100 行，迭代形态学，足够）或 [LingDong-/skeletonization-js](https://github.com/LingDong-/skeletonization-js)。骨架 → 图结构（链/分叉）→ 等弧长（=pitch）取点 → 法向偏移 ±p/2 得 2 钻宽；局部宽度测量（距离变换均值）> 3 钻径则切回 hexFill 分支——这条"宽度阈值分支"直接来自实证。

### 2.2 意图层（哪里贴）可组合的现成组件

| 组件 | 作用 | 现状（2026-09 验证） |
|---|---|---|
| SAM 2 | 元素级分区（everything mode 出 20–50 个 mask） | [github.com/facebookresearch/sam2](https://github.com/facebookresearch/sam2)，**Apache-2.0**，2024-07 发布，图像+视频。浏览器可跑：Transformers.js + onnxruntime-web（WebGPU 有数值正确性 issue 报告，需 WASM 回退，[社区实证](https://lucasgelfond.online)） |
| rembg / U²-Net / IS-Net | 主体抠图（hero vs 背景第一刀） | rembg MIT、U2Net Apache-2.0（[github.com/danielgatis/rembg](https://github.com/danielgatis/rembg)）；浏览器端可参照 `@imgly/background-removal`（onnxruntime-web 路线，v1 已验证，本次未复核） |
| Grounding DINO | 文本提示开放词汇检测（"wreath / street lamp / horse / text"） | [github.com/IDEA-Research/GroundingDINO](https://github.com/idea-research/groundingdino) Apache-2.0（ECCV 2024）；有官方 [Grounded-Segment-Anything](https://github.com/idea-research/grounded-segment-anything) 组合范式。MVP 可省（VLM 已能识别这些概念），做区域先验时再上 |
| OCR（PaddleOCR PP-OCR / tesseract.js） | 文字区检测（"大字贴、小字避让"规则需要字号/位置信息） | PaddleOCR det 模型有 ONNX 导出（onnxruntime-web 兼容性细节未验证）；tesseract.js 纯 JS 可行但装饰字体召回率未验证 |
| VLM（GPT/Claude/Gemini 视觉） | 审美决策：逐区输出 {类型, 贴/不贴, 填充策略, 材质, 优先级} JSON | 无现成"贴钻审美"模型——**这正是空白与壁垒**。规避其空间精度弱的方式：只让 VLM 在 SAM 给出的候选区域上做选择与参数化，不让它输出坐标 |
| 经典 saliency（OpenCV spectral residual / U²-Net 显著性） | 无 AI 时的启发式基线、交叉验证 | spectral residual 在 opencv_contrib 中，opencv.js 默认不含（未验证可编译入）；U²-Net ONNX 可用 |
| 审美评分（HPS v2 / LAION aesthetic，未在线复核） | 离线 rank 多稿候选 | Phase 3 再考虑，不进主链路 |

**组合结论**：意图层 = SAM2 出结构（精确 mask）+ VLM 出语义审美（离散档位 JSON，zod 校验）+ 规则层出硬约束（OCR 避让、最小面积、高光挖洞）。与 §1 实证的"元素级二元掩码 + 优先级表"完全对齐。

### 2.3 同类工具生态

**全贴钻 pattern generator（闭源 web 服务）**：MakeBead（[makebead.com](https://makebead.com)，DMC 匹配 + 符号图）、StitchMate（[stitchmate.app](https://stitchmate.app)）、Tiamond、StitchFiddle（可导出 .oxs）、Dotterly（iOS）。技术栈均为缩放 → 颜色量化 → DMC 匹配 → 每格一钻（含 Floyd–Steinberg）。**PixelMade AI**（[pixelmade.ai](https://www.pixelmade.ai)，2026-06 上线）是目前最接近"AI"的：照片转钻色 + "保护人脸/关键细节"编辑 + 履约 API，但仍是**全贴钻**范式——它验证了市场付费意愿，同时确认无人做 partial drill 审美层。

**开源相近物（可读代码）**：拼豆/十字绣社区成熟：`cornelk/beadmachine`（Go，调色板映射）、`real-jiakai/perler-studio`（纯浏览器）、`LunarXuan/Pindo`（本地优先）、`Jett-Wu/Perler_Beads_Generator`（图层数 + 用量统计）、`Chipdelmal/PixArt-Beads`（Python）、`hank/perler-bead-map`（用量计算）、`kohsuke/dmc-cross-stitch`（DMC 匹配）（均见 [github.com/topics/perler-beads](https://github.com/topics/perler-beads)）。**共同点：全部解决"格 → 珠/钻"，无一解决"哪些地方值得成为钻位"。**

**商业贴钻软件（行为可从教程推断）**：**Silhouette Studio** 的 Rhinestone 工具（Designer Edition 以上，[silhouetteschoolblog.com](https://www.silhouetteschoolblog.com)）作用于矢量路径：Edge/Linear/Radial 填充 + 间距/SS 参数，输出可切割孔位圆——这是几何引擎的直接对标物，但只吃矢量、不吃照片、无审美判断。**Cricut Design Space 无原生 rhinestone 功能**（需从 Silhouette 导出 SVG 中转，[教程生态](https://thecountrychiccottage.net)）。**Hotfix Era**（[sierra-software.com](https://www.sierra-software.com)）是专业烫钻排版事实标准；TRW（[therhinestoneworld.com](https://therhinestoneworld.com)）同场竞品（对比见 [rhinster.com](https://rhinster.com) 2026 综述）。PictoRhinestone（图 → 模板 SVG，$4.99/张，v1 已验证本次未复核）是"整图转钻"收费先例。

### 2.4 "AI + 贴钻布局"先行者

多路搜索（AI rhinestone layout / AI gem placement / diamond painting AI）**未发现任何严肃软件产品**：仅 NightCafe 风格画（画"贴钻风"图案，非排布）、TikTok 消费级"AI 给照片加钻"贴纸玩具、手工教程（domesticheights.com 的 image → template 圆点技巧）。硬件方向（贴钻机视觉定位）有宣传内容，可靠性低（未验证）。**结论：软件空白成立（截至 2026-09，基于英文搜索）。**

---

## 3. 生产约束体系

### 3.1 SS 钻尺寸与间距

SS→mm 非线性，永远查表（来源：[Fire Mountain Gems](https://www.firemountaingems.com)、Crystal Ninja、BeCreateful、Rhinestone Guy，各品牌有 ±0.1–0.2mm 出入）：

| SS | 直径 mm | | SS | 直径 mm |
|---|---|---|---|---|
| SS6 | ~2.0 | | SS16 | ~4.0 |
| SS8 | ~2.4 | | SS20 | 4.7–5.0 |
| SS10 | ~2.8 | | SS30 | ~6.4 |
| SS12 | ~3.0 | | SS34 | ~7.0–7.2 |

**间距（已验证的行业实践）**：密排填充石间空隙约 **0.5–1mm**（转移膜可干净拾取的下限，[从业者讨论](https://www.facebook.com/groups/blingallthethings/posts/4408654852728574)）；预算型散布 ~6mm（1/4 英寸）仍有闪感（[rhinestonesetc.com](https://www.rhinestonesetc.com)）；进阶"双尺寸 gap-fill"技法：SS20 打底 + SS6/SS5 补隙做超密效果（[blingyourthings.com](https://blingyourthings.com)、[crystalparade.co.uk](https://www.crystalparade.co.uk)）——数据模型需预留多 SS 共存，但 MVP 不做。用量估算可用 [Rhinestone Guy 计算器](https://www.rhinestoneguy.com)思路按面积解析计算。

**推荐**：pitch = 钻径 + 0.4–0.8mm 可调（SS10 → p=3.2–3.6mm），以 3 组样本逆标定。实证为统一粒径 → MVP 只支持单一 SS 全局切换。方钻是全贴钻格子范式产物，局部贴花基本用圆钻，MVP 只做圆钻。

### 3.2 颜色体系与匹配

- 行业用 DMC 编号做钻色 lingua franca（约 447 色公开参考表）；hotfix 水钻实际供应商色卡通常 30–80 色 + 材质变体（AB 彩虹镀、透明冰、金属金银、珍珠）。**需把朋友的真实供应商色卡数字化为 Lab 表**（实物色卡校色拍照，一次性成本；厂商 RGB 参考值精度未验证）。
- 匹配：sRGB → Lab → **ΔE 最近邻**。社区标准做法是 CIELAB 距离（[XStitchify](https://xstitchify.com) 明确用 CIE76 ΔE；CIEDE2000 更准但 447 色规模下差异边际——两者都实现，成本极低）。
- **不做 dithering（强主张，实证支持）**：dithering 的前提是"点距 < 人眼分辨阈、靠混色重建连续色调"（全贴钻每格一钻成立）；局部贴钻点距 3–5mm、且实证样本调色板收敛 5–6 色、区域单色填充、无混色迹象。正确策略：**区域级取色**（掩码内中位色/主色）→ 全图调色板收敛（k=5..8 聚类，与实证 5–6 色一致）→ Lab NN 映射。Highlight 范式钻色可脱离原图（AB/透明/金），由意图层显式指定。
- 印刷色域与钻色域不重合（钻的 glitter/AB 无对应印刷色），预览渲染需特殊处理（见 Phase 3）。

### 3.3 工艺与交付物

**hotfix vs 冷贴（已验证）**：hotfix 背胶预涂，130–150°C 热压 10–20 秒/颗（或整版热压），适合织物（[Bluestreak Crystals](https://www.bluestreakcrystals.com/blogs/news/what-is-the-difference-between-hotfix-and-non-hotfix)）；冷贴（flatback + E6000 类胶）适合热敏感面/印刷品。局部贴钻在印刷图上两种都可能出现，交付物相同。具体热压参数随基材，需打样确认（未验证细节）。

**模板生产流**（教程生态验证）：分层 SVG（每 SS 一层，钻位为 circle 孔）→ 切割机切模板胶片/sticky flock → 刷钻入孔 → transfer tape 整版揭起 → 热压/点胶到承印物。

**成品交付物（引擎输出契约）**：① 分层 SVG（按 SS 分层、按颜色分组，可直接进 Silhouette/Cricut）；② 符号图 PDF（A4 平铺 + 图例，手工冷贴用）；③ 坐标表 CSV（x, y, ss, color, regionId——复算/质检用）；④ BOM（color × SS 计数 + 成本）；⑤ 预览渲染（叠加原图效果图）。

### 3.4 排钻硬约束清单（生产检查层输入）

1. 最小间距：任意两钻中心距 ≥ pitch（同径时即 ≥ d + gap）；跨径时 ≥ (d1+d2)/2 + gap；spatial hash 碰撞检测 O(n)
2. 网格对齐：六方密排、行向水平全局一致、错行半距（实证）；自由散布（Decorative）例外但需局部主轴沿区域走向
3. 模板切割极限：孔径 ≥ 切割机最小可切孔（Silhouette 档约 2mm，未验证）→ SS6 以下慎用；孔间"桥"宽 ≥ ~0.5mm 保模板强度
4. 最小特征：宽度 < 1 钻径的形状整段放弃（实证：不缩径、不放半钻）；连通块 < 3 钻的孤岛删除
5. 收边：中心点规则（格位中心在掩码内即保留 → 边界自然裁断，实证无半钻）；掩码相对印刷描边内缩半钻径作缓冲
6. 挖洞：指定高亮区（马脸白纹、积雪）在掩码中减去，让位印刷
7. 预算：总钻数 ≤ 用户预算 → 按优先级表抽稀（atmosphere 优先删，light 最后删）
8. 避让区：OCR 小字、人脸默认禁贴（可配置）

---

## 4. AI 路线评估

### 4.0 gpt-image-2.5 事实核正（v1 结论作废）

v1 报告称"gpt-image-2.5 未能验证为官方模型名"——**该结论已过时**。本次验证（2026-09-18）：OpenAI 于 **2026-09-08 发布 "ChatGPT Images 2.5"**（[openai.com/index/introducing-chatgpt-images-2-5](https://openai.com/index/introducing-chatgpt-images-2-5)），API 提供 **gpt-image-2.5-sunburst**（细节更精）与 **gpt-image-2.5-flare**（更快）两个变体。关键能力（[fal.ai API 文档](https://fal.ai/gpt-image-2.5)、[OpenAI API 指南](https://developers.openai.com/api/docs/guides/image-generation)）：

- **原生透明背景**：`background: 'transparent'` + PNG/WebP，真 alpha 通道（前代 gpt-image-2 于 2026-08 才以 preview 加入，2.5 为正式改进项）
- **edit 端点**：prompt + 最多 16 张参考图 + **可选 mask 限定改动区域**；声称"只改被要求的部分，主体/构图保持"
- 分辨率至 3840 长边（自定义宽高，16 倍数）；质量档 auto/low/medium/high/xhigh/max
- 价格：高质量约 **$0.036–0.10/张**（1024²  $0.0528；4K $0.1002），edit 略贵；图像输入 $8/M tokens

### 4.1 四条路线对比

| 路线 | 机制 | 可控性 | 审美上限 | 成本/图 | 判定 |
|---|---|---|---|---|---|
| R1 生成"钻层透明 PNG"→ CV 提取钻位 | gpt-image-2.5 edit + 参考图，生成仅钻层 PNG，连通域/Hough 圆检测反推钻位 | **差**：钻粒径无毫米语义（同一亮点画 1 颗或 5 颗随机）、密度随 prompt 漂移、与原图像素不对齐（需弹性配准）、alpha 毛边污染 | 高（构图感好） | 高（多次生成挑图） | **不做主链路**（用户的 MVP 捷径想法在此被否决，理由：误差链最长） |
| R2 生成"意图涂色 mask"（降级用法） | 让 gpt-image-2.5 输出低分辨率涂色图（贴钻区涂白/按类型分色，其余透明） | 中：生成模型被训练画图而非标注，涂色服从性**待实验**；但输出经 SAM 精分边界后可校正 | 中-高（空间连续性好、元素边界自然，VLM 逐区打标给不了这个） | 低（$0.04–0.10） | **备选主链路**，1 天实验定生死 |
| R3 纯 CV 规则 | saliency + 亮度 + 边缘 → 阈值掩码 | 好 | **低**：不懂语义（会给脸密铺、天空排钻），但零成本离线 | ~0 | 兜底基线 + 交叉验证 |
| R4 SAM2 分区 + VLM 打标 | SAM2 everything → 每区缩略图 + 上下文 → VLM 输出 zod 校验的 JSON（类型/贴否/策略/优先级） | **好**：离散档位 + 可解释 + 可编辑；VLM 空间弱由 SAM 补 | 中-高 | 低（SAM 本地 ~0 + VLM 1–2 次调用） | **主链路** |

### 4.2 结论：R4 为主，R2 做竞争性实验，R1 废弃，生成模型另做预览

核心洞察不变：**"哪里贴"是低带宽决策，"钻放哪"是高带宽几何**。让生成模型画钻（R1）= 用高带宽不可控信道传低带宽决策再花大力气逆向恢复——方向反了。但 R2 与 R4 不是二选一：R2 的涂色图给**空间连续的区域提议**，R4 的 SAM 给**精确边界**、VLM 给**语义类型**。混合编排（Phase 2）：

```
原图 ─→ SAM2 everything（候选 regions）
     ─→ gpt-image-2.5 意图涂色（低分辨率提议，可选）
     ─→ 涂色区 ∩ SAM regions → 精确边界
     ─→ VLM 逐区打标 {type, drill, fillStrategy, priority}
     ─→ 规则修正（OCR 避让/最小面积/高光挖洞/邻接合并）
     ─→ DesignIntent（与 Phase 1 人工圈选产物同构）
```

gpt-image 的第二用途：**成品效果预览渲染**（把真实钻位渲成营销图）；但自建 WebGL 各向异性高光渲染可能更快更真且数据来自真实 Gem[]，Phase 3 再选。

### 4.3 回答用户三个开放问题

- **a) 大量决策，机器学习够不够？** 够，但形态是"感知用现成模型（SAM2/DINO/OCR）+ 决策用 VLM 规则化输出 + 几何用确定性算法"。实证显示审美规则是**可枚举的分层公式**（类型 × 贴否 × 策略），决策空间小、可 zod 离散化——**无需训练任何自有模型**。
- **b) gpt-image-2.5 直接生成透明贴钻层可行吗？** 技术上能出图（透明背景已原生），**作为钻位数据源不可行**（粒径/位置/密度不可控）；降级为"意图涂色提议器"可行且便宜，服从性需 §6 的 1 天实验验证。
- **c) 已有开源可参考？** §2.3 清单：拼豆/十字绣生成器（算法参考：量化/调色板/用量统计）、Silhouette Rhinestone 工具（几何对标）、d3-delaunay / poisson-disk-sampling / skeletonization-js / transformers.js / rembg（组件级复用）。没有任何项目做了意图层——需自建，这是壁垒也是工作量主体。

---

## 5. 架构推荐

### 5.1 数据流（ASCII）

```
输入图 (jpg/png + mm/px 标定)
   │
   ▼
┌── 意图层（元素级二元决策，唯一 AI 层）──────────────────────┐
│ Phase 1（人工）：套索/魔棒/画笔圈选 + SAM 点选精修 + 类型标签 │
│ Phase 2（AI）  ：SAM2 everything 分区                        │
│                 (+ gpt-image-2.5 意图涂色提议, 可选)          │
│                 → VLM 逐区打标 {type, drill?, fill, priority} │
│ 规则后处理：OCR 文字区(大字贴/小字避让) / 人脸避让 /          │
│            最小面积过滤 / 白色高光挖洞 / 描边缓冲内缩         │
└──────────────┬─────────────────────────────────────────┘
               ▼  DesignIntent { regions[], grid, palette }
┌── 几何 Layout Engine（确定性，纯 TS）────────────────────────┐
│ 全局六方网格：pitch = SS查表 + gap，行向水平，错行半距        │
│ 按 (RegionType → FillStrategy) 用 ts-pattern 分派：          │
│   hexFill       ：格位中心 ∈ 掩码 → 保留（title/hero 部件）   │
│   skeletonChain ：Zhang-Suen 细化 → 链 → 等弧长(pitch)取点    │
│                   → 法向偏移±p/2 出 2 钻宽；局部宽度>3钻径    │
│                   自动切 hexFill（linear：树枝/栏杆/尖塔）    │
│   elementSingle ：连通域质心 → 单钻/微簇（wreath 浆果/花心）  │
│   sparseScatter ：Bridson Poisson（decorative 自由散点，可选）│
│ 后处理：孤岛删除(<3钻) / spatial hash 碰撞检查 / 预算抽稀     │
└──────────────┬─────────────────────────────────────────┘
               ▼  Gem[]（mm 坐标 + 六方格位索引）
┌── 颜色映射 ────────────────────────────────────────────────┐
│ 区域级取色(掩码中位色) → 全图调色板收敛(k=5..8) →            │
│ Lab ΔE(CIE76/CIEDE2000) 最近邻 → 供应商色卡（无 dithering）  │
└──────────────┬─────────────────────────────────────────┘
               ▼
┌── 生产检查 + 交付 ──────────────────────────────────────────┐
│ §3.4 硬约束逐条检查 + BOM(色×SS×数量×成本)                   │
│ 分层SVG(切割模板) / 符号图PDF / 坐标表CSV / 预览渲染          │
└──────────────┬─────────────────────────────────────────┘
               ▼
交互编辑（React 19/Svelte 5 + canvas）
掩码笔刷增减 / 改类型标签(重跑该区排钻) / 逐钻增删/锁定 /
撤销重做(格位可逆性使然) / 实时钻数与成本
```

### 5.2 数据模型（TS/zod 草案，类型学直接来自实证）

```ts
// ── 元素类型学（来自 3 组样本实证，非拍脑袋枚举）──
export const RegionType = z.enum([
  "wreath",     // 边框花环：逐元素（浆果1钻/花瓣1钻+金花心）→ elementSingle
  "title",      // 主标题大字 → hexFill 密排
  "subtitle",   // 副标题小字 → 默认不贴（规则保留位）
  "hero",       // 英雄主体：按部件填色，钻色跟随原图色 → hexFill
  "linear",     // 线性骨架（树枝/栏杆/尖塔/细管）→ skeletonChain
  "light",      // 光源高光（穹顶/亮窗/灯罩）：只贴发光部 → hexFill/sparse
  "decorative", // 重构装饰（点阵节奏/自由散布）→ sparseScatter
  "atmosphere", // 天空/雪/路面/远景/人物 → 永不贴（显式建模"不贴"）
]);
export const FillStrategy = z.enum([
  "hexFill", "skeletonChain", "elementSingle", "sparseScatter", "none",
]);
export const MATERIAL = z.enum(["standard", "ab", "clear", "gold", "pearl"]);
export const SS = z.enum(["SS6","SS8","SS10","SS12","SS16","SS20","SS30","SS34"]);

// ── 意图层 ──
export interface Region {
  id: string;
  type: z.infer<typeof RegionType>;
  fill: z.infer<typeof FillStrategy>;        // 通常由 type 默认分派，可覆写
  mask: { w: number; h: number; bits: Uint8Array };  // 低分辨率位掩码
  holes: string[];                           // 掩码内挖洞区 id（高光让位印刷）
  priority: number;                          // 冲突/预算抽稀次序（light 高，atmosphere 无）
  colorPolicy:
    | { kind: "sampleFromImage"; levels: 1 | 2 }   // 区域取色 1–2 阶（hero 部件）
    | { kind: "fixed"; colorId: string };          // 意图指定材质色（light → AB/金）
  material?: z.infer<typeof MATERIAL>;
  provenance: "manual" | "sam" | "vlm" | "gen";    // 决策来源（可解释/回溯）
}

export interface DesignIntent {
  version: string;
  imageRef: string;                          // 图 + mm/px 标定
  grid: { ss: z.infer<typeof SS>; pitchMm: number; rowAngle: 0 };  // 行向水平=0°（实证）
  regions: Region[];
  palette: { k: number };                    // 调色板收敛目标（默认 6）
  budget?: { maxGems: number };
}

// ── 几何产物 ──
export interface Gem {
  gx: number; gy: number;                    // 六方格位（i, 行 j；sparse 时为 -1）
  x: number; y: number;                      // mm 世界坐标
  ss: z.infer<typeof SS>; shape: "round";    // shape 预留扩展位
  material: z.infer<typeof MATERIAL>;
  colorId: string;                           // 供应商色卡 id
  regionId: string;                          // 溯源 → 可按区重排
  locked?: boolean;
}

export interface ProductionReport {
  counts: Array<{ colorId: string; ss: string; n: number }>;
  estCostUsd?: number;
  warnings: Array<{ kind: "spacing"|"minHole"|"bridge"|"island"|"avoid"; detail: string }>;
}
```

关键设计：**atmosphere 作为显式 Region 类型建模"永不贴"**（实证：氛围层的存在感来自不被贴）；`provenance` 字段记录每个决策来自人还是哪个模型（审计/回流）。

### 5.3 技术选型（TS 全栈对齐）

- 采样/几何：六方网格与等弧长重采样自实现（各 <150 行）；`poisson-disk-sampling`、`d3-delaunay`（可选模块）；Zhang-Suen 自实现或 [skeletonization-js](https://github.com/LingDong-/skeletonization-js)；marching squares 自实现（轮廓/边界内缩）
- 图像处理：Canvas/OffscreenCanvas；形态学开闭运算自实现（或 opencv-wasm——注意默认 opencv.js 无 ximgproc，§2.1）；色彩空间 `culori` 或自实现
- SAM2：浏览器 transformers.js + onnxruntime-web（WebGPU 数值 issue → WASM 回退）；模型过大则 Deno/Node `onnxruntime-node` 包服务。Python 只做模型导出工具链，不进运行时
- VLM/gpt-image-2.5：OpenAI-compatible API + zod 校验 + 重试；ts-pattern 做策略分派

---

## 6. MVP 路径

### Phase 0（1 天验证实验，先于一切编码）

以 01/02/03（Boston 系列）src/res 为 ground truth：

1. **GT 掩码提取**：res 疑似由 src 合成的 mockup（视觉子代理判断），对 src/res 做差分（局部方差/SSIM）粗提"钻区掩码"，人工修 20 分钟 → 元素级 GT。
2. **R2 实验**：gpt-image-2.5 sunburst edit（参考图 + prompt："输出涂色图，把值得贴钻的区域涂白，其余透明"），每图 10 次。测：与 GT 的 IoU 均值/方差。**通过标准：mean IoU ≥ 0.75 且钻区面积变异系数 < 30%，否则 R2 降为 R4 的辅助**。
3. **R4 实验**：SAM2 everything + GPT/Claude/Gemini 三家 VLM 逐区打标，测元素级决策一致率（贴/不贴 + 类型命中）。**通过标准：贴/不贴准确率 ≥ 85%**。
4. 产出：路线确认表 + VLM 供应商选择 + 失败案例分析（喂 prompt 迭代）。

### Phase 1（2–4 周）：人工圈选 + 类型标签 → 一键排钻（无 AI 依赖）

最小算法集：魔棒（flood fill + 容差）/ 套索 / 笔刷；Zhang-Suen 细化 + 链化 + 等弧长采样；六方网格填充（中心点规则）；最小特征过滤（开运算 + 宽度/面积阈值）；高光挖洞工具；Lab ΔE + 调色板收敛；spatial hash 碰撞；分层 SVG + 符号 PDF + CSV + BOM 导出。
验收：3 组样本图人工圈选后 5 分钟内产出可切割 SVG + BOM，与真实 res 的钻数差 < 25%、目视风格一致。
（产品等价于"位图版 Silhouette Rhinestone 面板"，已被市场验证的付费能力；同时为 Phase 2 积累编辑器与几何底座。）

### Phase 2（+2–4 周）：AI 意图层

Phase 0 选出的路线（R4 主，R2 视实验）接入，产出 DesignIntent 初稿 → 用户在 Phase 1 编辑器微调。每次生成 A/B 两稿供选择，偏好数据留存（未来 ranker 的数据资产）。

### Phase 3：材质语言与高阶能力

AB/透明/金属材质规则（透明钻下垫浅色印刷的"冰感"）；大钻锚点（SS20+ 特殊钻，Decorative 视觉锚）；花环/浆果参数化图案库；WebGL 各向异性高光成品预览（与 gpt-image 预览路线对比后择一）。

---

## 7. 风险与开放问题

**风险清单**：

1. **gpt-image-2.5 意图涂色服从性未验证**（被训练"画好看图"而非"做标注"）→ Phase 0 实验，失败则 R4 独扛，架构不变
2. **onnxruntime-web WebGPU 数值正确性**（SAM 已有 issue 报告）→ WASM 回退 + 服务端兜底；无 WebGPU 低端设备性能未验证
3. **opencv.js 无 ximgproc** → 已定自实现 Zhang-Suen 方案，规避自编译 WASM 的维护成本
4. **骨架化对掩码噪声敏感**（毛刺分叉）→ 细化前形态学闭运算 + 面积过滤；链短于 2 钻的分支删除
5. **样本疑似 AI mockup**（非实物），材质/反光细节不可判 → 请朋友提供实物照片或打样一轮校准 pitch/间距/色卡
6. **审美规则存在例外**（卷草纹跨样本不一致）→ 一切 AI 决策皆为可覆写初稿，人工是最终裁决（provenance 字段支持回溯）
7. **VLM 审美无 ground truth** → 档位离散化 + A/B 偏好数据长期积累
8. **供应商色卡数字化精度**（厂商 RGB 参考值 ≠ 实物）→ 实物色卡校色拍照一轮
9. **PictoRhinestone 等已在"图→模板"收费** → 差异化押注"局部审美增强 + 可编辑意图层"，不做整图转钻

**开放问题**：

1. 密度→观感定量标定（多少颗/cm²"闪而不腻"）：用 3 组样本逆拟合 pitch，需实物确认
2. 印刷底图与钻的视觉冲突（透明钻在浅底、四色叠印区）需实物实验
3. OCR 在装饰字体（Christmas 花体）上的召回率未验证；不行则退化为"用户点选文字区"
4. 多尺寸混排（SS20 锚点 + SS10 主体）的网格共存规则——实证样本未出现，Phase 3 设计
5. SAM2 商用许可：repo 标 Apache-2.0，落地前过一次法务确认（惯例动作）

---

## 附：验证状态说明

**本次在线验证（2026-09-18）**：Secord 2002 论文与复现资源；SAM2 仓库与 Apache-2.0；Transformers.js/onnxruntime-web 跑 SAM 的 WebGPU 数值 issue；opencv.js 不含 ximgproc（GitHub issue 2025-08）与 skeletonization-js 替代；rembg MIT / U2Net Apache-2.0；Grounding DINO Apache-2.0 与 Grounded-SAM 组合仓库；拼豆/十字绣开源 repo 族群；MakeBead/StitchFiddle/StitchMate/PixelMade AI/Tiamond/Dotterly 产品形态；Silhouette Rhinestone 工具（Designer Edition+）与 Cricut 无原生功能；Hotfix Era/TRW 商业格局；**gpt-image-2.5 官方存在性（2026-09-08 公告）与 API 细节（透明背景/mask/16 参考图/价格）**；SS 尺寸表（多来源）；密排 0.5–1mm 间隙、6mm 预算间距、SS20+SS6 双尺寸技法；hotfix 130–150°C/10–20s vs 冷贴；CIE76/CIEDE2000 社区实践（XStitchify）；"AI+贴钻布局"无先行者（多路搜索）。

**未验证（正文已逐条标注）**：gpt-image-2.5 意图涂色服从性（Phase 0 实验）；切割机最小孔径与孔桥强度；热压参数细节；PaddleOCR det 的 onnxruntime-web 兼容性；装饰字体 OCR 召回率；厂商 RGB 色卡精度；贴钻机 AI 视觉定位宣传。

**继承自 v1（同日早稿，本次未复核）**：PictoRhinestone 定价与形态、MightyScape/inkscape-silhouette、`@imgly/background-removal`、LISA/HPS v2/CLIP aesthetics 学术引用、Pang 2008/de Goes 2012 论文细节。
