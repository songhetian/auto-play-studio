"""Seam：方案（配置模板）的 HTTP 端点。

方案的存储层在 test_plans.py 验，这里只验「界面能拿到的东西」：
列表能不能筛工具、读不到要不要说 404、改名会不会顺手把配置冲掉。
"""
from __future__ import annotations

import pytest

from engine import db


@pytest.fixture(autouse=True)
def _clean_plans():
    with db.write() as c:
        c.execute("DELETE FROM plans")
    yield


def _make(client, tool="cmp", name="日对账", config=None):
    r = client.post("/api/plans", json={"tool": tool, "name": name, "config": config or {"cmp": {"tolerance": 0.5}}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_created_plan_is_readable_from_the_endpoint(client):
    pid = _make(client)

    p = client.get(f"/api/plans/{pid}").json()
    assert p["name"] == "日对账"
    assert p["tool"] == "cmp"
    assert p["config"]["cmp"]["tolerance"] == 0.5


def test_list_can_be_filtered_to_one_tool(client):
    _make(client, tool="rpa", name="脚本方案")
    cmp_id = _make(client, tool="cmp", name="对比方案")

    rows = client.get("/api/plans", params={"tool": "cmp"}).json()
    assert [r["id"] for r in rows] == [cmp_id]


def test_reading_an_unknown_plan_is_a_404(client):
    r = client.get("/api/plans/no-such-plan")
    assert r.status_code == 404


def test_renaming_does_not_touch_the_config(client):
    pid = _make(client)

    assert client.patch(f"/api/plans/{pid}", json={"name": "新名"}).status_code == 200

    p = client.get(f"/api/plans/{pid}").json()
    assert p["name"] == "新名"
    assert p["config"]["cmp"]["tolerance"] == 0.5


def test_deleting_twice_says_404_the_second_time(client):
    pid = _make(client)

    assert client.delete(f"/api/plans/{pid}").status_code == 200
    assert client.get("/api/plans").json() == []
    assert client.delete(f"/api/plans/{pid}").status_code == 404


def test_a_plan_must_belong_to_a_real_tool(client):
    """方案挂在工具上，工具号不存在的新建实例时无从选 —— 当场拦掉，别存进库里变垃圾。"""
    r = client.post("/api/plans", json={"tool": "nope", "name": "幽灵方案", "config": {}})
    assert r.status_code == 400
