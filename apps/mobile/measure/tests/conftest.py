"""测试夹具：合成视频（会话级缓存）和调用命令行的小工具。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from chatmeasure.cli import main
from chatmeasure.synth import ChatSynth, SynthConfig, write_video


@pytest.fixture(scope="session")
def videos(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    d = tmp_path_factory.mktemp("videos")
    out = {
        "proto_h264": d / "proto_h264.mp4",
        "proto_lossless": d / "proto_lossless.mp4",
        "legacy_h264": d / "legacy_h264.mp4",
    }
    write_video(SynthConfig(markers=True), out["proto_h264"], "h264")
    write_video(SynthConfig(markers=True), out["proto_lossless"], "lossless")
    write_video(SynthConfig(markers=False), out["legacy_h264"], "h264")
    return out


@pytest.fixture(scope="session")
def synth() -> ChatSynth:
    return ChatSynth(SynthConfig())


@pytest.fixture()
def cli(tmp_path: Path):
    """运行子命令，返回 (结果 JSON, CSV 行列表)。"""
    import csv

    def _run(*args: str) -> tuple[dict, list[dict]]:
        j, c = tmp_path / "out.json", tmp_path / "out.csv"
        assert main([*args, "--json", str(j), "--csv", str(c)]) == 0
        with open(c) as fh:
            rows = list(csv.DictReader(fh))
        return json.loads(j.read_text()), rows

    return _run


def fnum(s: str) -> float | None:
    return None if s == "" else float(s)
