"""Excel 读写层：仅依赖 openpyxl，支持 .xlsx / .xlsm。

load_excel(path) -> dict
    {
        "id": str,            # 内部使用的稳定 id（文件名）
        "name": str,          # 展示名（文件名）
        "path": str,          # 绝对路径
        "sheet": str,         # 使用的工作表名
        "columns": [str],     # 表头列名（已去重/补空）
        "data": [dict],       # 每行一个 dict：{列名: 单元格值}
    }
"""
from __future__ import annotations

import os
import openpyxl


def _norm_columns(raw_header):
    """把原始表头规整为列名列表：去空格、空列补 '列N'、重名加后缀。"""
    columns = []
    seen = {}
    for i, h in enumerate(raw_header):
        name = str(h).strip() if h is not None else ""
        if not name:
            name = f"列{i + 1}"
        if name in seen:
            seen[name] += 1
            name = f"{name}_{seen[name]}"
        else:
            seen[name] = 0
        columns.append(name)
    return columns


def load_excel(path: str) -> dict:
    if not os.path.isfile(path):
        raise FileNotFoundError(f"文件不存在：{path}")
    ext = os.path.splitext(path)[1].lower()
    if ext not in (".xlsx", ".xlsm"):
        raise ValueError(
            f"不支持的文件格式：{ext or '无扩展名'}\n请使用 .xlsx / .xlsm（旧版 .xls 请先另存为 .xlsx）"
        )

    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        ws = wb.active
        if ws is None:
            raise ValueError("文件中没有任何工作表")
        sheet_title = ws.title
        rows_iter = ws.iter_rows(values_only=True)
        try:
            raw_header = next(rows_iter)
        except StopIteration:
            raise ValueError("文件为空（没有任何数据行）")
        if raw_header is None or all(c is None for c in raw_header):
            raise ValueError("未能读取到表头（第一行全部为空）")

        columns = _norm_columns(raw_header)
        data = []
        for r in rows_iter:
            if r is None:
                continue
            if all(c is None for c in r):
                continue
            row = {}
            for i, col in enumerate(columns):
                row[col] = r[i] if i < len(r) else None
            data.append(row)
    finally:
        wb.close()

    name = os.path.basename(path)
    return {
        "id": name,
        "name": name,
        "path": os.path.abspath(path),
        "sheet": sheet_title,
        "columns": columns,
        "data": data,
    }
