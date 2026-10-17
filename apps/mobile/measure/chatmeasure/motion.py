"""motion：估计给定区域内容在相邻帧之间的垂直位移（向下为正）。

方法：
- template（默认）：取上一帧区域中间一段作模板，在当前帧里只沿纵向搜索，归一化互相关取最大。
- phase：相位相关（cv2.phaseCorrelate），整块区域一次估计。
为了快，先把区域横向压缩成 --profile-width 列（纵向分辨率不变），纵向位移不受影响。
区域几乎全是背景（灰度标准差 < --min-std）或匹配置信度低时，标记为不可靠，不给数。
"""

from __future__ import annotations

import argparse

import cv2
import numpy as np

from chatmeasure.common import Timer, base_result, write_csv
from chatmeasure.stats import check, r
from chatmeasure.video import FrameSource, Rect


def add_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--region", required=True, help="分析区域 x,y,w,h（原始像素）")
    p.add_argument("--method", choices=["template", "phase"], default="template", help="默认 template")
    p.add_argument("--max-shift", type=float, help="单帧最大可测位移（原始像素），默认区域高度的 1/4")
    p.add_argument("--subpixel", action="store_true", help="输出亚像素位移（默认取整）")
    p.add_argument("--profile-width", type=int, default=96, help="横向压缩后的列数，默认 96；0 表示不压缩")
    p.add_argument("--min-std", type=float, default=3.0, help="低纹理判定：灰度标准差下限，默认 3")
    p.add_argument("--min-confidence", type=float,
                   help="匹配置信度下限：template 默认 0.6（相关系数），phase 默认 0.05（峰值响应）")
    p.add_argument("--expect", choices=["up", "down", "none", "any"], default="up",
                   help="预期运动方向：up=内容只上移或不动（流式贴底），none=应静止，默认 up")
    p.add_argument("--move-threshold-px", type=float, default=1.0, help="|位移| 达到它才算一次移动，默认 1px")
    p.add_argument("--jitter-window", type=int, default=3, help="方向在这么多帧内反复算抖动，默认 3")


def _prep(frame: np.ndarray, width: int) -> np.ndarray:
    g = cv2.cvtColor(np.ascontiguousarray(frame), cv2.COLOR_RGB2GRAY)
    if width and g.shape[1] > width:
        g = cv2.resize(g, (width, g.shape[0]), interpolation=cv2.INTER_AREA)
    return g.astype(np.float32)


def _parabola(vm: float, v0: float, vp: float) -> float:
    den = vm - 2 * v0 + vp
    if den >= 0 or not np.isfinite(den):
        return 0.0
    return float(np.clip(0.5 * (vm - vp) / den, -0.5, 0.5))


def shift_template(prev: np.ndarray, cur: np.ndarray, m: int, subpixel: bool) -> tuple[float, float, bool]:
    """返回 (dy 输出坐标, 置信度, 是否顶到搜索边界)。"""
    h = prev.shape[0]
    tmpl = prev[m: h - m]
    res = cv2.matchTemplate(cur, tmpl, cv2.TM_CCOEFF_NORMED)[:, 0]
    k = int(np.argmax(res))
    conf = float(res[k])
    dy = float(k - m)
    if subpixel and 0 < k < res.size - 1:
        dy += _parabola(float(res[k - 1]), float(res[k]), float(res[k + 1]))
    return dy, conf, k in (0, res.size - 1)


class PhaseShift:
    def __init__(self, shape: tuple[int, int]) -> None:
        self.win = cv2.createHanningWindow((shape[1], shape[0]), cv2.CV_32F)

    def __call__(self, prev: np.ndarray, cur: np.ndarray, m: int, subpixel: bool) -> tuple[float, float, bool]:
        (_, dy), resp = cv2.phaseCorrelate(prev, cur, self.win)
        dy = float(dy)
        if not subpixel:
            dy = float(round(dy))
        return dy, float(resp), abs(dy) > m


def run(a: argparse.Namespace) -> dict:
    timer = Timer()
    region = Rect.parse(a.region)
    src = FrameSource(a.input, start=a.start, end=a.end, crop=region, scale=a.scale)
    max_shift = a.max_shift if a.max_shift is not None else region.h / 4
    m = max(1, min(int(round(max_shift / src.sy)), src.out_h // 3))
    min_conf = a.min_confidence if a.min_confidence is not None else (0.6 if a.method == "template" else 0.05)
    phase: PhaseShift | None = None
    dys: list[float] = []
    confs: list[float] = []
    flags: list[str] = []
    prev: np.ndarray | None = None
    for _, frame in src:
        cur = _prep(frame, a.profile_width)
        if prev is None:
            dys.append(float("nan")); confs.append(float("nan")); flags.append("first")
            prev = cur
            continue
        tex = min(float(prev[m:-m].std()), float(cur.std()))
        if tex < a.min_std:
            dys.append(float("nan")); confs.append(float("nan")); flags.append("low_texture")
        else:
            if a.method == "template":
                dy, conf, edge = shift_template(prev, cur, m, a.subpixel)
            else:
                if phase is None:
                    phase = PhaseShift(cur.shape)
                dy, conf, edge = phase(prev, cur, m, a.subpixel)
            if conf < min_conf:
                dys.append(float("nan")); confs.append(conf); flags.append("low_confidence")
            elif edge:
                dys.append(float("nan")); confs.append(conf); flags.append("out_of_range")
            else:
                dys.append(dy * src.sy); confs.append(conf); flags.append("ok")
        prev = cur
    t = src.timestamps
    dy = np.asarray(dys, dtype=np.float64)
    ok = np.isfinite(dy)
    d = a.density
    thr = a.move_threshold_px
    moves = ok & (np.abs(dy) >= thr)
    if a.expect == "up":
        reverse = ok & (dy >= thr)
    elif a.expect == "down":
        reverse = ok & (dy <= -thr)
    elif a.expect == "none":
        reverse = moves
    else:
        reverse = np.zeros_like(ok)
    # 方向反复：相邻两次移动方向相反
    mv_idx = np.flatnonzero(moves)
    signs = np.sign(dy[mv_idx])
    changes = np.flatnonzero(signs[1:] != signs[:-1])
    quick = [int(mv_idx[c + 1]) for c in changes if mv_idx[c + 1] - mv_idx[c] <= a.jitter_window]
    cum = np.cumsum(np.where(ok, dy, 0.0))
    absdy = np.abs(dy[ok])
    n = int(dy.size)
    pairs = max(0, n - 1)
    flag_counts = {k: flags.count(k) for k in ("ok", "low_texture", "low_confidence", "out_of_range")}
    reverse_events = [{"frame": int(i), "t": r(t[i], 4), "dy_px": r(dy[i]), "dy_dp": r(dy[i] / d),
                       "confidence": r(confs[i])} for i in np.flatnonzero(reverse)]
    summary = {
        "pairs": pairs,
        "reliable_pairs": flag_counts["ok"],
        "unreliable_pairs": pairs - flag_counts["ok"],
        "unreliable_breakdown": {k: v for k, v in flag_counts.items() if k != "ok"},
        "moving_pairs": int(moves.sum()),
        "expect": a.expect,
        "reverse_moves": int(reverse.sum()),
        "direction_changes": int(changes.size),
        "quick_direction_changes": len(quick),
        "max_abs_step_px": r(absdy.max()) if absdy.size else None,
        "max_abs_step_dp": r(absdy.max() / d) if absdy.size else None,
        "p95_abs_step_px": r(np.percentile(absdy, 95)) if absdy.size else None,
        "net_displacement_px": r(cum[-1]) if n else None,
        "max_abs_cumulative_px": r(np.abs(cum).max()) if n else None,
        "max_abs_cumulative_dp": r(np.abs(cum).max() / d) if n else None,
    }
    checks = []
    if a.expect in ("up", "down", "none"):
        checks.append(check("reverse_moves", summary["reverse_moves"], 0, "=="))
    if a.expect == "none":
        checks.append(check("max_abs_cumulative_dp", summary["max_abs_cumulative_dp"], a.threshold_dp))
    checks.append(check("quick_direction_changes", len(quick), 0, "=="))
    res = base_result("motion", src, a.label, {
        "density": d, "region": region.as_list(), "method": a.method, "max_shift_px": r(m * src.sy),
        "min_std": a.min_std, "min_confidence": min_conf, "expect": a.expect,
        "move_threshold_px": thr, "subpixel": a.subpixel, "profile_width": a.profile_width,
    }, timer)
    res["summary"] = summary
    res["events"] = {"reverse_moves": reverse_events,
                     "quick_direction_changes": [{"frame": i, "t": r(t[i], 4), "dy_px": r(dy[i])} for i in quick]}
    res["checks"] = checks
    write_csv(a.csv, ["frame", "t", "dy_px", "confidence", "flag", "cumulative_px"],
              ([i, t[i], dy[i], confs[i], flags[i], cum[i]] for i in range(n)))
    return res
