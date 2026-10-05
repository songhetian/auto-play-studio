# -*- coding: utf-8 -*-
"""敏感词库的 HTTP 路由（挂在 /api/sensitive/words 下）。

路由只做参数校验与错误码转换，业务全在 `service` 里。
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from . import service

router = APIRouter(prefix="/sensitive", tags=["sensitive"])


class WordIn(BaseModel):
    word: str
    level: str = "mid"
    match_key: str = ""
    case_sensitive: bool = False
    note: str = ""


class WordPatch(BaseModel):
    word: str | None = None
    level: str | None = None
    match_key: str | None = None
    case_sensitive: bool | None = None
    note: str | None = None


class ImportIn(BaseModel):
    text: str


class ImportJsonIn(BaseModel):
    """直接收``payload``：兼容顶层是数组，也兼容 {"words": [...]} 包装。"""

    words: list | dict


@router.get("/words")
def list_words(q: str = "", level: str = "", enabled_only: bool = False) -> list[dict]:
    return service.list_words(q, level, enabled_only)


@router.post("/words")
def add_word(p: WordIn) -> dict:
    try:
        return service.add_word(p.word, p.level, p.match_key, p.case_sensitive, p.note)
    except ValueError as e:
        # 400 而不是 500：这是用户填错了，不是服务端出错
        raise HTTPException(400, str(e)) from e


@router.patch("/words/{wid}")
def update_word(wid: int, p: WordPatch) -> dict:
    try:
        return service.update_word(wid, p.model_dump(exclude_none=True))
    except KeyError:
        raise HTTPException(404, "没有这条词") from None
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


@router.post("/words/{wid}/enabled")
def set_enabled(wid: int, enabled: bool = True) -> dict:
    try:
        return service.set_enabled(wid, enabled)
    except KeyError:
        raise HTTPException(404, "没有这条词") from None


@router.delete("/words/{wid}")
def delete_word(wid: int) -> dict:
    try:
        service.delete_word(wid)
    except KeyError:
        raise HTTPException(404, "没有这条词") from None
    return {"ok": True}


@router.post("/words/import")
def import_words(p: ImportIn) -> dict:
    return service.import_words(p.text)


@router.post("/words/import-json")
def import_json(p: ImportJsonIn) -> dict:
    try:
        return service.import_json(p.words)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e


class SampleIn(BaseModel):
    """从运行中的应用取一段真实文本，用来挖候选词。"""

    text: str = ""


@router.get("/apps")
def list_apps() -> list[dict]:
    """列出当前有窗口的应用：让用户挑一个真实在用的，而不是手填进程名。

    窗口枚举失败（无 pywin32 / 非 Windows）时返回空数组，
    界面上据此降级为"直接粘贴对话文本"，不做静默失败。
    """
    out: list[dict] = []
    try:
        from ..window_control import list_windows
        rows = list_windows()
    except Exception:  # noqa: BLE001 —— 设备层不可用时降级
        return out
    seen: set[str] = set()
    for hwnd, title in rows:
        title = (title or "").strip()
        if not title or title in seen:
            continue
        seen.add(title)
        out.append({"hwnd": hwnd, "title": title})
    return out


@router.post("/candidates")
def candidates(p: SampleIn) -> dict:
    """从真实对话文本里提取候选违禁词（供用户勾选入库）。"""
    from ..sensitive import extract_candidates

    items = extract_candidates(p.text)
    return {"items": items, "textLen": len(p.text or "")}


@router.get("/stats")
def stats() -> dict:
    return service.stats()


@router.get("/export")
def export_json() -> dict:
    """导出成 studio 的 wordlib.json：别人在 Studio 里改完再分发给客户端。"""
    return service.export_json()


# ── wordlib.json 自动同步（文件监听 → 导入）──────────────────────────


class WordlibWatchIn(BaseModel):
    """被监听的词库文件路径；空串 = 关闭自动同步。"""

    path: str = ""


def _watch_status(st) -> dict:
    return {
        "path": st.path,
        "lastImportAt": st.last_import_at,
        "lastResult": st.last_result,
        "lastError": st.last_error,
    }


@router.get("/wordlib-watch")
def get_wordlib_watch() -> dict:
    """当前监听状态：配的路径 + 上次导入结果 / 错误。"""
    from . import watch

    return _watch_status(watch.get_watcher().state)


@router.put("/wordlib-watch")
def set_wordlib_watch(p: WordlibWatchIn) -> dict:
    """配置被监听的 wordlib.json。

    配好后**立即试导一次**：用户刚选完文件就想知道"到底进没进"，
    不该干等到下一个轮询周期（默认 3s）才看到结果。
    """
    from .. import db
    from . import watch

    path = db.save_wordlib_path(p.path)
    w = watch.get_watcher()
    w.set_path(path)
    w.poll()
    return _watch_status(w.state)