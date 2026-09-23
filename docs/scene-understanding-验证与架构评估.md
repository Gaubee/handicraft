# Scene Understanding 架构验证与评估（2026-09-23）

> 依据：Owner 与 ChatGPT 的架构讨论（自称不准确需验证）+ 本会话四轮 web 验证。结论分「已证实/待实测/评估采纳」三档。

## 1. 事实核验（ChatGPT 文档的声明 vs 实证）

| 声明 | 核验结果 | 来源 |
|---|---|---|
| SAM 3 存在，文本概念提示直接出 box+mask | ✅ **真**——SAM 3（2025-11，arXiv 2511.16719）提出 Promptable Concept Segmentation：文本/示例图提示 → 检测+分割+跟踪全部实例；开源含 checkpoint | [arXiv](https://arxiv.org/abs/2511.16719) / [facebookresearch/sam3](https://github.com/facebookresearch/sam3) / [Ultralytics 文档](https://docs.ultralytics.com) |
| SAM 3.1（多对象/提速） | ✅ 真——2026-03-27 发布，实时视频与可及性改进 | [Meta AI 公告](https://ai.meta.com) |
| SAM 3 取代 GroundingDINO→SAM 两段式 | ✅ 成立——概念提示直出 box+mask 即两段合一 | 同上 |
| 本地 checkpoint 可用 | ✅ 真（官方仓库+HF） | [sam3 repo](https://github.com/facebookresearch/sam3) |
| 许可 | ⚠️ **修正**：非 Apache 2.0——自定义 SAM License（社区许可）：**商用允许**，限军事/ITAR/核/制裁与 >700M MAU 条款；我们民用工艺工具场景合规 | [LICENSE](https://github.com/facebookresearch/sam3/blob/main/LICENSE) / [issue #262](https://github.com/facebookresearch/sam3/issues/262) |
| Apple Silicon 可行性未知 | ✅ **重大利好**：`mlx-community/sam3-image` MLX 移植已存在（M 系原生、含文本提示分割）；内存多 GB 级，16GB+ 可跑、32GB 理想——**我们 darwin-arm64 优先的平台路线与它对上**；16GB 实机性能仍待实测 | [mlx-community/sam3-image](https://huggingface.co) |
| 客户四模型栈=上一代拼装 | ✅ 与我方配置采集结论一致（GroundingDINO+SAM2+YoloWorld+Florence 全在场且为加密黑盒） | docs/客户工作流分析报告.md |

## 2. 架构评估（采纳与修正）

**采纳（写入 Phase 2 方向）**：
1. **Scene Graph 为核心资产**：Image → Scene Graph → Elements[]（id/category/role/mask/parent/children/decomposable/importance）——这不只是检测管线的中间结构，它就是我们 agent 编辑所需的**区域语义模型**：对话里的「帽子/花环/标题字」直接寻址 element，替代我此前「首版用图层当区域」的权宜方案（图层仍是 W4 过渡，长期归 Scene Graph）
2. **单模型优先+置信度门控的多模型按需补充**（不确定才调第二个）——对普通游戏本/本地跑目标是对的；不作四模型全跑
3. **AI/确定性边界**：理解（VLM+SAM3）→ Scene Graph → 贴钻策略（agent/DSL：density/edgeWeight/emphasis…）→ 几何引擎（我们确定性引擎）→ 生产包——与我们 capability/agent 架构严丝合缝：Drill Strategy DSL ≈ patch-propose 工具的参数面
4. 递归分解的 decomposable 判据（不必全拆）与 Object Resolver 去重（IoU 合并）作为管线组件采纳

**修正**：
- Florence-2 当 Scene Interpreter 偏弱——我们已有 LLM/agent 基建，Scene Graph 生成可直接用更强 VLM（经既有模型路由），Florence-2 降为候选
- 「拆素材」与「贴钻」分层成两个产品能力的论断采纳，但注意对我们而言两者共享同一 Scene Graph 资产与 agent 入口，不是两个产品

## 3. 落位（不打乱当前节奏）

- **不并入 add-backend-platform**（Codex 评审进行中）——此为 Phase 2（图像理解管线）的方向文件，届时另立 change（暂名 add-scene-understanding）
- **首个实验（成本低、决定性强）**：平台 W1 落地前后，在 Owner 的 Mac 上做 SAM3-MLX spike——用 mlx-community/sam3-image 跑 ~/Downloads/20x20/ 四张原图，文本提示 hat/person/wreath/sleigh 等，量测：耗时/峰值内存/mask 质量（与 30x30 生产包的已知区域对照）。一晚出结论，直接决定 Phase 2 用 SAM3-MLX 还是走远程 GPU 适配器

## 4. 开放项

- SAM 3.1 MLX 移植是否跟进（社区 MLX 包当前对应 SAM 3 基线——spike 时核）
- 16GB 实机吞吐与批量 4 图的耗时预算（对齐客户 2min/图 的体验基线）
