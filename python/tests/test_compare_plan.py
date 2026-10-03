"""Seam：Excel 对比的「方案」端点（工单「方案升格」· C4）。

以前「保存方案」把配置写进 `uploads/<iid>/对比方案.json` —— 存完就没人再读它，
实例一删文件也没了。现在方案进全局库：能列出、能载入、删实例不丢。
"""
from __future__ import annotations

import pytest

from engine import db

from .test_compare_api import CMP_DEFAULT, upload


@pytest.fixture(autouse=True)
def _clean_plans():
    with db.write() as c:
        c.execute("DELETE FROM plans")
    yield


def _save_plan(client, iid: str, name="日对账") -> str:
    r = client.post(f"/api/instances/{iid}/compare/plan", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_saving_a_plan_puts_it_in_the_global_library(client, make_instance, xlsx_factory):
    """方案要能被别处查到 —— 藏在实例目录里的文件等于不存在。"""
    a = xlsx_factory(["订单号", "退差金额"], [["A001", 100.0]], name="前台.xlsx")
    iid = make_instance("cmp", CMP_DEFAULT)
    upload(client, iid, "primary", a)

    pid = _save_plan(client, iid, "日对账")

    rows = client.get("/api/plans", params={"tool": "cmp"}).json()
    assert [r["id"] for r in rows] == [pid]
    assert rows[0]["name"] == "日对账"


def test_applying_a_plan_restores_roles_maps_and_tolerance(client, make_instance, xlsx_factory):
    a = xlsx_factory(["订单号", "退差金额"], [["A001", 100.0]], name="前台.xlsx")
    b = xlsx_factory(["订单编号", "退款差额"], [["A001", 250.0]], name="后台.xlsx")
    iid = make_instance("cmp", CMP_DEFAULT)
    upload(client, iid, "primary", a)
    upload(client, iid, "other", b)

    # 配好：订单号当主键、退差金额按数字比、容差 0.05，再手动把列名对不上的映射填好
    cfg = db.get_config(iid)
    cfg["cmp"]["primaryFields"] = [
        {"name": "订单号", "role": "key", "type": "text"},
        {"name": "退差金额", "role": "compare", "type": "number"},
    ]
    cfg["cmp"]["maps"] = {"后台.xlsx": {"订单号": "订单编号", "退差金额": "退款差额"}}
    cfg["cmp"]["tolerance"] = 0.05
    db.save_config(iid, cfg)
    pid = _save_plan(client, iid)

    # 把配置改回一片空白，再从方案载回来
    blank = db.get_config(iid)
    blank["cmp"]["primaryFields"] = [
        {"name": c, "role": "compare", "type": "text"} for c in blank["cmp"]["primaryColumns"]
    ]
    blank["cmp"]["maps"] = {}
    blank["cmp"]["tolerance"] = 0.0
    db.save_config(iid, blank)

    r = client.post(f"/api/instances/{iid}/compare/plan/apply", json={"planId": pid})
    assert r.status_code == 200, r.text

    after = db.get_config(iid)["cmp"]
    by_name = {f["name"]: f for f in after["primaryFields"]}
    assert by_name["订单号"]["role"] == "key", "主键角色要被还原"
    assert by_name["退差金额"]["type"] == "number", "字段类型要被还原"
    assert after["maps"]["后台.xlsx"] == {"订单号": "订单编号", "退差金额": "退款差额"}
    assert after["tolerance"] == 0.05


def test_applying_an_unknown_plan_is_a_404(client, make_instance):
    iid = make_instance("cmp", CMP_DEFAULT)

    r = client.post(f"/api/instances/{iid}/compare/plan/apply", json={"planId": "no-such-plan"})

    assert r.status_code == 404


def test_the_plan_outlives_the_instance(client, make_instance, xlsx_factory):
    """方案是资产，不该跟着实例一起消失 —— 这是把它提到全局的全部理由。"""
    a = xlsx_factory(["订单号"], [["A001"]], name="前台.xlsx")
    iid = make_instance("cmp", CMP_DEFAULT)
    upload(client, iid, "primary", a)
    pid = _save_plan(client, iid)

    assert client.delete(f"/api/instances/{iid}").status_code == 200

    assert [r["id"] for r in client.get("/api/plans").json()] == [pid]


def test_applying_does_nothing_when_the_primary_table_is_a_different_one(client, make_instance, xlsx_factory):
    """方案按【主表名】匹配：换了另一张主表还硬套，容差这类业务口径就张冠李戴了。"""
    a = xlsx_factory(["订单号", "退差金额"], [["A001", 100.0]], name="前台.xlsx")
    iid = make_instance("cmp", CMP_DEFAULT)
    upload(client, iid, "primary", a)
    cfg = db.get_config(iid)
    cfg["cmp"]["tolerance"] = 0.05
    db.save_config(iid, cfg)
    pid = _save_plan(client, iid)

    other = xlsx_factory(["订单号", "退差金额"], [["A001", 100.0]], name="另一张表.xlsx")
    upload(client, iid, "primary", other)
    db.save_config(iid, {**db.get_config(iid), "cmp": {**db.get_config(iid)["cmp"], "tolerance": 0.0}})

    assert client.post(f"/api/instances/{iid}/compare/plan/apply", json={"planId": pid}).status_code == 200

    assert db.get_config(iid)["cmp"]["tolerance"] == 0.0
