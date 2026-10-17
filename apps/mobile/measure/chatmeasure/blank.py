"""blank：逐帧判断对话区是否「空白」（非背景像素占比低于阈值）。"""

from __future__ import annotations

import argparse

import numpy as np

from chatmeasure.common import Timer, base_result, hex_color, mode_color, non_bg_mask, parse_color, write_csv
from chatmeasure.stats import check, r, runs
from chatmeasure.video import FrameSource, Rect


def add_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--region", required=True, help="对话区 x,y,w,h（原始像素）")
    p.add_argument("--bg", default="auto", help="背景色 #RRGGBB，或 auto（首帧区域众数色），默认 auto")
    p.add_argument("--bg-tol", type=int, default=40, help="与背景色任一通道差超过它算非背景，默认 40")
    p.add_argument("--max-content-ratio", type=float, default=0.003,
                   help="非背景像素占比低于它判为空白，默认 0.003（0.3%%）")
    p.add_argument("--max-blank-frames", type=int, default=2,
                   help="检查项：允许的最长连续空白帧数，默认 2（T7）；T6 用 0")
    p.add_argument("--sample-step", type=int, default=2, help="横纵向抽样步长（加速），默认 2")


def run(a: argparse.Namespace) -> dict:
    timer = Timer()
    region = Rect.parse(a.region)
    src = FrameSource(a.input, start=a.start, end=a.end, crop=region, scale=a.scale)
    bg: tuple[int, int, int] | None = None if a.bg == "auto" else parse_color(a.bg)
    ratios: list[float] = []
    st = max(1, a.sample_step)
    for _, frame in src:
        if st > 1:
            frame = frame[::st, ::st]
        if bg is None:
            bg = mode_color(frame)
        ratios.append(float(non_bg_mask(frame, bg, a.bg_tol).mean()))
    t = src.timestamps
    ratio = np.asarray(ratios)
    blank = ratio < a.max_content_ratio
    rs = runs(blank)
    n = int(ratio.size)

    def _ms(s: int, e: int) -> float | None:
        # 空白持续时间：从第一帧空白到下一帧非空白出现
        return r((t[e] - t[s]) * 1000.0, 1) if e < n else None

    events = [{"start_frame": s, "start_t": r(t[s], 4), "frames": e - s, "duration_ms": _ms(s, e)}
              for s, e in rs]
    longest = max(rs, key=lambda se: se[1] - se[0]) if rs else None
    summary = {
        "frames": n,
        "blank_frames": int(blank.sum()),
        "blank_ratio": r(blank.mean() if n else 0.0, 5),
        "blank_runs": len(rs),
        "longest_blank_frames": (longest[1] - longest[0]) if longest else 0,
        "longest_blank_start_t": r(t[longest[0]], 4) if longest else None,
        "longest_blank_ms": _ms(*longest) if longest else None,
        "runs_over_limit": sum(1 for s, e in rs if e - s > a.max_blank_frames),
        "min_content_ratio": r(ratio.min(), 5) if n else None,
        "median_content_ratio": r(np.median(ratio), 5) if n else None,
    }
    res = base_result("blank", src, a.label, {
        "region": region.as_list(), "bg": hex_color(bg) if bg else None, "bg_tol": a.bg_tol,
        "max_content_ratio": a.max_content_ratio, "max_blank_frames": a.max_blank_frames,
    }, timer)
    res["summary"] = summary
    res["events"] = {"blank_runs": events}
    res["checks"] = [check("longest_blank_frames", summary["longest_blank_frames"], a.max_blank_frames)]
    write_csv(a.csv, ["frame", "t", "content_ratio", "blank"],
              ([i, t[i], ratio[i], int(blank[i])] for i in range(n)))
    return res
