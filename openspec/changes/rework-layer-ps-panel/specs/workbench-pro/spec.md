## ADDED Requirements

### Requirement: 父层恒不产钻（v5 Owner 裁定）

可贴钻节点 SHALL 恒为叶子节点（无 children）；中间节点（组）不论 drillWorthy SHALL 不产钻、不产块、无策略指派入口（工作台直改 typed 拒 node-not-leaf）。既有父层指派在读面 SHALL 降级标注失效且 execute 重算跳过。

#### Scenario: 嵌套不叠钻

- **when** 图层被拆分为子图层 → 仅子图层可套钻；父层策略指派被拒
- **when** 执行重算 → 父层旧指派不产块（与子层钻无重叠叠排）

### Requirement: PS 图层面板复刻（v5）

左栏 SHALL 复刻 Photoshop 图层面板语义：顶部=最上层（z 序逆序）；行=眼睛/真实抠图缩略/名称（双击重命名）/锁定；有钻布局的叶子行 SHALL 显示 fx 徽标（钻=图层特效——不占树行）；组行带展开三角（缩略=子层拼合）；底部操作条（拆分/删除/展开/收起）。

#### Scenario: 面板操作

- **when** 面板首行 → 画布最上层（根背景层固定最底）
- **when** 双击行名 → 就地重命名（Enter/Esc 收尾）
- **when** 点击 fx 徽标 → 右栏定位该层钻详情
