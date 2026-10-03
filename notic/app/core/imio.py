# -*- coding: utf-8 -*-
"""Unicode 安全的图片读写 + 全链路日志。

cv2.imread / cv2.imwrite 在 Windows 上用 ANSI 编码传路径：文件名含 GBK
编不了的字符（emoji、部分特殊符号）时会**静默失败**——imwrite 假装成功
但文件没落盘、imread 返回 None，表现为"上传图片无效、无预览、图库空白"。
这里统一改走字节流通道：np.fromfile + cv2.imdecode 读、cv2.imencode +
文件对象写，路径由 Python 自己处理，任意 Unicode 文件名都可靠。

所有读取成功/失败都落 notic.imio 日志（进 notic_error.log），
"上传无效"这类反馈可以直接靠日志定位是哪一步、哪个文件。
"""
import logging
import os

import cv2
import numpy as np

_log = logging.getLogger("notic.imio")


def read_image(path):
    """读取图片为 BGR ndarray；失败返回 None（带 WARNING 日志）。"""
    try:
        buf = np.fromfile(path, dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR) if buf.size else None
    except Exception:
        img = None
    if img is None:
        _log.warning("图片读取失败: %s", path)
    else:
        _log.info("图片读取成功: %s (%dx%d)", path, img.shape[1], img.shape[0])
    return img


def write_image(path, img):
    """写入 BGR 图片；成功返回 True，失败返回 False（带 WARNING 日志）。"""
    try:
        ext = os.path.splitext(path)[1] or ".png"
        ok, buf = cv2.imencode(ext, img)
        if not ok:
            _log.warning("图片编码失败: %s", path)
            return False
        with open(path, "wb") as f:
            f.write(buf.tobytes())
        if not os.path.isfile(path):
            _log.warning("图片写入后未落盘: %s", path)
            return False
        _log.info("图片写入成功: %s", path)
        return True
    except Exception:
        _log.warning("图片写入异常: %s", path, exc_info=True)
        return False
