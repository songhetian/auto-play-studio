"""Excel 工具箱的核心算法（纯函数，不碰文件）。

**列是用户动态给的，不是写死的两列。** 所以下面每个函数都把「用哪些列」
当参数接，而不是假设第 1 列是键、第 2 列是值 —— 这是这套工具与
"两列合并"最大的区别，也是最容易写死的地方。

列名支持两种写法：字符串（沿用来源表列名），或 {"from": ..., "to": ...}（改列名）。
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping, Sequence

Row = dict[str, Any]

# 分隔符用竖线：订单号、手机号这类值里几乎不会出现，
# 即便出现也只是"两行被误判成同一行"，不会像空串那样到处误合并。
_SEP = "|"


def _text(v: Any) -> str:
    """把单元格值统一成文本。

    数字统一按整数形态输出：Excel 里 1 读出来可能是 1.0，
    不归一化会让「1」和「1.0」变成两个不同的键，去重和合并都会漏。
    """
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    if isinstance(v, str):
        return v.strip()
    return str(v).strip()


def _columns(spec: Iterable[str | Mapping[str, str]]) -> list[tuple[str, str | None]]:
    """把列配置统一成 (来源名, 目标名|None) 列表。"""
    out: list[tuple[str, str | None]] = []
    for c in spec:
        if isinstance(c, Mapping):
            src = str(c.get("from") or "").strip()
            dst = str(c.get("to") or "").strip() or src
            if src:
                out.append((src, dst))
        else:
            name = str(c).strip()
            if name:
                out.append((name, None))
    return out


def build_key(row: Mapping[str, Any], keys: Sequence[str], *, ordered: bool = False) -> str:
    """按若干列拼出匹配键。

    - **默认按键名排序**再拼，使键的**顺序不影响结果**（去重场景：
      「订单号+买家」和「买家+订单号」不该把同一行算成两行）。
    - ``ordered=True`` 时按**传入顺序**拼接 —— 合并两张表时，主表键与来源表键
      是一一对应但**列名不同**的（订单号↔单号、买家↔客户），必须按位置配对；
      若也按键名排序，「张…SO1」与「SO1…张」会错开，一行都匹配不上。
    - 缺列按空串占位，不抛异常：表里少一列不该让整个工具挂掉。
    """
    pairs = [(k, _text(row.get(k))) for k in keys]
    if not ordered:
        pairs.sort(key=lambda kv: kv[0])
    return _SEP.join(v for _, v in pairs)


def merge_combine(
    main_rows: Sequence[Row],
    src_rows: Sequence[Row],
    main_keys: Sequence[str],
    src_keys: Sequence[str],
    fill_columns: Sequence[str | Mapping[str, str]],
) -> list[Row]:
    """按（可多列）键把来源表的列补到主表上。

    匹配不上的行**原样保留且不补任何列** —— 丢掉行比补不上严重得多。
    来源表同键多行时取最后一条（不报错），与"后写入覆盖"的直觉一致。
    """
    cols = _columns(fill_columns)
    if not main_rows:
        return []

    index: dict[str, Row] = {}
    for r in src_rows:
        # ordered：主表键与来源表键列名不同，必须按位置配对，不能按键名排序
        index[build_key(r, src_keys, ordered=True)] = r

    main_key_list = list(main_keys)
    out: list[Row] = []
    for row in main_rows:
        merged = dict(row)
        hit = index.get(build_key(row, main_key_list, ordered=True))
        if hit is not None:
            for src_name, dst in cols:
                if src_name in hit:
                    merged[dst or src_name] = hit[src_name]
        out.append(merged)
    return out


def select_columns(rows: Sequence[Row], columns: Sequence[str]) -> list[Row]:
    """按勾选的列生成新表（"根据选择的生成新表格"）。

    列序 = 勾选顺序。缺列补空串而不是丢行。
    一列都不勾时返回 `[{}]` 而不是 `[]`：要保住表头，
    否则下载下来的 xlsx 是空的、Excel 打开会报错。
    """
    cols = [c for c in columns if c and c.strip()]
    return [{c: r.get(c, "") for c in cols} for r in rows]


def dedupe_rows(rows: Sequence[Row], keys: Sequence[str]) -> tuple[list[Row], int]:
    """按业务键去重，保留第一条。返回 (结果, 去掉的条数)。

    不给键就按整行内容去重。键的顺序不影响判定。
    """
    seen: set[str] = set()
    out: list[Row] = []
    removed = 0
    use_keys = list(keys) if keys else sorted({k for r in rows for k in r})
    for r in rows:
        if use_keys:
            k = build_key(r, use_keys)
        else:
            k = _SEP.join(f"{kk}={_text(r.get(kk))}" for kk in sorted(r))
        if k in seen:
            removed += 1
            continue
        seen.add(k)
        out.append(r)
    return out, removed


def filter_rows(rows: Sequence[Row], column: str, value: str) -> list[Row]:
    """等值筛选。空条件返回全部 —— "没填筛选条件"不等于"筛出空表"。"""
    if not column or value == "":
        return list(rows)
    return [r for r in rows if _text(r.get(column)) == _text(value)]


def split_by_column(rows: Sequence[Row], column: str) -> dict[str, list[Row]]:
    """按某列的值拆成多组（每组一个文件）。

    空值归到 `空` 这一组，不能丢行。
    """
    parts: dict[str, list[Row]] = {}
    for r in rows:
        k = _text(r.get(column)) or "空"
        parts.setdefault(k, []).append(r)
    return parts
