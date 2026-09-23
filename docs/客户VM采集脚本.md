# 客户 VM ComfyUI 配置采集（给 Owner 执行）

客户的 ComfyUI 跑在 OneThingAI 的**云实例**上（Linux 容器，视频里文件浏览器路径 `/root/ComfyUI/...`）。两种方式二选一：

## 方式 A（推荐·零授权负担）：你跑采集脚本，拿回一个包

在 OneThingAI 控制台打开该实例的 **Web 终端**（或 SSH 进去），整段粘贴执行：

```bash
cd /root/ComfyUI && mkdir -p /root/collect && \
cp -r my_workflows /root/collect/ 2>/dev/null; \
ls -la custom_nodes/ > /root/collect/custom_nodes.list 2>/dev/null; \
find custom_nodes -maxdepth 2 -name "*.py" | head -100 >> /root/collect/custom_nodes.list; \
find models -type f | sed 's/^/MODELS: /' > /root/collect/models.list 2>/dev/null; \
find input -type f | head -50 > /root/collect/input.list 2>/dev/null; \
find output -maxdepth 3 -type d > /root/collect/output.dirs 2>/dev/null; \
ls -la output/*/ 2>/dev/null | head -100 > /root/collect/output.files; \
python3 -c "import sys; print(sys.version)" > /root/collect/env.txt 2>&1; \
pip list --format=freeze >> /root/collect/env.txt 2>/dev/null; \
nvidia-smi >> /root/collect/env.txt 2>/dev/null; \
cd /root && tar czf comfyui-collect-$(date +%m%d).tar.gz collect && \
ls -lh /root/comfyui-collect-*.tar.gz
```

然后经控制台文件浏览器把 `/root/comfyui-collet-*.tar.gz` 下载回来到 `~/Downloads/`，告诉我路径即可。
（脚本只采集：工作流 JSON、节点清单、模型**文件名**清单、输入输出**目录结构**、环境信息——不拷贝模型本体和图片数据，包很小）

## 方式 B：给我直连

如果实例开了 SSH 且你愿意：把 **host + 端口 + 密码**发我，我从本机直接连上去自己采（等同方式 A 的范围，采完即退，不动他任何运行状态）。

## 采集目的声明（给客户也好看）

- **用途**：理解管线结构、做接口对接与能力对齐（我们自研）
- **红线**：工作流含供应商加密字库——我们**不破解、不搬运、不复制**其工作流与字库；JSON 只读结构

## 补采（2026-09-23 首采缺工作流 JSON——浏览器侧工作流不在 my_workflows 目录）

在实例 Web 终端执行：

```bash
cd /root/ComfyUI && mkdir -p /root/collect2 && \
cp -r user/default/workflows /root/collect2/ 2>/dev/null; \
find models/detection models/florence2 -type f 2>/dev/null | head -50 > /root/collect2/detection-models.list; \
ls models/checkpoints/ >> /root/collect2/detection-models.list 2>/dev/null; \
cd /root && tar czf comfyui-collect2-$(date +%m%d).tar.gz collect2 && ls -lh comfyui-collect2-*.tar.gz
```

下载 `/root/comfyui-collect2-*.tar.gz` 放到 `~/Downloads/20x20/` 即可。
