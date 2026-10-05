# -*- coding: utf-8 -*-
"""敏感词监控实例（guard）的运行行为。

抓取器（UIA / 剪贴板）是设备层，CI 里没有桌面，所以测试注入 **FakeGrabber**：
整条链路「抓文本 → 匹配 → 落命中事件」都在测试里真跑，只把最外层的抓取替换掉。
这正是 runner 里 `grabber` 可注入的原因。
"""
from __future__ import annotations

import pytest

from engine import db


class FakeGrabber:
    """按脚本吐出文本的假抓取器。

    scripted 用完就重复最后一条 —— 监控是长驻循环，
    用「读完就返回空」会让测试看起来命中了一次就没了。

    返回类型与真实抓取器**完全一致**（``GrabResult``）：接口形状不统一时，
    runner 里的分支就是靠猜的，两边改一边就会静默坏掉。
    """

    def __init__(self, scripted: list[str] | None = None, mode: str = "uia"):
        self.scripted = list(scripted or [""])
        self.mode = mode
        self.calls = 0
        self.texts: list[str] = []

    def poll(self):
        from engine.text_grabber import GrabResult

        self.calls += 1
        text = self.scripted[min(self.calls - 1, len(self.scripted) - 1)]
        self.texts.append(text)
        # 抓不到内容时要给出原因：真实抓取器在读不到时会说明为什么
        note = "" if text else "这轮没有读到输入框内容（测试注入的抓取器）"
        return GrabResult(text, self.mode, note)

    def close(self) -> None:
        pass


def guard_cfg(**over) -> dict:
    """guard 实例的真实配置形状。

    注意工具参数是**嵌套在 guard 下**的（`config.guard.levels`），与窗口同级 ——
    这与 rpa 的 `config.rpa.*` 是同一套约定。测试配置必须照真实形状写，
    否则"测试通过、真机不生效"（键放错层级，代码读不到默认值）。
    """
    cfg = {
        "tool": "guard",
        "window": "企业微信",
        "hotkeys": {"run": "F8", "toggle": "F9", "stop": "F10", "scope": "window"},
        "guard": {
            "captureMode": "auto",
            "allowClipboard": True,
            "levels": ["high", "mid", "low"],
            "pollMs": 200,
        },
        "alertSound": {"preset": "voice", "text": "", "customPath": ""},
    }
    guard_over = over.pop("guard", None)
    cfg.update(over)
    if guard_over:
        cfg["guard"].update(guard_over)
    return cfg


@pytest.fixture(autouse=True)
def clean_words():
    """词库是用户数据，不清会互相污染。"""
    with db.write() as c:
        c.execute("DELETE FROM sensitive_word")
    yield
    with db.write() as c:
        c.execute("DELETE FROM sensitive_word")
        c.execute("DELETE FROM hit_events")


@pytest.fixture
def words():
    """建词库。返回按词取 id 的函数。"""
    from engine.sensitive_words import service

    return lambda w, level="mid": service.add_word(w, level)["id"]


def _hits(iid: str) -> list:
    return db.query("SELECT * FROM hit_events WHERE instance_id=? ORDER BY id", (iid,))


def test_文本命中违禁词要落命中事件(make_instance, words, wait_status, monkeypatch):
    """这是监控工具存在的全部意义：命中了必须让人知道。"""
    words("退款政策", "high")
    iid = make_instance("guard", guard_cfg())

    from engine import runner as runner_mod

    grabber = FakeGrabber(["亲，退款政策我给您看一下"])
    monkeypatch.setattr(runner_mod, "build_grabber", lambda cfg, **kw: grabber)

    r = runner_mod.InstanceRunner(iid)
    assert r.start()
    # 跑到抓够一次就停：轮询是死循环，靠 stop 从外部打断
    deadline = 0
    while deadline < 50 and not _hits(iid):
        deadline += 1
        import time as _t
        _t.sleep(0.1)
    r.stop()
    wait_status(iid, {"idle"}, 10)

    hs = _hits(iid)
    assert len(hs) == 1, "应落一条命中事件"
    assert hs[0]["tool"] == "guard"
    assert hs[0]["matched_by"] == "keyword"
    assert hs[0]["level"] == "alert"
    assert "退款政策" in hs[0]["title"]


def test_同一句话不重复报(make_instance, words, wait_status, monkeypatch):
    """客服正在输入时同一句会连续出现好几轮；每轮都弹窗等于把告警变成噪音。"""
    words("退款政策", "high")
    iid = make_instance("guard", guard_cfg())

    from engine import runner as runner_mod

    grabber = FakeGrabber(["退款政策"] * 20)
    monkeypatch.setattr(runner_mod, "build_grabber", lambda cfg, **kw: grabber)

    r = runner_mod.InstanceRunner(iid)
    r.start()
    import time as _t
    _t.sleep(1.5)
    r.stop()
    wait_status(iid, {"idle"}, 10)

    assert len(_hits(iid)) == 1, "同一句持续出现只应报一次"


def test_没有命中时不产生事件(make_instance, words, wait_status, monkeypatch):
    """反过来的方向同样要钉住：不能因为「轮询到文本」就报事件。"""
    words("退款政策", "high")
    iid = make_instance("guard", guard_cfg())

    from engine import runner as runner_mod

    grabber = FakeGrabber(["您好，很高兴为您服务"])
    monkeypatch.setattr(runner_mod, "build_grabber", lambda cfg, **kw: grabber)

    r = runner_mod.InstanceRunner(iid)
    r.start()
    import time as _t
    _t.sleep(1.2)
    r.stop()
    wait_status(iid, {"idle"}, 10)

    assert _hits(iid) == []


def test_停用的词不参与匹配(make_instance, words, wait_status, monkeypatch):
    """词库的启用开关必须真的生效 —— 否则「先停用观察」这个用法是假的。"""
    from engine.sensitive_words import service

    wid = service.add_word("退款政策", "high")["id"]
    service.set_enabled(wid, False)
    iid = make_instance("guard", guard_cfg())

    from engine import runner as runner_mod

    grabber = FakeGrabber(["退款政策"])
    monkeypatch.setattr(runner_mod, "build_grabber", lambda cfg, **kw: grabber)

    r = runner_mod.InstanceRunner(iid)
    r.start()
    import time as _t
    _t.sleep(1.2)
    r.stop()
    wait_status(iid, {"idle"}, 10)

    assert _hits(iid) == []


def test_只启用高危时中危不告警(make_instance, words, wait_status, monkeypatch):
    """「只想盯最严重的」是常见配置，必须真的只报高危。"""
    words("最", "low")
    words("加微信", "high")
    iid = make_instance("guard", guard_cfg(guard={"levels": ["high"]}))

    from engine import runner as runner_mod

    grabber = FakeGrabber(["你这个最便宜的"])
    monkeypatch.setattr(runner_mod, "build_grabber", lambda cfg, **kw: grabber)

    r = runner_mod.InstanceRunner(iid)
    r.start()
    import time as _t
    _t.sleep(1.2)
    r.stop()
    wait_status(iid, {"idle"}, 10)

    assert _hits(iid) == []


def test_抓不到内容时要说明原因而不是静默(make_instance, wait_status, monkeypatch):
    """UIA 读不到 + 不允许剪贴板 → 用户必须知道为什么一直没反应。"""
    iid = make_instance("guard", guard_cfg(guard={"allowClipboard": False}))

    from engine import runner as runner_mod

    grabber = FakeGrabber([""], mode="none")
    monkeypatch.setattr(runner_mod, "build_grabber", lambda cfg, **kw: grabber)

    r = runner_mod.InstanceRunner(iid)
    r.start()
    import time as _t
    _t.sleep(1.0)
    r.stop()
    wait_status(iid, {"idle"}, 10)

    logs = db.query("SELECT message FROM logs WHERE instance_id=? ORDER BY id", (iid,))
    text = " ".join(x["message"] for x in logs)
    assert "抓" in text, "应在运行详情里说明抓不到内容的原因"

def test_降级到剪贴板时必须说明原因(monkeypatch):
    """京麦这类自绘软件会走剪贴板路径，用户必须知道 —— 否则「它到底读的是哪儿」无从判断。

    降级是**状态变化**：只在变化那一刻说一次，之后读到内容就不再重复刷屏。
    """
    from engine.text_grabber import GrabResult, WindowGrabber

    g = WindowGrabber({"window": "京麦", "captureMode": "auto", "allowClipboard": True})
    # UIA 读不到、剪贴板可读 → 应降级
    monkeypatch.setattr(g, "_read_uia", lambda: ("", False))
    monkeypatch.setattr(g, "_clipboard_readable", lambda: True)
    monkeypatch.setattr(g, "_read_clipboard", lambda: "加了微信")

    first = g.poll()
    assert first.mode == "clipboard"
    assert first.text == "加了微信"
    # 降级原因要透出来
    assert "降级" in first.note or "剪贴板" in first.note
