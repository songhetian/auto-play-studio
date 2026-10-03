"""真实驱动实现（pyautogui + OpenCV）。

只有这个文件依赖外部库，而且全部延迟导入 —— 没装也不影响引擎启动，
只在真正要执行 RPA 指令时才报「请先安装 xxx」。

依赖（按需装，见 requirements.txt）：
    pyautogui    键盘鼠标
    pyperclip    中文走剪贴板（pyautogui 直接输入中文不可靠）
    pillow       截图
    opencv-python + numpy  模板匹配找图
"""
from __future__ import annotations

import time
from pathlib import Path

from . import db, window_control
from .driver import DriverUnavailable


def _need(module: str, package: str) -> object:
    try:
        return __import__(module)
    except ImportError as exc:  # noqa: BLE001
        raise DriverUnavailable(f"缺少依赖 {package}，请执行：pip install {package}") from exc


class PyAutoGUIDriver:
    """把指令原语落到真实的键盘、鼠标、屏幕上。"""

    def __init__(self) -> None:
        self._pag = None
        self._screenshot = None

    # ── 延迟加载，避免没装依赖时连引擎都起不来 ──
    @property
    def pag(self):
        if self._pag is None:
            _need("pyautogui", "pyautogui")
            import pyautogui

            pyautogui.FAILSAFE = True  # 鼠标甩到左上角即紧急中止
            pyautogui.PAUSE = 0.05
            self._pag = pyautogui
        return self._pag

    def activate_window(self, title: str) -> None:
        window_control.activate_window(title)

    def type_text(self, text: str) -> None:
        """输入文本。含中文时走剪贴板 —— pyautogui 逐字输入中文会丢字。"""
        if not text:
            return
        if text.isascii():
            self.pag.write(text, interval=0.02)
            return
        pyperclip = _need("pyperclip", "pyperclip")
        pyperclip.copy(text)
        self.pag.hotkey("ctrl", "v")
        time.sleep(0.05)

    def press(self, combo: list[str], times: int = 1, delay_ms: int = 120) -> None:
        for i in range(max(1, times)):
            if len(combo) == 1:
                self.pag.press(combo[0])
            else:
                self.pag.hotkey(*combo)
            if i < times - 1:
                time.sleep(max(0, delay_ms) / 1000)

    def click(self, x: int, y: int) -> None:
        self.pag.click(int(x), int(y))

    def locate(self, asset_id: str, threshold: float = 0.85, timeout_sec: float = 5.0):
        """在屏幕上找图并返回中心坐标；超时返回 None。

        素材来自图像库（image_assets 表 + 磁盘文件），这里只负责匹配。
        """
        path = self._asset_path(asset_id)
        _need("cv2", "opencv-python")
        _need("numpy", "numpy")
        import cv2
        import numpy as np

        template = cv2.imread(str(path))
        if template is None:
            raise DriverUnavailable(f"图片素材读不出来：{path}")
        th, tw = template.shape[:2]

        deadline = time.time() + max(0.1, timeout_sec)
        while True:
            shot = np.array(self.pag.screenshot())
            gray_shot = cv2.cvtColor(shot, cv2.COLOR_RGB2GRAY)
            res = cv2.matchTemplate(gray_shot, cv2.cvtColor(template, cv2.COLOR_BGR2GRAY), cv2.TM_CCOEFF_NORMED)
            _min_v, max_v, _min_l, max_l = cv2.minMaxLoc(res)
            if max_v >= threshold:
                return (max_l[0] + tw // 2, max_l[1] + th // 2)
            if time.time() >= deadline:
                return None
            time.sleep(0.2)

    def sleep(self, seconds: float) -> None:
        time.sleep(max(0.0, seconds))

    @staticmethod
    def _asset_path(asset_id: str) -> Path:
        rows = db.query("SELECT path FROM image_assets WHERE id=?", (asset_id,))
        if not rows:
            raise DriverUnavailable(f"图像库里没有 id 为 {asset_id} 的素材，请先在图像库中导入")
        path = Path(rows[0]["path"])
        if not path.is_file():
            raise DriverUnavailable(f"图片素材文件不存在：{path}")
        return path
