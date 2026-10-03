"""跑后汇总：把行台账变成「一句话结论 + 失败原因归类 + 待人工确认清单」。

为什么不是前端 `useMemo` 里算
------------------------------
运行页的统计一直是在前端算的。同一份结论一旦有了第二个消费方（定时日报、
排障、以后可能的导出/推送），两处各算一次迟早会出现「页面说 3 条失败、
导出说 4 条」。所以判定收敛到后端，前端只负责显示。

归类为什么能抹掉引号里的内容
----------------------------
引擎的报错文案一路都用「」把变量括起来（`commands.py` 的
`等待超时，屏幕上没有找到图片「{asset_id}」`、`template.py` 的
`格式化器 date 认不出「{value}」`）。所以「抹掉引号里的内容」不是猜，
是在读这套文案的既定写法 —— 抹掉之后，换个值就换一条的那些行才会并成一类。

抹掉只在真的合并了多行时才做：只有一个成员的类保留原文，
「哪个按钮没找到」正是用户要看的。抹多了会把两类真问题并成一类。
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Iterable

#: 只有「成功」「跳过」算没问题，其余一律算失败 ——
#: 状态以后新增时，漏算比多算危险得多：多算一条，用户去表里看一眼就发现了；
#: 漏算一条会被当成「跑完了没问题」。
_OK_STATUS = "ok"
_SKIP_STATUS = "skip"

#: 默认最多列几类原因，剩下的只报个数
DEFAULT_TOP = 5

#: 成对的「」——引擎的报错文案用它括变量
_QUOTED = re.compile(r"「[^」]*」")

#: 归类是一行一句话的展示，文案里夹着换行会把版面撑坏
_WHITESPACE = re.compile(r"\s+")

#: 引擎没给说明时的占位，不能留空白行 —— 用户会以为界面坏了
_NO_REASON = "未说明原因"


@dataclass(frozen=True)
class ReasonGroup:
    """一类失败原因。`rows` 是它在原表里涉及的行号，按表里的顺序。"""

    label: str
    count: int
    rows: tuple[int, ...]


@dataclass(frozen=True)
class PendingRow:
    """待人工确认的一条：哪一行、主键是什么、引擎当时说了什么（原文）。"""

    row: int
    key: str
    reason: str


@dataclass(frozen=True)
class Summary:
    total: int
    ok: int
    failed: int
    skipped: int
    headline: str
    #: 按条数降序，最多 `top` 类；并列时按第一次出现的先后
    reasons: tuple[ReasonGroup, ...] = ()
    #: 没进 `reasons` 的类数 —— 页面用它写着「另有 N 类」
    other_reasons: int = 0
    #: 待人工确认清单，按行号升序（导出去补单时得跟表里同序）
    pending: tuple[PendingRow, ...] = ()


def summarize(rows: Iterable[dict[str, Any]], top: int = DEFAULT_TOP) -> Summary:
    """把一轮的行记录汇总成一份结论。`rows` 是 `db.query(... rows ...)` 的产物。"""
    ok = 0
    skipped = 0
    failed: list[PendingRow] = []

    for r in rows:
        status = str(r.get("status") or "")
        if status == _OK_STATUS:
            ok += 1
        elif status == _SKIP_STATUS:
            skipped += 1
        else:
            failed.append(
                PendingRow(
                    row=int(r.get("row_no") or 0),
                    key=str(r.get("key_value") or ""),
                    reason=str(r.get("message") or ""),
                )
            )

    failed.sort(key=lambda p: p.row)
    groups, other = _group_reasons(failed, top)

    return Summary(
        total=ok + skipped + len(failed),
        ok=ok,
        failed=len(failed),
        skipped=skipped,
        headline=_headline(ok + skipped + len(failed), ok, len(failed), skipped),
        reasons=groups,
        other_reasons=other,
        pending=tuple(failed),
    )


def _flatten(text: str) -> str:
    return _WHITESPACE.sub(" ", text).strip()


def _group_reasons(pending: list[PendingRow], top: int) -> tuple[tuple[ReasonGroup, ...], int]:
    buckets: dict[str, list[int]] = {}
    first_wording: dict[str, str] = {}
    for item in pending:
        flat = _flatten(item.reason)
        template = _QUOTED.sub("「…」", flat)
        # dict 的插入顺序就是「第一次出现的先后」，并列时的次序靠它定下来
        buckets.setdefault(template, []).append(item.row)
        first_wording.setdefault(template, flat)

    ranked = sorted(buckets.items(), key=lambda kv: -len(kv[1]))
    out = [
        ReasonGroup(
            # 只有一个成员的类别抹变量：「哪个按钮没找到」正是用户要看的
            label=(template if len(rows) > 1 else first_wording[template]) or _NO_REASON,
            count=len(rows),
            rows=tuple(rows),
        )
        for template, rows in ranked
    ]
    return tuple(out[:top]), max(len(out) - top, 0)


def _headline(total: int, ok: int, failed: int, skipped: int) -> str:
    if total == 0:
        return "本次没有执行任何行"
    if failed == 0 and skipped == 0:
        return f"本次共 {total} 行，全部成功"

    parts = []
    if ok:
        parts.append(f"成功 {ok}")
    if failed:
        parts.append(f"失败 {failed}")
    if skipped:
        parts.append(f"跳过 {skipped}")
    return f"本次共 {total} 行，" + "、".join(parts)


def to_payload(result: Summary) -> dict[str, Any]:
    """转成前端读的那套 camelCase —— 转换只在 `engine` 这一侧写一次。

    分成两处写的话，页面不报错、汇总块一片空白，排查要翻两边。
    """
    return {
        "total": result.total,
        "ok": result.ok,
        "failed": result.failed,
        "skipped": result.skipped,
        "headline": result.headline,
        "reasons": [{"label": g.label, "count": g.count, "rows": list(g.rows)} for g in result.reasons],
        "otherReasons": result.other_reasons,
        "pending": [{"row": p.row, "key": p.key, "reason": p.reason} for p in result.pending],
    }
