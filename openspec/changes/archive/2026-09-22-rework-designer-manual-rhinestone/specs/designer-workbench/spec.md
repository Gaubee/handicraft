# Delta: designer-workbench（rework-designer-manual-rhinestone）

## ADDED Requirements

### Requirement: 水钻贴图渲染与状态反馈
画布钻渲染 MUST 使用 `.gemshape` 目录纹理资产（texture dataUrl 经离屏烘焙为 sprite； CatalogSpec/资产层零改动消费）。渲染 MUST 预烘焙并按态选择帧：normal=贴图+柔投影、hover=投影增强+亮度微升、selected=发光描边+投影——hover/选中以渲染态变化提供即时视觉反馈（canvas 语境的 `backdrop-filter: shadow` 对应实现）。sprite 缓存 MUST 键于 specKey+dpr+态（+colorId 若采用着色案）；资产缺失 MUST 回退几何符号并走既有错误通道。性能 MUST 保持单次 drawImage 路径（渲染循环零逐钻 filter 计算）。SVG/BOM 导出面 MUST 零改动。

#### Scenario: 纹理渲染与选中反馈
- **WHEN** 画笔落下两颗 SS10 圆钻并选中其一、悬停另一颗
- **THEN** 两颗均以纹理 sprite 渲染（非纯色圆），选中颗带发光描边帧、悬停颗带增强投影帧

### Requirement: 笔刷流量与面积落子
笔刷 MUST 以圆盘 footprint（直径默认=当前规格直径、可调大）按**扫过面积**落子：吸附开=六方格位与笔刷圆盘交集的增量结算，吸附关=沿笔迹 pitch 间隔+圆盘碰撞；流量（0-100%）MUST 作为格位保留概率；落子 MUST 通过既有钻与本笔迹批内的碰撞检查。宽带笔刷（直径>2×钻径）一次拖动 MUST 铺出多列钻（「笔刷不是点」验收锚）。橡皮 MUST 以同一 footprint 批量擦除圆盘内所有可删钻。笔刷直径 MUST 可经 `[` `]`（画笔/橡皮工具下）与读数 popover 调节，光标 footprint 预览即时反映。

#### Scenario: 宽带笔刷面积落子
- **WHEN** 笔刷直径设为规格直径 3 倍并横向拖过空白区
- **THEN** 落钻覆盖扫过的整条宽带（多列六方排布），无碰撞违规，一次拖动为单个撤销组

### Requirement: ⌘T 自由变换态
选中（单颗或多颗）后 ⌘T MUST 进入自由变换态：包围盒四角柄=缩放（语义=批量改尺寸）、外柄=旋转；Enter 确认（单 patch 单撤销组）、Esc 取消；Shift=等比/15° 步进；顶栏实时读数。**尺寸变更 MUST NOT 移动钻位、MUST NOT 触发重排或重吸附**（位置恒相对参考图像素——invariant 测试冻结）。单选专用旋转/直径手柄 MUST 退役，变换交互统一归 ⌘T。round-only 选集旋转值恒 0。

#### Scenario: 多选批量改尺寸不挪位
- **WHEN** 框选 5 颗钻 ⌘T 拖角柄放大 20% 后 Enter
- **THEN** 5 颗钻尺寸字段增大、角度不变，全部 (x,y) 与变换前逐位相等，一次撤销恢复整组

## MODIFIED Requirements

### Requirement: PS 惯例键位与命令同源
键位 MUST 遵循 PS 惯例并全表落地：工具单键 V/B/E/H/Z 与空格临时抓手；⌘Z/⌘⇧Z（⌘Y）撤销重做；⌘C/⌘X/⌘V（原位偏移一格）；Delete 删除（单颗直删+可撤销，≥2 颗批量确认）；⌘D/Esc 取消选择；方向键三档微移；**`[` `]`=笔刷直径 -/+（画笔/橡皮下，Shift=粗档）**；**⌥`[` ⌥`]`=旋转 ±15°（⇧=5°）**；**⌘T=自由变换态**；⌘+/⌘-/⌘0/⌘1 视图；⌘⇧N/⌘E/⌘[ ]/⌘⇧[ ] 图层操作；⌘S/⌘⇧S 保存/另存。输入控件聚焦时 MUST 放行全部快捷键。快捷键、右键菜单、面板按钮 MUST 收敛到同一命令总线（禁第二实现）。

#### Scenario: 笔刷直径键
- **WHEN** 画笔工具下连按 ] 两次
- **THEN** 笔刷直径读数与光标 footprint 预览增大两档，未选中钻不受影响
#### Scenario: 工具单键切换
- **WHEN** 画布聚焦时依次按 B、E、V
- **THEN** 当前工具切换为画笔、橡皮、选择，进行中的框选与笔刷读数被丢弃
#### Scenario: 旋转步进键
- **WHEN** 选中一颗方形钻按 ⌥]
- **THEN** 该钻顺时针旋转 15°；按 Shift+⌥] 为 5°；连续按键在一个按键会话组内（一次撤销恢复整组）〔rework §3.3：[ ] 已让渡笔刷直径，旋转改 ⌥[ ⌥]〕

### Requirement: 指针交互清单
画布指针交互 MUST 覆盖：滚轮光标锚缩放（10%–1600%）、空格/中键平移、双击空白 100%⇄适配、双击钻定位属性面板、右键两态菜单（选中态：复制/剪切/粘贴/删除（≥2 颗批量确认）/对齐分布/移入图层/改规格；空态：粘贴/画幅设置…/适配/100%——**智能排布项已退役**）；框选空白起、**Shift+框选=并入、Alt+框选=从选区减去**；Alt+拖钻=复制；⌘T 变换态手势。图层面板行交互（选层/重命名/眼睛/锁/孤立显示/拖排）保持。

#### Scenario: Alt 框选减选
- **WHEN** Shift 框选 6 颗后再 Alt 框选其中 2 颗区域
- **THEN** 选集收敛为 4 颗，Alt 框选不产生移动或复制
#### Scenario: 右键菜单对齐显隐
- **WHEN** 选中 2 颗钻右键、再选中 3 颗钻右键
- **THEN** 前者「对齐」子树可见而「分布」子树隐藏，后者两子树均可见
#### Scenario: 空格临时抓手
- **WHEN** 画笔工具激活时按住空格拖动画布
- **THEN** 笔刷光标临时切换为抓手，画布平移，抬指后回到画笔工具

## REMOVED Requirements

### Requirement: 智能排布工具

〔rework R1 退役——Owner 2026-09-21 裁决：智能排布应基于选区/路径（预留 add-designer-selection-paths）；UI 能力整体移除，钻数组内核冻结为内部资产（design §5），不再作为用户面 requirement〕
