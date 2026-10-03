# -*- coding: utf-8 -*-
"""告警管理器：订阅检测事件、去抖后再经 Qt 信号交由主线程 UI 处理。"""
import time

from PyQt5.QtCore import QObject, pyqtSignal


class Alerter(QObject):
    """将底层检测事件去抖后转发为主线程信号。

    - 事件流来自 pynput 钩子线程 / 剪贴板轮询线程。
    - 通过 Qt 信号 `alert_triggered(title, message)` 交付主线程——由
      QObject 属于主线程 + AutoConnection 保证线程安全。
    - 界面弹窗与声音播放由主窗口的连接槽完成（见 ui/main_window.py）。
    - 内置去抖：同一类型事件在 debounce_ms 内只转发一次，防连发。
    """

    alert_triggered = pyqtSignal(str, str)

    def __init__(self, event_hub, debounce_ms=500, parent=None):
        super().__init__(parent)
        self._last_time = 0.0
        self._last_kind = None
        self._debounce_ms = debounce_ms
        self._sub = event_hub.subscribe(self._on_event)

    def _on_event(self, event):
        now = time.time() * 1000
        if self._last_kind == event.kind and (now - self._last_time) < self._debounce_ms:
            return
        self._last_time = now
        self._last_kind = event.kind
        self.alert_triggered.emit(event.title, event.message)

    def shutdown(self):
        try:
            self._sub()
        except Exception:
            pass