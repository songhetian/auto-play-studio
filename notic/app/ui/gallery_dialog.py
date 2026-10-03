# -*- coding: utf-8 -*-
"""图片（参考图）管理：缩略图预览、导入、删除、放大预览。"""
import os
import uuid

from PyQt5.QtCore import Qt
from PyQt5.QtGui import QDesktopServices
from PyQt5.QtCore import QUrl
from PyQt5.QtWidgets import (
    QDialog, QVBoxLayout, QHBoxLayout, QGridLayout, QLabel,
    QFileDialog, QMessageBox, QScrollArea, QWidget,
)

from .zone_dialog import _bgr_to_pixmap
from .widgets import flat_btn as _flat_btn
from ..core.imio import read_image
from .. import paths

BLUE = "#2455D9"
ZONES_DIR = paths.zones_dir()
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp")


class _Thumb(QWidget):
    """单个图片缩略图（小图 + 文件名 + 操作按钮）。"""

    def __init__(self, path, referenced, on_delete):
        super().__init__(None)
        self.path = path
        self.setFixedSize(150, 170)
        self.setStyleSheet("QWidget{background:#fff;border:1px solid #e6e9ed;border-radius:8px;}"
                           "QLabel{background:transparent;}")
        lay = QVBoxLayout(self)
        lay.setContentsMargins(6, 6, 6, 6)
        lay.setSpacing(4)

        img = QLabel()
        img.setFixedHeight(96)
        img.setAlignment(Qt.AlignCenter)
        img.setStyleSheet("border:1px solid #eee;border-radius:4px;background:#f7f8fa;")
        import cv2
        img.setPixmap(_bgr_to_pixmap(read_image(path), max_w=134, max_h=92))
        lay.addWidget(img, 1)

        name = QLabel(os.path.basename(path))
        name.setStyleSheet("color:#444;font-weight:400;font-size:11px;")
        name.setToolTip(path)
        lay.addWidget(name)

        tag = QLabel("被监控区引用" if referenced else "未引用")
        tag.setStyleSheet(
            f"color:{BLUE};font-weight:400;font-size:10px;" if referenced
            else "color:#999;font-weight:400;font-size:10px;")
        lay.addWidget(tag)

        row = QHBoxLayout()
        btn_view = _flat_btn("预览", self._preview, primary=False)
        btn_view.setMinimumHeight(26)
        btn_del = _flat_btn("删除", lambda: on_delete(self.path, referenced), primary=False)
        btn_del.setMinimumHeight(26)
        row.addWidget(btn_view)
        row.addWidget(btn_del)
        lay.addLayout(row)

    def _preview(self):
        QDesktopServices.openUrl(QUrl.fromLocalFile(self.path))


def pick_gallery_image(config, parent=None):
    """从图库目录选一张图片，返回绝对路径；取消返回 None。"""
    os.makedirs(ZONES_DIR, exist_ok=True)
    path, _ = QFileDialog.getOpenFileName(
        parent, "从图库选择图片", ZONES_DIR,
        "图片 (*.png *.jpg *.jpeg *.bmp);;所有文件 (*.*)")
    return path or None


class GalleryDialog(QDialog):
    """参考图库管理：网格缩略图 + 导入/删除/放大预览。"""

    def __init__(self, config, parent=None):
        super().__init__(parent)
        self.config = config
        self.setWindowTitle("图片管理")
        self.resize(760, 520)
        self._pick_mode = False
        self._build()

    def _build(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(16, 16, 16, 16)
        root.setSpacing(12)

        head = QHBoxLayout()
        title = QLabel("图片管理（参考图库）")
        title.setStyleSheet(f"color:{BLUE};font-size:16px;font-weight:600;")
        btn_import = _flat_btn("＋ 导入图片", self._import, primary=True)
        self.btn_close = _flat_btn("关闭", self.accept, primary=False)
        head.addWidget(title)
        head.addStretch(1)
        head.addWidget(btn_import)
        head.addWidget(self.btn_close)
        root.addLayout(head)

        self.lbl_hint = QLabel("双击/预览查看大图；仅“未引用”的图片可安全删除。")
        self.lbl_hint.setStyleSheet("color:#888;font-weight:400;font-size:12px;")
        root.addWidget(self.lbl_hint)

        self.host = QWidget()
        self.grid = QGridLayout(self.host)
        self.grid.setContentsMargins(0, 0, 0, 0)
        self.grid.setSpacing(12)
        self.grid.setAlignment(Qt.AlignTop)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setStyleSheet("QScrollArea{background:transparent;border:none;}")
        scroll.setWidget(self.host)
        root.addWidget(scroll, 1)

        self._render()

    def _zones_images(self):
        if not os.path.isdir(ZONES_DIR):
            return []
        return [os.path.join(ZONES_DIR, f)
                for f in os.listdir(ZONES_DIR)
                if os.path.splitext(f)[1].lower() in IMAGE_EXTS]

    def _referenced(self):
        refs = set()
        for z in self.config.get_zones():
            p = z.get("reference_image", "")
            if p:
                refs.add(p)
        return refs

    def _render(self):
        while self.grid.count():
            item = self.grid.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        refs = self._referenced()
        paths = self._zones_images()
        if not paths:
            empty = QLabel("图库为空。可在“新增监控区”里从区域截图或导入图片，或在此点击“导入图片”。")
            empty.setStyleSheet("color:#aaa;font-weight:400;padding:32px;")
            empty.setAlignment(Qt.AlignCenter)
            self.grid.addWidget(empty, 0, 0)
            return
        for i, p in enumerate(sorted(paths)):
            col = i % 4
            self.grid.addWidget(_Thumb(p, p in refs, self._delete), i // 4, col)

    def _import(self):
        paths, _ = QFileDialog.getOpenFileNames(
            self, "导入图片", "", "图片 (*.png *.jpg *.jpeg *.bmp);;所有文件 (*.*)")
        if not paths:
            return
        os.makedirs(ZONES_DIR, exist_ok=True)
        for src in paths:
            ext = os.path.splitext(src)[1].lower()
            dst = os.path.join(ZONES_DIR, "import_%s%s" % (uuid.uuid4().hex[:8], ext))
            try:
                import shutil
                shutil.copyfile(src, dst)
            except OSError:
                continue
        self._render()

    def _delete(self, path, referenced):
        if referenced:
            QMessageBox.warning(self, "无法删除",
                                "该图片正被某个监控区引用，请先在该监控区改用其他图片后再删除。")
            return
        ret = QMessageBox.question(self, "删除图片", "确定删除这张图片吗？")
        if ret == QMessageBox.Yes:
            try:
                os.remove(path)
            except OSError:
                pass
            self._render()