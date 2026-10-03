"""Seam：模板渲染（`python/engine/template.py`）。

`render_template(text, row)` 是模板语法的唯一真源 —— 解析 `{列名}` / `{列名|格式化器}`，
把当前行的值替换进去。纯函数、零 IO，所以「渲染得对不对」完全可以不碰鼠标键盘地测完。

为什么**不直测每个格式化器函数**：
用户写的是 `{金额|rmb}`，不是 `rmb_upper()`。直测内部函数等于把测试焊在实现上 ——
换个写法就红，而这时候红的是测试，不是 bug。

黄金用例在 `tests/fixtures/template_cases.json`，前端有一份同样的副本
（守卫测试 `test_template_cases_parity.py`）。任何一侧改了语义，另一侧立刻红。
"""
from __future__ import annotations

import datetime
import json
import pathlib

import pytest

from engine.template import TemplateError, render_template, template_issues

_CASES = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "template_cases.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("case", _CASES["render"], ids=lambda c: c["id"])
def test_render_cases(case: dict):
    """模板语法与集成。每条期望值都是能手算验证的独立真相，不是从实现反推的。"""
    assert render_template(case["tpl"], case["row"]) == case["out"]


@pytest.mark.parametrize(
    "case", _CASES["format"], ids=lambda c: f'{c["fmt"]}:{c.get("arg", "")}:{c["in"]}'
)
def test_format_cases(case: dict):
    """单个格式化器的边界打表。

    `rmb` 的分组进位（壹万零壹 vs 壹拾万伍仟）靠肉眼看不出来，必须拿边界值打表 ——
    第一版就写错过，`10000` 会输出成「壹零万元」。
    """
    spec = case["fmt"] + (f':{case["arg"]}' if case.get("arg") else "")
    row = {"values": {"值": case["in"]}}

    assert render_template("{值|" + spec + "}", row) == case["out"]


def test_date_accepts_a_real_datetime_not_just_text():
    """Excel 的日期单元格经 openpyxl 出来就是 datetime，不走字符串解析。

    这条没法进黄金用例（JSON 表达不了 datetime），但它仍然是同一个 seam。
    前端对应的是 ISO 字符串那条路径，已经在用例里覆盖。
    """
    row = {"values": {"下单时间": datetime.datetime(2026, 10, 2, 13, 20, 5)}}

    assert render_template("{下单时间|date:YYYY-MM-DD HH:mm:ss}", row) == "2026-10-02 13:20:05"


def test_date_accepts_a_plain_date_object():
    """只有日期的单元格（datetime.date）补零点即可。"""
    row = {"values": {"下单时间": datetime.date(2026, 10, 2)}}

    assert render_template("{下单时间|date:HH:mm}", row) == "00:00"


@pytest.mark.parametrize("case", _CASES["errors"], ids=lambda c: c["id"])
def test_error_cases(case: dict):
    """解析不出来必须抛错，绝不能把占位符原样透传 —— 那是直接发给客户的事故。"""
    with pytest.raises(TemplateError) as excinfo:
        render_template(case["tpl"], case["row"])

    assert case["message_contains"] in str(excinfo.value)


@pytest.mark.parametrize("case", _CASES["issues"], ids=lambda c: c["tpl"])
def test_issue_cases(case: dict):
    """保存时校验。

    它和运行时校验走的是**同一个解析出口**，所以报错文案就是同一句话 ——
    不需要第二套解析器，也就不可能出现「保存时说没问题、跑起来才炸」。
    断言用的是全等而不是包含：文案本身也是前后端之间的契约。
    """
    assert template_issues(case["tpl"], case["columns"]) == case["issues"]
