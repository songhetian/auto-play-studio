"""Seam：通知分发（工单 02 的第一片）。

这里只验「一次命中发给哪些通道、失败了怎么办」：
- 路由按级别查（`routing[level] = [通道名]`），没配通道就是不发，不是报错；
- **任何通道炸了都不影响别的通道，更不能影响监控主流程** —— 这是这条 seam 存在的理由；
- 返回值是「逐通道结果」，调用方（事件层）把它原样记进事件的 `notified` 字段。

期望值全部手写，不从实现里抄。
"""
from __future__ import annotations

import pytest

from engine.notify import Channel, NotifyPayload, deliver


def _payload(**over) -> NotifyPayload:
    base = {"title": "差评预警", "detail": "「差评关键词」命中", "level": "alert"}
    base.update(over)
    return NotifyPayload(**base)


class FakeChannel:
    """假通道：记下收到了什么；`boom=True` 时抛错，模拟通道故障。"""

    def __init__(self, name: str, boom: str | None = None) -> None:
        self.name = name
        self.boom = boom
        self.received: list[NotifyPayload] = []

    def send(self, payload: NotifyPayload) -> None:
        self.received.append(payload)
        if self.boom:
            raise RuntimeError(self.boom)


ROUTING = {
    "alert": ["desktop", "webhook"],
    "info": ["desktop"],
}


def test_only_channels_routed_for_the_level_get_called():
    desktop, webhook = FakeChannel("desktop"), FakeChannel("webhook")
    results = deliver(_payload(level="alert"), [desktop, webhook], ROUTING)

    assert results == {"desktop": "ok", "webhook": "ok"}
    assert len(desktop.received) == 1 and len(webhook.received) == 1


def test_a_level_without_channels_sends_nothing():
    desktop = FakeChannel("desktop")
    assert deliver(_payload(level="warn"), [desktop], ROUTING) == {}
    assert desktop.received == [], "warn 没配任何通道，就不该发"


def test_a_failing_channel_does_not_block_the_others():
    """这条是整个分发器存在的理由：webhook 挂了，桌面通知和监控本身都不能跟着挂。"""
    broken, healthy = FakeChannel("desktop", boom="网络不通"), FakeChannel("webhook")

    results = deliver(_payload(level="alert"), [broken, healthy], ROUTING)

    assert results == {"desktop": "fail: 网络不通", "webhook": "ok"}
    assert len(healthy.received) == 1, "前一个通道炸了，后面的通道照常要发"


def test_results_only_mention_channels_that_were_routed():
    desktop, webhook, mail = FakeChannel("desktop"), FakeChannel("webhook"), FakeChannel("mail")

    results = deliver(_payload(level="info"), [desktop, webhook, mail], ROUTING)

    assert results == {"desktop": "ok"}, "没被路由到的通道不应出现在结果里"
    assert webhook.received == [] and mail.received == []


def test_payload_travels_intact():
    ch = FakeChannel("desktop")
    deliver(_payload(title="差评预警", detail="命中「差」", level="alert"), [ch], ROUTING)

    got = ch.received[0]
    assert (got.title, got.detail, got.level) == ("差评预警", "命中「差」", "alert")
