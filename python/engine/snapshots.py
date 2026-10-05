"""命中快照：把命中那一刻的画面存下来。

背景：图片监控最常见的纠纷是"到底命中了没有"。此前命中只记 `rect`（坐标），
用户拿到一个坐标却不知道屏幕上当时是什么 —— 判断真命中还是误报只能跑到
现场复现，一张截图就能省掉这一趟。

两条决定：
  1. **存路径不存 base64**：命中是高频事件，base64 进库会让 db 迅速膨胀。
     落盘复用素材库目录（`AUTOPLAY_ASSETS_DIR`），有现成的路径白名单。
  2. **保存失败绝不影响命中上报**：监控是主链路，存图是附加能力。
     所以每一处失败都返回 None 安静退让，而不是抛异常打断监控。
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Sequence

import cv2
import numpy as np


def assets_root() -> Path:
    """素材库根目录（与 image_library 同约定）。"""
    configured = os.environ.get("AUTOPLAY_ASSETS_DIR")
    if configured:
        return Path(configured)
    db_path = Path(os.environ.get("AUTOPLAY_DB", "autoplay.db")).resolve()
    return db_path.parent / "image_assets"


def crop_region(
    frame: "np.ndarray | None",
    rect: "Sequence[int] | None",
) -> "np.ndarray | None":
    """按 `rect`（[x, y, w, h]）裁出命中区域。

    区域可能越界（命中贴着屏幕边缘），所以先与画面求交集；交集为空时返回
    None —— 返回一张 0 像素的图只会在保存时才炸，不如当场说"裁不出来"。
    """
    if frame is None or rect is None:
        return None
    try:
        x, y, w, h = (int(v) for v in rect)
    except (TypeError, ValueError):
        return None
    if w <= 0 or h <= 0:
        return None

    fh, fw = frame.shape[:2]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(fw, x + w), min(fh, y + h)
    if x1 <= x0 or y1 <= y0:
        return None
    return frame[y0:y1, x0:x1]


def _unique_path(folder: Path, stem: str) -> Path:
    """同名加序号 —— 绝不覆盖已有快照（覆盖了就查不出"当时"是什么了）。"""
    candidate = folder / f"{stem}.jpg"
    i = 1
    while candidate.exists():
        candidate = folder / f"{stem}({i}).jpg"
        i += 1
    return candidate


def save_hit_snapshot(
    frame: "np.ndarray | None",
    rect: "Sequence[int] | None",
    *,
    instance_id: str = "",
    now: "float | None" = None,
) -> str | None:
    """存一张命中截图，返回**相对素材库根目录**的路径（存进 db 的就是它）。

    返回 None 表示"没存成"（无 frame、裁不出区域、写盘失败）—— 调用方据此
    照常上报命中，不把存图失败当命中失败。
    """
    crop = crop_region(frame, rect)
    if crop is None:
        return None

    import time

    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now if now is not None else time.time()))
    # 实例名进文件名：一眼看出这张快照是哪台实例拍的，排查时不用查表
    safe_iid = "".join(ch for ch in (instance_id or "unknown") if ch.isalnum() or ch in "-_")[:24]
    folder = assets_root() / "hits" / safe_iid

    try:
        folder.mkdir(parents=True, exist_ok=True)
        dest = _unique_path(folder, f"{stamp}")
        ok, buf = cv2.imencode(".jpg", crop, [int(cv2.IMWRITE_JPEG_QUALITY), 80])
        if not ok:
            return None
        dest.write_bytes(buf.tobytes())
    except OSError:
        # 存图是附加能力：磁盘满了/权限不对都不该让监控崩
        return None

    return dest.relative_to(assets_root()).as_posix()
