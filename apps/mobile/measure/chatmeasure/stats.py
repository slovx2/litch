"""通用统计：偏差分位数、连续超标、相邻帧跳变、回弹事件与阶跃事件。

序列里用 NaN 表示「缺失」（该帧没测到）。
"""

from __future__ import annotations

from typing import Sequence

import numpy as np

DEFAULT_DENSITY = 2.625


def r(v: float | None, nd: int = 3) -> float | None:
    """JSON 友好的四舍五入（NaN/None → None）。"""
    if v is None:
        return None
    v = float(v)
    if not np.isfinite(v):
        return None
    return round(v, nd)


def longest_run(mask: np.ndarray) -> tuple[int, int]:
    """布尔序列里最长连续 True 段，返回 (长度, 起始下标)；没有则 (0, -1)。"""
    if mask.size == 0 or not mask.any():
        return 0, -1
    m = np.concatenate([[False], mask.astype(bool), [False]])
    d = np.diff(m.astype(np.int8))
    starts = np.flatnonzero(d == 1)
    ends = np.flatnonzero(d == -1)
    lens = ends - starts
    k = int(np.argmax(lens))
    return int(lens[k]), int(starts[k])


def runs(mask: np.ndarray) -> list[tuple[int, int]]:
    """所有连续 True 段 [(起, 止(不含))]。"""
    if mask.size == 0 or not mask.any():
        return []
    m = np.concatenate([[False], mask.astype(bool), [False]])
    d = np.diff(m.astype(np.int8))
    return list(zip(np.flatnonzero(d == 1).tolist(), np.flatnonzero(d == -1).tolist()))


def _pcts(a: np.ndarray, density: float, prefix: str = "") -> dict:
    out: dict = {}
    if a.size == 0:
        for k in ("p50", "p95", "p99", "max"):
            out[f"{prefix}{k}_px"] = None
            out[f"{prefix}{k}_dp"] = None
        return out
    vals = {"p50": np.percentile(a, 50), "p95": np.percentile(a, 95),
            "p99": np.percentile(a, 99), "max": a.max()}
    for k, v in vals.items():
        out[f"{prefix}{k}_px"] = r(v)
        out[f"{prefix}{k}_dp"] = r(v / density)
    return out


def deviation_stats(
    values: np.ndarray,
    times: Sequence[float],
    *,
    density: float = DEFAULT_DENSITY,
    threshold_dp: float = 2.0,
    steady: float | None = None,
    line_height_dp: float | None = None,
) -> dict:
    """序列相对稳态值（默认中位数）的偏差统计。"""
    v = np.asarray(values, dtype=np.float64)
    n = int(v.size)
    valid = np.isfinite(v)
    nv = int(valid.sum())
    out: dict = {"frames": n, "valid_frames": nv, "missing_frames": n - nv}
    if nv == 0:
        out["steady_px"] = None
        return out
    st = float(np.median(v[valid])) if steady is None else float(steady)
    dev = v - st
    absdev = np.abs(dev)
    out["steady_px"] = r(st)
    out["steady_dp"] = r(st / density)
    out["steady_source"] = "median" if steady is None else "given"
    out.update(_pcts(absdev[valid], density, "abs_dev_"))
    out["max_up_dev_px"] = r(min(0.0, float(np.nanmin(dev))))      # 变小（负）
    out["max_down_dev_px"] = r(max(0.0, float(np.nanmax(dev))))    # 变大（正）
    thr_px = threshold_dp * density
    over = valid & (absdev > thr_px + 1e-9)
    n_over = int(over.sum())
    out["threshold_dp"] = threshold_dp
    out["over_threshold_frames"] = n_over
    out["over_threshold_ratio"] = r(n_over / nv, 5)
    run_len, run_start = longest_run(over)
    out["longest_over_run_frames"] = run_len
    out["longest_over_run_start_t"] = r(times[run_start], 4) if run_len else None
    if run_len:
        end = min(run_start + run_len, n - 1)
        out["longest_over_run_ms"] = r((times[end] - times[run_start]) * 1000.0, 1) if end > run_start else None
    if line_height_dp:
        lh = line_height_dp * density
        over_lh = valid & (absdev > lh + 1e-9)
        out["line_height_dp"] = line_height_dp
        out["over_line_height_frames"] = int(over_lh.sum())
        out["longest_over_line_height_run_frames"] = longest_run(over_lh)[0]
    return out


def jump_stats(values: np.ndarray, *, density: float = DEFAULT_DENSITY,
               threshold_dp: float = 2.0) -> dict:
    """相邻两帧（都有效）的差值统计，衡量单条线自身的跳变。"""
    v = np.asarray(values, dtype=np.float64)
    both = np.isfinite(v[1:]) & np.isfinite(v[:-1])
    d = (v[1:] - v[:-1])[both]
    a = np.abs(d)
    out: dict = {"pairs": int(both.sum())}
    out.update(_pcts(a, density, "abs_jump_"))
    out["moved_pairs"] = int((a > 0.5).sum())
    out["over_threshold_pairs"] = int((a > threshold_dp * density + 1e-9).sum())
    return out


def detect_events(
    values: np.ndarray,
    times: Sequence[float],
    *,
    tol_px: float,
    max_frames: int = 3,
    density: float = DEFAULT_DENSITY,
) -> tuple[list[dict], list[dict]]:
    """区分「短暂偏离后回弹」和「阶跃式变化」。

    以当前平台值 base 为准：某帧偏离 base 超过 tol_px，就往后看 max_frames 帧，
    如果在这之内回到 base±tol_px，记为回弹事件；否则认为平台值变了，记为阶跃事件。
    缺失帧（NaN）跳过，不打断也不触发事件。
    """
    v = np.asarray(values, dtype=np.float64)
    idx = np.flatnonzero(np.isfinite(v))
    rebounds: list[dict] = []
    steps: list[dict] = []
    if idx.size == 0:
        return rebounds, steps
    base = float(v[idx[0]])
    k = 1
    while k < idx.size:
        i = int(idx[k])
        if abs(v[i] - base) <= tol_px:
            k += 1
            continue
        # 偏离开始：在其后 max_frames 帧（按帧序号）内找回到 base 的帧
        back = None
        kk = k + 1
        while kk < idx.size and int(idx[kk]) - i <= max_frames:
            if abs(v[int(idx[kk])] - base) <= tol_px:
                back = kk
                break
            kk += 1
        if back is not None:
            j = int(idx[back])
            seg = v[i:j]
            seg_dev = seg[np.isfinite(seg)] - base
            peak = float(seg_dev[np.argmax(np.abs(seg_dev))])
            rebounds.append({
                "start_frame": i, "start_t": r(times[i], 4), "frames": j - i,
                "duration_ms": r((times[j] - times[i]) * 1000.0, 1),
                "base_px": r(base), "amplitude_px": r(peak), "amplitude_dp": r(peak / density),
            })
            k = back + 1
        else:
            steps.append({
                "frame": i, "t": r(times[i], 4), "from_px": r(base), "to_px": r(v[i]),
                "delta_px": r(v[i] - base), "delta_dp": r((v[i] - base) / density),
            })
            base = float(v[i])
            k += 1
    # 合并相邻 max_frames 帧内的连续阶跃（动画中逐帧变化算一次）
    merged: list[dict] = []
    for s in steps:
        if merged and s["frame"] - merged[-1]["last_frame"] <= max_frames:
            m = merged[-1]
            m["to_px"] = s["to_px"]
            m["delta_px"] = r(s["to_px"] - m["from_px"])
            m["delta_dp"] = r((s["to_px"] - m["from_px"]) / density)
            m["last_frame"] = s["frame"]
            m["frames"] = s["frame"] - m["frame"] + 1
        else:
            merged.append({**s, "last_frame": s["frame"], "frames": 1})
    return rebounds, merged


def event_summary(rebounds: list[dict], steps: list[dict], *, max_frames: int, tol_px: float) -> dict:
    amps = [abs(e["amplitude_px"]) for e in rebounds]
    return {
        "rebound_max_frames": max_frames,
        "rebound_tol_px": r(tol_px),
        "rebound_count": len(rebounds),
        "rebound_max_amplitude_px": r(max(amps)) if amps else 0.0,
        "step_count": len(steps),
    }


def check(name: str, value: float | int | None, limit: float | int, op: str = "<=") -> dict:
    ok: bool | None
    if value is None:
        ok = None
    elif op == "<=":
        ok = bool(value <= limit + 1e-9)
    elif op == "==":
        ok = bool(value == limit)
    elif op == ">=":
        ok = bool(value >= limit - 1e-9)
    else:
        raise ValueError(op)
    return {"name": name, "value": value, "op": op, "limit": limit, "pass": ok}
