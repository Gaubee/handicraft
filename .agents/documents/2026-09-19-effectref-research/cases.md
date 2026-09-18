# 效果参考案例调查报告（EffectRef Research）

日期：2026-09-19 | 产出：`rhinestone-studio/src/lib/presets/effectRefs.ts`（整体覆盖占位版）+ `public/presets/` 14 张图片资产
状态：完成。调查方法：WebSearch 定位品牌站 → Shopify `products.json` 端点取结构化数据（标题/描述/图片清单）→ curl 下载 CDN 原图 → sips 压缩（长边 ≤800px、单张 ≤150KB）。

```
资产总览（public/presets/，共 8 案例 14 图）
────────────────────────────────────────────
本仓对照样本（3 对，印刷稿 src → 贴钻成品 mockup res）
├ new-orleans-{src,res}.jpg   样本 01
├ savannah-{src,res}.jpg      样本 02
└ boston-{src,res}.jpg        样本 03
网络真实产品案例（2 对 + 3 单图）
├ wreath-border-res.jpg       Diamond Dotz·Christmas Wreath（单图）
├ angel-dress-{src,res}.jpg   Diamond Dotz·Joy to the World（成对）
├ hummingbird-bloom-{src,res}.jpg  Diamond Dotz·Hummingbird Shadow Box（成对）
├ bear-plane-{src,res}.jpg    Diamond Dotz·Aero Bear（成对，src 抽自官方对比图）
└ greeting-card-res.jpg       Heartful Diamonds·圣诞贺卡套装（单图）
```

---

## 1. 案例明细

### 1.1 本仓样本三组（ground truth）

- **来源**：工作区 `01/02/03-{src,res}.jpg`（"Christmas in" 城市系列贴钻套装，印刷稿→贴钻成品 mockup）。tech-research.md §1 已有视觉子代理实证：同一套「元素级二元掩码 + 全域恒定密度六方密排」分层公式。
- **prompt 依据**：完全取自 §1 实证结论（边框花环逐元素 / 大字贴小字不贴 / 英雄按部件填色 / 线性骨架 1-2 钻宽成链 / 光源只贴发光部 / 氛围层永不贴 / 5-6 色收敛）。三份 prompt 共享该实证公式，但按「主导元素」分三条差异化路线（见 §2），**未逐图指定具体城市元素**——研究文档未按样本逐图记录元素分布，凭空指定即编造。

### 1.2 Diamond Dotz（diamonddotz.com，Shopify 站）

品牌背景：局部贴钻（partial coverage）品类的头部品牌，产品数据经 `/products/<handle>.json` 端点获取（含官方描述与图片清单）。以下 4 例**页面描述均明示 Coverage: Partial / partial coverage**。

| id | 产品页 | 成对 | 图片依据 |
|---|---|---|---|
| wreath-border | https://www.diamonddotz.com/products/christmas-wreath-diamond-painting-kit | 否 | `DD2.037_Simulation.jpg`（钻后仿真渲染，1572×1600） |
| angel-dress | https://www.diamonddotz.com/products/joy-to-the-world | 是 | src=`DD5.088_Mockup.jpg`、res=`DD5.088_Simulation.jpg` |
| hummingbird-bloom | https://www.diamonddotz.com/products/hummingbird-shadow-box | 是 | src=`DD30.011_Mockup.jpg`、res=`DD30.011_Dotted_Model.jpg` |
| bear-plane | https://www.diamonddotz.com/products/aero-bear-diamond-painting-kit | 是 | src=官方对比图上半幅（见 1.4）、res=`DD5.030_Simulation.jpg` |

**页面描述摘录（prompt 的事实基础）**：

- **Christmas Wreath**："traditional green wreath accented with glittering ornaments and a bold red bow … With Partial coverage and radiant Dotz" → 花环边框路线：环带逐元素（浆果/装饰球/叶片）、大红蝴蝶结、环心镂空。
- **Joy to the World**："a graceful angel in a flowing red dress … shimmering DOTZ gems bring warmth, light, and a touch of magic … Coverage: Partial, Round, 12.6\"x12.6\", 2,952 DOTZ" → 单人物路线：礼服大色块、翼/光环按「光」处理；**页面描述未提画面里有文字**，prompt 不写文字规则（不编造）。
- **Hummingbird Shadow Box**："a dazzling rainbow-hued hummingbird in mid-flight among bright garden blooms against a soft golden background … round drills on precision color-printed MDF panels … layered 3D shadow box" → 动物羽色分区路线 + 花朵逐瓣 + 背景金色留印。
- **Aero Bear**："an adventurous little bear piloting a propeller plane through a sunny sky. This partial coverage design uses round Dotz to highlight playful details like goggles, banners, and flying friends" → 英雄主体+稀疏点缀路线（描述原文即「用钻点亮趣味细节」）。

### 1.3 Heartful Diamonds（heartfuldiamonds.com，Shopify 站）

- **greeting-card**：https://heartfuldiamonds.com/products/new-diamond-painting-christmas-greeting-card-set
- 成对：否（`HK101-8PCS.png` 为 8 款贺卡套装网格图，1080×1080）。
- 描述摘录："Each card features a festive scene — jolly Santas, twinkling trees, cozy snowmen, and sparkling reindeer — pre-printed and ready for you to fill in with shimmering resin diamonds … keepsakes"。→ 贺卡小件路线：预印场景+钻填、小尺寸强对比简形。注意：该页未标注 partial/full，prompt 只引用「pre-printed + fill in」这一可证事实。

### 1.4 图片状态分类的依据与不确定性（诚实声明）

1. **Mockup / Simulation / Dotted_Model 的语义**按 Diamond Dotz 文件命名约定推定：`Simulation`=钻后仿真渲染（res），`Mockup`=设计/产品展示稿（src 候选），`Dotted_Model`=钻后实物模型（res）。**未做视觉判读**（依据任务纪律：不凭空编造图片内容；视觉判读须走 vision 子代理，本次未启用）。
2. 曾尝试程序化验证（Laplacian 方差 + 亮点局部极值计数区分钻面/印刷面），对渲染类图片**判别力不足**，弃用其结论。
3. **bear-plane 的 src** 取自官方 `comps_*.png` 对比图：程序化检测到 y≈720-756 处全宽白色分隔带（上下两幅），上幅与 Simulation 的颜色直方图相关系数 0.959、下幅 0.989 → 判定上幅为未钻画稿、下幅为钻后状态；上幅裁出作 src。此为结构+统计证据，非视觉判读。
4. wreath 的 `comps` 图经同法检测为多面板拼图（仅右下面板与设计稿相关 0.92，其余为场景照），**无干净画稿面板**，故 wreath 与 greeting-card 走 `srcImage: ''` 单图模式。

---

## 2. 八份 prompt 的差异化定位

公共硬约束收敛为 `RHINESTONE_COMMON_RULES` 常量（元素级二元决策 / 氛围层剔除 / 5-6 色闭合纯色形状 / 统一粒径六方密排 / 细于 1 钻径放弃 / 白或透明背景），各 prompt 仅写「风格路线」增量：

| id | 路线一句话 | 差异点 |
|---|---|---|
| new-orleans | 城市分层·全要素 | 五层全保留：边框花环＋大字＋英雄＋骨架链＋点光，最重的完整公式 |
| savannah | 城市分层·骨架主角 | 减层：单英雄大色场主导＋线性骨架链引导视线，明确「无边框无散饰」 |
| boston | 城市分层·字光主角 | 排版主导：超大标题实铺＋光源只贴发光部＋场景压两色调剪影 |
| wreath-border | 花环边框·浆果环带 | 环形构图：逐颗浆果/微簇＋蝴蝶结双场＋环心环外留印 |
| angel-dress | 人物主体·礼服大色块 | 单人物：礼服两层色阶＋翼/光环发光剪影＋脸部禁贴 |
| hummingbird-bloom | 动物主体·羽色分区 | 按羽毛天然分区逐片填色＋花瓣逐瓣闭合＋喙枝骨架链 |
| bear-plane | 英雄主体·细节点缀 | 大主体分件＋趣味细节独立小钻簇（3-10 颗）＋天空全留印 |
| greeting-card | 贺卡小件·强对比简形 | 小尺寸专法：≤6 大简形＋最强对比＋粗字单色铺钻/细字留印，色数降至 4-5 |

差异化设计原则：**主体类型学**（场景/人物/动物/机器/文字/边框纹样）×**层级策略**（全要素/减层/排版主导）×**尺度**（挂画/贺卡）三轴正交，覆盖用户照片的主要品类；调色板建议各不相同但全部落在 4-6 色。

## 3. 执行困难与解决方式

| 困难 | 解决 |
|---|---|
| WebSearch 结果多为对比文章而非产品页图片 | 直接走品牌站 Shopify `products.json` 结构化端点，批量取官方图与描述 |
| Craft Buddy（Crystal Art Cards，贺卡品类原定首选）三域名 TLS/网络不可达 | 改用 Heartful Diamonds 圣诞贺卡套装（同品类，可达且数据结构化） |
| Diamond Dotz 产品页 HTML 由 JS 渲染，curl 抓不到商品图 | 改用 `/products/<handle>.json` 端点（图片清单+描述一次拿全） |
| 全覆盖（full drill）产品会污染案例池 | 逐条核对描述中 Coverage 字样；Gilded Snowy Owl、Howling at the Moon（均为 full）已剔除 |
| 部分案例无画稿原图 | 按接口约定 `srcImage: ''` 单图模式（UI 已支持）；bear-plane 从官方对比图程序化裁出画稿补成对 |
| 原图 >150KB（PNG 高保真） | sips 转 JPEG + 质量参数 38-60 分档压到 ≤150KB，PIL verify 全量校验无损坏 |
| 版权 | 全部为品牌产品页公开 CDN 图，仅内部工具静态展示；每条 sourceNote 记录产品页 URL |

## 4. 验证记录

- `ls -la public/presets/`：14 张，全部长边 ≤800px、≤150KB（最大 angel-dress-src 108KB），PIL verify 通过。
- `pnpm run check`（svelte-check）：**0 errors, 0 warnings**。裸 `npx tsc --noEmit` 有 8 条与本次无关的既有 barrel-file 噪音（svelte 模块导出解析），无一条涉及 effectRefs.ts。
- 未跑全量测试、未起 dev server（任务边界约定）。
