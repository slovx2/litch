"""report：把若干个结果 JSON 合并成一份 markdown 表格。

同一子命令的多个结果并排成列（例如旧应用 vs 新原型），行是摊平后的汇总指标和检查项。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

CMD_TITLES = {
    "markers": "markers：标记线距离（T1/T2/T3）",
    "gap": "gap：内容末尾到输入区距离（旧应用）",
    "motion": "motion：相邻帧垂直位移",
    "track": "track：目标行跟踪（T5/T6）",
    "blank": "blank：空白帧（T6/T7）",
    "frametimes": "frametimes：帧耗时与卡顿",
}


def flatten(d: dict, prefix: str = "") -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in d.items():
        key = f"{prefix}{k}"
        if isinstance(v, dict):
            out.update(flatten(v, key + "."))
        elif isinstance(v, (list, tuple)):
            continue
        else:
            out[key] = v
    return out


def _fmt(v: Any) -> str:
    if v is None:
        return "-"
    if isinstance(v, bool):
        return "是" if v else "否"
    if isinstance(v, float):
        return f"{v:.4g}" if abs(v) < 1e5 else f"{v:.0f}"
    return str(v)


def _check_cell(c: dict | None) -> str:
    if c is None:
        return "-"
    verdict = {True: "通过", False: "不通过", None: "无数据"}[c.get("pass")]
    return f"{verdict}（{_fmt(c.get('value'))}）"


def render(results: list[dict]) -> str:
    groups: dict[str, list[dict]] = {}
    for res in results:
        groups.setdefault(res.get("command", "?"), []).append(res)
    lines = ["# 测量报告", ""]
    for cmd, items in groups.items():
        lines += [f"## {CMD_TITLES.get(cmd, cmd)}", ""]
        labels = [str(it.get("label", f"#{k}")) for k, it in enumerate(items)]
        lines.append("| 来源 | " + " | ".join(labels) + " |")
        lines.append("|---|" + "---|" * len(items))
        lines.append("| 输入 | " + " | ".join(f"`{Path(str(it.get('source', {}).get('input', ''))).name}`"
                                              for it in items) + " |")
        lines.append("| 帧数 | " + " | ".join(_fmt(it.get("source", {}).get("frames")) for it in items) + " |")
        lines.append("")
        # 检查项
        names: list[str] = []
        for it in items:
            for c in it.get("checks", []):
                tag = f"{c['name']} {c['op']} {_fmt(c['limit'])}"
                if tag not in names:
                    names.append(tag)
        if names:
            lines.append("| 检查项 | " + " | ".join(labels) + " |")
            lines.append("|---|" + "---|" * len(items))
            for tag in names:
                cells = []
                for it in items:
                    found = next((c for c in it.get("checks", [])
                                  if f"{c['name']} {c['op']} {_fmt(c['limit'])}" == tag), None)
                    cells.append(_check_cell(found))
                lines.append(f"| {tag} | " + " | ".join(cells) + " |")
            lines.append("")
        # 指标
        flats = [flatten(it.get("summary", {})) for it in items]
        keys: list[str] = []
        for f in flats:
            for k in f:
                if k not in keys:
                    keys.append(k)
        lines.append("| 指标 | " + " | ".join(labels) + " |")
        lines.append("|---|" + "---|" * len(items))
        for k in keys:
            lines.append(f"| {k} | " + " | ".join(_fmt(f.get(k)) for f in flats) + " |")
        lines.append("")
        # 事件计数
        ev_keys: list[str] = []
        for it in items:
            for k, v in (it.get("events") or {}).items():
                if isinstance(v, list) and k not in ev_keys:
                    ev_keys.append(k)
        if ev_keys:
            lines.append("| 事件 | " + " | ".join(labels) + " |")
            lines.append("|---|" + "---|" * len(items))
            for k in ev_keys:
                lines.append(f"| {k} | " + " | ".join(
                    str(len((it.get("events") or {}).get(k, []))) for it in items) + " |")
            lines.append("")
    return "\n".join(lines)


def add_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("inputs", nargs="+", help="各子命令输出的结果 JSON")
    p.add_argument("--out", help="markdown 输出路径，默认打印到标准输出")


def run(a: argparse.Namespace) -> None:
    results = [json.loads(Path(p).read_text()) for p in a.inputs]
    md = render(results)
    if a.out:
        Path(a.out).write_text(md + "\n")
        print(f"已写入 {a.out}", file=sys.stderr)
    else:
        print(md)
