<!--
Orthogonal intents (max 5):
1. [2026-09-18 Delivery] 纵向可验证的 tracer bullet：每节结束都有可运行/可测试的证据。
2. [2026-09-18 Safety] 几何不变量（间距/掩码/确定性/单调性）以 vitest 证明，而非人工目测。
3. [2026-09-18 UX] 模块 B 的验收是人类视觉裁决（多算法对比 + 密度手感），列为显式任务。
4. [2026-09-18 Owner 追加] 产品体验迭代（动线/收纳/移动端/视觉三批判轮）纳入本 change 收尾。
-->

## 1. 脚手架（P0）

- [x] 1.1 初始化 `rhinestone-studio/`：Vite 8.3 + Svelte 5.57 + TS strict + Tailwind v4.3 + vitest 5 + zod + ts-pattern；`dev`/`build`/`test` 全绿（Vite 8 兼容，未降级；vitest 需 browser 解析条件修复，见 vite.config.ts 注释）。
- [x] 1.2 shadcn-svelte 初始化（Tailwind v4 路线，style vega），11 个基础组件就位；两视图切换壳可运行。

## 2. 转化引擎（P1，纯 TS）

- [x] 2.1 `types.ts` 契约 + `segment()`：Lab k-means++（seed 确定性）、4-连通域、Felzenszwalb 距离变换宽度、类型推断；测试：合成图分块断言 + 确定性重放。
- [x] 2.2 构造式策略 S1 hex-thin / S2 hex-pitch / S3 poisson / S4 hybrid（Zhang-Suen 骨架+等弧长链）；五不变量全量断言。
- [x] 2.3 收敛式 S5 cvt（密度场加权 Lloyd + ε 早停）+ 松弛钩子 boundary（1D Lloyd）/ repulsion（斥力修复）；含后续修复：CVT 松弛系数 0.92 + 晶格容量基准 + 周期性 repairSpacing（满密度产额 92.2%、全区间单调）。
- [x] 2.4 `mapColors()`（Lab ΔE CIE76）/ `validate()`（spacing+mask 双阻断）/ `exportSvg()`/`exportBom()`；`LayoutResult.dropped` 消解计数。
- [x] 2.5 引擎冒烟：03-src.jpg 派生 fixture 全管线，SVG/BOM 对账（2310 圆点=2310 合计）。

## 3. 模块 A 提示词实验室（P1）

- [x] 3.1 BYOK 设置面板（baseUrl/key/model + 连接测试三分错误）。
- [x] 3.2 API 客户端：双端点、n:1 恒定、Advanced JSON 逃生舱（敏感键脱敏）、url/b64 双兼容、debug 脱敏、上传预处理。
- [x] 3.3 变体编辑器（5 组默认模板）+ Dropzone + 并发泵（上限 4、状态机、AbortController、失败免重传重试）。
- [x] 3.4 分组画廊 + 叠加/并排预览 + IndexedDB/localStorage 三级降级。
- [x] 3.5 「送转化」handoff（后续增强：携带参考原图 + 全局 toast + view store 编程切换）。

## 4. 模块 B 转化工作台（P2）

- [x] 4.1 画布底座：BlockCanvas 分块着色/点选/缩放平移（后续修复：layers effect 无限循环 F0 + computeFit 纯函数 + resize 重算取景 N1）。
- [x] 4.2 BlockPanel：每块启停/密度滑杆实时钻数/类型颜色覆写；全局 SS/gap/色板编辑。
- [x] 4.3 CompareGrid 五策略同屏 + 松弛开关 + 三预览模式（后续：策略选中=导出唯一真源）。
- [x] 4.4 ExportBar：SVG/BOM/PNG + 违规阻断（spacing+mask）。

## 5. 评审与收尾（P3/P4）

- [x] 5.1 评审子代理按 Codex 标准复核：7/10，两算法阻塞（B1 CVT 非单调/51% 产额、B2 相邻块联动）+ 走查阻塞（F0 effect 循环）全部修复，212/212 全绿。
- [x] 5.2 vision 走查三轮：R1（19 项批判）→ R2（15/19 修复+新 P0 定位）→ R3（定向复核收敛判定）。
- [ ] 5.3 `openspec validate --strict` → 归档 change → `git init` + 首次提交（无远程，push 不适用）→ 汇总报告。

## 6. 体验迭代（Owner 2026-09-18 追加）

- [x] 6.1 PM 子代理产品设计：用户故事映射/动线断裂 Top3/功能收纳（L0-L2）/移动端策略/线框 → ia-design.md。
- [x] 6.2 vision 第一轮视觉批判（19 项 + "安静的工坊"气质定位）→ vision-critique-round1.md。
- [x] 6.3 交叉裁决 → redesign-brief.md（R1-R5）。
- [x] 6.4 改版实现 R1-R5：全出血壳+stone/金主题、实验室（手风琴/sticky CTA/三步引导）、工作台（块详情置顶/策略真源/答案位）、移动端（底部 Tab/画布优先/抽屉/carousel/pinch）。
- [x] 6.5 三轮视觉迭代闭环：改版后批判 → N1-N7 修复（computeFit 纯函数+12 用例、预览浅底、答案位上提、换行、carousel 定位、金色统一、抽屉可发现性）→ 定向复核。
