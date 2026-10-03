"""屏幕互斥：一块屏幕同一时刻只能有一个实例在动键鼠。

rpa / macro 靠模拟真人键鼠干活，作用于**当前焦点窗口**。两个同时跑，第二个会把第一个的
窗口顶掉焦点、抢鼠标 —— 而且不报错，只会悄悄点错窗口、把话发给错人。这是「模拟真人键鼠」
这个手段的物理上限，不是实例模型的 bug：一块屏幕不可能同时被两套鼠标占用。

所以约束落在「同时跑」上，而不是「多开」上：多份配置照常并存、照常多开，
只是 start 的时候要抢到屏幕；抢不到就明说被谁占着，让用户去停那个，而不是让两个实例打架。

刻意**不含 monitor**：它只读屏、不抢键鼠，而且常驻盯屏是它的本职 ——
若它也占锁，别的实例就永远跑不起来。代价是「rpa 跑批时监控可能误判」，这条要在界面上提示。
"""
from __future__ import annotations

import threading

#: 要动真键鼠的工具。往这里加工具 = 宣布「它会抢屏幕」。
SCREEN_TOOLS = frozenset({"rpa", "macro"})


class ScreenBusy(RuntimeError):
    """屏幕已被别的实例占用。`holder_id` 是占着屏幕的那个实例。"""

    def __init__(self, holder_id: str) -> None:
        self.holder_id = holder_id
        super().__init__(holder_id)


_gate = threading.Lock()
_holder: str | None = None


def acquire_or_raise(holder_id: str) -> None:
    """握住屏幕；已被别的实例握着就抛 `ScreenBusy`。同一个实例重复进入是允许的。"""
    global _holder
    with _gate:
        if _holder is not None and _holder != holder_id:
            raise ScreenBusy(_holder)
        _holder = holder_id


def release(holder_id: str) -> None:
    global _holder
    with _gate:
        if _holder == holder_id:
            _holder = None


def holder() -> str | None:
    with _gate:
        return _holder


def is_screen_tool(tool: str | None) -> bool:
    return tool in SCREEN_TOOLS
