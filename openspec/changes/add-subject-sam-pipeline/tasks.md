# Tasks: 主体分割与多元贴钻内核

> 决策源：owner-directive-20260924.md（原话冻结）。阶段间可部分并行；每波实现走 remix 评审闭环。

## P0 契约与工件（先行，零模型依赖）

- [x] P0.1 contracts：ObjectTree/ObjectNode schema（§3）+ SceneAnalysis/StrategyAssignment/代码策略工件 schema + canvasCm 一等输入 + blockIds 接受 nodeId——Zod 冻结+测试
- [x] P0.2 daemon：ObjectTree→Block[] 适配器（mask 同构+effectiveMm/labVariance 回填+origin 标注）+ pixelsPerMm 推导——等价测试
- [x] P0.3 daemon：停止判据纯函数（尺寸/色容差/硬顶——§2）——确定性单测（构造已知节点）
- [x] P0.4 daemon：object-tree 工件持久化+树视图叠加预览图产出（人看图双轨）

## P1 策略面（可与 P2 并行）

- [x] P1.1 参数化几何族扩展：星射线/心/圆/矩/椭圆/螺旋（参数 schema 冻结+预览确定性测试）
- [x] P1.2 语义拟合族 v1：纹理亮暗（scatter/flow）+ 柔和曲线（骨架线）+ 花形（极坐标分解）——各≥1 真实 fixture
- [x] P1.3 排除族：drillWorthy 开关贯穿（排布跳过+BOM 未贴区明示）
- [x] P1.4 **自由代码族（最高优先）**：JS worker 沙箱（注入面=mask/标度/钻规格/几何库/Rand(seed)；无网无 fs；CPU/时有界）+ 输出 Zod 校验+强制引擎校验门+非法输出有界重试回 LLM+同 seed 回放——沙箱逃逸面审查（评审重点）
- [x] P1.5 策略注册表：四类统一接口 `apply(node, params|code, canvas) → Gem[]`（引擎五策略降级为基础族成员）

## P2 识图管线（macmini 桥）

- [ ] P2.1 macmini 侧服务：spike.py 底座改常驻（stdin/stdout JSON 协议）+ SAM3 几何/语义双提示面 + 版本上报 + 启停脚本
- [x] P2.2 daemon `sam-bridge.ts`：SSH 长连接+队列（并发 1）+120s 界+产物回传 BlobStore+输出留存目录（叠加图+meta）——mock 桥单测
- [ ] P2.3 VLM 全图分析工具 `scene.analyze`（经 LLM 路由；glm 视觉系候选；mock 单测+opt-in 真连）
- [ ] P2.4 迭代抠图循环 `subject.segment`：首轮=S2 元素、后续=宽泛语义；停止判据内嵌；vlmReentry 接口位（默认 false）——循环状态机单测
- [ ] P2.5 降级：桥不可达→一键模式（颜色结构分块）——对齐 §6.4 门测试
- [ ] P2.6 opt-in macmini 真连冒烟：分析→抠图全链留存+vision 子代理审查留档

## P3 策略设计器与 Agent 旅程（W4.3 重排承载）

- [x] P3.1 `strategy.design` 工具：LLM 输入 ObjectTree+钻规格+风格提示（styleId 预留）→ StrategyAssignment proposal → 授权桥审批
- [ ] P3.2 策略层 UI：左对话右实时画布+图层树面板+每层策略/参数编辑（图层级，禁单钻）+逐节点预览开关
- [ ] P3.3 旅程验收：「把这棵柳树按枝条贴」→ 树已备 → strategy.design/patch → 审批 → flow 纹理策略应用 → 合成预览

## P4 后续（不阻 P0-P3）

- [ ] P4.1 SAM3 中文/贴钻域词表 v1+版本化；部件级分解实测校准（对照停止判据）
- [ ] P4.2 艺术家风格多版本候选（styleId 全链路）
- [ ] P4.3 Python 沙箱调研（JS API 面不足时启用）

## 验收门

- 全链（mock 桥）：分析→迭代抠图→object-tree→LLM 策略→四类策略混合执行→合并导出；BOM 按节点分组可核对
- 一键模式回归与今日一致；自由代码非法输出零逃逸；引擎零改动收据；三包门禁基线不变
