# -*- coding: utf-8 -*-
"""命中事件的「处置状态」—— 告警确认闭环。

未读只回答「我走开这段时间命中了什么」；处置状态回答的是更要紧的一句：
**「这些告警有人管过吗」**。监控是常驻盯屏的，弹窗一闪而过、没人确认，
等于没报 —— 所以要有一条能追的闭环记录。

三条规矩：
1. 新事件默认「待确认」（pending）
2. 确认是显式动作，记下确认时刻（ackAt），返回**本次真正被确认**的条数
3. 已确认的不再重复计数；确认即视为已读（看过才谈得上确认）

期望值全部手写。
"""
from __future__ import annotations

import pytest

from engine import db

MONITOR = {"tool": "monitor", "region": "full", "rules": []}


@pytest.fixture(autouse=True)
def _clean_events():
    """conftest 只在会话开头清一次表，而这里断言看全局 —— 前后都清。"""
    _wipe()
    yield
    _wipe()


def _wipe():
    with db.write() as c:
        c.execute("DELETE FROM hit_events")


def _hit(iid: str, title: str) -> int:
    return db.record_hit_event(instance_id=iid, tool="monitor", rule_id="r", title=title)


def test_newly_recorded_events_start_pending(make_instance):
    iid = make_instance("monitor", MONITOR)
    _hit(iid, "命中 1")

    e = db.list_hit_events()[0]
    assert e["disposition"] == "pending", "新事件必须默认待确认"
    assert e["ackAt"] == "", "没确认过就没有确认时刻"


def test_ack_only_touches_the_ones_named(make_instance):
    iid = make_instance("monitor", MONITOR)
    first = _hit(iid, "命中 1")
    second = _hit(iid, "命中 2")

    assert db.ack_hit_events([second]) == 1

    by_id = {e["id"]: e["disposition"] for e in db.list_hit_events()}
    assert by_id[first] == "pending", "没点到的那条不能跟着被确认"
    assert by_id[second] == "acknowledged"


def test_ack_records_when_it_happened(make_instance):
    iid = make_instance("monitor", MONITOR)
    eid = _hit(iid, "命中 1")
    db.ack_hit_events([eid])

    e = db.list_hit_events()[0]
    assert e["ackAt"], "确认时刻要记下来 —— 否则无从回答「多快响应」"


def test_ack_all_covers_every_instance(make_instance):
    """不传 ids = 全部确认，就该是跨实例的。"""
    a = make_instance("monitor", MONITOR, name="A")
    b = make_instance("monitor", MONITOR, name="B")
    _hit(a, "A 的命中")
    _hit(b, "B 的命中")

    assert db.ack_hit_events() == 2


def test_acking_twice_does_not_double_count(make_instance):
    iid = make_instance("monitor", MONITOR)
    _hit(iid, "命中 1")
    _hit(iid, "命中 2")

    assert db.ack_hit_events() == 2
    assert db.ack_hit_events() == 0, "已确认的不再重复算，否则统计就虚高"


def test_ack_also_marks_read(make_instance):
    """确认意味着「处理了」，处理过的一定看过了 —— 别让已确认的还挂着未读角标。"""
    iid = make_instance("monitor", MONITOR)
    _hit(iid, "命中 1")
    assert db.unread_count() == 1

    db.ack_hit_events()

    assert db.unread_count() == 0
    assert db.list_hit_events()[0]["disposition"] == "acknowledged"


def test_ack_endpoint(client, make_instance):
    iid = make_instance("monitor", MONITOR)
    first = _hit(iid, "命中 1")
    _hit(iid, "命中 2")

    r = client.post("/api/hit-events/ack", json={"ids": [first]})
    assert r.status_code == 200
    assert r.json() == {"acked": 1}

    assert client.post("/api/hit-events/ack", json={}).json() == {"acked": 1}
    assert client.post("/api/hit-events/ack", json={}).json() == {"acked": 0}