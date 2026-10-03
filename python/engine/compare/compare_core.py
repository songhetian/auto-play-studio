"""对比引擎（v2）：以 A 表(主表)为基准，生成一张合并结果表。

新范式（满足“A 表基准 + 追加各对比表差异列”的需求）：
  * 先确定 A 表参与对比的字段，每个字段标记 角色：主键(用于匹配行) / 对比(用于比对数值或文本)。
  * 再依次上传 B、C… 表，每张表把 A 的字段映射到自己的列（列名可不同，如 A“订单号”↔B“订单”）。
  * 对比后产出一张新表：
      列顺序 = [结论] + A表原有全部列 + (每张对比表: [T·状态] + [T·{对比字段}]…)
      逐行以 A 为基准；不匹配/缺失/多余的对比数据在对应列高亮；
      仅在 B/C 存在、A 没有的行，作为“多余”行追加在末尾。

数据结构（由 UI 维护，引擎只读）：
  primary = {id,name,columns,data,...}                       # A 表
  primary_fields = [ {name, role:'key'|'compare', type:'text'|'number'} ]   # A 的参与字段
  others = [ {table:{...}, maps:{ A字段名: 该表列名|None }} ]   # B/C…

compare(primary, primary_fields, others, tolerance) -> dict
  {
    "header": [列标题...],               # 有序，首列为“结论”
    "rows": [ {cells:{标题:值}, status, cell_status:{标题:状态}, note, is_extra} ],
    "summary": {ok,diff,missing,extra,error,total},
    "warnings": [str],
    "cmp_fields": [A对比字段名...],
  }
"""
from __future__ import annotations

import re
import unicodedata

STATUS_CN = {
    "ok": "一致",
    "diff": "不一致",
    "missing": "缺失",
    "extra": "多余",
    "error": "数据错误",
    "unknown": "—",
}

# 严重程度（用于整行结论取最严重）
_SEVERITY = {"ok": 0, "missing": 1, "extra": 1, "diff": 2, "error": 3, "unknown": 0}


def _to_float(v):
    if v is None:
        return None
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s == "":
        return None
    for ch in ("￥", "¥", "$", ",", " ", "\u00a0", "%"):
        s = s.replace(ch, "")
    try:
        return float(s)
    except ValueError:
        return None


def _norm(v) -> str:
    """匹配主键时用的归一化：全角转半角 + 去掉所有空白。

    Excel 导出的订单号常带前后空格、全角数字或不可见的不间断空格，
    以前只做 strip() 会导致「明明同一单却匹配不上」。
    """
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", str(v)))


def _fmt(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


def _compare_values(pv, sv, ftype: str, tol: float) -> str:
    if ftype == "number":
        pf = _to_float(pv)
        sf = _to_float(sv)
        if pf is None or sf is None:
            return "error"
        return "ok" if abs(pf - sf) <= tol else "diff"
    return "ok" if _norm(pv) == _norm(sv) else "diff"


def _field_type(primary_fields, name):
    for f in primary_fields:
        if f["name"] == name:
            return f.get("type", "text")
    return "text"


def _worst(statuses):
    worst = "ok"
    for s in statuses:
        if s is None:
            continue
        if _SEVERITY.get(s, 0) > _SEVERITY.get(worst, 0):
            worst = s
    return worst


def compare(primary: dict, primary_fields: list, others: list, tolerance: float) -> dict:
    key_fields = [f["name"] for f in primary_fields if f["role"] == "key"]
    cmp_fields = [f["name"] for f in primary_fields if f["role"] == "compare"]
    if not key_fields:
        raise ValueError("请先在 A 表中指定至少一个【主键】字段（用于匹配行，如订单号）")
    if not cmp_fields:
        raise ValueError("请先在 A 表中指定至少一个【对比】字段（用于比对数值/文本，如退差金额）")

    a_cols = list(primary["columns"])

    # 构建各对比表的索引；主键未映射完整的表被跳过并记录告警
    built = []  # (table, maps, index|None)
    warnings = []
    for o in others:
        T = o["table"]
        maps = o.get("maps", {})
        unmapped = [kf for kf in key_fields if not maps.get(kf)]
        if unmapped:
            warnings.append(
                f"【{T['name']}】主键未映射（{', '.join(unmapped)}），已跳过该表对比。"
            )
            built.append((T, maps, None))
            continue
        idx = {}
        for i, row in enumerate(T["data"]):
            k = tuple(_norm(row.get(maps[kf])) for kf in key_fields)
            if all(x == "" for x in k):
                continue
            idx.setdefault(k, []).append((i, row))
        built.append((T, maps, idx))

    # A 表主键集合（用于判定“多余”行）
    pmap_keys = set()
    for prow in primary["data"]:
        k = tuple(_norm(prow.get(kf)) for kf in key_fields)
        if not all(x == "" for x in k):
            pmap_keys.add(k)

    field_order = key_fields + cmp_fields  # 先主键列后对比列，保证多余行也能显示其主键
    header = ["结论"] + a_cols
    for (T, _m, _i) in built:
        header.append(f"{T['name']}·状态")
        for f in field_order:
            header.append(f"{T['name']}·{f}")

    rows = []
    summary = {"ok": 0, "diff": 0, "missing": 0, "extra": 0, "error": 0}

    # ---------- A 基准行 ----------
    for prow in primary["data"]:
        pkey = tuple(_norm(prow.get(kf)) for kf in key_fields)
        pkey_blank = all(x == "" for x in pkey)
        cells = {}
        cells["结论"] = ""
        for col in a_cols:
            cells[col] = _fmt(prow.get(col))
        cell_status = {}
        per_t = []
        notes = []

        for (T, maps, idx) in built:
            if idx is None:
                cells[f"{T['name']}·状态"] = "已跳过"
                for f in cmp_fields:
                    cells[f"{T['name']}·{f}"] = ""
                continue
            if pkey_blank:
                cells[f"{T['name']}·状态"] = "无主键"
                for f in cmp_fields:
                    cells[f"{T['name']}·{f}"] = ""
                per_t.append("unknown")
                continue
            trows = idx.get(pkey)
            if not trows:
                cells[f"{T['name']}·状态"] = "缺失"
                for f in cmp_fields:
                    cells[f"{T['name']}·{f}"] = ""
                per_t.append("missing")
                notes.append(f"{T['name']}缺失")
                continue
            if len(trows) > 1:
                warnings.append(
                    f"【{T['name']}】主键 {pkey} 重复，仅取首行比对，请检查数据源。"
                )
            trow = trows[0][1]
            t_status = "ok"
            # 主键列（展示 B 侧主键值，便于核对）
            for kf in key_fields:
                kcol = maps.get(kf)
                cells[f"{T['name']}·{kf}"] = _fmt(trow.get(kcol) if kcol else None)
            for f in cmp_fields:
                a_val = prow.get(f)
                t_col = maps.get(f)
                t_val = trow.get(t_col) if t_col else None
                st = _compare_values(a_val, t_val, _field_type(primary_fields, f), tolerance)
                cells[f"{T['name']}·{f}"] = _fmt(t_val)
                if st in ("diff", "error"):
                    cell_status[f"{T['name']}·{f}"] = st
                    t_status = "error" if st == "error" else "diff"
            cells[f"{T['name']}·状态"] = STATUS_CN[t_status]
            per_t.append(t_status)

        overall = _worst(per_t) if per_t else "ok"
        cells["结论"] = STATUS_CN[overall]
        rows.append({
            "cells": cells,
            "status": overall,
            "cell_status": cell_status,
            "note": "；".join(notes),
            "is_extra": False,
        })
        summary[overall] = summary.get(overall, 0) + 1

    # ---------- 多余行（仅在某对比表存在，A 没有） ----------
    for (T, maps, idx) in built:
        if idx is None:
            continue
        for k, trows in idx.items():
            if k in pmap_keys:
                continue
            for (_i, trow) in trows:
                cells = {"结论": STATUS_CN["extra"]}
                for col in a_cols:
                    cells[col] = ""
                cell_status = {}
                for (T2, maps2, _i2) in built:
                    if T2["id"] == T["id"]:
                        cells[f"{T['name']}·状态"] = STATUS_CN["extra"]
                        for f in field_order:
                            t_col = maps2.get(f)
                            cells[f"{T['name']}·{f}"] = _fmt(trow.get(t_col) if t_col else None)
                            if f in cmp_fields:
                                cell_status[f"{T['name']}·{f}"] = "extra"
                        cell_status[f"{T['name']}·状态"] = "extra"
                    else:
                        cells[f"{T2['name']}·状态"] = ""
                        for f in cmp_fields:
                            cells[f"{T2['name']}·{f}"] = ""
                rows.append({
                    "cells": cells,
                    "status": "extra",
                    "cell_status": cell_status,
                    "note": f"仅在{T['name']}存在",
                    "is_extra": True,
                })
                summary["extra"] = summary.get("extra", 0) + 1

    summary["total"] = len(rows)
    return {
        "header": header,
        "rows": rows,
        "summary": summary,
        "warnings": warnings,
        "cmp_fields": cmp_fields,
    }
