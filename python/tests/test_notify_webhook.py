"""Seam：IM 机器人 webhook 通道（工单 02 · S5）。

客服团队在企微/钉钉/飞书里，命中要能进群 —— 桌面通知只在电脑前有用。

三家的消息格式各不相同且**对外是硬契约**（发错结构对方直接不显示），
所以 `build_webhook_body` 是独立 seam，期望值按各家公开文档手写。

真实发信是设备层（网络），测试注入 poster。
"""
from __future__ import annotations

import pytest

from engine import db
from engine import main as main_mod
from engine.notify import deliver
from engine.notify.model import NotifyPayload


@pytest.fixture(autouse=True)
def _clean_notify_config():
    """通知配置是全局一行，前后都清，别留给下一个文件。"""
    _wipe()
    yield
    _wipe()


def _wipe():
    with db.write() as c:
        c.execute("DELETE FROM settings WHERE key='notify'")


@pytest.fixture
def override_poster():
    """把「测试发送」端点里的真发信器换成假的（依赖覆盖必须挂在 api 子应用上）。"""

    def _use(poster):
        main_mod.api.dependency_overrides[main_mod.webhook_poster] = lambda: poster

    yield _use
    main_mod.api.dependency_overrides.pop(main_mod.webhook_poster, None)


def _payload(title="差评关键词", detail="相似度 0.93") -> NotifyPayload:
    return NotifyPayload(
        title=title, detail=detail, level="alert", instance_id="I1", rule_id="img_a", matched_by="image"
    )


class FakePoster:
    """假发信器：记下 (url, body)，可选地抛异常。"""

    def __init__(self, boom: Exception | None = None) -> None:
        self.boom = boom
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url: str, body: dict) -> dict:
        self.calls.append((url, body))
        if self.boom is not None:
            raise self.boom
        return {"errcode": 0}


def test_wecom_body():
    from engine.notify.webhook import build_webhook_body

    assert build_webhook_body("wecom", _payload()) == {
        "msgtype": "markdown",
        "markdown": {"content": "**差评关键词**\n相似度 0.93"},
    }


def test_dingtalk_body():
    from engine.notify.webhook import build_webhook_body

    assert build_webhook_body("dingtalk", _payload()) == {
        "msgtype": "markdown",
        "markdown": {"title": "差评关键词", "text": "**差评关键词**\n相似度 0.93"},
        "at": {"isAtAll": False},
    }


def test_feishu_body():
    """飞书 text 消息不认 markdown，别给它加 `**`。"""
    from engine.notify.webhook import build_webhook_body

    assert build_webhook_body("feishu", _payload()) == {
        "msg_type": "text",
        "content": {"text": "差评关键词\n相似度 0.93"},
    }


def test_body_without_detail_is_just_the_title():
    """没有 detail 时别留下一个空行。"""
    from engine.notify.webhook import build_webhook_body

    assert build_webhook_body("wecom", _payload(title="只有标题", detail="")) == {
        "msgtype": "markdown",
        "markdown": {"content": "**只有标题**"},
    }


def test_send_posts_to_the_configured_url():
    from engine.notify.webhook import WebhookChannel

    poster = FakePoster()
    ch = WebhookChannel(url="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x", kind="wecom", poster=poster)
    ch.send(_payload())

    assert [c[0] for c in poster.calls] == ["https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x"]
    assert poster.calls[0][1]["msgtype"] == "markdown"
    assert ch.name == "webhook"


def test_unknown_kind_fails_loudly():
    """不认识的类型宁可报失败，也不要发一堆对方解析不了的东西过去。"""
    from engine.notify.webhook import build_webhook_body

    with pytest.raises(ValueError):
        build_webhook_body("slack", _payload())


def test_a_failing_webhook_does_not_stop_the_other_channels():
    from engine.notify.webhook import WebhookChannel

    poster = FakePoster(boom=RuntimeError("网络不通"))
    ch = WebhookChannel(url="https://x", kind="wecom", poster=poster)

    class Ok:
        name = "desktop"
        sent = 0

        def send(self, _p):
            Ok.sent += 1

    ok = Ok()
    result = deliver(_payload(), [ch, ok], {"alert": ["webhook", "desktop"]})

    assert result["webhook"].startswith("fail: 网络不通")
    assert result["desktop"] == "ok", "一个通道炸了不影响其它通道（S1 的分发规矩）"
    assert Ok.sent == 1


def test_default_config_carries_the_webhook_url_and_kind():
    cfg = db.get_notify_config()
    assert cfg["webhook"] == {"url": "", "kind": "wecom"}, "没填地址就是不发，默认别指向任何地方"


def test_build_channels_skips_a_webhook_without_a_url():
    """启用了却没填地址，不能每次命中都往库里记一条「地址没填」的失败。"""
    from engine.notify.report import build_channels

    db.save_notify_config({"channels": {"webhook": True}, "webhook": {"url": ""}})
    assert [c.name for c in build_channels()] == ["desktop"]

    db.save_notify_config({"webhook": {"url": "https://x"}})
    assert [c.name for c in build_channels()] == ["desktop", "webhook"]


def test_test_send_endpoint_reports_per_channel_results(client, override_poster):
    """「测试发送」是为了让用户当场知道地址填得对不对，所以要回逐通道结果。"""
    poster = FakePoster()
    override_poster(poster)
    db.save_notify_config({"channels": {"webhook": True}, "webhook": {"url": "https://x", "kind": "feishu"}})

    r = client.post("/api/settings/notify/test")
    assert r.status_code == 200
    # 「测试发送」绕过级别路由，走所有启用的通道 —— 它验的是通道本身配得对不对
    assert r.json() == {"desktop": "ok", "webhook": "ok"}
    assert poster.calls[0][0] == "https://x"
    assert poster.calls[0][1]["content"]["text"].startswith("测试通知")


def test_a_bad_url_shows_up_as_a_failure_not_a_500(client, override_poster):
    """地址填错了要看到原因，而不是一个 500 —— 用户得知道该改什么。"""
    override_poster(FakePoster(boom=RuntimeError("地址不存在")))
    db.save_notify_config({"channels": {"webhook": True}, "webhook": {"url": "https://bad"}})

    r = client.post("/api/settings/notify/test")
    assert r.status_code == 200
    assert r.json()["webhook"] == "fail: 地址不存在"
