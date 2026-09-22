# design —— improve-lab-advanced-ux

主会话冻结裁决（标注〔可推翻〕处为代理可自行反转的决策；其余按裁决执行）。

## 1. icon 更换（点 1）

- 选 `TextQuote`（lucide `text-quote`）：图形 = 文本行 + 引号，语义「提示词/文本片段」，区别于 Pencil 的「编辑」泛义。备选 MessageSquareText（对话气泡，偏聊天语义）不取。〔icon 选型可推翻〕
- 按钮感三件：`variant="outline"`（边框）+ 悬停态（shadcn button 自带）+ `title` tooltip「编辑提示词片段」+ `aria-label`（含效果名）。testid `effect-prompt-edit-*` 保持不变（测试面稳定）。

## 2. 开关即注入/移除（点 2）

- 纯函数落 `lib/lab/prompt.ts`：
  - `appendEffectPromptPlaceholder(body, effect)`：已含占位符（任何位置）→ 原样返回；否则 `${body 去尾换行}\n${占位符}\n`（空 body → `${占位符}\n`）——Owner 默认插入式 `\n【占位符】\n`。
  - `removeEffectPromptPlaceholder(body, effect)`：删掉「整行只有该占位符」的行（带走该行换行 = 连同紧邻包裹换行），再 `replaceAll` 剥除行内残存出现（用户移进句中的占位符只剥文本）。
- 接线在 `TemplateAdvancedOptions` 三 toggle（开 → `append`；关 → `remove`），与效果键**同一 `submitTemplateField` patch**（`promptBody` + 效果键一次提交，单次落盘）：
  - 案例：`toggleCase` 双向。
  - 水钻：`addSpec` 首规格点亮 `enabled=true` 时注入；`toggleDrill(false)` 移除；空清单 pendingOpen 中间态不注入（enabled 未落）。
  - 蓝图：`toggleBlueprint` 双向。
- `EffectPromptDialog`：删 `onInsert` prop 与「插入到提示词」按钮，Footer = 取消/保存；`placeholderAlreadyPresent` 提示保留但改中性文案（「主提示词已含 X」）。`TemplateEditor.insertIntoPromptBody` 回调链退役删除；主提示词 placeholder 文案改「开启效果开关时自动插入/移除占位符」。
- 手动删占位符而开关开 → 不回注（RunBar 既有缺失提示兜底）。

## 3. 附图显式编号 `[image #N]`（点 3）

- 新冻结字面（v2）：图号引用标签 = `【图N [image #N]：角色名】`（例 `【图一 [image #1]：案例参照图】`）——同时保留「图N」中文概念与 Owner 建议的 `[image #N]` 写法，单一真源 `figureTagOf(ordinal, label)` 落 `lib/lab/prompt.ts`。〔双概念并存的字面形态可推翻（可改为纯 `[image #N]`），功能语义不可〕
- 常量改造：`SPEC_LIST_LINE_CUSTOM_ATTACHED` / `BLUEPRINT_CUSTOM_REF_CLAUSE` / `BLUEPRINT_SERIAL_TASK` 的 `{figure}` 占位升级为 `{figureTag}`（完整标签）；`composeDrillPrompt` 角色声明行 / 任务行 / 规则 `{ref}` / 输出行 / `MATERIAL_ROLE_DESC` 全部走 `figureTagOf`。
- byteEq 红线性质保持：三关全关 + 无占位符 = **新基线**逐字节稳定（`prompt.byteEq.test.ts` 内联快照同步再生，文件头注明再生日与依据）；受牵连测试（prompt.compose/service/contract/placeholder/blueprint、effectRef、gemgenArchive、lab.store、stagePipeline）断言字面同步。
- UI 徽标：`EffectRefControl` 徽标与说明句改 `[image #N]` 写法（`图${figure}` → `[image #${ordinal}]`）；`Dropzone` 序号说明同步。

## 4. 蓝图参考图预览（点 4）

- refs 行 = 缩略图按钮（素材库 `getUrl(assetId)` 懒解析 objectURL；undefined=解析中、null=blob 失效占位图标）+ 计数徽标保持；点击缩略 → 预览 Dialog（大图 + 资产 id 只进 title/alt 与角注，不做正文）；空态文案引导「从素材库选」；每行保留移除按钮。

## 5. 画幅必选（点 5）

- 表单：勾选退役；`drillOn` 时恒显宽高 input + 「必填」标记；`physical` 未声明 → input 空 + placeholder（210/148）+ 必填提示（`drill-physical-required`）；两值均合法才提交。
- 发起：`startRun` 对 `drillParams.enabled===true && physical===undefined` 的模板 fail-fast：`水钻参数配置需要画幅物理尺寸（模板「{name}」）`。〔错误文案带模板名可推翻为纯裁决原文〕
- 写入门不加 enabled⇒physical（保持「首规格入单即点亮」流；读面宽容旧档）。

## 6. 高级请求参数编辑器（点 6）

- 新 `lib/lab/advancedParams.ts`（纯函数 + 注册表，solo 可测）：
  - 已知字段注册表（可扩展）：`quality`(select auto/high/medium/low) / `background`(auto/transparent/opaque) / `output_format`(png/jpeg/webp) / `output_compression`(number 0-100) / `n`(number ≥1) / `moderation`(auto/low) / `input_fidelity`(low/high)。〔注册表成员集可推翻〕
  - `parseSizeString('1024x1536') ⇄ {width,height}`（旧载荷兼容回填）；`SIZE_PRESET_GROUPS`：1:1 [1024×1024]、3:2 [1536×1024]、2:3 [1024×1536]、7:4 [1792×1024]、4:7 [1024×1792] + 当前输入非标值入「自定义」组。
  - 序列化：已知字段按注册表序 + 未知键原序，`JSON.stringify(obj, null, 2)`。
- 新组件 `AdvancedParamsEditor.svelte`（VariantEditor 高级折叠组内容替换）：
  - Tabs：可视化（默认）/ JSON 预览（只读 pre）/ JSON 编辑（textarea 草稿；合法才 `updateForm({advancedJson})`，非法行内错误不落库）。
  - 可视化：已知字段控件（未设 =「默认」哨兵 = 键缺席）；未知键 = key-value 行（key 只读展示 + value 输入 JSON 字面量，严格 parse 非法行内错误；行可删）+ 新增自定义键行；尺寸 = 宽高 number input + `frame` icon-button → 快选 Dialog（比例分组 chips）。
  - 双向同源：唯一存储 = `form.advancedJson`（字符串）+ `form.size`（字符串）——可视化与 JSON 页都从同一 parse 派生，写路径各自 serialize 回 form（store/持久化/请求体零改动）。
- 旧 textarea 与 `wwwwxhhhh` 手写面删除；`parseAdvancedJson` 仍为解析底座。

## 纪律

- 每点：聚焦 solo vitest → `git commit` 显式路径（repo 根 `/Users/kzf/Pictures/贴钻`，禁 amend），信息 `feat(lab-ux) <点号>：<摘要>`。
- 不跑全量；收尾 `pnpm check` 0 错 + lab 族回归；红 solo 复跑定性；不起 dev server。
- 禁改设计师域（components/Designer、lib/designer、EditView、documentService）/engine/persistence（labFile 占位符 change 已收尾）。
