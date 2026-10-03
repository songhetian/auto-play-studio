"""RPA 指令解释器：把配置里的指令序列翻译成一串对自动化驱动的调用。

设计要点
--------
* 只依赖一个 **驱动** 抽象（见 driver.py），真正的 pyautogui / OpenCV 实现放在驱动层，
  这样「翻译得对不对」可以在不碰鼠标键盘的前提下测完。
* 指令里可以写 `{列名}` 引用当前行的 Excel 数据。**占位符解析不出来就整行失败** ——
  继续执行会把 `{客户名}` 这种字面量直接发给客户，那是真实事故。
* 关掉的指令（`on: false`）不执行；某条指令失败就中止当前行，不带着错误状态继续点下去。
"""
from __future__ import annotations

from .driver import Driver

#: 按键词表与组合键归一化（pyautogui 语汇）。和 hotkey.ts 的 Electron accelerator 是两套，
#: 别混用 —— 见 keys.py 顶部说明。
from .keys import normalize_combo

#: 模板渲染已经拆到 template.py（那里是语法的唯一真源）。这里保留 re-export，
#: 免得所有调用点都改 import；两处名字都指向同一个函数。
from .template import TemplateError, render_template  # noqa: F401


class CommandError(Exception):
    """一条指令没能执行成功，附带给人看的原因。"""


def run_commands(cmds: list[dict], row: dict, driver: Driver) -> tuple[bool, str]:
    """按顺序执行指令，返回 (是否成功, 失败原因)。"""
    for cmd in cmds:
        if not cmd.get("on", True):
            continue
        try:
            _exec(cmd, row, driver)
        except (CommandError, TemplateError) as exc:
            return False, f"「{cmd.get('t', '未命名指令')}」{exc}"
        except Exception as exc:  # noqa: BLE001
            return False, f"「{cmd.get('t', '未命名指令')}」执行异常：{exc}"
    return True, ""


def _exec(cmd: dict, row: dict, driver: Driver) -> None:
    kind = cmd.get("type")

    if kind == "text":
        driver.type_text(render_template(cmd.get("p", ""), row))
        return

    if kind == "win":
        title = render_template(cmd.get("p", ""), row) or str(row.get("key", ""))
        # 空标题不能交给驱动：窗口匹配是按「标题包含关键字」做的，空串会匹配到
        # **任意一个**窗口 —— 随机切一个窗口再往下按键。rpa 里留空会回落到本行
        # 关键字，所以碰不到；宏没有行（row['key'] 是空串），这条路真能走到。
        if not title.strip():
            raise CommandError("要切换的窗口标题是空的，请填一个标题关键字")
        driver.activate_window(title)
        return

    if kind == "key":
        key = cmd.get("key") or {}
        # 归一化放在这里而不是驱动层：用户在配置页怎么写都行，但驱动只该收到
        # pyautogui 认的那一串。写错的键名当场变成失败原因，而不是静默不按。
        combo, reason = normalize_combo(key.get("combo"))
        if reason:
            raise CommandError(reason)
        driver.press(combo, int(key.get("repeat", 1)), int(key.get("delayMs", 120)))
        return

    if kind == "img":
        _exec_image(cmd, driver)
        return

    if kind == "flow":
        _exec_flow(cmd, row, driver)
        return

    raise CommandError(f"不支持的指令类型「{kind}」")


def _exec_image(cmd: dict, driver: Driver) -> None:
    image = cmd.get("image") or {}
    asset_id = image.get("assetId")
    if not asset_id:
        raise CommandError("还没有选择要匹配的图片")

    threshold = float(image.get("threshold", 0.85))
    timeout = float(image.get("timeoutSec", 5))
    on_miss = image.get("onMiss", "fail")

    hit = driver.locate(asset_id, threshold, timeout)
    if hit is None and on_miss == "retry":
        hit = driver.locate(asset_id, threshold, timeout)
    if hit is None:
        raise CommandError(f"等待超时，屏幕上没有找到图片「{asset_id}」")
    if image.get("click", True):
        driver.click(int(hit[0]) + int(image.get("offsetX", 0)), int(hit[1]) + int(image.get("offsetY", 0)))


def _exec_flow(cmd: dict, row: dict, driver: Driver) -> None:
    raw = render_template(cmd.get("p", ""), row).strip()
    try:
        seconds = float(raw)
    except ValueError:
        raise CommandError(f"延时需要填秒数（例如 1.5），收到「{raw}」")
    if seconds < 0:
        raise CommandError("延时不能是负数")
    driver.sleep(seconds)
