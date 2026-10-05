# -*- coding: utf-8 -*-
"""从目标窗口读取待发文本（UIA 优先，剪贴板降级）。

这是设备层：真机才能验。测试注入 FakeGrabber 替掉整个抓取器。

**为什么需要降级**（实测自 WordGuard/desk）：
京麦、钉钉、飞鸽、千牛原生版这类 **Chromium / 自绘客户端**不暴露标准 UIA 焦点元素，
`AutomationElement.FocusedElement` 永远拿不到输入框 → 纯 UIA 方案对它们完全无效。
剪贴板降级能覆盖这类软件，但**必须显式开关**：读剪贴板是敏感操作，
默认开启会让人不安（用户会看到剪贴板历史被写入）。

策略决策（选哪种降级）抽在 `sensitive.pick_capture_mode`，那里是可测的纯逻辑。
"""
from __future__ import annotations

import time


class GrabResult:
    """一轮抓取的结果。

    ``note`` 非空表示"这轮没读到内容，原因在这里" —— 监控必须把它透出到日志，
    否则用户看到的是"开了但一直没反应"，无从判断是软件不对还是词不对。
    """

    __slots__ = ("text", "mode", "note")

    def __init__(self, text: str = "", mode: str = "none", note: str = ""):
        self.text = text or ""
        self.mode = mode
        self.note = note


class WindowGrabber:
    """按配置持续读取目标窗口的输入框文本。

    ``captureMode``：
      - ``uia``    只用 UIA，读不到就明确报「读不到」
      - ``clipboard`` 只读剪贴板
      - ``auto``   先 UIA，失败自动降级剪贴板（默认）
    """

    def __init__(self, cfg: dict) -> None:
        self.window = str(cfg.get("window") or "").strip()
        self.mode = str(cfg.get("captureMode") or "auto")
        # 降级开关：默认允许，但界面必须把它暴露成可见开关
        self.allow_clipboard = bool(cfg.get("allowClipboard", True))
        self._clip_seen: str | None = None
        self._note = ""
        self._decided = None

    # ── 抓取主循环接口（runner 依赖这三个方法） ──

    def poll(self) -> GrabResult:
        text, note, mode = self._read_once()
        if text:
            # 有内容时**仍然带上降级说明**（首次读到的那一轮）——
            # 用户就是在这轮看到「它读的是剪贴板」的
            return GrabResult(text, mode, note)
        return GrabResult("", mode, note or self._note or "这轮没有读到输入框内容")

    def close(self) -> None:
        pass

    # ── 内部实现 ──

    def _read_once(self) -> tuple[str, str]:
        from .sensitive import pick_capture_mode

        text_uia, ok_uia = self._read_uia()
        decision = pick_capture_mode(
            supports_uia=ok_uia,
            clipboard_readable=self._clipboard_readable(),
            user_opt_in_clipboard=self.allow_clipboard and self.mode != "uia",
        )

        # 降级是**状态变化**，只在变化那一刻说明一次。
        # 每轮都重复「已降级为剪贴板」会把真正的命中日志淹掉；
        # 而完全不说明，用户看到「监控没反应」根本猜不到它读的是剪贴板。
        note = ""
        if decision.mode != self._decided:
            self._decided = decision.mode
            note = decision.hint or decision.reason
        self._note = note

        if decision.mode == "uia":
            return text_uia, note, "uia"
        if decision.mode == "clipboard":
            return self._read_clipboard(), note, "clipboard"
        return "", note, "none"

    def _clipboard_readable(self) -> bool:
        try:
            import win32clipboard  # noqa: F401

            return True
        except Exception:  # noqa: BLE001 —— 没装 pywin32 就是读不了
            return False

    def _read_uia(self) -> tuple[str, bool]:
        """标准 UIA 读焦点输入框。返回 (文本, 是否成功)。"""
        try:
            import comtypes.client  # noqa: F401
        except Exception:  # noqa: BLE001
            self._note = "当前环境没有 UIA 组件（需安装 pywin32 / comtypes）"
            return "", False

        # 真正的 UIA 读取在真机上完成；这里保留接口形状，
        # 让设备层的实现可以整体替换而不影响上层。
        return "", False

    def _read_clipboard(self) -> str:
        """读剪贴板文本。

        连续两轮读到同一个内容就不重复上报 —— 剪贴板不会自己变，
        一直返回旧值等于每轮都"命中一次旧内容"。
        """
        try:
            import win32clipboard
        except Exception:  # noqa: BLE001
            return ""
        try:
            win32clipboard.OpenClipboard()
            try:
                import win32con

                if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                    data = win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
                    text = str(data or "").strip()
                    if text and text == self._clip_seen:
                        return ""
                    self._clip_seen = text
                    return text
            finally:
                win32clipboard.CloseClipboard()
        except Exception:  # noqa: BLE001 —— 剪贴板被别的进程占用是常态，不该让监控崩
            pass
        return ""


def build_grabber(cfg: dict, **_ignored) -> WindowGrabber:
    """构造抓取器。

    runner 通过这个名字取，测试用 monkeypatch 换成 FakeGrabber ——
    设备层不可测是客观现实，把这一层做成唯一的替换点就好。
    """
    return WindowGrabber(cfg)


#: 供 runner 判断"这轮是不是没抓到"用
def sleep_interval(cfg: dict, fallback_ms: int = 800) -> float:
    return max(200, int(cfg.get("pollMs") or fallback_ms)) / 1000.0


__all__ = ["GrabResult", "WindowGrabber", "build_grabber", "sleep_interval", "time"]