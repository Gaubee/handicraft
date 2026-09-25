# SAM3 macmini 服务协议（add-subject-sam-pipeline P2.1）

- 服务：`~/sam3-spike/service/sam3_service.py`（macmini，Apple M1 / macOS 26.5.1）
- 底座：`~/sam3-spike/mlx_sam3`（MLX 线 SAM3，模型 `mlx-community/sam3-image`，HF 缓存 3.2GB 已在位）
- 镜像：本目录（`daemon/sam-bridge/macmini/`）为 daemon 仓内审阅镜像，部署真身以 macmini `~/sam3-spike/service/` 为准
- 版本：service 1.0.0 / protocol 1

## 1. 传输与帧

行协议（JSON-RPC 风格）：**一行一请求、一行一响应**，UTF-8，`\n` 结尾。单行上限 64MB（base64 图余量）。并发=1（stdin 循环天然串行）；FIFO 面由 `ask.sh` 的 flock 保证串行。

请求：`{"id": <任意 JSON 标量，原样回显>, "method": "version|status|segment|analyze|shutdown", "params": {...}}`

响应：

```json
{"id": 1, "ok": true, "result": {...}}
{"id": 1, "ok": false, "error": {"code": "<CODE>", "message": "...", "details": {...}}}
```

两种接入模式：

| 模式 | 起法 | 适用 |
| --- | --- | --- |
| **direct（推荐 P2.6 桥）** | `ssh macmini '/Users/kzf/sam3-spike/mlx_sam3/.venv/bin/python /Users/kzf/sam3-spike/service/sam3_service.py'`，请求行写 ssh stdin、响应行读 ssh stdout；stdin EOF 即优雅退出 | daemon 持有一条 ssh 会话即一个常驻服务；模型惰性加载后随会话常驻。**勿用 `ssh -t`**（行规程截断长行） |
| **fifo（nohup 常驻）** | `service/start.sh`（nohup + pid 文件 + `in.fifo`/`out.fifo`）；`service/stop.sh` 停止；`service/ask.sh '<json>'` 一次性问答 | 临时/脚本面探针与人工排查 |

FIFO 注意：客户端**必须把响应行读走**。只写不读的客户端会让响应滞留管道，下一交换串扰（此时重启服务对齐：`stop.sh && start.sh`）；服务侧写超 300s 界会弃写并记 `response_abandoned` 事件，不卡死服务。

## 2. 方法

### version → result

```json
{"service":"1.0.0","protocol":"1","mlxSam3":"0.1.0","model":"mlx-community/sam3-image",
 "chip":"Apple M1","python":"3.13.15","mlx":"…","torch":"…","mode":"direct|fifo","libImportError":null}
```

不触发模型加载（秒回）。`torch` 字段为 venv 实况（processor 测试面 import torch；推理计算仍走 MLX）。

### status → result

`{"loaded":bool,"loadSec":number|null,"uptimeSec":number,"requests":int,"errors":int,"timeouts":int,"lastError":string|null,"mode":...}`

### segment → result

params：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `imagePngBase64` \| `imagePath` | string（二选一） | base64 图字节（PIL 可解码的任意格式）或 macmini 本地路径（内部服务，信任边界内） |
| `prompt.text` | string | 文本概念提示（spike 实证：英文语义词最稳，如 person/hat/flower） |
| `prompt.box` | `[x,y,w,h]` | **像素、左上原点**；服务内自动转 `add_geometric_prompt` 要求的归一化 cxcywh |
| `prompt.boxNegative` | `[x,y,w,h]` | 负例框（排除区域），与 box/text 可组合 |
| `prompt.points` | — | **不支持** → `UNSUPPORTED`（见能力矩阵） |
| `topK` | int（默认 1，1..32） | 返回检出数（按 score 降序） |
| `confThreshold` | float（默认 0.4） | 置信阈值（spike/multistrat 同值；processor 原生默认 0.5） |
| `maskMaxSide` | int（可选，≥32） | 掩码最长边降采样（省带宽；默认原图尺寸） |
| `overlay` | bool（默认 false） | 附带最高分检出的叠加预览图（spike 同款：半透明红+框+label score，jpeg base64） |
| `timeoutSec` | float（默认 120，1..600） | 本请求软超时界 |

text 与 box 可组合（先文本后几何——`set_text_prompt` → `add_geometric_prompt`，语义=文本概念内再聚焦/排除）。`prompt` 至少含 text 或 box 之一。

result：

```json
{"width":W,"height":H,"count":N,
 "detections":[{"mask":{"w":w,"h":h,"dataBase64":"<0/1 字节 base64>"},
                "maskPx":int,"score":0.87,"boxPx":[x,y,w,h],"label":"person"}],
 "mask":{...最佳检出（score 最高）…},"score":0.87,"maskPx":int}
```

- `mask.dataBase64`：`w*h` 个字节、取值 0/1、base64——与 contracts `InlineMask(encoding:"base64-01")` 同构（P2.6 传输适配器直映射）。
- 便捷面 `mask`/`score`/`maskPx` = 最高分检出；多检出明细在 `detections`。`count`=阈值以上检出总数（可 > `topK`）。
- 零检出：`count:0`，`detections:[]`，`mask:null`——**不是错误**（换提示词重试是调用方策略，P2.4 迭代循环的事）。

### analyze → 结构化 UNSUPPORTED（如实）

mlx_sam3 **无 VLM 面**（证据见 §4）。响应：

```json
{"id":1,"ok":false,"error":{"code":"UNSUPPORTED",
 "message":"mlx_sam3 无 VLM/分析能力：…",
 "details":{"capability":"vlm-analyze","model":"mlx-community/sam3-image",
            "fallback":"daemon 侧走 LLM 路由（P2.3 scene.analyze / P2.6 桥按能力矩阵降级）"}}}
```

daemon 侧（P2.2 `SshSamTransport` 适配器）应把此错误映射为 LLM 路由兜底，而非重试本服务。

### shutdown

优雅退出（回 `{"bye":true,"pid":...}` 后进程退出）。`stop.sh` 的常规路径是 SIGTERM，二选一。

## 3. 错误码

| code | 语义 |
| --- | --- |
| `PARSE_ERROR` | 行不是合法 JSON |
| `INVALID_REQUEST` | 形状/字段非法（缺图、prompt 空、图像超 4096×4096 像素护栏、行超 64MB 等） |
| `METHOD_NOT_FOUND` | 未知 method |
| `IMAGE_ERROR` | base64 解码失败 / 文件不存在 / 图像解码失败 |
| `UNSUPPORTED` | 能力不存在（points 提示、VLM analyze）——**结构化降级信号，非故障** |
| `TIMEOUT` | 超过 `timeoutSec` 软界——请求放弃，服务存活 |
| `NOT_LOADED` | 库导入/模型加载失败（查 logs/service.log、stderr.log） |
| `INTERNAL` | 未预期异常（trace 落 service.log `internal_error` 事件） |

超时语义（如实）：SIGALRM 软界——若正卡在单个长 MLX 原生算子内，异常延迟到算子返回后生效；实测单图全链约 10-13s（backbone ~9s + grounding ~1-3s），120s 界余量充足。超时后本请求 state 弃置，服务继续。

## 4. 能力矩阵（P2.1 实测）

| 面 | 支持度 | 证据 |
| --- | --- | --- |
| 文本概念提示（segment.prompt.text） | ✅ | spike 20260924 四图六概念实证；本服务自测见 §6 |
| box 几何提示（segment.prompt.box / boxNegative） | ✅ | `Sam3Processor.add_geometric_prompt(box, label, state)`（sam3_image_processor.py），box 归一化 cxcywh+正负标签；`Prompt.append_boxes`（geometry_encoders.py:297）。自测：文本 person 框内再 box 聚焦，掩码非空 |
| 点提示（segment.prompt.points） | ❌ UNSUPPORTED | `Prompt` 类仅暴露 `append_boxes`，无 append_points；`Sam3Processor` 无点 API。`SequenceGeometryEncoder` 有 points 配置位但无调用面——如实判不支持 |
| VLM/analyze | ❌ UNSUPPORTED | `build_sam3_image_model` 组成=ViT 视觉骨干+VETextEncoder（概念文本）+Transformer+分割头（model_builder.py）——无生成/描述组件。daemon 走 LLM 路由 |
| 掩码输出 | ✅ | 原图分辨率 0/1 字节（`interpolate` 回原尺寸后 sigmoid>0.5） |

## 5. 日志留存（`~/sam3-spike/service/logs/`）

| 文件 | 内容 |
| --- | --- |
| `service.log` | 生命周期：startup / model_loaded / signal / response_abandoned / internal_error（含 trace 尾部） |
| `requests.jsonl` | 每请求一行 meta：ts/id/method/参数摘要（图来源、prompt 面、count、maskPx、topScore）/durMs/ok/error——**不含图像字节** |
| `library-stdout.log` | 库内 print 隔离区（"Backbone pass took … Seconds" 等）——防污染协议通道 |
| `stderr.log` | 进程 stderr（start.sh nohup 重定向） |

## 6. 自测实录（2026-09-25，Apple M1 实测）

fifo 面自测 `selftest.py`（断言 20/20 全过，输出留存 `logs/selftest.log`）+ direct 面 ssh 直连冒烟（`logs/selftest-direct.log`）：

| 项 | 实测 |
| --- | --- |
| version | 0.7-1.3s 秒回；service 1.0.0 / mlxSam3 0.1.0 / mlx 0.30.0 / python 3.13.15 / torch 2.9.1（venv 实况，推理仍走 MLX） |
| 模型惰性加载 | 5.6s（fifo 首载）/ 3.0s（direct 会话）——HF 缓存命中 |
| segment 文本 person（736×736） | count=1，maskPx=277419，score=0.4389，39.7s 含首载（净 ~34s） |
| segment box（同图 person 框收缩 60%） | count=1，maskPx=69681，score=0.9545，59.2s |
| segment text+box 组合 | count=1，maskPx=87285，score=0.9488，102.2s ⚠ 接近默认 120s 界 |
| segment 文本 flower（bouquet 图，maskMaxSide=512） | count=24（topK=1 取最佳），score=0.8155，掩码 512×512 降采样生效，30.7s 含 3.0s 加载 |
| analyze / points | UNSUPPORTED 结构化错误（PASS——降级信号面） |
| 错误面 | PARSE_ERROR / METHOD_NOT_FOUND / IMAGE_ERROR（PASS）；status.errors=5 记账正确 |
| 掩码字节核验 | len=w*h、取值 ∈{0,1}、sum=maskPx（PASS） |
| 启停 | start.sh（pid 50607）→ stop.sh SIGTERM 优雅停（service.log `signal signum=15`），pid 文件清除，零残留进程 |

性能注意：M1 上单次 grounding 净耗时 ~25-35s（与 daemon 桥注释的「46s/提示实测」同量级）；**text+box 组合≈两次 grounding 相加，逼近默认 120s 软界**——P2.6 桥对组合请求建议传 `timeoutSec`≥180（协议上限 600）；当日机器 swap 已用 ~9GB（spike 机器信息），延迟有抖动空间。

## 7. 部署与启停

```bash
# macmini 上
~/sam3-spike/service/start.sh          # 起（nohup fifo 常驻，pid 文件 sam3-service.pid）
~/sam3-spike/service/ask.sh '{"id":1,"method":"version"}'
~/sam3-spike/service/stop.sh           # 停（SIGTERM→10s 界→SIGKILL）

# direct 模式（P2.6 桥用）
ssh macmini '/Users/kzf/sam3-spike/mlx_sam3/.venv/bin/python /Users/kzf/sam3-spike/service/sam3_service.py'
```

- 模型惰性加载：首个 segment 请求触发（HF 缓存命中约 6s；冷缓存首跑需下载 3.2GB——已预置）。version/status 不触发。
- 内存：spike 实测峰值 RSS < 1GB（16GB 机器余量充足）。
- 服务进程可控启停：fifo 模式 = start.sh/stop.sh + pid 文件；direct 模式 = 会话生命周期即服务生命周期。launchctl 未使用（无系统配置面侵入）。

## 8. P2.2 桥对接备注（daemon 侧）

- `imageBytes` → `imagePngBase64`；`prompt{kind:"text"}` → `prompt.text`；`prompt{kind:"geometric", box}` → `prompt.box`；`points` 收到 UNSUPPORTED → 应映射 `SamBridgeError`（transport/降级），不重试。
- 响应映射：`result.mask{w,h,dataBase64}` → `InlineMask(encoding:"base64-01", data)`；`result.score` → `score`；`result.overlay` → `overlay`（可选字段，mime image/jpeg）；`meta.model` 用 `version` 结果的 `model`+`mlxSam3` 拼装，`durationMs` daemon 侧自计。
