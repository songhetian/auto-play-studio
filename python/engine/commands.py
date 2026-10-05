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
            # 指令顶层的 `repeat` = 整条指令跑几遍（通用：点三次提交、发三条消息）。
            # 按键的「连按 N 次」是另一个意思，走 key.repeat，由驱动内部带间隔完成。
            for _ in range(_repeat_of(cmd)):
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
        _exec_key(cmd, driver)
        return

    if kind == "img":
        _exec_image(cmd, driver)
        return

    if kind == "flow":
        _exec_flow(cmd, row, driver)
        return

    # ── 扩充出来的指令 ──
    if kind == "mouse":
        _exec_mouse(cmd, row, driver)
        return

    if kind == "move":
        _exec_move(cmd, row, driver)
        return

    if kind == "scroll":
        _exec_scroll(cmd, row, driver)
        return

    if kind == "drag":
        _exec_drag(cmd, row, driver)
        return

    if kind == "clip":
        _exec_clip(cmd, row, driver)
        return

    if kind == "shot":
        _exec_shot(cmd, row, driver)
        return

    if kind == "waitimg":
        _exec_wait_image(cmd, driver)
        return

    if kind == "screen":
        _exec_screen(cmd, row, driver)
        return

    raise CommandError(f"不支持的指令类型「{kind}」")


def _parse_xy(raw: str, what: str = "坐标") -> tuple[int, int]:
    """解析 "x,y"。

    非法的坐标必须在执行前就拒掉 —— 坐标错误落到驱动层会变成
    `pyautogui.click(0, 0)`，也就是**真的点了屏幕左上角**，比报错糟得多。
    """
    parts = [p.strip() for p in (raw or "").replace("，", ",").split(",")]
    if len(parts) != 2 or not all(parts):
        raise CommandError(f"{what}要写成「x,y」（两个数字），收到「{raw}」")
    try:
        x, y = int(parts[0]), int(parts[1])
    except ValueError:
        raise CommandError(f"{what}必须是数字，收到「{raw}」") from None
    if x < 0 or y < 0:
        raise CommandError(f"{what}不能是负数，收到「{raw}」")
    return x, y


def _repeat_of(cmd: dict) -> int:
    """指令重复次数。

    放在**指令顶层**而不是各指令自己的字段里：重复是通用能力 ——
    「点三次提交」「发三次消息」都要它，压在 key 下面只有按键能用。
    """
    n = int(cmd.get("repeat", 1) or 1)
    if n < 1:
        raise CommandError("重复次数至少是 1")
    return n


def _exec_key(cmd: dict, driver: Driver) -> None:
    key = cmd.get("key") or {}
    combo, reason = normalize_combo(key.get("combo"))
    if reason:
        raise CommandError(reason)
    # 两个"重复"是两件事，别混：
    #   - `key.repeat`（既有语义）：连按几次，每次之间停 delayMs —— 驱动原语内部处理
    #   - 指令顶层 `repeat`（新增通用能力）：整条指令跑几遍 —— 外层 run_commands 处理
    times = int(key.get("repeat", 1) or 1)
    if times < 1:
        raise CommandError("按键重复次数至少是 1")
    driver.press(combo, times, int(key.get("delayMs", 120)))


def _exec_mouse(cmd: dict, row: dict, driver: Driver) -> None:
    """点击。默认就是左键单击，所以最常见的情况走最短路径。"""
    x, y = _parse_xy(render_template(cmd.get("p", ""), row))
    button = (cmd.get("button") or "left").strip().lower()
    if button not in ("left", "right", "middle"):
        raise CommandError("点击方式只能是 left / right / middle（默认 left）")
    clicks = int(cmd.get("clicks", 1) or 1)
    if clicks < 1 or clicks > 3:
        raise CommandError("点击次数只能是 1~3（双击填 2）")
    if button == "left" and clicks == 1:
        driver.click(x, y)  # 最常见路径，走原语
        return
    driver.click_button(x, y, button, clicks)


def _exec_move(cmd: dict, row: dict, driver: Driver) -> None:
    """移动鼠标但不点击 —— 悬停出菜单靠它。"""
    x, y = _parse_xy(render_template(cmd.get("p", ""), row))
    driver.move_to(x, y, int(cmd.get("durationMs", 0) or 0))


def _exec_scroll(cmd: dict, row: dict, driver: Driver) -> None:
    raw = render_template(cmd.get("p", ""), row).strip()
    try:
        amount = int(raw)
    except ValueError:
        raise CommandError(f"滚轮要填格数（正数向上、负数向下，例如 -3），收到「{raw}」") from None
    driver.scroll(amount)


def _exec_drag(cmd: dict, row: dict, driver: Driver) -> None:
    """拖拽：从起点按住到终点松开。参数是四个数字 x1,y1,x2,y2。"""
    raw = render_template(cmd.get("p", ""), row)
    parts = [p.strip() for p in raw.replace("，", ",").split(",")]
    if len(parts) != 4 or not all(parts):
        raise CommandError(f"拖拽坐标要写成「x1,y1,x2,y2」（四个数字），收到「{raw}」")
    try:
        x1, y1, x2, y2 = (int(p) for p in parts)
    except ValueError:
        raise CommandError(f"拖拽坐标必须是数字，收到「{raw}」") from None
    if min(x1, y1, x2, y2) < 0:
        raise CommandError(f"拖拽坐标不能是负数，收到「{raw}」")
    driver.drag_to(x1, y1, x2, y2, int(cmd.get("durationMs", 300) or 300))


def _exec_clip(cmd: dict, row: dict, driver: Driver) -> None:
    """剪贴板。客服最高频：从 Excel 取一段话贴进聊天框。"""
    action = (cmd.get("p") or "").strip()
    if action in ("复制", "copy"):
        text = render_template(str(cmd.get("text", "")), row)
        if not text.strip():
            raise CommandError("没有可复制的内容")
        driver.copy_to_clipboard(text)
        return
    if action in ("粘贴", "paste"):
        driver.paste_from_clipboard()
        return
    if action in ("复制并粘贴", "复制粘贴", "copy+paste"):
        text = render_template(str(cmd.get("text", "")), row)
        if not text.strip():
            raise CommandError("没有可复制的内容")
        # 一步做完：复制与粘贴之间夹着别的东西会粘错内容
        driver.copy_to_clipboard(text)
        driver.paste_from_clipboard()
        return
    if action in ("读取", "read"):
        driver.read_clipboard()
        return
    raise CommandError("剪贴板动作只能是：复制 / 粘贴 / 复制并粘贴 / 读取")


def _exec_shot(cmd: dict, row: dict, driver: Driver) -> None:
    path = render_template(cmd.get("p", ""), row).strip()
    if not path:
        raise CommandError("截图要填保存路径，否则会存到一个空名字的文件")
    driver.screenshot_to(path)


def _exec_wait_image(cmd: dict, driver: Driver) -> None:
    """条件等待：等到图片出现就继续，等不到就失败。

    与 `img` 指令的区别：**只等、不点**。用于"等弹窗出现"再执行下一条。

    要在超时时间内**反复找**，不是查一次就放弃 —— 驱动的 `locate` 自带轮询，
    但真驱动每轮自己只截图一次；这里再包一层重试，覆盖"驱动返回 None 但稍后就出现"
    的情况（弹窗动画、页面懒加载）。
    """
    image = cmd.get("image") or {}
    asset_id = image.get("assetId")
    if not asset_id:
        raise CommandError("还没有选择要等待的图片")
    threshold = float(image.get("threshold", 0.85))
    timeout = float(image.get("timeoutSec", 10))
    # 「等待」语义本身就包含重试：等着图片出现。哪怕 onMiss 是默认的 fail，
    # 也至少再找一次 —— 否则"等一下"变成了"看一眼"。
    attempts = 3 if image.get("onMiss", "fail") == "retry" else 2
    for _ in range(attempts):
        if driver.locate(asset_id, threshold, timeout) is not None:
            return
    raise CommandError(f"等了 {timeout:g} 秒，屏幕上没有出现图片「{asset_id}」")


def _exec_screen(cmd: dict, row: dict, driver: Driver) -> None:
    """屏幕信息：记分辨率、记当前鼠标位置时用。"""
    action = (cmd.get("p") or "").strip().lower()
    if action == "size":
        driver.get_screen_size()
        return
    if action == "pos":
        driver.cursor_position()
        return
    raise CommandError("屏幕信息只能是 size（分辨率）或 pos（鼠标位置）")


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
