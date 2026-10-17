"""视频读取：用 ffmpeg 解码成 RGB 帧流，并保留每帧的原始时间戳。

坐标约定：所有对外的坐标都是「原始分辨率像素」。读取时可以裁剪（只读需要的区域）
和缩放（加速），FrameSource 负责把输出帧里的坐标换算回原始坐标。
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import numpy as np


def _find_tool(name: str) -> str:
    env = os.environ.get(f"CHATMEASURE_{name.upper()}")
    if env:
        return env
    brew = f"/opt/homebrew/bin/{name}"
    if os.path.exists(brew):
        return brew
    found = shutil.which(name)
    if not found:
        raise RuntimeError(f"找不到 {name}，请安装或设置环境变量 CHATMEASURE_{name.upper()}")
    return found


FFMPEG = _find_tool("ffmpeg")
FFPROBE = _find_tool("ffprobe")

# showinfo 过滤器每帧打印一行，形如 "n:  12 pts:  200 pts_time:0.2 ..."
_SHOWINFO_RE = re.compile(r"\bn:\s*(\d+)\s+pts:\s*(-?\d+)\s+pts_time:\s*(-?[\d.eE+-]+)")


@dataclass(frozen=True)
class Rect:
    """矩形区域（原始分辨率像素），x/y 为左上角。"""

    x: int
    y: int
    w: int
    h: int

    @staticmethod
    def parse(text: str) -> "Rect":
        parts = [int(round(float(p))) for p in text.replace(" ", "").split(",")]
        if len(parts) != 4:
            raise ValueError(f"矩形格式应为 x,y,w,h：{text!r}")
        x, y, w, h = parts
        if w <= 0 or h <= 0:
            raise ValueError(f"矩形宽高必须为正：{text!r}")
        return Rect(x, y, w, h)

    @property
    def x2(self) -> int:
        return self.x + self.w

    @property
    def y2(self) -> int:
        return self.y + self.h

    def union(self, other: "Rect") -> "Rect":
        x, y = min(self.x, other.x), min(self.y, other.y)
        return Rect(x, y, max(self.x2, other.x2) - x, max(self.y2, other.y2) - y)

    def clamp(self, width: int, height: int) -> "Rect":
        x, y = max(0, self.x), max(0, self.y)
        x2, y2 = min(width, self.x2), min(height, self.y2)
        if x2 <= x or y2 <= y:
            raise ValueError(f"区域 {self} 不在画面 {width}x{height} 内")
        return Rect(x, y, x2 - x, y2 - y)

    def as_list(self) -> list[int]:
        return [self.x, self.y, self.w, self.h]


@dataclass
class VideoInfo:
    width: int
    height: int
    codec: str
    avg_frame_rate: float
    duration: float | None
    nb_frames: int | None


def _rate(text: str | None) -> float:
    if not text or text in ("0/0", "N/A"):
        return 0.0
    if "/" in text:
        a, b = text.split("/")
        return float(a) / float(b) if float(b) else 0.0
    return float(text)


def probe(path: str | Path) -> VideoInfo:
    """用 ffprobe 读视频流的基本信息。"""
    out = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries",
         "stream=width,height,codec_name,avg_frame_rate,nb_frames,duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True,
    ).stdout
    streams = json.loads(out).get("streams") or []
    if not streams:
        raise RuntimeError(f"{path} 里没有视频流")
    s = streams[0]
    nb = s.get("nb_frames")
    dur = s.get("duration")
    return VideoInfo(
        width=int(s["width"]), height=int(s["height"]), codec=str(s.get("codec_name", "")),
        avg_frame_rate=_rate(s.get("avg_frame_rate")),
        duration=float(dur) if dur not in (None, "N/A") else None,
        nb_frames=int(nb) if nb not in (None, "N/A") else None,
    )


def parse_showinfo(lines: list[str]) -> list[float]:
    """从 ffmpeg stderr 里按顺序取出 showinfo 打印的每帧 pts_time。"""
    ts: list[float] = []
    for line in lines:
        if "showinfo" not in line:
            continue
        m = _SHOWINFO_RE.search(line)
        if m:
            ts.append(float(m.group(3)))
    return ts


def _time_args(start: float | None, end: float | None) -> list[str]:
    # -ss/-to 作为输入选项：先快速定位再精确解码；配合 -copyts 保留原始时间戳
    args: list[str] = []
    if start is not None and start > 0:
        args += ["-ss", f"{start:.6f}"]
    if end is not None:
        args += ["-to", f"{end:.6f}"]
    return args


def _drain(stream, sink: list[str]) -> None:
    for raw in iter(stream.readline, b""):
        sink.append(raw.decode("utf-8", "replace"))
    stream.close()


class FrameSource:
    """逐帧读取 mp4（或 `frames` 子命令导出的帧目录）。

    迭代得到 (序号, RGB 帧)。时间戳在迭代结束后填进 `timestamps`（秒，原始 pts）。
    """

    def __init__(
        self,
        path: str | Path,
        *,
        start: float | None = None,
        end: float | None = None,
        crop: Rect | None = None,
        scale: float | None = None,
    ) -> None:
        self.path = Path(path)
        self.start, self.end = start, end
        self.is_dir = self.path.is_dir()
        self._dir_meta: dict | None = None
        if self.is_dir:
            meta = json.loads((self.path / "frames.json").read_text())
            self._dir_meta = meta
            self.width, self.height = int(meta["width"]), int(meta["height"])
            self.src_scale = float(meta.get("scale", 1.0))
            self.fps_hint = float(meta.get("avg_frame_rate", 0.0))
        else:
            info = probe(self.path)
            self.info = info
            self.width, self.height = info.width, info.height
            self.src_scale = 1.0
            self.fps_hint = info.avg_frame_rate
        self.scale = float(scale) if scale is not None else self.src_scale
        if not (0 < self.scale <= 1.0):
            raise ValueError("scale 取值应在 (0, 1]")
        rect = (crop or Rect(0, 0, self.width, self.height)).clamp(self.width, self.height)
        # 对齐到偶数，避免 yuv420 下裁剪时色度错位
        x, y = rect.x - rect.x % 2, rect.y - rect.y % 2
        x2 = min(self.width, rect.x2 + rect.x2 % 2)
        y2 = min(self.height, rect.y2 + rect.y2 % 2)
        self.crop = Rect(x, y, x2 - x, y2 - y)
        self.out_w = max(1, int(round(self.crop.w * self.scale)))
        self.out_h = max(1, int(round(self.crop.h * self.scale)))
        self.sx = self.crop.w / self.out_w
        self.sy = self.crop.h / self.out_h
        self.timestamps: list[float] = []
        self.frame_count = 0

    # ---- 坐标换算 ----
    def edge_y(self, y_out: float) -> float:
        """输出帧里的行边界（第 y_out 行的上沿）→ 原始坐标。"""
        return self.crop.y + y_out * self.sy

    def center_y(self, y_out: float) -> float:
        """输出帧里的行中心（第 y_out 行）→ 原始坐标中的行号。"""
        return self.crop.y + (y_out + 0.5) * self.sy - 0.5

    def out_y(self, y_full: float) -> float:
        """原始坐标的行边界 → 输出帧里的行边界。"""
        return (y_full - self.crop.y) / self.sy

    def out_x(self, x_full: float) -> float:
        return (x_full - self.crop.x) / self.sx

    def describe(self) -> dict:
        return {
            "input": str(self.path),
            "width": self.width,
            "height": self.height,
            "crop": self.crop.as_list(),
            "scale": self.scale,
            "frames": self.frame_count,
            "start": self.start,
            "end": self.end,
            "first_t": self.timestamps[0] if self.timestamps else None,
            "last_t": self.timestamps[-1] if self.timestamps else None,
        }

    # ---- 迭代 ----
    def __iter__(self) -> Iterator[tuple[int, np.ndarray]]:
        if self.is_dir:
            yield from self._iter_dir()
        else:
            yield from self._iter_video()

    def _iter_video(self) -> Iterator[tuple[int, np.ndarray]]:
        filters: list[str] = []
        c = self.crop
        if (c.x, c.y, c.w, c.h) != (0, 0, self.width, self.height):
            filters.append(f"crop={c.w}:{c.h}:{c.x}:{c.y}")
        if self.out_w != c.w or self.out_h != c.h:
            filters.append(f"scale={self.out_w}:{self.out_h}:flags=area")
        filters.append("showinfo")
        cmd = [FFMPEG, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info",
               *_time_args(self.start, self.end), "-copyts", "-i", str(self.path),
               "-map", "0:v:0", "-an", "-vf", ",".join(filters), "-fps_mode", "passthrough",
               "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]
        frame_bytes = self.out_w * self.out_h * 3
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=frame_bytes)
        err_lines: list[str] = []
        th = threading.Thread(target=_drain, args=(proc.stderr, err_lines), daemon=True)
        th.start()
        assert proc.stdout is not None
        i = 0
        try:
            while True:
                buf = proc.stdout.read(frame_bytes)
                if not buf or len(buf) < frame_bytes:
                    break
                yield i, np.frombuffer(buf, dtype=np.uint8).reshape(self.out_h, self.out_w, 3)
                i += 1
        finally:
            proc.stdout.close()
            try:
                rc = proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                proc.kill()
                rc = proc.wait()
            th.join()
        if rc != 0 and i == 0:
            raise RuntimeError("ffmpeg 解码失败：\n" + "".join(err_lines[-20:]))
        ts = parse_showinfo(err_lines)
        if len(ts) < i:
            # 理论上不会发生；兜底按平均帧率补齐
            fps = self.fps_hint or 60.0
            ts += [(len(ts) + k) / fps for k in range(i - len(ts))]
        self.timestamps = ts[:i]
        self.frame_count = i

    def _iter_dir(self) -> Iterator[tuple[int, np.ndarray]]:
        import cv2

        assert self._dir_meta is not None
        s0 = self.src_scale
        c = self.crop
        x0, y0 = int(round(c.x * s0)), int(round(c.y * s0))
        x1, y1 = int(round(c.x2 * s0)), int(round(c.y2 * s0))
        ts: list[float] = []
        i = 0
        for item in self._dir_meta["frames"]:
            t = float(item["t"])
            if self.start is not None and t < self.start - 1e-9:
                continue
            if self.end is not None and t >= self.end - 1e-9:
                continue
            img = cv2.imread(str(self.path / item["file"]), cv2.IMREAD_COLOR)
            if img is None:
                raise RuntimeError(f"读不了帧文件 {item['file']}")
            img = cv2.cvtColor(img[y0:y1, x0:x1], cv2.COLOR_BGR2RGB)
            if img.shape[1] != self.out_w or img.shape[0] != self.out_h:
                img = cv2.resize(img, (self.out_w, self.out_h), interpolation=cv2.INTER_AREA)
            ts.append(t)
            yield i, img
            i += 1
        self.timestamps = ts
        self.frame_count = i


def extract_frames(
    path: str | Path,
    out_dir: str | Path,
    *,
    start: float | None = None,
    end: float | None = None,
    scale: float = 1.0,
) -> dict:
    """把视频逐帧导出为 PNG（不丢帧、不补帧），并写 frames.json 记录每帧时间戳。"""
    info = probe(path)
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    filters: list[str] = []
    if scale != 1.0:
        w = max(2, int(round(info.width * scale)))
        h = max(2, int(round(info.height * scale)))
        filters.append(f"scale={w}:{h}:flags=area")
    filters.append("showinfo")
    cmd = [FFMPEG, "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info", "-y",
           *_time_args(start, end), "-copyts", "-i", str(path), "-map", "0:v:0", "-an",
           "-vf", ",".join(filters), "-fps_mode", "passthrough", "-start_number", "0",
           str(out / "frame_%06d.png")]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError("ffmpeg 抽帧失败：\n" + res.stderr[-2000:])
    ts = parse_showinfo(res.stderr.splitlines())
    files = sorted(p.name for p in out.glob("frame_*.png"))
    n = min(len(ts), len(files))
    frames = [{"index": k, "t": ts[k], "file": files[k]} for k in range(n)]
    meta = {
        "source": str(path),
        "width": info.width,
        "height": info.height,
        "scale": scale,
        "avg_frame_rate": info.avg_frame_rate,
        "start": start,
        "end": end,
        "frames": frames,
    }
    (out / "frames.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1))
    return meta
