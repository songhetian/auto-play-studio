"""Seam 2：Runner 执行与跳过成功行。

自动化内核（真开窗口、真点鼠标）不该出现在测试里，所以在 runner 与内核之间留一个
executor 注入点：测试注入假的 executor，验证的是「跑哪些行、回写什么、记什么」。
"""
from __future__ import annotations

import os
import pathlib
import threading
import time

import pytest

from engine import db, excel, screen_lock
from engine.providers import CaptchaEncountered, LogisticsProvider, WaybillResult
from engine.runner import InstanceRunner
from engine.screen_lock import ScreenBusy
from tests.helpers import (
    FakeDriver,
    FakeExecutor,
    last_run_records,
    logi_cfg,
    make_runner,
    rpa_cfg,
    run_to_completion,
    statuses,
)


def test_first_run_executes_every_row_and_writes_success(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    executor = FakeExecutor()

    run_to_completion(iid, executor, wait_status)

    assert executor.calls == ["张三", "李四"]
    assert statuses(order_xlsx) == [excel.STATUS_OK, excel.STATUS_OK]
    assert last_run_records(iid) == [("张三", "ok"), ("李四", "ok")]
    inst = db.query("SELECT progress_done, progress_total FROM instances WHERE id=?", (iid,))[0]
    assert (inst["progress_done"], inst["progress_total"]) == (2, 2)


def test_second_run_skips_rows_already_successful(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    run_to_completion(iid, FakeExecutor(), wait_status)

    second = FakeExecutor()
    run_to_completion(iid, second, wait_status)

    assert second.calls == [], "已成功的行不应重复执行"
    assert last_run_records(iid) == [("张三", "skip"), ("李四", "skip")]


def test_only_failed_rows_are_retried(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    run_to_completion(iid, FakeExecutor({"张三": (False, "未找到窗口")}), wait_status)

    assert statuses(order_xlsx) == [excel.STATUS_ERR, excel.STATUS_OK]

    second = FakeExecutor()
    run_to_completion(iid, second, wait_status)

    assert second.calls == ["张三"], "只应重跑失败行"
    assert statuses(order_xlsx) == [excel.STATUS_OK, excel.STATUS_OK]


def test_failure_reason_is_recorded(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    run_to_completion(iid, FakeExecutor({"张三": (False, "未找到窗口")}), wait_status)

    assert last_run_records(iid) == [("张三", "err"), ("李四", "ok")]
    rows = db.query(
        "SELECT message FROM rows WHERE run_id="
        "(SELECT id FROM runs WHERE instance_id=? ORDER BY id DESC LIMIT 1) ORDER BY row_no",
        (iid,),
    )
    assert rows[0]["message"] == "未找到窗口"


def test_two_instances_can_run_concurrently(make_instance, xlsx_factory, wait_status):
    """不碰屏幕的工具（logi 走独立浏览器）多开是真并行：各自的进度与回写不能互相干扰。

    这里刻意用 logi 而不是 rpa —— rpa/macro 要动真键鼠，一块屏幕同一时刻只能有一个在跑，
    那条约束在下面的「屏幕互斥」一节单独验。
    """
    p1 = xlsx_factory(["物流单号"], [["SF1"], ["SF2"]], name="a.xlsx")
    p2 = xlsx_factory(["物流单号"], [["YT1"]], name="b.xlsx")
    i1 = make_instance("logi", {"tool": "logi", "logi": {"file": p1, "colWaybill": "物流单号", "provider": "web"}})
    i2 = make_instance("logi", {"tool": "logi", "logi": {"file": p2, "colWaybill": "物流单号", "provider": "web"}})
    prov = SlowProvider(delay=0.05)

    assert InstanceRunner(i1, provider=prov, driver=FakeDriver()).start()
    assert InstanceRunner(i2, provider=prov, driver=FakeDriver()).start()

    assert wait_status(i1, {"completed"}, 10) == "completed"
    assert wait_status(i2, {"completed"}, 10) == "completed"
    assert last_run_records(i1) == [("SF1", "ok"), ("SF2", "ok")]
    assert last_run_records(i2) == [("YT1", "ok")]


# ── 屏幕互斥 ──────────────────────────────────────────────
# rpa / macro 靠模拟真人键鼠干活，作用于当前焦点窗口。一块屏幕同一时刻只能有一个在跑：
# 两个同时跑，第二个会把第一个的窗口顶掉焦点、抢鼠标 —— 而且不报错，只会悄悄点错窗口、
# 把话发给错人。这是「模拟真人键鼠」这个手段的物理上限，所以引擎要在 start 时拦住，
# 并且把「被谁占着」讲清楚，而不是让用户看着两个实例互相打架猜原因。


class BlockingExecutor:
    """一直跑到放行为止：把第一个实例钉在 running 状态，好让第二个去抢锁。"""

    def __init__(self) -> None:
        self.started = threading.Event()
        self.gate = threading.Event()
        self.calls: list[str] = []

    def __call__(self, cfg: dict, row: dict) -> tuple[bool, str]:
        self.calls.append(row["key"])
        self.started.set()
        self.gate.wait(5)
        return (True, "")


def test_screen_tool_cannot_start_while_another_holds_the_screen(make_instance, order_xlsx, xlsx_factory, wait_status):
    i1 = make_instance("rpa", rpa_cfg(order_xlsx), name="先行")
    i2 = make_instance("rpa", rpa_cfg(xlsx_factory(["客户名称"], [["王五"]], name="b.xlsx")), name="后到")

    blocker = BlockingExecutor()
    assert make_runner(i1, executor=blocker).start()
    assert blocker.started.wait(5), "第一个实例应当先跑起来、握住屏幕"

    # 第二个实例抢不到屏幕：start 直接说「为什么不行」，状态不能被偷偷改掉
    with pytest.raises(ScreenBusy) as caught:
        make_runner(i2, executor=FakeExecutor()).start()
    assert caught.value.holder_id == i1
    assert db.query("SELECT status FROM instances WHERE id=?", (i2,))[0]["status"] == "idle"

    # 第一个跑完，屏幕放出来，第二个就能正常跑了
    blocker.gate.set()
    assert wait_status(i1, {"completed"}, 10) == "completed"
    run_to_completion(i2, FakeExecutor(), wait_status)
    assert screen_lock.holder() is None


def test_paused_screen_tool_keeps_holding_the_screen(make_instance, order_xlsx, xlsx_factory, wait_status):
    """暂停 ≠ 交出屏幕：用户暂停是为了等个时机接着跑，屏幕不能在这时候被别人抢走。"""
    i1 = make_instance("rpa", rpa_cfg(order_xlsx), name="暂停中")
    i2 = make_instance("rpa", rpa_cfg(xlsx_factory(["客户名称"], [["王五"]], name="b.xlsx")), name="插队")

    holder = make_runner(i1, executor=FakeExecutor({"张三": (True, "")}))
    assert holder.start()
    assert wait_status(i1, {"running"}, 10) == "running"
    assert holder.pause()
    assert wait_status(i1, {"paused"}, 10) == "paused"

    with pytest.raises(ScreenBusy):
        make_runner(i2, executor=FakeExecutor()).start()

    assert holder.resume()
    assert wait_status(i1, {"completed"}, 10) == "completed"
    run_to_completion(i2, FakeExecutor(), wait_status)


def test_stopping_a_screen_tool_frees_the_screen(make_instance, order_xlsx, xlsx_factory, wait_status):
    """用户点「停止」应该立刻能跑下一个 —— 不能让屏幕被一个已经停了的实例占着。"""
    i1 = make_instance("rpa", rpa_cfg(order_xlsx), name="停掉")
    i2 = make_instance("rpa", rpa_cfg(xlsx_factory(["客户名称"], [["王五"]], name="b.xlsx")), name="接上")

    blocker = BlockingExecutor()
    runner = make_runner(i1, executor=blocker)
    assert runner.start()
    assert blocker.started.wait(5)
    runner.stop()
    assert wait_status(i1, {"idle"}, 10) == "idle"

    run_to_completion(i2, FakeExecutor(), wait_status)


TEXT_CMDS = [{"t": "输入文本", "type": "text", "on": True, "p": "您好 {客户名称}：{话术模板}"}]


# ── 绑定窗口 ──────────────────────────────────────────────
def test_bound_window_is_activated_before_the_first_row(make_instance, order_xlsx, wait_status):
    """配置页写着「运行时会先激活这个窗口再执行指令」，但引擎从来没读过 window 字段 ——
    用户被迫选一个窗口（不选就存不了），选完却毫无作用。
    """
    iid = make_instance("rpa", rpa_cfg(order_xlsx, cmds=TEXT_CMDS))
    driver = FakeDriver()

    InstanceRunner(iid, driver=driver).start()
    assert wait_status(iid, {"completed"}, 10) == "completed"

    assert driver.calls[0] == ("activate_window", "微信")
    # 只激活一次：每行都激活的话 100 行要多等 20 秒
    assert driver.kinds().count("activate_window") == 1


def test_unreachable_bound_window_fails_the_run_without_touching_the_keyboard(
    make_instance, order_xlsx, wait_status
):
    """窗口找不到就整轮失败。继续跑等于往「此刻恰好在前台」的窗口里打字 ——
    客服场景下那可能就是把话术发给了别的客户。
    """
    iid = make_instance("rpa", rpa_cfg(order_xlsx, cmds=TEXT_CMDS))
    driver = FakeDriver(missing_windows={"微信"})

    InstanceRunner(iid, driver=driver).start()
    assert wait_status(iid, {"error"}, 10) == "error"

    assert driver.kinds() == ["activate_window"], "只应尝试激活，不该发出任何按键"
    logs = db.query("SELECT message FROM logs WHERE instance_id=? ORDER BY id", (iid,))
    assert any("微信" in r["message"] for r in logs), "失败原因要说清是哪个窗口没找到"


def test_config_without_a_bound_window_still_runs(make_instance, order_xlsx, wait_status):
    """手工改过的存档 window 可能是空的，不该因此跑不起来。"""
    iid = make_instance("rpa", rpa_cfg(order_xlsx, cmds=TEXT_CMDS) | {"window": ""})
    driver = FakeDriver()

    run_to_completion(iid, FakeExecutor(), wait_status, driver=driver)

    assert driver.kinds() == [], "没绑窗口就不激活，也不该发出任何按键"


def test_text_is_built_from_the_current_excel_row(make_instance, order_xlsx, wait_status):
    """每行发不同内容 —— 这是这类工具最基本的诉求。"""
    iid = make_instance("rpa", rpa_cfg(order_xlsx, cmds=TEXT_CMDS))
    driver = FakeDriver()

    runner = InstanceRunner(iid, driver=driver)
    assert runner.start()
    assert wait_status(iid, {"completed"}, 10) == "completed"

    assert driver.calls == [
        ("activate_window", "微信"),
        ("type_text", "您好 张三：您好，新品上架"),
        ("type_text", "您好 李四：您好，老客回访"),
    ]


def test_unified_text_overrides_the_message_column(make_instance, order_xlsx, wait_status):
    """开了「统一发送内容」就忽略 Excel 的消息内容列，所有行发同一句。"""
    cfg = rpa_cfg(order_xlsx, colMsg="话术模板", unified=True, unifiedText="统一文案", cmds=TEXT_CMDS)
    iid = make_instance("rpa", cfg)
    driver = FakeDriver()

    InstanceRunner(iid, driver=driver).start()
    assert wait_status(iid, {"completed"}, 10) == "completed"

    assert [c[1] for c in driver.calls if c[0] == "type_text"] == ["您好 张三：统一文案", "您好 李四：统一文案"]


def test_command_failure_marks_the_row_failed(make_instance, order_xlsx, wait_status):
    cmds = [
        {
            "t": "点击发送",
            "type": "img",
            "on": True,
            "p": "",
            "image": {"assetId": "btn_send", "threshold": 0.9, "timeoutSec": 1, "onMiss": "fail"},
        }
    ]
    iid = make_instance("rpa", rpa_cfg(order_xlsx, cmds=cmds))

    InstanceRunner(iid, driver=FakeDriver()).start()  # 空屏幕：找不到按钮
    assert wait_status(iid, {"completed"}, 10) == "completed"

    assert statuses(order_xlsx) == [excel.STATUS_ERR, excel.STATUS_ERR]
    assert last_run_records(iid) == [("张三", "err"), ("李四", "err")]
    msg = db.query(
        "SELECT message FROM rows WHERE run_id=(SELECT id FROM runs WHERE instance_id=? ORDER BY id DESC LIMIT 1)",
        (iid,),
    )[0]["message"]
    assert "btn_send" in msg


def test_unknown_placeholder_never_reaches_the_keyboard(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx, cmds=[{"t": "输入文本", "type": "text", "on": True, "p": "您好 {客户名}"}]))
    driver = FakeDriver()

    InstanceRunner(iid, driver=driver).start()
    assert wait_status(iid, {"completed"}, 10) == "completed"

    assert driver.kinds() == ["activate_window"], "占位符解析不了就不该动键盘（激活窗口不算动键盘）"
    assert last_run_records(iid) == [("张三", "err"), ("李四", "err")]


def test_stop_brings_instance_back_to_idle(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx))
    executor = FakeExecutor(delay=0.3)
    runner = InstanceRunner(iid, executor=executor, driver=FakeDriver())

    assert runner.start()
    assert wait_status(iid, {"running"}, 5) == "running"
    assert runner.stop()
    assert wait_status(iid, {"idle"}, 10) == "idle"
    assert len(executor.calls) < 2, "停止后不应继续执行剩余行"


def test_skip_can_be_disabled(make_instance, order_xlsx, wait_status):
    iid = make_instance("rpa", rpa_cfg(order_xlsx, skipSuccess=False))
    run_to_completion(iid, FakeExecutor(), wait_status)

    second = FakeExecutor()
    run_to_completion(iid, second, wait_status)

    assert second.calls == ["张三", "李四"]


@pytest.mark.parametrize("status_col", ["", "发送结果"])
def test_custom_status_column_drives_skip(make_instance, xlsx_factory, wait_status, status_col):
    """无论用默认状态列还是用户指定的列，第二次执行都必须跳过成功行。"""
    path = xlsx_factory(["客户名称"], [["张三"], ["李四"]])
    iid = make_instance("rpa", rpa_cfg(path, colStatus=status_col))
    run_to_completion(iid, FakeExecutor(), wait_status)

    second = FakeExecutor()
    run_to_completion(iid, second, wait_status)

    assert second.calls == []


def test_logistics_run_writes_a_new_file(make_instance, xlsx_factory, ref_xlsx, wait_status):
    """物流查询：原文件保持只读，结果写进「原名_物流信息.xlsx」。"""
    src = xlsx_factory(
        ["订单号", "物流单号"],
        [["O1", "SF1234567890"], ["O2", "YT9876543210"]],
        name="waybill.xlsx",
    )
    iid = make_instance("logi", logi_cfg(src, ref_xlsx))

    runner = make_runner(iid)
    assert runner.start()
    assert wait_status(iid, {"completed"}, 10) == "completed"

    out = str(pathlib.Path(src).with_name("waybill_物流信息.xlsx"))
    assert os.path.exists(out)
    assert excel.detect_columns(src) == ["订单号", "物流单号"], "原文件不应被改动"
    assert excel.detect_columns(out)[-4:] == ["物流公司", "物流状态", "签收时间", "最新轨迹"]

    wb_rows = excel.read_rows(out, "物流单号", 2, 100)
    assert [r["key"] for r in wb_rows] == ["SF1234567890", "YT9876543210"]
    assert last_run_records(iid) == [("SF1234567890", "ok"), ("YT9876543210", "ok")]


class CaptchaProvider(LogisticsProvider):
    """注入到 runner 的假 Provider：查任何单号都报验证码。"""

    name = "captcha"

    def query(self, no: str) -> object:
        raise CaptchaEncountered(no)


class SlowProvider(LogisticsProvider):
    """注入到 runner 的假 Provider：查得到、但慢 —— 用来让两个 logi 真正重叠着跑。"""

    name = "slow"

    def __init__(self, delay: float) -> None:
        self.delay = delay

    def query(self, no: str) -> WaybillResult:
        time.sleep(self.delay)
        return WaybillResult(no=no, company="测试快递", status="已签收")


def test_logi_pauses_on_captcha_when_configured(make_instance, xlsx_factory, wait_status):
    """项目约定：遇验证码暂停转人工。注入报验证码的 Provider，开启 pauseOnCaptcha 后应停在 paused。"""
    src = xlsx_factory(["物流单号"], [["SF1"], ["SF2"]], name="wb.xlsx")
    cfg = {"tool": "logi", "logi": {"file": src, "colWaybill": "物流单号", "provider": "web", "pauseOnCaptcha": True}}
    iid = make_instance("logi", cfg)

    runner = InstanceRunner(iid, provider=CaptchaProvider())
    assert runner.start()
    assert wait_status(iid, {"paused"}, 10) == "paused"

    runner.stop()
    assert wait_status(iid, {"idle"}, 10) == "idle"


def test_logi_keeps_running_past_captcha_when_pause_disabled(make_instance, xlsx_factory, wait_status):
    """关掉 pauseOnCaptcha 时，验证码只让当前行失败，不暂停整批。"""
    src = xlsx_factory(["物流单号"], [["SF1"], ["SF2"]], name="wb2.xlsx")
    cfg = {"tool": "logi", "logi": {"file": src, "colWaybill": "物流单号", "provider": "web", "pauseOnCaptcha": False}}
    iid = make_instance("logi", cfg)

    runner = InstanceRunner(iid, provider=CaptchaProvider())
    assert runner.start()
    assert wait_status(iid, {"completed"}, 10) == "completed"
    assert last_run_records(iid) == [("SF1", "err"), ("SF2", "err")]
