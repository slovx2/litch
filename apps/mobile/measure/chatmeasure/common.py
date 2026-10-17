"""子命令共用的小工具：颜色解析、背景色、输出 JSON/CSV。"""

from __future__ import annotations

import csv
import json
import sys
import time
from pathlib import Path
from typing import Any, Iterable, Sequence

import cv2
import numpy as np

from chatmeasure.stats import r
from chatmeasure.video import FrameSource


def parse_color(text: str) -> tuple[int, int, int]:
    s = text.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if len(s) != 6:
        raise ValueError(f"颜色格式应为 #RRGGBB：{text!r}")
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def hex_color(c: Sequence[int]) -> str:
    return "#" + "".join(f"{int(v):02X}" for v in c)


def parse_range(text: str | None) -> tuple[int, int] | None:
    if not text:
        return None
    a, b = (int(round(float(p))) for p in text.split(","))
    if b <= a:
        raise ValueError(f"区间应为 起,止 且 止>起：{text!r}")
    return a, b


def mode_color(region: np.ndarray, quant: int = 8) -> tuple[int, int, int]:
    """区域内的众数色：先按 quant 量化再取众数，返回众数桶里像素的平均色。"""
    px = region.reshape(-1, 3)
    if px.shape[0] > 400_000:
        px = px[:: px.shape[0] // 400_000 + 1]
    q = (px // quant).astype(np.int32)
    key = (q[:, 0] << 16) | (q[:, 1] << 8) | q[:, 2]
    vals, counts = np.unique(key, return_counts=True)
    top = vals[np.argmax(counts)]
    sel = px[key == top]
    m = sel.mean(axis=0)
    return int(round(m[0])), int(round(m[1])), int(round(m[2]))


_BG_CACHE: dict[tuple, np.ndarray] = {}


def _bg_plane(shape: tuple[int, ...], bg: Sequence[int]) -> np.ndarray:
    key = (shape, tuple(int(v) for v in bg))
    plane = _BG_CACHE.get(key)
    if plane is None:
        if len(_BG_CACHE) > 16:
            _BG_CACHE.clear()
        plane = np.empty(shape, dtype=np.uint8)
        plane[:] = key[1]
        _BG_CACHE[key] = plane
    return plane


def non_bg_mask(region: np.ndarray, bg: Sequence[int], tol: int) -> np.ndarray:
    """非背景像素：任一通道与背景色相差超过 tol。"""
    diff = cv2.absdiff(region, _bg_plane(region.shape, bg))
    return diff.max(axis=2) > tol


class Timer:
    def __init__(self) -> None:
        self.t0 = time.perf_counter()

    def elapsed(self) -> float:
        return round(time.perf_counter() - self.t0, 3)


def base_result(command: str, src: FrameSource, label: str | None, params: dict, timer: Timer) -> dict:
    n = src.frame_count
    elapsed = timer.elapsed()
    return {
        "tool": "chatmeasure",
        "command": command,
        "label": label or Path(src.path).stem,
        "source": src.describe(),
        "params": params,
        "perf": {"elapsed_s": elapsed, "fps": r(n / elapsed if elapsed > 0 else 0.0, 1)},
    }


def emit(result: dict, json_path: str | None) -> None:
    text = json.dumps(result, ensure_ascii=False, indent=2, default=_json_default)
    if json_path and json_path != "-":
        Path(json_path).parent.mkdir(parents=True, exist_ok=True)
        Path(json_path).write_text(text + "\n")
        print(f"已写入 {json_path}", file=sys.stderr)
    else:
        print(text)


def _json_default(o: Any) -> Any:
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return r(float(o))
    if isinstance(o, np.ndarray):
        return o.tolist()
    if isinstance(o, Path):
        return str(o)
    raise TypeError(type(o))


def write_csv(path: str | None, header: Sequence[str], rows: Iterable[Sequence[Any]]) -> None:
    if not path:
        return
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(header)
        for row in rows:
            w.writerow(["" if (isinstance(x, float) and not np.isfinite(x)) or x is None else
                        (round(x, 4) if isinstance(x, float) else x) for x in row])
    print(f"已写入 {path}", file=sys.stderr)


def nan_list(a: np.ndarray) -> list[float | None]:
    return [None if not np.isfinite(x) else float(x) for x in a]
