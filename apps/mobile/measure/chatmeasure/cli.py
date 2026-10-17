"""命令行入口：uv run python -m chatmeasure <子命令> ..."""

from __future__ import annotations

import argparse
import sys
from typing import Callable

from chatmeasure import blank, frametimes, gap, markers, motion, report, track
from chatmeasure.common import emit
from chatmeasure.stats import DEFAULT_DENSITY
from chatmeasure.video import extract_frames


def _video_common(p: argparse.ArgumentParser, *, events: bool = False) -> None:
    p.add_argument("input", help="mp4 录屏，或 frames 子命令导出的帧目录")
    p.add_argument("--start", type=float, help="起始时间（秒，按原始时间戳）")
    p.add_argument("--end", type=float, help="结束时间（秒）")
    p.add_argument("--scale", type=float, help="读取时缩放（如 0.5 为半分辨率），默认 1；坐标参数始终按原始分辨率给")
    p.add_argument("--density", type=float, default=DEFAULT_DENSITY, help="屏幕密度 px/dp，默认 2.625")
    p.add_argument("--threshold-dp", type=float, default=2.0, help="偏差/位移阈值（dp），默认 2")
    if events:
        p.add_argument("--rebound-frames", type=int, default=3,
                       help="偏离后在这么多帧内回到原值算「回弹事件」，默认 3")
        p.add_argument("--rebound-tol-dp", type=float, help="「回到原值附近」的容差（dp），默认等于 --threshold-dp")
    p.add_argument("--label", help="结果标签（报告里的列名），默认取文件名")
    p.add_argument("--json", help="结果 JSON 路径，默认打印到标准输出")
    p.add_argument("--csv", help="逐帧明细 CSV 路径")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="chatmeasure", description="安卓录屏逐帧分析：度量聊天界面的飘、跳、闪、卡")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("frames", help="把 mp4 逐帧导出为 PNG，并记录每帧时间戳")
    p.add_argument("input")
    p.add_argument("--out", required=True, help="输出目录")
    p.add_argument("--start", type=float)
    p.add_argument("--end", type=float)
    p.add_argument("--scale", type=float, default=1.0, help="如 0.5 为半分辨率")

    p = sub.add_parser("markers", help="新原型：两条标记线的距离与跳变")
    _video_common(p, events=True)
    markers.add_args(p)

    p = sub.add_parser("gap", help="旧应用：最下面一行内容到输入区上沿的距离")
    _video_common(p, events=True)
    gap.add_args(p)

    p = sub.add_parser("motion", help="区域内容在相邻帧间的垂直位移")
    _video_common(p)
    motion.add_args(p)

    p = sub.add_parser("track", help="跟踪参考帧上一个矩形的纵向位置")
    _video_common(p)
    track.add_args(p)

    p = sub.add_parser("blank", help="对话区空白帧")
    _video_common(p)
    blank.add_args(p)

    p = sub.add_parser("frametimes", help="解析 dumpsys gfxinfo [framestats] 输出")
    frametimes.add_args(p)

    p = sub.add_parser("report", help="把多个结果 JSON 合并成 markdown 表格")
    report.add_args(p)
    return ap


RUNNERS: dict[str, Callable[[argparse.Namespace], dict]] = {
    "markers": markers.run,
    "gap": gap.run,
    "motion": motion.run,
    "track": track.run,
    "blank": blank.run,
    "frametimes": frametimes.run,
}


def main(argv: list[str] | None = None) -> int:
    a = build_parser().parse_args(argv)
    if a.command == "frames":
        meta = extract_frames(a.input, a.out, start=a.start, end=a.end, scale=a.scale)
        ts = [f["t"] for f in meta["frames"]]
        emit({"tool": "chatmeasure", "command": "frames", "out": a.out, "frames": len(ts),
              "first_t": ts[0] if ts else None, "last_t": ts[-1] if ts else None,
              "width": meta["width"], "height": meta["height"], "scale": meta["scale"]}, None)
        return 0
    if a.command == "report":
        report.run(a)
        return 0
    res = RUNNERS[a.command](a)
    emit(res, a.json)
    failed = [c["name"] for c in res.get("checks", []) if c.get("pass") is False]
    if failed:
        print("未通过的检查项：" + ", ".join(failed), file=sys.stderr)
    return 0
