"""Seam：素材引用同步。

删一张素材不是删一张图那么简单 —— 它可能正被几个实例的指令指着。
所以要能回答两个问题：
  ① 谁在用（实例名 + 第几条指令），删除前拦住；
  ② 真要强删，指令里那个 assetId 必须一起清掉，不能留个指向空气的指针。
另外配好之后就该能体检出「引用了不存在的素材」「素材文件丢了」，
而不是等到执行到那一条才报错。
"""
from __future__ import annotations

import json
import pathlib

import pytest

from engine import db, image_library, image_refs
from tests.helpers import png_bytes


def _rpa_config(cmds_assets: list[str | None], *, window: str = "记事本") -> dict:
    """按前端真实配置结构造一份 rpa 配置；元素为 assetId 或 None（非图像指令）。"""
    cmds = []
    for i, asset_id in enumerate(cmds_assets):
        if asset_id is None:
            cmds.append({"t": f"按键-{i + 1}", "type": "key", "on": True, "p": "", "key": {"combo": ["enter"]}})
        else:
            cmds.append(
                {
                    "t": f"图像-{i + 1}",
                    "type": "img",
                    "on": True,
                    "p": f"图 {i + 1}",
                    "image": {"assetId": asset_id, "threshold": 0.85},
                }
            )
    return {"tool": "rpa", "window": window, "rpa": {"cmds": cmds}}


def _config_of(instance_id: str) -> dict:
    row = db.query("SELECT config_json FROM instances WHERE id=?", (instance_id,))[0]
    return json.loads(row["config_json"])


def _problems_of(instance_id: str) -> list[dict]:
    """audit() 是整库体检，用例只关心自己建的那个实例。"""
    return [p for p in image_refs.audit() if p["instanceId"] == instance_id]


def test_find_references_locates_the_instance_and_command(make_instance, add_asset):
    asset = add_asset("确定")
    iid = make_instance("rpa", _rpa_config([None, asset["id"]]), name="客服账号A")

    refs = image_refs.find_references(asset["id"])

    assert len(refs) == 1
    assert refs[0]["instanceId"] == iid
    assert refs[0]["instanceName"] == "客服账号A"
    assert refs[0]["cmdIndex"] == 1, "第 2 条指令（0 基下标 1）引用了它"


def test_find_references_covers_every_instance(make_instance, add_asset):
    asset = add_asset("确定")
    a = make_instance("rpa", _rpa_config([asset["id"]]), name="账号A")
    b = make_instance("rpa", _rpa_config([None, asset["id"]]), name="账号B")

    refs = image_refs.find_references(asset["id"])

    assert {(r["instanceId"], r["cmdIndex"]) for r in refs} == {(a, 0), (b, 1)}


def test_find_references_ignores_other_assets_and_command_types(make_instance, add_asset):
    wanted = add_asset("要删的")
    other = add_asset("别人的")
    make_instance("rpa", _rpa_config([other["id"], None, wanted["id"]]))

    refs = image_refs.find_references(wanted["id"])

    assert [r["cmdIndex"] for r in refs] == [2], "只有第 3 条指令引用它"


def test_find_references_is_empty_when_nobody_uses_it(make_instance, add_asset):
    asset = add_asset("没人用")
    make_instance("rpa", _rpa_config([None]))
    make_instance("rpa", _rpa_config([None, None]))

    assert image_refs.find_references(asset["id"]) == []


def test_delete_is_blocked_while_referenced(make_instance, add_asset):
    asset = add_asset("确定")
    make_instance("rpa", _rpa_config([asset["id"]]), name="客服账号A")
    path = pathlib.Path(asset["path"])

    with pytest.raises(image_refs.ImageInUse):
        image_library.delete_image(asset["id"])

    assert image_library.get_image(asset["id"]) is not None, "被引用时不能删记录"
    assert path.is_file(), "被引用时不能删文件"


def test_blocked_message_names_the_instance_and_the_command(make_instance, add_asset):
    asset = add_asset("确定")
    make_instance("rpa", _rpa_config([None, asset["id"]]), name="客服账号A")

    with pytest.raises(image_refs.ImageInUse) as e:
        image_library.delete_image(asset["id"])

    msg = str(e.value)
    assert "客服账号A" in msg
    assert "第 2 条指令" in msg


def test_forced_delete_clears_the_asset_id_in_the_commands(make_instance, add_asset):
    asset = add_asset("确定")
    iid = make_instance("rpa", _rpa_config([None, asset["id"]]), name="客服账号A")

    assert image_library.delete_image(asset["id"], force=True) is True

    assert image_library.get_image(asset["id"]) is None
    cmds = _config_of(iid)["rpa"]["cmds"]
    assert cmds[1]["image"]["assetId"] == "", "强删必须顺手清掉指令里的引用"
    assert cmds[0]["key"]["combo"] == ["enter"], "别的指令不许被牵连"


def test_forced_delete_leaves_the_rest_of_that_command_intact(make_instance, add_asset):
    asset = add_asset("确定")
    iid = make_instance("rpa", _rpa_config([asset["id"]]), name="账号A")

    image_library.delete_image(asset["id"], force=True)

    cmd = _config_of(iid)["rpa"]["cmds"][0]
    assert cmd["t"] == "图像-1"
    assert cmd["image"]["threshold"] == 0.85, "只清 assetId，阈值这些配置保留"


def test_forced_delete_only_touches_the_references_it_found(make_instance, add_asset):
    kept = add_asset("保留的")
    doomed = add_asset("要删的")
    iid = make_instance("rpa", _rpa_config([kept["id"], doomed["id"]]), name="账号A")

    image_library.delete_image(doomed["id"], force=True)

    cmds = _config_of(iid)["rpa"]["cmds"]
    assert cmds[0]["image"]["assetId"] == kept["id"]
    assert cmds[1]["image"]["assetId"] == ""


def test_audit_is_clean_when_every_reference_lines_up(make_instance, add_asset):
    asset = add_asset("确定")
    iid = make_instance("rpa", _rpa_config([None, asset["id"]]))

    assert _problems_of(iid) == []


def test_audit_reports_a_reference_to_a_missing_asset(make_instance):
    iid = make_instance("rpa", _rpa_config(["img_早就没了"]), name="账号A")

    problems = _problems_of(iid)

    assert len(problems) == 1
    assert problems[0]["kind"] == "missing_asset"
    assert problems[0]["cmdIndex"] == 0
    assert problems[0]["assetId"] == "img_早就没了"
    assert problems[0]["instanceName"] == "账号A"


def test_audit_reports_a_missing_file(make_instance, add_asset):
    asset = add_asset("文件丢了")
    iid = make_instance("rpa", _rpa_config([asset["id"]]), name="账号A")
    pathlib.Path(asset["path"]).unlink()

    problems = _problems_of(iid)

    assert [p["kind"] for p in problems] == ["missing_file"]
    assert problems[0]["assetId"] == asset["id"]


def test_audit_ignores_commands_without_an_image(make_instance, add_asset):
    add_asset("没人用")
    iid = make_instance("rpa", _rpa_config([None, None]))

    assert _problems_of(iid) == []


def test_audit_reports_each_command_separately(make_instance):
    iid = make_instance("rpa", _rpa_config(["img_缺一", None, "img_缺二"]), name="账号A")

    problems = _problems_of(iid)

    assert {(p["cmdIndex"], p["assetId"]) for p in problems} == {(0, "img_缺一"), (2, "img_缺二")}
