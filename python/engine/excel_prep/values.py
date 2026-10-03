"""单元格值的归一化与判定（纯函数，不碰文件）。

Excel 里的「看起来一样」和 Python 的 `==` 不是一回事：从后台导出或从网页复制的表
普遍带首尾空白、全角空格、不换行空格。有时两个单号肉眼一模一样，实际是两个键。

这里给出**唯一一套**「为空」「相等」的判定，体检与整理共用 ——
两处各写一套的话，体检说「第 5 行重复」、整理却删掉第 7 行，用户再也没法核对。
"""
from __future__ import annotations

from typing import Any, Iterable


def normalize_text(value: Any) -> Any:
    """字符串去掉两端空白；其它类型原样返回。

    `str.strip()` 按 Unicode 判定空白，所以全角空格（U+3000）和不换行空格（U+00A0）
    都会被去掉 —— 这两样正是复制粘贴最常见的污染。

    非字符串（数字、日期、None）**原样返回**：把日期转成字符串再写回去，
    openpyxl 会把它当文本落盘，本来是「越修越坏」。
    """
    return value.strip() if isinstance(value, str) else value


def is_blank(value: Any) -> bool:
    """空 = None，或去掉两端空白后长度为 0 的字符串。

    0、False、「无」都**不算空**：把有值的行当空行删掉，等于删掉一整行真实数据。
    """
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip() == ""
    return False


def cell_text(value: Any) -> str:
    """比较与展示用的稳定文本。None 与空串在这里归一成同一个东西。"""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    return str(value).strip()


def row_signature(values: Iterable[Any]) -> tuple[str, ...]:
    """整行的比较签名：逐格取 `cell_text`。

    只差首尾空白的两个行算同一行 —— 同一处数据带不带空格，不构成「两行不同的数据」。
    """
    return tuple(cell_text(v) for v in values)
