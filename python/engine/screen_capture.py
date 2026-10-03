"""区域截图采集：从屏幕上框一块区域，直接存成素材。

分两层：
  * 采集原语 `default_grabber(x, y, w, h) -> PNG 字节` —— 只有它碰真实屏幕，
    依赖（pyautogui / Pillow）全部延迟导入，缺了就报一条能照着做的提示；
  * `capture_into_library(...)` —— 校验区域、抓图、交给图像库入库。

采集函数接受可注入的 grabber，所以「区域校验 / 尺寸记录 / 落库位置」这些
真实逻辑都能在没有屏幕的环境里测完，只有像素本身靠人工验收。
"""
from __future__ import annotations

import io
from collections.abc import Callable
from typing import Any

from . import image_library
from .driver import DriverUnavailable

Grabber = Callable[[int, int, int, int], bytes]

_INSTALL_HINT = "截屏需要 pyautogui 与 Pillow，请先安装：pip install pyautogui pillow"


def _load_capture_deps() -> tuple[Any, Any]:
    """延迟导入截图依赖，缺依赖时给出一条能照着做的提示。"""
    try:
        import pyautogui
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - 依赖装了就不会走到这里
        raise DriverUnavailable(_INSTALL_HINT) from exc
    return pyautogui, Image


def default_grabber(x: int, y: int, width: int, height: int) -> bytes:
    """真实截屏：抓一块区域并编码成 PNG 字节。"""
    pyautogui, _ = _load_capture_deps()
    shot = pyautogui.screenshot(region=(x, y, width, height))
    buf = io.BytesIO()
    shot.save(buf, format="PNG")
    return buf.getvalue()


def validate_region(region: tuple[int, int, int, int] | list[int]) -> tuple[int, int, int, int]:
    """区域必须是四元组且宽高为正。

    原点允许为负 —— 副屏摆在主屏左边/上边时坐标就是负的，那是正常情况。
    但宽高为 0 只能截出一张不存在的图，不如当场拒掉。
    """
    if len(region) != 4:
        raise ValueError("区域需要 x / y / 宽 / 高 四个值")
    x, y, width, height = (int(v) for v in region)
    if width <= 0 or height <= 0:
        raise ValueError(f"区域宽高必须大于 0，收到 {width}×{height}")
    return x, y, width, height


def capture_into_library(
    name: str,
    region: tuple[int, int, int, int] | list[int],
    *,
    grabber: Grabber | None = None,
    tag: str = image_library.DEFAULT_TAG,
    threshold: float = image_library.DEFAULT_THRESHOLD,
) -> dict[str, Any]:
    """框选区域 → 存进素材库。区域非法或抓到的不是图片都会抛 ValueError。"""
    x, y, width, height = validate_region(region)
    data = (grabber or default_grabber)(x, y, width, height)
    return image_library.import_image(name, data, tag=tag, threshold=threshold)


__all__ = [
    "Grabber",
    "capture_into_library",
    "default_grabber",
    "validate_region",
]

