# -*- coding: utf-8 -*-
"""引擎生命周期：启动做了什么不重要，**退出时有没有收干净**才重要。

起因是 watch 线程：lifespan 里起了后台轮询线程，却没有对应的停止，
导致 `TestClient` 关掉后线程还在跑 —— 测试里表现为「同一个进程里后跑的用例被
活着的线程污染」，真正上线时表现为「应用退出了线程还活着」。

接缝就是 FastAPI 的 lifespan 本身：以 `with TestClient(app)` 进出代表一次完整的
启动 / 退出，退出后进程里不该再有名叫 wordlib-watch 的线程。
"""
from __future__ import annotations

import threading
import time

import pytest

import engine.sensitive_words.watch as watch_mod


@pytest.fixture(autouse=True)
def _线程状态前后都清():
    """这条官”：线程是模块级全局，别把这个文件的影响带给别人。"""
    watch_mod.stop_watcher()
    yield
    watch_mod.stop_watcher()


def watch_threads() -> list[threading.Thread]:
    """按名字取监听线程 —— 名字就是它在 UI/日志里对外的身份。"""
    return [t for t in threading.enumerate() if t.name == "wordlib-watch"]


def test_lifespan启动期间监听线程是活着的():
    from fastapi.testclient import TestClient

    from engine.main import app

    with TestClient(app):
        assert len(watch_threads()) == 1, "lifespan 进来后应当有一条监听线程在跑"


def test_引擎退出后不残留监听线程():
    from fastapi.testclient import TestClient

    from engine.main import app

    with TestClient(app):
        pass

    deadline = time.time() + 5
    while time.time() < deadline and watch_threads():
        time.sleep(0.05)

    assert watch_threads() == [], "退出后必须停掉自己起的线程，不能留到进程结束"
