"""桌面通知通道（工单 02 · S4）。

通道这一层只管「把通知交出去」：桌面通道把通知放进 outbox，
由 Electron 主进程取走并真正弹出 Windows 通知 + 托盘角标。

真弹窗是设备层（Electron `Notification`），按项目约定只人工验收；
通道本身在自动化测试里可验（它只依赖 outbox，不碰设备）。
"""
from __future__ import annotations

from . import outbox
from .model import NotifyPayload


class DesktopChannel:
    """桌面通知：放进 outbox 等 Electron 来取。"""

    name = "desktop"

    def send(self, payload: NotifyPayload) -> None:
        outbox.push(payload)
