# 设计：效果提示词占位符体系

> 紧凑稿。Owner 原话见 proposal.md；本文件只落裁决、口径与测试面。
> 标注 **〔可推翻〕** 的条目是主会话冻结裁决，Owner 审阅可推翻——推翻后按新裁决重开对应切片。

## 0. 术语与顶层模型

```
模板 (.gemtpl v2)
├── promptBody ─────────── 主提示词（用户正文；可含 0..3 个效果占位符）
├── caseBinding ────────── 案例绑定（assetId + caseLayout；结构面，位置不变）
├── caseRef? ───────────── 案例参照图功能开关 {enabled, promptFragment?}   ← 新可选键
├── drillParams? ───────── 水钻参数配置 {enabled, specs, physical?, promptFragment?}  ← +fragment
└── blueprint? ─────────── 蓝图效果 {enabled, refs?, promptFragment?}      ← +fragment

run 时主提示词组装：
  promptBody ──(占位符→片段原文替换)──▶ 模板特化体 ──▶ composeDrillPrompt 既有骨架
  片段 = promptFragment(用户覆盖) ?? 既有生成器(自动)
```

占位符字面量（冻结，中文全角方括号）：`【案例参照图提示词】` `【水钻参数提示词】` `【蓝图效果提示词】`。

## 1. 三开关 × 占位符行为矩阵（裁决 1/4/7）

| 效果开关 | 占位符 | 结果 |
|---|---|---|
| 开 | 存在 | 占位符被片段（覆盖 ?? 自动）**原文替换**，注入位置 = 用户书写位置 |
| 开 | 缺失 | 效果正文**不注入**（不静默追加——旧「段尾自动插入」通道退役）；发起面板一次性提示 |
| 关 | 存在 | 占位符**原样保留**〔可推翻：保留让用户可见自己写的结构〕 |
| 关 | 缺失 | 无事发生（= 现状） |

- **红线**：三开关全关且 promptBody 无占位符 → `composeDrillPrompt` 输出与改造前逐字节相等（prompt.byteEq.test.ts 继续绿）。
- 附图/图号声明/任务行等结构面不变（裁决 6）：案例开 = 案例图随请求附送 + 角色声明 + 任务行引用（既有管线）；占位符只控制**正文文本**注入。
- 案例片段激活条件 = 案例开关开 **且** 绑定有效（实际附图）；水钻 = drillParams 启用（enabled⇒specs≥1 既有门）；蓝图 = blueprint 启用。
- 蓝图占位符在主提示词中的替换同样生效（用户显式放置 = 选择让主图请求携带蓝图片段；不放置则主图请求零变化——§2.1 纯净性对未放置者保持）。〔可推翻〕

## 2. Schema（裁决 8 前半；可选键不 bump formatVersion）

`.gemtpl` v2 新增可选键（读写双侧校验 + round-trip 字节等价；脏输入 typed error 沿既有防线）：

```
caseRef?:    { enabled: boolean, promptFragment?: string }
drillParams?: { ..., promptFragment?: string }
blueprint?:   { ..., promptFragment?: string }
```

- **〔可推翻·实现口径〕** caseRef 不内嵌 caseBinding 副本（brief 原文 `caseRef?: {enabled, caseBinding 现结构, promptFragment?}`）：绑定唯一真源保持在顶层 `caseBinding` 键（既有全部消费面零改动、无双真源）；「现结构」解读为「绑定结构/位置不变」。
- 读面归一（消费层，不入文件）：`caseRef` 缺席 + `caseBinding != null` → 开关视为**开**（旧模板零行为变化——已绑定案例继续附送，开关 UI 显示开，可手动关）；`caseRef` 缺席 + 无绑定 → 关。
- promptFragment 校验：可选 string（空串合法=空覆盖；UI 侧保存空文本 = 清除覆盖剥键）。

`.gemgen` v2 provenance 新增可选键 `fragmentSources?: { case?: 'auto'|'override', drill?: 'auto'|'override', blueprint?: 'auto'|'override' }`——仅记录**实际发生替换**的效果（审计：片段使用记录）。

## 3. 组装引擎（纯函数，`src/lib/lab/prompt.ts`）

```
substituteEffectPromptPlaceholders(body, plan): body'
  plan: { caseRef?: {text}, drillParams?: {text}, blueprint?: {text} }
  规则：plan 有键 → body.replaceAll(占位符, text)；plan 无键 → 占位符原样保留
```

`composeDrillPrompt(templateBody, roles, options)` 扩展（两参形态输出逐字节不变）：

- options 增：`casePromptFragment?: string`（案例覆盖文本；替换激活 = roles.hasCase）、`blueprintPrompt?: {text}`（蓝图预解析片段；替换激活 = 键存在）。水钻覆盖 ride 在 `options.drillParams.promptFragment`（任务侧快照天然携带）。
- 自动片段生成源（缺席覆盖时）：案例 = CASE_DESC[caseLayout]（角色声明文案，effectRefs 既有常量）；水钻 = `buildDrillSpecSection`（在 order 已知的组装器内部物化——交叉引用图号正确）；蓝图 = `composeBlueprintPrompt`（由调用侧按任务上下文预生成后以 `{text}` 传入）。
- **旧「段尾自动注入」退役**：`specSection` 恒不再独立成段（SEGMENT_ORDER_MAIN 常量注记退役语义，消费面仅文档性）；水钻正文只经占位符进入。

任务侧快照（`lab.svelte.ts`）：`LabTask.casePromptFragment?`（案例覆盖）；`pendingDrill.promptFragment?`（物化透传 → `drillParams.promptFragment`）；`LabTaskBlueprint.promptFragment?`（蓝图覆盖，蓝图 stage 请求提示词 = 覆盖 ?? composeBlueprintPrompt 自动骨架）。

## 4. UI（裁决 2/5；TemplateAdvancedOptions 三段 + 共享 Dialog）

- 三段开关行：`Switch` + 标签 + **铅笔 icon button**（`@lucide/svelte/icons/pencil`，testid `effect-prompt-edit-<effect>`）。案例段收纳现 EffectRefControl 选图面（三 tab 沿用），仅当案例开关开时可用（关灯不丢绑定——数据保留，同水钻关灯语义）。
- `EffectPromptDialog.svelte`（共享）：textarea 预填「自动生成文案」（打开时按当前模板配置尽力生成，标注为预览——发起时按实际附图序/任务上下文物化）+ 三 action：
  - **保存** = 存片段覆盖（空文本 = 清除覆盖）+ 关窗；
  - **取消** = 丢弃编辑 + 关窗；
  - **插入到提示词** = 保存片段 + 向主提示词插入占位符（**幂等**：已存在不重复；位置 = 光标处，无光标信息追加末尾）+ 关窗。
- 主提示词 textarea（TemplateEditor 的 promptBody 位）持有光标上下文：TemplateEditor 向 TemplateAdvancedOptions 传 `insertIntoPromptBody(text)` 回调（读 textarea selectionStart）。模板为 8000 截断上限沿既有（超长插入按截断口径）。
- 发起面板（RunBar）：可用模板中「开关开而主提示词缺对应占位符」的效果 → 派生提示行（testid `placeholder-missing-hint`，文案如「水钻参数配置已开启但主提示词缺少占位符」，逐效果逐模板列出；非阻断，条件消除即消失——「一次性」= 提示不重复弹 toast、不阻断发起）。〔可推翻：一次性语义取派生常驻Hint而非toast〕

## 5. 模板 v2 预设与旧内置处置（裁决 8 后半）

- v2 预设：`src/lib/presets/` 新增 v2 文案表（基于 EFFECT_REF_PRESETS 派生：域名指导句保留 + 追加 `【案例参照图提示词】` 占位符示例行）；seed 节点 id = `ast-tpl-<原id>-v2`，`provenance.presetId = <原id>-v2`，caseBinding **复用** v1 预设已物化的合成图资产（同 presetId 幂等物化，不重复建图），`caseRef = {enabled: true}`。
- 旧内置软删（`retireUnmodifiedBuiltinTemplates`，seed 之后执行）：命中条件（store/文件可判定的最小口径，全部满足才删）——`provenance.source='builtin-seed'` 且 `provenance.presetId` ∈ 旧 preset id（非 -v2） 且 `promptBody === preset.prompt`（逐字节） 且 `candidates === 2` 且 `caseBinding != null`（seed 恒绑定；解绑 = 用户编辑痕迹） 且 v2 新键全缺席（drillParams/blueprint/gemSpecIds/caseRef）。已修改的保留；user-created/forked 零触碰。
- 安全门：仅当对应 v2 节点**已存在**（本轮 created 或 create-only 命中）才软删旧节点（防 v2 seed 失败掏空模板库）；软删 = trashAsset（回收站可找回）。

## 6. 改名（裁决 9）

- UI 全部「参考图」/「参考原图」→「原图」（界面文案、注释、测试断言；跨 lab/studio/edit/assets 全域——同一资产流）。TERMS v4：词条「参考图」→「原图」（禁用词：参考图、参考原图、底图）+ 版本注；「案例参照图」词条补「功能开关」语义。
- **不改名**（冻结例外，grep 收据白名单）：① 模型面提示词骨架常量与快照（`REFERENCE_FIGURE_LABEL='参考图'`、DRILL_RULES、byteEq/compose 内联快照）——零行为红线（裁决 7）优先，提示词字节不得漂移；②「蓝图参考图」（不同概念）；③ TERMS 历史注记。
- 已知残余歧义登记：案例参照图 Dialog 内的「原图」（案例合成图的原图半边）与全局「原图」（目标图）同名不同指——上下文区分，Owner 可裁决改其一。〔可推翻〕

## 7. 测试矩阵

| 面 | 断言 |
|---|---|
| substitution 纯函数 | 替换/多占位符/无占位符原样/关灯保留/plan 缺键不动 |
| 红线 | 三开关全关 + 无占位符 → 与旧输出逐字节相等（含 prompt.byteEq 既有套件） |
| 组装 | 开+占位符=替换进模板体且不再有独立段尾注入；开+缺占位符=无该正文；水钻覆盖文本逐字节替换 |
| Dialog | 打开预填自动文案；保存=覆盖落键；取消=丢弃；插入=幂等（已存在不重复）+光标/末尾 |
| schema | caseRef/promptFragment round-trip 字节等价 + 脏输入 typed error + 缺席键零迁移 |
| seed v2 | v2 增量 create-only；未修改旧内置软删；修改过保留；v2 失败不软删 |
| 改名 | 源码扫描（非测试面）无「参考图/参考原图」残留（白名单：prompt 骨架常量文件、TERMS） |
| 回归 | lab 全族 + assets labFile 族 + app.smoke |

## 8. 裁决点与解释性偏离清单（供 Owner 推翻审阅）

1. **〔可推翻〕开关关 + 占位符存在 → 保留原样**（主会话冻结）：字面占位符会随请求发给模型；备选 = 剥除。
2. **〔可推翻〕提示词骨架不改名**：「参考图」→「原图」仅 UI 面；模型面 `【图二：参考图】` 等字节冻结（裁决 7 红线优先）。若 Owner 要模型面同步改名，需接受 byteEq 基线重采。
3. **〔可推翻〕caseRef 不内嵌 caseBinding**（见 §2）：避免双真源；brief 字面形状为内嵌。
4. **〔可推翻〕旧模板兼容读面**：caseRef 缺席 + 有绑定 → 开关视为开（零行为变化）；备选 = 视为关（基础形态收紧，存量模板案例即刻停送）。
5. **〔可推翻〕「一次性提示」实现为 RunBar 派生 Hint**（非 toast、非阻断）。
6. **〔可推翻〕蓝图占位符替换也作用于主图请求**（brief 裁决 4 字面直读）；备选 = 蓝图片段只进蓝图 stage 请求、主提示词中蓝图占位符保留原样。
7. **〔可推翻〕案例片段激活 = 开关开且绑定有效**（无绑定时开关开也不注入正文、不提示缺失）。
