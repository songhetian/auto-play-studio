"""Seam：对比核心（以 A 表为基准）。

期望值来自一组手算过的样例（前台 / 后台退差对账），不是照实现反推的。
"""
from __future__ import annotations

import pytest

from engine.compare.compare_core import compare

MAPS = {"订单号": "订单号", "退差金额": "退差金额", "客户": "客户"}


def run(a, b, fields, maps=None, tolerance=0.0):
    return compare(a, fields, [{"table": b, "maps": maps or MAPS}], tolerance)


def statuses(report, extra=False):
    """{主键值: 结论} —— A 基准行用 A 的主键，多余行用 B 的主键。"""
    out = {}
    for r in report["rows"]:
        if r["is_extra"] != extra:
            continue
        col = "后台.xlsx·订单号" if extra else "订单号"
        out[r["cells"][col]] = r["status"]
    return out


def test_every_primary_column_is_kept(front_backend, primary_fields):
    a, b = front_backend
    report = run(a, b, primary_fields)

    assert report["header"][0] == "结论"
    assert report["header"][1:4] == ["订单号", "退差金额", "客户"]
    assert "后台.xlsx·状态" in report["header"]


def test_rows_are_classified(front_backend, primary_fields):
    a, b = front_backend
    report = run(a, b, primary_fields)

    assert statuses(report) == {
        "A001": "ok",       # 完全一致
        "A002": "diff",     # 200.5 vs 250.5
        "A003": "ok",       # 完全一致
        "A004": "missing",  # 后台没有这单
        "A006": "error",    # 后台写成“文本”，不是数字
    }


def test_summary_counts(front_backend, primary_fields):
    a, b = front_backend
    report = run(a, b, primary_fields)

    assert report["summary"] == {"ok": 2, "diff": 1, "missing": 1, "extra": 1, "error": 1, "total": 6}


def test_extra_rows_only_exist_in_the_compare_table(front_backend, primary_fields):
    a, b = front_backend
    report = run(a, b, primary_fields)

    assert statuses(report, extra=True) == {"A005": "extra"}
    extra = next(r for r in report["rows"] if r["is_extra"])
    assert extra["cells"]["订单号"] == "", "多余行在 A 侧没有数据"
    assert extra["note"] == "仅在后台.xlsx存在"


def test_missing_row_leaves_compare_cells_blank(front_backend, primary_fields):
    a, b = front_backend
    report = run(a, b, primary_fields)

    row = next(r for r in report["rows"] if r["cells"]["订单号"] == "A004")
    assert row["cells"]["后台.xlsx·状态"] == "缺失"
    assert row["cells"]["后台.xlsx·退差金额"] == ""


def test_tolerance_absorbs_tiny_difference(table_factory, primary_fields):
    a = table_factory("A.xlsx", ["订单号", "退差金额"], [["A001", 100.00]])
    b = table_factory("B.xlsx", ["订单号", "退差金额"], [["A001", 100.005]])

    assert statuses(run(a, b, primary_fields, tolerance=0.01)) == {"A001": "ok"}
    assert statuses(run(a, b, primary_fields, tolerance=0.0)) == {"A001": "diff"}


def test_text_field_ignores_spaces_and_fullwidth(table_factory):
    fields = [
        {"name": "订单号", "role": "key", "type": "text"},
        {"name": "客户", "role": "compare", "type": "text"},
    ]
    a = table_factory("A.xlsx", ["订单号", "客户"], [["A001", "张三"]])
    b = table_factory("B.xlsx", ["订单号", "客户"], [["A001", " 张　三 "]])

    assert statuses(run(a, b, fields)) == {"A001": "ok"}


def test_cross_name_columns_compare_correctly(table_factory, primary_fields):
    """B 表列名不同（订单编号 / 退款差额），靠映射而不是靠列名一致。"""
    a = table_factory("A.xlsx", ["订单号", "退差金额"], [["A001", 100.0]])
    b = table_factory("B.xlsx", ["订单编号", "退款差额"], [["A001", 130.0]])
    maps = {"订单号": "订单编号", "退差金额": "退款差额"}

    report = run(a, b, primary_fields, maps=maps)
    assert statuses(report) == {"A001": "diff"}
    assert report["rows"][0]["cells"]["B.xlsx·退差金额"] == "130"  # 整数值去掉无意义的 .0


def test_key_field_is_required(front_backend):
    a, b = front_backend
    with pytest.raises(ValueError, match="主键"):
        run(a, b, [{"name": "退差金额", "role": "compare", "type": "number"}])


def test_compare_field_is_required(front_backend):
    a, b = front_backend
    with pytest.raises(ValueError, match="对比"):
        run(a, b, [{"name": "订单号", "role": "key", "type": "text"}])


def test_table_with_unmapped_key_is_skipped(front_backend, primary_fields):
    a, b = front_backend
    report = run(a, b, primary_fields, maps={"退差金额": "退差金额"})

    assert any("主键未映射" in w for w in report["warnings"])
    assert all(r["cells"]["后台.xlsx·状态"] == "已跳过" for r in report["rows"] if not r["is_extra"])
    assert report["summary"]["extra"] == 0, "被跳过的表不应再产出多余行"


def test_duplicate_key_is_reported(front_backend, primary_fields):
    a, b = front_backend
    b["data"].append({"订单号": "A001", "退差金额": 111.0, "客户": "张三"})
    report = run(a, b, primary_fields)

    assert any("重复" in w for w in report["warnings"])
