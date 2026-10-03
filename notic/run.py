# -*- coding: utf-8 -*-
"""图片上传/截图监控卫士 — 启动入口。

用法:
    python run.py                # 正常启动（驻留托盘）
"""
import os
import sys
import traceback

# 数据目录锚定：开发态=项目根目录；打包(onefile)后 __file__ 在临时解压目录，
# 必须改用 exe 所在目录，否则 config.json/zones/日志会写进临时目录丢失。
from app.paths import app_base_dir

os.chdir(app_base_dir())

# 全局异常钩子：PyQt 槽/定时器回调里未捕获的异常默认会 abort() 退出，
# 表现为"出现一次就界面全部卡死/未响应"。改为记录到日志文件并返回，保证软件不崩。
_ERR_LOG = os.path.join(app_base_dir(), "notic_error.log")


def _excepthook(exc_type, exc, tb):
    try:
        with open(_ERR_LOG, "a", encoding="utf-8") as f:
            f.write("=" * 70 + "\n")
            f.write("".join(traceback.format_exception(exc_type, exc, tb)))
    except Exception:
        pass
    # 正常返回，不交给 PyQt 默认处理（避免 abort()），让事件循环继续
    print("!! 未捕获异常，已记录到 notic_error.log，软件继续运行", file=sys.stderr)


sys.excepthook = _excepthook

# 让各模块 logger（notic.engine / notic.announcer 等）落到同一份日志文件。
# 此前引擎线程的异常只进 stderr，从托盘/exe 启动时完全不可见，
# "监控静默失效却查不到原因"多半源于此。
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.FileHandler(_ERR_LOG, encoding="utf-8")],
)


def main():
    # DPI 感知：保证小数缩放下刻度与弹窗尺寸正确（必须在 QApplication 之前设置）
    try:
        import ctypes
        ctypes.windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    from PyQt5.QtCore import Qt
    from PyQt5.QtWidgets import QApplication, QMessageBox

    QApplication.setAttribute(Qt.AA_EnableHighDpiScaling, True)
    QApplication.setAttribute(Qt.AA_UseHighDpiPixmaps, True)

    from app.config import ConfigManager
    from app.events import EventHub
    from app.single_instance import acquire_single_instance_lock
    from app.ui.main_window import run as run_app

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)  # 托盘驻留，关窗不退出

    # 单实例保护：两个实例会同时检测、同时播报（双声音的根因）
    if not acquire_single_instance_lock():
        QMessageBox.information(
            None, "监控卫士已在运行",
            "监控卫士已经在运行了（屏幕右下角托盘图标），请勿重复打开。\n"
            "如需重启，请先从托盘菜单退出当前实例。")
        return

    config = ConfigManager()
    event_hub = EventHub()
    window = run_app(config, event_hub)

    # 启动就显示主窗口（去掉 --show 判断）
    window.show()

    rc = app.exec_()
    sys.exit(rc)


if __name__ == "__main__":
    main()