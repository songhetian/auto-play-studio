"""Seam：列名智能匹配。

基准表 A 和核对表 B 的列名经常对不上号（「订单号」↔「订单编号」），
靠完全相同去匹配根本配不上；但配错了更糟 —— 对比结果会静默出错。
所以这里的契约是：**该配的要配上，拿不准的宁可留空**。
"""
from __future__ import annotations

from engine.compare.column_match import auto_map, similarity


def test_identical_names_match_perfectly():
    assert similarity("订单号", "订单号") == 1.0


def test_synonym_names_are_matched():
    """「订单号」↔「订单编号」、「退差金额」↔「退款差额」是现实里最常见的两对。"""
    m = auto_map(["订单号", "退差金额"], ["订单编号", "退款差额"])
    assert m == {"订单号": "订单编号", "退差金额": "退款差额"}


def test_half_overlap_is_left_unmapped():
    """「商品金额」和「退差金额」只共用一个「金额」—— 配上去就是错配。"""
    assert similarity("退差金额", "商品金额") < 0.68
    assert auto_map(["退差金额"], ["商品金额"])["退差金额"] is None


def test_brackets_and_spaces_are_ignored():
    """「退差金额（元）」「订 单 号」这种带注释和空格的表头要能认出来。"""
    assert auto_map(["退差金额"], ["退差金额（元）"])["退差金额"] == "退差金额（元）"
    assert auto_map(["订单号"], ["订 单 号"])["订单号"] == "订 单 号"


def test_english_header_matches_chinese_field():
    assert auto_map(["订单号"], ["Order_NO"])["订单号"] == "Order_NO"


def test_one_column_is_never_taken_twice():
    """两个字段不能抢同一列，也不能一列被用两次。"""
    m = auto_map(["订单号", "客户"], ["订单号", "客户名称"])
    assert m == {"订单号": "订单号", "客户": "客户名称"}
    assert len([c for c in m.values() if c]) == len(set(c for c in m.values() if c))


def test_only_one_field_gets_the_single_candidate():
    m = auto_map(["订单号", "运单号"], ["订单号"])
    assigned = [c for c in m.values() if c]
    assert assigned == ["订单号"]


def test_existing_mapping_is_kept_when_not_forced():
    """用户手动改过的映射不该被下一次自动匹配覆盖掉。"""
    m = auto_map(["订单号"], ["订单号", "备注"], existing={"订单号": "备注"})
    assert m["订单号"] == "备注"


def test_force_recomputes_and_can_fix_a_bad_pick():
    m = auto_map(["订单号"], ["订单号", "备注"], existing={"订单号": "备注"}, force=True)
    assert m["订单号"] == "订单号"


def test_every_field_is_present_in_the_result():
    assert set(auto_map(["订单号", "金额"], [])) == {"订单号", "金额"}


def test_blank_columns_are_ignored():
    assert auto_map(["订单号"], ["", None])["订单号"] is None
