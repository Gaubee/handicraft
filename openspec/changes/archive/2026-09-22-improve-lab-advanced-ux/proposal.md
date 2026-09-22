# 提示词实验室高级体验六点（improve-lab-advanced-ux）

## Why

- **Owner 2026-09-21 试用反馈（六点原话，忠实落档，本 change 的需求真源）**：

  > 1.「每个高级功能的提示词开关，不要用pencil这个icon，换一个，目前这个体现不出提示词，更像是"编辑"，让人感觉没有意义，甚至看不出是icon-button，还以为是icon而已」
  > 2.「只要是开启了开关，默认就直接注入提示词占位符到提示词中，而不是需要手动注入，同理在关闭开关的时候，就自动移除，默认插入方式是：\n【占位符】\n」
  > 3.「案例参照图 这里要非常明确地使用"图一"这种概念，或者你可以用`[image #1]`这种写法」
  > 4.「蓝图效果这里显示成：蓝图参考图 2/2 …63cfac47 …35894345——我完全看不懂什么意思，你至少给一个蓝图预览不是吗？这里不该是图片预览吗？」
  > 5.「画幅物理尺寸 不该是可选，而是必选」
  > 6.「高级请求参数，JSON + 尺寸，这里最好默认基于常用的openai images提供可视化结构化编辑（有些字段是已知的），然后通过tabs，来预览json或者直接编辑json（有些字段可能是未知的）。如果填写未知的字段，在可视化编辑这里就是体现成一个自定义的可删减的key-value，其中value始终使用JSON的字面量表达。所以尺寸也是，不要手写wwwwxhhhh，而是提供两个input，并且在旁边提供一个icon-button，点击可以展开一个Dialog，可以快速选择想要的比例对应的尺寸（以比例分组、平铺尺寸，使用chips组件）」

- 源码现状：效果提示词入口是铅笔 icon（无「提示词」语义且按钮感弱）；占位符需手动「插入到提示词」；附图编号只有中文「图N」且 UI 徽标与提示词字面混用易歧义；蓝图参考图只显示资产 id 尾巴（不可读不可预览）；画幅物理尺寸是可选勾选；高级请求参数是裸 JSON textarea + `wwwwxhhhh` 手写 size 字符串。

## What Changes

1. **icon 更换**：弃 Pencil，改 `TextQuote`（lucide）——文本+引号语义直指「提示词片段」；按钮化：outline 边框 + 悬停态 + tooltip「编辑提示词片段」+ aria-label。
2. **开关即注入/移除**：效果开关开 → 占位符缺席时以 `\n【占位符】\n` 追加 promptBody 末尾（已存在任何位置则不动）；关 → 移除该占位符全部出现（连同紧邻包裹换行）。Dialog 动作收敛为 保存/取消（「插入到提示词」退役）；占位符被手动删除而开关开 → 沿既有 RunBar 缺失提示，不自动回注。
3. **附图显式编号 `[image #N]`**：冻结骨架字面更新 `【图N：…】` → `【图N [image #N]：…】`（Owner 显式语义变更；byteEq 红线性质保持——三关全关+无占位符=新基线逐字节稳定，基线与测试同步再生）；UI 徽标与说明同步 `[image #1]`/`[image #2]` 写法。
4. **蓝图参考图预览**：refs 行改图片缩略（素材库 objectURL 懒解析）+ 计数；点击开预览 Dialog；资产 id 只进 title/alt；空态引导选择；missing 态占位图标。
5. **画幅必选**：水钻参数配置开启时画幅必填——表单必填标记（勾选退役）+ startRun fail-fast「水钻参数配置需要画幅物理尺寸」；蓝图不强制。
6. **高级请求参数编辑器**：Tabs 三页（可视化默认 / JSON 预览只读 / JSON 编辑）。可视化 = OpenAI images 已知字段注册表（quality/background/output_format/output_compression/n/moderation/input_fidelity）专属控件 + 未知字段自定义 key-value 行（可删减，value 严格 JSON 字面量，非法行内错误不落库）；尺寸 = 宽高两个 number input + icon-button → Dialog 快选（比例分组 1:1/3:2/2:3/7:4/4:7，组内尺寸 chips 平铺 = OpenAI 标准尺寸集 + 自定义已输入值）。JSON 页与可视化双向同源（同一 parse/normalize；非法错误态不落库）。替换裸 textarea 与手写 size 解析（旧载荷字符串 size → 双 input 回填兼容）。

## Impact

- 扩展：`rhinestone-studio/src/components/Lab/`（TemplateAdvancedOptions / EffectPromptDialog / TemplateEditor / EffectRefControl / Dropzone / VariantEditor + 新组件 AdvancedParamsEditor）、`src/lib/lab/prompt.ts`（占位符 append/remove 纯函数 + figureTag 字面）、`src/lib/lab/advancedParams.ts`（新：字段注册表与尺寸快选数据）、`src/lib/presets/effectRefs.ts`（组装器接线）、`src/lib/stores/lab.svelte.ts`（startRun 画幅 fail-fast）、相关测试（prompt.* / effectRef / effectPromptDialog / templateAdvancedOptions / lab.store / gemgenArchive / stagePipeline 等）。
- 格式影响：无 schema 变更（.gemtpl/.gemgen 零改动；form.size 字符串仍是存储层，UI 不再手写）。
- 不做：设计师域/engine/persistence（并行代理独占）；模板 seed 文案换代；蓝图策略模型。
