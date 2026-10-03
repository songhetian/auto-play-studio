# -*- coding: utf-8 -*-
"""监控区(Zone) 新增/编辑对话框：框选区域、上传本地参考图并预览、设置阈值与名称。"""
import os

import cv2
from PyQt5.QtCore import Qt
from PyQt5.QtGui import QImage, QPixmap
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QFormLayout, QGroupBox,
    QLabel, QLineEdit, QCheckBox, QFileDialog, QSlider,
    QRadioButton,
)

from ..core.monitor_engine import make_zone_id
from ..core.imio import read_image, write_image
from .. import paths
from .region_select import pick_region
from .widgets import flat_btn

BLUE = "#2455D9"
ZONES_DIR = paths.zones_dir()


def _bgr_to_pixmap(bgr, max_w=140, max_h=110):
    if bgr is None or bgr.size == 0:
        return QPixmap()
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    h, w = rgb.shape[:2]
    scale = min(max_w / w, max_h / h, 1.0)
    if scale < 1.0:
        rgb = cv2.resize(rgb, (int(w * scale), int(h * scale)))
    h, w, ch = rgb.shape
    qimg = QImage(rgb.data, w, h, ch * w, QImage.Format_RGB888).copy()
    return QPixmap.fromImage(qimg)


class ZoneDialog(QDialog):
    """返回的 zone 字典写在 `result_zone`。若取消则为 None。"""

    def __init__(self, config, zone=None, parent=None):
        super().__init__(parent)
        self.config = config
        self.is_edit = zone is not None
        self.zone = dict(zone) if zone else None
        self.result_zone = None

        # 预填字段：zone["rect"] 一律为物理像素（引擎/mss 坐标系）
        saved_rect = self.zone.get("rect") if self.zone else None
        self.zone_id = self.zone.get("id") if self.zone else make_zone_id()
        self.logical_rect = saved_rect
        self.phys_rect = saved_rect if saved_rect else None
        self.ref_path = self.zone.get("reference_image") if self.zone else ""
        self.scope = (self.zone or {}).get("scope", "full" if not saved_rect else "region")

        self.setWindowTitle("编辑监控区" if self.is_edit else "新增监控区")
        self.setMinimumWidth(480)
        self._build()
        self._refresh()

    # ---------- 界面 ----------
    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        # 区域 / 范围
        g_zone = QGroupBox("监控范围")
        zform = QFormLayout(g_zone)
        self.rb_full = QRadioButton("整屏监控（任意位置出现目标图即告警）")
        self.rb_region = QRadioButton("局部监控（在框选区域中查找）")
        # 注意：两个 radio 互斥时会先后触发 toggled，不能把各自的 on 值传入，
        # 否则"局部"最后一次 toggled(True) 会覆盖成"整屏"。改为统一读实时选中态。
        self.rb_full.toggled.connect(self._on_scope_toggled)
        self.rb_region.toggled.connect(self._on_scope_toggled)
        zform.addRow(self.rb_full)
        zform.addRow(self.rb_region)
        self.lbl_rect = QLabel("（未设置）")
        btn_pick = self._btn("框选区域（拖拽）", self._pick, primary=False)
        zform.addRow("区域坐标", self.lbl_rect)
        zform.addRow(btn_pick)

        # 参考图：仅本地上传 + 预览
        g_ref = QGroupBox("参考图（目标画面）")
        rform = QFormLayout(g_ref)
        self.btn_import = self._btn("上传本地图片", self._import_file, primary=True)
        self.btn_gallery = self._btn("从图库选择", self._pick_from_gallery, primary=False)
        self.lbl_ref = QLabel("（未上传）")
        self.lbl_ref.setStyleSheet("color:#666;")
        self.preview = QLabel("点击选择目标画面后，此处即时预览")
        self.preview.setAlignment(Qt.AlignCenter)
        self.preview.setWordWrap(True)
        self.preview.setStyleSheet("border:1px dashed #b9c6ea;border-radius:6px;color:#8a919c;")
        self.preview.setFixedHeight(120)
        self._ref_btn_row = QHBoxLayout()
        self._ref_btn_row.setSpacing(8)
        self._ref_btn_row.addWidget(self.btn_import)
        self._ref_btn_row.addWidget(self.btn_gallery)
        self._ref_btn_row.addStretch(1)
        rform.addRow(self.lbl_ref)
        rform.addRow(self._ref_btn_row)
        rform.addRow(self.preview)

        # 参数
        g_p = QGroupBox("匹配参数")
        pform = QFormLayout(g_p)
        self.ed_name = QLineEdit()
        self.ed_name.setPlaceholderText("区域名称，如：充值成功画面")
        self.cb_enabled = QCheckBox("启用本监控区")
        self.cb_enabled.setChecked(True)
        self.sl_hit = QSlider(Qt.Horizontal)
        self.sl_hit.setRange(50, 100)
        self.lbl_hit = QLabel("")
        self.lbl_hit.setFixedWidth(42)
        self.lbl_hit.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        self.lbl_hit.setStyleSheet("color:#2455D9;font-weight:600;")
        self.sl_hit.valueChanged.connect(lambda v: self.lbl_hit.setText(f"{v}%"))
        hit_row = QHBoxLayout()
        hit_row.setSpacing(8)
        hit_row.addWidget(self.sl_hit, 1)
        hit_row.addWidget(self.lbl_hit)
        pform.addRow("名称", self.ed_name)
        pform.addRow(self.cb_enabled)
        pform.addRow("出现相似度 (≥)", hit_row)

        root.addWidget(g_zone)
        root.addWidget(g_ref)
        root.addWidget(g_p)

        btn_row = QHBoxLayout()
        btn_row.addStretch(1)
        btn_ok = self._btn("保存", self._save, primary=True)
        btn_cancel = self._btn("取消", self.reject, primary=False)
        btn_row.addWidget(btn_cancel)
        btn_row.addWidget(btn_ok)
        root.addLayout(btn_row)

        # 预填值
        if self.zone:
            self.ed_name.setText(self.zone.get("name", ""))
            self.cb_enabled.setChecked(self.zone.get("enabled", True))
            self.sl_hit.setValue(int(self.zone.get("hit_threshold", 0.75) * 100))
        else:
            self.sl_hit.setValue(75)
        # 监控范围预填
        self.rb_full.setChecked(self.scope == "full")
        self.rb_region.setChecked(self.scope == "region")
        self._sync_scope(self.scope == "full")

    @staticmethod
    def _btn(text, on_click, primary=True):
        return flat_btn(text, on_click, primary)

    # ---------- 预览刷新 ----------
    def _on_scope_toggled(self, _on):
        """以实时选中态为准（整屏/局部互斥），确保"局部"不会被覆盖。"""
        self._sync_scope(self.rb_full.isChecked())

    def _sync_scope(self, full):
        """整屏时隐藏/提示区域信息，局部时提醒框选。"""
        self.scope = "full" if full else "region"
        if full:
            self.lbl_rect.setText("整屏（全屏任意位置）")
        elif not self.logical_rect:
            self.lbl_rect.setText("（未设置，请框选区域）")

    def _refresh(self):
        if self.scope == "full":
            self.lbl_rect.setText("整屏（全屏任意位置）")
        elif self.logical_rect:
            self.lbl_rect.setText(f"x:{self.logical_rect[0]}  y:{self.logical_rect[1]}  "
                                  f"宽:{self.logical_rect[2]}  高:{self.logical_rect[3]}")
        else:
            self.lbl_rect.setText("（未设置）")
        if self.ref_path and os.path.isfile(self.ref_path):
            self.lbl_ref.setText(os.path.basename(self.ref_path))
            self.preview.setText("")
            self.preview.setPixmap(_bgr_to_pixmap(read_image(self.ref_path)))
            self.preview.setToolTip(self.ref_path)
        else:
            self.lbl_ref.setText("（未上传）")
            self.preview.clear()
            self.preview.setPixmap(QPixmap())
            self.preview.setText("点击选择目标画面后，此处即时预览")

    # ---------- 动作 ----------
    def _pick(self):
        res = pick_region(self)
        if res["accepted"]:
            self.logical_rect = res["logical"]
            self.phys_rect = res["physical"]
            self._refresh()

    def _ref_dir(self):
        os.makedirs(ZONES_DIR, exist_ok=True)
        return ZONES_DIR

    def _import_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "导入参考图", "",
            "图片 (*.png *.jpg *.jpeg *.bmp);;所有文件 (*.*)")
        if not path:
            return
        self._load_image(path, error_label="无法读取该图片文件")

    def _pick_from_gallery(self):
        """从图库选一张已上传的图片作为参考图（懒导入避免循环依赖）。"""
        from .gallery_dialog import pick_gallery_image
        path = pick_gallery_image(self.config, self)
        if path:
            self._load_image(path, error_label="无法读取该图片文件")

    def _load_image(self, path, error_label=""):
        img = read_image(path)
        if img is None:
            self._flash(error_label)
            return
        self._save_ref(img, "import")

    def _save_ref(self, img, tag):
        """将 BGR 图片原样写入 zones 目录。

        刻意不做任何 resize：把上传图拉伸到框选区域尺寸会破坏宽高比，
        得到一张"变形的模板"，拿它去匹配屏幕上不变形的真实画面，
        相似度永远上不去 —— 这正是"图片变形 + 监控不到"的根因。
        模板匹配不要求参考图尺寸 == 区域尺寸（匹配器会在区域内按
        原始尺寸定位目标图），框选区域只用来限定搜索范围。
        """
        dst = os.path.join(self._ref_dir(), f"{self.zone_id}_{tag}.png")
        if not write_image(dst, img):
            self._flash("参考图保存失败，详见 notic_error.log")
            return
        self.ref_path = dst
        self._refresh()

    def _flash(self, text):
        self.lbl_ref.setText(text)

    def _save(self):
        # 守卫：没有有效参考图的监控区永远不可能命中，直接阻止保存
        if not self.ref_path or not os.path.isfile(self.ref_path):
            self._flash("请先上传目标图片再保存")
            return
        name = self.ed_name.text().strip() or self.zone_id
        if self.scope == "full":
            rect = []
        else:
            rect = self.phys_rect or self.logical_rect or []
            if not rect:
                self._flash("局部监控需先框选区域")
                return
        self.result_zone = {
            "id": self.zone_id,
            "name": name,
            "enabled": self.cb_enabled.isChecked(),
            "scope": self.scope,
            "rect": list(rect),
            "reference_image": self.ref_path,
            "hit_threshold": self.sl_hit.value() / 100.0,
        }
        self.accept()