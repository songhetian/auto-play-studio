"""桌面图片监控执行内核：复用 notic 的 OpenCV 模板匹配，做成可注入、可测试的执行器。

定位（与项目约定一致）：
- 设备层（mss 抓屏、图像素材库读取、声音/弹窗）只人工验收，所以 Grabber / ReferenceLoader
  之间留注入点，自动化测试只注入假实现。
- 匹配算法直接复用 notic 的 `match_template`（纯 OpenCV，不依赖 mss/PyQt5）：
  构造 `ScreenMatcher.__new__(ScreenMatcher)` 即可跳过 mss 设备初始化，notic 自己的
  离线自检也用这个手法。
- MonitorEngine 不持有线程、不碰 PyQt5/winmm；pause/stop 由 runner 的状态机驱动
  （与 rpa / logi / cmp 一致），命中通过 `on_hit` 回调 / 日志流上报，供运行详情页展示。
"""
from __future__ import annotations

import os
import sys
import threading
from typing import Callable, Protocol, runtime_checkable

import cv2
import numpy as np

# 复用 notic 的模板匹配算法（仓库根 notic/app/core/screen_matcher.py）。
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_NOTIC = os.path.join(_REPO_ROOT, "notic")
if _NOTIC not in sys.path:
    sys.path.insert(0, _NOTIC)
from app.core.screen_matcher import ScreenMatcher  # noqa: E402


@runtime_checkable
class Grabber(Protocol):
    """抓屏设备。真机用 mss，测试用 FakeGrabber。返回 BGR ndarray，失败返回 None。"""

    def grab(self) -> "np.ndarray | None":
        ...


@runtime_checkable
class ReferenceLoader(Protocol):
    """按 assetId 取参考图。真机用图像素材库，测试用 FakeRefLoader。"""

    def load(self, asset_id: str) -> "np.ndarray | None":
        ...


#: 命中事件：(asset_id, 相似度 0~1, 命中的物理像素矩形 [x,y,w,h] 或 None)
Hit = tuple[str, float, "list[int] | None"]
#: 命中回调：runner 用来落日志 / 写运行详情
HitSink = Callable[[str, float, "list[int] | None"], None]


def _match(ref: np.ndarray, frame: np.ndarray, search_rect) -> tuple[float, "list[int] | None"]:
    """复用 notic 的多尺度模板匹配（构造时不打开 mss）。"""
    return ScreenMatcher.__new__(ScreenMatcher).match_template(ref, frame, search_rect)


def _parse_region(region: str) -> tuple[str, "list[int] | None"]:
    """把 monitor 配置的 region 解析成 (scope, rect)。

    - "full" / 空 / 非法 → 整屏搜索
    - "x,y,w,h" → 局部搜索
    """
    if not region or region.strip().lower() == "full":
        return "full", None
    parts = [p.strip() for p in region.split(",")]
    if len(parts) == 4 and all(p.isdigit() for p in parts):
        return "region", [int(p) for p in parts]
    # 非法 region 退回整屏，避免配置写错就全盘失效
    return "full", None


def build_zones(cfg: dict) -> list[dict]:
    """把 {region, rules:[{assetId, threshold}]} 映射成 notic 风格 zone 列表。

    单一 region 作为所有 rule 的共享搜索范围（新程序 schema 不支持逐 rule 独立区域）。
    空的 assetId 直接跳过，不让一条坏的 rule 拖垮整批监控。
    """
    scope, rect = _parse_region(cfg.get("region", "") or "")
    zones: list[dict] = []
    for rule in cfg.get("rules", []) or []:
        asset_id = rule.get("assetId")
        if not asset_id:
            continue
        zones.append({
            "id": asset_id,
            "name": asset_id,
            "enabled": True,
            "scope": scope,
            "rect": rect if rect is not None else [0, 0, 0, 0],
            "hit_threshold": float(rule.get("threshold", 0.85)),
        })
    return zones


def missing_ref_zone_ids(zones: list[dict], ref_loader: ReferenceLoader) -> list[str]:
    """参考图加载失败的启用 zone id 列表（参考图缺失的监控区永远不会命中）。"""
    missing: list[str] = []
    for z in zones:
        if not z.get("enabled", True):
            continue
        ref = ref_loader.load(z["id"])
        if ref is None or ref.size == 0:
            missing.append(z["id"])
    return missing


def _rects_intersect(a: list[int], b: list[int]) -> bool:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return ax < bx + bw and bx < ax + aw and ay < by + bh and by < ay + ah


class MonitorEngine:
    """可注入的检测内核：一次 poll_once() 完成「抓帧→逐 rule 匹配→去重→返回命中」。

    不持有线程、不碰设备层的声音/弹窗；pause/stop 由调用方（runner）控制节奏。
    """

    def __init__(
        self,
        cfg: dict,
        grabber: Grabber,
        ref_loader: ReferenceLoader,
        on_hit: HitSink | None = None,
        on_log: Callable[[str], None] | None = None,
        poll_interval_ms: int = 500,
    ) -> None:
        self._cfg = cfg
        self._grabber = grabber
        self._ref_loader = ref_loader
        self._on_hit = on_hit
        self._on_log = on_log or (lambda m: None)
        self._poll_interval = max(0.1, poll_interval_ms / 1000.0)
        self._zones = build_zones(cfg)
        self._active_hits: set[str] = set()  # 已报过的 zone（画面持续存在不再重复报）
        self._lock = threading.Lock()

    @property
    def zones(self) -> list[dict]:
        return self._zones

    @property
    def poll_interval(self) -> float:
        return self._poll_interval

    def reload(self, cfg: dict | None = None) -> None:
        """配置热更新：增删 rule 后重建 zone 列表，清空去重状态。"""
        if cfg is not None:
            self._cfg = cfg
        self._zones = build_zones(self._cfg)
        self._active_hits.clear()

    def poll_once(self) -> list[Hit]:
        """抓一帧并匹配所有 zone，返回本轮新命中（已报过的不再重复）。

        返回空列表表示本轮无新命中。抓屏失败/无参考图均安全跳过。
        """
        frame = self._grabber.grab()
        if frame is None:
            return []
        hits: list[Hit] = []
        with self._lock:
            active = set(self._active_hits)
        for zone in self._zones:
            if not zone.get("enabled", True):
                continue
            ref = self._ref_loader.load(zone["id"])
            if ref is None or ref.size == 0:
                continue
            if zone.get("scope") == "full":
                search_rect = None
            else:
                # 本引擎抓屏不做整体下采样（mss 原始分辨率），rect 直接用物理像素
                search_rect = list(zone.get("rect", [0, 0, 0, 0]))
            sim, best_rect = _match(ref, frame, search_rect)
            zid = zone["id"]
            if sim < float(zone.get("hit_threshold", 0.85)):
                # 本轮未命中 → 画面已消失，解除"已报过"标记
                active.discard(zid)
                continue
            if zid in active:
                # 画面持续存在且已报过 → 只报一次，不重复
                continue
            active.add(zid)
            loc = ""
            if best_rect is not None:
                loc = f"位置({best_rect[0]},{best_rect[1]})"
            # 命中位置/分数交给 on_hit 实时消费者（声音/UI）；落日志由 runner 统一处理，
            # 避免引擎与 runner 双重写日志。
            if self._on_hit is not None:
                self._on_hit(zid, sim, best_rect)
            hits.append((zid, sim, best_rect))
        with self._lock:
            self._active_hits = active
        return hits


# ── 真实实现（设备层，仅真机验收） ──
class MssGrabber:
    """mss 抓虚拟全屏（惰性打开，停止后可重建）。测试中不实例化。"""

    def __init__(self) -> None:
        self._sct = None
        self._lock = threading.Lock()

    def grab(self) -> "np.ndarray | None":
        with self._lock:
            try:
                if self._sct is None:
                    import mss
                    self._sct = mss.mss()
                monitor = self._sct.monitors[0]
                shot = self._sct.grab(monitor)
                bgr = np.asarray(shot, dtype=np.uint8)[:, :, :3]
                return bgr
            except Exception:
                return None

    def shutdown(self) -> None:
        with self._lock:
            if self._sct is not None:
                try:
                    self._sct.close()
                except Exception:
                    pass
                self._sct = None


class AssetReferenceLoader:
    """按 assetId 从图像素材库取参考图（Unicode 安全读取，复用 notic.imio 的字节流通道）。"""

    def load(self, asset_id: str) -> "np.ndarray | None":
        from engine import image_library

        rec = image_library.get_image(asset_id)
        if not rec:
            return None
        path = rec.get("path", "")
        if not path or not os.path.isfile(path):
            return None
        buf = np.fromfile(path, dtype=np.uint8)
        if buf.size == 0:
            return None
        return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def build_monitor(
    cfg: dict,
    on_hit: HitSink | None = None,
    on_log: Callable[[str], None] | None = None,
    grabber: Grabber | None = None,
    ref_loader: ReferenceLoader | None = None,
) -> MonitorEngine:
    """构造真实监控内核（抓屏/参考图用默认实现，可注入以覆盖）。"""
    return MonitorEngine(
        cfg,
        grabber or MssGrabber(),
        ref_loader or AssetReferenceLoader(),
        on_hit=on_hit,
        on_log=on_log,
        poll_interval_ms=int(cfg.get("pollIntervalMs", 500)),
    )


def make_alert(cfg: dict) -> "HitSink | None":
    """构造命中声音告警回调（设备层，仅 Windows 真机有效；失败静默降级）。

    复用 notic 的 ``sound.play``（winmm MCI + 系统 TTS）。非 Windows 或依赖缺失时
    导入即失败，这里吞掉异常，绝不让声音影响监控主流程。按约定声音不进自动化测试。
    """
    if not cfg.get("alertSound", True):
        return None
    text = cfg.get("alertText") or "出现目标图片 请查看"

    def _alert(_asset_id: str, _sim: float, _rect) -> None:
        try:
            from app.core.sound import play
            play(text=text, repeat=1)
        except Exception:
            pass

    return _alert
