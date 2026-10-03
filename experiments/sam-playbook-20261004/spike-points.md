# Spike：SAM3.1 点提示可行路径验证（add-sam-playbook ④）

- 日期：2026-10-04
- 执行：spike 子代理（三轮脚本实证 + 一轮 N9 补充，共 ~40 次真实推理）
- 测试图：`微信图片_20260921172653_27_485.jpg`（三天使 1280×1280，**拥抱交叠构图**——左/中/右天使身体互相重叠，底部有圣诞红球冬青叶；图内无花篮，第二目标改用红球）
- 环境：macmini `~/sam3-spike/spike-points-20261004/`，与服务同款 f16 checkpoint + `Sam3Processor(conf=0.4)`，未动产线服务/8317；所有脚本跑完即退（已验证 0 残留进程）
- 脚本：直接 import 库调 processor（`set_image` → `add_geometric_prompt`/`set_text_prompt`/原生点字段注入 → `_call_grounding`），完全镜像产线 `do_segment` 的调用路径

---

## 1. points 库面结论：**底层可包装**（协议矩阵说法需修正）

协议矩阵（PROTOCOL.md:115）称「`SequenceGeometryEncoder` 有 points 配置位但无调用面」。实证后这说法只对了一半——**配置位不是摆设，是完整训练过的可用通路，只缺最上层的 append/调用方法**：

| 证据 | 位置 | 内容 |
|---|---|---|
| Prompt 类字段 | `mlx_sam3/sam3/model/geometry_encoders.py:86-101`（docstring）、`_init_point` L273-291 | `point_embeddings/point_labels/point_mask` 字段完整，零长初始化自动生成 |
| 缺失的方法 | 同文件 L297-326 | 只有 `append_boxes`，无 `append_points`（约 10 行即可补齐，逻辑与 append_boxes 对称） |
| 前向无条件消费点序列 | 同文件 `SequenceGeometryEncoder.__call__`（L580+，`_encode_points` 调用在 L629 附近） | 前向**先编码点序列再拼接 box 序列**——现状 box-only 请求就是带着零长点序列跑的 |
| 点编码器三路全开 | `mlx_sam3/sam3/model_builder.py:208-213` | `encode_boxes_as_points=False, points_direct_project=True, points_pool=True, points_pos_enc=True` |
| **checkpoint 权重在** | `service/models/sam3-image-f16/model.safetensors` 实测键 | `geometry_encoder.points_direct_project.{weight[256,2],bias}`、`points_pool_project.{weight[256,256],bias}`、`points_pos_enc_project.{weight[256,256],bias}`、`label_embed.weight[2,256]`（2 行 = 正/负标签，点框共用） |
| 调用面 | `mlx_sam3/sam3/model/sam3_image_processor.py:147-171` | `add_geometric_prompt` 只走 `append_boxes`；`_get_dummy_prompt`（sam3_image.py:445-450）建零长 box 序列 |

**spike 直接证明**：不改任何库文件，只在 spike 进程内给 `state["geometric_prompt"]` 的三个 point 字段赋值（`point_embeddings=mx.array(...).reshape(N,1,2)`、`point_labels` int64 0/1、`point_mask` (1,N) bool）后调 `_call_grounding`，前向即正常出候选——三轮 15+ 次原生点推理全部机械可行，含「文本+原生负点」「正框+原生负点」组合提示。

**结论：可行包装，无需近似。** 包装量 ≈ 30 行（`Prompt.append_points` ~10 行 + processor `add_point_prompt` ~15 行镜像 `add_geometric_prompt` + 服务 `prompt.points` 参数处理），坐标格式为归一化 `[x/W, y/H]`（与 box 的归一化 cxcywh 同尺度，见 `_encode_points` L450 注释）。

---

## 2. 微框近似点（主方案）：**否决**——微框与点是两种语义

### 2.1 正点（微框 = 点击处 s×s px 的 box 正提示）

第一轮（点击中天使上身肤色区 (645,496)，参考=文本 'angel' 检出）：

| 尺寸 | count | 最高分 | maskPx | 与参考 IoU | 实际落点 |
|---|---|---|---|---|---|
| 4×4 | 3 | 0.4882 | 795 | 0.0000 | 全部落在 [502,434,555,461]——**点击点左侧 143px 的中天使红唇**（视觉模型确认该矩形是嘴唇） |
| 8×8 | 3 | 0.4824 | 784 | 0.0000 | 同上 |
| 16×16 | 1 | 0.4632 | 777 | 0.0000 | 同上 |

第二轮（数值定位三张脸 + 红球，四目标 × 8/16/32px，最高分候选）：

| 目标(点击点) | 8×8 | 16×16 | 32×32 |
|---|---|---|---|
| 左脸 (374,221) | 238px/0.431/不含点击 | **0 检出** | 552px/0.477/含 |
| 中脸 (527,431) | 209px/0.403/含 | **0 检出** | 740px/0.823/含（=又是嘴唇小物体） |
| 右脸 (611,235) | **0 检出** | 812px/0.418/不含 | 1080px/0.660/含 |
| 红球 (503,1223) | 547px/0.566/不含(落在别的小物) | 550px/0.557/不含 | 562px/0.570/不含 |

**机制定性**：微框被模型理解为「**框住的小物体本身**」（segment the small object in this patch），不是「框下的实例」（the instance under this point）。掩膜尺寸 ≈ 微框自身大小（209-1080px），与目标实例（天使 9 万-44 万 px）差 2-3 个数量级，IoU 全程 ≈0。所有测试尺寸（4/8/16/32）一致，**不存在可用尺寸**。

### 2.2 负点（微框 boxNegative）

负微框 8×8 @ 左脸 + 文本 'angel'：**0 检出**（全部被压到 0.4 阈值以下）——不裁剪掩膜，反而全局压低置信度（见 §4）。负微框不可用。

---

## 3. 原生点提示（对照组）：**机械可行、语义可用但有粒度问题**

单正点 → 模型返回 6-11 个候选（DETR 式多 query），**含点击点的候选存在且通常排前 1-3**，但常是「部件级」（头/上半身），完整实例（文本级 blob）也在候选里但分数低：

| 点击点 | 含点击点的最优候选 | score | maskPx | 粒度 | 完整 blob 候选 |
|---|---|---|---|---|---|
| 左脸 (374,221) | cand0（rank1） | 0.536 | 15,394 | 头部 | ref2(417k px) 未入前 8 |
| 中脸 (527,431) | cand1（rank2） | 0.547 | 43,743 | 头+上身 | — |
| 右脸 (611,235) | cand0（rank1） | 0.799 | 51,581 | 头+上身 | ref0/ref2 以 0.402/0.415 挤在 rank6/7 |
| 红球 (503,1223) | cand2（rank3） | 0.811 | 8,408 | 整个红球束 | — |

双正点（右脸 + 右天使下袍 (926,868)）：掩膜从 51k → **292,616 px**（IoU 0.665 vs 完整右 blob），规模上能拼出大实例；但最高分候选**不含脸点**，且无候选同时含两点——多点有效但**不保证一致性**，桥层必须做「含全部正点」的候选筛选（filter containsClick → 按 score 取最优）。

**延迟**（f16，1280×1280）：backbone `set_image` 4.1-4.4s + grounding 0.8-2.9s ≈ 单请求 6s，与产线 A/B 数据一致；模型加载（暖页缓存）0.6-1.7s。

---

## 4. boxNegative 现状复核（playbook ② 基线）：**「✅」应降级——无空间排除效果**

PROTOCOL.md:114 的 ✅ 依据是「文本 person 框内再 box 聚焦，掩码非空」——只验证了路径通、掩膜非空，**没验证排除语义**。本轮以文本 'angel' 左 blob 检出（417,761px，实含左脸+中脸两张脸）为基线做收缩实测：

| 变体 | 检出数 | 基线类似检出 maskPx | Δ收缩 | 脸窗(160×160)移除 |
|---|---|---|---|---|
| 基线（纯文本） | 3 | 417,761 | — | — |
| 原生负点 @ 左脸（掩膜内） | 3 | 416,989 | **-772（0.18%）** | 50/23,450（0.2%） |
| 原生负点 @ 中脸（掩膜内） | 3 | 417,115 | **-646（0.15%）** | ≈0 |
| **对照：原生负点 @ 右上空背景** | 3 | 417,305 | **-456（0.11%）** | ≈0 |
| 负微框 8×8 @ 左脸 | **0**（全低于 0.4） | — | — | — |
| 负框 160×160 @ 左脸 | **0**（全低于 0.4） | — | — | — |
| 负框 = 中天使整列框（246×829） | 2 | 417,994 | **+233（反涨）** | 6px |
| （第一轮）正联合框 + 负框=邻 blob 框（纯几何） | 3 | 443,220 | +567（反涨） | — |

**三个硬结论**：
1. **负点/负框都不做空间排除**：掩膜内负点的收缩量（0.15-0.18%）与空背景对照点（0.11%）同量级＝噪声；负框甚至让掩膜微涨。负提示的真实作用是**全局微调置信度**（分数 0.847→0.828~0.839）。
2. **矛盾负框会全局压分到阈值以下**：脸上负框（无论 8px 微框还是 160px 框）+ 文本 → 0 检出。对 playbook ② 这是**陷阱用法**：用户想「排除这块」却得到空结果。
3. 对 playbook ② 的修正建议：**区域排除应在桥层做像素减法**（mask AND NOT excludeRegion），或用正提示换目标，不要指望 boxNegative 裁剪。PROTOCOL 能力矩阵该行建议改为「⚠️ 路径可用但无空间排除语义，矛盾组合可致 0 检出」。

附带证据：正负点组合（正@右脸+负@中脸，无文本）：负区候选仍在（score 0.535），最高分微升 0.799→0.826——负点只是软先验，不删候选。

---

## 5. 确定性与可复现

文本 'angel' 三检出 maskPx 在三轮独立进程间**逐位一致**（439333/92475/417761 × 3 轮），score 一致（0.8546/0.5446/0.8471）——同 checkpoint 同输入完全确定，候选级对比跨轮有效。

---

## 6. 对 ④ 实现方案的推荐：**macmini 服务改造（原生点包装）**，否决桥层微框映射

| 方案 | 判定 | 理由 |
|---|---|---|
| A. daemon 桥层微框映射 | **否决** | §2 两轮一致：微框语义=「框内小物体」，4/8/16/32px 全尺寸失效（IoU≈0、落点漂移、常不含点击点）；负微框直接 0 检出。映射层做得再对也救不了模型语义错位 |
| B. macmini 服务改造（原生点包装） | **推荐** | 模型侧权重/前向/标签嵌全在且实测可用（§1/§3）；改动 ~30 行 + 服务参数 + PROTOCOL 更新；坐标语义与 box 同尺度，桥层零换算成本（像素→归一化） |

**方案 B 的落地要点**（给 playbook ④ 的实现约束）：
1. `Prompt.append_points(points, labels, mask)` 对称 `append_boxes`（geometry_encoders.py:297 的镜像，~10 行）+ processor `add_point_prompt(norm_xy, label, state)` 镜像 `add_geometric_prompt`（sam3_image_processor.py:147，含 "visual" dummy text 逻辑）。
2. 服务面：`prompt.points: [{x, y, label}]`（像素坐标，服务内 `/W /H` 归一化），正负标签 1/0；与 text/box/boxNegative 可组合（spike 已实证组合路径可跑）。
3. **桥层必须做候选筛选**：原生点返回多候选，取「含全部正点 ∧ 不含负点」中 score 最高者；单点粒度常为部件级（头/上身），需要完整实例时用多正点（脸+身体）拉大掩膜（51k→292k 实测）。
4. **负点不要承诺排除语义**：如实标注「负点=软先验，无空间裁剪」；排除需求走桥层像素减法（顺带修 playbook ②）。
5. 返回面建议：topK 候选全给（score/maskPx/box/含点布尔），让上层做交互式精选——单点一次 ~6s，多轮点选体验可接受。

## 7. 产物留存

macmini `~/sam3-spike/spike-points-20261004/`：
- 脚本：`spike_points.py`（R1：微框 4/8/16 + union 场景 + 原生点初探）、`spike_points2.py`（R2：三脸+红球 × 原生/微框 8/16/32 + 全候选记录）、`spike_points3.py`（R3：负点/负框收缩矩阵 + 正负组合 + 对照）
- 数据：`results.json` / `results2.json` / `results3.json` / `results4.json`（N9 双正点）
- 叠加图：`out/`（R1 11 张）、`out2/`（R2 18 张）、`out3/`（R3 + n9a）
- 日志：`spike_run.log` / `spike_run2.log` / `spike_run3.log`

本地 `/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/`：上述三个脚本、results*.json、run 日志、out*/ 叠加图副本、本报告。

进程纪律：三轮 + N9 共 4 个脚本进程均自然退出，`ps` 复核 0 残留；未触碰产线服务文件、8317 fifo、venv。
