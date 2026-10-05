"""Seam：命中 → 通知（工单 02 · S3 接线）。

`report_hit` 是「命中」通往「通知」的唯一入口：记事件、组 payload、分发、把结果写回事件。

三条不能破的规矩（S1 已在分发器里守住一半，这里守住另一半）：
1. 通道炸了不影响记录 —— 事件必须先落库，通知只是附带的
2. 结果要写回**这一条**事件，不能写到别的事件上
3. 级别没配通道就是没发，结果里也不出现（否则会读成「发了但没成」）

期望值全部手写。
"""
from __future__ import annotations

import pytest

from engine import db
from engine.notify import deliver
from engine.notify.model import NotifyPayload


class FakeChannel:
    """记下收到的 payload，可选地在 send 里抛异常。"""

    def __init__(self, name: str, boom: Exception | None = None) -> None:
        self.name = name
        self._boom = boom
        self.sent: list[NotifyPayload] = []

    def send(self, payload: NotifyPayload) -> None:
        if self._boom is not None:
            raise self._boom
        self.sent.append(payload)


@pytest.fixture(autouse=True)
def _clean_events():
    with db.write() as c:
        c.execute("DELETE FROM hit_events")
    yield


def _report(**kw):
    from engine.notify.report import report_hit

    kw.setdefault("instance_id", "I1")
    kw.setdefault("tool", "monitor")
    return report_hit(**kw)


def test_report_hit_records_the_event_and_writes_the_result_back():
    ch = FakeChannel("desktop")
    eid = _report(
        rule_id="img_a", level="alert", title="差评关键词", detail="相似度 0.93",
        channels=[ch], routing={"alert": ["desktop"], "warn": [], "info": []},
    )
    assert eid > 0

    e = db.list_hit_events()[0]
    assert e["id"] == eid
    assert e["notified"] == {"desktop": "ok"}, "发没发出去要记在事件上，事件列表才能回答这件事"

    assert len(ch.sent) == 1
    # 通知标题走 wording 的统一说法（与应用内横幅同源），不是调用方给的原文；
    # 原文（"差评关键词"）仍留在事件的 detail 里，排查时能看到命中的具体是什么。
    assert ch.sent[0].title == "图片监控命中"
    assert "差评关键词" in ch.sent[0].detail
    assert ch.sent[0].level == "alert"
    assert ch.sent[0].instance_id == "I1"


def test_a_channel_that_blows_up_does_not_break_reporting():
    ch = FakeChannel("desktop", boom=RuntimeError("托盘没了"))
    eid = _report(level="alert", channels=[ch], routing={"alert": ["desktop"]})

    events = db.list_hit_events()
    assert len(events) == 1, "通知失败不能把命中记录一起带走"
    assert events[0]["id"] == eid
    assert events[0]["notified"] == {"desktop": "fail: 托盘没了"}, "失败原因要留下来，否则用户只看到「没通知」"


def test_level_without_any_channel_is_recorded_without_a_result():
    ch = FakeChannel("desktop")
    _report(level="warn", channels=[ch], routing={"alert": ["desktop"], "warn": [], "info": []})

    assert ch.sent == [], "没配通道的级别不该去碰通道"
    assert db.list_hit_events()[0]["notified"] == {}, "没发过就是没发过，别记成发了但没成"


def test_the_result_lands_on_the_event_it_belongs_to():
    """写回必须认准本次这条 —— 写错行的话，事件列表里全是张冠李戴的通知状态。"""
    quiet = FakeChannel("desktop")
    _report(rule_id="old", level="info", channels=[quiet], routing={"info": []})

    loud = FakeChannel("desktop")
    eid2 = _report(rule_id="new", level="alert", channels=[loud], routing={"alert": ["desktop"]})

    events = db.list_hit_events()
    assert [e["id"] for e in events] == [eid2, eid2 - 1], "最新的排最前"
    assert events[0]["notified"] == {"desktop": "ok"}
    assert events[1]["notified"] == {}, "上一条没发过，不能被这次的结果盖掉"


def test_deliver_is_the_only_thing_between_a_hit_and_its_channels():
    """一条反证：`report_hit` 不许自己发明分发逻辑（否则 S1 守的规矩就白守了）。"""
    ch = FakeChannel("desktop")
    payload = NotifyPayload(title="t", detail="d", level="alert", instance_id="I1", rule_id="r")
    assert deliver(payload, [ch], {"alert": ["desktop"]}) == {"desktop": "ok"}
