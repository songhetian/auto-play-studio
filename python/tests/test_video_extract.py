# -*- coding: utf-8 -*-
"""视频抽帧：纯函数 choose_frame_timestamps + 抽帧路由（抽帧本体用桩，避免依赖真实视频/cv2）。"""
from __future__ import annotations

import io

import pytest


def test_choose_frame_timestamps_均匀采样且避开头尾黑场():
    from engine.video_extract import choose_frame_timestamps

    out = choose_frame_timestamps(10.0, max_frames=24)
    # 10 秒 → 每秒约 1 帧，共 10 个采样点
    assert len(out) == 10
    # 落在区间内，且避开 0s / 10s 的黑场与淡出
    assert all(0 < t < 10 for t in out)
    # 单调递增
    assert out == sorted(out)
    # 中段取样：第一个点约在 0.5s 而非 0s
    assert out[0] == 0.5


def test_choose_frame_timestamps_长视频受max_frames限制():
    from engine.video_extract import choose_frame_timestamps

    out = choose_frame_timestamps(600.0, max_frames=24)
    assert len(out) == 24


def test_choose_frame_timestamps_非法时长返回空():
    from engine.video_extract import choose_frame_timestamps

    assert choose_frame_timestamps(0, max_frames=24) == []
    assert choose_frame_timestamps(-5, max_frames=24) == []


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    from engine.main import app

    with TestClient(app) as c:
        yield c


def test_抽帧路由_把视频转成帧素材(client, monkeypatch):
    """抽帧本体（cv2）用桩替换：路由只验证「收视频 → 调抽帧 → 回帧素材」这条链路。

    真实 cv2 抽帧在沙箱里没有真实视频可验，但链路与纯函数都各自有测试覆盖。
    """
    import engine.video_extract as ve

    fake_frames = [
        {"id": "img_aaa", "name": "帧0.50s", "ts": 0.5},
        {"id": "img_bbb", "name": "帧1.50s", "ts": 1.5},
    ]
    monkeypatch.setattr(ve, "extract_upload", lambda path, max_frames=24: fake_frames)

    r = client.post(
        "/api/video/extract",
        files={"file": ("demo.mp4", io.BytesIO(b"\x00\x01binary"), "video/mp4")},
        data={"max_frames": "24"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["count"] == 2
    assert [f["id"] for f in body["frames"]] == ["img_aaa", "img_bbb"]


def test_抽帧路由_拒绝不支持的格式(client):
    r = client.post(
        "/api/video/extract",
        files={"file": ("demo.txt", io.BytesIO(b"hello"), "text/plain")},
    )
    assert r.status_code == 400


def test_抽帧路由_按表单里的max_frames抽帧(client, monkeypatch):
    """max_frames 前端是用 FormData（表单字段）发的，不是 query。

    曾经路由把它声明成普通标量 → FastAPI 只从 query 读，表单里的值被静默忽略，
    永远按默认 24 抽帧。
    """
    import engine.video_extract as ve

    captured: dict = {}
    monkeypatch.setattr(
        ve, "extract_upload", lambda path, max_frames=24: captured.update(mf=max_frames) or []
    )

    r = client.post(
        "/api/video/extract",
        files={"file": ("demo.mp4", io.BytesIO(b"\x00\x01binary"), "video/mp4")},
        data={"max_frames": "3"},
    )

    assert r.status_code == 200
    assert captured["mf"] == 3
