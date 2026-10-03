"""静音时段判定（工单 02 · S6b）。

开会/午休时不该被弹窗打断，但命中不能丢 —— 静音只影响「发不发」，不影响「记不记」。

窗口要支持跨天（22:00 → 08:00 是最常见的写法），这是最容易写错的一处。
"""
from __future__ import annotations

import datetime as dt


def _minutes(hhmm: str) -> "int | None":
    """'22:00' → 1320。写错返回 None（调用方据此当没配）。"""
    try:
        hour, minute = str(hhmm).split(":")
        value = int(hour) * 60 + int(minute)
    except (ValueError, AttributeError):
        return None
    return value if 0 <= value < 24 * 60 else None


def in_quiet_window(cfg: "dict | None", now: "dt.datetime | None" = None) -> bool:
    """当前是否在静音时段内。

    时间写错时返回 False —— 宁可不静音，也不要让用户以为通知坏了
    （静默静音是这类功能最坏的失败方式）。
    """
    quiet = (cfg or {}).get("quiet") or {}
    if not quiet.get("enabled"):
        return False
    start = _minutes(quiet.get("from", "") or "")
    end = _minutes(quiet.get("to", "") or "")
    if start is None or end is None:
        return False

    now = now or dt.datetime.now()
    cur = now.hour * 60 + now.minute
    if start == end:
        return True  # 起止相同 = 全天静音
    if start < end:
        return start <= cur < end
    return cur >= start or cur < end  # 跨天：从起点到午夜 + 午夜到终点
