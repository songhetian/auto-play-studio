"""按键词表与组合键归一化。

**为什么必须单独一个模块**：系统里有两套互不相干的键位语汇 ——

* `src/lib/hotkey.ts` 走 **Electron accelerator**（`CommandOrControl` / `Super` / `Return`），
  是给主进程注册全局快捷键用的；
* 指令层要的是 **pyautogui 的词表**（`ctrl` / `win` / `enter`），也就是这里。

以前指令层没有归一化器：用户在配置页写 `Ctr+C`，它会一路原样传到
`pyautogui.hotkey('Ctr', 'C')` —— 还好那样会抛异常；更糟的是写成一个串
（`hotkey('ctrl+c')`），pyautogui 会把整串当成**一个键名**，**静默什么都不做**。

词表里的每个规范名都在 `pyautogui.KEYBOARD_KEYS` 里，由 `tests/test_keys.py`
拿真 pyautogui 断言；`src/lib/keys.ts` 是同一份语义的第二实现，两侧跑同一组
黄金用例（`tests/fixtures/key_cases.json`）。
"""
from __future__ import annotations

#: 修饰键的规范顺序。写反了也要归一到同一个串 —— 否则「同一个快捷键」会变成两个。
_MODIFIERS = ("ctrl", "alt", "shift", "win")

_MODIFIER_RANK = {name: i for i, name in enumerate(_MODIFIERS)}

#: 别名 -> 规范名。规范名本身也在这里，作为它自己的别名。
_ALIASES: dict[str, str] = {
    # 修饰键
    "ctrl": "ctrl",
    "control": "ctrl",
    "ctl": "ctrl",
    "alt": "alt",
    "option": "alt",
    "shift": "shift",
    "win": "win",
    "winleft": "win",
    "super": "win",
    "cmd": "win",
    "command": "win",
    "meta": "win",
    # 命名键
    "enter": "enter",
    "return": "enter",
    "escape": "escape",
    "esc": "escape",
    "tab": "tab",
    "space": "space",
    "空格": "space",
    "backspace": "backspace",
    "back": "backspace",
    "delete": "delete",
    "del": "delete",
    "insert": "insert",
    "ins": "insert",
    "home": "home",
    "end": "end",
    "pageup": "pageup",
    "pgup": "pageup",
    "pagedown": "pagedown",
    "pgdn": "pagedown",
    "up": "up",
    "arrowup": "up",
    "down": "down",
    "arrowdown": "down",
    "left": "left",
    "arrowleft": "left",
    "right": "right",
    "arrowright": "right",
    "capslock": "capslock",
    "printscreen": "printscreen",
    "prtsc": "printscreen",
    "prtscr": "printscreen",
    # 小键盘与标点：规范名就是 pyautogui 认的那一个字符
    "add": "add",
    "subtract": "subtract",
    "multiply": "multiply",
    "divide": "divide",
    "decimal": "decimal",
    "+": "+",
    "plus": "+",
    "-": "-",
    "minus": "-",
    "=": "=",
    "equal": "=",
    "/": "/",
    "slash": "/",
    ".": ".",
    "period": ".",
    ",": ",",
    "comma": ",",
    # 规则族：数字、字母、功能键、小键盘数字
    **{f"num{i}": f"num{i}" for i in range(10)},
    **{f"f{i}": f"f{i}" for i in range(1, 25)},
    **{ch: ch for ch in "abcdefghijklmnopqrstuvwxyz"},
    **{ch: ch for ch in "0123456789"},
}


def normalize_combo(raw: object) -> tuple[list[str], str]:
    """把用户写的按键整理成 pyautogui 认得的一串。

    返回 `(combo, reason)`：成功时 `reason` 为空串，失败时 `combo` 为空列表。

    不抛异常是有意的 —— 配置页的键位拾取器要拿 reason 当场提示，
    而引擎侧拿到 reason 再翻成 `CommandError`，两边共用同一份判断。
    """
    if isinstance(raw, (list, tuple)):
        parts = [str(p) for p in raw]
    elif raw is None:
        parts = []
    else:
        parts = str(raw).split("+")

    # 空段一律丢掉：`Ctrl++C` 与 `Ctrl+C` 等价，`["Ctrl", "", "C"]` 同理
    tokens = [p.strip() for p in parts if p.strip()]
    if not tokens:
        return [], "请填一个按键"

    modifiers: list[str] = []
    keys: list[str] = []

    for token in tokens:
        canonical = _ALIASES.get(token.lower())
        if canonical is None:
            return [], f"不知道「{token}」是什么键"

        bucket = modifiers if canonical in _MODIFIER_RANK else keys
        if canonical in bucket:
            return [], f"「{canonical}」重复了"
        bucket.append(canonical)

    if not keys:
        # 只按住修饰键的话，driver 会静默什么都不做
        return [], "还缺一个按键（只按住了修饰键）"

    modifiers.sort(key=lambda m: _MODIFIER_RANK[m])
    return modifiers + keys, ""
