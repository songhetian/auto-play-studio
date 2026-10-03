"""Excel 对比门面：把「读表 → 智能匹配 → 对比 → 写报告」串成一次任务。

这里是唯一对外入口，调用方（HTTP 路由 / 运行器）不需要知道内部有几个模块。
"""
from __future__ import annotations

from typing import Any

from . import column_match, excel_io
from .compare_core import compare
from .report import write_report


def load_table(path: str) -> dict:
    """读一张表，返回 {id,name,path,sheet,columns,data}。"""
    return excel_io.load_excel(path)


def auto_maps(primary_fields: list[dict], table: dict, existing: dict | None = None, force: bool = True) -> dict:
    """给一张对比表自动匹配列映射：{A 字段名: 该表列名 | None}。"""
    fields = [f["name"] for f in primary_fields]
    return column_match.auto_map(fields, table["columns"], existing=existing, force=force)


def run(
    primary: dict,
    primary_fields: list[dict],
    others: list[dict],
    tolerance: float = 0.0,
) -> dict:
    """执行一次对比，返回报告（header / rows / summary / warnings / cmp_fields）。"""
    return compare(primary, primary_fields, others, tolerance)


def write(out_path: str, report: dict, primary_name: str, tolerance: float) -> str:
    """把报告写成 xlsx，返回文件路径。"""
    return write_report(out_path, report, primary_name, tolerance)


def rows_for_db(report: dict) -> list[dict[str, Any]]:
    """把报告摊平成可入库的行记录，供运行详情页展示明细与统计。"""
    out = []
    for i, r in enumerate(report["rows"], start=1):
        out.append(
            {
                "row_no": i,
                "key_value": r["cells"].get(report["header"][1], "") or "",
                "status": r["status"],
                "message": r.get("note", ""),
                "duration_ms": 0,
            }
        )
    return out
