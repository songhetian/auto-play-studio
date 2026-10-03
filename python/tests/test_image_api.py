"""接口层：图像素材库。

业务逻辑在三个模块里都测过了，这一层要证明的是「串起来能跑」：
上传/截图/改/删四类入口都通，且错误能翻成前端看得懂的状态码。
特别注意路由声明顺序 —— `/images/audit` 不能被 `/images/{aid}` 吞掉（这个坑踩过一次）。
"""
from __future__ import annotations

import json
import pathlib

from engine import db, image_refs
from tests.helpers import png_bytes


class RecordingGrabber:
    def __init__(self, payload: bytes | None = None) -> None:
        self.payload = payload
        self.calls: list[tuple[int, int, int, int]] = []

    def __call__(self, x: int, y: int, width: int, height: int) -> bytes:
        self.calls.append((x, y, width, height))
        return self.payload if self.payload is not None else png_bytes(width, height)


def use_grabber(grabber) -> None:
    """把截图实现换成假的 —— 截图接口不该在测接口时真去抓屏。

    覆盖要挂在 `api` 上：路由都注册在这个子应用里，父 app 的 overrides 对它不生效。
    """
    from engine import image_routes
    from engine.main import api

    api.dependency_overrides[image_routes.get_grabber] = lambda: grabber


def clear_grabber() -> None:
    from engine import image_routes
    from engine.main import api

    api.dependency_overrides.pop(image_routes.get_grabber, None)


def _rpa_with_image(asset_id: str) -> dict:
    return {
        "tool": "rpa",
        "window": "记事本",
        "rpa": {
            "cmds": [
                {"t": "按键-1", "type": "key", "on": True, "p": "", "key": {"combo": ["enter"]}},
                {"t": "图像-2", "type": "img", "on": True, "p": "点确定", "image": {"assetId": asset_id, "threshold": 0.85}},
            ]
        },
    }


def _by_id(items: list[dict], asset_id: str) -> dict:
    return next(i for i in items if i["id"] == asset_id)


# ── 列表 ────────────────────────────────────────────────────


def test_list_returns_the_assets_the_ui_needs(client, add_asset):
    asset = add_asset("登录按钮", width=20, height=9, threshold=0.9, tag="图标类")

    r = client.get("/api/images")

    assert r.status_code == 200
    item = _by_id(r.json(), asset["id"])
    assert item["name"] == "登录按钮"
    assert (item["width"], item["height"]) == (20, 9)
    assert item["threshold"] == 0.9
    assert item["tag"] == "图标类"
    assert item["refCount"] == 0
    assert isinstance(item["createdAt"], str)


def test_list_counts_how_many_commands_use_each_asset(client, make_instance, add_asset):
    used = add_asset("被用的")
    idle = add_asset("没人用")
    make_instance("rpa", _rpa_with_image(used["id"]), name="客服账号A")

    items = client.get("/api/images").json()

    assert _by_id(items, used["id"])["refCount"] == 1
    assert _by_id(items, idle["id"])["refCount"] == 0


def test_list_returns_newest_first(client, add_asset):
    older = add_asset("先导入的")
    newer = add_asset("后导入的")

    ids = [i["id"] for i in client.get("/api/images").json()]

    assert ids.index(newer["id"]) < ids.index(older["id"])


# ── 上传 ────────────────────────────────────────────────────


def test_upload_stores_the_image(client):
    r = client.post(
        "/api/images",
        files={"file": ("按钮.png", png_bytes(16, 8), "image/png")},
        data={"name": "上传的按钮"},
    )

    assert r.status_code == 200
    asset = r.json()
    assert asset["name"] == "上传的按钮"
    assert (asset["width"], asset["height"]) == (16, 8)
    assert asset["refCount"] == 0, "响应形状要一致：每个素材接口都带 refCount"
    assert pathlib.Path(asset["path"]).read_bytes() == png_bytes(16, 8)
    assert _by_id(client.get("/api/images").json(), asset["id"])["id"] == asset["id"]


def test_upload_accepts_tag_and_threshold(client):
    r = client.post(
        "/api/images",
        files={"file": ("图.png", png_bytes(4, 4), "image/png")},
        data={"name": "调过的", "tag": "图标类", "threshold": "0.92"},
    )

    assert r.json()["tag"] == "图标类"
    assert r.json()["threshold"] == 0.92


def test_upload_falls_back_to_the_filename_as_name(client):
    r = client.post("/api/images", files={"file": ("确定按钮.png", png_bytes(4, 4), "image/png")})

    assert r.json()["name"] == "确定按钮"


def test_upload_rejects_something_that_is_not_an_image(client):
    r = client.post("/api/images", files={"file": ("假的.png", b"not an image", "image/png")})

    assert r.status_code == 400
    assert "图片" in r.json()["detail"]


# ── 区域截图 ────────────────────────────────────────────────


def test_capture_stores_a_screenshot_of_the_region(client):
    grabber = RecordingGrabber()
    use_grabber(grabber)
    try:
        r = client.post(
            "/api/images/capture",
            json={"name": "登录按钮", "x": 100, "y": 200, "width": 37, "height": 12},
        )
    finally:
        clear_grabber()

    assert r.status_code == 200
    assert grabber.calls == [(100, 200, 37, 12)]
    assert (r.json()["width"], r.json()["height"]) == (37, 12)
    assert r.json()["name"] == "登录按钮"
    assert r.json()["refCount"] == 0


def test_capture_rejects_a_degenerate_region(client):
    grabber = RecordingGrabber()
    use_grabber(grabber)
    try:
        r = client.post("/api/images/capture", json={"name": "空", "x": 0, "y": 0, "width": 0, "height": 10})
    finally:
        clear_grabber()

    assert r.status_code == 400
    assert grabber.calls == []
    assert "区域" in r.json()["detail"]


# ── 体检（顺带证明路由顺序没被 id 路由吞掉）──────────────────


def test_audit_endpoint_is_not_swallowed_by_the_id_route(client, make_instance):
    iid = make_instance("rpa", _rpa_with_image("img_早就没了"), name="客服账号A")

    r = client.get("/api/images/audit")

    assert r.status_code == 200
    mine = [p for p in r.json() if p["instanceId"] == iid]
    assert [p["kind"] for p in mine] == ["missing_asset"]


# ── 修改 ────────────────────────────────────────────────────


def test_patch_updates_threshold_and_name(client, add_asset):
    asset = add_asset("原名")

    r = client.patch(f"/api/images/{asset['id']}", json={"name": "新名", "threshold": 0.7})

    assert r.status_code == 200
    assert r.json()["name"] == "新名"
    assert r.json()["threshold"] == 0.7
    assert r.json()["refCount"] == 0
    assert _by_id(client.get("/api/images").json(), asset["id"])["name"] == "新名"


def test_patch_unknown_id_is_404(client):
    assert client.patch("/api/images/img_不存在", json={"name": "x"}).status_code == 404


def test_patch_keeps_fields_that_were_not_sent(client, add_asset):
    asset = add_asset("原名", threshold=0.77, tag="图标类")

    r = client.patch(f"/api/images/{asset['id']}", json={"name": "只改名"})

    assert r.json()["threshold"] == 0.77
    assert r.json()["tag"] == "图标类"


def test_patch_reports_the_current_reference_count(client, make_instance, add_asset):
    asset = add_asset("确定")
    make_instance("rpa", _rpa_with_image(asset["id"]), name="客服账号A")

    r = client.patch(f"/api/images/{asset['id']}", json={"name": "改个名"})

    assert r.json()["refCount"] == 1


# ── 引用查询 ────────────────────────────────────────────────


def test_references_endpoint_lists_where_it_is_used(client, make_instance, add_asset):
    asset = add_asset("确定")
    iid = make_instance("rpa", _rpa_with_image(asset["id"]), name="客服账号A")

    r = client.get(f"/api/images/{asset['id']}/references")

    assert r.status_code == 200
    assert r.json() == [
        {"instanceId": iid, "instanceName": "客服账号A", "cmdIndex": 1, "cmdName": "图像-2"}
    ]


# ── 删除 ────────────────────────────────────────────────────


def test_delete_in_use_is_rejected_with_the_reference_list(client, make_instance, add_asset):
    asset = add_asset("确定")
    make_instance("rpa", _rpa_with_image(asset["id"]), name="客服账号A")

    r = client.delete(f"/api/images/{asset['id']}")

    assert r.status_code == 409
    body = r.json()
    assert body["refs"][0]["cmdIndex"] == 1
    assert body["refs"][0]["instanceName"] == "客服账号A"
    assert "客服账号A" in body["message"]
    assert _by_id(client.get("/api/images").json(), asset["id"])["id"] == asset["id"]


def test_force_delete_clears_the_references(client, make_instance, add_asset):
    asset = add_asset("确定")
    iid = make_instance("rpa", _rpa_with_image(asset["id"]), name="客服账号A")

    r = client.delete(f"/api/images/{asset['id']}?force=true")

    assert r.status_code == 200
    assert r.json() == {"deleted": True, "clearedRefs": 1}
    assert all(i["id"] != asset["id"] for i in client.get("/api/images").json())
    cfg = json.loads(db.query("SELECT config_json FROM instances WHERE id=?", (iid,))[0]["config_json"])
    assert cfg["rpa"]["cmds"][1]["image"]["assetId"] == ""
    assert [p for p in image_refs.audit() if p["assetId"] == asset["id"]] == []


def test_delete_unused_succeeds_without_force(client, add_asset):
    asset = add_asset("没人用")

    r = client.delete(f"/api/images/{asset['id']}")

    assert r.status_code == 200
    assert r.json() == {"deleted": True, "clearedRefs": 0}


def test_delete_unknown_id_is_404(client):
    assert client.delete("/api/images/img_不存在").status_code == 404


# ── 原文读取（前端 <img src> 直接用）────────────────────────


def test_raw_serves_the_stored_bytes(client, add_asset):
    asset = add_asset("原图", width=13, height=5)

    r = client.get(f"/api/images/{asset['id']}/raw")

    assert r.status_code == 200
    assert r.content == png_bytes(13, 5)
    assert r.headers["content-type"].startswith("image/png")


def test_raw_unknown_id_is_404(client):
    assert client.get("/api/images/img_不存在/raw").status_code == 404
