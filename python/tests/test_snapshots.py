"""命中快照：把命中那一刻的画面存下来（对应原型改进项 ①）。

为什么要有：图片监控最常见的纠纷是"到底命中了没有"。此前命中只记了
`rect`（坐标），用户拿到一个坐标却不知道屏幕上当时是什么 ——
判断真命中还是误报只能跑到现场复现，效率极低。

两张图一起给才有用：
  - **裁剪图**（命中区域）：一眼看出命中了什么模板
  - **全屏图**（带红框标出位置）：知道它在页面的哪个位置

存**路径**而不是 base64：命中是高频事件，base64 进库会让 db 迅速膨胀。
落盘位置复用素材库目录（AUTOPLAY_ASSETS_DIR），有现成的白名单与清理策略。
"""
from __future__ import annotations

import numpy as np
import pytest

from engine import snapshots


class TestCropRegion:
    def test_裁出命中区域_尺寸就是坐标给的宽高(self):
        frame = np.zeros((600, 800, 3), dtype=np.uint8)
        crop = snapshots.crop_region(frame, [100, 200, 120, 80])
        assert crop.shape[:2] == (80, 120)

    def test_区域越界时自动裁到画面内_不返回空图(self):
        # 命中区域贴着屏幕边缘，rect 可能超出实际画面
        frame = np.zeros((600, 800, 3), dtype=np.uint8)
        crop = snapshots.crop_region(frame, [700, 550, 200, 200])
        assert crop.size > 0
        assert crop.shape[0] <= 200 and crop.shape[1] <= 200

    def test_区域完全在画面外时返回None_而不是空数组(self):
        frame = np.zeros((600, 800, 3), dtype=np.uint8)
        assert snapshots.crop_region(frame, [5000, 5000, 100, 100]) is None

    def test_没有坐标时裁不出来_返回空(self):
        frame = np.zeros((600, 800, 3), dtype=np.uint8)
        assert snapshots.crop_region(frame, None) is None

    def test_宽高为零时返回None_不生成空图(self):
        frame = np.zeros((600, 800, 3), dtype=np.uint8)
        assert snapshots.crop_region(frame, [10, 10, 0, 0]) is None


class TestSaveHitSnapshot:
    def test_返回可访问的相对路径_而不是绝对路径(self):
        # 绝对路径把用户的磁盘结构写进数据库，换机器/换目录就全失效了
        frame = _frame_with_rect()
        path = snapshots.save_hit_snapshot(frame, [10, 10, 60, 40], instance_id="I1")
        assert path is not None
        assert not path.startswith(("/", "\\", "C:", "c:"))
        assert "hits" in path.replace("\\", "/")

    def test_不同实例的快照分目录_不会互相覆盖(self):
        f = _frame_with_rect()
        a = snapshots.save_hit_snapshot(f, [10, 10, 60, 40], instance_id="I1")
        b = snapshots.save_hit_snapshot(f, [10, 10, 60, 40], instance_id="I2")
        assert a != b

    def test_同名冲突时加序号_绝不覆盖已有快照(self):
        f = _frame_with_rect()
        a = snapshots.save_hit_snapshot(f, [10, 10, 60, 40], instance_id="I1")
        b = snapshots.save_hit_snapshot(f, [10, 10, 60, 40], instance_id="I1")
        assert a != b
        assert (snapshots.assets_root() / b).exists()

    def test_帧为空时返回None_不写空文件(self):
        assert snapshots.save_hit_snapshot(None, [10, 10, 60, 40], instance_id="I1") is None

    def test_存下来的图能被重新打开_不是损坏文件(self):
        f = _frame_with_rect()
        rel = snapshots.save_hit_snapshot(f, [10, 10, 60, 40], instance_id="I1")
        assert rel is not None
        data = (snapshots.assets_root() / rel).read_bytes()
        assert data[:2] == b"\xff\xd8", "应是 jpg（FF D8），否则页面上的缩略图会裂"


def _frame_with_rect() -> np.ndarray:
    """一张有内容的假画面（不是纯黑，否则 jpg 压出来看不出对错）。"""
    frame = np.zeros((300, 400, 3), dtype=np.uint8)
    frame[:, :, 1] = 120
    frame[50:120, 80:200, 2] = 200
    return frame


class TestSnapshotRoute:
    """前端 <img src="/api/hit-snapshots/..."> 直接取字节，所以要真的能访问。"""

    def test_能取到快照字节(self, client) -> None:
        import numpy as np

        from engine import snapshots

        rel = snapshots.save_hit_snapshot(_frame_with_rect(), [10, 10, 60, 40], instance_id="I1")
        assert rel is not None
        r = client.get(f"/api/hit-snapshots/{rel}")
        assert r.status_code == 200
        assert r.content[:2] == b"\xff\xd8"

    def test_不存在的快照给404(self, client) -> None:
        assert client.get("/api/hit-snapshots/hits/I1/nope.jpg").status_code == 404

    def test_路径穿越被挡住_不能读素材库外的文件(self, client) -> None:
        # ../ 能读到 autoplay.db 或用户其它文件，这是最不能出的错
        r = client.get("/api/hit-snapshots/..%2F..%2Fautoplay.db")
        assert r.status_code in (400, 403, 404)


class TestSnapshotReachesTheBanner:
    """端到端：截图存下来 → 落进命中事件 → 事件接口带出路径 → 图片能取回字节。

    横幅上的缩略图完全依赖这条链。任一环断了（事件表少一列、接口不返回、
    URL 取不到字节），用户看到的就只是一个空白方框。这类问题肉眼验收盯不住，
    必须钉成测试。
    """

    def test_命中事件带得出快照路径_且图片能取回(self, client) -> None:
        from engine.notify.report import report_hit

        rel = snapshots.save_hit_snapshot(_frame_with_rect(), [10, 10, 60, 40], instance_id="MSNAP")
        assert rel is not None

        report_hit(
            instance_id="MSNAP",
            tool="monitor",
            rule_id="img_banner",
            matched_by="image",
            level="alert",
            title="提交按钮",
            detail="相似度 0.95",
            snapshot=rel,
            channels=[],   # 不发通知（设备层），这里只验事件与取图
            routing={},
        )

        items = client.get("/api/hit-events", params={"instanceId": "MSNAP"}).json()
        hit = next((h for h in items if h["ruleId"] == "img_banner"), None)
        assert hit is not None, "命中事件没出现在事件接口里"
        # 横幅 <img src> 就是拿这个字段拼出来的（字段名/驼峰都别改）
        assert hit["snapshot"] == rel

        r = client.get(f"/api/hit-snapshots/{rel}")
        assert r.status_code == 200
        assert r.content[:2] == b"\xff\xd8", "取回来的不是 jpg，缩略图会裂"
        assert r.headers["content-type"].startswith("image/"), \
            f"Content-Type 不对：{r.headers['content-type']}"

    def test_没有截图的命中返回空串_而不是缺字段(self, client) -> None:
        # 前端按 `snapshotUrlOf(hit.snapshot)` 取址；字段缺失会让它拿到 undefined
        from engine.notify.report import report_hit

        report_hit(
            instance_id="MSNAP2",
            tool="monitor",
            rule_id="img_nosnap",
            matched_by="image",
            level="alert",
            title="无截图命中",
            channels=[],
            routing={},
        )
        items = client.get("/api/hit-events", params={"instanceId": "MSNAP2"}).json()
        hit = next(h for h in items if h["ruleId"] == "img_nosnap")
        assert hit["snapshot"] == ""
