"""frametimes：解析 `adb shell dumpsys gfxinfo <包名> [framestats]` 的输出。

- framestats 的 PROFILEDATA 段：总帧耗时 = FrameCompleted - IntendedVsync（Android 文档的定义），
  Flags 非 0 的帧是系统标记的异常值，按文档忽略。耗时超过一个刷新周期记为卡顿帧。
- 普通输出的汇总行：Total frames rendered、Janky frames、分位数、各类 Number ... 计数。
两种内容可以在同一个文件里（framestats 的输出本身也带汇总行）。
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

import numpy as np

from chatmeasure.common import Timer, write_csv
from chatmeasure.stats import check, r

_SUMMARY_PATTERNS: dict[str, re.Pattern[str]] = {
    "total_frames_rendered": re.compile(r"^\s*Total frames rendered:\s*(\d+)", re.M),
    "janky_frames": re.compile(r"^\s*Janky frames:\s*(\d+)\s*\(([\d.]+)%\)", re.M),
    "janky_frames_legacy": re.compile(r"^\s*Janky frames \(legacy\):\s*(\d+)\s*\(([\d.]+)%\)", re.M),
    "missed_vsync": re.compile(r"^\s*Number Missed Vsync:\s*(\d+)", re.M),
    "high_input_latency": re.compile(r"^\s*Number High input latency:\s*(\d+)", re.M),
    "slow_ui_thread": re.compile(r"^\s*Number Slow UI thread:\s*(\d+)", re.M),
    "slow_bitmap_uploads": re.compile(r"^\s*Number Slow bitmap uploads:\s*(\d+)", re.M),
    "slow_issue_draw_commands": re.compile(r"^\s*Number Slow issue draw commands:\s*(\d+)", re.M),
    "frame_deadline_missed": re.compile(r"^\s*Number Frame deadline missed:\s*(\d+)", re.M),
    "frame_deadline_missed_legacy": re.compile(r"^\s*Number Frame deadline missed \(legacy\):\s*(\d+)", re.M),
}
_PCT_RE = re.compile(r"^\s*(\d+)th percentile:\s*([\d.]+)ms", re.M)
_GPU_PCT_RE = re.compile(r"^\s*(\d+)th gpu percentile:\s*([\d.]+)ms", re.M)


def parse_summary(text: str) -> dict:
    """取第一处出现的汇总行（应用级汇总）。"""
    out: dict = {}
    for key, pat in _SUMMARY_PATTERNS.items():
        m = pat.search(text)
        if not m:
            continue
        if key.startswith("janky_frames"):
            out[key] = int(m.group(1))
            out[key + "_percent"] = float(m.group(2))
        else:
            out[key] = int(m.group(1))
    for name, pat in (("percentile_ms", _PCT_RE), ("gpu_percentile_ms", _GPU_PCT_RE)):
        seen: dict[str, float] = {}
        for m in pat.finditer(text):
            seen.setdefault(f"p{m.group(1)}", float(m.group(2)))
        if seen:
            out[name] = seen
    return out


def parse_profiledata(text: str) -> list[dict]:
    """解析所有 ---PROFILEDATA--- 段，返回逐帧记录（单位 ns 的原始列 + 计算列）。"""
    frames: list[dict] = []
    lines = text.splitlines()
    i = 0
    section = -1
    while i < len(lines):
        if lines[i].strip() != "---PROFILEDATA---":
            i += 1
            continue
        i += 1
        if i >= len(lines):
            break
        header = [h.strip() for h in lines[i].strip().rstrip(",").split(",")]
        if "IntendedVsync" not in header or "FrameCompleted" not in header:
            continue
        section += 1
        col = {h: k for k, h in enumerate(header)}
        i += 1
        while i < len(lines) and lines[i].strip() != "---PROFILEDATA---":
            parts = lines[i].strip().rstrip(",").split(",")
            i += 1
            if len(parts) < len(header):
                continue
            try:
                vals = [int(p) for p in parts[: len(header)]]
            except ValueError:
                continue
            rec = {h: vals[k] for h, k in col.items()}
            rec["section"] = section
            frames.append(rec)
        i += 1  # 跳过结束标记
    return frames


def analyze(text: str, refresh_ms: float = 1000.0 / 60.0) -> dict:
    summary = parse_summary(text)
    recs = parse_profiledata(text)
    used = [f for f in recs if f.get("Flags", 0) == 0 and f["FrameCompleted"] > f["IntendedVsync"] > 0]
    total = np.asarray([(f["FrameCompleted"] - f["IntendedVsync"]) / 1e6 for f in used], dtype=np.float64)
    out: dict = {"gfxinfo_summary": summary}
    fs: dict = {
        "sections": len({f["section"] for f in recs}),
        "rows": len(recs),
        "frames": int(total.size),
        "ignored_flagged_frames": len(recs) - len(used),
        "refresh_ms": r(refresh_ms, 3),
    }
    if total.size:
        jank = total > refresh_ms
        fs.update({
            "janky_frames": int(jank.sum()),
            "janky_ratio": r(jank.mean(), 5),
            "frame_ms_p50": r(np.percentile(total, 50), 2),
            "frame_ms_p90": r(np.percentile(total, 90), 2),
            "frame_ms_p95": r(np.percentile(total, 95), 2),
            "frame_ms_p99": r(np.percentile(total, 99), 2),
            "frame_ms_max": r(total.max(), 2),
            "over_2x_refresh_frames": int((total > 2 * refresh_ms).sum()),
        })
        if all("FrameDeadline" in f for f in used):
            missed = [f["FrameCompleted"] > f["FrameDeadline"] > 0 for f in used]
            fs["deadline_missed_frames"] = int(sum(missed))
    out["framestats"] = fs
    out["_frames"] = [(f["section"], f["IntendedVsync"], v) for f, v in zip(used, total.tolist())]
    return out


def add_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("input", help="dumpsys gfxinfo 输出的文本文件，- 表示标准输入")
    p.add_argument("--refresh-ms", type=float, default=1000.0 / 60.0, help="刷新周期（毫秒），默认 16.67")
    p.add_argument("--max-jank-ratio", type=float, default=0.05, help="检查项：卡顿帧占比上限，默认 0.05")
    p.add_argument("--label", help="结果标签，默认取文件名")
    p.add_argument("--json", help="结果 JSON 路径，默认打印到标准输出")
    p.add_argument("--csv", help="逐帧明细 CSV 路径")


def run(a: argparse.Namespace) -> dict:
    timer = Timer()
    text = sys.stdin.read() if a.input == "-" else Path(a.input).read_text(errors="replace")
    res = analyze(text, a.refresh_ms)
    frames = res.pop("_frames")
    fs = res["framestats"]
    checks = []
    if "janky_ratio" in fs:
        checks.append(check("janky_ratio", fs["janky_ratio"], a.max_jank_ratio))
    elif "janky_frames_percent" in res["gfxinfo_summary"]:
        checks.append(check("janky_frames_percent", res["gfxinfo_summary"]["janky_frames_percent"],
                            a.max_jank_ratio * 100))
    out = {
        "tool": "chatmeasure",
        "command": "frametimes",
        "label": a.label or (Path(a.input).stem if a.input != "-" else "stdin"),
        "source": {"input": a.input},
        "params": {"refresh_ms": a.refresh_ms},
        "perf": {"elapsed_s": timer.elapsed()},
        "summary": res,
        "checks": checks,
    }
    write_csv(a.csv, ["section", "intended_vsync_ns", "total_ms", "janky"],
              ([s, iv, v, int(v > a.refresh_ms)] for s, iv, v in frames))
    return out
