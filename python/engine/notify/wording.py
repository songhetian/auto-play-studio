"""提醒文案（三层共用的单一真源 · 引擎侧）。

与前��� `src/modules/alerts/alertTone.ts` **一字不差**地维护一份：

  tool → 标题（"图片监控命中"）+ 语气标签（"画面目标出现"）

为什么必须是两份而不能只留一份：引擎是 Python，跑在 Electron 之外，
没法 import TypeScript。唯一能接受的做法是「两边各存一份 + 测试钉住字串相同」——
`tests/test_notify_wording.py` 里的断言就是这个钉子，改一边忘了另一边会红。

统一的是**"这件事叫什么"**；"有多急"（颜色、是否发声、停留多久）仍由 level 决定，
那是各层的样式职责，不在文案里。
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ToolWording:
    """一类功能的人话说法。"""

    title: str
    tone: str


# 与前端 TOOL_PURPOSE 逐条对应。改这里必须同步改 alertTone.ts。
_TOOL_WORDING: dict[str, ToolWording] = {
    # 画面里出现了目标：突发事件
    "monitor": ToolWording("图片监控命中", "画面目标出现"),
    # 客服打了不该说的词：行为问题，要去改话术/复核
    "guard": ToolWording("敏感词命中", "话里有违禁词"),
    # 单张图片识别命中（模板/OCR）
    "image": ToolWording("图片识别命中", "画面出现目标"),
    # 视频帧识别命中
    "video": ToolWording("视频帧命中", "视频里出现目标"),
    # 基于意图快速定位到的画面
    "intent": ToolWording("意图定位结果", "按意图找到画面"),
}

# 认不出来的工具：中性。宁可弱一点，也不要把"不知道是什么"渲染成红色 ——
# 红色一多就等于没红色（与前端 alertTone 的回落策略一致）。
_FALLBACK = ToolWording("命中提醒", "系统提示")


def of_tool(tool: str) -> ToolWording:
    """按工具取说法；不认识的中性回落。"""
    return _TOOL_WORDING.get(tool, _FALLBACK)


@dataclass(frozen=True)
class NotificationText:
    """一条系统通知的标题与正文。"""

    title: str
    body: str


def compose(*, tool: str, level: str, title: str = "", detail: str = "") -> NotificationText:
    """把调用方给的原始命中信息，组装成与人��内横幅一致的文案。

    - 标题**总是**取 `of_tool` 的人话说法，不透传调用方的 title ——
      调用方传的多半是实例名或规则名，直接显示会让用户以为通知说的是别的事。
    - 正文 = 语气标签 + 命中原文。原文为空时不留空正文（Windows 只显示标题，
      空正文看起来像坏了）。
    - 标题与原文重复时不复读一遍。
    """
    w = of_tool(tool)
    raw = (title or "").strip()
    body_detail = (detail or "").strip()

    parts: list[str] = []
    if raw and raw != w.title:
        parts.append(raw)
    if body_detail and body_detail not in parts:
        parts.append(body_detail)

    body = f"{w.tone}：{' · '.join(parts)}" if parts else w.tone
    return NotificationText(title=w.title, body=body)
