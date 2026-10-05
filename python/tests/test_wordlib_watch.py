# -*- coding: utf-8 -*-
"""wordlib.json 文件监听的纯逻辑测试（注入假文件 / 假时钟，不碰真磁盘与库）。

监听的全部价值在"什么时候触发一次导入、什么时候不触发"，
所以这里把外部依赖（读文件 / 取签名 / 写库 / 取时间）全部换成假实现。
"""
from __future__ import annotations

import pytest

from engine.sensitive_words.watch import WordlibWatcher, read_wordlib


class FakeFs:
    """假文件：sig 为 None 表示"文件不存在"。"""

    def __init__(self, text: str = "[]", mtime: int = 1):
        self.text = text
        self.sig = (mtime, len(text))

    def read(self, _path: str) -> str:
        return self.text

    def stat(self, _path: str):
        return self.sig

    def touch(self, text: str, mtime: int) -> None:
        """改内容并更新签名（模拟外部程序覆写文件）。"""
        self.text = text
        self.sig = (mtime, len(text))


def make(fs: FakeFs, import_fn=None):
    calls = []

    def _default_import(payload):
        calls.append(payload)
        return {"added": ["x"], "skipped": []}

    w = WordlibWatcher(
        read_text=fs.read,
        stat_signature=fs.stat,
        import_fn=import_fn or _default_import,
        now=lambda: "2026-10-05 10:00:00",
    )
    return w, calls


def test_未配路径时轮询什么都不做():
    w, calls = make(FakeFs())
    assert w.poll() is False
    assert calls == []


def test_首次轮询即导入():
    fs = FakeFs(text='["加微信"]')
    w, calls = make(fs)
    w.set_path("C:/lib/wordlib.json")
    assert w.poll() is True
    assert calls == [["加微信"]]
    assert w.state.last_import_at == "2026-10-05 10:00:00"
    assert w.state.last_error == ""


def test_文件没变不重复导入():
    w, calls = make(FakeFs())
    w.set_path("x.json")
    assert w.poll() is True
    assert w.poll() is False
    assert len(calls) == 1


def test_文件变化后再次导入():
    fs = FakeFs(text='["a"]')
    w, calls = make(fs)
    w.set_path("x.json")
    w.poll()
    fs.touch('["a","b"]', 2)
    assert w.poll() is True
    assert len(calls) == 2


def test_同一秒内改动靠size识别():
    fs = FakeFs(text='["a"]', mtime=5)
    w, calls = make(fs)
    w.set_path("x.json")
    w.poll()
    fs.touch('["a","bb"]', 5)  # mtime 不变，size 变了
    assert w.poll() is True


def test_文件不存在不算错误也不导入():
    fs = FakeFs()
    fs.sig = None
    w, calls = make(fs)
    w.set_path("x.json")
    assert w.poll() is False
    assert calls == []
    assert "等待" in w.state.last_error


def test_坏文件只在第一次报错_同一份不重复尝试():
    w, calls = make(FakeFs(text="{ 半个 JSON"))
    w.set_path("x.json")
    assert w.poll() is False
    assert w.state.last_error
    assert w.poll() is False
    assert calls == [], "连解析都没过，不会调用导入"
    assert w.state.last_result is None


def test_坏文件修好后能导入():
    fs = FakeFs(text="坏的")
    w, calls = make(fs)
    w.set_path("x.json")
    w.poll()
    fs.touch('["ok"]', 9)
    assert w.poll() is True
    assert calls == [["ok"]]
    assert w.state.last_error == ""


def test_导入本身抛错时记住失败签名不重试():
    fs = FakeFs(text='["a"]')
    calls = []

    def boom(payload):
        calls.append(payload)
        raise ValueError("库炸了")

    w, _ = make(fs, import_fn=boom)
    w.set_path("x.json")
    assert w.poll() is False
    assert w.poll() is False
    assert len(calls) == 1, "同一份内容只试一次，失败不轰炸"
    assert "库炸了" in w.state.last_error


def test_切换路径后必须重导一次():
    w, calls = make(FakeFs(text='["a"]'))
    w.set_path("a.json")
    w.poll()
    w.set_path("b.json")  # 换了文件，签名清空
    assert w.poll() is True
    assert len(calls) == 2


def test_read_wordlib_非法JSON抛ValueError():
    with pytest.raises(ValueError):
        read_wordlib("{ 坏的")
    assert read_wordlib('{"words":["a"]}') == {"words": ["a"]}