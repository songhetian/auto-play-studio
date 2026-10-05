"""速查填入的执行内核。

业务只有一件事：**把一段话术敲进客服客户端那个已经框好的输入框里，不按发送。**

为什么要点一下再打：客户端窗口被激活后，焦点未必在输入框上（可能停在上一条
消息、或者列表上）。不点就打字，那串字会落到焦点所在的位置 —— 最坏的情况是
被当成了快捷键。所以「点输入框 → 打字」是必须的一对。

为什么不按发送：见 `__init__.py`。
"""
from __future__ import annotations

import json
from dataclasses import dataclass

from engine import db, screen_lock
from engine.driver import Driver, build_driver

#: 屏幕锁的持有者名字。和实例 id 共用一把锁，所以可以用真实实例 id 撞它，
#: 但填入本身不属于任何实例 —— 用一个固定的名字表示「手动填入」。
HOLDER = "assist"


class NoTarget(RuntimeError):
    """还没框定输入框。没有目标就不猜坐标 —— 猜出来的坐标点的位置全凭运气。"""


@dataclass(frozen=True)
class Target:
    """客服客户端的输入框：窗口标题 + 屏幕上那块矩形的左上角与宽高。"""

    window: str
    x: int
    y: int
    width: int
    height: int

    def __post_init__(self) -> None:
        if not (self.window or "").strip():
            raise ValueError("要填的是哪个窗口？窗口名不能为空")
        if self.width <= 0 or self.height <= 0:
            raise ValueError(f"输入框的宽高必须是正数，收到 {self.width}×{self.height}")

    @property
    def center(self) -> tuple[int, int]:
        """要点的那一点。用中心而不是左上角：边框和圆角都在边界上，中心最稳。"""
        return self.x + self.width // 2, self.y + self.height // 2

    def as_dict(self) -> dict:
        return {
            "window": self.window,
            "x": self.x,
            "y": self.y,
            "width": self.width,
            "height": self.height,
        }


def fill_text(text: str, target: Target, *, driver: Driver | None = None) -> None:
    """把 `text` 填进 `target` 指着的输入框。

    屏幕互斥：和 rpa / macro 一样会抢真键鼠，所以先抢屏幕；抢不到就抛
    `ScreenBusy`，让用户去停那个实例，而不是两个实例抢鼠标。
    """
    if not text.strip():
        # 空手抢一次焦点是净损失：客服正在打的字被顶掉，输入框里还是空的。
        # 放在抢屏幕之前，是因为「抢完才发现没内容」更糟。
        raise ValueError("要填入的话术是空的")
    screen_lock.acquire_or_raise(HOLDER)
    try:
        d = driver or build_driver()
        d.activate_window(target.window)
        d.click(*target.center)
        d.type_text(text)
    finally:
        screen_lock.release(HOLDER)


# ── 填入目标的存取 ────────────────────────────────────────────────────
#
# 存 settings 表而不是 instances：填入是「手动动作」，没有进度、没有起停，
# 也不是一个能跑批的实例。多塞一个实例只会让实例列表里多一条永远「空闲」的噪音。

#: settings 表里的 key
SETTINGS_KEY = "assist"


def get_target() -> Target | None:
    """读回框定的输入框；没配过返回 None。

    没配过就是 None，不给默认值 —— 默认坐标等于默认往某个位置乱点。
    """
    rows = db.query("SELECT value_json FROM settings WHERE key=?", (SETTINGS_KEY,))
    if not rows:
        return None
    try:
        raw = json.loads(rows[0]["value_json"]) or {}
        return Target(
            window=str(raw["window"]),
            x=int(raw["x"]),
            y=int(raw["y"]),
            width=int(raw["width"]),
            height=int(raw["height"]),
        )
    except (ValueError, KeyError, TypeError):
        # 存档坏了（手工改过库 / 旧版本写了一半）就当没配过，让界面重新框一次，
        # 而不是抛出去把知识库页整个弄崩
        return None


def save_target(target: Target) -> Target:
    with db.write() as c:
        c.execute(
            "INSERT INTO settings(key, value_json, updated_at) VALUES (?,?,datetime('now','localtime')) "
            "ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
            (SETTINGS_KEY, json.dumps(target.as_dict(), ensure_ascii=False)),
        )
    return target


def fill_saved(text: str, *, driver: Driver | None = None) -> Target:
    """用框定好的输入框填一段话术，返回实际用的目标。

    界面只要给一段文字就行 —— 「填到哪」是配置，不该由每次调用各自决定。
    """
    target = get_target()
    if target is None:
        raise NoTarget("还没框定客服输入框，先点「框选输入框」把它框出来")
    fill_text(text, target, driver=driver)
    return target
