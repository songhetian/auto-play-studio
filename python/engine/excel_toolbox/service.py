"""Excel 工具箱的文件层：读表、算、写出新文件。

两条贯穿全文件的规矩：
  1. **原文件只读**，产出永远是 `xxx_工具名.xlsx`（或 csv）的新文件，落在原表同目录。
     批处理工具覆盖原表是不可逆的，这个工具箱不该给这个选项。
  2. **列由用户动态指定**。所有涉及列的地方都从参数拿，不写死第 1/2 列 ——
     "订单号+买家+手机号"这种三键对齐是客服的真实需求。
"""
from __future__ import annotations

import csv
import os
from typing import Any, Sequence

from openpyxl import Workbook, load_workbook

from . import core
from .core import Row

# 产出文件名的后缀：一眼看得出是哪个工具生成的
SUFFIX = {
    "merge": "已合并",
    "generate": "已生成",
    "dedupe": "已去重",
    "filter": "已筛选",
    "problem": "问题行",
    "convert": "",
    "split": "",
}


class Unreadable(ValueError):
    """文件在但读不出来（不是 xlsx、已损坏、被 Excel 独占）。"""


# ── 读 ──────────────────────────────────────────────────────────


def read_table(path: str) -> tuple[list[str], list[Row]]:
    """读首个工作表：返回 (列名, 数据行)。

    和 `excel.read_rows` 的区别：这里**不跳过空主键行** ——
    工具箱要做的是"表里有什么就处理什么"，让用户自己决定丢不丢。

    csv 走 `read_csv`：界面每个面板都标注「xlsx / csv」，只有这条入口不认，
    用户按提示传 csv 会被 400 打断（columns_of / convert 早就支持 csv 了）。
    """
    if path.lower().endswith(".csv"):
        return read_csv(path)
    if not os.path.isfile(path):
        raise LookupError(f"文件不存在：{path}")
    if not path.lower().endswith((".xlsx", ".xlsm")):
        raise Unreadable(f"只支持 xlsx/xlsm/csv，收到：{os.path.basename(path)}")
    try:
        wb = load_workbook(path, read_only=True, data_only=True)
    except Exception as exc:  # 损坏 / 被独占
        raise Unreadable(f"打不开（可能已被 Excel 独占或文件损坏）：{exc}") from exc
    try:
        ws = wb[wb.sheetnames[0]]
        it = ws.iter_rows(values_only=True)
        first = next(it, ())
        headers = [str(h).strip() if h is not None else "" for h in first]
        rows: list[Row] = []
        for raw in it:
            if raw is None or all(v is None or str(v).strip() == "" for v in raw):
                continue  # 全空行跳过（Excel 里尾随空行很常见）
            rows.append({headers[i]: raw[i] for i in range(min(len(headers), len(raw)))})
        return [h for h in headers if h], rows
    finally:
        wb.close()


def read_csv(path: str) -> tuple[list[str], list[Row]]:
    """读 csv。编码先试 utf-8-sig（Excel 导出的中文 csv 多半带 BOM），再退回 gbk。"""
    if not os.path.isfile(path):
        raise LookupError(f"文件不存在：{path}")
    last: Exception | None = None
    for enc in ("utf-8-sig", "gbk", "utf-8"):
        try:
            with open(path, newline="", encoding=enc) as f:
                reader = csv.DictReader(f)
                headers = [h.strip() for h in (reader.fieldnames or []) if h]
                rows = [
                    {(k.strip() if k else ""): v for k, v in r.items()}
                    for r in reader
                    if any((v or "").strip() for v in r.values())
                ]
                return headers, rows
        except UnicodeDecodeError as exc:
            last = exc
            continue
    raise Unreadable(f"读不出编码，尝试过 utf-8/gbk：{last}")


def columns_of(path: str) -> list[str]:
    """只要列名（页面渲染下拉选项用，不必把整表读进来）。"""
    head, _ = (read_csv(path) if path.lower().endswith(".csv") else read_table(path))
    return head


def count_rows(path: str) -> int:
    _, rows = (read_csv(path) if path.lower().endswith(".csv") else read_table(path))
    return len(rows)


# ── 写 ──────────────────────────────────────────────────────────


def out_path(src: str, kind: str, ext: str = ".xlsx", suffix_text: str = "") -> str:
    """产出路径：原表同目录 + 原名 + 后缀。同名已存在就加序号，绝不覆盖原表。"""
    folder = os.path.dirname(os.path.abspath(src))
    stem = os.path.splitext(os.path.basename(src))[0]
    tail = suffix_text or SUFFIX.get(kind, "")
    base = f"{stem}_{tail}" if tail else f"{stem}_新"
    ext = ext if ext.startswith(".") else f".{ext}"
    candidate = os.path.join(folder, base + ext)
    i = 1
    while os.path.exists(candidate):
        candidate = os.path.join(folder, f"{base}({i}){ext}")
        i += 1
    return candidate


def _cell(v: Any) -> Any:
    """写出去前的单元格归一。

    xlsx 分不出「空串」和「空单元格」—— 写 "" 读回来是 None，页面上会显示成
    `null` / `undefined`。这里统一成空串，读回来还是空，符合直觉。
    """
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def write_xlsx(path: str, headers: Sequence[str], rows: Sequence[Row]) -> str:
    wb = Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    ws.append(list(headers))
    for r in rows:
        ws.append([_cell(r.get(h, "")) for h in headers])
    wb.save(path)
    return path


def write_csv(path: str, headers: Sequence[str], rows: Sequence[Row]) -> str:
    # utf-8-sig：Excel 打开不乱码（用户直接双击看结果，这是最常见的用法）
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(list(headers))
        for r in rows:
            w.writerow([_cell(r.get(h, "")) for h in headers])
    return path


def _check_cols(headers: Sequence[str], cols: Sequence[str], which: str) -> None:
    """列不存在就报 400 并点名是哪一列。静默产出空表是最糟的失败方式。"""
    bad = [c for c in cols if c not in headers]
    if bad:
        raise ValueError(f"{which}里没有这些列：{'、'.join(bad)}。可用列：{list(headers)}")


# ── 各工具 ──────────────────────────────────────────────────────


def merge(
    main_path: str,
    src_path: str,
    main_keys: Sequence[str],
    src_keys: Sequence[str],
    fill_columns: Sequence[Any],
) -> dict[str, Any]:
    """按（多列）键把来源表的列补到主表上，产出新表。"""
    main_h, main_rows = read_table(main_path)
    src_h, src_rows = read_table(src_path)
    _check_cols(main_h, main_keys, "主表")
    _check_cols(src_h, src_keys, "来源表")
    for c in fill_columns:
        name = c.get("from") if isinstance(c, dict) else c
        if name and name not in src_h:
            raise ValueError(f"来源表里没有列「{name}」。可用列：{src_h}")

    merged = core.merge_combine(main_rows, src_rows, main_keys, src_keys, fill_columns)

    # 新列名 = 原列 + 追加的补全列，顺序按用户勾选
    extra: list[str] = []
    for c in fill_columns:
        name = (c.get("from") if isinstance(c, dict) else c) or ""
        dst = (c.get("to") if isinstance(c, dict) else "") or name
        if name and dst not in extra:
            extra.append(dst)
    headers = list(main_h) + [h for h in extra if h not in main_h]

    path = write_xlsx(out_path(main_path, "merge"), headers, merged)
    matched = sum(1 for m, r in zip(merged, main_rows) if m != r)
    return {"path": path, "rowCount": len(merged), "matchedCount": matched, "columns": headers}


def generate(path: str, columns: Sequence[str]) -> dict[str, Any]:
    """按勾选的列生成新表（列序 = 勾选顺序）。"""
    headers, rows = read_table(path)
    _check_cols(headers, columns, "这张表")
    picked = core.select_columns(rows, columns)
    out = write_xlsx(out_path(path, "generate"), columns, picked)
    return {"path": out, "rowCount": len(picked), "columns": list(columns)}


def dedupe(path: str, keys: Sequence[str]) -> dict[str, Any]:
    headers, rows = read_table(path)
    _check_cols(headers, keys, "这张表")
    kept, removed = core.dedupe_rows(rows, keys)
    out = write_xlsx(out_path(path, "dedupe"), headers, kept)
    return {"path": out, "rowCount": len(kept), "removedCount": removed, "columns": list(headers)}


def convert(path: str, target: str) -> dict[str, Any]:
    """格式互转。目标只支持 xlsx / csv。"""
    t = (target or "").lower().lstrip(".")
    if t not in ("xlsx", "csv"):
        raise ValueError("目标格式只支持 xlsx 或 csv")
    headers, rows = (read_csv(path) if path.lower().endswith(".csv") else read_table(path))
    if t == "csv":
        out = write_csv(out_path(path, "convert", ".csv"), headers, rows)
    else:
        out = write_xlsx(out_path(path, "convert", ".xlsx"), headers, rows)
    return {"path": out, "rowCount": len(rows), "format": t}


def split(path: str, column: str) -> dict[str, Any]:
    """按某列的值拆成多个文件。"""
    headers, rows = read_table(path)
    _check_cols(headers, [column], "这张表")
    parts = core.split_by_column(rows, column)
    files: list[dict[str, Any]] = []
    folder = os.path.dirname(os.path.abspath(path))
    stem = os.path.splitext(os.path.basename(path))[0]
    for value, rs in sorted(parts.items()):
        safe = str(value).replace("/", "_").replace("\\", "_")[:40] or "空"
        p = os.path.join(folder, f"{stem}_{safe}.xlsx")
        i = 1
        while os.path.exists(p):
            p = os.path.join(folder, f"{stem}_{safe}({i}).xlsx")
            i += 1
        write_xlsx(p, headers, rs)
        files.append({"value": value, "path": p, "rowCount": len(rs)})
    return {"files": files, "count": len(files)}


def filter_export(path: str, column: str, value: str) -> dict[str, Any]:
    headers, rows = read_table(path)
    if column:
        _check_cols(headers, [column], "这张表")
    kept = core.filter_rows(rows, column, value)
    out = write_xlsx(out_path(path, "filter"), headers, kept)
    return {"path": out, "rowCount": len(kept), "columns": list(headers)}


def problem_rows(path: str, key_column: str = "") -> dict[str, Any]:
    """导出行号 + 问题原因，方便直接回原表改。

    判定：主键列空、行内整行空、同一主键重复。带 Excel 真实行号（从 2 起）。
    """
    headers, rows = read_table(path)
    if key_column and key_column not in headers:
        raise ValueError(f"这张表里没有列「{key_column}」。可用列：{headers}")

    seen: dict[str, int] = {}
    out: list[Row] = []
    for i, r in enumerate(rows, start=2):
        reasons: list[str] = []
        if key_column:
            k = r.get(key_column)
            if k is None or str(k).strip() == "":
                reasons.append(f"主键「{key_column}」为空")
            else:
                key = str(k).strip()
                if key in seen:
                    reasons.append(f"主键重复（第 {seen[key]} 行已出现）")
                else:
                    seen[key] = i
        if all(v is None or str(v).strip() == "" for v in r.values()):
            reasons.append("整行为空")
        if reasons:
            out.append({"行号": i, "问题": "；".join(reasons), **{h: r.get(h, "") for h in headers}})

    out_headers = ["行号", "问题"] + [h for h in headers if h not in ("行号", "问题")]
    dest = out_path(path, "problem")
    write_xlsx(dest, out_headers, out)
    return {"path": dest, "rowCount": len(out), "columns": out_headers}
