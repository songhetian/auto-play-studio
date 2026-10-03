# -*- coding: utf-8 -*-
"""告警设置对话框：声音文件选择与试听、弹窗开关、默认语音文案。"""
import os

from PyQt5.QtCore import Qt
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QGroupBox,
    QLabel, QLineEdit, QFileDialog, QSpinBox, QPushButton,
    QButtonGroup,
)

from ..core import sound
from .widgets import flat_btn as _flat_btn, ToggleSwitch

BLUE = "#2455D9"

_SOUND_EXTS = (".mp3", ".wav")

# 重报间隔预设档位（秒）：用户不再手动输数字，点档位即生效
HOLD_PRESETS = (5, 10, 30)
HOLD_DEFAULT = 10


def hold_preset_seconds(ms):
    """把任意旧配置的毫秒数吸附到最接近的预设档位（5/10/30 秒）。

    距离并列时取更小档；异常值（<=0 或超大）分别落到最小/最大档，
    保证任何旧配置迁移后都落在合法档位上。
    """
    s = int(ms) // 1000
    return min(HOLD_PRESETS, key=lambda p: (abs(p - s), p))


class AlertSettingsDialog(QDialog):
    """告警方式配置：弹窗开关、声音文件+试听、默认语音。"""

    def __init__(self, config, parent=None):
        super().__init__(parent)
        self.config = config
        self.setWindowTitle("告警设置")
        self.setMinimumWidth(520)
        self._build()
        self._load()

    # ---------- 界面 ----------
    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        g_alert = QGroupBox("告警方式")
        aform = QFormLayout(g_alert)
        self.cb_popup = ToggleSwitch("触发时弹出置顶提示框")
        self.cb_sound = ToggleSwitch("触发时播放声音")
        aform.addRow(self.cb_popup)
        aform.addRow(self.cb_sound)

        g_sound = QGroupBox("声音文件（支持 mp3 / wav）")
        sform = QFormLayout(g_sound)
        self.ed_file = QLineEdit()
        self.ed_file.setPlaceholderText("留空则使用系统默认语音播报")
        self.ed_file.setReadOnly(True)
        row = QHBoxLayout()
        btn_browse = _flat_btn("选择文件…", self._browse, primary=False)
        btn_clear = _flat_btn("清除", self._clear, primary=False)
        btn_test = _flat_btn("▶ 试听", self._test, primary=True)
        row.addWidget(btn_browse)
        row.addWidget(btn_clear)
        row.addStretch(1)
        row.addWidget(btn_test)
        sform.addRow("声音文件", self.ed_file)
        sform.addRow(row)

        g_tts = QGroupBox("默认语音（未设置声音文件时）")
        tform = QFormLayout(g_tts)
        self.ed_text = QLineEdit()
        self.ed_text.setPlaceholderText("如：出现目标图片 请查看")
        self.sp_repeat = QSpinBox()
        self.sp_repeat.setRange(1, 10)
        tform.addRow("播报文案", self.ed_text)
        tform.addRow("连读遍数", self.sp_repeat)

        g_hold = QGroupBox("播报节奏")
        hform = QFormLayout(g_hold)
        self.cb_repeat = ToggleSwitch("画面持续存在时重复报警（推荐）")
        lbl_repeat = QLabel(
            "开启（默认）：只要画面一直在，就按播报时长间隔反复报警。\n"
            "关闭：目标画面出现时只报一次，消失后再次出现才再报。")
        lbl_repeat.setWordWrap(True)
        lbl_repeat.setStyleSheet("color:#8a919c;")
        lbl_hold = QLabel("播报期间暂停检测；播完后若画面仍在，隔此时长再次播报。")
        lbl_hold.setWordWrap(True)
        lbl_hold.setStyleSheet("color:#8a919c;")
        hform.addRow(self.cb_repeat)
        hform.addRow(lbl_repeat)
        hform.addRow(lbl_hold)

        # 重报间隔档位：5 / 10 / 30 秒三档，点选即选，免手动输数字
        preset_row = QHBoxLayout()
        preset_row.setSpacing(8)
        self._hold_group = QButtonGroup(self)
        self._hold_group.setExclusive(True)
        for sec in HOLD_PRESETS:
            btn = QPushButton(f"{sec} 秒")
            btn.setCheckable(True)
            btn.setCursor(Qt.PointingHandCursor)
            # 标准统一尺寸：与全局 flat_btn 同高（32），等宽对齐
            btn.setFixedSize(88, 32)
            btn.setStyleSheet(
                "QPushButton{background:#fff;color:#333;border:1px solid #d6d9dd;"
                "border-radius:6px;font-weight:400;}"
                "QPushButton:hover{background:#eef1f4;}"
                f"QPushButton:checked{{background:{BLUE};color:#fff;border-color:{BLUE};}}")
            self._hold_group.addButton(btn, sec)
            preset_row.addWidget(btn)
        preset_row.addStretch(1)
        hform.addRow("重报间隔", preset_row)

        root.addWidget(g_alert)
        root.addWidget(g_sound)
        root.addWidget(g_tts)
        root.addWidget(g_hold)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        btn_save = _flat_btn("保存", self._save, primary=True)
        btn_cancel = _flat_btn("取消", self.reject, primary=False)
        btn_row.addWidget(btn_cancel)
        btn_row.addWidget(btn_save)
        root.addLayout(btn_row)

    # ---------- 数据 ----------
    @property
    def hold_seconds(self):
        """当前选中的重报间隔档位（秒），来自互斥档位按钮组。"""
        return self._hold_group.checkedId()

    @hold_seconds.setter
    def hold_seconds(self, sec):
        btn = self._hold_group.button(int(sec))
        if btn is not None:
            btn.setChecked(True)

    def _load(self):
        self.cb_popup.setChecked(bool(self.config.get("alert.popup_enabled", True)))
        self.cb_sound.setChecked(bool(self.config.get("alert.play_sound", True)))
        self.ed_file.setText(self.config.get("alert.sound_file", "") or "")
        self.ed_text.setText(self.config.get("alert.default_text", "出现目标图片 请查看"))
        self.sp_repeat.setValue(int(self.config.get("alert.text_repeat", 3)))
        # 旧配置任意秒数自动吸附到最近档位（5/10/30），无配置默认 10 秒
        self.hold_seconds = hold_preset_seconds(
            int(self.config.get("alert.popup_timeout_ms", HOLD_DEFAULT * 1000)))
        # 默认必须与引擎默认一致（True）：引擎默认重复报警，
        # 对话框默认 False 会让"开一次设置点保存"悄悄关掉重复报警
        self.cb_repeat.setChecked(bool(self.config.get("alert.repeat_while_visible", True)))

    def _save(self):
        self.config.set("alert.popup_enabled", self.cb_popup.isChecked())
        self.config.set("alert.play_sound", self.cb_sound.isChecked())
        self.config.set("alert.sound_file", self.ed_file.text().strip())
        self.config.set("alert.default_text", self.ed_text.text().strip() or "出现目标图片 请查看")
        self.config.set("alert.text_repeat", self.sp_repeat.value())
        self.config.set("alert.popup_timeout_ms", self.hold_seconds * 1000)
        self.config.set("alert.repeat_while_visible", self.cb_repeat.isChecked())
        self.config.save()
        self.accept()

    # ---------- 动作 ----------
    def _browse(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择告警声音", "",
            "声音文件 (*.mp3 *.wav);;所有文件 (*.*)")
        if path:
            self.ed_file.setText(path)

    def _clear(self):
        self.ed_file.clear()

    def _test(self):
        """试听：优先播放已选声音文件；未选则用默认文案合成语音。"""
        sound.play(self.ed_file.text().strip(),
                   self.ed_text.text().strip() or "出现目标图片 请查看",
                   self.sp_repeat.value())
        self._feedback("正在试听…")

    def _feedback(self, text):
        self.setWindowTitle(f"告警设置 — {text}")