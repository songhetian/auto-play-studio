"""Excel 预处理的业务层。

两件事在这里收口：

1. **字段名 camelCase。** 引擎内部 snake_case、前端读 camelCase —— 转换只写这一处。
   分开写的话，页面不报错、整块面板空白，排查要翻两边。
2. **「能打开的文件」是一份白名单，不是一个路径参数。** 引擎是本机进程，
   `?path=` 由前端拼；照单全收就等于给任意字符串配了一个读文件 / 起进程的动作。
   白名单里只有**这个工具自己整理产出的**文件。
"""
from __future__ import annotations

import os
import subprocess
import sys
from typing import Any, Callable
from zipfile import BadZipFile

from openpyxl.utils.exceptions import InvalidFileException

from . import clean as cleaner
from . import inspector

#: openpyxl 读不了老版 .xls 与 csv，硬读了只会抛一个用户看不懂的异常。
#: 与其让他猜，不如直说该怎么做。
_SUFFIXES = {".xlsx", ".xlsm"}

#: 这次运行里产出的文件（绝对路径归一化后）。进程级，重启即清空 ——
#: 白名单要表达的是「刚才那次整理的结果」，不是「历史上出现过的所有路径」。
_produced: set[str] = set()

#: 「用系统默认程序打开」的实现，测试里替换掉（进程内启动编辑器不可测）
_open_with_system: Callable[[str], None]


def _open_with_system(path: str) -> None:  # noqa: F811 —— 覆盖上面的注解声明
    """只有在同一台机器上才有意义（引擎是本机 sidecar）。"""
    if sys.platform.startswith("win"):
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])


class Unreadable(Exception):
    """文件读不了：不是工作簿、后缀不对、内容损坏。"""


def reset() -> None:
    """清空白名单（测试之间、以及每轮整理开始时）。"""
    _produced.clear()


def _identity(path: str) -> str:
    """白名单的比较键。只看路径本身，不解析符号链接 ——
    用户挪走文件之后仍然要能说清「它已经不在了」，而不是当成没产出过。"""
    return os.path.normcase(os.path.abspath(path))


def is_produced(path: str) -> bool:
    return _identity(path) in _produced


def produced_file(path: str) -> str:
    """下载/打开前的唯一一道闸。返回原路径，不通过就抛 `LookupError`。"""
    if not is_produced(path):
        raise LookupError("只能下载或打开这个工具整理出来的文件")
    if not os.path.exists(path):
        raise LookupError(f"文件不在了：{path}")
    return path


def open_file(path: str) -> None:
    _open_with_system(produced_file(path))


def _require_workbook(path: str) -> str:
    if not (path or "").strip():
        raise Unreadable("文件路径是空的")
    if not os.path.exists(path):
        raise LookupError(f"找不到文件：{path}")
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in _SUFFIXES:
        raise Unreadable(
            f"只支持 .xlsx / .xlsm，收到的是「{os.path.basename(path)}」。"
            "老版 .xls 与 csv 请先用 Excel 另存为 .xlsx"
        )
    return path


def inspect_file(path: str, key_col: str = "") -> dict[str, Any]:
    """只读体检，返回前端直接可用的报告。"""
    return report_payload(_report(path, key_col))


def clean_file(path: str, key_col: str = "", accept_risk: bool = False) -> dict[str, Any]:
    """整理成新文件，返回台账。产出的路径进白名单，之后才允许被下载/打开。"""
    _require_workbook(path)
    try:
        output, log = cleaner.clean(path, cleaner.CleanOptions(key_col=key_col, accept_risk=accept_risk))
    except ValueError:
        raise  # 列名写错：文案原样带给用户，别包成「文件坏了」
    except (InvalidFileException, BadZipFile, OSError) as exc:
        raise Unreadable(f"整理不了这个文件：{exc}") from exc

    _produced.add(_identity(output))
    return log_payload(log)


def _report(path: str, key_col: str):
    _require_workbook(path)
    try:
        return inspector.inspect(path, key_col)
    except ValueError:
        raise
    except (InvalidFileException, BadZipFile, OSError) as exc:
        raise Unreadable(f"读不了这个文件：{exc}") from exc


# ── camelCase 转换（唯一的一处） ──────────────────────────────────────


def report_payload(report: inspector.Report) -> dict[str, Any]:
    return {
        "path": report.path,
        "sheet": report.sheet,
        "headerRow": report.header_row,
        "columns": report.columns,
        "dataRows": report.data_rows,
        "keyCol": report.key_col,
        "issues": [
            {
                "kind": issue.kind,
                "severity": issue.severity,
                "rows": list(issue.rows),
                "cols": list(issue.cols),
                "detail": issue.detail,
            }
            for issue in report.issues
        ],
    }


def log_payload(log: cleaner.ChangeLog) -> dict[str, Any]:
    return {
        "output": log.output,
        "fileName": os.path.basename(log.output),
        "sheet": log.sheet,
        "rowsKept": list(log.rows_kept),
        "colsKept": list(log.cols_kept),
        "changes": [
            {
                "kind": change.kind,
                "detail": change.detail,
                "row": change.row,
                "col": change.col,
                "before": change.before,
                "after": change.after,
            }
            for change in log.changes
        ],
    }
