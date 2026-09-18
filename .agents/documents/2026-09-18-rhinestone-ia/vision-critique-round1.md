# 视觉批判 · 第一轮（vision 子代理，2026-09-18）

判读材料：/tmp/rs-shots/01-lab.png（实验室）、/tmp/rs-shots/02-studio.png（工作台），1600×1000 视口。前置校验通过（非黑图、像素分布正常）。像素尺寸为目测近似（±5%）。
背景约束：工作台"分块画布/策略卡"内容为空是已定位正在修复的渲染 bug（F0），批判已跳过"内容为空"本身。

## 总评

当前视觉是「shadcn 默认白卡 + 灰色小字说明」的标准后台管理气质，而产品的核心资产——画布与候选图——只分到约 29% 视口宽度，页面底色与卡片底色几乎同为白色（直方图仅差一档亮度），整页发平、无主角。最大问题不是单卡美观，而是布局系统没有为「创作工具」服务：chrome 占据第一眼，作品区退居其次。

## P0

1. **画布工具栏与图像重叠**（工作台画布顶部）：「适应/放大/缩小/50%」行与图像顶边重叠，50% 读数被盖。改法：画布容器 `relative overflow-hidden`，工具栏浮动 `absolute left-3 top-3 z-10 flex gap-1 rounded-lg border bg-background/85 p-1 shadow-sm backdrop-blur`；缩放读数与按钮分离为 `text-xs tabular-nums text-muted-foreground`，不做同款胶囊。
2. **视口利用率过低，画布没成为主角**（两图）：1600px 视口内容区仅约 870px（54%），画布卡仅约 460px。改法：应用壳 `h-screen flex flex-col overflow-hidden`；顶 header + 主区 `grid lg:grid-cols-[360px_minmax(0,1fr)]`，左面板 `overflow-y-auto min-h-0`，画布区 `flex-1 min-h-0`；移除居中 max-w 容器。
3. **图底关系缺失，整页无纵深**：页面底色 (255,255,255) 与卡片底色 (254,254,254) 仅差一档亮度。改法：应用区底色 `bg-muted/40` 或 baseColor 换 stone-50；卡片 `bg-card shadow-xs`。

## P1

4. **品牌字断行孤儿字**：「贴钻工作台」折成「贴钻工作/台」。改法：品牌移入顶部 header（推荐，与 PM 方案一致）。
5. **缺应用顶栏，Tabs 悬空**：加 `h-12 border-b bg-background/80 backdrop-blur` 顶栏：左品牌、Tabs、右侧 BYOK 状态与全局动作。
6. **技术说明书式说明铺满每卡**（7+ 处灰字噪音）：默认收进帮助入口——卡题行 `HelpCircle h-3.5 w-3.5` + Tooltip 承载原文；卡内至多一行 `CardDescription text-xs line-clamp-1`。可降信息密度约三成。
7. **卡片权重均质、标题层级弱**：卡题 `text-sm font-semibold tracking-tight`；主工作面卡（画布/画廊）`p-2 shadow-md ring-1` 提级，配置卡 `p-4`；纵向节奏 `space-y-4→space-y-6`、组内 `gap-3`。
8. **实验室疏密失衡**：左列溢出折叠、右列约 700px 纯白。改法：画廊候选就位后 `grid grid-cols-2 lg:grid-cols-3 auto-rows-min gap-3`；空态框固定 `h-48`；变体组改 Accordion（trigger=名称+候选数，默认仅第一项展开），左列高度可减约 60%。
9. **主 CTA 不在视口内**（空态文案引导点「开始生成」但视口内无此按钮）：空态内嵌 `<Button size="sm">开始生成</Button>` + 左列底部 `sticky bottom-0 bg-gradient-to-t from-background pb-3` 常驻 CTA。
10. **策略卡五连排过窄文字竖折**（每卡约 84px）：容器 `flex gap-3 overflow-x-auto snap-x`、卡 `min-w-36 snap-start`；名称 `text-xs font-medium whitespace-nowrap`、别名 `text-[10px] font-mono text-muted-foreground`；选中态改 `ring-1 ring-primary bg-accent/50` + 右上 Check（黑粗框像报错）。
11. **破坏性操作红色噪音 + 触达不足**：垃圾桶/「删」「加」单字按钮改 `Button ghost icon h-8 w-8 text-muted-foreground hover:text-destructive`（Trash2/Plus 图标）；色板行动作列固定 `w-8`。
12. **空状态无引导性**：容器 `flex h-48 flex-col items-center justify-center gap-2 rounded-lg border-dashed bg-muted/30 text-center` + 图标 `h-8 w-8 text-muted-foreground/40` + 文案 `text-sm` + 内嵌主按钮；画布空态可铺钻点母题底纹 `bg-[radial-gradient(circle,var(--color-stone-300)_1.5px,transparent_1.5px)] [background-size:14px_14px]`。
13. **变体 textarea 体量失控**（单框约 300px 高 × 5）：`field-sizing-content min-h-24 max-h-64 overflow-y-auto text-xs font-mono leading-relaxed` + Accordion 双保险。

## P2

14. 色板行：色块 `h-6 w-6 rounded-md ring-1 ring-inset ring-border`；hex 合并单输入（`#` 前缀 absolute + `Input pl-6 font-mono text-xs`）。
15. 滑杆：统一 Field 结构（label `text-xs text-muted-foreground` + 右侧 `float-right font-mono tabular-nums` 当前值 + `Slider py-2` 扩命中）；双列 `grid grid-cols-2 gap-3 items-end`。
16. 零值徽标告警质感：「预估 0 钻」等改纯文本 `text-xs tabular-nums text-muted-foreground`；Badge 只留真拦截状态（未配置 Key 用 `bg-destructive/10 text-destructive`）。
17. 画布提示条低对比：`rounded-md bg-black/55 px-2.5 py-1 text-[11px] text-white backdrop-blur-sm`。
18. 实验室头卡徽标堆叠：合并一行状态行（状态点 + 「Base URL / API Key 未配置」 + link 设置）；模型名入标题右侧 `text-xs font-mono`。
19. 「策略对比」裸区头与卡片语言不一致：统一（并入画布卡 CardFooter 或全部裸区头）。

## 移动端红旗（桌面截图推断）

- 固定左栏 380px → lg 以下单列，顺序 画布/画廊 → 控件
- 策略卡五连排 375px 必破 → `min-w-36 + overflow-x-auto snap-x` 横滑
- 图层 pills 行（5 枚约 380px）→ flex-wrap 或横滑；动作与视图混排是 IA 问题
- 色板行四元素 → hex 列 `hidden sm:block`
- SS/gap 双列 → `grid-cols-1 sm:grid-cols-2`
- 画布浮动工具栏触屏无 hover → 点按显隐
- 顶部 Tabs 胶囊窄屏可用，保留

## 气质定位：「安静的工坊」，不是「后台管理」

参考 Figma/Procreate 的共同语言——画布即产品，chrome 退后。手法：
1. 底色 stone 暖中性 + 白卡（暖灰=工坊纸感），恢复图底关系
2. 全站一个强调色：取色板「金 #D4A017」做 primary/accent；红色只留破坏与拦截
3. 「钻点母题」：空态点阵底纹、选中态圆点指示、色板 swatch `h-8 w-8 rounded-lg ring-1 ring-inset ring-border`——工具本身像钻盘
4. 控件数字全部 `font-mono tabular-nums`（0.40mm、#C8102E）——仪器精度感
5. 字阶整体上移一档：应用标题 `text-base font-semibold`、卡题 `text-sm font-semibold`、正文/说明 `text-xs`，说明默认藏 tooltip
6. 圆角 `rounded-xl`（卡）/`rounded-md`（控件），阴影只给浮层与主工作卡

## 移交 IA 层的衔接点

1. 动作与视图混排（上传/清除原图混进视图 pill 组）——操作分类问题
2. 「开始生成」不可见但空态引用它——任务流断点（sticky CTA/空态内嵌）
3. 左列同时承载全局配置+5 组变体——编辑态/折叠态与主从结构
4. 「预估 0 钻」等实时指标归属（画布/状态栏 vs 设置卡头）
5. 实验室头卡与 Tab 同名重复、说明术语化——内容分层
6. 「优先消费实验室送转化的图」靠灰字承载——跨视图产物流转关系

## 判读边界

确定：卡片均质白底、底色卡底亮度差≤1 档（直方图）、品牌孤儿断行、策略卡竖折、实验室右列大块空白、视口内无开始生成按钮。不确定：「开始生成」是否在折叠区下方、「50%」被遮机制、说明文字实际字号、px 均为目测。

第二轮建议补拍 1440×900 与 390×844（移动端）各一张验证。
