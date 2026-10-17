"""gap：给没有标记线的旧应用用。逐帧找对话区里最下面一行内容的下沿，算它到输入区上沿的距离。

- 内容行：该行非背景像素数 ≥ --min-row-pixels，且连续这样的行 ≥ --min-run-rows（滤掉噪点）。
- 输入区上沿：固定值，或在给定纵向范围内逐帧找一条横贯的水平边缘（相邻两行差异明显的列占比最高的那条）。
- 只在输入区上沿以上找内容，避免把输入区本身当成内容。
"""

from __future__ import annotations

import argparse

import numpy as np

from chatmeasure.common import (Timer, base_result, hex_color, mode_color, non_bg_mask, parse_color,
                                parse_range, write_csv)
from chatmeasure.stats import check, deviation_stats, detect_events, event_summary, jump_stats, r, runs
from chatmeasure.video import FrameSource, Rect


def add_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--region", required=True, help="对话区 x,y,w,h（原始像素）")
    p.add_argument("--bg", default="auto", help="背景色 #RRGGBB，或 auto（取首帧对话区众数色），默认 auto")
    p.add_argument("--bg-tol", type=int, default=40, help="与背景色任一通道差超过它算非背景，默认 40")
    p.add_argument("--min-row-pixels", type=int, default=6,
                   help="一行非背景像素数（原始像素）达到它才算内容，默认 6")
    p.add_argument("--min-run-rows", type=int, default=2, help="内容至少连续几行（原始像素），默认 2")
    p.add_argument("--input-top", default="auto",
                   help="输入区上沿 y（原始像素），或 auto（配合 --input-search 逐帧检测），默认 auto")
    p.add_argument("--input-search", help="auto 时搜索输入区上沿的纵向范围 y0,y1")
    p.add_argument("--edge-tol", type=int, default=8, help="水平边缘：相邻两行通道差超过它算有差异，默认 8")
    p.add_argument("--min-edge-fill", type=float, default=0.6, help="水平边缘：有差异的列占比下限，默认 0.6")
    p.add_argument("--col-step", type=int, default=2, help="找输入区边缘时的横向抽样步长，默认 2")
    p.add_argument("--steady", type=float, help="稳态距离（px），默认取中位数")
    p.add_argument("--line-height-dp", type=float, help="行高（dp），给出时检查最大偏差不超过一个行高")


def detect_edge(band: np.ndarray, edge_tol: int, min_fill: float) -> float:
    """band 里最强的一条横贯边缘，返回边缘下方那一行的行号（band 内坐标），没有则 NaN。"""
    if band.shape[0] < 2:
        return float("nan")
    b = band.astype(np.int16)
    diff = np.abs(b[1:] - b[:-1]).max(axis=2) > edge_tol
    frac = diff.mean(axis=1)
    k = int(np.argmax(frac))
    if frac[k] < min_fill:
        return float("nan")
    return float(k + 1)


def content_bottom(mask_rows: np.ndarray, min_run: int) -> float:
    """逐行内容标记里，最后一段长度 ≥ min_run 的连续内容的下沿（不含），没有则 NaN。"""
    for a, b in reversed(runs(mask_rows)):
        if b - a >= min_run:
            return float(b)
    return float("nan")


def scan_bottom(region: np.ndarray, bg: tuple[int, int, int], tol: int, min_px: int, min_run: int,
                chunk: int = 96) -> float:
    """从下往上分块找最下面一段内容，内容一般就在底部附近，大多只需看一两块。"""
    h = region.shape[0]
    flags = np.zeros(h, dtype=bool)
    hi = h
    while hi > 0:
        lo = max(0, hi - chunk)
        flags[lo:hi] = non_bg_mask(region[lo:hi], bg, tol).sum(axis=1) >= min_px
        for a, b in reversed(runs(flags[lo:])):
            a, b = a + lo, b + lo
            if b - a >= min_run:
                return float(b)
            if a == lo and lo > 0:
                break  # 这段可能向上延伸，读下一块再判断
        hi = lo
    return float("nan")


def run(a: argparse.Namespace) -> dict:
    timer = Timer()
    region = Rect.parse(a.region)
    auto_top = str(a.input_top).lower() == "auto"
    crop = region
    search = None
    if auto_top:
        search = parse_range(a.input_search)
        if not search:
            raise SystemExit("--input-top auto 时需要 --input-search y0,y1")
        crop = crop.union(Rect(region.x, search[0], region.w, search[1] - search[0]))
    else:
        fixed_top = float(a.input_top)
    src = FrameSource(a.input, start=a.start, end=a.end, crop=crop, scale=a.scale)
    rx0, rx1 = int(round(src.out_x(region.x))), int(round(src.out_x(region.x2)))
    ry0, ry1 = int(round(src.out_y(region.y))), int(round(src.out_y(region.y2)))
    if search:
        sy0, sy1 = int(round(src.out_y(search[0]))), int(round(src.out_y(search[1])))
    min_px = max(1, int(round(a.min_row_pixels / src.sx)))
    min_run = max(1, int(round(a.min_run_rows / src.sy)))
    bg: tuple[int, int, int] | None = None if a.bg == "auto" else parse_color(a.bg)
    cbs: list[float] = []
    its: list[float] = []
    for _, frame in src:
        if bg is None:
            bg = mode_color(frame[ry0:ry1, rx0:rx1])
        if auto_top:
            e = detect_edge(frame[sy0:sy1, rx0:rx1:max(1, a.col_step)], a.edge_tol, a.min_edge_fill)
            it_out = sy0 + e if np.isfinite(e) else float("nan")
            it_full = src.edge_y(it_out) if np.isfinite(it_out) else float("nan")
        else:
            it_full = fixed_top
            it_out = src.out_y(fixed_top)
        lim = ry1 if not np.isfinite(it_out) else int(min(ry1, max(ry0, int(np.floor(it_out)))))
        b = scan_bottom(frame[ry0:lim, rx0:rx1], bg, a.bg_tol, min_px, min_run)
        cbs.append(src.edge_y(ry0 + b) if np.isfinite(b) else float("nan"))
        its.append(it_full)
    t = src.timestamps
    cb, it = np.asarray(cbs, dtype=np.float64), np.asarray(its, dtype=np.float64)
    dist = it - cb
    d = a.density
    tol_px = (a.rebound_tol_dp if a.rebound_tol_dp is not None else a.threshold_dp) * d
    dstats = deviation_stats(dist, t, density=d, threshold_dp=a.threshold_dp, steady=a.steady,
                             line_height_dp=a.line_height_dp)
    rebounds, steps = detect_events(dist, t, tol_px=tol_px, max_frames=a.rebound_frames, density=d)
    checks = [
        check("missing_frames", dstats["missing_frames"], 0, "=="),
        check("p99_abs_dev_dp", dstats.get("abs_dev_p99_dp"), a.threshold_dp),
        check("rebound_count", len(rebounds), 0, "=="),
    ]
    if a.line_height_dp:
        checks.append(check("max_abs_dev_dp", dstats.get("abs_dev_max_dp"), a.line_height_dp))
    res = base_result("gap", src, a.label, {
        "density": d, "threshold_dp": a.threshold_dp, "region": region.as_list(),
        "bg": hex_color(bg) if bg else None, "bg_tol": a.bg_tol, "min_row_pixels": a.min_row_pixels,
        "min_run_rows": a.min_run_rows, "input_top": a.input_top, "input_search": list(search) if search else None,
        "rebound_frames": a.rebound_frames, "rebound_tol_px": r(tol_px),
    }, timer)
    res["summary"] = {
        "distance": dstats,
        "events": event_summary(rebounds, steps, max_frames=a.rebound_frames, tol_px=tol_px),
        "content_bottom": {"missing_frames": int(np.isnan(cb).sum()),
                           **jump_stats(cb, density=d, threshold_dp=a.threshold_dp)},
        "input_top": {"missing_frames": int(np.isnan(it).sum()),
                      **jump_stats(it, density=d, threshold_dp=a.threshold_dp)},
    }
    res["events"] = {"rebounds": rebounds, "steps": steps}
    res["checks"] = checks
    steady = dstats.get("steady_px") or 0.0
    write_csv(a.csv, ["frame", "t", "content_bottom", "input_top", "distance_px", "deviation_px"],
              ([i, t[i], cb[i], it[i], dist[i], dist[i] - steady] for i in range(len(t))))
    return res

