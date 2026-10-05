# -*- coding: utf-8 -*-
"""每日汇总播报（工单 04 · ⑥）：文案拼装、发送时机、发送/补发逻辑。

不依赖真实网络与真实 DB：poster 注入假发信器，db 的读取/写入全部 monkeypatch。
期望值手写，不复用 daily_summary 内部实现。
"""
from __future__ import annotations

from datetime import datetime

import pytest

from engine import daily_summary
from engine import db


def _cfg(enabled=True, send_time="18:00", last_sent_date=""):
    return {"enabled": enabled, "send_time": send_time, "last_sent_date": last_sent_date}


def _summary(total=3, high=1, mid=1, low=1, words=None):
    return {
        "total": total,
        "byLevel": {"high": high, "mid": mid, "low": low},
        "byWord": words or [{"word": "加微信", "level": "high", "count": 2}],
    }


def _patch_db(monkeypatch, *, cfg=None, notify=None, summary=None, saves=None, pending=None, set_pending=None):
    monkeypatch.setattr(db, "get_daily_summary_config", lambda: cfg or _cfg())
    monkeypatch.setattr(
        db,
        "get_notify_config",
        lambda: notify if notify is not None else {"webhook": {"url": "http://hook", "kind": "wecom"}},
    )
    monkeypatch.setattr(db, "summarize_violations", lambda f=None: summary if summary is not None else _summary())
    saves.clear() if saves is not None else None
    monkeypatch.setattr(db, "save_daily_summary_config", lambda p: (saves.append(p) or _cfg(**p)) if saves is not None else _cfg())
    monkeypatch.setattr(db, "get_pending_summary_dates", lambda: pending or [])
    monkeypatch.setattr(db, "set_pending_summary_dates", lambda d: set_pending.append(d) if set_pending is not None else None)


def test_build_text_empty():
    assert daily_summary.build_daily_summary_text({"total": 0}, "2026-10-05") == "今日（2026-10-05）无违禁词命中。"


def test_build_text_with_counts():
    text = daily_summary.build_daily_summary_text(_summary(), "2026-10-05")
    assert "共 3 次" in text
    assert "高危 1 · 中危 1 · 低危 1" in text
    assert "加微信(2)" in text


def test_next_send_delay_same_day():
    now = datetime(2026, 10, 5, 10, 0, 0)
    # 18:00 还有 8 小时
    assert daily_summary.next_send_delay("18:00", now) == pytest.approx(8 * 3600, abs=1)


def test_next_send_delay_crosses_midnight():
    now = datetime(2026, 10, 5, 19, 0, 0)
    # 已过 18:00，顺延到次日 18:00（约 23 小时）
    assert daily_summary.next_send_delay("18:00", now) == pytest.approx(23 * 3600, abs=1)


def test_send_disabled(monkeypatch):
    _patch_db(monkeypatch, cfg=_cfg(enabled=False))
    assert daily_summary.send_due_summary(today="2026-10-05")["reason"] == "disabled"


def test_send_no_webhook(monkeypatch):
    saves: list = []
    _patch_db(monkeypatch, notify={"webhook": {"url": "", "kind": "wecom"}}, saves=saves)
    res = daily_summary.send_due_summary(today="2026-10-05")
    assert res["reason"] == "no_webhook"
    assert res.get("pending") is None  # 没地址永发不出，不进 pending


def test_send_ok(monkeypatch):
    saves: list = []
    calls: list = []
    _patch_db(monkeypatch, saves=saves)

    def poster(url, body):
        calls.append((url, body))
        return {"ok": True}

    res = daily_summary.send_due_summary(poster=poster, today="2026-10-05")
    assert res["sent"] is True
    assert len(calls) == 1
    # 发出去后记录 last_sent_date
    assert saves and saves[-1].get("last_sent_date") == "2026-10-05"


def test_send_already_sent(monkeypatch):
    _patch_db(monkeypatch, cfg=_cfg(last_sent_date="2026-10-05"))
    res = daily_summary.send_due_summary(today="2026-10-05")
    assert res["reason"] == "already_sent"


def test_send_webhook_failed_goes_pending(monkeypatch):
    saves: list = []
    pending: list = []
    _patch_db(monkeypatch, saves=saves, pending=[], set_pending=pending)

    def poster(url, body):
        raise RuntimeError("网络不通")

    res = daily_summary.send_due_summary(poster=poster, today="2026-10-05")
    assert res["sent"] is False
    assert res["reason"] == "webhook_failed"
    assert res["pending"] is True
    # 标进待补发
    assert pending == [["2026-10-05"]]


def test_retry_sends_and_clears(monkeypatch):
    pending: list = []
    _patch_db(monkeypatch, pending=["2026-10-04", "2026-10-05"], set_pending=pending)
    calls: list = []

    def poster(url, body):
        calls.append(1)
        return {"ok": True}

    res = daily_summary.retry_pending(poster=poster)
    assert res["retried"] == 2
    assert res["sent"] == 2
    assert res["remaining"] == 0
    assert pending == [[]]  # 全发出去了，pending 清空


def test_retry_keeps_failures(monkeypatch):
    pending: list = []
    _patch_db(monkeypatch, pending=["2026-10-04"], set_pending=pending)

    def poster(url, body):
        raise RuntimeError("还是不通")

    res = daily_summary.retry_pending(poster=poster)
    assert res["sent"] == 0
    assert res["remaining"] == 1
    assert pending == [["2026-10-04"]]
