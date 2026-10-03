"""测试用的公共构造：假执行内核、配置构造、结果读取。"""
from __future__ import annotations

import time

from engine import db, excel
from engine.driver import Driver, DriverUnavailable
from engine.runner import InstanceRunner


class FakeExecutor:
    """记录被执行的行，并按配置返回成功/失败 —— 替代真实自动化内核。"""

    def __init__(self, results: dict[str, tuple[bool, str]] | None = None, delay: float = 0.0) -> None:
        self.results = results or {}
        self.calls: list[str] = []
        self.delay = delay

    def __call__(self, cfg: dict, row: dict) -> tuple[bool, str]:
        self.calls.append(row["key"])
        if self.delay:
            time.sleep(self.delay)
        return self.results.get(row["key"], (True, ""))


def png_bytes(width: int = 2, height: int = 2) -> bytes:
    """用标准库编码一张真实 PNG（纯色）。

    图像库的测试需要真图片字节，但仓库里不该塞二进制夹具 —— 现造一张更干净，
    而且宽高是我们自己指定的，拿它验证尺寸解析是独立真相源。
    """
    import struct
    import zlib

    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8bit truecolor
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


class FakeDriver:
    """假的自动化驱动：只记录被调用了什么，不真动鼠标键盘。

    真驱动（pyautogui / OpenCV）无法在 CI 里验证，指令解释器的正确性
    完全可以在这一层验完。
    """

    def __init__(
        self,
        images: dict[str, tuple[int, int] | None] | None = None,
        scripted: dict[str, list[tuple[int, int] | None]] | None = None,
        missing_windows: set[str] | None = None,
    ) -> None:
        self.calls: list[tuple] = []
        self.images = images or {}
        #: 按调用次数依次返回，用来模拟「第一次没找到、第二次找到」
        self.scripted = {k: list(v) for k, v in (scripted or {}).items()}
        #: 找不到的窗口标题：镜像真驱动「找不到就抛」的行为
        self.missing_windows = missing_windows or set()

    def activate_window(self, title: str) -> None:
        self.calls.append(("activate_window", title))
        if title in self.missing_windows:
            raise DriverUnavailable(f"没有找到标题包含「{title}」的窗口，请确认它已打开")

    def type_text(self, text: str) -> None:
        self.calls.append(("type_text", text))

    def press(self, combo: list[str], times: int, delay_ms: int) -> None:
        self.calls.append(("press", tuple(combo), times, delay_ms))

    def click(self, x: int, y: int) -> None:
        self.calls.append(("click", x, y))

    def locate(self, asset_id: str, threshold: float, timeout_sec: float) -> tuple[int, int] | None:
        self.calls.append(("locate", asset_id, threshold, timeout_sec))
        queue = self.scripted.get(asset_id)
        if queue:
            return queue.pop(0)
        return self.images.get(asset_id)

    def sleep(self, seconds: float) -> None:
        self.calls.append(("sleep", seconds))

    # 断言辅助
    def kinds(self) -> list[str]:
        return [c[0] for c in self.calls]


def rpa_cfg(path: str, **over) -> dict:
    rpa = {
        "excelPath": path,
        "colName": "客户名称",
        "colMsg": "",
        "colStatus": "",
        "unified": False,
        "unifiedText": "",
        "from": 2,
        "to": 100,
        "retry": 2,
        "onFail": "continue",
        "skipSuccess": True,
        "writeReason": True,
        "backup": False,
        "cmds": [],
    }
    rpa.update(over)
    return {"tool": "rpa", "window": "微信", "rpa": rpa}


def macro_cfg(cmds: list[dict], **over) -> dict:
    """按键精灵配置：只有「绑定窗口 + 指令序列」，没有 Excel、没有列。

    绑定窗口故意用「记事本」而不是 rpa 用的「微信」—— 窗口标题撞车会让
    「宏激活的是自己绑的那个窗」这种断言失去区分力。
    """
    macro = {"cmds": cmds}
    macro.update(over)
    return {"tool": "macro", "window": "记事本", "macro": macro}


def logi_cfg(path: str, ref_path: str, **over) -> dict:
    logi = {
        "file": path,
        "colWaybill": "物流单号",
        "provider": "excel",
        "refFile": ref_path,
        "refNo": "物流单号",
        "refStatus": "物流状态",
        "intervalMs": 1500,
        "retry": 2,
        "pauseOnCaptcha": True,
    }
    logi.update(over)
    return {"tool": "logi", "logi": logi}


def statuses(path: str, key_col: str = "客户名称", status_col: str = excel.STATUS_COLUMN_DEFAULT) -> list[str]:
    return [r["existing_status"] for r in excel.read_rows(path, key_col, 1, 100, status_col)]


def last_run_records(iid: str) -> list[tuple[str, str]]:
    recs = db.query(
        "SELECT key_value, status FROM rows WHERE run_id="
        "(SELECT id FROM runs WHERE instance_id=? ORDER BY id DESC LIMIT 1) ORDER BY row_no",
        (iid,),
    )
    return [(r["key_value"], r["status"]) for r in recs]


def make_runner(iid: str, **kw) -> InstanceRunner:
    """测试里造 runner 的统一入口：**默认注入假驱动**。

    runner 起跑时会先激活「绑定窗口」（`_activate_bound_window`），没注入驱动的话
    它会去构造真驱动，在 CI 上必然找不到窗口。这个默认值让「没在意窗口这件事」的
    用例也能照常跑；真要验驱动的用例自己传 `driver=`。
    """
    kw.setdefault("driver", FakeDriver())
    return InstanceRunner(iid, **kw)


def run_to_completion(
    iid: str,
    executor: FakeExecutor,
    wait,
    executor_only: bool = True,
    driver: Driver | None = None,
) -> InstanceRunner:
    runner = make_runner(iid, executor=executor, driver=driver or FakeDriver())
    assert runner.start(), "实例应能从当前状态启动"
    assert wait(iid, {"completed"}, 10) == "completed"
    return runner
