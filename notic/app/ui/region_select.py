# -*- coding: utf-8 -*-
"""全屏半透明区域框选器：鼠标拖拽画矩形选择一块屏幕区域。
拖拽时只重绘变化的矩形区域，避免整块全屏覆盖层反复全量重绘导致卡顿。
"""
from PyQt5.QtCore import Qt, QRect
from PyQt5.QtGui import QPainter, QPen, QColor, QFont
from PyQt5.QtWidgets import QDialog, QApplication

BLUE = "#2455D9"
_MARGIN = 6  # 重绘区域外扩，避免拖影


class RegionSelect(QDialog):
    """无边框、置顶、半透明的全屏框选覆盖层。

    结果：`selected_rect` 为逻辑坐标 (x, y, w, h)。
    拖拽画框，Esc 取消。
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self._start = None
        self._current = None
        self._old_rect = None
        self._cancelled = False

        self.setWindowFlags(
            Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Dialog)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.setCursor(Qt.CrossCursor)
        try:
            self.setWindowState(Qt.WindowFullScreen)
        except Exception:
            self.setWindowState(Qt.WindowActive)
        screen = QApplication.primaryScreen()
        if screen:
            self.setGeometry(screen.geometry())
        self.selected_rect = None

    # ---------- 事件 ----------
    def mousePressEvent(self, e):
        if e.button() == Qt.LeftButton:
            self._start = self._current = e.pos()
            self._old_rect = None
            self.update(self._dirty_region())

    def mouseMoveEvent(self, e):
        if self._start is not None:
            self._current = e.pos()
            self.update(self._dirty_region())

    def mouseReleaseEvent(self, e):
        if e.button() == Qt.LeftButton and self._start is not None:
            self._current = e.pos()
            r = QRect(self._start, self._current).normalized()
            if r.width() >= 3 and r.height() >= 3:
                self.selected_rect = (r.x(), r.y(), r.width(), r.height())
                self.accept()
            else:
                self._start = self._current = None
                self._old_rect = None
                self.update()

    def keyPressEvent(self, e):
        if e.key() == Qt.Key_Escape:
            self._cancelled = True
            self.reject()
        else:
            super().keyPressEvent(e)

    # ---------- 增量重绘 ----------
    def _dirty_region(self):
        """返回需要重绘的矩形：新选区 ∪ 旧选区并外扩。"""
        new = None
        if self._start is not None and self._current is not None:
            new = QRect(self._start, self._current).normalized()
        reg = new
        if self._old_rect is not None:
            reg = new.united(self._old_rect) if new else self._old_rect
        self._old_rect = new
        if reg is not None:
            return reg.adjusted(-_MARGIN, -_MARGIN, _MARGIN, _MARGIN)
        return self.rect()

    def paintEvent(self, e):
        p = QPainter(self)
        dirty = e.rect()  # 只重绘更新区域
        # 半透明遮罩（只填脏区）
        p.fillRect(dirty, QColor(20, 20, 20, 120))
        if self._start is not None and self._current is not None:
            r = QRect(self._start, self._current).normalized()
            if r.intersects(dirty):
                pen = QPen(QColor(BLUE))
                pen.setWidth(2)
                p.setPen(pen)
                fill = QColor(BLUE)
                fill.setAlpha(40)
                p.setBrush(fill)
                p.drawRect(r)
                p.setPen(QColor(BLUE))
                font = QFont(self.font())
                font.setPointSize(10)
                p.setFont(font)
                p.drawText(r.adjusted(4, 4, -4, -4), Qt.AlignLeft | Qt.AlignTop,
                           f"{r.width()} × {r.height()}  px")
        else:
            hint = "按住鼠标左键并拖动，框选出监控区域（Esc 取消）"
            p.setPen(Qt.white)
            dirty.adjust(_MARGIN, _MARGIN, -_MARGIN, -_MARGIN)
            p.drawText(self.rect(), Qt.AlignCenter, hint)


def pick_region(parent=None):
    """弹框选器，返回 { 逻辑rect: (x,y,w,h) 物理rect: (x,y,w,h), accepted }。
    框选期间挂起告警播报，避免命中时叠加弹窗/声音干扰与卡顿。
    """
    from ..core import announcer
    sel = RegionSelect(parent)
    announcer.suspend()
    try:
        ok = sel.exec_() == QDialog.Accepted and sel.selected_rect
    finally:
        announcer.resume()
    if ok:
        lx, ly, lw, lh = sel.selected_rect
        screen = QApplication.primaryScreen()
        dpr = screen.devicePixelRatio() if screen else 1.0
        phys = (int(round(lx * dpr)), int(round(ly * dpr)),
                int(round(lw * dpr)), int(round(lh * dpr)))
        return {"logical": (lx, ly, lw, lh), "physical": phys, "accepted": True}
    return {"logical": None, "physical": None, "accepted": False}