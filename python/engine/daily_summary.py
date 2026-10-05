"""每日违禁词汇总播报（工单 04 · ⑥）。

到点把当天违禁词命中汇总推到 IM webhook —— 复用「通知」里已经配好的机器人地址，
不另起一套配置。断网不发丢：发不出去的日期进 pending，后台定时补发，直到发出为止。

分两层：
- 纯函数（`build_daily_summary_text` / `next_send_delay`）：拼文案、算下次发送的等待秒数，
  不碰网络、不碰 DB，便于单测。
- 副作用函数（`send_due_summary` / `retry_pending`）：组 payload、走 webhook、记 last_sent / pending；
  poster 可注入，测试用假发信器覆盖真网络。
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime, timedelta
from typing import Callable

from . import db
from .notify.model import NotifyPayload
from .notify.webhook import WebhookChannel

#: 后台补发轮询间隔（秒）。webhook 是「尽力发」，断网期间靠它兜底，
#: 不必太密 —— 半小时一次足够让汇总在当天晚些时候网络恢复时补上。
RETRY_INTERVAL_SECONDS = 1800


def build_daily_summary_text(summary: dict, day: str) -> str:
    """把聚合结果拼成一段人能一眼看完的播报。纯函数，便于单测。"""
    total = int(summary.get("total", 0) or 0)
    if total == 0:
        return f"今日（{day}）无违禁词命中。"
    by_level = summary.get("byLevel", {}) or {}
    lines = [
        f"今日（{day}）共 {total} 次违禁词命中：",
        f"- 高危 {by_level.get('high', 0)} · 中危 {by_level.get('mid', 0)} · 低危 {by_level.get('low', 0)}",
    ]
    by_word = summary.get("byWord", []) or []
    if by_word:
        top = "、".join(f"{w['word']}({w['count']})" for w in by_word[:5])
        lines.append(f"- 高频词：{top}")
    return "\n".join(lines)


def _post_summary(text: str, poster: "Callable[[str, dict], dict] | None" = None) -> bool:
    """复用到期的 IM webhook；没配地址或发失败都返回 False。"""
    notify = db.get_notify_config()
    wh = notify.get("webhook") or {}
    url = wh.get("url")
    if not url:
        return False
    channel = WebhookChannel(url=url, kind=wh.get("kind", "wecom"), poster=poster)
    try:
        channel.send(NotifyPayload(title="今日违禁词播报", detail=text, level="info"))
        return True
    except Exception:  # noqa: BLE001
        return False


def _webhook_configured() -> bool:
    return bool((db.get_notify_config().get("webhook") or {}).get("url"))


def send_due_summary(poster: "Callable[[str, dict], dict] | None" = None, today: "str | None" = None) -> dict:
    """发今天的汇总（如果启用且今天还没发）。返回结果给接口 / 后台统一消费。

    四种结局：
    - disabled：没开功能，不发；
    - no_webhook：通知里没配机器人地址，发不出去，也不进 pending（永发不出，留着没意义）；
    - already_sent：今天发过了，幂等跳过；
    - webhook_failed：网络挂了，标 pending 等补发。
    """
    cfg = db.get_daily_summary_config()
    if not cfg.get("enabled"):
        return {"sent": False, "reason": "disabled"}
    day = today or date.today().isoformat()
    if cfg.get("last_sent_date") == day:
        return {"sent": False, "reason": "already_sent", "date": day}
    if not _webhook_configured():
        return {"sent": False, "reason": "no_webhook", "date": day}

    summary = db.summarize_violations({"date_from": day, "date_to": day})
    text = build_daily_summary_text(summary, day)
    if _post_summary(text, poster):
        db.save_daily_summary_config({"last_sent_date": day})
        return {"sent": True, "date": day, "text": text}

    # 离线：标待补发，绝不静默吞掉
    pending = db.get_pending_summary_dates()
    if day not in pending:
        db.set_pending_summary_dates([*pending, day])
    return {"sent": False, "reason": "webhook_failed", "date": day, "pending": True}


def retry_pending(poster: "Callable[[str, dict], dict] | None" = None) -> dict:
    """补发之前没发出去的日期。发出去的清掉，仍失败的留着下次再试。"""
    pending = db.get_pending_summary_dates()
    if not pending:
        return {"retried": 0, "sent": 0, "remaining": 0}
    still: list[str] = []
    sent = 0
    for d in pending:
        summary = db.summarize_violations({"date_from": d, "date_to": d})
        text = build_daily_summary_text(summary, d)
        if _post_summary(text, poster):
            sent += 1
            db.save_daily_summary_config({"last_sent_date": d})
        else:
            still.append(d)
    db.set_pending_summary_dates(still)
    return {"retried": len(pending), "sent": sent, "remaining": len(still)}


def next_send_delay(send_time: str, now: "datetime | None" = None) -> float:
    """到下一个发送点的秒数（供后台循环 sleep）。纯函数，便于单测。

    `send_time` 形如 `18:00`；格式异常兜底到 18:00，避免循环算出负数 sleep。
    """
    now = now or datetime.now()
    try:
        hh, mm = (int(x) for x in send_time.split(":"))
        if not (0 <= hh <= 23 and 0 <= mm <= 59):
            raise ValueError
    except (ValueError, AttributeError):
        hh, mm = 18, 0
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return (target - now).total_seconds()


async def run_scheduler() -> None:
    """后台调度：每天到点发今天的汇总，并发掉积压的 pending。"""
    while True:
        try:
            cfg = db.get_daily_summary_config()
            await asyncio.sleep(next_send_delay(cfg["send_time"]))
            send_due_summary()
            retry_pending()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            await asyncio.sleep(60)


async def run_retry() -> None:
    """后台补发：定期把 pending 里没发出去的日期再试一次。"""
    while True:
        try:
            await asyncio.sleep(RETRY_INTERVAL_SECONDS)
            retry_pending()
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            await asyncio.sleep(60)
