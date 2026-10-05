"""Seam：`assist` 的 HTTP 层（/api/assist）。

这里验的是**前端拿到的契约**：字段名、状态码、以及「失败时用户看到的那句话」。
坐标运算和屏幕锁的语义在 `test_assist_fill.py` 里验过了，这里不重复。

`build_driver` 用 monkeypatch 换掉（和 `test_guard_runner` 里换 `build_grabber` 一个路子）：
真驱动在无桌面环境起不来，而这一层要验的本来也不是键鼠本身。
"""
from __future__ import annotations

import pytest

from engine import db, screen_lock
from engine.assist import service
from tests.helpers import FakeDriver, rpa_cfg

TARGET = {"window": "千牛工作台", "x": 100, "y": 200, "width": 300, "height": 40}


@pytest.fixture(autouse=True)
def _clean_slate():
    """目标存在库里、屏幕锁是全局状态 —— 两样都要清，否则用例之间互相喂数据。"""
    screen_lock.release("assist")
    with db.write() as c:
        c.execute("DELETE FROM settings WHERE key='assist'")
    yield
    screen_lock.release("assist")


def test_没框过输入框时目标为空(client):
    """空的就回空的，不给默认坐标 —— 默认坐标等于默认往某个位置乱点。"""
    r = client.get("/api/assist/target")

    assert r.status_code == 200
    assert r.json() == {"target": None}


def test_框选结果存下来后能读回(client):
    r = client.put("/api/assist/target", json=TARGET)

    assert r.status_code == 200
    assert r.json()["target"] == TARGET
    assert client.get("/api/assist/target").json()["target"] == TARGET


def test_宽高为零的矩形被拒绝_它没有中心可点(client):
    r = client.put("/api/assist/target", json={**TARGET, "width": 0})

    assert r.status_code == 400
    assert "宽高" in r.json()["detail"]


def test_窗口名为空被拒绝_否则会激活到随便哪个窗口(client):
    r = client.put("/api/assist/target", json={**TARGET, "window": "  "})

    assert r.status_code == 400
    assert "窗口" in r.json()["detail"]


def test_填空白话术被拒绝(client, monkeypatch):
    """空白话术不该真的去点一下：点完只是把客服正在打的字顶掉了，什么都没补上。"""
    client.put("/api/assist/target", json=TARGET)
    driver = FakeDriver()
    monkeypatch.setattr(service, "build_driver", lambda: driver)

    r = client.post("/api/assist/fill", json={"text": "   "})

    assert r.status_code == 400
    assert driver.calls == []


def test_没框过就点填入_回一句人话让用户去框(client):
    r = client.post("/api/assist/fill", json={"text": "您好"})

    assert r.status_code == 400
    assert "框" in r.json()["detail"]


def test_填入成功_把话术打进框下来的那个窗口(client, monkeypatch):
    client.put("/api/assist/target", json=TARGET)
    driver = FakeDriver()
    monkeypatch.setattr(service, "build_driver", lambda: driver)

    r = client.post("/api/assist/fill", json={"text": "运费由商家承担"})

    assert r.status_code == 200
    assert r.json() == {"filled": True, "window": "千牛工作台"}
    assert driver.kinds() == ["activate_window", "click", "type_text"]
    assert ("click", 250, 220) in driver.calls


def test_屏幕被别的实例占着时回409并指名道姓(client, make_instance, monkeypatch):
    """只说「冲突」等于让用户自己去猜该停哪一个 —— 要说清是被谁占着。"""
    iid = make_instance("rpa", rpa_cfg("x.xlsx"), name="跑批任务A")
    client.put("/api/assist/target", json=TARGET)
    driver = FakeDriver()
    monkeypatch.setattr(service, "build_driver", lambda: driver)
    screen_lock.acquire_or_raise(iid)
    try:
        r = client.post("/api/assist/fill", json={"text": "您好"})
    finally:
        screen_lock.release(iid)

    assert r.status_code == 409
    assert "跑批任务A" in r.json()["detail"]
    assert driver.calls == [], "没抢到屏幕就不该动键鼠"


def test_窗口候选去重排序_空白标题不占位(client, monkeypatch):
    """给用户挑的列表：重复的、空标题的窗口混在里面，等于让他自己去撞运气。"""
    from engine import window_control

    monkeypatch.setattr(
        window_control,
        "list_windows",
        lambda: [(1, "千牛工作台"), (2, "京麦"), (3, "千牛工作台"), (4, "   ")],
    )

    r = client.get("/api/assist/windows")

    assert r.status_code == 200
    assert r.json()["windows"] == ["京麦", "千牛工作台"]


def test_枚举不了窗口时回空列表并说明原因(client, monkeypatch):
    """非 Windows 上枚举窗口必然失败 —— 这时要老实说，让前端退回手填，
    而不是把一个永远空的下拉框摆在那里让人以为软件坏了。"""
    from engine import window_control
    from engine.driver import DriverUnavailable

    def boom():
        raise DriverUnavailable("窗口控制目前只支持 Windows")

    monkeypatch.setattr(window_control, "list_windows", boom)

    r = client.get("/api/assist/windows")

    assert r.status_code == 200
    body = r.json()
    assert body["windows"] == []
    assert "Windows" in body["reason"]
