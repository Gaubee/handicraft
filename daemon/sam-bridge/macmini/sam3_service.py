#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SAM3-MLX 常驻识图服务（add-subject-sam-pipeline P2.1 / design §7）。

行协议（JSON-RPC 风格，一行一请求、一行一响应，UTF-8）：
  请求: {"id": <标量>, "method": "version|status|segment|analyze|shutdown", "params": {...}}
  响应: {"id": <同请求>, "ok": true, "result": {...}}
        {"id": <同请求>, "ok": false, "error": {"code": "<CODE>", "message": "...", "details": {...}?}}

两种运行模式：
  direct（P2.6 daemon 桥推荐——ssh 直连，会话存活期间模型常驻）:
      ssh macmini '/Users/kzf/sam3-spike/mlx_sam3/.venv/bin/python \
                   /Users/kzf/sam3-spike/service/sam3_service.py'
      请求行写 stdin、响应行读 stdout；stdin EOF 即优雅退出。勿用 ssh -t（行规程会截断长行）。
  fifo（nohup 常驻，由 start.sh 拉起）:
      sam3_service.py --fifo → 打开 service/in.fifo / service/out.fifo（O_RDWR，客户端见 ask.sh）

能力（如实标注，证据见 PROTOCOL.md）：
  segment 文本概念提示  支持（spike 20260924 实证）
  segment box 几何提示  支持（Sam3Processor.add_geometric_prompt，服务内自动转归一化 cxcywh）
  segment 点提示        不支持（mlx_sam3 Prompt 仅暴露 append_boxes，无点提示 API）→ UNSUPPORTED
  analyze（VLM 面）     不支持（SAM3Image=概念接地分割模型，无生成/描述组件）→ UNSUPPORTED，
                        daemon 侧走 LLM 路由兜底（P2.3/P2.6）

日志留存（~/sam3-spike/service/logs/）：
  service.log          生命周期事件（启动/加载/信号/响应弃写）
  requests.jsonl       每请求一行 meta（id/method/参数摘要/耗时/结果摘要/错误）
  library-stdout.log   库内 print 隔离区（Backbone pass 耗时等——防污染协议通道）
  stderr.log           进程 stderr（nohup 重定向，start.sh 负责）
"""
from __future__ import annotations

import argparse
import base64
import binascii
import gc
import io
import json
import os
import select
import signal
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent
SPIKE_DIR = SERVICE_DIR.parent            # ~/sam3-spike
LIB_DIR = SPIKE_DIR / "mlx_sam3"          # mlx_sam3 库（sys.path 注入用）
LOGS_DIR = SERVICE_DIR / "logs"

SERVICE_VERSION = "1.0.0"
PROTOCOL_VERSION = "1"
MODEL_ID = "mlx-community/sam3-image"
DEFAULT_TIMEOUT_SEC = 120.0   # 与 daemon 桥 SAM_REQUEST_TIMEOUT_MS 对齐
MAX_TIMEOUT_SEC = 600.0
MAX_LINE_BYTES = 64 * 1024 * 1024     # 单请求行上限（base64 图像余量）
MAX_IMAGE_PIXELS = 4096 * 4096        # 解码像素护栏
DEFAULT_CONFIDENCE = 0.4              # 与 spike/multistrat 同阈值（processor 原生默认 0.5）
FIFO_WRITE_TIMEOUT_SEC = 300.0        # fifo 响应写出界（客户端不发读时弃写，不卡死服务）

# 库噪声抑制（hub 进度条/分词器告警）
os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")


# ---------------------------------------------------------------- 基础设施

def _now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


class ServiceError(Exception):
    """结构化协议错误（error.code 词汇表见 PROTOCOL.md）。"""

    def __init__(self, code: str, message: str, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details


class RequestTimeout(Exception):
    """SIGALRM 软超时（见 PROTOCOL.md「超时语义」——软界，非硬抢占）。"""


def _on_alarm(signum, frame):  # noqa: ARG001
    raise RequestTimeout()


signal.signal(signal.SIGALRM, _on_alarm)


def _chip_name() -> str:
    try:
        return subprocess.run(
            ["sysctl", "-n", "machdep.cpu.brand_string"],
            capture_output=True, text=True, timeout=5,
        ).stdout.strip()
    except Exception:
        return "unknown"


CHIP = _chip_name()


class Logs:
    """单线程写（stdin 循环天然串行），无需锁。"""

    def __init__(self) -> None:
        LOGS_DIR.mkdir(parents=True, exist_ok=True)
        self._svc = open(LOGS_DIR / "service.log", "a", buffering=1, encoding="utf-8")
        self._req = open(LOGS_DIR / "requests.jsonl", "a", buffering=1, encoding="utf-8")

    def event(self, event: str, **kw) -> None:
        self._svc.write(json.dumps({"ts": _now_iso(), "event": event, **kw}, ensure_ascii=False) + "\n")

    def request(self, rec: dict) -> None:
        rec = {"ts": _now_iso(), **rec}
        self._req.write(json.dumps(rec, ensure_ascii=False) + "\n")


LOG = Logs()


# ---------------------------------------------------------------- 模型运行时（惰性加载）

class Sam3Runtime:
    """模型+处理器惰性单例：首个 segment 请求加载，此后常驻内存。"""

    def __init__(self) -> None:
        self.processor = None
        self.model = None
        self.sam3_version: str | None = None
        self.load_sec: float | None = None
        self._import_error: str | None = None
        self._import_done = False

    def import_lib(self):
        """导入库（不加载权重）——version 上报用；失败如实记录。"""
        if not self._import_done:
            self._import_done = True
            if str(LIB_DIR) not in sys.path:
                sys.path.insert(0, str(LIB_DIR))
            try:
                import sam3  # noqa: F401
                self.sam3_version = getattr(sam3, "__version__", None)
            except Exception as e:  # noqa: BLE001
                self._import_error = repr(e)
        return self

    def ensure_loaded(self):
        if self.processor is not None:
            return
        self.import_lib()
        if self._import_error:
            raise ServiceError("NOT_LOADED", f"mlx_sam3 导入失败: {self._import_error}")
        t0 = time.time()
        try:
            from sam3 import build_sam3_image_model
            from sam3.model.sam3_image_processor import Sam3Processor

            model = build_sam3_image_model()  # HF 缓存命中约 6s（首跑已下载 3.2GB）
            self.processor = Sam3Processor(model, confidence_threshold=DEFAULT_CONFIDENCE)
            self.model = model
        except Exception as e:  # noqa: BLE001
            raise ServiceError("NOT_LOADED", f"模型加载失败: {e!r}") from e
        self.load_sec = round(time.time() - t0, 2)
        LOG.event("model_loaded", loadSec=self.load_sec)

    @property
    def loaded(self) -> bool:
        return self.processor is not None


RT = Sam3Runtime()


# ---------------------------------------------------------------- 图像输入

def load_image(params: dict):
    """imagePngBase64 | imagePath 二选一 → (PIL RGB 图, 来源摘要)。"""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS  # 与护栏对齐（同时消 PIL 告警）
    b64 = params.get("imagePngBase64")
    path = params.get("imagePath")
    if b64 is None and path is None:
        raise ServiceError("INVALID_REQUEST", "需提供 imagePngBase64 或 imagePath 之一")
    if b64 is not None and path is not None:
        raise ServiceError("INVALID_REQUEST", "imagePngBase64 与 imagePath 只能二选一")
    try:
        if b64 is not None:
            if not isinstance(b64, str) or not b64:
                raise ServiceError("INVALID_REQUEST", "imagePngBase64 需为非空字符串")
            try:
                raw = base64.b64decode(b64, validate=True)
            except (binascii.Error, ValueError) as e:
                raise ServiceError("IMAGE_ERROR", f"base64 解码失败: {e}") from e
            src = f"b64({len(raw)}B)"
            fp = io.BytesIO(raw)
        else:
            if not isinstance(path, str) or not path:
                raise ServiceError("INVALID_REQUEST", "imagePath 需为非空字符串")
            p = Path(os.path.expanduser(path))
            if not p.is_file():
                raise ServiceError("IMAGE_ERROR", f"图像文件不存在: {p}")
            src = f"path:{p.name}"
            fp = open(p, "rb")  # noqa: SIM115
        try:
            image = Image.open(fp)
            image.load()
        except Exception as e:  # noqa: BLE001
            raise ServiceError("IMAGE_ERROR", f"图像解码失败: {e}") from e
        finally:
            fp.close()
    except ServiceError:
        raise
    w, h = image.size
    if w * h > MAX_IMAGE_PIXELS:
        raise ServiceError("INVALID_REQUEST", f"图像过大 {w}x{h}（上限 {MAX_IMAGE_PIXELS} 像素）")
    return image.convert("RGB"), src


# ---------------------------------------------------------------- segment 实现

def _coerce_box(b, name: str) -> list[float]:
    ok = isinstance(b, (list, tuple)) and len(b) == 4 and all(
        isinstance(v, (int, float)) and not isinstance(v, bool) for v in b
    )
    if not ok:
        raise ServiceError("INVALID_REQUEST", f"{name} 需为 [x, y, w, h] 四数字（像素，左上原点）")
    x, y, w, h = (float(v) for v in b)
    if w <= 0 or h <= 0:
        raise ServiceError("INVALID_REQUEST", f"{name} 的 w/h 需 > 0")
    return [x, y, w, h]


def _to_norm_cxcywh(box: list[float], img_w: int, img_h: int) -> list[float]:
    """像素 xywh（左上原点）→ add_geometric_prompt 要求的归一化 cxcywh。"""
    x, y, w, h = box
    return [
        min(max((x + w / 2.0) / img_w, 0.0), 1.0),
        min(max((y + h / 2.0) / img_h, 0.0), 1.0),
        min(max(w / img_w, 0.0), 1.0),
        min(max(h / img_h, 0.0), 1.0),
    ]


def _clamp(v, lo, hi):
    return min(max(v, lo), hi)


def do_segment(params: dict) -> dict:
    import numpy as np

    p = params if isinstance(params, dict) else {}
    prompt = p.get("prompt")
    if not isinstance(prompt, dict):
        raise ServiceError("INVALID_REQUEST", "params.prompt 必须为对象 {text?|box?|boxNegative?|points?}")

    text = prompt.get("text")
    box = prompt.get("box")
    box_neg = prompt.get("boxNegative")
    points = prompt.get("points")

    if points is not None:
        raise ServiceError(
            "UNSUPPORTED",
            "点提示不支持：mlx_sam3 的 Prompt 仅暴露 append_boxes，无点提示 API（几何面仅 box）",
            details={"capability": "points-prompt", "alternative": "用 box 或 text 提示"},
        )
    if text is not None and (not isinstance(text, str) or not (1 <= len(text) <= 256)):
        raise ServiceError("INVALID_REQUEST", "prompt.text 需为 1..256 字符")
    if text is None and box is None and box_neg is None:
        raise ServiceError("INVALID_REQUEST", "prompt 需至少含 text 或 box 之一（points 不支持）")
    if box is not None:
        box = _coerce_box(box, "prompt.box")
    if box_neg is not None:
        box_neg = _coerce_box(box_neg, "prompt.boxNegative")

    try:
        top_k = _clamp(int(p.get("topK", 1)), 1, 32)
        conf = _clamp(float(p.get("confThreshold", DEFAULT_CONFIDENCE)), 0.05, 0.95)
        mask_max_side = p.get("maskMaxSide")
        if mask_max_side is not None:
            mask_max_side = int(mask_max_side)
            if mask_max_side < 32:
                raise ServiceError("INVALID_REQUEST", "maskMaxSide 需 >= 32")
    except (TypeError, ValueError):
        raise ServiceError("INVALID_REQUEST", "topK/confThreshold/maskMaxSide 需为数字") from None
    want_overlay = bool(p.get("overlay", False))

    image, img_src = load_image(p)
    W, H = image.size

    RT.ensure_loaded()
    proc = RT.processor
    old_conf = proc.confidence_threshold
    proc.confidence_threshold = conf
    state = None
    try:
        state = proc.set_image(image)                     # 每请求全新 state——无跨请求提示污染
        if text is not None:
            state = proc.set_text_prompt(text, state)
        if box is not None:
            state = proc.add_geometric_prompt(_to_norm_cxcywh(box, W, H), True, state)
        if box_neg is not None:
            state = proc.add_geometric_prompt(_to_norm_cxcywh(box_neg, W, H), False, state)

        masks = np.array(state["masks"]) if len(state["scores"]) else np.zeros((0, 1, H, W), dtype=bool)
        boxes = np.array(state["boxes"]) if len(state["scores"]) else np.zeros((0, 4), dtype=np.float32)
        scores = np.array([float(s) for s in state["scores"]])
        count = len(scores)
    finally:
        proc.confidence_threshold = old_conf

    label = text if text is not None else "box"
    detections = []
    for i in np.argsort(-scores)[:top_k] if count else []:
        m = masks[int(i)]
        if m.ndim == 3:
            m = m[0]
        arr = (np.asarray(m) > 0).astype(np.uint8)
        mh, mw = arr.shape
        if mask_max_side is not None and max(mw, mh) > mask_max_side:
            from PIL import Image as PILImage

            scale = mask_max_side / max(mw, mh)
            nw, nh = max(1, int(mw * scale)), max(1, int(mh * scale))
            arr = (np.asarray(
                PILImage.fromarray(arr * 255).resize((nw, nh), PILImage.NEAREST)
            ) > 127).astype(np.uint8)
            mh, mw = arr.shape
        box_px = None
        if int(i) < len(boxes):
            x0, y0, x1, y1 = (float(v) for v in boxes[int(i)])
            box_px = [
                int(round(_clamp(x0, 0, W))), int(round(_clamp(y0, 0, H))),
                int(round(_clamp(x1 - x0, 0, W))), int(round(_clamp(y1 - y0, 0, H))),
            ]
        det = {
            "mask": {"w": mw, "h": mh, "dataBase64": base64.b64encode(arr.tobytes()).decode("ascii")},
            "maskPx": int(arr.sum()),
            "score": round(float(scores[int(i)]), 4),
            "boxPx": box_px,
            "label": label,
        }
        if want_overlay and box_px is not None:
            det["overlay"] = _render_overlay(image, arr, box_px, label, det["score"])
        detections.append(det)
        del arr

    best = detections[0] if detections else None
    result = {
        "width": W,
        "height": H,
        "count": int(count),
        "detections": detections,
        "mask": best["mask"] if best else None,       # 便捷面=最高分检出（任务协议形状）
        "score": best["score"] if best else None,
        "maskPx": best["maskPx"] if best else 0,
    }
    if want_overlay and best is not None and "overlay" in best:
        result["overlay"] = best["overlay"]

    del state, masks, boxes, scores
    gc.collect()
    _last_segment_summary[0] = {
        "image": img_src, "count": result["count"], "maskPx": result["maskPx"],
        "topScore": result["score"], "promptKinds": [k for k, v in
            (("text", text is not None), ("box", box is not None),
             ("boxNegative", box_neg is not None)) if v],
    }
    return result


_last_segment_summary: list = [None]


def _render_overlay(image, mask_arr, box_px, label, score):
    """spike 同款叠加预览（半透明彩色+框+label score），jpeg base64。"""
    from PIL import Image as PILImage, ImageDraw

    overlay = image.copy()
    mask_img = PILImage.fromarray(mask_arr * 255)
    tint = PILImage.new("RGB", overlay.size, (255, 60, 60))
    overlay = PILImage.composite(PILImage.blend(overlay, tint, 0.45), overlay, mask_img)
    d = ImageDraw.Draw(overlay)
    x, y, w, h = box_px
    d.rectangle([x, y, x + w, y + h], outline=(255, 60, 60), width=3)
    d.text((x + 4, max(0, y - 14)), f"{label} {score:.2f}", fill=(255, 60, 60))
    buf = io.BytesIO()
    overlay.save(buf, format="JPEG", quality=92)
    return {"mime": "image/jpeg", "dataBase64": base64.b64encode(buf.getvalue()).decode("ascii")}


# ---------------------------------------------------------------- 其余方法

def do_version(mode: str) -> dict:
    RT.import_lib()
    mlx_ver = "unknown"
    torch_ver = None
    try:
        import mlx
        mlx_ver = getattr(mlx, "__version__", getattr(mlx.core, "__version__", "unknown"))
    except Exception:  # noqa: BLE001
        pass
    try:
        import torch
        torch_ver = torch.__version__
    except Exception:  # noqa: BLE001
        pass
    return {
        "service": SERVICE_VERSION,
        "protocol": PROTOCOL_VERSION,
        "mlxSam3": RT.sam3_version,
        "model": MODEL_ID,
        "chip": CHIP,
        "python": sys.version.split()[0],
        "mlx": mlx_ver,
        "torch": torch_ver,       # venv 实况：processor 测试面 import torch（计算仍走 MLX）
        "mode": mode,
        "libImportError": RT._import_error,
    }


def do_analyze(params: dict) -> dict:
    raise ServiceError(
        "UNSUPPORTED",
        "mlx_sam3 无 VLM/分析能力：SAM3Image = ViT 视觉骨干 + 概念文本编码器 + 分割头，"
        "无生成/描述组件（model_builder.py 组成实证）",
        details={
            "capability": "vlm-analyze",
            "model": MODEL_ID,
            "fallback": "daemon 侧走 LLM 路由（P2.3 scene.analyze / P2.6 桥按能力矩阵降级）",
        },
    )


# ---------------------------------------------------------------- 请求分发

STATS = {"started": time.time(), "requests": 0, "errors": 0, "timeouts": 0, "lastError": None}
SHUTDOWN = {"flag": False}


def dispatch(method: str, params, mode: str) -> tuple[dict | None, dict | None]:
    """返回 (result, err_summary)；ServiceError 已就地转 resp 形。"""
    if method == "version":
        return do_version(mode), None
    if method == "status":
        return {
            "loaded": RT.loaded,
            "loadSec": RT.load_sec,
            "uptimeSec": round(time.time() - STATS["started"], 1),
            "requests": STATS["requests"],
            "errors": STATS["errors"],
            "timeouts": STATS["timeouts"],
            "lastError": STATS["lastError"],
            "mode": mode,
        }, None
    if method == "segment":
        if isinstance(params, dict) and "timeoutSec" in params:
            try:
                timeout = _clamp(float(params["timeoutSec"]), 1.0, MAX_TIMEOUT_SEC)
            except (TypeError, ValueError):
                raise ServiceError("INVALID_REQUEST", "timeoutSec 需为数字") from None
        else:
            timeout = DEFAULT_TIMEOUT_SEC
        signal.setitimer(signal.ITIMER_REAL, timeout)
        try:
            result = do_segment(params)
            return result, None
        except RequestTimeout:
            STATS["timeouts"] += 1
            STATS["lastError"] = "TIMEOUT"
            gc.collect()
            raise ServiceError(
                "TIMEOUT",
                f"segment 超过 {timeout:.0f}s 软界（SIGALRM）——请求放弃，服务存活。"
                "注：mlx 原生算子内的异常延迟到算子返回，界为软界",
                details={"timeoutSec": timeout, "hard": False},
            ) from None
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
    if method == "analyze":
        return do_analyze(params)
    if method == "shutdown":
        SHUTDOWN["flag"] = True
        return {"bye": True, "pid": os.getpid()}, None
    raise ServiceError("METHOD_NOT_FOUND", f"未知 method: {method!r}（可用: version/status/segment/analyze/shutdown）")


def handle_line(line: str, mode: str) -> tuple[dict, dict]:
    """→ (响应, 请求摘要用于日志)。"""
    try:
        req = json.loads(line)
    except Exception as e:  # noqa: BLE001
        STATS["errors"] += 1
        STATS["lastError"] = "PARSE_ERROR"
        return ({"id": None, "ok": False,
                 "error": {"code": "PARSE_ERROR", "message": f"JSON 解析失败: {e}"}}, {})
    rid = req.get("id") if isinstance(req, dict) else None
    method = req.get("method") if isinstance(req, dict) else None
    params = req.get("params", {}) if isinstance(req, dict) else {}
    summary = {"id": rid, "method": method if isinstance(method, str) else None}
    if not isinstance(req, dict) or not isinstance(method, str):
        STATS["errors"] += 1
        STATS["lastError"] = "INVALID_REQUEST"
        return ({"id": rid, "ok": False, "error": {
            "code": "INVALID_REQUEST", "message": "请求必须为含 method 字符串的对象"}}, summary)
    try:
        result, _ = dispatch(method, params, mode)
        resp = {"id": rid, "ok": True, "result": result}
        if method == "segment" and _last_segment_summary[0]:
            summary["detail"] = _last_segment_summary[0]
            _last_segment_summary[0] = None
        return resp, summary
    except ServiceError as e:
        STATS["errors"] += 1
        STATS["lastError"] = e.code
        err = {"code": e.code, "message": e.message}
        if e.details:
            err["details"] = e.details
        summary["error"] = e.code
        return {"id": rid, "ok": False, "error": err}, summary
    except Exception as e:  # noqa: BLE001
        STATS["errors"] += 1
        STATS["lastError"] = "INTERNAL"
        LOG.event("internal_error", method=method, trace=traceback.format_exc()[-2000:])
        return ({"id": rid, "ok": False, "error": {
            "code": "INTERNAL", "message": f"内部错误: {e!r}"}}, summary)


# ---------------------------------------------------------------- 传输面

def make_fifo_writer(fd_out: int):
    """非阻塞 select 写循环：客户端不发读时最长等 FIFO_WRITE_TIMEOUT_SEC 后弃写（服务不卡死）。"""

    def write_line(text: str) -> None:
        data = (text + "\n").encode("utf-8")
        deadline = time.time() + FIFO_WRITE_TIMEOUT_SEC
        while data:
            _, w, _ = select.select([], [fd_out], [], 5.0)
            if not w:
                if time.time() >= deadline:
                    LOG.event("response_abandoned", bytesLeft=len(data),
                              note="fifo 写超界弃写——下一条交换可能需重启服务对齐（见 PROTOCOL.md）")
                    return
                continue
            try:
                n = os.write(fd_out, data)
            except BlockingIOError:
                continue
            data = data[n:]

    return write_line


def serve(fin, write_line, mode: str) -> None:
    LOG.event("serve_start", mode=mode, pid=os.getpid())
    while True:
        line = fin.readline(MAX_LINE_BYTES + 1)
        if not line:  # EOF（direct 模式会话结束 / fifo 理论不自断）
            LOG.event("stdin_eof", mode=mode)
            break
        if len(line) > MAX_LINE_BYTES:
            while True:  # 排干到行尾
                tail = fin.readline(MAX_LINE_BYTES + 1)
                if not tail or tail.endswith("\n"):
                    break
            STATS["errors"] += 1
            resp = {"id": None, "ok": False, "error": {
                "code": "INVALID_REQUEST",
                "message": f"请求行超过 {MAX_LINE_BYTES} 字节上限"}}
            write_line(json.dumps(resp, ensure_ascii=False))
            LOG.request({"id": None, "method": None, "ok": False, "durMs": 0,
                         "error": "LINE_TOO_LONG"})
            continue
        line = line.strip()
        if not line:
            continue
        t0 = time.time()
        STATS["requests"] += 1
        resp, summary = handle_line(line, mode)
        dur_ms = round((time.time() - t0) * 1000)
        write_line(json.dumps(resp, ensure_ascii=False))
        LOG.request({**summary, "ok": resp["ok"], "durMs": dur_ms})
        if SHUTDOWN["flag"]:
            LOG.event("shutdown_bye", mode=mode)
            break
    LOG.event("serve_end", mode=mode,
              uptimeSec=round(time.time() - STATS["started"], 1), **STATS)


def _install_term_handlers() -> None:
    def _term(signum, frame):  # noqa: ARG001
        LOG.event("signal", signum=signum)
        try:
            sys.stdout.flush()
        except Exception:  # noqa: BLE001
            pass
        os._exit(0)

    signal.signal(signal.SIGTERM, _term)
    signal.signal(signal.SIGINT, _term)


def main() -> None:
    ap = argparse.ArgumentParser(description="SAM3-MLX 常驻识图服务（P2.1）")
    ap.add_argument("--fifo", action="store_true",
                    help="FIFO 常驻模式（start.sh 拉起；默认 direct=stdin/stdout）")
    args = ap.parse_args()
    _install_term_handlers()

    if args.fifo:
        in_path, out_path = SERVICE_DIR / "in.fifo", SERVICE_DIR / "out.fifo"
        for f in (in_path, out_path):
            if not f.exists():
                os.mkfifo(f, 0o600)
        fd_in = os.open(in_path, os.O_RDWR)                      # O_RDWR：open 永不阻塞
        fd_out = os.open(out_path, os.O_RDWR | os.O_NONBLOCK)    # 写侧非阻塞+select 界
        fin = os.fdopen(fd_in, "r", encoding="utf-8", errors="replace")
        write_line = make_fifo_writer(fd_out)
        mode = "fifo"
    else:
        proto = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)  # 协议通道=真 stdout
        fin = sys.stdin

        def write_line(text: str) -> None:
            proto.write(text + "\n")
            proto.flush()

        mode = "direct"

    # 库内 print 隔离（set_image 的 Backbone pass 等）——sys.stdout 重定向到日志
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    sys.stdout = open(LOGS_DIR / "library-stdout.log", "a", buffering=1, encoding="utf-8")  # noqa: SIM115

    LOG.event("startup", mode=mode, service=SERVICE_VERSION, protocol=PROTOCOL_VERSION,
              chip=CHIP, pid=os.getpid(), defaultTimeoutSec=DEFAULT_TIMEOUT_SEC)
    try:
        serve(fin, write_line, mode)
    finally:
        LOG.event("exit", mode=mode)
        sys.stdout.flush()


if __name__ == "__main__":
    main()
