"""跑后汇总：行台账 → 一句话结论 + 失败原因归类 + 待人工确认清单。

期望值全部手算：几行、成功/失败/跳过各几条、归成几类、每类几条 ——
不先跑一遍实现再把它当期望，那只是把实现抄了一遍。

`rows` 的形状就是 `db.query("SELECT row_no, key_value, status, message FROM rows ...")`
出来的那种（`status` 取 `ok` / `err` / `skip`）。
"""
from __future__ import annotations

from engine import summary

#: 引擎报错文案里的变量一律用「」括起来（`commands.py` 与 `template.py` 都是这个写法）。
#: 归类时正是靠它把「换个值就换一条」的行并成一类。
BAD_DATE = "格式化器 date 认不出「待定」，它需要一个日期"
NO_WINDOW = "等待超时，屏幕上没有找到图片「提交按钮」"


def row(no: int, key: str, status: str, message: str = "") -> dict:
    return {"row_no": no, "key_value": key, "status": status, "message": message, "duration_ms": 12}


# ── 数数 ──────────────────────────────────────────────────────────────


def test_counts_the_three_outcomes():
    rows = [
        row(2, "A001", "ok"),
        row(3, "A002", "err", NO_WINDOW),
        row(4, "A003", "skip", "上次已成功"),
        row(5, "A004", "ok"),
        row(6, "A005", "ok"),
        row(7, "A006", "err", NO_WINDOW),
    ]

    s = summary.summarize(rows)

    assert (s.total, s.ok, s.failed, s.skipped) == (6, 3, 2, 1)


def test_a_status_the_summary_does_not_know_is_counted_as_failed():
    """只认「成功」「跳过」两种没问题，其余一律算失败。

    状态是以后新增的时候，漏算比多算危险得多：多算一条用户去表里看一眼就发现了，
    漏算一条会被当成「跑完了没问题」。
    """
    s = summary.summarize([row(2, "A001", "ok"), row(3, "A002", "wait")])

    assert (s.total, s.ok, s.failed) == (2, 1, 1)


# ── 一句话结论 ────────────────────────────────────────────────────────


def test_the_headline_says_everything_worked():
    s = summary.summarize([row(2, "A001", "ok"), row(3, "A002", "ok")])

    assert s.headline == "本次共 2 行，全部成功"


def test_the_headline_says_everything_failed():
    s = summary.summarize([row(2, "A001", "err", NO_WINDOW), row(3, "A002", "err", NO_WINDOW)])

    assert s.headline == "本次共 2 行，失败 2"


def test_the_headline_spells_out_the_mixture():
    rows = [
        row(2, "A001", "ok"),
        row(3, "A002", "ok"),
        row(4, "A003", "ok"),
        row(5, "A004", "err", NO_WINDOW),
        row(6, "A005", "err", NO_WINDOW),
        row(7, "A006", "skip", "上次已成功"),
    ]

    assert summary.summarize(rows).headline == "本次共 6 行，成功 3、失败 2、跳过 1"


def test_the_headline_leaves_out_the_parts_that_are_zero():
    s = summary.summarize([row(2, "A001", "ok"), row(3, "A002", "ok"), row(4, "A003", "skip", "上次已成功")])

    assert s.headline == "本次共 3 行，成功 2、跳过 1"


def test_an_empty_run_says_so_instead_of_showing_a_row_of_zeros():
    s = summary.summarize([])

    assert (s.total, s.ok, s.failed, s.skipped) == (0, 0, 0, 0)
    assert s.headline == "本次没有执行任何行"
    assert s.reasons == ()
    assert s.pending == ()


# ── 失败原因归类 ──────────────────────────────────────────────────────


def test_failures_are_grouped_by_what_went_wrong_not_by_row():
    rows = [
        row(2, "A001", "err", "格式化器 date 认不出「待定」，它需要一个日期"),
        row(3, "A002", "err", "格式化器 date 认不出「未定」，它需要一个日期"),
        row(4, "A003", "err", "格式化器 date 认不出「稍后」，它需要一个日期"),
        row(5, "A004", "ok"),
        row(6, "A005", "err", NO_WINDOW),
        row(7, "A006", "skip", "上次已成功"),
    ]

    s = summary.summarize(rows)

    assert [(g.count, g.label) for g in s.reasons] == [
        (3, "格式化器 date 认不出「…」，它需要一个日期"),
        (1, NO_WINDOW),
    ]
    assert s.reasons[0].rows == (2, 3, 4)


def test_a_group_of_one_keeps_the_original_wording():
    """只有一个成员的类，把变量抹掉反而丢了信息 ——「哪个按钮」正是用户要看的。

    所以抹变量这件事只在真的合并了多行时才做。
    """
    s = summary.summarize([row(2, "A001", "err", NO_WINDOW)])

    assert s.reasons[0].label == "等待超时，屏幕上没有找到图片「提交按钮」"


def test_only_what_the_engine_quoted_is_erased():
    """抹多了会把两类真问题并成一类，用户就再也看不出是哪个毛病了。"""
    rows = [
        row(2, "A", "err", "等待超时，屏幕上没有找到图片「a」"),
        row(3, "B", "err", "等待超时，屏幕上没有找到图片「b」"),
        row(4, "C", "err", "不支持的指令类型「click」"),
    ]

    assert [(g.count, g.label) for g in summary.summarize(rows).reasons] == [
        (2, "等待超时，屏幕上没有找到图片「…」"),
        (1, "不支持的指令类型「click」"),
    ]


def test_a_multi_line_message_is_flattened_into_one_line():
    """归类是「一行一句话」的展示，文案里夹着换行会把版面撑坏。"""
    rows = [row(2, "A", "err", "第一次失败\n第二次也失败"), row(3, "B", "err", "第一次失败\n第二次也失败")]

    assert summary.summarize(rows).reasons[0].label == "第一次失败 第二次也失败"


def test_a_failure_without_a_reason_is_still_shown():
    """引擎没给说明时不能留一个空白行 —— 用户会以为界面坏了。"""
    s = summary.summarize([row(2, "A001", "err", "")])

    assert s.reasons[0].label == "未说明原因"
    assert s.pending[0].reason == ""


def test_reasons_are_sorted_by_how_often_they_happened():
    """一次跑里最常见的那个原因，才是用户当下要处理的那个。"""
    rows = [
        row(2, "A", "err", "少见的"),
        row(3, "B", "err", "常见的"),
        row(4, "C", "err", "常见的"),
        row(5, "D", "err", "常见的"),
        row(6, "E", "err", "中间的"),
        row(7, "F", "err", "中间的"),
    ]

    assert [g.count for g in summary.summarize(rows).reasons] == [3, 2, 1]


def test_reasons_with_the_same_count_keep_the_order_they_first_appeared():
    """并列时按第一次出现的先后 —— 同样的输入必须给同样的报告。"""
    rows = [row(2, "A", "err", "先出现的"), row(3, "B", "err", "后出现的")]

    assert [g.label for g in summary.summarize(rows).reasons] == ["先出现的", "后出现的"]


def test_only_the_top_reasons_are_listed_and_the_rest_are_counted():
    rows = [row(2 + i, f"K{i}", "err", f"第 {i} 种毛病") for i in range(6)]

    s = summary.summarize(rows, top=3)

    assert len(s.reasons) == 3
    assert s.other_reasons == 3
    assert [g.label for g in s.reasons] == ["第 0 种毛病", "第 1 种毛病", "第 2 种毛病"]


def test_a_run_without_failures_has_no_reason_groups():
    s = summary.summarize([row(2, "A001", "ok", "已签收"), row(3, "A002", "skip", "上次已成功")])

    assert s.reasons == ()
    assert s.other_reasons == 0


# ── 待人工确认清单 ────────────────────────────────────────────────────


def test_pending_lists_exactly_the_failed_rows_with_their_original_reason():
    rows = [
        row(2, "A001", "ok"),
        row(3, "A002", "err", "找不到窗口「客服系统」"),
        row(4, "A003", "skip", "上次已成功"),
        row(5, "A004", "ok"),
        row(6, "A005", "err", "格式化器 money 处理不了「待定」，它需要一个金额"),
    ]

    s = summary.summarize(rows)

    assert [(p.row, p.key, p.reason) for p in s.pending] == [
        (3, "A002", "找不到窗口「客服系统」"),
        (6, "A005", "格式化器 money 处理不了「待定」，它需要一个金额"),
    ]


def test_pending_keeps_the_file_order():
    """导出的清单是拿去一条条补的，顺序得跟表里一致。"""
    rows = [row(9, "A009", "err", "x"), row(3, "A003", "err", "x"), row(5, "A005", "err", "x")]

    assert [p.row for p in summary.summarize(rows).pending] == [3, 5, 9]


def test_a_clean_run_has_nothing_to_confirm():
    s = summary.summarize([row(2, "A001", "ok"), row(3, "A002", "skip", "上次已成功")])

    assert s.pending == ()
