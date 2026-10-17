"""motion / track / blank：位移、跟踪位置、空白帧与真值对得上。"""

from __future__ import annotations

import pytest

from conftest import fnum

REGION = "0,200,1080,1800"
TOL = 2.0
# 内容向下移动（与流式贴底预期方向相反）的帧及位移
EXPECTED_REVERSE = {60: 40, 100: 20, 122: 25, 180: 15, 240: 30}


def _truth_dy(synth, f: int) -> float:
    """第 f-1 → f 帧，已有内容的真实垂直位移（向下为正）。"""
    a, b = synth.truth(f - 1), synth.truth(f)
    return (b["content_bottom"] - a["content_bottom"]) - synth.cfg.line_h * (b["n_lines"] - a["n_lines"])


@pytest.mark.parametrize("method,scale", [("template", None), ("template", "0.5"), ("phase", None)])
def test_motion(videos, synth, cli, method, scale):
    args = ["motion", str(videos["legacy_h264"]), "--region", REGION, "--method", method]
    if scale:
        args += ["--scale", scale]
    res, rows = cli(*args)
    rev = {e["frame"]: e["dy_px"] for e in res["events"]["reverse_moves"]}
    assert set(rev) == set(EXPECTED_REVERSE), rev
    for f, dy in EXPECTED_REVERSE.items():
        assert abs(rev[f] - dy) <= TOL
    for row in rows[1:]:
        f = int(row["frame"])
        dy = fnum(row["dy_px"])
        blank_pair = synth.truth(f)["blank"] or synth.truth(f - 1)["blank"]
        if blank_pair:
            assert dy is None and row["flag"] == "low_texture", (f, row)
        else:
            assert dy is not None, (f, row)
            assert abs(dy - _truth_dy(synth, f)) <= TOL, (f, dy, _truth_dy(synth, f))
    s = res["summary"]
    assert s["unreliable_breakdown"]["low_texture"] == 11
    assert s["max_abs_step_px"] == pytest.approx(50.0, abs=TOL)
    # 回弹（下去马上回来）会表现为快速的方向反复
    quick = {e["frame"] for e in res["events"]["quick_direction_changes"]}
    assert {61, 122, 183} <= quick


def test_motion_low_texture(videos, cli):
    """右侧一条纯白区域：全部标为低纹理，不给位移数。"""
    res, rows = cli("motion", str(videos["legacy_h264"]), "--region", "1050,200,30,1700", "--profile-width", "0")
    assert res["summary"]["reliable_pairs"] == 0
    assert all(r["dy_px"] == "" for r in rows)


def test_track(videos, synth, cli):
    ref, line = 35, 25
    top0 = synth.line_bottom(ref, line) - 40
    res, rows = cli("track", str(videos["legacy_h264"]), "--rect", f"40,{top0},600,50", "--ref-frame", str(ref))
    assert int(rows[0]["frame"]) == ref
    lost = []
    for row in rows:
        f = int(row["frame"])
        exp = synth.line_bottom(f, line) - 40
        y = fnum(row["y_px"])
        if synth.truth(f)["blank"]:
            assert y is None
            lost.append(f)
            continue
        assert y is not None and abs(y - exp) <= TOL, (f, y, exp)
    assert lost == list(range(200, 210))
    s = res["summary"]
    assert s["lost_frames"] == 10
    assert s["max_abs_offset_px"] == pytest.approx(abs(synth.line_bottom(299, line) - 40 - top0), abs=TOL)


def test_track_static_row_passes(videos, cli):
    """标题栏是静止的：偏移为 0，T5 的检查通过。"""
    res, _ = cli("track", str(videos["legacy_h264"]), "--rect", "380,40,320,120", "--search", "60")
    assert res["summary"]["max_abs_offset_px"] <= 0.5
    assert all(c["pass"] for c in res["checks"])


@pytest.mark.parametrize("scale", [None, "0.5"])
def test_blank(videos, cli, scale):
    args = ["blank", str(videos["legacy_h264"]), "--region", REGION]
    if scale:
        args += ["--scale", scale]
    res, rows = cli(*args)
    blank = [int(r["frame"]) for r in rows if r["blank"] == "1"]
    assert blank == list(range(200, 210))
    s = res["summary"]
    assert s["longest_blank_frames"] == 10
    assert s["longest_blank_start_t"] == pytest.approx(200 / 60, abs=1e-3)
    assert s["longest_blank_ms"] == pytest.approx(10 / 60 * 1000, abs=1.0)
    assert res["checks"][0]["pass"] is False  # T7：超过 2 帧
