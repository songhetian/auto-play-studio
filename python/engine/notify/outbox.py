"""桌面通知的出口（工单 02 · S4 的引擎侧）。

引擎是 sidecar，自己弹不了 Windows 通知；而且监控是常驻盯屏的，
没人会一直开着实例窗口等着收。所以引擎把待发的通知攒在这里，
由 Electron 主进程（托盘常驻）来取并真正弹出去 —— 窗口关了也照样收得到。

只存最近 `_MAX` 条：没人在取的时候（比如应用没开）不该无限涨。
"""
from __future__ import annotations

import itertools
import threading
import time
from typing import Any

from .model import NotifyPayload

_MAX = 200

_lock = threading.Lock()
_seq = itertools.count(1)
_items: list[dict[str, Any]] = []


def push(payload: NotifyPayload) -> int:
    """把一条通知放进待发队列，返回它的序号。"""
    with _lock:
        nid = next(_seq)
        _items.append({
            "id": nid,
            "instanceId": payload.instance_id,
            "ruleId": payload.rule_id,
            "matchedBy": payload.matched_by,
            "level": payload.level,
            "title": payload.title,
            "detail": payload.detail,
            "at": time.strftime("%Y-%m-%d %H:%M:%S"),
        })
        if len(_items) > _MAX:
            del _items[: len(_items) - _MAX]
        return nid


def drain(since: int = 0) -> tuple[list[dict[str, Any]], int]:
    """取 `since` 之后的通知，返回 (列表, 新游标)。游标回传给下次调用，取过的不再重复。"""
    with _lock:
        items = [i for i in _items if i["id"] > since]
        cursor = _items[-1]["id"] if _items else since
        return items, cursor


def reset() -> None:
    """清空待发队列（仅测试用）。"""
    with _lock:
        _items.clear()
