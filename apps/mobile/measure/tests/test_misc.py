"""frames（时间戳）、frametimes、report、统计函数。"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from chatmeasure.cli import main
from chatmeasure.stats import deviation_stats, detect_events
from chatmeasure.synth import SynthConfig, write_video


def test_frames_vfr(tmp_path: Path):
    """可变帧率：丢掉第 30–39 帧后，导出的时间戳要如实反映这段空档。"""
    src = tmp_path / "vfr.mp4"
    write_video(SynthConfig(frames=90), src, "h264", extra_vf="select='not(between(n,30,39))'")
    out = tmp_path / "frames"
    assert main(["frames", str(src), "--out", str(out), "--scale", "0.5"]) == 0
    meta = json.loads((out / "frames.json").read_text())
    ts = np.array([f["t"] for f in meta["frames"]])
    assert len(ts) == 80
    gaps = np.diff(ts)
    assert int((gaps > 0.1).sum()) == 1
    assert ts[30] - ts[29] == pytest.approx(11 / 60, abs=1e-3)
    assert len(list(out.glob("frame_*.png"))) == 80
    # 帧目录也能直接作为分析输入，时间段过滤按原始时间戳
    j = tmp_path / "m.json"
    assert main(["markers", str(out), "--start", "0.4", "--end", "1.0", "--json", str(j)]) == 0
    res = json.loads(j.read_text())
    assert res["source"]["frames"] == int(((ts >= 0.4 - 1e-9) & (ts < 1.0 - 1e-9)).sum())
    assert res["summary"]["distance"]["steady_px"] == pytest.approx(50.0, abs=2.0)


def test_frames_time_range(tmp_path: Path):
    src = tmp_path / "c.mp4"
    write_video(SynthConfig(frames=120), src, "h264")
    out = tmp_path / "f"
    main(["frames", str(src), "--out", str(out), "--start", "0.5", "--end", "1.0"])
    ts = [f["t"] for f in json.loads((out / "frames.json").read_text())["frames"]]
    assert ts[0] == pytest.approx(0.5, abs=1e-3)
    assert len(ts) == 30


def _framestats_text() -> str:
    header = ("Flags,FrameTimelineVsyncId,IntendedVsync,Vsync,InputEventId,HandleInputStart,AnimationStart,"
              "PerformTraversalsStart,DrawStart,FrameDeadline,FrameStartTime,FrameInterval,WorkloadTarget,"
              "SyncQueued,SyncStart,IssueDrawCommandsStart,SwapBuffers,FrameCompleted,DequeueBufferDuration,"
              "QueueBufferDuration,GpuCompleted,SwapBuffersCompleted,DisplayPresentTime,CommandSubmissionCompleted,")
    ncol = len(header.rstrip(",").split(","))
    totals = [8.0] * 90 + [20.0] * 8 + [40.0] * 2
    rows = []
    t0 = 1_000_000_000
    for k, ms in enumerate(totals):
        iv = t0 + k * 16_666_667
        vals = [0] * ncol
        vals[2], vals[3] = iv, iv
        vals[9] = iv + 16_666_667
        vals[17] = iv + int(ms * 1e6)
        rows.append(",".join(map(str, vals)) + ",")
    # 3 行 Flags 非 0（系统标记的异常值），要被忽略
    for k in range(3):
        vals = [0] * ncol
        vals[0] = 1
        vals[2] = t0
        vals[17] = t0 + 500_000_000
        rows.append(",".join(map(str, vals)) + ",")
    half = len(rows) // 2
    sec = lambda rs: "---PROFILEDATA---\n" + header + "\n" + "\n".join(rs) + "\n---PROFILEDATA---\n"  # noqa: E731
    return ("Applications Graphics Acceleration Info:\n** Graphics info for pid 1234 [com.example.chat] **\n\n"
            "Stats since: 123ns\nTotal frames rendered: 1500\nJanky frames: 45 (3.00%)\n"
            "Janky frames (legacy): 60 (4.00%)\n50th percentile: 6ms\n90th percentile: 12ms\n"
            "95th percentile: 17ms\n99th percentile: 32ms\nNumber Missed Vsync: 3\n"
            "Number High input latency: 7\nNumber Slow UI thread: 11\nNumber Slow bitmap uploads: 0\n"
            "Number Slow issue draw commands: 4\nNumber Frame deadline missed: 40\n"
            "50th gpu percentile: 4ms\n\nWindow: com.example.chat/.Main\n"
            + sec(rows[:half]) + "\nWindow: popup\n" + sec(rows[half:]))


def test_frametimes(tmp_path: Path):
    p = tmp_path / "gfx.txt"
    p.write_text(_framestats_text())
    j = tmp_path / "ft.json"
    c = tmp_path / "ft.csv"
    assert main(["frametimes", str(p), "--json", str(j), "--csv", str(c)]) == 0
    res = json.loads(j.read_text())
    fs = res["summary"]["framestats"]
    assert fs["sections"] == 2
    assert fs["frames"] == 100
    assert fs["ignored_flagged_frames"] == 3
    assert fs["janky_frames"] == 10
    assert fs["janky_ratio"] == pytest.approx(0.10)
    assert fs["frame_ms_p50"] == pytest.approx(8.0)
    assert fs["frame_ms_p95"] == pytest.approx(20.0)
    assert fs["frame_ms_max"] == pytest.approx(40.0)
    assert fs["deadline_missed_frames"] == 10
    sm = res["summary"]["gfxinfo_summary"]
    assert sm["total_frames_rendered"] == 1500
    assert sm["janky_frames"] == 45 and sm["janky_frames_percent"] == 3.0
    assert sm["janky_frames_legacy"] == 60
    assert sm["percentile_ms"] == {"p50": 6.0, "p90": 12.0, "p95": 17.0, "p99": 32.0}
    assert sm["slow_ui_thread"] == 11 and sm["frame_deadline_missed"] == 40
    assert res["checks"][0]["pass"] is False  # 10% > 默认上限 5%


def test_frametimes_summary_only(tmp_path: Path):
    p = tmp_path / "gfx.txt"
    p.write_text("Total frames rendered: 200\nJanky frames: 4 (2.00%)\n50th percentile: 5ms\n")
    j = tmp_path / "ft.json"
    main(["frametimes", str(p), "--refresh-ms", "8.33", "--json", str(j)])
    res = json.loads(j.read_text())
    assert res["summary"]["framestats"]["frames"] == 0
    assert res["checks"][0]["name"] == "janky_frames_percent" and res["checks"][0]["pass"] is True


def test_report(tmp_path: Path):
    p = tmp_path / "gfx.txt"
    p.write_text(_framestats_text())
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    main(["frametimes", str(p), "--label", "旧应用", "--json", str(a)])
    main(["frametimes", str(p), "--label", "新原型", "--json", str(b)])
    md = tmp_path / "r.md"
    assert main(["report", str(a), str(b), "--out", str(md)]) == 0
    text = md.read_text()
    assert "| 来源 | 旧应用 | 新原型 |" in text
    assert "framestats.janky_ratio" in text
    assert "不通过" in text


def test_detect_events_unit():
    t = [i / 60 for i in range(40)]
    v = np.full(40, 100.0)
    v[5] = 80            # 1 帧回弹
    v[10:12] = 130       # 2 帧回弹
    v[20:] = 150         # 阶跃
    v[30] = np.nan       # 缺失不影响
    rb, st = detect_events(v, t, tol_px=5.0, max_frames=3)
    assert [(e["start_frame"], e["frames"], e["amplitude_px"]) for e in rb] == [(5, 1, -20.0), (10, 2, 30.0)]
    assert [(s["frame"], s["delta_px"]) for s in st] == [(20, 50.0)]
    ds = deviation_stats(v, t, threshold_dp=2.0, steady=100.0)
    assert ds["missing_frames"] == 1
    assert ds["longest_over_run_frames"] == 10  # 20–29（30 缺失打断）
    assert ds["over_threshold_frames"] == 22
