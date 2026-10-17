"""合成测试视频：模拟聊天界面流式输出，带已知的回弹、空白、向下跳动，并给出逐帧真值。

自测和性能测试都用它。命令行：
    uv run python -m chatmeasure.synth OUT.mp4 [--frames 300] [--codec h264|lossless] [--no-markers]
"""

from __future__ import annotations

import argparse
import json
import subprocess
from dataclasses import asdict, dataclass, field
from pathlib import Path

import numpy as np

from chatmeasure.video import FFMPEG

MAGENTA = (255, 0, 255)
CYAN = (0, 255, 255)
WHITE = (255, 255, 255)
INPUT_BG = (232, 232, 232)
HEADER_BG = (245, 245, 245)


@dataclass
class SynthConfig:
    width: int = 1080
    height: int = 2400
    fps: int = 60
    frames: int = 300
    region_top: int = 200          # 对话区上沿（之上是标题栏）
    input_top: int = 2000          # 输入区上沿
    line_h: int = 50               # 行高
    glyph_h: int = 30              # 「文字块」高度
    base_gap: int = 60             # 内容末尾到输入区上沿的稳态距离
    left: int = 40
    initial_lines: int = 24
    line_every: int = 12           # 每隔多少帧新起一行
    line_phase: int = 6
    markers: bool = True
    seed: int = 7
    # (起始帧, 结束帧(不含), 内容末尾的位移 px，正数=向下)
    offsets: list[tuple[int, int, int]] = field(default_factory=lambda: [
        (60, 61, 40),      # 回弹：1 帧，向下 40（被输入区遮住一截）
        (120, 122, -25),   # 回弹：2 帧，向上 25
        (100, 105, 20),    # 5 帧的偏离：超过 3 帧，应判为两次阶跃而不是回弹
        (180, 183, 15),    # 回弹：3 帧，向下 15
        (240, 260, 30),    # 向下跳 30 并停住（阶跃）
        (260, 280, -20),   # 再向上一个行高（阶梯式变化）
        (280, 10**9, -70), # 再向上一个行高
    ])
    blank: tuple[int, int] = (200, 210)  # 对话区空白的帧区间（不含结束帧）


def _offset(cfg: SynthConfig, f: int) -> int:
    for a, b, off in cfg.offsets:
        if a <= f < b:
            return off
    return 0


def _line_words(rng: np.random.Generator, max_w: int) -> tuple[int, list[tuple[int, int]]]:
    """一行「文字」：若干个词块，返回 (总宽, [(x0,x1)...])，坐标相对行首。"""
    total = int(rng.integers(320, max_w))
    words: list[tuple[int, int]] = []
    x = 0
    while x < total:
        w = int(rng.integers(30, 140))
        words.append((x, min(total, x + w)))
        x += w + int(rng.integers(14, 26))
    return total, words


class ChatSynth:
    def __init__(self, cfg: SynthConfig) -> None:
        self.cfg = cfg
        rng = np.random.default_rng(cfg.seed)
        n_add = (cfg.frames - cfg.line_phase) // cfg.line_every + 2
        self.lines = [_line_words(rng, cfg.width - 2 * cfg.left) for _ in range(cfg.initial_lines + n_add)]
        base = np.empty((cfg.height, cfg.width, 3), dtype=np.uint8)
        base[:] = WHITE
        base[: cfg.region_top] = HEADER_BG
        base[60:140, 400:680] = (60, 60, 60)  # 标题
        base[cfg.input_top:] = INPUT_BG
        base[cfg.input_top + 40: cfg.input_top + 140, 40: 900] = WHITE  # 输入框
        base[cfg.input_top + 50: cfg.input_top + 130, 920: 1040] = (30, 110, 220)  # 发送按钮
        self.base = base

    def line_count(self, f: int) -> int:
        c = self.cfg
        added = 0 if f < c.line_phase else (f - c.line_phase) // c.line_every + 1
        return c.initial_lines + added

    def truth(self, f: int) -> dict:
        c = self.cfg
        cb = c.input_top - c.base_gap + _offset(c, f)
        blank = c.blank[0] <= f < c.blank[1]
        n = self.line_count(f)
        return {
            "frame": f,
            "t": f / c.fps,
            "content_bottom": cb,
            "blank": blank,
            "n_lines": n,
            "magenta_y": None if blank or not c.markers else cb + 8 + 0.5,
            "cyan_y": (c.input_top - 2 + 0.5) if c.markers else None,
            "input_top": c.input_top,
        }

    def line_bottom(self, f: int, i: int) -> int:
        """第 i 行文字块的下沿（不含）在第 f 帧的 y。"""
        tr = self.truth(f)
        return tr["content_bottom"] - (tr["n_lines"] - 1 - i) * self.cfg.line_h

    def render(self, f: int) -> np.ndarray:
        c = self.cfg
        img = self.base.copy()
        tr = self.truth(f)
        if c.markers:
            img[c.input_top - 2: c.input_top, :] = CYAN
        if tr["blank"]:
            return img
        n = tr["n_lines"]
        cb = tr["content_bottom"]
        add_frame = c.line_phase + (n - c.initial_lines - 1) * c.line_every if n > c.initial_lines else -10**6
        for i in range(n):
            bottom = cb - (n - 1 - i) * c.line_h
            top = bottom - c.glyph_h
            if bottom <= c.region_top:
                continue
            y0, y1 = max(top, c.region_top), min(bottom, c.input_top)
            if y1 <= y0:
                continue
            total, words = self.lines[i]
            if i == n - 1:  # 最后一行逐帧写满
                total = min(total, 80 + (f - add_frame) * 60)
            for a, b in words:
                if a >= total:
                    break
                img[y0:y1, c.left + a: c.left + min(b, total)] = (20, 20, 20)
        if c.markers:
            my = cb + 8
            if c.region_top <= my and my + 2 <= c.input_top:
                img[my: my + 2, :] = MAGENTA
        return img


def encoder_args(codec: str) -> list[str]:
    if codec == "h264":
        # 模拟 screenrecord：H.264、yuv420p、20Mbps、无 B 帧
        return ["-c:v", "libx264", "-preset", "veryfast", "-bf", "0", "-b:v", "20M",
                "-maxrate", "20M", "-bufsize", "40M", "-pix_fmt", "yuv420p"]
    if codec == "lossless":
        return ["-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", "-pix_fmt", "rgb24"]
    raise ValueError(codec)


def write_video(cfg: SynthConfig, out: str | Path, codec: str = "h264",
                extra_vf: str | None = None) -> list[dict]:
    """渲染并编码，返回逐帧真值（同时写到 OUT.truth.json）。"""
    synth = ChatSynth(cfg)
    out = Path(out)
    cmd = [FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
           "-s", f"{cfg.width}x{cfg.height}", "-framerate", str(cfg.fps), "-i", "pipe:0"]
    if extra_vf:
        cmd += ["-vf", extra_vf, "-fps_mode", "passthrough"]
    cmd += [*encoder_args(codec), "-movflags", "+faststart", str(out)]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None
    truth = []
    for f in range(cfg.frames):
        proc.stdin.write(synth.render(f).tobytes())
        truth.append(synth.truth(f))
    proc.stdin.close()
    if proc.wait() != 0:
        raise RuntimeError("ffmpeg 编码失败")
    meta = {"config": asdict(cfg), "codec": codec, "truth": truth}
    out.with_suffix(".truth.json").write_text(json.dumps(meta))
    return truth


def main() -> int:
    ap = argparse.ArgumentParser(description="合成聊天界面测试视频")
    ap.add_argument("out")
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--codec", choices=["h264", "lossless"], default="h264")
    ap.add_argument("--no-markers", action="store_true")
    ap.add_argument("--repeat-events", action="store_true",
                    help="长视频时每 300 帧重复一遍事件（性能测试用）")
    a = ap.parse_args()
    cfg = SynthConfig(frames=a.frames, markers=not a.no_markers)
    if a.repeat_events:
        offs, blank = cfg.offsets, cfg.blank
        cfg.offsets = [(s + k * 300, min(e, 300) + k * 300, o) for k in range(a.frames // 300 + 1)
                       for s, e, o in offs]
        cfg.blank = blank
    write_video(cfg, a.out, a.codec)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
