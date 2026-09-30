# Design：材料故事闭环重构

## 1. 信息架构裁定

后台资源管理两分区（外部/对内的语义分界是 Owner 指令的核心）：

```
资源管理
├── 材料市场（外部 · 管理员维护 · 全账号共享）
│   └── 单一视图（无顶部 tab）：
│       左栏分组树 = 供应商（钻型树，现有）+ 「组合」分区（系统组合列表）
│       右侧网格   = 钻样卡（默认）/ 所选组合的成员钻卡
│       左栏组合分区头部：「添加组合」按钮 → CreateSetDialog
└── 我的材料（对内 · 账户私有）
    └── 三子区（面板内二级导航，同设置分区 list-detail 形态）：
        ├── 我的贴砖组合：组合卡片列表（成员数/更新时间）+ 创建（复用
        │   CreateSetDialog，owner=本人）+ 编辑/删除
        ├── 我的文件：现 AssetsLibAdmin 文件管理原功能，去 IndexedDB 迁移
        └── 我的任务：任务行列表（会话标题/任务状态/时间/产物入口链接）
```

**理由**：组合的本质是「材料的分组」（Owner 前次裁决）——它属于哪个域取决于谁维护：
系统组合（管理员/导入）在材料市场，用户自建组合在我的材料。两侧共享同一
`sets.*` RPC 与 CreateSetDialog，仅 owner 语义不同。

## 2. 关键实现裁定

### 2.1 CreateSetDialog（公共组件，波 2 由材料市场子代理产出）

- 位置：`components/stones-admin/CreateSetDialog.svelte`（材料市场为主场景）。
- 形态：Dialog 三段式——名称输入；钻挑选器（搜索框+结果多选列表，数据走
  `stones.tree/query` 现有读面；选中项带数量输入，默认 0=「按设计用量另计」）；
  提交调 `sets.create`（成员=StonePick 快照语义——服务端已实现）。
- 两处复用：材料市场左栏「添加组合」（owner=admin）、我的材料「创建组合」
  （owner=当前账户）。owner 由挂载方传参，不在 Dialog 内猜。

### 2.2 材料市场左栏组合分区（StonesAdminView 侵入改造）

- 左栏树下方新增「组合」段（可折叠，与供应商树同视觉语言）：组合行=名称+成员数。
- 点组合行 → 右侧网格切换为该组合成员钻卡（复用现有钻卡网格渲染，数据走
  `sets.get`）；再点供应商节点 → 回钻型树网格。选中态互斥。
- WarehouseView/StonesLibraryPanel 从后台退役（dev 旗标旧工作台入口不动）。

### 2.3 我的材料三分区壳

- AdminPage 资源区「我的材料」挂载点：新薄壳 `MyMaterialsPanel.svelte`
  （顶部三 pill 子导航：我的组合/我的文件/我的任务——形态照设置分区移动端
  pill 条，桌面同款顶部横条；三区均满高链组件内滚）。
- 「我的文件」子区=AssetsLibAdmin 零逻辑改动挂载（去 IDB 后）。

### 2.4 我的任务读面

- 数据面：`sessions.list`（本人域；admin 视角全量）现有 RPC——若列表投影缺
  任务状态/产物入口字段，读面用 `tasks.detail` 惰性补（daemon 零改优先；
  仅当 sessions.list 无任务行投影时才在 daemon 加只读投影，最小入参）。
- 呈现：行列表（会话标题/最新任务状态徽标/时间/进入会话链接=跳前台会话）。
  只读：不做后台任务操作（取消/清理属前台会话域）。

### 2.5 预览 80% contains（横切，两处网格）

- 素材卡（AssetsLibAdmin）与钻样卡（StonesAdminView 网格）：图片容器
  `aspect-square` 内 `object-contain`，且图片渲染尺寸放大至容器的 80% 宽/高
  （`w-[80%] h-[80%] mx-auto my-auto object-contain` 或等价——小源图（44×44
  贴图）放大充满、大图 contain 不裁切）。
- 素材缩略同时加 `raw?w=600` 缩放参数（服务端 raw 面已支持 w——15MB 原图
  不进缩略格，点开 raw 直链仍是全分辨率）。

### 2.6 废弃 IndexedDB 迁移

- 删 AssetsLibAdmin「从本浏览器导入」按钮+迁移 Dialog+migrateToServer import；
  `lib/persistence/migrateToServer.ts` 文件保留与否：若前台无引用则删文件，
  有引用则仅断开后台入口（以 grep 引用为准）。空态文案去掉「可从本浏览器导入」。

## 3. 风险

- **StonesAdminView 侵入**是首次破坏「零改动挂载」约束——左栏与网格的数据源
  切换要守住现有钻型浏览行为不回归（聚焦测试+全量回归）。
- CreateSetDialog 的钻挑选器在 992 款库上必须走服务端搜索（stones 读面
  现有 query 过滤），严禁一次拉全量渲染。
- 「我的任务」不得引入后台任务写操作——故事里归档是只读回看。

## 4. 波次

| 波 | 交付 | 依赖 |
| --- | --- | --- |
| W1 骨架 | 改名两分区；材料市场去 tab 直挂 StonesAdminView；我的材料三分区壳（组合/任务占位空态+文件区实装）；预览 80% contains；废弃 IDB 迁移 | 无 |
| W2a 市场组合 | 左栏组合分区+成员网格切换+CreateSetDialog（含单测） | W1 |
| W2b 我的内容 | 我的组合（复用 CreateSetDialog）+我的任务读面 | W1、W2a 的 Dialog |
| W3 走查 | vision 真机走查故事闭环四环 + 提交换装 8317 | W2a/W2b |
