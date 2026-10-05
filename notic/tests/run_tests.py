# -*- coding: utf-8 -*-
"""ScreenGuard 回归测试（离线，offscreen Qt，不依赖真机抓屏）。

运行: python tests/run_tests.py
"""
import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(_ROOT)
sys.path.insert(0, _ROOT)

import numpy as np
import cv2

from PyQt5.QtWidgets import QApplication

app = QApplication.instance() or QApplication(sys.argv)


class FakeConfig:
    """ZoneDialog/Gallery 依赖的最小配置桩。"""
    def get(self, key, default=None):
        return default
    def get_zones(self):
        return []


# ------------------------------------------------------------------
# 切片 1：上传的参考图必须保持原始像素（不被拉伸到框选区域尺寸）
# ------------------------------------------------------------------
def test_uploaded_reference_keeps_original_pixels():
    from app.ui.zone_dialog import ZoneDialog
    dlg = ZoneDialog(FakeConfig())
    dlg.phys_rect = [0, 0, 80, 80]          # 方形框选区域
    img = np.random.randint(0, 256, (50, 100, 3), dtype=np.uint8)  # 100x50 原始图
    dlg._save_ref(img, "t1")
    saved = cv2.imread(dlg.ref_path)
    assert saved is not None, "参考图未落盘"
    assert saved.shape == img.shape, \
        f"参考图被拉伸变形: 原{img.shape[:2]} 存成{saved.shape[:2]}"
    assert np.array_equal(saved, img), "参考图像素被修改（应原样保存）"


# ------------------------------------------------------------------
# 切片 2：画面被下采样（宽>1600）时，匹配打分与定位仍必须准确
# ------------------------------------------------------------------
def test_match_template_on_downscaled_frame():
    from app.core.screen_matcher import ScreenMatcher
    frame = np.full((600, 2400, 3), 200, dtype=np.uint8)   # max_side=2400 → 触发内部下采样
    tpl = np.random.randint(0, 256, (80, 120, 3), dtype=np.uint8)
    frame[250:330, 1800:1920] = tpl                        # 目标图在 (1800,250)
    m = ScreenMatcher.__new__(ScreenMatcher)               # 跳过 mss 初始化
    sim, rect = m.match_template(tpl, frame, None)
    assert sim > 0.9, f"下采样画面上打分失真: sim={sim:.3f}"
    assert abs(rect[0] - 1800) <= 4 and abs(rect[1] - 250) <= 4, f"定位偏移: {rect}"


# ------------------------------------------------------------------
# 切片 3：参考图缺失/加载失败必须产生告警日志（不允许静默失效）
# ------------------------------------------------------------------
def test_missing_reference_image_logs_warning():
    import logging
    from app.core.screen_matcher import ScreenMatcher
    records = []
    handler = logging.Handler()
    handler.emit = lambda r: records.append(r)
    lg = logging.getLogger("notic.matcher")
    lg.addHandler(handler)
    try:
        m = ScreenMatcher.__new__(ScreenMatcher)   # 跳过 mss 初始化
        import threading
        m._lock = threading.RLock()
        m._cache = {}
        m._ref_paths = {}
        m._scale = 1.0
        zones = [{"id": "z_missing", "enabled": True,
                  "reference_image": r"E:\tools\notic\zones\__no_such_file__.png"}]
        m.update_zones(zones)
        assert m._cache.get("z_missing") is None, "缺失图不应进缓存"
        assert any(r.levelno >= logging.WARNING and "z_missing" in r.getMessage()
                   for r in records), "参考图加载失败必须打 WARNING 日志"
    finally:
        lg.removeHandler(handler)


# ------------------------------------------------------------------
# 切片 4：未上传参考图时，保存监控区必须被阻止（不允许造出永远无法命中的空区）
# ------------------------------------------------------------------
def test_save_blocked_without_reference_image():
    from app.ui.zone_dialog import ZoneDialog
    dlg = ZoneDialog(FakeConfig())
    dlg.ed_name.setText("空图区")
    dlg._save()   # 未上传任何图片
    assert dlg.result_zone is None, "无参考图不应允许保存"


# ------------------------------------------------------------------
# 切片 5：能识别出"参考图缺失/不可读"的监控区（供状态栏提示与日志用）
# ------------------------------------------------------------------
def test_missing_ref_zone_ids():
    from app.core.monitor_engine import missing_ref_zone_ids
    zones = [
        {"id": "a", "reference_image": r"E:\tools\notic\zones\za433c5cf_import.png"},
        {"id": "b", "reference_image": r"E:\tools\notic\zones\__gone__.png"},
        {"id": "c", "reference_image": ""},                      # 从未上传
        {"id": "d", "reference_image": r"E:\tools\notic\zones\za433c5cf_import.png",
         "enabled": False},                                      # 停用的不提示
    ]
    missing = missing_ref_zone_ids(zones)
    assert set(missing) == {"b", "c"}, missing


# ------------------------------------------------------------------
# 切片 6：端到端回归 —— 命中→播报→恢复检测→再次命中，且主线程抢锁不被饿死
# （锁定"报警卡死"修复：引擎线程绝不允许持锁等待）
# ------------------------------------------------------------------
def test_hit_report_recover_cycle_end_to_end():
    import time as _time
    from app.core.monitor_engine import MonitorEngine
    from app.core.announcer import Announcer

    class Cfg:
        def get(self, key, default=None):
            return {"general.poll_interval_ms": 100,
                    "alert.popup_timeout_ms": 1200,
                    "alert.popup_enabled": False,
                    "alert.play_sound": False}.get(key, default)
        def get_zones(self):
            return [{"id": "z1", "name": "t", "enabled": True, "scope": "region",
                     "rect": [0, 0, 10, 10], "reference_image": "x", "hit_threshold": 0.75}]

    class StubMatcher:
        def __init__(self):
            self.hit_budget = 2
            self.scale = 1.0
        def update_zones(self, zones): pass
        def shutdown(self): pass
        def invalidate(self, ids): pass
        def grab_full(self): return "FRAME"
        def ref_for(self, zone): return "REF"
        def match_template(self, ref, frame, rect):
            if self.hit_budget > 0:
                self.hit_budget -= 1
                return 0.99, [1, 1, 2, 2]
            return 0.0, None

    cfg = Cfg()
    eng = MonitorEngine(cfg)
    eng.matcher = StubMatcher()
    lock_times = []
    _orig = eng.begin_reporting
    def timed_begin():
        t0 = _time.perf_counter()
        _orig()
        lock_times.append((_time.perf_counter() - t0) * 1000)
    eng.begin_reporting = timed_begin
    ann = Announcer(cfg, None, eng)
    eng.start()
    try:
        # 等第一次播报（1.2s 保持）结束并恢复检测
        deadline = _time.time() + 6
        while _time.time() < deadline:
            app.processEvents()
            _time.sleep(0.05)
        app.processEvents()
        assert eng.reporting is False, "播报结束后应恢复检测（reporting 应为 False）"
        worst = max(lock_times) if lock_times else 0.0
        assert worst < 50, f"主线程抢锁被卡 {worst:.0f}ms（持锁等待回归！）"
        # 第二次命中应能再次进入播报（画面仍在 → 周期性再报警）
        eng.matcher.hit_budget = 1
        t0 = _time.time()
        rehit = False
        while _time.time() - t0 < 4:
            app.processEvents()
            if eng.reporting:
                rehit = True
                break
            _time.sleep(0.05)
        assert rehit, "第二次命中未触发播报"
    finally:
        ann.shutdown()
        eng.stop()


# ------------------------------------------------------------------
# 切片 7：只报一次模式 —— 画面持续存在时不重复报警，消失后再出现才重新报警
# ------------------------------------------------------------------
def test_alert_once_per_appearance():
    import time as _time
    from app.core.monitor_engine import MonitorEngine

    class Cfg:
        repeat = False   # 显式关闭重复 → 锁定"只报一次"可选模式的行为
        def get(self, key, default=None):
            if key == "general.poll_interval_ms":
                return 50
            if key == "alert.repeat_while_visible":
                return Cfg.repeat
            return default
        def get_zones(self):
            return [{"id": "z1", "name": "t", "enabled": True, "scope": "full",
                     "rect": [], "reference_image": "x", "hit_threshold": 0.75}]

    class SeqMatcher:
        """按匹配次数返回脚本化结果：命中→命中→消失→命中→命中。"""
        def __init__(self):
            self.script = [0.9, 0.9, 0.1, 0.9, 0.9]
            self.calls = 0
            self.scale = 1.0
        def update_zones(self, zones): pass
        def shutdown(self): pass
        def invalidate(self, ids): pass
        def grab_full(self): return "F"
        def ref_for(self, zone): return "R"
        def match_template(self, ref, frame, rect):
            s = self.script[min(self.calls, len(self.script) - 1)]
            self.calls += 1
            return (s, [1, 1, 2, 2]) if s >= 0.75 else (s, None)

    cfg = Cfg()
    eng = MonitorEngine(cfg)
    eng.matcher = SeqMatcher()
    hits = []
    eng.start()
    try:
        # 等 5 次匹配全部发生，再留出时间把队列里的命中排干
        deadline = _time.time() + 6
        while _time.time() < deadline and eng.matcher.calls < 5:
            app.processEvents()
            h = eng.drain_hit()
            if h is not None:
                hits.append(h)
                eng.end_reporting()   # 模拟播报结束恢复检测
            _time.sleep(0.02)
        tail = _time.time() + 1.0
        while _time.time() < tail:
            app.processEvents()
            h = eng.drain_hit()
            if h is not None:
                hits.append(h)
                eng.end_reporting()
            _time.sleep(0.02)
    finally:
        eng.stop()
    assert eng.matcher.calls >= 5, f"脚本未执行完: {eng.matcher.calls}"
    assert len(hits) == 2, \
        f"应只报 2 次(第1次出现 + 消失后再出现)，实际报了 {len(hits)} 次"


# ------------------------------------------------------------------
# 切片 8：repeat_while_visible=True 时恢复"画面一直在就重复提醒"旧行为
# ------------------------------------------------------------------
def test_repeat_mode_reports_every_tick():
    import time as _time
    from app.core.monitor_engine import MonitorEngine

    class Cfg:
        repeat = True
        def get(self, key, default=None):
            if key == "general.poll_interval_ms":
                return 50
            if key == "alert.repeat_while_visible":
                return Cfg.repeat
            return default
        def get_zones(self):
            return [{"id": "z1", "name": "t", "enabled": True, "scope": "full",
                     "rect": [], "reference_image": "x", "hit_threshold": 0.75}]

    class SeqMatcher:
        def __init__(self):
            self.script = [0.9, 0.9, 0.1, 0.9, 0.9]
            self.calls = 0
            self.scale = 1.0
        def update_zones(self, zones): pass
        def shutdown(self): pass
        def invalidate(self, ids): pass
        def grab_full(self): return "F"
        def ref_for(self, zone): return "R"
        def match_template(self, ref, frame, rect):
            if self.calls >= len(self.script):
                return 0.0, None      # 脚本结束 → 画面消失，不再命中
            s = self.script[self.calls]
            self.calls += 1
            return (s, [1, 1, 2, 2]) if s >= 0.75 else (s, None)

    cfg = Cfg()
    eng = MonitorEngine(cfg)
    eng.matcher = SeqMatcher()
    hits = []
    eng.start()
    try:
        deadline = _time.time() + 6
        while _time.time() < deadline and eng.matcher.calls < 5:
            app.processEvents()
            h = eng.drain_hit()
            if h is not None:
                hits.append(h)
                eng.end_reporting()
            _time.sleep(0.02)
        tail = _time.time() + 1.0
        while _time.time() < tail:
            app.processEvents()
            h = eng.drain_hit()
            if h is not None:
                hits.append(h)
                eng.end_reporting()
            _time.sleep(0.02)
    finally:
        eng.stop()
    assert eng.matcher.calls >= 5, f"脚本未执行完: {eng.matcher.calls}"
    assert len(hits) == 4, \
        f"重复模式应报恰好 4 次(命中,命中,消失,命中,命中)，实际 {len(hits)} 次"


# ------------------------------------------------------------------
# 切片 9：多尺度匹配 —— 目标在画面中的实际大小与参考图不一致时（DPI 渲染缩放、
# 截屏来源不同、抓屏下采样叠加），也必须能命中。
# 真实场景：导入 133x58 按钮原图，屏幕按 125%~150% 渲染再被抓屏下采样，
# 目标在匹配画面里只剩参考图的 0.5~0.9 倍 → 单尺度匹配相似度永远够不到阈值。
# ------------------------------------------------------------------
def test_match_template_across_scales():
    import time as _time
    from app.core.screen_matcher import ScreenMatcher
    # 合成"真实按钮"：实心青绿 + 白色文字条 + 边缘描边（纯随机噪声对任何
    # 缩放误差都呈相关性崩塌，是病态样本，不具代表性）
    tpl = np.full((58, 133, 3), (156, 188, 26), dtype=np.uint8)   # 青绿实心
    tpl[8:20, 14:30] = 255          # "+" 块
    tpl[30:42, 40:112] = 255        # 文字条
    tpl[0:2, :] = 200
    tpl[:, 0:2] = 200               # 描边
    m = ScreenMatcher.__new__(ScreenMatcher)
    for factor in (0.7, 0.85, 1.4):
        frame = np.full((700, 1400, 3), 235, dtype=np.uint8)
        tw, th = int(133 * factor), int(58 * factor)
        frame[200:200 + th, 300:300 + tw] = cv2.resize(tpl, (tw, th),
                                                       interpolation=cv2.INTER_AREA)
        t0 = _time.perf_counter()
        sim, rect = m.match_template(tpl, frame, None)
        dt = _time.perf_counter() - t0
        assert sim >= 0.75, f"factor={factor} 未命中: sim={sim:.3f}"
        assert abs(rect[0] - 300) <= 8 and abs(rect[1] - 200) <= 8, \
            f"factor={factor} 定位偏移: {rect}"
        assert dt < 1.0, f"factor={factor} 单次匹配耗时 {dt*1000:.0f}ms，超出轮询预算"


# ------------------------------------------------------------------
# 切片 10：默认行为 —— 目标画面持续存在时按间隔反复报警（间隔=播报时长，默认 10s）
# ------------------------------------------------------------------
def test_default_repeats_alert_while_visible():
    import time as _time
    from app.core.monitor_engine import MonitorEngine

    class Cfg:
        """除轮询与播报时长外全部走程序默认值——锁定"默认重复报警"行为。"""
        def get(self, key, default=None):
            if key == "general.poll_interval_ms":
                return 80
            if key == "alert.popup_timeout_ms":
                return 600          # 缩短等待便于测试；间隔即播报时长
            return default
        def get_zones(self):
            return [{"id": "z1", "name": "t", "enabled": True, "scope": "full",
                     "rect": [], "reference_image": "x", "hit_threshold": 0.75}]

    class AlwaysHit:
        scale = 1.0
        def update_zones(self, zones): pass
        def shutdown(self): pass
        def invalidate(self, ids): pass
        def grab_full(self): return "F"
        def ref_for(self, zone): return "R"
        def match_template(self, ref, frame, rect):
            return 0.9, [1, 1, 2, 2]

    eng = MonitorEngine(Cfg())
    eng.matcher = AlwaysHit()
    hits = []
    eng.start()
    try:
        deadline = _time.time() + 2.2
        while _time.time() < deadline:
            app.processEvents()
            h = eng.drain_hit()
            if h is not None:
                hits.append(h)
                eng.end_reporting()   # 模拟每次播报结束恢复检测
            _time.sleep(0.02)
    finally:
        eng.stop()
    assert len(hits) >= 3, \
        f"默认应持续重复报警(2.2s/0.6s间隔 至少3次)，实际 {len(hits)} 次"


# ------------------------------------------------------------------
# 切片 11：告警弹窗必须置顶（WindowStaysOnTopHint），否则会被全屏/前台窗口遮挡
# ------------------------------------------------------------------
def test_alert_popup_is_always_on_top():
    from PyQt5.QtCore import Qt
    import app.ui.alert_popup as ap
    ap.show_alert_popup("测试", "置顶校验", 1000)
    try:
        app.processEvents()
        assert ap._POPUP is not None and ap._POPUP.isVisible(), "弹窗未显示"
        assert ap._POPUP.windowFlags() & Qt.WindowStaysOnTopHint, \
            "弹窗缺少 WindowStaysOnTopHint，会被前台窗口遮挡"
    finally:
        if ap._POPUP is not None:
            ap._POPUP.hide()


# ------------------------------------------------------------------
# 切片 12：告警弹窗必须出现在屏幕顶部水平居中（横幅式提示，不再靠右）
# ------------------------------------------------------------------
def test_alert_popup_top_center():
    from PyQt5.QtWidgets import QApplication
    import app.ui.alert_popup as ap
    ap.show_alert_popup("测试", "居中校验", 1000)
    try:
        app.processEvents()
        w = ap._POPUP
        assert w is not None and w.isVisible(), "弹窗未显示"
        av = QApplication.primaryScreen().availableGeometry()
        expected_x = av.x() + (av.width() - w.width()) // 2
        assert abs(w.x() - expected_x) <= 2, \
            f"弹窗应顶部水平居中: x={w.x()} 期望≈{expected_x}"
        assert abs(w.y() - (av.top() + 24)) <= 2, f"弹窗应贴近顶部: y={w.y()}"
    finally:
        if ap._POPUP is not None:
            ap._POPUP.hide()


# ------------------------------------------------------------------
# 切片 13：单实例保护 —— 同一时刻只允许一个监控实例运行，
# 否则两个实例同时检测同时播音（"两个声音"的根因）
# ------------------------------------------------------------------
def test_single_instance_lock():
    from app.single_instance import (
        acquire_single_instance_lock, release_single_instance_lock)
    first = acquire_single_instance_lock()
    try:
        assert first is True, "首次获取实例锁应成功"
        second = acquire_single_instance_lock()
        assert second is False, "第二次获取实例锁应失败（已有实例在运行）"
    finally:
        release_single_instance_lock()
    third = acquire_single_instance_lock()
    release_single_instance_lock()
    assert third is True, "释放后应可再次获取"


# ------------------------------------------------------------------
# 切片 14：自匹配防护 —— 命中位置若落在软件自身窗口内（主界面/编辑框会显示
# 参考图缩略图，多尺度匹配会命中它），必须忽略，不得报警
# ------------------------------------------------------------------
def test_engine_ignores_hits_inside_own_windows():
    import time as _time
    from app.core.monitor_engine import MonitorEngine

    class Cfg:
        def get(self, key, default=None):
            if key == "general.poll_interval_ms":
                return 80
            return default
        def get_zones(self):
            return [{"id": "z1", "name": "t", "enabled": True, "scope": "full",
                     "rect": [], "reference_image": "x", "hit_threshold": 0.75}]

    class AlwaysHit:
        scale = 1.0
        def update_zones(self, zones): pass
        def shutdown(self): pass
        def invalidate(self, ids): pass
        def grab_full(self): return "F"
        def ref_for(self, zone): return "R"
        def match_template(self, ref, frame, rect):
            return 0.99, [100, 100, 50, 40]   # 命中位置固定

    eng = MonitorEngine(Cfg())
    eng.matcher = AlwaysHit()
    eng.self_rects = [[80, 80, 300, 200]]      # 自身窗口覆盖命中位置

    def _run(seconds):
        hits = []
        eng.start()
        deadline = _time.time() + seconds
        while _time.time() < deadline:
            app.processEvents()
            h = eng.drain_hit()
            if h is not None:
                hits.append(h)
                eng.end_reporting()
            _time.sleep(0.02)
        eng.stop()
        return hits

    try:
        hits = _run(0.7)
        assert len(hits) == 0, \
            f"命中位置在自身窗口内必须忽略，实际报了 {len(hits)} 次"
        eng.self_rects = []                    # 窗口关闭/隐藏后应恢复报警
        hits2 = _run(0.7)
        assert len(hits2) >= 1, "自身窗口移除后应恢复报警"
    finally:
        eng.self_rects = []


def test_paths_module_frozen_aware():
    """打包(onefile)后 __file__ 指向临时解压目录，数据目录必须锚定 exe 所在目录。"""
    import sys as _sys
    from app import paths
    base = paths.app_base_dir()
    assert os.path.isabs(base), f"app_base_dir 非绝对路径: {base}"
    # 开发态：必须解析到项目根目录（tests/ 的上一级）
    if not getattr(_sys, "frozen", False):
        assert base == os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))), f"开发态根目录错误: {base}"
    zd = paths.zones_dir()
    assert os.path.dirname(zd) == base, f"zones 目录必须落在数据根目录下: {zd}"


def test_all_modules_importable():
    """打包事故回归：gallery_dialog 的 ZONES_DIR 改用 paths 后漏加/改坏
    import，模块级 NameError 只在 exe 启动时炸（测试没导入过该模块）。
    遍历导入 app 包下全部模块，任何模块级错误当场暴露。"""
    import importlib
    import pkgutil
    import app
    failed = []
    for mod in pkgutil.walk_packages(app.__path__, prefix="app."):
        try:
            importlib.import_module(mod.name)
        except Exception as e:
            failed.append(f"{mod.name}: {type(e).__name__}: {e}")
    assert not failed, "以下模块导入失败: " + "; ".join(failed)


def test_stop_then_start_no_zombie_thread():
    """回归：stop() 的 join 超时（一轮匹配 >2s）后线程未死却被丢弃，
    随后 start() 清掉停止事件 → 旧线程复活 + 新线程并存 → 双线程共享
    mss 并发抓屏全部失败 = "先关后开监控失效"。stop→start 后必须只有
    一个引擎线程在抓屏。"""
    import threading
    import time as _time
    from app.core.monitor_engine import MonitorEngine

    class SlowMatcher:
        def __init__(self):
            self._m = threading.Lock()
            self.concurrent = 0
            self.max_concurrent = 0
        def update_zones(self, zones): pass
        def shutdown(self): pass
        def invalidate(self, ids): pass
        def grab_full(self):
            with self._m:
                self.concurrent += 1
                self.max_concurrent = max(self.max_concurrent, self.concurrent)
            _time.sleep(2.5)          # 模拟一轮多尺度匹配超过 stop 的 join(2s)
            with self._m:
                self.concurrent -= 1
        def ref_for(self, zone): return None
        def match_template(self, *a, **k): return 0.0, None

    class Cfg:
        def get_zones(self):
            return [{"id": "z1", "enabled": True}]
        def get(self, key, default=None):
            if key == "general.poll_interval_ms":
                return 100
            return default

    eng = MonitorEngine(Cfg())
    eng.matcher = m = SlowMatcher()
    eng.start()
    _time.sleep(0.3)      # 让线程进入 grab_full 的 2.5s 长匹配
    eng.stop()            # 旧实现 join(2s) 超时返回，线程还睡在 grab 里
    eng.start()           # 旧实现清掉 _stop → 旧线程复活，与新线程并发
    _time.sleep(4.0)      # 观察窗口：若双线程并存，必然出现并发抓屏
    eng.stop()
    assert m.max_concurrent == 1, \
        f"stop→start 后出现 {m.max_concurrent} 个线程并发抓屏（僵尸线程复活）"


def test_grab_full_thread_safe():
    """grab_full 的惰性重建 mss / grab / resize 必须串行化——
    mss 实例不允许并发抓屏，并发时必须全部成功而非静默返回 None。"""
    import threading
    from app.core.screen_matcher import ScreenMatcher
    m = ScreenMatcher()
    results = []
    errors = []

    def worker():
        for _ in range(10):
            try:
                results.append(m.grab_full())
            except Exception as e:      # pragma: no cover
                errors.append(e)

    ts = [threading.Thread(target=worker) for _ in range(2)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert not errors, f"grab_full 抛异常: {errors[:2]}"
    assert results and all(f is not None for f in results), \
        f"并发抓屏出现 {sum(1 for f in results if f is None)}/{len(results)} 次 None"


def test_alert_settings_default_repeat_on():
    """回归：引擎默认"重复报警"(repeat_while_visible=True)，但告警设置
    对话框复选框默认值曾写成 False——用户开一次设置点保存就悄悄关掉
    重复报警，表现为"图片一直在桌面就不再报警，消失再现才报"。
    对话框默认值必须与引擎默认一致（True）。"""
    import tempfile
    from app.config import ConfigManager
    from app.ui.alert_settings_dialog import AlertSettingsDialog
    with tempfile.TemporaryDirectory() as td:
        cfg = ConfigManager(path=os.path.join(td, "config.json"))
        dlg = AlertSettingsDialog(cfg, parent=None)
        assert dlg.cb_repeat.isChecked(), \
            "告警设置对话框的重复报警复选框默认应为勾选（与引擎默认一致）"


def test_default_config_alert_consistency():
    """默认配置必须与引擎/播报器默认一致：重复报警开、重报间隔 10s。"""
    from app.config import DEFAULT_CONFIG
    assert DEFAULT_CONFIG["alert"].get("repeat_while_visible") is True, \
        "DEFAULT_CONFIG 必须显式声明 repeat_while_visible=True"
    assert DEFAULT_CONFIG["alert"].get("popup_timeout_ms") >= 10000, \
        "默认重报间隔(=弹窗时长)应 >= 10 秒（用户要求的节奏）"


def test_hold_seconds_snaps_to_preset():
    """重报间隔改为预设档位（5/10/30 秒）后：任意旧配置值必须自动吸附
    到最接近的档位，且默认档位是 10 秒——用户不再手动输数字。"""
    from app.ui.alert_settings_dialog import hold_preset_seconds
    assert hold_preset_seconds(10000) == 10, "默认应为 10 秒档"
    assert hold_preset_seconds(7000) == 5, "旧配置 7 秒应吸附到 5 秒档"
    assert hold_preset_seconds(13000) == 10, "13 秒更接近 10 秒档"
    assert hold_preset_seconds(25000) == 30, "25 秒应吸附到 30 秒档"
    assert hold_preset_seconds(0) == 5, "异常值 0 也必须落在合法档位"
    assert hold_preset_seconds(600000) == 30, "超出范围的值吸附到最大档"


def test_hold_preset_ui_roundtrip():
    """对话框集成：数字框换成 5/10/30 档位按钮后——
    ① 加载旧配置 7000ms 自动选中 5 秒档；
    ② 点选 30 秒档保存，配置写入 30000ms；
    ③ 无配置时默认选中 10 秒档。"""
    import tempfile
    from app.config import ConfigManager
    from app.ui.alert_settings_dialog import AlertSettingsDialog
    with tempfile.TemporaryDirectory() as td:
        cfg = ConfigManager(path=os.path.join(td, "config.json"))
        cfg.set("alert.popup_timeout_ms", 7000)
        cfg.save()
        dlg = AlertSettingsDialog(cfg, parent=None)
        assert dlg.hold_seconds == 5, \
            f"旧配置 7 秒加载后应选中 5 秒档，实际 {dlg.hold_seconds}"
        dlg.hold_seconds = 30
        dlg._save()
        assert int(cfg.get("alert.popup_timeout_ms")) == 30000, \
            f"选 30 秒档保存应写 30000ms，实际 {cfg.get('alert.popup_timeout_ms')}"
    with tempfile.TemporaryDirectory() as td:
        cfg2 = ConfigManager(path=os.path.join(td, "config.json"))
        dlg2 = AlertSettingsDialog(cfg2, parent=None)
        assert dlg2.hold_seconds == 10, \
            f"无配置时应默认选中 10 秒档，实际 {dlg2.hold_seconds}"


def test_alert_toggles_are_switch_style():
    """三个告警开关（弹窗/声音/重复报警）换成滑动开关样式后，
    行为必须不变：选中状态来自配置、保存写回同一批配置键。"""
    import tempfile
    from app.config import ConfigManager
    from app.ui.widgets import ToggleSwitch
    from app.ui.alert_settings_dialog import AlertSettingsDialog
    with tempfile.TemporaryDirectory() as td:
        cfg = ConfigManager(path=os.path.join(td, "config.json"))
        cfg.set("alert.popup_enabled", False)
        cfg.set("alert.play_sound", False)
        cfg.set("alert.repeat_while_visible", False)
        cfg.save()
        dlg = AlertSettingsDialog(cfg, parent=None)
        for name in ("cb_popup", "cb_sound", "cb_repeat"):
            w = getattr(dlg, name)
            assert isinstance(w, ToggleSwitch), \
                f"{name} 应为滑动开关 ToggleSwitch，实际 {type(w).__name__}"
            assert not w.isChecked(), f"{name} 加载 False 配置后应为关"
        dlg.cb_popup.setChecked(True)
        dlg.cb_sound.setChecked(True)
        dlg.cb_repeat.setChecked(True)
        dlg._save()
        assert cfg.get("alert.popup_enabled") is True
        assert cfg.get("alert.play_sound") is True
        assert cfg.get("alert.repeat_while_visible") is True


def test_toggle_switch_knobs_align_in_column():
    """滑动开关的滑槽必须固定锚在控件右缘——与文字长度无关，
    多行开关在同一表单里滑块才能对齐成一列（用户截图反馈"样式不均"）。"""
    from app.ui.widgets import ToggleSwitch
    short = ToggleSwitch("触发时播放声音")
    long = ToggleSwitch("画面持续存在时重复报警（推荐）")
    for w in (short, long):
        w.resize(420, 28)
    assert short._knob_rect()[0] == long._knob_rect()[0], \
        f"不同文字长度的开关滑槽 x 必须相同: {short._knob_rect()[0]} vs {long._knob_rect()[0]}"


def test_hold_preset_buttons_uniform():
    """重报间隔档位按钮必须尺寸统一（标准按钮），且互斥可选。"""
    import tempfile
    from app.config import ConfigManager
    from app.ui.alert_settings_dialog import AlertSettingsDialog
    with tempfile.TemporaryDirectory() as td:
        cfg = ConfigManager(path=os.path.join(td, "config.json"))
        dlg = AlertSettingsDialog(cfg, parent=None)
        btns = [b for b in dlg._hold_group.buttons()]
        assert len(btns) == 3
        sizes = {(b.minimumWidth(), b.minimumHeight()) for b in btns}
        assert len(sizes) == 1, f"档位按钮尺寸必须统一，实际 {sizes}"
        assert all(b.isCheckable() for b in btns), "档位按钮必须可选中（互斥档位）"


def test_play_cancels_previous_playback():
    """重报间隔(5s)可能短于语音播报时长 → 连续两次 play() 绝不允许
    叠音：第二次播放开始前，第一次播放必须被停止（收到停止信号）。"""
    import time as _time
    import threading
    import app.core.sound as sound

    results = []

    def fake_play_file(path, stop_ev):
        # 模拟一段 2 秒的语音：只有被 stop 才会提前结束
        stop_ev.wait(2.0)
        results.append((path, stop_ev.is_set()))

    orig = sound._play_file
    sound._play_file = fake_play_file
    try:
        sound.play("fake.mp3")
        deadline = _time.time() + 2
        while _time.time() < deadline and not sound.is_playing():
            _time.sleep(0.01)
        assert sound.is_playing(), "第一次播放应处于 is_playing 状态"
        sound.play("fake.mp3")   # 第二次报警：必须先掐断第一次
        deadline = _time.time() + 4
        while _time.time() < deadline and len(results) < 2:
            _time.sleep(0.02)
        assert len(results) == 2, f"应有两次播放结束，实际 {len(results)}"
        assert results[0][1] is True, "第一次播放必须被第二次播放停止（而不是播完自然结束）"
    finally:
        sound._play_file = orig
        sound.stop()


def test_announcer_waits_for_sound_before_resuming():
    """播报时长(5s)到点但语音还没播完时，绝不能恢复检测开新一轮
    （否则新报警叠到旧语音上）；语音播完才恢复。"""
    import tempfile
    import app.core.sound as sound
    from app.config import ConfigManager
    from app.core.announcer import Announcer

    class StubEngine:
        def begin_reporting(self): pass
        def end_reporting(self): self.resumed = True
        resumed = False
        def drain_hit(self): return None

    with tempfile.TemporaryDirectory() as td:
        cfg = ConfigManager(path=os.path.join(td, "config.json"))
        cfg.set("alert.popup_timeout_ms", 5000)
        eng = StubEngine()
        ann = Announcer(cfg, engine=eng)
        ann._active = True
        ann._report_start_ms = 0.0   # 早已超过 5s
        orig_is_playing = sound.is_playing
        sound.is_playing = lambda: True
        try:
            ann._tick()
            assert not eng.resumed, "语音未播完时不得恢复检测（否则叠音）"
        finally:
            sound.is_playing = orig_is_playing
        sound.is_playing = lambda: False
        try:
            ann._tick()
            assert eng.resumed, "语音播完且超时应恢复检测（进入下一轮重报）"
        finally:
            sound.is_playing = orig_is_playing


def test_toggle_switch_clickable_on_painted_track():
    """开关的可点击热区必须覆盖自绘滑槽（控件右缘）——否则用户点
    可见开关没反应（上一版热区还留在默认样式的左侧不可见区域）。"""
    from PyQt5.QtCore import QPoint
    from app.ui.widgets import ToggleSwitch
    sw = ToggleSwitch("触发时弹出置顶提示框")
    sw.resize(300, 28)
    assert sw.hitButton(QPoint(sw.width() - 20, sw.height() // 2)), \
        "滑槽区域必须可点击切换"
    assert sw.hitButton(QPoint(10, sw.height() // 2)), "文字区域也应可点击"


def test_unicode_safe_image_io():
    """图片读写必须走 Unicode 安全通道（imdecode/imencode）——
    cv2.imread/imwrite 在 Windows 上走 ANSI 编码路径，文件名含 GBK
    编不了的字符（emoji、特殊符号）时静默失败 → 上传"无效"、预览空。
    用户实测症状：选图后无预览 + 提示无法读取。"""
    import tempfile
    from app.core.imio import read_image, write_image
    img = np.zeros((24, 56, 3), dtype=np.uint8)
    img[:, :, 0] = 200
    with tempfile.TemporaryDirectory() as td:
        for name in ("微信图片_2026.png", "screenshot 😀.png", "plain.png"):
            p = os.path.join(td, name)
            assert write_image(p, img), f"write_image 失败: {name}"
            back = read_image(p)
            assert back is not None and back.shape == img.shape, \
                f"read_image 失败: {name}"
        assert read_image(os.path.join(td, "不存在.png")) is None


def test_upload_flow_logging():
    """上传/图库选图的每一步必须落日志（选了哪个路径、读取是否成功），
    便于"上传无效"这类用户反馈能靠 notic_error.log 定位。"""
    import logging, tempfile
    from app.core.imio import read_image, write_image
    records = []

    class Cap(logging.Handler):
        def emit(self, r):
            records.append(r)

    h = Cap()
    logging.getLogger("notic.imio").addHandler(h)
    logging.getLogger("notic.imio").setLevel(logging.INFO)
    try:
        img = np.zeros((10, 10, 3), dtype=np.uint8)
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "a.png")
            write_image(p, img)
            read_image(p)
            read_image(os.path.join(td, "缺.png"))
    finally:
        logging.getLogger("notic.imio").removeHandler(h)
    msgs = [r.getMessage() for r in records]
    assert any("读取" in m and "a.png" in m for m in msgs), f"读取成功未落日志: {msgs}"
    assert any("失败" in m and "缺.png" in m for m in msgs), f"读取失败未落日志: {msgs}"


def test_alert_popup_refresh_restarts_auto_hide():
    """连续两次报警：第二次必须**重排**自动消失的计时。

    旧实现每次 refresh 都排一个新的 QTimer.singleShot 且从不取消前一个：
    第一次的计时到点会把第二次的弹窗提前隐藏。监控场景里
    「没看见 = 没报警」，这是最不能接受的失败方式。
    """
    import time as _time
    import app.ui.alert_popup as ap

    ap.show_alert_popup("第一次", "短展示", 1000)      # 实际按下限 2500ms 排
    ap.show_alert_popup("第二次", "长展示", 6000)
    try:
        app.processEvents()
        # 熬过第一次的 2500ms：此时应当**仍然可见**（计时已被重排到 6000ms）
        deadline = _time.time() + 3.2
        while _time.time() < deadline:
            app.processEvents()
            _time.sleep(0.02)
        assert ap._POPUP is not None and ap._POPUP.isVisible(), \
            "第二次报警被第一次的计时提前隐藏了（新弹窗只显示了约 2.5 秒）"
        # 本次时长到点后必须自动消失 —— 自动隐藏本身没坏
        deadline = _time.time() + 4.0
        while _time.time() < deadline and ap._POPUP is not None and ap._POPUP.isVisible():
            app.processEvents()
            _time.sleep(0.02)
        assert ap._POPUP is not None and not ap._POPUP.isVisible(), \
            "重排之后仍应在本次时长结束时自动消失"
    finally:
        if ap._POPUP is not None:
            ap._POPUP.hide()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
        except Exception as e:
            failed += 1
            print(f"ERROR {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} 通过")
    sys.exit(1 if failed else 0)
