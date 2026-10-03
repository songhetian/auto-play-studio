# -*- coding: utf-8 -*-
"""共用 UI 小部件：统一按钮样式、滑动开关，消除各对话框里的复制粘贴。"""
from PyQt5.QtCore import Qt
from PyQt5.QtWidgets import QPushButton, QCheckBox

BLUE = "#2455D9"


def flat_btn(text, on_click, primary=True, min_h=32):
    """统一风格的扁平按钮。primary=True 为蓝色主按钮，否则为白底次按钮。"""
    btn = QPushButton(text)
    btn.setCursor(Qt.PointingHandCursor)
    btn.setMinimumHeight(min_h)
    btn.setStyleSheet(
        f"QPushButton{{background:{BLUE};color:#fff;border:none;border-radius:6px;"
        f"font-weight:400;}}"
        f"QPushButton:hover{{background:#1d44b0;}}"
        if primary else
        "QPushButton{background:#fff;color:#333;border:1px solid #d6d9dd;"
        "border-radius:6px;font-weight:400;}"
        "QPushButton:hover{background:#eef1f4;}")
    btn.clicked.connect(on_click)
    return btn


class ToggleSwitch(QCheckBox):
    """iOS 风格滑动开关：本质仍是 QCheckBox（isChecked/setChecked/toggled
    全部兼容）。滑槽固定锚在控件右缘（与文字长度无关，多行开关对齐成列），
    整个控件都是点击热区（hitButton 覆盖自绘滑槽，否则点了没反应）。"""

    _TRACK_H = 22
    _TRACK_W = 40

    def __init__(self, text="", parent=None):
        super().__init__(text, parent)
        self.setCursor(Qt.PointingHandCursor)
        self.setStyleSheet("QCheckBox{color:#3a3f47; spacing:10px;}")

    # ---------- 交互 ----------
    def hitButton(self, pos):
        """整个控件都是热区：默认样式的热区在左侧 indicator（已被自绘
        取代、不可见），不重写这个，用户点可见的滑槽就会毫无反应。"""
        return self.rect().contains(pos)

    def _knob_rect(self):
        """滑槽矩形：固定锚在控件右缘（与文字长度无关）——多行开关在
        同一表单里滑块才能对齐成一列；文字固定画在左侧。"""
        return self.width() - self._TRACK_W, (self.height() - self._TRACK_H) // 2

    def paintEvent(self, event):
        from PyQt5.QtGui import QPainter, QColor, QPen
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        x, y = self._knob_rect()
        w, h = self._TRACK_W, self._TRACK_H
        # 滑槽：开=主题蓝，关=浅灰，禁用=更浅
        track = QColor(BLUE) if self.isChecked() else QColor("#d6dbe1")
        if not self.isEnabled():
            track = QColor("#e4e7eb")
        p.setPen(Qt.NoPen)
        p.setBrush(track)
        p.drawRoundedRect(x, y, w, h, h // 2, h // 2)
        # 滑块：白色圆点 + 浅描边 + 底部半透明阴影，带一点立体感
        d = h - 6
        kx = x + w - d - 3 if self.isChecked() else x + 3
        ky = y + 3
        p.setPen(Qt.NoPen)
        p.setBrush(QColor(0, 0, 0, 28))
        p.drawEllipse(kx, ky + 1, d, d)
        p.setBrush(QColor("#ffffff"))
        p.setPen(QPen(QColor("#c9ced6"), 1))
        p.drawEllipse(kx, ky, d, d)
        # 文字：固定左侧，与滑槽位置无关
        p.setPen(QColor("#3a3f47"))
        p.drawText(self.rect().adjusted(0, 0, -self._TRACK_W - 10, 0),
                   int(Qt.AlignVCenter | Qt.AlignLeft), self.text())
        p.end()
