"""Seam：静音时段（工单 02 · S6b）。

开会/午休时不该被弹窗打断，但**命中不能丢**：静音期间事件照记，只是不往通道发。
`notified` 要写 `skip: 静音时段` 而不是留空 —— 否则用户在事件列表里只看到「这条没通知」，
看不出是静音了还是发失败了。

跨天窗口（22:00 → 08:00）是真实用法，也是最容易写错的地方。
期望值全部手写（时间点直接给）。
"""
from __future__ import annotations

import datetime as dt
import pytest

from engine import db
from engine.notify.model import NotifyPayload


@pytest.fixture(autouse=True)
def _clean():
    _wipe()
    yield
    _wipe()


def _wipe():
    with db.write() as c:
        c.execute("DELETE FROM settings WHERE key='notify'")
        c.execute("DELETE FROM hit_events")


def _quiet(enabled=True, start="22:00", end="08:00"):
    return {"quiet": {"enabled": enabled, "from": start, "to": end}}


def _in(cfg, hour, minute=0):
    from engine.notify.quiet import in_quiet_window

    return in_quiet_window(cfg, dt.datetime(2026, 10, 3, hour, minute))


def test_window_that_crosses_midnight():
    cfg = _quiet()
    assert _in(cfg, 23, 30) is True
    assert _in(cfg, 7, 0) is True, "跨天后半夜仍在窗口内"
    assert _in(cfg, 22, 0) is True, "起点算在窗口内"
    assert _in(cfg, 8, 0) is False, "到点就解除"
    assert _in(cfg, 21, 59) is False


def test_window_within_one_day():
    cfg = _quiet(start="09:00", end="18:00")
    assert _in(cfg, 12, 0) is True
    assert _in(cfg, 9, 0) is True
    assert _in(cfg, 17, 59) is True
    assert _in(cfg, 18, 0) is False
    assert _in(cfg, 8, 59) is False


def test_disabled_never_mutes():
    assert _in(_quiet(enabled=False), 23, 30) is False
    assert _in(_quiet(enabled=False), 3, 0) is False


def test_a_broken_time_means_no_muting():
    """时间写错了宁可不静音 —— 静默静音会让用户以为通知坏了。"""
    assert _in(_quiet(start="??", end="08:00"), 23, 30) is False
    assert _in(_quiet(start="22:00", end="25:99"), 23, 30) is False


def test_same_start_and_end_mutes_the_whole_day():
    assert _in(_quiet(start="00:00", end="00:00"), 13, 0) is True
    assert _in(_quiet(start="00:00", end="00:00"), 23, 59) is True


def test_muted_hits_are_still_recorded_and_say_why(make_instance):
    from engine.notify.report import report_hit

    iid = make_instance("monitor", {"tool": "monitor"})
    db.save_notify_config({"channels": {"desktop": True}, "routing": {"alert": ["desktop"]}, **_quiet()})

    class Channel:
        name = "desktop"
        sent = 0

        def send(self, _p):
            Channel.sent += 1

    eid = report_hit(
        instance_id=iid, tool="monitor", rule_id="img_a", level="alert", title="差评",
        channels=[Channel()], routing={"alert": ["desktop"]},
        now=dt.datetime(2026, 10, 3, 23, 30),
    )

    events = db.list_hit_events()
    assert len(events) == 1 and events[0]["id"] == eid, "静音期间命中不能丢"
    assert Channel.sent == 0, "静音就是不发"
    assert events[0]["notified"] == {"desktop": "skip: 静音时段"}, "要写明是静音，不是发失败"


def test_muted_result_comes_from_the_dispatcher():
    """静音判定不能散落在调用方：分发器是通道的唯一出口。"""
    from engine.notify import deliver

    class Channel:
        name = "desktop"
        sent = 0

        def send(self, _p):
            Channel.sent += 1

    payload = NotifyPayload(title="t", level="alert")
    got = deliver(payload, [Channel()], {"alert": ["desktop"]}, muted=True)
    assert got == {"desktop": "skip: 静音时段"}
    assert Channel.sent == 0
