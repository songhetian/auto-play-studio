# -*- coding: utf-8 -*-
"""按键精灵指令库扩充。

原来只有 5 种指令（窗口/文本/按键/图像/延时），能做的事情太���。
这里定义扩充后的指令语义 —— 每条都是「配置里怎么写」与「落到哪个驱动原语」的对应关系，
全部用假驱动验证，不真动鼠标。
"""
from __future__ import annotations

import pytest

from engine.commands import run_commands
from tests.helpers import FakeDriver


@pytest.fixture
def driver():
    return FakeDriver()


def cmd(kind: str, p: str = "", name: str = "指令", **extra) -> dict:
    return {"t": name, "type": kind, "on": True, "p": p, **extra}


# ── 鼠标：点击（左右中键 / 双击）────────────────────────────

def test_左键点击(driver):
    ok, msg = run_commands([cmd("mouse", "100,200")], {}, driver)
    assert (ok, msg) == (True, "")
    assert driver.calls == [("click", 100, 200)]


def test_右键点击_用于打开菜单(driver):
    ok, _ = run_commands([cmd("mouse", "100,200", button="right")], {}, driver)
    assert ok is True
    assert driver.calls == [("click_button", 100, 200, "right", 1)]


def test_双击(driver):
    ok, _ = run_commands([cmd("mouse", "50,60", clicks=2)], {}, driver)
    assert ok is True
    assert driver.calls == [("click_button", 50, 60, "left", 2)]


def test_中键点击(driver):
    ok, _ = run_commands([cmd("mouse", "10,10", button="middle")], {}, driver)
    assert ok is True
    assert driver.calls == [("click_button", 10, 10, "middle", 1)]


def test_点击坐标必须是两个数字(driver):
    """坐标写错时要在执行前就说清楚，不能真去点 (0,0) 那个像素。"""
    for bad in ["100", "a,b", "", "100,", ",200"]:
        ok, msg = run_commands([cmd("mouse", bad)], {}, driver)
        assert ok is False, bad
        assert "坐标" in msg, f"{bad} 的报错要说人话：{msg}"
        assert driver.calls == [], "坐标非法时不该已经动了鼠标"


def test_负坐标要拒绝_点负数没有意义且多半是填错了(driver):
    ok, msg = run_commands([cmd("mouse", "-5,10")], {}, driver)
    assert ok is False
    assert "坐标" in msg


# ── 鼠标移动与滚轮 ─────────────────────────────────────────

def test_移动鼠标不点击_用于悬停出菜单(driver):
    ok, _ = run_commands([cmd("move", "300,400")], {}, driver)
    assert ok is True
    assert driver.calls == [("move_to", 300, 400, 0)]


def test_滚轮向下翻页(driver):
    """滚轮正负约定：正数向上、负数向下。写反了会让人以为程序有 bug。"""
    ok, _ = run_commands([cmd("scroll", "-3")], {}, driver)
    assert ok is True
    assert driver.calls == [("scroll", -3)]


def test_滚轮格数必须是整数(driver):
    for bad in ["abc", "1.5", ""]:
        ok, msg = run_commands([cmd("scroll", bad)], {}, driver)
        assert ok is False, bad
        assert "滚轮" in msg


# ── 拖拽 ───────────────────────────────────────────────────

def test_拖拽(driver):
    ok, _ = run_commands([cmd("drag", "10,20,300,400")], {}, driver)
    assert ok is True
    assert driver.calls == [("drag_to", 10, 20, 300, 400, 300)]


def test_拖拽要四个数字(driver):
    ok, msg = run_commands([cmd("drag", "10,20,300")], {}, driver)
    assert ok is False
    assert "坐标" in msg


# ── 剪贴板：客服场景最高频 ──────────────────────────────────

def test_复制到剪贴板(driver, rpa_row):
    """从 Excel 取话术贴进聊天框是这个工具最常见的用法。"""
    ok, msg = run_commands([cmd("clip", "复制", text="您好 {客户名称}")], rpa_row, driver)
    assert (ok, msg) == (True, "")
    assert driver.calls == [("copy_to_clipboard", "您好 张三")]


def test_粘贴(driver, rpa_row):
    ok, _ = run_commands([cmd("clip", "粘贴")], rpa_row, driver)
    assert ok is True
    assert driver.calls == [("paste_from_clipboard",)]


def test_剪贴板_一键复制并粘贴(driver, rpa_row):
    ok, _ = run_commands([cmd("clip", "复制并粘贴", text="您好 {客户名称}")], rpa_row, driver)
    assert ok is True
    assert driver.calls == [("copy_to_clipboard", "您好 张三"), ("paste_from_clipboard",)]


def test_剪贴板占位符解析不出要失败_不能把原文贴给客户(driver, rpa_row):
    ok, msg = run_commands([cmd("clip", "复制", text="您好 {客户名}")], rpa_row, driver)
    assert ok is False
    assert "客户名" in msg
    assert driver.calls == [], "出问题就不该碰剪贴板"


def test_未知剪贴板动作要说清支持哪些(driver):
    ok, msg = run_commands([cmd("clip", "清空剪贴板")], {}, driver)
    assert ok is False
    assert "复制" in msg and "粘贴" in msg


# ── 截图 ───────────────────────────────────────────────────

def test_截图到指定路径(driver):
    ok, _ = run_commands([cmd("shot", "C:/tmp/shot.png")], {}, driver)
    assert ok is True
    assert driver.calls == [("screenshot_to", "C:/tmp/shot.png")]


def test_截图路径为空要报错_不然会存到一个叫空字符串的文件(driver):
    ok, msg = run_commands([cmd("shot", "  ")], {}, driver)
    assert ok is False
    assert "路径" in msg


# ── 重复执行（同一段指令跑 N 次）───────────────────────────

def test_重复指令(driver, rpa_row):
    """连点三次提交这类操作很常见，不该让用户复制三份指令。"""
    ok, msg = run_commands([cmd("key", name="回车", key={"combo": ["enter"]}, repeat=3)], rpa_row, driver)
    assert (ok, msg) == (True, "")
    # repeat=3 是「这条指令整体跑 3 遍」（通用能力：点三次提交、发三条消息）
    # 每次都按本指令的语义执行一遍
    assert driver.calls == [("press", ("enter",), 1, 120)] * 3


# ── 等待图片出现（条件等待，与「找到就点图」不同）─────────────

def test_等待图片出现后继续(driver):
    driver.scripted["a1"] = [None, (300, 400)]
    ok, msg = run_commands([cmd("waitimg", name="等图片", image={"assetId": "a1", "timeoutSec": 3})], {}, driver)
    assert (ok, msg) == (True, "")
    # 只定位、不点击：等待指令的语义就是"等到"为止
    assert driver.kinds() == ["locate", "locate"]


def test_等不到图片要失败_不能静默跳过继续往下跑(driver):
    ok, msg = run_commands([cmd("waitimg", name="等图片", image={"assetId": "zz", "timeoutSec": 1})], {}, driver)
    assert ok is False
    assert "zz" in msg


# ── 屏幕信息（供指令里做相对定位）──────────────────────────

def test_读取屏幕尺寸(driver):
    """指令里用不到返回值也没关系：这一步本身是给「记录当前分辨率」用的。"""
    ok, _ = run_commands([cmd("screen", "size")], {}, driver)
    assert ok is True
    assert driver.calls == [("get_screen_size",)]


def test_读取鼠标位置(driver):
    ok, _ = run_commands([cmd("screen", "pos")], {}, driver)
    assert ok is True
    assert driver.calls == [("cursor_position",)]


def test_屏幕动作不认识要说清支持什么(driver):
    ok, msg = run_commands([cmd("screen", "分辨率")], {}, driver)
    assert ok is False
    assert "size" in msg and "pos" in msg


# ── 回归：老指令不能被改坏 ──────────────────────────────────

def test_老指令仍然正常(driver, rpa_row):
    ok, _ = run_commands(
        [cmd("win", "微信"), cmd("text", "您好"), cmd("flow", "1.5")],
        rpa_row,
        driver,
    )
    assert ok is True
    assert driver.kinds() == ["activate_window", "type_text", "sleep"]
