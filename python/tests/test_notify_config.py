"""Seam：通知配置的读写（工单 02 · S3 地基）。

通知配置决定执行（命中后发不发、发到哪），所以落在引擎 SQLite，不进 localStorage。

期望值全部手写；「默认值」这一条是独立真相源 —— 没配过也要有一套能用的，
否则监控命中了却因为没人配过通道而一条通知都不发。
"""
from __future__ import annotations

import pytest

from engine import db


@pytest.fixture(autouse=True)
def _clean_notify_config():
    """配置是全局一行，测试之间会串味 —— 前后都要清，别把值留给下一个文件。"""
    _wipe()
    yield
    _wipe()


def _wipe():
    with db.write() as c:
        c.execute("DELETE FROM settings WHERE key='notify'")


def test_notify_config_has_usable_defaults():
    cfg = db.get_notify_config()
    assert cfg["channels"] == {"desktop": True, "webhook": False}, "桌面通知默认开，webhook 得填了地址才有用"
    assert cfg["routing"]["alert"] == ["desktop"], "要提醒的级别默认走桌面通知"
    assert cfg["routing"]["info"] == [], "普通信息默认不弹，否则监控一跑就刷屏"


def test_notify_config_roundtrip():
    db.save_notify_config(
        {"channels": {"desktop": False, "webhook": False}, "routing": {"alert": [], "warn": [], "info": []}}
    )
    assert db.get_notify_config()["channels"]["desktop"] is False
    assert db.get_notify_config()["routing"]["alert"] == []


def test_partial_save_keeps_the_rest_at_defaults():
    """只改一块不能把别的冲掉 —— 配置页每次只提交当前那一块。"""
    db.save_notify_config({"routing": {"alert": []}})
    cfg = db.get_notify_config()
    assert cfg["routing"]["alert"] == []
    assert cfg["channels"] == {"desktop": True, "webhook": False}, "没提交的 channels 应保持默认"


def test_unknown_level_never_notifies():
    """级别写错时宁可静默，也不要当成「全部通道都发」。"""
    db.save_notify_config({"routing": {"alert": ["desktop"], "warn": [], "info": [], "紧急": ["desktop"]}})
    assert "紧急" not in db.get_notify_config()["routing"], "只认 info / warn / alert 三档"


def test_settings_endpoint_reads_and_writes_notify_config(client):
    assert client.get("/api/settings/notify").json()["channels"]["desktop"] is True

    r = client.put("/api/settings/notify", json={"routing": {"alert": []}})
    assert r.status_code == 200
    assert r.json()["routing"]["alert"] == []

    # 端点写完要真进库，不能只在响应里回显
    assert db.get_notify_config()["routing"]["alert"] == []
    assert client.get("/api/settings/notify").json()["routing"]["alert"] == []
