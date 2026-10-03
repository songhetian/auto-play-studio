"""IM 机器人 webhook 通道（工单 02 · S5）。

客服团队在企微/钉钉/飞书里，命中要能进群 —— 桌面通知只在电脑前有用。

三家的消息结构对外是**硬契约**（发错结构对方直接不显示，且不报错），
所以 `build_webhook_body` 单独成一个纯函数，可以对着各家文档逐字测。

真发信走网络（设备层），测试注入 poster。
用 stdlib 的 urllib 而不是 requests：引擎要被 PyInstaller 打成 sidecar，
少一个第三方依赖就少一处 hidden-import 的坑。
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Callable

from .model import NotifyPayload

#: 三家的消息类型标记，写错一个字对方就不显示
WEBHOOK_KINDS = ("wecom", "dingtalk", "feishu")


def _markdown(payload: NotifyPayload) -> str:
    head = f"**{payload.title}**"
    return f"{head}\n{payload.detail}" if payload.detail else head


def build_webhook_body(kind: str, payload: NotifyPayload) -> dict:
    """按机器人类型组消息体。不认识的类型直接报错 —— 宁可发不出去，也不发一堆对方解析不了的东西。"""
    if kind == "wecom":
        return {"msgtype": "markdown", "markdown": {"content": _markdown(payload)}}
    if kind == "dingtalk":
        return {
            "msgtype": "markdown",
            "markdown": {"title": payload.title, "text": _markdown(payload)},
            "at": {"isAtAll": False},
        }
    if kind == "feishu":
        text = f"{payload.title}\n{payload.detail}" if payload.detail else payload.title
        return {"msg_type": "text", "content": {"text": text}}
    raise ValueError(f"不支持的机器人类型：{kind}（可选 {'/'.join(WEBHOOK_KINDS)}）")


def post_json(url: str, body: dict, timeout: float = 5.0) -> dict:
    """真发信（设备层：走网络）。失败抛异常，由 dispatch 统一记成 `fail: 原因`。"""
    req = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


class WebhookChannel:
    """IM 机器人通道。`poster` 可注入（测试用假发信器）。"""

    name = "webhook"

    def __init__(
        self,
        url: str,
        kind: str = "wecom",
        poster: "Callable[[str, dict], dict] | None" = None,
    ) -> None:
        self.url = url
        self.kind = kind
        self._post = poster or post_json

    def send(self, payload: NotifyPayload) -> None:
        if not self.url:
            raise ValueError("webhook 地址没填")
        self._post(self.url, build_webhook_body(self.kind, payload))
