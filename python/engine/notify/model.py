"""通知的「发什么」与「谁来发」。

`NotifyPayload` 是事件与通道之间的契约：事件层把命中写成它，通道只认它 ——
以后加通道（企微/钉钉/飞书/邮件）不需要动事件层，加通道也不需要动事件。

`level` 的取值刻意只有三档（info / warn / alert）：路由按它查，
档位一多「哪些级别走哪些通道」的配置就没法看了。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol, runtime_checkable


@dataclass
class NotifyPayload:
    """一条待发的通知。事件层的产出、所有通道的唯一输入。"""

    title: str
    detail: str = ""
    level: str = "info"
    instance_id: str = ""
    rule_id: str = ""
    matched_by: str = ""
    evidence_path: str = ""
    #: 逐通道结果回填：{通道名: 'ok' | 'fail: 原因'}，由 dispatch 产出
    notified: dict[str, str] = field(default_factory=dict)


@runtime_checkable
class Channel(Protocol):
    """一条通知通道。`send` 抛任何异常都视为发送失败，由 dispatch 统一记下来。"""

    name: str

    def send(self, payload: NotifyPayload) -> None: ...
