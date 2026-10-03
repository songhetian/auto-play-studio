"""Seam：桌面通知的出口与通道装配（工单 02 · S4 引擎侧）。

引擎弹不了通知，攒在 outbox 里等 Electron 主进程来取 —— 这个环必须可测，
否则「命中了但没弹」会分不清是通道没发、还是主进程没取。

期望值全部手写。
"""
from __future__ import annotations

import pytest

from engine import db
from engine.notify import outbox
from engine.notify.desktop import DesktopChannel
from engine.notify.model import NotifyPayload
from engine.notify.report import build_channels


@pytest.fixture(autouse=True)
def _clean():
    """outbox 是进程级队列、通知配置是全局一行 —— 前后都要清，别留给下一个文件。"""
    _wipe()
    yield
    _wipe()


def _wipe():
    outbox.reset()
    with db.write() as c:
        c.execute("DELETE FROM settings WHERE key='notify'")


def _payload(title: str = "差评关键词", level: str = "alert") -> NotifyPayload:
    return NotifyPayload(
        title=title, detail="相似度 0.93", level=level, instance_id="I1", rule_id="img_a", matched_by="image"
    )


def test_desktop_channel_puts_the_notification_in_the_outbox():
    DesktopChannel().send(_payload())

    items, _cursor = outbox.drain()
    assert len(items) == 1
    assert items[0]["title"] == "差评关键词"
    assert items[0]["instanceId"] == "I1"
    assert items[0]["ruleId"] == "img_a"
    assert items[0]["matchedBy"] == "image"
    assert items[0]["level"] == "alert"
    assert items[0]["at"]


def test_cursor_keeps_the_reader_from_getting_the_same_one_twice():
    DesktopChannel().send(_payload("第一条"))
    items, cursor = outbox.drain()
    assert [i["title"] for i in items] == ["第一条"]

    DesktopChannel().send(_payload("第二条"))
    items2, _ = outbox.drain(since=cursor)
    assert [i["title"] for i in items2] == ["第二条"], "取过的不再重复，没取过的不能漏"

    assert outbox.drain(since=cursor + 1)[0] == [], "游标推进后不该再有"


def test_outbox_only_keeps_the_most_recent_ones():
    """没人来取时不该无限涨 —— 丢的是最老的，留给最近的。"""
    for i in range(250):
        DesktopChannel().send(_payload(f"第 {i} 条"))

    items, _ = outbox.drain()
    assert len(items) == 200
    assert items[0]["title"] == "第 50 条"
    assert items[-1]["title"] == "第 249 条"


def test_outbox_endpoint_returns_items_and_a_cursor(client):
    DesktopChannel().send(_payload())
    r = client.get("/api/notifications/outbox")
    assert r.status_code == 200
    body = r.json()
    assert [i["title"] for i in body["items"]] == ["差评关键词"]
    assert body["cursor"] >= 1

    assert client.get("/api/notifications/outbox", params={"since": body["cursor"]}).json()["items"] == []


def test_build_channels_only_returns_the_enabled_ones():
    assert [c.name for c in build_channels()] == ["desktop"], "默认开桌面通知"

    db.save_notify_config({"channels": {"desktop": False, "webhook": False}})
    assert build_channels() == [], "停用的通道根本不该进列表"
