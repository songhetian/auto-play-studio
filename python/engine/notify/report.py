"""命中 → 通知的接线（工单 02 · S3）。

「命中了怎么通知人」只有这一个入口：记事件 → 组 payload → `deliver` → 结果写回事件。
通道列表与路由默认从通知配置来，测试里注入假通道即可。

两条不能破的规矩：
- **通道炸了不影响记录**：事件先落库，通知只是附带的；失败原因记进 `notified`。
- **结果认准这一条**：`notified` 只写给本次产生的事件 id。
"""
from __future__ import annotations

from typing import Mapping, Sequence

from .dispatch import deliver
from .model import Channel, NotifyPayload
from .. import db


def report_hit(
    *,
    instance_id: str,
    tool: str,
    rule_id: str = "",
    matched_by: str = "image",
    level: str = "alert",
    title: str = "",
    detail: str = "",
    similarity: "float | None" = None,
    rect: "list[int] | None" = None,
    channels: "Sequence[Channel] | None" = None,
    routing: "Mapping[str, Sequence[str]] | None" = None,
) -> int:
    """记一次命中并把通知发出去，返回事件 id。

    `channels` / `routing` 不传就读通知配置（真机路径）；传了就是注入（测试路径）。
    """
    event_id = db.record_hit_event(
        instance_id=instance_id,
        tool=tool,
        rule_id=rule_id,
        matched_by=matched_by,
        level=level,
        title=title,
        detail=detail,
        similarity=similarity,
        rect=rect,
    )

    cfg = db.get_notify_config()
    wanted = routing if routing is not None else cfg["routing"]
    targets = list(channels) if channels is not None else build_channels(cfg)

    notified = deliver(
        NotifyPayload(
            title=title,
            detail=detail,
            level=level,
            instance_id=instance_id,
            rule_id=rule_id,
            matched_by=matched_by,
        ),
        targets,
        wanted,
    )
    if notified:
        db.set_hit_notified(event_id, notified)
    return event_id


def build_channels(cfg: "dict | None" = None, poster=None) -> list[Channel]:
    """按配置构造当前启用的通道。

    停用的通道根本不进列表 —— 让「停用」在分发器里靠路由二次判断，
    等于同一件事两块开关。webhook 启用了却没填地址也不进列表：
    否则每次命中都往库里记一条「地址没填」的失败，真正的失败反而被淹掉。
    """
    from .desktop import DesktopChannel
    from .webhook import WebhookChannel

    cfg = cfg if cfg is not None else db.get_notify_config()
    enabled = cfg.get("channels", {})
    out: list[Channel] = []
    if enabled.get("desktop"):
        out.append(DesktopChannel())
    if enabled.get("webhook"):
        wh = cfg.get("webhook") or {}
        if wh.get("url"):
            out.append(WebhookChannel(url=wh["url"], kind=wh.get("kind", "wecom"), poster=poster))
    return out
