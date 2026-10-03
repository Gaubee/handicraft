# macmini SAM 服务点提示升级（add-sam-playbook ④——原生点包装）

- 日期：2026-10-04
- 执行：④ 子代理；依据 spike 报告 `../spike-points.md` §1/§3/§6（方案 B：服务原生点包装，否决桥层微框映射）
- 目标：`prompt.points: [{x,y,label}]`（像素坐标）进产线服务，与 text/box/boxNegative 可组合；topK 候选全给 + `containsPoints` 布尔，筛选留给 daemon 桥层（另批）
- 纪律执行：改前备份 ×3；只做加法（text/box/boxNegative 既有路径零行为改动，回归逐位一致实证）；只写 `~/sam3-spike/`；未动 8317/daemon

---

## 1. 改动文件清单（macmini）

| 文件 | 备份 | 改动 | diff 行数（±） |
|---|---|---|---|
| `~/sam3-spike/mlx_sam3/sam3/model/geometry_encoders.py` | `.bak-20261004` | 新增 `Prompt.append_points(points, labels, mask)`——`append_boxes`（L297）逐行镜像：None 直赋 / concat_padded_sequences 双拼（labels 与 embeddings 两段）；零长 dummy 点序列（`_get_dummy_prompt` 产物）走 concat 路径正常合并 | +29 |
| `~/sam3-spike/mlx_sam3/sam3/model/sam3_image_processor.py` | `.bak-20261004` | 新增 `add_points_prompt(points, labels, state)`（批量，**单次 grounding pass**——spike 实证多点一致性路径）+ `add_point_prompt(point, label, state)`（单点便捷面，委托前者）；含 `add_geometric_prompt` 同款 "visual" dummy text 逻辑与 `_get_dummy_prompt` 兜底 | +32 |
| `~/sam3-spike/service/sam3_service.py` | `.bak-20261004` | ① UNSUPPORTED 拒绝块 → `_coerce_points` 结构校验（1..16 项、{x,y,label} 对象、label 1/0，越界坐标与 box 同策略归一化时 clamp）；② 应用序 text→box→boxNegative→**points 批量注入**；③ 每个 detection 附 `containsPoints` 布尔（全分辨率掩膜、先于 maskMaxSide 降采样判定：含全部正点∧不含任何负点）；④ 最小 prompt 校验/label/promptKinds/文档头/SERVICE_VERSION 1.0.0→1.1.0 | +68 |
| `~/sam3-spike/service/PROTOCOL.md` | —（git 外文档，改前内容留存于本报告 §4 与本地 artifacts） | 能力矩阵 points ❌→✅；params 表 points 行；result 面 containsPoints 说明；UNSUPPORTED 词汇表、§6 自测行、§8 桥对接备注同步；新增 §6.1 点提示自测实录（实测值）；boxNegative 行加 ⚠️ 无空间排除语义注记 | 180→205 行 |

完整 diff：`points-upgrade-artifacts/macmini-diffs.txt`（三代码文件 unified diff）。

### 实现要点与 spike 的对应

- **坐标**：`/W /H` 归一化 `[x,y]`（左上原点像素入参）——与 box 的归一化 cxcywh 同尺度（`_encode_points` L450 注释），桥层零换算成本。
- **标签**：processor 层以 **bool** 存储（True=正/False=负），与 `add_geometric_prompt` 的 bool 标签同构；`_encode_points` 内 `astype(int64)` 后进共享 `label_embed[2,256]`。
- **一处 spike 外的坑（本轮实证）**：`concat_padded_sequences` 的 GPU scatter **不支持 int64**（首跑 p1-p4 全 INTERNAL：`[scatter] GPU scatter does not yet support int64`）。box 路径存活正因它传 bool。修复=processor 包装层传 bool 标签（镜像 box 约定），语义不变。spike 直注 int64 字段可跑是因为绕过了 concat——包装层走正规 append 路径才暴露此约束。
- **单 pass 注入**：N 个点一次 `add_points_prompt`（时延 5.1-5.2s 不随点数线性涨）；DETR 式多 query 候选全给，服务端不筛。

## 2. 自测数据（三天使图 1280×1280，f16 checkpoint，conf 0.4，topK=8）

harness：direct 面冷启动（`svc_points_harness.py`，macmini `~/sam3-spike/spike-points-20260904/`）。

### 2.1 回归（改前 1.0.0 vs 改后 1.1.0，同图同 prompt）

| 请求 | 改前 | 改后 | 判定 |
|---|---|---|---|
| text `angel` | 3 检出 439333/417761/92475 px，score 0.8546/0.8471/0.5446 | **逐位一致** | PASS |
| text+box [533,0,741,1144] | 3 检出 440362/421400/92676，0.9794/0.9222/0.4683 | **逐位一致** | PASS |
| 纯 box [533,0,741,1144] | 3 检出 439773/419416/91703，0.9787/0.8931/0.6906 | **逐位一致** | PASS |

（基线数字与 spike §5 跨进程确定性记录一致——439333/92475/417761 × 0.8546/0.5446/0.8471。）

### 2.2 点提示新功能

| 用例 | 结果 | spike 对照 |
|---|---|---|
| p1 纯正点 右脸(611,235) | count=7；top 0.7971/51,576px `containsPoints=true`（头+上身部件级）；完整 blob（404,881/409,660px）在列但 0.42/0.40 分 | §3 右脸 0.799/51,581 复现 ✓ |
| p2 双正点 (611,235)+(926,868) | count=2；0.4516/**292,025px** + 0.4335/212,402px；两候选 containsPoints 均 false | N9 292,616px 复现 ✓；§3「无候选同时含两点」复现 ✓ |
| p3 text+负点(528,430) | 3 检出；含负点的左中 blob 417,761→417,105（−656px≈噪声）score 0.8471→0.8334；不含负点候选 containsPoints=true | §4 C2 −646px 软先验复现 ✓ |
| p4 全组合 text+box+正点+负点 | 3 检出 top 0.9689/443,788px，7.0s | 组合路径可跑 ✓ |
| e1-e5 校验面 | label=2 / 空数组 / 缺 label / 非对象项 / 空 prompt → `INVALID_REQUEST` ×5 | — |

时延：纯点 5.1-5.2s、text+点 5.7s、全组合 7.0s（单 grounding pass，不随点数线性涨）。

## 3. PROTOCOL 能力矩阵更新行（实际落盘）

> `| 点提示（segment.prompt.points） | ✅（④ 2026-10-04） | 原生包装：Prompt.append_points（append_boxes 镜像）+ Sam3Processor.add_points_prompt（batch 单次 grounding，含 "visual" dummy text 逻辑）。f16 checkpoint 点编码权重/label_embed[2,256]/前向无条件点序列通路全在（spike-points §1）。自测见 §6.1：text/box 回归逐位一致；单点→多候选（部件级~实例级）；双正点 51k→292k px 拉大实例；负点=软先验（掩膜收缩≈噪声量级） |`

附带修正：boxNegative 行加 ⚠️（无空间排除语义、矛盾组合可 0 检出——spike §4 硬结论，顺手落档；行为未动，属 playbook ② 范畴的文档面）。

## 4. 遗留风险与桥层注意事项

1. **负点语义**（最重要）：负点=全局软先验（微调置信度），**无空间排除/裁剪语义**——PROTOCOL params 行与 §4 已如实标注。排除需求走桥层像素减法（mask AND NOT region）。
2. **「含全部正点」可能无解**：p2 实测两候选 containsPoints 均 false（右脸点不在任何掩膜内）。桥层需回退策略：取 topScore / 多数包含 / 加点重试。单点粒度常为部件级，完整实例用多正点（脸+身体）拉大。
3. **fifo 常驻进程仍是旧代码**：pid 78097（`--fifo`，Mon 起）与 stale pid 17097（Sat 起，无 --fifo 的直连残留）在内存中跑旧代码——**points 请求到 fifo 面仍回 UNSUPPORTED**，直到 `stop.sh && start.sh`。direct 面（daemon 桥 P2.6 的每连接 SSH 路径）下次连接即新代码 1.1.0。未替 Owner 重启生产常驻进程（超出本批授权）；17097 疑似孤儿，建议 Owner 核后清理。
4. **label dtype 约定**：库级 `append_points` 保持 dtype 无关（镜像 append_boxes）；调用方（processor 包装）必须传 bool——int64 会触发 MLX GPU scatter 不支持。已在两处代码注释里写明。
5. 微框近似点（方案 A）已由 spike 否决——桥层**不要**用小 box 模拟点（4/8/16/32px 全尺寸 IoU≈0，负微框直接 0 检出）。

## 5. 产物路径

- 本报告：`/Users/kzf/Pictures/贴钻/experiments/sam-playbook-20261004/points-service-upgrade.md`
- 产物集：`…/sam-playbook-20261004/points-upgrade-artifacts/`——`macmini-diffs.txt`（三文件完整 diff）、`baseline_svc.json`（改前基线）、`points_svc.json`（改后回归+点功能）、`points_err.json`（校验面 5 例）、`PROTOCOL.md`（更新后全文副本）、`svc_points_harness.py` + 4 个 plan
- macmini：改动文件与 `.bak-20261004` 备份同目录；自测脚本/数据在 `~/sam3-spike/spike-points-20260904/`（含补传的 `angels.jpg` 测试原图——spike 后该目录曾被清理，本轮从本地 `/Users/kzf/Pictures/贴钻/微信图片_20260921172653_27_485.jpg` 回传）

## 6. 进程回收证据

- 所有测试走 direct 模式子进程（harness `subprocess.Popen`），stdin EOF 优雅退出：三轮回测 `serviceExitCode=0`（baseline 19.0s / points 30.2s / err 0.9s）
- 改后 `ps aux | grep sam3_service`：仅存两个**改前已有**进程（17097、78097，见 §4.3），本轮**零新增、零残留**
- 未触碰：8317、daemon 代码、fifo 常驻服务、`in.fifo`/`out.fifo`
