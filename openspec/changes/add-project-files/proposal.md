# Add Project Files（排钻项目 .gemproj / 精修项目 .gemdoc）+ 排钻页改名 + 两页重构

## Why

排钻页与手动编辑页的全部工作状态都是模块级内存 $state（studio.svelte.ts / edit.svelte.ts）：刷新即丢、跨会话无法续作。素材库解决了图片资产的真源，「工作成果」仍无真源。同时手动编辑唯一入口绑死排钻页「送精修」（Owner 定性 concept error——库内一张图想逐钻精修必须先过调参之旅）；「转化工作台」是管线内部词，无行业直觉且与 app 名共享「工作台」三字（移动端 Tab 被迫退化成泛称）。

## What Changes

- **两种项目文件格式**（规范性设计：`.agents/documents/2026-09-19-project-file-formats/project-format-and-redesign.md`，下称 PM 稿）：
  - 格式 1 `.gemproj` 排钻项目 = **参数工程**：只存来源图引用/内嵌 + 参数全集；钻位永不入文件，打开 = 引擎确定性重放；`engineVersion` 漂移横幅；来源缺失可重绑续命
  - 格式 2 `.gemdoc` 精修项目 = **烘焙文档**：gems 全量 + 只读 blocks + 内嵌 PNG 底图，自包含独立可开
  - 格式 1 → 格式 2 导出（「导出为精修项目」，与送精修共用同一烘焙构造函数）
- **素材库扩展**：AssetProject 节点（内容寻址 blobKey；**保存 = 换绑新 blob，资产不可变契约对项目节点显式豁免**）；系统目录「项目」；引用保护第 ④ 类（打开中的项目 pin 其 source/reference）；「全部素材」口径纳入项目节点；点击 = 对应页面打开
- **改名**：「转化工作台」→「排钻设计」（移动端「排钻」）；「送转化」→「送排钻」全量联动（PM 稿 B.3 措辞表）；「送精修」不变
- **排钻设计页项目生命周期**：空态（最近项目）/新建未命名/打开中/干净/dirty(●+⌘S)/另存为(fork)/关闭/来源缺失重绑/引擎版本横幅/守卫三分法（切 Tab 不守卫、刷新 beforeunload、页内破坏性动作三按钮确认）
- **手动编辑页解绑**：空态重设计——「从素材库选图 → **快速排稿**（默认参数一次性烘焙，lib/edit/quickLayout.ts 直连 computeClient，不经 studio store）」直入；打开 .gemdoc；dirty 口径替换 hasEdits（撤销栈永不序列化）
- **实验室格式对**（[Owner 2026-09-19] 新增）：
  - `.gemtpl` 模板 = 提示词模板（提示词体 + 案例参照绑定 + 默认值），存素材库，实验室左侧模板面板**不再硬编码**，改为从素材库选取（内置 preset 一次性 seed 为模板资产）
  - `.gemgen` 生成结果 = 单次生成的自包含档案（图片内嵌 + 溯源：模板资产/提示词快照/参考图/任务元数据）；**「生成结果」目录归档从裸图片换成 .gemgen**
- **实验室任务画廊重构**：从仅「全部」升级为按 tpl（模板资产）分组管理/过滤；卡片增加**展开/收起**两态（收起=小图预览行，展开=大图+动作）；双击 `.gemtpl` → 实验室 + 画廊按该 tpl 过滤；双击 `.gemgen` → 实验室 + 左侧自动关联对应 tpl + 画廊过滤并**滚动定位到该结果且展开**
- **App 层**：.gemproj/.gemdoc/.gemtpl/.gemgen 全局导入（file input + drop → 按类型路由：前两者切对应页，后两者进实验室）

## Impact

- 新建：`lib/persistence/projectFile.ts`（两格式 serialize/parse/formatVersion 迁移链唯一出口）、`lib/edit/quickLayout.ts`
- 扩展：assetStore（AssetProject + ingestProjectAsset + blobKey 换绑 + sys-projects + sys-templates + 保护④ + projectKind 四分化）、library/AssetsView（type-aware 过滤/计数 + 项目卡片 + 双击路由）、studio store（项目生命周期挂接，参数集零改动）、edit store（serialize/deserialize + dirty）、**lab store/画廊/模板面板（库化重构 + .gemtpl/.gemgen 挂接）**、StudioContextBar（重写）、EditView（空态重写）、App.svelte（改名 + 导入 + beforeunload）、引擎新增 `ENGINE_VERSION` 常量（只增常量与 bump 纪律，不改算法）
- 不动：引擎算法与确定性语义、实验室模块（仅「送排钻」文案）、送精修烘焙原则本身、素材库图片节点不可变契约
- 依赖关系：add-asset-library（已实现）/ redesign-studio-layout / add-manual-edit-mode 的既有接口为消费面；本 change 不回改它们的行为
