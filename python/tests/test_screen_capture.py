"""Seam：区域截图采集。

「选图」除了从磁盘导入，更常用的是框一块屏幕区域直接存成素材。
截图本身要真实屏幕，属于设备层 —— 但采集之外的东西全都能测：
区域是否合法、抓到的内容是不是真图片、尺寸有没有记对、落库位置对不对。
所以采集函数接受一个可注入的 grabber，测试喂一张已知宽高的合成图。
"""
from __future__ import annotations

import pathlib
import sys

import pytest

from engine import image_library, image_meta, screen_capture
from engine.driver import DriverUnavailable
from tests.helpers import png_bytes


class FakeGrabber:
    """假的截屏器：记录被请求的区域，返回一张指定宽高的真 PNG。"""

    def __init__(self, width: int = 8, height: int = 6, payload: bytes | None = None) -> None:
        self.width = width
        self.height = height
        self.payload = payload
        self.calls: list[tuple[int, int, int, int]] = []

    def __call__(self, x: int, y: int, width: int, height: int) -> bytes:
        self.calls.append((x, y, width, height))
        if self.payload is not None:
            return self.payload
        return png_bytes(width, height)


def test_capture_stores_an_asset_of_the_region_size(tmp_path):
    grabber = FakeGrabber()

    asset = screen_capture.capture_into_library(
        "登录按钮", (100, 200, 37, 12), grabber=grabber
    )

    assert (asset["width"], asset["height"]) == (37, 12)
    assert asset["name"] == "登录按钮"
    assert pathlib.Path(asset["path"]).is_file()


def test_capture_asks_the_grabber_for_exactly_that_region():
    grabber = FakeGrabber()

    screen_capture.capture_into_library("区域", (10, 20, 30, 40), grabber=grabber)

    assert grabber.calls == [(10, 20, 30, 40)]


def test_capture_accepts_negative_origin_for_multi_monitor_setups():
    """副屏在主屏左边或上边时，原点就是负的 —— 不能因此判非法。"""
    grabber = FakeGrabber()

    asset = screen_capture.capture_into_library("副屏区域", (-1200, -300, 20, 10), grabber=grabber)

    assert grabber.calls == [(-1200, -300, 20, 10)]
    assert (asset["width"], asset["height"]) == (20, 10)


@pytest.mark.parametrize("region", [(0, 0, 0, 10), (0, 0, 10, 0), (0, 0, -5, 10), (0, 0, 10, -5)])
def test_capture_rejects_a_degenerate_region(region):
    grabber = FakeGrabber()

    with pytest.raises(ValueError, match="区域"):
        screen_capture.capture_into_library("空区域", region, grabber=grabber)

    assert grabber.calls == [], "区域非法就不该去抓屏"


def test_capture_rejects_a_degenerate_region_before_touching_the_library():
    before = {i["id"] for i in image_library.list_images()}

    with pytest.raises(ValueError):
        screen_capture.capture_into_library("空区域", (0, 0, 0, 0), grabber=FakeGrabber())

    assert {i["id"] for i in image_library.list_images()} == before


def test_capture_rejects_a_payload_that_is_not_an_image():
    grabber = FakeGrabber(payload=b"\x00\x01 definitely not an image")

    with pytest.raises(ValueError, match="图片"):
        screen_capture.capture_into_library("坏截图", (0, 0, 4, 4), grabber=grabber)


def test_capture_applies_defaults_and_honours_overrides():
    default = screen_capture.capture_into_library("默认", (0, 0, 4, 4), grabber=FakeGrabber())
    tuned = screen_capture.capture_into_library(
        "调过阈值", (0, 0, 4, 4), grabber=FakeGrabber(), threshold=0.95, tag="图标类"
    )

    assert default["threshold"] == 0.85
    assert default["tag"] == "按钮类"
    assert tuned["threshold"] == 0.95
    assert tuned["tag"] == "图标类"


def test_capture_lands_inside_the_assets_dir():
    asset = screen_capture.capture_into_library("落盘位置", (0, 0, 4, 4), grabber=FakeGrabber())

    assert pathlib.Path(asset["path"]).parent == image_library.assets_dir()


def test_capture_returns_a_real_png_that_matches_the_region_size():
    asset = screen_capture.capture_into_library("像素校验", (0, 0, 11, 7), grabber=FakeGrabber())

    width, height = image_meta.read_size(asset["path"])
    assert (width, height) == (11, 7)


def test_default_grabber_explains_what_to_install_when_deps_are_missing(monkeypatch, tmp_path):
    """缺 pyautogui / Pillow 时要给一条能照做的事，而不是抛 ImportError 堆栈。"""
    monkeypatch.setitem(sys.modules, "pyautogui", None)

    with pytest.raises(DriverUnavailable) as e:
        screen_capture.default_grabber(0, 0, 2, 2)

    assert "pyautogui" in str(e.value)


def test_capture_reports_the_same_helpful_error_when_deps_are_missing(monkeypatch, tmp_path):
    monkeypatch.setitem(sys.modules, "pyautogui", None)

    with pytest.raises(DriverUnavailable, match="pyautogui"):
        screen_capture.capture_into_library("截图", (0, 0, 2, 2))
