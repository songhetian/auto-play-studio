"""命中事件要能带上快照（对应原型改进项 ①）。

给 `hit_events` 加 `snapshot` 列：存相对素材库根目录的路径。
**存路径不存图片本身** —— 命中是高频事件，base64 进库会让 db 迅速膨胀。
"""
from __future__ import annotations

from engine import db


def _clear() -> None:
    with db.write() as c:
        c.execute("DELETE FROM hit_events")


def test_记命中时可以带快照路径() -> None:
    _clear()
    eid = db.record_hit_event(
        instance_id="I1",
        tool="monitor",
        title="订单页面模板",
        rect=[10, 20, 100, 50],
        snapshot="hits/I1/20261005-102231.jpg",
    )
    e = db.list_hit_events()[0]
    assert e["id"] == eid
    assert e["snapshot"] == "hits/I1/20261005-102231.jpg"
    assert e["rect"] == [10, 20, 100, 50]


def test_不传快照时是空_不报错() -> None:
    _clear()
    db.record_hit_event(instance_id="I1", tool="guard", title="最佳")
    assert db.list_hit_events()[0]["snapshot"] == ""


def test_快照是后加的列_老库升上来也能用() -> None:
    """
    老库里 hit_events 没有 snapshot 列。迁移必须是幂等的 ALTER TABLE，
    否则升级后所有命中上报直接抛 "no such column"。
    """
    with db.write() as c:
        cols = {r[1] for r in c.execute("PRAGMA table_info(hit_events)")}
    assert "snapshot" in cols
