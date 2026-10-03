# -*- coding: utf-8 -*-
"""顶层告警弹窗：置顶、无边框、自动消失、单例复用。

为什么这样做：
- 不使用 WA_TranslucentBackground，也不做 windowOpacity 动画——透明+动画会触发
  DWM 分层窗口合成，显示瞬间可能与监控线程的抓屏 GDI 冲突，导致主线程阻塞、
  被系统判定"未响应"。这里用**实心不透明窗口 + 立即显示**，零合成开销。
- 在构建时就调用 winId() 预创建原生窗口句柄，把"建窗口"这件相对重的事移到启动期，
  避免播报瞬间才建窗。
- 全局唯一实例：后续播报只更新文案再显示，不再新建窗口。
"""
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtWidgets import QWidget, QVBoxLayout, QHBoxLayout, QLabel

# 全进程唯一弹窗实例
_POPUP = None


def show_alert_popup(title, message, timeout_ms=5000):
    """显示/刷新唯一告警弹窗。无动画、实心窗口，播报瞬间零重活。"""
    global _POPUP
    if _POPUP is None:
        _POPUP = _AlertPopup()
        _POPUP.refresh(title, message, timeout_ms)
        _POPUP.show()
    else:
        _POPUP.refresh(title, message, timeout_ms)
        if not _POPUP.isVisible():
            _POPUP.show()


class _AlertPopup(QWidget):
    """右上角置顶实心告警卡。"""

    STYLE = """
        QWidget#root {
            background: #FFFFFF;
            border: 1px solid #E3E6EA;
            border-top: 4px solid #E5484D;
        }
        QLabel#iconLabel {
            background: #FDEBEC;
            color: #E5484D;
            font-size: 17px;
            font-weight: 600;
            border: none;
            border-radius: 15px;
        }
        QLabel#titleLabel {
            color: #1F2329;
            font-size: 15px;
            font-weight: 600;
            background: transparent;
            border: none;
        }
        QLabel#msgLabel {
            color: #5B616B;
            font-size: 12px;
            font-weight: 400;
            background: transparent;
            border: none;
        }
    """

    def __init__(self):
        super().__init__(None)
        self.setWindowFlags(
            Qt.FramelessWindowHint
            | Qt.Tool
            | Qt.WindowStaysOnTopHint
            | Qt.WindowDoesNotAcceptFocus
        )
        # 置顶（WindowStaysOnTopHint）：弹窗会被全屏/前台窗口遮挡，必须置顶。
        # 历史上去掉置顶是为规避"命中瞬间未响应"，但真凶是引擎持锁等待（已修），
        # 置顶本身没有问题。Tool = 不进任务栏；DoesNotAcceptFocus = 永不抢焦点。
        # 预创建原生窗口句柄：把"建窗口"移到启动/首次，避开播报瞬间
        self.winId()

        # 图标徽章
        icon = QLabel("⚠")
        icon.setObjectName("iconLabel")
        icon.setFixedSize(30, 30)
        icon.setAlignment(Qt.AlignCenter)

        text_box = QVBoxLayout()
        text_box.setSpacing(3)
        self._title_label = QLabel("")
        self._title_label.setObjectName("titleLabel")
        self._msg_label = QLabel("")
        self._msg_label.setObjectName("msgLabel")
        self._msg_label.setWordWrap(True)
        # 限制横幅最大宽度：顶部居中提示不宜横向铺满半屏
        self._msg_label.setMaximumWidth(460)
        text_box.addWidget(self._title_label)
        text_box.addWidget(self._msg_label)

        layout = QHBoxLayout(self)
        layout.setContentsMargins(16, 14, 20, 14)
        layout.setSpacing(12)
        layout.addWidget(icon, 0, Qt.AlignVCenter)
        layout.addLayout(text_box, 1)

        self.setObjectName("root")
        self.setStyleSheet(self.STYLE)

    def refresh(self, title, message, timeout_ms=5000):
        """更新文案、定位、强制置顶并安排自动消失（不新建窗口、无动画）。"""
        self._title_label.setText(title)
        self._msg_label.setText(message)
        self.adjustSize()
        self._place_top_center()
        if not self.isVisible():
            self.show()
        # 每次报警都推到最前：即便用户刚切换过窗口也不会被压在下面
        self.raise_()
        QTimer.singleShot(max(1000, int(timeout_ms)), self.hide)

    def _place_top_center(self):
        """顶部水平居中：横幅式提示视线焦点在屏幕中央上方，比右上角更显眼。"""
        from PyQt5.QtWidgets import QApplication
        screen = QApplication.primaryScreen().availableGeometry()
        self.adjustSize()
        self.move(screen.x() + (screen.width() - self.width()) // 2,
                  screen.top() + 24)

    def mousePressEvent(self, event):
        # 点击任意位置立即关闭，不挡操作
        self.hide()
        super().mousePressEvent(event)