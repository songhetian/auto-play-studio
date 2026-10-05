# -*- coding: utf-8 -*-
"""视频抽帧的 HTTP 路由。

只做：校验格式 → 落临时文件 → 调 video_extract → 把帧素材回给前端。
真正的抽帧逻辑在 video_extract（含可单测的纯函数 choose_frame_timestamps）。
"""
from __future__ import annotations

import os
import tempfile

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from . import video_extract

router = APIRouter(prefix="/video", tags=["video"])

_VIDEO_EXT = (".mp4", ".mov", ".avi", ".mkv", ".webm", ".flv", ".wmv")


@router.post("/extract")
async def extract(file: UploadFile = File(...), max_frames: int = Form(24)) -> dict:
    """上传一段视频，均匀抽帧成图像素材（标签「视频帧」），回传每帧的素材描述。

    抽到的帧直接进素材库，可在「图像素材库」里看、被意图定位、被监控指令引用。
    """
    suffix = os.path.splitext(file.filename or "")[1].lower()
    if suffix not in _VIDEO_EXT:
        raise HTTPException(400, f"不支持的视频格式（只收 {', '.join(_VIDEO_EXT)}）")

    fd, tmp = tempfile.mkstemp(suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(await file.read())
        frames = video_extract.extract_upload(tmp, max_frames=max_frames)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    return {"frames": frames, "count": len(frames)}
