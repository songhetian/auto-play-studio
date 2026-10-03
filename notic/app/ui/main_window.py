# -*- coding: utf-8 -*-
"""主窗口 + 系统托盘：监控区列表、全局启停、图片管理、告警处理。"""
import os

import cv2
from PyQt5.QtCore import Qt, QTimer
from PyQt5.QtGui import QIcon, QPixmap, QPainter, QColor
from PyQt5.QtWidgets import (
    QApplication, QSystemTrayIcon, QMenu, QAction, QWidget,
    QVBoxLayout, QHBoxLayout, QLabel, QPushButton, QScrollArea,
    QFrame, QCheckBox, QFileDialog, QDialog,
)

from .alert_popup import show_alert_popup
from .zone_dialog import ZoneDialog, _bgr_to_pixmap
from .gallery_dialog import GalleryDialog
from .alert_settings_dialog import AlertSettingsDialog
from .widgets import flat_btn as _flat_btn
from ..core.announcer import Announcer
from ..core.monitor_engine import MonitorEngine, make_zone_id
from ..core import sound
from .. import paths

BLUE = "#2455D9"
BG = "#f5f6f8"
ZONES_DIR = paths.zones_dir()


GLOBAL_QSS = f"""
    QWidget {{ background: {BG}; color: #333; font-family: "Microsoft YaHei"; }}
    QLabel {{ font-weight: 400; }}
    QPushButton {{ font-weight: 400; }}
    QCheckBox {{ font-weight: 400; }}
    QGroupBox {{
        background: #ffffff; border: 1px solid #e6e9ed; border-radius: 8px;
        margin-top: 10px; font-weight: 400;
    }}
    QGroupBox::title {{
        subcontrol-origin: margin; left: 12px; top: 0px;
        padding: 0 6px; color: #2b2f36; background: transparent;
    }}
    QRadioButton, QCheckBox {{ color: #3a3f47; font-weight: 400; spacing: 6px; }}
    QRadioButton::indicator, QCheckBox::indicator {{ width: 15px; height: 15px; }}
    QLineEdit {{
        background: #fff; border: 1px solid #d6d9dd; border-radius: 6px;
        padding: 6px 8px; font-weight: 400;
    }}
    QLineEdit:focus {{ border: 1px solid {BLUE}; }}
    QPushButton {{
        background: #ffffff; color: #3a3f47; border: 1px solid #d6d9dd;
        border-radius: 6px; padding: 5px 12px; font-weight: 400;
    }}
    QPushButton:hover {{ background: #eef1f4; border: 1px solid #b9c6ea; }}
    QPushButton:pressed {{ background: #e2e7f3; }}
    QScrollBar:vertical {{
        background: transparent; width: 8px; margin: 2px;
    }}
    QScrollBar::handle:vertical {{ background: #c9cdd3; border-radius: 4px; min-height: 20px; }}
    QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {{ height: 0; }}
    QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {{ background: transparent; }}
"""


def _make_icon():
    pm = QPixmap(64, 64)
    pm.fill(Qt.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.Antialiasing)
    p.setBrush(QColor(BLUE))
    p.setPen(Qt.NoPen)
    p.drawRoundedRect(4, 4, 56, 56, 12, 12)
    p.setPen(Qt.white)
    p.drawText(pm.rect(), Qt.AlignCenter, "监")
    p.end()
    return QIcon(pm)


class _ZoneCard(QFrame):
    """单个监控区卡片。"""

    def __init__(self, zone, on_toggle, on_edit, on_delete, parent=None):
        super().__init__(parent)
        self.zone = zone
        self.setOnToggle = on_toggle
        self.setOnEdit = on_edit
        self.setOnDelete = on_delete
        self.setStyleSheet(
            "QFrame#card{background:#fff;border:1px solid #e6e9ed;border-radius:10px;}"
            "QFrame#card:hover{border:1px solid #b9c6ea;}"
            "QLabel{background:transparent;}")
        self.setObjectName("card")
        self._build()

    def _build(self):
        lay = QHBoxLayout(self)
        lay.setContentsMargins(12, 10, 12, 10)
        lay.setSpacing(12)

        thumb = QLabel()
        thumb.setFixedSize(72, 52)
        thumb.setAlignment(Qt.AlignCenter)
        thumb.setStyleSheet("border:1px solid #eef0f3;border-radius:6px;background:#f7f8fa;")
        path = self.zone.get("reference_image", "")
        if path and os.path.isfile(path):
            from ..core.imio import read_image
            thumb.setPixmap(_bgr_to_pixmap(read_image(path), max_w=68, max_h=48))
        lay.addWidget(thumb)

        info = QVBoxLayout()
        info.setSpacing(3)
        title = QLabel(f'<b>{self.zone.get("name", "")}</b>')
        title.setStyleSheet("color:#2b2f36;font-size:14px;font-weight:400;")
        rect = self.zone.get("rect", [])
        if self.zone.get("scope") == "full" or not rect:
            meta = QLabel("整屏监控（任意位置）")
        else:
            meta = QLabel(f'局部 x:{rect[0]} y:{rect[1]}  {rect[2]}×{rect[3]}')
        meta.setStyleSheet("color:#8a919c;font-size:12px;font-weight:400;")
        thres = QLabel(f'出现相似度 ≥{self.zone.get("hit_threshold", 0.9):.0%}')
        thres.setStyleSheet("color:#8a919c;font-size:12px;font-weight:400;")
        info.addWidget(title)
        info.addWidget(meta)
        info.addWidget(thres)
        lay.addLayout(info, 1)

        cb = QCheckBox("启用")
        cb.setChecked(self.zone.get("enabled", True))
        cb.stateChanged.connect(lambda s: self.setOnToggle(self.zone.get("id"), s == Qt.Checked))
        lay.addWidget(cb)

        for txt, slot in (("编辑", self._edit), ("删除", self._delete)):
            btn = QPushButton(txt)
            btn.setCursor(Qt.PointingHandCursor)
            btn.setMinimumHeight(28)
            btn.setStyleSheet(
                "QPushButton{background:#eef1f4;color:#3a3f47;border:none;border-radius:6px;font-weight:400;}"
                "QPushButton:hover{background:#dfe5eb;}")
            btn.clicked.connect(slot)
            lay.addWidget(btn)

    def _edit(self):
        self.setOnEdit(self.zone)

    def _delete(self):
        self.setOnDelete(self.zone.get("id"))


class MainWindow(QWidget):
    """主界面：监控区列表 + 全局开关 + 图片管理 + 托盘。"""

    def __init__(self, config, event_hub):
        super().__init__(None)
        self.config = config
        self.event_hub = event_hub

        self.setStyleSheet(GLOBAL_QSS)
        self.engine = MonitorEngine(config, event_hub)
        self.announcer = Announcer(config, event_hub, self.engine)
        self.tray = None

        self._sub = config.add_listener(self._on_config_change)

        self.setWindowTitle("屏幕内容监控卫士")
        self.resize(600, 520)
        self._build_ui()
        self._setup_tray()

        os.makedirs(ZONES_DIR, exist_ok=True)
        self.engine.start()
        self._render_zones()

        # 每秒把自身可见窗口矩形（物理像素）发布给引擎——
        # 主界面/编辑框里的参考图缩略图会被匹配引擎命中（自匹配误报），必须排除
        self._self_rects_timer = QTimer(self)
        self._self_rects_timer.timeout.connect(self._publish_self_rects)
        self._self_rects_timer.start(1000)

    def _publish_self_rects(self):
        """收集本进程所有可见顶层窗口的物理像素矩形交给引擎做自匹配防护。"""
        from PyQt5.QtWidgets import QApplication as _QApp
        rects = []
        for w in _QApp.topLevelWidgets():
            if not w.isVisible() or w == self.tray:
                continue
            screen = w.screen()
            dpr = screen.devicePixelRatio() if screen else 1.0
            g = w.frameGeometry()
            if g.width() <= 0 or g.height() <= 0:
                continue
            rects.append([int(g.x() * dpr), int(g.y() * dpr),
                          int(g.width() * dpr), int(g.height() * dpr)])
        self.engine.self_rects = rects

    # ---------- 界面 ----------
    def _build_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(18, 18, 18, 18)
        root.setSpacing(14)

        head = QHBoxLayout()
        head.setSpacing(12)
        logo = QLabel()
        logo.setPixmap(_make_icon().pixmap(40, 40))
        title_box = QVBoxLayout()
        title_box.setSpacing(0)
        t1 = QLabel("屏幕内容监控卫士")
        t1.setStyleSheet(f"color:{BLUE};font-size:18px;font-weight:600;")
        t2 = QLabel("设定目标画面，出现即播报告警")
        t2.setStyleSheet("color:#8a919c;font-size:12px;font-weight:400;")
        title_box.addWidget(t1)
        title_box.addWidget(t2)
        head.addWidget(logo)
        head.addLayout(title_box)
        head.addStretch(1)

        self.cb_global = QCheckBox("启用监控")
        self.cb_global.setChecked(self.config.get("general.run_monitoring", True))
        self.cb_global.stateChanged.connect(self._toggle_global)
        btn_settings = _flat_btn("告警设置", self._open_settings, primary=False)
        btn_gallery = _flat_btn("图片管理", self._open_gallery, primary=False)
        btn_refresh = _flat_btn("刷新列表", self._render_zones, primary=False)
        btn_add = _flat_btn("＋ 新增监控区", self._add_zone, primary=True)
        head.addWidget(self.cb_global)
        head.addWidget(btn_settings)
        head.addWidget(btn_gallery)
        head.addWidget(btn_refresh)
        head.addWidget(btn_add)
        root.addLayout(head)

        # “监控列表”页面标题
        page_title = QLabel("监控列表")
        page_title.setStyleSheet(f"color:#2b2f36;font-size:15px;font-weight:600;")
        root.addWidget(page_title)

        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setStyleSheet("QScrollArea{background:transparent;border:none;}")
        self.cards_host = QWidget()
        self.cards_host.setStyleSheet("background:transparent;")
        self.cards_layout = QVBoxLayout(self.cards_host)
        self.cards_layout.setContentsMargins(0, 0, 0, 0)
        self.cards_layout.setSpacing(10)
        self.cards_layout.addStretch(1)
        self.scroll.setWidget(self.cards_host)
        root.addWidget(self.scroll, 1)

        self.lbl_status = QLabel("")
        self.lbl_status.setStyleSheet("color:#5b616b;font-weight:400;")
        root.addWidget(self.lbl_status)

    # ---------- 托盘 ----------
    def _setup_tray(self):
        self.tray = QSystemTrayIcon(_make_icon(), self)
        self.tray.setToolTip("屏幕内容监控卫士")
        menu = QMenu()
        act_show = QAction("打开主界面", self)
        act_show.triggered.connect(self._show_self)
        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self.quit_app)
        menu.addAction(act_show)
        menu.addSeparator()
        menu.addAction(act_quit)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(
            lambda r: self._show_self() if r == QSystemTrayIcon.Trigger else None)
        self.tray.show()

    def _show_self(self):
        self.show()
        self.raise_()
        self.activateWindow()

    def _toggle_global(self, state):
        on = state == Qt.Checked
        self.config.set("general.run_monitoring", on)
        if on:
            self.engine.start()
        else:
            self.engine.stop()
        self._refresh_status()

    # ---------- 监控区管理 ----------
    def _render_zones(self):
        while self.cards_layout.count() > 1:
            item = self.cards_layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        zones = self.config.get_zones()
        if not zones:
            empty = QLabel("还没有监控区。点击右上角“＋ 新增监控区”开始配置。")
            empty.setStyleSheet("color:#aab0b9;font-weight:400;padding:28px;")
            empty.setAlignment(Qt.AlignCenter)
            self.cards_layout.insertWidget(0, empty)
        else:
            for z in zones:
                card = _ZoneCard(z, self._toggle_zone, self._edit_zone, self._delete_zone)
                self.cards_layout.insertWidget(self.cards_layout.count() - 1, card)
        self._refresh_status()

    def _add_zone(self):
        dlg = ZoneDialog(self.config, parent=self)
        if dlg.exec_() and dlg.result_zone:
            self.config.add_zone(dlg.result_zone)
            self.config.save()
            self.engine.reload()
            self._render_zones()

    def _edit_zone(self, zone):
        dlg = ZoneDialog(self.config, zone=zone, parent=self)
        if dlg.exec_() and dlg.result_zone:
            new = dlg.result_zone
            self.config.update_zone(new["id"], **{
                "name": new["name"], "enabled": new["enabled"],
                "scope": new["scope"],
                "rect": new["rect"], "reference_image": new["reference_image"],
                "hit_threshold": new["hit_threshold"],
            })
            self.config.save()
            # 编辑可能改写同一参考图路径，强制丢弃旧缓存再重载，避免继续比对旧图
            # （注意：matcher 在 engine 里，MainWindow 自身没有 matcher 属性；
            #   旧代码写 self.matcher 会 AttributeError，导致后面的 reload/render
            #   全部被跳过——"修改监控区永远不生效"的根因。）
            self.engine.matcher.invalidate(new["id"])
            self.engine.reload()
            self._render_zones()

    def _delete_zone(self, zone_id):
        self.config.remove_zone(zone_id)
        self.config.save()
        self.engine.reload()
        self._render_zones()

    def _toggle_zone(self, zone_id, on):
        self.config.update_zone(zone_id, enabled=on)
        self.config.save()
        self.engine.reload()

    def _open_gallery(self):
        dlg = GalleryDialog(self.config, parent=self)
        dlg.exec_()

    def _open_settings(self):
        dlg = AlertSettingsDialog(self.config, parent=self)
        dlg.exec_()

    def _refresh_status(self):
        zones = self.config.get_zones()
        enabled = sum(1 for z in zones if z.get("enabled", True))
        # 参考图缺失的监控区永远不会命中，必须在状态栏显式提示
        from ..core.monitor_engine import missing_ref_zone_ids
        missing = missing_ref_zone_ids(zones)
        warn = f" · ⚠ {len(missing)} 个监控区参考图缺失，请重新上传" if missing else ""
        if not self.config.get("general.run_monitoring", True):
            state = "监控已暂停"
        elif self.engine.reporting:
            state = "正在播报（暂停检测）"
        elif self.engine.running:
            state = "正常监控中"
        else:
            state = "待命"
        self.lbl_status.setText(f"{state} · 共 {len(zones)} 个监控区（启用 {enabled} 个）{warn}")

    # ---------- 配置热更新 ----------
    def _on_config_change(self, key, value):
        if key == "zones":
            self._render_zones()
        elif key == "general.run_monitoring":
            self.cb_global.blockSignals(True)
            self.cb_global.setChecked(bool(value))
            self.cb_global.blockSignals(False)

    # ---------- 退出 ----------
    def quit_app(self):
        self.announcer.shutdown()
        self.engine.stop()
        self.config.save()
        try:
            self._sub()
        except Exception:
            pass
        if self.tray:
            self.tray.hide()
        QApplication.instance().quit()

    def closeEvent(self, event):
        event.ignore()
        self.hide()


def run(config, event_hub):
    win = MainWindow(config, event_hub)
    win.hide()
    return win