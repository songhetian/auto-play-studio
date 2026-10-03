# -*- coding: utf-8 -*-
"""告警播报协调器（QObject，常驻主线程）。

原实现用 Qt 队列信号从监控线程把事件桥接回主线程，非 Qt 线程触发信号会对
GIL/事件循环造成压力，导致界面卡顿。现改为：

  引擎线程命中 → 只是把消息写进容量为 1 的线程安全队列（绝不触碰 Qt）
  主线程 QTimer(60ms) 轮询队列 → 取到才播报（弹窗 + 播放声音/合成语音）

流程：
  1. drain_hit() 取到命中 → 置 _active
  2. engine.begin_reporting() 暂停引擎轮询（播报期间停止检测）
  3. 右上角弹窗（淡入淡出）+ 播放声音（自定义 mp3/wav 或默认合成语音）
  4. QTimer 按播报时长(默认约7s)结束后 engine.end_reporting() 恢复
恢复后若画面仍在 → 引擎下一轮再命中 → 继续播报；画面消失则自然停播。
"""
import logging
import time

from PyQt5.QtCore import QObject, QTimer

from ..ui.alert_popup import show_alert_popup
from . import sound

_log = logging.getLogger("notic.announcer")

# 单次播报的最低保持时长（毫秒），与弹窗超时一致，也是重复报警的间隔
DEFAULT_HOLD_MS = 10000

# 挂起计数：模态交互（如框选区域）期间禁止触发新播报，避免弹窗/声音叠加到交互里造成卡顿
_suspended = 0


def suspend():
    global _suspended
    _suspended += 1


def resume():
    global _suspended
    if _suspended > 0:
        _suspended -= 1


def is_suspended():
    return _suspended > 0


class Announcer(QObject):
    """轮询引擎命中队列并协调播报与检测恢复，全部在主线程运行。"""

    def __init__(self, config, event_hub=None, engine=None, parent=None):
        super().__init__(parent)
        self.config = config
        self.engine = engine
        self._active = False
        self._report_start_ms = 0.0
        # 命中轮询：主线程定时捞取，避免把任何 Qt 操作放到监控线程
        self._poll = QTimer(self)
        self._poll.setInterval(60)
        self._poll.timeout.connect(self._drain)
        self._poll.start()
        # 播报结束判定
        self._timer = QTimer(self)
        self._timer.setInterval(150)
        self._timer.timeout.connect(self._tick)

    def shutdown(self):
        self._poll.stop()
        self._timer.stop()

    # ---------- 主线程：从队列取命中并播报 ----------
    def _drain(self):
        if self._active:
            return
        if is_suspended():
            # 挂起（如框选区域）不处理，命中留在队列待恢复后再播
            return
        hit = self.engine.drain_hit() if self.engine else None
        if hit is None:
            return
        # 异常隔离护栏：播报侧（弹窗/声音）任何一次抛错都绝不能压死主线程。
        # PyQt 对未捕获异常默认会 abort() 退出，导致"出现一次就整个界面卡死"。
        try:
            self._start_report(hit)
        except Exception:
            _log.exception("播报处理异常（已捕获，不影响主线程）")
            self._active = False
            self._timer.stop()
            try:
                self.engine.end_reporting()
            except Exception:
                pass

    def _start_report(self, hit):
        self._active = True
        self.engine.begin_reporting()
        self._report_start_ms = time.time() * 1000

        if self.config.get("alert.popup_enabled", True):
            # 弹窗延迟到下一轮事件循环，保证 _drain 立即返回，绝不在本次调用里做重活
            def _show_popup():
                try:
                    show_alert_popup(
                        "检测到目标画面", hit.get("message", ""),
                        int(self.config.get("alert.popup_timeout_ms", DEFAULT_HOLD_MS)))
                except Exception:
                    _log.exception("弹窗显示异常（已捕获）")
            QTimer.singleShot(0, _show_popup)

        if self.config.get("alert.play_sound", True):
            try:
                sound.play(self.config.get("alert.sound_file", ""),
                           self.config.get("alert.default_text", "出现目标图片 请查看"),
                           int(self.config.get("alert.text_repeat", 3)))
            except Exception:
                _log.exception("声音播放异常（已捕获）")
        self._timer.start()

    def _tick(self):
        """主线程：达到播报时长且语音已播完后，才恢复检测进入下一轮。
        时长即重报间隔；若语音比间隔长，必须等语音播完——否则新一轮
        报警的声音会叠到旧语音上（用户选 5s 档 + 长语音时尤其明显）。"""
        try:
            hold_ms = int(self.config.get("alert.popup_timeout_ms", DEFAULT_HOLD_MS))
            elapsed = time.time() * 1000 - self._report_start_ms
            if elapsed < hold_ms:
                return
            if sound.is_playing():
                return
            self._timer.stop()
            self._active = False
            self.engine.end_reporting()
        except Exception:
            _log.exception("播报恢复检测异常（已捕获）")
            self._timer.stop()
            self._active = False
            try:
                self.engine.end_reporting()
            except Exception:
                pass