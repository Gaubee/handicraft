# prompt-lab Specification

## Purpose
定义从原图到"贴钻层数字油画"候选的生成工作流：提示词变体管理、并发生成、分组展示与预览、以及 BYOK 网络层的可观察行为。

## Requirements

### Requirement: BYOK 连接配置

系统 SHALL 允许用户配置任意 OpenAI 兼容 baseUrl、apiKey 与模型名（自由文本），并仅持久化于浏览器 localStorage。构建产物中 SHALL NOT 内联任何 apiKey。

#### Scenario: 中转站 baseUrl

- **WHEN** 用户填入非官方的中转站 baseUrl 并生成
- **THEN** 请求发往该 baseUrl 对应的 `/images/generations` 或 `/images/edits`，响应同时兼容 `data[0].url` 与 `data[0].b64_json`

#### Scenario: 连接测试

- **WHEN** 用户点击连接测试
- **THEN** 系统向 `{baseUrl}/models` 发起 GET 并展示可达性结果，失败时区分网络错误与鉴权错误

### Requirement: 提示词变体组生成

系统 SHALL 支持编辑一组提示词模板（模板 = .gemtpl 库资产：提示词特化体 + 案例参照绑定 + 正交高级选项），并对每个"模板 × 候选"发起独立的单图生成请求（请求体 `n` 恒为 1），以可配置并发上限并行执行。组装进 composeDrillPrompt 骨架的模板正文 MUST 先经效果占位符替换（按「效果提示词占位符体系」条款执行）；主提示词输入框 MUST 支持效果占位符的光标位插入（幂等）。

#### Scenario: 分组批量生成

- **WHEN** 用户上传原图并对 3 个模板各设 2 候选发起生成
- **THEN** 系统发出 6 个独立请求，画廊按批次分组展示 6 张候选，每组内含各自的状态/耗时/错误信息

#### Scenario: 单候选失败重试

- **WHEN** 某候选请求失败且用户点击重试
- **THEN** 仅该候选重新发起请求，输入的原图无需重新上传，其余候选不受影响

#### Scenario: 占位符替换后组包

- **WHEN** 模板正文含【案例参照图提示词】且案例开关开，发起生成
- **THEN** 组装进请求的模板特化体中该占位符已被案例片段原文替换（替换语义按「效果提示词占位符体系」条款）

### Requirement: 高级参数逃生舱

系统 SHALL 提供 Advanced JSON 输入，其内容合并进请求体原样透传（含 `background: "transparent"`、`quality`、`seed` 等），不做白名单校验；upstream 报错 SHALL 原样展示给用户。

#### Scenario: 透明背景参数

- **WHEN** 用户在 Advanced JSON 填入 `{"background":"transparent","output_format":"png"}` 并生成
- **THEN** 请求体包含这两个字段；若端点不支持，错误信息原样展示且不重试

### Requirement: 候选预览与送转化

系统 SHALL 提供候选的放大预览，支持与原图的叠加模式（透明度可调）与并排模式；任一候选 SHALL 可一键送入转化工作台作为输入。

#### Scenario: 叠加比对

- **WHEN** 用户打开某候选的叠加预览并拖动透明度滑杆
- **THEN** 候选图与上传原图实时混合显示，用于判断风格化选择的偏差

### Requirement: 持久化与配额降级

生成图片 SHALL 写入 IndexedDB；任务与设置 SHALL 写入 localStorage，且在配额不足时按"全量 → 去 payload → 仅最近 50 条"三级降级，任何情况下 SHALL NOT 因配额异常丢失设置。

#### Scenario: 刷新恢复

- **WHEN** 用户刷新页面后回到实验室
- **THEN** 历史候选从 IndexedDB 恢复显示，BYOK 设置保持

### Requirement: 效果提示词占位符体系

实验室的三个正交效果开关（案例参照图 / 水钻参数配置 / 蓝图效果）MUST 各自拥有一个效果提示词片段（`promptFragment`：缺席时由既有生成器自动生成，用户在 Dialog 编辑后存储为覆盖文本）与一个全角方括号占位符（`【案例参照图提示词】`/`【水钻参数提示词】`/`【蓝图效果提示词】`，字面量冻结）。run 时主提示词（模板 promptBody）中的占位符 MUST 被对应效果片段**原文替换**（注入位置由用户书写决定）；效果开启而占位符缺失时该效果正文 MUST NOT 注入（MUST NOT 静默追加到其它段落——段尾自动注入通道退役），发起面板 MUST 给出提示；效果关闭时已存在的占位符 MUST 原样保留。三开关全关且 promptBody 无占位符时，`composeDrillPrompt` 输出 MUST 与本 change 前逐字节相等。附图与图号声明等结构面 MUST NOT 因占位符体系变化（占位符只控制正文文本注入）。

#### Scenario: 开 + 占位符 → 原文替换
- **WHEN** 模板开启水钻参数配置，promptBody 中书写「……【水钻参数提示词】……」，发起生成
- **THEN** 主提示词中该占位符被【尺寸与钻规格】段全文替换（用户覆盖片段时为覆盖文本逐字节），输出不再含独立段尾注入
#### Scenario: 开 + 占位符缺失 → 不注入并提示
- **WHEN** 模板开启蓝图效果但 promptBody 无【蓝图效果提示词】，发起面板可见
- **THEN** 发起面板显示「蓝图效果已开启但主提示词缺少占位符」类提示（非阻断），主提示词不含蓝图文案
#### Scenario: 关 + 占位符存在 → 原样保留
- **WHEN** 模板关闭案例参照图开关，promptBody 中仍有【案例参照图提示词】，发起生成
- **THEN** 主提示词原样保留该占位符字面量，案例图不随请求附送
#### Scenario: 零行为红线
- **WHEN** 三开关全关且 promptBody 无任何占位符
- **THEN** composeDrillPrompt 输出与 change 前逐字节相等（既有字节等价测试保持绿）

### Requirement: 效果提示词 Dialog 与插入动作

每个效果开关旁 MUST 有明显的 icon button 入口（非铅笔图形——采用文本/引号语义图标；带边框、悬停态、tooltip 与 aria-label），点击展开共享 Dialog：textarea 预填按当前模板配置自动生成的提示词（预览口径，发起时按任务上下文物化）+ 保存/取消两 action。保存 MUST 持久化片段覆盖（空文本 = 清除覆盖）；取消 MUST 丢弃编辑。占位符注入/移除由效果开关自动完成（见「效果开关即注入/移除占位符」），Dialog 不承担插入动作。

#### Scenario: 入口可辨识
- **WHEN** 用户查看高级选项区
- **THEN** 每开关旁的提示词入口呈现为带边框按钮，tooltip/aria-label 表明「编辑提示词片段」
#### Scenario: 插入幂等
- **WHEN** 主提示词已含【水钻参数提示词】，用户关闭再重新开启水钻参数配置开关
- **THEN** 主提示词不重复注入占位符（自动注入幂等）——〔语义随迁注记〕原「插入到提示词」按钮的幂等语义随六点反馈（开关即注入/移除）迁移至开关自动注入路径，Dialog 不再承担插入动作
#### Scenario: 编辑保存与取消
- **WHEN** 用户在 Dialog 修改自动文案后分别执行保存 / 取消
- **THEN** 保存后再次打开回显修改文本（覆盖态）；取消后覆盖不落、回显仍为自动文案

### Requirement: 案例参照图功能开关

案例参照图 MUST 从必选绑定改为与水钻参数配置同款的功能性开关（`.gemtpl` v2 可选键 `caseRef`，绑定结构保持在顶层 caseBinding 键）：开关开 = 案例图随请求附送 + 角色声明 + 案例片段可注入；开关关 = 不附送（绑定数据保留，选图配置面仅开关开时可用）。`caseRef` 键缺席且存在有效绑定的旧模板 MUST 读面视为开关开（存量行为零变化）。模板 v2 内置预设（presetId `<原id>-v2`）MUST 增量 seed（create-only，案例绑定复用既有合成图资产）；未被用户修改的旧内置模板 MUST 软删（最小口径：promptBody 与原 preset 逐字节相等 && 候选数为 seed 默认 && 绑定在 && v2 新键全缺席），已修改的与用户模板 MUST NOT 触碰；对应 v2 节点不存在时 MUST NOT 软删旧节点。

#### Scenario: 开关关灯不丢绑定
- **WHEN** 用户关闭案例参照图开关后保存，再重新打开
- **THEN** 案例绑定与片段覆盖原样保留，请求不附送案例图
#### Scenario: 旧模板兼容
- **WHEN** 打开无 caseRef 键但已绑定案例的既有模板
- **THEN** 开关显示为开，案例图照常附送（行为与本 change 前一致）
#### Scenario: v2 换代软删
- **WHEN** hydrate 时 v2 节点 seed 成功，存在未被用户修改的旧内置模板
- **THEN** 旧内置模板软删入回收站；用户修改过的内置模板与用户自建模板保留

### Requirement: 「参考图」改名「原图」

用户可见文案（含注释与测试断言口径）中指代待处理目标图的「参考图 / 参考原图」MUST 统一改为「原图」（TERMS v4 词条登记 + 版本注）。模型面提示词骨架常量与字节等价快照（如【图N：参考图】）MUST NOT 改动（零行为红线优先）；「蓝图参考图」为不同概念 MUST NOT 误改。

#### Scenario: 界面清零
- **WHEN** 扫描源码非测试用户可见文案
- **THEN** 无「参考图 / 参考原图」残留（例外白名单：模型面骨架常量、TERMS 历史注记、字节快照测试文件、蓝图参考图）

### Requirement: 提示词组合所见即所得

提示词组合器（composeDrillPrompt 族）MUST 收敛为「占位符替换 + 附空缺省不动」单语义：除用户模板正文与用户可见的效果片段外，MUST NOT 向发送提示词注入任何隐藏内容（人设前言、图序声明块、任务指令行、固定指导规则块、正文包裹壳、输出指令行整体退场）。WYSIWYG 公理（byteEq 红线）：三效果开关全关且 promptBody 无占位符时，发送提示词 MUST 与 promptBody **逐字节相等**。图序声明（图一 [image #1]=案例参照图、图二 [image #2]=原图 等多图介绍）MUST 由案例参照图片段的默认（auto）内容承载——按实际活跃附图集生成，用户在效果提示词 Dialog 中可改可清空，清空即不发送任何图序说明（用户明确选择）。固定贴钻指导规则（DRILL_RULES）MUST 并入 v2/v3 内置模板 seed 正文尾部（可见、逐模板可编辑可删；seed 为 create-only，已被用户修改的模板 MUST NOT 重播规则尾；既有用户模板正文 MUST NOT 触碰）。发起前终稿预览与实际发送 MUST 同源（同一组合器同一次计算——所见即所发）。

#### Scenario: WYSIWYG 公理（零注入红线）

- **WHEN** 三个效果开关全关且模板 promptBody 不含任何占位符，发起生成
- **THEN** 实际发送的提示词与 promptBody 逐字节相等（无人设前言、无图序声明块、无任务/输出指令行、无指导规则块、无正文包裹壳；既有字节等价测试保持绿）

#### Scenario: 图序声明由案例片段默认内容承载

- **WHEN** 案例参照图开关开启且 promptBody 含【案例参照图提示词】占位符，发起生成
- **THEN** 占位符被替换为按实际活跃附图集生成的图序声明默认文案（图一 [image #1]=案例参照图、图二 [image #2]=原图 与简短参照任务句）；用户在效果提示词 Dialog 修改或清空该片段后，发送内容随之逐字节反映（清空 = 不发送任何图序说明）

#### Scenario: 固定指导规则入 seed 正文且改过不重播

- **WHEN** 内置模板 v2/v3 seed hydrate（create-only），且某内置模板正文已被用户修改过
- **THEN** 新 seed 模板正文尾部含【贴钻指导规则】段（可见可编辑可删）；已修改的内置模板不被重播规则尾、既有用户模板正文不动（自然失去注入正是 WYSIWYG 语义）

#### Scenario: 终稿预览与实际发送同源

- **WHEN** 用户在发起区展开「最终请求提示词」预览后发起生成
- **THEN** 预览全文与实际发出的请求提示词出自同一组合器同一次计算（同输入同输出，无第二组装路径）

### Requirement: 效果开关即注入/移除占位符

效果开关（案例参照图 / 水钻参数配置 / 蓝图效果）开启时，若主提示词（promptBody）尚无该效果占位符，系统 MUST 以 `\n【占位符】\n` 形态自动追加到 promptBody 末尾（占位符已存在于任何位置则不动）；关闭时 MUST 自动移除该占位符的全部出现（连同整行包裹换行；行内出现只剥占位符文本）。效果提示词 Dialog 的动作 MUST 收敛为 保存/取消（「插入到提示词」动作退役——自动注入取代）；用户仍可在主提示词中自由移动占位符文本。占位符被手动删除而开关开启时 MUST NOT 自动回注（沿发起面板既有缺失提示）。

#### Scenario: 开关开 → 自动注入
- **WHEN** 主提示词为「正文」且无【水钻参数提示词】，用户开启水钻参数配置（首规格入单点亮）
- **THEN** promptBody 变为 `正文\n【水钻参数提示词】\n`（与效果键同一次提交落盘）
#### Scenario: 开关关 → 自动移除
- **WHEN** promptBody 为 `A\n【蓝图效果提示词】\nB`，用户关闭蓝图效果
- **THEN** promptBody 变为 `A\nB`（该行连同换行移除，数据键保留）
#### Scenario: 占位符已存在 → 不动
- **WHEN** 用户已把占位符移进句子中间（如「见【案例参照图提示词】这里」），再次开-关-开案例开关
- **THEN** 开启时不重复插入；关闭时仅剥除占位符文本本身，句子其余文字保留

### Requirement: 附图显式编号 [image #N]

提示词骨架中的图号引用字面 MUST 更新为 `【图N [image #N]：角色名】` 形态（如 `【图一 [image #1]：案例参照图】`），同时保留中文「图N」概念与 `[image #N]` 写法；UI 附图徽标与说明 MUST 同步 `[image #N]` 写法（案例参照图=`[image #1]`、原图=`[image #2]`，素材与蓝图参考顺延）。三开关全关且 promptBody 无占位符时，`composeDrillPrompt` 输出 MUST 相对新字面逐字节稳定（byteEq 基线同步再生）。

#### Scenario: 角色声明与交叉引用
- **WHEN** 附图 = 案例 + 原图 + 一张自定义素材，发起生成
- **THEN** 角色声明行含 `1. 【图一 [image #1]：案例参照图】：…`；清单行交叉引用含 `素材见【图三 [image #3]：钻石素材图·<code>】`
#### Scenario: UI 徽标同步
- **WHEN** 案例已绑定且原图已上传，打开模板编辑器
- **THEN** 案例缩略角标显示 `[image #1]`、原图行说明以 `[image #2]` 指称其请求序号

### Requirement: 蓝图参考图预览

蓝图效果的参考图列表 MUST 以图片缩略呈现（素材库懒解析 objectURL）+ 计数；点击缩略 MUST 打开预览 Dialog；资产 id MUST NOT 作为正文展示（只进 title/alt 与角注）；空列表 MUST 引导选择；资产失效（blob 缺失）MUST 显示占位图标态。

#### Scenario: 缩略与预览
- **WHEN** 模板蓝图 refs 含两张有效资产，展开蓝图表单
- **THEN** 可见两张缩略图与 `2 / 2` 计数；点击任一缩略弹出大图预览
#### Scenario: 资产失效
- **WHEN** 某 ref 资产 blob 已缺失
- **THEN** 该缩略位显示占位图标（不显示裸 asset id），移除按钮仍可用

### Requirement: 高级请求参数结构化编辑

高级请求参数 MUST 提供 Tabs 三页：可视化编辑（默认）/ JSON 预览（只读）/ JSON 编辑。可视化页 MUST 基于常用 OpenAI images 字段注册表（quality / background / output_format / output_compression / n / moderation / input_fidelity 等，注册表可扩展）提供专属控件（未设 = 键缺席）；未知字段 MUST 呈现为可删减的自定义 key-value 行，value 输入 MUST 使用 JSON 字面量表达（严格 parse，非法 → 行内错误且不落库）。尺寸 MUST 由宽高两个 number input 编辑（不手写 `WxH` 字符串），旁置 icon-button MUST 打开快选 Dialog（按比例分组平铺尺寸 chips = OpenAI 标准尺寸集 + 自定义已输入值）。JSON 页与可视化页 MUST 双向同源（同一 parse/normalize；JSON 非法 → 错误态不落库）。既有字符串 size 载荷 MUST 兼容回填双 input。

#### Scenario: 可视化编辑已知字段
- **WHEN** 用户在可视化页将 quality 设为 high、background 设为 transparent
- **THEN** JSON 预览显示两键（注册表序）；请求体合并这两字段
#### Scenario: 自定义字段非法值不落库
- **WHEN** 用户添加自定义键 `seed`，value 输入 `abc`（非法 JSON 字面量）
- **THEN** 该行显示行内错误，form.advancedJson 不含该修改
#### Scenario: 尺寸快选
- **WHEN** 用户点击尺寸旁 icon-button，在 3:2 组选择 1536×1024
- **THEN** 宽高 input 回填 1536/1024，form.size = `1536x1024`
#### Scenario: 旧载荷回填
- **WHEN** 恢复会话时 form.size 为既有字符串 `1024x1536`
- **THEN** 宽高 input 分别回填 1024 与 1536

### Requirement: 画幅物理尺寸必选

水钻参数配置开启时画幅物理尺寸 MUST 为必填：表单呈现必填标记（勾选式可选声明退役），`startRun` 对「水钻参数配置开启而画幅未声明」的模板 MUST fail-fast 并给出中文错误（「水钻参数配置需要画幅物理尺寸」）；蓝图效果不做此强制。

#### Scenario: 发起拦截
- **WHEN** 某启用模板水钻参数配置开但 physical 缺失，用户点击开始生成
- **THEN** run 不发起，显示「水钻参数配置需要画幅物理尺寸（模板「{name}」）」类错误
#### Scenario: 蓝图不强制
- **WHEN** 某启用模板仅开启蓝图效果（无水钻参数配置）
- **THEN** 画幅缺失不拦截发起
