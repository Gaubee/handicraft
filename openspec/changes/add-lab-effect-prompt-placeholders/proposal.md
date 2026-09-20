# 效果提示词占位符体系（add-lab-effect-prompt-placeholders）

## Why

- **Owner 2026-09-20 原话（忠实落档，本 change 的需求真源）**：

  > 「现在的提示词实验室里面的这些模板有明显的问题，都是旧版的，我说过，任何参数的输入最终都应该当做是提示词的一部分作为注入。像我说的，水钻参数配置和蓝图效果这些新效果都是。那么也就意味着这些效果都应该有一个 textarea 来显示要注入的提示词。并且我们需要在主提示词输入框中插入一个简短的占位提示词，可以用特殊的符号将它框选起来。这些想法具体到页面上的交互，应该是每一个效果提示词，入口都应该是一个铅笔形状的 icon button，点击后它会展开一个 Dialog 带有 textarea 和一些 actions，里面是我们预设的自动生成的一份提示词。这里的 actions 会包含保存、取消以及插入到提示词这个功能。插入到提示词这个功能会在主提示词里面插入一段占位符，如果已经存在这个占位符，那么就不会重复插入。比如说占位符是【蓝图效果提示词】。最后，最重要的就是我们的案例参照图。它本身也是一个功能，所以我希望你把它作为一个独立的开关作为插入，就跟我们的水钻参数配置一样，它是一个功能性开关，而不是必选的，所以它也有提示词插入能力。最后我想改『参考图』这个名字，把它改成『原图』。」

- 源码现状：水钻参数配置与蓝图效果的注入位置**硬编码在组装器内部**（`buildDrillSpecSection` 恒插在模板体之后、`composeBlueprintPrompt` 完全独立于模板体——`rhinestone-studio/src/lib/lab/prompt.ts` / `src/lib/presets/effectRefs.ts`），用户不可见、不可控、不可改写；案例参照图是**必选绑定**（`caseBinding != null` 即随请求附送，无功能开关）；「参考图」术语与用户心智（该图实为待处理的原图）相悖。
- 内置模板为旧版预设（无占位符、案例必绑、无效果提示词面），需要以 v2 预设增量换代。

## What Changes

- **三个正交效果开关**：案例参照图（原必选绑定 → 功能开关，与水钻参数配置同款）/ 水钻参数配置 / 蓝图效果。基础形态 = 原图（原「参考图」改名）+ 主提示词。
- **占位符记号**（中文全角方括号，冻结字面量）：`【案例参照图提示词】` `【水钻参数提示词】` `【蓝图效果提示词】`——run 时主提示词（模板 promptBody）中的占位符被对应效果片段**原文替换**，用户控制注入位置。
- **片段双态**：每效果 `promptFragment`——缺席时由既有生成器自动生成（案例 = 案例角色声明文案；水钻 = `buildDrillSpecSection` 现有产出；蓝图 = `composeBlueprintPrompt` 任务行/图例节），用户在 Dialog 编辑后存储为覆盖文本。
- **效果提示词 Dialog**：每开关旁铅笔 icon button → 共享 Dialog（textarea 预填自动生成文案 + actions：保存 / 取消 / 插入到提示词）。插入动作幂等（占位符已存在不重复插入；插入位置 = 主提示词光标处，无光标信息则追加末尾）。
- **组装语义**：开关开 + 占位符存在 → 原文替换；开关开 + 占位符缺失 → 该效果正文**不注入**（不静默追加），发起面板给一次性提示；开关关 → 占位符即使存在也保留原样。附图与图号声明等结构面不变（占位符只控制正文文本注入）。
- **零行为红线**：三开关全关且 promptBody 无占位符 → `composeDrillPrompt` 输出与现状逐字节相等（既有字节等价测试继续绿）。
- **旧模板处置**：内置 seed 刷新为 v2 预设（promptBody 含占位符示例 + 新版文案，presetId `<原id>-v2` 增量 seed，create-only）；未被用户修改的旧内置软删（按 store 可判定的最小口径）；已修改的保留；用户模板零触碰。
- **改名**：UI 全部「参考图」→「原图」（含 EffectRefControl/发起面板/测试断言/注释）；TERMS v3→v4（改名词条登记 + 版本注）；「案例参照图」词条补「功能开关」语义。

## Impact

- 扩展：`src/lib/lab/prompt.ts`（substitution 纯函数 + `composeDrillPrompt` 消费）、`src/lib/presets/effectRefs.ts`（组装接线）、`src/lib/persistence/labFile.ts`（.gemtpl v2 可选键 `caseRef` / `drillParams.promptFragment` / `blueprint.promptFragment`，不 bump formatVersion；.gemgen provenance 片段使用记录）、`src/lib/stores/templates.svelte.ts`（record/patch/快照扩展）、`src/lib/stores/lab.svelte.ts`（startRun 快照 + runStage 组装 + 案例开关）、`src/components/Lab/TemplateAdvancedOptions.svelte`（三开关 + 铅笔）、新组件 `EffectPromptDialog.svelte`、`src/components/Lab/TemplateEditor.svelte`（EffectRefControl 收纳 + 光标插入回调）、`src/components/Lab/RunBar.svelte`（占位符缺失提示）、`src/lib/lab/templateSeed.ts`（v2 增量 seed + 旧内置软删）、`src/lib/presets/`（v2 预设文案）、TERMS.md。
- 格式影响：`.gemtpl` v2 新增**可选键**（读写双侧校验，旧文件零迁移）；`.gemgen` v2 provenance 新增可选片段使用记录键。
- 不做：蓝图策略/生命周期模型（add-lab-drill-params-and-blueprint 域）、画廊重构、砖石目录、提示词骨架既有文案改写（`REFERENCE_FIGURE_LABEL` 等冻结常量保持——见 design §8-2）。
