# -*- coding: utf-8 -*-
"""依赖申报守卫。

起因（真实事故）：知识库对外承诺支持 pdf / docx / pptx，但这三个解析器都是**函数体内**
的延迟 import，而 `python/requirements.txt` 里一个字都没提。后果是从新环境装上就缺::

    ExtractError: policy.pdf：ModuleNotFoundError: No module named 'pypdf'

而索引器会把这种失败记成"这个文件跳过了"，用户看到的就是一份文档莫名其妙搜不到 ——
**没有任何报错提示**。这类"能写好鸡汤还写得挺好"的失效，只能靠机器盯着。

所以这两条断言盯的是同一件事：**源码用到的东西，必须在申报文件里留下痕迹**。
真相源是 `requirements.txt` 和 `package.json` 这两个文件本身，
不是手抄一份包名清单（那样包名改了测试还在绿）。

1. 任何第三方 import → 必须在 requirements.txt 里被提到（启用行或被注释的可选行都算，
   后者代表"刻意不装"的已知决定，本文件不对它做价值判断）；
2. 凡是我们**承诺会装**（启用行）却又写在函数体里的包 → 必须在 build:engine 里显式
   `--hidden-import`，否则打包产物可能缺零件。
"""
from __future__ import annotations

import ast
import json
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
ENGINE_DIR = ROOT / "python" / "engine"
TESTS_DIR = ROOT / "python" / "tests"
REQUIREMENTS = ROOT / "python" / "requirements.txt"
PACKAGE_JSON = ROOT / "package.json"

#: 本仓自己的顶层包名，不是第三方依赖
FIRST_PARTY = {"engine", "tests", "app", "notic"}

#: 模块名 → 发行包名（pip install 用的那个名字）
ALIASES = {
    "pptx": "python-pptx",
    "docx": "python-docx",
    "cv2": "opencv-python",
    "PIL": "pillow",
    "yaml": "pyyaml",
    "win32clipboard": "pywin32",
    "win32con": "pywin32",
    "win32gui": "pywin32",
}

#: 行的形态：`pyautogui==0.9.54   # 键盘鼠标` / `# 测试：pytest>=8（...）`
_R_NAME = re.compile(r"([A-Za-z][A-Za-z0-9_.\-]*)\s*(?:[><=~!]=?|\[)")


def _dist_of(module: str) -> str:
    return ALIASES.get(module, module).lower().replace("_", "-")


def declared_names() -> set[str]:
    """requirements.txt 里出现过的发行包名（启用行与注释里的可选行都算）。"""
    names: set[str] = set()
    for raw in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        line = raw.lstrip("#").strip()  # 注释掉的可选项也算"提到过"，代表已知决定
        m = _R_NAME.search(line)
        if m:
            names.add(m.group(1).lower().replace("_", "-"))
    return names


def scanned_imports() -> dict[str, dict]:
    """扫描 engine/ + tests/ 下所有第三方 import，标注它是不是延迟（在函数体内）。"""
    found: dict[str, dict] = {}
    for path in sorted(list(ENGINE_DIR.rglob("*.py")) + list(TESTS_DIR.rglob("*.py"))):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        module_root = path.parts[0]

        def collect(node) -> set[str]:
            mods: set[str] = set()
            for n in ast.walk(node):
                if isinstance(n, ast.Import):
                    mods.update(a.name.split(".")[0] for a in n.names)
                elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
                    mods.add(n.module.split(".")[0])
            return mods

        deferred: set[str] = set()
        for fn in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
            deferred |= collect(fn)

        top_level = collect(ast.Module(body=tree.body, type_ignores=[]))

        for group, kind in ((deferred, "deferred"), (top_level, "top")):
            for mod in sorted(group):
                if mod in sys.stdlib_module_names or mod in FIRST_PARTY or mod == module_root:
                    continue
                entry = found.setdefault(
                    mod, {"dist": _dist_of(mod), "deferred": False, "top": False, "where": []}
                )
                if kind == "deferred":
                    entry["deferred"] = True
                else:
                    entry["top"] = True
                entry["where"].append(str(path.relative_to(ROOT)))
    return found


def top_level_anywhere() -> set[str]:
    """全仓**顶层** import 过的模块：这些打包器一定统计得到，不需要额外点名。

    单独记一个标记而不是用「非延迟」推断：openpyxl 这类包既在顶层 import、
    又在某个函数体内延迟 import，只看 deferred 会把它误判成不可见。
    """
    return {mod for mod, info in scanned_imports().items() if info["top"]}


def active_requirements() -> set[str]:
    """只取**启用**行 —— 这些是我们承诺一定会装到的包。"""
    names: set[str] = set()
    for raw in REQUIREMENTS.read_text(encoding="utf-8").splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        line = stripped.split("#", 1)[0].strip()
        m = _R_NAME.search(line)
        if m:
            names.add(m.group(1).lower().replace("_", "-"))
    return names


def hidden_imports() -> set[str]:
    """package.json 里 build:engine 显式点名的模块。"""
    cmd = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["scripts"]["build:engine"]
    return set(re.findall(r"--hidden-import\s+(\S+)", cmd))


IMPORTS = scanned_imports()
DECLARED = declared_names()

#: 收窄到出事的那个模块：知识库解析器。
#: 它的三个 third-party 解析器全是函数体内延迟 import，且缺了之后是**静默失效**
#: （索引器只记"这个文件跳过"），所以这里要求打包命令行显式点名。
#: 之所以不推广到全仓：openpyxl / fastapi / numpy 等同样是延迟 import 却一直跑得好好的，
#: 说明 `--collect-submodules engine` 通常能解析到；把它们也塞进来只会制造噪音。
EXTRACTOR = ENGINE_DIR / "kb" / "extract.py"


def test_用到的第三方包都必须在requirements里留痕():
    """没写进 requirements 的包 = 新环境装上就缺，且缺失往往是静默的。"""
    missing = {
        mod: info["dist"]
        for mod, info in IMPORTS.items()
        if info["dist"] not in DECLARED
    }
    assert missing == {}, (
        "以下模块在源码里 import 了，requirements.txt 却完全没提，"
        "新环境装上会静默失效：\n"
        + "\n".join("  %s（pip 名 %s）← %s" % (mod, dist, IMPORTS[mod]["where"][0]) for mod, dist in sorted(missing.items()))
    )


def _deferred_third_party_in(path: pathlib.Path) -> set[str]:
    """取单个模块里**函数体内**的第三方 import（同一个 Use：它是 Acceptance 的二类
    —— 顶层 import 打包器一定看得到，延迟 import 才需要点名）。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    out: set[str] = set()
    for fn in (n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))):
        for n in ast.walk(fn):
            if isinstance(n, ast.Import):
                out.update(a.name.split(".")[0] for a in n.names)
            elif isinstance(n, ast.ImportFrom) and n.level == 0 and n.module:
                out.add(n.module.split(".")[0])
    return {m for m in out if m not in sys.stdlib_module_names and m not in FIRST_PARTY}


def test_知识库解析器的可选依赖必须显式声明给打包器():
    """这三个解析器缺了还不报错，只是文档"搜不到" —— 打包时不能交给运气。"""
    # 顶层已经 import 过的包（如 openpyxl）打包器统计得到，不必再点名；
    # 只有从没在顶层出现过的延迟包才缺那一次显式声明。
    hidden = hidden_imports()
    invisible = _deferred_third_party_in(EXTRACTOR) - top_level_anywhere()
    missing = sorted(invisible - hidden)
    assert missing == [], (
        "kb/extract.py 在函数体内 import 了这些包，且全仓从无顶层 import，"
        "必须在 package.json 的 build:engine 里补 --hidden-import：\n  " + "\n  ".join(missing)
    )
