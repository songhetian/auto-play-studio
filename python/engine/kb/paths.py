"""路径归一化：只做“比较用”的归一化，不改动要展示或要打开的路径。

移植自 know 的 `path-utils.ts`。它存在的唯一理由是「同一个文件不要出现两次」：
Windows 上 `C:\\docs\\a.md` 与 `C:/docs/a.md` 是同一个文件，
拖拽进来的路径还经常带结尾斜杠。
"""
from __future__ import annotations


def normalize_path(path: str) -> str:
    """反斜杠转正斜杠，去掉一个结尾斜杠。空串原样返回。"""
    if not path:
        return ""
    return path.replace("\\", "/").removesuffix("/")
