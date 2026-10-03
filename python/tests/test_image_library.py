"""Seam：图像素材库。

图像指令要能在真实屏幕上找图，前提是素材本身被正确存下来：
文件落盘、尺寸记对、删得干净。这块全部可以用真图片字节验证。

注意：这些用例共用一个会话级数据库，所以断言都锚定「自己刚插入的那几条」，
不做全局计数 —— 否则会随用例顺序变化而飘。
"""
from __future__ import annotations

import pathlib

import pytest

from engine import image_library
from tests.helpers import png_bytes


def test_import_stores_the_file_and_its_metadata(add_asset):
    rec = add_asset("发送按钮", width=4, height=3)

    assert rec["id"].startswith("img_")
    assert rec["name"] == "发送按钮"
    path = pathlib.Path(rec["path"])
    assert path.is_file(), "素材必须真的落到磁盘上"
    assert path.read_bytes() == png_bytes(4, 3)


def test_import_records_the_real_pixel_size(add_asset):
    rec = add_asset("头像", width=37, height=12)

    assert (rec["width"], rec["height"]) == (37, 12)


def test_import_applies_defaults(add_asset):
    rec = add_asset("按钮")

    assert rec["threshold"] == 0.85
    assert rec["tag"] == "按钮类"


def test_import_honours_explicit_threshold_and_tag(add_asset):
    rec = add_asset("标题", threshold=0.93, tag="标题类")

    assert rec["threshold"] == 0.93
    assert rec["tag"] == "标题类"


def test_same_name_twice_keeps_both(add_asset):
    """两个不同窗口都有「确定」按钮，同名也要能共存。"""
    a = add_asset("确定", width=2, height=2)
    b = add_asset("确定", width=5, height=5)

    assert a["id"] != b["id"]
    assert a["path"] != b["path"]
    listed = {i["id"] for i in image_library.list_images()}
    assert {a["id"], b["id"]} <= listed


def test_list_returns_newest_first(add_asset):
    older = add_asset("先导入的")
    newer = add_asset("后导入的")

    ids = [i["id"] for i in image_library.list_images()]

    assert ids.index(newer["id"]) < ids.index(older["id"])


def test_paths_are_ascii_and_inside_the_assets_dir(add_asset):
    """中文名只出现在展示字段里，文件名用 id —— 避免中文路径与路径穿越问题。"""
    rec = add_asset("发 送/按钮")

    path = pathlib.Path(rec["path"])
    assert path.parent == image_library.assets_dir()
    assert path.stem == rec["id"]
    assert path.name.isascii()


def test_import_rejects_something_that_is_not_an_image():
    with pytest.raises(ValueError, match="图片"):
        image_library.import_image("坏文件", b"this is not a png at all")


def test_import_rejects_empty_data():
    with pytest.raises(ValueError, match="图片"):
        image_library.import_image("空文件", b"")


def test_empty_name_falls_back_to_something_readable(add_asset):
    rec = add_asset("   ")

    assert rec["name"].strip()


def test_update_threshold_and_tag(add_asset):
    rec = add_asset("按钮")

    updated = image_library.update_image(rec["id"], threshold=0.7, tag="图标类")

    assert updated["threshold"] == 0.7
    assert updated["tag"] == "图标类"
    assert image_library.get_image(rec["id"])["threshold"] == 0.7


def test_rename(add_asset):
    rec = add_asset("旧名字")

    assert image_library.update_image(rec["id"], name="新名字")["name"] == "新名字"


def test_update_unknown_id_returns_none():
    assert image_library.update_image("img_不存在", name="x") is None


def test_delete_removes_both_the_row_and_the_file(add_asset):
    rec = add_asset("待删除")
    path = pathlib.Path(rec["path"])
    assert path.is_file()

    assert image_library.delete_image(rec["id"]) is True

    assert image_library.get_image(rec["id"]) is None
    assert not path.exists(), "删素材不能只删记录，磁盘文件也要清掉"


def test_delete_unknown_id_is_a_no_op():
    assert image_library.delete_image("img_不存在") is False


def test_get_unknown_id_returns_none():
    assert image_library.get_image("img_不存在") is None


def test_copy_into_library_keeps_the_source_file(tmp_path, add_asset):
    src = tmp_path / "某个截图.png"
    src.write_bytes(png_bytes(6, 6))

    rec = image_library.copy_into_library(src, name="导入的截图")

    assert rec["name"] == "导入的截图"
    assert (rec["width"], rec["height"]) == (6, 6)
    assert src.is_file(), "导入是复制，不该动原文件"
