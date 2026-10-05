"""Seam：`assist`（知识库速查填入）的执行内核。

填入 = 「激活客服窗口 → 点输入框 → 把话术打进去」这三步的编排。真设备层
（真窗口激活、真键鼠）只人工验收，所以这里注入 `FakeDriver`。

验的是**「会不会把话打给别的客人」**的判据：顺序、焦点落点、空文本、
窗口不在、屏幕互斥、锁一定释放。
"""
from __future__ import annotations

import pytest

from engine import db, screen_lock
from engine.screen_lock import ScreenBusy
from engine.assist.service import NoTarget, Target, fill_saved, fill_text, get_target, save_target
from engine.driver import DriverUnavailable
from tests.helpers import FakeDriver

#: 千牛输入框在屏幕上的位置：左上 (100, 200)，宽 300 高 40 → 中心 (250, 220)
TARGET = Target(window="千牛工作台", x=100, y=200, width=300, height=40)


#: 假装正在跑批的实例，用来占住屏幕
OTHER = "跑批中的实例"


@pytest.fixture(autouse=True)
def _clean_slate():
    """屏幕锁是模块级全局状态、目标是库里的一行 —— 两样都得清干净。

    不清的话「没配过目标」这类用例会被上一个用例存下的目标喂饱，直接失去意义。
    """
    for h in ("assist", OTHER):
        screen_lock.release(h)
    with db.write() as c:
        c.execute("DELETE FROM settings WHERE key='assist'")
    yield
    for h in ("assist", OTHER):
        screen_lock.release(h)


def test_填入一句话_驱动先点输入框中心再打这句话():
    """起手先激活窗口，再点输入框，最后打字。

    顺序不能反：先打字再激活，那串话术就落在了当时恰好在前台的那个窗口里 ——
    客服场景下就是把话术打给了别的客人。
    """
    driver = FakeDriver()

    fill_text("您好，请问需要什么帮助？", TARGET, driver=driver)

    assert driver.kinds() == ["activate_window", "click", "type_text"], "顺序：激活 → 点 → 打"
    assert ("activate_window", "千牛工作台") in driver.calls
    assert ("click", 250, 220) in driver.calls, "要点输入框的正中间，不是左上角"
    assert ("type_text", "您好，请问需要什么帮助？") in driver.calls


def test_窗口不在时一个键鼠动作都不许发生():
    """客服把客户端最小化了 / 关掉了，这时候绝不能「照着老坐标点下去」。

    坐标是绑窗口的：窗口不在，那块矩形底下是桌面或者别的程序。点下去就是
    在别的地方乱点，打得出来的是什么全凭运气。
    """
    driver = FakeDriver(missing_windows={"千牛工作台"})

    with pytest.raises(DriverUnavailable) as err:
        fill_text("您好", TARGET, driver=driver)

    assert "千牛工作台" in str(err.value), "错误里要说清是哪个窗口没找到"
    assert "click" not in driver.kinds(), "窗口不在还想点，正是这条要挡的"
    assert "type_text" not in driver.kinds()


def test_空话术不点也不打_连屏幕都不抢():
    """空文本填进去等于「白抢一次焦点」：把客服正在打的字顶掉了，还什么都没补上。

    所以要在抢屏幕**之前**就拒掉 —— 抢了才发现没内容，客服的输入框已经被顶过了。
    """
    driver = FakeDriver()

    with pytest.raises(ValueError):
        fill_text("   ", TARGET, driver=driver)

    assert driver.calls == [], "空文本一个动作都不该发生"
    assert screen_lock.holder() is None, "空文本不该抢屏幕"


def test_别的实例占着屏幕时拒绝填入_而不是抢鼠标():
    """rpa 正在跑批的时候点「填入」，两套鼠标会打架：它把窗口顶掉焦点，
    这段话术就打进了它刚切过去的窗口。宁可明确拒绝，也不赌。"""
    driver = FakeDriver()
    screen_lock.acquire_or_raise(OTHER)

    with pytest.raises(ScreenBusy) as err:
        fill_text("您好", TARGET, driver=driver)

    assert err.value.holder_id == OTHER, "要指名道姓说清是被谁占着"
    assert driver.calls == [], "没抢到屏幕就一个动作都不该做"


def test_失败也必须把屏幕锁放掉():
    """锁留在手里 = 屏幕永久锁死：后面所有实例都起不来，顾客等着的活儿全停在这。

    两种失败都试：还没碰到输入框（激活失败）、以及已经点完输入框（打字失败）。
    """
    gone = FakeDriver(missing_windows={"千牛工作台"})
    with pytest.raises(DriverUnavailable):
        fill_text("您好", TARGET, driver=gone)
    assert screen_lock.holder() is None, "激活失败后锁没放掉"

    class Exploding(FakeDriver):
        def type_text(self, text: str) -> None:
            raise OSError("输入法卡住了")

    with pytest.raises(OSError):
        fill_text("您好", TARGET, driver=Exploding())
    assert screen_lock.holder() is None, "打字失败后锁没放掉"


# ── 输入框矩形本身 ────────────────────────────────────────────────


def test_目标必须是有面积的矩形_窗口名也不能空():
    """没面积的矩形没有「中心」可点（点出来落在边界那条线上）；窗口名空更糟 ——
    `activate_window("")` 会匹配到随便哪个窗口，等于把话术打在别人的窗口里。"""
    with pytest.raises(ValueError, match="窗口"):
        Target(window="   ", x=0, y=0, width=100, height=20)
    with pytest.raises(ValueError, match="宽高"):
        Target(window="千牛工作台", x=0, y=0, width=0, height=20)
    with pytest.raises(ValueError, match="宽高"):
        Target(window="千牛工作台", x=0, y=0, width=100, height=-5)


def test_副屏在左边时坐标可以是负的():
    """显示器排在主屏左边时 x 就是负的 —— 这是合法的，不该被当成错。"""
    t = Target(window="千牛工作台", x=-1800, y=100, width=200, height=40)

    assert t.center == (-1700, 120)


# ── 目标配置的存取 ────────────────────────────────────────────────


def test_没配过目标时返回空_而不是编一个默认的():
    """默认一个坐标 = 默认往某个位置乱点。宁可是空的，让界面提示去框。"""
    assert get_target() is None


def test_存下来的目标能原样读回():
    save_target(TARGET)

    assert get_target() == TARGET


# ── 一步到位：读目标 + 填入 ────────────────────────────────────────


def test_没框过输入框时提示去框_而不是随便点一下():
    """没框过就没有目标坐标。这时绝不能「照着上次的坐标点」——
    更要紧的是别静默失败：客服点了「填入」什么都没发生，会以为软件坏了。"""
    with pytest.raises(NoTarget) as err:
        fill_saved("您好", driver=FakeDriver())

    assert "框" in str(err.value), "提示里要说清下一步是去框一下"
    assert screen_lock.holder() is None


def test_框过之后填入用的是框下来的那个窗口():
    save_target(TARGET)
    driver = FakeDriver()

    fill_saved("运费由商家承担", driver=driver)

    assert ("activate_window", "千牛工作台") in driver.calls
    assert ("type_text", "运费由商家承担") in driver.calls
