# prompt-lab Delta —— improve-lab-advanced-ux

## ADDED Requirements

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

## MODIFIED Requirements

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
