"""自动化驱动抽象层。

指令解释器（commands.py）只认这个协议，不认具体实现。这样：
  * 测试注入假驱动，不真动鼠标；
  * 将来换实现（pyautogui → 其它）不用碰指令解释器；
  * 真正的实现集中在 pyautogui_driver.py，只有它依赖外部库。
"""
from __future__ import annotations

from typing import Protocol, runtime_checkable


class DriverUnavailable(RuntimeError):
    """真实驱动不可用（缺依赖 / 缺素材），消息要能直接指导用户怎么办。"""


@runtime_checkable
class Driver(Protocol):
    """一条指令最终落到驱动上的原语操作。"""

    def activate_window(self, title: str) -> None:
        """把标题匹配的窗口切到前台。"""

    def type_text(self, text: str) -> None:
        """向当前焦点输入文本（含中文时由实现决定走剪贴板还是逐字）。"""

    def press(self, combo: list[str], times: int, delay_ms: int) -> None:
        """按键或组合键，重复 times 次，每次之间停 delay_ms 毫秒。"""

    def click(self, x: int, y: int) -> None:
        """在屏幕绝对坐标点一下。"""

    def locate(self, asset_id: str, threshold: float, timeout_sec: float) -> tuple[int, int] | None:
        """在屏幕上找图，返回中心坐标；超时未找到返回 None。"""

    def sleep(self, seconds: float) -> None:
        """等待。"""


def build_driver() -> Driver:
    """构造真实驱动。放在这里是为了让「用哪个实现」只有一个决定点。"""
    from .pyautogui_driver import PyAutoGUIDriver

    return PyAutoGUIDriver()
