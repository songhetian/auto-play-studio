"""Seam：方案（列映射模板）的存取格式。

配好一组文件后存成方案，下次换同结构的文件一键复用 —— 省掉每次重新选列。
映射按【文件名】匹配，所以文件换了只要名字/结构没变就能直接套用。
"""
from __future__ import annotations

from engine.compare.config_io import apply_config, dump_config


def test_dump_config_keeps_everything_the_plan_needs(front_backend, primary_fields):
    a, b = front_backend
    others = [{"table": b, "maps": {"订单号": "订单号", "退差金额": "退差金额"}}]

    cfg = dump_config(a, primary_fields, others, 0.05)

    assert cfg["version"] == 2
    assert cfg["primary"] == "前台.xlsx"
    assert cfg["tolerance"] == 0.05
    assert cfg["primary_fields"] == primary_fields
    assert cfg["others"][0]["name"] == "后台.xlsx"


def test_apply_config_restores_roles_and_maps(front_backend, primary_fields):
    a, b = front_backend
    others = [{"table": b, "maps": {"订单号": "订单号", "退差金额": "退差金额"}}]
    cfg = dump_config(a, primary_fields, others, 0.05)

    blank_fields = [{"name": c, "role": "compare", "type": "text"} for c in a["columns"]]
    new_fields, new_others, tol = apply_config(
        cfg, a, blank_fields, [{"table": b, "maps": {}}], 0.0
    )

    by_name = {f["name"]: f for f in new_fields}
    assert by_name["订单号"]["role"] == "key", "主键角色要被还原"
    assert by_name["退差金额"]["type"] == "number", "字段类型要被还原"
    assert tol == 0.05
    assert new_others[0]["maps"]["订单号"] == "订单号"


def test_apply_config_keeps_only_columns_that_exist(table_factory, primary_fields):
    """方案里记的列名在当前文件里没有时，不该硬塞一个不存在的列。"""
    a = table_factory("A.xlsx", ["订单号", "金额"], [["A1", 1]])
    b = table_factory("B.xlsx", ["订单号", "金额"], [["A1", 1]])
    cfg = {
        "version": 2,
        "primary": "A.xlsx",
        "tolerance": 0.0,
        "primary_fields": [{"name": "订单号", "role": "key", "type": "text"}],
        "others": [{"name": "B.xlsx", "maps": {"订单号": "订单号", "退差金额": "退差金额"}}],
    }
    fields = [{"name": "订单号", "role": "key", "type": "text"}]

    _nf, others, _tol = apply_config(cfg, a, fields, [{"table": b, "maps": {}}], 0.0)

    assert others[0]["maps"] == {"订单号": "订单号"}


def test_apply_config_does_nothing_when_primary_name_differs(front_backend, primary_fields):
    a, b = front_backend
    cfg = dump_config(a, primary_fields, [], 0.05)
    cfg["primary"] = "另一张表.xlsx"

    new_fields, _others, tol = apply_config(cfg, a, primary_fields, [], 0.0)

    assert new_fields == primary_fields, "主表对不上时应原样保留"
    assert tol == 0.0


def test_unknown_table_keeps_blank_maps(table_factory):
    a = table_factory("A.xlsx", ["订单号"], [["A1"]])
    b = table_factory("B.xlsx", ["订单号"], [["A1"]])
    fields = [{"name": "订单号", "role": "key", "type": "text"}]
    cfg = {"version": 2, "primary": "A.xlsx", "tolerance": 0.0, "primary_fields": fields, "others": []}

    _nf, others, _tol = apply_config(cfg, a, fields, [{"table": b, "maps": {}}], 0.0)

    assert others[0]["maps"] == {"订单号": None}
