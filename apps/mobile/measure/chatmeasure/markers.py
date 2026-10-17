"""markers：逐帧找新原型画的两条纯色标记线（内容末尾 #FF00FF、输入区上沿 #00FFFF）。

颜色匹配默认用「色度」方式：把像素减去自身灰度得到色度向量，看它在目标色方向上的投影
是否够大、方向是否够接近。这样对 H.264 4:2:0 色度下采样（细线色度被背景冲淡一半）、
亮度偏移都更稳。也可以用 rgb 方式（各通道差都不超过 tol）。
"""

from __future__ import annotations

import argparse

import numpy as np

from chatmeasure.common import Timer, base_result, parse_color, parse_range, write_csv
from chatmeasure.stats import (check, deviation_stats, detect_events, event_summary, jump_stats, r,
                               runs)
from chatmeasure.video import FrameSource, Rect


class ColorMatcher:
    def __init__(self, color: tuple[int, int, int], *, mode: str = "chroma", tol: int = 80,
                 min_ratio: float = 0.3, min_cos: float = 0.8) -> None:
        self.color = np.asarray(color, dtype=np.float32)
        self.mode = mode
        self.tol = tol
        self.min_cos = min_cos
        dev = self.color - self.color.mean()
        norm = float(np.linalg.norm(dev))
        if mode == "chroma" and norm < 30:
            raise ValueError("chroma 方式要求标记色是饱和色（如 #FF00FF）；灰色请用 --match rgb")
        self.dir = (dev / norm).astype(np.float32) if norm > 0 else np.zeros(3, np.float32)
        self.full_score = norm
        self.min_score = min_ratio * norm

    def match(self, f: np.ndarray, dev: np.ndarray | None, dnorm: np.ndarray | None) -> tuple[np.ndarray, np.ndarray]:
        """返回 (逐像素是否命中, 逐像素强度 0~1)。"""
        if self.mode == "rgb":
            diff = np.abs(f.astype(np.int16) - self.color.astype(np.int16)).max(axis=2)
            hit = diff <= self.tol
            strength = np.clip(1.0 - diff / max(1, 2 * self.tol), 0.0, 1.0).astype(np.float32)
            return hit, strength
        assert dev is not None and dnorm is not None
        score = dev @ self.dir
        hit = (score >= self.min_score) & (score >= self.min_cos * dnorm)
        strength = np.clip(score / self.full_score, 0.0, 1.0)
        return hit, strength


def _chroma(f: np.ndarray, mode: str) -> tuple[np.ndarray | None, np.ndarray | None]:
    if mode != "chroma":
        return None, None
    ff = f.astype(np.float32)
    dev = ff - ff.mean(axis=2, keepdims=True)
    return dev, np.sqrt((dev * dev).sum(axis=2))


def find_line(row_frac: np.ndarray, row_strength: np.ndarray, *, min_fill: float,
              max_rows: int) -> float:
    """在逐行命中率里找最像标记线的一段，返回加权中心行（输出帧坐标），找不到为 NaN。"""
    cand = [(a, b) for a, b in runs(row_frac >= min_fill) if b - a <= max_rows]
    if not cand:
        return float("nan")
    a, b = max(cand, key=lambda ab: float(row_frac[ab[0]:ab[1]].sum()))
    lo, hi = max(0, a - 1), min(row_frac.size, b + 1)
    w = row_strength[lo:hi] * (row_frac[lo:hi] >= min_fill * 0.25)
    if w.sum() <= 0:
        return (a + b - 1) / 2.0
    return float((np.arange(lo, hi) * w).sum() / w.sum())


def add_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--content-color", default="#FF00FF", help="内容末尾线颜色，默认 #FF00FF")
    p.add_argument("--input-color", default="#00FFFF", help="输入区上沿线颜色，默认 #00FFFF")
    p.add_argument("--match", choices=["chroma", "rgb"], default="chroma", help="颜色匹配方式")
    p.add_argument("--tol", type=int, default=80, help="rgb 方式的通道容差，默认 80")
    p.add_argument("--min-ratio", type=float, default=0.3,
                   help="chroma 方式：色度投影至少达到目标色的比例，默认 0.3")
    p.add_argument("--min-cos", type=float, default=0.8, help="chroma 方式：色度方向相似度下限，默认 0.8")
    p.add_argument("--x-range", help="标记线所在横向区间 x0,x1（原始像素），默认全宽")
    p.add_argument("--y-range", help="只在这个纵向区间里找 y0,y1，默认全高")
    p.add_argument("--min-fill", type=float, default=0.6, help="一行里命中像素的最小占比，默认 0.6")
    p.add_argument("--max-thickness", type=int, default=12, help="线的最大厚度（原始像素），默认 12")
    p.add_argument("--col-step", type=int, default=2, help="细查时的横向抽样步长，默认 2")
    p.add_argument("--coarse-step", type=int, default=16, help="粗查候选行时的横向抽样步长，默认 16")
    p.add_argument("--steady", type=float, help="稳态距离（px），默认取中位数")
    p.add_argument("--line-height-dp", type=float, help="行高（dp），给出时检查最大偏差不超过一个行高")


def run(a: argparse.Namespace) -> dict:
    timer = Timer()
    full = FrameSource(a.input)  # 只为拿到画面尺寸
    xr = parse_range(a.x_range) or (0, full.width)
    yr = parse_range(a.y_range) or (0, full.height)
    src = FrameSource(a.input, start=a.start, end=a.end, crop=Rect(xr[0], yr[0], xr[1] - xr[0], yr[1] - yr[0]),
                      scale=a.scale)
    mk = dict(mode=a.match, tol=a.tol, min_ratio=a.min_ratio, min_cos=a.min_cos)
    cm = ColorMatcher(parse_color(a.content_color), **mk)
    im = ColorMatcher(parse_color(a.input_color), **mk)
    max_rows = max(2, int(np.ceil(a.max_thickness / src.sy)) + 2)
    step = max(1, a.col_step)
    coarse = max(step, a.coarse_step)
    cys: list[float] = []
    iys: list[float] = []
    for _, frame in src:
        # 第一遍：横向粗抽样，快速找候选行；第二遍只在候选行附近细查
        fc = frame[:, ::coarse]
        devc, normc = _chroma(fc, a.match)
        ys = []
        for m in (cm, im):
            hit_c, _ = m.match(fc, devc, normc)
            cand = np.flatnonzero(hit_c.mean(axis=1) >= a.min_fill * 0.5)
            if cand.size == 0:
                ys.append(float("nan"))
                continue
            rows = np.unique(np.clip((cand[:, None] + np.arange(-2, 3)[None, :]).ravel(), 0, frame.shape[0] - 1))
            sub = frame[rows, ::step]
            dev, dnorm = _chroma(sub, a.match)
            hit, strength = m.match(sub, dev, dnorm)
            frac = np.zeros(frame.shape[0], np.float32)
            stren = np.zeros(frame.shape[0], np.float32)
            frac[rows] = hit.mean(axis=1)
            stren[rows] = strength.mean(axis=1)
            y = find_line(frac, stren, min_fill=a.min_fill, max_rows=max_rows)
            ys.append(src.center_y(y) if np.isfinite(y) else float("nan"))
        cys.append(ys[0])
        iys.append(ys[1])
    t = src.timestamps
    cy, iy = np.asarray(cys), np.asarray(iys)
    dist = iy - cy
    d = a.density
    tol_px = (a.rebound_tol_dp if a.rebound_tol_dp is not None else a.threshold_dp) * d
    dstats = deviation_stats(dist, t, density=d, threshold_dp=a.threshold_dp, steady=a.steady,
                             line_height_dp=a.line_height_dp)
    rebounds, steps = detect_events(dist, t, tol_px=tol_px, max_frames=a.rebound_frames, density=d)
    checks = [
        check("missing_frames", dstats["missing_frames"], 0, "=="),
        check("p99_abs_dev_dp", dstats.get("abs_dev_p99_dp"), a.threshold_dp),
        check("over_threshold_ratio", dstats.get("over_threshold_ratio"), 0.01),
        check("longest_over_run_frames", dstats.get("longest_over_run_frames"), 1),
    ]
    if a.line_height_dp:
        checks.append(check("max_abs_dev_dp", dstats.get("abs_dev_max_dp"), a.line_height_dp))
    res = base_result("markers", src, a.label, {
        "density": d, "threshold_dp": a.threshold_dp, "content_color": a.content_color,
        "input_color": a.input_color, "match": a.match, "x_range": list(xr), "y_range": list(yr),
        "min_fill": a.min_fill, "rebound_frames": a.rebound_frames, "rebound_tol_px": r(tol_px),
    }, timer)
    res["summary"] = {
        "distance": dstats,
        "events": event_summary(rebounds, steps, max_frames=a.rebound_frames, tol_px=tol_px),
        "content_line": {"missing_frames": int(np.isnan(cy).sum()),
                         **jump_stats(cy, density=d, threshold_dp=a.threshold_dp)},
        "input_line": {"missing_frames": int(np.isnan(iy).sum()),
                       **jump_stats(iy, density=d, threshold_dp=a.threshold_dp)},
    }
    res["events"] = {"rebounds": rebounds, "steps": steps}
    res["checks"] = checks
    write_csv(a.csv, ["frame", "t", "content_y", "input_y", "distance_px", "deviation_px"],
              ([i, t[i], cy[i], iy[i], dist[i], dist[i] - (dstats.get("steady_px") or 0.0)]
               for i in range(len(t))))
    return res
