"""Seam：命中事件（工单 02 · 独立事件模型 + 跨实例检索）。

以前命中只挂在「某个实例的运行记录」下（`monitor_hits`），跨实例查不到 ——
而「这个差评规则一共命中过几次、在哪个实例上」才是用户真正要问的问题。
所以事件模型独立成表，并按工具 / 级别 / 实例筛选。

`monitor_hits` 的读写全部改走 `hit_events`（单一真源），
运行详情页那份「命中记录」的字段（assetId / similarity / rect / ts）保持不变。

期望值全部手写。
"""
from __future__ import annotations

import pytest

from engine import db

MONITOR = {"tool": "monitor", "region": "full", "rules": []}


@pytest.fixture(autouse=True)
def _clean_events():
    """conftest 只在会话开头清一次表，而这里有「不带筛选看全局」的断言，
    会被同一文件里前面的用例留下的数据污染 —— 每条测试都从空表开始。"""
    with db.write() as c:
        c.execute("DELETE FROM hit_events")
    yield


def test_recorded_event_comes_back_with_every_field_it_needs(make_instance):
    iid = make_instance("monitor", MONITOR, name="差评哨兵")
    eid = db.record_hit_event(
        instance_id=iid,
        tool="monitor",
        rule_id="img_a",
        matched_by="image",
        level="alert",
        title="差评关键词",
        detail="相似度 0.93",
        similarity=0.93,
        rect=[150, 100, 80, 60],
        notified={"desktop": "ok", "webhook": "fail: 网络不通"},
    )
    assert eid > 0

    events = db.list_hit_events()
    assert len(events) == 1
    e = events[0]
    assert e["id"] == eid
    assert e["instanceId"] == iid
    assert e["tool"] == "monitor"
    assert e["ruleId"] == "img_a"
    assert e["matchedBy"] == "image", "靠什么命中的要记下来，否则用户没法判断规则可不可靠"
    assert e["level"] == "alert"
    assert e["title"] == "差评关键词"
    assert e["detail"] == "相似度 0.93"
    assert e["similarity"] == 0.93
    assert e["rect"] == [150, 100, 80, 60]
    assert e["notified"] == {"desktop": "ok", "webhook": "fail: 网络不通"}
    assert e["ts"]


def test_events_are_searchable_across_instances(make_instance):
    """跨实例检索是这张表存在的理由：不带 instanceId 就是看全局。"""
    a = make_instance("monitor", MONITOR, name="A")
    b = make_instance("monitor", MONITOR, name="B")
    db.record_hit_event(instance_id=a, tool="monitor", rule_id="r1", level="alert", title="命中 A")
    db.record_hit_event(instance_id=b, tool="monitor", rule_id="r2", level="info", title="命中 B")

    assert [e["instanceId"] for e in db.list_hit_events()] == [b, a], "最新的排最前"
    assert [e["instanceId"] for e in db.list_hit_events(instance_id=a)] == [a]
    assert [e["title"] for e in db.list_hit_events(level="alert")] == ["命中 A"]


def test_filter_by_tool(make_instance):
    a = make_instance("monitor", MONITOR, name="A")
    b = make_instance("rpa", {"tool": "rpa"}, name="B")
    db.record_hit_event(instance_id=a, tool="monitor", rule_id="r1", title="监控命中")
    db.record_hit_event(instance_id=b, tool="rpa", rule_id="r2", title="跑批告警")

    assert [e["title"] for e in db.list_hit_events(tool="monitor")] == ["监控命中"]
    assert [e["title"] for e in db.list_hit_events(tool="rpa")] == ["跑批告警"]


def test_pagination_walks_backwards_with_a_cursor(make_instance):
    iid = make_instance("monitor", MONITOR)
    for i in range(5):
        db.record_hit_event(instance_id=iid, tool="monitor", rule_id=f"r{i}", title=f"命中 {i}")

    page1 = db.list_hit_events(limit=2)
    assert [e["title"] for e in page1] == ["命中 4", "命中 3"]

    page2 = db.list_hit_events(limit=2, before_id=page1[-1]["id"])
    assert [e["title"] for e in page2] == ["命中 2", "命中 1"]

    # 5 条 / 每页 2 条 = 满两页还剩一条，最后一页是半页
    page3 = db.list_hit_events(limit=2, before_id=page2[-1]["id"])
    assert [e["title"] for e in page3] == ["命中 0"]

    assert db.list_hit_events(limit=2, before_id=page3[-1]["id"]) == [], "翻到最后应停下"


def test_hit_events_endpoint_filters_across_instances(client, make_instance):
    """跨实例检索必须有接口，否则页面只能一个实例一个实例地问。"""
    a = make_instance("monitor", MONITOR, name="A")
    b = make_instance("rpa", {"tool": "rpa"}, name="B")
    db.record_hit_event(instance_id=a, tool="monitor", rule_id="r1", level="alert", title="监控命中")
    db.record_hit_event(instance_id=b, tool="rpa", rule_id="r2", level="info", title="跑批提示")

    all_ev = client.get("/api/hit-events").json()
    assert [e["title"] for e in all_ev] == ["跑批提示", "监控命中"], "最新的排最前"

    assert [e["title"] for e in client.get("/api/hit-events", params={"level": "alert"}).json()] == ["监控命中"]
    assert [e["title"] for e in client.get("/api/hit-events", params={"tool": "rpa"}).json()] == ["跑批提示"]
    assert [e["title"] for e in client.get("/api/hit-events", params={"instanceId": a}).json()] == ["监控命中"]


def test_hit_events_endpoint_is_empty_when_nothing_hit(client):
    assert client.get("/api/hit-events").json() == []


def test_monitor_hits_and_hit_events_are_the_same_records(make_instance):
    """单一真源：老的 record_monitor_hit 只是 hit_events 的一个特例写法。"""
    iid = make_instance("monitor", MONITOR)
    db.record_monitor_hit(iid, "img_a", 0.93, [150, 100, 80, 60])

    hits = db.list_monitor_hits(iid)
    assert hits == [
        {"assetId": "img_a", "similarity": 0.93, "rect": [150, 100, 80, 60], "ts": hits[0]["ts"]}
    ]

    events = db.list_hit_events(instance_id=iid)
    assert len(events) == 1
    assert events[0]["ruleId"] == "img_a"
    assert events[0]["matchedBy"] == "image"
    assert events[0]["level"] == "alert", "监控命中默认按「要提醒」处理"
