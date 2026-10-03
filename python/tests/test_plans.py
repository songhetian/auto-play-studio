"""方案（配置模板）：全局存一份，跨工具、跨实例复用。

方案是「配置模板层」，实例是「运行主体层」，两者**不双向同步**：
从实例另存出来的方案是一份快照，之后再改实例配置不会回写方案，改方案也不动已有实例。
"""
from __future__ import annotations

import pytest

from engine import db
from engine import plans


@pytest.fixture(autouse=True)
def _clean_plans():
    """conftest 只在会话开头清一次表，而这里全是「看全局」的断言，每条都从空表开始。"""
    with db.write() as c:
        c.execute("DELETE FROM plans")
    yield


def test_created_plan_comes_back_intact():
    pid = plans.create_plan("cmp", "日对账", {"cmp": {"tolerance": 0.5}})
    assert pid

    p = plans.get_plan(pid)
    assert p["name"] == "日对账"
    assert p["tool"] == "cmp"
    assert p["config"]["cmp"]["tolerance"] == 0.5
    assert p["createdAt"]


def test_list_puts_newer_plans_first():
    first = plans.create_plan("cmp", "甲", {"n": 1})
    second = plans.create_plan("cmp", "乙", {"n": 2})

    assert [p["id"] for p in plans.list_plans()] == [second, first]


def test_list_filters_by_tool():
    plans.create_plan("rpa", "脚本方案", {"n": 1})
    cmp_plan = plans.create_plan("cmp", "对比方案", {"n": 2})

    assert [p["id"] for p in plans.list_plans(tool="cmp")] == [cmp_plan]


def test_rename_keeps_the_config():
    pid = plans.create_plan("cmp", "旧名", {"cmp": {"tolerance": 0.5}})

    assert plans.update_plan(pid, name="新名") is True

    p = plans.get_plan(pid)
    assert p["name"] == "新名"
    assert p["config"]["cmp"]["tolerance"] == 0.5


def test_update_replaces_the_config():
    pid = plans.create_plan("cmp", "日对账", {"cmp": {"tolerance": 0.5}})

    plans.update_plan(pid, config={"cmp": {"tolerance": 0.01}})

    assert plans.get_plan(pid)["config"] == {"cmp": {"tolerance": 0.01}}


def test_delete_removes_it_and_says_what_happened():
    pid = plans.create_plan("cmp", "日对账", {})

    assert plans.delete_plan(pid) is True
    assert plans.get_plan(pid) is None
    # 删第二遍要如实说没删到，不能永远回 True
    assert plans.delete_plan(pid) is False


def test_unknown_plan_reads_back_as_none():
    assert plans.get_plan("no-such-plan") is None


def test_plan_is_a_snapshot_not_a_live_link_to_the_instance(make_instance):
    """另存出来的方案是快照：之后改实例配置，方案不能跟着变。

    这是「方案与实例不双向同步」这条约定的落点 ——
    要是方案跟着实例走，用户改一次配置就把别人的模板改坏了。
    """
    iid = make_instance("cmp", {"cmp": {"tolerance": 0.5}}, name="我的对账")
    pid = plans.create_plan("cmp", "日对账", db.get_config(iid))

    db.save_config(iid, {"cmp": {"tolerance": 99}})

    assert plans.get_plan(pid)["config"] == {"cmp": {"tolerance": 0.5}}
