# -*- coding: utf-8 -*-
"""单实例保护。

历史事故：用户同时开了两个监控实例，两个引擎各自检测命中、各自播报——
表现为"同时出现两个声音/弹窗节奏错乱"。用 QLockFile（跨进程文件锁）保证
任意时刻只有一个实例在跑；同进程内重复调用由模块级状态直接拒绝。
"""
import os

from PyQt5.QtCore import QLockFile

from . import paths

_LOCK = None
_ACQUIRED = False


def _lock_path():
    # 锁文件必须落在 exe/项目目录：onefile 打包后 __file__ 在临时目录里，
    # 两个实例各解压到不同临时目录、各拿各的锁 → 单实例保护失效
    return os.path.join(paths.app_base_dir(), "notic.lock")


def acquire_single_instance_lock():
    """尝试获取实例锁。成功返回 True；已有实例持有（无论其他进程还是本进程）
    返回 False，调用方应提示用户并退出。"""
    global _LOCK, _ACQUIRED
    if _ACQUIRED:
        return False
    if _LOCK is None:
        _LOCK = QLockFile(_lock_path())
    if not _LOCK.tryLock(0):
        return False
    _ACQUIRED = True
    return True


def release_single_instance_lock():
    global _ACQUIRED
    if _LOCK is not None and _ACQUIRED:
        _LOCK.unlock()
    _ACQUIRED = False
