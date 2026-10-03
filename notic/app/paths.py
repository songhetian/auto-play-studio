# -*- coding: utf-8 -*-
"""应用数据目录的统一定位（打包感知）。

打包成 onefile 后，模块的 __file__ 指向临时解压目录（sys._MEIPASS），
每次启动目录都不同——config.json / zones 参考图 / 日志 / 单实例锁如果
仍按 __file__ 相对定位，会写进临时目录随后丢失，或导致锁文件不共享
（单实例保护失效）。因此所有数据文件必须锚定 exe 所在目录（frozen 态）
或项目根目录（开发态）。
"""
import os
import sys


def app_base_dir():
    """数据根目录：config.json / zones / notic_error.log / notic.lock 所在。

    frozen（PyInstaller exe）→ exe 所在目录；
    开发态（python run.py） → 项目根目录（app/ 的上一级）。
    """
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def zones_dir():
    """参考图库目录（不存在时由调用方创建）。"""
    return os.path.join(app_base_dir(), "zones")
