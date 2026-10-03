# -*- coding: utf-8 -*-
"""离线验证：相似度算法 + 播报暂停机制 + 默认语音文案拼接（不依赖真机抓屏）。"""
import os
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.getcwd())

import numpy as np
import cv2

from app.core.screen_matcher import similarity
from app.core.sound import build_phrase


def test_similarity():
    # 完全相同 → 约 1.0
    a = np.random.randint(0, 256, (80, 120, 3), dtype=np.uint8)
    s_self = similarity(a, a.copy())
    assert s_self > 0.999, s_self
    # 纯黑 vs 纯白 → 约 0.0
    black = np.zeros((80, 120, 3), dtype=np.uint8)
    white = np.full((80, 120, 3), 255, dtype=np.uint8)
    s_bw = similarity(black, white)
    assert s_bw < 0.03, s_bw
    # 轻微扰动 → 仍高相似
    noisy = a.copy()
    idx = np.random.choice(a.size // 3, int(a.size // 3 * 0.02), replace=False)
    flat = noisy.ravel()
    flat[idx] = np.clip(flat[idx].astype(int) + 15, 0, 255).astype(np.uint8)
    s_noise = similarity(a, noisy)
    assert s_noise > 0.8, s_noise
    print(f"OK similarity: 自比={s_self:.4f} 黑白={s_bw:.4f} 噪声2%={s_noise:.4f}")


def test_template_match():
    """模板匹配：在整屏大图中正确找到嵌入式目标图（目标图出现在任意位置）。"""
    from app.core.screen_matcher import ScreenMatcher
    # 构造一张"屏幕"大图
    frame = np.full((400, 600, 3), 230, dtype=np.uint8)
    # 在 (150,100) 处嵌入一张 60x80 的目标图
    tpl = np.random.randint(0, 256, (60, 80, 3), dtype=np.uint8)
    frame[100:160, 150:230] = tpl
    matcher = ScreenMatcher.__new__(ScreenMatcher)  # 避免打开 mss
    sim, rect = matcher.match_template(tpl, frame, None)  # 整屏搜索
    assert sim > 0.95, sim
    # 找到的位置应接近 (150,100)
    assert abs(rect[0] - 150) <= 2 and abs(rect[1] - 100) <= 2, rect
    # 不包含目标图时相似度应明显低
    empty = np.full((400, 600, 3), 230, dtype=np.uint8)
    sim2, _ = matcher.match_template(tpl, empty, None)
    assert sim2 < 0.5, sim2
    # 局部搜索：限缩区域，目标图在该区域内也能命中
    tpl2 = np.random.randint(0, 256, (40, 40, 3), dtype=np.uint8)
    region = frame.copy()
    region[200:240, 300:340] = tpl2
    sim3, rect3 = matcher.match_template(tpl2, region, [250, 150, 200, 200])
    assert sim3 > 0.9, sim3
    cx, cy = rect3[0], rect3[1]
    assert 250 <= cx <= 450 and 150 <= cy <= 350, rect3
    print(f"OK 模板匹配: 整屏命中={sim:.3f} 空屏={sim2:.3f} 局部命中={sim3:.3f} 位置{rect} / {rect3}")


def test_reporting_pause():
    """播报暂停：引擎在 reporting 期间跳过检测，恢复后可再次触发。"""
    from app.core.monitor_engine import MonitorEngine
    from app.events import EventHub

    eng = MonitorEngine(type("_Cfg", (), {"get": lambda self, k, d=None: d,
                                          "get_zones": lambda self: []})(), EventHub())

    # 未播报：正常
    assert eng.reporting is False
    assert eng.running is False  # 未 start 时 running=False
    # 开始播报 → 暂停检测
    eng.begin_reporting()
    assert eng.reporting is True
    assert eng.running is False
    # 播报结束 → 恢复
    eng.end_reporting()
    assert eng.reporting is False
    eng.shutdown() if hasattr(eng, "shutdown") else None
    print("OK 播报暂停：reporting 期间暂停检测，end_reporting 后恢复")


def test_default_phrase():
    # 默认文案连读 3 遍
    p = build_phrase("出现目标图片 请查看", 3)
    assert p == "出现目标图片 请查看，出现目标图片 请查看，出现目标图片 请查看", p
    # 去掉末尾标点、自动去空格
    assert build_phrase(" 你好。 ", 2) == "你好，你好"
    print("OK 默认语音文案拼接")


if __name__ == "__main__":
    test_similarity()
    test_template_match()
    test_reporting_pause()
    test_default_phrase()
    print("\n全部离线验证通过")