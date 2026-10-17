"""track：在参考帧上框一个矩形（被点的那一行、锚点行），在后续帧里沿纵向做模板匹配跟踪它的 y。

只纵向搜索（横向位置固定为参考矩形的 x）。默认 --follow：每帧以上一次找到的位置为中心搜索，
可以跟住大位移而搜索范围仍然小。置信度低于阈值的帧记为「丢失」。
"""

from __future__ import annotations

import argparse

import cv2
import numpy as np

from chatmeasure.common import Timer, base_result, parse_range, write_csv
from chatmeasure.motion import _parabola
from chatmeasure.stats import check, jump_stats, r
from chatmeasure.video import FrameSource, Rect


def add_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--rect", required=True, help="参考帧上的目标矩形 x,y,w,h（原始像素）")
    p.add_argument("--ref-frame", type=int, default=0, help="参考帧序号（相对于分析起点），默认 0")
    p.add_argument("--ref-time", type=float, help="参考帧时间（秒），给出时从这一刻开始分析，优先于 --ref-frame")
    p.add_argument("--search", type=float, default=200.0, help="纵向搜索半径（原始像素），默认 200")
    p.add_argument("--min-confidence", type=float, default=0.7, help="匹配置信度下限（相关系数），默认 0.7")
    p.add_argument("--min-std", type=float, default=3.0, help="模板灰度标准差下限，太平的模板会报错")
    p.add_argument("--no-follow", action="store_true", help="始终以参考位置为中心搜索")
    p.add_argument("--y-range", help="只在这个纵向区间里找 y0,y1，默认全高")


def run(a: argparse.Namespace) -> dict:
    timer = Timer()
    rect = Rect.parse(a.rect)
    start = a.start
    if a.ref_time is not None:
        start = a.ref_time if start is None else max(start, a.ref_time)
    probe_src = FrameSource(a.input)
    yr = parse_range(a.y_range) or (0, probe_src.height)
    # 横向裁到矩形的 x 范围（对齐偶数可能多出 1 列，下面再按原始 x 精确切）
    src = FrameSource(a.input, start=start, end=a.end,
                      crop=Rect(rect.x, yr[0], rect.w, yr[1] - yr[0]), scale=a.scale)
    x0 = int(round(src.out_x(rect.x)))
    x1 = max(x0 + 1, int(round(src.out_x(rect.x2))))
    ref_idx = 0 if a.ref_time is not None else a.ref_frame
    s_out = max(1, int(round(a.search / src.sy)))
    tmpl: np.ndarray | None = None
    ref_y_out = src.out_y(rect.y)
    th = 0
    ys: list[float] = []
    confs: list[float] = []
    frames_idx: list[int] = []
    last = ref_y_out
    for i, frame in src:
        if i < ref_idx:
            continue
        g = cv2.cvtColor(np.ascontiguousarray(frame[:, x0:x1]), cv2.COLOR_RGB2GRAY).astype(np.float32)
        if tmpl is None:
            yo = int(round(ref_y_out))
            th = max(2, int(round(rect.h / src.sy)))
            tmpl = g[yo: yo + th].copy()
            if tmpl.shape[0] < th or float(tmpl.std()) < a.min_std:
                raise SystemExit("参考矩形内纹理太少（几乎是纯色）或越界，换一个包含文字/边框的矩形")
            ys.append(src.edge_y(yo)); confs.append(1.0); frames_idx.append(i)
            last = float(yo)
            continue
        center = ref_y_out if a.no_follow else last
        lo = max(0, int(np.floor(center - s_out)))
        hi = min(g.shape[0], int(np.ceil(center + s_out)) + th)
        if hi - lo < th + 1:
            ys.append(float("nan")); confs.append(float("nan")); frames_idx.append(i)
            continue
        res = cv2.matchTemplate(g[lo:hi], tmpl, cv2.TM_CCOEFF_NORMED)[:, 0]
        res = np.nan_to_num(res, nan=-1.0)
        k = int(np.argmax(res))
        conf = float(res[k])
        yk = float(k)
        if 0 < k < res.size - 1:
            yk += _parabola(float(res[k - 1]), float(res[k]), float(res[k + 1]))
        frames_idx.append(i)
        confs.append(conf)
        if conf < a.min_confidence:
            ys.append(float("nan"))
            continue
        y_out = lo + yk
        last = y_out
        ys.append(src.edge_y(y_out))
    if tmpl is None:
        raise SystemExit("没有读到参考帧")
    t_all = src.timestamps
    t = [t_all[i] for i in frames_idx]
    y = np.asarray(ys, dtype=np.float64)
    y0 = float(y[0])
    off = y - y0
    ok = np.isfinite(off)
    absoff = np.abs(off[ok])
    d = a.density
    lost = int((~ok).sum())
    k_max = int(np.nanargmax(np.abs(off))) if ok.any() else 0
    first_lost = int(np.flatnonzero(~ok)[0]) if lost else None
    summary = {
        "frames": int(y.size),
        "ref_t": r(t[0], 4),
        "ref_y_px": r(y0),
        "lost_frames": lost,
        "first_lost_t": r(t[first_lost], 4) if first_lost is not None else None,
        "max_abs_offset_px": r(absoff.max()),
        "max_abs_offset_dp": r(absoff.max() / d),
        "max_offset_t": r(t[k_max], 4),
        "p95_abs_offset_px": r(np.percentile(absoff, 95)),
        "final_offset_px": r(off[ok][-1]) if ok.any() else None,
        "max_up_offset_px": r(min(0.0, float(np.nanmin(off)))),
        "max_down_offset_px": r(max(0.0, float(np.nanmax(off)))),
        "jumps": jump_stats(y, density=d, threshold_dp=a.threshold_dp),
    }
    res = base_result("track", src, a.label, {
        "density": d, "rect": rect.as_list(), "ref_frame": ref_idx, "ref_time": a.ref_time,
        "search_px": a.search, "min_confidence": a.min_confidence, "follow": not a.no_follow,
    }, timer)
    res["summary"] = summary
    res["checks"] = [
        check("max_abs_offset_dp", summary["max_abs_offset_dp"], a.threshold_dp),
        check("lost_frames", lost, 0, "=="),
    ]
    write_csv(a.csv, ["frame", "t", "y_px", "offset_px", "confidence"],
              ([frames_idx[k], t[k], y[k], off[k], confs[k]] for k in range(y.size)))
    return res
