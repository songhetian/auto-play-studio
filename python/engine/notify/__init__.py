"""通知通道（工单 02）。

一次「命中」要走两层才变成一条通知：
  1. `model`    —— 发出去的是什么（payload）与「通道」长什么样（协议）；
  2. `dispatch` —— 这次命中该走哪些通道、失败了怎么记。

分层理由：通道的**实现**（桌面通知 / IM webhook / 邮件）五花八门，
但「按级别路由 + 失败不传染」只有一份，全部收在 dispatch 里。
"""
from engine.notify.dispatch import deliver
from engine.notify.model import Channel, NotifyPayload

__all__ = ["Channel", "NotifyPayload", "deliver"]
