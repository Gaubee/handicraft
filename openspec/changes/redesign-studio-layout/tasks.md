<!--
Orthogonal intents (max 4):
1. [2026-09-19 Delivery] Codex-R1 修订版：renderer 纯函数+基准先行 → 五区骨架（无资产依赖，可与 add-asset-library
   数据层并行）→ 逐区拆装 → 对比覆盖层 → 资产接入回接（等适配层）。
2. [2026-09-19 Safety] 真浏览器测试三档 viewport 兜底移动端硬承诺 [B8]；renderer 像素基准 [B9]；每步全量绿门。
3. [2026-09-19 Boundary] 不复制临时 picker：空态 CTA/更换入口/reference 在适配层就绪前占位禁用 [R1-C]。
4. [2026-09-19 Process] A/B 对比 P0 最小形态（两栏切换）入验收；滑动器为增强。
-->

## 0. renderer 边界与基准（先行）[Codex-R1-B9]

- [ ] 0.1 previewRender 纯函数抽取（drawPreview(ctx, input)，签名按 design §2 冻结）；Image/objectURL/ResizeObserver/重绘调度留组件；vitest：同 fixture 下旧 CompareGrid 卡 / 新调用方像素与尺寸一致性（旧卡为 golden）

## 1. 骨架重写（五区固定视口，无资产依赖）

- [ ] 1.1 StudioView 重排：上下文条/画布 flex/检查器 320px/胶片带/状态条（min-h-0/min-w-0 链）；「更换」入口占位禁用（等适配层）；主区零纵向滚动（结构性断言）
- [ ] 1.2 StudioContextBar：来源信息 + 预览三模式 pills/透明度 + 取景控制（适应/±/百分比）；vitest+走查：预览模式即时生效

## 2. 逐区拆装

- [ ] 2.1 Inspector（自 BlockPanel 拆装）：选中块详情置顶 + 物理/色板/分块/块列表折叠组；无选中=全局态
- [ ] 2.2 StrategyFilmStrip：五策略 chips+钻数+合规点+选中高亮（点击=唯一写入点）+ hover 预览浮卡（180px，经 previewRender）
- [ ] 2.3 StudioStatusBar（自 ExportBar 演化）：答案位+策略回显+校验徽标+BOM 前3色…▾+导出组+送精修（reference 链占位）；违规浮出修复直达+清单▾；spacing 门语义不变（vitest 迁移）
- [ ] 2.4 CompareGrid 旧组件退役（测试选择器迁移完成后再删）

## 3. 对比模式（覆盖层）

- [ ] 3.1 CompareOverlay：全屏覆盖（Esc/点外部退出，focus trap 测试）+ 五栏大图（约 20vw，经 previewRender）+ 点卡=设为导出策略并退出
- [ ] 3.2 A/B 对比 **P0 最小形态=两栏并排+点击切换**（验收含此形态）；拖拽分屏为 P0.5 增强

## 4. 移动端同构 + 真浏览器测试 [Codex-R1-B8]

- [ ] 4.1 画布 flex 填充（60vh 废除）+ 胶片带横滑 chips（停驻≠选中）+ 状态条导出菜单；对比模式=全屏 Sheet（scroll-snap + [设为导出策略]）
- [ ] 4.2 真浏览器测试：312/375/桌面最小宽三档——主区 computed overflow 断言、五区可见性、胶片带滚动不改 activeStrategy、overlay Esc/focus trap、导出门与 worker 进度；vitest 仅保留状态单测

## 5. 资产接入回接（等 add-asset-library 适配层）

- [ ] 5.1 空态双 CTA + 上下文条「更换」接 AssetPickerController；origin 'library' + StudioImage.assetId；reference preview 经 getAssetBlob
- [ ] 5.2 送精修 reference 链回接（buildManualEditHandoff referenceAssetId）+ 导出 PNG 入库挂接；与 add-asset-library §6 互查（C-4 三交汇点）

## 6. 收尾

- [ ] 6.1 八态逐态测试 + 全量绿门
- [ ] 6.2 浏览器走查：312+375 工作台；「调整→画布全程可见」断言；记分卡复测（Journey 5→9；发布会截图=能）
