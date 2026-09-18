# layout-engine Specification

## Purpose
定义数字油画到合法钻位的确定性转化：分块、密度语义、排布算法族（构造式 + 收敛式）、颜色映射、硬约束校验与导出。

## Requirements

### Requirement: 自动分块

系统 SHALL 将输入的数字油画经 Lab 空间颜色量化（k 可配）与连通域分析切分为 Block 列表，每个 Block SHALL 携带位掩码、代表色、面积、包围盒与基于距离变换的宽度统计，并据此给出 fill/linear/element 类型建议（用户可覆写）。

#### Scenario: 少色扁平图分块

- **WHEN** 输入一张 6 色闭合面域的数字油画
- **THEN** 产出的 Block 数量与人工可辨的色块区域一致，每个 Block 的代表色落在其色域内

### Requirement: 块级密度控制

系统 SHALL 为每个 Block 提供独立密度参数 d（0 < d ≤ 1），且任一策略下该块钻数随 d 单调不减；界面 SHALL 实时显示每块与全局的预估钻数。

#### Scenario: 密度滑杆单调

- **WHEN** 用户将某块密度从 1.0 降到 0.5 再降到 0.25
- **THEN** 该块钻数逐级不增，其余块的钻数不变

### Requirement: 排布算法族

系统 SHALL 提供至少五种可互换策略：六方定距+蓝噪声抽稀、六方 pitch 调制、Poisson disk、语义混合（骨架链+填充）、密度场 CVT 点画；并 SHALL 提供可开关的松弛后处理（边界一维 Lloyd、斥力修复）。全部策略与松弛钩子 SHALL 输出统一的 Gem 结构并可同屏对比渲染。

#### Scenario: 五策略同屏

- **WHEN** 用户在对比视图载入同一分块结果与密度设置
- **THEN** 五种策略各自渲染一帧钻位预览，互不影响，可逐个放大

#### Scenario: CVT 密度连续性

- **WHEN** CVT 策略下相邻两块的密度设为 0.6 与 0.7
- **THEN** 两块交界处钻距呈连续过渡而非阶跃跳变

### Requirement: 排布硬约束

任何策略（含松弛后）的输出 SHALL 满足：任意两钻中心距 ≥ pitch（浮点容差内）；钻心落于所属 Block 掩码内（由此天然无半钻）。校验失败且无法修复的残留 SHALL 以 warning 呈现并阻止导出。

#### Scenario: 松弛后校验

- **WHEN** 开启 repulsion 松弛后仍存在间距违规对
- **THEN** 导出按钮禁用并逐条列出违规详情

#### Scenario: 确定性重放

- **WHEN** 同一输入图、分块参数、策略、密度与 seed 重复运行两次
- **THEN** 两次产出的 Gem 列表逐位相同

### Requirement: 颜色映射与导出

系统 SHALL 将 Block 代表色经 Lab ΔE 最近邻映射到可编辑色板（内置起步色板），并 SHALL 导出按色分层的 SVG、BOM 清单（色 × 尺寸 × 数量）与预览 PNG；BOM 计数 SHALL 等于钻位总数。

#### Scenario: BOM 对账

- **WHEN** 用户导出 SVG 与 BOM
- **THEN** SVG 中圆点总数与 BOM 数量合计均等于当前 Gem 总数
