"""Seam：新建实例时套用方案（工单「方案升格」· C3）。

方案与实例唯一的接触点就在这里：把方案里的配置**拷一份**给新实例，之后互不影响。
"""
from __future__ import annotations

import pytest

from engine import db


@pytest.fixture(autouse=True)
def _clean_plans():
    with db.write() as c:
        c.execute("DELETE FROM plans")
    yield


def _plan(client, tool="cmp", name="日对账", config=None):
    r = client.post("/api/plans", json={"tool": tool, "name": name, "config": config or {}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _count_instances() -> int:
    return db.query("SELECT COUNT(*) AS n FROM instances")[0]["n"]


def _config_of(client, iid: str) -> dict:
    """引擎没有单实例读配置的端点，从列表里取那一条。"""
    rows = client.get("/api/instances").json()
    return next(r for r in rows if r["id"] == iid)["config"]


def test_a_new_instance_starts_with_the_plan_config(client):
    pid = _plan(client, config={"cmp": {"tolerance": 0.25}})

    iid = client.post("/api/instances", json={"name": "今日对账", "tool": "cmp", "planId": pid}).json()["id"]

    assert _config_of(client, iid)["cmp"]["tolerance"] == 0.25


def test_a_partial_plan_still_leaves_a_complete_config(client):
    """方案可以只写关心的那几项（比如只存容差），剩下的必须由默认值补齐。

    少了这一步，套出来的实例配置会缺字段 —— 前端读到 undefined 就炸。
    """
    pid = _plan(client, config={"cmp": {"tolerance": 0.01}})

    iid = client.post("/api/instances", json={"name": "今日对账", "tool": "cmp", "planId": pid}).json()["id"]
    cfg = _config_of(client, iid)

    assert cfg["cmp"]["tolerance"] == 0.01          # 方案里的
    assert cfg["cmp"]["primaryFile"] == ""          # 默认里的
    assert cfg["hotkeys"]["run"] == "F8"            # 默认里的（嵌套一层也要补到）


def test_an_unknown_plan_creates_nothing(client):
    before = _count_instances()

    r = client.post("/api/instances", json={"name": "今日对账", "tool": "cmp", "planId": "no-such-plan"})

    assert r.status_code == 404
    assert _count_instances() == before


def test_a_plan_cannot_be_applied_to_another_tool(client):
    """cmp 的字段映射套到 rpa 实例上没有意义，只会写进一堆没人对得上的字段。"""
    pid = _plan(client, tool="cmp", config={"cmp": {"tolerance": 0.25}})
    before = _count_instances()

    r = client.post("/api/instances", json={"name": "脚本实例", "tool": "rpa", "planId": pid})

    assert r.status_code == 400
    assert _count_instances() == before


def test_without_a_plan_the_instance_gets_the_defaults(client):
    iid = client.post("/api/instances", json={"name": "空白实例", "tool": "cmp"}).json()["id"]

    assert _config_of(client, iid)["cmp"]["tolerance"] == 0.0
