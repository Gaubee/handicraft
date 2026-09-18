# 手动编辑模式设计文档（v1 讨论稿）

- 日期：2026-09-19（成文 2026-09-18）
- 作者：产品（PM 子代理）；讨论对象：Codex + 编排者；定稿后进 OpenSpec change
- 状态：**讨论稿**——§10 议题清单未裁决前，不作为实现依据

方法论出处（本文件按以下一手 skill 执行）：
- 需求定框：`~/.agents/references/design-skills/skills/product-discovery-and-framing/SKILL.md`
- 竞品调研：`~/.agents/references/design-skills/skills/competitive-intel/SKILL.md` + `references/guide.md`
- 交互行为结构（状态/撤销/控制权）：`~/.agents/references/design-skills/skills/interaction-design/SKILL.md`

证据分级标注约定：`[一手]` 官方文档/源码原文；`[二手]` 检索摘要/第三方评测（官网不可达时）；`[通识]` 通用设计范式（不附 URL）；`[假设]` 待验证推断（附最小验证方式）。

---

## 0. 决策框架（framing）

**决策句**：为「贴钻工作台」第三模块「手动编辑」裁定——(a) 在两段式管线中的定位与入口形态；(b) 图层与钻位数据模型；(c) 工具箱构成与引擎算法的工具化方式；(d) 与转化工作台的边界；(e) MVP 切分。截止：随本 change 进入 OpenSpec 迭代。

**问题框定**：贴钻设计师在使用「实验室→工作台」自动管线后，遇到引擎参数化无法表达的局部修正需求（AI 分块错色、语义边缘毛刺、艺术性增删改、局部重排），只能回到提示词反复重生成或放弃自动管线。Evidence: Owner 需求原话（用户一手）+ 工作台覆写体系止步于块级（源码 `studio.svelte.ts`：disabled/density/type/color 四种块级字典，无钻级操作）。

**非目标（本 change 明确不做）**：
- 不做多用户协作、不做人脸/照片直接转钻（那是实验室的事）
- 不做切割机/烫图机硬件对接（业内导出止步于 SVG 模板 + BOM，本产品同口径）
- 不改变工作台既有管线行为（护栏，回归零破坏）

---

## 1. 业内软件调研

### 1.1 贴钻专业软件

**Silhouette Studio（Rhinestone 面板，Designer Edition+）** `[一手]`
来源：Silhouette 官方学习站 <https://www.silhouette101.com/archives/rhinestone-conversion-tools-designer-edition-and-higher>（全文抓取 2026-09-18）。工作方式：

- 右侧 Rhinestone 面板，把图像/矢量转为贴钻图案；SS 尺寸 6ss/10ss/16ss/20ss
- 四种效果：**Edge**（沿所有线条边缘排钻）、**Linear Fill**（直线行填充）、**Radial Fill**（由外缘向内的同心圆环填充）、**Draw Rhinestones**（手绘：**单击放 1 颗，或按住拖动画出连续的一串钻**——即"笔刷"）
- 参数：Size（SS）与 Spacing（英寸，如 0.060"），**改动即时重排**
- 面板底部**实时计数器**：按 SS 尺寸统计选中对象或整个工作区的钻数
- **Release Rhinestones（释放）**：把参数化图案解散为可单独移动/删除/操作的独立部分——官方教程原话"once the rhinestone pattern is released it cannot be re-adjusted with the Rhinestone tools"（释放后不再受参数化工具控制）
- 转换后整体缩放图形，程序**自动重算钻位**（保持钻物理尺寸不变）

> 对本设计的关键启示：Silhouette 的模型是「**参数化生成 → 释放 → 单颗编辑**」两态切换，且释放不可逆；手绘笔刷（单击/拖线）是一等公民；实时计数内嵌在工具面板里。

**Hotfix Era（Sierra）** `[一手]`
来源：Sierra 官网产品页 <https://www.sierra-software.com/Sites/Products/HotfixEra/HotfixEra.aspx>（抓取 2026-09-18）。页面原文要点：

- 填充风格：uniform（均一）、**Concentric（同心/轮廓跟随）**、Flat、**Flexible**、Textures 等，属性可调且**自动重算**
- 造物方式：贝塞尔/圆弧节点数字化、免手数字化、**位图自动描摹**（内置矢量化）、矢量对象导入
- 图形编辑：节点/孔/曲线的增删移、缩放旋转，**形状改动后对象自动重新处理**
- **单颗编辑：改类型、移动、删除、添加单颗**（与参数化对象并存）
- **高亮重叠或间距过近的钻**，供人工清理
- 字库：预数字化字体 + TrueType
- 多视图同步：design map / sequence view / **elements list（元素列表）** / satellite / simulation
- 输出：乙烯/激光切割机模板 + 各品牌自动烫图机
- 分 Standard / Plus 两档

> 关键启示：单颗编辑与参数化对象**并存而非两态**；重叠/过近高亮 ≈ 本产品引擎 `validate` 的 spacing warning；Hotfix Era 用「元素列表」而非 PS 式自由图层树管理对象。

**TRW Design Wizard（原 Stone Wizard）** `[二手]`
来源：官网 <https://www.therhinestoneworld.com/trw-design-wizard-rhinestone-design-software>（直连 403，能力来自检索摘要与生态教程）。CorelDRAW/Illustrator 插件：Stone Fill / **Offset Fill（沿轮廓等距填充）** / Smart Fill / Split；自动调整多对象间距或增加钻数填满路径；**Multi-Dec（多尺寸混排）**；文字拱形；一键效果图（mockup）。

**Cricut 生态** `[二手]`
来源：Jennifer Maker 教程 <https://jennifermaker.com>（2023-03-24，直接在 Design Space 手工摆圆点）+ TRW 面向 Cricut 用户的教程 <https://www.therhinestoneworld.com>。**Design Space 原生无贴钻功能**，用户要么手工摆点（繁琐），要么用第三方软件生成 SVG 后导入。→ 本产品的「转化+精修+导出 SVG」链路在此生态是空白位。

### 1.2 相邻工艺图案编辑器

**十字绣（PCStitch / Stitch Fiddle）**
- Stitch Fiddle `[一手]`（官网 <https://www.stitchfiddle.com> + App Store 描述）：**支持钻石画（diamond painting）图案**；空白画布绘制或照片导入转换；**画/擦/泛滥填充**逐针编辑；**撤销近期更改**；回针缝合；多层编辑
- PCStitch `[二手]`（官网 <https://www.pcstitch.com> + 论坛 + 评测摘要）：全针/半针/特种针法工具、从图案取色的吸管工具、**多级撤销**、图层（评测称）、缩放、图像导入

**拼豆（Perler/Hama/Artkal）**
- StitchMate `[二手]`（<https://stitchmate.app>）：**笔刷/填充/直线/形状工具 + 无限撤销**，照片转图纸
- Beads Creator / Perlypop `[二手]`（Google Play / App Store）：像素风网格编辑、真实豆色板、图纸库

**数字油画（PBN）生成器** `[二手]`
- PBNify / Davencified / Mimi Panda（<https://www.davincified.com> 等）：生成器为主，编辑能力弱（点击定义色区后即出图）——**编辑深度反而是市场空缺**，本产品「生成后深度精修」有差异化空间。

**通用范式** `[通识]`：PS（图层/笔刷尺寸/选区三件套/历史面板）、Figma（布尔运算、对象树）、Procreate（笔刷+快速形状）。仅取交互语法，不取其自由度（见 §3.2 裁剪理由）。

### 1.3 归纳：工艺图案编辑器的能力光谱

```
          生成侧（参数化）                    编辑侧（直接操作）
 ◄──────────────────────────────────────────────────────────►
 Silhouette   Edge/Linear/Radial + 参数即时重排    Release→单颗移删
 Hotfix Era   填充风格 + 形状改动自动重算          单颗增删改+冲突高亮
 TRW          填充工具集(Corel)                    Corel 原生编辑
 Stitch Fiddle 照片→图纸                          逐格画/擦/灌充+撤销
 本产品现状   五策略+块级覆写+全局重算             ❌ 无（缺口即本模块）
```

**共同工具箱（跨 5 类软件收敛，全部具备≥4 项）**：
1. 网格笔刷（画/擦）+ 当前色绑色板
2. 区域填充（几何填充或泛滥填充）
3. 选区（点选/连通域/同色）
4. 撤销/重做（编辑器标配，无限或多级）
5. 实时计数（Silhouette 的 per-SS 计数、BOM 类）
6. 显示组织（图层或元素列表/显隐过滤）
7. 底图参考（照片/中间稿叠底）

**贴钻专业独有（相邻品类没有）**：
- 沿边/沿路径排钻（Edge、Offset Fill、骨架线填充）
- SS 尺寸 + 间距（pitch）参数化重排
- 多尺寸混排（Multi-Dec）
- 切割模板导出（孔位 SVG）

**对本产品的裁剪结论**：共同工具箱 1–7 = 本模块骨架；贴钻独有能力中「沿路径排钻」「策略化区域填充」恰好能把现有引擎算法工具化，形成与 Silhouette（固定 4 效果）差异化——**我们的"填充效果"就是五种排钻策略 + 松弛钩子，且可作用于任意局部区域**。

---

## 2. 定位与产品模型

### 2.1 管线位置（主线裁定）

```
┌──────────┐  handoff   ┌──────────┐  handoff'  ┌──────────┐
│ 提示词实验室 │ ────────▶ │ 转化工作台 │ ─────────▶ │ 手动编辑   │──▶ SVG/BOM 导出
│ (gpt-image │  中间稿    │ (分块+策略  │  钻面快照    │ (精修/再创作│
│  中间稿生成) │           │  参数化重算)│            │  直接操作)  │
└──────────┘           └──────────┘            └──────────┘
     真源=提示词            真源=参数               真源=Gem[]
```

**主线 = 精修/再创作层**（以工作台产物为起点的直接操作）；从零创作为 P1 辅线（空白画布）。理由：
- 产品现有价值链是「AI 中间稿→引擎转化」，手动编辑的差异化价值 = 表达引擎参数化覆盖不了的局部判断（AI 分块错色、边缘毛刺、艺术性增删、局部换策略）`[判断，依据=调研缺口分析+owner原话"对转化结果的精修"，置信度 高]`
- 纯从零创作市场已有 Silhouette/Hotfix Era 占据，且与本产品「算法工具箱」卖点弱相关
- 数字油画生成器调研显示"生成强、编辑弱"是普遍空缺——**生成后深度精修是本产品的定位缝隙** `[二手证据：PBNify/Davencified 等]`

### 2.2 入口与导航

第三 Tab「手动编辑」，与既有双 Tab 对称；复用 handoff 单向交接范式（`handoff.svelte.ts` 的扩展版）。备选方案（工作台内子模式）的取舍见 §10 议题 1。

```
顶栏: ◆ 贴钻工作台  [提示词实验室][转化工作台][手动编辑]        ● BYOK
移动端底部 Tab Bar 同步加第三项（App.svelte 既有模式照搬）
```

**One Concept → One Canonical Location 检查**：
- 分块参数（k/seed/覆写）真源 = 转化工作台；编辑器内分块层**只读**，不提供重分块
- 排布策略真源 = 引擎；编辑器只是调用方（工具形态）
- 钻面真源 = 手动编辑文档（进入后）；工作台的重算不再覆盖它（§3.1 烘焙原则）
- 色板：两模块各持快照，编辑器内增删改不回写工作台（P1 若实证需要，再议「色板全局化」）

---

## 3. 图层模型与数据结构

### 3.1 烘焙原则（bake-on-enter）——数据模型第一决策

**进入编辑即快照，编辑文档中 `Gem[]` 成为唯一真源；工作台后续参数改动不自动回流。**

```
送精修（工作台 → 编辑器 handoff'）:
EditDocument {
  meta:     { sourceStrategy, sourceParams: {density,relax,ss,gap}, createdAt }
  gems:     deepCopy(activeResult.gems)     // 12k 颗 ≈ 数百 KB，可承受
  blocks:   deepCopy(blocks)                // 只读参考（选块工具/边界渲染）
  palette:  deepCopy(palette)
  grid:     deepCopy(grid)                  // ss/gap 随之冻结
  painting: 引用共享（不拷贝像素）           // 中间稿叠底
  reference:引用共享（原图叠底）
}
```

依据：Silhouette 的 Release Rhinestones 同样是单向不可逆释放 `[一手]`；参数回流会静默摧毁用户手工成果（逆方向冲突——工作台重算以"无手工编辑"为前提，见 `layout/index.ts` 注释：validate 的 spacing warning "只对外部篡改过的钻集（UI 手动编辑）可达" `[代码事实]`）。**引擎已经在契约层面预设了"手动编辑钻集"这一场景，本设计是对该预设的产品化。**

代价与对冲：用户回工作台调参会得到新结果、旧编辑不自动迁移——UI 必须明示（送精修按钮文案："送精修（快照当前结果）"；再次送精修时若编辑文档已存在改动，弹确认"覆盖当前编辑文档？"）。

### 3.2 图层：固定语义四层，不做 PS 自由图层树

```
z 序（自下而上）                          可操作性
┌─────────────────────────────────────────────────┐
│ L4 钻面层 gems        ★唯一可编辑层（P0）        │
│ L3 分块层 blocks      只读：边界线/块选命中区      │
│ L2 底图层 painting    只读：AI 中间稿叠底+透明度   │
│ L1 参考层 reference   只读：原始照片/效果图叠底    │
│ (L5 标注层 notes      P2：文字/尺寸标注)          │
└─────────────────────────────────────────────────┘
```

- **显隐 + 透明度**：L1/L2/L3 各有 👁 + 透明度滑杆（工作台 previewMode/overlayOpacity 交互平移）
- **颜色分组 = 钻面层内过滤视图**（P1）：按 colorId 显隐/锁定，效果等价"每色一层"但无层间合并语义
- **明确不做**：PS 式自由图层树、多钻面物理分层（跨层间距冲突需要消解语义，复杂度爆炸）。业内无一款贴钻软件有自由图层树——Hotfix Era 用 elements list，Silhouette 靠对象选择 `[一手]`。工具类产品 Convention 轨道：欠缺设计优于过度设计（OJO 装载纪律）
- 多钻面层（不同 SS 混排 = Multi-Dec 类）是**唯一**未来可能需要物理分层的场景，推迟到需求实证 `[假设：精修场景单 SS 足够；验证=P0 发布后追踪"改 SS"请求频率]`

### 3.3 钻位 = 对象（非栅格）

`Gem { id, x, y, colorId, blockId }` `[代码事实：types.ts]` 原样作为编辑对象，不加字段：
- 单颗可选中/可删/可改色 → BOM 精确计数 → validate 可跑——三者栅格方案全毁
- `blockId` 语义退化为"来源块"（参考信息），编辑后不维护
- 编辑器侧维护**空间索引**（UniformGrid 哈希，桶尺寸 = pitch）：O(1) 点选命中、笔刷邻域查询、间距预检；不入引擎
- 栅格 mask 仅作为工具**内部中间态**（选区栅格化 → 合成 Block → 喂 layout），不进文档

### 3.4 撤销模型：patch 命令栈

```
Patch（三种原子，均可逆，可序列化）
  { op: 'add',    gems: Gem[] }                        // 逆 = remove
  { op: 'remove', gems: Gem[] }                        // 携带原对象，逆 = add
  { op: 'update', changes: { id, before:{x,y,colorId},
                             after: {x,y,colorId} }[] } // 逆 = swap before/after

一条用户动作 = 一个复合 Patch（数组长度的原子序列）
  笔刷一划（stroke）    → remove[旧] + add[新] 合并提交（pointerup 时）
  选块策略重排          → remove[该块旧钻] + add[layout 新钻]
  单颗拖动              → update[{id, before, after}]
  一键修复              → remove[dropped] + update[移动的]

undo = 逆序应用逆 patch；redo = 重放。栈上限 100 步（或 50MB 内存预算，先到为准）。
```

为什么不用全量快照：1 万钻快照 ≈ 1MB+，100 步 ≈ 100MB+ 不可控；patch 方案天然支持未来的历史面板/协作 replay。`[判断，依据=数据量估算，置信度 高]`

---

## 4. 工具箱设计（P0/P1/P2）

### 4.1 总览与业内对标

| 工具 | 快捷键 | 对标 | 优先级 |
|---|---|---|---|
| 画钻笔刷（单颗/连线） | B | Silhouette Draw Rhinestones `[一手]` | **P0** |
| 擦除笔刷 | E | Stitch Fiddle erase | **P0** |
| 单选/拖动/删除/改色 | V | Hotfix Era 单颗编辑 `[一手]` | **P0** |
| 选块填充（策略重排） | R | Silhouette Linear/Radial Fill 的局部化 | **P0** |
| 撤销/重做 | ⌘Z / ⌘⇧Z | 全品类标配 | **P0** |
| 导出（SVG/BOM） | ⌘E | 本产品既有 | **P0** |
| 套索/魔棒选区 | L / W | PS 语法；魔棒=同色选择 | P1 |
| 沿路径排钻 | P | Edge/Offset Fill 的手绘版 | P1 |
| 密度笔刷（局部密度±重排） | D | 本产品独有（块密度的笔刷化） | P1 |
| 颜色过滤面板（虚拟图层） | — | 元素列表/图层显隐 | P1 |
| 批量操作（选区改色/删除/平移） | — | Hotfix Era / PS | P1 |
| 对称（镜像/万花筒） | — | 拼豆类常见 | P2 |
| 形状工具/文字沿路径 | — | 拼豆 shape tools、TRW text arch | P2 |
| 变换（旋转/缩放→重排） | — | Hotfix Era | P2 |
| 空白画布从零创作 + 多 SS 混排 | — | Multi-Dec 对标 | P2 |
| 标注层/模板库/快捷键自定义 | — | — | P2 |

### 4.2 P0 工具规格

**① 画钻笔刷**（颜色 = 色板当前色，右面板可换）
```
模式 A 单颗: 点击 = 放 1 颗；吸附开(默认) → 落点 snap 到 pitch 网格最近孔位
              （六方网格基础件已有）；空位才落，撞已有钻不落（光标变⊘）
模式 B 连线: 按住拖动 → 沿轨迹按 pitch 等距放钻（Silhouette 拖拽串钻）
              （轨迹夹角自动成行，与引擎六方行向 rowAngleDeg=0 一致）
吸附开关: 网格吸附(默认开) / 自由放置(关 → 仅受"不重叠"约束)
光标: 半透明钻预览 + 笔刷半径圈；放置成功的钻短暂高亮 200ms
一划 = 一个 Patch（可一次 ⌘Z 撤销整划）
```

**② 擦除笔刷**：半径圈（[/] 调大小，1–10 钻径），扫过即删；同样 stroke 合并为一个 Patch。

**③ 单选工具**：点选（shift 加选）→ 拖动（带吸附预览）/ Del 删除 / 右面板改色（色板条目点击）。选中态：高亮描边 + 图层过滤面板联动（该色组闪烁）。

**④ 选块填充（owner 原话"选中区域自动排钻"）**
```
交互流:
 ① 选[选块填充]工具 → ② 点击目标块（分块层命中，块高亮，右侧显示现钻数/估算）
 ③ 右面板: 策略▾(五策略) + 密度滑杆(0.1–1.0) + 松弛钩子(boundary/repulsion)
 ④ [应用] → 确认弹层: "该块 1,240 颗 → 重排后约 990 颗 [执行/取消]"
 ⑤ 引擎调用: layout([该Block], strategy, {density,seed,relax}, grid)
    → remove[旧块钻] + add[新钻] = 一个 Patch
边界约束: 新钻与块外既有钻的间距冲突 → 立即进冲突高亮（§6 状态矩阵）
```
P0 的"区域"= 分块（复用工作台块选择心智，零新学习成本）；P1 套索/魔棒出现后，任意选区走同一条路径（选区 mask → 合成临时 Block → layout）。

**⑤ 撤销/重做**：§3.4；底部状态条常驻 ⌘Z/⌘⇧Z 按钮（含步数）。

**⑥ 导出**：复用 ExportBar 口径——`validate(gems, grid, blocks)` + `isExportable` 门 + `exportSvg/exportBom` `[代码事实：studio.svelte.ts buildActiveSvg 同构逻辑]`。冲突时阻断 + 引导修复（§6）。

### 4.3 P1 工具要点

- **魔棒**：点 1 颗 → 选同 colorId 全部（等价 PS 容差 0）；点分块层 → 选该块全部（连通域，工作台已有）
- **套索**：手绘闭合区域 → 栅格化 mask → 与"选块填充"共用重排管线
- **沿路径排钻**：手绘 polyline（虚线预览）→ 松手等弧长采样 pitch 间距 → 半透明钻预览 → Enter 落钻 / Esc 取消。引擎新函数 `layoutAlongPath`（§5）
- **密度笔刷**：在块内刷 → 该块 density ±0.1 → 局部重排（把工作台块密度滑杆笔刷化，本产品独有交互）
- **颜色过滤面板**：色板每行 + 👁显隐 + 🔒锁定（锁定色不可被擦除/编辑——防误伤大底色区）

### 4.4 底部状态条（常驻，Silhouette live counter 对标）

```
│ ⌘Z 撤销(23) ⌘⇧Z │ ■ 深空蓝 3,142 ■ 象牙白 2,891 ▾总 12,304 颗 │ ⚠ 间距冲突 2 [定位][一键修复] │ [导出 SVG][导出 BOM] │
```
BOM 计数逻辑 = 工作台 `bomSummary` 派生平移 `[代码事实]`；冲突计数 = validate warnings filter(kind='spacing')。

---

## 5. 引擎工具化（API 提案，给 Codex 的核心输入）

深模块纪律不变：编辑器 UI 只 `import from '$lib/engine'`，新能力以纯函数进引擎（node 同构可测）。

**直接复用（零改动）**：
```
layout(blocks, strategy, opts, grid)      // 选块/选区重排
validate(gems, grid, blocks) + isExportable  // 导出门
exportSvg / exportBom                     // 导出
SS_TABLE / pitchPx                        // 吸附网格
```

**新增公共出口提案（3 个，逐个评审签名）**：
```
1. layoutAlongPath(path: Pt[], opts: { grid: GridSpec; colorId: string;
     exclude?: Gem[] })  → Gem[]
   等弧长采样（pitch 间距）+ 与 exclude 既有钻的间距消解。
   实现：直接 polyline 弧长采样——路径已是线，无需 skeletonize
   （skeleton/等弧长逻辑是给"区域细化"用的，`layout/skeleton.ts` `[代码事实]`，
   其等弧长取点函数可抽出复用但入口不同）。

2. resolveConflicts(gems: Gem[], grid: GridSpec) → { gems: Gem[]; dropped: number }
   把 layout 内部 enforceMinDistanceCounted 的终局消解语义暴露为修复 API
   （layout/index.ts 现为私有调用 `[代码事实]`）。编辑器"一键修复"用。

3. blockFromMask(mask: Mask2D, colorRgb: [n,n,n]) → Block
   选区/套索栅格 → 合成临时 Block（label="编辑选区"），供 1/2 号管线消费。
   放引擎的理由：Block 构造纪律（bbox/areaPx/widthPx 统计口径）与 segment 产物一致。
```

**编辑器私有（不入引擎）**：空间索引、patch 栈、笔刷轨迹、选区栅格化、图层可见性。

---

## 6. 交互范式与状态矩阵

### 6.1 主界面线框（桌面 lg+）

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◆ 贴钻工作台   [提示词实验室][转化工作台][手动编辑●]                    ● BYOK │ h-12
├────┬───────────────────────────────────────────────────────┬─────────────────┤
│工具 │                    画布（缩放/平移复用）                │ 右面板（随工具切换）│
│ B 画钻│   ┌───────────────────────────────────────────┐    │                 │
│ E 擦除│   │  L1 参考层(照片,30%透明)                    │    │ ▸ 笔刷          │
│ V 单选│   │  L2 底图(AI中间稿,50%)                     │    │   颜色 ■深空蓝 ▾ │
│ R 选块│   │  L3 分块边界(虚线)                         │    │   模式 ◉单颗 ○连线│
│   填充│   │  L4 钻面:  ○○○○○                          │    │   吸附 [网格 ✓]  │
│ P 路径│   │           ○○●●○ ← 红圈=间距冲突高亮         │    │ ▸ 图层显隐       │
│ (P1) │   │           ○○○○○     ⌘=放大镜光标           │    │   参考 👁 30% ─○─│
│ D 密度│   │                                           │    │   底图 👁 50% ─●─│
│ (P1) │   │   空格+拖 = 平移                            │    │   分块 👁       │
│     │   └───────────────────────────────────────────┘    │   钻面 👁        │
│ ⌘Z ↺│                                                        │ ▸ BOM ▾(每色计数)│
├────┴───────────────────────────────────────────────────────┴─────────────────┤
│ ↺撤销(23) ↻ │ 总 12,304 颗 │ ⚠ 间距冲突 2 [定位][一键修复] │ ✅可导出 [SVG][BOM] │ h-10
└──────────────────────────────────────────────────────────────────────────────┘
```

移动端（<lg）：左工具栏折为底部工具 Dock（横滚图标条），右面板折为底部抽屉（Sheet 组件已有）。与现有底部 Tab Bar 共存：Tab Bar 在编辑器内上移让位或工具 Dock 与 Tab 分层——P0 先做桌面，移动端布局 P1（工具类精修是桌面场景 `[假设；验证=P0 种子用户设备分布]`）。

### 6.2 状态矩阵（interaction-design output contract）

| 状态 | 触发 | 呈现 | 出口/恢复 |
|---|---|---|---|
| 空文档 | 进入 Tab 无 handoff' | 空态卡：说明 + [去工作台] | 跳工作台（P1 加"空白新建"） |
| 快照构建 | 收到 handoff' | 同步构建（<100ms，无 spinner） | 直接进编辑态 |
| 编辑中 | 常态 | 全工具可用 | — |
| 局部计算中 | 选块重排/沿路径预览 | 按钮转圈 + 结果渐入（局部重排 <300ms `依据：工作台全图五策略秒级内，块级子集更快`） | 完成自动退出 |
| 冲突态 | validate spacing>0 | 红圈高亮 + 计数 + 导出禁用 | [定位]逐个跳转 / [一键修复] |
| 导出阻断 | isExportable=false | 按钮禁用 + tooltip 列冲突清单 | 修复后自动解禁 |
| 撤销栈空/满 | — | 按钮禁用 | — |
| 离开确认 | 有未导出编辑 + 切 Tab/关页 | "编辑未导出，离开将丢失"[离开/留下]；beforeunload | P1 IndexedDB 草稿自动续 |
| 大文档性能 | >2 万钻 | 画布降级渲染（LOD：缩小时画点不画圆） | 缩放阈值自动 |

### 6.3 主旅程走查（Journey First 自检）

```
工作台调参满意 → [送精修] → 自动切 Tab → 画布内容与工作台预览一致（Context连续性✓）
→ 发现眼睛分块错色 → R 工具点中该块 → 换策略重排（局部替代全局重算 = 本模块核心价值时刻）
→ 边缘毛刺 → E 擦除笔刷清理 → 缺钻处 → B 画钻补（snap 网格，行向一致）
→ 状态条 BOM 实时更新（State 可见性✓）→ ⚠ 冲突 2 → [一键修复] → ✅
→ [导出 SVG + BOM] → 完成
每步可 ⌘Z 回退（控制权✓）；全链无不可逆动作（除"再次送精修覆盖"，有确认门）
```

---

## 7. 与转化工作台的边界与协作

| 维度 | 转化工作台 | 手动编辑 |
|---|---|---|
| 操作粒度 | 块级（覆写字典） | 钻级 + 任意区域 |
| 真源 | 参数（blocks/overrides） | EditDocument.gems（烘焙快照） |
| 重算范围 | 全图五策略 | 局部（单块/选区/路径） |
| 可回退性 | 参数即历史（可重算） | patch 撤销栈 |
| 分块编辑 | ✅（k/seed/覆写） | ❌ 只读参考 |
| 导出 | ✅ | ✅（同引擎同门） |

协作流：工作台 [送精修] → 编辑 → 导出。**编辑成果不回流工作台**（回流 = 参数化管线吃不了手工钻集，硬融会造出第二真源）；若用户想"以编辑结果为参照重新转化"，P2 提供"编辑结果叠底送回工作台当参考图"（图片级回流，非数据级）。

---

## 8. MVP 切分

**P0（最小可用闭环 = owner 提的"图层+笔刷+单策略区域填充+撤销+导出"具体化）**
1. 第三 Tab + handoff' 快照交接 + 空态/离开确认
2. 固定语义四层（显隐+透明度）
3. 画钻笔刷（单颗/连线 + 网格吸附）、擦除笔刷、单选（移动/删除/改色）
4. 选块填充（五策略 + 密度 + 松弛钩子，作用于分块）
5. patch 撤销栈（⌘Z/⌘⇧Z）
6. 状态条：BOM 实时计数 + 冲突计数 + [一键修复]（依赖引擎 resolveConflicts）
7. 导出 SVG/BOM（validate 门复用）
8. 引擎：resolveConflicts 出口；layoutAlongPath 可延后至 P1 一并交付

**P1**：套索/魔棒 → 任意选区填充；沿路径排钻（+引擎 layoutAlongPath）；密度笔刷；颜色过滤面板（虚拟图层+锁定）；批量操作；移动端布局；IndexedDB 草稿持久化；blockFromMask
**P2**：对称、形状/文字工具、变换重排、空白画布从零创作、多 SS 混排（物理多钻面层的唯一入口场景）、标注层、模板库、快捷键自定义、"编辑结果叠底回流参考图"

---

## 9. 成功标准与风险

**主指标（单一）**：送精修 → 编辑后成功导出的闭环完成率（P0 后 2 周窗口，种子用户 ≥10 名，目标 ≥60% 进入编辑的会话完成导出）`[目标值为假设，首发校准]`
**支撑指标**：编辑动作分布（重排/擦/补/改色占比——验证工具箱配比）、撤销使用率（编辑器健康度）、冲突一键修复率、编辑后 BOM 变化幅度（编辑强度的间接量）
**护栏**：工作台管线回归零破坏；1 万钻画布平移缩放 60fps、笔刷按下到反馈 <16ms；导出门不放行任何 spacing 违规文档

**风险台账**：
| 风险 | 等级 | 对冲 |
|---|---|---|
| 手动放置破坏六方行向一致性（rowAngleDeg=0 全局行向 `[代码事实]`）| 中 | 默认网格吸附 + 自由模式仅受间距约束（显式用户选择）|
| 大文档渲染性能 | 中 | LOD 降级 + 空间索引增量重绘（BlockCanvas 基础件扩展）|
| 烘焙后用户误解"工作台改参数怎么编辑器没变" | 高 | 送精修文案 + 编辑器顶部来源徽章（"来自 hybrid @ 密度0.8"）|
| 选块重排与块外钻冲突常态化 | 中 | 冲突高亮即时反馈 + 修复引导（Hotfix Era 同法 `[一手]`）|
| 移动端精修需求被高估 | 低 | P0 桌面先行 + 设备埋点验证 |

---

## 10. 给 Codex 的议题清单（附初步立场）

1. **入口形态**：第三 Tab + handoff' 快照 vs 工作台内「自动/手动」子模式（共享状态零交接）。
   立场：第三 Tab。导航对称、工作台 UI 密度已满、handoff 范式现成；代价是两视图间来回切换。若 Codex 认为切换频率会很高（精修中频繁回调参数），子模式方案需重评。
2. **图层粒度**：固定语义四层 + 颜色过滤视图 vs 物理多钻面层（按色/按策略分层，跨层间距消解）。
   立场：前者。引擎 export/validate/BOM 均吃扁平 Gem[]；多钻面层引入合并语义，无业内先例支撑；Multi-Dec（多 SS）是唯一硬场景，P2 再议。
3. **钻位对象 vs 栅格**：对象 Gem[] + 空间索引（本方案）vs 栅格 bitmap 编辑（像素编辑器路线，渲染/笔刷更快）。
   立场：对象。BOM 精确计数、单颗操作、validate 复用三者在栅格路线全部重造；性能用空间索引+LOD 对冲。
4. **引擎工具化 API 形态**：§5 的三个新出口（layoutAlongPath / resolveConflicts / blockFromMask）进引擎 vs 编辑器私有实现；以及 resolveConflicts 是否应直接改写 layout 内部调用以共用一份消解实现。
   立场：进引擎（纯函数、node 同构、深模块纪律）；内部与 layout 共用 enforceMinDistanceCounted，避免两套消解语义漂移。
5. **导出门语义**：spacing 违规阻断导出（现状语义延伸）+ 一键修复 vs 警告放行（Hotfix Era 是高亮提示不阻断 `[一手]`）。
   立场：P0 阻断+修复（物理间距是贴钻硬约束，阻断是质量门）；若用户实测修复损耗大，P1 加"强制导出（自担风险，文件名带 -unsafe）"。

（第 6 个潜在议题「烘焙 vs 参数回流」已按 §3.1 定为设计决策而非议题——业内一手证据一边倒；如 Codex 有强反驳再升级为议题。）

---

## 11. 附：调研来源清单

- Silhouette101（官方）Rhinestone Conversion Tools：<https://www.silhouette101.com/archives/rhinestone-conversion-tools-designer-edition-and-higher>
- Sierra Hotfix Era（官方产品页）：<https://www.sierra-software.com/Sites/Products/HotfixEra/HotfixEra.aspx>
- TRW Design Wizard（官方，403 经检索摘要）：<https://www.therhinestoneworld.com/trw-design-wizard-rhinestone-design-software>
- Jennifer Maker（Cricut 贴钻教程）：<https://jennifermaker.com>
- Stitch Fiddle（官方）：<https://www.stitchfiddle.com>
- PCStitch（官方+评测摘要）：<https://www.pcstitch.com>
- StitchMate（拼豆编辑器）：<https://stitchmate.app>
- Beads Creator（Google Play）：<https://play.google.com/store/apps/details?id=com.onetap.beadscreator>
- Davencified / PBN 生成器综述：<https://www.davincified.com>、<https://ledgebay.com>
- 代码事实：`rhinestone-studio/src/lib/engine/{types,index}.ts`、`layout/{index,skeleton}.ts`、`stores/{studio,handoff}.svelte.ts`、`App.svelte`
