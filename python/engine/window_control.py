"""窗口控制：按标题把目标窗口切到前台。

用 ctypes 直接调 Win32，不引第三方库 —— 新手上手时最烦的就是「找不到窗口」，
这一层要尽量少让人装东西。
"""
from __future__ import annotations

import ctypes
import sys
import time

from .driver import DriverUnavailable

_IS_WINDOWS = sys.platform == "win32"

if _IS_WINDOWS:  # pragma: no cover - 仅在 Windows 上可用
    _user32 = ctypes.windll.user32
    SW_RESTORE = 9


def list_windows() -> list[tuple[int, str]]:
    """枚举带标题的顶层窗口，返回 [(hwnd, title)]。"""
    if not _IS_WINDOWS:
        raise DriverUnavailable("窗口控制目前只支持 Windows")
    out: list[tuple[int, str]] = []

    @ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)  # type: ignore[attr-defined]
    def _cb(hwnd, _lparam):
        if not _user32.IsWindowVisible(hwnd):
            return True
        length = _user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        _user32.GetWindowTextW(hwnd, buf, length + 1)
        out.append((int(hwnd), buf.value))
        return True

    _user32.EnumWindows(_cb, 0)
    return out


def find_window(title: str) -> int | None:
    """按标题找窗口：先精确匹配，再退化为包含匹配（用户往往只记得关键字）。"""
    title = (title or "").strip()
    if not title:
        return None
    windows = list_windows()
    for hwnd, t in windows:
        if t == title:
            return hwnd
    for hwnd, t in windows:
        if title in t:
            return hwnd
    return None


def activate_window(title: str) -> None:
    """把窗口切到前台。找不到就抛 DriverUnavailable，让这一行失败而不是乱点。"""
    if not _IS_WINDOWS:
        raise DriverUnavailable("窗口控制目前只支持 Windows")

    hwnd = find_window(title)
    if hwnd is None:
        raise DriverUnavailable(f"没有找到标题包含「{title}」的窗口，请确认它已打开")

    # 最小化的窗口先还原，否则 SetForegroundWindow 不生效
    if _user32.IsIconic(hwnd):
        _user32.ShowWindow(hwnd, SW_RESTORE)
    _user32.SetForegroundWindow(hwnd)
    _user32.BringWindowToTop(hwnd)
    time.sleep(0.2)  # 给窗口一点时间真正获得焦点
