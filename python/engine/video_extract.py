# -*- coding: utf-8 -*-
"""视频抽帧：把一段视频按均匀间隔抽成若干帧，作为图像素材入库。

设计取舍：
- 抽到的帧直接走 ``image_library.import_image``，复用素材库的落盘 / 元数据 / 原图服务，
  不必为视频帧另写一套存储与展示。
- 抽帧点的选择是**纯函数** ``choose_frame_timestamps``，可单测、不依赖 cv2 / 真实视频；
  真正的 cv2 读取只是「到这些时间点抓一帧」的薄封装。
- 没有视觉模型：离线只能"按时间均匀取样"。要让"检查是否遗漏配件"这类语义意图真正可用，
  需要给每帧附上 OCR / 标签（见 docs/intent-recognition-feasibility.md），离线启发式再据此定位。
"""
from __future__ import annotations

import math
import tempfile
from pathlib import Path

from . import image_library


def choose_frame_timestamps(duration: float, max_frames: int = 24) -> list[float]:
    """按视频时长算均匀采样的时间点（秒）。

    纯函数、可单测：离线、不需要 cv2。
    - 时长 <= 0 → 空（没东西可抽）
    - 每秒约 1 帧，但不超过 ``max_frames``（长视频也不会抽爆素材库）
    - 采样点落在每段的**中段**（0.5s、1.5s…），避开 0s / 末尾的黑场与淡出
    """
    if duration is None or duration <= 0 or max_frames <= 0:
        return []
    n = max(1, min(max_frames, int(round(duration))))
    n = min(n, max_frames)
    if n <= 0:
        return []
    return [round(duration * (i + 0.5) / n, 3) for i in range(n)]


def extract_frames(video_path: str | Path, max_frames: int = 24) -> list[dict]:
    """抽帧并入库：返回每帧的素材描述（id / name / ts）。

    每帧作为一张图像素材入库，标签 ``视频帧``，名字带时间点，便于在素材库里定位、
    也便于被意图定位（locateByIntent）按名字/标签匹配。
    """
    import cv2

    cap = cv2.VideoCapture(str(video_path))
    try:
        if not cap.isOpened():
            raise ValueError("打不开这个视频（格式不支持或文件损坏）")
        fps = cap.get(cv2.CAP_PROP_FPS) or 0
        frames_total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        duration = (frames_total / fps) if fps > 0 else 0
        if duration <= 0:
            raise ValueError("读不到视频时长，无法均匀抽帧")

        ts_list = choose_frame_timestamps(duration, max_frames)
        created: list[dict] = []
        for ts in ts_list:
            frame_no = int(round(ts * fps)) if fps > 0 else 0
            cap.set(cv2.CAP_PROP_POS_FRAMES, frame_no)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            ok2, buf = cv2.imencode(".png", frame)
            if not ok2:
                continue
            asset = image_library.import_image(
                name=f"帧{ts:.2f}s",
                data=buf.tobytes(),
                tag="视频帧",
                threshold=0.8,
            )
            created.append({**asset, "ts": ts})
        if not created:
            raise ValueError("一帧都没抽出来（视频可能为空或不支持）")
        return created
    finally:
        cap.release()


def extract_upload(upload_path: str | Path, max_frames: int = 24) -> list[dict]:
    """从已落盘的上传视频抽帧（路由层先把上传文件存到临时文件再调这里）。"""
    return extract_frames(upload_path, max_frames=max_frames)


__all__ = ["choose_frame_timestamps", "extract_frames", "extract_upload"]
