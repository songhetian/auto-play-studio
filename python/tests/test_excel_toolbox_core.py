"""Excel 工具箱：纯函数层的测试。

先测「列映射 / 合并键」这些**不碰文件**的逻辑，因为列是用户动态加的
（不是固定两列），这里是错得最多的地方。文件读写在 test_excel_toolbox_api.py 覆盖。
"""
from __future__ import annotations

import pytest

from engine.excel_toolbox.core import (
    build_key,
    merge_combine,
    split_by_column,
    select_columns,
    dedupe_rows,
    filter_rows,
)


HEADERS = ["订单号", "买家", "金额"]


class TestBuildKey:
    def test_单键取该列值(self):
        assert build_key({"订单号": "SO1", "买家": "张"}, ["订单号"]) == "SO1"

    def test_多键按给定顺序拼接_与顺序无关(self):
        # 「订单号+买家」和「买家+订单号」应该等价，否则同一个键会算成两行
        a = build_key({"订单号": "SO1", "买家": "张"}, ["订单号", "买家"])
        b = build_key({"订单号": "SO1", "买家": "张"}, ["买家", "订单号"])
        assert a == b

    def test_缺列按空串占位_不会崩(self):
        # 键列在表里不存在时不能抛异常，否则整个工具直接挂掉；
        # 缺哪一列都算同一个"空值"，不该因为缺列位置不同算出不同的键
        assert build_key({"订单号": "SO1"}, ["订单号", "缺失"]) == build_key({"订单号": "SO1"}, ["缺失", "订单号"])

    def test_数值归一化_避免整数读成浮点算成两个键(self):
        # Excel 读数字可能是 1.0，字符串 "1" 和 1.0 应该算出同一个键
        assert build_key({"订单号": 1}, ["订单号"]) == build_key({"订单号": "1"}, ["订单号"])


class TestMergeCombine:
    def test_按多列匹配补全_而不是只认第一列(self):
        # 这是「不是固定两列」的核心：两列一起才能唯一定位一行
        main = [
            {"订单号": "SO1", "买家": "张", "金额": 10},
            {"订单号": "SO2", "买家": "李", "金额": 20},
        ]
        src = [
            {"订单": "SO1", "客户": "张", "物流状态": "已签收"},
            {"订单": "SO2", "客户": "李", "物流状态": "运输中"},
        ]
        out = merge_combine(
            main, src,
            main_keys=["订单号", "买家"], src_keys=["订单", "客户"],
            fill_columns=["物流状态"],
        )
        assert [r["物流状态"] for r in out] == ["已签收", "运输中"]

    def test_补全字段可重命名_不必沿用来源表列名(self):
        out = merge_combine(
            [{"订单号": "SO1"}], [{"订单": "SO1", "快递单": "SF1"}],
            main_keys=["订单号"], src_keys=["订单"],
            fill_columns=[{"from": "快递单", "to": "快递单号"}],
        )
        assert out[0]["快递单号"] == "SF1"

    def test_没有匹配上的行原样保留_并标出没补上(self):
        out = merge_combine(
            [{"订单号": "SO9"}], [{"订单": "SO1", "物流状态": "已签收"}],
            main_keys=["订单号"], src_keys=["订单"], fill_columns=["物流状态"],
        )
        assert out[0]["订单号"] == "SO9"
        assert "物流状态" not in out[0]

    def test_不写死列数_传一列也能跑(self):
        out = merge_combine(
            [{"订单号": "SO1"}], [{"订单": "SO1", "备注": "加急"}],
            main_keys=["订单号"], src_keys=["订单"], fill_columns=["备注"],
        )
        assert out[0]["备注"] == "加急"

    def test_来源表同键多行_取最后一条不报错(self):
        out = merge_combine(
            [{"订单号": "SO1"}],
            [{"订单": "SO1", "状态": "待发"}, {"订单": "SO1", "状态": "已发"}],
            main_keys=["订单号"], src_keys=["订单"], fill_columns=["状态"],
        )
        assert out[0]["状态"] in ("待发", "已发")

    def test_空主表返回空表(self):
        assert merge_combine([], [], ["订单号"], ["订单"], ["状态"]) == []


class TestSelectColumns:
    def test_按勾选顺序生成新表(self):
        # 「根据选择的生成新表格」：列序由勾选顺序决定，不按原表顺序
        rows = [{"a": 1, "b": 2, "c": 3}]
        assert select_columns(rows, ["c", "a"]) == [{"c": 3, "a": 1}]

    def test_缺列补空值_而不是丢行(self):
        out = select_columns([{"a": 1}], ["a", "不存在"])
        assert out == [{"a": 1, "不存在": ""}]

    def test_没勾任何列时返回空行_而不是空表(self):
        # 表头要保留，否则下载下来的 xlsx 打不开
        assert select_columns([{"a": 1}], []) == [{}]


class TestDedupe:
    def test_按业务键去重_保留第一条(self):
        rows = [{"k": "A", "n": 1}, {"k": "A", "n": 2}, {"k": "B", "n": 3}]
        out, removed = dedupe_rows(rows, ["k"])
        assert [r["n"] for r in out] == [1, 3]
        assert removed == 1

    def test_不指定键时按整行去重(self):
        rows = [{"k": "A"}, {"k": "A"}, {"k": "B"}]
        out, removed = dedupe_rows(rows, [])
        assert len(out) == 2
        assert removed == 1


class TestFilterAndSplit:
    def test_等值筛选(self):
        rows = [{"s": "已签收"}, {"s": "运输中"}]
        assert filter_rows(rows, "s", "已签收") == [{"s": "已签收"}]

    def test_空条件返回全部(self):
        rows = [{"s": "已签收"}]
        assert filter_rows(rows, "s", "") == rows

    def test_按列拆分_每个值一个文件(self):
        rows = [{"c": "A", "v": 1}, {"c": "B", "v": 2}, {"c": "A", "v": 3}]
        parts = split_by_column(rows, "c")
        assert sorted(parts) == ["A", "B"]
        assert len(parts["A"]) == 2

    def test_空值归到空这一组_不丢行(self):
        parts = split_by_column([{"c": ""}, {"c": "A"}], "c")
        assert sum(len(v) for v in parts.values()) == 2

    def test_空表拆分不报错(self):
        assert split_by_column([], "c") == {}

    def test_多列键_两表列名不同也按位置配对(self):
        """键按列名排序是错的：两表的键列名不同，排序后相对顺序会错开。

        「订单号+买家」与「单号+客户」是同一组键的两种叫法，
        按列名排序会得到「张…SO1」和「SO1…张」两个不同的键 —— 一行都匹配不上。
        """
        out = merge_combine(
            [{"订单号": "SO1", "买家": "张"}],
            [{"单号": "SO1", "客户": "张", "状态": "已签收"}],
            main_keys=["订单号", "买家"], src_keys=["单号", "客户"], fill_columns=["状态"],
        )
        assert out[0]["状态"] == "已签收"
