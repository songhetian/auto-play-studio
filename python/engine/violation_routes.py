# -*- coding: utf-8 -*-
"""违规事件检索与聚合（挂在 /api/violations 下，工单 04 · ④）。

路由只做参数透传与错误码转换；业务全在 `db` 层（record_violation /
list_violations / summarize_violations）。筛选轴对齐主管抽检：词 / 危级 / 坐席 / 时间。
"""
from __future__ import annotations

from fastapi import APIRouter

from . import db

router = APIRouter(prefix="/violations", tags=["violations"])


@router.get("")
def list_violations(
    word: str = "",
    level: str = "",
    seat: str = "",
    dateFrom: str = "",
    dateTo: str = "",
    limit: int = 500,
) -> list[dict]:
    return db.list_violations(
        word=word or None,
        level=level or None,
        seat=seat or None,
        date_from=dateFrom or None,
        date_to=dateTo or None,
        limit=limit,
    )


@router.get("/summary")
def summary(
    word: str = "",
    level: str = "",
    seat: str = "",
    dateFrom: str = "",
    dateTo: str = "",
) -> dict:
    """聚合：总数 + 按词计数 + 按危级计数。统计页直接消费。"""
    return db.summarize_violations(
        {
            "word": word or None,
            "level": level or None,
            "seat": seat or None,
            "date_from": dateFrom or None,
            "date_to": dateTo or None,
        }
    )
