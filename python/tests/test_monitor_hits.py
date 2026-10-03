"""Seam：桌面监控的命中事件（结构化记录 + 读取接口）。

命中本来是散在日志里的一行文本；这里把它落成可查询的事件表，运行详情页能列出来。
记录的边界是 db 层（record/list），读取的边界是 API（GET /api/instances/{iid}/monitor-hits）。
"""
from __future__ import annotations

from engine import db


def test_record_and_list_monitor_hit_roundtrip(make_instance):
    iid = make_instance("monitor", {"tool": "monitor", "region": "full", "rules": []})
    db.record_monitor_hit(iid, "img_a", 0.93, [150, 100, 80, 60])

    hits = db.list_monitor_hits(iid)
    assert len(hits) == 1
    assert hits[0]["assetId"] == "img_a"
    assert hits[0]["similarity"] == 0.93
    assert hits[0]["rect"] == [150, 100, 80, 60]
    assert hits[0]["ts"]


def test_list_monitor_hits_newest_first_with_limit(make_instance):
    iid = make_instance("monitor", {"tool": "monitor", "region": "full", "rules": []})
    for i in range(5):
        db.record_monitor_hit(iid, f"img_{i}", 0.9, None)

    hits = db.list_monitor_hits(iid, limit=3)
    assert len(hits) == 3
    assert hits[0]["assetId"] == "img_4", "最新的命中排在最前"
    assert hits[0]["rect"] is None, "无位置时 rect 为 None，不报错"


def test_list_monitor_hits_scoped_per_instance(make_instance):
    a = make_instance("monitor", {"tool": "monitor", "region": "full", "rules": []}, name="A")
    b = make_instance("monitor", {"tool": "monitor", "region": "full", "rules": []}, name="B")
    db.record_monitor_hit(a, "img_a", 0.9, None)

    assert [h["assetId"] for h in db.list_monitor_hits(a)] == ["img_a"]
    assert db.list_monitor_hits(b) == [], "命中按实例隔离"


def test_monitor_hits_endpoint(client, make_instance):
    iid = make_instance("monitor", {"tool": "monitor", "region": "full", "rules": []})
    db.record_monitor_hit(iid, "img_a", 0.88, [10, 20, 30, 40])

    res = client.get(f"/api/instances/{iid}/monitor-hits")
    assert res.status_code == 200
    body = res.json()
    assert len(body) == 1
    assert body[0]["assetId"] == "img_a"
    assert body[0]["similarity"] == 0.88
    assert body[0]["rect"] == [10, 20, 30, 40]


def test_monitor_hits_endpoint_empty_for_unknown_instance(client):
    res = client.get("/api/instances/nope/monitor-hits")
    assert res.status_code == 200
    assert res.json() == []
