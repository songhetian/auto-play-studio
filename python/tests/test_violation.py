# -*- coding: utf-8 -*-
"""违规事件：记录点 + 检索 + 聚合（工单 04 · ④）。

行为规格（对齐「主管事后抽检」的预期）：
- guard 命中一条违禁词，就落一条带 (word, level, seat, ts) 的事件，不是只给词 +1 计数；
- 统计页要能按 词 / 危级 / 时间 三轴筛选与聚合；
- 坐席维度在 A（纯单机）下恒为本机用户，这里只验证它能落到库里、可筛选。

期望值全部手写；不依赖 db.record_violation 内部怎么算。
"""
from __future__ import annotations

import pytest

from engine import db
from engine.sensitive import MatchHit
from engine.sensitive_words import service


def _clear():
    with db.write() as c:
        c.execute("DELETE FROM violation_events")


@pytest.fixture(autouse=True)
def _clean_table():
    _clear()
    yield
    _clear()


def test_record_violation_writes_all_fields():
    """命中点要落全字段：词、危级、坐席、实例、上下文。"""
    eid = db.record_violation(
        word="加微信",
        level="high",
        seat="song",
        instance_id="G1",
        detail="亲加我微信 abc123 便宜点",
    )
    row = db.query(
        "SELECT word, level, seat, instance_id, detail FROM violation_events WHERE id=?",
        (eid,),
    )[0]
    assert row["word"] == "加微信"
    assert row["level"] == "high"
    assert row["seat"] == "song"
    assert row["instance_id"] == "G1"
    assert row["detail"] == "亲加我微信 abc123 便宜点"


def test_record_violation_defaults():
    """没传的字段走默认值：mid 危级、guard 工具、空坐席。"""
    eid = db.record_violation(word="私下交易")
    row = db.query("SELECT level, seat, tool FROM violation_events WHERE id=?", (eid,))[0]
    assert row["level"] == "mid"
    assert row["tool"] == "guard"
    assert row["seat"] == ""


def test_record_violations_records_each_hit_with_level():
    """guard 一次可能命中多条词；每条都要落一条事件，且危级从 MatchHit 带过来。"""
    hits = [
        MatchHit(word="加微信", start=0, end=3, level="high"),
        MatchHit(word="私下交易", start=6, end=10, level="low"),
    ]
    service.record_violations(hits, instance_id="G1", seat="song")

    rows = db.list_violations()
    assert len(rows) == 2
    by_word = {r["word"]: r["level"] for r in rows}
    assert by_word["加微信"] == "high"
    assert by_word["私下交易"] == "low"


def test_list_violations_filters_by_word_and_level():
    db.record_violation(word="加微信", level="high", seat="song")
    db.record_violation(word="加微信", level="high", seat="song")
    db.record_violation(word="私下交易", level="low", seat="song")

    only_wechat = db.list_violations(word="加微信")
    assert len(only_wechat) == 2
    assert all(r["word"] == "加微信" for r in only_wechat)

    only_high = db.list_violations(level="high")
    assert len(only_high) == 2
    assert all(r["level"] == "high" for r in only_high)


def test_list_violations_filters_by_seat():
    """A 线坐席维度 = 本机用户：筛选要认 seat。"""
    db.record_violation(word="加微信", level="high", seat="song")
    db.record_violation(word="私下交易", level="low", seat="alice")

    mine = db.list_violations(seat="song")
    assert len(mine) == 1
    assert mine[0]["seat"] == "song"


def test_list_violations_filters_by_date_range():
    """按天筛选：只取某一天命中的。"""
    db.record_violation(word="加微信", level="high", seat="song")
    # 手动插一条很早之前的，模拟历史
    with db.write() as c:
        c.execute(
            "INSERT INTO violation_events(word, level, seat, ts) VALUES (?,?,?,?)",
            ("老词", "low", "song", "2000-01-01 10:00:00"),
        )

    today = db.list_violations(date_from="2026-01-01", date_to="2099-12-31")
    assert len(today) == 1
    assert today[0]["word"] == "加微信"

    old = db.list_violations(date_from="1999-01-01", date_to="2000-12-31")
    assert len(old) == 1
    assert old[0]["word"] == "老词"


def test_list_violations_order_newest_first_and_limit():
    for i in range(5):
        db.record_violation(word=f"w{i}", level="low", seat="song")

    rows = db.list_violations(limit=3)
    assert len(rows) == 3
    ids = [r["id"] for r in rows]
    assert ids == sorted(ids, reverse=True)


def test_get_violations_endpoint(client):
    """接口层：GET /api/violations 返回事件列表，字段 camelCase。"""
    db.record_violation(word="加微信", level="high", seat="song", instance_id="G1")
    r = client.get("/api/violations")
    assert r.status_code == 200
    data = r.json()
    assert isinstance(data, list)
    assert data[0]["word"] == "加微信"
    assert data[0]["level"] == "high"
    assert data[0]["seat"] == "song"
    assert data[0]["instanceId"] == "G1"


def test_get_violations_endpoint_filters(client):
    db.record_violation(word="加微信", level="high", seat="song")
    db.record_violation(word="私下交易", level="low", seat="song")

    r = client.get("/api/violations", params={"level": "low"})
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["word"] == "私下交易"


def test_get_violations_summary_endpoint(client):
    """聚合：按词计数、按危级计数、总数。统计页直接消费。"""
    db.record_violation(word="加微信", level="high", seat="song")
    db.record_violation(word="加微信", level="high", seat="song")
    db.record_violation(word="私下交易", level="low", seat="song")

    r = client.get("/api/violations/summary")
    assert r.status_code == 200
    s = r.json()
    assert s["total"] == 3

    by_word = {x["word"]: x["count"] for x in s["byWord"]}
    assert by_word["加微信"] == 2
    assert by_word["私下交易"] == 1

    assert s["byLevel"]["high"] == 2
    assert s["byLevel"]["low"] == 1
