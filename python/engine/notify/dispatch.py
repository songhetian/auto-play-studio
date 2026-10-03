"""按级别把一次命中分发给若干通道。

这条 seam 存在的理由只有一句话：**通知失败绝不能影响监控主流程**。
盯屏是长活，一条 webhook 断网就把监控拖死，等于没有监控。
所以这里的规矩是：
  - 没被路由到的通道**根本不碰**（结果里也不出现，免得用户以为「发了但没发成」）；
  - 某个通道炸了，记下原因、继续发下一个；
  - 返回逐通道结果，调用方原样写进事件的 `notified` 字段 —— 失败原因留在事件里可查。
"""
from __future__ import annotations

from typing import Iterable, Mapping

from engine.notify.model import Channel, NotifyPayload


def deliver(
    payload: NotifyPayload,
    channels: Iterable[Channel],
    routing: Mapping[str, list[str]],
    muted: bool = False,
) -> dict[str, str]:
    """把一次命中发给该走的通道，返回 {通道名: 'ok' | 'fail: 原因' | 'skip: 静音时段'}。

    静音判定放在这里而不是调用方：这里是通道的唯一出口，
    散落出去就会出现「桌面静音了、webhook 照发」这种半静音。
    """
    wanted = routing.get(payload.level, ())
    results: dict[str, str] = {}

    for channel in channels:
        if channel.name not in wanted:
            continue
        if muted:
            results[channel.name] = "skip: 静音时段"
            continue
        try:
            channel.send(payload)
        except Exception as exc:  # noqa: BLE001  通道的任何故障都不许往外冒
            results[channel.name] = f"fail: {exc}"
        else:
            results[channel.name] = "ok"

    return results
