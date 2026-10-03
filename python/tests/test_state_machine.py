"""Seam 4：实例状态机迁移。

状态机在前端（src/schemas/instance.ts）与后端（engine/runner.py）各存一份，
靠人肉同步必然漂移 —— 这一份测试就是它们的一致性契约。
"""
from __future__ import annotations

import pathlib
import re

import pytest

from engine.runner import ALLOWED_TRANSITIONS, InstanceRunner
from tests.helpers import FakeExecutor, make_runner, rpa_cfg

TS_SCHEMA = pathlib.Path(__file__).resolve().parents[2] / "src" / "schemas" / "instance.ts"


def parse_ts_transitions(text: str) -> dict[str, list[str]]:
    block = re.search(r"ALLOWED_TRANSITIONS[^=]*=\s*\{(.*?)\n\}", text, re.S).group(1)
    return {m.group(1): re.findall(r"'([^']+)'", m.group(2)) for m in re.finditer(r"(\w+):\s*\[([^\]]*)\]", block)}


def test_transition_tables_match_between_frontend_and_backend():
    ts = parse_ts_transitions(TS_SCHEMA.read_text(encoding="utf-8"))
    assert ts, f"未能从 {TS_SCHEMA} 解析出 ALLOWED_TRANSITIONS"

    assert {k: sorted(v) for k, v in ts.items()} == {k: sorted(v) for k, v in ALLOWED_TRANSITIONS.items()}


def test_every_status_appears_as_a_key():
    """迁移表里不能出现「只有目标没有来源」或反之的状态。"""
    targets = {t for ts in ALLOWED_TRANSITIONS.values() for t in ts}
    assert targets <= set(ALLOWED_TRANSITIONS), f"出现了未定义来源的状态：{targets - set(ALLOWED_TRANSITIONS)}"


def test_illegal_transitions_are_rejected(make_instance, order_xlsx):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    runner = make_runner(iid, executor=FakeExecutor())

    assert runner.status() == "idle"
    assert runner.pause() is False, "空闲实例不能暂停"
    assert runner.resume() is False, "空闲实例不能继续"
    assert runner.status() == "idle", "被拒绝的迁移不应改动状态"


def test_pause_and_resume_roundtrip(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    runner = make_runner(iid, executor=FakeExecutor(delay=0.4))

    assert runner.start()
    assert wait_status(iid, {"running"}, 5) == "running"

    assert runner.pause()
    assert wait_status(iid, {"paused"}, 5) == "paused"

    assert runner.resume()
    assert wait_status(iid, {"running"}, 5) == "running"

    runner.stop()
    assert wait_status(iid, {"idle"}, 10) == "idle"
    assert runner.resume() is False, "停止后不能继续，只能重新开始"


def test_completed_instance_can_start_again(make_instance, order_xlsx, wait_status):
    """跑完之后再点「开始」应该直接重跑，而不是要求用户先手动重置。"""
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    make_runner(iid, executor=FakeExecutor()).start()
    assert wait_status(iid, {"completed"}, 10) == "completed"

    assert make_runner(iid, executor=FakeExecutor()).start()
    assert wait_status(iid, {"completed", "error"}, 10) == "completed"


@pytest.mark.parametrize(
    "current,action,allowed",
    [
        ("idle", "start", True),
        ("running", "pause", True),
        ("paused", "resume", True),
        ("paused", "pause", False),
        ("completed", "pause", False),
        ("idle", "resume", False),
    ],
)
def test_control_actions_respect_the_table(make_instance, order_xlsx, current, action, allowed):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    import json

    from engine import db

    with db.write() as c:
        c.execute("UPDATE instances SET status=? WHERE id=?", (current, iid))

    runner = make_runner(iid, executor=FakeExecutor())
    result = {"start": runner.start, "pause": runner.pause, "resume": runner.resume}[action]()

    assert bool(result) is allowed
    if not allowed:
        assert runner.status() == current
    if result and action == "start":
        runner.stop()


HOTKEY_TS = pathlib.Path(__file__).resolve().parents[2] / "src" / "lib" / "hotkey.ts"


def test_engine_default_config_agrees_with_the_frontend():
    """引擎造实例时写进去的默认值，必须和前端的两份常量对得上。

    这里守的是本仓库最容易静默漂移的一处：**同一份清单两边各写一遍**。
    漏改一边不会有任何报错 ——
      * 前端少了工具 id，新建的实例在配置页会掉进 `default` 分支、读不到子对象而白屏；
      * 引擎少了热键动作，用户看到界面写着「F8 开始」却按不出反应。
    两边都「看起来正常」，所以只能靠这条契约看住。
    """
    from engine.main import DEFAULT_CONFIG

    # ① 工具清单：toolTypeSchema ↔ DEFAULT_CONFIG
    schema_ts = TS_SCHEMA.read_text(encoding="utf-8")
    enum_block = re.search(r"toolTypeSchema = z\.enum\(\[([^\]]*)\]\)", schema_ts).group(1)
    tool_ids = set(re.findall(r"'(\w+)'", enum_block))
    assert tool_ids, f"未能从 {TS_SCHEMA} 解析出 toolTypeSchema"
    assert tool_ids == set(DEFAULT_CONFIG), "工具清单两边不一致（新工具要同时登记两处）"

    # ② 默认热键：DEFAULT_HOTKEY_MAP ↔ 每个工具的 hotkeys
    hotkey_ts = HOTKEY_TS.read_text(encoding="utf-8")
    block = re.search(r"DEFAULT_HOTKEY_MAP[^=]*=\s*\{(.*?)\}", hotkey_ts, re.S).group(1)
    expected = dict(re.findall(r"(\w+)\s*:\s*'([^']+)'", block))
    assert expected, f"未能从 {HOTKEY_TS} 解析出 DEFAULT_HOTKEY_MAP"

    for tool, cfg in DEFAULT_CONFIG.items():
        assert cfg.get("hotkeys") == expected, f"{tool} 的默认热键与前端 DEFAULT_HOTKEY_MAP 不一致"


HOTKEY_TS = pathlib.Path(__file__).resolve().parents[2] / "src" / "lib" / "hotkey.ts"


def test_engine_default_config_agrees_with_the_frontend():
    """引擎造实例时写进去的默认值，必须和前端的两份常量对得上。

    这里守的是本仓库最容易静默漂移的一处：**同一份清单两边各写一遍**。
    漏改一边不会有任何报错 ——
      * 前端少了工具 id，新建的实例在配置页会掉进 `default` 分支、读不到子对象而白屏；
      * 引擎少了热键动作，用户看到界面写着「F8 开始」却按不出反应。
    两边都「看起来正常」，所以只能靠这条契约看住。
    """
    from engine.main import DEFAULT_CONFIG

    # ① 工具清单：toolTypeSchema ↔ DEFAULT_CONFIG
    schema_ts = TS_SCHEMA.read_text(encoding="utf-8")
    enum_block = re.search(r"toolTypeSchema = z\.enum\(\[([^\]]*)\]\)", schema_ts).group(1)
    tool_ids = set(re.findall(r"'(\w+)'", enum_block))
    assert tool_ids, f"未能从 {TS_SCHEMA} 解析出 toolTypeSchema"
    assert tool_ids == set(DEFAULT_CONFIG), "工具清单两边不一致（新工具要同时登记两处）"

    # ② 默认热键：DEFAULT_HOTKEY_MAP ↔ 每个工具的 hotkeys
    hotkey_ts = HOTKEY_TS.read_text(encoding="utf-8")
    block = re.search(r"DEFAULT_HOTKEY_MAP[^=]*=\s*\{(.*?)\}", hotkey_ts, re.S).group(1)
    expected = dict(re.findall(r"(\w+)\s*:\s*'([^']+)'", block))
    assert expected, f"未能从 {HOTKEY_TS} 解析出 DEFAULT_HOTKEY_MAP"

    for tool, cfg in DEFAULT_CONFIG.items():
        assert cfg.get("hotkeys") == expected, f"{tool} 的默认热键与前端 DEFAULT_HOTKEY_MAP 不一致"
