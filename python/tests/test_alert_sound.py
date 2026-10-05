# -*- coding: utf-8 -*-
"""实例级告警声音的选声决策。

播放是设备层（不进自动化测试），但「这个实例该播什么」是纯逻辑，单独测它。
"""
from engine.alert_sound import resolve_alert_sound


def test_没有配置时回落到语音():
    """老存档里没有 alertSound 字段，不能因此变成哑巴。"""
    assert resolve_alert_sound({})["mode"] == "voice"
    assert resolve_alert_sound(None)["mode"] == "voice"
    assert resolve_alert_sound({"alertSound": {}})["mode"] == "voice"


def test_静音预设不播声音():
    assert resolve_alert_sound({"alertSound": {"preset": "silent"}})["mode"] == "silent"


def test_语音预设使用自定义文案():
    r = resolve_alert_sound({"alertSound": {"preset": "voice", "text": "客户来消息了"}})
    assert r == {"mode": "voice", "text": "客户来消息了"}


def test_语音预设文案为空时用默认文案_空串会播成静默():
    r = resolve_alert_sound({"alertSound": {"preset": "voice", "text": "   "}})
    assert r["mode"] == "voice"
    assert r["text"].strip(), "默认文案不能是空白，否则等于没播"


def test_铃声预设解析成文件播放():
    r = resolve_alert_sound({"alertSound": {"preset": "chime"}})
    assert r["mode"] == "file"
    assert r["path"].endswith(".wav")


def test_不同铃声预设指向不同文件_靠声音分辨是哪个实例():
    a = resolve_alert_sound({"alertSound": {"preset": "chime"}})
    b = resolve_alert_sound({"alertSound": {"preset": "alarm"}})
    assert a["path"] != b["path"]


def test_自定义音频优先于预设():
    r = resolve_alert_sound({"alertSound": {"preset": "voice", "customPath": "C:/tmp/ding.wav"}})
    assert r == {"mode": "file", "path": "C:/tmp/ding.wav"}


def test_自定义扩展名不支持时判非法_不静默播错的():
    for bad in ["C:/tmp/a.txt", "C:/tmp/a.exe", "C:/tmp/a"]:
        r = resolve_alert_sound({"alertSound": {"customPath": bad}})
        assert r["mode"] == "invalid", bad
        assert r["reason"]


def test_自定义路径纯空格当作没配_不是配错():
    r = resolve_alert_sound({"alertSound": {"preset": "voice", "customPath": "   "}})
    assert r["mode"] == "voice"


def test_认不出的预设回落到语音_而不是静默():
    r = resolve_alert_sound({"alertSound": {"preset": "nope"}})
    assert r["mode"] == "voice"


def test_每个实例各自配置互不干扰():
    a = resolve_alert_sound({"alertSound": {"preset": "silent"}})
    b = resolve_alert_sound({"alertSound": {"preset": "chime"}})
    assert a["mode"] == "silent"
    assert b["mode"] == "file"
