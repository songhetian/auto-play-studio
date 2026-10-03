# -*- coding: utf-8 -*-
"""屏幕抓取与目标图模板匹配。

- 用 mss 抓取虚拟全屏，numpy 切片裁剪搜索范围（整屏或局部），一次抓屏支持多区间。
- 用 cv2.matchTemplate(TM_CCOEFF_NORMED) 在搜索范围里找参考图的**最佳出现位置**，
  取最高相似度与坐标。支持两种范围：
    * 局部：zone.rect 框定的屏幕子区域；
    * 整屏：不做裁剪，在整个屏幕任意位置找目标图，出现即命中。
- 为控制性能，较宽的搜索画面会先下采样再匹配，坐标结果换算回原屏幕坐标。
"""
import logging
import os
import threading

import cv2
import numpy as np
import mss

_log = logging.getLogger("notic.matcher")

# 搜索画面最大宽度（像素），超过则整体下采样后在缩略图上匹配以提速
_MAX_SEARCH_W = 1600


def load_reference(path):
    """加载参考图（BGR np 数组），保留原始尺寸。失败返回 None。"""
    if not path or not os.path.isfile(path):
        return None
    from .imio import read_image
    img = read_image(path)
    return img if (img is not None and img.size > 0) else None


def similarity(gray_a, gray_b):
    """像素级平均相似度（保留给离线自检/兼容用）。"""
    if gray_a.size == 0 or gray_b.size == 0:
        return 0.0
    if gray_a.shape != gray_b.shape:
        gray_b = cv2.resize(
            gray_b, (gray_a.shape[1], gray_a.shape[0]),
            interpolation=cv2.INTER_AREA)
    diff = np.abs(gray_a.astype(np.int16) - gray_b.astype(np.int16))
    return float(1.0 - diff.mean() / 255.0)


class ScreenMatcher:
    """封装 mss 抓屏与目标图模板匹配。区域配置可热更新。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._sct = mss.mss()
        self._cache = {}          # zone_id -> 参考图(BGR, 原始尺寸)
        self._ref_paths = {}      # zone_id -> 参考图路径
        self._scale = 1.0         # 抓屏下采样比例 frame.W / raw.W

    # ---------- 配置热更新 ----------
    def update_zones(self, zones):
        """重建参考图缓存（删除的区移除，新增/变更的重新加载）。"""
        with self._lock:
            ids = set()
            for z in zones:
                zid = z.get("id")
                ref = z.get("reference_image", "")
                ids.add(zid)
                if not z.get("enabled", True):
                    continue
                if self._ref_paths.get(zid) == ref and zid in self._cache:
                    continue
                self._cache[zid] = load_reference(ref)
                self._ref_paths[zid] = ref
                if self._cache[zid] is None:
                    # 静默失效是"监控不到却查不出原因"的元凶，必须留下痕迹
                    _log.warning("监控区 %s 的参考图加载失败（路径不存在或不可读）: %r",
                                 zid, ref)
            for zid in list(self._cache):
                if zid not in ids:
                    self._cache.pop(zid, None)
                    self._ref_paths.pop(zid, None)

    def invalidate(self, zone_ids):
        """强制丢弃指定 zone 的参考图缓存（编辑图片后调用，确保按新文件重载）。"""
        if zone_ids:
            zone_ids = {zone_ids} if not isinstance(zone_ids, (list, tuple, set)) else set(zone_ids)
        else:
            zone_ids = None
        with self._lock:
            for zid in list(self._cache):
                if zone_ids is None or zid in zone_ids:
                    self._cache.pop(zid, None)
                    self._ref_paths.pop(zid, None)

    # ---------- 抓屏 ----------
    @property
    def scale(self):
        """当前抓屏下采样比例（<1 表示整帧已被压到 ≤1600 宽）。"""
        with self._lock:
            return self._scale

    def grab_full(self):
        """抓虚拟全屏并压到 ≤1600 宽，返回 BGR；同时记录下采样比例。
        立即下采样（cv2.resize 运行时释放 GIL），避免高分屏/多屏每次拷贝几十 MB 造成卡顿。
        若实例在 stop() 时被关闭，此处惰性重建，保证停止后再次启动也能正常抓屏。
        线程安全：mss 实例不允许并发抓屏（僵尸线程兜底场景下可能有两线程并存），
        惰性重建 + grab + resize 全程持锁串行化。"""
        with self._lock:
            try:
                if self._sct is None:
                    self._sct = mss.mss()
                monitor = self._sct.monitors[0]
                shot = self._sct.grab(monitor)
                bgr = np.asarray(shot, dtype=np.uint8)[:, :, :3]
                h, w = bgr.shape[:2]
                if w > _MAX_SEARCH_W:
                    nw = _MAX_SEARCH_W
                    nh = max(1, int(round(h * nw / w)))
                    self._scale = nw / w
                    bgr = cv2.resize(bgr, (nw, nh), interpolation=cv2.INTER_AREA)
                else:
                    self._scale = 1.0
                return bgr
            except Exception:
                return None

    def shutdown(self):
        try:
            if self._sct is not None:
                self._sct.close()
        except Exception:
            pass
        # 置空：下次抓屏时惰性重建，支持"停止后再启动"
        with self._lock:
            self._sct = None

    @staticmethod
    def crop(frame, rect):
        """按 (x,y,w,h) 从整帧裁剪，返回 BGR 数组；越界/超限时安全裁剪。"""
        if frame is None or not rect:
            return None
        x, y, w, h = (int(v) for v in rect)
        h_lim, w_lim = frame.shape[:2]
        x2, y2 = min(x + w, w_lim), min(y + h, h_lim)
        if x2 <= x or y2 <= y:
            return None
        return frame[y:y2, x:x2]

    # ---------- 匹配 ----------
    def ref_for(self, zone):
        with self._lock:
            return self._cache.get(zone.get("id"))

    def match_template(self, ref, frame, search_rect=None):
        """在整屏或局部区域搜索参考图最佳位置。

        ref: 参考图 BGR（原始尺寸）。
        frame: 整帧 BGR。
        search_rect: 局部区域 [x,y,w,h]（物理像素）；None 表示整屏。
        返回 (相似度 0~1, 最佳矩形 [x,y,w,h])；无有效匹配返回 (0.0, None)。
        """
        if ref is None or frame is None or ref.size == 0:
            return 0.0, None
        if search_rect:
            search = ScreenMatcher.crop(frame, search_rect)
            sx, sy = int(search_rect[0]), int(search_rect[1])
        else:
            search = frame
            sx, sy = 0, 0
        if search is None or search.size == 0:
            return 0.0, None

        sh, sw = search.shape[:2]
        rh, rw = ref.shape[:2]

        # 关键：无论目标图大小，都把搜索画面统一下采样到最大边长以内，
        # 使 matchTemplate 的计算量恒有上限，避免高分屏/多屏下单次匹配卡顿。
        dscale = 1.0
        max_side = max(sw, sh)
        if max_side > _MAX_SEARCH_W:
            dscale = _MAX_SEARCH_W / max_side
            search = cv2.resize(search,
                                (max(1, int(sw * dscale)), max(1, int(sh * dscale))),
                                interpolation=cv2.INTER_AREA)
        tsh, tsw = search.shape[:2]

        ref_gray = cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY)
        # 模板方差守卫：参考图若是纯色/近乎纯色（无特征），对任何屏幕都会"像"，
        # 毫无区分度。此时一律不算命中，避免误报轰炸，也提示用户需用有特征的图。
        if float(ref_gray.var()) < 3.0:
            return 0.0, None

        # 关键（多尺度）：目标在屏幕上的渲染尺寸往往与导入图不同——
        #   * 导入的是原始素材图，屏幕按 DPI 125%/150% 渲染；
        #   * 抓屏又整体下采样到 ≤1600 宽。
        # 三者叠加后，目标在匹配画面里可能只有参考图的 0.3~2 倍。
        # 单尺度匹配时尺寸对不上，相似度永远差一截 → "监控不到却查不出原因"。
        # 因此对一组候选缩放逐一匹配，取像素级验证分数最高的一档。
        # 粗匹配全程灰度单通道（定位够了，且比彩色省一半以上算力）。
        factors = (0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0)
        ks = sorted({round(dscale * f, 4) for f in factors})
        search_gray = cv2.cvtColor(search, cv2.COLOR_BGR2GRAY)
        best = None   # (final, maxl, k, tw2, th2)
        seen_sizes = set()
        for k in ks:
            tw2, th2 = int(rw * k), int(rh * k)
            if tw2 < 8 or th2 < 8 or tw2 >= tsw or th2 >= tsh:
                continue
            if (tw2, th2) in seen_sizes:
                continue
            seen_sizes.add((tw2, th2))
            tpl_gray = ref_gray if k == 1.0 else cv2.resize(ref_gray, (tw2, th2),
                                                            interpolation=cv2.INTER_AREA)
            try:
                res = cv2.matchTemplate(search_gray, tpl_gray, cv2.TM_CCOEFF_NORMED)
                _minv, maxv, _minl, maxl = cv2.minMaxLoc(res)
            except Exception:
                continue
            if maxv < 0:
                maxv = 0.0
            # TM_CCOEFF_NORMED 在纯色/低纹理区域会给出虚假高分（可接近 1.0），
            # 它只用来"定位"；真正的分数用像素级相似度：在定位点抠出窗口与
            # 该尺度下的模板逐像素比对，平地段自然得低分，杜绝纯色误报。
            patch = ScreenMatcher.crop(search_gray, [int(maxl[0]), int(maxl[1]), tw2, th2])
            if patch is None:
                continue
            if patch.shape[0] != th2 or patch.shape[1] != tw2:
                patch = cv2.resize(patch, (tw2, th2), interpolation=cv2.INTER_AREA)
            score = similarity(tpl_gray, patch)
            final = min(score, maxv)
            if best is None or final > best[0]:
                best = (final, maxl, k, tw2, th2)

        if best is None:
            # 画面比目标图还小（所有尺度都放不下），退化为整块像素比对
            s = similarity(ref, search)
            return s, (sx, sy, int(rw), int(rh))

        # 局部尺度精修：粗阶梯（比例~1.15）无法覆盖 125%/150% 这类非整数 DPI，
        # 在最优尺度 ±10% 内按整数像素宽度穷举、在定位点附近的小 crop 里细搜尺度。
        # 真实目标宽度必是整数像素，百分比网格会踩空；crop 只有模板的 ~2 倍大，
        # 单次 matchTemplate 开销可忽略，±10% 只有约 20 个候选。
        b_final, b_maxl, b_k, b_tw, b_th = best
        margin = 1.8
        cx = max(0, int(b_maxl[0] - b_tw * (margin - 1) / 2))
        cy = max(0, int(b_maxl[1] - b_th * (margin - 1) / 2))
        cw = min(tsw - cx, int(b_tw * margin))
        ch = min(tsh - cy, int(b_th * margin))
        if b_final < 0.97 and cw > b_tw and ch > b_th:
            crop_area = search_gray[cy:cy + ch, cx:cx + cw]
            w_lo = max(8, int(b_tw * 0.9))
            w_hi = int(b_tw * 1.1)
            for tw3 in range(w_lo, w_hi + 1):
                th3 = max(1, int(round(rh * tw3 / rw)))
                if tw3 >= cw or th3 >= ch:
                    continue
                tpl3 = cv2.resize(ref_gray, (tw3, th3), interpolation=cv2.INTER_AREA)
                try:
                    res3 = cv2.matchTemplate(crop_area, tpl3, cv2.TM_CCOEFF_NORMED)
                    _m, maxv3, _l, maxl3 = cv2.minMaxLoc(res3)
                except Exception:
                    continue
                if maxv3 < 0:
                    maxv3 = 0.0
                patch3 = ScreenMatcher.crop(crop_area, [int(maxl3[0]), int(maxl3[1]), tw3, th3])
                if patch3 is None:
                    continue
                if patch3.shape[0] != th3 or patch3.shape[1] != tw3:
                    patch3 = cv2.resize(patch3, (tw3, th3), interpolation=cv2.INTER_AREA)
                score3 = similarity(tpl3, patch3)
                final3 = min(score3, maxv3)
                if final3 > b_final:
                    b_final = final3
                    b_k = tw3 / rw
                    b_maxl = (cx + int(maxl3[0]), cy + int(maxl3[1]))
                if b_final >= 0.97:
                    break   # 足够可信，提前结束精修

        final = b_final
        # 定位坐标是下采样坐标系 → 换算回 search 原坐标系再加偏移；
        # 尺寸按实际命中尺度换算回屏幕物理像素（k/dscale = 目标相对参考图的渲染比）
        lx, ly = int(b_maxl[0] / dscale), int(b_maxl[1] / dscale)
        best_rect = [sx + lx, sy + ly,
                     max(1, int(round(rw * b_k / dscale))),
                     max(1, int(round(rh * b_k / dscale)))]
        return final, best_rect