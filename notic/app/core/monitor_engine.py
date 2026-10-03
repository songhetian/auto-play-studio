# -*- coding: utf-8 -*-
"""屏幕监控引擎：后台线程按固定间隔轮询各监控区。
命中目标时发出告警事件，播放播报期间暂停检测，播完恢复；若画面仍在则自然续播。

- 若已在播报（reporting），本轮 tick 直接跳过。
- 相似度 >= hit_threshold → 命中 → 将命中消息压入线程安全队列 → 触发播报 → reporting 暂停轮询。
- 播报结束 → end_reporting() → 恢复轮询。下一轮若仍命中 → 再次触发 → 循环。
- 画面消失后，命中不再发生 → 自然停播，回到正常监测。

线程模型：引擎线程完全"不碰 Qt"。命中结果放到带容量上限的队列，
由主线程的定时器轮询取走并触发播报，避免跨线程 Qt 信号造成界面卡死。
"""
import logging
import os
import queue
import threading
import time
import uuid

from .screen_matcher import ScreenMatcher

_log = logging.getLogger("notic.engine")

# 命中队列容量：只保留最新一次命中，播报期间后续命中直接丢弃，不堆积
_HIT_CAP = 1


def make_zone_id():
    return "z" + uuid.uuid4().hex[:8]


def missing_ref_zone_ids(zones):
    """返回参考图缺失/不可读的启用监控区 id 列表。

    用于状态栏提示——参考图缺失的监控区永远不会命中，属于
    "设置了却监控不到"且最容易被忽视的场景。
    """
    missing = []
    for z in zones or []:
        if not z.get("enabled", True):
            continue
        path = z.get("reference_image", "")
        if not path or not os.path.isfile(path):
            missing.append(z.get("id"))
    return missing


def _rects_intersect(a, b):
    """判断两个 [x,y,w,h] 矩形是否相交（自匹配防护用）。"""
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


class MonitorEngine:
    """管理区域列表、轮询线程与播报暂停；向主线程暴露线程安全命中队列。"""

    def __init__(self, config, event_hub=None):
        self.config = config
        self.event_hub = event_hub
        self.matcher = ScreenMatcher()
        self._lock = threading.RLock()
        self._thread = None
        self._stop = threading.Event()
        self._hits = queue.Queue(maxsize=_HIT_CAP)
        self._reporting = False
        self._running = False
        self._error = None
        # "只报一次"状态：画面出现→报一次；画面一直在→不再重复；
        # 画面消失（任一轮未命中）→解除，再次出现才再报。配置 alert.repeat_while_visible=True 时退回旧行为（持续重复提醒）。
        self._active_hits = set()
        # 自匹配防护：主线程定期发布的"自身可见窗口矩形"（物理像素 [x,y,w,h]）。
        # 主界面/编辑框会显示参考图缩略图，多尺度匹配会把模板缩小后命中缩略图，
        # 造成"图片明明关了还在报警"。命中位置落在这些矩形内的一律忽略。
        self.self_rects = []
        self._self_hit_log_ts = {}   # 自匹配忽略日志的节流（每区 30 秒一条）

    # ---------- 生命周期 ----------
    def start(self):
        # 关键（僵尸线程收尸）：stop() 的 join 可能超时返回而旧线程还活着
        # （一轮多尺度匹配可以超过 2s）。此时绝不能直接清 _stop 再起新线程——
        # 旧线程会在下一轮循环看到 _stop 被清而"复活"，与新线程并存，
        # 两个线程共享同一 mss 实例并发抓屏 → 全部失败 = "先关后开监控失效"。
        old = self._thread
        if old is not None and old.is_alive():
            _log.warning("start: 旧引擎线程仍存活，先等待其退出")
            self._stop.set()
            deadline = time.time() + 8
            while old.is_alive() and time.time() < deadline:
                old.join(timeout=0.5)
            if old.is_alive():
                _log.error("start: 旧引擎线程 8s 仍未退出，放弃本次启动")
                return
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop.clear()
            self._reporting = False
            self._rebuild_cache_locked()
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()
            self._running = True

    def stop(self):
        with self._lock:
            self._stop.set()
            self._running = False
            self._reporting = False
            t = self._thread
        if t:
            t.join(timeout=2.0)
            if t.is_alive():
                # 一轮匹配可能超过 join(2s)：有界等它自然退出，
                # 超时则保留线程引用（不丢弃），让下次 start() 收尸，
                # 避免僵尸线程在 start() 清掉 _stop 后复活。
                _log.warning("stop: 引擎线程 2s 内未退出，继续等待（最长 8s）")
                deadline = time.time() + 8
                while t.is_alive() and time.time() < deadline:
                    t.join(timeout=0.5)
            if t.is_alive():
                _log.error("stop: 引擎线程 8s 仍未退出，保留引用由 start() 兜底")
                with self._lock:
                    self._thread = t
            else:
                with self._lock:
                    if self._thread is t:
                        self._thread = None
        self.matcher.shutdown()

    @property
    def running(self):
        return self._running and not self._reporting

    @property
    def reporting(self):
        with self._lock:
            return self._reporting

    @property
    def last_error(self):
        return self._error

    # ---------- 播报控制 ----------
    def begin_reporting(self):
        with self._lock:
            self._reporting = True

    def end_reporting(self):
        with self._lock:
            self._reporting = False

    def drain_hit(self):
        """主线程取走一条命中消息；没有则返回 None（非阻塞）。"""
        try:
            return self._hits.get_nowait()
        except queue.Empty:
            return None

    # ---------- 配置热更新 ----------
    def reload(self):
        """通知引擎重新加载区域配置（增删改后调用）。线程意外死亡时自动复活。"""
        with self._lock:
            self._rebuild_cache_locked()
            t = self._thread
        if self._running and (t is None or not t.is_alive()):
            _log.warning("引擎线程已死亡，reload 时自动重启")
            self.start()

    def _rebuild_cache_locked(self):
        zones = self.config.get_zones()
        self.matcher.update_zones(zones)

    # ---------- 主循环 ----------
    def _loop(self):
        interval = max(0.1, self.config.get("general.poll_interval_ms", 500) / 1000.0)
        while not self._stop.is_set():
            try:
                # 关键：绝不在持有 _lock 的状态下 wait。原实现 reporting 分支持锁
                # wait(interval)，导致主线程 begin_reporting / end_reporting /
                # reload / reporting 属性每次都要被卡 200~800ms（实测），Qt 事件
                # 循环被反复堵死 → 报警瞬间界面卡死/未响应。这里只短暂读状态，
                # 等待一律放在锁外。
                with self._lock:
                    reporting = self._reporting
                    zones = None if reporting else [
                        z for z in self.config.get_zones() if z.get("enabled", True)]
                if reporting:
                    self._stop.wait(interval)
                    continue
                if not zones:
                    self._stop.wait(interval)
                    continue
                frame = self.matcher.grab_full()
                if frame is None:
                    self._stop.wait(interval)
                    continue
                for zone in zones:
                    # 快速停机：每区之间检查停止事件，保证 stop() 的 join
                    # 能在一轮内尽快等到线程退出（而不是等完整轮匹配）
                    if self._stop.is_set():
                        break
                    ref = self.matcher.ref_for(zone)
                    if ref is None:
                        continue
                    # 局部：只在框定区域搜索；整屏：全屏搜索目标图出现位置
                    scale = self.matcher.scale
                    if zone.get("scope") == "full":
                        search_rect = None
                    else:
                        # 抓屏已整体下采样，区域坐标要同步换算到缩放后的帧坐标
                        rx, ry, rw, rh = zone.get("rect", [0, 0, 0, 0])
                        search_rect = [int(rx * scale), int(ry * scale),
                                       int(rw * scale), int(rh * scale)]
                    sim, best_rect = self.matcher.match_template(ref, frame, search_rect)
                    zid = zone.get("id")
                    if sim < float(zone.get("hit_threshold", 0.75)):
                        # 本轮未命中 → 画面已消失，解除"已报过"标记
                        self._active_hits.discard(zid)
                        continue
                    # 画面持续存在且已提醒过 → 不重复报警（只报一次模式）
                    if (not self.config.get("alert.repeat_while_visible", True)
                            and zid in self._active_hits):
                        continue
                    # 自匹配防护：命中位置落在软件自身窗口内（缩略图/预览图）
                    # → 这是软件自己显示的参考图，不是屏幕上真实出现的目标，忽略
                    if best_rect is not None and any(
                            _rects_intersect(best_rect, r)
                            for r in self.self_rects):
                        now = time.time()
                        if now - self._self_hit_log_ts.get(zid, 0) > 30:
                            self._self_hit_log_ts[zid] = now
                            _log.info("命中(%s) 位于软件自身窗口内，已忽略（防缩略图自匹配误报）", zid)
                        continue
                    with self._lock:
                        # 命中即将进入播报：立即置位 reporting，停止本轮后续区域与下一轮轮询
                        if self._reporting:
                            break
                        self._reporting = True
                    loc = ""
                    if best_rect is not None and scale != 1.0:
                        # 匹配坐标是缩放帧坐标，换算回物理像素便于提示
                        rx, ry, rw, rh = best_rect
                        loc = f"位置({int(rx/scale)},{int(ry/scale)})"
                    elif best_rect is not None:
                        loc = f"位置({best_rect[0]},{best_rect[1]})"
                    msg = f'「{zone.get("name", zone.get("id"))}」出现目标画面，{loc}（相似度 {sim:.0%}）'
                    # 命中落日志：出现"关了图还在报警"类问题时，可据此核对匹配位置与分数
                    _log.info("命中: %s %s 相似度=%.0f%%", zid, loc, sim * 100)
                    self._active_hits.add(zid)
                    # 压入线程安全队列（容量1，播报期间后续命中自动丢弃），主线程定时器取走
                    try:
                        self._hits.put({"zone": zid, "message": msg}, block=False)
                    except queue.Full:
                        pass
                    break
                self._stop.wait(interval)
            except Exception:
                # 兜底：循环内任何异常都不允许杀死引擎线程——线程一死，
                # 新增/修改监控区都会"永远无效"且无任何报错（历史卡死表现之一）。
                _log.exception("监控轮询异常（已捕获，继续下一轮）")
                self._stop.wait(interval)