"""Seam：指令解释器。

把配置里的指令序列翻译成一串「对驱动的调用」。真驱动（pyautogui / OpenCV）
不在测试范围内，但「翻译得对不对」完全可以在这里验完。
"""
from __future__ import annotations

import pytest

from engine.commands import run_commands
from tests.helpers import FakeDriver


@pytest.fixture
def driver():
    return FakeDriver()


def text_cmd(text: str, name: str = "输入文本") -> dict:
    return {"t": name, "type": "text", "on": True, "p": text}


# ── 变量替换 ──────────────────────────────────────────────
def test_text_command_substitutes_row_values(driver, rpa_row):
    cmds = [text_cmd("您好 {客户名称}，您的单号是 {订单编号}")]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert (ok, msg) == (True, "")
    assert driver.calls == [("type_text", "您好 张三，您的单号是 A001")]


def test_unknown_placeholder_fails_instead_of_being_sent(driver, rpa_row):
    """占位符写错时绝不能原样发出去 —— 那是直接发给客户的事故。"""
    cmds = [text_cmd("您好 {客户名}")]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert "{客户名}" in msg
    assert driver.calls == [], "发现问题就不该再动键盘"


def test_multiple_commands_run_in_order(driver, rpa_row):
    cmds = [text_cmd("第一句"), text_cmd("第二句")]

    ok, _ = run_commands(cmds, rpa_row, driver)

    assert ok is True
    assert driver.calls == [("type_text", "第一句"), ("type_text", "第二句")]


def test_disabled_command_is_skipped(driver, rpa_row):
    cmds = [text_cmd("要发的"), {**text_cmd("不发的"), "on": False}]

    ok, _ = run_commands(cmds, rpa_row, driver)

    assert ok is True
    assert driver.calls == [("type_text", "要发的")]


def test_empty_command_list_succeeds(driver, rpa_row):
    assert run_commands([], rpa_row, driver) == (True, "")
    assert driver.calls == []


def test_unknown_command_type_fails_with_its_name(driver, rpa_row):
    cmds = [{"t": "外星指令", "type": "alien", "on": True, "p": ""}]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert "外星指令" in msg


# ── 按键 ──────────────────────────────────────────────
def test_hotkey_is_pressed_with_defaults(driver, rpa_row):
    cmds = [{"t": "粘贴", "type": "key", "on": True, "p": "", "key": {"combo": ["Ctrl", "V"]}}]

    ok, _ = run_commands(cmds, rpa_row, driver)

    assert ok is True
    assert driver.calls == [("press", ("ctrl", "v"), 1, 120)], "重复 1 次、间隔 120ms 是默认值"


def test_hotkey_repeat_and_delay_are_honoured(driver, rpa_row):
    cmds = [{"t": "回车", "type": "key", "on": True, "p": "", "key": {"combo": ["Enter"], "repeat": 3, "delayMs": 50}}]

    ok, _ = run_commands(cmds, rpa_row, driver)

    assert ok is True
    assert driver.calls == [("press", ("enter",), 3, 50)]


def test_hotkey_is_normalized_before_reaching_the_driver(driver, rpa_row):
    """用户在配置页写什么写法都行，driver 只收到 pyautogui 认得的那一串。"""
    cmds = [{"t": "复制", "type": "key", "on": True, "p": "", "key": {"combo": ["Shift", "CONTRol", "C"]}}]

    ok, _ = run_commands(cmds, rpa_row, driver)

    assert ok is True
    assert driver.calls == [("press", ("ctrl", "shift", "c"), 1, 120)], "修饰键要按固定顺序排"


def test_hotkey_typo_fails_the_row_instead_of_pressing_nothing(driver, rpa_row):
    """以前 Ctr+C 会原样传给 pyautogui：写成一个串时它当一个键名，静默什么都不按。"""
    cmds = [{"t": "复制", "type": "key", "on": True, "p": "", "key": {"combo": ["Ctr", "C"]}}]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert "「Ctr」" in msg
    assert driver.calls == [], "键名不对就不该碰键盘"


def test_hotkey_with_only_modifiers_fails_the_row(driver, rpa_row):
    """只按住修饰键，driver 会静默什么都不做 —— 那是最难查的一类「没反应」。"""
    cmds = [{"t": "按住 Ctrl", "type": "key", "on": True, "p": "", "key": {"combo": ["Ctrl", "Shift"]}}]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert "还缺一个按键" in msg
    assert driver.calls == []


def test_key_command_without_a_key_fails(driver, rpa_row):
    cmds = [{"t": "回车", "type": "key", "on": True, "p": ""}]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert "按键" in msg


# ── 图像 ──────────────────────────────────────────────
def img_cmd(**over) -> dict:
    image = {"assetId": "btn_send", "threshold": 0.9, "timeoutSec": 5, "offsetX": 3, "offsetY": -2, "onMiss": "fail"}
    image.update(over)
    return {"t": "点击图像", "type": "img", "on": True, "p": "", "image": image}


def test_image_is_located_then_clicked_with_offset(rpa_row):
    driver = FakeDriver(images={"btn_send": (100, 200)})

    ok, _ = run_commands([img_cmd()], rpa_row, driver)

    assert ok is True
    assert driver.calls == [("locate", "btn_send", 0.9, 5.0), ("click", 103, 198)]


def test_missing_image_fails_the_row(rpa_row):
    driver = FakeDriver()

    ok, msg = run_commands([img_cmd()], rpa_row, driver)

    assert ok is False
    assert "按钮" in msg or "图像" in msg or "btn_send" in msg
    assert driver.kinds() == ["locate"]


def test_missing_image_can_retry_once(rpa_row):
    driver = FakeDriver(scripted={"btn_send": [None, (10, 20)]})

    ok, _ = run_commands([img_cmd(onMiss="retry")], rpa_row, driver)

    assert ok is True
    assert driver.kinds() == ["locate", "locate", "click"]
    assert driver.calls[-1] == ("click", 13, 18)


def test_missing_image_still_fails_after_retrying(rpa_row):
    driver = FakeDriver(scripted={"btn_send": [None, None]})

    ok, msg = run_commands([img_cmd(onMiss="retry")], rpa_row, driver)

    assert ok is False
    assert driver.kinds() == ["locate", "locate"]


def test_image_command_without_an_asset_fails(driver, rpa_row):
    cmds = [{"t": "点击图像", "type": "img", "on": True, "p": ""}]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert "图" in msg


# ── 流程控制 ──────────────────────────────────────────
def test_wait_command_sleeps_for_the_given_seconds(driver, rpa_row):
    cmds = [{"t": "延时等待", "type": "flow", "on": True, "p": "1.5"}]

    ok, _ = run_commands(cmds, rpa_row, driver)

    assert ok is True
    assert driver.calls == [("sleep", 1.5)]


def test_wait_command_with_bad_number_fails(driver, rpa_row):
    cmds = [{"t": "延时等待", "type": "flow", "on": True, "p": "一会儿"}]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert "1.5" in msg or "秒" in msg or "数字" in msg


def test_failure_stops_the_rest_of_the_row(driver, rpa_row):
    cmds = [{"t": "坏指令", "type": "alien", "on": True, "p": ""}, text_cmd("不该执行")]

    ok, _ = run_commands(cmds, rpa_row, driver)

    assert ok is False
    assert driver.kinds() == [], "前一条失败后不应继续"


# ── 切换窗口 ──────────────────────────────────────────────
def test_window_command_activates_the_given_title(driver, rpa_row):
    cmds = [{"t": "切窗口", "type": "win", "on": True, "p": "企业微信"}]

    ok, msg = run_commands(cmds, rpa_row, driver)

    assert (ok, msg) == (True, "")
    assert driver.calls == [("activate_window", "企业微信")]


def test_window_command_without_a_title_fails_instead_of_picking_any_window(driver, rpa_row):
    """标题解析为空时必须失败，不能把「空串」交给驱动。

    空串在真驱动上会匹配到**任意一个**窗口 —— 等于随机切一个窗口再往下按键，
    客服场景下就是话术发给了别人。rpa 里留空会回落到本行关键字，所以正常用法
    碰不到；宏没有行，`row['key']` 就是空串，这条路是真能走到的。
    """
    cmds = [{"t": "切窗口", "type": "win", "on": True, "p": ""}]
    macro_row = {"row_no": 0, "key": "", "values": {}}

    ok, msg = run_commands(cmds, macro_row, driver)

    assert ok is False
    assert "窗口" in msg
    assert driver.calls == [], "标题为空时不该碰任何窗口"
