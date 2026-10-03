"""Seam：命中事件的「未读」（工单 02 · S6a）。

「未读」是托盘角标与事件列表页共用的地基：监控是常驻盯屏的，人不可能一直看着窗口，
回来看一眼要知道「我走之后命中了几次」，看完能一键清空。

三条规矩：
1. 新事件默认未读（记录了却算已读 = 走开一趟回来什么都看不到）
2. 「全部标记已读」是全局的（按钮就叫这个），返回**本次真正被标记**的条数
3. 已读的不再重复计数 —— 否则角标会翻倍

期望值全部手写。
"""
from __future__ import annotations

import pytest

from engine import db

MONITOR = {"tool": "monitor", "region": "full", "rules": []}


@pytest.fixture(autouse=True)
def _clean_events():
    """conftest 只在会话开头清一次表，而这里有「看全局」的断言 —— 前后都清。"""
    _wipe()
    yield
    _wipe()


def _wipe():
    with db.write() as c:
        c.execute("DELETE FROM hit_events")


def _hit(iid: str, title: str) -> int:
    return db.record_hit_event(instance_id=iid, tool="monitor", rule_id="r", title=title)


def test_newly_recorded_events_start_unread(make_instance):
    iid = make_instance("monitor", MONITOR)
    _hit(iid, "命中 1")
    _hit(iid, "命中 2")

    events = db.list_hit_events()
    assert [e["read"] for e in events] == [False, False], "新事件必须默认未读"
    assert db.unread_count() == 2
    assert len(db.list_hit_events(unread_only=True)) == 2


def test_marking_read_only_touches_the_ones_named(make_instance):
    iid = make_instance("monitor", MONITOR)
    first = _hit(iid, "命中 1")
    second = _hit(iid, "命中 2")

    assert db.mark_hits_read([second]) == 1

    by_id = {e["id"]: e["read"] for e in db.list_hit_events()}
    assert by_id[first] is False, "没点到的那条不能跟着变已读"
    assert by_id[second] is True
    assert db.unread_count() == 1


def test_mark_all_read_covers_every_instance(make_instance):
    """按钮叫「全部标记已读」，就该是全局的 —— 不能只清当前实例的。"""
    a = make_instance("monitor", MONITOR, name="A")
    b = make_instance("monitor", MONITOR, name="B")
    _hit(a, "A 的命中")
    _hit(b, "B 的命中")

    assert db.mark_hits_read() == 2
    assert db.unread_count() == 0
    assert db.list_hit_events(unread_only=True) == []


def test_marking_read_twice_does_not_double_count(make_instance):
    iid = make_instance("monitor", MONITOR)
    _hit(iid, "命中 1")
    _hit(iid, "命中 2")

    assert db.mark_hits_read() == 2
    assert db.mark_hits_read() == 0, "已经读过的不再重复算进条数，否则角标会翻倍"


def test_unread_count_endpoint_and_marking_read_through_the_api(client, make_instance):
    iid = make_instance("monitor", MONITOR)
    first = _hit(iid, "命中 1")
    _hit(iid, "命中 2")

    assert client.get("/api/hit-events/unread-count").json() == {"count": 2}

    r = client.post("/api/hit-events/read", json={"ids": [first]})
    assert r.status_code == 200
    assert r.json() == {"marked": 1}
    assert client.get("/api/hit-events/unread-count").json() == {"count": 1}

    assert client.post("/api/hit-events/read", json={}).json() == {"marked": 1}
    assert client.get("/api/hit-events/unread-count").json() == {"count": 0}
