# 改版实现简报（PM × Vision 交叉裁决后）

> 输入：ia-design.md（PM，动线/IA/移动端）+ vision-critique-round1.md（vision，19 项视觉问题+气质定位）。
> 两份文档高度收敛，本简报只记录裁决与实现顺序，细节以两份源文档为准。
> 前置依赖：F0–F6 修复回合完成（工作台渲染 bug 是视觉迭代前提）。

<!--
Orthogonal intents (max 3):
1. [2026-09-18 Owner] 视觉与动线两轮子代理碰撞后的统一实现简报，供实现子代理直接落地。
2. [2026-09-18 Adjudication] 冲突项裁决记录（左右栏宽度、主题换色、双真源）。
3. [2026-09-18 Scope] 桌面 + 移动端一次到位；不含新功能，只重组现有功能。
-->

## 交叉裁决（唯一分歧项）

| 分歧 | PM | Vision | 裁决 |
|---|---|---|---|
| 左栏宽度 | 实验室 400px / 工作台 340px | 统一 360px | **按 PM 分视图取值**（有各自内容量依据），主区一律 `minmax(0,1fr)` |
| 应用壳 | 线框隐含全出血 | 显式 `h-screen overflow-hidden` | **按 vision**：全出血应用壳，移除 max-w 居中 |
| 主题 | 未涉及 | stone 底 + 金 #D4A017 强调色 | **按 vision**：stone 暖中性 + 金 primary，红只留破坏/拦截 |
| 品牌位置 | 顶栏 | 顶栏（或竖排 rail） | 顶栏，无竖排 rail |
| 策略双真源 | 收敛到对比网格选中卡 | 选中态视觉改 ring+Check | 双方互补，**合并执行** |

## 实现顺序（P0 全做 → P1 全做 → P2 选做）

### R1 应用壳与主题（vision P0-2/3、P1-4/5 + PM 顶栏方案）
1. `h-screen flex flex-col overflow-hidden` 壳：顶栏 `h-12 border-b bg-background/80 backdrop-blur`（品牌+Tabs+BYOK 状态芯片[点击开设置 Dialog]）；主区 per-view grid；左面板 `overflow-y-auto min-h-0`；画布/画廊区 `flex-1 min-h-0`
2. 主题：baseColor neutral→stone（components.json + app.css 变量重生成）；primary=金 #D4A017；`bg-muted/40` 应用底色恢复图底关系
3. 气质基建：数字全 `font-mono tabular-nums`；卡 `rounded-xl`/控件 `rounded-md`；字阶上移一档；钻点母题（空态点阵底纹/色板大 swatch/选中圆点指示）

### R2 实验室改版（PM §5.1 线框 + vision P1-6/8/9/13、P2-18）
1. 左列 400px：原图卡（缩略图+尺寸+edits 标注+移除）→ 变体 Accordion（首组展开，trigger=名称+候选数，textarea `field-sizing-content min-h-24 max-h-64`）→ 高级参数（JSON+尺寸）折叠组 → **sticky 吸底 CTA**（未配置时变「配置连接」开 Dialog——PM 动线断裂 Top1）
2. 右列画廊：分组骨架（变体名+候选数）；候选 `grid-cols-2 lg:grid-cols-3`；空态=三步引导卡（①配置 ②传图(可选) ③生成）内嵌 CTA；失败卡带「去设置」
3. 头卡徽标堆叠清理（状态行合并）；说明文字收 Tooltip（HelpCircle）

### R3 工作台改版（PM §5.2 线框 + vision P0-1、P1-7/10/12、移交项 1/4）
1. 左列 340px：**选中块详情置顶常驻**（密度滑杆+实时钻数+类型/颜色覆写+禁用——PM 动线断裂 Top3）→ 块列表 → 物理参数/色板 chips/分块参数三折叠组
2. 画布区 `flex-1`：浮动工具栏（vision P0-1 重叠修复）；预览模式与参考图动作拆两组（IA 移交项 1）；提示条深底白字
3. 策略卡横排 `min-w-36 snap-x`、选中=导出真源（ring+Check，导出条策略只读）；导出条=钻数唯一答案位（BOM 摘要 chips）
4. 空态：双 CTA（回实验室挑成品=主入口 / 直接上传=次入口）+ 钻点底纹
5. handoff 增强（PM 动线断裂 Top2）：handoff 增带参考原图（工作台「叠原图」免二次上传）+ 全局 toast 确认

### R4 移动端（PM §4 全案 + vision 移动红旗）
1. lg 以下：底部 Tab Bar（48-56px+安全区）；顶栏瘦身（标题+状态芯片）
2. 实验室单列可跑通：变体手风琴天然适配 + 吸底生成按钮（底部 Tab 之上）+ 画廊 2 列
3. 工作台画布优先：载入摘要行 → 画布 60vh → 策略 carousel（chips 横滑+单卡，停驻=导出策略）→ 导出条；参数=[块][物理][色板]三按钮开底部抽屉；选中块半屏抽屉
4. 触控：滑杆命中 ≥44px；pinch 缩放（zoomAt 双指版）；双击适应；「不做清单」按 PM §4.4 只读降级
5. vision 红旗逐条：色板 hex `hidden sm:block`、SS/gap `grid-cols-1 sm:grid-cols-2`、pills flex-wrap

### R5 P2 视觉细修（vision #14-19）
色板行合并输入/滑杆 Field 统一/零值徽标去告警化/画布提示条对比度/区头语言统一。

## 验收标准
1. 全量 `pnpm test` 零回归（冒烟测试断言若因文案/结构改动失效，同步更新断言而非删除测试）
2. `svelte-check` 0/0、`pnpm build` 成功
3. 桌面 1600×1000 + 1440×900 + 移动 390×844 三视口截图：画布/画廊为主角（首屏占比 ≥50%）；无孤儿断行、无文字竖折、无工具栏重叠；CTA 始终可见
4. 冷启动动线：无 key 状态下从「开始生成」到配置 Dialog 一步直达
5. 移动端：两模块可完整查看、工作台画布可缩放、无横向溢出
