<!--
Orthogonal intents (max 5):
1. [2026-09-21 Owner 六点] 高级功能入口/注入交互：TextQuote 按钮化 + 开关即注入/移除
   （\n【占位符】\n 默认式）+ Dialog 收敛保存/取消。
2. [2026-09-21 Owner] 附图显式编号 [image #N]：骨架字面 v2（【图N [image #N]：…】）+ UI 徽标
   同步 + byteEq 新基线再生（红线性质保持）。
3. [2026-09-21 Owner] 蓝图参考图缩略预览（id 退 title/alt）。
4. [2026-09-21 Owner] 画幅必选：表单必填标记 + startRun fail-fast（蓝图不强制）。
5. [2026-09-21 Owner] 高级请求参数编辑器：tabs 三页 + 已知字段注册表 + 自定义 key-value
   （JSON 字面量）+ 尺寸双 input + 比例分组快选 Dialog（存储层 form.advancedJson/size 不变）。
约束：每切片 solo vitest 绿 + 显式路径 commit（repo 根发起，禁 amend）；收尾 svelte-check 0 错
+ lab 全族回归；不起 dev server；validate 归主会话。
-->

## 1. 点 1：icon 更换

- [x] 1.1 TemplateAdvancedOptions 三入口 Pencil → TextQuote + outline 边框 + tooltip「编辑提示词片段」+ aria-label；测试：按钮可辨识断言（aria-label/title）+ 既有 testid 面

## 2. 点 2：开关即注入/移除

- [x] 2.1 prompt.ts `appendEffectPromptPlaceholder` / `removeEffectPromptPlaceholder` 纯函数；vitest：注入默认式/幂等（任何位置已存在不动）/移除全出现（含包裹换行、行内残存、空 body 边界）
- [x] 2.2 三 toggle 接线（同 patch 提交 promptBody+效果键；水钻 pendingOpen 中间态不注入）；EffectPromptDialog 动作收敛（删 onInsert）；TemplateEditor insertIntoPromptBody 链退役；vitest：开→注入/关→移除矩阵（含水钻首规格点亮路径）+ Dialog 二动作

## 3. 点 3：[image #N] 显式编号

- [x] 3.1 prompt.ts `figureTagOf` + 三常量 {figure}→{figureTag} + effectRefs 组装接线（声明行/任务行/{ref}/输出行/MATERIAL_ROLE_DESC）；byteEq 内联快照再生（文件头注再生日）+ 受牵连测试字面同步；UI 徽标/说明句/Dropzone 文案同步；vitest：prompt 族 + effectRef 族回归

## 4. 点 4：蓝图参考图预览

- [ ] 4.1 TemplateAdvancedOptions refs 行缩略（getUrl 懒解析）+ 点击预览 Dialog + 空态引导 + missing 占位；vitest：缩略渲染/点击预览/移除回归（沿 4.2 picker 测试基建）

## 5. 点 5：画幅必选

- [ ] 5.1 表单必填标记（勾选退役、未声明提示）+ startRun fail-fast（水钻开而画幅缺 → 中文错误）；vitest：fail-fast 矩阵 + 表单标记 + 既有画幅提交回归

## 6. 点 6：高级请求参数编辑器

- [ ] 6.1 lib/lab/advancedParams.ts（注册表 + parse/serialize + 尺寸组）；vitest：序列化序/未知键保留/值字面量 parse 矩阵/尺寸字符串兼容
- [ ] 6.2 AdvancedParamsEditor.svelte（tabs 三页 + 可视化控件 + 自定义行 + 尺寸双 input + 快选 Dialog）+ VariantEditor 接线（裸 textarea/size input 退役）；vitest：三页切换/双向同源/非法不落库/快选回填

## 7. 收尾

- [ ] 7.1 `pnpm check` 0 错 + lab 全族回归全绿；红 solo 复跑定性；收据（icon 理由/字面变更清单/注册表与尺寸清单/偏离清单）落报告
