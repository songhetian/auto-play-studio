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
        """在屏幕绝对坐标点一下（等价于鼠标左键单击）。"""

    def locate(self, asset_id: str, threshold: float, timeout_sec: float) -> tuple[int, int] | None:
        """在屏幕上找图，返回中心坐标；超时未找到返回 None。"""

    def sleep(self, seconds: float) -> None:
        """等待。"""

    # ── 以下是按键精灵指令库扩充出来的原语 ──
    # 原来只有上面 6 个，"按一下快捷键"之外什么都做不了：
    # 右键菜单、滚轮翻页、鼠标移动、剪贴板、截图全都没有。

    def click_button(self, x: int, y: int, button: str = "left", clicks: int = 1) -> None:
        """在坐标点击。``button`` = left/right/middle，``clicks`` = 2 就是双击。"""

    def move_to(self, x: int, y: int, duration_ms: int = 0) -> None:
        """把鼠标移动到坐标（不点击）。悬停出菜单时需要。"""

    def scroll(self, amount: int) -> None:
        """滚轮。正数向上翻页，负数向下。"""

    def drag_to(self, x1: int, y1: int, x2: int, y2: int, duration_ms: int = 300) -> None:
        """从 (x1,y1) 按下拖到 (x2,y2) 再松开。文件拖拽、下拉框展开都要它。"""

    def copy_to_clipboard(self, text: str) -> None:
        """写剪贴板。客服场景高频：从 Excel 取一段话贴进聊天框。"""

    def paste_from_clipboard(self) -> None:
        """粘贴（等价于 Ctrl+V）。"""

    def read_clipboard(self) -> str:
        """读剪贴板内容。"""

    def screenshot_to(self, path: str) -> None:
        """整屏截图存到路径。留证、比对异常时用。"""

    def get_screen_size(self) -> tuple[int, int]:
        """屏幕分辨率。指令里可以用 ``{屏幕宽}`` 之类的变量做相对定位。"""

    def cursor_position(self) -> tuple[int, int]:
        """当前鼠标位置。"""


def build_driver() -> Driver:
    """构造真实驱动。放在这里是为了让「用哪个实现」只有一个决定点。"""
    from .pyautogui_driver import PyAutoGUIDriver

    return PyAutoGUIDriver()
