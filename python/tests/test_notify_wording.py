"""提醒文案在引擎侧也必须同源（对应前端 alertTone.test.ts 的「三层共用一套文案」）。

问题：系统通知此前直接显示调用方给的原始 title —— 图片监控命中会显示
实例名或规则名（如「监控实例-01」），而应用内横幅显示「图片监控命中」。
同一件事两种说法，用户会以为是两件不同的事。

修法：引擎侧建一张与前端 `alertTone.ts` **一字不差**的映射（tool → 标题/语气），
`report_hit` 统一从这里取标题。映射放这里而不是散在各处，是为了能被测试钉住；
前后端各存一份是这套方案唯一能接受的重复 —— 因为引擎不能 import TypeScript。
"""
from __future__ import annotations

import numpy as np
import pytest

from engine import db
from engine.notify import wording
from engine.notify.model import Channel
from engine.notify.report import report_hit


class TestWording:
    def test_五类功能都有标题与语气(self):
        # 少一类，前端有分型而系统通知回落成「命中提醒」，两层又不一致了
        for tool in ("monitor", "guard", "image", "video", "intent"):
            w = wording.of_tool(tool)
            assert w.title, f"{tool} 缺标题"
            assert w.tone, f"{tool} 缺语气标签"

    def test_标题与前端一字不差(self):
        # 这些字串与 src/modules/alerts/alertTone.ts 的 TOOL_PURPOSE 必须相同，
        # 否则同一件事在系统通知与应用内横幅上会说成两句话
        assert wording.of_tool("monitor").title == "图片监控命中"
        assert wording.of_tool("guard").title == "敏感词命中"
        assert wording.of_tool("image").title == "图片识别命中"
        assert wording.of_tool("video").title == "视频帧命中"
        assert wording.of_tool("intent").title == "意图定位结果"

    def test_语气标签也与前端一致(self):
        assert wording.of_tool("monitor").tone == "画面目标出现"
        assert wording.of_tool("guard").tone == "话里有违禁词"

    def test_不认识的工具回落到中性_不能变红也不能瞎编标题(self):
        w = wording.of_tool("未来工具")
        assert w.title == "命中提醒"
        assert w.tone == "系统提示"

    def test_空标题时给出人话兜底_不给空通知(self):
        text = wording.compose(tool="monitor", level="alert", title="", detail="")
        # Windows 通知只显示标题，正文空着看起来像坏了
        assert text.title == "图片监控命中"
        assert text.body

    def test_正文带语气标签与原文(self):
        text = wording.compose(
            tool="guard", level="alert", title="最佳", detail="客户面前提到了最好"
        )
        assert "话里有违禁词" in text.body
        assert "最佳" in text.body
        assert "客户面前提到了最好" in text.body

    def test_标题与原文重复时不出现两遍(self):
        # 调用方常把 title 传成已经带好前缀的整句，再拼一次就成复读
        text = wording.compose(tool="monitor", level="alert", title="图片监控命中", detail="")
        assert text.body.count("图片监控命中") <= 1

    def test_级别不影响标题_只影响语气强度(self):
        # 三层统一的是「这件事叫什么」，不是「有多急」—— 那是颜色/停留时长的职责
        assert (
            wording.compose(tool="monitor", level="info", title="a").title
            == wording.compose(tool="monitor", level="alert", title="a").title
        )


class _FakeChannel:
    name = "desktop"

    def __init__(self) -> None:
        self.sent = []

    def send(self, payload) -> None:
        self.sent.append(payload)


class TestSnapshotPassThrough:
    """report_hit 要能把快照路径一路带到事件表（否则存图白存）。"""

    def setup_method(self) -> None:
        with db.write() as c:
            c.execute("DELETE FROM hit_events")

    def test_快照写进事件表(self) -> None:
        ch = _FakeChannel()
        report_hit(
            instance_id="I1",
            tool="monitor",
            title="订单页面模板",
            rect=[10, 20, 100, 50],
            snapshot="hits/I1/20261005-102231.jpg",
            channels=[ch],
            routing={"info": [], "warn": [], "alert": ["desktop"]},
        )
        assert db.list_hit_events()[0]["snapshot"] == "hits/I1/20261005-102231.jpg"

    def test_没传快照也能正常记_不影响命中主链路(self) -> None:
        ch = _FakeChannel()
        eid = report_hit(
            instance_id="I1",
            tool="monitor",
            title="订单页面模板",
            channels=[ch],
            routing={"info": [], "warn": [], "alert": ["desktop"]},
        )
        assert eid > 0
        assert db.list_hit_events()[0]["snapshot"] == ""

    def test_快照不参与通知正文_通知只说人话(self) -> None:
        ch = _FakeChannel()
        report_hit(
            instance_id="I1",
            tool="monitor",
            title="订单页面模板",
            snapshot="hits/I1/x.jpg",
            channels=[ch],
            routing={"info": [], "warn": [], "alert": ["desktop"]},
        )
        # 路径是内部实现细节，不该出现在用户看到的通知里
        assert "x.jpg" not in ch.sent[0].detail
