"""切片 3：Excel 整理 —— 原文件只读，出「原名_已整理.xlsx」+ 逐处改动台账。

这一片最要紧的不是「改得对不对」，而是**台账说的和文件里的必须是一回事**。
所以除了逐格对比手写的 work example，还有一条通用对账：
拿「台账 + 输入」去还原输出，逐格比。对账器不认识任何规则 ——
它看的是「台账有没有漏记一处改动、有没有记一处没发生的改动」。

行号/列号一律是**原文件**的坐标：用户是拿着原文件去核对的，
整理之后行号会漂，输出文件里找不到「第 8 行」。
"""
from __future__ import annotations

import os
import pathlib

import pytest

from engine.excel_prep import clean as prep_clean
from engine.excel_prep import inspector as prep_inspect
from tests import excel_prep_fixtures as F


def options(key_col: str, accept_risk: bool = False) -> prep_clean.CleanOptions:
    return prep_clean.CleanOptions(key_col=key_col, accept_risk=accept_risk)


def assert_output_rebuilds_from_log(source: str, output: str, log: prep_clean.ChangeLog) -> None:
    """通用对账：不认识任何规则，只拿「台账 + 输入」还原输出。

    台账漏记一处改动，用户会以为某个值原样保留着；记一处没发生的改动，
    用户会去核对一个文件里根本找不到的差异。两种都不能忍，所以这里逐格比。
    """
    src = F.sheet_rows(source)
    out = F.sheet_rows(output)

    assert list(log.rows_kept) == sorted(log.rows_kept), "保留的行必须按原文件的顺序"
    assert list(log.cols_kept) == sorted(log.cols_kept)
    assert len(log.rows_kept) == len(set(log.rows_kept)), "同一行不能保留两次"
    assert 1 <= min(log.rows_kept) <= max(log.rows_kept) <= len(src)
    assert 1 <= min(log.cols_kept) <= max(log.cols_kept) <= len(src[0])

    assert len(out) == len(log.rows_kept), "输出的行数与台账里的保留行对不上"

    changed = {(c.row, c.col): c for c in log.changes if c.row and c.col}
    for i, src_row in enumerate(log.rows_kept):
        for j, src_col in enumerate(log.cols_kept):
            change = changed.get((src_row, src_col))
            want = change.after if change else src[src_row - 1][src_col - 1]
            got = out[i][j] if j < len(out[i]) else None
            assert got == want, f"输出第 {i + 1} 行第 {j + 1} 格与台账不符：{got!r} != {want!r}"

    for (row, col), change in changed.items():
        assert change.before == src[row - 1][col - 1], "台账里的 before 必须真的是改之前的值"
        assert change.before != change.after, "记了一处并没有真的改动"


# ── 只读 ──────────────────────────────────────────────────────────────


def test_the_input_file_is_never_touched(tmp_path):
    source = F.write_messy(str(tmp_path / "messy.xlsx"))
    before_rows = F.sheet_rows(source)
    before_bytes = pathlib.Path(source).read_bytes()

    prep_clean.clean(source, options(F.MESSY_KEY_COL))

    assert F.sheet_rows(source) == before_rows
    assert pathlib.Path(source).read_bytes() == before_bytes


def test_the_output_name_keeps_the_original_stem_and_extension(tmp_path):
    """文件名里带点也要留住：`订单.2026.xlsx` 的后缀只有最后一个点之后那一段。"""
    assert prep_clean.output_name(os.path.join("d", "订单 表.xlsx")) == os.path.join("d", "订单 表_已整理.xlsx")
    assert prep_clean.output_name(os.path.join("d", "订单.2026.xlsx")) == os.path.join("d", "订单.2026_已整理.xlsx")


def test_the_output_lands_next_to_the_input_under_a_new_name(tmp_path):
    source = F.write_messy(str(tmp_path / "messy.xlsx"))

    output, log = prep_clean.clean(source, options(F.MESSY_KEY_COL))

    assert os.path.dirname(output) == str(tmp_path)
    assert os.path.basename(output) == "messy_已整理.xlsx"
    assert log.output == output
    assert log.source == source
    assert log.sheet == "导出"


# ── 干净表 ────────────────────────────────────────────────────────────


def test_a_clean_table_comes_out_unchanged(tmp_path):
    source = F.write_clean(str(tmp_path / "clean.xlsx"))

    output, log = prep_clean.clean(source, options(F.CLEAN_KEY_COL))

    assert F.sheet_rows(output) == F.CLEAN_GRID
    assert log.changes == ()
    assert log.rows_kept == tuple(range(1, len(F.CLEAN_GRID) + 1))
    assert log.cols_kept == (1, 2, 3)
    assert_output_rebuilds_from_log(source, output, log)


# ── 脏表 ──────────────────────────────────────────────────────────────


def test_the_cleaned_table_is_the_hand_written_work_example(tmp_path):
    source = F.write_messy(str(tmp_path / "messy.xlsx"))

    output, log = prep_clean.clean(source, options(F.MESSY_KEY_COL))

    assert F.sheet_rows(output) == F.MESSY_CLEAN_GRID
    assert log.rows_kept == F.MESSY_KEPT_ROWS
    assert log.cols_kept == (1, 2, 3)
    assert_output_rebuilds_from_log(source, output, log)


def test_every_removed_row_and_column_is_named_in_the_log(tmp_path):
    """第 4 行（空行）、第 5 行（完全重复）、第 8 行（空主键）都被删了。

    台账里只按 `kind` 记，不带原因文案 —— 文案在体检报告里（同一个 kind 查得到），
    台账是「哪一行被动了」的记录，重复一遍文案只会有两处地方各说各话。
    """
    source = F.write_messy(str(tmp_path / "messy.xlsx"))

    _, log = prep_clean.clean(source, options(F.MESSY_KEY_COL))

    removed = {c.row for c in log.changes if c.col == 0}
    assert removed == {F.M_BLANK_ROW, F.M_SAME_AS_FIRST, F.M_NO_KEY}
    assert {c.kind for c in log.changes if c.col == 0} == {"blank_row", "duplicate_row", "blank_key"}


def test_the_log_records_before_and_after_of_every_changed_cell(tmp_path):
    source = F.write_messy(str(tmp_path / "messy.xlsx"))

    _, log = prep_clean.clean(source, options(F.MESSY_KEY_COL))

    by_cell = {(c.row, c.col): c for c in log.changes}
    assert by_cell[(F.M_HEADER, 2)].before == "客户名称 "
    assert by_cell[(F.M_HEADER, 2)].after == "客户名称"
    assert by_cell[(F.M_SPACEY_KEY, 1)].before == "  A005  "
    assert by_cell[(F.M_SPACEY_KEY, 1)].after == "A005"


def test_rows_above_the_header_are_dropped(tmp_path):
    source = F.write_offset_headers(str(tmp_path / "offset.xlsx"))

    output, log = prep_clean.clean(source, options(F.OFFSET_KEY_COL))

    assert log.rows_kept == F.OFFSET_KEPT_ROWS
    assert F.sheet_rows(output) == F.OFFSET_CLEAN_GRID
    assert {c.row for c in log.changes if c.kind == "leading_blank_rows"} == {1, 2}
    assert_output_rebuilds_from_log(source, output, log)


# ── risk 级：默认不应用 ───────────────────────────────────────────────


def test_the_risky_rule_is_left_alone_by_default(tmp_path):
    """同一条工单做两遍 = 重复退款，所以默认不动第 7 行。"""
    source = F.write_messy(str(tmp_path / "messy.xlsx"))

    _, log = prep_clean.clean(source, options(F.MESSY_KEY_COL))

    assert F.M_KEY_REPEATS_SECOND in log.rows_kept
    assert "duplicate_key" not in {c.kind for c in log.changes}


def test_the_risky_rule_runs_once_the_user_accepts_it(tmp_path):
    source = F.write_messy(str(tmp_path / "messy.xlsx"))

    output, log = prep_clean.clean(source, options(F.MESSY_KEY_COL, accept_risk=True))

    assert F.M_KEY_REPEATS_SECOND not in log.rows_kept
    assert log.rows_kept == F.MESSY_KEPT_ROWS_WITH_RISK
    assert F.sheet_rows(output) == F.MESSY_CLEAN_GRID_WITH_RISK
    assert "duplicate_key" in {c.kind for c in log.changes}
    assert_output_rebuilds_from_log(source, output, log)


# ── 空列名 ────────────────────────────────────────────────────────────


def test_a_nameless_column_with_nothing_in_it_is_dropped(tmp_path):
    source = F.write_blank_header(str(tmp_path / "bh.xlsx"))

    output, log = prep_clean.clean(source, options("订单编号"))

    assert log.cols_kept == F.BH_KEPT_COLS
    assert F.sheet_rows(output) == F.BH_CLEAN_GRID
    assert any(c.kind == "blank_header" and c.col == F.BH_EMPTY_COL for c in log.changes)
    assert_output_rebuilds_from_log(source, output, log)


def test_a_nameless_column_holding_data_is_left_where_it_is(tmp_path):
    """只报不改的那半：列名是用户起的名，工具编不出正确的名字。"""
    source = F.write_blank_header_with_data(str(tmp_path / "bhd.xlsx"))

    output, log = prep_clean.clean(source, options("订单编号"))

    assert log.cols_kept == F.BHD_KEPT_COLS
    assert F.sheet_rows(output) == F.BHD_CLEAN_GRID
    assert not any(c.kind == "blank_header" for c in log.changes)
    assert_output_rebuilds_from_log(source, output, log)


# ── 只报不改的那两类 ──────────────────────────────────────────────────


def test_unparsable_values_are_reported_but_never_rewritten(tmp_path):
    """类型问题只是 `info`：猜错的值会变成客户投诉，不如让它整行失败。"""
    source = F.write_bad_dates(str(tmp_path / "bd.xlsx"))

    output, log = prep_clean.clean(source, options("订单编号"))

    assert F.sheet_rows(output) == F.sheet_rows(source)
    assert log.changes == ()


def test_a_repeated_column_name_is_not_renamed(tmp_path):
    """自动改名更糟：用户模板里引用的就是那个名字，改了之后模板全线失配。"""
    source = F.write_duplicate_header(str(tmp_path / "dh.xlsx"))

    output, log = prep_clean.clean(source, options("订单编号"))

    assert log.cols_kept == (1, 2, 3)
    assert [c.kind for c in log.changes] == ["header_whitespace"]
    assert F.sheet_rows(output)[0] == ["订单编号", "客户名称", "客户名称"]


# ── 与体检同一条口径 ──────────────────────────────────────────────────


def test_an_unknown_key_column_fails_loudly(tmp_path):
    """走的是体检那条路 —— 列名写错时不能静默当成「没有主键」，否则会删错行。"""
    source = F.write_messy(str(tmp_path / "messy.xlsx"))

    with pytest.raises(ValueError) as excinfo:
        prep_clean.clean(source, options("不存在的列"))

    assert "不存在的列" in str(excinfo.value)


def test_every_automatic_fix_shows_up_in_the_log(tmp_path):
    """体检说会自动修的每一类，台账里都必须有；台账里也不能出现体检没说过的种类。

    两处各判一次的话，报告说「第 5 行重复」、整理删了第 7 行 ——
    用户照着报告去核对，只会觉得这个工具在瞎改。
    """
    source = F.write_messy(str(tmp_path / "messy.xlsx"))
    report = prep_inspect.inspect(source, F.MESSY_KEY_COL)

    _, log = prep_clean.clean(source, options(F.MESSY_KEY_COL))

    assert {issue.kind for issue in report.issues if issue.severity == "fix"} == {c.kind for c in log.changes}


def test_the_report_names_exactly_the_rows_the_log_removes(tmp_path):
    """报告点名要删的行，输出里一行都不能留；没点名的行，一行都不能少。

    「一行都不能少」这半条尤其要紧：多删一行是**静默**的 ——
    用户拿到文件只会觉得数据本来就长这样。
    """
    source = F.write_messy(str(tmp_path / "messy.xlsx"))
    report = prep_inspect.inspect(source, F.MESSY_KEY_COL)

    _, log = prep_clean.clean(source, options(F.MESSY_KEY_COL))

    doomed = {row for issue in report.issues if issue.kind in {"blank_row", "duplicate_row", "blank_key"} for row in issue.rows}
    assert doomed == {F.M_BLANK_ROW, F.M_SAME_AS_FIRST, F.M_NO_KEY}
    assert set(log.rows_kept) == {row for row in range(1, F.M_SPACEY_KEY + 1) if row not in doomed}
