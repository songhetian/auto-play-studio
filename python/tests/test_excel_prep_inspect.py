"""Excel 体检（只读）。

两条这里才定得下来的契约：

1. **行号一律是原文件的行号。** 用户是对着原文件去核对的，整理后行号会漂，
   所以台账与报告都锚在原文件上。
2. **`severity` 决定整理时会不会动它**，不是一个装饰性标签：
   `fix` 自动应用、`risk` 默认不应用（同一条工单做两遍 = 重复退款）、`info` 只报不改。

期望值全部引用 `excel_prep_fixtures` 里手写出来的行号常量，不靠代码算。
"""
from __future__ import annotations

import datetime

import pytest

from engine.excel_prep import inspector as prep_inspect
from engine.excel_prep import values
from tests import excel_prep_fixtures as F


def kinds(report) -> list[str]:
    return [i.kind for i in report.issues]


def rows_of(report, kind: str) -> list[int]:
    """某个 kind 的行号，展平后排序 —— 只关心「哪些行」，不关心分了几个 issue。"""
    out: list[int] = []
    for issue in report.issues:
        if issue.kind == kind:
            out.extend(issue.rows)
    return sorted(out)


def issue_of(report, kind: str):
    hits = [i for i in report.issues if i.kind == kind]
    assert hits, f"没有报出 {kind}，实际报了 {kinds(report)}"
    return hits[0]


# ── 值归一化 ──────────────────────────────────────────────────────────


@pytest.mark.parametrize("value", [None, "", "   ", "\u3000", " \u3000 ", "\t\n"])
def test_blank_values_are_blank(value):
    assert values.is_blank(value) is True


@pytest.mark.parametrize("value", [0, False, "0", " 0 ", "-", "无"])
def test_zeros_and_placeholders_are_not_blank(value):
    """0 和「无」都是有内容的值：把它们当空删掉，等于删掉一整行真实数据。"""
    assert values.is_blank(value) is False


def test_normalize_text_trims_unicode_whitespace():
    """全角空格（U+3000）与不换行空格（U+00A0）都是从系统里复制表时的常见污染。"""
    assert values.normalize_text("  张三 \u3000") == "张三"
    assert values.normalize_text("\xa0李四\xa0") == "李四"
    assert values.normalize_text("王五") == "王五"


def test_normalize_text_leaves_non_strings_alone():
    """数字与日期原样返回：改成字符串会让 openpyxl 把日期写成文本，越修越坏。"""
    day = datetime.date(2026, 10, 2)
    assert values.normalize_text(123) == 123
    assert values.normalize_text(day) is day
    assert values.normalize_text(None) is None


def test_row_signature_treats_whitespace_only_differences_as_equal():
    assert values.row_signature(["A001", " 张三 ", None]) == values.row_signature(["A001 ", "张三", ""])


def test_row_signature_separates_different_values():
    assert values.row_signature(["A001", "张三"]) != values.row_signature(["A002", "张三"])


# ── 报告本身 ──────────────────────────────────────────────────────────


def test_clean_table_reports_no_issues(tmp_path):
    report = prep_inspect.inspect(F.write_clean(str(tmp_path / "clean.xlsx")), F.CLEAN_KEY_COL)

    assert report.issues == []
    assert report.columns == ["订单编号", "客户名称", "处理备注"]
    assert report.header_row == F.C_HEADER
    assert report.data_rows == F.C_OK_SECOND - F.C_HEADER


def test_report_echoes_sheet_name_and_path(tmp_path):
    report = prep_inspect.inspect(F.write_clean(str(tmp_path / "clean.xlsx"), sheet="订单"), F.CLEAN_KEY_COL)

    assert report.sheet == "订单"
    assert report.path.endswith("clean.xlsx")


def test_data_rows_counts_every_row_after_the_header(tmp_path):
    """含空行 —— 这个数要能解释「上传后说 9 行，跑起来只有 6 行有内容」。"""
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert report.data_rows == F.MESSY_DATA_ROWS


def test_every_issue_carries_a_reason_in_plain_words(tmp_path):
    """detail 是给客服看的一句话，不能是 kind 的复读。"""
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert report.issues
    for issue in report.issues:
        assert issue.severity in {"info", "fix", "risk"}
        assert len(issue.detail) >= 6
        assert issue.detail != issue.kind


# ── 表头 ──────────────────────────────────────────────────────────────


def test_header_whitespace_is_reported(tmp_path):
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    issue = issue_of(report, "header_whitespace")
    assert issue.severity == "fix"
    assert issue.rows == (F.M_HEADER,)
    assert "客户名称" in issue.detail


def test_header_row_is_the_first_non_blank_row(tmp_path):
    """表头不在第 1 行时，`detect_columns`（读第 1 行）会得到空列名 —— 体检要说得出来。"""
    report = prep_inspect.inspect(F.write_offset_headers(str(tmp_path / "offset.xlsx")), F.OFFSET_KEY_COL)

    assert report.header_row == F.O_HEADER
    assert report.columns == F.OFFSET_HEADERS
    assert rows_of(report, "leading_blank_rows") == [1, 2]


def test_a_table_whose_header_is_on_row_one_has_no_leading_blank_rows(tmp_path):
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert "leading_blank_rows" not in kinds(report)


# ── 行级问题 ──────────────────────────────────────────────────────────


def test_blank_rows_are_reported(tmp_path):
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert rows_of(report, "blank_row") == [F.M_BLANK_ROW]
    assert issue_of(report, "blank_row").severity == "fix"


def test_rows_identical_to_an_earlier_row_are_reported(tmp_path):
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert rows_of(report, "duplicate_row") == [F.M_SAME_AS_FIRST]
    assert issue_of(report, "duplicate_row").severity == "fix"


def test_rows_with_a_blank_key_are_reported(tmp_path):
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert rows_of(report, "blank_key") == [F.M_NO_KEY]
    assert issue_of(report, "blank_key").severity == "fix"


def test_a_key_with_padding_around_it_is_reported(tmp_path):
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert rows_of(report, "key_whitespace") == [F.M_SPACEY_KEY]


def test_a_key_that_is_only_whitespace_counts_as_blank(tmp_path, xlsx_factory):
    """「   」不是内容。它必须先被当成空主键，否则会以一个看不见的键跑一行。"""
    path = xlsx_factory(["订单编号", "备注"], [["   ", "只有空格的键"]], name="spacekey.xlsx")

    report = prep_inspect.inspect(path, "订单编号")

    assert rows_of(report, "blank_key") == [2]
    assert rows_of(report, "key_whitespace") == []


# ── 重复主键：排除掉已经被「完全重复行」吃掉的那些 ────────────────────


def test_duplicate_key_covers_only_rows_the_identical_row_rule_did_not_take(tmp_path):
    """M_A001 出现两次，但第二次是完全重复行 —— 去重行先跑，轮到查重复主键时它已经不在了。

    两处都报的话，用户会以为有两条问题行，去原表里只找得到一条对应不上。
    """
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert rows_of(report, "duplicate_row") == [F.M_SAME_AS_FIRST]
    assert rows_of(report, "duplicate_key") == [F.M_KEY_REPEATS_SECOND]


def test_duplicate_key_is_risky_not_automatic(tmp_path):
    """同一条工单做两遍 = 重复退款，所以它不能跟别的规则一样自动应用。"""
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert issue_of(report, "duplicate_key").severity == "risk"


def test_duplicate_key_ignores_rows_that_will_be_dropped_for_a_blank_key(tmp_path):
    """第 8 行主键为空，会被「删空主键行」先删掉；它不能参与重复主键的判定。"""
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), F.MESSY_KEY_COL)

    assert F.M_NO_KEY not in rows_of(report, "duplicate_key")


def test_duplicate_key_compares_after_trimming(tmp_path):
    """「B001」与「  B001  」是同一个键 —— 否则带空格的表永远查不出重复。

    第 3 行整行内容与第 2 行不同，所以这条只可能由重复主键抓到，不会被去重行顺手带走。
    """
    report = prep_inspect.inspect(F.write_duplicate_key(str(tmp_path / "dupkey.xlsx")), F.DK_KEY_COL)

    assert rows_of(report, "duplicate_key") == [F.DK_SPACEY_SAME_KEY]
    assert "duplicate_row" not in kinds(report)


def test_the_input_file_is_never_touched(tmp_path):
    """体检是只读的。这条是这一片的根基，值得单独钉住。"""
    path = F.write_messy(str(tmp_path / "messy.xlsx"))
    before = F.sheet_rows(path)

    prep_inspect.inspect(path, F.MESSY_KEY_COL)

    assert F.sheet_rows(path) == before


def test_a_missing_key_column_is_reported_instead_of_raising(tmp_path):
    """用户刚上传、还没选主键列时不能炸 —— 报告里说清少了什么就行。"""
    report = prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), "")

    assert report.header_row == F.M_HEADER
    assert "blank_key" not in kinds(report)
    assert "key_whitespace" not in kinds(report)
    assert "duplicate_key" not in kinds(report)


def test_an_unknown_key_column_fails_loudly(tmp_path):
    """但列名写错时要报错：静默按「没有主键」处理，用户会拿着一份不对的体检结论去整理。"""
    with pytest.raises(ValueError) as excinfo:
        prep_inspect.inspect(F.write_messy(str(tmp_path / "messy.xlsx")), "不存在的列")

    assert "不存在的列" in str(excinfo.value)


# ── 表头：空列名 ──────────────────────────────────────────────────────
# 表头问题的定位单位是**列**（`cols` 是原文件的列序号，1 起），不是行 ——
# 整理时要照着它删掉或多留哪一列。


def test_a_header_cell_without_a_name_is_reported(tmp_path):
    report = prep_inspect.inspect(F.write_blank_header(str(tmp_path / "bh.xlsx")), "订单编号")

    issue = issue_of(report, "blank_header")
    assert issue.rows == (F.BH_HEADER,)
    assert issue.cols == (F.BH_EMPTY_COL,)
    assert f"第 {F.BH_EMPTY_COL} 列" in issue.detail


def test_a_nameless_column_with_nothing_in_it_is_dropped(tmp_path):
    """整列一个字都没有 —— 删掉它是零风险的，所以归 `fix`，整理时自动应用。"""
    report = prep_inspect.inspect(F.write_blank_header(str(tmp_path / "bh.xlsx")), "订单编号")

    assert issue_of(report, "blank_header").severity == "fix"
    assert kinds(report) == ["blank_header"]


def test_a_nameless_column_holding_data_is_only_reported(tmp_path):
    """下面有内容时只报：列名是用户起的名，工具编不出正确的名字，
    编一个「未命名1」等于让用户对着一个不存在的列名去写模板。"""
    report = prep_inspect.inspect(F.write_blank_header_with_data(str(tmp_path / "bhd.xlsx")), "订单编号")

    assert issue_of(report, "blank_header").severity == "info"
    assert kinds(report) == ["blank_header"]


def test_a_full_header_row_reports_nothing_about_it(tmp_path):
    report = prep_inspect.inspect(F.write_clean(str(tmp_path / "clean.xlsx")), F.CLEAN_KEY_COL)

    assert "blank_header" not in kinds(report)


# ── 表头：列名重复 ────────────────────────────────────────────────────


def test_a_repeated_column_name_is_reported(tmp_path):
    report = prep_inspect.inspect(F.write_duplicate_header(str(tmp_path / "dh.xlsx")), "订单编号")

    issue = issue_of(report, "duplicate_header")
    assert issue.severity == "info"
    assert issue.cols == (F.DH_DUPLICATE_COL,)
    assert "客户名称" in issue.detail
    assert f"第 {F.DH_DUPLICATE_COL} 列" in issue.detail


def test_a_repeated_column_name_is_only_reported_for_the_later_column(tmp_path):
    """第一个同名列是「本尊」，不能被算成重复 —— 否则整理时会把真正的数据列删掉。"""
    report = prep_inspect.inspect(F.write_duplicate_header(str(tmp_path / "dh.xlsx")), "订单编号")

    assert F.DH_FIRST_COL not in issue_of(report, "duplicate_header").cols


def test_duplicate_header_compares_column_names_after_trimming(tmp_path):
    """第 3 列名叫「客户名称␠」：不去空白就看不出来它和第 2 列重名。

    `header_whitespace` 与它同时报出是对的 —— 那一列确实有两处毛病。
    """
    report = prep_inspect.inspect(F.write_duplicate_header(str(tmp_path / "dh.xlsx")), "订单编号")

    assert kinds(report) == ["header_whitespace", "duplicate_header"]


# ── 类型体检：一列「看着是日期/金额」时才逐格试解析 ────────────────────
# 判定刻意保守：列里的值得**严格多数**能解析、且能解析的至少 2 个、非空格至少 3 个。
# 放松任何一条，备注列里偶然出现的一个日期串就会把整列打成「日期列」，
# 报告里全是误报，用户就不看体检了。


def test_a_date_column_with_one_unparsable_value_is_reported(tmp_path):
    report = prep_inspect.inspect(F.write_bad_dates(str(tmp_path / "bd.xlsx")), "订单编号")

    issue = issue_of(report, "unparsable_value")
    assert issue.severity == "info"
    assert issue.rows == (F.BD_BAD_DATE,)
    assert issue.cols == (2,)
    assert "日期" in issue.detail
    assert "待定" in issue.detail
    assert f"第 {F.BD_BAD_DATE} 行" in issue.detail


def test_a_real_date_cell_counts_as_parsable(tmp_path):
    """Excel 的日期单元格出来就是 datetime，不走字符串解析 —— 它不该被报成问题。

    第 2 行是 `date(2026, 10, 1)`，只有第 5 行是真问题。
    """
    report = prep_inspect.inspect(F.write_bad_dates(str(tmp_path / "bd.xlsx")), "订单编号")

    assert F.BD_REAL_DATE not in issue_of(report, "unparsable_value").rows
    assert kinds(report) == ["unparsable_value"]


def test_an_amount_column_with_one_unparsable_value_is_reported(tmp_path):
    report = prep_inspect.inspect(F.write_bad_amounts(str(tmp_path / "am.xlsx")), "订单编号")

    issue = issue_of(report, "unparsable_value")
    assert issue.rows == (F.AM_BAD_AMOUNT,)
    assert "金额" in issue.detail
    assert "待定" in issue.detail


def test_thousands_separators_and_currency_symbols_are_not_problems(tmp_path):
    """`1,234.5` 和 `¥99` 都能解析 —— 报它们等于让用户去改本来没问题的表。"""
    report = prep_inspect.inspect(F.write_bad_amounts(str(tmp_path / "am.xlsx")), "订单编号")

    assert kinds(report) == ["unparsable_value"]
    assert 2 not in issue_of(report, "unparsable_value").rows
    assert 3 not in issue_of(report, "unparsable_value").rows


def test_several_bad_values_in_one_column_are_reported_as_one_issue(tmp_path, xlsx_factory):
    """一列里有 5 处坏值就报 5 条，报告会淹掉真正要看的东西。"""
    path = xlsx_factory(
        ["订单编号", "下单日期"],
        [["P001", "2026-10-01"], ["P002", "2026-10-02"], ["P003", "2026-10-03"], ["P004", "待定"], ["P005", "未定"]],
    )

    report = prep_inspect.inspect(path, "订单编号")

    hits = [i for i in report.issues if i.kind == "unparsable_value"]
    assert len(hits) == 1
    assert hits[0].rows == (5, 6)  # 表头占第 1 行，坏值「待定」「未定」落在第 5、6 行
    assert hits[0].cols == (2,)


def test_a_column_where_a_date_shows_up_only_once_is_not_a_date_column(tmp_path):
    """备注列里出现一个日期串，说明不了这一列是日期列。"""
    report = prep_inspect.inspect(F.write_remarks_with_a_date(str(tmp_path / "rm.xlsx")), "订单编号")

    assert kinds(report) == []


def test_a_column_too_short_to_judge_is_left_alone(tmp_path):
    """两格里有 1 格是日期 —— 样本太少，认不出这一列是什么。"""
    report = prep_inspect.inspect(F.write_short_date_column(str(tmp_path / "sc.xlsx")), "订单编号")

    assert kinds(report) == []


def test_exactly_half_parsing_is_not_enough_to_call_it_a_date_column(tmp_path, xlsx_factory):
    """一半一半等于抛硬币。判定放到这里，误报就会从「偶尔」变成「每张表都有」。"""
    path = xlsx_factory(
        ["订单编号", "下单日期"],
        [["Q001", "2026-10-01"], ["Q002", "待定"], ["Q003", "2026-10-03"], ["Q004", "未定"]],
    )

    report = prep_inspect.inspect(path, "订单编号")

    assert kinds(report) == []


def test_a_date_column_where_every_value_parses_is_clean(tmp_path, xlsx_factory):
    path = xlsx_factory(
        ["订单编号", "下单日期"],
        [["N001", "2026-10-01"], ["N002", "2026-10-02"], ["N003", "2026-10-03"]],
    )

    report = prep_inspect.inspect(path, "订单编号")

    assert kinds(report) == []
