"""Seam：桌面图片监控执行内核（复用 notic 的 OpenCV 模板匹配）。

设备层（mss 抓屏、图像素材库读取、声音/弹窗）只人工验收，所以在 Grabber / ReferenceLoader
之间留注入点：测试注入 FakeGrabber / FakeRefLoader，验证的是「配置映射、阈值判定、区域限制、
去重、缺失参考图」这些纯逻辑。匹配本身直接复用 notic 的 match_template（真实算法）。
"""
from __future__ import annotations

import time

import numpy as np
import pytest

from engine import db
from engine.monitor import (
    AssetReferenceLoader,
    Grabber,
    MonitorEngine,
    ReferenceLoader,
    build_monitor,
    build_zones,
    missing_ref_zone_ids,
)
from tests.helpers import make_runner


# ── 构造帧/模板的小工具 ──
def _template(h: int = 60, w: int = 80) -> np.ndarray:
    return np.random.randint(0, 256, (h, w, 3), dtype=np.uint8)


def _frame_with(h: int, w: int, tpl: np.ndarray, at: tuple[int, int]) -> np.ndarray:
    """构造一张纯色大图，并在 (y,x) 处嵌入 tpl（精确嵌入 → 相似度≈1）。"""
    frame = np.full((h, w, 3), 230, dtype=np.uint8)
    y, x = at
    th, tw = tpl.shape[:2]
    frame[y:y + th, x:x + tw] = tpl
    return frame


class FakeGrabber:
    def __init__(self, frame: np.ndarray | None) -> None:
        self._frame = frame

    def grab(self) -> np.ndarray | None:
        return self._frame


class FakeRefLoader:
    def __init__(self, refs: dict[str, np.ndarray | None]) -> None:
        self._refs = refs

    def load(self, asset_id: str) -> np.ndarray | None:
        return self._refs.get(asset_id)


# ── 配置映射 ──
def test_build_zones_full_scope():
    cfg = {"region": "full", "rules": [
        {"assetId": "a", "threshold": 0.9},
        {"assetId": "b", "threshold": 0.8},
    ]}
    zones = build_zones(cfg)
    assert [z["id"] for z in zones] == ["a", "b"]
    assert zones[0]["scope"] == "full"
    assert zones[0]["hit_threshold"] == 0.9
    assert zones[1]["hit_threshold"] == 0.8
    assert zones[1]["rect"] == [0, 0, 0, 0]


def test_build_zones_region_scope():
    cfg = {"region": "100,200,300,400", "rules": [{"assetId": "a", "threshold": 0.85}]}
    zones = build_zones(cfg)
    assert len(zones) == 1
    assert zones[0]["scope"] == "region"
    assert zones[0]["rect"] == [100, 200, 300, 400]


def test_build_zones_skips_blank_asset_id():
    cfg = {"region": "full", "rules": [
        {"assetId": "", "threshold": 0.9},
        {"assetId": "a", "threshold": 0.9},
    ]}
    zones = build_zones(cfg)
    assert [z["id"] for z in zones] == ["a"]


def test_build_zones_empty_region_falls_back_to_full():
    cfg = {"region": "", "rules": [{"assetId": "a", "threshold": 0.85}]}
    zones = build_zones(cfg)
    assert zones[0]["scope"] == "full"


# ── 匹配 / 阈值 ──
def test_poll_once_reports_hit_when_similarity_above_threshold():
    tpl = _template()
    frame = _frame_with(400, 600, tpl, (100, 150))
    eng = MonitorEngine(
        {"region": "full", "rules": [{"assetId": "a", "threshold": 0.85}]},
        FakeGrabber(frame), FakeRefLoader({"a": tpl}),
    )
    hits = eng.poll_once()
    assert len(hits) == 1
    asset_id, sim, rect = hits[0]
    assert asset_id == "a"
    assert sim >= 0.85
    assert rect is not None


def test_poll_once_no_hit_when_target_absent():
    tpl = _template()
    frame = np.full((400, 600, 3), 230, dtype=np.uint8)  # 不含目标图
    eng = MonitorEngine(
        {"region": "full", "rules": [{"assetId": "a", "threshold": 0.85}]},
        FakeGrabber(frame), FakeRefLoader({"a": tpl}),
    )
    assert eng.poll_once() == []


def test_poll_once_high_threshold_skips_low_similarity():
    """目标图以微扰形式出现（相似度 < 0.999），高阈值 zone 跳过、低阈值 zone 命中。"""
    tpl = _template()
    frame = _frame_with(400, 600, tpl, (100, 150))
    # 轻微扰动：让精确匹配分数降到 ~0.97 区间，验证阈值边界而非随机嵌入的 1.0
    noise = frame.copy()
    noise[100:160, 150:230] = np.clip(tpl.astype(int) + 6, 0, 255).astype(np.uint8)
    eng = MonitorEngine(
        {"region": "full", "rules": [
            {"assetId": "strict", "threshold": 0.999},
            {"assetId": "loose", "threshold": 0.5},
        ]},
        FakeGrabber(noise),
        FakeRefLoader({"strict": tpl, "loose": tpl}),
    )
    hits = eng.poll_once()
    ids = [h[0] for h in hits]
    assert "strict" not in ids, "高于实际相似度的阈值不应命中"
    assert "loose" in ids


# ── 区域限制 ──
def test_poll_once_region_restricts_search():
    tpl = _template()
    # 目标图嵌在 (500,500)，用更大画布
    frame = _frame_with(700, 800, tpl, (500, 500))
    # 区域不包含目标 → 不命中
    eng_out = MonitorEngine(
        {"region": "0,0,100,100", "rules": [{"assetId": "a", "threshold": 0.85}]},
        FakeGrabber(frame), FakeRefLoader({"a": tpl}),
    )
    assert eng_out.poll_once() == []
    # 区域覆盖目标 → 命中
    eng_in = MonitorEngine(
        {"region": "400,400,300,300", "rules": [{"assetId": "a", "threshold": 0.85}]},
        FakeGrabber(frame), FakeRefLoader({"a": tpl}),
    )
    hits = eng_in.poll_once()
    assert len(hits) == 1


# ── 去重：画面持续存在只报一次 ──
def test_poll_once_dedup_reports_once_while_visible():
    tpl = _template()
    frame = _frame_with(400, 600, tpl, (100, 150))
    eng = MonitorEngine(
        {"region": "full", "rules": [{"assetId": "a", "threshold": 0.85}]},
        FakeGrabber(frame), FakeRefLoader({"a": tpl}),
    )
    first = eng.poll_once()
    assert len(first) == 1, "首次出现应报一次"
    second = eng.poll_once()
    assert second == [], "画面仍在不应重复报"


def test_poll_once_rededup_after_disappear():
    tpl = _template()
    present = _frame_with(400, 600, tpl, (100, 150))
    absent = np.full((400, 600, 3), 230, dtype=np.uint8)
    loader = FakeRefLoader({"a": tpl})
    eng = MonitorEngine(
        {"region": "full", "rules": [{"assetId": "a", "threshold": 0.85}]},
        FakeGrabber(present), loader,
    )
    assert len(eng.poll_once()) == 1
    # 画面消失一轮：解除"已报过"
    eng._grabber = FakeGrabber(absent)  # 直接换抓屏源，模拟消失
    assert eng.poll_once() == []
    # 再次出现：应再次报
    eng._grabber = FakeGrabber(present)
    assert len(eng.poll_once()) == 1


# ── 缺失参考图 ──
def test_poll_once_skips_zone_with_missing_reference():
    tpl = _template()
    frame = _frame_with(400, 600, tpl, (100, 150))
    # 参考图加载失败（None）→ 该 zone 被跳过，不报错、不命中
    eng = MonitorEngine(
        {"region": "full", "rules": [{"assetId": "missing", "threshold": 0.85}]},
        FakeGrabber(frame), FakeRefLoader({"missing": None}),
    )
    assert eng.poll_once() == []


def test_missing_ref_zone_ids_lists_enabled_zones_without_reference():
    zones = build_zones({"region": "full", "rules": [
        {"assetId": "ok", "threshold": 0.85},
        {"assetId": "gone", "threshold": 0.85},
    ]})
    loader = FakeRefLoader({"ok": _template(), "gone": None})
    assert missing_ref_zone_ids(zones, loader) == ["gone"]


# ── 真实参考图加载器（接图像素材库）──
def test_asset_reference_loader_reads_from_library(add_asset):
    rec = add_asset("目标图", width=20, height=16)
    loader = AssetReferenceLoader()
    img = loader.load(rec["id"])
    assert img is not None
    assert img.shape[0] == 16 and img.shape[1] == 20


def test_asset_reference_loader_returns_none_for_unknown():
    assert AssetReferenceLoader().load("img_does_not_exist") is None


# ── build_monitor 接线：on_hit 回调 ──
def test_build_monitor_invokes_on_hit_sink():
    tpl = _template()
    frame = _frame_with(400, 600, tpl, (100, 150))
    seen: list[tuple[str, float, object]] = []
    eng = build_monitor(
        {"region": "full", "rules": [{"assetId": "a", "threshold": 0.85}]},
        on_hit=lambda aid, sim, rect: seen.append((aid, sim, rect)),
        grabber=FakeGrabber(frame),
        ref_loader=FakeRefLoader({"a": tpl}),
    )
    eng.poll_once()
    assert seen and seen[0][0] == "a"


# ── Runner 分支：monitor 工具能跑起来，命中落日志 + 进度 ──
class FakeMonitorEngine:
    """注入给 runner 的假监控内核：首轮报一次命中，之后无。"""

    def __init__(self, hits: list[tuple[str, float, list[int] | None]]) -> None:
        self._hits = list(hits)
        self.zones = [{"id": h[0]} for h in self._hits] or [{"id": "x"}]
        self.poll_interval = 0.02
        self._emitted = False

    def poll_once(self) -> list[tuple[str, float, list[int] | None]]:
        if not self._emitted:
            self._emitted = True
            return self._hits
        return []


def _monitor_cfg(rules, region="full"):
    return {"tool": "monitor", "region": region, "rules": rules}


def test_runner_monitor_branch_runs_and_logs_hit(make_instance, wait_status):
    iid = make_instance("monitor", _monitor_cfg([{"assetId": "img_a", "threshold": 0.85}]))
    runner = make_runner(iid, monitor_engine=FakeMonitorEngine([("img_a", 0.95, [150, 100, 80, 60])]))
    assert runner.start()
    assert wait_status(iid, {"running"}, 5) == "running"

    # 等待命中落库（runner 线程异步执行；以结构化事件表为最终判据，避免时序竞态）
    deadline = time.time() + 5
    hits: list[dict] = []
    while time.time() < deadline:
        hits = db.list_monitor_hits(iid)
        if hits:
            break
        time.sleep(0.02)
    assert hits, "命中应写入结构化事件表"

    runner.stop()
    assert wait_status(iid, {"idle"}, 5) == "idle"

    assert hits[0]["assetId"] == "img_a"
    assert hits[0]["rect"] == [150, 100, 80, 60]

    # 命中同时写入运行日志
    logs = db.query("SELECT message FROM logs WHERE instance_id=? AND message LIKE ?", (iid, "%命中%"))
    assert logs, "命中应写入运行日志"

    inst = db.query("SELECT progress_done, progress_total FROM instances WHERE id=?", (iid,))[0]
    assert inst["progress_total"] == 1
    assert inst["progress_done"] == 1


def test_repeated_start_stop_always_ends_back_at_idle(make_instance, wait_status):
    """回归「点停止后永远卡在停止中」。

    `_set_status` 曾经先读状态、再单独写（两段中间隔着一个窗口）：
    读到的可能已经过时，于是把「idle → stopping」这种非法转换写进去。
    卡住之后界面再也点不动 —— stopping 只允许去 idle / error，而这两个都不会自己发生。

    这里连跑 20 轮：旧实现大约两轮就会卡一次。
    """
    iid = make_instance("monitor", _monitor_cfg([{"assetId": "img_a", "threshold": 0.85}]))
    for round_no in range(20):
        runner = make_runner(iid, monitor_engine=FakeMonitorEngine([("img_a", 0.95, None)]))
        assert runner.start(), f"第 {round_no} 轮没起跑"
        assert wait_status(iid, {"running"}, 5) == "running"
        runner.stop()
        assert wait_status(iid, {"idle"}, 5) == "idle", f"第 {round_no} 轮停止后没回到 idle"


def test_monitor_hit_reaches_the_notification_channel(make_instance, wait_status, add_asset):
    """命中要有出口 —— 否则盯屏的人根本不知道命中了，监控在生产里就是没用的。"""
    from engine.notify import outbox

    outbox.reset()
    asset = add_asset(name="差评弹窗")
    iid = make_instance("monitor", _monitor_cfg([{"assetId": asset["id"], "threshold": 0.85}]))
    runner = make_runner(iid, monitor_engine=FakeMonitorEngine([(asset["id"], 0.95, [1, 2, 3, 4])]))
    assert runner.start()
    assert wait_status(iid, {"running"}, 5) == "running"

    deadline = time.time() + 5
    events: list[dict] = []
    while time.time() < deadline:
        events = db.list_hit_events(instance_id=iid)
        if events:
            break
        time.sleep(0.02)
    runner.stop()
    assert wait_status(iid, {"idle"}, 5) == "idle"
    assert events, "命中应写入命中事件"

    assert events[0]["notified"] == {"desktop": "ok"}, "默认配置下命中要走桌面通知"
    assert events[0]["title"] == "差评弹窗", "通知标题用素材名，不是素材 id"

    items, _cursor = outbox.drain()
    assert items[-1]["title"] == "差评弹窗", "通知要真的进了待发队列，等着被弹出去"
    outbox.reset()
