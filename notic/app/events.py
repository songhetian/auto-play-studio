# -*- coding: utf-8 -*-
"""事件/回调管道定义：解耦检测器与告警层。"""
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, List


@dataclass
class DetectionEvent:
    """一次检测到的事件。"""

    kind: str  # 'drag_upload' | 'screenshot_key' | 'screenshot_clipboard'
    message: str
    timestamp: datetime = field(default_factory=datetime.now)

    @property
    def title(self):
        return {
            "drag_upload": "检测到拖拽上传",
            "screenshot_key": "检测到截图（按键）",
            "screenshot_clipboard": "检测到复制图片",
        }.get(self.kind, "检测到可疑操作")


class EventHub:
    """极简发布/订阅管道，线程安全。"""

    def __init__(self):
        self._listeners: List[Callable[[DetectionEvent], None]] = []
        self._lock = __import__("threading").RLock()

    def subscribe(self, cb: Callable[[DetectionEvent], None]):
        self._lock.acquire()
        try:
            self._listeners.append(cb)
        finally:
            self._lock.release()
        return lambda: self.unsubscribe(cb)

    def unsubscribe(self, cb):
        self._lock.acquire()
        try:
            if cb in self._listeners:
                self._listeners.remove(cb)
        finally:
            self._lock.release()

    def emit(self, event: DetectionEvent):
        self._lock.acquire()
        listeners = list(self._listeners)
        self._lock.release()
        for cb in listeners:
            try:
                cb(event)
            except Exception:
                pass