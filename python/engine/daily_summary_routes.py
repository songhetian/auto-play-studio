"""每日汇总接口（工单 04 · ⑥）：配置、状态、手动触发。

挂在 /api 之下，路径为 /api/notify/daily-summary（+ /send、/retry），与前端 api.ts 对齐。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter

from . import daily_summary
from . import db

router = APIRouter(prefix="/notify/daily-summary", tags=["daily-summary"])


@router.get("")
def get_status() -> dict[str, Any]:
    cfg = db.get_daily_summary_config()
    return {
        "enabled": cfg["enabled"],
        "sendTime": cfg["send_time"],
        "lastSentDate": cfg["last_sent_date"],
        "pending": db.get_pending_summary_dates(),
    }


@router.put("")
def save(body: dict[str, Any]) -> dict[str, Any]:
    allowed = {k: body[k] for k in ("enabled", "send_time", "last_sent_date") if k in body}
    return db.save_daily_summary_config(allowed)


@router.post("/send")
def send_now() -> dict[str, Any]:
    """手动触发今天的汇总（设置页「立即发送」用）。"""
    return daily_summary.send_due_summary()


@router.post("/retry")
def retry() -> dict[str, Any]:
    """手动补发 pending（设置页「重试未发送」用）。"""
    return daily_summary.retry_pending()
