"""markers / gap：位置误差 ≤2px，回弹事件与阶跃事件识别正确。"""

from __future__ import annotations

import pytest

from conftest import fnum

# 合成视频里埋的事件（见 chatmeasure/synth.py 的 SynthConfig.offsets）
# 距离 = 输入区上沿 - 内容末尾，内容向下移 → 距离变小
EXPECTED_REBOUNDS = [(60, 1, -40), (120, 2, 25), (180, 3, -15)]
EXPECTED_STEPS = [100, 105, 240, 260, 280]
BLANK = range(200, 210)
TOL = 2.0


def _check_events(res: dict) -> None:
    rb = res["events"]["rebounds"]
    assert [(e["start_frame"], e["frames"]) for e in rb] == [(f, n) for f, n, _ in EXPECTED_REBOUNDS]
    for e, (_, _, amp) in zip(rb, EXPECTED_REBOUNDS):
        assert abs(e["amplitude_px"] - amp) <= TOL
        assert abs(e["start_t"] - e["start_frame"] / 60) < 1e-3
    assert [s["frame"] for s in res["events"]["steps"]] == EXPECTED_STEPS
    assert res["summary"]["events"]["rebound_count"] == 3


@pytest.mark.parametrize("video,scale", [("proto_h264", None), ("proto_lossless", None), ("proto_h264", "0.5")])
def test_markers(videos, synth, cli, video, scale):
    args = ["markers", str(videos[video])]
    if scale:
        args += ["--scale", scale]
    res, rows = cli(*args)
    assert len(rows) == 300
    for row in rows:
        f = int(row["frame"])
        tr = synth.truth(f)
        assert abs(float(row["t"]) - f / 60) < 1e-3
        iy = fnum(row["input_y"])
        assert iy is not None and abs(iy - tr["cyan_y"]) <= TOL, (f, iy)
        cy = fnum(row["content_y"])
        if tr["blank"]:
            assert cy is None, f
        else:
            assert cy is not None and abs(cy - tr["magenta_y"]) <= TOL, (f, cy, tr["magenta_y"])
    dist = res["summary"]["distance"]
    assert dist["missing_frames"] == len(BLANK)
    assert abs(dist["steady_px"] - 50.0) <= TOL
    assert res["summary"]["input_line"]["missing_frames"] == 0
    assert res["summary"]["input_line"]["abs_jump_max_px"] <= TOL
    _check_events(res)


def test_markers_compression_drift(videos, cli):
    """H.264 4:2:0 编码后与无损版本相比，标记线位置差不超过 1px。"""
    _, a = cli("markers", str(videos["proto_h264"]))
    _, b = cli("markers", str(videos["proto_lossless"]))
    for ra, rb in zip(a, b):
        for k in ("content_y", "input_y"):
            va, vb = fnum(ra[k]), fnum(rb[k])
            assert (va is None) == (vb is None)
            if va is not None:
                assert abs(va - vb) <= 1.0


def test_markers_t1_checks_on_clean_segment(videos, cli):
    """只取没有事件的一段，T1 的检查项应全部通过。"""
    res, _ = cli("markers", str(videos["proto_h264"]), "--start", "0.0", "--end", "0.95",
                 "--line-height-dp", "19")
    assert all(c["pass"] for c in res["checks"]), res["checks"]
    assert res["summary"]["distance"]["abs_dev_max_px"] <= TOL


@pytest.mark.parametrize("scale,top", [(None, "auto"), ("0.5", "auto"), (None, "2000")])
def test_gap(videos, synth, cli, scale, top):
    args = ["gap", str(videos["legacy_h264"]), "--region", "0,200,1080,1800", "--input-top", top]
    if top == "auto":
        args += ["--input-search", "1900,2100"]
    if scale:
        args += ["--scale", scale]
    res, rows = cli(*args)
    assert len(rows) == 300
    for row in rows:
        f = int(row["frame"])
        tr = synth.truth(f)
        it = fnum(row["input_top"])
        assert it is not None and abs(it - tr["input_top"]) <= TOL
        cb = fnum(row["content_bottom"])
        if tr["blank"]:
            assert cb is None, f
        else:
            assert cb is not None and abs(cb - tr["content_bottom"]) <= TOL, (f, cb, tr["content_bottom"])
    assert res["summary"]["distance"]["missing_frames"] == len(BLANK)
    assert abs(res["summary"]["distance"]["steady_px"] - 60.0) <= TOL
    _check_events(res)


def test_gap_rebound_window(videos, cli):
    """--rebound-frames 改成 5 时，5 帧的偏离（第 100–104 帧）也算回弹。"""
    res, _ = cli("gap", str(videos["legacy_h264"]), "--region", "0,200,1080,1800",
                 "--input-search", "1900,2100", "--rebound-frames", "5")
    frames = [(e["start_frame"], e["frames"]) for e in res["events"]["rebounds"]]
    assert (100, 5) in frames
    assert 100 not in [s["frame"] for s in res["events"]["steps"]]
