"""Seam：`macro`（按键精灵）的执行内核 —— 没有数据源的一次性指令序列。

设备层（真窗口激活、真键鼠）只人工验收，所以这里注入 `FakeDriver`：验的是
「顺序、每步一条台账、失败即止、可中断、没绑窗口不许跑」这些纯逻辑。

真值来源是配置本身（指令序列 + 绑定窗口），不是实现里的任何常量。
"""
from __future__ import annotations

from engine import db
from tests.helpers import FakeDriver, last_run_records, macro_cfg, make_runner


def _progress(iid: str) -> tuple[int, int]:
    """进度条读的就是这两个数：宏的「总量」是指令条数，不是 Excel 行数。"""
    r = db.query("SELECT progress_done, progress_total FROM instances WHERE id=?", (iid,))[0]
    return r["progress_done"], r["progress_total"]


def test_macro_runs_each_command_once_in_order(make_instance, wait_status):
    """一轮宏 = 把指令序列从头走到尾，一次；起跑前先把绑定窗口拉到前台。

    窗口必须在**第一条指令之前**激活：先打字再激活，那串字就留在了当时恰好
    在前台的那个窗口里 —— 客服场景下就是把话术发给了别的客户。
    """
    iid = make_instance(
        "macro",
        macro_cfg(
            [
                {"t": "输入问候语", "type": "text", "p": "您好，请问需要什么帮助？"},
                {"t": "复制", "type": "key", "key": {"combo": ["ctrl", "c"]}},
                {"t": "等一下", "type": "flow", "p": "0.4"},
            ]
        ),
    )
    driver = FakeDriver()
    runner = make_runner(iid, driver=driver)

    assert runner.start(), "空闲实例应能启动"
    assert wait_status(iid, {"completed"}) == "completed"

    assert driver.calls == [
        ("activate_window", "记事本"),
        ("type_text", "您好，请问需要什么帮助？"),
        ("press", ("ctrl", "c"), 1, 120),
        ("sleep", 0.4),
    ]


def test_macro_records_one_row_per_command(make_instance, wait_status):
    """台账粒度是「一条指令一行」。

    这样运行详情页不用为宏单独做一套 UI，失败也能指到具体是哪一步 ——
    「宏失败了」对用户没有信息量，「第 2 步『复制』失败了」才有。
    """
    iid = make_instance(
        "macro",
        macro_cfg(
            [
                {"t": "输入问候语", "type": "text", "p": "您好"},
                {"t": "复制", "type": "key", "key": {"combo": ["ctrl", "c"]}},
                {"t": "等一下", "type": "flow", "p": "0.1"},
            ]
        ),
    )
    runner = make_runner(iid, driver=FakeDriver())

    assert runner.start()
    assert wait_status(iid, {"completed"}) == "completed"

    assert last_run_records(iid) == [("输入问候语", "ok"), ("复制", "ok"), ("等一下", "ok")]
    assert _progress(iid) == (3, 3)


def test_macro_records_switched_off_commands_as_skipped(make_instance, wait_status):
    """关掉的指令也要占一行 `skip`，而且仍计入进度。

    否则台账里凭空少一条：用户看到「2/3」却不知道少的那个是谁，
    进度条还会永远差一格。语义与 rpa 记「上次已成功」的 skip 是同一个。
    """
    iid = make_instance(
        "macro",
        macro_cfg(
            [
                {"t": "输入问候语", "type": "text", "p": "在吗"},
                {"t": "旧话术", "type": "text", "p": "这句不该出现", "on": False},
                {"t": "回车", "type": "key", "key": {"combo": ["enter"]}},
            ]
        ),
    )
    driver = FakeDriver()
    runner = make_runner(iid, driver=driver)

    assert runner.start()
    assert wait_status(iid, {"completed"}) == "completed"

    assert last_run_records(iid) == [("输入问候语", "ok"), ("旧话术", "skip"), ("回车", "ok")]
    assert _progress(iid) == (3, 3)
    typed = [c[1] for c in driver.calls if c[0] == "type_text"]
    assert typed == ["在吗"], "关掉的指令不该碰键盘"


def test_macro_stops_at_the_first_failing_command(make_instance, wait_status):
    """某一步失败就停住，并让整轮以 `error` 收场。

    停：后面的指令是建立在「前一步成了」的前提上写的（复制完才粘贴），
    接着执行只会把错误放大。
    `error`：宏断在第 2 条却显示「已完成」，客服会读成「这条回复发出去了」——
    那是真实事故，不是措辞问题。
    """
    iid = make_instance(
        "macro",
        macro_cfg(
            [
                {"t": "输入问候语", "type": "text", "p": "您好"},
                # 键名写错（pyautogui 认 ctrl 不认 Ctr）：这是最容易静默失配的一类错
                {"t": "复制", "type": "key", "key": {"combo": ["Ctr", "c"]}},
                {"t": "粘贴", "type": "key", "key": {"combo": ["ctrl", "v"]}},
            ]
        ),
    )
    driver = FakeDriver()
    runner = make_runner(iid, driver=driver)

    assert runner.start()
    assert wait_status(iid, {"error"}) == "error"

    assert last_run_records(iid) == [("输入问候语", "ok"), ("复制", "err")]
    assert _progress(iid) == (2, 3)
    assert [c for c in driver.calls if c[0] == "press"] == [], "错的那条没按键，后面那条更不该按"


def test_macro_with_no_commands_reports_an_error(make_instance, wait_status):
    """空宏不许静默「完成」。

    刚建好的实例还没有指令，这时候按 F8 如果回报「已完成」，用户会以为它干了什么。
    连窗口都不用激活 —— 没有指令就没必要把任何窗口拉到前台。
    """
    iid = make_instance("macro", macro_cfg([]))
    driver = FakeDriver()
    runner = make_runner(iid, driver=driver)

    assert runner.start()
    assert wait_status(iid, {"error"}) == "error"

    assert driver.calls == []


def test_macro_without_a_bound_window_refuses_to_run(make_instance, wait_status):
    """没绑窗口就不许跑 —— 这是「误触发保护」的最后一道闸。

    宏的全部意义是「在某个窗口里按几下」；没有窗口就等于往「此刻恰好在前台」
    的那个窗口里打字，客服场景下那可能就是这批话术发给了别的客户。
    配置页会拦住这种存档，但手工改过的 JSON 拦不住，所以引擎自己也认这条底线。
    """
    cfg = macro_cfg([{"t": "输入问候语", "type": "text", "p": "您好"}])
    cfg["window"] = ""
    iid = make_instance("macro", cfg)
    driver = FakeDriver()
    runner = make_runner(iid, driver=driver)

    assert runner.start()
    assert wait_status(iid, {"error"}) == "error"

    assert driver.calls == [], "一条指令都不该执行，连窗口都不该去激活"


class _StopOnFirstSleep(FakeDriver):
    """第一条指令执行到一半就按停止键。

    用回调而不是「另起线程睡一会儿再 stop」：抢那几十毫秒在慢 CI 上会偶发失败，
    而这条测试要验的是「停住之后不再执行后面的指令」，不是抢时序的本事。
    """

    def __init__(self) -> None:
        super().__init__()
        self.on_sleep = None

    def sleep(self, seconds: float) -> None:
        super().sleep(seconds)
        if self.on_sleep:
            self.on_sleep()


def test_macro_can_be_stopped_between_commands(make_instance, wait_status):
    """暂停/停止检查落在**每一条指令之前**，所以长宏跑飞了停得下来。

    停止生效的时点 = 下一条指令开头。这也意味着单条 `flow` 延时期间停不住 ——
    延时通常在 1 秒上下，这个代价换来了「每条指令都是原子的」这一简单模型。
    """
    iid = make_instance(
        "macro",
        macro_cfg(
            [
                {"t": "等一下", "type": "flow", "p": "1"},
                {"t": "不该执行", "type": "text", "p": "这句话不该被打出来"},
            ]
        ),
    )
    driver = _StopOnFirstSleep()
    runner = make_runner(iid, driver=driver)
    driver.on_sleep = runner.stop

    assert runner.start()
    assert wait_status(iid, {"idle"}) == "idle"

    assert driver.kinds() == ["activate_window", "sleep"]
    assert last_run_records(iid) == [("等一下", "ok")]


def test_macro_with_an_unreachable_window_fails_without_touching_the_keyboard(make_instance, wait_status):
    """绑定的窗口找不到时整轮失败，一条指令都不执行。

    窗口标题写错、目标程序没开，都是日常会发生的事。这时候唯一的正确做法是停住 ——
    继续按键就等于把话术打进「此刻恰好在前台」的那个窗口里。
    """
    iid = make_instance("macro", macro_cfg([{"t": "输入问候语", "type": "text", "p": "您好"}]))
    driver = FakeDriver(missing_windows={"记事本"})
    runner = make_runner(iid, driver=driver)

    assert runner.start()
    assert wait_status(iid, {"error"}) == "error"

    assert driver.kinds() == ["activate_window"], "只尝试过激活，没有真的按键"
    assert last_run_records(iid) == []


def test_macro_bailing_out_resets_the_stale_progress(make_instance, wait_status):
    """这一轮什么都没跑，「已完成多少」就不该留着上一轮的数字。

    「整体进度 5 / 5 条指令」配 0 条明细和一个错误状态，读起来像
    「5 条都成了、只是没显示出来」。复位之后是 0/1：计划 1 条，一条都没跑成 ——
    `total` 是本轮自己定的计划，`done` 才是绝不能从上一轮继承的东西。
    """
    iid = make_instance("macro", macro_cfg([{"t": "输入问候语", "type": "text", "p": "您好"}]))
    with db.write() as c:
        c.execute("UPDATE instances SET progress_done=5, progress_total=5 WHERE id=?", (iid,))

    runner = make_runner(iid, driver=FakeDriver(missing_windows={"记事本"}))
    assert runner.start()
    assert wait_status(iid, {"error"}) == "error"

    assert _progress(iid) == (0, 1)
