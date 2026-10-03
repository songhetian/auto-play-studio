"""Seam：方案存取。

配好一组文件后存成方案，下次换同结构的文件一键复用 —— 省掉每次重新选列。
映射按【文件名】匹配，所以文件换了只要名字/结构没变就能直接套用。
"""
from __future__ import annotations

import json

from engine.compare.config_io import apply_config, dump_config, load_config_file, save_config_file


def test_dump_then_load_roundtrip(tmp_path, front_backend, primary_fields):
    a, b = front_backend
    others = [{"table": b, "maps": {"订单号": "订单号", "退差金额": "退差金额"}}]
    path = str(tmp_path / "方案.json")

    save_config_file(path, a, primary_fields, others, 0.05)
    cfg = load_config_file(path)

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


def test_load_config_rejects_foreign_file(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"hello": "world"}), encoding="utf-8")

    import pytest

    with pytest.raises(ValueError, match="格式不正确"):
        load_config_file(str(path))
